import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
import base from '../../../playwright.config.ts';

const root = resolve(import.meta.dirname, '../../..');
const webServer = base.webServer;
if (!webServer || Array.isArray(webServer)) throw new Error('Expected one repository test web server');

// A dedicated root avoids treating this checkout's own .worktrees ancestor
// as a nested checkout to ignore. The normal full-suite config is unchanged.
export default defineConfig({
  ...base,
  testDir: root,
  testMatch: '**/packages/pixi/tests/live.spec.ts',
  testIgnore: [],
  workers: 1,
  webServer: { ...webServer, cwd: root, reuseExistingServer: false },
});
