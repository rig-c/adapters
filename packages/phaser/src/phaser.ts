import { retainPage, releasePage, type RetainedPage } from './pages.ts';
import {
  clamp01,
  type DrawClip,
  type DrawNumbers,
  type DrawSlot,
  isImmutableSpan,
  LiveDrawViews,
  numberCount,
  numberOffset,
  numberSource,
  RetainedRuntimeFrame,
} from '@rig-c/adapters-shared';
import type { BlendMode, LiveFrame, ModelAssets, PosedClip, PosedFrame, PosedSlot } from '@rig-c/play';
import { FrameSubmitter, type SlotView } from './mesh.ts';
import { clipPoints, createClipPair, type ClipPair } from './clip.ts';
import Phaser from 'phaser';

/**
 * PosedFrame's premultiplied-output factors: srcRGB, dstRGB, srcAlpha, dstAlpha.
 * GL constants: ONE=1, ONE_MINUS_SRC_ALPHA=771, DST_COLOR=774,
 * ONE_MINUS_SRC_COLOR=769. Phaser's ADD preset uses DST_ALPHA for destination
 * instead of ONE; MULTIPLY uses DST_COLOR for source alpha instead of ONE.
 * Reuse a native preset only when its four factors match this contract.
 */
export const BLEND_PHASER: Readonly<Record<BlendMode, readonly [number, number, number, number]>> = {
  Normal: [1, 771, 1, 771],
  Additive: [1, 1, 1, 1],
  Multiply: [774, 771, 1, 771],
  Screen: [1, 769, 1, 769],
};

const engineBlendModes = new WeakMap<Phaser.Renderer.WebGL.WebGLRenderer, Record<BlendMode, number>>();
function blendModesFor(renderer: Phaser.Renderer.WebGL.WebGLRenderer): Record<BlendMode, number> {
  const cached = engineBlendModes.get(renderer);
  if (cached) return cached;
  const presets: Record<BlendMode, number> = { Normal: Phaser.BlendModes.NORMAL, Additive: Phaser.BlendModes.ADD, Multiply: Phaser.BlendModes.MULTIPLY, Screen: Phaser.BlendModes.SCREEN };
  const modes = { ...presets };
  for (const blend of Object.keys(presets) as BlendMode[]) {
    const factors = [...BLEND_PHASER[blend]];
    const preset = renderer.blendModes[presets[blend]].func;
    if (JSON.stringify(preset) === JSON.stringify(factors)) continue;
    // In 4.2.1 addBlendMode's returned index precedes its appended entry. Read
    // the actual new slot, verify it, and use updateBlendMode for four factors.
    const index = renderer.blendModes.length;
    renderer.addBlendMode(factors, renderer.gl.FUNC_ADD);
    renderer.updateBlendMode(index, factors, renderer.gl.FUNC_ADD);
    if (renderer.blendModes.length !== index + 1 || JSON.stringify(renderer.blendModes[index].func) !== JSON.stringify(factors)) {
      throw new Error(`PhaserRenderer: blend "${blend}" registration at ${index} did not retain factors ${factors.join(',')} (expected native four-factor mode)`);
    }
    modes[blend] = index;
  }
  // Modes belong to the engine, not a rig: removing one would splice indices
  // used by other scene objects. One registry per engine lives until teardown.
  engineBlendModes.set(renderer, modes);
  return modes;
}

/** Phaser's native tint is RGB8; opacity remains the object's scalar alpha. */
export function tintToPhaser(tint: readonly [number, number, number, number]): { color: number; alpha: number } {
  const [r, g, b] = tint.map((value) => Math.round(clamp01(value) * 255));
  return { color: (r << 16) | (g << 8) | b, alpha: clamp01(tint[3]) };
}

/** The actual native scene object, including its inspectable GPU wrappers. */
export type PhaserRegionView = SlotView;

function assertFiniteValues(values: DrawNumbers, expectedLength: number, field: string, detail: string, indexed: boolean): void {
  const source = numberSource(values), offset = numberOffset(values), count = numberCount(values);
  if ((!indexed && !Array.isArray(values)) || count !== expectedLength) {
    const actualLength = Array.isArray(values) || indexed ? count : undefined;
    throw new Error(`${detail} has invalid ${field} length ${actualLength} (expected ${expectedLength})`);
  }
  for (let i = 0; i < count; i++) {
    const value = source[offset + i];
    if (!Number.isFinite(value)) throw new Error(`${detail} has non-finite ${field}[${i}]=${value} (expected finite number)`);
  }
}

/** Native PosedFrame drawing. The caller owns its container, scene and assets. */
export class PhaserRenderer {
  private readonly textures = new Map<string, RetainedPage>();
  private readonly views = new Map<string, SlotView>();
  private readonly submitter: FrameSubmitter;
  private readonly blendModes: Record<BlendMode, number>;
  private readonly native: Phaser.Renderer.WebGL.WebGLRenderer;
  private readonly liveViews = new LiveDrawViews('PhaserRenderer');
  private readonly retainedRuntimeFrame = new RetainedRuntimeFrame('PhaserRenderer');
  private clips: Array<ClipPair & { key: string }> = [];
  private disposed = false;
  private accepted: PosedFrame | null = null;
  private hasRetained = false;
  get drawnFrame(): PosedFrame | null {
    if (this.accepted) return this.accepted;
    if (!this.hasRetained) return null;
    this.accepted = this.retainedRuntimeFrame.snapshot();
    return this.accepted;
  }
  get alwaysReuploadGeometry(): boolean { return this.submitter.alwaysReuploadGeometry; }
  set alwaysReuploadGeometry(value: boolean) { this.submitter.alwaysReuploadGeometry = value; }

  constructor(readonly container: Phaser.GameObjects.Container, readonly assets: ModelAssets) {
    const native = container.scene.sys.game.renderer;
    if (!(native instanceof Phaser.Renderer.WebGL.WebGLRenderer)) throw new Error('PhaserRenderer: scene renderer must be Phaser WebGLRenderer (found Canvas or HEADLESS)');
    this.native = native;
    this.submitter = new FrameSubmitter(native);
    this.blendModes = blendModesFor(native);
  }

  private pageTextureFor(slot: PosedSlot | DrawSlot): string {
    const identity = `${slot.page}\u0000${slot.pma}`;
    let entry = this.textures.get(identity);
    if (!entry) {
      entry = retainPage(this.native, this.container.scene.textures, this.assets.pageImages.get(slot.page)!, slot.pma, this);
      this.textures.set(identity, entry);
    }
    return entry.texture.key;
  }

  render(frame: PosedFrame | LiveFrame): void {
    if (this.disposed) throw new Error('PhaserRenderer: render called after dispose (expected a live renderer)');
    if (!frame || typeof frame !== 'object') throw new Error('PhaserRenderer: invalid frame.order (expected PosedFrame array)');
    if ('order' in frame) {
      if (!Array.isArray(frame.order)) throw new Error('PhaserRenderer: invalid frame.order (expected PosedFrame array)');
      this.renderOrder(frame.order, false);
      this.accepted = frame;
      this.hasRetained = false;
      return;
    }
    try {
      this.renderOrder(this.liveViews.read(frame), true);
      this.retainedRuntimeFrame.capture(frame);
      this.accepted = null;
      this.hasRetained = true;
    } finally {
      this.liveViews.release();
    }
  }

  private renderOrder(order: readonly (PosedSlot | DrawSlot)[], indexed: boolean): void {
    const names = new Set<string>(), plans = new Map<PosedClip | DrawClip, Phaser.Math.Vector2[]>();
    // Refuse malformed data before touching the previous accepted scene.
    for (const slot of order) {
      const detail = `PhaserRenderer: slot "${slot.slot}" on page "${slot.page}"`;
      if (names.has(slot.slot)) throw new Error(`${detail} repeats a slot name (expected unique names)`);
      names.add(slot.slot);
      if (slot.kind !== 'region' && slot.kind !== 'mesh') throw new Error(`${detail} has unsupported kind "${String((slot as {kind:unknown}).kind)}" (expected region or mesh)`);
      if (typeof slot.pma !== 'boolean') throw new Error(`${detail} has invalid pma=${String(slot.pma)} (expected boolean)`);
      if (!this.assets.pageImages.has(slot.page)) throw new Error(`${detail} is missing from assets.pageImages (expected loaded page)`);
      const coords = slot.kind === 'region' ? slot.corners : slot.vertices;
      const coordCount = numberCount(coords);
      if ((!indexed && !Array.isArray(coords)) || coordCount < 6 || coordCount % 2 !== 0 || (slot.kind === 'region' && coordCount !== 8)) throw new Error(`${detail} has invalid geometry (expected four region corners or finite mesh x/y pairs)`);
      if (coordCount / 2 > 65535) throw new Error(`${detail} has ${coordCount / 2} vertices (expected at most 65535 (maximum index 65534; 65535 is primitive restart) for native UNSIGNED_SHORT elements)`);
      assertFiniteValues(coords, coordCount, 'vertices', detail, indexed);
      const priorView = this.views.get(slot.slot);
      const priorBuffers = priorView?.slotBuffers;
      const sameVertexCount = !this.alwaysReuploadGeometry && priorView !== undefined && priorView.vertices.length === coordCount * 2;
      if (!sameVertexCount || !isImmutableSpan(slot.uvs, indexed) || priorBuffers?.uvs !== slot.uvs) {
        assertFiniteValues(slot.uvs, coordCount, 'uvs', detail, indexed);
      }
      assertFiniteValues(slot.tint, 4, 'tint', detail, indexed);
      if (slot.dark !== undefined) assertFiniteValues(slot.dark, 3, 'dark', detail, indexed);
      if (slot.kind === 'mesh') {
        if (!sameVertexCount || !isImmutableSpan(slot.triangles, indexed) || priorBuffers?.triangles !== slot.triangles) {
          if ((!indexed && !Array.isArray(slot.triangles)) || slot.triangles.length < 3 || slot.triangles.length % 3 !== 0) throw new Error(`${detail} has invalid triangles (expected index triples)`);
          for (let i = 0; i < slot.triangles.length; i++) {
            const index = slot.triangles[i];
            if (!Number.isInteger(index) || index < 0 || index >= coordCount / 2) throw new Error(`${detail} has triangle index ${index} (expected integer in 0..${coordCount / 2 - 1})`);
          }
        }
      }
      if (!Object.hasOwn(BLEND_PHASER, slot.blend)) throw new Error(`${detail} has unsupported blend "${slot.blend}" (expected Normal, Additive, Multiply or Screen)`);
      if (slot.clip !== undefined && !plans.has(slot.clip)) {
        if (!this.native.gl.getContextAttributes()?.stencil) throw new Error(`${detail} requires stencil storage (expected WebGL stencil enabled)`);
        plans.set(slot.clip, clipPoints(slot.clip, detail, indexed));
      }
    }
    this.native.renderNodes.finishBatch();
    const previousClips = this.clips; this.clips = [];
    const place = (view: Phaser.GameObjects.GameObject) => { if (view.parentContainer === this.container) this.container.bringToTop(view); else this.container.add(view); };
    for (const [name, view] of this.views) if (!names.has(name)) { this.submitter.remove(view); view.destroy(); this.views.delete(name); }
    let activeKey: string | undefined, pair: ClipPair | undefined;
    for (const slot of order) {
      const points = slot.clip ? plans.get(slot.clip)! : undefined;
      const keyForClip = slot.clip ? JSON.stringify([slot.clip.inverse, points!.map((p) => [p.x, p.y])]) : undefined;
      if (keyForClip !== activeKey) {
        if (pair) place(pair.close);
        activeKey = keyForClip; pair = undefined;
        if (slot.clip) {
          const key = keyForClip!;
          const prior = previousClips[this.clips.length];
          const cached = prior?.key === key ? prior : { ...createClipPair(this.container.scene, slot.clip, points!), key };
          if (prior && cached !== prior) { prior.close.destroy(); prior.open.destroy(); }
          pair = cached; this.clips.push(cached); place(pair.open);
        }
      }
      const coords = slot.kind === 'region' ? slot.corners : slot.vertices;
      const coordSource = numberSource(coords), coordOffset = numberOffset(coords), coordCount = numberCount(coords);
      const key = this.pageTextureFor(slot);
      let view = this.views.get(slot.slot);
      if (!view) {
        const vertices: number[] = new Array<number>(coordCount * 2);
        for (let i = 0; i < coordCount; i += 2) {
          const base = i * 2;
          vertices[base] = coordSource[coordOffset + i];
          vertices[base + 1] = -coordSource[coordOffset + i + 1];
          vertices[base + 2] = slot.uvs[i];
          vertices[base + 3] = slot.uvs[i + 1];
        }
        const triangles = slot.kind === 'region' ? [0, 1, 2, 0, 2, 3] : slot.triangles;
        const indices: number[] = [];
        for (let i = 0; i < triangles.length; i += 3) indices.push(triangles[i], triangles[i + 1], triangles[i + 2], 0);
        view = new Phaser.GameObjects.Mesh2D(this.container.scene, 0, 0, key, vertices, indices, true) as SlotView;
        view.setName(slot.slot).setOrigin(0, 0);
        if (slot.kind === 'region') view.buildOrderedIndices(2, true);
        view.vertexRoundMode = 'off'; view.setRenderNodeRole('Submitter', this.submitter);
        this.views.set(slot.slot, view);
      } else {
        if (view.texture.key !== key) view.setTexture(key);
        const uvChanged = view.slotBuffers?.uvs !== slot.uvs;
        if (view.vertices.length !== coordCount * 2) {
          const vertices: number[] = new Array<number>(coordCount * 2);
          for (let i = 0; i < coordCount; i += 2) {
            const base = i * 2;
            vertices[base] = coordSource[coordOffset + i];
            vertices[base + 1] = -coordSource[coordOffset + i + 1];
            vertices[base + 2] = slot.uvs[i];
            vertices[base + 3] = slot.uvs[i + 1];
          }
          view.vertices = vertices;
        } else {
          const vertices = view.vertices;
          for (let i = 0; i < coordCount; i += 2) {
            const base = i * 2;
            vertices[base] = coordSource[coordOffset + i];
            vertices[base + 1] = -coordSource[coordOffset + i + 1];
            if (uvChanged) {
              vertices[base + 2] = slot.uvs[i];
              vertices[base + 3] = slot.uvs[i + 1];
            }
          }
        }
        const triangles = slot.kind === 'region' ? [0, 1, 2, 0, 2, 3] : slot.triangles;
        if (view.slotBuffers?.triangles !== triangles) {
          const indices: number[] = [];
          for (let i = 0; i < triangles.length; i += 3) indices.push(triangles[i], triangles[i + 1], triangles[i + 2], 0);
          view.indices = indices;
        }
      }
      const tintSource = numberSource(slot.tint), tintOffset = numberOffset(slot.tint);
      const tintTuple: [number, number, number, number] = [
        tintSource[tintOffset + 0],
        tintSource[tintOffset + 1],
        tintSource[tintOffset + 2],
        tintSource[tintOffset + 3],
      ];
      view.slotLight = [tintTuple[0], tintTuple[1], tintTuple[2]];
      view.slotDark = slot.dark ? [slot.dark[0], slot.dark[1], slot.dark[2]] : [0, 0, 0];
      if (!indexed) {
        view.posedSlot = slot as PosedSlot;
      } else {
        const prior = view.posedSlot as Partial<PosedSlot> | undefined;
        if (!prior || prior.slot !== slot.slot || prior.page !== slot.page || prior.pma !== slot.pma || prior.kind !== slot.kind || prior.blend !== slot.blend) {
          view.posedSlot = (slot.kind === 'region'
            ? { kind: 'region', slot: slot.slot, z: 0, page: slot.page, region: slot.region, pma: slot.pma, blend: slot.blend, corners: [], uvs: [], tint: tintTuple }
            : { kind: 'mesh', slot: slot.slot, z: 0, page: slot.page, pma: slot.pma, blend: slot.blend, vertices: [], uvs: [], triangles: [], sequence: 0, tint: tintTuple }) as PosedSlot;
        }
      }
      this.submitter.syncBuffers(view, slot);
      const tint = tintToPhaser(tintTuple); view.tint = tint.color;
      view.setAlpha(tint.alpha).setBlendMode(this.blendModes[slot.blend] as Phaser.BlendModes);
      if (view.parentContainer === this.container) this.container.bringToTop(view); else this.container.add(view);
    }
    if (pair) place(pair.close);
    for (const stale of previousClips.slice(this.clips.length)) { stale.close.destroy(); stale.open.destroy(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.native.renderNodes.finishBatch();
    for (const pair of this.clips) { pair.close.destroy(); pair.open.destroy(); } this.clips = [];
    for (const view of this.views.values()) { this.submitter.remove(view); view.destroy(); } this.views.clear();
    this.submitter.dispose();
    for (const entry of new Set(this.textures.values())) releasePage(this.native, this.container.scene.textures, entry, this);
    this.textures.clear(); this.accepted = null; this.disposed = true;
  }
}

/** Read native Mesh2D vertices through its native Float32 world matrix. */
export function readRegionScreenCorners(view: Phaser.GameObjects.Mesh2D): number[] {
  const matrix = view.getWorldTransformMatrix();
  const result: number[] = [];
  for (let i = 0; i < view.vertices.length; i += 4) {
    const point = matrix.transformPoint(view.vertices[i], view.vertices[i + 1]);
    result.push(point.x, point.y);
  }
  return result;
}
