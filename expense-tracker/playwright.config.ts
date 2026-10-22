import { defineConfig, devices } from '@playwright/test';

const PORT = 5190;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://127.0.0.1:${PORT}/`,
    timezoneId: 'Asia/Kolkata',
    locale: 'en-IN',
  },
  webServer: {
    // The production build, so the service worker and manifest are the real ones.
    command: `npm run build && npx vite preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
