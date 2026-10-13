#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApiMiddleware } from './api.js';
import { enabledProviders } from './providers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** Cross-origin isolation lets ONNX Runtime use multi-threaded WASM. */
function isolationHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
}

const api = createApiMiddleware();

function serveStatic(req, res) {
  const url = new URL(req.url || '/', 'http://local');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, '.' + rel);
  if (!file.startsWith(root + path.sep)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(root, 'index.html');
    const ext = path.extname(target);
    fs.readFile(target, (e, data) => {
      if (e) {
        res.statusCode = 404;
        return res.end('Not found. Did you run `npm run build`?');
      }
      res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', target.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      res.end(data);
    });
  });
}

const server = http.createServer((req, res) => {
  isolationHeaders(res);
  api(req, res, () => serveStatic(req, res));
});

server.listen(port, host, () => {
  const list = enabledProviders()
    .map((p) => p.label)
    .join(', ');
  console.log(`TrueForm 3D running at http://${host}:${port}`);
  console.log(`Reference search providers: ${list}`);
});
