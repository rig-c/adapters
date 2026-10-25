import { parseTimingProtocol, assertTimingProtocolRows, timingProtocolDescription } from '../bench/timing-protocol.ts';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';
import { root } from './workspaces.mjs';

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
  const tmpDir = resolve(root, 'node_modules/.cache/bench-refusal-mutant');
  rmSync(tmpDir, { recursive: true, force: true });
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
  const tmpDir = resolve(root, 'node_modules/.cache/bench-bundles');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

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
    `export { loadModel, RigPlayer } from '@rig-c/play';
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

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Number(((sorted[mid - 1] + sorted[mid]) / 2).toFixed(3))
    : Number(sorted[mid].toFixed(3));
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const val = base + 1 < sorted.length
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
  return Number(val.toFixed(3));
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
    const rows = frameRows.filter((r) => r.skeleton === skeleton && r.arm === 'rig-c-pixi');
    if (rows.length === 0) {
      violations.push(`${skeleton} missing rig-c-pixi rows`);
      continue;
    }
    for (const row of rows) {
      if (row.drawCallsPerFrame > limit) {
        violations.push(
          `${row.skeleton} ${row.instances}x rig-c-pixi drawCallsPerFrame=${row.drawCallsPerFrame} (expected <= ${limit})`,
        );
      }
    }
  }
  return {
    pass: violations.length === 0,
    violations,
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
  const arms = ['spine-pixi-v8', 'rig-c-pixi'];

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

  const bundles = await measureBundles();
  const port = await allocatePort();
  const { child: server, baseUrl } = await startViteServer(port);

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--js-flags=--expose-gc',
      '--enable-precise-memory-info',
    ],
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
        (s) => window.__rigBench.checkCorrectness(s, { times: [0, 0.35, 0.7], mutant: 'none' }),
        skeleton,
      );
      if (!positive.pass) {
        throw new Error(
          `BENCH_CORRECTNESS_FAILED: ${skeleton} failed Bar 1 correctness check before benchmark: ${JSON.stringify(positive)}`,
        );
      }
      const mutant = await page.evaluate(
        (s) => window.__rigBench.checkCorrectness(s, { times: [0, 0.35, 0.7], mutant: 'time-offset' }),
        skeleton,
      );
      if (mutant.pass) {
        throw new Error(
          `BENCH_MUTANT_SURVIVED: ${skeleton} time-offset mutant passed Bar 1 correctness check: ${JSON.stringify(mutant)}`,
        );
      }
      correctness[skeleton] = { positive, mutant };
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

    // Pass 1: Frame time & draw calls across instance counts
    const frameRows = [];
    const secondFrameRows = options.checkRepro ? [] : null;
    for (const skeleton of skeletons) {
      for (const instances of instanceCounts) {
        for (const arm of arms) {
          await page.evaluate(
            ({ s, a, count, warmup }) =>
              window.__rigBench.prepareBenchmarkStage(s, a, count, warmup),
            { s: skeleton, a: arm, count: instances, warmup: warmupFrames },
          );
          const { set1, set2 } = await page.evaluate(
            ({ rCount, frames, repro, protocol }) =>
              window.__rigBench.collectPreparedRuns(rCount, frames, repro, protocol),
            { rCount: runs, frames: measuredFrames, repro: Boolean(secondFrameRows), protocol: timingProtocol },
          );
          assertTimingProtocolRows(timingProtocol, set1);
          if (secondFrameRows) assertTimingProtocolRows(timingProtocol, set2);
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
          await page.evaluate(() => window.__rigBench.disposePreparedStage());
        }
      }
    }

    // Issue #41 Bar 1: Assert unmutated rig-c-pixi draw calls first (spineboy === 1, raptor <= 3)
    const bar1DrawCalls = evaluateBar1DrawCalls(frameRows, skeletons);
    if (!bar1DrawCalls.pass) {
      throw new Error(
        `BENCH_BAR1_DRAW_CALLS_FAILED: unmutated rig-c-pixi exceeded Bar 1 draw-call limits: ${bar1DrawCalls.violations.join('; ')}`,
      );
    }
    const bar1SyntheticMutant = evaluateBar1DrawCalls(
      frameRows.map((r) =>
        r.arm === 'rig-c-pixi' ? { ...r, drawCallsPerFrame: r.drawCallsPerFrame + 10 } : r,
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

    // Pass 2: Load time to first frame (cold network + PNG decode + WebGL upload)
    const loadResults = [];
    for (const skeleton of skeletons) {
      for (const arm of arms) {
        const loadSamples = [];
        let drawCalls = 0;
        for (let r = 0; r < runs; r++) {
          const res = await page.evaluate(
            ({ s, a, idx }) => window.__rigBench.measureLoadToFirstFrame(s, a, idx),
            { s: skeleton, a: arm, idx: r },
          );
          loadSamples.push(res.loadMs);
          drawCalls = res.drawCalls;
        }
        loadResults.push({
          skeleton,
          arm,
          runs,
          p50Ms: median(loadSamples),
          p95Ms: quantile(loadSamples, 0.95),
          samplesMs: loadSamples,
          firstFrameDrawCalls: drawCalls,
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
    };

    const headSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      stdio: 'pipe',
    })
      .stdout.toString('utf8')
      .trim();

    return {
      timingProtocol,
      timingDescription: timingProtocolDescription(timingProtocol),
      host: 'pixi',
      measuredCommit: headSha || 'unknown',
      pixiVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/pixi.js/package.json'), 'utf8')).version,
      playVersion: JSON.parse(readFileSync(resolve(root, 'node_modules/@rig-c/play/package.json'), 'utf8')).version,
      rigcVersion: manifest.rigcTag,
      spineRuntimesRef: manifest.spineRuntimesRef,
      spinePixiVersion: '4.3.13',
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
      secondFrameTable: secondFrameRows,
    };
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

export function formatResultsMarkdown(report, reproReport) {
  if (report.timingProtocol === undefined) throw new Error('BENCH_TIMING_PROTOCOL: report has no protocol');
  const timingProtocol = parseTimingProtocol(report.timingProtocol);
  assertTimingProtocolRows(timingProtocol, report.frameTable);
  if (report.secondFrameTable) assertTimingProtocolRows(timingProtocol, report.secondFrameTable);
  const command = `bun run bench -- --timing-protocol ${timingProtocol}`;
  const lines = [];
  lines.push('# Benchmark Results — `pixi` (`@rig-c/pixi` vs `@esotericsoftware/spine-pixi-v8`)');
  lines.push('');
  lines.push('Every figure in this document is produced by the command printed alongside its section.');
  lines.push('');
  lines.push('## Environment & Provenance');
  lines.push('');
  lines.push(`- **Command**: \`${command}\` (add \`--json\` for JSON)`);
  lines.push(`- **Timing protocol**: \`${timingProtocol}\` — ${timingProtocolDescription(timingProtocol)}`);
  lines.push('- **Comparison rule**: Compare only matching protocol IDs and recorded fixtures, dependencies, browser/GPU, workload and host conditions. Historical unlabeled results are cpu-submit-v1; a v2-v1 difference is not a runtime improvement.');
  lines.push(`- **Measured head commit**: \`${report.measuredCommit}\``);
  lines.push(`- **Host engine**: \`pixi.js@${report.pixiVersion}\``);
  lines.push(`- **Arm A (Official Spine runtime)**: \`@esotericsoftware/spine-pixi-v8@${report.spinePixiVersion}\``);
  lines.push(`- **Arm B (\`@rig-c/pixi\` over \`@rig-c/play\`)**: \`@rig-c/pixi\` + \`@rig-c/play@${report.playVersion}\` (\`rigc ${report.rigcVersion}\`)`);
  lines.push(`- **Upstream Spine examples ref**: \`EsotericSoftware/spine-runtimes@${report.spineRuntimesRef}\``);
  lines.push(`- **Platform / CPU**: \`${report.machine.platform}\` — \`${report.machine.cpuModel}\` (\`${report.machine.cpuCores}\` cores, \`${report.machine.totalMemoryGiB} GiB\` RAM)`);
  lines.push(`- **GPU / WebGL**: \`${report.machine.gpuRenderer}\` (\`${report.machine.webglVersion}\`)`);
  lines.push(`- **Protocol**: Headless Chromium via Playwright, \`900 x 640\` WebGL canvas (\`devicePixelRatio = 1\`), \`M = ${report.frameTable[0]?.runs ?? 5}\` runs, \`${report.frameTable[0]?.warmupFrames ?? 60}\` warm-up frames + \`${report.frameTable[0]?.measuredFrames ?? 300}\` measured frames (\`${report.frameTable[0]?.durationSeconds ?? 5} s\` at \`dt = 1/60 s\`) per run; median across runs reported.`);
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
  lines.push(
    `| \`@esotericsoftware/spine-pixi-v8@${report.spinePixiVersion}\` | Full bundle including \`pixi.js@${report.pixiVersion}\` | \`${report.bundles['spine-pixi-v8'].includingPixiHost.rawBytes.toLocaleString('en-US')}\` | \`${report.bundles['spine-pixi-v8'].includingPixiHost.gzipBytes.toLocaleString('en-US')}\` |`,
  );
  lines.push(
    `| \`@rig-c/pixi\` + \`@rig-c/play@${report.playVersion}\` | Full bundle including \`pixi.js@${report.pixiVersion}\` | \`${report.bundles['rig-c-pixi'].includingPixiHost.rawBytes.toLocaleString('en-US')}\` | \`${report.bundles['rig-c-pixi'].includingPixiHost.gzipBytes.toLocaleString('en-US')}\` |`,
  );
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
  lines.push('| Skeleton | Instances | Arm | Frame `p50` (ms) | Pose `p50` (ms) | Draw/completion `p50` (ms) | Frame `p95` (ms) | Frame `mean` (ms) | Draw calls / frame | Triangles / frame | JS heap after warm-up (KiB) | Heap delta over empty stage (KiB) |');
  lines.push('| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const row of report.frameTable) {
    const heapKiB = (row.heapUsedBytes / 1024).toFixed(1);
    const deltaKiB = (row.heapDeltaBytes / 1024).toFixed(1);
    lines.push(
      `| \`${row.skeleton}\` | \`${row.instances}x\` | \`${row.arm}\` | \`${row.p50Ms.toFixed(3)}\` | \`${row.poseP50Ms.toFixed(3)}\` | \`${row.drawP50Ms.toFixed(3)}\` | \`${row.p95Ms.toFixed(3)}\` | \`${row.meanMs.toFixed(3)}\` | \`${row.drawCallsPerFrame}\` | \`${row.trianglesPerFrame}\` | \`${heapKiB}\` | \`+${deltaKiB}\` |`,
    );
  }
  lines.push('');

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
    lines.push('Command: `bun run bench -- --check-repro`');
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
  const protocolIndex = args.indexOf('--timing-protocol');
  const timingProtocol = parseTimingProtocol(protocolIndex === -1 ? undefined : (args[protocolIndex + 1] ?? ''));
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
    timingProtocol,
    skeletons,
    instanceCounts,
    runs,
    warmupFrames,
    measuredFrames,
    checkRepro,
  });

  let reproReport = null;
  if (checkRepro && report.secondFrameTable) {
    reproReport = evaluateReproducibility(report.frameTable, report.secondFrameTable);
    delete report.secondFrameTable;
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
