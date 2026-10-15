import type { PosedClip } from '@rig-c/play';

type Point = [number, number];
const cross = (a: Point, b: Point, c: Point) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (items: Point[]) => {
    const result: Point[] = [];
    for (const p of items) { while (result.length >= 2 && cross(result[result.length - 2], result[result.length - 1], p) <= 0) result.pop(); result.push(p); }
    return result;
  };
  return [...half(sorted).slice(0, -1), ...half([...sorted].reverse()).slice(0, -1)];
}

/** The canvas reader keeps concavities, except convex=true and inverse use the hull. */
export function clipPolygon(clip: PosedClip, detail: string, capacity: number): number[] {
  const fail = (why: string): never => { throw new Error(`${detail} has invalid clip: ${why} (expected finite simple nonzero-area polygon, boolean inverse/convex, at most GPU MAX_TEXTURE_SIZE=${capacity} vertices)`); };
  if (!clip || typeof clip.inverse !== 'boolean' || typeof clip.convex !== 'boolean' || !Array.isArray(clip.polygon) || clip.polygon.length < 6 || clip.polygon.length % 2 !== 0) fail('invalid flags or polygon length');
  if (clip.polygon.length / 2 > capacity) fail(`THREE_CLIP_CAPACITY: found ${clip.polygon.length / 2} vertices`);
  const points: Point[] = [];
  for (let i = 0; i < clip.polygon.length; i += 2) {
    const p: Point = [clip.polygon[i], clip.polygon[i + 1]];
    if (!p.every((v) => Number.isFinite(v) && Number.isFinite(Math.fround(v)))) fail(`vertex ${i / 2} contains ${p.join(',')}`);
    const previous = points.at(-1);
    if (!previous || previous[0] !== p[0] || previous[1] !== p[1]) points.push(p);
  }
  if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) points.pop();
  if (points.length < 3) fail('fewer than three distinct vertices');
  for (let i = 0; i < points.length; i++) if (points.slice(0, i).some((p) => p[0] === points[i][0] && p[1] === points[i][1])) fail(`nonadjacent repeated vertex ${i}`);
  const n = points.length;
  let area = 0;
  const on = (a: Point, b: Point, p: Point) => cross(a, b, p) === 0 && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n]; area += a[0] * b[1] - a[1] * b[0];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = points[j], d = points[(j + 1) % n];
      if ((cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) || on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) fail(`crossing edges ${i}/${j}`);
    }
  }
  if (area === 0) fail('zero area');
  return (clip.inverse || clip.convex ? hull(points) : points).flat();
}
