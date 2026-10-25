/** Wall-clock boundaries; neither protocol is a GPU-only timer. */
export const TIMING_PROTOCOLS = ['cpu-submit-v1', 'gpu-complete-v2'] as const;
export type TimingProtocol = typeof TIMING_PROTOCOLS[number];
export const DEFAULT_TIMING_PROTOCOL: TimingProtocol = 'gpu-complete-v2';

export function parseTimingProtocol(value: unknown = DEFAULT_TIMING_PROTOCOL): TimingProtocol {
  if (value === 'cpu-submit-v1' || value === 'gpu-complete-v2') return value;
  throw new Error(`BENCH_TIMING_PROTOCOL: found "${String(value)}"; expected ${TIMING_PROTOCOLS.join(' or ')}`);
}

/** Accept both conventional CLI spellings; never silently ignore a selector. */
export function parseTimingProtocolArgs(args: readonly string[]): TimingProtocol {
  const selectors = args.flatMap((value, index) =>
    value === '--timing-protocol' || value.startsWith('--timing-protocol=') ? [index] : []);
  if (selectors.length === 0) return DEFAULT_TIMING_PROTOCOL;
  if (selectors.length > 1) throw new Error('BENCH_TIMING_PROTOCOL: multiple selectors; expected one protocol');
  const index = selectors[0];
  const selector = args[index];
  const value = selector.startsWith('--timing-protocol=')
    ? selector.slice('--timing-protocol='.length)
    : (args[index + 1] ?? '');
  return parseTimingProtocol(value);
}

export function assertTimingProtocolRows(
  protocol: TimingProtocol,
  rows: ReadonlyArray<{ timingProtocol?: unknown }>,
): void {
  parseTimingProtocol(protocol);
  if (rows.length === 0) throw new Error('BENCH_TIMING_PROTOCOL: missing frame rows');
  for (const [index, row] of rows.entries()) {
    if (row.timingProtocol !== protocol) {
      throw new Error(`BENCH_TIMING_PROTOCOL: row ${index} found "${String(row.timingProtocol)}"; expected ${protocol}`);
    }
  }
}

export function timingProtocolDescription(protocol: TimingProtocol): string {
  return parseTimingProtocol(protocol) === 'gpu-complete-v2'
    ? 'CPU wall time: pose + draw + per-frame gl.finish; draw includes GPU completion wait. Warm-up is drained before sampling. Not GPU-only time or presentation latency.'
    : 'Legacy CPU pose + render/submission wall time, including driver back-pressure; gl.finish after the collected batches is outside samples. Not per-frame GPU completion.';
}
