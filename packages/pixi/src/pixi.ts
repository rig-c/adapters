import { LiveDrawViews, RetainedRuntimeFrame, numberSource, numberOffset, numberCount, type DrawNumbers, type DrawClip, type DrawMesh, type DrawRegion, type DrawSlot } from './live.ts';
import { clamp01 } from '@rig-c/adapters-shared';
import {
  type BlendMode,
  type BoneAdjust,
  type BoneWorld,
  type ModelAssets,
  type LiveFrame,
  type LiveNumbers,
  type PlayOptions,
  type PoseBounds,
  type PosedFrame,
  type QueueOptions,
  type RigComplete,
  type RigEnvironment,
  type RigEvent,
  RigPlayer,
  type SlotFilter,
  type TrackEntry,
} from '@rig-c/play';
import {
  type BLEND_MODES,
  ColorMatrixFilter,
  Container,
  type DestroyOptions,
  Graphics,
  ImageSource,
  Matrix,
  Mesh,
  MeshGeometry,
  Rectangle,
  Sprite,
  Texture,
  Ticker,
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


/**
 * Maps a `PosedSlot.tint` tuple (`[r, g, b, a]` in `0..1`) to PixiJS
 * 24-bit RGB `tint` (`0xRRGGBB`) and `alpha` (`0..1`).
 */
export function tintToPixi(tint: LiveNumbers): {
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
  tint: LiveNumbers,
  dark: LiveNumbers,
): PixiColorMatrix {
  return darkMatrixAt(tint, 0, dark);
}

function darkMatrixAt(tint: LiveNumbers, offset: number, dark: LiveNumbers): PixiColorMatrix {
  const r = clamp01(tint[offset]);
  const g = clamp01(tint[offset + 1]);
  const b = clamp01(tint[offset + 2]);
  const a = clamp01(tint[offset + 3]);
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

function polygonSignedArea2(polygon: LiveNumbers): number {
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
  values: DrawNumbers,
  expectedLength: number,
  field: string,
  slot: string,
  page: string,
  indexed = false,
): void {
  const count = indexed || Array.isArray(values) ? numberCount(values) : -1;
  if (count !== expectedLength) {
    throw new Error(
      `PixiRenderer: slot "${slot}" on page "${page}" has invalid ${field} length ${count < 0 ? 'non-array' : count} (expected ${expectedLength})`,
    );
  }
  const source = numberSource(values);
  const offset = numberOffset(values);
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(source[offset + i])) {
      throw new Error(
        `PixiRenderer: slot "${slot}" on page "${page}" has non-finite ${field}[${i}]=${String(source[offset + i])} (expected finite number)`,
      );
    }
  }
}

function assertFiniteEvenArray(
  values: DrawNumbers,
  minLength: number,
  field: string,
  slot: string,
  page: string,
  indexed = false,
): void {
  const count = indexed || Array.isArray(values) ? numberCount(values) : -1;
  if (count < minLength || count % 2 !== 0) {
    throw new Error(
      `PixiRenderer: slot "${slot}" on page "${page}" has invalid ${field} length ${count < 0 ? 'non-array' : count} (expected even length >= ${minLength})`,
    );
  }
  const source = numberSource(values);
  const offset = numberOffset(values);
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(source[offset + i])) {
      throw new Error(
        `PixiRenderer: slot "${slot}" on page "${page}" has non-finite ${field}[${i}]=${String(source[offset + i])} (expected finite number)`,
      );
    }
  }
}

interface ValidatedClip {
  screenPolygon: number[];
  inverse: boolean;
}

function validateClip(clip: DrawClip, slot: string, page: string, indexed = false): ValidatedClip {
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
  if ((!indexed && !Array.isArray(clip.polygon)) || clip.polygon.length < 6 || clip.polygon.length % 2 !== 0) {
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
  poolKey: string;
  blendMode: BLEND_MODES;
  color: number;
  alpha: number;
  darkMatrix: PixiColorMatrix | null;
  clipPlan: ValidatedClip | null;
}

interface PreparedSlotItem extends PreparedSlotCommon {
  kind: 'region' | 'mesh';
  slot: DrawSlot;
  texture: Texture;
}

interface MeshSlotEntry {
  mesh: Mesh<MeshGeometry>;
  geometry: MeshGeometry;
  positions: Float32Array;
  verticesRef: DrawNumbers | null;
  uvsRef: LiveNumbers | null;
  trianglesRef: LiveNumbers | null;
  page: string | null;
  pma: boolean | null;
  texture: Texture | null;
  darkFilter: ColorMatrixFilter | null;
}

interface RegionSlotEntry {
  sprite: Sprite;
  darkFilter: ColorMatrixFilter | null;
  uvsRef: LiveNumbers | null;
  page: string | null;
  pma: boolean | null;
  texture: Texture | null;
  c0: number;
  c1: number;
  c2: number;
  c3: number;
  c4: number;
  c5: number;
}

interface ValidatedPageInfo {
  pageImage: HTMLImageElement;
  pw: number;
  ph: number;
}

interface SharedPageSourceEntry {
  source: ImageSource;
  pma: boolean;
  holders: Set<PixiRenderer>;
}

const sharedPageSources = new WeakMap<HTMLImageElement, SharedPageSourceEntry>();
const livePageSources = new Set<ImageSource>();

/**
 * Returns the number of live shared page `ImageSource` textures currently held
 * across all active `PixiRenderer` / `PixiRig` instances.
 */
export function getLivePageTextureCount(): number {
  return livePageSources.size;
}

/**
 * Returns the number of active `PixiRenderer` / `PixiRig` instances currently
 * retaining the shared `ImageSource` for `pageImage`.
 */
export function getPageRefCount(pageImage: HTMLImageElement): number {
  return sharedPageSources.get(pageImage)?.holders.size ?? 0;
}

/**
 * Returns the shared `ImageSource` currently allocated for `pageImage`, or
 * `undefined` if no active renderer retains `pageImage`.
 */
export function getSharedPageSource(pageImage: HTMLImageElement): ImageSource | undefined {
  return sharedPageSources.get(pageImage)?.source;
}

/**
 * Per-instance display object and texture resource counts owned by a
 * `PixiRenderer` / `PixiRig`.
 */
export interface PixiRigResourceCounts {
  sprites: number;
  meshes: number;
  geometries: number;
  masks: number;
  filters: number;
  textureViews: number;
  retainedPages: number;
  livePageTextures: number;
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
 *
 * Page `ImageSource` textures are reference-counted per `HTMLImageElement` across
 * `PixiRenderer` instances so several `PixiRig`s over one `ModelAssets` load share
 * the same GPU page textures and only the last `dispose()` / `destroy()` frees them.
 */
export class PixiRenderer {
  /** Number of mesh UV buffer allocations/uploads performed across `render()` calls. */
  uvUploadCount = 0;
  /** Number of mesh triangle index buffer allocations/uploads performed across `render()` calls. */
  triangleUploadCount = 0;
  /** Total mesh UV + triangle index buffer uploads (`uvUploadCount + triangleUploadCount`). */
  geometryUploadCount = 0;
  /** Number of mesh vertex position buffer allocations/uploads performed across `render()` calls. */
  positionUploadCount = 0;
  /** Number of `MeshGeometry` instances created by this renderer. */
  meshGeometryCount = 0;
  /**
   * When true, forces `positions`, `uvs`, and `triangles` buffers to re-upload
   * on every frame even when array references or vertex coordinates are unchanged
   * (used as the negative control for static / `timescale = 0` geometry reuse).
   */
  alwaysReuploadGeometry = false;
  /** Validate dynamic live tuples; snapshots always retain full validation. */
  liveFrameChecks = true;
  private liveInput = false;
  private livePositionsUnchanged = false;
  private lastLiveFrame: WeakRef<LiveFrame> | null = null;
  private lastLiveGeneration = -1;
  /**
   * When true (default), `dispose()` decrements and destroys shared page
   * `ImageSource`s when the last holder is disposed. Setting to `false` serves
   * as the negative control for Bar 3's page texture unload check.
   */
  releasePageSourcesOnDispose = true;
  /**
   * When true, promotes `this.root` into its own PixiJS `RenderGroup` even when
   * no clipping mask is active. Defaults to `false` so multiple `PixiRig`
   * instances in the same container batch together in a single draw call.
   */
  useRenderGroup = false;
  /**
   * Batch mode assigned to each `MeshGeometry` owned by this renderer. Defaults
   * to `'batch'` so meshes exceeding PixiJS v8's 100-vertex `'auto'` threshold
   * still batch with surrounding slots and instances.
   */
  meshBatchMode: 'auto' | 'batch' = 'batch';

  private readonly retainedPages = new Set<HTMLImageElement>();
  private readonly regionTextures = new Map<string, Texture>();
  private readonly pageTextures = new Map<string, Texture>();
  private readonly regionPool = new Map<string, RegionSlotEntry>();
  private readonly meshPool = new Map<string, MeshSlotEntry>();
  private readonly maskPool: Graphics[] = [];
  private rootMask: Graphics | null = null;
  private readonly validatedClips = new Map<DrawClip, ValidatedClip>();
  private readonly liveViews = new LiveDrawViews();
  private readonly validatedPages = new Map<string, ValidatedPageInfo>();
  private readonly slotCounts = new Map<string, { generation: number; count: number }>();
  private drawGeneration = 0;
  private readonly preparedPool: PreparedSlotItem[] = [];
  private autoPromotedRenderGroup = false;
  private disposed = false;

  constructor(
    public readonly root: Container,
    private readonly assets: ModelAssets,
  ) {}

  /** Number of pooled `Sprite` instances currently owned by this renderer. */
  get spriteCount(): number {
    return this.regionPool.size;
  }

  /** Number of pooled `Mesh` instances currently owned by this renderer. */
  get meshCount(): number {
    return this.meshPool.size;
  }

  /** Number of pooled `Graphics` mask instances currently owned by this renderer. */
  get maskCount(): number {
    return (this.rootMask ? 1 : 0) + this.maskPool.length;
  }

  /** Number of `ColorMatrixFilter` instances currently owned by this renderer. */
  get filterCount(): number {
    let count = 0;
    for (const entry of this.regionPool.values()) {
      if (entry.darkFilter) count++;
    }
    for (const entry of this.meshPool.values()) {
      if (entry.darkFilter) count++;
    }
    return count;
  }

  /** Number of lightweight `Texture` views (`regionTextures + pageTextures`) owned by this renderer. */
  get textureViewCount(): number {
    return this.regionTextures.size + this.pageTextures.size;
  }

  /** Number of page `HTMLImageElement`s currently retained by this renderer. */
  get retainedPageCount(): number {
    return this.retainedPages.size;
  }

  /** Whether `dispose()` has been called on this renderer. */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Returns a snapshot of the display objects, geometries, texture views, and
   * shared page textures currently owned or retained by this renderer.
   */
  resourceCounts(): PixiRigResourceCounts {
    return {
      sprites: this.spriteCount,
      meshes: this.meshCount,
      geometries: this.meshPool.size,
      masks: this.maskCount,
      filters: this.filterCount,
      textureViews: this.textureViewCount,
      retainedPages: this.retainedPageCount,
      livePageTextures: getLivePageTextureCount(),
    };
  }

  /**
   * Draws one `PosedFrame` into `this.root`.
   *
   * Validates every slot in `frame.order` before mutating `this.root.children`
   * so a refused frame never leaves a half-updated scene graph.
   */
  render(frame: PosedFrame | LiveFrame): void {
    if (!frame || typeof frame !== 'object') {
      throw new Error('PixiRenderer: frame.order is missing or not an array (expected PosedFrame or LiveFrame)');
    }
    if ('order' in frame) {
      this.lastLiveFrame = null;
      this.renderOrder(frame.order, false);
      return;
    }
    // read() checks the generation before renderOrder can touch scene objects.
    try {
      const order = this.liveViews.read(frame);
      const generation = frame.generation;
      this.liveInput = true;
      this.livePositionsUnchanged = this.lastLiveFrame?.deref() === frame && this.lastLiveGeneration === generation;
      this.renderOrder(order, true);
      if (this.lastLiveFrame?.deref() !== frame) this.lastLiveFrame = new WeakRef(frame);
      this.lastLiveGeneration = generation;
    } finally {
      this.liveInput = false;
      this.livePositionsUnchanged = false;
      this.liveViews.release();
      this.validatedClips.clear();
      // Static UV/index references are compared only by identity. Production
      // metadata stays stable; a prior checked proxy is never read by index.
    }
  }

  private renderOrder(order: readonly DrawSlot[], indexed: boolean): void {
    if (this.disposed) {
      throw new Error(
        'PixiRenderer: cannot render on a disposed PixiRenderer (expected active renderer)',
      );
    }
    if (!Array.isArray(order)) {
      throw new Error('PixiRenderer: frame.order is missing or not an array (expected PosedFrame)');
    }

    this.validatedClips.clear();
    this.validatedPages.clear();
    // Reuse counters without rebuilding the Map's backing table every draw.
    const generation = this.drawGeneration = (this.drawGeneration + 1) >>> 0;
    if (generation === 0) this.slotCounts.clear();
    const slotCount = order.length;
    const prepared = this.preparedPool;
    const slotCounts = this.slotCounts;

    for (let i = 0; i < slotCount; i++) {
      const slot = order[i];
      const slotName =
        slot && typeof slot === 'object' && typeof slot.slot === 'string' && slot.slot.length > 0
          ? slot.slot
          : '<unnamed>';
      let counter = slotCounts.get(slotName);
      if (!counter) {
        counter = { generation, count: 0 };
        slotCounts.set(slotName, counter);
      } else if (counter.generation !== generation) {
        counter.generation = generation; counter.count = 0;
      }
      const occurrence = counter.count++;
      const poolKey = occurrence === 0 ? slotName : `${slotName}\u0000${occurrence}`;
      let item = prepared[i];
      if (!item) {
        item = {
          kind: 'region',
          poolKey,
          slot,
          texture: Texture.EMPTY,
          blendMode: 'normal',
          color: 0xffffff,
          alpha: 1,
          darkMatrix: null,
          clipPlan: null,
        };
        prepared[i] = item;
      }
      this.prepareSlot(slot, poolKey, item, indexed);
    }

    // Promote root to a RenderGroup only when explicitly requested or when a
    // clipping mask is present (so unparented stencil mask Graphics share root's
    // coordinate space `(worldX, -worldY)` under any ancestor transform, while
    // unclipped multi-instance rigs batch across instances in one RenderGroup).
    let hasClip = false;
    for (let i = 0; i < slotCount; i++) {
      if (prepared[i].clipPlan !== null) {
        hasClip = true;
        break;
      }
    }
    if (this.useRenderGroup || hasClip) {
      if (!this.root.isRenderGroup) {
        this.root.enableRenderGroup();
        this.autoPromotedRenderGroup = true;
      }
    } else if (this.autoPromotedRenderGroup && this.root.isRenderGroup) {
      this.root.disableRenderGroup();
      this.autoPromotedRenderGroup = false;
    }

    // Check whether one clip covers every slot in the frame (the whole-skeleton root clip case).
    const firstClip = slotCount > 0 ? prepared[0].slot.clip : undefined;
    let allShareRootClip = firstClip !== undefined;
    if (allShareRootClip) {
      for (let i = 1; i < slotCount; i++) {
        if (prepared[i].slot.clip !== firstClip) {
          allShareRootClip = false;
          break;
        }
      }
    }

    if (allShareRootClip && firstClip !== undefined && prepared[0].clipPlan !== null) {
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
    while (this.root.children.length > slotCount) {
      this.root.removeChildAt(this.root.children.length - 1);
    }

    let maskPoolIndex = 0;

    for (let i = 0; i < slotCount; i++) {
      const item = prepared[i];
      const { poolKey } = item;

      const view =
        item.kind === 'region'
          ? this.updateRegionView(poolKey, item, item.slot as DrawRegion)
          : this.updateMeshView(poolKey, item, item.slot as DrawMesh);

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
    }
  }

  /**
   * Returns the shared `ImageSource` retained by this renderer for `pageName`,
   * or `undefined` if that page has not been rendered by this renderer (or after
   * `dispose()`).
   */
  getPageSource(pageName: string): ImageSource | undefined {
    const pageImage = this.assets.pageImages.get(pageName);
    if (!pageImage || !this.retainedPages.has(pageImage)) return undefined;
    return sharedPageSources.get(pageImage)?.source;
  }

  /**
   * Removes all display objects from `this.root`, destroys the PixiJS
   * geometries, texture views, masks, and filters created by this renderer, and
   * releases this renderer's hold on each shared page `ImageSource` (destroying
   * the `ImageSource` when the last holder releases it). Does not dispose
   * `ModelAssets`. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.root.mask) {
      this.root.setMask({ inverse: false });
      this.root.mask = null;
    }
    this.root.removeChildren();
    if (this.autoPromotedRenderGroup && this.root.isRenderGroup) {
      this.root.disableRenderGroup();
      this.autoPromotedRenderGroup = false;
    }
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
    for (const pageImage of this.retainedPages) {
      const entry = sharedPageSources.get(pageImage);
      if (!entry) continue;
      entry.holders.delete(this);
      if (entry.holders.size === 0 && this.releasePageSourcesOnDispose) {
        entry.source.destroy();
        livePageSources.delete(entry.source);
        sharedPageSources.delete(pageImage);
      }
    }
    this.retainedPages.clear();
    this.validatedClips.clear();
    this.validatedPages.clear();
    this.slotCounts.clear();
    this.preparedPool.length = 0;
  }

  private updateRegionView(poolKey: string, item: PreparedSlotItem, slot: DrawRegion): Sprite {
    let entry = this.regionPool.get(poolKey);
    if (!entry) {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.roundPixels = false;
      entry = {
        sprite,
        darkFilter: null,
        uvsRef: null,
        page: null,
        pma: null,
        texture: null,
        c0: NaN,
        c1: NaN,
        c2: NaN,
        c3: NaN,
        c4: NaN,
        c5: NaN,
      };
      this.regionPool.set(poolKey, entry);
    }
    const { sprite } = entry;
    if (sprite.label !== slot.slot) {
      sprite.label = slot.slot;
    }
    const textureChanged = entry.texture !== item.texture;
    if (textureChanged) {
      sprite.texture = item.texture;
    }
    entry.uvsRef = slot.uvs;
    entry.page = slot.page;
    entry.pma = slot.pma;
    entry.texture = item.texture;

    this.applyColorAndBlend(entry, sprite, item);

    // Apply the affine basis (a, b, c, d, tx, ty) directly via position,
    // skew, and scale with rotation=0 rather than sprite.setFromMatrix(),
    // because PixiJS Matrix.decompose zeroes skew when |skewX + skewY| < 1e-5,
    // which would shift corners of large sprites by up to ~3.3e-5 px.
    const corners = numberSource(slot.corners);
    const cornerOffset = numberOffset(slot.corners);
    const c0 = corners[cornerOffset + 0];
    const c1 = corners[cornerOffset + 1];
    const c2 = corners[cornerOffset + 2];
    const c3 = corners[cornerOffset + 3];
    const c4 = corners[cornerOffset + 4];
    const c5 = corners[cornerOffset + 5];
    if (
      textureChanged ||
      entry.c0 !== c0 ||
      entry.c1 !== c1 ||
      entry.c2 !== c2 ||
      entry.c3 !== c3 ||
      entry.c4 !== c4 ||
      entry.c5 !== c5
    ) {
      entry.c0 = c0;
      entry.c1 = c1;
      entry.c2 = c2;
      entry.c3 = c3;
      entry.c4 = c4;
      entry.c5 = c5;
      const w = item.texture.orig.width;
      const h = item.texture.orig.height;
      const sblX = c0;
      const sblY = -c1;
      const sulX = c2;
      const sulY = -c3;
      const surX = c4;
      const surY = -c5;
      const a = (surX - sulX) / w;
      const b = (surY - sulY) / w;
      const c = (sblX - sulX) / h;
      const d = (sblY - sulY) / h;
      sprite.position.set(sulX, sulY);
      sprite.rotation = 0;
      sprite.skew.set(Math.atan2(c, d), Math.atan2(b, a));
      sprite.scale.set(Math.sqrt(a * a + b * b), Math.sqrt(c * c + d * d));
    }

    return sprite;
  }

  private updateMeshView(
    poolKey: string,
    item: PreparedSlotItem,
    slot: DrawMesh,
  ): Mesh<MeshGeometry> {
    const verts = slot.vertices;
    const points = numberSource(verts);
    const offset = numberOffset(verts);
    const count = numberCount(verts);
    let entry = this.meshPool.get(poolKey);

    if (!entry) {
      const positions = new Float32Array(count);
      for (let i = 0; i < count; i += 2) {
        positions[i] = points[offset + i];
        positions[i + 1] = points[offset + i + 1];
      }
      const uvs = new Float32Array(slot.uvs.length);
      const indices = new Uint32Array(slot.triangles.length);
      for (let i = 0; i < uvs.length; i++) uvs[i] = slot.uvs[i];
      for (let i = 0; i < indices.length; i++) indices[i] = slot.triangles[i];
      const geometry = new MeshGeometry({
        positions,
        uvs,
        indices,
      });
      geometry.batchMode = this.meshBatchMode;
      const mesh = new Mesh({
        geometry,
        texture: item.texture,
        roundPixels: false,
      });
      // Keep Y-up Float32 positions, and reflect once through the host transform.
      mesh.scale.y = -1;
      this.meshGeometryCount++;
      this.positionUploadCount++;
      this.uvUploadCount++;
      this.triangleUploadCount++;
      this.geometryUploadCount = this.uvUploadCount + this.triangleUploadCount;

      entry = {
        mesh,
        geometry,
        positions,
        verticesRef: verts,
        uvsRef: slot.uvs,
        trianglesRef: slot.triangles,
        page: slot.page,
        pma: slot.pma,
        texture: item.texture,
        darkFilter: null,
      };
      this.meshPool.set(poolKey, entry);
    } else {
      // LiveFrame has a frame generation, not per-span dirtiness. A new pose
      // conservatively uploads each mesh; a repeated unchanged lease skips it.
      if (entry.positions.length !== count) {
        const positions = new Float32Array(count);
        for (let i = 0; i < count; i += 2) {
          positions[i] = points[offset + i];
          positions[i + 1] = points[offset + i + 1];
        }
        entry.positions = positions;
        entry.geometry.positions = positions;
        entry.verticesRef = verts;
        this.positionUploadCount++;
      } else if (this.liveInput) {
        if (this.alwaysReuploadGeometry || !this.livePositionsUnchanged) {
          const positions = entry.positions;
          // Typed assignment converts Float64 to Float32 without a transient
          // subarray view; checked leases keep the same indexed read boundary.
          for (let i = 0; i < count; i++) positions[i] = points[offset + i];
          entry.geometry.getBuffer('aPosition').update();
          this.positionUploadCount++;
        }
        entry.verticesRef = verts;
      } else {
        const positions = entry.positions;
        let changed = this.alwaysReuploadGeometry;
        for (let i = 0; i < count; i += 2) {
          const x = Math.fround(points[offset + i]);
          const y = Math.fround(points[offset + i + 1]);
          if (positions[i] !== x || positions[i + 1] !== y) {
            positions[i] = x;
            positions[i + 1] = y;
            changed = true;
          }
        }
        entry.verticesRef = verts;
        if (changed) {
          entry.geometry.getBuffer('aPosition').update();
          this.positionUploadCount++;
        }
      }

      // Read indexed values directly; retain GPU buffers across checked leases too.
      if (this.alwaysReuploadGeometry || entry.uvsRef !== slot.uvs) {
        let uvs = entry.geometry.uvs;
        // A new static-array identity requests an upload under the snapshot
        // contract, even when its values match. Keep the GPU buffer in place.
        let changed = this.alwaysReuploadGeometry || entry.uvsRef !== slot.uvs;
        if (uvs.length !== slot.uvs.length) {
          uvs = new Float32Array(slot.uvs.length);
          entry.geometry.uvs = uvs;
          changed = true;
        }
        for (let i = 0; i < uvs.length; i++) {
          const value = Math.fround(slot.uvs[i]);
          if (uvs[i] !== value) { uvs[i] = value; changed = true; }
        }
        if (changed) { entry.geometry.getBuffer('aUV').update(); this.uvUploadCount++; }
        entry.uvsRef = slot.uvs;
      }
      if (this.alwaysReuploadGeometry || entry.trianglesRef !== slot.triangles) {
        let indices = entry.geometry.indices;
        let changed = this.alwaysReuploadGeometry || entry.trianglesRef !== slot.triangles;
        if (indices.length !== slot.triangles.length) {
          indices = new Uint32Array(slot.triangles.length);
          entry.geometry.indices = indices;
          changed = true;
        }
        for (let i = 0; i < indices.length; i++) {
          const value = slot.triangles[i];
          if (indices[i] !== value) { indices[i] = value; changed = true; }
        }
        if (changed) { entry.geometry.indexBuffer.update(); this.triangleUploadCount++; }
        entry.trianglesRef = slot.triangles;
      }
      this.geometryUploadCount = this.uvUploadCount + this.triangleUploadCount;

      entry.page = slot.page;
      entry.pma = slot.pma;
      entry.texture = item.texture;
    }

    const { mesh } = entry;
    if (mesh.label !== slot.slot) {
      mesh.label = slot.slot;
    }
    if (mesh.texture !== item.texture) {
      mesh.texture = item.texture;
    }
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
      if (view.tint !== 0xffffff) view.tint = 0xffffff;
      if (view.alpha !== 1) view.alpha = 1;
      if (view.blendMode !== 'normal') view.blendMode = 'normal';
      view.filters = [entry.darkFilter];
    } else {
      if (view.filters && view.filters.length > 0) {
        view.filters = [];
      }
      if (view.tint !== item.color) view.tint = item.color;
      if (view.alpha !== item.alpha) view.alpha = item.alpha;
      if (view.blendMode !== item.blendMode) view.blendMode = item.blendMode;
    }
  }

  private prepareSlot(slot: DrawSlot, poolKey: string, out: PreparedSlotItem, indexed: boolean): void {
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

    let pageInfo = this.validatedPages.get(slot.page);
    if (!pageInfo) {
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
      pageInfo = { pageImage, pw, ph };
      this.validatedPages.set(slot.page, pageInfo);
    }
    const { pageImage, pw, ph } = pageInfo;

    const checkDynamic = !indexed || this.liveFrameChecks;
    if (checkDynamic) assertFiniteTuple(slot.tint, 4, 'tint', slotName, pageName, indexed);
    const tint = numberSource(slot.tint);
    const tintOffset = numberOffset(slot.tint);

    let darkMatrix: PixiColorMatrix | null = null;
    if (slot.dark !== undefined) {
      if (checkDynamic) assertFiniteTuple(slot.dark, 3, 'dark', slotName, pageName, indexed);
      darkMatrix = darkMatrixAt(tint, tintOffset, slot.dark);
    }

    let clipPlan: ValidatedClip | null = null;
    if (slot.clip !== undefined) {
      let cachedPlan = this.validatedClips.get(slot.clip);
      if (!cachedPlan) {
        cachedPlan = validateClip(slot.clip, slotName, pageName, indexed);
        this.validatedClips.set(slot.clip, cachedPlan);
      }
      clipPlan = cachedPlan;
    }

    const r = Math.round(clamp01(tint[tintOffset + 0]) * 255);
    const g = Math.round(clamp01(tint[tintOffset + 1]) * 255);
    const b = Math.round(clamp01(tint[tintOffset + 2]) * 255);
    const color = (r << 16) | (g << 8) | b;
    const alpha = clamp01(tint[tintOffset + 3]);

    if (slot.kind === 'region') {
      if (checkDynamic) assertFiniteTuple(slot.corners, 8, 'corners', slotName, pageName, indexed);

      const regionEntry = this.regionPool.get(poolKey);
      let texture: Texture;
      if (
        !this.alwaysReuploadGeometry &&
        regionEntry &&
        regionEntry.uvsRef === slot.uvs &&
        regionEntry.page === slot.page &&
        regionEntry.pma === slot.pma &&
        regionEntry.texture !== null &&
        !regionEntry.texture.destroyed
      ) {
        this.sourceFor(pageImage, slot.pma);
        texture = regionEntry.texture;
      } else {
        assertFiniteTuple(slot.uvs, 8, 'uvs', slotName, pageName, indexed);
        texture = this.regionTextureFor(pageImage, pw, ph, slot);
      }

      out.kind = 'region';
      out.poolKey = poolKey;
      out.slot = slot;
      out.texture = texture;
      out.blendMode = blendMode;
      out.color = color;
      out.alpha = alpha;
      out.darkMatrix = darkMatrix;
      out.clipPlan = clipPlan;
      return;
    }

    // slot.kind === 'mesh'
    if (checkDynamic) assertFiniteEvenArray(slot.vertices, 6, 'vertices', slotName, pageName, indexed);
    const meshEntry = this.meshPool.get(poolKey);

    const sameVertexCount =
      !this.alwaysReuploadGeometry &&
      meshEntry !== undefined &&
      meshEntry.positions.length === numberCount(slot.vertices);

    if (!sameVertexCount || meshEntry.uvsRef !== slot.uvs) {
      assertFiniteTuple(slot.uvs, numberCount(slot.vertices), 'uvs', slotName, pageName, indexed);
    }

    if (!sameVertexCount || meshEntry.trianglesRef !== slot.triangles) {
      if (
        (!indexed && !Array.isArray(slot.triangles)) ||
        slot.triangles.length < 3 ||
        slot.triangles.length % 3 !== 0
      ) {
        throw new Error(
          `PixiRenderer: slot "${slotName}" on page "${pageName}" has invalid triangles length ${Array.isArray(slot.triangles) ? slot.triangles.length : 'non-array'} (expected multiple of 3 >= 3)`,
        );
      }
      const vertexCount = numberCount(slot.vertices) / 2;
      for (let i = 0; i < slot.triangles.length; i++) {
        const idx = slot.triangles[i];
        if (!Number.isInteger(idx) || idx < 0 || idx >= vertexCount) {
          throw new Error(
            `PixiRenderer: slot "${slotName}" on page "${pageName}" has out-of-range triangle index triangles[${i}]=${String(idx)} (expected integer in 0..${vertexCount - 1})`,
          );
        }
      }
    }
    if (!indexed && (typeof slot.sequence !== 'number' || !Number.isInteger(slot.sequence))) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" has invalid sequence=${String(slot.sequence)} (expected integer)`,
      );
    }

    let texture: Texture;
    if (
      !this.alwaysReuploadGeometry &&
      meshEntry &&
      meshEntry.page === slot.page &&
      meshEntry.pma === slot.pma &&
      meshEntry.texture !== null &&
      !meshEntry.texture.destroyed
    ) {
      this.sourceFor(pageImage, slot.pma);
      texture = meshEntry.texture;
    } else {
      texture = this.pageTextureFor(pageImage, slot.page, slot.pma);
    }

    out.kind = 'mesh';
    out.poolKey = poolKey;
    out.slot = slot;
    out.texture = texture;
    out.blendMode = blendMode;
    out.color = color;
    out.alpha = alpha;
    out.darkMatrix = darkMatrix;
    out.clipPlan = clipPlan;
  }

  private sourceFor(pageImage: HTMLImageElement, pma: boolean): ImageSource {
    const desiredAlphaMode = pma ? 'premultiplied-alpha' : 'premultiply-alpha-on-upload';
    let entry = sharedPageSources.get(pageImage);
    if (!entry || entry.source.destroyed) {
      const source = new ImageSource({
        resource: pageImage,
        alphaMode: desiredAlphaMode,
        scaleMode: 'linear',
        addressMode: 'clamp-to-edge',
        autoGenerateMipmaps: false,
      });
      entry = {
        source,
        pma,
        holders: new Set<PixiRenderer>(),
      };
      sharedPageSources.set(pageImage, entry);
      livePageSources.add(source);
    } else if (entry.pma !== pma) {
      entry.pma = pma;
      entry.source.alphaMode = desiredAlphaMode;
      entry.source.update();
    }

    if (!this.retainedPages.has(pageImage)) {
      this.retainedPages.add(pageImage);
      entry.holders.add(this);
    }

    return entry.source;
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
    slot: DrawRegion,
  ): Texture {
    const blU = slot.uvs[0], blV = slot.uvs[1], ulU = slot.uvs[2], ulV = slot.uvs[3];
    const urU = slot.uvs[4], urV = slot.uvs[5], brU = slot.uvs[6], brV = slot.uvs[7];
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
 * Options for constructing a `PixiRig` display object.
 */
export interface PixiRigOptions {
  /** Borrowed-frame diagnostics; omitted keeps play's development default. */
  liveFrameChecks?: boolean;
  /** Explicit reference poser, useful when validating unsupported runtime views. */
  poser?: 'auto' | 'oracle';
  /** Initial skin name (defaults to `'default'`). */
  skin?: string;
  /** Optional initial slot filter (`only` / `hide`). */
  slots?: SlotFilter;
  /** Initial playback speed multiplier (`>= 0`, defaults to `1`). */
  timeScale?: number;
  /** Alias for `timeScale` (`>= 0`, defaults to `1`). */
  timescale?: number;
  /**
   * PixiJS `Ticker` used to advance the player automatically when `autoUpdate`
   * is enabled. Defaults to `Ticker.shared`. Pass `null` or `autoUpdate: false`
   * to step exclusively via manual `advance(dt)` / `seek(t)`.
   */
  ticker?: Ticker | null;
  /**
   * Whether to attach to `ticker` automatically when `play()` is called.
   * Defaults to `true` when `ticker !== null`.
   */
  autoUpdate?: boolean;
  /**
   * Whether to promote this rig's container into its own PixiJS `RenderGroup`
   * unconditionally. Defaults to `false` so multiple `PixiRig` instances share
   * their parent's batch.
   */
  renderGroup?: boolean;
}

/**
 * A PixiJS `Container` display object that owns a `@rig-c/play` `RigPlayer`,
 * advances it from a PixiJS `Ticker` (`play`, `advance(dt)`, `seek(t)`,
 * `timescale`), draws each posed frame through `PixiRenderer`, exposes
 * `bone(name)` and `bounds()` identically to `@rig-c/play`, and releases all
 * owned display objects, geometries, and reference-counted page `ImageSource`
 * textures on `destroy()`.
 *
 * Several `PixiRig` instances may share a single `ModelAssets` load: each
 * instance poses its own `RigPlayer` and owns its own `Sprite`s/`Mesh`es while
 * sharing the underlying page `ImageSource` GPU textures until the last
 * instance is destroyed.
 */
export class PixiRig extends Container {
  readonly assets: ModelAssets;
  readonly player: RigPlayer;
  readonly renderer: PixiRenderer;

  private ticker: Ticker | null;
  private autoUpdate: boolean;
  private tickerAttached = false;
  private lastDrawnFrame: PosedFrame | null = null;
  private readonly retainedRuntimeFrame = new RetainedRuntimeFrame();
  private readonly snapshotSeed = (): PosedFrame => this.player.posedFrame();
  private rigDestroyed = false;

  constructor(assets: ModelAssets, options: PixiRigOptions = {}) {
    super();

    if (
      !assets ||
      typeof assets !== 'object' ||
      !assets.document ||
      typeof assets.document !== 'object' ||
      !(assets.pageImages instanceof Map)
    ) {
      throw new Error(
        'PixiRig: invalid assets argument (expected ModelAssets with document and pageImages Map)',
      );
    }

    const rawScale = options.timescale ?? options.timeScale;
    if (
      rawScale !== undefined &&
      (typeof rawScale !== 'number' || !Number.isFinite(rawScale) || rawScale < 0)
    ) {
      throw new Error(
        `PixiRig: invalid timescale=${String(rawScale)} (expected finite number >= 0)`,
      );
    }
    if (options.renderGroup !== undefined && typeof options.renderGroup !== 'boolean') {
      throw new Error(
        `PixiRig: invalid renderGroup=${String(options.renderGroup)} (expected boolean)`,
      );
    }

    this.assets = assets;
    const host = document.createElement('div');
    const mode = assets.regions === 'none' ? 'canvas' : 'dom';
    this.player = new RigPlayer(host, assets, {
      mode,
      skin: options.skin,
      slots: options.slots,
      liveFrameChecks: options.liveFrameChecks,
      poser: options.poser,
    });
    if (rawScale !== undefined) {
      this.player.timeScale = rawScale;
    }

    this.renderer = new PixiRenderer(this, assets);
    this.renderer.liveFrameChecks = options.liveFrameChecks ?? false;
    if (options.renderGroup === true) {
      this.renderer.useRenderGroup = true;
    }
    this.ticker = options.ticker === undefined ? Ticker.shared : options.ticker;
    this.autoUpdate = options.autoUpdate ?? this.ticker !== null;

    // Render the initial setup pose into this container immediately.
    const initialFrame = this.player.posedFrame();
    this.lastDrawnFrame = initialFrame;
    this.renderer.render(initialFrame);

    if (this.autoUpdate && this.ticker) {
      this.attachTicker();
    }
  }

  private readonly onTick = (ticker: Ticker): void => {
    if (this.rigDestroyed) return;
    this.advance(ticker.deltaMS / 1000);
  };

  private ensureActive(method: string): void {
    if (this.rigDestroyed) {
      throw new Error(`PixiRig: cannot call ${method}() on a destroyed PixiRig`);
    }
  }

  private attachTicker(): void {
    if (this.tickerAttached || !this.ticker || this.rigDestroyed) return;
    this.ticker.add(this.onTick);
    this.tickerAttached = true;
  }

  private detachTicker(): void {
    if (!this.tickerAttached || !this.ticker) return;
    this.ticker.remove(this.onTick);
    this.tickerAttached = false;
  }

  /**
   * Starts playing animation `name` (with optional `loop`, `track`, `mix`,
   * `alpha`, `additive`), draws the initial frame of the animation immediately,
   * and attaches to the configured `Ticker` if `autoUpdate` is enabled.
   */
  play(name: string, options: PlayOptions = {}): void {
    this.ensureActive('play');
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        `PixiRig: invalid animation name ${String(name)} in play(name) (expected non-empty string)`,
      );
    }
    this.player.play(name, options);
    this.drawCurrent();
    if (this.autoUpdate && this.ticker) {
      this.attachTicker();
    }
  }

  /**
   * Advances the underlying `RigPlayer` by `dt` seconds (`dt * timescale`) and
   * draws the resulting `PosedFrame` through `this.renderer`.
   */
  advance(dt: number): void {
    this.ensureActive('advance');
    if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) {
      throw new Error(
        `PixiRig: invalid dt=${String(dt)} in advance(dt) (expected finite number >= 0)`,
      );
    }
    this.player.advance(dt);
    this.drawCurrent();
  }

  /**
   * Seeks the current animation to `time` seconds and draws the resulting
   * `PosedFrame` through `this.renderer`.
   */
  seek(time: number): void {
    this.ensureActive('seek');
    if (typeof time !== 'number' || !Number.isFinite(time)) {
      throw new Error(
        `PixiRig: invalid time=${String(time)} in seek(time) (expected finite number)`,
      );
    }
    this.player.seek(time);
    this.drawCurrent();
  }

  /**
   * Reads the current `PosedFrame` from `this.player.posedFrame()` and renders
   * it into `this` container via `this.renderer.render(frame)`.
   */
  draw(): PosedFrame {
    this.ensureActive('draw');
    const frame = this.player.posedFrame();
    this.lastDrawnFrame = frame;
    this.renderer.render(frame);
    return frame;
  }

  /**
   * Submit a snapshot or a current lease from this.player synchronously.
   * This is the draw half for hosts that time advance/acquisition separately.
   */
  renderFrame(frame: PosedFrame | LiveFrame): void {
    this.ensureActive('renderFrame');
    if ('order' in frame) {
      this.renderer.render(frame);
      this.lastDrawnFrame = frame;
      return;
    }
    if (frame.generation !== this.player.generation) {
      throw new Error(`PixiRig: live frame generation ${frame.generation} needs current player generation ${this.player.generation}`);
    }
    if (this.player.poser !== 'runtime') {
      // Live metadata omits sequence and full draw-order z. Keep the exact
      // oracle snapshot rather than fabricate either field for retained reads.
      this.renderFrame(this.player.posedFrame());
      return;
    }
    this.renderer.render(frame);
    this.retainedRuntimeFrame.capture(frame, this.snapshotSeed);
    this.lastDrawnFrame = null;
  }

  private drawCurrent(): void {
    this.renderFrame(this.player.poser === 'runtime' ? this.player.liveFrame() : this.player.posedFrame());
  }

  /**
   * Returns the detached most recently drawn record. A lease draw materializes
   * it on demand from saved Float64 values, even after direct player mutation.
   */
  drawnFrame(): PosedFrame {
    this.ensureActive('drawnFrame');
    return this.lastDrawnFrame ??= this.retainedRuntimeFrame.snapshot();
  }

  /**
   * Delegates to `this.player.posedFrame(slots)` without modifying the pose.
   */
  posedFrame(slots?: SlotFilter | null): PosedFrame {
    this.ensureActive('posedFrame');
    if (slots === undefined) {
      return this.player.posedFrame();
    }
    return this.player.posedFrame(slots);
  }

  /**
   * Reads the world-space transform (`BoneWorld`) of bone `name`, throwing by
   * name if `name` does not exist on the rig.
   */
  bone(name: string): BoneWorld {
    this.ensureActive('bone');
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        `PixiRig: invalid bone name ${String(name)} in bone(name) (expected non-empty string)`,
      );
    }
    return this.player.bone(name);
  }

  /**
   * Computes the world-space axis-aligned bounding box (`PoseBounds | null`)
   * for the current frame and slot filter, identical to `RigPlayer.bounds()`.
   */
  bounds(): PoseBounds | null {
    this.ensureActive('bounds');
    return this.player.bounds();
  }

  /** Current playback time in seconds on track 0. */
  get time(): number {
    return this.player.time;
  }

  /** Currently playing animation name on track 0, or `null` if none. */
  get current(): string | null {
    return this.player.current;
  }

  /** Playback speed multiplier (`>= 0`). `0` holds the current frame. */
  get timescale(): number {
    return this.player.timeScale;
  }

  set timescale(value: number) {
    this.ensureActive('timescale');
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(
        `PixiRig: invalid timescale=${String(value)} (expected finite number >= 0)`,
      );
    }
    this.player.timeScale = value;
  }

  /** Alias for `timescale` matching `RigPlayer.timeScale`. */
  get timeScale(): number {
    return this.player.timeScale;
  }

  set timeScale(value: number) {
    this.timescale = value;
  }

  /** Active skin name, or `undefined` when no skin is set. Setting re-poses and re-draws immediately. */
  get skin(): string | undefined {
    return this.player.skin;
  }

  set skin(name: string | undefined) {
    this.ensureActive('skin');
    this.player.skin = name;
    this.drawCurrent();
  }

  /** Active slot filter (`SlotFilter | null`). Setting re-draws immediately. */
  get slots(): SlotFilter | null {
    return this.player.slots;
  }

  set slots(filter: SlotFilter | null) {
    this.ensureActive('slots');
    this.player.slots = filter;
    this.drawCurrent();
  }

  /** Whole-skeleton tint multiplier `[r, g, b, a]`. Setting re-draws immediately. */
  get color(): [number, number, number, number] {
    return this.player.color;
  }

  set color(rgba: [number, number, number, number]) {
    this.ensureActive('color');
    this.player.color = rgba;
    this.drawCurrent();
  }

  /** Per-pose bone adjustment callback (`BoneAdjust | null`). Setting re-poses and re-draws immediately. */
  get adjust(): BoneAdjust | null {
    return this.player.adjust;
  }

  set adjust(fn: BoneAdjust | null) {
    this.ensureActive('adjust');
    this.player.adjust = fn;
    this.drawCurrent();
  }

  /** Whether the underlying `RigPlayer` is on the composed multi-track mixer. */
  get composed(): boolean {
    this.ensureActive('composed');
    return this.player.composed;
  }

  /** Re-runs the pose pipeline at the current state and re-draws. */
  repose(): void {
    this.ensureActive('repose');
    this.player.repose();
    this.drawCurrent();
  }

  /** Pauses playback on the underlying `RigPlayer`. */
  pause(): void {
    this.ensureActive('pause');
    this.player.pause();
  }

  /** Resumes playback on the underlying `RigPlayer`. */
  resume(): void {
    this.ensureActive('resume');
    this.player.resume();
  }

  /** Queues an animation on a track. */
  queue(name: string, options?: QueueOptions): void {
    this.ensureActive('queue');
    this.player.queue(name, options);
  }

  /** Clears a track (or track 0 when `track` is omitted) and re-draws. */
  clear(track?: number, options?: { mix?: number }): void {
    this.ensureActive('clear');
    this.player.clear(track, options);
    this.drawCurrent();
  }

  /** Queues a track clear with optional `mix` and `delay`. */
  queueClear(track?: number, options?: { mix?: number; delay?: number }): void {
    this.ensureActive('queueClear');
    this.player.queueClear(track, options);
  }

  /** Sets the alpha blend weight on `track` and re-draws. */
  setAlpha(track: number, alpha: number): void {
    this.ensureActive('setAlpha');
    this.player.setAlpha(track, alpha);
    this.drawCurrent();
  }

  /** Inspects the current track entry on `track` (defaults to `0`). */
  entry(track?: number): TrackEntry | null {
    this.ensureActive('entry');
    return this.player.entry(track);
  }

  /** Sets or clears physics environment parameters (`wind`, `gravity`) and re-draws. */
  environment(patch?: Partial<RigEnvironment> | null): RigEnvironment {
    this.ensureActive('environment');
    const env = this.player.environment(patch);
    this.drawCurrent();
    return env;
  }

  /** Notifies the rig's physics of whole-rig world translation or rotation. */
  moved(motion: { x?: number; y?: number; rotation?: number }): void {
    this.ensureActive('moved');
    this.player.moved(motion);
  }

  /** Subscribes to `RigPlayer` `'event'` or `'complete'` callbacks; returns an unsubscribe function. */
  onRigEvent(type: 'event', listener: (payload: RigEvent) => void): () => void;
  onRigEvent(type: 'complete', listener: (payload: RigComplete) => void): () => void;
  onRigEvent(
    type: 'event' | 'complete',
    listener: ((payload: RigEvent) => void) | ((payload: RigComplete) => void),
  ): () => void {
    this.ensureActive('onRigEvent');
    if (type === 'event') {
      return this.player.on('event', listener as (payload: RigEvent) => void);
    }
    return this.player.on('complete', listener as (payload: RigComplete) => void);
  }

  /**
   * Returns a snapshot of the display objects, geometries, texture views, and
   * shared page textures currently owned or retained by this `PixiRig`.
   */
  resourceCounts(): PixiRigResourceCounts {
    return this.renderer.resourceCounts();
  }

  /**
   * Detaches from `Ticker`, disposes `this.renderer` and `this.player`
   * (releasing owned `Sprite`s, `Mesh`es, `MeshGeometry`s, `Graphics` masks,
   * `ColorMatrixFilter`s, `Texture` views, and decrementing shared page
   * `ImageSource` reference counts), and destroys this PixiJS `Container`.
   * Idempotent.
   */
  override destroy(options?: DestroyOptions): void {
    if (this.rigDestroyed) return;
    this.rigDestroyed = true;
    this.detachTicker();
    this.renderer.dispose();
    this.player.dispose();
    super.destroy(options);
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
