import { resolve } from 'node:path';
import { root, run, workspaces } from './workspaces.mjs';

export function assertPublishable(pkg) {
  if (pkg.private === true) throw new Error(`PUBLISH_PRIVATE: ${pkg.name} is private and must never be published`);
  if (!pkg.name.startsWith('@rig-c/')) throw new Error(`PUBLISH_NAME: ${pkg.name} must use @rig-c/<host>`);
}
export function releasePlan(paths, base = root) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) throw new Error('RELEASE_PATHS: expected a JSON array of workspace paths');
  if (new Set(paths).size !== paths.length) throw new Error('RELEASE_PATHS: duplicate workspace path');
  const all = workspaces(base);
  return paths.map((path) => {
    const pkg = all.find((item) => item.path === path);
    if (!pkg) throw new Error(`RELEASE_PATH: unknown workspace "${path}"`);
    assertPublishable(pkg);
    return { path, name: pkg.name, version: pkg.version };
  });
}
export function assertPublicationEnvironment(env = process.env) {
  if (env.ADAPTERS_PUBLISH_ENABLED !== 'true') throw new Error('PUBLISH_DISABLED: owner bootstrap/enable is required before npm publication');
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('PUBLISH_PROVENANCE: publication requires GitHub-hosted Actions OIDC request context from id-token:write');
  }
}
export function tagTarget(env = process.env) {
  const tag = env.GITHUB_REF?.replace(/^refs\/tags\//, '');
  if (!env.GITHUB_REF?.startsWith('refs/tags/') || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)) throw new Error('RELEASE_REF_NOT_TAG: run on an existing package tag');
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.INPUT_TAG !== tag) throw new Error('RELEASE_REF_NOT_TAG: dispatch ref must equal the requested tag');
  const match = /^(pixi|phaser|three)-v((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(tag);
  if (!match) throw new Error(`RELEASE_TAG_FORM: ${tag} expected <pixi|phaser|three>-vX.Y.Z`);
  return { tag, path: `packages/${match[1]}`, name: `@rig-c/${match[1]}`, version: match[2] };
}
export function validateRelease(env = process.env, base = root, command = run) {
  const target = tagTarget(env);
  const invoke = (bin, args) => command(bin, args, { cwd: base }).trim();
  let sha;
  try { sha = invoke('git', ['rev-parse', '--verify', `refs/tags/${target.tag}^{commit}`]); }
  catch { throw new Error(`RELEASE_TAG_UNRESOLVED: ${target.tag} is not a local commit tag`); }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`RELEASE_TAG_UNRESOLVED: ${target.tag}`);
  let remote;
  try { remote = invoke('gh', ['api', `repos/${env.GITHUB_REPOSITORY}/commits/refs%2Ftags%2F${target.tag}`, '--jq', '.sha']); }
  catch { throw new Error(`RELEASE_TAG_UNRESOLVED: cannot resolve remote ${target.tag}`); }
  if (env.GITHUB_SHA !== sha || remote !== sha || invoke('git', ['rev-parse', 'HEAD']) !== sha) throw new Error(`PROVENANCE_SHA_MISMATCH: ${target.tag} must match GITHUB_SHA, fetched tag, remote tag and HEAD`);
  try { invoke('git', ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']); }
  catch { throw new Error(`RELEASE_TAG_NOT_ON_MAIN: ${target.tag} is not reachable from origin/main`); }
  const pkg = releasePlan([target.path], base)[0];
  if (pkg.name !== target.name || pkg.version !== target.version) throw new Error(`RELEASE_TAG_VERSION_MISMATCH: ${target.tag} expected ${target.name}@${target.version}, found ${pkg.name}@${pkg.version}`);
  // Fetch all served versions in one successful request. Registry/auth failures
  // refuse publication rather than being mistaken for an unpublished version.
  let versions;
  try { versions = JSON.parse(invoke('npm', ['view', target.name, 'versions', '--json'])); }
  catch { throw new Error(`RELEASE_REGISTRY: cannot read served versions of ${target.name}`); }
  if (typeof versions === 'string') versions = [versions];
  if (!Array.isArray(versions) || versions.some((v) => typeof v !== 'string')) throw new Error(`RELEASE_REGISTRY: invalid versions for ${target.name}`);
  if (versions.includes(target.version)) throw new Error(`RELEASE_ALREADY_PUBLISHED: ${target.name}@${target.version}`);
  const greater = (version) => {
    if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) return false;
    const a = version.split('.').map(BigInt), b = target.version.split('.').map(BigInt);
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
    return false;
  };
  if (versions.some(greater)) throw new Error(`RELEASE_BELOW_LATEST: ${target.name}@${target.version} is below a served stable version`);
  return { ...pkg, sha };
}
if (import.meta.main) {
  if (process.argv.includes('--execute')) assertPublicationEnvironment();
  const pkg = validateRelease();
  if (process.argv.includes('--execute')) {
    const result = Bun.spawnSync(['npm', 'publish', '--access', 'public', '--provenance', '--ignore-scripts'], { cwd: resolve(root, pkg.path), stdout: 'inherit', stderr: 'inherit' });
    if (result.exitCode !== 0) throw new Error(`PUBLISH_FAILED: ${pkg.name}@${pkg.version} npm exited ${result.exitCode}`);
  } else console.log(JSON.stringify([pkg]));
}
