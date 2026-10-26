import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseTimingProtocol, parseTimingProtocolArgs, assertTimingProtocolRows, timingProtocolDescription } from './timing-protocol.ts';
import {
  BENCH_CHROMIUM_ARGS,
  computePairedFrameTable,
  evaluateBar1DrawCalls,
  evaluatePairedReproducibility,
  evaluateReproducibility,
  formatResultsMarkdown,
  parseCompareBundleArgs,
  prepareCompareBundle,
} from '../scripts/bench.mjs';

function assertBoundary(events, frames, complete) {
  const clocks = events.flatMap((event, index) => event === 'now' ? [index] : []);
  if (clocks.length !== frames * 3) {
    throw new Error(`BENCH_TIMING_BOUNDARY: expected ${frames * 3} timestamps, found ${clocks.length}: ${events}`);
  }
  for (let frame = 0; frame < frames; frame++) {
    const [start, split, end] = clocks.slice(frame * 3, frame * 3 + 3);
    const pose = events.slice(start + 1, split);
    const draw = events.slice(split + 1, end);
    const finishes = draw.filter((event) => event === 'finish').length;
    if (pose.includes('finish') || !draw.includes('draw') || finishes !== Number(complete) ||
        (complete && draw.at(-1) !== 'finish')) {
      throw new Error(`BENCH_TIMING_BOUNDARY: frame ${frame} pose=${pose} draw=${draw}; expected finish=${Number(complete)} after draw and before timestamp`);
    }
  }
}

async function trace(page, arm, protocol, repro, mutant = 'none') {
  if (mutant !== 'none') {
    await page.route('**/bench/main.ts', async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      const boundary = /if \(timingProtocol === ["']gpu-complete-v2["']\) gl\.finish\(\);/g;
      expect(body.match(boundary)?.length).toBe(3);
      body = body.replace(boundary, '/* completion boundary removed */');
      if (mutant === 'batch-only') {
        body = body.replace('return summarizeFrameBatch(prepared, times,', 'gl.finish(); return summarizeFrameBatch(prepared, times,');
      }
      await route.fulfill({ response, body });
    });
  }
  await page.addInitScript(() => {
    window.__timingEvents = [];
    window.__captureTiming = false;
    const now = performance.now.bind(performance);
    Object.defineProperty(performance, 'now', { configurable: true, value() {
      const caller = new Error().stack?.split('\n')[2] ?? '';
      if (window.__captureTiming && /\b(runPreparedFrames|collectPreparedRuns)\b/.test(caller)) {
        window.__timingEvents.push('now');
      }
      return now();
    } });
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      for (const name of ['finish', 'drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
        if (typeof proto[name] !== 'function') continue;
        const original = proto[name];
        proto[name] = function (...args) {
          const result = original.apply(this, args);
          if (window.__captureTiming) window.__timingEvents.push(name === 'finish' ? 'finish' : 'draw');
          return result;
        };
      }
    }
  });
  await page.goto('/bench/index.html');
  await page.waitForFunction(() => Boolean(window.__rigBench));
  return page.evaluate(async ({ arm, protocol, repro }) => {
    const bench = window.__rigBench;
    await bench.prepareBenchmarkStage('spineboy', arm, 1, 2);
    window.__captureTiming = true;
    try {
      const rows = repro
        ? await bench.collectPreparedRuns(1, 3, true, protocol)
        : await bench.collectPreparedRuns(1, 3, false, protocol);
      return { events: window.__timingEvents, rows };
    } finally {
      window.__captureTiming = false;
      await bench.disposePreparedStage();
    }
  }, { arm, protocol, repro });
}

for (const arm of ['spine-pixi-v8', 'rig-c-pixi']) {
  for (const repro of [false, true]) {
    for (const protocol of ['gpu-complete-v2', 'cpu-submit-v1']) {
      test(`${arm} repro=${repro} ${protocol} actual GL boundary`, async ({ page }) => {
        const { events, rows } = await trace(page, arm, protocol, repro);
        assertBoundary(events, repro ? 6 : 3, protocol === 'gpu-complete-v2');
        assertTimingProtocolRows(protocol, [...rows.set1, ...rows.set2]);
        // v2 drains warm-up work before the first timestamp, outside samples.
        if (protocol === 'gpu-complete-v2') expect(events.indexOf('finish')).toBeLessThan(events.indexOf('now'));
      });
    }
    for (const mutant of ['missing', 'batch-only']) {
      test(`${arm} repro=${repro} catches ${mutant} completion mutant`, async ({ page }) => {
        const { events } = await trace(page, arm, 'gpu-complete-v2', repro, mutant);
        expect(() => assertBoundary(events, repro ? 6 : 3, true)).toThrow(/BENCH_TIMING_BOUNDARY: frame/);
      });
    }
  }
}

test('protocol provenance, named CLI refusal and mixed-series mutants', () => {
  expect(parseTimingProtocol()).toBe('gpu-complete-v2');
  for (const value of ['cpu-submit-v1', 'gpu-complete-v2']) expect(parseTimingProtocol(value)).toBe(value);
  for (const value of ['', 'gpu', null]) expect(() => parseTimingProtocol(value)).toThrow(/BENCH_TIMING_PROTOCOL/);
  expect(parseTimingProtocolArgs([])).toBe('gpu-complete-v2');
  for (const value of ['cpu-submit-v1', 'gpu-complete-v2']) {
    expect(parseTimingProtocolArgs(['--timing-protocol', value])).toBe(value);
    expect(parseTimingProtocolArgs([`--timing-protocol=${value}`])).toBe(value);
  }
  for (const args of [['--timing-protocol'], ['--timing-protocol', 'unknown'], ['--timing-protocol='], ['--timing-protocol=unknown'], ['--timing-protocol=cpu-submit-v1', '--timing-protocol', 'gpu-complete-v2']]) {
    const result = spawnSync('bun', ['scripts/bench.mjs', ...args], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('BENCH_TIMING_PROTOCOL');
    expect(result.stdout).toBe('');
  }
  expect(() => assertTimingProtocolRows('gpu-complete-v2', [])).toThrow(/missing frame rows/);
  expect(() => assertTimingProtocolRows('gpu-complete-v2', [{ timingProtocol: 'cpu-submit-v1' }])).toThrow(/row 0/);
  expect(() => assertTimingProtocolRows('gpu-complete-v2', [{}])).toThrow(/row 0/);
  expect(timingProtocolDescription('gpu-complete-v2')).toContain('per-frame gl.finish');
  expect(timingProtocolDescription('cpu-submit-v1')).toContain('outside samples');
  const row = { skeleton: 'spineboy', arm: 'rig-c-pixi', instances: 1, timingProtocol: 'gpu-complete-v2', p50Ms: 1 };
  expect(() => evaluateReproducibility([row], [{ ...row, timingProtocol: 'cpu-submit-v1' }])).toThrow(/BENCH_TIMING_PROTOCOL/);
  const mixed = [row, { ...row, instances: 10, timingProtocol: 'cpu-submit-v1' }];
  expect(() => evaluateReproducibility(mixed, mixed)).toThrow(/BENCH_TIMING_PROTOCOL/);
});

test('Markdown labels completion and never mixes v2 with historical v1 timing tables', () => {
  const numeric = { rawBytes: 1, gzipBytes: 1 };
  const row = { timingProtocol: 'gpu-complete-v2', skeleton: 'spineboy', arm: 'rig-c-pixi', instances: 1,
    runs: 7, warmupFrames: 60, measuredFrames: 76, durationSeconds: 1.27, p50Ms: 1, p95Ms: 2,
    meanMs: 1, poseP50Ms: 0.5, drawP50Ms: 0.5, drawCallsPerFrame: 1, trianglesPerFrame: 1,
    heapUsedBytes: 1, heapDeltaBytes: 1 };
  const report = { timingProtocol: 'gpu-complete-v2', frameTable: [row], correctness: {}, assets: {},
    machine: {}, bundles: { 'spine-pixi-v8': { adapterAndRuntime: numeric, includingPixiHost: numeric },
      'rig-c-pixi': { adapterAndRuntime: numeric, includingPixiHost: numeric } }, loadToFirstFrame: [],
    hygiene: { diskRefusalMutant: {}, browserRefusalMutant: {} } };
  expect(() => formatResultsMarkdown({ ...report, timingProtocol: undefined })).toThrow(/BENCH_TIMING_PROTOCOL/);
  const markdown = formatResultsMarkdown(report);
  expect(markdown).toContain('gpu-complete-v2');
  expect(markdown).toContain('per-frame gl.finish');
  expect(markdown).toContain('Draw/completion');
  expect(markdown).toContain('Historical timing comparisons omitted');
  expect(markdown).not.toContain('Before vs Pin-Bump Control vs After');
  expect(markdown).not.toContain('within `2x`');
  expect(() => formatResultsMarkdown({ ...report, frameTable: [{ ...row, timingProtocol: 'cpu-submit-v1' }] })).toThrow(/BENCH_TIMING_PROTOCOL/);
  const legacy = formatResultsMarkdown({ ...report, timingProtocol: 'cpu-submit-v1', frameTable: [{ ...row, timingProtocol: 'cpu-submit-v1' }] });
  expect(legacy).not.toContain('Before vs Pin-Bump Control vs After');
  expect(legacy).toContain('outside samples');
  const repro = formatResultsMarkdown({ ...report, timingProtocol: 'cpu-submit-v1', frameTable: [{ ...row, timingProtocol: 'cpu-submit-v1' }] }, { comparisons: [], maxRelDelta: 0 });
  expect(repro).toContain('Command: `bun run bench -- --timing-protocol cpu-submit-v1 --check-repro`');
  expect(readFileSync('bench/RESULTS.md', 'utf8')).toContain('Historical timing protocol: **cpu-submit-v1**');
});

test('Chromium background-throttling flags and machine provenance (#53)', () => {
  expect(BENCH_CHROMIUM_ARGS).toEqual([
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--js-flags=--expose-gc',
    '--enable-precise-memory-info',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
  ]);
  const numeric = { rawBytes: 1, gzipBytes: 1 };
  const rowA = {
    timingProtocol: 'gpu-complete-v2',
    interleaving: 'ABAB',
    skeleton: 'spineboy',
    arm: 'spine-pixi-v8',
    instances: 1,
    runs: 3,
    warmupFrames: 60,
    measuredFrames: 76,
    durationSeconds: 1.27,
    p50Ms: 1.0,
    p95Ms: 1.2,
    meanMs: 1.0,
    poseP50Ms: 0.4,
    drawP50Ms: 0.6,
    runP50sMs: [0.95, 1.0, 1.05],
    drawCallsPerFrame: 1,
    trianglesPerFrame: 10,
    heapUsedBytes: 1024,
    heapDeltaBytes: 512,
  };
  const rowB = {
    ...rowA,
    arm: 'rig-c-pixi',
    p50Ms: 1.5,
    runP50sMs: [1.45, 1.5, 1.55],
  };
  const pairedFrameTable = computePairedFrameTable([rowA, rowB]);
  const report = {
    timingProtocol: 'gpu-complete-v2',
    interleaving: 'ABAB',
    arms: ['spine-pixi-v8', 'rig-c-pixi'],
    frameTable: [rowA, rowB],
    pairedFrameTable,
    correctness: {},
    assets: {},
    machine: {
      platform: 'darwin',
      cpuModel: 'Apple M4',
      cpuCores: 10,
      totalMemoryGiB: 16,
      gpuRenderer: 'ANGLE Metal',
      webglVersion: 'WebGL 2.0',
      chromiumArgs: [...BENCH_CHROMIUM_ARGS],
    },
    bundles: {
      'spine-pixi-v8': { adapterAndRuntime: numeric, includingPixiHost: numeric },
      'rig-c-pixi': { adapterAndRuntime: numeric, includingPixiHost: numeric },
    },
    loadToFirstFrame: [],
    hygiene: { diskRefusalMutant: {}, browserRefusalMutant: {} },
  };
  const markdown = formatResultsMarkdown(report);
  expect(markdown).toContain('--disable-renderer-backgrounding');
  expect(markdown).toContain('--disable-background-timer-throttling');
  expect(markdown).toContain('--disable-backgrounding-occluded-windows');
  expect(markdown).toContain('## Paired AB Differences (`ABAB` Interleaved Runs)');
  expect(markdown).toContain('`[0.950, 1.000, 1.050]`');
  expect(markdown).toContain('`[1.450, 1.500, 1.550]`');
  expect(markdown).toContain('`[+0.500, +0.500, +0.500]`');
});

test('ABAB paired differences and common-mode cancellation (#53)', () => {
  const rowA1 = {
    timingProtocol: 'gpu-complete-v2',
    skeleton: 'raptor',
    arm: 'spine-pixi-v8',
    instances: 100,
    p50Ms: 2.0,
    runP50sMs: [2.0, 2.0, 2.5],
  };
  const rowB1 = {
    timingProtocol: 'gpu-complete-v2',
    skeleton: 'raptor',
    arm: 'rig-c-pixi',
    instances: 100,
    p50Ms: 12.0,
    runP50sMs: [12.0, 12.0, 15.0],
  };
  const paired1 = computePairedFrameTable([rowA1, rowB1]);
  expect(paired1).toHaveLength(1);
  expect(paired1[0].pairDiffsMs).toEqual([10.0, 10.0, 12.5]);
  expect(paired1[0].pairRelDiffs).toEqual([5.0, 5.0, 5.0]);
  expect(paired1[0].pairRatios).toEqual([6.0, 6.0, 6.0]);
  expect(paired1[0].p50DiffMs).toBe(10.0);
  expect(paired1[0].p50RelDiff).toBe(5.0);
  expect(paired1[0].p50Ratio).toBe(6.0);

  // Invocation 2 with a +20% common-mode clock step on both arms cancels in ratio/relDiff
  const rowA2 = {
    ...rowA1,
    p50Ms: 2.4,
    runP50sMs: [2.4, 2.4, 2.4],
  };
  const rowB2 = {
    ...rowB1,
    p50Ms: 14.4,
    runP50sMs: [14.4, 14.4, 14.4],
  };
  const paired2 = computePairedFrameTable([rowA2, rowB2]);
  const pairedRepro = evaluatePairedReproducibility(paired1, paired2);
  expect(pairedRepro.maxAbsRelDiffSpread).toBe(0);
  expect(pairedRepro.maxRatioRelSpread).toBe(0);
  expect(pairedRepro.ratioPass).toBe(true);
  expect(pairedRepro.comparisons[0].relDiffSpread).toBe(0.2);
  expect(pairedRepro.pass).toBe(false);

  // Planted failure mutants for computePairedFrameTable & evaluatePairedReproducibility
  expect(() => computePairedFrameTable([rowA1])).toThrow(/BENCH_PAIRED_MISMATCH: missing armB/);
  expect(() =>
    computePairedFrameTable([rowA1, { ...rowB1, runP50sMs: [12.0, 12.0] }]),
  ).toThrow(/BENCH_PAIRED_MISMATCH: raptor 100x run count mismatch/);
  expect(() =>
    computePairedFrameTable([rowA1], ['only-one-arm']),
  ).toThrow(/BENCH_PAIRED_MISMATCH: expected 2 arms/);
  expect(() =>
    evaluatePairedReproducibility(paired1, [{ ...paired1[0], skeleton: 'spineboy' }]),
  ).toThrow(/BENCH_REPRO_MISSING_ROW/);
});

test('browser ABAB interleaving alternates arms in execution order and enforces stage prep (#53)', async ({ page }) => {
  await page.goto('/bench/index.html');
  await page.waitForFunction(() => Boolean(window.__rigBench));
  const result = await page.evaluate(async () => {
    const bench = window.__rigBench;
    let unpreparedError = '';
    try {
      await bench.runInterleavedArmBatch('rig-c-pixi', 2, false, 'gpu-complete-v2');
    } catch (err) {
      unpreparedError = err instanceof Error ? err.message : String(err);
    }

    const arms = ['spine-pixi-v8', 'rig-c-pixi'];
    for (const arm of arms) {
      await bench.prepareBenchmarkStage('spineboy', arm, 1, 2, '/bench', { keepPrepared: true });
    }
    const order = [];
    for (let r = 0; r < 2; r++) {
      for (const arm of arms) {
        const { set1 } = await bench.runInterleavedArmBatch(arm, 3, false, 'gpu-complete-v2', 1);
        order.push({ r, arm: set1[0].arm, frames: set1[0].measuredFrames, p50Ms: set1[0].p50Ms });
      }
    }
    await bench.disposePreparedStage();
    return { unpreparedError, order };
  });

  expect(result.unpreparedError).toContain('BENCH_STAGE_NOT_PREPARED: arm "rig-c-pixi" is not prepared');
  expect(result.order.map((e) => e.arm)).toEqual([
    'spine-pixi-v8',
    'rig-c-pixi',
    'spine-pixi-v8',
    'rig-c-pixi',
  ]);
  for (const item of result.order) {
    expect(item.frames).toBe(3);
    expect(item.p50Ms).toBeGreaterThan(0);
  }
});

test('--compare-bundle CLI parsing, bundle preparation, refusals, and browser ABAB execution (#53)', async ({ page }) => {
  expect(parseCompareBundleArgs([])).toBeNull();
  expect(parseCompareBundleArgs(['--compare-bundle', 'packages/pixi/src/index.ts'])).toBe(
    'packages/pixi/src/index.ts',
  );
  expect(parseCompareBundleArgs(['--compare-bundle=node_modules/@rig-c/play'])).toBe(
    'node_modules/@rig-c/play',
  );

  for (const badArgs of [
    ['--compare-bundle'],
    ['--compare-bundle', '--smoke'],
    ['--compare-bundle='],
    ['--compare-bundle=a', '--compare-bundle=b'],
    ['--compare-bundle', 'non-existent-bundle-path.js'],
  ]) {
    const cli = spawnSync('bun', ['scripts/bench.mjs', ...badArgs], { encoding: 'utf8' });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('BENCH_COMPARE_BUNDLE');
  }

  const badDir = resolve('node_modules/.cache/bench-bad-compare');
  rmSync(badDir, { recursive: true, force: true });
  mkdirSync(badDir, { recursive: true });
  const badModulePath = resolve(badDir, 'invalid.js');
  writeFileSync(badModulePath, 'export const notARig = 42;\n');
  try {
    await expect(prepareCompareBundle(badDir)).rejects.toThrow(/BENCH_COMPARE_BUNDLE: no entry module/);
    await expect(prepareCompareBundle(badModulePath)).rejects.toThrow(
      /BENCH_COMPARE_BUNDLE: .* must export \{ loadModel, PixiRig \}/,
    );
  } finally {
    rmSync(badDir, { recursive: true, force: true });
  }

  // Prepare from @rig-c/play directory (mode === 'rig-play')
  const playCompare = await prepareCompareBundle('node_modules/@rig-c/play');
  expect(playCompare.mode).toBe('rig-play');
  expect(playCompare.adapterAndRuntime.rawBytes).toBeGreaterThan(1000);
  expect(playCompare.includingPixiHost.rawBytes).toBeGreaterThan(playCompare.adapterAndRuntime.rawBytes);
  expect(playCompare.sha256).toMatch(/^[0-9a-f]{64}$/);

  await page.goto('/bench/index.html');
  await page.waitForFunction(() => Boolean(window.__rigBench));

  const browserRes = await page.evaluate(async ({ code, label }) => {
    const bench = window.__rigBench;
    let invalidBundleError = '';
    try {
      await bench.registerCompareBundle({ moduleCode: 'export const x = 1;', label: 'bad-inline' });
    } catch (err) {
      invalidBundleError = err instanceof Error ? err.message : String(err);
    }

    await bench.registerCompareBundle({ moduleCode: code, label });
    const correctness = await bench.checkCorrectness('spineboy', {
      times: [0, 0.35],
      mutant: 'none',
      arm: 'rig-c-pixi-compare',
    });

    const arms = ['rig-c-pixi', 'rig-c-pixi-compare'];
    for (const arm of arms) {
      await bench.prepareBenchmarkStage('spineboy', arm, 1, 2, '/bench', { keepPrepared: true });
    }
    const batches = [];
    for (let r = 0; r < 2; r++) {
      for (const arm of arms) {
        const { set1 } = await bench.runInterleavedArmBatch(arm, 3, false, 'gpu-complete-v2', 1);
        batches.push(set1[0]);
      }
    }
    await bench.disposePreparedStage();
    return { invalidBundleError, correctnessPass: correctness.pass, batches };
  }, { code: playCompare.browserCode, label: playCompare.sourcePath });

  expect(browserRes.invalidBundleError).toContain('BENCH_COMPARE_BUNDLE: "bad-inline" must export functions { loadModel, PixiRig }');
  expect(browserRes.correctnessPass).toBe(true);
  expect(browserRes.batches.map((b) => b.arm)).toEqual([
    'rig-c-pixi',
    'rig-c-pixi-compare',
    'rig-c-pixi',
    'rig-c-pixi-compare',
  ]);
  const bar1 = evaluateBar1DrawCalls(browserRes.batches, ['spineboy']);
  expect(bar1.pass).toBe(true);
});
