import { clamp01 } from '@rig-c/adapters-shared';
import type { BlendMode, ModelAssets, PosedFrame, PosedClip, PosedSlot } from '@rig-c/play';
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

let rendererId = 0;

/** The actual native scene object, including its inspectable GPU wrappers. */
export type PhaserRegionView = SlotView;

/** Native PosedFrame drawing. The caller owns its container, scene and assets. */
export class PhaserRenderer {
  private readonly prefix = `rigc-phaser-${++rendererId}-`;
  private readonly textures = new Map<string, string>();
  private readonly views = new Map<string, SlotView>();
  private readonly submitter: FrameSubmitter;
  private readonly blendModes: Record<BlendMode, number>;
  private readonly native: Phaser.Renderer.WebGL.WebGLRenderer;
  private clips: Array<ClipPair & { key: string }> = [];
  private disposed = false;
  private accepted: PosedFrame | null = null;
  get drawnFrame(): PosedFrame | null { return this.accepted; }
  get alwaysReuploadGeometry(): boolean { return this.submitter.alwaysReuploadGeometry; }
  set alwaysReuploadGeometry(value: boolean) { this.submitter.alwaysReuploadGeometry = value; }

  constructor(readonly container: Phaser.GameObjects.Container, readonly assets: ModelAssets) {
    const native = container.scene.sys.game.renderer;
    if (!(native instanceof Phaser.Renderer.WebGL.WebGLRenderer)) throw new Error('PhaserRenderer: scene renderer must be Phaser WebGLRenderer (found Canvas or HEADLESS)');
    this.native = native;
    this.submitter = new FrameSubmitter(native);
    this.blendModes = blendModesFor(native);
  }

  private pageTextureFor(slot: PosedSlot): string {
    const identity = `${slot.page}\u0000${slot.pma}`;
    let key = this.textures.get(identity);
    if (!key) {
      key = this.prefix + this.textures.size;
      const image = this.assets.pageImages.get(slot.page)!;
      const gl = this.native.gl;
      // Posed pma means already multiplied; native pma means multiply on upload.
      const wrapper = this.native.createTexture2D(0, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.RGBA, image, image.naturalWidth, image.naturalHeight, !slot.pma, false, true);
      const texture = this.container.scene.textures.addGLTexture(key, wrapper);
      if (!texture) { this.native.deleteTexture(wrapper); throw new Error(`PhaserRenderer: slot "${slot.slot}" page "${slot.page}" could not register texture "${key}"`); }
      texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
      this.textures.set(identity, key);
    }
    return key;
  }

  render(frame: PosedFrame): void {
    if (this.disposed) throw new Error('PhaserRenderer: render called after dispose (expected a live renderer)');
    if (!frame || !Array.isArray(frame.order)) throw new Error('PhaserRenderer: invalid frame.order (expected PosedFrame array)');
    const names = new Set<string>(), plans = new Map<PosedClip, Phaser.Math.Vector2[]>();
    // Refuse malformed data before touching the previous accepted scene.
    for (const slot of frame.order) {
      const detail = `PhaserRenderer: slot "${slot.slot}" on page "${slot.page}"`;
      if (names.has(slot.slot)) throw new Error(`${detail} repeats a slot name (expected unique names)`);
      names.add(slot.slot);
      if (slot.kind !== 'region' && slot.kind !== 'mesh') throw new Error(`${detail} has unsupported kind "${String((slot as {kind:unknown}).kind)}" (expected region or mesh)`);
      if (typeof slot.pma !== 'boolean') throw new Error(`${detail} has invalid pma=${String(slot.pma)} (expected boolean)`);
      if (!this.assets.pageImages.has(slot.page)) throw new Error(`${detail} is missing from assets.pageImages (expected loaded page)`);
      const coords = slot.kind === 'region' ? slot.corners : slot.vertices;
      if (!Array.isArray(coords) || coords.length < 6 || coords.length % 2 !== 0 || (slot.kind === 'region' && coords.length !== 8)) throw new Error(`${detail} has invalid geometry (expected four region corners or finite mesh x/y pairs)`);
      if (coords.length / 2 > 65535) throw new Error(`${detail} has ${coords.length / 2} vertices (expected at most 65535 (maximum index 65534; 65535 is primitive restart) for native UNSIGNED_SHORT elements)`);
      for (const [field, values, length] of [['vertices', coords, coords.length], ['uvs', slot.uvs, coords.length], ['tint', slot.tint, 4], ...(slot.dark !== undefined ? [['dark', slot.dark, 3] as const] : [])] as const) {
        if (!Array.isArray(values) || values.length !== length) throw new Error(`${detail} has invalid ${field} length ${values?.length} (expected ${length})`);
        for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) throw new Error(`${detail} has non-finite ${field}[${i}]=${values[i]} (expected finite number)`);
      }
      if (slot.kind === 'mesh') {
        if (!Array.isArray(slot.triangles) || slot.triangles.length < 3 || slot.triangles.length % 3 !== 0) throw new Error(`${detail} has invalid triangles (expected index triples)`);
        for (const index of slot.triangles) if (!Number.isInteger(index) || index < 0 || index >= coords.length / 2) throw new Error(`${detail} has triangle index ${index} (expected integer in 0..${coords.length / 2 - 1})`);
      }
      if (!Object.hasOwn(BLEND_PHASER, slot.blend)) throw new Error(`${detail} has unsupported blend "${slot.blend}" (expected Normal, Additive, Multiply or Screen)`);
      if (slot.clip !== undefined && !plans.has(slot.clip)) {
        if (!this.native.gl.getContextAttributes()?.stencil) throw new Error(`${detail} requires stencil storage (expected WebGL stencil enabled)`);
        plans.set(slot.clip, clipPoints(slot.clip, detail));
      }
    }
    this.native.renderNodes.finishBatch();
    const previousClips = this.clips; this.clips = [];
    const place = (view: Phaser.GameObjects.GameObject) => { if (view.parentContainer === this.container) this.container.bringToTop(view); else this.container.add(view); };
    for (const [name, view] of this.views) if (!names.has(name)) { this.submitter.remove(view); view.destroy(); this.views.delete(name); }
    let activeKey: string | undefined, pair: ClipPair | undefined;
    for (const slot of frame.order) {
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
      const vertices: number[] = [];
      for (let i = 0; i < coords.length; i += 2) vertices.push(coords[i], -coords[i + 1], slot.uvs[i], slot.uvs[i + 1]);
      const triangles = slot.kind === 'region' ? [0, 1, 2, 0, 2, 3] : slot.triangles;
      const indices = triangles.flatMap((_, i) => i % 3 === 0 ? [...triangles.slice(i, i + 3), 0] : []);
      const key = this.pageTextureFor(slot);
      let view = this.views.get(slot.slot);
      if (!view) {
        view = new Phaser.GameObjects.Mesh2D(this.container.scene, 0, 0, key, vertices, indices, true) as SlotView;
        view.setName(slot.slot).setOrigin(0, 0);
        if (slot.kind === 'region') view.buildOrderedIndices(2, true);
        view.vertexRoundMode = 'off'; view.setRenderNodeRole('Submitter', this.submitter);
        this.views.set(slot.slot, view);
      } else { view.setTexture(key); view.vertices = vertices; view.indices = indices; }
      view.posedSlot = slot;
      const tint = tintToPhaser(slot.tint); view.tint = tint.color;
      view.setAlpha(tint.alpha).setBlendMode(this.blendModes[slot.blend] as Phaser.BlendModes);
      if (view.parentContainer === this.container) this.container.bringToTop(view); else this.container.add(view);
    }
    if (pair) place(pair.close);
    for (const stale of previousClips.slice(this.clips.length)) { stale.close.destroy(); stale.open.destroy(); }
    this.accepted = frame;
  }

  dispose(): void {
    if (this.disposed) return;
    this.native.renderNodes.finishBatch();
    for (const pair of this.clips) { pair.close.destroy(); pair.open.destroy(); } this.clips = [];
    for (const view of this.views.values()) { this.submitter.remove(view); view.destroy(); } this.views.clear();
    this.submitter.dispose();
    for (const key of this.textures.values()) this.container.scene.textures.remove(key);
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
