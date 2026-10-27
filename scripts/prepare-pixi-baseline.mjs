// Fetch exact public origin bytes and build one private browser comparison module.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './workspaces.mjs';

const args = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
const commit = option('--commit');
const output = option('--out');
const pixiHash = option('--pixi-sha256');
const indexHash = option('--index-sha256');
const liveHash = args.includes('--live-sha256') ? option('--live-sha256') : null;
if (args.includes('--help')) { console.log('bun scripts/prepare-pixi-baseline.mjs --commit SHA --out DIR --pixi-sha256 HASH --index-sha256 HASH [--live-sha256 HASH]'); process.exit(0); }
if (liveHash !== null && !/^[a-f0-9]{64}$/.test(liveHash)) throw Error('BASELINE_ARGUMENTS: invalid --live-sha256');
if (!args.includes('--commit') || !/^[a-f0-9]{40}$/.test(commit ?? '') || !args.includes('--out') ||
    !/^[a-f0-9]{64}$/.test(pixiHash ?? '') || !/^[a-f0-9]{64}$/.test(indexHash ?? '')) {
  throw new Error('BASELINE_ARGUMENTS: --commit, --out, --pixi-sha256 and --index-sha256 are required');
}
const out = resolve(output);
if (out === root || out.startsWith(`${root}/`)) throw new Error('BASELINE_OUTPUT: output must be outside the worktree');
mkdirSync(resolve(out, 'source'), { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex');
const files = [];
for (const [name, expected] of [['pixi', pixiHash], ['index', indexHash], ...(liveHash ? [['live', liveHash]] : [])]) {
  const path = `packages/pixi/src/${name}.ts`;
  const response = await fetch(`https://api.github.com/repos/rig-c/adapters/contents/${path}?ref=${commit}`, {
    headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`BASELINE_FETCH: ${path} returned HTTP ${response.status}`);
  const item = await response.json();
  if (item.type !== 'file' || item.encoding !== 'base64' || typeof item.content !== 'string') throw new Error(`BASELINE_CONTENT: ${path} needs a file with base64 content`);
  const bytes = Buffer.from(item.content, 'base64');
  if (digest(bytes) !== expected) throw new Error(`BASELINE_HASH: ${path} differs from the frozen origin receipt`);
  writeFileSync(resolve(out, 'source', `${name}.ts`), bytes);
  files.push({ path, sha256: expected, blobSha: item.sha });
}
// Every relative source edge must be present in the pinned receipt, including
// transitive imports introduced by later releases. Never resolve a stale file
// left in a reused output folder.
const allowed = new Set(files.map(file => resolve(out, 'source', file.path.split('/').at(-1))));
for (const file of allowed) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
    if (!allowed.has(resolve(file, '..', match[1]))) throw Error(`BASELINE_LOCAL_IMPORT: ${file.split('/').at(-1)} needs pinned ${match[1]}`);
  }
}
const play = resolve(root, 'node_modules/@rig-c/play/dist/index.js');
const playPackage = JSON.parse(readFileSync(resolve(root, 'node_modules/@rig-c/play/package.json'), 'utf8'));
if (playPackage.version !== '1.20.0') throw new Error(`BASELINE_PLAY: found ${playPackage.version}, needed 1.20.0`);
const entry = resolve(out, 'entry.ts');
writeFileSync(entry, `export { loadModel } from ${JSON.stringify(play)};\nexport { PixiRig, PixiRenderer } from './source/index.ts';\n`);
const exports = ['ColorMatrixFilter', 'Container', 'Graphics', 'ImageSource', 'Matrix', 'Mesh', 'MeshGeometry', 'Rectangle', 'Sprite', 'Texture', 'Ticker'];
const shim = `const p = globalThis.__rigAdaptersPixi ?? globalThis.__rigBenchPixi; if (!p) throw new Error('BASELINE_PIXI_HOST'); export const { ${exports.join(', ')} } = p;`;
const build = await Bun.build({
  entrypoints: [entry], target: 'browser', format: 'esm', minify: true,
  plugins: [{ name: 'same-play-shared-pixi-host', setup(builder) {
    builder.onResolve({ filter: /^@rig-c\/play$/ }, () => ({ path: play }));
    builder.onResolve({ filter: /^@rig-c\/adapters-shared$/ }, () => ({ path: resolve(root, 'packages/shared/src/index.ts') }));
    builder.onResolve({ filter: /^pixi\.js$/ }, () => ({ path: 'host', namespace: 'baseline-pixi' }));
    builder.onLoad({ filter: /.*/, namespace: 'baseline-pixi' }, () => ({ contents: shim, loader: 'js' }));
  } }],
});
if (!build.success || build.outputs.length !== 1) throw new Error(`BASELINE_BUILD: ${JSON.stringify(build.logs)}`);
const bytes = Buffer.from(await build.outputs[0].arrayBuffer());
const bundle = resolve(out, 'origin-browser.mjs');
writeFileSync(bundle, bytes);
const receipt = { commit, files, playVersion: playPackage.version, playEntrySha256: digest(readFileSync(play)),
  bundleSha256: digest(bytes), bundleBytes: bytes.length, sharedPixiHost: true,
  sharedSourceSha256: digest(readFileSync(resolve(root, 'packages/shared/src/index.ts'))) };
writeFileSync(resolve(out, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
