import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseTimingProtocol, parseTimingProtocolArgs, assertTimingProtocolRows, timingProtocolDescription } from './timing-protocol.ts';
import { evaluateReproducibility, formatResultsMarkdown } from '../scripts/bench.mjs';

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
