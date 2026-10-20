import { fixtureModelUrl } from '@rig-c/adapters-shared/fixtures';
import {
  CanvasRenderer,
  loadModel,
  type ModelAssets,
  type PoseBounds,
  type PosedFrame,
  type PosedMesh,
  type PosedRegion,
  type PosedSlot,
  RigPlayer,
  type SlotFilter,
} from '@rig-c/play';
import { Container, Mesh, type MeshGeometry, Sprite, Ticker, WebGLRenderer } from 'pixi.js';

import {
  BLEND_PIXI,
  getLivePageTextureCount,
  getPageRefCount,
  getSharedPageSource,
  PixiRenderer,
  PixiRig,
  type PixiRigResourceCounts,
  readMeshScreenVertices,
  readSpriteScreenCorners,
  tintToPixi,
  worldToScreenCorners,
  worldToScreenVertices,
} from '../src/index.ts';

const STAGE_BG = '#14161a';
const PAD = 16;

const cachedAssets = new Map<string, Promise<ModelAssets>>();

function getAssets(rigName: string): Promise<ModelAssets> {
  let promise = cachedAssets.get(rigName);
  if (!promise) {
    promise = loadModel({ modelUrl: fixtureModelUrl(rigName) });
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
  meshSlots: Array<{ slot: string; page: string; vertices: number; triangles: number }>;
  clippedSlots: string[];
  darkSlots: string[];
}

function poseAt(
  assets: ModelAssets,
  time: number,
  animationName?: string,
): { animation: string; frame: PosedFrame } {
  const dummy = document.createElement('div');
  const player = new RigPlayer(dummy, assets);
  const animation = animationName ?? assets.animations[0].name;
  player.play(animation);
  player.seek(time);
  const frame = player.posedFrame();
  player.dispose();
  return { animation, frame };
}

/**
 * Inspects a rig's unfiltered `PosedFrame` at `time` through `RigPlayer`.
 */
async function inspectRigSlots(
  rigName: string,
  time: number,
  animationName?: string,
): Promise<SlotInventory> {
  const assets = await getAssets(rigName);
  const { animation, frame } = poseAt(assets, time, animationName);

  const regionSlots: string[] = [];
  const meshSlots: Array<{ slot: string; page: string; vertices: number; triangles: number }> = [];
  const clippedSlots: string[] = [];
  const darkSlots: string[] = [];

  for (const slot of frame.order) {
    if (slot.kind === 'region') {
      regionSlots.push(slot.slot);
    } else {
      meshSlots.push({
        slot: slot.slot,
        page: slot.page,
        vertices: slot.vertices.length / 2,
        triangles: slot.triangles.length / 3,
      });
    }
    if (slot.clip !== undefined) clippedSlots.push(slot.slot);
    if (slot.dark !== undefined) darkSlots.push(slot.slot);
  }
  return {
    rigName,
    animation,
    totalSlots: frame.order.length,
    regionSlots,
    meshSlots,
    clippedSlots,
    darkSlots,
  };
}

export interface GeometryProbeOptions {
  rigName: string;
  animation?: string;
  time: number;
  mutant?: 'none' | 'swap-order' | 'shift-corner' | 'shift-mesh-vertex';
}

export interface GeometryProbeResult {
  rigName: string;
  animation: string;
  time: number;
  childrenCount: number;
  orderCount: number;
  regionCount: number;
  meshCount: number;
  meshVertexCount: number;
  orderMatches: boolean;
  childLabels: string[];
  orderNames: string[];
  maxCornerDeltaPx: number;
  maxMeshDeltaF32Px: number;
  maxMeshDeltaF64Px: number;
  maxMeshF32QuantizationPx: number;
  maxMeshBeyondF32QuantizationPx: number;
  perSlotMaxDeltaPx: Record<string, number>;
  rootMasked: boolean;
  maskedChildSlots: string[];
}

async function geometryProbe(options: GeometryProbeOptions): Promise<GeometryProbeResult> {
  const assets = await getAssets(options.rigName);
  const { animation, frame } = poseAt(assets, options.time, options.animation);

  const stage = new Container();
  const root = new Container();
  root.position.set(280, 360);
  stage.addChild(root);
  stage.getGlobalTransform(stage.worldTransform, false);
  root.getGlobalTransform(root.worldTransform, false);

  const pixiRenderer = new PixiRenderer(root, assets);
  pixiRenderer.render(frame);

  if (options.mutant === 'swap-order' && root.children.length >= 2) {
    const regionIndices: number[] = [];
    for (let i = 0; i < root.children.length; i++) {
      if (root.children[i] instanceof Sprite) regionIndices.push(i);
    }
    if (regionIndices.length >= 2) {
      root.swapChildren(root.children[regionIndices[0]], root.children[regionIndices[1]]);
    } else {
      root.swapChildren(root.children[0], root.children[1]);
    }
  } else if (options.mutant === 'shift-corner') {
    const firstRegionIdx = frame.order.findIndex((s) => s.kind === 'region');
    if (firstRegionIdx >= 0) {
      const sprite = root.children[firstRegionIdx] as Sprite;
      sprite.x += 1e-3;
      sprite.getGlobalTransform(sprite.worldTransform, false);
    }
  } else if (options.mutant === 'shift-mesh-vertex') {
    const firstMeshIdx = frame.order.findIndex((s) => s.kind === 'mesh');
    if (firstMeshIdx >= 0) {
      const mesh = root.children[firstMeshIdx] as Mesh<MeshGeometry>;
      mesh.geometry.positions[0] += 1e-3;
    }
  }

  const childLabels = root.children.map((c) => c.label);
  const orderNames = frame.order.map((s) => s.slot);
  const orderMatches =
    childLabels.length === orderNames.length &&
    childLabels.every((label, i) => label === orderNames[i]);

  let maxCornerDeltaPx = 0;
  let maxMeshDeltaF32Px = 0;
  let maxMeshDeltaF64Px = 0;
  let maxMeshF32QuantizationPx = 0;
  let maxMeshBeyondF32QuantizationPx = 0;
  let regionCount = 0;
  let meshCount = 0;
  let meshVertexCount = 0;
  const perSlotMaxDeltaPx: Record<string, number> = {};
  const maskedChildSlots: string[] = [];

  const count = Math.min(root.children.length, frame.order.length);
  for (let i = 0; i < count; i++) {
    const child = root.children[i];
    const slot = frame.order[i];
    if (child.mask) {
      maskedChildSlots.push(slot.slot);
    }
    if (slot.kind === 'region') {
      regionCount++;
      if (!(child instanceof Sprite)) continue;
      const actual = readSpriteScreenCorners(child);
      const expected = worldToScreenCorners(slot.corners, root);
      let slotMax = 0;
      for (let k = 0; k < 8; k++) {
        const delta = Math.abs(actual[k] - expected[k]);
        if (delta > slotMax) slotMax = delta;
        if (delta > maxCornerDeltaPx) maxCornerDeltaPx = delta;
      }
      perSlotMaxDeltaPx[slot.slot] = slotMax;
    } else {
      meshCount++;
      meshVertexCount += slot.vertices.length / 2;
      if (!(child instanceof Mesh)) continue;
      const mesh = child as Mesh<MeshGeometry>;
      const actual = readMeshScreenVertices(mesh);
      const expectedF32 = worldToScreenVertices(slot.vertices, root, true);
      const expectedF64 = worldToScreenVertices(slot.vertices, root, false);
      let slotMaxF32 = 0;
      for (let k = 0; k < actual.length; k++) {
        const deltaF32 = Math.abs(actual[k] - expectedF32[k]);
        const deltaF64 = Math.abs(actual[k] - expectedF64[k]);
        const quant = Math.abs(expectedF64[k] - expectedF32[k]);
        const beyondQuant = Math.abs(deltaF64 - quant);
        if (deltaF32 > slotMaxF32) slotMaxF32 = deltaF32;
        if (deltaF32 > maxMeshDeltaF32Px) maxMeshDeltaF32Px = deltaF32;
        if (deltaF64 > maxMeshDeltaF64Px) maxMeshDeltaF64Px = deltaF64;
        if (quant > maxMeshF32QuantizationPx) maxMeshF32QuantizationPx = quant;
        if (beyondQuant > maxMeshBeyondF32QuantizationPx) {
          maxMeshBeyondF32QuantizationPx = beyondQuant;
        }
      }
      perSlotMaxDeltaPx[slot.slot] = slotMaxF32;
    }
  }

  const rootMasked = Boolean(root.mask);

  pixiRenderer.dispose();
  stage.destroy({ children: true });

  return {
    rigName: options.rigName,
    animation,
    time: options.time,
    childrenCount: childLabels.length,
    orderCount: orderNames.length,
    regionCount,
    meshCount,
    meshVertexCount,
    orderMatches,
    childLabels,
    orderNames,
    maxCornerDeltaPx,
    maxMeshDeltaF32Px,
    maxMeshDeltaF64Px,
    maxMeshF32QuantizationPx,
    maxMeshBeyondF32QuantizationPx,
    perSlotMaxDeltaPx,
    rootMasked,
    maskedChildSlots,
  };
}

export type PictureMutant =
  | 'none'
  | 'drop-slot'
  | 'swap-order'
  | 'additive-as-normal'
  | 'drop-tint'
  | 'reverse-triangles'
  | 'ignore-clip'
  | 'drop-dark';

export interface PictureCaptureOptions {
  rigName: string;
  animation?: string;
  time: number;
  sampleTimes?: readonly number[];
  pad?: number;
  mutant?: PictureMutant;
}

export interface SlotVisualState {
  slot: string;
  kind: 'region' | 'mesh';
  blend: string;
  pixiBlendMode: string;
  tint: [number, number, number, number];
  dark?: [number, number, number];
  hasDarkFilter: boolean;
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

function computeFrameBounds(
  frames: PosedFrame[],
  pad = PAD,
): {
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
      const coords = slot.kind === 'region' ? slot.corners : slot.vertices;
      for (let k = 0; k < coords.length; k += 2) {
        const wx = coords[k];
        const wy = coords[k + 1];
        if (wx < minX) minX = wx;
        if (wx > maxX) maxX = wx;
        if (wy < minY) minY = wy;
        if (wy > maxY) maxY = wy;
      }
    }
  }

  const left = Math.floor(minX) - pad;
  const right = Math.ceil(maxX) + pad;
  const bottomWorld = Math.floor(minY) - pad;
  const topWorld = Math.ceil(maxY) + pad;
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

function mutateFrame(frame: PosedFrame, mutant: PictureMutant): PosedFrame {
  if (mutant === 'none') return frame;
  if (mutant === 'drop-slot') {
    const dropIdx = frame.order.length > 1 ? Math.floor(frame.order.length / 2) : 0;
    return {
      order: frame.order.filter((_, i) => i !== dropIdx),
    };
  }
  if (mutant === 'swap-order') {
    const copy = [...frame.order];
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
    return { order: copy };
  }
  if (mutant === 'additive-as-normal') {
    return {
      order: frame.order.map((slot) =>
        slot.blend === 'Additive' ? { ...slot, blend: 'Normal' } : slot,
      ),
    };
  }
  if (mutant === 'drop-tint') {
    return {
      order: frame.order.map((slot) => ({
        ...slot,
        tint: [1, 1, 1, 1] as [number, number, number, number],
      })),
    };
  }
  if (mutant === 'reverse-triangles') {
    return {
      order: frame.order.map((slot) => {
        if (slot.kind !== 'mesh') return slot;
        const vCount = slot.vertices.length / 2;
        return {
          ...slot,
          triangles: slot.triangles.map((idx) => vCount - 1 - idx),
        };
      }),
    };
  }
  if (mutant === 'ignore-clip') {
    return {
      order: frame.order.map((slot) => {
        if (slot.clip === undefined) return slot;
        const copy = { ...slot };
        delete copy.clip;
        return copy;
      }),
    };
  }
  if (mutant === 'drop-dark') {
    return {
      order: frame.order.map((slot) => {
        if (slot.dark === undefined) return slot;
        const copy = { ...slot };
        delete copy.dark;
        return copy;
      }),
    };
  }
  return frame;
}

async function pictureCaptureProbe(options: PictureCaptureOptions): Promise<PictureCaptureResult> {
  const assets = await getAssets(options.rigName);
  const sampleTimes = options.sampleTimes ?? [0, 0.5, 1.2];
  const samples = sampleTimes.map((t) => poseAt(assets, t, options.animation));
  const bounds = computeFrameBounds(
    samples.map((s) => s.frame),
    options.pad ?? PAD,
  );
  const { animation, frame } = poseAt(assets, options.time, options.animation);

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
  canvasRenderer.render(frame);
  const canvasBackendActive = canvasRenderer.backendActive;
  const canvasPngBase64 = compositeOnBackdrop(canvasRenderer.canvas, bounds.width, bounds.height);
  canvasRenderer.dispose();

  // 2. PixiRenderer picture on the same pose (or mutated pose for mutant controls).
  const pixiFrame = mutateFrame(frame, options.mutant ?? 'none');

  const gl = await getPixiGl(bounds.width, bounds.height);
  const stage = new Container();
  const pixiRoot = new Container();
  pixiRoot.position.set(-bounds.left, bounds.topWorld);
  stage.addChild(pixiRoot);

  const pixiRenderer = new PixiRenderer(pixiRoot, assets);
  pixiRenderer.render(pixiFrame);
  gl.render({ container: stage });

  const slotStates: SlotVisualState[] = pixiFrame.order.map((slot, i) => {
    const view = pixiRoot.children[i] as Sprite | Mesh<MeshGeometry>;
    const expected = tintToPixi(slot.tint);
    const hasDarkFilter = Boolean(view.filters && view.filters.length > 0);
    const effectiveBlend = hasDarkFilter ? view.filters![0].blendMode : view.blendMode;
    return {
      slot: slot.slot,
      kind: slot.kind,
      blend: slot.blend,
      pixiBlendMode: effectiveBlend,
      tint: [...slot.tint] as [number, number, number, number],
      ...(slot.dark ? { dark: [...slot.dark] as [number, number, number] } : {}),
      hasDarkFilter,
      pixiTintHex: view.tint,
      pixiAlpha: view.alpha,
      expectedTintHex: hasDarkFilter ? 0xffffff : expected.color,
      expectedAlpha: hasDarkFilter ? 1 : expected.alpha,
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

export interface IdentityProbeOptions {
  rigName: string;
  animation?: string;
  times: readonly number[];
  mutant?: 'none' | 'always-reupload' | 'clone-arrays';
}

export interface IdentityProbeResult {
  rigName: string;
  animation: string;
  meshSlotCount: number;
  uvsIdenticalAcrossFrames: boolean;
  trianglesIdenticalAcrossFrames: boolean;
  uploadsPerFrame: Array<{
    time: number;
    uvUploadCount: number;
    triangleUploadCount: number;
    geometryUploadCount: number;
    meshGeometryCount: number;
  }>;
}

async function identityProbe(options: IdentityProbeOptions): Promise<IdentityProbeResult> {
  const assets = await getAssets(options.rigName);
  const dummy = document.createElement('div');
  const player = new RigPlayer(dummy, assets);
  const animation = options.animation ?? assets.animations[0].name;
  player.play(animation);

  const stage = new Container();
  const root = new Container();
  stage.addChild(root);

  const renderer = new PixiRenderer(root, assets);
  if (options.mutant === 'always-reupload') {
    renderer.alwaysReuploadGeometry = true;
  }

  let firstFrameMeshes: Map<
    string,
    { uvs: readonly number[]; triangles: readonly number[] }
  > | null = null;
  let uvsIdenticalAcrossFrames = true;
  let trianglesIdenticalAcrossFrames = true;
  let meshSlotCount = 0;

  const uploadsPerFrame: IdentityProbeResult['uploadsPerFrame'] = [];

  for (const time of options.times) {
    player.seek(time);
    let frame = player.posedFrame();
    const meshes = frame.order.filter((s): s is PosedMesh => s.kind === 'mesh');
    meshSlotCount = meshes.length;

    if (!firstFrameMeshes) {
      firstFrameMeshes = new Map(
        meshes.map((m) => [m.slot, { uvs: m.uvs, triangles: m.triangles }]),
      );
    } else {
      for (const m of meshes) {
        const ref = firstFrameMeshes.get(m.slot);
        if (ref) {
          if (m.uvs !== ref.uvs) uvsIdenticalAcrossFrames = false;
          if (m.triangles !== ref.triangles) trianglesIdenticalAcrossFrames = false;
        }
      }
    }

    if (options.mutant === 'clone-arrays') {
      frame = {
        order: frame.order.map((slot) =>
          slot.kind === 'mesh'
            ? { ...slot, uvs: [...slot.uvs], triangles: [...slot.triangles] }
            : slot,
        ),
      };
    }

    renderer.render(frame);
    uploadsPerFrame.push({
      time,
      uvUploadCount: renderer.uvUploadCount,
      triangleUploadCount: renderer.triangleUploadCount,
      geometryUploadCount: renderer.geometryUploadCount,
      meshGeometryCount: renderer.meshGeometryCount,
    });
  }

  player.dispose();
  renderer.dispose();
  stage.destroy({ children: true });

  return {
    rigName: options.rigName,
    animation,
    meshSlotCount,
    uvsIdenticalAcrossFrames,
    trianglesIdenticalAcrossFrames,
    uploadsPerFrame,
  };
}

// --- Lossless PNG encoder for building premultiplied (`pma: true`) twin pages ---

const PNG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = PNG_CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngAdler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePng(pixels: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const stride = 1 + width * 4;
  const raw = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlib = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let at = 2;
  for (let block = 0; block < blocks; block++) {
    const start = block * 65535;
    const length = Math.min(65535, raw.length - start);
    zlib[at++] = block === blocks - 1 ? 1 : 0;
    zlib[at++] = length & 0xff;
    zlib[at++] = (length >> 8) & 0xff;
    zlib[at++] = ~length & 0xff;
    zlib[at++] = (~length >> 8) & 0xff;
    zlib.set(raw.subarray(start, start + length), at);
    at += length;
  }
  new DataView(zlib.buffer).setUint32(at, pngAdler32(raw));
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

async function makePremultipliedTwinImage(page: HTMLImageElement): Promise<{
  image: HTMLImageElement;
  url: string;
}> {
  const width = page.naturalWidth || page.width;
  const height = page.naturalHeight || page.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2d context unavailable');
  ctx.drawImage(page, 0, 0);
  const src = ctx.getImageData(0, 0, width, height).data;
  const out = new Uint8ClampedArray(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    out[i] = Math.round((src[i] * a) / 255);
    out[i + 1] = Math.round((src[i + 1] * a) / 255);
    out[i + 2] = Math.round((src[i + 2] * a) / 255);
    out[i + 3] = a;
  }
  const pngBytes = encodePng(out, width, height);
  const url = URL.createObjectURL(new Blob([pngBytes.buffer as ArrayBuffer], { type: 'image/png' }));
  const img = new Image();
  img.src = url;
  await img.decode();
  return { image: img, url };
}

const cachedPmaPages = new Map<string, Promise<Map<string, HTMLImageElement>>>();

function getPmaTwinPages(rigName: string, assets: ModelAssets): Promise<Map<string, HTMLImageElement>> {
  let promise = cachedPmaPages.get(rigName);
  if (!promise) {
    promise = (async () => {
      const map = new Map<string, HTMLImageElement>();
      for (const [name, img] of assets.pageImages.entries()) {
        const twin = await makePremultipliedTwinImage(img);
        map.set(name, twin.image);
      }
      return map;
    })();
    cachedPmaPages.set(rigName, promise);
  }
  return promise;
}

export interface PmaProbeOptions {
  rigName: string;
  animation?: string;
  time: number;
  pma: boolean;
  /** When true, passes `pma: false` on slots while feeding the premultiplied twin images (the double-premultiply mutant). */
  mutantIgnorePmaFlag?: boolean;
}

export interface PmaProbeResult {
  rigName: string;
  animation: string;
  time: number;
  pma: boolean;
  alphaModes: Record<string, string>;
  additiveSlots: string[];
  canvasPngBase64: string;
  pixiPngBase64: string;
}

async function pmaProbe(options: PmaProbeOptions): Promise<PmaProbeResult> {
  const baseAssets = await getAssets(options.rigName);
  const pmaPages = options.pma ? await getPmaTwinPages(options.rigName, baseAssets) : baseAssets.pageImages;
  const assets: ModelAssets = {
    ...baseAssets,
    pageImages: pmaPages,
  };

  const samples = [0, 0.5, 1.2].map((t) => poseAt(baseAssets, t, options.animation));
  const bounds = computeFrameBounds(samples.map((s) => s.frame));
  const { animation, frame: baseFrame } = poseAt(baseAssets, options.time, options.animation);

  const refFrame: PosedFrame = {
    order: baseFrame.order.map((slot) => ({ ...slot, pma: options.pma })),
  };
  const pixiFrame: PosedFrame = {
    order: baseFrame.order.map((slot) => ({
      ...slot,
      pma: options.mutantIgnorePmaFlag ? false : options.pma,
    })),
  };

  // 1. CanvasRenderer reference on the same page set (`pma` or `straight`).
  const refRoot = document.createElement('div');
  const canvasRenderer = new CanvasRenderer(refRoot, pmaPages);
  canvasRenderer.pixelRatio = 1;
  canvasRenderer.backend = 'webgl';
  canvasRenderer.viewport = {
    x: bounds.left,
    y: bounds.bottomWorld,
    width: bounds.width,
    height: bounds.height,
  };
  canvasRenderer.render(refFrame);
  const canvasPngBase64 = compositeOnBackdrop(canvasRenderer.canvas, bounds.width, bounds.height);
  canvasRenderer.dispose();

  // 2. PixiRenderer on `pixiFrame`.
  const gl = await getPixiGl(bounds.width, bounds.height);
  const stage = new Container();
  const pixiRoot = new Container();
  pixiRoot.position.set(-bounds.left, bounds.topWorld);
  stage.addChild(pixiRoot);

  const pixiRenderer = new PixiRenderer(pixiRoot, assets);
  pixiRenderer.render(pixiFrame);
  gl.render({ container: stage });

  const alphaModes: Record<string, string> = {};
  const additiveSlots: string[] = [];
  for (const slot of pixiFrame.order) {
    const src = pixiRenderer.getPageSource(slot.page);
    if (src) {
      alphaModes[slot.page] = src.alphaMode;
    }
    if (slot.blend === 'Additive') {
      additiveSlots.push(slot.slot);
    }
  }

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
    pma: options.pma,
    alphaModes,
    additiveSlots,
    canvasPngBase64,
    pixiPngBase64,
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
  const figureAssets = await getAssets('figure');

  const walkSample = poseAt(walkAssets, 0.5);
  const figureSample = poseAt(figureAssets, 0.5, 'walk');

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

  const baseRegion = walkSample.frame.order[3] as PosedRegion;
  const baseMesh = figureSample.frame.order.find((s): s is PosedMesh => s.kind === 'mesh')!;

  // Case 1: missing page in assets.pageImages
  {
    const pagesCopy = new Map(walkAssets.pageImages);
    pagesCopy.delete(baseRegion.page);
    const brokenAssets: ModelAssets = {
      ...walkAssets,
      pageImages: pagesCopy,
    };
    runCase('missing-page', brokenAssets, walkSample.frame);
  }

  // Case 2: clip polygon with fewer than 3 vertices (< 6 coordinates)
  {
    const badClipSlot: PosedSlot = {
      ...baseRegion,
      slot: 'clip_too_short_slot',
      clip: {
        polygon: [0, 0, 100, 0],
        inverse: false,
        convex: true,
      },
    };
    runCase('clip-too-short', walkAssets, { order: [badClipSlot] }, walkSample.frame);
  }

  // Case 3: self-crossing (bowtie) clip polygon refused by clipShapeOf
  {
    const crossingClipSlot: PosedSlot = {
      ...baseRegion,
      slot: 'clip_bowtie_slot',
      clip: {
        polygon: [0, 0, 100, 100, 100, 0, 0, 100],
        inverse: false,
        convex: false,
      },
    };
    runCase('clip-self-crossing', walkAssets, { order: [crossingClipSlot] }, walkSample.frame);
  }

  // Case 4: collinear clip polygon (every vertex on one line)
  {
    const collinearClipSlot: PosedSlot = {
      ...baseRegion,
      slot: 'clip_collinear_slot',
      clip: {
        polygon: [0, 0, 50, 50, 100, 100],
        inverse: false,
        convex: true,
      },
    };
    runCase('clip-collinear', walkAssets, { order: [collinearClipSlot] }, walkSample.frame);
  }

  // Case 5: repeated-vertex non-convex clip polygon
  {
    const repeatedClipSlot: PosedSlot = {
      ...baseRegion,
      slot: 'clip_repeated_vertex_slot',
      clip: {
        polygon: [0, 0, 100, 0, 50, 50, 100, 0, 0, 100],
        inverse: false,
        convex: false,
      },
    };
    runCase('clip-repeated-vertices', walkAssets, { order: [repeatedClipSlot] }, walkSample.frame);
  }

  // Case 5b: concave (dart/L-shape) clip polygon marked convex: true
  {
    const nonConvexMarkedConvexSlot: PosedSlot = {
      ...baseRegion,
      slot: 'clip_nonconvex_marked_convex_slot',
      clip: {
        polygon: [0, 0, 100, 0, 30, 30, 0, 100],
        inverse: false,
        convex: true,
      },
    };
    runCase(
      'clip-nonconvex-marked-convex',
      walkAssets,
      { order: [nonConvexMarkedConvexSlot] },
      walkSample.frame,
    );
  }

  // Case 6: mesh slot with out-of-range triangle index
  {
    const badTriMesh: PosedMesh = {
      ...baseMesh,
      slot: 'broken_mesh_tris',
      triangles: [0, 1, 9999],
    };
    runCase('mesh-bad-triangles', figureAssets, { order: [badTriMesh] }, figureSample.frame);
  }

  // Case 7: mesh slot with mismatched uvs length
  {
    const badUvMesh: PosedMesh = {
      ...baseMesh,
      slot: 'broken_mesh_uvs',
      uvs: [0, 0, 1, 0],
    };
    runCase('mesh-uv-mismatch', figureAssets, { order: [badUvMesh] });
  }

  // Case 8: slot with malformed dark tint
  {
    const badDarkSlot: PosedSlot = {
      ...baseRegion,
      slot: 'bad_dark_slot',
      dark: [0.2, Number.NaN, 0.4],
    };
    runCase('invalid-dark', walkAssets, { order: [badDarkSlot] });
  }

  // Case 9: slot with unknown blend mode
  {
    const badBlendSlot = {
      ...baseRegion,
      slot: 'bad_blend_slot',
      blend: 'Subtract' as unknown as PosedRegion['blend'],
    };
    runCase('invalid-blend', walkAssets, { order: [badBlendSlot] });
  }

  // Case 10: slot with unknown kind
  {
    const badKindSlot = {
      ...baseRegion,
      slot: 'bad_kind_slot',
      kind: 'point' as unknown as PosedRegion['kind'],
    };
    runCase('invalid-kind', walkAssets, { order: [badKindSlot] });
  }

  return results;
}

export interface ParityProbeOptions {
  rigName: string;
  animation?: string;
  times: readonly number[];
  mutantPerturbPose?: boolean;
}

export interface ParityProbeResult {
  rigName: string;
  animation: string;
  checkedTimes: number;
  allSeekFramesByteEqual: boolean;
  allAdvanceFramesByteEqual: boolean;
  allBonesByteEqual: boolean;
  checkedBones: number;
  firstMismatchDetail: string | null;
}

function defaultAnimationFor(assets: ModelAssets): string {
  return assets.animations[0]?.name ?? '';
}

function readBoneNames(rig: PixiRig): readonly string[] {
  let names: readonly string[] = [];
  rig.adjust = (bones) => {
    names = bones.names;
  };
  rig.adjust = null;
  return names;
}

async function parityProbe(options: ParityProbeOptions): Promise<ParityProbeResult> {
  const assets = await getAssets(options.rigName);
  const animName = options.animation ?? defaultAnimationFor(assets);

  const rig = new PixiRig(assets, { ticker: null, autoUpdate: false });
  const bareHost = document.createElement('div');
  const bareMode = assets.regions === 'none' ? 'canvas' : 'dom';
  const bare = new RigPlayer(bareHost, assets, { mode: bareMode });

  rig.play(animName);
  bare.play(animName);

  const boneNames = readBoneNames(rig);
  let allSeekFramesByteEqual = true;
  let allBonesByteEqual = true;
  let firstMismatchDetail: string | null = null;

  for (const t of options.times) {
    rig.seek(t);
    bare.seek(t);

    let drawn = rig.drawnFrame();
    if (options.mutantPerturbPose && drawn.order.length > 0) {
      const first = drawn.order[0];
      const mutatedFirst: PosedSlot =
        first.kind === 'region'
          ? {
              ...first,
              corners: [
                first.corners[0] + 1e-3,
                first.corners[1],
                first.corners[2],
                first.corners[3],
                first.corners[4],
                first.corners[5],
                first.corners[6],
                first.corners[7],
              ],
            }
          : {
              ...first,
              vertices: first.vertices.map((v, idx) => (idx === 0 ? v + 1e-3 : v)),
            };
      drawn = {
        order: [mutatedFirst, ...drawn.order.slice(1)],
      };
    }

    const rigJson = JSON.stringify(drawn);
    const bareJson = JSON.stringify(bare.posedFrame());
    if (rigJson !== bareJson) {
      allSeekFramesByteEqual = false;
      if (!firstMismatchDetail) {
        firstMismatchDetail = `seek(${t}): JSON length rig=${rigJson.length} vs bare=${bareJson.length}`;
      }
    }

    for (const bName of boneNames) {
      const rb = JSON.stringify(rig.bone(bName));
      const bb = JSON.stringify(bare.bone(bName));
      if (rb !== bb) {
        allBonesByteEqual = false;
        if (!firstMismatchDetail) {
          firstMismatchDetail = `bone("${bName}")@${t}: rig=${rb} vs bare=${bb}`;
        }
      }
    }
  }

  // Also verify step-by-step advance(dt) parity across 10 steps of dt = 1/60.
  rig.play(animName);
  bare.play(animName);
  let allAdvanceFramesByteEqual = true;
  const dt = 1 / 60;
  for (let step = 1; step <= 10; step++) {
    rig.advance(dt);
    bare.advance(dt);
    if (JSON.stringify(rig.drawnFrame()) !== JSON.stringify(bare.posedFrame())) {
      allAdvanceFramesByteEqual = false;
      if (!firstMismatchDetail) {
        firstMismatchDetail = `advance step ${step} mismatch`;
      }
    }
  }

  rig.destroy();
  bare.dispose();

  return {
    rigName: options.rigName,
    animation: animName,
    checkedTimes: options.times.length,
    allSeekFramesByteEqual,
    allAdvanceFramesByteEqual,
    allBonesByteEqual,
    checkedBones: boneNames.length,
    firstMismatchDetail,
  };
}

export interface TickerProbeOptions {
  rigName: string;
  animation?: string;
  ticks?: number;
  dt?: number;
  mutant?: 'none' | 'drop-one-tick' | 'ignore-zero-timescale' | 'always-reupload';
}

export interface TickerProbeResult {
  rigName: string;
  animation: string;
  ticks: number;
  dt: number;
  allTicksMatchManualAdvance: boolean;
  finalRecordByteEqual: boolean;
  tickerTimeAfter300: number;
  manualTimeAfter300: number;
  binaryExactCumulativeMatchesAll300: boolean;
  naiveCumulativeMismatchesOutOf300: number;
  naiveCumulativeTimeDriftAt300: number;
  frameHeldWhenTimescaleZero: boolean;
  meshSlotCount: number;
  uploadsDuringTimescaleZero: {
    uvUploads: number;
    triangleUploads: number;
    geometryUploads: number;
    positionUploads: number;
    newMeshGeometries: number;
  };
}

async function tickerProbe(options: TickerProbeOptions): Promise<TickerProbeResult> {
  const assets = await getAssets(options.rigName);
  const animName = options.animation ?? defaultAnimationFor(assets);
  const ticks = options.ticks ?? 300;
  const dt = options.dt ?? 1 / 60;
  const mutant = options.mutant ?? 'none';

  // 1. 300 ticks via PixiJS Ticker vs 300 manual advance(dt) calls.
  const ticker = new Ticker();
  ticker.autoStart = false;

  const tickerRig = new PixiRig(assets, { ticker, autoUpdate: true });
  const manualRig = new PixiRig(assets, { ticker: null, autoUpdate: false });

  tickerRig.play(animName);
  manualRig.play(animName);

  const tickerSteps = mutant === 'drop-one-tick' ? ticks - 1 : ticks;
  let allTicksMatchManualAdvance = true;
  const stepMs = dt * 1000;

  for (let i = 1; i <= ticks; i++) {
    if (i <= tickerSteps) {
      ticker.lastTime = 0;
      ticker.update(stepMs);
    }
    manualRig.advance(dt);
    if (
      tickerRig.time !== manualRig.time ||
      JSON.stringify(tickerRig.drawnFrame()) !== JSON.stringify(manualRig.drawnFrame())
    ) {
      allTicksMatchManualAdvance = false;
    }
  }

  const finalRecordByteEqual =
    JSON.stringify(tickerRig.drawnFrame()) === JSON.stringify(manualRig.drawnFrame());
  const tickerTimeAfter300 = tickerRig.time;
  const manualTimeAfter300 = manualRig.time;

  // Also measure binary-exact cumulative timestamps (dt = 1/50 = 20ms) vs naive cumulative (k * 1000/60)
  // to quantify PixiJS Ticker's `currentTime - lastTime` floating-point behavior.
  const exactTicker = new Ticker();
  exactTicker.autoStart = false;
  exactTicker.lastTime = 0;
  const exactTickerRig = new PixiRig(assets, { ticker: exactTicker, autoUpdate: true });
  const exactManualRig = new PixiRig(assets, { ticker: null, autoUpdate: false });
  exactTickerRig.play(animName);
  exactManualRig.play(animName);
  let binaryExactCumulativeMatchesAll300 = true;
  for (let k = 1; k <= ticks; k++) {
    exactTicker.update(k * 20);
    exactManualRig.advance(0.02);
    if (JSON.stringify(exactTickerRig.drawnFrame()) !== JSON.stringify(exactManualRig.drawnFrame())) {
      binaryExactCumulativeMatchesAll300 = false;
    }
  }
  exactTickerRig.destroy();
  exactManualRig.destroy();

  const naiveTicker = new Ticker();
  naiveTicker.autoStart = false;
  naiveTicker.lastTime = 0;
  const naiveTickerRig = new PixiRig(assets, { ticker: naiveTicker, autoUpdate: true });
  const naiveManualRig = new PixiRig(assets, { ticker: null, autoUpdate: false });
  naiveTickerRig.play(animName);
  naiveManualRig.play(animName);
  let naiveCumulativeMismatchesOutOf300 = 0;
  for (let k = 1; k <= ticks; k++) {
    naiveTicker.update(k * (1000 / 60));
    naiveManualRig.advance(1 / 60);
    if (JSON.stringify(naiveTickerRig.drawnFrame()) !== JSON.stringify(naiveManualRig.drawnFrame())) {
      naiveCumulativeMismatchesOutOf300++;
    }
  }
  const naiveCumulativeTimeDriftAt300 = Math.abs(naiveTickerRig.time - naiveManualRig.time);
  naiveTickerRig.destroy();
  naiveManualRig.destroy();

  // 2. `timescale = 0` holds the frame and reuses every geometry across 300 ticks (zero uploads).
  tickerRig.seek(0.5);
  const meshSlotCount = tickerRig.drawnFrame().order.filter((s) => s.kind === 'mesh').length;
  const heldBaselineJson = JSON.stringify(tickerRig.drawnFrame());

  tickerRig.timescale = mutant === 'ignore-zero-timescale' ? 1 : 0;
  if (mutant === 'always-reupload') {
    tickerRig.renderer.alwaysReuploadGeometry = true;
  }

  const baseUv = tickerRig.renderer.uvUploadCount;
  const baseTri = tickerRig.renderer.triangleUploadCount;
  const baseGeom = tickerRig.renderer.geometryUploadCount;
  const basePos = tickerRig.renderer.positionUploadCount;
  const baseMeshGeom = tickerRig.renderer.meshGeometryCount;

  let frameHeldWhenTimescaleZero = true;
  for (let i = 1; i <= ticks; i++) {
    ticker.lastTime = 0;
    ticker.update(stepMs);
    if (JSON.stringify(tickerRig.drawnFrame()) !== heldBaselineJson) {
      frameHeldWhenTimescaleZero = false;
    }
  }

  const uploadsDuringTimescaleZero = {
    uvUploads: tickerRig.renderer.uvUploadCount - baseUv,
    triangleUploads: tickerRig.renderer.triangleUploadCount - baseTri,
    geometryUploads: tickerRig.renderer.geometryUploadCount - baseGeom,
    positionUploads: tickerRig.renderer.positionUploadCount - basePos,
    newMeshGeometries: tickerRig.renderer.meshGeometryCount - baseMeshGeom,
  };

  tickerRig.destroy();
  manualRig.destroy();

  return {
    rigName: options.rigName,
    animation: animName,
    ticks,
    dt,
    allTicksMatchManualAdvance,
    finalRecordByteEqual,
    tickerTimeAfter300,
    manualTimeAfter300,
    binaryExactCumulativeMatchesAll300,
    naiveCumulativeMismatchesOutOf300,
    naiveCumulativeTimeDriftAt300,
    frameHeldWhenTimescaleZero,
    meshSlotCount,
    uploadsDuringTimescaleZero,
  };
}

export interface MultiInstanceAggregateCounts {
  activeRigs: number;
  totalSprites: number;
  totalMeshes: number;
  totalGeometries: number;
  totalMasks: number;
  totalFilters: number;
  totalTextureViews: number;
  totalRetainedPageHolds: number;
  livePageTextures: number;
  minPageRefCount: number;
  maxPageRefCount: number;
  allPageSourcesDestroyed: boolean;
}

export interface MultiInstanceProbeOptions {
  rigName: string;
  animation?: string;
  instanceCount?: number;
  mutantSkipLastPageRelease?: boolean;
}

export interface MultiInstanceProbeResult {
  rigName: string;
  animation: string;
  instanceCount: number;
  distinctTimes: number[];
  distinctDrawnFrames: number;
  allTenMatchBarePlayers: boolean;
  sharedPageSourcesIdenticalAcrossAllTen: boolean;
  perRigCountsBefore: PixiRigResourceCounts;
  destroyedRigCountsAfterFirstDestroy: PixiRigResourceCounts;
  survivingRigCountsAfterFirstDestroy: PixiRigResourceCounts;
  aggregateBeforeDestroy: MultiInstanceAggregateCounts;
  aggregateAfterFirstDestroy: MultiInstanceAggregateCounts;
  aggregateAfterNineDestroys: MultiInstanceAggregateCounts;
  aggregateAfterLastDestroy: MultiInstanceAggregateCounts;
}

async function multiInstanceProbe(
  options: MultiInstanceProbeOptions,
): Promise<MultiInstanceProbeResult> {
  const assets = await getAssets(options.rigName);
  const animName = options.animation ?? defaultAnimationFor(assets);
  const count = options.instanceCount ?? 10;

  const gl = await getPixiGl(800, 600);
  const stage = new Container();

  const rigs: PixiRig[] = [];
  const distinctTimes: number[] = [];
  let allTenMatchBarePlayers = true;

  for (let i = 0; i < count; i++) {
    const t = Number((0.05 + i * 0.11).toFixed(4));
    distinctTimes.push(t);
    const rig = new PixiRig(assets, { ticker: null, autoUpdate: false });
    rig.play(animName);
    rig.seek(t);
    stage.addChild(rig);
    rigs.push(rig);

    const bare = new RigPlayer(document.createElement('div'), assets, {
      mode: assets.regions === 'none' ? 'canvas' : 'dom',
    });
    bare.play(animName);
    bare.seek(t);
    if (JSON.stringify(rig.drawnFrame()) !== JSON.stringify(bare.posedFrame())) {
      allTenMatchBarePlayers = false;
    }
    bare.dispose();
  }

  gl.render({ container: stage });

  const distinctDrawnFrames = new Set(rigs.map((r) => JSON.stringify(r.drawnFrame()))).size;

  // Verify all 10 rigs share the exact same ImageSource object for every rendered page.
  const renderedPageNames = Array.from(new Set(rigs[0].drawnFrame().order.map((s) => s.page)));
  const renderedPageImages = renderedPageNames
    .map((name) => assets.pageImages.get(name))
    .filter((img): img is HTMLImageElement => img !== undefined);
  const trackedSources = renderedPageImages
    .map((img) => getSharedPageSource(img))
    .filter((s) => s !== undefined);

  let sharedPageSourcesIdenticalAcrossAllTen = renderedPageNames.length > 0;
  for (const pageName of renderedPageNames) {
    const firstSource = rigs[0].renderer.getPageSource(pageName);
    if (!firstSource) {
      sharedPageSourcesIdenticalAcrossAllTen = false;
      continue;
    }
    for (let i = 1; i < count; i++) {
      if (rigs[i].renderer.getPageSource(pageName) !== firstSource) {
        sharedPageSourcesIdenticalAcrossAllTen = false;
      }
    }
  }

  const measureAggregate = (): MultiInstanceAggregateCounts => {
    let activeRigs = 0;
    let totalSprites = 0;
    let totalMeshes = 0;
    let totalGeometries = 0;
    let totalMasks = 0;
    let totalFilters = 0;
    let totalTextureViews = 0;
    let totalRetainedPageHolds = 0;

    for (const r of rigs) {
      if (!r.renderer.isDisposed) {
        activeRigs++;
      }
      const c = r.resourceCounts();
      totalSprites += c.sprites;
      totalMeshes += c.meshes;
      totalGeometries += c.geometries;
      totalMasks += c.masks;
      totalFilters += c.filters;
      totalTextureViews += c.textureViews;
      totalRetainedPageHolds += c.retainedPages;
    }

    const refCounts = renderedPageImages.map((img) => getPageRefCount(img));
    const minPageRefCount = refCounts.length > 0 ? Math.min(...refCounts) : 0;
    const maxPageRefCount = refCounts.length > 0 ? Math.max(...refCounts) : 0;
    const allPageSourcesDestroyed =
      trackedSources.length > 0 && trackedSources.every((src) => src.destroyed);

    return {
      activeRigs,
      totalSprites,
      totalMeshes,
      totalGeometries,
      totalMasks,
      totalFilters,
      totalTextureViews,
      totalRetainedPageHolds,
      livePageTextures: getLivePageTextureCount(),
      minPageRefCount,
      maxPageRefCount,
      allPageSourcesDestroyed,
    };
  };

  const perRigCountsBefore = rigs[0].resourceCounts();
  const aggregateBeforeDestroy = measureAggregate();

  // Destroy 1st instance (`rigs[0]`): frees only its own objects; other 9 rigs and shared page textures remain live.
  rigs[0].destroy();
  const destroyedRigCountsAfterFirstDestroy = rigs[0].resourceCounts();
  const survivingRigCountsAfterFirstDestroy = rigs[1].resourceCounts();
  const aggregateAfterFirstDestroy = measureAggregate();

  // Verify the surviving 9 rigs still advance and render into the WebGL stage without issue.
  for (let i = 1; i < count; i++) {
    rigs[i].advance(1 / 60);
  }
  gl.render({ container: stage });

  // Destroy instances 1..count-2 (leaving only the last instance `rigs[count - 1]`).
  for (let i = 1; i < count - 1; i++) {
    rigs[i].destroy();
  }
  const aggregateAfterNineDestroys = measureAggregate();

  // Destroy the last instance (`rigs[count - 1]`): frees the shared page textures.
  const lastRig = rigs[count - 1];
  if (options.mutantSkipLastPageRelease) {
    lastRig.renderer.releasePageSourcesOnDispose = false;
  }
  lastRig.destroy();
  const aggregateAfterLastDestroy = measureAggregate();

  // Clean up if mutant left page sources unreleased so subsequent tests see a clean state.
  if (options.mutantSkipLastPageRelease) {
    for (const src of trackedSources) {
      if (!src.destroyed) {
        src.destroy();
      }
    }
    const dummyRoot = new Container();
    const cleaner = new PixiRenderer(dummyRoot, assets);
    cleaner.render(poseAt(assets, 0, animName).frame);
    cleaner.dispose();
    dummyRoot.destroy();
  }

  stage.destroy({ children: true });

  return {
    rigName: options.rigName,
    animation: animName,
    instanceCount: count,
    distinctTimes,
    distinctDrawnFrames,
    allTenMatchBarePlayers,
    sharedPageSourcesIdenticalAcrossAllTen,
    perRigCountsBefore,
    destroyedRigCountsAfterFirstDestroy,
    survivingRigCountsAfterFirstDestroy,
    aggregateBeforeDestroy,
    aggregateAfterFirstDestroy,
    aggregateAfterNineDestroys,
    aggregateAfterLastDestroy,
  };
}

export interface BoundsProbeOptions {
  rigName: string;
  animation?: string;
  times: readonly number[];
  mutant?: 'none' | 'ignore-filter' | 'inflate-width';
}

export interface BoundsCaseSummary {
  time: number;
  filterLabel: string;
  rigBounds: PoseBounds | null;
  bareBounds: PoseBounds | null;
  matches: boolean;
}

export interface BoundsProbeResult {
  rigName: string;
  animation: string;
  totalCases: number;
  allMatch: boolean;
  cases: BoundsCaseSummary[];
}

async function boundsProbe(options: BoundsProbeOptions): Promise<BoundsProbeResult> {
  const assets = await getAssets(options.rigName);
  const animName = options.animation ?? defaultAnimationFor(assets);
  const mutant = options.mutant ?? 'none';

  const rig = new PixiRig(assets, { ticker: null, autoUpdate: false });
  const bare = new RigPlayer(document.createElement('div'), assets, {
    mode: assets.regions === 'none' ? 'canvas' : 'dom',
  });

  rig.play(animName);
  bare.play(animName);

  const slotNames = Array.from(new Set(rig.drawnFrame().order.map((s) => s.slot)));
  const firstSlot = slotNames[0] ?? '';
  const lastSlot = slotNames[slotNames.length - 1] ?? '';

  const filters: Array<{ label: string; filter: SlotFilter | null }> = [
    { label: 'all', filter: null },
    { label: `only:[${firstSlot},${lastSlot}]`, filter: [firstSlot, lastSlot] },
    { label: `hide:[${firstSlot}]`, filter: (slot: string) => slot !== firstSlot },
    { label: 'only:[]', filter: [] },
  ];

  const cases: BoundsCaseSummary[] = [];
  let allMatch = true;

  for (const t of options.times) {
    rig.seek(t);
    bare.seek(t);

    for (const { label, filter } of filters) {
      rig.slots = mutant === 'ignore-filter' ? null : filter;
      bare.slots = filter;

      let rb = rig.bounds();
      if (mutant === 'inflate-width' && rb !== null) {
        rb = { ...rb, width: rb.width + 5 };
      }
      const bb = bare.bounds();
      const matches = JSON.stringify(rb) === JSON.stringify(bb);
      if (!matches) {
        allMatch = false;
      }
      cases.push({
        time: t,
        filterLabel: label,
        rigBounds: rb,
        bareBounds: bb,
        matches,
      });
    }
  }

  rig.destroy();
  bare.dispose();

  return {
    rigName: options.rigName,
    animation: animName,
    totalCases: cases.length,
    allMatch,
    cases,
  };
}

export interface PixiRigRefusalAndFreezeResult {
  refusals: Array<{ name: string; threw: boolean; message: string }>;
  frozenAssetsLifecycleSucceeded: boolean;
  defaultRenderGroupFalse: boolean;
  optInRenderGroupTrue: boolean;
  clippedRenderGroupTrue: boolean;
  allMeshGeometriesBatchMode: boolean;
}

async function pixiRigRefusalAndFreezeProbe(): Promise<PixiRigRefusalAndFreezeResult> {
  const walkAssets = await getAssets('walk');
  const flexAssets = await getAssets('flex');
  const figureAssets = await getAssets('figure');
  const refusals: Array<{ name: string; threw: boolean; message: string }> = [];

  const capture = (name: string, fn: () => void): void => {
    let threw = false;
    let message = '';
    try {
      fn();
    } catch (err) {
      threw = true;
      message = err instanceof Error ? err.message : String(err);
    }
    refusals.push({ name, threw, message });
  };

  capture('invalid-assets', () => {
    new PixiRig(null as unknown as ModelAssets);
  });

  capture('invalid-initial-timescale', () => {
    new PixiRig(walkAssets, { timescale: -1 });
  });

  capture('invalid-render-group', () => {
    new PixiRig(walkAssets, { renderGroup: 'yes' as unknown as boolean });
  });

  const rig = new PixiRig(walkAssets, { ticker: null, autoUpdate: false });

  capture('unknown-animation', () => {
    rig.play('nonexistent_animation_xyz');
  });

  capture('empty-animation-name', () => {
    rig.play('');
  });

  capture('unknown-bone', () => {
    rig.bone('nonexistent_bone_xyz');
  });

  capture('empty-bone-name', () => {
    rig.bone('');
  });

  capture('negative-dt', () => {
    rig.advance(-0.016);
  });

  capture('nan-dt', () => {
    rig.advance(Number.NaN);
  });

  capture('nan-seek', () => {
    rig.seek(Number.NaN);
  });

  capture('negative-timescale-setter', () => {
    rig.timescale = -0.5;
  });

  rig.destroy();

  capture('play-after-destroy', () => {
    rig.play('walk');
  });

  capture('advance-after-destroy', () => {
    rig.advance(0.016);
  });

  capture('seek-after-destroy', () => {
    rig.seek(0.2);
  });

  capture('bone-after-destroy', () => {
    rig.bone('root');
  });

  capture('bounds-after-destroy', () => {
    rig.bounds();
  });

  // Verify that running a full PixiRig lifecycle over frozen ModelAssets and frozen PosedFrames mutates nothing.
  let frozenAssetsLifecycleSucceeded = false;
  const frozenAssets: ModelAssets = Object.freeze({
    ...walkAssets,
    document: Object.freeze({ ...walkAssets.document }),
  });
  const frozenRig = new PixiRig(frozenAssets, { ticker: null, autoUpdate: false });
  frozenRig.play('walk');
  frozenRig.advance(1 / 60);
  frozenRig.seek(0.4);
  const boneNames = readBoneNames(frozenRig);
  const frame = frozenRig.drawnFrame();
  Object.freeze(frame);
  Object.freeze(frame.order);
  for (const slot of frame.order) {
    Object.freeze(slot);
    if (slot.kind === 'region') {
      Object.freeze(slot.corners);
    } else {
      Object.freeze(slot.vertices);
    }
  }
  frozenRig.renderer.render(frame);
  const b = frozenRig.bounds();
  const rootBone = frozenRig.bone(boneNames[0] ?? 'root');
  const defaultRenderGroupFalse = frozenRig.isRenderGroup === false;
  frozenRig.destroy();
  if (b !== null && Number.isFinite(rootBone.x) && Number.isFinite(rootBone.y)) {
    frozenAssetsLifecycleSucceeded = true;
  }

  const optInRig = new PixiRig(walkAssets, {
    ticker: null,
    autoUpdate: false,
    renderGroup: true,
  });
  const optInRenderGroupTrue = optInRig.isRenderGroup === true;
  optInRig.destroy();

  const flexRig = new PixiRig(flexAssets, { ticker: null, autoUpdate: false });
  const allMeshGeometriesBatchMode =
    flexRig.isRenderGroup === false &&
    flexRig.children.every((child) => {
      if (child instanceof Mesh) {
        return child.geometry.batchMode === 'batch';
      }
      return true;
    });
  flexRig.destroy();

  const clippedRig = new PixiRig(figureAssets, { ticker: null, autoUpdate: false });
  clippedRig.play('mask');
  const clippedRenderGroupTrue = clippedRig.isRenderGroup === true;
  clippedRig.destroy();

  return {
    refusals,
    frozenAssetsLifecycleSucceeded,
    defaultRenderGroupFalse,
    optInRenderGroupTrue,
    clippedRenderGroupTrue,
    allMeshGeometriesBatchMode,
  };
}

const harness = {
  BLEND_PIXI,
  inspectRigSlots,
  geometryProbe,
  pictureCaptureProbe,
  identityProbe,
  pmaProbe,
  refusalProbe,
  parityProbe,
  tickerProbe,
  multiInstanceProbe,
  boundsProbe,
  pixiRigRefusalAndFreezeProbe,
};

declare global {
  interface Window {
    rigAdaptersHarness: typeof harness;
  }
}

window.rigAdaptersHarness = harness;
