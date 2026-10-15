import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig(({ command }) => {
  const packages = resolve('packages');
  const harnesses = Object.fromEntries(
    readdirSync(packages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => [entry.name, `packages/${entry.name}/tests/harness.html`] as const)
      .filter(([, path]) => existsSync(path)),
  );
  return {
    // The demo is a source consumer in development, so first dev and HMR need
    // no preceding library build. Production/installed smoke use package exports.
    server: command === 'serve' ? {
      fs: { allow: [resolve('.')] },
    } : undefined,
    resolve: command === 'serve' ? {
      alias: [
        { find: /^@rig-c\/pixi(?:\/pixi)?$/, replacement: resolve('packages/pixi/src/index.ts') },
        { find: /^@rig-c\/phaser$/, replacement: resolve('packages/phaser/src/index.ts') },
      ],
    } : undefined,
    build: {
      rollupOptions: { input: { main: 'index.html', ...harnesses } },
    },
  };
});
