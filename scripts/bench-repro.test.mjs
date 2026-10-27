import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { evaluateReproducibility } from './bench.mjs';
import { parseTimingProtocol, assertTimingProtocolRows } from '../bench/timing-protocol.ts';

const row = (p50Ms) => ({
  skeleton: 'spineboy', arm: 'rig-c-pixi', instances: 1,
  timingProtocol: 'gpu-complete-v2', p50Ms,
});

function assertSmallDrift(evaluate) {
  const result = evaluate([row(0.5)], [row(0.625)]);
  expect(result.comparisons[0].relDelta).toBe(0.25);
  expect(result.pass).toBe(false);
}

test('rejects pure 25% drift below one millisecond', () => {
  assertSmallDrift(evaluateReproducibility);
});

test('accepts identical and within-limit rows without changing their scale', () => {
  expect(evaluateReproducibility([row(0.5)], [row(0.5)]).pass).toBe(true);
  const result = evaluateReproducibility([row(0.5)], [row(0.515)]);
  expect(result.comparisons[0].relDelta).toBeCloseTo(0.03, 12);
  expect(result.pass).toBe(true);
});

test('compares unrounded relative drift at the limit', () => {
  expect(evaluateReproducibility([row(20)], [row(21)]).pass).toBe(true);
  expect(evaluateReproducibility([row(20)], [row(21.000001)]).pass).toBe(false);
});

test('refuses undefined relative deltas by workload name', () => {
  for (const [first, second] of [[0, 1], [-1, 1], [NaN, 1], [Infinity, 1], [1, -1], [1, NaN], [1, Infinity]]) {
    expect(() => evaluateReproducibility([row(first)], [row(second)]))
      .toThrow(/BENCH_REPRO_INVALID_P50: spineboy rig-c-pixi 1x/);
  }
  expect(evaluateReproducibility([row(1)], [row(0)]).pass).toBe(false);
});

test('kills a restored denominator-floor mutant in memory', () => {
  const source = readFileSync(new URL('./bench.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('export function evaluateReproducibility(');
  const end = source.indexOf('\n}\n', start) + 2;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const helper = source.slice(start, end).replace('export function', 'function');
  const original = 'const relDelta = absDeltaMs / r1.p50Ms;';
  expect(helper.split(original)).toHaveLength(2);
  const mutated = helper.replace(original, 'const relDelta = absDeltaMs / Math.max(r1.p50Ms, 3.0);');
  const evaluateMutant = new Function('parseTimingProtocol', 'assertTimingProtocolRows', `return (${mutated});`)(parseTimingProtocol, assertTimingProtocolRows);
  expect(evaluateMutant([row(0.5)], [row(0.625)]).pass).toBe(true);
  expect(() => assertSmallDrift(evaluateMutant)).toThrow();
});

// Execute the real orchestration with deterministic host/timer doubles, without a GPU.
function preparedCollector() {
  const source = readFileSync(new URL('../bench/main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('export async function collectPreparedRuns(');
  const end = source.indexOf('\nexport async function runInterleavedArmBatch(', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  return new Function('activePreparedStage', 'getRenderer', 'parseTimingProtocol',
    'DEFAULT_TIMING_PROTOCOL', 'window', 'runPreparedFrames', 'summarizeFrameBatch',
    `${compiled.replace('export ', '')}; return collectPreparedRuns;`);
}

for (const options of [{}, { skipPreWarmup: true, settleFrames: 4 }]) {
  test(`repro collects complete sequential passes with equal warmup ${JSON.stringify(options)}`, async () => {
    const events = [];
    let poses = 0;
    const prepared = { poseAll: () => { poses++; }, drawAll: () => {} };
    const counters = { reset() {}, drawCalls: 0, triangles: 0 };
    const collect = preparedCollector()(prepared,
      async () => ({ renderer: { gl: { finish() {} } }, counters }),
      parseTimingProtocol, 'gpu-complete-v2', { gc: () => events.push('gc') },
      async (frames, protocol) => {
        events.push(`batch:${poses}:${frames}:${protocol}`);
        return { batch: events.length };
      }, () => { throw new Error('interleaved frame summarization'); });
    const result = await collect(2, 3, true, 'gpu-complete-v2', options);
    const warmup = options.skipPreWarmup ? 4 : 45;
    const expected = [];
    for (const pass of [1, 2]) {
      if (!options.skipPreWarmup) expected.push('gc', 'gc');
      expected.push(`batch:${warmup * pass}:3:gpu-complete-v2`,
        `batch:${warmup * pass}:3:gpu-complete-v2`);
    }
    expect(events).toEqual(expected);
    expect(result.set1).toHaveLength(2);
    expect(result.set2).toHaveLength(2);
    expect(result.set1[1].batch).toBeLessThan(result.set2[0].batch);
  });
}
