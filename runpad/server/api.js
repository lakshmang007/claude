import { baseName, normalizePadPath } from '../shared/padpath.js';
import { LANGUAGE_BY_ID, effectiveLanguage } from '../shared/langs.js';
import { hashPassword, parseTokens, verifyPassword } from './auth.js';
import { mainFileName } from './languages.js';
import { createZip } from './zip.js';

/**
 * HTTP API under `/_api/`. Pads are addressed with `?path=a/b` (JSON endpoints) or as a
 * path suffix (`/_api/raw/a/b`). Lock tokens travel in the `X-Pad-Tokens` header or the
 * `t` query parameter, comma-separated.
 */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PREVIEW_TYPES = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/plain',
  csv: 'text/plain',
  xml: 'application/xml',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // Raw pads are never rendered as a page, whatever is in them.
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** @returns {Promise<string>} */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new HttpError(413, 'Body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req, 64 * 1024);
  try {
    const data = JSON.parse(text || '{}');
    if (data && typeof data === 'object') return data;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, 'Expected a JSON body');
}

function contentDisposition(filename) {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

class Limiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    /** @type {Map<string, number[]>} */
    this.hits = new Map();
  }

  take(key, now = Date.now()) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.hits.clear();
    return list.length <= this.max;
  }
}

/**
 * @param {object} deps
 * @param {import('./config.js').Config} deps.config
 * @param {import('./store.js').PadStore} deps.store
 * @param {import('./auth.js').Access} deps.access
 * @param {import('./auth.js').TokenSigner} deps.signer
 * @param {import('./collab.js').CollabServer} deps.collab
 * @param {import('./exec.js').ExecServer | null} deps.exec
 * @param {(req: import('node:http').IncomingMessage) => string} deps.clientIp
 */
export function createApi({ config, store, access, signer, collab, exec, clientIp }) {
  const unlockLimiter = new Limiter(20, 10 * 60_000);
  const maxBodyBytes = config.maxPadChars * 3 + 1024;

  function tokensOf(req, url) {
    return [...parseTokens(req.headers['x-pad-tokens']), ...parseTokens(url.searchParams.get('t') ?? '')];
  }

  function padParam(url, name = 'path') {
    const p = normalizePadPath(url.searchParams.get(name) ?? '', { decoded: true });
    if (!p) throw new HttpError(400, 'Invalid pad path');
    return p;
  }

  function mustRead(padPath, tokens) {
    const perm = access.check(padPath, tokens);
    if (!perm.canRead) throw new HttpError(401, 'This pad is private. Unlock it first.');
    return perm;
  }

  function mustWrite(padPath, tokens) {
    const perm = mustRead(padPath, tokens);
    if (!perm.canWrite) throw new HttpError(403, 'This pad is locked. Unlock it to make changes.');
    return perm;
  }

  /** Reads a pad as plain text (also used for `GET /<pad>` from curl). */
  async function rawGet(res, padPath, tokens, { download = false } = {}) {
    mustRead(padPath, tokens);
    const text = (await store.getText(padPath)) ?? '';
    const headers = {};
    if (download) {
      const info = store.info(padPath);
      const name = baseName(padPath);
      const lang = effectiveLanguage(info?.language, name, text);
      headers['Content-Disposition'] = contentDisposition(mainFileName(name, lang, text).replace(/^main\./, `${name}.`));
    }
    sendText(res, 200, text, headers);
  }

  /** Writes a pad from a request body (`curl --data-binary @file`, `curl -T file`). */
  async function rawPut(req, res, padPath, tokens, append) {
    mustWrite(padPath, tokens);
    const body = await readBody(req, maxBodyBytes);
    const next = append ? ((await store.getText(padPath)) ?? '') + body : body;
    if (next.length > config.maxPadChars) throw new HttpError(413, 'Pad would be too large');
    await store.setText(padPath, next, 'api');
    sendText(res, 200, `Saved ${next.length} characters to /${padPath}\n`);
  }

  async function zipOf(padPath, tokens) {
    const rootName = baseName(padPath);
    const prefix = padPath + '/';
    const paths = [...store.index.keys()].filter((p) => p === padPath || p.startsWith(prefix)).sort();
    const isFolder = (p) => paths.some((q) => q.startsWith(p + '/'));
    const files = [];
    for (const p of paths) {
      if (!access.check(p, tokens).canRead) continue;
      const text = await store.getText(p);
      if (!text) continue;
      const info = store.info(p);
      const name = baseName(p);
      const lang = effectiveLanguage(info?.language, name, text);
      const rel = rootName + (p === padPath ? '' : '/' + p.slice(prefix.length));
      let file;
      if (isFolder(p)) file = `${rel}/${mainFileName(name, lang, text)}`;
      else if (/\.[A-Za-z0-9]+$/.test(name)) file = rel;
      else file = `${rel}.${LANGUAGE_BY_ID.get(lang)?.ext[0] ?? 'txt'}`;
      files.push({ name: file, data: text, mtime: new Date(info?.updatedAt || Date.now()) });
    }
    return createZip(files);
  }

  async function preview(req, res, url, rest) {
    // /_api/preview/<tokens or ->/<pad path>[/]
    const slash = rest.indexOf('/');
    if (slash < 0) throw new HttpError(404, 'Not found');
    const tokens = parseTokens(rest.slice(0, slash) === '-' ? '' : decodeURIComponent(rest.slice(0, slash)));
    const sub = rest.slice(slash + 1);
    const padPath = normalizePadPath(sub);
    if (!padPath) throw new HttpError(404, 'Not found');
    mustRead(padPath, tokens);
    const text = (await store.getText(padPath)) ?? '';
    const ext = /\.([A-Za-z0-9]+)$/.exec(baseName(padPath))?.[1]?.toLowerCase();
    const type = sub.endsWith('/') ? 'text/html' : (PREVIEW_TYPES[ext] ?? 'text/plain');
    const body = Buffer.from(text, 'utf8');
    res.writeHead(200, {
      'Content-Type': `${type}; charset=utf-8`,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // An opaque origin: the page's scripts cannot reach RunPad or its storage.
      'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
      // The URL carries lock tokens; links in the page must not pass it on.
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const routes = {
    'GET /_api/health': async (req, res) => sendJson(res, 200, { ok: true }),

    'GET /_api/config': async (req, res) =>
      sendJson(res, 200, {
        maxPadChars: config.maxPadChars,
        exec: exec ? exec.info() : { enabled: false, terminal: false, languages: [], needsKey: false },
      }),

    'GET /_api/pad': async (req, res, url) => {
      const padPath = padParam(url);
      const tokens = tokensOf(req, url);
      const perm = access.check(padPath, tokens);
      const info = store.info(padPath);
      sendJson(res, 200, {
        path: padPath,
        canRead: perm.canRead,
        canWrite: perm.canWrite,
        lock: perm.lock,
        ownLock: !!store.lockAt(padPath),
        canManageLock: !!store.lockAt(padPath) && perm.holds,
        online: collab.presence(padPath),
        ...(perm.canRead && info ? { size: info.size, createdAt: info.createdAt, updatedAt: info.updatedAt, language: info.language } : {}),
      });
    },

    'GET /_api/children': async (req, res, url) => {
      const padPath = padParam(url);
      mustRead(padPath, tokensOf(req, url));
      sendJson(res, 200, { path: padPath, children: store.children(padPath) });
    },

    'GET /_api/history': async (req, res, url) => {
      const padPath = padParam(url);
      mustRead(padPath, tokensOf(req, url));
      sendJson(res, 200, { path: padPath, items: await store.history(padPath) });
    },

    'GET /_api/history/item': async (req, res, url) => {
      const padPath = padParam(url);
      mustRead(padPath, tokensOf(req, url));
      const item = await store.historyItem(padPath, url.searchParams.get('id'));
      if (!item) throw new HttpError(404, 'No such version');
      sendJson(res, 200, item);
    },

    'POST /_api/history/restore': async (req, res, url) => {
      const body = await readJson(req);
      const padPath = normalizePadPath(String(body.path ?? ''), { decoded: true });
      if (!padPath) throw new HttpError(400, 'Invalid pad path');
      mustWrite(padPath, tokensOf(req, url));
      if (!(await store.restore(padPath, body.id))) throw new HttpError(404, 'No such version');
      sendJson(res, 200, { ok: true });
    },

    'POST /_api/snapshot': async (req, res, url) => {
      const body = await readJson(req);
      const padPath = normalizePadPath(String(body.path ?? ''), { decoded: true });
      if (!padPath) throw new HttpError(400, 'Invalid pad path');
      mustWrite(padPath, tokensOf(req, url));
      await store.snapshot(padPath);
      sendJson(res, 200, { ok: true });
    },

    'POST /_api/lock': async (req, res, url) => {
      const body = await readJson(req);
      const padPath = normalizePadPath(String(body.path ?? ''), { decoded: true });
      if (!padPath) throw new HttpError(400, 'Invalid pad path');
      const tokens = tokensOf(req, url);
      const perm = mustWrite(padPath, tokens);
      if (store.lockAt(padPath) && !perm.holds) throw new HttpError(403, 'Unlock this pad first.');
      const mode = body.mode === 'private' ? 'private' : body.mode === 'readonly' ? 'readonly' : null;
      if (!mode) throw new HttpError(400, 'Mode must be "readonly" or "private"');
      const password = typeof body.password === 'string' ? body.password : '';
      if (password.length < 4 || password.length > 200) throw new HttpError(400, 'Use a password of 4 to 200 characters.');
      const version = await store.setLock(padPath, { mode, ...(await hashPassword(password)) });
      sendJson(res, 200, { lock: { path: padPath, mode }, token: signer.sign(padPath, version) });
    },

    'POST /_api/unlock': async (req, res, url) => {
      if (!unlockLimiter.take(clientIp(req))) throw new HttpError(429, 'Too many attempts. Wait a few minutes.');
      const body = await readJson(req);
      const padPath = normalizePadPath(String(body.path ?? ''), { decoded: true });
      if (!padPath) throw new HttpError(400, 'Invalid pad path');
      const password = typeof body.password === 'string' ? body.password : '';
      for (const link of store.lockChain(padPath).reverse()) {
        const lock = store.lockAt(link.path);
        if (lock && (await verifyPassword(password, lock))) {
          return sendJson(res, 200, { lockPath: link.path, token: signer.sign(link.path, lock.version) });
        }
      }
      throw new HttpError(403, 'Wrong password.');
    },

    'POST /_api/lock/remove': async (req, res, url) => {
      const body = await readJson(req);
      const padPath = normalizePadPath(String(body.path ?? ''), { decoded: true });
      if (!padPath) throw new HttpError(400, 'Invalid pad path');
      const perm = access.check(padPath, tokensOf(req, url));
      if (!store.lockAt(padPath)) throw new HttpError(400, 'This pad has no lock of its own.');
      if (!perm.holds) throw new HttpError(403, 'Unlock this pad first.');
      await store.setLock(padPath, null);
      sendJson(res, 200, { ok: true });
    },

    'POST /_api/touch': async (req, res, url) => {
      const body = await readJson(req);
      const padPath = normalizePadPath(String(body.path ?? ''), { decoded: true });
      if (!padPath) throw new HttpError(400, 'Invalid pad path');
      mustWrite(padPath, tokensOf(req, url));
      if (typeof body.text === 'string' && body.text) {
        if (body.text.length > config.maxPadChars) throw new HttpError(413, 'File is too large');
        if (!(await store.getText(padPath))) await store.setText(padPath, body.text, 'api');
      }
      await store.touch(padPath);
      sendJson(res, 200, { ok: true, path: padPath });
    },

    'POST /_api/delete': async (req, res, url) => {
      const body = await readJson(req);
      const padPath = normalizePadPath(String(body.path ?? ''), { decoded: true });
      if (!padPath) throw new HttpError(400, 'Invalid pad path');
      const perm = mustWrite(padPath, tokensOf(req, url));
      if (store.lockAt(padPath) && !perm.holds) throw new HttpError(403, 'Unlock this pad first.');
      await store.remove(padPath);
      sendJson(res, 200, { ok: true });
    },
  };

  /**
   * Handles `/_api/...`. Resolves false when the URL is not an API route.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  async function handleApi(req, res, url) {
    const route = routes[`${req.method} ${url.pathname}`];
    if (route) return route(req, res, url);
    const [, kind, rest = ''] = /^\/_api\/(raw|zip|preview)\/(.*)$/.exec(url.pathname) ?? [];
    if (kind === 'preview' && (req.method === 'GET' || req.method === 'HEAD')) return preview(req, res, url, rest);
    if (!kind) throw new HttpError(404, 'Not found');
    const padPath = normalizePadPath(rest);
    if (!padPath) throw new HttpError(400, 'Invalid pad path');
    const tokens = tokensOf(req, url);
    if (kind === 'raw') {
      if (req.method === 'GET' || req.method === 'HEAD') return rawGet(res, padPath, tokens, { download: url.searchParams.has('download') });
      if (req.method === 'POST' || req.method === 'PUT') return rawPut(req, res, padPath, tokens, url.searchParams.has('append'));
    }
    if (kind === 'zip' && req.method === 'GET') {
      mustRead(padPath, tokens);
      const zip = await zipOf(padPath, tokens);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': zip.length,
        'Content-Disposition': contentDisposition(`${baseName(padPath)}.zip`),
        'Cache-Control': 'no-store',
      });
      return res.end(zip);
    }
    throw new HttpError(405, 'Method not allowed');
  }

  /** Wraps a handler so thrown HttpErrors become JSON (or text) error responses. */
  function guard(fn) {
    return async (req, res, url, ...rest) => {
      try {
        await fn(req, res, url, ...rest);
      } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error(`[api] ${req.method} ${url.pathname}: ${err.stack || err}`);
        if (res.headersSent) return res.destroy();
        const message = status >= 500 ? 'Internal server error' : err.message;
        const wantsText = url.pathname.startsWith('/_api/raw/') || !url.pathname.startsWith('/_api/');
        if (wantsText) sendText(res, status, message + '\n');
        else sendJson(res, status, { error: message });
      }
    };
  }

  return {
    handleApi: guard(handleApi),
    rawGet: guard((req, res, url, padPath) => rawGet(res, padPath, tokensOf(req, url), { download: url.searchParams.has('download') })),
    rawPut: guard((req, res, url, padPath) => rawPut(req, res, padPath, tokensOf(req, url), url.searchParams.has('append'))),
  };
}
