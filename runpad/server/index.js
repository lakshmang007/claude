#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { normalizePadPath } from '../shared/padpath.js';
import { createApi, sendText } from './api.js';
import { Access, TokenSigner, loadSecret, parseTokens } from './auth.js';
import { CLOSE_BAD_PATH, CollabServer } from './collab.js';
import { ROOT, loadConfig } from './config.js';
import { ExecServer } from './exec.js';
import { detectToolchains } from './languages.js';
import { Sandbox } from './sandbox.js';
import { PadStore } from './store.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  // CodeMirror styles the editor with <style> elements.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "connect-src 'self' ws: wss:",
  "frame-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

/**
 * Starts RunPad. Returns handles for tests.
 * @param {ReturnType<typeof loadConfig>} config
 */
export async function startServer(config = loadConfig()) {
  const secret = loadSecret(config.dataDir);
  const signer = new TokenSigner(secret);
  const store = await new PadStore({ dataDir: config.dataDir, maxPadChars: config.maxPadChars, history: config.history }).init();
  const access = new Access(store, signer);
  const collab = new CollabServer({ store, access });

  let exec = null;
  if (config.exec.enabled) {
    const only = process.env.RUNPAD_LANGUAGES ? process.env.RUNPAD_LANGUAGES.split(',').map((s) => s.trim()) : undefined;
    const languages = await detectToolchains({ only, uid: config.exec.uid, gid: config.exec.gid });
    const sandbox = new Sandbox({ ...config.exec, hide: [config.dataDir] }).init();
    exec = await new ExecServer({ config, store, access, signer, sandbox, languages }).init();
  }

  const clientIp = (req) => {
    if (config.trustProxy) {
      const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
      if (fwd) return fwd;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };
  const api = createApi({ config, store, access, signer, collab, exec, clientIp });

  const distDir = path.join(ROOT, 'dist');
  /** @type {import('vite').ViteDevServer | null} */
  let vite = null;
  const server = http.createServer();
  if (config.dev) {
    const { createServer } = await import('vite');
    vite = await createServer({
      root: ROOT,
      appType: 'custom',
      server: { middlewareMode: true, hmr: { server } },
    });
  } else if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.warn('No build found in dist/. Run `npm run build` first, or use `npm run dev`.');
  }

  async function indexHtml(url) {
    if (vite) {
      const template = await fsp.readFile(path.join(ROOT, 'index.html'), 'utf8');
      return vite.transformIndexHtml(url, template);
    }
    return fsp.readFile(path.join(distDir, 'index.html'), 'utf8');
  }

  async function serveApp(req, res, url) {
    let html;
    try {
      html = await indexHtml(url.pathname);
    } catch {
      return sendText(res, 503, 'RunPad has not been built. Run `npm run build`.\n');
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...(vite ? {} : { 'Content-Security-Policy': CSP }),
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  }

  async function serveStatic(req, res, url) {
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return sendText(res, 400, 'Bad request\n');
    }
    const file = path.resolve(distDir, '.' + rel);
    if (!file.startsWith(distDir + path.sep)) return sendText(res, 403, 'Forbidden\n');
    try {
      const data = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': rel.startsWith('/_assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendText(res, 404, 'Not found\n');
    }
  }

  server.on('request', async (req, res) => {
    const url = new URL(req.url || '/', 'http://local');
    const { pathname } = url;
    if (pathname.startsWith('/_api/')) return api.handleApi(req, res, url);

    const accept = String(req.headers.accept ?? '');
    const isPage = req.method === 'GET' || req.method === 'HEAD';
    if (vite && !(isPage && accept.includes('text/html'))) {
      // Modules, styles and HMR come from Vite in development.
      return vite.middlewares(req, res, () => sendText(res, 404, 'Not found\n'));
    }
    if (pathname.startsWith('/_assets/') || pathname.startsWith('/_static/')) return serveStatic(req, res, url);
    if (pathname === '/favicon.ico') {
      res.writeHead(301, { Location: '/_static/favicon.svg' });
      return res.end();
    }
    if (pathname === '/robots.txt') return sendText(res, 200, 'User-agent: *\nDisallow: /\n');
    if (pathname === '/' || pathname === '') {
      if (isPage) return serveApp(req, res, url);
      return sendText(res, 405, 'Method not allowed\n');
    }
    const padPath = normalizePadPath(pathname);
    if (!padPath) return sendText(res, 404, 'Not a valid pad name\n');
    if (req.method === 'POST' || req.method === 'PUT') return api.rawPut(req, res, url, padPath);
    if (!isPage) return sendText(res, 405, 'Method not allowed\n');
    // Browsers get the editor; curl, wget and scripts get the text.
    if (url.searchParams.has('raw') || url.searchParams.has('download') || !accept.includes('text/html')) {
      return api.rawGet(req, res, url, padPath);
    }
    return serveApp(req, res, url);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(4 * 1024 * 1024, config.maxPadChars * 4) });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://local');
    if (!url.pathname.startsWith('/_ws/')) return; // Vite's HMR socket, in development
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try {
        ok = new URL(origin).host === req.headers.host;
      } catch {
        /* malformed */
      }
      if (!ok) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
    }
    if (url.pathname.startsWith('/_ws/doc/')) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const padPath = normalizePadPath(url.pathname.slice('/_ws/doc/'.length));
        if (!padPath) return ws.close(CLOSE_BAD_PATH, 'invalid pad');
        collab.handle(ws, padPath, parseTokens(url.searchParams.get('t') ?? '')).catch((err) => {
          console.error(`[collab] ${err.stack || err}`);
          ws.close(1011, 'server error');
        });
      });
    } else if (url.pathname === '/_ws/exec' && exec) {
      wss.handleUpgrade(req, socket, head, (ws) => exec.handle(ws, clientIp(req)));
    } else {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve(undefined));
  });

  async function close() {
    collab.close();
    exec?.close();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => server.close(() => resolve(undefined)));
    server.closeAllConnections?.();
    await vite?.close();
    await store.flush();
  }

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  return { server, port, store, collab, exec, close };
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const config = loadConfig();
  const app = await startServer(config);
  const hosts = config.host === '0.0.0.0' || config.host === '::' ? ['localhost', ...lanAddresses()] : [config.host];
  console.log(`RunPad${config.dev ? ' (development)' : ''} is running:`);
  for (const h of hosts) console.log(`  http://${h}:${app.port}/`);
  console.log(`Pads are stored in ${config.dataDir}`);
  if (app.exec) {
    const info = app.exec.info();
    console.log(`Code execution: ${info.sandbox}; languages: ${info.languages.map((l) => l.id).join(', ') || 'none found'}`);
    if (!info.needsKey && config.host !== '127.0.0.1' && config.host !== 'localhost') {
      console.log('  Anyone who can reach this server can run code on it. Set RUNPAD_EXEC_TOKEN to require a key.');
    }
  } else {
    console.log('Code execution is off (RUNPAD_EXEC=off).');
  }
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      if (stopping) process.exit(1);
      stopping = true;
      console.log('Saving pads…');
      await app.close();
      process.exit(0);
    });
  }
}
