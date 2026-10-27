/** Descriptive intervals over independent-launch paired medians, never pooled frames. */
// Two-sided 95%: t_(0.975, n-1). NIST table and distribution-CDF controls:
// https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm
export const T_CRITICAL_95 = Object.freeze({ 2: 12.706204736432095, 3: 4.302652729696142, 6: 2.570581835636305 });

export function launchMedianInterval(values) {
  if (!Array.isArray(values) || !Object.hasOwn(T_CRITICAL_95, values.length) || values.some(value => !Number.isFinite(value))) {
    throw Error('HARDWARE_STATISTIC_SAMPLES: need 2, 3 or 6 finite launch medians');
  }
  const n = values.length;
  const meanMs = values.reduce((sum, value) => sum + value, 0) / n;
  const sampleSdMs = Math.sqrt(values.reduce((sum, value) => sum + (value - meanMs) ** 2, 0) / (n - 1));
  const criticalT = T_CRITICAL_95[n];
  const halfWidthMs = criticalT * sampleSdMs / Math.sqrt(n);
  if (![meanMs, sampleSdMs, halfWidthMs].every(Number.isFinite)) throw Error('HARDWARE_STATISTIC_SAMPLES: interval arithmetic must be finite');
  return { n, meanMs, sampleSdMs, criticalT, lowerMs: meanMs - halfWidthMs, upperMs: meanMs + halfWidthMs };
}

export function judgeLaunchMedians(aa, ab) {
  if (!Array.isArray(aa) || !Array.isArray(ab) || aa.length !== ab.length) throw Error('HARDWARE_STATISTIC_SAMPLES: AA and AB need equal launch counts');
  const aaInterval = launchMedianInterval(aa), abInterval = launchMedianInterval(ab);
  const allAbNegative = ab.every(value => value < 0);
  const gain = abInterval.upperMs < 0 && abInterval.upperMs < aaInterval.lowerMs && allAbNegative;
  return { aaInterval, abInterval, allAbNegative, verdict: gain ? 'improvement under descriptive launch-median CIs' : 'unresolved by descriptive launch-median CIs' };
}
