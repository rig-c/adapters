import { clamp01 } from '@rig-c/adapters-shared';
import type { BlendMode, ModelAssets, PosedFrame, PosedRegion } from '@rig-c/play';
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

/** Phaser 4.2.1 implements tint but omits it from its Mesh2D declaration. */
export interface PhaserRegionView extends Phaser.GameObjects.Mesh2D { tint: number }

/**
 * Keep each page's submission isolated from unrelated Phaser texture batches.
 * This uses native submission/draw hooks, owns no GPU buffers, and changes no
 * renderer-global texture limits. Completing the incoming batch also preserves
 * ordinary scene objects placed before or after the rig.
 */
class RegionSubmitter extends Phaser.Renderer.WebGL.RenderNodes.SubmitterMeshToQuad {
  override onRunBegin(context: Phaser.Renderer.WebGL.DrawingContext): void {
    this.manager.finishBatch();
    super.onRunBegin(context);
  }
  override onRunEnd(context: Phaser.Renderer.WebGL.DrawingContext): void {
    this.manager.finishBatch();
    super.onRunEnd(context);
  }
}

/**
 * Draws region-only PosedFrames using native Phaser 4 Mesh2D objects.
 * The supplied container maps (worldX, -worldY) into the scene. The caller owns
 * the scene, container and assets; dispose removes this renderer's objects and
 * texture registrations, without disposing the ModelAssets or its images.
 */
export class PhaserRenderer {
  private readonly prefix = `rigc-phaser-${++rendererId}-`;
  private readonly textures = new Map<string, string>();
  private readonly views = new Map<string, PhaserRegionView>();
  private readonly submitter: RegionSubmitter;
  private readonly blendModes: Record<BlendMode, number>;
  private disposed = false;

  constructor(readonly container: Phaser.GameObjects.Container, readonly assets: ModelAssets) {
    if (!(container.scene.sys.game.renderer instanceof Phaser.Renderer.WebGL.WebGLRenderer)) {
      throw new Error('PhaserRenderer: scene renderer must be Phaser WebGLRenderer (found Canvas or HEADLESS)');
    }
    this.submitter = new RegionSubmitter(container.scene.sys.game.renderer.renderNodes);
    this.blendModes = blendModesFor(container.scene.sys.game.renderer);
  }

  render(frame: PosedFrame): void {
    if (this.disposed) throw new Error('PhaserRenderer: render called after dispose (expected a live renderer)');
    const names = new Set<string>();
    // Validate the whole incoming frame before touching the last accepted frame.
    for (const slot of frame.order) {
      const detail = `PhaserRenderer: slot "${slot.slot}" on page "${slot.page}"`;
      if (names.has(slot.slot)) throw new Error(`${detail} repeats a slot name (expected unique names)`);
      names.add(slot.slot);
      if (slot.kind !== 'region') throw new Error(`${detail} has unsupported kind "${slot.kind}" (expected region)`);
      if (slot.clip !== undefined) throw new Error(`${detail} has unsupported clip (expected no clip)`);
      if (slot.dark !== undefined) throw new Error(`${detail} has unsupported dark colour (expected no dark)`);
      if (slot.pma !== false) throw new Error(`${detail} has unsupported pma=${String(slot.pma)} (expected false)`);
      if (!this.assets.pageImages.has(slot.page)) throw new Error(`${detail} is missing from assets.pageImages (expected loaded page)`);
      for (const [field, values, length] of [['corners', slot.corners, 8], ['uvs', slot.uvs, 8], ['tint', slot.tint, 4]] as const) {
        if (!Array.isArray(values) || values.length !== length) throw new Error(`${detail} has invalid ${field} length ${values?.length} (expected ${length})`);
        for (let i = 0; i < values.length; i++) {
          if (!Number.isFinite(values[i])) throw new Error(`${detail} has non-finite ${field}[${i}]=${values[i]} (expected finite number)`);
        }
      }
      if (!Object.hasOwn(BLEND_PHASER, slot.blend)) throw new Error(`${detail} has unsupported blend "${slot.blend}" (expected Normal, Additive, Multiply or Screen)`);
    }
    for (const [name, view] of this.views) {
      if (!names.has(name)) { view.destroy(); this.views.delete(name); }
    }
    for (const slot of frame.order) {
      // The first loop narrowed every member; no unsupported member is skipped.
      const region = slot as PosedRegion;
      let key = this.textures.get(region.page);
      if (!key) {
        key = this.prefix + this.textures.size;
        const texture = this.container.scene.textures.addImage(key, this.assets.pageImages.get(region.page)!);
        if (!texture) throw new Error(`PhaserRenderer: slot "${region.slot}" page "${region.page}" could not register texture "${key}"`);
        // Match the page sampler used by play's CanvasRenderer, independently
        // of the consumer's global sprite antialias/nearest-neighbour option.
        texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
        this.textures.set(region.page, key);
      }
      const vertices: number[] = [];
      for (let i = 0; i < 4; i++) vertices.push(region.corners[i * 2], -region.corners[i * 2 + 1], region.uvs[i * 2], region.uvs[i * 2 + 1]);
      let view = this.views.get(region.slot);
      if (!view) {
        view = new Phaser.GameObjects.Mesh2D(this.container.scene, 0, 0, key, vertices, [0, 1, 2, 0, 0, 2, 3, 0], true) as PhaserRegionView;
        // Pair the fixed region triangles into Phaser's native quad batch.
        // The individual-triangle batch lost wedges in Chromium while the
        // quad route preserves all four independently authored UV corners.
        view.setName(region.slot).setOrigin(0, 0).buildOrderedIndices(2, true);
        view.setRenderNodeRole('Submitter', this.submitter);
        this.container.add(view);
        this.views.set(region.slot, view);
      } else {
        view.setTexture(key);
        view.vertices = vertices;
      }
      const tint = tintToPhaser(region.tint);
      view.tint = tint.color;
      view.setAlpha(tint.alpha).setBlendMode(this.blendModes[region.blend] as Phaser.BlendModes);
      this.container.bringToTop(view);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    for (const view of this.views.values()) view.destroy();
    this.views.clear();
    for (const key of this.textures.values()) this.container.scene.textures.remove(key);
    this.textures.clear();
    this.disposed = true;
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
