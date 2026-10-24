import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as Y from 'yjs';
import { selfAndAncestors } from '../shared/padpath.js';
import { replaceText } from '../shared/ytext.js';

/**
 * Pad storage. Every pad is a Yjs document holding:
 * - `content` (Y.Text): the pad itself;
 * - `stdin` (Y.Text): the program input box, shared like the content;
 * - `meta` (Y.Map): `language` ('auto' or a language id).
 *
 * On disk, `pads/<id>.ystate` keeps the Yjs state (so collaborators who reconnect after a
 * restart merge cleanly instead of duplicating text) and `pads/<id>.json` the metadata the
 * server needs without loading the document: path, size, times, language and lock.
 * `history/<id>.json` keeps text snapshots. `<id>` is a hash of the path.
 *
 * Loaded documents stay in memory while in use and are written back shortly after each
 * change; an empty pad with no lock and no history leaves nothing on disk.
 */

/**
 * @typedef {object} LockInfo
 * @property {'readonly' | 'private'} mode
 * @property {string} salt
 * @property {string} hash
 * @property {number} version
 *
 * @typedef {object} PadMeta
 * @property {string} path
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} size Characters in the content.
 * @property {string} language
 * @property {LockInfo | null} lock
 * @property {boolean} [created] Kept even while empty (an attached file someone added).
 */

const SAVE_DELAY = 400;
const SAVE_MAX_WAIT = 3000;
export const MAX_STDIN_CHARS = 256 * 1024;

export function padId(padPath) {
  return crypto.createHash('sha256').update(padPath).digest('hex').slice(0, 40);
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** The pad index, keeping a running total of the characters in all pads. */
class PadIndex extends Map {
  total = 0;

  set(key, value) {
    this.total += (value?.size ?? 0) - (super.get(key)?.size ?? 0);
    return super.set(key, value);
  }

  delete(key) {
    this.total -= super.get(key)?.size ?? 0;
    return super.delete(key);
  }
}

export class Pad {
  /** @param {string} padPath */
  constructor(padPath) {
    this.path = padPath;
    this.id = padId(padPath);
    this.doc = new Y.Doc();
    this.text = this.doc.getText('content');
    this.stdin = this.doc.getText('stdin');
    this.meta = this.doc.getMap('meta');
    this.refs = 0;
    this.dirty = false;
    this.firstDirtyAt = 0;
    this.updatedAt = 0;
    /** @type {NodeJS.Timeout | null} */
    this.saveTimer = null;
    /** @type {NodeJS.Timeout | null} */
    this.unloadTimer = null;
    /** @type {Array<{ id: number, t: number, text: string }> | null} */
    this.history = null;
  }
}

export class PadStore extends EventEmitter {
  /**
   * @param {{ dataDir: string, maxPadChars: number, maxTotalChars?: number, history: { intervalMs: number, maxEntries: number, maxBytes: number }, unloadDelayMs?: number }} opts
   */
  constructor(opts) {
    super();
    this.dataDir = opts.dataDir;
    this.padsDir = path.join(opts.dataDir, 'pads');
    this.historyDir = path.join(opts.dataDir, 'history');
    this.maxPadChars = opts.maxPadChars;
    /** Once all pads together hold this much text, they may shrink but not grow. */
    this.maxTotalChars = opts.maxTotalChars ?? Infinity;
    this.historyOpts = opts.history;
    this.unloadDelayMs = opts.unloadDelayMs ?? 30_000;
    /** @type {PadIndex & Map<string, PadMeta>} */
    this.index = new PadIndex();
    /** @type {Map<string, Pad>} */
    this.loaded = new Map();
    /** @type {Map<string, Promise<Pad>>} */
    this.loading = new Map();
    /** @type {Map<string, Promise<unknown>>} per-pad queue that serialises disk writes */
    this.queues = new Map();
  }

  async init() {
    // Only the server reads pads; programs run as other users or have this hidden.
    await fsp.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(this.dataDir, 0o700);
    await fsp.mkdir(this.padsDir, { recursive: true });
    await fsp.mkdir(this.historyDir, { recursive: true });
    for (const name of await fsp.readdir(this.padsDir)) {
      if (name.endsWith('.tmp')) {
        await fsp.rm(path.join(this.padsDir, name), { force: true });
        continue;
      }
      if (!name.endsWith('.json')) continue;
      const meta = await readJson(path.join(this.padsDir, name), null);
      if (meta && typeof meta.path === 'string') this.index.set(meta.path, meta);
    }
    return this;
  }

  #file(id, ext) {
    return path.join(ext === 'history' ? this.historyDir : this.padsDir, `${id}.${ext === 'history' ? 'json' : ext}`);
  }

  #enqueue(id, task) {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.catch((err) => console.error(`[store] ${err.stack || err}`));
    this.queues.set(id, tail);
    tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return next;
  }

  // ---- index -------------------------------------------------------------

  /** True when the storage cap is reached (approximate: counts pad text only). */
  isFull() {
    return this.index.total >= this.maxTotalChars;
  }

  /** @returns {PadMeta | null} */
  info(padPath) {
    return this.index.get(padPath) ?? null;
  }

  /** Locks on the pad and its ancestors, outermost first. */
  lockChain(padPath) {
    const chain = [];
    for (const p of selfAndAncestors(padPath)) {
      const lock = this.index.get(p)?.lock;
      if (lock) chain.push({ path: p, mode: lock.mode, version: lock.version });
    }
    return chain;
  }

  /** @returns {LockInfo | null} */
  lockAt(padPath) {
    return this.index.get(padPath)?.lock ?? null;
  }

  /**
   * Direct sub-pads of a pad, like Dontpad's list of subpages. Includes intermediate
   * names that only have deeper pads below them.
   */
  children(padPath) {
    const prefix = padPath + '/';
    /** @type {Map<string, { name: string, path: string, size: number, updatedAt: number, exists: boolean, hasChildren: boolean, locked: boolean }>} */
    const out = new Map();
    for (const [p, meta] of this.index) {
      if (!p.startsWith(prefix)) continue;
      const rest = p.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      let item = out.get(name);
      if (!item) {
        item = { name, path: prefix + name, size: 0, updatedAt: 0, exists: false, hasChildren: false, locked: false };
        out.set(name, item);
      }
      if (slash < 0) {
        item.exists = meta.size > 0 || !!meta.created;
        item.size = meta.size;
        item.updatedAt = Math.max(item.updatedAt, meta.updatedAt);
        item.locked = !!meta.lock;
      } else if (meta.size > 0 || meta.created || meta.lock) {
        item.hasChildren = true;
        item.updatedAt = Math.max(item.updatedAt, meta.updatedAt);
      }
    }
    return [...out.values()].filter((c) => c.exists || c.hasChildren).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- documents -----------------------------------------------------------

  /** Loads a pad (or reuses the loaded one) and holds it until release(). */
  async acquire(padPath) {
    let pad = this.loaded.get(padPath);
    if (!pad) {
      let pending = this.loading.get(padPath);
      if (!pending) {
        pending = this.#load(padPath);
        this.loading.set(padPath, pending);
        pending.finally(() => this.loading.delete(padPath));
      }
      pad = await pending;
    }
    pad.refs++;
    if (pad.unloadTimer) {
      clearTimeout(pad.unloadTimer);
      pad.unloadTimer = null;
    }
    return pad;
  }

  /** @param {Pad} pad */
  release(pad) {
    pad.refs = Math.max(0, pad.refs - 1);
    if (pad.refs > 0 || pad.unloadTimer) return;
    pad.unloadTimer = setTimeout(() => {
      pad.unloadTimer = null;
      if (pad.refs === 0) this.#unload(pad).catch((err) => console.error(`[store] unload: ${err.stack || err}`));
    }, this.unloadDelayMs);
    pad.unloadTimer.unref?.();
  }

  /** Runs `fn` with the pad loaded. */
  async withPad(padPath, fn) {
    const pad = await this.acquire(padPath);
    try {
      return await fn(pad);
    } finally {
      this.release(pad);
    }
  }

  async #load(padPath) {
    const pad = new Pad(padPath);
    try {
      const state = await fsp.readFile(this.#file(pad.id, 'ystate'));
      Y.applyUpdate(pad.doc, new Uint8Array(state), 'load');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[store] could not read ${padPath}: ${err.message}`);
    }
    pad.updatedAt = this.index.get(padPath)?.updatedAt ?? 0;
    pad.doc.on('update', (_update, origin) => {
      if (origin === 'load') return;
      pad.updatedAt = Date.now();
      if (!pad.dirty) pad.firstDirtyAt = pad.updatedAt;
      pad.dirty = true;
      this.#scheduleSave(pad);
    });
    this.loaded.set(padPath, pad);
    return pad;
  }

  async #unload(pad) {
    await this.save(pad, { snapshot: true });
    if (pad.refs > 0) return;
    this.loaded.delete(pad.path);
    pad.doc.destroy();
  }

  #scheduleSave(pad) {
    if (pad.saveTimer) clearTimeout(pad.saveTimer);
    const wait = Date.now() - pad.firstDirtyAt > SAVE_MAX_WAIT ? 0 : SAVE_DELAY;
    pad.saveTimer = setTimeout(() => {
      pad.saveTimer = null;
      this.save(pad).catch((err) => console.error(`[store] save: ${err.stack || err}`));
    }, wait);
  }

  /**
   * Writes a pad to disk now. `snapshot` adds a history entry if the text changed since
   * the last one, whatever its age.
   * @param {Pad} pad
   */
  save(pad, { snapshot = false } = {}) {
    if (pad.saveTimer) {
      clearTimeout(pad.saveTimer);
      pad.saveTimer = null;
    }
    return this.#enqueue(pad.id, async () => {
      const wasDirty = pad.dirty;
      pad.dirty = false;
      const text = pad.text.toString();
      await this.#snapshot(pad, text, snapshot);
      const hist = await this.#loadHistory(pad);
      const prev = this.index.get(pad.path);
      const keep = text.length > 0 || pad.stdin.length > 0 || !!prev?.lock || !!prev?.created || hist.length > 0;
      if (!keep) {
        if (prev) {
          this.index.delete(pad.path);
          await fsp.rm(this.#file(pad.id, 'json'), { force: true });
        }
        await fsp.rm(this.#file(pad.id, 'ystate'), { force: true });
        return;
      }
      if (!wasDirty && prev && !snapshot) return;
      const now = Date.now();
      /** @type {PadMeta} */
      const meta = {
        path: pad.path,
        createdAt: prev?.createdAt || now,
        updatedAt: pad.updatedAt || prev?.updatedAt || now,
        size: text.length,
        language: String(pad.meta.get('language') ?? prev?.language ?? 'auto'),
        lock: prev?.lock ?? null,
        created: !!prev?.created,
      };
      await writeAtomic(this.#file(pad.id, 'ystate'), Y.encodeStateAsUpdate(pad.doc));
      await writeAtomic(this.#file(pad.id, 'json'), JSON.stringify(meta));
      this.index.set(pad.path, meta);
    });
  }

  /** Saves every loaded pad (on shutdown). */
  async flush() {
    await Promise.all([...this.loaded.values()].map((pad) => this.save(pad, { snapshot: true })));
  }

  /** Current text of a pad, or null if it does not exist. */
  async getText(padPath) {
    const loaded = this.loaded.get(padPath);
    if (loaded) return loaded.text.toString();
    if (!this.index.has(padPath)) return null;
    return this.withPad(padPath, (pad) => pad.text.toString());
  }

  /**
   * Replaces a pad's text (raw API, restoring history, uploads). Collaborators see the
   * change live. The previous text is kept in history.
   * @returns {Promise<boolean>} whether the text changed
   */
  async setText(padPath, text, origin = 'api') {
    if (text.length > this.maxPadChars) throw Object.assign(new Error('Pad is too large'), { status: 413 });
    return this.withPad(padPath, async (pad) => {
      const before = pad.text.toString();
      if (before === text) return false;
      if (before) await this.#enqueue(pad.id, () => this.#snapshot(pad, before, true));
      pad.doc.transact(() => replaceText(pad.text, text), origin);
      await this.save(pad, { snapshot: true });
      return true;
    });
  }

  /** Marks a pad as existing even while empty (a new attached file). */
  async touch(padPath) {
    const prev = this.index.get(padPath);
    if (prev?.created || (prev && prev.size > 0)) return;
    await this.withPad(padPath, async (pad) => {
      const now = Date.now();
      this.index.set(padPath, {
        path: padPath,
        createdAt: prev?.createdAt || now,
        updatedAt: prev?.updatedAt || now,
        size: pad.text.length,
        language: String(pad.meta.get('language') ?? 'auto'),
        lock: prev?.lock ?? null,
        created: true,
      });
      pad.dirty = true;
      await this.save(pad);
    });
  }

  /** Empties a pad and forgets it: content, input, history and its own lock. */
  async remove(padPath) {
    await this.withPad(padPath, async (pad) => {
      pad.doc.transact(() => {
        pad.text.delete(0, pad.text.length);
        pad.stdin.delete(0, pad.stdin.length);
      }, 'api');
      pad.history = [];
      const prev = this.index.get(padPath);
      if (prev) this.index.set(padPath, { ...prev, lock: null, created: false, size: 0 });
      await this.#enqueue(pad.id, () => fsp.rm(this.#file(pad.id, 'history'), { force: true }));
      await this.save(pad);
    });
    this.emit('lock', padPath);
  }

  /**
   * Keeps the content and input below their size limits after a collaborator's edit.
   * @returns {boolean} whether something was cut
   */
  enforceLimits(pad) {
    const over = pad.text.length - this.maxPadChars;
    const overIn = pad.stdin.length - MAX_STDIN_CHARS;
    if (over <= 0 && overIn <= 0) return false;
    pad.doc.transact(() => {
      if (over > 0) pad.text.delete(this.maxPadChars, over);
      if (overIn > 0) pad.stdin.delete(MAX_STDIN_CHARS, overIn);
    }, 'limit');
    return true;
  }

  // ---- history -------------------------------------------------------------

  async #loadHistory(pad) {
    if (!pad.history) pad.history = await readJson(this.#file(pad.id, 'history'), []);
    return pad.history;
  }

  async #snapshot(pad, text, force) {
    if (!text) return;
    const hist = await this.#loadHistory(pad);
    const last = hist.at(-1);
    if (last && last.text === text) return;
    const now = Date.now();
    if (!force && last && now - last.t < this.historyOpts.intervalMs) return;
    hist.push({ id: (last?.id ?? 0) + 1, t: now, text });
    let bytes = hist.reduce((n, h) => n + h.text.length, 0);
    while (hist.length > 1 && (hist.length > this.historyOpts.maxEntries || bytes > this.historyOpts.maxBytes)) {
      bytes -= hist.shift().text.length;
    }
    await writeAtomic(this.#file(pad.id, 'history'), JSON.stringify(hist));
  }

  /** Adds the current text to history now (before the browser replaces it wholesale). */
  async snapshot(padPath) {
    if (!this.index.has(padPath) && !this.loaded.has(padPath)) return;
    await this.withPad(padPath, (pad) => this.#enqueue(pad.id, () => this.#snapshot(pad, pad.text.toString(), true)));
  }

  /** Snapshots of a pad, newest first, without their text. */
  async history(padPath) {
    if (!this.index.has(padPath) && !this.loaded.has(padPath)) return [];
    return this.withPad(padPath, async (pad) => {
      const hist = await this.#loadHistory(pad);
      return hist.map(({ id, t, text }) => ({ id, t, size: text.length, lines: text.split('\n').length })).reverse();
    });
  }

  async historyItem(padPath, id) {
    if (!this.index.has(padPath) && !this.loaded.has(padPath)) return null;
    return this.withPad(padPath, async (pad) => (await this.#loadHistory(pad)).find((h) => h.id === Number(id)) ?? null);
  }

  async restore(padPath, id) {
    const item = await this.historyItem(padPath, id);
    if (!item) return false;
    await this.setText(padPath, item.text, 'restore');
    return true;
  }

  // ---- locks ---------------------------------------------------------------

  /**
   * Sets or removes the lock on a pad. A new lock gets a new version, so tokens issued
   * for an earlier lock on the same pad stop working.
   * @param {string} padPath
   * @param {{ mode: 'readonly' | 'private', salt: string, hash: string } | null} lock
   */
  async setLock(padPath, lock) {
    let version = 0;
    await this.withPad(padPath, async (pad) => {
      const prev = this.index.get(padPath);
      version = lock ? Math.max(Date.now(), (prev?.lock?.version ?? 0) + 1) : 0;
      const now = Date.now();
      this.index.set(padPath, {
        path: padPath,
        createdAt: prev?.createdAt || now,
        updatedAt: prev?.updatedAt || now,
        size: pad.text.length,
        language: String(pad.meta.get('language') ?? prev?.language ?? 'auto'),
        created: !!prev?.created,
        lock: lock ? { ...lock, version } : null,
      });
      pad.dirty = true;
      await this.save(pad);
    });
    this.emit('lock', padPath);
    return version;
  }
}
