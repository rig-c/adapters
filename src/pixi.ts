import type { BlendMode, ModelAssets, PosedFrame, PosedRegion, PosedSlot } from '@rig-c/play';
import {
  type BLEND_MODES,
  type Container,
  ImageSource,
  Matrix,
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

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Maps a `PosedSlot.tint` tuple (`[r, g, b, a]` in `0..1`) to PixiJS `Sprite`
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

interface PreparedSlot {
  slot: PosedRegion;
  texture: Texture;
  blendMode: BLEND_MODES;
  color: number;
  alpha: number;
  matrix: Matrix;
}

/**
 * Renders the region slots (`kind: 'region'`) of a `@rig-c/play` `PosedFrame`
 * into a PixiJS `Container`.
 *
 * The renderer owns nothing of the pose: every slot's world corners, page UVs,
 * tint, and blend mode are read straight from the `PosedFrame` record. World
 * coordinates (`x` right, `y` up) map into `root`'s local coordinate space as
 * `(worldX, -worldY)`, matching `@rig-c/play`'s `CanvasRenderer` and
 * `DomRenderer`.
 */
export class PixiRenderer {
  private readonly sources = new Map<HTMLImageElement, ImageSource>();
  private readonly textures = new Map<string, Texture>();
  private readonly spritePool: Sprite[] = [];
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
      throw new Error('PixiRenderer: cannot render on a disposed PixiRenderer (expected active renderer)');
    }
    if (!frame || !Array.isArray(frame.order)) {
      throw new Error('PixiRenderer: frame.order is missing or not an array (expected PosedFrame)');
    }

    const order = frame.order;
    const prepared: PreparedSlot[] = new Array(order.length);

    for (let i = 0; i < order.length; i++) {
      const slot = order[i];
      prepared[i] = this.prepareSlot(slot);
    }

    // Synchronize root.children to match prepared slots in exact draw order.
    while (this.spritePool.length < prepared.length) {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.roundPixels = false;
      this.spritePool.push(sprite);
    }

    // Remove excess children from root if the previous frame had more slots.
    while (this.root.children.length > prepared.length) {
      this.root.removeChildAt(this.root.children.length - 1);
    }

    for (let i = 0; i < prepared.length; i++) {
      const item = prepared[i];
      const sprite = this.spritePool[i];
      sprite.label = item.slot.slot;
      sprite.texture = item.texture;
      sprite.blendMode = item.blendMode;
      sprite.tint = item.color;
      sprite.alpha = item.alpha;

      // Apply the affine basis (a, b, c, d, tx, ty) directly via position,
      // skew, and scale with rotation=0 rather than sprite.setFromMatrix(),
      // because PixiJS Matrix.decompose zeroes skew when |skewX + skewY| < 1e-5,
      // which would shift corners of large sprites by up to ~3.3e-5 px.
      const m = item.matrix;
      sprite.position.set(m.tx, m.ty);
      sprite.rotation = 0;
      sprite.skew.set(Math.atan2(m.c, m.d), Math.atan2(m.b, m.a));
      sprite.scale.set(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));

      if (this.root.children[i] !== sprite) {
        this.root.addChildAt(sprite, i);
      }
      // Update worldTransform immediately so reading transforms after render()
      // without a full renderer pass reflects the current pose and stage.
      sprite.getGlobalTransform(sprite.worldTransform, false);
    }
  }

  /**
   * Removes all sprites from `this.root` and destroys the PixiJS textures and
   * sources created by this renderer. Does not dispose `ModelAssets`. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeChildren();
    for (const sprite of this.spritePool) {
      sprite.destroy();
    }
    this.spritePool.length = 0;
    for (const texture of this.textures.values()) {
      texture.destroy(false);
    }
    this.textures.clear();
    for (const source of this.sources.values()) {
      source.destroy();
    }
    this.sources.clear();
  }

  private prepareSlot(slot: PosedSlot): PreparedSlot {
    if (!slot || typeof slot !== 'object') {
      throw new Error('PixiRenderer: encountered invalid slot entry in frame.order (expected PosedSlot object)');
    }
    const slotName = typeof slot.slot === 'string' && slot.slot.length > 0 ? slot.slot : '<unnamed>';
    const pageName = typeof slot.page === 'string' && slot.page.length > 0 ? slot.page : '<unnamed>';

    if (slot.kind !== 'region') {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" has unsupported kind "${String(slot.kind)}" (expected "region")`,
      );
    }
    if (slot.clip !== undefined) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" carries a clip polygon (${slot.clip.polygon.length / 2} vertices), which region-only PixiRenderer does not support (expected clip to be undefined)`,
      );
    }
    if (slot.dark !== undefined) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" carries dark tint [${slot.dark.join(', ')}], which region-only PixiRenderer does not support (expected dark to be undefined)`,
      );
    }
    if (slot.pma === true) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" sets pma=true, which region-only PixiRenderer does not support (expected pma=false or undefined)`,
      );
    }

    const blendMode = (BLEND_PIXI as Record<string, BLEND_MODES | undefined>)[slot.blend];
    if (blendMode === undefined) {
      throw new Error(
        `PixiRenderer: slot "${slotName}" on page "${pageName}" has unsupported blend mode "${String(slot.blend)}" (expected Normal, Additive, Multiply, or Screen)`,
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

    assertFiniteTuple(slot.corners, 8, 'corners', slotName, pageName);
    assertFiniteTuple(slot.uvs, 8, 'uvs', slotName, pageName);
    assertFiniteTuple(slot.tint, 4, 'tint', slotName, pageName);

    const texture = this.textureFor(pageImage, pw, ph, slot);
    const { color, alpha } = tintToPixi(slot.tint);

    // PosedRegion.corners is [blX, blY, ulX, ulY, urX, urY, brX, brY] in world
    // space (Y up). In root local space (Y down), each point (x, y) is (x, -y).
    // A Sprite's local quad has UL=(0,0), UR=(W,0), BR=(W,H), BL=(0,H) where
    // W = texture.orig.width and H = texture.orig.height.
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
      slot,
      texture,
      blendMode,
      color,
      alpha,
      matrix: new Matrix(a, b, c, d, tx, ty),
    };
  }

  private sourceFor(pageImage: HTMLImageElement): ImageSource {
    let source = this.sources.get(pageImage);
    if (!source) {
      source = new ImageSource({
        resource: pageImage,
        alphaMode: 'premultiply-alpha-on-upload',
        scaleMode: 'linear',
        addressMode: 'clamp-to-edge',
        autoGenerateMipmaps: false,
      });
      this.sources.set(pageImage, source);
    }
    return source;
  }

  private textureFor(pageImage: HTMLImageElement, pw: number, ph: number, slot: PosedRegion): Texture {
    const [blU, blV, ulU, ulV, urU, urV, brU, brV] = slot.uvs;
    const key = `${slot.page}\u0000${blU},${blV},${ulU},${ulV},${urU},${urV},${brU},${brV}`;
    let texture = this.textures.get(key);
    if (texture) return texture;

    const source = this.sourceFor(pageImage);
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
    const orig = turned ? new Rectangle(0, 0, frameH, frameW) : new Rectangle(0, 0, frameW, frameH);
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

    this.textures.set(key, texture);
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
