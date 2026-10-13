#!/usr/bin/env node
// Serves artifact/ the way a locked-down artifact host does: the page fragment wrapped in the
// host's own <!doctype html><head><body> skeleton, under a sub-path, with a policy that allows
// no external stylesheets and no requests to other origins, and no /api behind it.
//
//   node tests/e2e/artifact-host.mjs [port]
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'artifact');
const port = Number(process.argv[2] || 5180);
const PREFIX = '/hosted/demo/';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(body);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://host');
    if (!url.pathname.startsWith(PREFIX)) return send(res, 404, 'Not found');
    const rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      if (rel === 'index.html') {
        res.setHeader('Content-Security-Policy', CSP);
        const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${data}</body></html>`;
        return send(res, 200, page, 'text/html; charset=utf-8');
      }
      send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`Artifact host on http://127.0.0.1:${port}${PREFIX}`));
