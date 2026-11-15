import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { root, publishable } from './workspaces.mjs';
import { assertPublicationEnvironment, releasePlan, tagTarget, validateRelease } from './release-plan.mjs';

const ci = parse(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8'));
const release = parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'));
function assertPublicationWorkflow(workflow) {
  assert.deepEqual(workflow.on.push, { tags: ['pixi-v*', 'phaser-v*', 'three-v*'] }, 'RELEASE_TRIGGER: package tags only');
  assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true, 'RELEASE_RECOVERY: explicit tag required');
  assert.equal(workflow.permissions.contents, 'read', 'RELEASE_PERMISSIONS: read only');
  assert.equal(workflow.permissions['pull-requests'], undefined, 'RELEASE_PERMISSIONS: no PR write access');
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name !== 'publish') assert.notEqual(job.permissions?.['id-token'], 'write', 'RELEASE_OIDC_SCOPE: publish only');
  }
  assert.equal(workflow.permissions['id-token'], undefined, 'RELEASE_OIDC_SCOPE: no global OIDC');
  const publish = workflow.jobs.publish;
  assert(publish.steps.some((step) => step.uses?.startsWith('actions/checkout@') && step.with?.ref === '${{ matrix.package.sha }}'), 'RELEASE_CHECKOUT: validated immutable commit required');
  assert(publish.steps.at(-1).run === 'bun scripts/release-plan.mjs --execute', 'RELEASE_EXECUTOR: guarded selector must publish');
  assert.equal(publish.if.includes("vars.ADAPTERS_PUBLISH_ENABLED == 'true'"), true, 'RELEASE_GATE: owner enable required');
  assert.equal(publish.strategy.matrix.package.includes('needs.plan.outputs.packages'), true, 'RELEASE_MATRIX: published packages must come from the dynamic plan');
  assert.equal(publish.permissions['id-token'], 'write', 'RELEASE_PROVENANCE: id-token permission absent');
  assert.equal(publish['runs-on'], 'ubuntu-latest', 'RELEASE_RUNNER: trusted publishing requires a GitHub-hosted runner');
  assert.equal(publish.environment, 'npm', 'RELEASE_ENVIRONMENT: trusted publisher identity uses the npm environment');
  assert(publish.steps.some((step) => step.uses?.startsWith('actions/setup-node@') && step.with['node-version'] === '22'), 'RELEASE_NODE: Node 22 setup absent');
  assert(publish.steps.some((step) => step.run?.includes('npm install -g npm@12.2.2')), 'RELEASE_NPM: trusted publishing requires npm 12.2.2');
  assert.doesNotMatch(JSON.stringify(publish), /NPM_TOKEN|NODE_AUTH_TOKEN/, 'RELEASE_TOKEN: publication must not depend on npm token secrets');
}
assertPublicationWorkflow(release);
function assertReleaseCI(workflow) {
  const job = workflow.jobs['release-path'];
  assert(job && job.steps.some((step) => step.uses?.startsWith('actions/setup-node@') && step.with?.['node-version'] === '22' && step.with?.['registry-url'] === 'https://registry.npmjs.org'), 'RELEASE_CI_NODE: Node/registry required');
  assert(job.steps.some((step) => step.run?.includes('npm install -g npm@12.2.2')), 'RELEASE_CI_NPM: exact publish npm required');
  for (const command of ['bun install --frozen-lockfile', 'bun run build:libraries', 'bun run check:packages']) {
    assert(job.steps.some((step) => step.run === command), `RELEASE_CI_PATH: missing ${command}`);
    assert(release.jobs.publish.steps.some((step) => step.run === command), `RELEASE_CI_PATH: publish missing ${command}`);
  }
  assert(job.steps.at(-1).run.includes('for package in pixi phaser three') && job.steps.at(-1).run.includes('npm pack --dry-run --json --ignore-scripts'), 'RELEASE_CI_PACK: each host must dry-pack');
  assert(workflow.jobs.test.steps.some((step) => step.run === 'bun scripts/check-host-scaffold.mjs'), 'RELEASE_SCAFFOLD: preserve CI browser scaffold');
  assert(!JSON.stringify(job).includes('id-token') && !JSON.stringify(job).includes('npm publish'), 'RELEASE_CI_AUTH: no publish or OIDC');
}
assertReleaseCI(ci);
for (const [mutate, refusal] of [
  [(w) => { w.jobs['release-path'].steps.find((s) => s.run?.includes('npm install -g')).run = 'npm install -g npm@10'; }, /RELEASE_CI_NPM/],
  [(w) => { w.jobs['release-path'].steps.pop(); }, /RELEASE_CI_PACK/],
  [(w) => { w.jobs.test.steps = w.jobs.test.steps.filter((s) => s.run !== 'bun scripts/check-host-scaffold.mjs'); }, /RELEASE_SCAFFOLD/],
]) { const mutant = structuredClone(ci); mutate(mutant); assert.throws(() => assertReleaseCI(mutant), refusal); }
console.log('RELEASE_CI: matching npm/build/package path and all-host dry packs; three workflow mutants RED; PASS');
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
  ['PR write permission', (workflow) => { workflow.permissions['pull-requests'] = 'write'; }, /RELEASE_PERMISSIONS/],
  ['main trigger', (workflow) => { workflow.on.push = { branches: ['main'] }; }, /RELEASE_TRIGGER/],
  ['environment change', (workflow) => { workflow.jobs.publish.environment = 'other'; }, /RELEASE_ENVIRONMENT/],
  ['global OIDC', (workflow) => { workflow.permissions['id-token'] = 'write'; }, /RELEASE_OIDC_SCOPE/],
  ['plan OIDC', (workflow) => { workflow.jobs.plan.permissions = { 'id-token': 'write' }; }, /RELEASE_OIDC_SCOPE/],
  ['mutable checkout', (workflow) => { workflow.jobs.publish.steps[0].with.ref = 'main'; }, /RELEASE_CHECKOUT/],
  ['unguarded executor', (workflow) => { workflow.jobs.publish.steps.at(-1).run = 'npm publish'; }, /RELEASE_EXECUTOR/],
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
  const sha = 'a'.repeat(40);
  for (const tool of ['git', 'gh']) {
    const file = join(publication, tool);
    writeFileSync(file, `#!/bin/sh\ncase "$*" in *merge-base*) exit 0;; *) echo ${sha};; esac\n`);
    chmodSync(file, 0o755);
  }
  const npm = join(publication, 'npm');
  writeFileSync(npm, '#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs";\nif (process.argv[2] === "view") console.log(JSON.stringify(["0.1.0"])); else writeFileSync(process.env.PUBLICATION_CALLS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));\n');
  chmodSync(npm, 0o755);
  const env = { ...process.env, PATH: `${publication}:${process.env.PATH}`, PUBLICATION_CALLS: calls };
  for (const field of [...Object.keys(oidc), 'NODE_AUTH_TOKEN', 'NPM_TOKEN']) delete env[field];
  const execute = (context) => Bun.spawnSync([process.execPath, join(root, 'scripts/release-plan.mjs'), '--execute'], { env: { ...env, GITHUB_REF: 'refs/tags/pixi-v0.2.0', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sha, GITHUB_REPOSITORY: 'rig-c/adapters', ...context }, stdout: 'pipe', stderr: 'pipe' });
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

const sha = 'a'.repeat(40);
const context = { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/pixi-v0.2.0', GITHUB_SHA: sha, GITHUB_REPOSITORY: 'rig-c/adapters' };
function commandFixture({ versions = ['0.1.0'], remote = sha, head = sha, ancestor = true } = {}) {
  return (bin, args) => {
    if (bin === 'gh') return remote;
    if (bin === 'npm') return JSON.stringify(versions);
    if (args[0] === 'merge-base') { if (!ancestor) throw new Error('not ancestor'); return ''; }
    return args[1] === 'HEAD' ? head : sha;
  };
}
for (const pkg of publishable()) {
  const host = pkg.path.split('/').at(-1);
  const env = { ...context, GITHUB_REF: `refs/tags/${host}-v${pkg.version}` };
  assert.equal(validateRelease(env, root, commandFixture()).path, pkg.path);
  assert.equal(validateRelease(env, root, commandFixture({ versions: '0.1.0' })).path, pkg.path);
  assert.equal(validateRelease({ ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_TAG: `${host}-v${pkg.version}` }, root, commandFixture()).path, pkg.path);
}
for (const [env, fixture, refusal] of [
  [{ ...context, GITHUB_REF: 'refs/heads/main' }, {}, /RELEASE_REF_NOT_TAG/],
  [{ ...context, GITHUB_REF: 'refs/tags/shared-v0.2.0' }, {}, /RELEASE_TAG_FORM/],
  [{ ...context, GITHUB_REF: 'refs/tags/pixi-v00.2.0' }, {}, /RELEASE_TAG_FORM/],
  [{ ...context, GITHUB_EVENT_NAME: 'workflow_dispatch', INPUT_TAG: 'three-v0.2.0' }, {}, /RELEASE_REF_NOT_TAG/],
  [{ ...context, GITHUB_SHA: 'b'.repeat(40) }, {}, /PROVENANCE_SHA_MISMATCH/],
  [context, { remote: 'b'.repeat(40) }, /PROVENANCE_SHA_MISMATCH/],
  [context, { head: 'b'.repeat(40) }, /PROVENANCE_SHA_MISMATCH/],
  [context, { ancestor: false }, /RELEASE_TAG_NOT_ON_MAIN/],
  [{ ...context, GITHUB_REF: 'refs/tags/pixi-v0.3.0' }, {}, /RELEASE_TAG_VERSION_MISMATCH/],
  [context, { versions: ['0.2.0'] }, /RELEASE_ALREADY_PUBLISHED/],
  [context, { versions: ['0.10.0'] }, /RELEASE_BELOW_LATEST/],
  [context, { versions: {} }, /RELEASE_REGISTRY/],
]) assert.throws(() => validateRelease(env, root, commandFixture(fixture)), refusal);
assert.throws(() => validateRelease(context, root, (bin, args, options) => {
  if (bin === 'npm') throw new Error('network unavailable');
  return commandFixture()(bin, args, options);
}), /RELEASE_REGISTRY/);
for (const tool of ['git', 'gh']) assert.throws(() => validateRelease(context, root, (bin, args, options) => {
  if (bin === tool) throw new Error('missing tag');
  return commandFixture()(bin, args, options);
}), /RELEASE_TAG_UNRESOLVED/);
assert.throws(() => tagTarget({ ...context, GITHUB_EVENT_NAME: 'pull_request' }), /RELEASE_REF_NOT_TAG/);
console.log('RELEASE_SELECTION: three hosts push/recovery accepted; 16 adversarial inputs refused; PASS');
