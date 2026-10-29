import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../playwright.config.ts';

const root = resolve(import.meta.dirname, '..');
const webkit = base.projects?.find(project => project.name === 'webkit');
if (!webkit) throw new Error('POOL_WEBKIT_PROJECT: expected the repository WebKit project');
const webServer = base.webServer;
if (!webServer || Array.isArray(webServer)) {
  throw new Error('POOL_WEBKIT_SERVER: expected one repository test web server');
}

export default defineConfig({
  ...base,
  testDir: root,
  globalSetup: resolve(root, 'scripts/probe-webkit-newpage.ts'),
  workers: 1,
  projects: [{
    ...webkit,
    use: {
      ...webkit.use,
      // WSL's default EGL device selection can stall before newPage resolves.
      // This process-local Mesa setting requires no pool image modification.
      launchOptions: {
        ...webkit.use?.launchOptions,
        env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1' },
      },
    },
  }],
  webServer: { ...webServer, cwd: root, reuseExistingServer: false },
});
