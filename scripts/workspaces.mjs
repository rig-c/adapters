import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
export function workspaces(base = root) {
  return readdirSync(resolve(base, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = `packages/${entry.name}`;
      return { path, dir: resolve(base, path), ...JSON.parse(readFileSync(resolve(base, path, 'package.json'), 'utf8')) };
    }).sort((a, b) => a.path.localeCompare(b.path));
}
export function publishable(base = root) {
  return workspaces(base).filter((pkg) => pkg.private !== true);
}
export function run(command, args, options = {}) {
  const result = Bun.spawnSync([command, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe', ...options });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) throw new Error(`${command} ${args.join(' ')}: exit ${result.exitCode}\n${stdout}\n${stderr}`);
  return stdout;
}

// npm <=11 returns an array; npm 12 keys pack results by package name.
export function packListing(text, name) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`PACK_JSON: ${name} expected valid npm pack JSON`); }
  const listing = Array.isArray(value) && value.length === 1 ? value[0]
    : value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 ? value[name] : undefined;
  if (!listing || listing.name !== name || typeof listing.filename !== 'string' || !Array.isArray(listing.files)
    || listing.files.some((file) => !file || typeof file.path !== 'string')) {
    throw new Error(`PACK_JSON: ${name} expected exactly one matching npm pack listing with filename and files`);
  }
  return listing;
}
