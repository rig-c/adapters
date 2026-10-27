import Phaser from 'phaser';
import type { DrawClip } from '@rig-c/adapters-shared';
import type { PosedClip } from '@rig-c/play';

function cross(a: number[], b: number[], c: number[]): number { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function hull(points: number[][]): number[][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (items: number[][]) => {
    const result: number[][] = [];
    for (const p of items) { while (result.length >= 2 && cross(result[result.length - 2], result[result.length - 1], p) <= 0) result.pop(); result.push(p); }
    return result;
  };
  return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
}

/** Validate before scene mutation; inverse clips follow the reader's hull rule. */
export function clipPoints(clip: PosedClip | DrawClip, detail: string, indexed = false): Phaser.Math.Vector2[] {
  const fail = (why: string): never => { throw new Error(`${detail} has invalid clip: ${why} (expected a finite simple nondegenerate polygon and boolean inverse/convex)`); };
  const validPolygon = indexed
    ? Boolean(clip && clip.polygon && typeof clip.polygon === 'object' && Number.isInteger(clip.polygon.length))
    : Boolean(clip && Array.isArray(clip.polygon));
  if (!clip || typeof clip.inverse !== 'boolean' || typeof clip.convex !== 'boolean' || !validPolygon || clip.polygon.length < 6 || clip.polygon.length % 2 !== 0) fail('invalid shape or fewer than 3 vertices');
  const points: number[][] = [];
  for (let i = 0; i < clip.polygon.length; i += 2) {
    const p = [clip.polygon[i], clip.polygon[i + 1]];
    if (!p.every(Number.isFinite)) fail(`non-finite vertex ${i / 2}`);
    const previous = points.at(-1);
    if (!previous || previous[0] !== p[0] || previous[1] !== p[1]) points.push(p);
  }
  if (points.length > 1 && points[0][0] === points.at(-1)![0] && points[0][1] === points.at(-1)![1]) points.pop();
  if (points.length < 3) fail('fewer than 3 distinct vertices');
  for (let i = 0; i < points.length; i++) if (points.slice(0, i).some((p) => p[0] === points[i][0] && p[1] === points[i][1])) fail(`nonadjacent repeated vertex ${i}`);
  let area = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n]; area += a[0] * b[1] - a[1] * b[0];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = points[j], d = points[(j + 1) % n];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) fail(`self-crossing edges ${i}/${j}`);
    }
  }
  if (area === 0) fail('zero area');
  const selected = clip.inverse || clip.convex ? hull(points) : points;
  return selected.map(([x, y]) => new Phaser.Math.Vector2(x, -y));
}

export interface ClipPair { open: Phaser.GameObjects.Stencil; close: Phaser.GameObjects.StencilReference }
export function createClipPair(scene: Phaser.Scene, clip: PosedClip | DrawClip, points: Phaser.Math.Vector2[]): ClipPair {
  const graphics = new Phaser.GameObjects.Graphics(scene);
  graphics.fillStyle(0xffffff, 1).fillPoints(points, true, true);
  const options = { stencilInvert: !clip.inverse, stencilLayerMode: 'addLayer' as const, stencilCompositeCheck: false, stencilAlphaStrategy: 'keep' as const };
  const open = new Phaser.GameObjects.Stencil(scene, 0, 0, [graphics], options);
  const close = new Phaser.GameObjects.StencilReference(scene, open, { ...options, stencilLayerMode: 'subtractLayer' });
  return { open, close };
}
