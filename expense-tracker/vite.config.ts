import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin, type ResolvedConfig } from 'vite';
import react from '@vitejs/plugin-react';

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/**
 * Emits sw.js with every built file in its precache list, so the installed app
 * opens with no network. The cache name changes whenever the file list does.
 */
function serviceWorker(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'expense-tracker-sw',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((file) => !file.endsWith('.map'));
      const publicFiles = config.publicDir
        ? listFiles(config.publicDir).map((file) => relative(config.publicDir, file).split('\\').join('/'))
        : [];
      const files = ['./', ...[...built, ...publicFiles].filter((file) => file !== 'index.html').sort()];
      const version = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `const CACHE = 'expense-tracker-${version}';
const FILES = ${JSON.stringify(files)};

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('expense-tracker-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    // Fresh page when online, the cached app shell when not.
    event.respondWith(fetch(request).catch(() => caches.match('./', { cacheName: CACHE })));
    return;
  }
  event.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)));
});
`,
      });
    },
  };
}

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig(({ mode }) => {
  // `--mode demo` builds one script and one stylesheet for scripts/build-demo-page.mjs to inline.
  const demo = mode === 'demo';
  return {
    // Relative URLs: the same build runs from GitHub Pages' sub-path and inside the Android app.
    base: './',
    define: { __APP_VERSION__: JSON.stringify(version) },
    plugins: demo ? [react()] : [react(), serviceWorker()],
    publicDir: demo ? false : 'public',
    build: {
      target: 'es2022',
      ...(demo ? { outDir: 'dist-demo', rollupOptions: { output: { inlineDynamicImports: true } } } : {}),
    },
  };
});
