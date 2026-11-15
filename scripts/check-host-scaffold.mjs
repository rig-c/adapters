import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { checkDevSource } from './dev-source-probe.mjs';
import { root, run, workspaces, publishable } from './workspaces.mjs';

const temp = mkdtempSync(join(tmpdir(), 'adapters-second-host-'));
try {
  cpSync(root, temp, { recursive: true, filter: (source) => !['.git', 'node_modules', '.worktrees', 'dist', 'public', 'test-results', 'playwright-report'].includes(basename(source)) });
  // Same workspace/suite steps as ADDING_A_HOST.md, private solely for this dry run.
  const path = 'packages/_example';
  const dir = join(temp, path);
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, 'tests'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@rig-c/_example', version: '0.1.0', private: true, type: 'module', exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } }, files: ['dist', 'README.md', 'LICENSE', 'NOTICE'], sideEffects: false, peerDependencies: { '@rig-c/play': '^1.10.0' } }));
  writeFileSync(join(dir, 'src/index.ts'), 'export function draw(canvas: HTMLCanvasElement): void { const ctx = canvas.getContext(\"2d\"); if (!ctx) throw new Error(\"EXAMPLE_CONTEXT\"); ctx.fillStyle = \"rgb(17, 34, 51)\"; ctx.fillRect(0, 0, 1, 1); }\n');
  writeFileSync(join(dir, 'tests/harness.html'), '<!doctype html><canvas id=\"example\" width=\"1\" height=\"1\"></canvas><script type=\"module\" src=\"./harness.ts\"></script>');
  writeFileSync(join(dir, 'tests/harness.ts'), 'import { draw } from \"../src/index.ts\"; const canvas = document.querySelector(\"canvas\"); if (!canvas) throw new Error(\"EXAMPLE_CANVAS\"); draw(canvas); document.body.dataset.ready = \"true\";');
  writeFileSync(join(dir, 'tests/example.spec.ts'), "import { expect, test } from '@playwright/test';\ntest('second host production harness', async ({ page }) => { const response = await page.goto('/packages/_example/tests/harness.html'); expect(response?.status()).toBe(200); await page.waitForFunction(() => document.body.dataset.ready === 'true'); const pixel = await page.evaluate(() => Array.from(document.querySelector('canvas')!.getContext('2d')!.getImageData(0, 0, 1, 1).data)); expect(pixel).toEqual([17, 34, 51, 255]); });\n");
  cpSync(join(root, 'packages/pixi/tsconfig.build.json'), join(dir, 'tsconfig.build.json'));
  for (const file of ['README.md', 'LICENSE', 'NOTICE']) cpSync(join(root, 'packages/pixi', file), join(dir, file));
  assert(workspaces(temp).some((pkg) => pkg.path === path));
  assert(!publishable(temp).some((pkg) => pkg.path === path));
  symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
  for (const pkg of workspaces()) {
    const dependencies = join(pkg.dir, 'node_modules');
    if (existsSync(dependencies)) symlinkSync(dependencies, join(temp, pkg.path, 'node_modules'), 'dir');
  }
  const oracleDependencies = join(root, 'tests/oracle/node_modules');
  if (existsSync(oracleDependencies)) symlinkSync(oracleDependencies, join(temp, 'tests/oracle/node_modules'), 'dir');
  const discovery = run('bunx', ['--no-install', 'playwright', 'test', '--list', '--config', join(temp, 'playwright.config.ts')], { cwd: temp });
  assert(discovery.includes('second host production harness'), 'SECOND_HOST_CI: parity suite not discovered');
  assert(discovery.includes('[chromium]') && discovery.includes('[webkit]'), 'SECOND_HOST_CI: both browsers not discovered');
  for (const workflow of ['ci.yml', 'release.yml']) {
    assert.equal(readFileSync(join(temp, '.github/workflows', workflow), 'utf8'), readFileSync(join(root, '.github/workflows', workflow), 'utf8'));
  }
  console.log('[bar2:scaffold] packages/_example: private workspace + chromium/webkit suite discovered; workflows unchanged; PASS');
  run('bunx', ['--no-install', 'vite', 'build'], { cwd: temp });
  assert(existsSync(join(temp, 'dist/packages/_example/tests/harness.html')), 'SECOND_HOST_BUILD: new harness absent from production output');
  const previewConfig = readFileSync(join(temp, 'playwright.config.ts'), 'utf8')
    .replace('bun run build && bunx vite preview', 'bunx --no-install vite preview');
  writeFileSync(join(temp, 'playwright.config.ts'), previewConfig);
  const preview = run('bunx', ['--no-install', 'playwright', 'test', '--config', join(temp, 'playwright.config.ts'), '--project', 'chromium', '--grep', 'second host production harness'], { cwd: temp, env: { ...process.env, CI: '1', TEST_PORT: '4331' } });
  console.log(`[bar2:preview] new host harness built by unchanged generic Vite config and served in production preview: ${preview.trim()}; PASS`);
  // A clean dev consumer must use live source, even when no package dist exists.
  await checkDevSource(temp);
  console.log(run('bun', [join(root, 'scripts/check-dev-source-probe.mjs')]).trim());

} finally {
  rmSync(temp, { recursive: true, force: true });
  assert(!existsSync(temp));
  console.log('[bar2:cleanup] throwaway second-host scaffold removed; PASS');
}
