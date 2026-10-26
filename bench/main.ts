import { DEFAULT_TIMING_PROTOCOL, parseTimingProtocol, type TimingProtocol } from './timing-protocol.ts';
import { loadModel, type ModelAssets, type PosedFrame } from '@rig-c/play';
import { PixiRig } from '@rig-c/pixi';
import * as PixiNamespace from 'pixi.js';
import { Container, ImageSource, Matrix, WebGLRenderer } from 'pixi.js';
import {
  AtlasAttachmentLoader,
  Physics,
  type SkeletonData,
  SkeletonJson,
  Spine,
  SpineTexture,
  TextureAtlas,
} from '../tests/oracle/pixi-spine-bridge.ts';

export type BenchSkeleton = 'spineboy' | 'raptor';
export type BenchArm = 'spine-pixi-v8' | 'rig-c-pixi' | 'rig-c-pixi-compare';

(window as Window & { __rigBenchPixi?: typeof PixiNamespace }).__rigBenchPixi = PixiNamespace;

export interface CorrectnessSampleResult {
  time: number;
  wholeCanvasMae: number;
  contentUnionMae: number;
  maxDelta: number;
  bad: number;
  rawBad: number;
  contentA: number;
  contentB: number;
  contentUnion: number;
  badRatio: number;
  contentMismatch: number;
  pass: boolean;
}

export interface CorrectnessResult {
  skeleton: BenchSkeleton;
  animation: string;
  canvasWidth: number;
  canvasHeight: number;
  mutant: 'none' | 'time-offset';
  samples: CorrectnessSampleResult[];
  maxWholeCanvasMae: number;
  maxContentUnionMae: number;
  maxBadRatio: number;
  maxContentMismatch: number;
  pass: boolean;
}

export interface FrameBatchResult {
  timingProtocol: TimingProtocol;
  skeleton: BenchSkeleton;
  arm: BenchArm;
  instances: number;
  warmupFrames: number;
  measuredFrames: number;
  dtSeconds: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  poseP50Ms: number;
  drawP50Ms: number;
  drawCallsPerFrame: number;
  trianglesPerFrame: number;
}

export interface DrawCallMutantResult {
  renderGroupMutantSpineboy100x: number;
  meshBatchAutoMutantRaptor100x: number;
  combinedMutantRaptor100x: number;
  pass: boolean;
}

export interface GpuInfo {
  vendor: string;
  renderer: string;
  webglVersion: string;
  userAgent: string;
}

const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 640;
const CHANNEL_TOLERANCE = 24;
const WHOLE_CANVAS_MAE_LIMIT = 2.0;
const CONTENT_UNION_MAE_LIMIT = 6.0;
const BAD_RATIO_LIMIT = 0.005;
const CONTENT_MISMATCH_LIMIT = 0.02;

const SKELETON_PLACEMENT: Record<BenchSkeleton, { x: number; y: number; scale: number; animation: string }> = {
  spineboy: { x: 450, y: 560, scale: 0.65, animation: 'walk' },
  raptor: { x: 480, y: 560, scale: 0.42, animation: 'walk' },
};

interface GlCallCounters {
  drawCalls: number;
  triangles: number;
  reset(): void;
}

let sharedRenderer: WebGLRenderer | null = null;
let sharedCounters: GlCallCounters | null = null;

function instrumentGl(gl: WebGLRenderingContext | WebGL2RenderingContext): GlCallCounters {
  let drawCalls = 0;
  let triangles = 0;

  const origDrawElements = gl.drawElements.bind(gl);
  const origDrawArrays = gl.drawArrays.bind(gl);

  gl.drawElements = (mode: GLenum, count: GLsizei, type: GLenum, offset: GLintptr): void => {
    drawCalls += 1;
    if (mode === gl.TRIANGLES) {
      triangles += Math.floor(count / 3);
    } else if (mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN) {
      triangles += Math.max(0, count - 2);
    }
    origDrawElements(mode, count, type, offset);
  };

  gl.drawArrays = (mode: GLenum, first: GLint, count: GLsizei): void => {
    drawCalls += 1;
    if (mode === gl.TRIANGLES) {
      triangles += Math.floor(count / 3);
    } else if (mode === gl.TRIANGLE_STRIP || mode === gl.TRIANGLE_FAN) {
      triangles += Math.max(0, count - 2);
    }
    origDrawArrays(mode, first, count);
  };

  if ('drawElementsInstanced' in gl && typeof gl.drawElementsInstanced === 'function') {
    const gl2 = gl as WebGL2RenderingContext;
    const origDrawElementsInstanced = gl2.drawElementsInstanced.bind(gl2);
    gl2.drawElementsInstanced = (
      mode: GLenum,
      count: GLsizei,
      type: GLenum,
      offset: GLintptr,
      instanceCount: GLsizei,
    ): void => {
      drawCalls += 1;
      if (mode === gl2.TRIANGLES) {
        triangles += Math.floor(count / 3) * instanceCount;
      }
      origDrawElementsInstanced(mode, count, type, offset, instanceCount);
    };
  }

  return {
    get drawCalls() {
      return drawCalls;
    },
    get triangles() {
      return triangles;
    },
    reset() {
      drawCalls = 0;
      triangles = 0;
    },
  };
}

async function getRenderer(): Promise<{ renderer: WebGLRenderer; counters: GlCallCounters }> {
  if (!sharedRenderer || !sharedCounters) {
    const renderer = new WebGLRenderer();
    await renderer.init({
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
      resolution: 1,
      antialias: false,
      backgroundAlpha: 0,
      preserveDrawingBuffer: true,
      clearBeforeRender: true,
      powerPreference: 'high-performance',
    });
    const host = document.getElementById('bench-host');
    if (host && renderer.canvas instanceof HTMLCanvasElement) {
      host.innerHTML = '';
      host.appendChild(renderer.canvas);
    }
    const counters = instrumentGl(renderer.gl);
    sharedRenderer = renderer;
    sharedCounters = counters;
  } else {
    sharedRenderer.resize(CANVAS_WIDTH, CANVAS_HEIGHT, 1);
  }
  return { renderer: sharedRenderer, counters: sharedCounters };
}

async function getGpuInfo(): Promise<GpuInfo> {
  const { renderer } = await getRenderer();
  const gl = renderer.gl;
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const vendor = dbg
    ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
    : String(gl.getParameter(gl.VENDOR));
  const rendererName = dbg
    ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  const webglVersion = String(gl.getParameter(gl.VERSION));
  return {
    vendor,
    renderer: rendererName,
    webglVersion,
    userAgent: navigator.userAgent,
  };
}

async function requireFetchText(skeleton: string, url: string, cache: RequestCache = 'default'): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { cache });
  } catch (err) {
    throw new Error(
      `BENCH_ASSET_MISSING: ${skeleton} (${url}) network failure: ${err instanceof Error ? err.message : String(err)} — run "bash scripts/fetch-assets.sh"`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `BENCH_ASSET_MISSING: ${skeleton} (${url}) HTTP ${response.status} — run "bash scripts/fetch-assets.sh"`,
    );
  }
  const text = await response.text();
  if (text.trimStart().startsWith('<!doctype html') || text.trimStart().startsWith('<html')) {
    throw new Error(
      `BENCH_ASSET_MISSING: ${skeleton} (${url}) returned HTML fallback instead of asset — run "bash scripts/fetch-assets.sh"`,
    );
  }
  return text;
}

async function requireImage(skeleton: string, url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw new Error(
      `BENCH_ASSET_MISSING: ${skeleton} (${url}) failed to decode image — run "bash scripts/fetch-assets.sh"`,
    );
  }
  if (img.naturalWidth <= 0 || img.naturalHeight <= 0) {
    throw new Error(
      `BENCH_ASSET_MISSING: ${skeleton} (${url}) decoded empty image — run "bash scripts/fetch-assets.sh"`,
    );
  }
  return img;
}

export async function verifyAssets(
  skeleton: string,
  baseUrl = '/bench',
): Promise<{ ok: true; skeleton: string; checkedFiles: string[] }> {
  if (skeleton !== 'spineboy' && skeleton !== 'raptor') {
    throw new Error(
      `BENCH_SKELETON_UNKNOWN: "${skeleton}" (expected "spineboy" or "raptor")`,
    );
  }
  const dir = `${baseUrl}/${skeleton}`;
  const required = [
    `${dir}/skeleton.model.json`,
    `${dir}/${skeleton}-pro.json`,
    `${dir}/${skeleton}.atlas`,
    `${dir}/${skeleton}.png`,
  ];
  for (const fileUrl of required) {
    if (fileUrl.endsWith('.png')) {
      await requireImage(skeleton, fileUrl);
    } else {
      await requireFetchText(skeleton, fileUrl, 'no-store');
    }
  }
  return { ok: true, skeleton, checkedFiles: required };
}

interface LoadedSpineOfficial {
  skeletonData: SkeletonData;
  atlas: TextureAtlas;
  sources: ImageSource[];
  dispose(): void;
}

async function loadSpineOfficial(
  skeleton: BenchSkeleton,
  baseUrl = '/bench',
  cacheBust = '',
  cache: RequestCache = 'default',
): Promise<LoadedSpineOfficial> {
  const dir = `${baseUrl}/${skeleton}`;
  const suffix = cacheBust ? `?cb=${encodeURIComponent(cacheBust)}` : '';
  const [jsonText, atlasText] = await Promise.all([
    requireFetchText(skeleton, `${dir}/${skeleton}-pro.json${suffix}`, cache),
    requireFetchText(skeleton, `${dir}/${skeleton}.atlas${suffix}`, cache),
  ]);
  const atlas = new TextureAtlas(atlasText);
  const sources: ImageSource[] = [];
  for (const page of atlas.pages) {
    const img = await requireImage(skeleton, `${dir}/${page.name}${suffix}`);
    const source = new ImageSource({
      resource: img,
      alphaMode: page.pma ? 'premultiplied-alpha' : 'premultiply-alpha-on-upload',
      scaleMode: 'linear',
      addressMode: 'clamp-to-edge',
      autoGenerateMipmaps: false,
    });
    sources.push(source);
    page.setTexture(SpineTexture.from(source));
  }
  const reader = new SkeletonJson(new AtlasAttachmentLoader(atlas));
  const parsed: unknown = JSON.parse(jsonText);
  const skeletonData = reader.readSkeletonData(parsed);
  return {
    skeletonData,
    atlas,
    sources,
    dispose() {
      atlas.dispose();
      for (const source of sources) {
        source.destroy();
      }
    },
  };
}

interface CompareBundleModule {
  loadModel: typeof loadModel;
  PixiRig: typeof PixiRig;
}

let compareBundleModule: CompareBundleModule | null = null;
const cachedOfficialAssets = new Map<BenchSkeleton, LoadedSpineOfficial>();
const cachedRigPlayAssets = new Map<BenchSkeleton, ModelAssets>();
const cachedCompareRigPlayAssets = new Map<BenchSkeleton, ModelAssets>();

function requireCompareBundle(): CompareBundleModule {
  if (!compareBundleModule) {
    throw new Error('BENCH_COMPARE_BUNDLE: compare bundle is not registered; call registerCompareBundle() first');
  }
  return compareBundleModule;
}

export async function registerCompareBundle(
  source: { moduleUrl?: string; moduleCode?: string; label?: string } | string,
): Promise<{ ok: true; label: string }> {
  const opts = typeof source === 'string' ? { moduleUrl: source, label: source } : source;
  const label = opts.label ?? opts.moduleUrl ?? 'inline-compare-bundle';
  let importUrl = opts.moduleUrl ?? '';
  let revokeUrl = '';
  if (typeof opts.moduleCode === 'string' && opts.moduleCode.length > 0) {
    revokeUrl = URL.createObjectURL(new Blob([opts.moduleCode], { type: 'text/javascript' }));
    importUrl = revokeUrl;
  }
  if (!importUrl) {
    throw new Error(`BENCH_COMPARE_BUNDLE: missing moduleUrl or moduleCode for "${label}"`);
  }
  let imported: unknown;
  try {
    imported = await import(/* @vite-ignore */ importUrl);
  } catch (err) {
    throw new Error(
      `BENCH_COMPARE_BUNDLE: failed to load "${label}": ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    if (revokeUrl) URL.revokeObjectURL(revokeUrl);
  }
  const candidate = imported as Partial<CompareBundleModule> | null;
  if (
    !candidate ||
    typeof candidate.loadModel !== 'function' ||
    typeof candidate.PixiRig !== 'function'
  ) {
    throw new Error(
      `BENCH_COMPARE_BUNDLE: "${label}" must export functions { loadModel, PixiRig }`,
    );
  }
  compareBundleModule = {
    loadModel: candidate.loadModel,
    PixiRig: candidate.PixiRig,
  };
  cachedCompareRigPlayAssets.clear();
  return { ok: true, label };
}

async function loadRigPlayModel(
  skeleton: BenchSkeleton,
  baseUrl = '/bench',
  cacheBust = '',
  arm: 'rig-c-pixi' | 'rig-c-pixi-compare' = 'rig-c-pixi',
): Promise<ModelAssets> {
  const suffix = cacheBust ? `?cb=${encodeURIComponent(cacheBust)}` : '';
  const modelUrl = `${baseUrl}/${skeleton}/skeleton.model.json${suffix}`;
  await requireFetchText(skeleton, modelUrl, cacheBust ? 'no-store' : 'default');
  const loader = arm === 'rig-c-pixi-compare' ? requireCompareBundle().loadModel : loadModel;
  try {
    return await loader({ modelUrl, regions: 'none' });
  } catch (err) {
    throw new Error(
      `BENCH_ASSET_MISSING: ${skeleton} (${modelUrl}) failed to load model: ${err instanceof Error ? err.message : String(err)} — run "bash scripts/fetch-assets.sh"`,
    );
  }
}

async function getCachedSpineOfficial(
  skeleton: BenchSkeleton,
  baseUrl = '/bench',
): Promise<LoadedSpineOfficial> {
  const existing = cachedOfficialAssets.get(skeleton);
  if (existing) return existing;
  const loaded = await loadSpineOfficial(skeleton, baseUrl);
  cachedOfficialAssets.set(skeleton, loaded);
  return loaded;
}

async function getCachedRigPlayModel(
  skeleton: BenchSkeleton,
  baseUrl = '/bench',
  arm: 'rig-c-pixi' | 'rig-c-pixi-compare' = 'rig-c-pixi',
): Promise<ModelAssets> {
  const cache = arm === 'rig-c-pixi-compare' ? cachedCompareRigPlayAssets : cachedRigPlayAssets;
  const existing = cache.get(skeleton);
  if (existing) return existing;
  const loaded = await loadRigPlayModel(skeleton, baseUrl, '', arm);
  cache.set(skeleton, loaded);
  return loaded;
}

function createOfficialInstance(
  skeletonData: SkeletonData,
  animation: string,
  x: number,
  y: number,
  scale: number,
  initialTime: number,
): Spine {
  const spine = new Spine({ skeletonData, autoUpdate: false });
  spine.position.set(x, y);
  spine.scale.set(scale);
  spine.skeleton.setupPose();
  spine.state.setAnimation(0, animation, true);
  spine.update(0);
  spine.skeleton.updateWorldTransform(Physics.reset);
  if (initialTime > 0) {
    spine.update(initialTime);
  }
  return spine;
}

function createRigInstance(
  assets: ModelAssets,
  animation: string,
  x: number,
  y: number,
  scale: number,
  initialTime: number,
  useSeek = true,
  arm: 'rig-c-pixi' | 'rig-c-pixi-compare' = 'rig-c-pixi',
): PixiRig {
  const RigCtor = arm === 'rig-c-pixi-compare' ? requireCompareBundle().PixiRig : PixiRig;
  const rig = new RigCtor(assets, { ticker: null, autoUpdate: false });
  rig.position.set(x, y);
  rig.scale.set(scale);
  rig.play(animation, { loop: true });
  if (useSeek) {
    rig.seek(initialTime);
  } else if (initialTime > 0) {
    rig.advance(initialTime);
  }
  return rig;
}

function readPixelsTopDown(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  width: number,
  height: number,
): Uint8Array {
  const raw = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const flipped = new Uint8Array(width * height * 4);
  const rowBytes = width * 4;
  for (let y = 0; y < height; y++) {
    const srcOffset = (height - 1 - y) * rowBytes;
    const dstOffset = y * rowBytes;
    flipped.set(raw.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
  }
  return flipped;
}

function comparePixelBuffers(
  pa: Uint8Array,
  pb: Uint8Array,
  w: number,
  h: number,
  tolerance = CHANNEL_TOLERANCE,
): Omit<CorrectnessSampleResult, 'time' | 'pass'> {
  const matchesNear = (from: Uint8Array, i: number, into: Uint8Array): boolean => {
    const px = (i / 4) % w;
    const py = (i / 4 - px) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const y = py + dy;
      if (y < 0 || y >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const x = px + dx;
        if (x < 0 || x >= w) continue;
        const j = (y * w + x) * 4;
        if (
          Math.abs(from[i] - into[j]) <= tolerance &&
          Math.abs(from[i + 1] - into[j + 1]) <= tolerance &&
          Math.abs(from[i + 2] - into[j + 2]) <= tolerance &&
          Math.abs(from[i + 3] - into[j + 3]) <= tolerance
        ) {
          return true;
        }
      }
    }
    return false;
  };

  let totalChannelAbsDiff = 0;
  let contentUnionChannelAbsDiff = 0;
  let rawBad = 0;
  let badAB = 0;
  let badBA = 0;
  let maxDelta = 0;
  let contentA = 0;
  let contentB = 0;
  let contentUnion = 0;

  for (let i = 0; i < pa.length; i += 4) {
    const dr = Math.abs(pa[i] - pb[i]);
    const dg = Math.abs(pa[i + 1] - pb[i + 1]);
    const db = Math.abs(pa[i + 2] - pb[i + 2]);
    const da = Math.abs(pa[i + 3] - pb[i + 3]);
    const pixelSum = dr + dg + db + da;
    totalChannelAbsDiff += pixelSum;

    const delta = Math.max(dr, dg, db);
    if (delta > maxDelta) maxDelta = delta;

    const ca = pa[i + 3] > 16 || pa[i] > 8 || pa[i + 1] > 8 || pa[i + 2] > 8;
    const cb = pb[i + 3] > 16 || pb[i] > 8 || pb[i + 1] > 8 || pb[i + 2] > 8;
    if (ca) contentA++;
    if (cb) contentB++;
    if (ca || cb) {
      contentUnion++;
      contentUnionChannelAbsDiff += pixelSum;
    }

    if (delta > tolerance) {
      rawBad++;
      if (!matchesNear(pa, i, pb)) badAB++;
      if (!matchesNear(pb, i, pa)) badBA++;
    }
  }

  const bad = Math.max(badAB, badBA);
  const wholeCanvasMae = Number((totalChannelAbsDiff / pa.length).toFixed(4));
  const contentUnionMae = Number(
    (contentUnion > 0 ? contentUnionChannelAbsDiff / (contentUnion * 4) : 0).toFixed(4),
  );
  const badRatio = Number((bad / Math.max(1, contentUnion)).toFixed(6));
  const contentMismatch = Number(
    (Math.abs(contentA - contentB) / Math.max(1, contentA, contentB)).toFixed(6),
  );

  return {
    wholeCanvasMae,
    contentUnionMae,
    maxDelta,
    bad,
    rawBad,
    contentA,
    contentB,
    contentUnion,
    badRatio,
    contentMismatch,
  };
}

export async function checkCorrectness(
  skeleton: BenchSkeleton,
  options: {
    times?: number[];
    mutant?: 'none' | 'time-offset';
    baseUrl?: string;
    arm?: 'rig-c-pixi' | 'rig-c-pixi-compare';
  } = {},
): Promise<CorrectnessResult> {
  const baseUrl = options.baseUrl ?? '/bench';
  const candidateArm = options.arm ?? 'rig-c-pixi';
  await verifyAssets(skeleton, baseUrl);
  const { renderer } = await getRenderer();
  const gl = renderer.gl;
  const placement = SKELETON_PLACEMENT[skeleton];
  const times = options.times ?? [0, 0.35, 0.7];
  const mutant = options.mutant ?? 'none';

  const [official, rigAssets] = await Promise.all([
    loadSpineOfficial(skeleton, baseUrl),
    loadRigPlayModel(skeleton, baseUrl, '', candidateArm),
  ]);

  const samples: CorrectnessSampleResult[] = [];
  try {
    for (const time of times) {
      const stageA = new Container();
      const spine = createOfficialInstance(
        official.skeletonData,
        placement.animation,
        placement.x,
        placement.y,
        placement.scale,
        time,
      );
      stageA.addChild(spine);
      renderer.render({ container: stageA });
      gl.finish();
      const pixelsA = readPixelsTopDown(gl, CANVAS_WIDTH, CANVAS_HEIGHT);
      stageA.removeChildren();
      spine.destroy({ children: true });
      stageA.destroy({ children: true });

      const stageB = new Container();
      const rigTime = mutant === 'time-offset' ? time + 0.15 : time;
      const rig = createRigInstance(
        rigAssets,
        placement.animation,
        placement.x,
        placement.y,
        placement.scale,
        rigTime,
        true,
        candidateArm,
      );
      stageB.addChild(rig);
      renderer.render({ container: stageB });
      gl.finish();
      const pixelsB = readPixelsTopDown(gl, CANVAS_WIDTH, CANVAS_HEIGHT);
      stageB.removeChildren();
      rig.destroy({ children: true });
      stageB.destroy({ children: true });

      const diff = comparePixelBuffers(pixelsA, pixelsB, CANVAS_WIDTH, CANVAS_HEIGHT);
      const samplePass =
        diff.contentUnion > 5000 &&
        diff.wholeCanvasMae <= WHOLE_CANVAS_MAE_LIMIT &&
        diff.contentUnionMae <= CONTENT_UNION_MAE_LIMIT &&
        diff.badRatio <= BAD_RATIO_LIMIT &&
        diff.contentMismatch <= CONTENT_MISMATCH_LIMIT;
      samples.push({
        time,
        ...diff,
        pass: samplePass,
      });
    }
  } finally {
    official.dispose();
  }

  const maxWholeCanvasMae = Math.max(...samples.map((s) => s.wholeCanvasMae));
  const maxContentUnionMae = Math.max(...samples.map((s) => s.contentUnionMae));
  const maxBadRatio = Math.max(...samples.map((s) => s.badRatio));
  const maxContentMismatch = Math.max(...samples.map((s) => s.contentMismatch));
  const pass = samples.every((s) => s.pass);

  return {
    skeleton,
    animation: placement.animation,
    canvasWidth: CANVAS_WIDTH,
    canvasHeight: CANVAS_HEIGHT,
    mutant,
    samples,
    maxWholeCanvasMae,
    maxContentUnionMae,
    maxBadRatio,
    maxContentMismatch,
    pass,
  };
}

export async function measureLoadToFirstFrame(
  skeleton: BenchSkeleton,
  arm: BenchArm,
  runIndex = 0,
  baseUrl = '/bench',
): Promise<{ skeleton: BenchSkeleton; arm: BenchArm; loadMs: number; drawCalls: number }> {
  const { renderer, counters } = await getRenderer();
  const gl = renderer.gl;
  const placement = SKELETON_PLACEMENT[skeleton];
  const cb = `load-${skeleton}-${arm}-${runIndex}-${ Math.random().toString(36).slice(2) }`;

  const stage = new Container();
  renderer.render({ container: stage });
  gl.finish();

  const t0 = performance.now();
  let drawCalls = 0;

  if (arm === 'spine-pixi-v8') {
    const official = await loadSpineOfficial(skeleton, baseUrl, cb, 'no-store');
    const spine = createOfficialInstance(
      official.skeletonData,
      placement.animation,
      placement.x,
      placement.y,
      placement.scale,
      0,
    );
    stage.addChild(spine);
    counters.reset();
    renderer.render({ container: stage });
    gl.finish();
    const loadMs = Number((performance.now() - t0).toFixed(3));
    drawCalls = counters.drawCalls;
    stage.removeChildren();
    spine.destroy({ children: true });
    stage.destroy({ children: true });
    official.dispose();
    return { skeleton, arm, loadMs, drawCalls };
  }

  const assets = await loadRigPlayModel(skeleton, baseUrl, cb, arm);
  const rig = createRigInstance(
    assets,
    placement.animation,
    placement.x,
    placement.y,
    placement.scale,
    0,
    true,
    arm,
  );
  stage.addChild(rig);
  counters.reset();
  renderer.render({ container: stage });
  gl.finish();
  const loadMs = Number((performance.now() - t0).toFixed(3));
  drawCalls = counters.drawCalls;
  stage.removeChildren();
  rig.destroy({ children: true });
  stage.destroy({ children: true });
  return { skeleton, arm, loadMs, drawCalls };
}

interface PreparedStage {
  skeleton: BenchSkeleton;
  arm: BenchArm;
  instances: number;
  warmupFrames: number;
  stage: Container;
  resetPhase(): void;
  poseAll(dt: number): void;
  drawAll(options?: { clear?: boolean; transform?: Matrix }): void;
  dispose(): void;
}

let activePreparedStage: PreparedStage | null = null;
const preparedStages = new Map<BenchArm, PreparedStage>();

function computePlacementGrid(
  skeleton: BenchSkeleton,
  count: number,
): Array<{ x: number; y: number; scale: number; phase: number }> {
  const base = SKELETON_PLACEMENT[skeleton];
  if (count === 1) {
    return [{ x: base.x, y: base.y, scale: base.scale, phase: 0 }];
  }
  const cols = Math.ceil(Math.sqrt(count * (CANVAS_WIDTH / CANVAS_HEIGHT)));
  const rows = Math.ceil(count / cols);
  const cellW = (CANVAS_WIDTH - 120) / Math.max(1, cols);
  const cellH = (CANVAS_HEIGHT - 100) / Math.max(1, rows);
  const scaleFactor = Math.min(1, Math.max(0.22, 1.8 / Math.sqrt(count)));
  const scale = base.scale * scaleFactor;
  const items: Array<{ x: number; y: number; scale: number; phase: number }> = [];
  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = 60 + (col + 0.5) * cellW;
    const y = 80 + (row + 0.85) * cellH;
    const phase = Number(((i * 0.07) % 1.0).toFixed(4));
    items.push({ x, y, scale, phase });
  }
  return items;
}

export async function prepareBenchmarkStage(
  skeleton: BenchSkeleton,
  arm: BenchArm,
  instances: number,
  warmupFrames = 60,
  baseUrl = '/bench',
  options: { keepPrepared?: boolean } = {},
): Promise<{ skeleton: BenchSkeleton; arm: BenchArm; instances: number; warmupFrames: number; drawCallsPerFrame: number; trianglesPerFrame: number }> {
  if (!options.keepPrepared) {
    for (const existing of preparedStages.values()) {
      existing.dispose();
    }
    preparedStages.clear();
    if (activePreparedStage) {
      activePreparedStage = null;
    }
  } else {
    const existingForArm = preparedStages.get(arm);
    if (existingForArm) {
      existingForArm.dispose();
      preparedStages.delete(arm);
    }
  }
  const winWithGc = window as Window & { gc?: () => void };
  if (typeof winWithGc.gc === 'function') {
    winWithGc.gc();
  }
  const { renderer, counters } = await getRenderer();
  const gl = renderer.gl;
  const placement = SKELETON_PLACEMENT[skeleton];
  const grid = computePlacementGrid(skeleton, instances);
  const dt = 1 / 60;
  const stage = new Container();

  if (arm === 'spine-pixi-v8') {
    const official = await getCachedSpineOfficial(skeleton, baseUrl);
    const spines: Spine[] = [];
    for (const slot of grid) {
      const spine = createOfficialInstance(
        official.skeletonData,
        placement.animation,
        slot.x,
        slot.y,
        slot.scale,
        slot.phase,
      );
      spines.push(spine);
      stage.addChild(spine);
    }
    const resetPhase = (): void => {
      for (let i = 0; i < spines.length; i++) {
        const s = spines[i];
        const phase = grid[i].phase;
        s.skeleton.setupPose();
        s.state.setAnimation(0, placement.animation, true);
        s.update(0);
        s.skeleton.updateWorldTransform(Physics.reset);
        if (phase > 0) {
          s.update(phase);
        }
      }
    };
    const poseAll = (stepDt: number): void => {
      for (let i = 0; i < spines.length; i++) {
        spines[i].update(stepDt);
      }
    };
    const drawAll = (options: { clear?: boolean; transform?: Matrix } = {}): void => {
      renderer.render({ container: stage, ...options });
    };
    for (let f = 0; f < warmupFrames; f++) {
      poseAll(dt);
      drawAll();
    }
    gl.finish();
    counters.reset();
    poseAll(dt);
    drawAll();
    gl.finish();
    const drawCallsPerFrame = counters.drawCalls;
    const trianglesPerFrame = counters.triangles;

    let disposed = false;
    const prepared: PreparedStage = {
      skeleton,
      arm,
      instances,
      warmupFrames,
      stage,
      resetPhase,
      poseAll,
      drawAll,
      dispose() {
        if (disposed) return;
        disposed = true;
        stage.removeChildren();
        for (const s of spines) {
          s.destroy({ children: true });
        }
        stage.destroy({ children: true });
      },
    };
    preparedStages.set(arm, prepared);
    activePreparedStage = prepared;
    return { skeleton, arm, instances, warmupFrames, drawCallsPerFrame, trianglesPerFrame };
  }

  const assets = await getCachedRigPlayModel(skeleton, baseUrl, arm);
  const rigs: PixiRig[] = [];
  const posedFrames: PosedFrame[] = new Array<PosedFrame>(grid.length);
  for (let i = 0; i < grid.length; i++) {
    const slot = grid[i];
    const rig = createRigInstance(
      assets,
      placement.animation,
      slot.x,
      slot.y,
      slot.scale,
      slot.phase,
      false,
      arm,
    );
    rigs.push(rig);
    posedFrames[i] = rig.drawnFrame();
    stage.addChild(rig);
  }
  const resetPhase = (): void => {
    for (let i = 0; i < rigs.length; i++) {
      const r = rigs[i];
      const phase = grid[i].phase;
      r.player.play(placement.animation, { loop: true });
      if (phase > 0) {
        r.player.advance(phase);
      }
      posedFrames[i] = r.player.posedFrame();
    }
  };
  const poseAll = (stepDt: number): void => {
    for (let i = 0; i < rigs.length; i++) {
      const r = rigs[i];
      r.player.advance(stepDt);
      posedFrames[i] = r.player.posedFrame();
    }
  };
  const drawAll = (options: { clear?: boolean; transform?: Matrix } = {}): void => {
    for (let i = 0; i < rigs.length; i++) {
      rigs[i].renderer.render(posedFrames[i]);
    }
    renderer.render({ container: stage, ...options });
  };
  for (let f = 0; f < warmupFrames; f++) {
    poseAll(dt);
    drawAll();
  }
  gl.finish();
  counters.reset();
  poseAll(dt);
  drawAll();
  gl.finish();
  const drawCallsPerFrame = counters.drawCalls;
  const trianglesPerFrame = counters.triangles;

  let disposed = false;
  const prepared: PreparedStage = {
    skeleton,
    arm,
    instances,
    warmupFrames,
    stage,
    resetPhase,
    poseAll,
    drawAll,
    dispose() {
      if (disposed) return;
      disposed = true;
      stage.removeChildren();
      for (const r of rigs) {
        r.destroy({ children: true });
      }
      stage.destroy({ children: true });
    },
  };
  preparedStages.set(arm, prepared);
  activePreparedStage = prepared;
  return { skeleton, arm, instances, warmupFrames, drawCallsPerFrame, trianglesPerFrame };
}

export function activatePreparedStage(arm: BenchArm): { arm: BenchArm; skeleton: BenchSkeleton; instances: number } {
  const prepared = preparedStages.get(arm);
  if (!prepared) {
    throw new Error(`BENCH_STAGE_NOT_PREPARED: arm "${arm}" is not prepared; call prepareBenchmarkStage() first`);
  }
  activePreparedStage = prepared;
  return { arm: prepared.arm, skeleton: prepared.skeleton, instances: prepared.instances };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function summarizeFrameBatch(
  prepared: PreparedStage,
  times: number[],
  poseTimes: number[],
  drawTimes: number[],
  totalDrawCalls: number,
  totalTriangles: number,
  timingProtocol: TimingProtocol,
): FrameBatchResult {
  const measuredFrames = times.length;
  const sorted = [...times].sort((a, b) => a - b);
  const sortedPose = [...poseTimes].sort((a, b) => a - b);
  const sortedDraw = [...drawTimes].sort((a, b) => a - b);
  const sum = times.reduce((acc, v) => acc + v, 0);
  return {
    timingProtocol,
    skeleton: prepared.skeleton,
    arm: prepared.arm,
    instances: prepared.instances,
    warmupFrames: prepared.warmupFrames,
    measuredFrames,
    dtSeconds: 1 / 60,
    p50Ms: Number(quantile(sorted, 0.5).toFixed(3)),
    p95Ms: Number(quantile(sorted, 0.95).toFixed(3)),
    meanMs: Number((sum / measuredFrames).toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    poseP50Ms: Number(quantile(sortedPose, 0.5).toFixed(3)),
    drawP50Ms: Number(quantile(sortedDraw, 0.5).toFixed(3)),
    drawCallsPerFrame: Math.round(totalDrawCalls / measuredFrames),
    trianglesPerFrame: Math.round(totalTriangles / measuredFrames),
  };
}

export async function runPreparedFrames(
  measuredFrames = 300,
  protocol: TimingProtocol = DEFAULT_TIMING_PROTOCOL,
): Promise<FrameBatchResult> {
  const timingProtocol = parseTimingProtocol(protocol);
  if (!activePreparedStage) {
    throw new Error('BENCH_STAGE_NOT_PREPARED: call prepareBenchmarkStage() before runPreparedFrames()');
  }
  const prepared = activePreparedStage;
  const { renderer, counters } = await getRenderer();
  const gl = renderer.gl;
  const dt = 1 / 60;
  const times: number[] = new Array<number>(measuredFrames);
  const poseTimes: number[] = new Array<number>(measuredFrames);
  const drawTimes: number[] = new Array<number>(measuredFrames);
  let totalDrawCalls = 0;
  let totalTriangles = 0;

  // Exclude pending warm-up/prior work from the first v2 sample.
  if (timingProtocol === 'gpu-complete-v2') {
    gl.finish();
  }
  for (let f = 0; f < measuredFrames; f++) {
    counters.reset();
    const t0 = performance.now();
    prepared.poseAll(dt);
    const t1 = performance.now();
    prepared.drawAll();
    if (timingProtocol === 'gpu-complete-v2') gl.finish();
    const t2 = performance.now();
    poseTimes[f] = t1 - t0;
    drawTimes[f] = t2 - t1;
    times[f] = t2 - t0;
    totalDrawCalls += counters.drawCalls;
    totalTriangles += counters.triangles;
  }

  return summarizeFrameBatch(prepared, times, poseTimes, drawTimes, totalDrawCalls, totalTriangles, timingProtocol);
}

export async function collectPreparedRuns(
  runs: number,
  measuredFrames: number,
  checkRepro: boolean,
  protocol: TimingProtocol = DEFAULT_TIMING_PROTOCOL,
  options: { skipPreWarmup?: boolean; settleFrames?: number } = {},
): Promise<{ set1: FrameBatchResult[]; set2: FrameBatchResult[] }> {
  const timingProtocol = parseTimingProtocol(protocol);
  if (!activePreparedStage) {
    throw new Error('BENCH_STAGE_NOT_PREPARED: call prepareBenchmarkStage() before collectPreparedRuns()');
  }
  const prepared = activePreparedStage;
  const { renderer, counters } = await getRenderer();
  const gl = renderer.gl;
  const dt = 1 / 60;

  if (!options.skipPreWarmup) {
    const winWithGc = window as Window & { gc?: () => void };
    if (typeof winWithGc.gc === 'function') {
      winWithGc.gc();
      winWithGc.gc();
    }
    // Keep CPU P-core frequency and GPU command queue in steady state right after GC
    for (let w = 0; w < 45; w++) {
      prepared.poseAll(dt);
      prepared.drawAll();
    }
  } else {
    const settleFrames = options.settleFrames ?? 0;
    for (let w = 0; w < settleFrames; w++) {
      prepared.poseAll(dt);
      prepared.drawAll();
    }
  }

  if (timingProtocol === 'gpu-complete-v2') {
    gl.finish();
  }
  const set1: FrameBatchResult[] = [];
  const set2: FrameBatchResult[] = [];
  for (let r = 0; r < runs; r++) {
    if (!checkRepro) {
      set1.push(await runPreparedFrames(measuredFrames, timingProtocol));
    } else {
      const times1: number[] = new Array<number>(measuredFrames);
      const pose1: number[] = new Array<number>(measuredFrames);
      const draw1: number[] = new Array<number>(measuredFrames);
      const times2: number[] = new Array<number>(measuredFrames);
      const pose2: number[] = new Array<number>(measuredFrames);
      const draw2: number[] = new Array<number>(measuredFrames);
      let drawCalls1 = 0;
      let triangles1 = 0;
      let drawCalls2 = 0;
      let triangles2 = 0;
      for (let f = 0; f < measuredFrames; f++) {
        counters.reset();
        const t10 = performance.now();
        prepared.poseAll(dt);
        const t11 = performance.now();
        prepared.drawAll();
        if (timingProtocol === 'gpu-complete-v2') gl.finish();
        const t12 = performance.now();
        pose1[f] = t11 - t10;
        draw1[f] = t12 - t11;
        times1[f] = t12 - t10;
        drawCalls1 += counters.drawCalls;
        triangles1 += counters.triangles;

        counters.reset();
        const t20 = performance.now();
        prepared.poseAll(dt);
        const t21 = performance.now();
        prepared.drawAll();
        if (timingProtocol === 'gpu-complete-v2') gl.finish();
        const t22 = performance.now();
        pose2[f] = t21 - t20;
        draw2[f] = t22 - t21;
        times2[f] = t22 - t20;
        drawCalls2 += counters.drawCalls;
        triangles2 += counters.triangles;
      }
      set1.push(summarizeFrameBatch(prepared, times1, pose1, draw1, drawCalls1, triangles1, timingProtocol));
      set2.push(summarizeFrameBatch(prepared, times2, pose2, draw2, drawCalls2, triangles2, timingProtocol));
    }
  }
  gl.finish();
  return { set1, set2 };
}

export async function runInterleavedArmBatch(
  arm: BenchArm,
  measuredFrames: number,
  checkRepro: boolean,
  protocol: TimingProtocol = DEFAULT_TIMING_PROTOCOL,
  settleFrames = 4,
): Promise<{ set1: FrameBatchResult[]; set2: FrameBatchResult[] }> {
  activatePreparedStage(arm);
  return collectPreparedRuns(1, measuredFrames, checkRepro, protocol, {
    skipPreWarmup: true,
    settleFrames,
  });
}

export async function checkDrawCallMutants(baseUrl = '/bench'): Promise<DrawCallMutantResult> {
  const { renderer, counters } = await getRenderer();
  const gl = renderer.gl;

  // Mutant 1: enable per-instance RenderGroup (`renderGroup: true`) on 100 spineboy instances
  const spineboyAssets = await getCachedRigPlayModel('spineboy', baseUrl);
  const spineboyGrid = computePlacementGrid('spineboy', 100);
  const spineboyPlacement = SKELETON_PLACEMENT.spineboy;
  const stage1 = new Container();
  const rigs1: PixiRig[] = [];
  for (const slot of spineboyGrid) {
    const rig = new PixiRig(spineboyAssets, {
      ticker: null,
      autoUpdate: false,
      renderGroup: true,
    });
    rig.position.set(slot.x, slot.y);
    rig.scale.set(slot.scale);
    rig.play(spineboyPlacement.animation, { loop: true });
    rigs1.push(rig);
    stage1.addChild(rig);
  }
  counters.reset();
  renderer.render({ container: stage1 });
  gl.finish();
  const renderGroupMutantSpineboy100x = counters.drawCalls;
  stage1.removeChildren();
  for (const r of rigs1) r.destroy({ children: true });
  stage1.destroy({ children: true });

  // Mutant 2: set MeshGeometry batchMode = 'auto' on 100 raptor instances
  const raptorAssets = await getCachedRigPlayModel('raptor', baseUrl);
  const raptorGrid = computePlacementGrid('raptor', 100);
  const raptorPlacement = SKELETON_PLACEMENT.raptor;
  const stage2 = new Container();
  const rigs2: PixiRig[] = [];
  for (const slot of raptorGrid) {
    const rig = new PixiRig(raptorAssets, { ticker: null, autoUpdate: false });
    rig.renderer.meshBatchMode = 'auto';
    // Re-set existing geometries created during constructor's initial render to 'auto'
    for (const child of rig.children) {
      if ('geometry' in child && child.geometry) {
        (child.geometry as { batchMode: 'auto' | 'batch' }).batchMode = 'auto';
      }
    }
    rig.position.set(slot.x, slot.y);
    rig.scale.set(slot.scale);
    rig.play(raptorPlacement.animation, { loop: true });
    rigs2.push(rig);
    stage2.addChild(rig);
  }
  counters.reset();
  renderer.render({ container: stage2 });
  gl.finish();
  const meshBatchAutoMutantRaptor100x = counters.drawCalls;
  stage2.removeChildren();
  for (const r of rigs2) r.destroy({ children: true });
  stage2.destroy({ children: true });

  // Mutant 3: both `renderGroup: true` and `meshBatchMode = 'auto'` on 100 raptor instances (reproducing old 300 draw calls)
  const stage3 = new Container();
  const rigs3: PixiRig[] = [];
  for (const slot of raptorGrid) {
    const rig = new PixiRig(raptorAssets, {
      ticker: null,
      autoUpdate: false,
      renderGroup: true,
    });
    rig.renderer.meshBatchMode = 'auto';
    for (const child of rig.children) {
      if ('geometry' in child && child.geometry) {
        (child.geometry as { batchMode: 'auto' | 'batch' }).batchMode = 'auto';
      }
    }
    rig.position.set(slot.x, slot.y);
    rig.scale.set(slot.scale);
    rig.play(raptorPlacement.animation, { loop: true });
    rigs3.push(rig);
    stage3.addChild(rig);
  }
  counters.reset();
  renderer.render({ container: stage3 });
  gl.finish();
  const combinedMutantRaptor100x = counters.drawCalls;
  stage3.removeChildren();
  for (const r of rigs3) r.destroy({ children: true });
  stage3.destroy({ children: true });

  return {
    renderGroupMutantSpineboy100x,
    meshBatchAutoMutantRaptor100x,
    combinedMutantRaptor100x,
    pass:
      renderGroupMutantSpineboy100x === 100 &&
      meshBatchAutoMutantRaptor100x === 201 &&
      combinedMutantRaptor100x === 300,
  };
}

// This protocol shares one completion boundary. Arm samples are CPU submission,
// never a partition of the blocking whole-frame completion time.
export async function runSameFramePair(
  skeleton: BenchSkeleton,
  arms: [BenchArm, BenchArm],
  instances: number,
  options: { warmupFrames?: number; measuredFrames?: number; busyArm?: BenchArm; busyMs?: number } = {},
) {
  const warmup = options.warmupFrames ?? 60;
  const count = options.measuredFrames ?? 76;
  if (arms[0] === arms[1] || !arms.every(a => ['spine-pixi-v8', 'rig-c-pixi', 'rig-c-pixi-compare'].includes(a))) {
    throw new Error(`BENCH_SAME_FRAME: expected two distinct known arms, found ${arms}`);
  }
  for (const [name, value, minimum] of [['instances', instances, 1], ['warmupFrames', warmup, 0], ['measuredFrames', count, 1]] as const) {
    if (!Number.isInteger(value) || value < minimum) throw new Error(`BENCH_SAME_FRAME: ${name} found ${value}, needed integer >= ${minimum}`);
  }
  if (options.busyArm && !arms.includes(options.busyArm)) throw new Error(`BENCH_SAME_FRAME: busyArm ${options.busyArm} absent from pair`);
  const busyMs = options.busyMs ?? 0;
  if (!Number.isFinite(busyMs) || busyMs < 0) throw new Error(`BENCH_SAME_FRAME: busyMs found ${busyMs}, needed finite >= 0`);
  await disposePreparedStage();
  const { renderer, counters } = await getRenderer();
  const gl = renderer.gl;
  const scene = new Container();
  const prepared: PreparedStage[] = [];
  const pending: Array<{ query: WebGLQuery; frame: number; arm: number }> = [];
  const gl2 = gl instanceof WebGL2RenderingContext ? gl : null;
  const ext = gl2?.getExtension('EXT_disjoint_timer_query_webgl2') as {
    TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number;
  } | null;
  let gpuStatus = ext ? 'available' : 'unavailable: EXT_disjoint_timer_query_webgl2 not exposed';
  const gpuSamples: Array<[number | null, number | null]> = [];
  const rows: Array<{
    frame: number; order: BenchArm[];
    arms: Array<{ arm: BenchArm; poseMs: number; submitMs: number; cpuMs: number; drawCalls: number }>;
    wholeFrameCompletionMs: number;
  }> = [];
  const offsets = [new Matrix(), new Matrix(1, 0, 0, 1, CANVAS_WIDTH, 0)];
  const drawArm = (index: number) => {
    // Scissor confines even oversized geometry to its half; both renders retain
    // the other half. Pixi resets GL state at the start of the next frame.
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(index * CANVAS_WIDTH, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    prepared[index].drawAll({ clear: false, transform: offsets[index] });
    gl.disable(gl.SCISSOR_TEST);
  };
  const clear = () => {
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  };
  const halves: Array<{ time: number; arm: BenchArm; pass: boolean; wholeCanvasMae: number; contentUnionMae: number; badRatio: number; contentMismatch: number }> = [];
  try {
    for (const arm of arms) {
      await prepareBenchmarkStage(skeleton, arm, instances, 0, '/bench', { keepPrepared: true });
      const stage = preparedStages.get(arm)!;
      prepared.push(stage);
      scene.addChild(stage.stage);
    }
    renderer.resize(CANVAS_WIDTH * 2, CANVAS_HEIGHT);
    // Compare each shared half to its isolated arm at the same phase and
    // placement. The existing cross-runtime oracle also runs before CLI sampling.
    for (const time of [0, 0.35, 0.7]) {
      for (const stage of prepared) { stage.resetPhase(); stage.poseAll(time); }
      clear();
      drawArm(0); drawArm(1); gl.finish();
      const combined = readPixelsTopDown(gl, CANVAS_WIDTH * 2, CANVAS_HEIGHT);
      for (let i = 0; i < 2; i++) {
        const half = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT * 4);
        for (let y = 0; y < CANVAS_HEIGHT; y++) {
          const start = (y * CANVAS_WIDTH * 2 + i * CANVAS_WIDTH) * 4;
          half.set(combined.subarray(start, start + CANVAS_WIDTH * 4), y * CANVAS_WIDTH * 4);
        }
        clear(); drawArm(i); gl.finish();
        const isolated = readPixelsTopDown(gl, CANVAS_WIDTH * 2, CANVAS_HEIGHT);
        const reference = new Uint8Array(half.length);
        for (let y = 0; y < CANVAS_HEIGHT; y++) {
          const start = (y * CANVAS_WIDTH * 2 + i * CANVAS_WIDTH) * 4;
          reference.set(isolated.subarray(start, start + CANVAS_WIDTH * 4), y * CANVAS_WIDTH * 4);
        }
        const diff = comparePixelBuffers(half, reference, CANVAS_WIDTH, CANVAS_HEIGHT);
        const pass = diff.contentUnion > 0 && diff.wholeCanvasMae <= WHOLE_CANVAS_MAE_LIMIT &&
          diff.contentUnionMae <= CONTENT_UNION_MAE_LIMIT && diff.badRatio <= BAD_RATIO_LIMIT && diff.contentMismatch <= CONTENT_MISMATCH_LIMIT;
        halves.push({ time, arm: arms[i], pass, wholeCanvasMae: diff.wholeCanvasMae, contentUnionMae: diff.contentUnionMae, badRatio: diff.badRatio, contentMismatch: diff.contentMismatch });
      }
    }
    if (!halves.every(h => h.pass)) throw new Error(`BENCH_SAME_FRAME_PIXELS: ${JSON.stringify(halves)}`);
    for (const stage of prepared) stage.resetPhase();
    for (let f = -warmup; f < count; f++) {
      const order = (f % 2 === 0) ? [0, 1] : [1, 0];
      if (f === 0) gl.finish();
      const frameStart = performance.now();
      clear();
      const samples = new Array<{ arm: BenchArm; poseMs: number; submitMs: number; cpuMs: number; drawCalls: number }>(2);
      for (const index of order) {
        counters.reset();
        const t0 = performance.now();
        prepared[index].poseAll(1 / 60);
        const t1 = performance.now();
        if (options.busyArm === arms[index]) {
          const until = performance.now() + busyMs;
          while (performance.now() < until) { /* deliberate per-arm CPU negative control */ }
        }
        let query: WebGLQuery | null = null;
        if (f >= 0 && gl2 && ext) {
          query = gl2.createQuery();
          if (!query) throw new Error('BENCH_SAME_FRAME_GPU: createQuery failed');
          gl2.beginQuery(ext.TIME_ELAPSED_EXT, query);
        }
        drawArm(index);
        if (query && gl2 && ext) {
          gl2.endQuery(ext.TIME_ELAPSED_EXT);
          pending.push({ query, frame: f, arm: index });
        }
        const t2 = performance.now();
        samples[index] = { arm: arms[index], poseMs: t1 - t0, submitMs: t2 - t1, cpuMs: t2 - t0, drawCalls: counters.drawCalls };
      }
      gl.finish();
      const end = performance.now();
      if (f >= 0) {
        rows.push({ frame: f, order: order.map(i => arms[i]), arms: samples, wholeFrameCompletionMs: end - frameStart });
        gpuSamples.push([null, null]);
      }
    }
    if (gl2 && ext) {
      // Query availability can change only after yielding back to the browser.
      const deadline = performance.now() + 5000;
      while (pending.length > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (gl2.getParameter(ext.GPU_DISJOINT_EXT)) {
          gpuStatus = 'unavailable: GPU disjoint; all arm GPU samples discarded';
          break;
        }
        for (let i = pending.length - 1; i >= 0; i--) {
          const entry = pending[i];
          if (!gl2.getQueryParameter(entry.query, gl2.QUERY_RESULT_AVAILABLE)) continue;
          gpuSamples[entry.frame][entry.arm] = Number(gl2.getQueryParameter(entry.query, gl2.QUERY_RESULT)) / 1e6;
          gl2.deleteQuery(entry.query); pending.splice(i, 1);
        }
        if (performance.now() > deadline) { gpuStatus = 'unavailable: query result timeout; all arm GPU samples discarded'; break; }
      }
      if (gpuStatus !== 'available') for (const sample of gpuSamples) sample.fill(null);
    }
    const deltas = rows.map(row => row.arms[1].cpuMs - row.arms[0].cpuMs);
    const summary = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return { p50Ms: quantile(sorted, 0.5), p95Ms: quantile(sorted, 0.95), minMs: sorted[0], maxMs: sorted.at(-1), spreadMs: quantile(sorted, 0.95) - quantile(sorted, 0.05) };
    };
    return {
      mode: 'same-frame-ab-v1', skeleton, instances, arms, warmupFrames: warmup, measuredFrames: count,
      gpuStatus, gpuSamplesMs: gpuSamples, halves, frames: rows,
      cpuPairedDifference: summary(deltas),
      gpuPairedDifference: gpuStatus === 'available' ? summary(gpuSamples.map(s => s[1]! - s[0]!)) : null,
      wholeFrameCompletion: summary(rows.map(row => row.wholeFrameCompletionMs)),
      drawCallsPass: rows.every(row => row.arms.every(a => a.drawCalls > 0 && a.drawCalls <= (skeleton === 'spineboy' ? 1 : 3))),
    };
  } finally {
    for (const entry of pending) gl2?.deleteQuery(entry.query);
    scene.removeChildren(); scene.destroy();
    await disposePreparedStage();
    renderer.resize(CANVAS_WIDTH, CANVAS_HEIGHT);
  }
}

export async function disposePreparedStage(): Promise<void> {
  for (const existing of preparedStages.values()) {
    existing.dispose();
  }
  preparedStages.clear();
  if (activePreparedStage) {
    activePreparedStage.dispose();
    activePreparedStage = null;
  }
  const { renderer } = await getRenderer();
  const empty = new Container();
  renderer.render({ container: empty });
  renderer.gl.finish();
  empty.destroy();
}

export interface RigBenchHarness {
  runSameFramePair: typeof runSameFramePair;
  getGpuInfo: typeof getGpuInfo;
  verifyAssets: typeof verifyAssets;
  registerCompareBundle: typeof registerCompareBundle;
  checkCorrectness: typeof checkCorrectness;
  measureLoadToFirstFrame: typeof measureLoadToFirstFrame;
  prepareBenchmarkStage: typeof prepareBenchmarkStage;
  activatePreparedStage: typeof activatePreparedStage;
  runPreparedFrames: typeof runPreparedFrames;
  collectPreparedRuns: typeof collectPreparedRuns;
  runInterleavedArmBatch: typeof runInterleavedArmBatch;
  checkDrawCallMutants: typeof checkDrawCallMutants;
  disposePreparedStage: typeof disposePreparedStage;
}

declare global {
  interface Window {
    __rigBench: RigBenchHarness;
  }
}

window.__rigBench = {
  runSameFramePair,
  getGpuInfo,
  verifyAssets,
  registerCompareBundle,
  checkCorrectness,
  measureLoadToFirstFrame,
  prepareBenchmarkStage,
  activatePreparedStage,
  runPreparedFrames,
  collectPreparedRuns,
  runInterleavedArmBatch,
  checkDrawCallMutants,
  disposePreparedStage,
};
