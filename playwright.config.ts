import { defineConfig } from '@playwright/test';

const DEFAULT_PORT = 4322;

function resolveTestPort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PORT;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `TEST_PORT must be an integer between 1024 and 65535, got "${raw}".`,
    );
  }
  return port;
}

const port = resolveTestPort(process.env.TEST_PORT);

export default defineConfig({
  testDir: '.',
  testMatch: ['packages/**/tests/*.spec.ts', 'examples/**/tests/*.spec.ts'],
  testIgnore: ['**/.worktrees/**'],
  timeout: 60_000,
  expect: { timeout: 30_000 },
  workers: 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 900, height: 640 },
    deviceScaleFactor: 1,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: `bun run build && bunx vite preview --port ${port} --strictPort`,
    port,
    reuseExistingServer: process.env.TEST_PORT === undefined && !process.env.CI,
    timeout: 180_000,
  },
});
