import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
function assertPublicationWorkflow(workflow) {
  const publish = workflow.jobs.publish;
  assert.equal(publish.if.includes("vars.ADAPTERS_PUBLISH_ENABLED == 'true'"), true, 'RELEASE_GATE: owner enable required');
  assert.equal(publish.strategy.matrix.package.includes('needs.plan.outputs.packages'), true, 'RELEASE_MATRIX: published packages must come from the dynamic plan');
  assert.equal(publish.permissions['id-token'], 'write', 'RELEASE_PROVENANCE: id-token permission absent');
  assert.equal(publish['runs-on'], 'ubuntu-latest', 'RELEASE_RUNNER: trusted publishing requires a GitHub-hosted runner');
  assert.equal(publish.environment, 'npm', 'RELEASE_ENVIRONMENT: trusted publisher identity uses the npm environment');
  assert(publish.steps.some((step) => step.uses?.startsWith('actions/setup-node@') && step.with['node-version'] === '22'), 'RELEASE_NODE: Node 22 setup absent');
  assert(publish.steps.some((step) => step.run?.includes('npm install -g npm@11.5.1')), 'RELEASE_NPM: trusted publishing requires npm >= 11.5.1');
  assert.doesNotMatch(JSON.stringify(publish), /NPM_TOKEN|NODE_AUTH_TOKEN/, 'RELEASE_TOKEN: publication must not depend on npm token secrets');
}
assertPublicationWorkflow(release);
// This is a context fixture, not an OIDC exchange. npm verifies the real token
// and trusted publisher identity only during an owner-authorized publication.
const oidc = { ADAPTERS_PUBLISH_ENABLED: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'context-fixture' };
assert.doesNotThrow(() => assertPublicationEnvironment(oidc));
assert.throws(() => assertPublicationEnvironment({}), /PUBLISH_DISABLED/);
assert.throws(() => assertPublicationEnvironment({ ...oidc, ADAPTERS_PUBLISH_ENABLED: 'false' }), /PUBLISH_DISABLED/);
assert.throws(() => assertPublicationEnvironment({ ADAPTERS_PUBLISH_ENABLED: 'true' }), /PUBLISH_PROVENANCE/);
assert.throws(() => assertPublicationEnvironment({ ADAPTERS_PUBLISH_ENABLED: 'true', NODE_AUTH_TOKEN: 'fixture' }), /PUBLISH_PROVENANCE/);
assert.throws(() => assertPublicationEnvironment({ ...oidc, RUNNER_ENVIRONMENT: 'self-hosted' }), /PUBLISH_PROVENANCE/);
for (const field of ['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']) {
  const missing = { ...oidc };
  delete missing[field];
  assert.throws(() => assertPublicationEnvironment(missing), /PUBLISH_PROVENANCE/, `RELEASE_OIDC: missing ${field} must refuse`);
}
assert.throws(() => releasePlan(['packages/shared']), /PUBLISH_PRIVATE/);
assert.throws(() => releasePlan(['packages/missing']), /RELEASE_PATH/);
for (const [name, mutate, refusal] of [
  ['owner gate removal', (workflow) => { workflow.jobs.publish.if = "needs.plan.outputs.packages != '[]'"; }, /RELEASE_GATE/],
  ['OIDC permission removal', (workflow) => { delete workflow.jobs.publish.permissions['id-token']; }, /RELEASE_PROVENANCE/],
  ['self-hosted runner', (workflow) => { workflow.jobs.publish['runs-on'] = 'self-hosted'; }, /RELEASE_RUNNER/],
  ['npm downgrade', (workflow) => { workflow.jobs.publish.steps.find((step) => step.run?.includes('npm install -g')).run = 'npm install -g npm@10'; }, /RELEASE_NPM/],
  ['token dependency', (workflow) => { workflow.jobs.publish.steps.at(-1).env.NODE_AUTH_TOKEN = '${{ secrets.NPM_TOKEN }}'; }, /RELEASE_TOKEN/],
]) {
  const mutant = structuredClone(release);
  mutate(mutant);
  assert.throws(() => assertPublicationWorkflow(mutant), refusal, `RELEASE_MUTANT: ${name}`);
}
console.log('[bar6:publication-gates] disabled, self-hosted and each absent OIDC field refused; token-free context fixture accepted; private/unknown path refused; gate/OIDC/runner/npm/token mutants RED; PASS');

const publication = mkdtempSync(join(tmpdir(), 'adapters-publication-'));
try {
  const calls = join(publication, 'calls.json');
  const npm = join(publication, 'npm');
  writeFileSync(npm, '#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.PUBLICATION_CALLS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n');
  chmodSync(npm, 0o755);
  const env = { ...process.env, PATH: `${publication}:${process.env.PATH}`, PUBLICATION_CALLS: calls };
  for (const field of [...Object.keys(oidc), 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) delete env[field];
  const execute = (context) => Bun.spawnSync([process.execPath, join(root, 'scripts/release-plan.mjs'), '["packages/pixi"]', '--execute'], { env: { ...env, ...context }, stdout: 'pipe', stderr: 'pipe' });
  const missingRunner = { ...oidc };
  delete missingRunner.RUNNER_ENVIRONMENT;
  for (const [context, refusal] of [[{}, /PUBLISH_DISABLED/], [{ ADAPTERS_PUBLISH_ENABLED: 'true' }, /PUBLISH_PROVENANCE/], [missingRunner, /PUBLISH_PROVENANCE/], [{ ...oidc, RUNNER_ENVIRONMENT: 'self-hosted' }, /PUBLISH_PROVENANCE/]]) {
    const result = execute(context);
    assert.notEqual(result.exitCode, 0, 'RELEASE_EXECUTE: invalid context must fail');
    assert.match(result.stderr.toString(), refusal);
    assert.equal(existsSync(calls), false, 'RELEASE_EXECUTE: refused publication must not invoke npm');
  }
  const result = execute(oidc);
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')), { args: ['publish', '--access', 'public', '--provenance', '--ignore-scripts'], cwd: resolve(root, 'packages/pixi') });
  console.log('[bar6:publication-execute] disabled/absent OIDC/missing runner/self-hosted stop before npm; token-free fixture invokes confined npm stub with public/provenance flags from packages/pixi; no real publication; PASS');
} finally {
  rmSync(publication, { recursive: true, force: true });
}

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
  const oracleDependencies = join(root, 'tests/oracle/node_modules');
  if (existsSync(oracleDependencies)) symlinkSync(oracleDependencies, join(temp, 'tests/oracle/node_modules'), 'dir');
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



  async function dryRun(changedPath, messages = ['fix: confined host dry-run control']) {
    const calls = [];
    // A bounded read-only SCM fixture supplies commits/files. The installed
    // release-please parser, manifest splitter and Node strategy produce the PR.
    const scm = new Proxy({
      repository: { owner: 'rig-c', repo: 'adapters', defaultBranch: 'main' },
      async getFileJson(file) { calls.push(`read:${file}`); return JSON.parse(readFileSync(join(temp, file), 'utf8')); },
      async getFileContentsOnBranch(file) { calls.push(`read:${file}`); const parsedContent = readFileSync(join(temp, file), 'utf8'); return { parsedContent, content: Buffer.from(parsedContent).toString('base64'), sha: 'fixture-file', mode: '100644' }; },
      async *releaseIterator() {},
      async *tagIterator() {},
      async *mergeCommitIterator() { for (const [index, message] of messages.entries()) yield { sha: String(index + 1).repeat(40), message, files: [`${changedPath}/src/index.ts`] }; },
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
  if (config.packages['packages/phaser']) {
    // A new component's nonzero manifest seed is treated as a prior release.
    // Keep the first release at 0.1.0 across the three held feature cards by
    // preserving #17's Release-As footer in its real squash commit.
    const firstPhaser = await dryRun('packages/phaser', [
      'feat: live Phaser scene object',
      'feat: remaining Phaser frame fields',
      'feat: native Phaser region renderer\n\nRelease-As: 0.1.0',
    ]);
    assert.equal(firstPhaser[0].version, '0.1.0', 'PHASER_FIRST_RELEASE: three held feature commits must propose exactly 0.1.0');
    const withoutFooter = await dryRun('packages/phaser', ['feat: native Phaser region renderer']);
    assert.notEqual(withoutFooter[0].version, '0.1.0', 'PHASER_FIRST_RELEASE_MUTANT: missing release footer must expose the manifest-seed bump');
    console.log('[phaser:bar7:first-release] actual Manifest: three Phaser feat commits + Release-As -> Phaser-only 0.1.0; missing footer mutant RED; workflows unchanged; PASS');
  }
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
