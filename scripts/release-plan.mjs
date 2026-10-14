import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { publishable, root, workspaces } from './workspaces.mjs';

export function assertPublishable(pkg) {
  if (pkg.private === true) throw new Error(`PUBLISH_PRIVATE: ${pkg.name} is private and must never be published`);
  if (!pkg.name.startsWith('@rig-c/')) throw new Error(`PUBLISH_NAME: ${pkg.name} must use @rig-c/<host>`);
}
export function releasePlan(paths, base = root) {
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string')) throw new Error('RELEASE_PATHS: expected a JSON array of workspace paths');
  if (new Set(paths).size !== paths.length) throw new Error('RELEASE_PATHS: duplicate workspace path');
  const manifest = JSON.parse(readFileSync(resolve(base, '.release-please-manifest.json'), 'utf8'));
  const all = workspaces(base);
  return paths.map((path) => {
    const pkg = all.find((item) => item.path === path);
    if (!pkg) throw new Error(`RELEASE_PATH: unknown workspace "${path}"`);
    assertPublishable(pkg);
    if (manifest[path] !== pkg.version) throw new Error(`RELEASE_VERSION: ${path} manifest=${manifest[path]} package=${pkg.version}`);
    return { path, name: pkg.name, version: pkg.version };
  });
}
export function assertPublicationEnvironment(env = process.env) {
  if (env.ADAPTERS_PUBLISH_ENABLED !== 'true') throw new Error('PUBLISH_DISABLED: owner bootstrap/enable is required before npm publication');
  if (!env.NODE_AUTH_TOKEN) throw new Error('PUBLISH_CREDENTIALS: NODE_AUTH_TOKEN is required for the selected release packages');
  if (env.GITHUB_ACTIONS !== 'true' || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('PUBLISH_PROVENANCE: publication requires GitHub Actions with id-token:write and a public repository');
  }
}
if (import.meta.main) {
  const paths = JSON.parse(process.argv[2] ?? '[]');
  const plan = releasePlan(paths);
  if (process.argv.includes('--execute')) {
    assertPublicationEnvironment();
    for (const pkg of plan) {
      const result = Bun.spawnSync(['npm', 'publish', '--access', 'public', '--provenance', '--ignore-scripts'], { cwd: resolve(root, pkg.path), stdout: 'inherit', stderr: 'inherit' });
      if (result.exitCode !== 0) throw new Error(`PUBLISH_FAILED: ${pkg.name}@${pkg.version} npm exited ${result.exitCode}`);
    }
  } else console.log(JSON.stringify(plan));
}
