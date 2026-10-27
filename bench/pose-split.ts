/** Instrumentation only: keep advance/snapshot adjacent for each instance. */
export interface PoseSplitTiming {
  advanceMs: number;
  snapshotMs: number;
}

export function splitPose<Frame>(
  rigs: readonly { player: { advance(dt: number): void; posedFrame(): Frame } }[],
  frames: Frame[],
  dt: number,
  now: () => number,
): PoseSplitTiming {
  let advanceMs = 0;
  let snapshotMs = 0;
  for (let i = 0; i < rigs.length; i++) {
    const r = rigs[i];
    const t0 = now();
    r.player.advance(dt);
    const t1 = now();
    frames[i] = r.player.posedFrame();
    const t2 = now();
    advanceMs += t1 - t0;
    snapshotMs += t2 - t1;
  }
  return { advanceMs, snapshotMs };
}

/** Same timer count and loop shape, with no player calls; never subtract it. */
export function splitClockControl(instances: number, now: () => number): PoseSplitTiming {
  let advanceMs = 0;
  let snapshotMs = 0;
  for (let i = 0; i < instances; i++) {
    const t0 = now();
    const t1 = now();
    const t2 = now();
    advanceMs += t1 - t0;
    snapshotMs += t2 - t1;
  }
  return { advanceMs, snapshotMs };
}

export function snapshotShare(snapshotMs: number, poseMs: number): number {
  if (!Number.isFinite(snapshotMs) || snapshotMs < 0 || !Number.isFinite(poseMs) || poseMs <= 0 || snapshotMs > poseMs) {
    throw new Error(`BENCH_POSE_SPLIT: snapshot=${snapshotMs}, pose=${poseMs}; expected 0 <= snapshot <= pose and pose > 0`);
  }
  return snapshotMs / poseMs;
}

export function premiseVerdict(snapshotMs: number, poseMs: number): 'eligible' | 'premise-refuted' {
  return snapshotShare(snapshotMs, poseMs) < 0.1 ? 'premise-refuted' : 'eligible';
}
