import type {
  BlendMode,
  ModelAssets,
  PosedClip,
  PosedFrame,
  PosedMesh,
  PosedRegion,
  PosedSlot,
} from '@rig-c/play';
import {
  type BLEND_MODES,
  ColorMatrixFilter,
  type Container,
  Graphics,
  ImageSource,
  Matrix,
  Mesh,
  MeshGeometry,
  Rectangle,
  Sprite,
  Texture,
} from 'pixi.js';

/**
 * Table mapping every `PosedSlot.blend` mode to its PixiJS v8 `blendMode`.
 */
export const BLEND_PIXI: Readonly<Record<BlendMode, BLEND_MODES>> = {
  Normal: 'normal',
  Additive: 'add',
  Multiply: 'multiply',
  Screen: 'screen',
};

/**
 * 20-element 4x5 row-major colour matrix consumed by PixiJS `ColorMatrixFilter`.
 */
export type PixiColorMatrix = [
  number, number, number, number, number,
  number, number, number, number, number,
  number, number, number, number, number,
  number, number, number, number, number,
];

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Maps a `PosedSlot.tint` tuple (`[r, g, b, a]` in `0..1`) to PixiJS
 * 24-bit RGB `tint` (`0xRRGGBB`) and `alpha` (`0..1`).
 */
export function tintToPixi(tint: readonly [number, number, number, number]): {
  color: number;
  alpha: number;
} {
  const r = Math.round(clamp01(tint[0]) * 255);
  const g = Math.round(clamp01(tint[1]) * 255);
  const b = Math.round(clamp01(tint[2]) * 255);
  const alpha = clamp01(tint[3]);
  return {
    color: (r << 16) | (g << 8) | b,
    alpha,
  };
}

/**
 * Builds the 4x5 colour matrix for a two-colour (`dark`) tint on a slot:
 * maps straight texel colour `c` to `c * light + (1 - c) * dark = (light - dark) * c + dark`,
 * and texel alpha `t.a` to `t.a * a` (`ColorMatrixFilter` un-premultiplies
 * before applying the matrix and re-premultiplies by `result.a` afterwards).
 */
export function darkTintColorMatrix(
  tint: readonly [number, number, number, number],
  dark: readonly [number, number, number],
): PixiColorMatrix {
  const r = clamp01(tint[0]);
  const g = clamp01(tint[1]);
  const b = clamp01(tint[2]);
  const a = clamp01(tint[3]);
  const dr = clamp01(dark[0]);
  const dg = clamp01(dark[1]);
  const db = clamp01(dark[2]);
  return [
    r - dr, 0, 0, 0, dr,
    0, g - dg, 0, 0, dg,
    0, 0, b - db, 0, db,
    0, 0, 0, a, 0,
  ];
}

function polygonSignedArea2(polygon: readonly number[]): number {
  let area2 = 0;
  const n = polygon.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area2 += polygon[2 * i] * polygon[2 * j + 1] - polygon[2 * j] * polygon[2 * i + 1];
  }
  return area2;
}

function cross2d(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function onSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): boolean {
  return (
    px >= Math.min(ax, bx) - 1e-9 &&
    px <= Math.max(ax, bx) + 1e-9 &&
    py >= Math.min(ay, by) - 1e-9 &&
    py <= Math.max(ay, by) + 1e-9
  );
}

function segmentsIntersect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = cross2d(cx, cy, dx, dy, ax, ay);
  const d2 = cross2d(cx, cy, dx, dy, bx, by);
  const d3 = cross2d(ax, ay, bx, by, cx, cy);
  const d4 = cross2d(ax, ay, bx, by, dx, dy);

  if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
      ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) {
    return true;
  }
  if (Math.abs(d1) <= 1e-9 && onSegment(cx, cy, dx, dy, ax, ay)) return true;
  if (Math.abs(d2) <= 1e-9 && onSegment(cx, cy, dx, dy, bx, by)) return true;
  if (Math.abs(d3) <= 1e-9 && onSegment(ax, ay, bx, by, cx, cy)) return true;
  if (Math.abs(d4) <= 1e-9 && onSegment(ax, ay, bx, by, dx, dy)) return true;
  return false;
}

function assertFiniteTuple(
  values: readonly number[],
  expectedLength: number,
  field: string,
  slot: string,
  page: string,
): void {
  if (!Array.isArray(values) || values.length !== expectedLength) {
    throw new Error(
      `PixiRenderer: slot "${slot}" on page "${page}" has invalid ${field} length ${Array.isArray(values) ? values.length : 'non-array'} (expected ${expectedLength})`,
    );
  }
  for (let i = 0; i < expectedLength; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(
        `PixiRenderer: slot "${slot}" on page "${page}" has non-finite ${field}[${i}]=${String(values[i])} (expected finite number)`,
      );
    }
  }
}

function assertFiniteEvenArray(
  values: readonly number[],
  minLength: number,
  field: string,
  slot: string,
  page: string,
): void {
  if (!Array.isArray(values) || values.length < minLength || values.length % 2 !== 0) {
    throw new Error(
      `PixiRenderer: slot "${slot}" on page "${page}" has invalid ${field} length ${Array.isArray(values) ? values.length : 'non-array'} (expected even length >= ${minLength})`,
    );
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(
        `PixiRenderer: slot "${slot}" on page "${page}" has non-finite ${field}[${i}]=${String(values[i])} (expected finite number)`,
      );
    }
  }
}

interface ValidatedClip {
  screenPolygon: number[];
  inverse: boolean;
}

function validateClip(clip: PosedClip, slot: string, page: string): ValidatedClip {
  if (!clip || typeof clip !== 'object') {
    throw new Error(
      `PixiRenderer: slot "${slot}" on page "${page}" has invalid clip value (expected PosedClip object)`,
    );
  }
  if (typeof clip.inverse !== 'boolean' || typeof clip.convex !== 'boolean') {
    throw new Error(
      `PixiRenderer: slot "${slot}" on page "${page}" has invalid clip flags inverse=${String(clip.inverse)}, convex=${String(clip.convex)} (expected booleans)`,
    );
  }
  if (!Array.isArray(clip.polygon) || clip.polygon.length < 6 || clip.polygon.length % 2 !== 0) {
    throw new Error(
      `PixiRenderer: slot "${slot}" on page "${page}" carries an unbuildable clip polygon with fewer than 3 vertices: length=${Array.isArray(clip.polygon) ? clip.polygon.length : 'non-array'} (expected even length >= 6)`,
    );
  }
  const poly = clip.polygon;
  for (let i = 0; i < poly.length; i++) {
    if (!Number.isFinite(poly[i])) {
      throw new Error(
        `PixiRenderer: slot "${slot}" on page "${page}" has non-finite clip.polygon[${i}]=${String(poly[i])} (expected finite number)`,
      );
    }
  }

  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const xi = poly[2 * i];
    const yi = poly[2 * i + 1];
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(xi - poly[2 * j]) <= 1e-9 && Math.abs(yi - poly[2 * j + 1]) <= 1e-9) {
        throw new Error(
          `PixiRenderer: slot "${slot}" on page "${page}" carries an unbuildable clip polygon with repeated vertex at indices ${i} and ${j} (expected distinct polygon vertices)`,
        );
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    const ax = poly[2 * i];
    const ay = poly[2 * i + 1];
    const bx = poly[2 * iNext];
    const by = poly[2 * iNext + 1];

    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const jNext = (j + 1) % n;
      const cx = poly[2 * j];
      const cy = poly[2 * j + 1];
      const dx = poly[2 * jNext];
      const dy = poly[2 * jNext + 1];
      if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) {
        throw new Error(
          `PixiRenderer: slot "${slot}" on page "${page}" carries an unbuildable self-crossing clip polygon between edges ${i} and ${j} (expected simple non-crossing polygon)`,
        );
      }
    }
  }

  const area2 = polygonSignedArea2(poly);
  if (Math.abs(area2) <= 1e-9) {
    throw new Error(
      `PixiRenderer: slot "${slot}" on page "${page}" carries an unbuildable collinear / zero-area clip polygon (expected non-degenerate polygon with area > 0)`,
    );
  }

  if (clip.convex) {
    const sign = area2 > 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const k = (i + 2) % n;
      const turn = cross2d(
        poly[2 * i],
        poly[2 * i + 1],
        poly[2 * j],
        poly[2 * j + 1],
        poly[2 * k],
        poly[2 * k + 1],
      );
      if (turn * sign < -1e-9) {
        throw new Error(
          `PixiRenderer: slot "${slot}" on page "${page}" carries an unbuildable non-convex clip polygon marked convex=true at vertex ${j} (expected convex polygon)`,
        );
      }
    }
  }

  const screenPolygon = new Array<number>(poly.length);
  for (let i = 0; i < poly.length; i += 2) {
    screenPolygon[i] = poly[i];
    screenPolygon[i + 1] = -poly[i + 1];
  }
  return {
    screenPolygon,
    inverse: clip.inverse,
  };
}

function drawClipIntoGraphics(graphics: Graphics, clip: ValidatedClip): void {
  graphics.clear();
  graphics.poly(clip.screenPolygon).fill(0xffffff);
}

interface PreparedSlotCommon {
  blendMode: BLEND_MODES;
  color: number;
  alpha: number;
  darkMatrix: PixiColorMatrix | null;
  clipPlan: ValidatedClip | null;
}

interface PreparedRegionSlot extends PreparedSlotCommon {
  kind: 'region';
  slot: PosedRegion;
  texture: Texture;
  matrix: Matrix;
}

interface PreparedMeshSlot extends PreparedSlotCommon {
  kind: 'mesh';
  slot: PosedMesh;
  texture: Texture;
}

type PreparedSlot = PreparedRegionSlot | PreparedMeshSlot;

interface MeshSlotEntry {
  mesh: Mesh<MeshGeometry>;
  geometry: MeshGeometry;
  positions: Float32Array;
  uvsRef: readonly number[] | null;
  trianglesRef: readonly number[] | null;
  darkFilter: ColorMatrixFilter | null;
}

interface RegionSlotEntry {
  sprite: Sprite;
  darkFilter: ColorMatrixFilter | null;
}

/**
 * Renders a `@rig-c/play` `PosedFrame` — region slots (`kind: 'region'`), mesh
 * slots (`kind: 'mesh'`), clipping polygons (`clip`), two-colour tints (`dark`),
 * and premultiplied or straight atlas pages (`pma`) — into a PixiJS `Container`.
 *
 * The renderer owns nothing of the pose: every slot's world corners or mesh
 * vertices, page UVs, triangle indices, tint, dark tint, clip polygon, and
 * blend mode are read straight from the `PosedFrame` record. World coordinates
 * (`x` right, `y` up) map into `root`'s local coordinate space as
 * `(worldX, -worldY)`, matching `@rig-c/play`'s `CanvasRenderer` and
 * `DomRenderer`.
 */
export class PixiRenderer {
  /** Number of mesh UV buffer allocations/uploads performed across `render()` calls. */
  uvUploadCount = 0;
  /** Number of mesh triangle index buffer allocations/uploads performed across `render()` calls. */
  triangleUploadCount = 0;
  /** Total mesh UV + triangle index buffer uploads (`uvUploadCount + triangleUploadCount`). */
  geometryUploadCount = 0;
  /** Number of `MeshGeometry` instances created by this renderer. */
  meshGeometryCount = 0;
  /**
   * When true, forces `uvs` and `triangles` buffers to re-upload on every frame
   * even when array references are identical (used as the Bar 3 negative control).
   */
  alwaysReuploadGeometry = false;

  private readonly sources = new Map<HTMLImageElement, { source: ImageSource; pma: boolean }>();
  private readonly regionTextures = new Map<string, Texture>();
  private readonly pageTextures = new Map<string, Texture>();
  private readonly regionPool = new Map<string, RegionSlotEntry>();
  private readonly meshPool = new Map<string, MeshSlotEntry>();
  private readonly maskPool: Graphics[] = [];
  private rootMask: Graphics | null = null;
  private readonly validatedClips = new Map<PosedClip, ValidatedClip>();
  private disposed = false;

  constructor(
    public readonly root: Container,
    private readonly assets: ModelAssets,
  ) {}

  /**
   * Draws one `PosedFrame` into `this.root`.
   *
   * Validates every slot in `frame.order` before mutating `this.root.children`
   * so a refused frame never leaves a half-updated scene graph.
   */
  render(frame: PosedFrame): void {
    if (this.disposed) {
      throw new Error(
        'PixiRenderer: cannot render on a disposed PixiRenderer (expected active renderer)',
      );
    }
    if (!frame || !Array.isArray(frame.order)) {
      throw new Error('PixiRenderer: frame.order is missing or not an array (expected PosedFrame)');
    }

    this.validatedClips.clear();
    const order = frame.order;
    const prepared: PreparedSlot[] = new Array(order.length);

    for (let i = 0; i < order.length; i++) {
      prepared[i] = this.prepareSlot(order[i]);
    }

    // Ensure root is a RenderGroup so masks attached to root or its children
    // share root's coordinate space (`(worldX, -worldY)`) under any ancestor transform.
    if (!this.root.isRenderGroup) {
      this.root.enableRenderGroup();
    }

    // Check whether one clip covers every slot in the frame (the whole-skeleton root clip case).
    const firstClip = prepared.length > 0 ? prepared[0].slot.clip : undefined;
    const allShareRootClip =
      firstClip !== undefined && prepared.every((item) => item.slot.clip === firstClip);

    if (allShareRootClip && prepared[0].clipPlan !== null) {
      if (!this.rootMask) {
        this.rootMask = new Graphics();
      }
      drawClipIntoGraphics(this.rootMask, prepared[0].clipPlan);
      this.root.setMask({ mask: this.rootMask, inverse: firstClip.inverse });
    } else if (this.root.mask) {
      this.root.setMask({ inverse: false });
      this.root.mask = null;
    }

    // Remove excess children from root if the previous frame had more slots.
    while (this.root.children.length > prepared.length) {
      this.root.removeChildAt(this.root.children.length - 1);
    }

    const slotCounts = new Map<string, number>();
    let maskPoolIndex = 0;

    for (let i = 0; i < prepared.length; i++) {
      const item = prepared[i];
      const slotName = item.slot.slot;
      const occurrence = slotCounts.get(slotName) ?? 0;
      slotCounts.set(slotName, occurrence + 1);
      const poolKey = occurrence === 0 ? slotName : `${slotName}\u0000${occurrence}`;

      const view =
        item.kind === 'region'
          ? this.updateRegionView(poolKey, item)
          : this.updateMeshView(poolKey, item);

      if (!allShareRootClip && item.clipPlan !== null && item.slot.clip !== undefined) {
        while (this.maskPool.length <= maskPoolIndex) {
          this.maskPool.push(new Graphics());
        }
        const maskGraphics = this.maskPool[maskPoolIndex++];
        drawClipIntoGraphics(maskGraphics, item.clipPlan);
        view.setMask({ mask: maskGraphics, inverse: item.slot.clip.inverse });
      } else if (view.mask) {
        view.setMask({ inverse: false });
        view.mask = null;
      }

      if (this.root.children[i] !== view) {
        this.root.addChildAt(view, i);
      }
      view.getGlobalTransform(view.worldTransform, false);
    }
  }

  /**
   * Returns the `ImageSource` created for `pageName`, or `undefined` if that
   * page has not been rendered yet.
   */
  getPageSource(pageName: string): ImageSource | undefined {
    const pageImage = this.assets.pageImages.get(pageName);
    if (!pageImage) return undefined;
    return this.sources.get(pageImage)?.source;
  }

  /**
   * Removes all display objects from `this.root` and destroys the PixiJS
   * geometries, textures, masks, and sources created by this renderer. Does not
   * dispose `ModelAssets`. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.root.mask) {
      this.root.setMask({ inverse: false });
      this.root.mask = null;
    }
    this.root.removeChildren();
    if (this.rootMask) {
      this.rootMask.destroy();
      this.rootMask = null;
    }
    for (const mask of this.maskPool) {
      mask.destroy();
    }
    this.maskPool.length = 0;
    for (const entry of this.regionPool.values()) {
      entry.darkFilter?.destroy();
      entry.sprite.destroy();
    }
    this.regionPool.clear();
    for (const entry of this.meshPool.values()) {
      entry.darkFilter?.destroy();
      entry.mesh.destroy();
      entry.geometry.destroy(true);
    }
    this.meshPool.clear();
    for (const texture of this.regionTextures.values()) {
      texture.destroy(false);
    }
    this.regionTextures.clear();
    for (const texture of this.pageTextures.values()) {
      texture.destroy(false);
    }
    this.pageTextures.clear();
    for (const { source } of this.sources.values()) {
      source.destroy();
    }
    this.sources.clear();
    this.validatedClips.clear();
  }

  private updateRegionView(poolKey: string, item: PreparedRegionSlot): Sprite {
    let entry = this.regionPool.get(poolKey);
    if (!entry) {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.roundPixels = false;
      entry = { sprite, darkFilter: null };
      this.regionPool.set(poolKey, entry);
    }
    const { sprite } = entry;
    sprite.label = item.slot.slot;
    sprite.texture = item.texture;

    this.applyColorAndBlend(entry, sprite, item);

    // Apply the affine basis (a, b, c, d, tx, ty) directly via position,
    // skew, and scale with rotation=0 rather than sprite.setFromMatrix(),
    // because PixiJS Matrix.decompose zeroes skew when |skewX + skewY| < 1e-5,
    // which would shift corners of large sprites by up to ~3.3e-5 px.
    const m = item.matrix;
    sprite.position.set(m.tx, m.ty);
    sprite.rotation = 0;
    sprite.skew.set(Math.atan2(m.c, m.d), Math.atan2(m.b, m.a));
    sprite.scale.set(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));

    return sprite;
  }

  private updateMeshView(poolKey: string, item: PreparedMeshSlot): Mesh<MeshGeometry> {
    const { slot } = item;
    const verts = slot.vertices;
    let entry = this.meshPool.get(poolKey);

    if (!entry) {
      const positions = new Float32Array(verts.length);
      for (let i = 0; i < verts.length; i += 2) {
        positions[i] = verts[i];
        positions[i + 1] = -verts[i + 1];
      }
      const uvs = new Float32Array(slot.uvs);
      const indices = new Uint32Array(slot.triangles);
      const geometry = new MeshGeometry({
        positions,
        uvs,
        indices,
      });
      const mesh = new Mesh({
        geometry,
        texture: item.texture,
        roundPixels: false,
      });
      this.meshGeometryCount++;
      this.uvUploadCount++;
      this.triangleUploadCount++;
      this.geometryUploadCount = this.uvUploadCount + this.triangleUploadCount;

      entry = {
        mesh,
        geometry,
        positions,
        uvsRef: slot.uvs,
        trianglesRef: slot.triangles,
        darkFilter: null,
      };
      this.meshPool.set(poolKey, entry);
    } else {
      // Update world positions (Y flipped to -Y in root local space).
      if (entry.positions.length !== verts.length) {
        const positions = new Float32Array(verts.length);
        for (let i = 0; i < verts.length; i += 2) {
          positions[i] = verts[i];
          positions[i + 1] = -verts[i + 1];
        }
        entry.positions = positions;
        entry.geometry.positions = positions;
      } else {
        const positions = entry.positions;
        for (let i = 0; i < verts.length; i += 2) {
          positions[i] = verts[i];
          positions[i + 1] = -verts[i + 1];
        }
        entry.geometry.getBuffer('aPosition').update();
      }

      // Reuse UVs by array reference identity across frames.
      if (this.alwaysReuploadGeometry || entry.uvsRef !== slot.uvs) {
        entry.geometry.uvs = new Float32Array(slot.uvs);
        entry.uvsRef = slot.uvs;
        this.uvUploadCount++;
        this.geometryUploadCount = this.uvUploadCount + this.triangleUploadCount;
      }

      // Reuse triangle indices by array reference identity across frames.
      if (this.alwaysReuploadGeometry || entry.trianglesRef !== slot.triangles) {
        entry.geometry.indices = new Uint32Array(slot.triangles);
        entry.trianglesRef = slot.triangles;
        this.triangleUploadCount++;
        this.geometryUploadCount = this.uvUploadCount + this.triangleUploadCount;
      }
    }

    const { mesh } = entry;
    mesh.label = slot.slot;
    mesh.texture = item.texture;
    this.applyColorAndBlend(entry, mesh, item);

    return mesh;
  }

  private applyColorAndBlend(
    entry: { darkFilter: ColorMatrixFilter | null },
    view: Sprite | Mesh<MeshGeometry>,
    item: PreparedSlotCommon,
  ): void {
    if (item.darkMatrix !== null) {
      if (!entry.darkFilter) {
        entry.darkFilter = new ColorMatrixFilter();
      }
      entry.darkFilter.matrix = item.darkMatrix;
      entry.darkFilter.blendMode = item.blendMode;
      view.tint = 0xffffff;
      view.alpha = 1;
      view.blendMode = 'normal';
      view.filters = [entry.darkFilter];
    } else {
      if (view.filters && view.filters.length > 0) {
        view.filters = [];
      }
      view.tint = item.color;
      view.alpha = item.alpha;
      view.blendMode = item.blendMode;
    }
  }

  private prepareSlot(slot: PosedSlot): PreparedSlot {
    if (!slot || typeof slot !== 'object') {
      throw new Error(
        'PixiRenderer: encountered invalid slot entry in frame.order (expected PosedSlot object)',
      );
    }
    const slotName =
      typeof slot.slot === 'string' && slot.slot.length > 0 ? slot.slot : '<unnamed>';
    const pageName =
      typeof slot.page === 'string' && slot.page.length > 0 ? slot.page : '<unnamed>';

    if (slot.kind !== 'region' && slot.kind !== 'mesh') {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" has unsupported kind "${String((slot as { kind?: unknown }).kind)}" (expected "region" or "mesh")`,
      );
    }

    const blendMode = (BLEND_PIXI as Record<string, BLEND_MODES | undefined>)[slot.blend];
    if (blendMode === undefined) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" has unsupported blend mode "${String(slot.blend)}" (expected Normal, Additive, Multiply, or Screen)`,
      );
    }

    if (typeof slot.pma !== 'boolean') {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" has invalid pma=${String(slot.pma)} (expected boolean)`,
      );
    }

    const pageImage = this.assets.pageImages.get(slot.page);
    if (!pageImage) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" references page "${pageName}", which is missing from assets.pageImages (expected HTMLImageElement for "${pageName}")`,
      );
    }

    const pw = pageImage.naturalWidth || pageImage.width;
    const ph = pageImage.naturalHeight || pageImage.height;
    if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" page "${pageName}" has invalid image dimensions ${String(pw)}x${String(ph)} (expected positive decoded dimensions)`,
      );
    }

    assertFiniteTuple(slot.tint, 4, 'tint', slotName, pageName);

    let darkMatrix: PixiColorMatrix | null = null;
    if (slot.dark !== undefined) {
      assertFiniteTuple(slot.dark, 3, 'dark', slotName, pageName);
      darkMatrix = darkTintColorMatrix(slot.tint, slot.dark);
    }

    let clipPlan: ValidatedClip | null = null;
    if (slot.clip !== undefined) {
      let cachedPlan = this.validatedClips.get(slot.clip);
      if (!cachedPlan) {
        cachedPlan = validateClip(slot.clip, slotName, pageName);
        this.validatedClips.set(slot.clip, cachedPlan);
      }
      clipPlan = cachedPlan;
    }

    const { color, alpha } = tintToPixi(slot.tint);

    if (slot.kind === 'region') {
      assertFiniteTuple(slot.corners, 8, 'corners', slotName, pageName);
      assertFiniteTuple(slot.uvs, 8, 'uvs', slotName, pageName);

      const texture = this.regionTextureFor(pageImage, pw, ph, slot);
      const [blX, blY, ulX, ulY, urX, urY] = slot.corners;
      const w = texture.orig.width;
      const h = texture.orig.height;

      const sblX = blX;
      const sblY = -blY;
      const sulX = ulX;
      const sulY = -ulY;
      const surX = urX;
      const surY = -urY;

      const a = (surX - sulX) / w;
      const b = (surY - sulY) / w;
      const c = (sblX - sulX) / h;
      const d = (sblY - sulY) / h;
      const tx = sulX;
      const ty = sulY;

      return {
        kind: 'region',
        slot,
        texture,
        blendMode,
        color,
        alpha,
        darkMatrix,
        clipPlan,
        matrix: new Matrix(a, b, c, d, tx, ty),
      };
    }

    // slot.kind === 'mesh'
    assertFiniteEvenArray(slot.vertices, 6, 'vertices', slotName, pageName);
    assertFiniteTuple(slot.uvs, slot.vertices.length, 'uvs', slotName, pageName);

    if (
      !Array.isArray(slot.triangles) ||
      slot.triangles.length < 3 ||
      slot.triangles.length % 3 !== 0
    ) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" has invalid triangles length ${Array.isArray(slot.triangles) ? slot.triangles.length : 'non-array'} (expected multiple of 3 >= 3)`,
      );
    }
    const vertexCount = slot.vertices.length / 2;
    for (let i = 0; i < slot.triangles.length; i++) {
      const idx = slot.triangles[i];
      if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) {
        throw new Error(
          `PixiRenderer: slot "${slotName}" on page "${pageName}" has out-of-range triangle index triangles[${i}]=${String(idx)} (expected integer in 0..${vertexCount - 1})`,
        );
      }
    }
    if (typeof slot.sequence !== 'number' || !Number.isInteger(slot.sequence)) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" has invalid sequence=${String(slot.sequence)} (expected integer)`,
      );
    }

    const texture = this.pageTextureFor(pageImage, slot.page, slot.pma);
    return {
      kind: 'mesh',
      slot,
      texture,
      blendMode,
      color,
      alpha,
      darkMatrix,
      clipPlan,
    };
  }

  private sourceFor(pageImage: HTMLImageElement, pma: boolean): ImageSource {
    const desiredAlphaMode = pma ? 'premultiplied-alpha' : 'premultiply-alpha-on-upload';
    const existing = this.sources.get(pageImage);
    if (existing) {
      if (existing.pma !== pma) {
        existing.pma = pma;
        existing.source.alphaMode = desiredAlphaMode;
        existing.source.update();
      }
      return existing.source;
    }
    const source = new ImageSource({
      resource: pageImage,
      alphaMode: desiredAlphaMode,
      scaleMode: 'linear',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    this.sources.set(pageImage, { source, pma });
    return source;
  }

  private pageTextureFor(pageImage: HTMLImageElement, pageName: string, pma: boolean): Texture {
    const key = `${pageName}\u0000${pma ? '1' : '0'}`;
    let texture = this.pageTextures.get(key);
    if (texture) {
      this.sourceFor(pageImage, pma);
      return texture;
    }
    const source = this.sourceFor(pageImage, pma);
    texture = new Texture({ source });
    this.pageTextures.set(key, texture);
    return texture;
  }

  private regionTextureFor(
    pageImage: HTMLImageElement,
    pw: number,
    ph: number,
    slot: PosedRegion,
  ): Texture {
    const [blU, blV, ulU, ulV, urU, urV, brU, brV] = slot.uvs;
    const key = `${slot.page}\u0000${slot.pma ? '1' : '0'}\u0000${blU},${blV},${ulU},${ulV},${urU},${urV},${brU},${brV}`;
    let texture = this.regionTextures.get(key);
    if (texture) {
      this.sourceFor(pageImage, slot.pma);
      return texture;
    }

    const source = this.sourceFor(pageImage, slot.pma);
    const u1 = Math.min(blU, ulU, urU, brU);
    const u2 = Math.max(blU, ulU, urU, brU);
    const v1 = Math.min(blV, ulV, urV, brV);
    const v2 = Math.max(blV, ulV, urV, brV);

    const frameW = Math.max(1, (u2 - u1) * pw);
    const frameH = Math.max(1, (v2 - v1) * ph);
    const frame = new Rectangle(u1 * pw, v1 * ph, frameW, frameH);

    // Detect 90-degree atlas rotation (`region.degrees === 90`), where UL and UR
    // share U (`ulU === urU`) and UL and BL share V (`ulV === blV`).
    const turned = Math.abs(ulU - urU) < Math.abs(ulU - blU);
    const orig = turned
      ? new Rectangle(0, 0, frameH, frameW)
      : new Rectangle(0, 0, frameW, frameH);
    const rotate = turned ? 6 : 0;

    texture = new Texture({
      source,
      frame,
      orig,
      rotate,
    });

    // Preserve the exact float32 UVs from PosedRegion.uvs on the four Sprite corners:
    // (x0, y0) = UL, (x1, y1) = UR, (x2, y2) = BR, (x3, y3) = BL.
    texture.uvs.x0 = ulU;
    texture.uvs.y0 = ulV;
    texture.uvs.x1 = urU;
    texture.uvs.y1 = urV;
    texture.uvs.x2 = brU;
    texture.uvs.y2 = brV;
    texture.uvs.x3 = blU;
    texture.uvs.y3 = blV;

    this.regionTextures.set(key, texture);
    return texture;
  }
}

/**
 * Reads back the four corners of a rendered `Sprite` in `[blX, blY, ulX, ulY, urX, urY, brX, brY]`
 * order after the stage's transform (`sprite.worldTransform`).
 */
export function readSpriteScreenCorners(
  sprite: Sprite,
): [number, number, number, number, number, number, number, number] {
  const w = sprite.texture.orig.width;
  const h = sprite.texture.orig.height;
  const wt = sprite.getGlobalTransform(new Matrix(), false);

  const bl = wt.apply({ x: 0, y: h });
  const ul = wt.apply({ x: 0, y: 0 });
  const ur = wt.apply({ x: w, y: 0 });
  const br = wt.apply({ x: w, y: h });

  return [bl.x, bl.y, ul.x, ul.y, ur.x, ur.y, br.x, br.y];
}

/**
 * Maps `PosedRegion.corners` (`[blX, blY, ulX, ulY, urX, urY, brX, brY]` in
 * world space, Y up) through the stage's world->screen transform (`root` plus
 * the Y-axis flip `(worldX, -worldY)`).
 */
export function worldToScreenCorners(
  corners: readonly number[],
  root: Container,
): [number, number, number, number, number, number, number, number] {
  const rt = root.getGlobalTransform(new Matrix(), false);
  const bl = rt.apply({ x: corners[0], y: -corners[1] });
  const ul = rt.apply({ x: corners[2], y: -corners[3] });
  const ur = rt.apply({ x: corners[4], y: -corners[5] });
  const br = rt.apply({ x: corners[6], y: -corners[7] });
  return [bl.x, bl.y, ul.x, ul.y, ur.x, ur.y, br.x, br.y];
}

/**
 * Reads back every vertex of a rendered `Mesh` (`mesh.geometry.positions`)
 * after the stage's transform (`mesh.worldTransform`).
 */
export function readMeshScreenVertices(mesh: Mesh<MeshGeometry>): number[] {
  const positions = mesh.geometry.positions;
  const wt = mesh.getGlobalTransform(new Matrix(), false);
  const out = new Array<number>(positions.length);
  for (let i = 0; i < positions.length; i += 2) {
    const pt = wt.apply({ x: positions[i], y: positions[i + 1] });
    out[i] = pt.x;
    out[i + 1] = pt.y;
  }
  return out;
}

/**
 * Maps `PosedMesh.vertices` (flat `x, y` pairs in world space, Y up) through
 * the stage's world->screen transform (`root` plus the Y-axis flip
 * `(worldX, -worldY)`). When `quantizeFloat32` is true, each local vertex is
 * rounded through `Math.fround` first to match `MeshGeometry`'s `Float32Array`
 * attribute buffer.
 */
export function worldToScreenVertices(
  vertices: readonly number[],
  root: Container,
  quantizeFloat32 = false,
): number[] {
  const rt = root.getGlobalTransform(new Matrix(), false);
  const out = new Array<number>(vertices.length);
  for (let i = 0; i < vertices.length; i += 2) {
    const lx = quantizeFloat32 ? Math.fround(vertices[i]) : vertices[i];
    const ly = quantizeFloat32 ? Math.fround(-vertices[i + 1]) : -vertices[i + 1];
    const pt = rt.apply({ x: lx, y: ly });
    out[i] = pt.x;
    out[i + 1] = pt.y;
  }
  return out;
}
