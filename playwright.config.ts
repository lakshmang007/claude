import { defineConfig } from '@playwright/test';

const PORT = 5179;
const ARTIFACT_PORT = 5180;

export default defineConfig({
  testDir: 'tests/e2e',
  // WebGL runs on the CPU (SwiftShader); parallel browsers starve each other past the timeouts.
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 60_000 },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1400, height: 900 },
    launchOptions: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: [
    {
      command: `npx vite --port ${PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      // The static demo bundle as a locked-down artifact host serves it (tests/e2e/artifact.spec.ts).
      command: `npm run build:artifact && node tests/e2e/artifact-host.mjs ${ARTIFACT_PORT}`,
      url: `http://127.0.0.1:${ARTIFACT_PORT}/hosted/demo/`,
      reuseExistingServer: true,
      timeout: 180_000,
    },
  ],
});
