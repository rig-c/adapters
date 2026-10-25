import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'timing.spec.mjs',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4337', browserName: 'chromium' },
  webServer: {
    cwd: resolve(import.meta.dirname, '..'),
    command: 'RIG_BENCH=1 bunx --no-install vite --host 127.0.0.1 --port 4337 --strictPort',
    url: 'http://127.0.0.1:4337/bench/index.html',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
