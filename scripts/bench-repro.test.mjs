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
