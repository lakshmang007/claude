import { defineConfig, type Plugin } from 'vite';
import { createApiMiddleware } from './server/api.js';

/** Serves the reference-search API from the Vite dev/preview server too. */
function trueformApi(): Plugin {
  return {
    name: 'trueform-api',
    configureServer(server) {
      server.middlewares.use(createApiMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createApiMiddleware());
    },
  };
}

// Cross-origin isolation enables multi-threaded WASM for the in-browser models.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  plugins: [trueformApi()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4096 },
});
