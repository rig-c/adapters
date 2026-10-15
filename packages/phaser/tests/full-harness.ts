export { officialPicture, disposeOfficialOracle } from './oracle-harness.ts';
import Phaser from 'phaser';
import { CanvasRenderer, RigPlayer, type PosedFrame, type PosedSlot, type ModelAssets } from '@rig-c/play';
import { PhaserRenderer, readMeshScreenVertices } from '../src/index.ts';
import type { SlotView } from '../src/mesh.ts';
import { assetsFor, gameFor, composite } from './harness.ts';
import { makePremultipliedTwinImage } from './png.ts';

export type Mutant = 'none' | 'reverse-map' | 'ignore-clip' | 'drop-dark' | 'double-pma';
export async function pose(rig: string, animation: string, time: number) {
  const assets = await assetsFor(rig);
  const player = new RigPlayer(document.createElement('div'), assets);
  player.play(animation); player.seek(time);
  const frame = player.posedFrame(); player.dispose();
  return { assets, frame };
}
export function bounds(frame: PosedFrame) {
  const coords = frame.order.flatMap((slot) => slot.kind === 'region' ? slot.corners : slot.vertices);
  const xs = coords.filter((_, i) => i % 2 === 0), ys = coords.filter((_, i) => i % 2 === 1);
  const left = Math.floor(Math.min(...xs)) - 16, top = Math.ceil(Math.max(...ys)) + 16;
  const bottom = Math.floor(Math.min(...ys)) - 16;
  return { left, top, bottom, width: Math.ceil(Math.max(...xs)) + 16 - left, height: top - bottom };
}
export function slotViews(root: Phaser.GameObjects.Container): SlotView[] {
  return root.list.filter((view) => view instanceof Phaser.GameObjects.Mesh2D) as SlotView[];
}
function mutated(frame: PosedFrame, mutant: Mutant): PosedFrame {
  return { order: frame.order.map((slot): PosedSlot => {
    if (mutant === 'reverse-map' && slot.kind === 'mesh') return { ...slot, triangles: slot.triangles.map((index) => slot.vertices.length / 2 - 1 - index) };
    if (mutant === 'ignore-clip') return { ...slot, clip: undefined };
    if (mutant === 'drop-dark') return { ...slot, dark: undefined };
    if (mutant === 'double-pma') return { ...slot, pma: false };
    return slot;
  }) };
}

export async function fullGeometry(rig: string, animation: string, time: number) {
  const { assets, frame } = await pose(rig, animation, time);
  const { game, scene } = await gameFor();
  const root = scene.add.container(280.1, 360.2).setScale(0.9, 1.1), renderer = new PhaserRenderer(root, assets);
  try {
    renderer.render(frame); game.step(0, 0);
    let maxError = 0, coordinates = 0;
    for (const view of slotViews(root)) {
      if (view.posedSlot.kind !== 'mesh') continue;
      const actual = readMeshScreenVertices(view), vertices = view.posedSlot.vertices;
      for (let i = 0; i < vertices.length; i += 2) {
        const expected = [Math.fround(Math.fround(0.9) * vertices[i] + Math.fround(280.1)), Math.fround(Math.fround(1.1) * -vertices[i + 1] + Math.fround(360.2))];
        for (let axis = 0; axis < 2; axis++) { maxError = Math.max(maxError, Math.abs(actual[i + axis] - expected[axis])); coordinates++; }
      }
    }
    return { coordinates, maxError, names: slotViews(root).map((view) => view.name), expectedNames: frame.order.map((slot) => slot.slot), meshes: frame.order.filter((slot) => slot.kind === 'mesh').length, clipped: frame.order.filter((slot) => slot.clip).length };
  } finally { renderer.dispose(); root.destroy(); }
}

export async function fullPicture(rig: string, animation: string, time: number, mutant: Mutant = 'none', pma = false) {
  const loaded = await pose(rig, animation, time);
  const urls: string[] = [];
  let assets: ModelAssets = loaded.assets;
  if (pma) {
    const pages = new Map<string, HTMLImageElement>();
    for (const [name, page] of assets.pageImages) { const twin = await makePremultipliedTwinImage(page); pages.set(name, twin.image); urls.push(twin.url); }
    assets = { ...assets, pageImages: pages };
  }
  const frame = pma ? { order: loaded.frame.order.map((slot) => ({ ...slot, pma: true })) } : loaded.frame;
  const box = bounds(frame), reference = new CanvasRenderer(document.createElement('div'), assets.pageImages);
  reference.pixelRatio = 1; reference.backend = 'webgl';
  reference.viewport = { x: box.left, y: box.bottom, width: box.width, height: box.height }; reference.render(frame);
  const referencePng = composite(reference.canvas), backend = reference.backendActive; reference.dispose();
  const { game, scene } = await gameFor(); game.scale.resize(box.width, box.height);
  const root = scene.add.container(-box.left, box.top), renderer = new PhaserRenderer(root, assets);
  try {
    renderer.render(mutated(frame, mutant)); game.step(0, 0);
    return { referencePng, phaserPng: composite(game.canvas), backend,
      uploadPma: slotViews(root).map((view) => ({ slot: view.name, pma: view.posedSlot.pma, nativeMultiply: view.texture.source[0].glTexture!.pma })),
      nativeGlError: (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl.getError(),
    };
  } finally { renderer.dispose(); root.destroy(); for (const url of urls) URL.revokeObjectURL(url); }
}

export async function uploadProbe(always = false) {
  const assets = await assetsFor('figure'), player = new RigPlayer(document.createElement('div'), assets);
  player.play('mask');
  const { game, scene } = await gameFor(), root = scene.add.container(300, 500), renderer = new PhaserRenderer(root, assets);
  const native = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer, gl = native.gl;
  let events: Array<{ buffer: WebGLBuffer | null; bytes: number }> = [];
  const data = gl.bufferData.bind(gl), sub = gl.bufferSubData.bind(gl);
  gl.bufferData = ((target: number, source: number | BufferSource | null, usage: number) => {
    events.push({ buffer: gl.getParameter(target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING), bytes: typeof source === 'number' ? source : source?.byteLength ?? 0 }); data(target, source as BufferSource, usage);
  }) as typeof gl.bufferData;
  gl.bufferSubData = (target, offset, source) => { events.push({ buffer: gl.getParameter(target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING), bytes: source.byteLength }); sub(target, offset, source); };
  try {
    renderer.alwaysReuploadGeometry = always;
    player.seek(0); renderer.render(player.posedFrame()); game.step(0, 0);
    const buffers = slotViews(root).map((view) => view.slotBuffers!);
    const uv = new Set(buffers.map((b) => b.uv.webGLBuffer)), index = new Set(buffers.map((b) => b.index.webGLBuffer)), position = new Set(buffers.map((b) => b.position.webGLBuffer));
    const count = () => ({ uv: events.filter((e) => uv.has(e.buffer)).reduce((n, e) => n + e.bytes, 0), index: events.filter((e) => index.has(e.buffer)).reduce((n, e) => n + e.bytes, 0), position: events.filter((e) => position.has(e.buffer)).reduce((n, e) => n + e.bytes, 0) });
    const initial = count(); events = [];
    const originalStatic = buffers.map((b) => ({ uv: b.uv, index: b.index, uvHandle: b.uv.webGLBuffer, indexHandle: b.index.webGLBuffer }));
    const unchangedStatic = () => slotViews(root).every((view, i) => view.slotBuffers!.uv === originalStatic[i].uv && view.slotBuffers!.index === originalStatic[i].index && view.slotBuffers!.uv.webGLBuffer === originalStatic[i].uvHandle && view.slotBuffers!.index.webGLBuffer === originalStatic[i].indexHandle);
    player.seek(0.5); const frame = player.posedFrame();
    const refs = frame.order.map((slot) => slot.uvs);
    renderer.render(frame); game.step(0, 0); const moving = count(), movingStaticRetained = unchangedStatic(); events = [];
    renderer.render(player.posedFrame()); game.step(0, 0); const held = count(), heldStaticRetained = unchangedStatic();
    const sameWrappers = slotViews(root).every((view, i) => view.slotBuffers === buffers[i]);
    const sameUVs = player.posedFrame().order.every((slot, i) => slot.uvs === refs[i]);
    const mesh = frame.order.find((slot) => slot.kind === 'mesh')!;
    events = [];
    const uvChanged = { order: frame.order.map((slot) => slot === mesh ? { ...slot, uvs: [...slot.uvs] } : slot) };
    renderer.render(uvChanged); game.step(0, 0); const uvOnly = count();
    const unchangedIndexRetained = slotViews(root).every((view, i) => view.slotBuffers!.index === originalStatic[i].index);
    const uvBeforeIndexChange = slotViews(root).map((view) => view.slotBuffers!.uv);
    events = [];
    const indexChanged = { order: uvChanged.order.map((slot) => slot.slot === mesh.slot && slot.kind === 'mesh' ? { ...slot, triangles: [...slot.triangles] } : slot) };
    renderer.render(indexChanged); game.step(0, 0); const indexOnly = count();
    const unchangedUVRetained = slotViews(root).every((view, i) => view.slotBuffers!.uv === uvBeforeIndexChange[i]);
    renderer.dispose();
    return { initial, moving, held, movingStaticRetained, heldStaticRetained, uvOnly, indexOnly, unchangedIndexRetained, unchangedUVRetained, sameWrappers, sameUVs, staticRemoved: buffers.every((b) => !native.glBufferWrappers.includes(b.uv) && !native.glBufferWrappers.includes(b.index) && !native.glVAOWrappers.includes(b.vao)) };
  } finally { gl.bufferData = data; gl.bufferSubData = sub; renderer.dispose(); root.destroy(); player.dispose(); }
}


/** Opaque clip geometry remains hard under parent alpha; later native draws restore stencil. */
export async function clipIntegration(animation: 'window' | 'inverse', sentinel = false) {
  const { assets, frame } = await pose('figure', animation, 0.5);
  const activeClip = frame.order.find((slot) => slot.clip)?.clip;
  if (!activeClip || !frame.order.every((slot) => slot.clip === activeClip)) throw new Error('CLIP_ROOT: fixture must have one shared clip on every drawn slot');
  const box = bounds(frame), reference = new CanvasRenderer(document.createElement('div'), assets.pageImages);
  reference.pixelRatio = 1; reference.backend = 'webgl'; reference.viewport = { x: box.left, y: box.bottom, width: box.width, height: box.height };
  const expectedFrame = { order: frame.order.map((slot): PosedSlot => ({ ...slot, ...(sentinel ? { clip: undefined } : {}), tint: [slot.tint[0], slot.tint[1], slot.tint[2], slot.tint[3] * 0.5] })) };
  reference.render(expectedFrame);
  const expectedCanvas = document.createElement('canvas'); expectedCanvas.width = box.width; expectedCanvas.height = box.height;
  const ctx = expectedCanvas.getContext('2d')!;
  if (sentinel) { ctx.fillStyle = '#41cc63'; ctx.fillRect(0, 0, box.width, box.height); }
  ctx.drawImage(reference.canvas, 0, 0); const referencePng = composite(expectedCanvas); reference.dispose();
  const { game, scene } = await gameFor(); game.scale.resize(box.width, box.height);
  const root = scene.add.container(-box.left, box.top).setAlpha(0.5), renderer = new PhaserRenderer(root, assets);
  let secondRoot: Phaser.GameObjects.Container | undefined, secondRenderer: PhaserRenderer | undefined, marker: Phaser.GameObjects.Rectangle | undefined;
  try {
    renderer.render(frame); game.step(0, 0);
    const helpers = root.list.filter((view) => !(view instanceof Phaser.GameObjects.Mesh2D));
    renderer.render({ order: frame.order.map((slot) => ({ ...slot, clip: { ...slot.clip!, polygon: [...slot.clip!.polygon] } })) });
    game.step(0, 0);
    const retained = helpers.length === root.list.filter((view) => !(view instanceof Phaser.GameObjects.Mesh2D)).length && helpers.every((view) => root.list.includes(view));
    if (sentinel) {
      marker = scene.add.rectangle(box.width / 2, box.height / 2, box.width, box.height, 0x41cc63, 1);
      secondRoot = scene.add.container(-box.left, box.top).setAlpha(0.5); secondRenderer = new PhaserRenderer(secondRoot, assets);
      secondRenderer.render({ order: frame.order.map((slot) => ({ ...slot, clip: undefined })) });
      game.step(0, 0);
    }
    return { referencePng, phaserPng: composite(game.canvas), helperCount: helpers.length, retained, allRootClip: true, nativeGlError: (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl.getError() };
  } finally { secondRenderer?.dispose(); secondRoot?.destroy(); marker?.destroy(); renderer.dispose(); root.destroy(); }
}

async function syntheticMesh() {
  const { assets, frame } = await pose('glow', 'burn', 0), source = frame.order.find((slot) => slot.kind === 'mesh')!;
  if (source.kind !== 'mesh') throw new Error('SYNTHETIC_MESH: expected mesh source metadata');
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 8, 8);
  const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
  return { assets: { ...assets, pageImages: new Map([['synthetic-white', image]]) }, source: { ...source, slot: 'synthetic-mesh', page: 'synthetic-white', tint: [1, 1, 1, 1] as [number, number, number, number], dark: undefined, clip: undefined, pma: false, blend: 'Normal' as const } };
}

/** A nondegenerate white triangle visibly uses the final admitted vertex. */
export async function boundaryProbe() {
  const { assets, source } = await syntheticMesh();
  const vertices = new Array<number>(65535 * 2).fill(0), uvs = new Array<number>(vertices.length).fill(0.5);
  vertices[2] = 80; vertices[3] = 0; vertices[65534 * 2] = 0; vertices[65534 * 2 + 1] = -80;
  const { game, scene } = await gameFor(); game.scale.resize(120, 120);
  const root = scene.add.container(20, 20), renderer = new PhaserRenderer(root, assets);
  try {
    const good = { order: [{ ...source, vertices, uvs, triangles: [0, 1, 65534] }] };
    renderer.render(good); game.step(0, 0);
    const buffer = slotViews(root)[0].slotBuffers!, actualLastIndex = buffer.index.viewU16![2];
    const captured = document.createElement('canvas'); captured.width = captured.height = 120;
    const ctx = captured.getContext('2d')!; ctx.drawImage(game.canvas, 0, 0);
    const data = ctx.getImageData(0, 0, 120, 120).data;
    const visiblePixels = data.filter((_, i) => i % 4 === 3 && data[i] > 0).length;
    const inside = [...ctx.getImageData(30, 30, 1, 1).data], outside = [...ctx.getImageData(110, 110, 1, 1).data];
    let message = '';
    try { renderer.render({ order: [{ ...source, vertices: [...vertices, 0, 0], uvs: [...uvs, 0, 0], triangles: [0, 1, 65535] }] }); } catch (error) { message = String(error); }
    return { actualLastIndex, visiblePixels, inside, outside, acceptedRetained: renderer.drawnFrame === good, message, glError: (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl.getError() };
  } finally { renderer.dispose(); root.destroy(); }
}

/** Updating slot A cannot overwrite the ELEMENT binding retained by slot B's VAO. */
export async function vaoIsolation(mutant = false) {
  const { assets, source } = await syntheticMesh();
  const first = { ...source, slot: 'triangle-A', vertices: [0,0,0,-80,80,-80,80,0], uvs: [0,0,0,1,1,1,1,0], triangles: [0,1,2], tint: [1,0,0,1] as [number,number,number,number] };
  const second = { ...source, slot: 'quad-B', vertices: [100,0,100,-80,180,-80,180,0], uvs: first.uvs, triangles: [0,1,2,0,2,3], tint: [0,0,1,1] as [number,number,number,number] };
  const { game, scene } = await gameFor(); game.scale.resize(220, 120);
  const root = scene.add.container(20, 20), renderer = new PhaserRenderer(root, assets);
  const native = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer, gl = native.gl;
  const draw = native.drawElements.bind(native), update = native.glWrapper.updateVAO.bind(native.glWrapper);
  try {
    renderer.render({ order: [first, second] }); game.step(0, 0);
    const owned = new Set(slotViews(root).map((view) => view.slotBuffers!.vao)); let mismatches = 0;
    native.drawElements = (...args) => {
      const result = draw(...args);
      if (owned.has(args[3]) && gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING) !== args[3].indexBuffer!.webGLBuffer) mismatches++;
      return result;
    };
    if (mutant) native.glWrapper.updateVAO = (state) => { if (state.vao !== null) update(state); };
    const changed = { order: [{ ...first, triangles: [0,1,3] }, second] };
    renderer.render(changed); game.step(0, 0);
    const phaserPng = composite(game.canvas), glError = gl.getError();
    native.glWrapper.updateVAO = update;
    const reference = new CanvasRenderer(document.createElement('div'), assets.pageImages);
    reference.pixelRatio = 1; reference.backend = 'webgl'; reference.viewport = { x: -20, y: -100, width: 220, height: 120 }; reference.render(changed);
    const referencePng = composite(reference.canvas); reference.dispose();
    return { mismatches, glError, referencePng, phaserPng };
  } finally { native.drawElements = draw; native.glWrapper.updateVAO = update; renderer.dispose(); root.destroy(); }
}

export async function samplerProbe() {
  const { assets } = await pose('glow', 'burn', 0), image = assets.pageImages.values().next().value!;
  const { game, scene } = await gameFor(), native = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer, gl = native.gl;
  const texture = native.createTexture2D(0, gl.LINEAR, gl.LINEAR, gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.RGBA, image, image.naturalWidth, image.naturalHeight, true, false, true);
  const sample = () => {
    const previous = gl.getParameter(gl.TEXTURE_BINDING_2D); gl.bindTexture(gl.TEXTURE_2D, texture.webGLTexture);
    const result = [gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER), gl.getTexParameter(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER)]; gl.bindTexture(gl.TEXTURE_2D, previous); return result;
  };
  const created = sample(), wrapped = scene.textures.addGLTexture('sampler-probe', texture)!;
  const registered = sample(); wrapped.setFilter(Phaser.Textures.FilterMode.LINEAR); const explicitLinear = sample(); scene.textures.remove('sampler-probe');
  return { created, registered, explicitLinear, antialias: gl.getContextAttributes()!.antialias };
}

export async function clipValidationProbe() {
  const { assets, frame } = await pose('glow', 'burn', 0), source = frame.order[0];
  const { scene } = await gameFor(), root = scene.add.container(), renderer = new PhaserRenderer(root, assets);
  const base = { inverse: false, convex: false };
  const accept = (polygon: number[]) => { renderer.render({ order: [{ ...source, clip: { ...base, polygon } }] }); return true; };
  try {
    const closing = accept([0,0,4,0,4,4,0,4,0,0]), adjacent = accept([0,0,4,0,4,0,4,4,0,4]);
    const prior = renderer.drawnFrame; let message = '';
    try { accept([0,0,4,0,4,4,4,0,0,4]); } catch (error) { message = String(error); }
    return { closing, adjacent, message, acceptedRetained: prior === renderer.drawnFrame };
  } finally { renderer.dispose(); root.destroy(); }
}
