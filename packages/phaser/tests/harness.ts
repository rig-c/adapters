import * as meshHarness from './full-harness.ts';
import { CanvasRenderer, loadModel, RigPlayer, type ModelAssets, type PosedFrame, type PosedRegion } from '@rig-c/play';
import { fixtureModelUrl } from '@rig-c/adapters-shared/fixtures';
import Phaser from 'phaser';
import { BLEND_PHASER, PhaserRenderer, type PhaserRegionView, readRegionScreenCorners, tintToPhaser } from '../src/index.ts';

const assetsCache = new Map<string, Promise<ModelAssets>>();
export function assetsFor(rig: string): Promise<ModelAssets> {
  let promise = assetsCache.get(rig);
  if (!promise) { promise = loadModel({ modelUrl: fixtureModelUrl(rig) }); assetsCache.set(rig, promise); }
  return promise;
}

let gamePromise: Promise<{ game: Phaser.Game; scene: Phaser.Scene }> | undefined;
export function gameFor(): Promise<{ game: Phaser.Game; scene: Phaser.Scene }> {
  return gamePromise ??= new Promise((resolve) => {
    const game = new Phaser.Game({
      type: Phaser.WEBGL, width: 800, height: 600, transparent: true,
      audio: { noAudio: true }, banner: false,
      render: { antialias: false, antialiasGL: false, roundPixels: false, preserveDrawingBuffer: true },
      scene: { create(this: Phaser.Scene) { queueMicrotask(() => { game.loop.stop(); resolve({ game, scene: this }); }); } },
    });
  });
}

async function regionFrame(rig: string, time: number): Promise<{ assets: ModelAssets; frame: PosedFrame; omitted: string[] }> {
  const assets = await assetsFor(rig);
  const player = new RigPlayer(document.createElement('div'), assets);
  player.play(assets.animations[0].name);
  player.seek(time);
  const complete = player.posedFrame();
  // #17 explicitly measures the region subset; both renderers receive this
  // exact filtered record, without suppressing unsupported fields in either.
  const selected = complete.order.filter((slot) => slot.kind === 'region').map((slot) => slot.slot);
  const frame = player.posedFrame(selected);
  player.dispose();
  return { assets, frame, omitted: complete.order.filter((slot) => slot.kind !== 'region').map((slot) => slot.slot) };
}

function views(root: Phaser.GameObjects.Container): PhaserRegionView[] {
  return root.list.filter((child) => child instanceof Phaser.GameObjects.Mesh2D).map((child) => {
    return child as PhaserRegionView;
  });
}

function blendFactors(renderer: Phaser.Renderer.WebGL.WebGLRenderer, index: number | string): number[] {
  if (typeof index !== 'number') throw new Error(`HARNESS_BLEND: expected numeric native blend index, found ${index}`);
  const factors = renderer.blendModes[index]?.func;
  if (!factors) throw new Error(`HARNESS_BLEND: native blend ${index} has no factors`);
  return [...factors];
}

async function storageProbe() {
  const { scene } = await gameFor();
  const input = 1 + 2 ** -30;
  const mesh = new Phaser.GameObjects.Mesh2D(scene, 0, 0, '__WHITE', [input, 0, 0, 0], []);
  const matrix = mesh.getWorldTransformMatrix();
  const native = scene.sys.game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
  const appended = native.blendModes.length;
  const returned = native.addBlendMode([native.gl.ONE, native.gl.ONE], native.gl.FUNC_ADD);
  native.updateBlendMode(appended, [1, 1, 1, 1], native.gl.FUNC_ADD);
  const result = {
    meshArray: Array.isArray(mesh.vertices), vertex: mesh.vertices[0], input,
    f32: Math.fround(input), vertexRetainsBinary64: mesh.vertices[0] === input && mesh.vertices[0] !== Math.fround(input),
    matrixType: matrix.matrix.constructor.name,
    matrixQuantized: (() => { matrix.tx = input; return matrix.tx === Math.fround(input); })(),
    // Object geometry readback has no extra tolerance: number[] locals through
    // the native float32 transform; final batch coordinates are float32 too.
    readbackTolerance: 0,
    blendRegistration: { returned, appended, actualFactors: blendFactors(native, appended) },
  };
  mesh.destroy();
  return result;
}

async function geometryProbe(rig: string, time: number, mutant: 'none' | 'shift-corner' | 'swap-order' = 'none') {
  const { assets, frame, omitted } = await regionFrame(rig, time);
  const { scene } = await gameFor();
  // Non-dyadic mapping exposes matrix quantization instead of hiding it behind
  // integer translation. The independent expected matrix is explicitly f32.
  const root = scene.add.container(280.1, 360.2).setScale(0.9, 1.1);
  const renderer = new PhaserRenderer(root, assets);
  try {
    renderer.render(frame);
    if (mutant === 'swap-order' && root.length >= 2) root.swap(root.list[0], root.list[root.length - 1]);
    if (mutant === 'shift-corner') views(root)[0].vertices[0] += 0.01;
    let maxError = 0, maxQuantization = 0, coordinates = 0;
    const nativeViews = views(root);
    for (const [index, slot] of frame.order.entries()) {
      if (slot.kind !== 'region') throw new Error('HARNESS_FILTER: non-region survived region filter');
      const actual = readRegionScreenCorners(nativeViews[index]);
      for (let i = 0; i < 8; i += 2) {
        const expected = [Math.fround(0.9) * slot.corners[i] + Math.fround(280.1), Math.fround(1.1) * -slot.corners[i + 1] + Math.fround(360.2)];
        const unquantized = [0.9 * slot.corners[i] + 280.1, 1.1 * -slot.corners[i + 1] + 360.2];
        for (let axis = 0; axis < 2; axis++) {
          maxError = Math.max(maxError, Math.abs(actual[i + axis] - expected[axis]));
          maxQuantization = Math.max(maxQuantization, Math.abs(expected[axis] - unquantized[axis]));
          coordinates++;
        }
      }
    }
    const names = nativeViews.map((view) => view.name);
    return { count: names.length, coordinates, names, expectedNames: frame.order.map((slot) => slot.slot), omitted, maxError, maxQuantization,
      nativeRoutes: nativeViews.map((view) => ({ triangles: view.renderAsTriangles, ordered: view.useOrderedIndices, indexCount: view.indicesOrdered?.length ?? 0 })),
    };
  } finally { renderer.dispose(); root.destroy(); }
}

export function composite(canvas: HTMLCanvasElement): string {
  const target = document.createElement('canvas'); target.width = canvas.width; target.height = canvas.height;
  const ctx = target.getContext('2d'); if (!ctx) throw new Error('HARNESS_CONTEXT: 2d context absent');
  ctx.fillStyle = '#14161a'; ctx.fillRect(0, 0, target.width, target.height); ctx.drawImage(canvas, 0, 0);
  return target.toDataURL().split(',')[1];
}

export type PictureMutant = 'none' | 'drop-slot' | 'swap-order' | 'drop-tint' | 'wrong-blend' | 'flip-uv';
async function pictureProbe(rig: string, time: number, mutant: PictureMutant = 'none') {
  const { assets, frame, omitted } = await regionFrame(rig, time);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const slot of frame.order) {
    if (slot.kind !== 'region') throw new Error('HARNESS_FILTER: expected region');
    for (let i = 0; i < 8; i += 2) {
      minX = Math.min(minX, slot.corners[i]); maxX = Math.max(maxX, slot.corners[i]);
      minY = Math.min(minY, slot.corners[i + 1]); maxY = Math.max(maxY, slot.corners[i + 1]);
    }
  }
  const left = Math.floor(minX) - 16, bottom = Math.floor(minY) - 16, top = Math.ceil(maxY) + 16;
  const width = Math.ceil(maxX) + 16 - left, height = top - bottom;
  const reference = new CanvasRenderer(document.createElement('div'), assets.pageImages);
  reference.pixelRatio = 1; reference.backend = 'webgl';
  reference.viewport = { x: left, y: bottom, width, height }; reference.render(frame);
  const canvasBackend = reference.backendActive;
  const referencePng = composite(reference.canvas); reference.dispose();
  let order = [...frame.order];
  if (mutant === 'drop-slot') order.splice(Math.floor(order.length / 2), 1);
  if (mutant === 'swap-order') order.reverse();
  if (mutant === 'drop-tint') order = order.map((slot) => ({ ...slot, tint: [1, 1, 1, 1] }));
  const { game, scene } = await gameFor();
  game.scale.resize(width, height);
  const root = scene.add.container(-left, top);
  const renderer = new PhaserRenderer(root, assets);
  try {
    renderer.render({ order });
    if (mutant === 'flip-uv') for (const view of views(root)) view.flipV = false;
    if (mutant === 'wrong-blend') for (const view of views(root)) view.setBlendMode(Phaser.BlendModes.ADD);
    const gl = (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl;
    let drawCalls = 0;
    const drawElements = gl.drawElements.bind(gl);
    gl.drawElements = (...args: Parameters<WebGLRenderingContext['drawElements']>) => { drawCalls++; drawElements(...args); };
    try { game.step(0, 0); } finally { gl.drawElements = drawElements; }
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      referencePng, phaserPng: composite(game.canvas), canvasBackend, omitted,
      gpu: { renderer: gl.getParameter(gl.RENDERER), vendor: gl.getParameter(gl.VENDOR), context: gl.getContextAttributes(), version: gl.getParameter(gl.VERSION),
        unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        maxTextures: (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).maxTextures, error: gl.getError(), drawCalls,
      },
      blendTable: { ...BLEND_PHASER }, nativeBlendTable: { Normal: [gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA], Additive: [gl.ONE, gl.ONE, gl.ONE, gl.ONE], Multiply: [gl.DST_COLOR, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA], Screen: [gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_COLOR] },
      states: views(root).map((view) => ({ name: view.name, tint: view.tint, alpha: view.alpha, blend: blendFactors(game.renderer as Phaser.Renderer.WebGL.WebGLRenderer, view.blendMode) })),
      expected: order.map((slot) => ({ name: slot.slot, tint: tintToPhaser(slot.tint).color, alpha: slot.tint[3], blend: mutant === 'wrong-blend' ? blendFactors(game.renderer as Phaser.Renderer.WebGL.WebGLRenderer, Phaser.BlendModes.ADD) : [...BLEND_PHASER[slot.blend]] })),
    };
  } finally { renderer.dispose(); root.destroy(); }
}

async function refusalProbe() {
  const { assets, frame } = await regionFrame('walk', 0.5);
  const { scene } = await gameFor();
  const source = frame.order[0] as PosedRegion;
  const cases: Array<{ name: string; slot: unknown; assets?: ModelAssets }> = [
    { name: 'missing-page', slot: { ...source, slot: 'missing-page', page: 'absent.png' } },
    { name: 'mesh', slot: { ...source, slot: 'mesh', kind: 'mesh' } },
    { name: 'kind', slot: { ...source, slot: 'kind', kind: 'point' } },
    { name: 'clip', slot: { ...source, slot: 'clip', clip: { polygon: [0, 0, 1, 0], inverse: false, convex: true } } },
    { name: 'dark', slot: { ...source, slot: 'dark', dark: [NaN, 0, 0] } },
    { name: 'pma', slot: { ...source, slot: 'pma', pma: 'invalid' } },
    { name: 'blend', slot: { ...source, slot: 'blend', blend: 'Subtract' } },
    { name: 'corners', slot: { ...source, slot: 'corners', corners: [NaN, ...source.corners.slice(1)] } },
    { name: 'uvs', slot: { ...source, slot: 'uvs', uvs: [] } },
    { name: 'tint', slot: { ...source, slot: 'tint', tint: [1, Infinity, 1, 1] } },
  ];
  const root = scene.add.container(); const renderer = new PhaserRenderer(root, assets);
  try {
    renderer.render(frame);
    const before = root.list.map((child) => child.name);
    return cases.map(({ name, slot }) => {
      let message = '';
      try { renderer.render({ order: [slot as PosedRegion] }); } catch (error) { message = String(error); }
      return { name, message, retained: JSON.stringify(root.list.map((child) => child.name)) === JSON.stringify(before) };
    });
  } finally { renderer.dispose(); root.destroy(); }
}

async function coexistenceProbe() {
  const { assets, frame } = await regionFrame('walk', 0.5);
  const { game, scene } = await gameFor();
  game.scale.resize(800, 600);
  const native = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
  const maxTexturesBefore = native.maxTextures;
  const nativeAddBefore = blendFactors(native, Phaser.BlendModes.ADD);
  const red = scene.textures.createCanvas('coexistence-red', 8, 8);
  const green = scene.textures.createCanvas('coexistence-green', 8, 8);
  if (!red || !green) throw new Error('HARNESS_TEXTURE: unable to create ordinary scene textures');
  red.context.fillStyle = '#ff0000'; red.context.fillRect(0, 0, 8, 8); red.refresh();
  green.context.fillStyle = '#00ff00'; green.context.fillRect(0, 0, 8, 8); green.refresh();
  const before = scene.add.image(20, 20, red);
  const first = scene.add.container(200, 450).setScale(0.4);
  const second = scene.add.container(600, 450).setScale(0.4);
  const a = new PhaserRenderer(first, assets), b = new PhaserRenderer(second, assets);
  const after = scene.add.image(780, 20, green);
  try {
    a.render(frame); b.render(frame); game.step(0, 0);
    const copy = document.createElement('canvas'); copy.width = 800; copy.height = 600;
    const ctx = copy.getContext('2d'); if (!ctx) throw new Error('HARNESS_CONTEXT: missing 2d');
    ctx.drawImage(game.canvas, 0, 0);
    return {
      beforePixel: [...ctx.getImageData(20, 20, 1, 1).data], afterPixel: [...ctx.getImageData(780, 20, 1, 1).data],
      order: scene.children.list.map((child) => child === before ? 'before' : child === first ? 'first' : child === second ? 'second' : child === after ? 'after' : 'unexpected'),
      maxTexturesBefore, maxTexturesAfter: native.maxTextures, error: native.gl.getError(),
      nativeAddBefore, nativeAddAfter: blendFactors(native, Phaser.BlendModes.ADD),
      firstNames: first.list.map((child) => child.name), secondNames: second.list.map((child) => child.name), expectedNames: frame.order.map((slot) => slot.slot),
    };
  } finally {
    a.dispose(); b.dispose(); before.destroy(); first.destroy(); second.destroy(); after.destroy(); red.destroy(); green.destroy();
  }
}

async function transparentPaddingProbe(time: number, nativePreset = false) {
  const { assets, frame } = await regionFrame('glow', time);
  const { game, scene } = await gameFor();
  const regions = frame.order as PosedRegion[];
  const xs = regions.flatMap((slot) => slot.corners.filter((_, i) => i % 2 === 0));
  const ys = regions.flatMap((slot) => slot.corners.filter((_, i) => i % 2 === 1));
  const left = Math.floor(Math.min(...xs)) - 16, top = Math.ceil(Math.max(...ys)) + 16;
  const width = Math.ceil(Math.max(...xs)) + 16 - left, height = top - Math.floor(Math.min(...ys)) + 16;
  game.scale.resize(width, height);
  const root = scene.add.container(-left, top), renderer = new PhaserRenderer(root, assets);
  const copy = document.createElement('canvas'); copy.width = width; copy.height = height;
  const ctx = copy.getContext('2d'); if (!ctx) throw new Error('HARNESS_CONTEXT: no pixel reader');
  const pixels = () => { ctx.clearRect(0, 0, width, height); ctx.drawImage(game.canvas, 0, 0); return ctx.getImageData(0, 0, width, height).data; };
  try {
    renderer.render(frame);
    if (nativePreset) for (const view of views(root)) if (view.name.startsWith('spark_')) view.setBlendMode(Phaser.BlendModes.ADD);
    game.step(0, 0); const full = pixels();
    const results = [];
    for (const slot of regions.filter((slot) => slot.slot === 'spark_a' || slot.slot === 'spark_b')) {
      renderer.render({ order: frame.order.filter((other) => other.slot !== slot.slot) });
      if (nativePreset) for (const view of views(root)) if (view.name.startsWith('spark_')) view.setBlendMode(Phaser.BlendModes.ADD);
      game.step(0, 0); const underlying = pixels();
      const page = assets.pageImages.get(slot.page)!;
      const tex = document.createElement('canvas'); tex.width = page.naturalWidth; tex.height = page.naturalHeight;
      const tc = tex.getContext('2d'); if (!tc) throw new Error('HARNESS_CONTEXT: no page reader');
      tc.drawImage(page, 0, 0); const texels = tc.getImageData(0, 0, tex.width, tex.height).data;
      const c = slot.corners, x0 = c[0] - left, y0 = top - c[1];
      const ax = c[6] - c[0], ay = -c[7] + c[1], bx = c[2] - c[0], by = -c[3] + c[1], det = ax * by - ay * bx;
      let measured = 0, changed = 0, maxDelta = 0;
      const bounds = { left: Math.floor(Math.min(c[0], c[2], c[4], c[6]) - left), right: Math.ceil(Math.max(c[0], c[2], c[4], c[6]) - left), top: Math.floor(top - Math.max(c[1], c[3], c[5], c[7])), bottom: Math.ceil(top - Math.min(c[1], c[3], c[5], c[7])) };
      for (let y = bounds.top; y < bounds.bottom; y++) for (let x = bounds.left; x < bounds.right; x++) {
        const dx = x + 0.5 - x0, dy = y + 0.5 - y0;
        const a = (dx * by - dy * bx) / det, b = (ax * dy - ay * dx) / det;
        if (a < 0 || a > 1 || b < 0 || b > 1) continue;
        const u = slot.uvs[0] + a * (slot.uvs[6] - slot.uvs[0]) + b * (slot.uvs[2] - slot.uvs[0]);
        const v = slot.uvs[1] + a * (slot.uvs[7] - slot.uvs[1]) + b * (slot.uvs[3] - slot.uvs[1]);
        const tx = Math.floor(u * tex.width - 0.5), ty = Math.floor(v * tex.height - 0.5);
        // Require all four bilinear neighbours to carry exactly zero alpha.
        // The blend contribution is then mathematically zero: identical RGBA8
        // storage on the two renders gives an exact, zero-UNORM8-delta bar.
        if ([0, 1].some((ox) => [0, 1].some((oy) => texels[(Math.max(0, Math.min(tex.height - 1, ty + oy)) * tex.width + Math.max(0, Math.min(tex.width - 1, tx + ox))) * 4 + 3] !== 0))) continue;
        let delta = 0; for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(full[(y * width + x) * 4 + channel] - underlying[(y * width + x) * 4 + channel]));
        measured++; if (delta > 0) changed++; maxDelta = Math.max(maxDelta, delta);
      }
      results.push({ slot: slot.slot, blend: slot.blend, page: slot.page, bounds, measured, changed, maxDelta, toleranceUNORM8: 0 });
    }
    return results;
  } finally { renderer.dispose(); root.destroy(); }
}

window.phaserHarness = { storageProbe, geometryProbe, pictureProbe, refusalProbe, coexistenceProbe, transparentPaddingProbe };
declare global { interface Window { phaserHarness: {
  storageProbe: typeof storageProbe; geometryProbe: typeof geometryProbe; pictureProbe: typeof pictureProbe; refusalProbe: typeof refusalProbe; coexistenceProbe: typeof coexistenceProbe; transparentPaddingProbe: typeof transparentPaddingProbe;
}; } }

window.phaserMeshHarness = meshHarness;
declare global { interface Window { phaserMeshHarness: typeof meshHarness } }
