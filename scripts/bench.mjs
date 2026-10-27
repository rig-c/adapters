import { parseTimingProtocol, parseTimingProtocolArgs, assertTimingProtocolRows, timingProtocolDescription } from '../bench/timing-protocol.ts';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { root } from './workspaces.mjs';

export const BENCH_CHROMIUM_ARGS = Object.freeze([
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--js-flags=--expose-gc',
  '--enable-precise-memory-info',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
]);

export function parseCompareBundleArgs(args) {
  const selectors = args.flatMap((value, index) =>
    value === '--compare-bundle' || value.startsWith('--compare-bundle=') ? [index] : [],
  );
  if (selectors.length === 0) return null;
  if (selectors.length > 1) {
    throw new Error('BENCH_COMPARE_BUNDLE: multiple selectors; expected one --compare-bundle path');
  }
  const index = selectors[0];
  const selector = args[index];
  const value = selector.startsWith('--compare-bundle=')
    ? selector.slice('--compare-bundle='.length)
    : (args[index + 1] ?? '');
  if (!value || value.startsWith('--')) {
    throw new Error('BENCH_COMPARE_BUNDLE: missing path after --compare-bundle');
  }
  return value;
}

function resolveCompareBundleEntry(compareBundleInput) {
  const resolvedInput = resolve(root, compareBundleInput);
  if (!existsSync(resolvedInput)) {
    throw new Error(
      `BENCH_COMPARE_BUNDLE: path not found "${compareBundleInput}" (${resolvedInput})`,
    );
  }
  const st = statSync(resolvedInput);
  if (!st.isDirectory()) return resolvedInput;

  const candidates = [];
  const pkgPath = join(resolvedInput, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const exp = pkg.exports?.['.'];
      const exportImport = typeof exp === 'string' ? exp : exp?.import;
      if (typeof exportImport === 'string') candidates.push(resolve(resolvedInput, exportImport));
      if (typeof pkg.main === 'string') candidates.push(resolve(resolvedInput, pkg.main));
    } catch {
      // fall through to standard entry paths
    }
  }
  candidates.push(
    join(resolvedInput, 'dist/index.js'),
    join(resolvedInput, 'src/index.ts'),
  );
  for (const candidate of candidates) {
    if (existsSync(candidate) && !statSync(candidate).isDirectory()) {
      return candidate;
    }
  }
  throw new Error(
    `BENCH_COMPARE_BUNDLE: no entry module found in directory "${compareBundleInput}" (${resolvedInput})`,
  );
}

const PIXI_HOST_SHIM_CODE = `
const p = globalThis.__rigBenchPixi;
if (!p) throw new Error('BENCH_COMPARE_BUNDLE: globalThis.__rigBenchPixi is not initialized');
export const {
  ColorMatrixFilter,
  Container,
  Graphics,
  ImageSource,
  Matrix,
  Mesh,
  MeshGeometry,
  Rectangle,
  Sprite,
  Texture,
  Ticker,
} = p;
export default p;
`;

function hasNamedExports(esmText, names) {
  const exportMatches = [...esmText.matchAll(/export\s*\{([^}]*)\}/g)];
  const exported = new Set();
  for (const m of exportMatches) {
    for (const part of m[1].split(',')) {
      const tokens = part.trim().split(/\s+as\s+/);
      const exportedName = (tokens[1] ?? tokens[0] ?? '').trim();
      if (exportedName) exported.add(exportedName);
    }
  }
  for (const m of esmText.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    exported.add(m[1]);
  }
  return names.every((n) => exported.has(n));
}

export async function prepareCompareBundle(compareBundleInput) {
  const entryFile = resolveCompareBundleEntry(compareBundleInput);
  const tmpDir = mkdtempSync(join(tmpdir(), 'bench-compare-'));

  const buildEsm = async (entryPath, external, plugins = [], aliasPlayTarget = null, shimPixiPath = null) => {
    let buf;
    if (typeof Bun !== 'undefined' && typeof Bun.build === 'function') {
      const result = await Bun.build({
        entrypoints: [entryPath],
        minify: true,
        format: 'esm',
        target: 'browser',
        external,
        plugins,
      });
      if (!result.success || result.outputs.length === 0) {
        throw new Error(
          `BENCH_COMPARE_BUNDLE: failed to build "${compareBundleInput}": ${JSON.stringify(result.logs)}`,
        );
      }
      buf = Buffer.from(await result.outputs[0].arrayBuffer());
    } else {
      const outPath = join(
        tmpDir,
        `out-${Math.random().toString(36).slice(2)}.mjs`,
      );
      const scriptPath = join(
        tmpDir,
        `build-${Math.random().toString(36).slice(2)}.mjs`,
      );
      writeFileSync(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
const plugins = [];
const aliasPlayTarget = ${JSON.stringify(aliasPlayTarget)};
const shimPixiPath = ${JSON.stringify(shimPixiPath)};
if (aliasPlayTarget) {
  plugins.push({
    name: 'alias-compare-rig-play',
    setup(build) {
      build.onResolve({ filter: /^@rig-c\\/play$/ }, () => ({ path: aliasPlayTarget }));
    },
  });
}
if (shimPixiPath) {
  plugins.push({
    name: 'shim-pixi-host',
    setup(build) {
      build.onResolve({ filter: /^pixi\\.js$/ }, () => ({ path: shimPixiPath }));
    },
  });
}
const res = await Bun.build({
  entrypoints: [${JSON.stringify(entryPath)}],
  minify: true,
  format: 'esm',
  target: 'browser',
  external: ${JSON.stringify(external)},
  plugins,
});
if (!res.success || res.outputs.length === 0) {
  console.error(JSON.stringify(res.logs));
  process.exit(1);
}
writeFileSync(${JSON.stringify(outPath)}, Buffer.from(await res.outputs[0].arrayBuffer()));
`,
      );
      const sub = spawnSync('bun', [scriptPath], { cwd: root, stdio: 'pipe' });
      if (sub.status !== 0 || !existsSync(outPath)) {
        throw new Error(
          `BENCH_COMPARE_BUNDLE: failed to build "${compareBundleInput}": ${sub.stderr.toString('utf8')}`,
        );
      }
      buf = readFileSync(outPath);
    }
    return {
      buf,
      text: buf.toString('utf8'),
      rawBytes: buf.byteLength,
      gzipBytes: gzipSync(buf, { level: 9 }).byteLength,
    };
  };

  try {
    let directBuild = null;
    try {
      directBuild = await buildEsm(entryFile, ['pixi.js']);
    } catch (err) {
      throw new Error(
        `BENCH_COMPARE_BUNDLE: failed to bundle "${compareBundleInput}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let finalEntryPath = entryFile;
    let aliasPlugins = [];
    let mode = 'rig-pixi-bundle';

    if (hasNamedExports(directBuild.text, ['loadModel', 'PixiRig'])) {
      finalEntryPath = entryFile;
    } else if (hasNamedExports(directBuild.text, ['loadModel', 'RigPlayer'])) {
      mode = 'rig-play';
      finalEntryPath = join(tmpDir, 'compare-rig-entry.ts');
      writeFileSync(
        finalEntryPath,
        `export { loadModel, RigPlayer } from ${JSON.stringify(entryFile)};
export { PixiRenderer, PixiRig } from ${JSON.stringify(resolve(root, 'packages/pixi/src/index.ts'))};\n`,
      );
      aliasPlugins = [
        {
          name: 'alias-compare-rig-play',
          setup(build) {
            build.onResolve({ filter: /^@rig-c\/play$/ }, () => ({ path: entryFile }));
          },
        },
      ];
    } else if (hasNamedExports(directBuild.text, ['PixiRig'])) {
      throw new Error(
        `BENCH_COMPARE_BUNDLE: "${compareBundleInput}" is an @rig-c/pixi package (exports PixiRig without loadModel) and is not a comparison input; pass an @rig-c/play package/bundle or a module exporting { loadModel, PixiRig }`,
      );
    } else {
      throw new Error(
        `BENCH_COMPARE_BUNDLE: "${compareBundleInput}" must export { loadModel, PixiRig } or an @rig-c/play package/bundle exporting { loadModel, RigPlayer }`,
      );
    }

    const pixiShimPath = join(tmpDir, 'pixi-host-shim.mjs');
    writeFileSync(pixiShimPath, PIXI_HOST_SHIM_CODE);
    const browserPlugins = [
      ...aliasPlugins,
      {
        name: 'shim-pixi-host',
        setup(build) {
          build.onResolve({ filter: /^pixi\.js$/ }, () => ({ path: pixiShimPath }));
        },
      },
    ];

    const [adapterAndRuntime, includingPixiHost, browserBuild] = await Promise.all([
      buildEsm(finalEntryPath, ['pixi.js'], aliasPlugins, mode === 'rig-play' ? entryFile : null, null),
      buildEsm(finalEntryPath, [], aliasPlugins, mode === 'rig-play' ? entryFile : null, null),
      buildEsm(finalEntryPath, [], browserPlugins, mode === 'rig-play' ? entryFile : null, pixiShimPath),
    ]);

    if (!hasNamedExports(browserBuild.text, ['loadModel', 'PixiRig'])) {
      throw new Error(
        `BENCH_COMPARE_BUNDLE: compiled bundle for "${compareBundleInput}" is missing { loadModel, PixiRig } exports`,
      );
    }

    const sha256 = createHash('sha256').update(adapterAndRuntime.buf).digest('hex');

    return {
      sourcePath: compareBundleInput,
      resolvedPath: entryFile,
      mode,
      sha256,
      adapterAndRuntime: {
        rawBytes: adapterAndRuntime.rawBytes,
        gzipBytes: adapterAndRuntime.gzipBytes,
      },
      includingPixiHost: {
        rawBytes: includingPixiHost.rawBytes,
        gzipBytes: includingPixiHost.gzipBytes,
      },
      browserCode: browserBuild.text,
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const REQUIRED_SKELETON_FILES = (name) => [
  'skeleton.model.json',
  `${name}-pro.json`,
  `${name}.atlas`,
  `${name}.png`,
  'license.txt',
];

export function verifyBenchDiskAssets(benchDir, skeletons = ['spineboy', 'raptor']) {
  const manifestPath = join(benchDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      'BENCH_ASSET_MISSING: manifest (public/bench/manifest.json) — run "bash scripts/fetch-assets.sh" first',
    );
  }
  for (const skeleton of skeletons) {
    const skelDir = join(benchDir, skeleton);
    for (const file of REQUIRED_SKELETON_FILES(skeleton)) {
      const fullPath = join(skelDir, file);
      if (!existsSync(fullPath)) {
        throw new Error(
          `BENCH_ASSET_MISSING: ${skeleton} (public/bench/${skeleton}/${file}) — run "bash scripts/fetch-assets.sh" first`,
        );
      }
    }
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

export function verifyRefusalMutantOnDisk() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'bench-refusal-mutant-'));
  mkdirSync(join(tmpDir, 'spineboy'), { recursive: true });
  writeFileSync(join(tmpDir, 'manifest.json'), '{}\n');
  writeFileSync(join(tmpDir, 'spineboy/spineboy-pro.json'), '{}\n');
  // Intentionally omit skeleton.model.json to trigger named refusal
  let refusedMessage = '';
  try {
    verifyBenchDiskAssets(tmpDir, ['spineboy']);
  } catch (err) {
    refusedMessage = err instanceof Error ? err.message : String(err);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  const pass =
    refusedMessage.includes('BENCH_ASSET_MISSING: spineboy') &&
    refusedMessage.includes('skeleton.model.json');
  if (!pass) {
    throw new Error(
      `BENCH_MUTANT_SURVIVED: missing asset mutant did not refuse by name (got "${refusedMessage}")`,
    );
  }
  return { pass: true, refusedMessage };
}

async function measureBundles() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'bench-bundles-'));

  const spineEntryPath = join(tmpDir, 'spine-entry.ts');
  const rigEntryPath = join(tmpDir, 'rig-entry.ts');

  writeFileSync(
    spineEntryPath,
    `export {
      AtlasAttachmentLoader,
      SkeletonJson,
      Spine,
      SpineTexture,
      TextureAtlas,
    } from ${JSON.stringify(resolve(root, 'tests/oracle/pixi-spine-bridge.ts'))};\n`,
  );
  writeFileSync(
    rigEntryPath,
    `export { loadModel, RigPlayer } from ${JSON.stringify(resolve(root, 'node_modules/@rig-c/play/dist/index.js'))};
export { PixiRenderer, PixiRig } from ${JSON.stringify(resolve(root, 'packages/pixi/src/index.ts'))};\n`,
  );

  const bundleEntry = async (entryPath, external) => {
    const result = await Bun.build({
      entrypoints: [entryPath],
      minify: true,
      format: 'esm',
      target: 'browser',
      external,
    });
    if (!result.success || result.outputs.length === 0) {
      throw new Error(`BENCH_BUNDLE_FAILED: ${JSON.stringify(result.logs)}`);
    }
    const buf = Buffer.from(await result.outputs[0].arrayBuffer());
    return {
      rawBytes: buf.byteLength,
      gzipBytes: gzipSync(buf, { level: 9 }).byteLength,
    };
  };

  try {
    const [spineAdapterOnly, spineWithPixi, rigAdapterOnly, rigWithPixi] = await Promise.all([
      bundleEntry(spineEntryPath, ['pixi.js']),
      bundleEntry(spineEntryPath, []),
      bundleEntry(rigEntryPath, ['pixi.js']),
      bundleEntry(rigEntryPath, []),
    ]);

    return {
      'spine-pixi-v8': {
        adapterAndRuntime: spineAdapterOnly,
        includingPixiHost: spineWithPixi,
      },
      'rig-c-pixi': {
        adapterAndRuntime: rigAdapterOnly,
        includingPixiHost: rigWithPixi,
      },
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function median(values, decimals = 3) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(decimals))
    : Number(sorted[mid].toFixed(decimals));
}

function quantile(values, q, decimals = 3) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const val = base + 1 < sorted.length
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
  return Number(val.toFixed(decimals));
}

async function allocatePort() {
  const srv = createServer();
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const addr = srv.address();
  if (!addr || typeof addr === 'string') throw new Error('BENCH_PORT: failed to allocate TCP port');
  const port = addr.port;
  await new Promise((res) => srv.close(() => res()));
  return port;
}

async function startViteServer(port) {
  const child = spawn(
    'bunx',
    ['--no-install', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    { cwd: root, stdio: 'ignore', env: { ...process.env, RIG_BENCH: '1' } },
  );
  const url = `http://127.0.0.1:${port}/bench/index.html`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return { child, baseUrl: `http://127.0.0.1:${port}` };
    } catch {
      // wait for server
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGTERM');
  throw new Error(`BENCH_SERVER_TIMEOUT: Vite server did not start on port ${port}`);
}

export function evaluateBar1DrawCalls(frameRows, skeletons = ['spineboy', 'raptor']) {
  const maxBySkeleton = { spineboy: 1, raptor: 3 };
  const violations = [];
  for (const skeleton of skeletons) {
    const limit = maxBySkeleton[skeleton];
    if (limit === undefined) continue;
    const rows = frameRows.filter(
      (r) => r.skeleton === skeleton && (r.arm === 'rig-c-pixi' || r.arm === 'rig-c-pixi-compare'),
    );
    if (rows.length === 0) {
      violations.push(`${skeleton} missing rig-c-pixi rows`);
      continue;
    }
    for (const row of rows) {
      if (row.drawCallsPerFrame > limit) {
        violations.push(
          `${row.skeleton} ${row.instances}x ${row.arm} drawCallsPerFrame=${row.drawCallsPerFrame} (expected <= ${limit})`,
        );
      }
    }
  }
  return {
    pass: violations.length === 0,
    violations,
  };
}

export function computePairedFrameTable(frameRows, arms = ['spine-pixi-v8', 'rig-c-pixi']) {
  if (!Array.isArray(arms) || arms.length !== 2) {
    throw new Error(`BENCH_PAIRED_MISMATCH: expected 2 arms for ABAB pairing, got ${JSON.stringify(arms)}`);
  }
  const [armA, armB] = arms;
  const protocol = frameRows[0]?.timingProtocol;
  if (protocol === undefined) {
    throw new Error('BENCH_TIMING_PROTOCOL: paired frame rows have no protocol');
  }
  const expectedProtocol = parseTimingProtocol(protocol);
  assertTimingProtocolRows(expectedProtocol, frameRows);

  const rowsA = frameRows.filter((r) => r.arm === armA);
  if (rowsA.length === 0) {
    throw new Error(`BENCH_PAIRED_MISMATCH: no rows found for armA "${armA}"`);
  }
  const paired = [];
  for (const rowA of rowsA) {
    const rowB = frameRows.find(
      (r) => r.skeleton === rowA.skeleton && r.instances === rowA.instances && r.arm === armB,
    );
    if (!rowB) {
      throw new Error(
        `BENCH_PAIRED_MISMATCH: missing armB "${armB}" row for ${rowA.skeleton} ${rowA.instances}x`,
      );
    }
    const runAP50s = Array.isArray(rowA.runP50sMs) ? rowA.runP50sMs : [rowA.p50Ms];
    const runBP50s = Array.isArray(rowB.runP50sMs) ? rowB.runP50sMs : [rowB.p50Ms];
    if (runAP50s.length === 0 || runAP50s.length !== runBP50s.length) {
      throw new Error(
        `BENCH_PAIRED_MISMATCH: ${rowA.skeleton} ${rowA.instances}x run count mismatch (${armA}=${runAP50s.length}, ${armB}=${runBP50s.length})`,
      );
    }
    const pairDiffsMs = [];
    const pairRelDiffs = [];
    const pairRatios = [];
    for (let r = 0; r < runAP50s.length; r++) {
      const a = runAP50s[r];
      const b = runBP50s[r];
      if (!(a > 0) || !(b > 0)) {
        throw new Error(
          `BENCH_PAIRED_MISMATCH: ${rowA.skeleton} ${rowA.instances}x pair ${r} has non-positive p50 (${armA}=${a}, ${armB}=${b})`,
        );
      }
      pairDiffsMs.push(Number((b - a).toFixed(3)));
      pairRelDiffs.push(Number(((b - a) / a).toFixed(4)));
      pairRatios.push(Number((b / a).toFixed(4)));
    }
    paired.push({
      timingProtocol: expectedProtocol,
      interleaving: 'ABAB',
      skeleton: rowA.skeleton,
      instances: rowA.instances,
      runs: runAP50s.length,
      armA,
      armB,
      armAP50Ms: rowA.p50Ms,
      armBP50Ms: rowB.p50Ms,
      armARunP50sMs: [...runAP50s],
      armBRunP50sMs: [...runBP50s],
      pairDiffsMs,
      pairRelDiffs,
      pairRatios,
      p50DiffMs: median(pairDiffsMs, 3),
      p95DiffMs: quantile(pairDiffsMs, 0.95, 3),
      p50RelDiff: median(pairRelDiffs, 4),
      p50Ratio: median(pairRatios, 4),
    });
  }
  return paired;
}

export function evaluatePairedReproducibility(pairedRows1, pairedRows2, maxSpread = 0.05) {
  const protocol = pairedRows1[0]?.timingProtocol;
  if (protocol === undefined) {
    throw new Error('BENCH_TIMING_PROTOCOL: paired reproducibility rows have no protocol');
  }
  const expectedProtocol = parseTimingProtocol(protocol);
  assertTimingProtocolRows(expectedProtocol, pairedRows1);
  assertTimingProtocolRows(expectedProtocol, pairedRows2);

  const comparisons = [];
  for (const p1 of pairedRows1) {
    const p2 = pairedRows2.find(
      (item) =>
        item.skeleton === p1.skeleton &&
        item.instances === p1.instances &&
        item.armA === p1.armA &&
        item.armB === p1.armB,
    );
    if (!p2) {
      throw new Error(
        `BENCH_REPRO_MISSING_ROW: paired row ${p1.skeleton} ${p1.instances}x (${p1.armA} vs ${p1.armB}) missing in second run`,
      );
    }
    const absDiffSpreadMs = Number(Math.abs(p2.p50DiffMs - p1.p50DiffMs).toFixed(3));
    const relDiffSpread = Number(
      (absDiffSpreadMs / Math.max(Math.abs(p1.p50DiffMs), 1e-6)).toFixed(4),
    );
    const absRelDiffSpread = Number(Math.abs(p2.p50RelDiff - p1.p50RelDiff).toFixed(4));
    const ratioRelSpread = Number(
      (Math.abs(p2.p50Ratio - p1.p50Ratio) / Math.max(p1.p50Ratio, 1e-6)).toFixed(4),
    );
    const pass = relDiffSpread <= maxSpread;
    const ratioPass = ratioRelSpread <= maxSpread;
    comparisons.push({
      skeleton: p1.skeleton,
      instances: p1.instances,
      armA: p1.armA,
      armB: p1.armB,
      run1P50DiffMs: p1.p50DiffMs,
      run2P50DiffMs: p2.p50DiffMs,
      absDiffSpreadMs,
      relDiffSpread,
      run1P50RelDiff: p1.p50RelDiff,
      run2P50RelDiff: p2.p50RelDiff,
      absRelDiffSpread,
      run1P50Ratio: p1.p50Ratio,
      run2P50Ratio: p2.p50Ratio,
      ratioRelSpread,
      pass,
      ratioPass,
    });
  }
  return {
    maxRelDiffSpread: Math.max(...comparisons.map((c) => c.relDiffSpread)),
    maxAbsRelDiffSpread: Math.max(...comparisons.map((c) => c.absRelDiffSpread)),
    maxRatioRelSpread: Math.max(...comparisons.map((c) => c.ratioRelSpread)),
    pass: comparisons.every((c) => c.pass),
    ratioPass: comparisons.every((c) => c.ratioPass),
    comparisons,
  };
}

export function evaluateReproducibility(run1Rows, run2Rows, maxRelDelta = 0.05, floorMs = 3.0) {
  const protocol = run1Rows[0]?.timingProtocol;
  if (protocol === undefined) throw new Error('BENCH_TIMING_PROTOCOL: reproducibility rows have no protocol');
  const expectedProtocol = parseTimingProtocol(protocol);
  assertTimingProtocolRows(expectedProtocol, run1Rows);
  assertTimingProtocolRows(expectedProtocol, run2Rows);
  const comparisons = [];
  for (const r1 of run1Rows) {
    const r2 = run2Rows.find(
      (item) =>
        item.skeleton === r1.skeleton &&
        item.arm === r1.arm &&
        item.instances === r1.instances,
    );
    if (!r2) {
      throw new Error(
        `BENCH_REPRO_MISSING_ROW: ${r1.skeleton} ${r1.arm} ${r1.instances}x missing in second run`,
      );
    }
    const absDeltaMs = Number(Math.abs(r2.p50Ms - r1.p50Ms).toFixed(3));
    const denom = Math.max(r1.p50Ms, floorMs);
    const relDelta = Number((absDeltaMs / denom).toFixed(4));
    const pass = relDelta <= maxRelDelta;
    comparisons.push({
      skeleton: r1.skeleton,
      arm: r1.arm,
      instances: r1.instances,
      run1P50Ms: r1.p50Ms,
      run2P50Ms: r2.p50Ms,
      absDeltaMs,
      relDelta,
      pass,
    });
  }
  return {
    maxRelDelta: Math.max(...comparisons.map((c) => c.relDelta)),
    pass: comparisons.every((c) => c.pass),
    comparisons,
  };
}

export async function runBenchmarkSuite(options = {}) {
  const timingProtocol = parseTimingProtocol(options.timingProtocol);
  const skeletons = options.skeletons ?? ['spineboy', 'raptor'];
  const instanceCounts = options.instanceCounts ?? [1, 10, 50, 100];
  const runs = options.runs ?? 5;
  const warmupFrames = options.warmupFrames ?? 60;
  const measuredFrames = options.measuredFrames ?? 300;
  const compareBundleInput = options.compareBundle ?? null;
  const compareBundleInfo = compareBundleInput
    ? await prepareCompareBundle(compareBundleInput)
    : null;
  const arms = options.officialControl
    ? ['spine-pixi-v8', 'rig-c-pixi-compare']
    : compareBundleInfo
    ? ['rig-c-pixi', 'rig-c-pixi-compare']
    : ['spine-pixi-v8', 'rig-c-pixi'];

  const benchDir = resolve(root, 'public/bench');
  const manifest = verifyBenchDiskAssets(benchDir, skeletons);
  const diskRefusalMutant = verifyRefusalMutantOnDisk();

  const buildLib = spawnSync('bun', [resolve(root, 'scripts/build-packages.mjs')], {
    cwd: root,
    stdio: 'pipe',
  });
  if (buildLib.status !== 0) {
    throw new Error(`BENCH_BUILD_FAILED: ${buildLib.stderr.toString('utf8')}`);
  }

  const gitCheck = spawn('git', ['ls-files', 'public/bench'], { cwd: root });
  const trackedBenchFiles = await new Promise((res) => {
    let out = '';
    gitCheck.stdout.on('data', (d) => { out += String(d); });
    gitCheck.on('close', () => res(out.trim()));
  });
  if (trackedBenchFiles.length > 0) {
    throw new Error(`BENCH_HYGIENE_VIOLATION: public/bench files are tracked in git:\n${trackedBenchFiles}`);
  }

  const bundles = options.poseSplit ? null : await measureBundles();
  if (compareBundleInfo) {
    bundles['rig-c-pixi-compare'] = {
      adapterAndRuntime: compareBundleInfo.adapterAndRuntime,
      includingPixiHost: compareBundleInfo.includingPixiHost,
    };
  }
  const port = await allocatePort();
  const { child: server, baseUrl } = await startViteServer(port);

  const browser = await chromium.launch({
    headless: true,
    args: [...BENCH_CHROMIUM_ARGS],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 900, height: 640 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');

    const readJsHeapBytes = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      await page.evaluate(() => new Promise((r) => setTimeout(r, 20)));
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      const entry = metrics.find((m) => m.name === 'JSHeapUsedSize');
      return entry ? Math.round(entry.value) : 0;
    };

    await page.goto(`${baseUrl}/bench/index.html`);
    await page.waitForFunction(() => Boolean(window.__rigBench));

    if (compareBundleInfo) {
      await page.evaluate(
        ({ code, label }) =>
          window.__rigBench.registerCompareBundle({ moduleCode: code, label }),
        { code: compareBundleInfo.browserCode, label: compareBundleInfo.sourcePath },
      );
    }
    if (options.compareControl) await page.evaluate(() => window.__rigBench.useCompareAsPrimary(true));

    const gpu = await page.evaluate(() => window.__rigBench.getGpuInfo());

    // Bar 3 browser-level missing asset mutant
    const browserRefusalMutant = await page.evaluate(async () => {
      try {
        await window.__rigBench.verifyAssets('spineboy', '/bench-missing-dir');
        return { pass: false, message: 'did not throw' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          pass: message.includes('BENCH_ASSET_MISSING: spineboy'),
          message,
        };
      }
    });
    if (!browserRefusalMutant.pass) {
      throw new Error(
        `BENCH_MUTANT_SURVIVED: browser verifyAssets mutant did not refuse by name (${browserRefusalMutant.message})`,
      );
    }

    // Bar 1: Correctness check first + negative control mutant
    const correctness = {};
    for (const skeleton of skeletons) {
      const positive = await page.evaluate(
        (s) => window.__rigBench.checkCorrectness(s, { times: [0, 0.35, 0.7], mutant: 'none', arm: 'rig-c-pixi' }),
        skeleton,
      );
      if (!positive.pass) {
        throw new Error(
          `BENCH_CORRECTNESS_FAILED: ${skeleton} failed Bar 1 correctness check before benchmark: ${JSON.stringify(positive)}`,
        );
      }
      const mutant = await page.evaluate(
        (s) => window.__rigBench.checkCorrectness(s, { times: [0, 0.35, 0.7], mutant: 'time-offset', arm: 'rig-c-pixi' }),
        skeleton,
      );
      if (mutant.pass) {
        throw new Error(
          `BENCH_MUTANT_SURVIVED: ${skeleton} time-offset mutant passed Bar 1 correctness check: ${JSON.stringify(mutant)}`,
        );
      }
      let comparePositive = null;
      if (compareBundleInfo) {
        comparePositive = await page.evaluate(
          (s) =>
            window.__rigBench.checkCorrectness(s, {
              times: [0, 0.35, 0.7],
              mutant: 'none',
              arm: 'rig-c-pixi-compare',
            }),
          skeleton,
        );
        if (!comparePositive.pass) {
          throw new Error(
            `BENCH_CORRECTNESS_FAILED: ${skeleton} (rig-c-pixi-compare) failed Bar 1 correctness check before benchmark: ${JSON.stringify(comparePositive)}`,
          );
        }
      }
      correctness[skeleton] = comparePositive
        ? { positive, mutant, comparePositive }
        : { positive, mutant };
    }

    if (options.poseSplit) {
      const drawCallMutants = await page.evaluate(() => window.__rigBench.checkDrawCallMutants());
      if (!drawCallMutants.pass) throw new Error('BENCH_MUTANT_SURVIVED: draw-call controls');
      const rows = [];
      for (const skeleton of skeletons) for (const instances of instanceCounts) {
        for (let run = 0; run < runs; run++) {
          await page.evaluate(
            ({ skeleton, instances, warmupFrames }) => window.__rigBench.prepareBenchmarkStage(skeleton, 'rig-c-pixi', instances, warmupFrames, '/bench', { snapshotOnly: true }),
            { skeleton, instances, warmupFrames },
          );
          const row = await page.evaluate(
            ({ measuredFrames, run }) => window.__rigBench.runPreparedPoseSplit(measuredFrames, run % 2 === 1),
            { measuredFrames, run },
          );
          rows.push({ run, ...row });
          await page.evaluate(() => window.__rigBench.disposePreparedStage());
        }
      }
      return {
        mode: 'pose-split-v1', rows, correctness, drawCallMutants,
        machine: { platform: platform(), release: release(), arch: arch(), browser: browser.version(), ...gpu, chromiumArgs: [...BENCH_CHROMIUM_ARGS] },
        assets: manifest.skeletons, rigcVersion: manifest.rigcTag, spineRuntimesRef: manifest.spineRuntimesRef,
        playVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/@rig-c/play/package.json'), 'utf8')).version,
        hygiene: { diskRefusalMutant, browserRefusalMutant },
        threshold: 0.1,
      };
    }

    if (options.sameFrame) {
      const drawCallMutants = await page.evaluate(() => window.__rigBench.checkDrawCallMutants());
      if (!drawCallMutants.pass) throw new Error('BENCH_MUTANT_SURVIVED: draw-call controls');
      const rows = [];
      for (const skeleton of skeletons) for (const instances of instanceCounts) {
        for (let run = 0; run < runs; run++) {
          const row = await page.evaluate(
            ({ skeleton, arms, instances, warmupFrames, measuredFrames }) =>
              window.__rigBench.runSameFramePair(skeleton, arms, instances, { warmupFrames, measuredFrames }),
            { skeleton, arms, instances, warmupFrames, measuredFrames },
          );
          if (!row.drawCallsPass) throw new Error(`BENCH_SAME_FRAME_DRAW_CALLS: ${skeleton} ${instances}x`);
          rows.push({ run, ...row });
        }
      }
      return {
        mode: 'same-frame-ab-v1', arms, rows, correctness, drawCallMutants,
        liveFrameChecks: arms.includes('rig-c-pixi') && !options.compareControl ? false : null,
        framePaths: Object.fromEntries(arms.map(arm => [arm, arm === 'spine-pixi-v8' ? 'official'
          : arm === 'rig-c-pixi-compare' || options.compareControl ? 'snapshot' : 'live'])),
        compareAsPrimary: Boolean(options.compareControl),
        officialControl: Boolean(options.officialControl),
        machine: { platform: platform(), release: release(), arch: arch(), browser: browser.version(), ...gpu, chromiumArgs: [...BENCH_CHROMIUM_ARGS] },
        assets: manifest.skeletons, rigcVersion: manifest.rigcTag, spineRuntimesRef: manifest.spineRuntimesRef,
        pixiVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/pixi.js/package.json'), 'utf8')).version,
        playVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/@rig-c/play/package.json'), 'utf8')).version,
        compareBundle: compareBundleInfo ? { sourcePath: compareBundleInfo.sourcePath, sha256: compareBundleInfo.sha256, mode: compareBundleInfo.mode } : null,
        hygiene: { diskRefusalMutant, browserRefusalMutant },
        repeatability: 'not measured: compare two independent invocations; no within-command substitute',
      };
    }

    // Pre-warm V8 TurboFan JIT and WebGL batcher buffer pools up to max instance count
    const maxWarmInstances = Math.max(...instanceCounts);
    for (const skeleton of skeletons) {
      for (const arm of arms) {
        await page.evaluate(
          ({ s, a, maxCount }) => window.__rigBench.prepareBenchmarkStage(s, a, maxCount, 90),
          { s: skeleton, a: arm, maxCount: maxWarmInstances },
        );
        await page.evaluate((protocol) => window.__rigBench.runPreparedFrames(90, protocol), timingProtocol);
        await page.evaluate(() => window.__rigBench.disposePreparedStage());
      }
    }

    const toRowSummary = (
      skeleton,
      arm,
      instances,
      runP50s,
      runP95s,
      runMeans,
      runPoseP50s,
      runDrawP50s,
      drawCallsPerFrame,
      trianglesPerFrame,
    ) => ({
      timingProtocol,
      interleaving: 'ABAB',
      skeleton,
      arm,
      instances,
      runs,
      warmupFrames,
      measuredFrames,
      durationSeconds: Number((measuredFrames / 60).toFixed(2)),
      p50Ms: median(runP50s),
      p95Ms: median(runP95s),
      meanMs: median(runMeans),
      poseP50Ms: median(runPoseP50s),
      drawP50Ms: median(runDrawP50s),
      runP50sMs: runP50s,
      runP95sMs: runP95s,
      drawCallsPerFrame,
      trianglesPerFrame,
      heapUsedBytes: 0,
      heapDeltaBytes: 0,
    });

    // Pass 1: Frame time & draw calls across instance counts (ABAB interleaved per skeleton x instance row)
    const frameRows = [];
    const secondFrameRows = options.checkRepro ? [] : null;
    for (const skeleton of skeletons) {
      for (const instances of instanceCounts) {
        const collectedByArm = new Map(
          arms.map((arm) => [arm, { set1: [], set2: [] }]),
        );
        for (const arm of arms) {
          await page.evaluate(
            ({ s, a, count, warmup }) =>
              window.__rigBench.prepareBenchmarkStage(s, a, count, warmup, '/bench', {
                keepPrepared: true,
              }),
            { s: skeleton, a: arm, count: instances, warmup: warmupFrames },
          );
        }
        for (let r = 0; r < runs; r++) {
          for (const arm of arms) {
            const { set1, set2 } = await page.evaluate(
              ({ a, frames, repro, protocol }) =>
                window.__rigBench.runInterleavedArmBatch(a, frames, repro, protocol),
              {
                a: arm,
                frames: measuredFrames,
                repro: Boolean(secondFrameRows),
                protocol: timingProtocol,
              },
            );
            assertTimingProtocolRows(timingProtocol, set1);
            if (secondFrameRows) assertTimingProtocolRows(timingProtocol, set2);
            const bucket = collectedByArm.get(arm);
            bucket.set1.push(...set1);
            if (secondFrameRows) bucket.set2.push(...set2);
          }
        }
        await page.evaluate(() => window.__rigBench.disposePreparedStage());

        for (const arm of arms) {
          const { set1, set2 } = collectedByArm.get(arm);
          const run1P50s = set1.map((b) => b.p50Ms);
          const run1P95s = set1.map((b) => b.p95Ms);
          const run1Means = set1.map((b) => b.meanMs);
          const run1PoseP50s = set1.map((b) => b.poseP50Ms);
          const run1DrawP50s = set1.map((b) => b.drawP50Ms);
          const drawCallsPerFrame = set1[0]?.drawCallsPerFrame ?? 0;
          const trianglesPerFrame = set1[0]?.trianglesPerFrame ?? 0;

          frameRows.push(
            toRowSummary(
              skeleton,
              arm,
              instances,
              run1P50s,
              run1P95s,
              run1Means,
              run1PoseP50s,
              run1DrawP50s,
              drawCallsPerFrame,
              trianglesPerFrame,
            ),
          );
          if (secondFrameRows) {
            const run2P50s = set2.map((b) => b.p50Ms);
            const run2P95s = set2.map((b) => b.p95Ms);
            const run2Means = set2.map((b) => b.meanMs);
            const run2PoseP50s = set2.map((b) => b.poseP50Ms);
            const run2DrawP50s = set2.map((b) => b.drawP50Ms);
            secondFrameRows.push(
              toRowSummary(
                skeleton,
                arm,
                instances,
                run2P50s,
                run2P95s,
                run2Means,
                run2PoseP50s,
                run2DrawP50s,
                drawCallsPerFrame,
                trianglesPerFrame,
              ),
            );
          }
        }
      }
    }

    const pairedFrameTable = computePairedFrameTable(frameRows, arms);
    const secondPairedFrameTable = secondFrameRows
      ? computePairedFrameTable(secondFrameRows, arms)
      : null;

    // Issue #41 Bar 1: Assert unmutated rig-c-pixi draw calls first (spineboy === 1, raptor <= 3)
    const bar1DrawCalls = evaluateBar1DrawCalls(frameRows, skeletons);
    if (!bar1DrawCalls.pass) {
      throw new Error(
        `BENCH_BAR1_DRAW_CALLS_FAILED: unmutated rig-c-pixi exceeded Bar 1 draw-call limits: ${bar1DrawCalls.violations.join('; ')}`,
      );
    }
    const bar1SyntheticMutant = evaluateBar1DrawCalls(
      frameRows.map((r) =>
        r.arm === 'rig-c-pixi' || r.arm === 'rig-c-pixi-compare'
          ? { ...r, drawCallsPerFrame: r.drawCallsPerFrame + 10 } : r,
      ),
      skeletons,
    );
    if (bar1SyntheticMutant.pass) {
      throw new Error(
        'BENCH_MUTANT_SURVIVED: evaluateBar1DrawCalls passed when +10 draw calls were injected into rig-c-pixi rows',
      );
    }

    // Negative control mutants for Issue #41 Bar 1 (per-instance RenderGroup & MeshGeometry batchMode 'auto')
    const drawCallMutants = await page.evaluate(() => window.__rigBench.checkDrawCallMutants());
    if (!drawCallMutants.pass) {
      throw new Error(
        `BENCH_MUTANT_SURVIVED: draw-call mutants did not break batching as expected: ${JSON.stringify(drawCallMutants)}`,
      );
    }

    // Pass 2: Load time to first frame (cold network + PNG decode + WebGL upload, interleaved ABAB)
    const loadResults = [];
    for (const skeleton of skeletons) {
      const loadByArm = new Map(
        arms.map((arm) => [arm, { samples: [], drawCalls: 0 }]),
      );
      for (let r = 0; r < runs; r++) {
        for (const arm of arms) {
          const res = await page.evaluate(
            ({ s, a, idx }) => window.__rigBench.measureLoadToFirstFrame(s, a, idx),
            { s: skeleton, a: arm, idx: r },
          );
          const entry = loadByArm.get(arm);
          entry.samples.push(res.loadMs);
          entry.drawCalls = res.drawCalls;
        }
      }
      for (const arm of arms) {
        const entry = loadByArm.get(arm);
        loadResults.push({
          skeleton,
          arm,
          runs,
          p50Ms: median(entry.samples),
          p95Ms: quantile(entry.samples, 0.95),
          samplesMs: entry.samples,
          firstFrameDrawCalls: entry.drawCalls,
        });
      }
    }

    // Pass 3: JS heap after warm-up via CDP HeapProfiler.collectGarbage + Performance.getMetrics
    await page.evaluate(() => window.__rigBench.disposePreparedStage());
    const baselineHeapBytes = await readJsHeapBytes();
    for (const row of frameRows) {
      await page.evaluate(
        ({ s, a, count, warmup }) =>
          window.__rigBench.prepareBenchmarkStage(s, a, count, warmup),
        { s: row.skeleton, a: row.arm, count: row.instances, warmup: warmupFrames },
      );
      row.heapUsedBytes = await readJsHeapBytes();
      row.heapDeltaBytes = Math.max(0, row.heapUsedBytes - baselineHeapBytes);
      await page.evaluate(() => window.__rigBench.disposePreparedStage());
    }

    const cpuList = cpus();
    const machine = {
      platform: `${platform()} ${release()} (${arch()})`,
      cpuModel: cpuList[0]?.model ?? 'unknown',
      cpuCores: cpuList.length,
      totalMemoryGiB: Number((totalmem() / (1024 ** 3)).toFixed(1)),
      gpuVendor: gpu.vendor,
      gpuRenderer: gpu.renderer,
      webglVersion: gpu.webglVersion,
      chromiumArgs: [...BENCH_CHROMIUM_ARGS],
    };

    const headSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      stdio: 'pipe',
    })
      .stdout.toString('utf8')
      .trim();

    const report = {
      timingProtocol,
      timingDescription: timingProtocolDescription(timingProtocol),
      interleaving: 'ABAB',
      arms,
      host: 'pixi',
      compareAsPrimary: Boolean(options.compareControl),
      officialControl: Boolean(options.officialControl),
      liveFrameChecks: arms.includes('rig-c-pixi') && !options.compareControl ? false : null,
      framePaths: Object.fromEntries(arms.map(arm => [arm, arm === 'spine-pixi-v8' ? 'official'
        : arm === 'rig-c-pixi-compare' || options.compareControl ? 'snapshot' : 'live'])),
      measuredCommit: headSha || 'unknown',
      pixiVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/pixi.js/package.json'), 'utf8')).version,
      playVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/@rig-c/play/package.json'), 'utf8')).version,
      rigcVersion: manifest.rigcTag,
      spineRuntimesRef: manifest.spineRuntimesRef,
      spinePixiVersion: '4.3.13',
      ...(compareBundleInfo
        ? {
            compareBundle: {
              sourcePath: compareBundleInfo.sourcePath,
              mode: compareBundleInfo.mode,
              sha256: compareBundleInfo.sha256,
              adapterAndRuntime: compareBundleInfo.adapterAndRuntime,
              includingPixiHost: compareBundleInfo.includingPixiHost,
            },
          }
        : {}),
      machine,
      hygiene: {
        trackedBenchFiles: '(empty)',
        diskRefusalMutant,
        browserRefusalMutant,
      },
      drawCallMutants,
      bundles,
      assets: manifest.skeletons,
      correctness,
      loadToFirstFrame: loadResults,
      frameTable: frameRows,
      pairedFrameTable,
      secondFrameTable: secondFrameRows,
      secondPairedFrameTable,
    };
    return report;
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

export function formatSameFrameMarkdown(report) {
  const lines = ['# Same-frame AB benchmark', '',
    'Protocol: `same-frame-ab-v1`, one 1800 × 640 canvas, 900 × 640 per arm; AB/BA alternates every frame. CPU submit includes timer instrumentation and driver back-pressure. GPU query values measure execution; whole-frame completion is CPU wall time through one gl.finish(), never GPU-only time.', '',
    `Machine: ${JSON.stringify(report.machine)}`, '',
    '| Rig | Instances | Run | CPU B−A p50 ms | CPU B−A p95 ms | p95−p05 ms | Whole completion p50 ms | GPU queries |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
  for (const row of report.rows) lines.push(`| ${row.skeleton} | ${row.instances} | ${row.run} | ${row.cpuPairedDifference.p50Ms} | ${row.cpuPairedDifference.p95Ms} | ${row.cpuPairedDifference.spreadMs} | ${row.wholeFrameCompletion.p50Ms} | ${row.gpuStatus} |`);
  lines.push('', `Repeatability: ${report.repeatability}.`, '', 'Raw per-frame CPU/GPU samples, half-image gates and dependency/fixture provenance are available with --json.');
  return lines.join('\n');
}

// No floor: near-zero signed differences can be intrinsically unstable. Exact
// zero against zero is zero spread; zero against nonzero cannot pass.
export function compareSameFrameReports(first, second, limit = 0.05) {
  if (first.mode !== 'same-frame-ab-v1' || second.mode !== first.mode) throw new Error('BENCH_SAME_FRAME: report mode mismatch');
  for (const field of ['arms', 'assets', 'machine', 'rigcVersion', 'spineRuntimesRef', 'pixiVersion', 'playVersion', 'compareBundle']) {
    if (first[field] === undefined || second[field] === undefined || JSON.stringify(first[field]) !== JSON.stringify(second[field])) {
      throw new Error(`BENCH_SAME_FRAME: missing or mismatched provenance ${field}`);
    }
  }
  const group = report => {
    const groups = new Map();
    for (const row of report.rows) {
      if (!row.frames?.length || row.frames.some(f => f.arms?.length !== 2 || f.arms.some(a => !Number.isFinite(a.cpuMs) || a.cpuMs < 0))) throw new Error('BENCH_SAME_FRAME: invalid CPU samples');
      const key = JSON.stringify([row.skeleton, row.instances, row.arms, row.warmupFrames, row.measuredFrames]);
      const list = groups.get(key) ?? [];
      list.push(...row.frames.map(f => f.arms[1].cpuMs - f.arms[0].cpuMs));
      groups.set(key, list);
    }
    if (!groups.size) throw new Error('BENCH_SAME_FRAME: empty report rows');
    return groups;
  };
  const a = group(first), b = group(second);
  if (a.size !== b.size || [...a.keys()].some(k => !b.has(k))) throw new Error('BENCH_SAME_FRAME: workload mismatch');
  return [...a].map(([key, values]) => {
    const rawMedian = samples => {
      const sorted = [...samples].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };
    if (values.length !== b.get(key).length) throw new Error('BENCH_SAME_FRAME: sample count mismatch');
    const x = rawMedian(values), y = rawMedian(b.get(key));
    const spread = x === 0 && y === 0 ? 0 : x === 0 ? null : Math.abs(y - x) / Math.abs(x);
    return { key, firstP50Ms: x, secondP50Ms: y, relativeSpread: spread, pass: spread !== null && spread <= limit };
  });
}

export function formatResultsMarkdown(report, reproReport) {
  if (report.timingProtocol === undefined) throw new Error('BENCH_TIMING_PROTOCOL: report has no protocol');
  const timingProtocol = parseTimingProtocol(report.timingProtocol);
  assertTimingProtocolRows(timingProtocol, report.frameTable);
  if (report.secondFrameTable) assertTimingProtocolRows(timingProtocol, report.secondFrameTable);
  const arms = Array.isArray(report.arms) && report.arms.length === 2
    ? report.arms
    : ['spine-pixi-v8', 'rig-c-pixi'];
  const pairedRows = Array.isArray(report.pairedFrameTable)
    ? (assertTimingProtocolRows(timingProtocol, report.pairedFrameTable), report.pairedFrameTable)
    : report.frameTable.some((r) => r.arm === arms[0]) && report.frameTable.some((r) => r.arm === arms[1])
      ? computePairedFrameTable(report.frameTable, arms)
      : [];
  const compareArg = report.compareBundle?.sourcePath
    ? ` --compare-bundle ${report.compareBundle.sourcePath}`
    : '';
  const command = `bun run bench -- --timing-protocol ${timingProtocol}${compareArg}`;
  const lines = [];
  lines.push('# Benchmark Results — `pixi` (`@rig-c/pixi` vs `@esotericsoftware/spine-pixi-v8`)');
  lines.push('');
  lines.push('Every figure in this document is produced by the command printed alongside its section.');
  lines.push('');
  lines.push('## Environment & Provenance');
  lines.push('');
  lines.push(`- **Command**: \`${command}\` (add \`--json\` for JSON)`);
  lines.push(`- **Timing protocol**: \`${timingProtocol}\` — ${timingProtocolDescription(timingProtocol)}`);
  lines.push(`- **Run interleaving**: \`${report.interleaving ?? 'ABAB'}\` (${arms.join(' <-> ')})`);
  lines.push('- **Comparison rule**: Compare only matching protocol IDs and recorded fixtures, dependencies, browser/GPU, workload and host conditions. Historical unlabeled results are cpu-submit-v1; a v2-v1 difference is not a runtime improvement.');
  lines.push(`- **Measured head commit**: \`${report.measuredCommit}\``);
  lines.push(`- **Host engine**: \`pixi.js@${report.pixiVersion}\``);
  if (report.compareBundle) {
    lines.push(`- **Arm A (Base \`@rig-c/pixi\` over \`@rig-c/play\`)**: \`@rig-c/pixi\` + \`@rig-c/play@${report.playVersion}\` (\`rigc ${report.rigcVersion}\`)`);
    lines.push(`- **Arm B (Compare bundle \`rig-c-pixi-compare\`)**: \`${report.compareBundle.sourcePath}\` (\`mode=${report.compareBundle.mode}\`, \`sha256=${report.compareBundle.sha256}\`)`);
  } else {
    lines.push(`- **Arm A (Official Spine runtime)**: \`@esotericsoftware/spine-pixi-v8@${report.spinePixiVersion}\``);
    lines.push(`- **Arm B (\`@rig-c/pixi\` over \`@rig-c/play\`)**: \`@rig-c/pixi\` + \`@rig-c/play@${report.playVersion}\` (\`rigc ${report.rigcVersion}\`)`);
  }
  lines.push(`- **Upstream Spine examples ref**: \`EsotericSoftware/spine-runtimes@${report.spineRuntimesRef}\``);
  lines.push(`- **Platform / CPU**: \`${report.machine.platform}\` — \`${report.machine.cpuModel}\` (\`${report.machine.cpuCores}\` cores, \`${report.machine.totalMemoryGiB} GiB\` RAM)`);
  lines.push(`- **GPU / WebGL**: \`${report.machine.gpuRenderer}\` (\`${report.machine.webglVersion}\`)`);
  if (Array.isArray(report.machine.chromiumArgs) && report.machine.chromiumArgs.length > 0) {
    lines.push(`- **Chromium launch args**: \`${report.machine.chromiumArgs.join(' ')}\``);
  }
  lines.push(`- **Protocol**: Headless Chromium via Playwright, \`900 x 640\` WebGL canvas (\`devicePixelRatio = 1\`), \`M = ${report.frameTable[0]?.runs ?? 5}\` interleaved \`ABAB\` runs, \`${report.frameTable[0]?.warmupFrames ?? 60}\` warm-up frames + \`${report.frameTable[0]?.measuredFrames ?? 300}\` measured frames (\`${report.frameTable[0]?.durationSeconds ?? 5} s\` at \`dt = 1/60 s\`) per run; median across runs reported.`);
  lines.push('');

  lines.push('## Bar 1 — Correctness Check Before Benchmark (`walk`, 3 sampled times)');
  lines.push('');
  lines.push(`Command: \`${command}\``);
  lines.push('');
  lines.push('| Skeleton | Animation | Sample times (s) | Max whole-canvas MAE (px, <= 2.0) | Max content-union MAE (px, <= 6.0) | Max shift-tolerant `badRatio` (<= 0.005) | Max `contentMismatch` (<= 0.020) | Mutant (`+0.15s` offset) whole-canvas MAE | Mutant verdict | Verdict |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const [skeleton, entry] of Object.entries(report.correctness)) {
    const pos = entry.positive;
    const mut = entry.mutant;
    const timesStr = pos.samples.map((s) => s.time.toFixed(2)).join(', ');
    lines.push(
      `| \`${skeleton}\` | \`${pos.animation}\` | \`${timesStr}\` | \`${pos.maxWholeCanvasMae.toFixed(4)}\` | \`${pos.maxContentUnionMae.toFixed(4)}\` | \`${pos.maxBadRatio.toFixed(6)}\` | \`${pos.maxContentMismatch.toFixed(6)}\` | \`${mut.maxWholeCanvasMae.toFixed(4)}\` (\`badRatio=${mut.maxBadRatio.toFixed(4)}\`) | ${!mut.pass ? 'FAIL (caught)' : 'SURVIVED'} | ${pos.pass && !mut.pass ? 'PASS' : 'FAIL'} |`,
    );
  }
  lines.push('');

  lines.push('## Runtime JS Bundle Size (minified ESM, `Bun.build`)');
  lines.push('');
  lines.push(`Command: \`${command}\``);
  lines.push('');
  lines.push('| Arm | Scope | Raw bytes | Gzip bytes (level 9) |');
  lines.push('| --- | --- | ---: | ---: |');
  lines.push(
    `| \`@esotericsoftware/spine-pixi-v8@${report.spinePixiVersion}\` | Adapter + Spine runtime (\`pixi.js\` external) | \`${report.bundles['spine-pixi-v8'].adapterAndRuntime.rawBytes.toLocaleString('en-US')}\` | \`${report.bundles['spine-pixi-v8'].adapterAndRuntime.gzipBytes.toLocaleString('en-US')}\` |`,
  );
  lines.push(
    `| \`@rig-c/pixi\` + \`@rig-c/play@${report.playVersion}\` | Adapter + \`@rig-c/play\` + \`rig-c/core\` (\`pixi.js\` external) | \`${report.bundles['rig-c-pixi'].adapterAndRuntime.rawBytes.toLocaleString('en-US')}\` | \`${report.bundles['rig-c-pixi'].adapterAndRuntime.gzipBytes.toLocaleString('en-US')}\` |`,
  );
  if (report.bundles['rig-c-pixi-compare']) {
    lines.push(
      `| \`rig-c-pixi-compare\` (\`${report.compareBundle?.sourcePath ?? 'compare'}\`) | Adapter + compare runtime (\`pixi.js\` external) | \`${report.bundles['rig-c-pixi-compare'].adapterAndRuntime.rawBytes.toLocaleString('en-US')}\` | \`${report.bundles['rig-c-pixi-compare'].adapterAndRuntime.gzipBytes.toLocaleString('en-US')}\` |`,
    );
  }
  lines.push(
    `| \`@esotericsoftware/spine-pixi-v8@${report.spinePixiVersion}\` | Full bundle including \`pixi.js@${report.pixiVersion}\` | \`${report.bundles['spine-pixi-v8'].includingPixiHost.rawBytes.toLocaleString('en-US')}\` | \`${report.bundles['spine-pixi-v8'].includingPixiHost.gzipBytes.toLocaleString('en-US')}\` |`,
  );
  lines.push(
    `| \`@rig-c/pixi\` + \`@rig-c/play@${report.playVersion}\` | Full bundle including \`pixi.js@${report.pixiVersion}\` | \`${report.bundles['rig-c-pixi'].includingPixiHost.rawBytes.toLocaleString('en-US')}\` | \`${report.bundles['rig-c-pixi'].includingPixiHost.gzipBytes.toLocaleString('en-US')}\` |`,
  );
  if (report.bundles['rig-c-pixi-compare']) {
    lines.push(
      `| \`rig-c-pixi-compare\` (\`${report.compareBundle?.sourcePath ?? 'compare'}\`) | Full bundle including \`pixi.js@${report.pixiVersion}\` | \`${report.bundles['rig-c-pixi-compare'].includingPixiHost.rawBytes.toLocaleString('en-US')}\` | \`${report.bundles['rig-c-pixi-compare'].includingPixiHost.gzipBytes.toLocaleString('en-US')}\` |`,
    );
  }
  lines.push('');

  lines.push('## Model Asset Byte Sizes (`rigc ingest --art none` -> `rigc build --atlas-in`)');
  lines.push('');
  lines.push('Command: `bash scripts/fetch-assets.sh && cat public/bench/manifest.json`');
  lines.push('');
  lines.push('| Skeleton | Artifact | Raw bytes | Gzip bytes | SHA-256 |');
  lines.push('| --- | --- | ---: | ---: | --- |');
  for (const [skeleton, data] of Object.entries(report.assets)) {
    const f = data.files;
    lines.push(`| \`${skeleton}\` | Upstream \`${skeleton}-pro.json\` | \`${f.spineJson.bytes.toLocaleString('en-US')}\` | \`${f.spineJson.gzipBytes.toLocaleString('en-US')}\` | \`${f.spineJson.sha256}\` |`);
    lines.push(`| \`${skeleton}\` | Upstream \`${skeleton}.atlas\` | \`${f.spineAtlas.bytes.toLocaleString('en-US')}\` | \`${f.spineAtlas.gzipBytes.toLocaleString('en-US')}\` | \`${f.spineAtlas.sha256}\` |`);
    lines.push(`| \`${skeleton}\` | Upstream \`${skeleton}.png\` | \`${f.atlasPng.bytes.toLocaleString('en-US')}\` | \`${f.atlasPng.gzipBytes.toLocaleString('en-US')}\` | \`${f.atlasPng.sha256}\` |`);
    lines.push(`| \`${skeleton}\` | Ingested \`rig.json\` | \`${f.ingestedRig.bytes.toLocaleString('en-US')}\` | \`${f.ingestedRig.gzipBytes.toLocaleString('en-US')}\` | \`${f.ingestedRig.sha256}\` |`);
    lines.push(`| \`${skeleton}\` | Ingested \`motion.json\` | \`${f.ingestedMotion.bytes.toLocaleString('en-US')}\` | \`${f.ingestedMotion.gzipBytes.toLocaleString('en-US')}\` | \`${f.ingestedMotion.sha256}\` |`);
    lines.push(`| \`${skeleton}\` | Built \`skeleton.model.json\` | \`${f.builtModel.bytes.toLocaleString('en-US')}\` | \`${f.builtModel.gzipBytes.toLocaleString('en-US')}\` | \`${f.builtModel.sha256}\` |`);
  }
  lines.push('');

  lines.push('## Load Time to First Rendered Frame');
  lines.push('');
  lines.push(`Command: \`${command}\``);
  lines.push('');
  lines.push(
    '> **Note**: The load-to-first-frame and back-to-back reproducibility figures in this run are not trusted until [#43](https://github.com/rig-c/adapters/issues/43) lands (`loadRigPlayModel` duplicate `skeleton.model.json` fetch, `collectPreparedRuns` frame interleaving, and `evaluateReproducibility` `3.0 ms` denominator floor).',
  );
  lines.push('');
  lines.push('| Skeleton | Arm | Runs ($M$) | Load `p50` (ms) | Load `p95` (ms) | First-frame draw calls |');
  lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
  for (const row of report.loadToFirstFrame) {
    lines.push(
      `| \`${row.skeleton}\` | \`${row.arm}\` | \`${row.runs}\` | \`${row.p50Ms.toFixed(3)}\` | \`${row.p95Ms.toFixed(3)}\` | \`${row.firstFrameDrawCalls}\` |`,
    );
  }
  lines.push('');

  lines.push('## Steady-State Frame Time (`p50` / `p95`), Pose vs Draw Split, Draw Calls, and JS Heap (`1x`, `10x`, `50x`, `100x`)');
  lines.push('');
  lines.push(`Command: \`${command}\` (measured at commit \`${report.measuredCommit}\`)`);
  lines.push('');
  lines.push('| Skeleton | Instances | Arm | Frame `p50` (ms) | Per-run `p50` in order (ms) | Pose `p50` (ms) | Draw/completion `p50` (ms) | Frame `p95` (ms) | Frame `mean` (ms) | Draw calls / frame | Triangles / frame | JS heap after warm-up (KiB) | Heap delta over empty stage (KiB) |');
  lines.push('| --- | ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.frameTable) {
    const heapKiB = (row.heapUsedBytes / 1024).toFixed(1);
    const deltaKiB = (row.heapDeltaBytes / 1024).toFixed(1);
    const runSeries = Array.isArray(row.runP50sMs)
      ? row.runP50sMs.map((v) => v.toFixed(3)).join(', ')
      : row.p50Ms.toFixed(3);
    lines.push(
      `| \`${row.skeleton}\` | \`${row.instances}x\` | \`${row.arm}\` | \`${row.p50Ms.toFixed(3)}\` | \`[${runSeries}]\` | \`${row.poseP50Ms.toFixed(3)}\` | \`${row.drawP50Ms.toFixed(3)}\` | \`${row.p95Ms.toFixed(3)}\` | \`${row.meanMs.toFixed(3)}\` | \`${row.drawCallsPerFrame}\` | \`${row.trianglesPerFrame}\` | \`${heapKiB}\` | \`+${deltaKiB}\` |`,
    );
  }
  lines.push('');

  if (pairedRows.length > 0) {
    lines.push('## Paired AB Differences (`ABAB` Interleaved Runs)');
    lines.push('');
    lines.push(`Command: \`${command}\``);
    lines.push('');
    lines.push('| Skeleton | Instances | Arm A | Arm B | Arm A `p50` (ms) | Arm B `p50` (ms) | Paired diffs `B - A` in order (ms) | Paired `p50` diff `B - A` (ms) | Paired `p50` rel diff `(B - A) / A` | Paired `p50` ratio `B / A` |');
    lines.push('| --- | ---: | --- | --- | ---: | ---: | --- | ---: | ---: | ---: |');
    for (const p of pairedRows) {
      const diffsStr = p.pairDiffsMs.map((d) => (d >= 0 ? `+${d.toFixed(3)}` : d.toFixed(3))).join(', ');
      const p50DiffStr = p.p50DiffMs >= 0 ? `+${p.p50DiffMs.toFixed(3)}` : p.p50DiffMs.toFixed(3);
      const p50RelStr = p.p50RelDiff >= 0 ? `+${p.p50RelDiff.toFixed(4)}` : p.p50RelDiff.toFixed(4);
      lines.push(
        `| \`${p.skeleton}\` | \`${p.instances}x\` | \`${p.armA}\` | \`${p.armB}\` | \`${p.armAP50Ms.toFixed(3)}\` | \`${p.armBP50Ms.toFixed(3)}\` | \`[${diffsStr}]\` | \`${p50DiffStr}\` | \`${p50RelStr}\` | \`${p.p50Ratio.toFixed(4)}x\` |`,
      );
    }
    lines.push('');
  }

  lines.push('Historical timing comparisons omitted. Compare separate reports only after verifying matching protocol, inputs and host conditions.');
  lines.push('');
  if (report.drawCallMutants) {
    lines.push(
      `- **Bar 1 Negative-Control Mutants (\`100x\` draw calls)**: \`renderGroup: true\` on \`spineboy\` -> \`${report.drawCallMutants.renderGroupMutantSpineboy100x}\` draw calls (\`> 1\`, \`FAIL (caught)\`); \`meshBatchMode = 'auto'\` alone on \`raptor\` -> \`${report.drawCallMutants.meshBatchAutoMutantRaptor100x}\` draw calls (\`> 3\`, \`FAIL (caught)\`); \`renderGroup: true\` + \`meshBatchMode = 'auto'\` on \`raptor\` -> \`${report.drawCallMutants.combinedMutantRaptor100x}\` draw calls (\`> 3\`, \`FAIL (caught)\`).`,
    );
    lines.push('');
  }

  if (reproReport) {
    lines.push('## Bar 2 — Back-to-Back Reproducibility Check (`p50` within 5%)');
    lines.push('');
    lines.push(`Command: \`${command} --check-repro\``);
    lines.push('');
    lines.push(
      '> **Note**: The back-to-back reproducibility figures in this run are not trusted until [#43](https://github.com/rig-c/adapters/issues/43) lands (`evaluateReproducibility` `3.0 ms` denominator floor and `collectPreparedRuns` frame interleaving).',
    );
    lines.push('');
    lines.push('| Skeleton | Instances | Arm | Run 1 `p50` (ms) | Run 2 `p50` (ms) | Abs delta (ms) | Relative delta (`<= 0.0500`) | Verdict |');
    lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |');
    for (const c of reproReport.comparisons) {
      lines.push(
        `| \`${c.skeleton}\` | \`${c.instances}x\` | \`${c.arm}\` | \`${c.run1P50Ms.toFixed(3)}\` | \`${c.run2P50Ms.toFixed(3)}\` | \`${c.absDeltaMs.toFixed(3)}\` | \`${c.relDelta.toFixed(4)}\` | ${c.pass ? 'PASS' : 'FAIL'} |`,
      );
    }
    lines.push('');
    lines.push(
      `- Max relative delta across all 16 rows: \`${reproReport.maxRelDelta.toFixed(4)} <= 0.0500\` (\`PASS\`)`,
    );
    lines.push(
      '- Synthetic drift mutant (`+25% + 1.0 ms` injected into Run 2 `p50`): `FAIL (caught)` (`PASS`)',
    );
    lines.push('');
  }

  lines.push('## Bar 3 — Refusal by Name & Asset Hygiene');
  lines.push('');
  lines.push('Command: `bun run bench` and `git status --porcelain public/bench`');
  lines.push('');
  lines.push(`- Tracked files under \`public/bench\`: \`${report.hygiene.trackedBenchFiles}\``);
  lines.push(`- Disk missing-asset mutant refusal: \`${report.hygiene.diskRefusalMutant.refusedMessage}\` (\`PASS\`)`);
  lines.push(`- Browser missing-asset mutant refusal: \`${report.hygiene.browserRefusalMutant.message}\` (\`PASS\`)`);
  lines.push('');
  // Historical prose contained measured ratios tied to the legacy host/run.
  lines.push('## Timing Interpretation');
  lines.push('');
  lines.push(timingProtocolDescription(timingProtocol));
  lines.push('Pose and draw medians need not sum to the frame median. These are unpaced wall-time samples, not FPS.');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--pose-split') && (args.includes('--same-frame') || args.includes('--check-repro') || args.some(arg => arg.startsWith('--compare-bundle')))) {
    throw new Error('BENCH_POSE_SPLIT: pose split cannot be combined with same-frame, repro or compare-bundle modes');
  }
  const timingProtocol = parseTimingProtocolArgs(args);
  const compareBundle = parseCompareBundleArgs(args);
  if (args.includes('--compare-control') && !compareBundle) throw new Error('BENCH_COMPARE_CONTROL: --compare-control needs --compare-bundle');
  if (args.includes('--official-control') && (!compareBundle || args.includes('--compare-control'))) throw new Error('BENCH_OFFICIAL_CONTROL: needs --compare-bundle without --compare-control');
  if (args.includes('--same-frame') && (args.includes('--check-repro') || args.some(a => a.startsWith('--timing-protocol')))) throw new Error('BENCH_SAME_FRAME: --check-repro and --timing-protocol do not apply; use two independent invocations');
  const isSmoke = args.includes('--smoke');
  const isJson = args.includes('--json');
  const checkRepro = args.includes('--check-repro');
  const writeResultsIdx = args.indexOf('--write-results');
  const writeResultsPath =
    writeResultsIdx !== -1 && args[writeResultsIdx + 1] && !args[writeResultsIdx + 1].startsWith('--')
      ? resolve(root, args[writeResultsIdx + 1])
      : args.includes('--write-results')
        ? resolve(root, 'bench/RESULTS.md')
        : null;

  const runsIdx = args.indexOf('--runs');
  const runs =
    runsIdx !== -1 && args[runsIdx + 1]
      ? Number(args[runsIdx + 1])
      : isSmoke
        ? 2
        : 7;

  const instancesIdx = args.indexOf('--instances');
  const instanceCounts =
    instancesIdx !== -1 && args[instancesIdx + 1]
      ? args[instancesIdx + 1].split(',').map((n) => Number(n.trim()))
      : isSmoke
        ? [1, 10]
        : [1, 10, 50, 100];

  const skeletonsIdx = args.indexOf('--skeletons');
  const skeletons =
    skeletonsIdx !== -1 && args[skeletonsIdx + 1]
      ? args[skeletonsIdx + 1].split(',').map((s) => s.trim())
      : ['spineboy', 'raptor'];

  const measuredFrames = isSmoke ? 60 : 76;
  const warmupFrames = isSmoke ? 20 : 60;

  const report = await runBenchmarkSuite({
    poseSplit: args.includes('--pose-split'),
    compareControl: args.includes('--compare-control'),
    officialControl: args.includes('--official-control'),
    timingProtocol,
    sameFrame: args.includes('--same-frame'),
    compareBundle,
    skeletons,
    instanceCounts,
    runs,
    warmupFrames,
    measuredFrames,
    checkRepro,
  });

  if (args.includes('--pose-split')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (args.includes('--same-frame')) {
    const output = isJson ? JSON.stringify(report, null, 2) : formatSameFrameMarkdown(report);
    if (writeResultsPath) writeFileSync(writeResultsPath, formatSameFrameMarkdown(report));
    console.log(output);
    return;
  }
  let reproReport = null;
  if (checkRepro && report.secondFrameTable) {
    reproReport = evaluateReproducibility(report.frameTable, report.secondFrameTable);
    const pairedRepro = report.secondPairedFrameTable
      ? evaluatePairedReproducibility(report.pairedFrameTable, report.secondPairedFrameTable)
      : null;
    delete report.secondFrameTable;
    delete report.secondPairedFrameTable;
    if (!reproReport.pass) {
      throw new Error(
        `BENCH_REPRODUCIBILITY_FAILED: maxRelDelta=${reproReport.maxRelDelta} > 0.05:\n${JSON.stringify(reproReport, null, 2)}`,
      );
    }
    // Verify negative control mutant for Bar 2 reproducibility check
    const driftedRows = report.frameTable.map((r) => ({
      ...r,
      p50Ms: Number((r.p50Ms * 1.25 + 1.0).toFixed(3)),
    }));
    const driftCheck = evaluateReproducibility(report.frameTable, driftedRows);
    if (driftCheck.pass) {
      throw new Error('BENCH_MUTANT_SURVIVED: +25% drifted p50 rows passed reproducibility check');
    }
    report.reproducibility = {
      ...reproReport,
      ...(pairedRepro ? { paired: pairedRepro } : {}),
      driftMutantCaught: !driftCheck.pass,
    };
  }

  if (writeResultsPath) {
    writeFileSync(writeResultsPath, formatResultsMarkdown(report, reproReport));
  }

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatResultsMarkdown(report, reproReport));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
