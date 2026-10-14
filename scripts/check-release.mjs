import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Manifest } from 'release-please';
import { parse } from 'yaml';
import { createServer } from 'vite';
import { root, run, workspaces, publishable } from './workspaces.mjs';
import { assertPublicationEnvironment, releasePlan } from './release-plan.mjs';

const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8'));
const versions = JSON.parse(readFileSync(join(root, '.release-please-manifest.json'), 'utf8'));
assert.deepEqual(Object.keys(config.packages).sort(), publishable().map((pkg) => pkg.path).sort(), 'RELEASE_COMPONENTS: each public workspace needs exactly one component');
for (const pkg of publishable()) assert.equal(versions[pkg.path], pkg.version, `RELEASE_VERSION: ${pkg.path}`);
assert.equal(config['separate-pull-requests'], true, 'RELEASE_SEPARATE: package PRs must be independent');
const release = parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'));
assert.equal(release.jobs.publish.if.includes("vars.ADAPTERS_PUBLISH_ENABLED == 'true'"), true, 'RELEASE_GATE: owner enable required');
assert.equal(release.jobs.publish.strategy.matrix.package.includes('needs.plan.outputs.packages'), true, 'RELEASE_MATRIX: published packages must come from the dynamic plan');
assert.equal(release.jobs.publish.permissions['id-token'], 'write', 'RELEASE_PROVENANCE: id-token permission absent');
assert.throws(() => assertPublicationEnvironment({}), /PUBLISH_DISABLED/);
assert.throws(() => assertPublicationEnvironment({ ADAPTERS_PUBLISH_ENABLED: 'true' }), /PUBLISH_CREDENTIALS/);
assert.throws(() => assertPublicationEnvironment({ ADAPTERS_PUBLISH_ENABLED: 'true', NODE_AUTH_TOKEN: 'fixture' }), /PUBLISH_PROVENANCE/);
assert.throws(() => releasePlan(['packages/shared']), /PUBLISH_PRIVATE/);
assert.throws(() => releasePlan(['packages/missing']), /RELEASE_PATH/);
const gateMutant = structuredClone(release);
gateMutant.jobs.publish.if = "needs.plan.outputs.packages != '[]'";
assert.throws(() => assert.equal(gateMutant.jobs.publish.if.includes("vars.ADAPTERS_PUBLISH_ENABLED == 'true'"), true));
console.log('[bar6:publication-gates] disabled, enabled/no credentials, absent provenance, private/unknown path refused; gate-removal mutant RED; PASS');

const temp = mkdtempSync(join(tmpdir(), 'adapters-second-host-'));
try {
  cpSync(root, temp, { recursive: true, filter: (source) => !['.git', 'node_modules', '.worktrees', 'dist', 'public', 'test-results', 'playwright-report'].includes(basename(source)) });
  // Same workspace/manifest/suite steps as ADDING_A_HOST.md, private solely for this dry run.
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
  const fixtureConfig = structuredClone(config);
  fixtureConfig.packages[path] = { component: '_example' };
  writeFileSync(join(temp, 'release-please-config.json'), JSON.stringify(fixtureConfig));
  writeFileSync(join(temp, '.release-please-manifest.json'), JSON.stringify({ ...versions, [path]: '0.1.0' }));
  assert(workspaces(temp).some((pkg) => pkg.path === path));
  assert(!publishable(temp).some((pkg) => pkg.path === path));
  symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'), 'dir');
  for (const pkg of workspaces()) {
    const dependencies = join(pkg.dir, 'node_modules');
    if (existsSync(dependencies)) symlinkSync(dependencies, join(temp, pkg.path, 'node_modules'), 'dir');
  }
  const discovery = run('bunx', ['--no-install', 'playwright', 'test', '--list', '--config', join(temp, 'playwright.config.ts')], { cwd: temp });
  assert(discovery.includes('second host production harness'), 'SECOND_HOST_CI: parity suite not discovered');
  assert(discovery.includes('[chromium]') && discovery.includes('[webkit]'), 'SECOND_HOST_CI: both browsers not discovered');
  for (const workflow of ['ci.yml', 'release.yml']) {
    assert.equal(readFileSync(join(temp, '.github/workflows', workflow), 'utf8'), readFileSync(join(root, '.github/workflows', workflow), 'utf8'));
  }
  console.log('[bar2:scaffold] packages/_example: private workspace + manifest component + chromium/webkit suite discovered; workflows unchanged; PASS');
  run('bunx', ['--no-install', 'vite', 'build'], { cwd: temp });
  assert(existsSync(join(temp, 'dist/packages/_example/tests/harness.html')), 'SECOND_HOST_BUILD: new harness absent from production output');
  const previewConfig = readFileSync(join(temp, 'playwright.config.ts'), 'utf8')
    .replace('bun run build && bunx vite preview', 'bunx --no-install vite preview');
  writeFileSync(join(temp, 'playwright.config.ts'), previewConfig);
  const preview = run('bunx', ['--no-install', 'playwright', 'test', '--config', join(temp, 'playwright.config.ts'), '--project', 'chromium', '--grep', 'second host production harness'], { cwd: temp, env: { ...process.env, CI: '1', TEST_PORT: '4331' } });
  console.log(`[bar2:preview] new host harness built by unchanged generic Vite config and served in production preview: ${preview.trim()}; PASS`);
  // A clean dev consumer must use live source, even when no package dist exists.
  const previousCwd = process.cwd();
  let dev;
  try {
    process.chdir(temp);
    dev = await createServer({ root: temp, configFile: join(temp, 'vite.config.ts'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 } });
    await dev.listen();
    const port = dev.httpServer.address().port;
    const main = await (await fetch(`http://127.0.0.1:${port}/src/main.ts`)).text();
    assert(main.includes('/packages/pixi/src/index.ts'), 'DEV_SOURCE: demo must resolve the live Pixi source entry');
    const source = join(temp, 'packages/pixi/src/pixi.ts');
    await fetch(`http://127.0.0.1:${port}/packages/pixi/src/pixi.ts`);
    writeFileSync(source, readFileSync(source, 'utf8') + '\nexport const DEV_REFRESH_PROBE = \"fresh-source\";\n');
    let refreshed = false;
    for (let attempt = 0; attempt < 20 && !refreshed; attempt++) {
      await new Promise((done) => setTimeout(done, 100));
      const text = await (await fetch(`http://127.0.0.1:${port}/packages/pixi/src/pixi.ts`)).text();
      refreshed = text.includes('DEV_REFRESH_PROBE');
    }
    assert(refreshed, 'DEV_REFRESH: source edit was not reflected without library rebuild');
    console.log('[development:source] clean dev resolves source entry and source edit refreshes transformed module without package rebuild; PASS');
  } finally {
    if (dev) await dev.close();
    process.chdir(previousCwd);
  }



  async function dryRun(changedPath) {
    const calls = [];
    // A bounded read-only SCM fixture supplies commits/files. The installed
    // release-please parser, manifest splitter and Node strategy produce the PR.
    const scm = new Proxy({
      repository: { owner: 'rig-c', repo: 'adapters', defaultBranch: 'main' },
      async getFileJson(file) { calls.push(`read:${file}`); return JSON.parse(readFileSync(join(temp, file), 'utf8')); },
      async getFileContentsOnBranch(file) { calls.push(`read:${file}`); const parsedContent = readFileSync(join(temp, file), 'utf8'); return { parsedContent, content: Buffer.from(parsedContent).toString('base64'), sha: 'fixture-file', mode: '100644' }; },
      async *releaseIterator() {},
      async *tagIterator() {},
      async *mergeCommitIterator() { yield { sha: '1111111111111111111111111111111111111111', message: 'fix: confined host dry-run control', files: [`${changedPath}/src/index.ts`] }; },
    }, { get(target, key) { if (key in target) return target[key]; throw new Error(`RELEASE_FIXTURE_UNEXPECTED_OPERATION: ${String(key)}`); } });
    const manifest = await Manifest.fromManifest(scm, 'main');
    const prs = await manifest.buildPullRequests();
    const output = prs.map((pr) => ({ title: pr.title.toString(), version: pr.version?.toString(), paths: pr.updates.map((update) => update.path) }));
    assert.equal(output.length, 1, `RELEASE_DRY_RUN: ${changedPath} needs one PR, found ${output.length}`);
    assert(output[0].paths.some((file) => file === `${changedPath}/package.json`), `RELEASE_DRY_RUN: missing ${changedPath} package update`);
    assert(!output[0].paths.some((file) => file.startsWith('packages/') && !file.startsWith(`${changedPath}/`)), 'RELEASE_DRY_RUN: unrelated host changed');
    console.log(`[bar2:release-please-dry-run] input=${changedPath}/src/index.ts; actual Manifest.buildPullRequests=${JSON.stringify(output)}; SCM calls=${calls.join(',')}; PASS`);
    return output;
  }
  await dryRun('packages/pixi');
  await dryRun(path);
  // Adversarial absence: unrelated root docs must release neither component.
  const emptyScm = {
    repository: { owner: 'rig-c', repo: 'adapters', defaultBranch: 'main' },
    async getFileJson(file) { return JSON.parse(readFileSync(join(temp, file), 'utf8')); },
    async getFileContentsOnBranch(file) { const parsedContent = readFileSync(join(temp, file), 'utf8'); return { parsedContent, content: Buffer.from(parsedContent).toString('base64'), sha: 'fixture-file' }; },
    async *releaseIterator() {}, async *tagIterator() {},
    async *mergeCommitIterator() { yield { sha: '2222222222222222222222222222222222222222', message: 'fix: unrelated documentation control', files: ['README.md'] }; },
  };
  const empty = await Manifest.fromManifest(emptyScm, 'main');
  assert.deepEqual(await empty.buildPullRequests(), [], 'RELEASE_DRY_RUN: root-only change must not release hosts');
  console.log('[bar2:release-please-control] root-only commit -> no PR; PASS');
} finally {
  rmSync(temp, { recursive: true, force: true });
  assert(!existsSync(temp));
  console.log('[bar2:cleanup] throwaway second-host scaffold removed; PASS');
}
