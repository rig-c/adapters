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
