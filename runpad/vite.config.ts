import { defineConfig } from 'vite';

// In development the RunPad server (npm run dev) hosts Vite as middleware, so pads,
// the API and WebSockets all share one origin. `npm run build` writes dist/ for `npm start`.
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'dist',
    // Pad names can be anything, so the app's own files live under reserved `_` prefixes.
    assetsDir: '_assets',
    chunkSizeWarningLimit: 1500,
  },
});
