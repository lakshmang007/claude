import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = 5299;
// A fresh data directory per run, so tests never see old pads.
const data = path.join(os.tmpdir(), `runpad-e2e-${process.pid}`);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1360, height: 820 },
  },
  webServer: {
    command: 'node server/index.js',
    url: `http://127.0.0.1:${PORT}/_api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT), HOST: '127.0.0.1', RUNPAD_DATA: data, RUNPAD_WORK: `${data}-work` },
  },
});
