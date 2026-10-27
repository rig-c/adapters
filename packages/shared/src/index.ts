export function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export {
  type DrawClip,
  type DrawMesh,
  type DrawNumbers,
  type DrawRegion,
  type DrawSlot,
  LiveDrawViews,
  NumberSpan,
  numberCount,
  numberOffset,
  numberSource,
  RetainedRuntimeFrame,
} from './live.ts';


