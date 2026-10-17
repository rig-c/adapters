import { cpSync, readdirSync, existsSync } from 'node:fs';
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
  const examples: Record<string, string> = {};
  if (existsSync('examples/look/index.html')) {
    examples.look = 'examples/look/index.html';
  }
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
        { find: /^@rig-c\/three$/, replacement: resolve('packages/three/src/index.ts') },
      ],
    } : undefined,
    plugins: [
      {
        name: 'copy-examples-look-rig',
        closeBundle() {
          if (existsSync('examples/look/rig')) {
            cpSync('examples/look/rig', 'dist/examples/look/rig', { recursive: true });
          }
        },
      },
    ],
    build: {
      rollupOptions: {
        input: { main: 'index.html', threeDemo: 'three-demo.html', ...examples, ...harnesses },
      },
    },
  };
});
