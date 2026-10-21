import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { baseName } from '../shared/padpath.js';
import { LANGUAGE_BY_ID } from '../shared/langs.js';
import { parseTokens } from './auth.js';
import { HELPERS, HELPER_SOURCE, isAttachableName, mainFileName, terminalShell, useHelpersDir } from './languages.js';

/**
 * Code execution over a WebSocket (`/_ws/exec`). JSON messages:
 *
 * client → server
 *   { type: 'run', id, language, code, stdin, pad?, tokens?, key? }
 *       Runs `code`. Non-empty `stdin` is fed to the program, then end of file; empty
 *       stdin keeps input open so the user can type while it runs.
 *   { type: 'cmd', id, command, pad, language, code, tokens?, key? }
 *       Runs a shell command in the pad's workspace (needs edit access to the pad).
 *   { type: 'stdin', id, data } | { type: 'eof', id } | { type: 'kill', id }
 *   { type: 'reset', id, pad, tokens? }   empties the pad's workspace
 *
 * server → client
 *   { type: 'hello', ... }                languages and limits
 *   { type: 'phase', id, phase: 'compile' | 'run', command }
 *   { type: 'out', id, stream: 'stdout' | 'stderr', data }
 *   { type: 'exit', id, phase, code, signal, reason, timeMs }
 *   { type: 'error', id, message, code? }
 *
 * Programs run in a fresh directory that holds the pad as its main file and the pad's
 * attached files (sub-pads with file names). Terminal commands run in a workspace kept
 * per pad, so files they create survive between commands.
 */

const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_COMMAND = 4000;

class RateLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  take(key, now = Date.now()) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= this.perMinute) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < 60_000)) this.hits.delete(k);
    return true;
  }
}

async function dirSize(dir, limit) {
  let total = 0;
  let count = 0;
  const stack = [dir];
  while (stack.length && total <= limit && count < 20_000) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      count++;
      const full = path.join(current, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) total += (await fsp.lstat(full).catch(() => ({ size: 0 }))).size;
    }
  }
  return total;
}

export class ExecServer {
  /**
   * @param {object} deps
   * @param {import('./config.js').Config} deps.config
   * @param {import('./store.js').PadStore} deps.store
   * @param {import('./auth.js').Access} deps.access
   * @param {import('./auth.js').TokenSigner} deps.signer
   * @param {import('./sandbox.js').Sandbox} deps.sandbox
   * @param {Map<string, import('./languages.js').Runner>} deps.languages
   */
  constructor({ config, store, access, signer, sandbox, languages }) {
    this.config = config;
    this.limits = config.exec;
    this.store = store;
    this.access = access;
    this.signer = signer;
    this.sandbox = sandbox;
    this.languages = languages;
    this.shell = terminalShell();
    this.runsDir = path.join(config.workDir, 'runs');
    this.wsDir = path.join(config.workDir, 'workspaces');
    this.cacheDir = path.join(config.workDir, 'cache');
    this.active = 0;
    /** @type {Map<string, number>} */
    this.perClient = new Map();
    this.rate = new RateLimiter(this.limits.runsPerMinute);
    this.keyHash = this.limits.token ? crypto.createHash('sha256').update(this.limits.token).digest() : null;
  }

  async init() {
    // Programs may enter their own directories but not list anyone else's.
    for (const dir of [this.config.workDir, this.runsDir, this.wsDir, this.cacheDir]) {
      await fsp.mkdir(dir, { recursive: true, mode: 0o711 });
      await fsp.chmod(dir, 0o711);
    }
    // Leftovers from a previous run of the server.
    for (const name of await fsp.readdir(this.runsDir)) await fsp.rm(path.join(this.runsDir, name), { recursive: true, force: true });
    // The build cache may hold files from before the sandbox user changed.
    if (this.sandbox.uid !== null) spawnSync('chown', ['-R', `${this.sandbox.uid}:${this.sandbox.gid ?? this.sandbox.uid}`, this.cacheDir]);
    await this.#own(this.cacheDir);
    const helpers = path.join(this.config.workDir, 'helpers');
    await fsp.mkdir(helpers, { recursive: true, mode: 0o755 });
    await fsp.chmod(helpers, 0o755);
    for (const name of await fsp.readdir(HELPER_SOURCE)) {
      await fsp.copyFile(path.join(HELPER_SOURCE, name), path.join(helpers, name));
      await fsp.chmod(path.join(helpers, name), 0o644);
    }
    useHelpersDir(helpers);
    this.cleaner = setInterval(() => this.cleanWorkspaces().catch(() => {}), 3600_000);
    this.cleaner.unref?.();
    return this;
  }

  close() {
    clearInterval(this.cleaner);
  }

  /** What the client needs to know: shown in the language menu and the run panel. */
  info() {
    return {
      enabled: this.limits.enabled,
      terminal: this.limits.terminal,
      needsKey: !!this.keyHash,
      sandbox: this.sandbox.describe(),
      languages: [...this.languages.values()].map(({ id, name, version }) => ({ id, name, version })),
      limits: {
        runSeconds: this.limits.runTimeoutMs / 1000,
        interactiveSeconds: this.limits.interactiveTimeoutMs / 1000,
        cpuSeconds: this.limits.cpuSeconds,
        memoryMb: this.limits.memoryMb,
        outputKb: Math.round(this.limits.maxOutputBytes / 1024),
      },
    };
  }

  /** Removes workspaces nobody used for a while. */
  async cleanWorkspaces(now = Date.now()) {
    const maxAge = this.limits.workspaceIdleHours * 3600_000;
    for (const name of await fsp.readdir(this.wsDir).catch(() => [])) {
      const dir = path.join(this.wsDir, name);
      const st = await fsp.stat(dir).catch(() => null);
      if (st && now - st.mtimeMs > maxAge) await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  async #own(target) {
    if (this.sandbox.uid === null) return;
    await fsp.chown(target, this.sandbox.uid, this.sandbox.gid ?? this.sandbox.uid);
  }

  #keyOk(key) {
    if (!this.keyHash) return true;
    if (typeof key !== 'string') return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(key).digest(), this.keyHash);
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {string} clientIp
   */
  handle(ws, clientIp) {
    /** @type {Map<string, { job: import('./sandbox.js').Job | null, cancelled: boolean }>} */
    const jobs = new Map();
    const reply = (msg) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(msg));
    };
    reply({ type: 'hello', ...this.info() });

    ws.on('message', (data, isBinary) => {
      if (isBinary || data.length > MAX_MESSAGE) return reply({ type: 'error', id: null, message: 'Message too large' });
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      const id = typeof msg.id === 'string' ? msg.id.slice(0, 64) : null;
      const entry = id ? jobs.get(id) : null;
      switch (msg.type) {
        case 'stdin':
          if (entry?.job && typeof msg.data === 'string') entry.job.write(msg.data);
          break;
        case 'eof':
          entry?.job?.end();
          break;
        case 'kill':
          if (entry) {
            entry.cancelled = true;
            entry.job?.kill('killed');
          }
          break;
        case 'run':
        case 'cmd':
        case 'reset':
          if (!id || jobs.has(id)) return reply({ type: 'error', id, message: 'Missing or duplicate job id' });
          this.#start(msg, id, jobs, reply, clientIp);
          break;
        default:
          break;
      }
    });
    ws.on('close', () => {
      for (const entry of jobs.values()) {
        entry.cancelled = true;
        entry.job?.kill('killed');
      }
    });
    ws.on('error', () => ws.terminate());
  }

  async #start(msg, id, jobs, reply, clientIp) {
    const entry = { job: null, cancelled: false };
    jobs.set(id, entry);
    const fail = (message, code) => reply({ type: 'error', id, message, ...(code ? { code } : {}) });
    let slot = false;
    try {
      if (!this.limits.enabled) return fail('Running code is turned off on this server.');
      if (msg.type !== 'run' && !this.limits.terminal) return fail('The terminal is turned off on this server.');
      if (!this.#keyOk(msg.key)) return fail('This server needs a run key to execute code.', 'key');
      if (msg.type === 'reset') return await this.#reset(msg, id, reply, fail);
      if (!this.rate.take(clientIp)) return fail('Too many runs in the last minute. Wait a moment and try again.');
      const mine = this.perClient.get(clientIp) ?? 0;
      if (mine >= this.limits.maxPerClient) return fail(`You already have ${mine} programs running. Stop one first.`);
      if (this.active >= this.limits.maxConcurrent) return fail('The server is busy running other programs. Try again in a few seconds.');
      this.active++;
      this.perClient.set(clientIp, mine + 1);
      slot = true;
      if (msg.type === 'run') await this.#run(msg, id, entry, reply, fail);
      else await this.#command(msg, id, entry, reply, fail);
    } catch (err) {
      console.error(`[exec] ${err.stack || err}`);
      fail(`Internal error: ${err.message}`);
    } finally {
      jobs.delete(id);
      if (slot) {
        this.active--;
        const left = (this.perClient.get(clientIp) ?? 1) - 1;
        if (left > 0) this.perClient.set(clientIp, left);
        else this.perClient.delete(clientIp);
      }
    }
  }

  /** Sub-pads of `padPath` with file names, readable by the caller. */
  async #attachments(padPath, tokens) {
    if (!padPath) return [];
    const files = [];
    for (const child of this.store.children(padPath)) {
      if (!child.exists || !isAttachableName(child.name)) continue;
      if (!this.access.check(child.path, tokens).canRead) continue;
      const text = await this.store.getText(child.path);
      if (text !== null) files.push({ name: child.name, text });
      if (files.length >= 50) break;
    }
    return files;
  }

  /**
   * Writes the pad and its attachments into `dir`.
   * @returns {Promise<{ main: string, files: string[], texts: Map<string, string> }>}
   */
  async #writeFiles(dir, { padPath, language, code, tokens }) {
    const main = mainFileName(padPath ? baseName(padPath) : 'main', language, code);
    const attachments = await this.#attachments(padPath, tokens);
    const texts = new Map([[main, code]]);
    for (const f of attachments) if (!texts.has(f.name)) texts.set(f.name, f.text);
    for (const [name, text] of texts) {
      const file = path.join(dir, name);
      // A program may have replaced a file with a link; never write through it.
      await fsp.rm(file, { force: true, recursive: true });
      await fsp.writeFile(file, text, { mode: 0o644 });
      await this.#own(file);
    }
    return { main, files: [...texts.keys()], texts };
  }

  #padArgs(msg) {
    const tokens = parseTokens(msg.tokens);
    const padPath = typeof msg.pad === 'string' && msg.pad ? msg.pad : null;
    return { tokens, padPath };
  }

  async #run(msg, id, entry, reply, fail) {
    const runner = this.languages.get(msg.language);
    if (!runner) {
      const name = LANGUAGE_BY_ID.get(msg.language)?.name ?? msg.language;
      return fail(`${name} programs can't be run on this server.`);
    }
    const code = typeof msg.code === 'string' ? msg.code : '';
    if (code.length > this.store.maxPadChars) return fail('The program is too large.');
    const stdin = typeof msg.stdin === 'string' ? msg.stdin : '';
    const { tokens, padPath } = this.#padArgs(msg);
    if (padPath && !this.access.check(padPath, tokens).canRead) return fail('This pad is private.');

    const dir = path.join(this.runsDir, crypto.randomBytes(12).toString('hex'));
    await fsp.mkdir(dir, { mode: 0o700 });
    await this.#own(dir);
    try {
      const { main, files, texts } = await this.#writeFiles(dir, { padPath, language: runner.id, code, tokens });
      const plan = runner.plan({ main, files, read: (name) => texts.get(name) ?? '' });
      const env = { ...plan.env, ...this.#toolEnv() };
      const onOutput = (stream, data) => reply({ type: 'out', id, stream, data });
      if (plan.compile) {
        reply({ type: 'phase', id, phase: 'compile', command: this.#display(plan.compile) });
        entry.job = this.sandbox.spawn({
          argv: plan.compile,
          cwd: dir,
          env,
          timeoutMs: this.limits.compileTimeoutMs,
          cpuSeconds: Math.max(this.limits.cpuSeconds, this.limits.compileTimeoutMs / 1000),
          memoryMb: null,
          fileSizeMb: Math.max(this.limits.fileSizeMb, 64),
          maxOutputBytes: this.limits.maxOutputBytes,
          stdin: '',
          onOutput,
        });
        const result = await entry.job.done;
        if (entry.cancelled || result.code !== 0) {
          return reply({ type: 'exit', id, phase: 'compile', ...result, reason: entry.cancelled ? 'killed' : result.reason });
        }
      }
      if (entry.cancelled) return reply({ type: 'exit', id, phase: 'run', code: null, signal: null, reason: 'killed', timeMs: 0 });
      const interactive = stdin.length === 0;
      reply({ type: 'phase', id, phase: 'run', command: this.#display(plan.run), interactive });
      entry.job = this.sandbox.spawn({
        argv: plan.run,
        cwd: dir,
        env,
        timeoutMs: interactive ? this.limits.interactiveTimeoutMs : this.limits.runTimeoutMs,
        cpuSeconds: this.limits.cpuSeconds,
        memoryMb: plan.memoryLimit ? this.limits.memoryMb : null,
        fileSizeMb: this.limits.fileSizeMb,
        maxOutputBytes: this.limits.maxOutputBytes,
        stdin: interactive ? null : stdin.endsWith('\n') ? stdin : stdin + '\n',
        onOutput,
      });
      const result = await entry.job.done;
      reply({ type: 'exit', id, phase: 'run', ...result });
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #workspace(padPath) {
    const dir = path.join(this.wsDir, this.signer.digest(padPath));
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.#own(dir);
    const now = new Date();
    await fsp.utimes(dir, now, now).catch(() => {});
    return dir;
  }

  async #command(msg, id, entry, reply, fail) {
    const { tokens, padPath } = this.#padArgs(msg);
    if (!padPath) return fail('Commands run in a pad’s workspace; open a pad first.');
    const perm = this.access.check(padPath, tokens);
    if (!perm.canWrite) return fail('This pad is locked. Unlock it to use its terminal.', 'locked');
    const command = typeof msg.command === 'string' ? msg.command.trim() : '';
    if (!command) return reply({ type: 'exit', id, phase: 'run', code: 0, signal: null, reason: null, timeMs: 0 });
    if (command.length > MAX_COMMAND) return fail('Command is too long.');

    const dir = await this.#workspace(padPath);
    const limit = this.limits.workspaceMb * 1024 * 1024;
    if ((await dirSize(dir, limit)) > limit && !/^(rm|ls|du|df)\b/.test(command)) {
      return fail(`This workspace holds more than ${this.limits.workspaceMb} MB. Delete files with rm, or reset the workspace.`);
    }
    const code = typeof msg.code === 'string' ? msg.code : '';
    if (code.length > this.store.maxPadChars) return fail('The pad is too large.');
    const language = LANGUAGE_BY_ID.has(msg.language) ? msg.language : 'plaintext';
    const { main } = await this.#writeFiles(dir, { padPath, language, code, tokens });

    reply({ type: 'phase', id, phase: 'run', command, interactive: true });
    entry.job = this.sandbox.spawn({
      argv: [this.shell, '-c', command],
      cwd: dir,
      env: { ...this.#toolEnv(), RUNPAD_MAIN: main, RUNPAD_PAD: padPath, PS1: '$ ' },
      timeoutMs: this.limits.interactiveTimeoutMs,
      cpuSeconds: Math.max(this.limits.cpuSeconds, 30),
      memoryMb: null,
      fileSizeMb: this.limits.fileSizeMb,
      maxOutputBytes: this.limits.maxOutputBytes,
      stdin: null,
      onOutput: (stream, data) => reply({ type: 'out', id, stream, data }),
    });
    const result = await entry.job.done;
    reply({ type: 'exit', id, phase: 'run', ...result });
  }

  async #reset(msg, id, reply, fail) {
    const { tokens, padPath } = this.#padArgs(msg);
    if (!padPath) return fail('No pad given.');
    if (!this.access.check(padPath, tokens).canWrite) return fail('This pad is locked.', 'locked');
    await fsp.rm(path.join(this.wsDir, this.signer.digest(padPath)), { recursive: true, force: true });
    reply({ type: 'exit', id, phase: 'reset', code: 0, signal: null, reason: null, timeMs: 0 });
  }

  /** Environment for toolchains that need a writable cache (Go). */
  #toolEnv() {
    return {
      GOCACHE: path.join(this.cacheDir, 'go-build'),
      GOPATH: path.join(this.cacheDir, 'gopath'),
      GOTOOLCHAIN: 'local',
      CGO_ENABLED: '0',
      GOTELEMETRY: 'off',
    };
  }

  /** Command line as shown to the user: tool names without install paths or helpers. */
  #display(argv) {
    let args = [...argv];
    if (path.basename(args[0]) === 'stdbuf') args = args.slice(3);
    if (path.isAbsolute(args[0])) args[0] = path.basename(args[0]);
    return args
      .filter((a) => !a.includes(HELPERS) && a !== '-MRunPadSync')
      .map((a) => (/^[\w./:=+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
      .join(' ');
  }

}
