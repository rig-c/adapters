import {
  CanvasRenderer,
  loadModel,
  type ModelAssets,
  type PosedFrame,
  type PosedMesh,
  type PosedRegion,
  type PosedSlot,
  RigPlayer,
} from '@rig-c/play';
import { Container, Sprite, WebGLRenderer } from 'pixi.js';

import {
  BLEND_PIXI,
  PixiRenderer,
  readSpriteScreenCorners,
  tintToPixi,
  worldToScreenCorners,
} from '../src/index.ts';

const STAGE_BG = '#14161a';
const PAD = 16;

const cachedAssets = new Map<string, Promise<ModelAssets>>();

function getAssets(rigName: string): Promise<ModelAssets> {
  let promise = cachedAssets.get(rigName);
  if (!promise) {
    promise = loadModel({ modelUrl: `/rigs/${rigName}/skeleton.model.json` });
    cachedAssets.set(rigName, promise);
  }
  return promise;
}

let sharedPixiGl: WebGLRenderer | null = null;

async function getPixiGl(width: number, height: number): Promise<WebGLRenderer> {
  if (!sharedPixiGl) {
    const gl = new WebGLRenderer();
    await gl.init({
      width,
      height,
      resolution: 1,
      antialias: false,
      backgroundAlpha: 0,
      preserveDrawingBuffer: true,
      clearBeforeRender: true,
    });
    sharedPixiGl = gl;
  } else {
    sharedPixiGl.resize(width, height, 1);
  }
  return sharedPixiGl;
}

export interface SlotInventory {
  rigName: string;
  animation: string;
  totalSlots: number;
  regionSlots: string[];
  meshSlots: Array<{ slot: string; page: string }>;
}

/**
 * Inspects a rig's unfiltered `PosedFrame` at `time` through `RigPlayer` and
 * partitions its drawn slots by `kind`.
 */
async function inspectRigSlots(rigName: string, time: number): Promise<SlotInventory> {
  const assets = await getAssets(rigName);
  const dummy = document.createElement('div');
  const player = new RigPlayer(dummy, assets);
  const animation = assets.animations[0].name;
  player.play(animation);
  player.seek(time);
  const frame = player.posedFrame();
  player.dispose();

  const regionSlots: string[] = [];
  const meshSlots: Array<{ slot: string; page: string }> = [];
  for (const slot of frame.order) {
    if (slot.kind === 'region') {
      regionSlots.push(slot.slot);
    } else {
      meshSlots.push({ slot: slot.slot, page: slot.page });
    }
  }
  return {
    rigName,
    animation,
    totalSlots: frame.order.length,
    regionSlots,
    meshSlots,
  };
}

/**
 * Obtains a region-only `PosedFrame` at `time` using `@rig-c/play`'s
 * `RigPlayer.posedFrame(SlotFilter)` API.
 */
async function regionFrameAt(
  assets: ModelAssets,
  time: number,
): Promise<{
  animation: string;
  unfilteredFrame: PosedFrame;
  regionFrame: PosedFrame;
  regionSlotNames: string[];
  meshSlotEntries: Array<{ slot: string; page: string }>;
}> {
  const dummy = document.createElement('div');
  const player = new RigPlayer(dummy, assets);
  const animation = assets.animations[0].name;
  player.play(animation);
  player.seek(time);
  const unfilteredFrame = player.posedFrame();

  const regionSet = new Set<string>();
  const meshSlotEntries: Array<{ slot: string; page: string }> = [];
  for (const s of unfilteredFrame.order) {
    if (s.kind === 'region') {
      regionSet.add(s.slot);
    } else {
      meshSlotEntries.push({ slot: s.slot, page: s.page });
    }
  }

  // Use RigPlayer's public SlotFilter parameter when mesh slots exist on the rig.
  const regionFrame =
    meshSlotEntries.length > 0
      ? player.posedFrame((slotName: string) => regionSet.has(slotName))
      : unfilteredFrame;
  player.dispose();

  return {
    animation,
    unfilteredFrame,
    regionFrame,
    regionSlotNames: [...regionSet],
    meshSlotEntries,
  };
}

export interface GeometryProbeOptions {
  rigName: string;
  time: number;
  mutant?: 'none' | 'swap-order' | 'shift-corner';
}

export interface GeometryProbeResult {
  rigName: string;
  animation: string;
  time: number;
  childrenCount: number;
  orderCount: number;
  orderMatches: boolean;
  childLabels: string[];
  orderNames: string[];
  maxCornerDeltaPx: number;
  perSlotMaxDeltaPx: Record<string, number>;
  unfilteredMeshCount: number;
  unfilteredRefusalMessage: string | null;
}

async function geometryProbe(options: GeometryProbeOptions): Promise<GeometryProbeResult> {
  const assets = await getAssets(options.rigName);
  const { animation, unfilteredFrame, regionFrame, meshSlotEntries } = await regionFrameAt(
    assets,
    options.time,
  );

  const stage = new Container();
  const root = new Container();
  root.position.set(280, 360);
  stage.addChild(root);
  stage.getGlobalTransform(stage.worldTransform, false);
  root.getGlobalTransform(root.worldTransform, false);

  const pixiRenderer = new PixiRenderer(root, assets);

  let unfilteredRefusalMessage: string | null = null;
  if (meshSlotEntries.length > 0) {
    try {
      pixiRenderer.render(unfilteredFrame);
    } catch (err) {
      unfilteredRefusalMessage = err instanceof Error ? err.message : String(err);
    }
  }

  pixiRenderer.render(regionFrame);

  if (options.mutant === 'swap-order' && root.children.length >= 2) {
    root.swapChildren(root.children[0], root.children[1]);
  } else if (options.mutant === 'shift-corner' && root.children.length >= 1) {
    const first = root.children[0] as Sprite;
    first.x += 1e-3;
    first.getGlobalTransform(first.worldTransform, false);
  }

  const childLabels = root.children.map((c) => c.label);
  const orderNames = regionFrame.order.map((s) => s.slot);
  const orderMatches =
    childLabels.length === orderNames.length &&
    childLabels.every((label, i) => label === orderNames[i]);

  let maxCornerDeltaPx = 0;
  const perSlotMaxDeltaPx: Record<string, number> = {};

  const count = Math.min(root.children.length, regionFrame.order.length);
  for (let i = 0; i < count; i++) {
    const sprite = root.children[i] as Sprite;
    const slot = regionFrame.order[i] as PosedRegion;
    const actual = readSpriteScreenCorners(sprite);
    const expected = worldToScreenCorners(slot.corners, root);
    let slotMax = 0;
    for (let k = 0; k < 8; k++) {
      const delta = Math.abs(actual[k] - expected[k]);
      if (delta > slotMax) slotMax = delta;
      if (delta > maxCornerDeltaPx) maxCornerDeltaPx = delta;
    }
    perSlotMaxDeltaPx[slot.slot] = slotMax;
  }

  pixiRenderer.dispose();
  stage.destroy({ children: true });

  return {
    rigName: options.rigName,
    animation,
    time: options.time,
    childrenCount: childLabels.length,
    orderCount: orderNames.length,
    orderMatches,
    childLabels,
    orderNames,
    maxCornerDeltaPx,
    perSlotMaxDeltaPx,
    unfilteredMeshCount: meshSlotEntries.length,
    unfilteredRefusalMessage,
  };
}

export type PictureMutant =
  | 'none'
  | 'drop-slot'
  | 'swap-order'
  | 'additive-as-normal'
  | 'drop-tint';

export interface PictureCaptureOptions {
  rigName: string;
  time: number;
  mutant?: PictureMutant;
}

export interface SlotVisualState {
  slot: string;
  blend: string;
  pixiBlendMode: string;
  tint: [number, number, number, number];
  pixiTintHex: number;
  pixiAlpha: number;
  expectedTintHex: number;
  expectedAlpha: number;
}

export interface PictureCaptureResult {
  rigName: string;
  animation: string;
  time: number;
  width: number;
  height: number;
  canvasBackendActive: string;
  canvasPngBase64: string;
  pixiPngBase64: string;
  slotStates: SlotVisualState[];
}

function computeRegionBounds(frames: PosedFrame[]): {
  left: number;
  bottomWorld: number;
  width: number;
  height: number;
  topWorld: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const frame of frames) {
    for (const slot of frame.order) {
      if (slot.kind !== 'region') continue;
      const c = slot.corners;
      for (let k = 0; k < 8; k += 2) {
        const wx = c[k];
        const wy = c[k + 1];
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
    }
  }

  const left = Math.floor(minX) - PAD;
  const right = Math.ceil(maxX) + PAD;
  const bottomWorld = Math.floor(minY) - PAD;
  const topWorld = Math.ceil(maxY) + PAD;
  return {
    left,
    bottomWorld,
    width: Math.max(1, right - left),
    height: Math.max(1, topWorld - bottomWorld),
    topWorld,
  };
}

function compositeOnBackdrop(sourceCanvas: HTMLCanvasElement, width: number, height: number): string {
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.fillStyle = STAGE_BG;
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(sourceCanvas, 0, 0);
  return out.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

async function pictureCaptureProbe(options: PictureCaptureOptions): Promise<PictureCaptureResult> {
  const assets = await getAssets(options.rigName);
  const samples = await Promise.all([0, 0.5, 1.2].map((t) => regionFrameAt(assets, t)));
  const bounds = computeRegionBounds(samples.map((s) => s.regionFrame));
  const { animation, regionFrame } = await regionFrameAt(assets, options.time);

  // 1. Reference picture from @rig-c/play's CanvasRenderer (WebGL).
  const refRoot = document.createElement('div');
  const canvasRenderer = new CanvasRenderer(refRoot, assets.pageImages);
  canvasRenderer.pixelRatio = 1;
  canvasRenderer.backend = 'webgl';
  canvasRenderer.viewport = {
    x: bounds.left,
    y: bounds.bottomWorld,
    width: bounds.width,
    height: bounds.height,
  };
  canvasRenderer.render(regionFrame);
  const canvasBackendActive = canvasRenderer.backendActive;
  const canvasPngBase64 = compositeOnBackdrop(canvasRenderer.canvas, bounds.width, bounds.height);
  canvasRenderer.dispose();

  // 2. PixiRenderer picture on the same pose (or mutated pose for mutant controls).
  let pixiFrame: PosedFrame = regionFrame;
  const mutant = options.mutant ?? 'none';
  if (mutant === 'drop-slot') {
    // Drop the non-backdrop foreground slot with the largest area (avoid dropping index 0 if it is the background plate).
    const dropIdx = regionFrame.order.length > 1 ? Math.floor(regionFrame.order.length / 2) : 0;
    pixiFrame = {
      order: regionFrame.order.filter((_, i) => i !== dropIdx),
    };
  } else if (mutant === 'swap-order') {
    // Swap the first foreground slot with the last foreground slot so occlusion changes visibly.
    const copy = [...regionFrame.order];
    if (copy.length >= 3) {
      const a = 1;
      const b = copy.length - 1;
      const tmp = copy[a];
      copy[a] = copy[b];
      copy[b] = tmp;
    } else if (copy.length === 2) {
      const tmp = copy[0];
      copy[0] = copy[1];
      copy[1] = tmp;
    }
    pixiFrame = { order: copy };
  } else if (mutant === 'additive-as-normal') {
    pixiFrame = {
      order: regionFrame.order.map((slot) =>
        slot.blend === 'Additive' ? { ...slot, blend: 'Normal' } : slot,
      ),
    };
  } else if (mutant === 'drop-tint') {
    pixiFrame = {
      order: regionFrame.order.map((slot) => ({
        ...slot,
        tint: [1, 1, 1, 1] as [number, number, number, number],
      })),
    };
  }

  const gl = await getPixiGl(bounds.width, bounds.height);
  const stage = new Container();
  const pixiRoot = new Container();
  // Map root local (worldX, -worldY) so world (left, topWorld) lands at canvas (0, 0).
  pixiRoot.position.set(-bounds.left, bounds.topWorld);
  stage.addChild(pixiRoot);

  const pixiRenderer = new PixiRenderer(pixiRoot, assets);
  pixiRenderer.render(pixiFrame);
  gl.render({ container: stage });

  const slotStates: SlotVisualState[] = pixiFrame.order.map((slot, i) => {
    const sprite = pixiRoot.children[i] as Sprite;
    const expected = tintToPixi(slot.tint);
    return {
      slot: slot.slot,
      blend: slot.blend,
      pixiBlendMode: sprite.blendMode,
      tint: [...slot.tint] as [number, number, number, number],
      pixiTintHex: sprite.tint,
      pixiAlpha: sprite.alpha,
      expectedTintHex: expected.color,
      expectedAlpha: expected.alpha,
    };
  });

  const pixiPngBase64 = compositeOnBackdrop(
    gl.canvas as HTMLCanvasElement,
    bounds.width,
    bounds.height,
  );

  pixiRenderer.dispose();
  stage.destroy({ children: true });

  return {
    rigName: options.rigName,
    animation,
    time: options.time,
    width: bounds.width,
    height: bounds.height,
    canvasBackendActive,
    canvasPngBase64,
    pixiPngBase64,
    slotStates,
  };
}

export interface RefusalCaseResult {
  name: string;
  threw: boolean;
  message: string;
  childrenAfterThrow: number;
}

async function refusalProbe(): Promise<RefusalCaseResult[]> {
  const walkAssets = await getAssets('walk');
  const flexAssets = await getAssets('flex');
  const glowAssets = await getAssets('glow');

  const walkSample = await regionFrameAt(walkAssets, 0.5);
  const flexSample = await regionFrameAt(flexAssets, 0.5);
  const glowSample = await regionFrameAt(glowAssets, 0.5);

  const results: RefusalCaseResult[] = [];

  const runCase = (
    name: string,
    assets: ModelAssets,
    frame: PosedFrame,
    preRenderFrame?: PosedFrame,
  ): void => {
    const root = new Container();
    const renderer = new PixiRenderer(root, assets);
    if (preRenderFrame) {
      renderer.render(preRenderFrame);
    }
    let threw = false;
    let message = '';
    try {
      renderer.render(frame);
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    const childrenAfterThrow = root.children.length;
    renderer.dispose();
    root.destroy({ children: true });
    results.push({ name, threw, message, childrenAfterThrow });
  };

  // Case 1: missing page in assets.pageImages
  {
    const targetSlot = walkSample.regionFrame.order[3] as PosedRegion; // e.g. torso/leg
    const pagesCopy = new Map(walkAssets.pageImages);
    pagesCopy.delete(targetSlot.page);
    const brokenAssets: ModelAssets = {
      ...walkAssets,
      pageImages: pagesCopy,
    };
    runCase('missing-page', brokenAssets, walkSample.regionFrame);
  }

  // Case 2: real unfiltered `flex` frame containing mesh slots (`flag_a`, etc.)
  runCase('real-flex-mesh', flexAssets, flexSample.unfilteredFrame, flexSample.regionFrame);

  // Case 3: real unfiltered `glow` frame containing mesh slots (`flame`, `core`)
  runCase('real-glow-mesh', glowAssets, glowSample.unfilteredFrame, glowSample.regionFrame);

  // Case 4: synthetic mesh slot injected into a region frame
  {
    const baseSlot = walkSample.regionFrame.order[0] as PosedRegion;
    const meshSlot: PosedMesh = {
      slot: 'synthetic_cloth',
      kind: 'mesh',
      z: 1,
      page: baseSlot.page,
      pma: false,
      vertices: [0, 0, 10, 0, 10, 10],
      uvs: [0, 0, 1, 0, 1, 1],
      triangles: [0, 1, 2],
      sequence: 0,
      tint: [1, 1, 1, 1],
      blend: 'Normal',
    };
    runCase('synthetic-mesh', walkAssets, {
      order: [baseSlot, meshSlot],
    });
  }

  // Case 5: slot carrying a `clip` polygon (unsupported in region-only renderer)
  {
    const baseSlot = walkSample.regionFrame.order[0] as PosedRegion;
    const clippedSlot: PosedSlot = {
      ...baseSlot,
      slot: 'clipped_visor',
      clip: {
        polygon: [0, 0, 100, 0, 100, 100],
        inverse: false,
        convex: true,
      },
    };
    runCase('unsupported-clip', walkAssets, { order: [clippedSlot] });
  }

  // Case 6: slot carrying `dark` tint (unsupported in region-only renderer)
  {
    const baseSlot = walkSample.regionFrame.order[0] as PosedRegion;
    const darkSlot: PosedSlot = {
      ...baseSlot,
      slot: 'dark_tinted_head',
      dark: [0.2, 0.3, 0.4],
    };
    runCase('unsupported-dark', walkAssets, { order: [darkSlot] });
  }

  // Case 7: slot with `pma: true` (unsupported in region-only renderer)
  {
    const baseSlot = walkSample.regionFrame.order[0] as PosedRegion;
    const pmaSlot: PosedSlot = {
      ...baseSlot,
      slot: 'pma_region_slot',
      pma: true,
    };
    runCase('unsupported-pma', walkAssets, { order: [pmaSlot] });
  }

  // Case 8: slot with unknown blend mode
  {
    const baseSlot = walkSample.regionFrame.order[0] as PosedRegion;
    const badBlendSlot = {
      ...baseSlot,
      slot: 'bad_blend_slot',
      blend: 'Subtract' as unknown as PosedRegion['blend'],
    };
    runCase('invalid-blend', walkAssets, { order: [badBlendSlot] });
  }

  return results;
}

const harness = {
  BLEND_PIXI,
  inspectRigSlots,
  geometryProbe,
  pictureCaptureProbe,
  refusalProbe,
};

declare global {
  interface Window {
    rigAdaptersHarness: typeof harness;
  }
}

window.rigAdaptersHarness = harness;
