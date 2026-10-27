import { expect, test } from 'bun:test';
import { T_CRITICAL_95, launchMedianInterval, judgeLaunchMedians } from './hardware-statistics.mjs';

// Independent analytical Student-t CDFs for df=1,2,5. The 1e-10 tolerance
// bounds numerical quantile approximation, not a performance-decision floor.
for (const n of [2, 3, 6]) test(`fixed t critical for n=${n} integrates to 0.975`, () => {
  const t = T_CRITICAL_95[n], theta = Math.atan(t / Math.sqrt(5));
  const cdf = n === 2 ? .5 + Math.atan(t) / Math.PI : n === 3 ? .5 + t / (2 * Math.sqrt(t * t + 2)) :
    .5 + theta / Math.PI + 2 * Math.sin(2 * theta) / (3 * Math.PI) + Math.sin(4 * theta) / (12 * Math.PI);
  expect(Math.abs(cdf - .975)).toBeLessThan(1e-10);
});

test('sampleSD uses n-1 and launch count, not the frame population', () => {
  const r = launchMedianInterval([1, 2, 3]);
  expect(r.meanMs).toBe(2); expect(r.sampleSdMs).toBe(1);
  expect(r.upperMs - r.meanMs).toBeCloseTo(4.302652729696142 / Math.sqrt(3), 12);
  expect(r.n).toBe(3);
});

for (const n of [3, 6]) test(`zero variance gain and strict equality controls at n=${n}`, () => {
  const values = value => Array(n).fill(value);
  const gain = judgeLaunchMedians(values(0), values(-1));
  expect(gain.aaInterval.lowerMs).toBe(0); expect(gain.abInterval.upperMs).toBe(-1);
  expect(gain.verdict).toStartWith('improvement');
  expect(judgeLaunchMedians(values(0), values(0)).verdict).toStartWith('unresolved');
  expect(judgeLaunchMedians(values(-1), values(-1)).verdict).toStartWith('unresolved');
  expect(judgeLaunchMedians(values(-1), values(-.5)).verdict).toStartWith('unresolved');
});

test('negative AB medians with CI crossing zero or AA remain unresolved', () => {
  const zeroCrossing = judgeLaunchMedians([0, 0, 0], [-1, -2, -3]);
  expect(zeroCrossing.allAbNegative).toBe(true); expect(zeroCrossing.abInterval.upperMs).toBeGreaterThan(0);
  expect(zeroCrossing.verdict).toStartWith('unresolved');
  const overlap = judgeLaunchMedians([-2, -2, -2], [-1, -1, -1]);
  expect(overlap.abInterval.upperMs).toBeLessThan(0);
  expect(overlap.abInterval.upperMs).toBeGreaterThan(overlap.aaInterval.lowerMs);
  expect(overlap.verdict).toStartWith('unresolved');
});

test('one positive launch blocks gain even when both CI bounds alone pass', () => {
  const r = judgeLaunchMedians(Array(6).fill(0), [-10, -10, -10, -10, -10, .01]);
  expect(r.abInterval.upperMs).toBeLessThan(0);
  expect(r.abInterval.upperMs).toBeLessThan(r.aaInterval.lowerMs);
  expect(r.allAbNegative).toBe(false); expect(r.verdict).toStartWith('unresolved');
});

test('more variable added launches can widen a CI', () => {
  const first = launchMedianInterval([1, 1, 1]), full = launchMedianInterval([1, 1, 1, -10, 10, 1]);
  expect(full.upperMs - full.lowerMs).toBeGreaterThan(first.upperMs - first.lowerMs);
});

test('missing, unsupported or nonfinite launch samples refuse by name', () => {
  for (const values of [[], [1], [1, 2, 3, 4], [1, 2, NaN], [1, 2, Infinity]]) expect(() => launchMedianInterval(values)).toThrow('HARDWARE_STATISTIC_SAMPLES');
  expect(() => judgeLaunchMedians([1, 2, 3], [1, 2])).toThrow('HARDWARE_STATISTIC_SAMPLES');
});
