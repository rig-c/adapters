import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishable, root, run, workspaces } from './workspaces.mjs';
import { assertPublishable } from './release-plan.mjs';

export function assertTarball(pkg, listing) {
  for (const entry of listing.files) {
    // npm always adds package.json. This metadata file is required for installation.
    if (entry.path === 'package.json') continue;
    if (entry.path.startsWith('dist/') || ['README.md', 'LICENSE', 'NOTICE'].includes(entry.path)) continue;
    throw new Error(`PACK_ALLOWLIST: ${pkg.name} contains unexpected path "${entry.path}"`);
  }
  for (const required of ['package.json', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE', 'NOTICE']) {
    assert(listing.files.some((file) => file.path === required), `PACK_REQUIRED: ${pkg.name} lacks ${required}`);
  }
}
const packages = publishable();
assert(packages.length > 0, 'PACK_NO_PACKAGES: publishable workspace absent');
for (const pkg of packages) {
  const listing = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: pkg.dir }))[0];
  assertTarball(pkg, listing);
  const packedPackage = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf8'));
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(packedPackage[section] ?? {})) {
      assert(!/spine|esotericsoftware/i.test(name), `PACK_RUNTIME: ${pkg.name} ${section} contains ${name}`);
      assert(!workspaces().some((item) => item.private && item.name === name), `PACK_PRIVATE_DEPENDENCY: ${pkg.name} links ${name}`);
    }
  }
  for (const file of listing.files.filter((entry) => entry.path.startsWith('dist/'))) {
    const text = readFileSync(join(pkg.dir, file.path), 'utf8');
    assert(!/@esotericsoftware|spine-core/.test(text), `PACK_RUNTIME: ${pkg.name}/${file.path}`);
    assert(!/from\s*["']@rig-c\/adapters-shared/.test(text), `PACK_PRIVATE_IMPORT: ${pkg.name}/${file.path}`);
  }
  console.log(`[bar1:pack] ${pkg.name}: ${listing.files.map((entry) => entry.path).join(', ')}; PASS`);
  console.log(`[bar4:tarball-runtime] ${pkg.name}: prohibited runtime/private imports (empty); PASS`);
  const temp = mkdtempSync(join(tmpdir(), 'adapters-pack-mutant-'));
  try {
    cpSync(pkg.dir, temp, { recursive: true });
    const mutant = { ...packedPackage, files: [...packedPackage.files, 'tests/planted.txt'] };
    writeFileSync(join(temp, 'tests/planted.txt'), 'Must never ship.');
    writeFileSync(join(temp, 'package.json'), JSON.stringify(mutant));
    const mutantListing = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: temp }))[0];
    assert.throws(() => assertTarball(pkg, mutantListing), /PACK_ALLOWLIST.*tests\/planted.txt/);
    console.log(`[bar1:mutant] ${pkg.name}: PACK_ALLOWLIST rejected tests/planted.txt; RED as required`);
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
for (const pkg of workspaces().filter((item) => item.private)) {
  assert.throws(() => assertPublishable(pkg), /PUBLISH_PRIVATE/);
  console.log(`[bar1:private] ${pkg.name}: PUBLISH_PRIVATE refused before npm; PASS`);
}
// Exercise actual packing on a standalone private fixture without publishing/network.
const temp = mkdtempSync(join(tmpdir(), 'adapters-private-pack-'));
try {
  writeFileSync(join(temp, 'package.json'), JSON.stringify({ name: '@rig-c/private-pack-probe', version: '0.0.0', private: true }));
  const listing = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: temp }))[0];
  assert(listing.files.some((file) => file.path === 'package.json'));
  console.log('[bar1:refuted] npm pack --dry-run accepts private:true; private blocks publication, not local tarball creation. Publishing pipeline rejects private packages before invoking npm.');
} finally { rmSync(temp, { recursive: true, force: true }); }
