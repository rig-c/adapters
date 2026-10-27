import { CanvasRenderer, RigPlayer, loadModel, type LiveFrame, type LiveNumbers, type ModelAssets, type PosedFrame, type PosedSlot } from '@rig-c/play';
import { RetainedRuntimeFrame } from '@rig-c/adapters-shared';
import { fixtureModelUrl } from '@rig-c/adapters-shared/fixtures';
import { BufferAttribute, Group, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, Vector3, WebGLRenderer } from 'three';
import { ThreeRenderer, ThreeRig, getLivePageTextureCount, getPageRefCount, readMeshScreenVertices, type ThreeSlotMesh } from '../src/index.ts';
import { makePremultipliedTwinImage } from './png.ts';

const cache = new Map<string, Promise<ModelAssets>>();
async function assetsFor(name: string) { let p = cache.get(name); if (!p) { p = loadModel({ modelUrl: fixtureModelUrl(name) }); cache.set(name, p); } return p; }
async function posed(name: string, animation: string | undefined, time: number) {
  const assets = await assetsFor(name), player = new RigPlayer(document.createElement('div'), assets);
  player.play(animation ?? assets.animations[0].name); player.seek(time);
  const frame = player.posedFrame(); player.dispose(); return { assets, frame };
}
let webgl: WebGLRenderer | undefined;
function host(width: number, height: number) {
  webgl ??= new WebGLRenderer({ alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
  webgl.setPixelRatio(1); webgl.setSize(width, height); webgl.setClearColor(0, 0); return webgl;
}
function bounds(frame: PosedFrame) {
  const points = frame.order.flatMap((s) => s.kind === 'region' ? s.corners : s.vertices);
  const xs = points.filter((_, i) => i % 2 === 0), ys = points.filter((_, i) => i % 2 === 1);
  const left = Math.floor(Math.min(...xs)) - 16, right = Math.ceil(Math.max(...xs)) + 16;
  const top = Math.ceil(Math.max(...ys)) + 16, bottom = Math.floor(Math.min(...ys)) - 16;
  return { left, right, top, bottom, width: right - left, height: top - bottom };
}
function cameraFor(box: ReturnType<typeof bounds>) { const c = new OrthographicCamera(box.left, box.right, box.top, box.bottom, 0.1, 2000); c.position.z = 1000; c.updateMatrixWorld(); return c; }
function composite(canvas: HTMLCanvasElement) {
  const out = document.createElement('canvas'); out.width = canvas.width; out.height = canvas.height;
  const ctx = out.getContext('2d')!; ctx.fillStyle = '#14161a'; ctx.fillRect(0, 0, out.width, out.height); ctx.drawImage(canvas, 0, 0);
  return out.toDataURL('image/png').split(',')[1];
}
function views(root: Group): ThreeSlotMesh[] { return root.children.filter((x) => x instanceof Mesh) as ThreeSlotMesh[]; }
export type Mutant = 'none' | 'drop-slot' | 'swap-order' | 'ignore-clip' | 'drop-dark' | 'ignore-pma' | 'shift-vertex';
function mutated(frame: PosedFrame, mutant: Mutant): PosedFrame {
  const order = frame.order.map((slot): PosedSlot => mutant === 'ignore-clip' ? { ...slot, clip: undefined } : mutant === 'drop-dark' ? { ...slot, dark: undefined } : mutant === 'ignore-pma' ? { ...slot, pma: false } : slot);
  if (mutant === 'drop-slot') order.splice(Math.floor(order.length / 2), 1);
  if (mutant === 'swap-order') order.reverse();
  return { order };
}
export async function format() {
  const value = 1 + 2 ** -30, attribute = new BufferAttribute(new Float32Array([value, 0, 0]), 3);
  return { input: value, stored: attribute.getX(0), quantized: Math.fround(value), format: attribute.array.constructor.name, beyondQuantization: attribute.getX(0) - Math.fround(value) };
}
export async function geometry(name: string, animation: string | undefined, time: number, mutant: Mutant = 'none', perspective = false) {
  const { assets, frame } = await posed(name, animation, time), renderer = host(900, 640), root = new Group(), scene = new Scene(); scene.add(root);
  root.position.set(19.1, -9.2, -12.3); root.scale.set(0.9, 1.1, 1); root.rotation.set(perspective ? 0.2 : 0, perspective ? -0.35 : 0, 0.17);
  const camera = perspective ? new PerspectiveCamera(40, 900 / 640, 0.1, 5000) : new OrthographicCamera(-450, 450, 320, -320, 0.1, 5000); camera.position.z = 1400;
  const draw = new ThreeRenderer(root, assets, renderer);
  try {
    draw.render(frame); if (mutant === 'swap-order') views(root).reverse().forEach((mesh, i) => mesh.renderOrder = i);
    if (mutant === 'shift-vertex') { const attr = views(root)[0].geometry.getAttribute('position'); attr.setX(0, attr.getX(0) + 0.25); attr.needsUpdate = true; }
    renderer.render(scene, camera); root.updateWorldMatrix(true, true); camera.updateWorldMatrix(true, false);
    let coordinates = 0, maxError = 0, quantization = 0, maxLocalError = 0;
    for (const [index, mesh] of views(root).entries()) {
      const slot = frame.order[index], source = slot.kind === 'region' ? slot.corners : slot.vertices;
      const positions = mesh.geometry.getAttribute('position'), actual = readMeshScreenVertices(mesh, camera, 900, 640);
      for (let i = 0; i < source.length; i += 2) {
        const expected = new Vector3(Math.fround(source[i]), Math.fround(source[i + 1]), 0).applyMatrix4(root.matrixWorld).project(camera);
        const exact = new Vector3(source[i], source[i + 1], 0).applyMatrix4(root.matrixWorld).project(camera);
        const pixel = [(expected.x + 1) * 450, (1 - expected.y) * 320], raw = [(exact.x + 1) * 450, (1 - exact.y) * 320];
        maxLocalError = Math.max(maxLocalError, Math.abs(positions.getX(i / 2) - Math.fround(source[i])), Math.abs(positions.getY(i / 2) - Math.fround(source[i + 1])));
        for (let axis = 0; axis < 2; axis++) { maxError = Math.max(maxError, Math.abs(actual[i + axis] - pixel[axis])); quantization = Math.max(quantization, Math.abs(raw[axis] - pixel[axis])); coordinates++; }
      }
    }
    return { coordinates, maxError, maxLocalError, quantization, names: [...views(root)].sort((a, b) => a.renderOrder - b.renderOrder).map((m) => m.name), expected: frame.order.map((s) => s.slot), meshCount: views(root).length, materialCount: new Set(views(root).map((m) => m.material)).size, pageCount: new Set(frame.order.map((s) => s.page)).size, glError: renderer.getContext().getError() };
  } finally { draw.dispose(); }
}
export async function picture(name: string, animation: string | undefined, time: number, mutant: Mutant = 'none', pma = false) {
  const loaded = await posed(name, animation, time), urls: string[] = [];
  let assets = loaded.assets;
  if (pma) {
    const images = new Map<string, HTMLImageElement>();
    for (const [name, page] of assets.pageImages) { const twin = await makePremultipliedTwinImage(page); images.set(name, twin.image); urls.push(twin.url); }
    assets = { ...assets, pageImages: images };
  }
  const frame = pma ? { order: loaded.frame.order.map((s) => ({ ...s, pma: true })) } : loaded.frame;
  const box = bounds(frame), reference = new CanvasRenderer(document.createElement('div'), assets.pageImages);
  reference.pixelRatio = 1; reference.backend = 'webgl'; reference.viewport = { x: box.left, y: box.bottom, width: box.width, height: box.height }; reference.render(frame);
  const referencePng = composite(reference.canvas), backend = reference.backendActive; reference.dispose();
  const renderer = host(box.width, box.height), scene = new Scene(), root = new Group(); scene.add(root);
  const draw = new ThreeRenderer(root, assets, renderer);
  try {
    draw.render(mutated(frame, mutant)); renderer.render(scene, cameraFor(box));
    return { referencePng, threePng: composite(renderer.domElement), backend, glError: renderer.getContext().getError(), slots: frame.order.length, clipped: frame.order.filter((s) => s.clip).length, dark: frame.order.filter((s) => s.dark).length, pma };
  } finally { draw.dispose(); for (const url of urls) URL.revokeObjectURL(url); }
}

/** Instrument the actual host context, after the other player's oracle has posed. */
function observe(renderer: WebGLRenderer) {
  const gl = renderer.getContext(), data = gl.bufferData.bind(gl), sub = gl.bufferSubData.bind(gl), create = gl.createBuffer.bind(gl), remove = gl.deleteBuffer.bind(gl);
  const owned = new Set<WebGLBuffer>(), textures = new Set<WebGLTexture>(); let bytes = 0, calls = 0, deleted = 0, textureUploads = 0, deletedTextures = 0;
  const createTexture = gl.createTexture.bind(gl), deleteTexture = gl.deleteTexture.bind(gl), texImage = gl.texImage2D.bind(gl), texSubImage = gl.texSubImage2D.bind(gl);
  gl.createTexture = () => { const t = createTexture(); if (t) textures.add(t); return t; };
  gl.deleteTexture = (t) => { if (t && textures.has(t)) deletedTextures++; deleteTexture(t); };
  gl.texImage2D = ((...args: Parameters<typeof gl.texImage2D>) => { if (textures.has(gl.getParameter(gl.TEXTURE_BINDING_2D))) textureUploads++; Reflect.apply(texImage, gl, args); }) as typeof gl.texImage2D;
  gl.texSubImage2D = ((...args: Parameters<typeof gl.texSubImage2D>) => { if (textures.has(gl.getParameter(gl.TEXTURE_BINDING_2D))) textureUploads++; Reflect.apply(texSubImage, gl, args); }) as typeof gl.texSubImage2D;
  gl.createBuffer = () => { const b = create(); if (b) owned.add(b); return b; };
  gl.deleteBuffer = (b) => { if (b && owned.has(b)) deleted++; remove(b); };
  gl.bufferData = ((target: number, source: number | BufferSource | null, usage: number) => { const b = gl.getParameter(target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING); if (owned.has(b)) { calls++; bytes += typeof source === 'number' ? source : source?.byteLength ?? 0; } data(target, source as BufferSource, usage); }) as typeof gl.bufferData;
  gl.bufferSubData = ((target: number, offset: number, source: BufferSource) => { const b = gl.getParameter(target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING); if (owned.has(b)) { calls++; bytes += source.byteLength; } sub(target, offset, source); }) as typeof gl.bufferSubData;
  return { read: () => ({ bytes, calls, textureUploads, textures: textures.size, deletedTextures, liveTextures: [...textures].filter((t) => gl.isTexture(t)).length, buffers: owned.size, deleted, liveBuffers: [...owned].filter((b) => gl.isBuffer(b)).length }), reset: () => { bytes = calls = textureUploads = 0; }, restore: () => { gl.bufferData = data; gl.bufferSubData = sub; gl.createBuffer = create; gl.deleteBuffer = remove; gl.createTexture = createTexture; gl.deleteTexture = deleteTexture; gl.texImage2D = texImage; gl.texSubImage2D = texSubImage; } };
}
export async function lifecycle(leak = false, dropIngress = false) {
  const assets = await assetsFor('figure'), renderer = host(900, 640), scene = new Scene(), camera = new OrthographicCamera(-450, 450, 320, -320, 0.1, 2000); camera.position.z = 1000;
  const observed = observe(renderer), rigs: ThreeRig[] = [];
  let bare: RigPlayer | undefined; let restoreIngress = () => {};
  try {
    for (let i = 0; i < 10; i++) { const rig = new ThreeRig(assets, { renderer }); rig.renderOrder = i; rig.play('mask'); rig.seek(i * 0.037); rig.position.x = i * 50; scene.add(rig); rigs.push(rig); }
    renderer.render(scene, camera);
    const initial = rigs.map((r) => r.resourceCounts()), distinct = new Set(rigs.map((r) => JSON.stringify(r.drawnFrame()))).size;
    const first = rigs[0]; bare = new RigPlayer(document.createElement('div'), assets); bare.play('mask');
    const verifier = new RetainedRuntimeFrame('ThreeRig');
    const captured: string[] = [], nativeRender = ThreeRenderer.prototype.render;
    ThreeRenderer.prototype.render = function(frame) {
      if (this === first.renderer) {
        if ('order' in frame) {
          captured.push(JSON.stringify(frame));
        } else {
          verifier.capture(frame, () => ({ order: first.player.posedFrame().order.slice(dropIngress ? 1 : 0) }));
          captured.push(JSON.stringify(verifier.snapshot()));
        }
      }
      return nativeRender.call(this, frame);
    };
    restoreIngress = () => { ThreeRenderer.prototype.render = nativeRender; };
    if (dropIngress) {
      first.renderer.render = (frame) => {
        if ('order' in frame) return ThreeRenderer.prototype.render.call(first.renderer, { order: frame.order.slice(1) });
        const count = Math.max(0, frame.count - 1);
        const drawOrder = new Int32Array(count);
        for (let i = 0; i < count; i++) drawOrder[i] = frame.drawOrder[i + 1];
        return ThreeRenderer.prototype.render.call(first.renderer, { ...frame, count, drawOrder });
      };
    }
    first.seek(0); const getterIngress = JSON.stringify(first.drawnFrame()) === JSON.stringify(bare.posedFrame());
    const ingress = captured.at(-1) === JSON.stringify(bare.posedFrame());
    const hidden = first.drawnFrame().order[0].slot; const filter = (slot: string) => slot !== hidden;
    const boundsEqual = JSON.stringify(first.bounds()) === JSON.stringify(bare.bounds());
    const filterEqual = JSON.stringify(first.posedFrame(filter)) === JSON.stringify(bare.posedFrame(filter));
    first.timescale = 0.75; bare.timeScale = 0.75;
    let ingressUpdates = true;
    for (let i = 0; i < 300; i++) { first.update(1 / 60); bare.advance(1 / 60); ingressUpdates &&= captured.at(-1) === JSON.stringify(bare.posedFrame()); }
    const updates = JSON.stringify(first.drawnFrame()) === JSON.stringify(bare.posedFrame()), time = first.time, bareTime = bare.time;
    renderer.render(scene, camera); observed.reset(); const counter = first.renderer.geometryUploadCount;
    first.timescale = 0; const heldFrame = JSON.stringify(first.drawnFrame());
    for (let i = 0; i < 20; i++) { first.update(1 / 60); renderer.render(scene, camera); }
    const held = observed.read(), heldCounters = first.renderer.geometryUploadCount - counter, heldEqual = heldFrame === JSON.stringify(first.drawnFrame());
    const images = [...assets.pageImages.values()], refsBefore = images.map(getPageRefCount), textureHandles = images.map((image) => {
      const name = [...assets.pageImages].find(([, value]) => value === image)![0];
      const texture = first.renderer.getPageTexture(name);
      return texture ? (renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture : undefined;
    });
    const survivorFrames = rigs.slice(1).map((r) => JSON.stringify(r.drawnFrame()));
    first.destroy();
    const survivingTexturesLiveBeforeDraw = textureHandles.filter(Boolean).every((t) => renderer.getContext().isTexture(t!));
    renderer.render(scene, camera);
    const survivorPixels = new Uint8Array(900 * 640 * 4); renderer.getContext().readPixels(0, 0, 900, 640, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, survivorPixels);
    const survivorDrawn = survivorPixels.filter((value, i) => i % 4 === 3 && value > 0).length;
    const survivorsUnchanged = rigs.slice(1).every((r, i) => JSON.stringify(r.drawnFrame()) === survivorFrames[i]);
    const survivingTexturesLive = textureHandles.filter(Boolean).every((t) => renderer.getContext().isTexture(t!));
    const afterOne = observed.read(), refsOne = images.map(getPageRefCount);
    for (const rig of rigs.slice(1)) rig.destroy();
    const final = observed.read();
    // A fresh load gives the planted leak a separate image identity, then destroys the host to clean GPU state.
    let leakDetected = false;
    if (leak) {
      const fresh = await loadModel({ modelUrl: fixtureModelUrl('walk') }); const bad = new ThreeRig(fresh, { renderer }); scene.add(bad); bad.play('walk'); renderer.render(scene, camera);
      const handles = [...fresh.pageImages.keys()].map((name) => bad.renderer.getPageTexture(name)).filter((texture) => texture !== undefined).map((texture) => (renderer.properties.get(texture) as { __webglTexture?: WebGLTexture }).__webglTexture).filter((handle): handle is WebGLTexture => handle !== undefined);
      const beforeLeak = getLivePageTextureCount(); bad.renderer.releasePageTexturesOnDispose = false; bad.destroy(); leakDetected = getLivePageTextureCount() === beforeLeak && beforeLeak > 0 && handles.length > 0 && handles.every((handle) => renderer.getContext().isTexture(handle));
    }
    return { ingress, getterIngress, ingressUpdates, capturedFrames: captured.length, survivorsUnchanged, survivorDrawn, survivingTexturesLive, survivingTexturesLiveBeforeDraw, boundsEqual, filterEqual, updates, time, bareTime, dt: 1 / 60, n: 300, timescale: 0.75, distinct, initial, held, heldCounters, heldEqual, refsBefore, refsOne, refsFinal: images.map(getPageRefCount), afterOne, final, allDestroyed: rigs.every((r) => r.resourceCounts().meshes === 0), texturesDeleted: textureHandles.filter(Boolean).every((t) => !renderer.getContext().isTexture(t!)), textureHandles: textureHandles.filter(Boolean).length, survivors: survivorFrames.length, livePages: getLivePageTextureCount(), leakDetected };
  } finally { for (const rig of rigs) rig.destroy(); bare?.dispose(); restoreIngress(); observed.restore(); }
}

/** Consecutive same-page slots alternate clip, light, dark and blend, then a native sentinel draws. */
export async function stateProbe() {
  const { assets, frame } = await posed('duo', undefined, 0.5), original = frame.order[0], page = original.page;
  const corners = [-60, -60, -60, 60, 60, 60, 60, -60], uvs = [0, 1, 0, 0, 1, 0, 1, 1];
  const base = { ...original, kind: 'region' as const, page, region: 'probe', corners, uvs, pma: original.pma };
  const order: PosedSlot[] = [
    { ...base, slot: 'clipped-red-dark', z: 0, tint: [0.8, 0.5, 0.3, 0.7], dark: [0.2, 0.1, 0.4], blend: 'Multiply', clip: { polygon: [-60, -60, -60, 60, 0, 60, 0, -60], inverse: false, convex: true } },
    { ...base, slot: 'unclipped-blue', z: 1, corners: corners.map((v, i) => i % 2 === 0 ? v + 100 : v), tint: [0.3, 0.5, 0.8, 0.8], dark: undefined, blend: 'Normal', clip: undefined },
    { ...base, slot: 'screen-green', z: 2, corners: corners.map((v, i) => i % 2 === 0 ? v + 200 : v), tint: [0.3, 0.8, 0.2, 0.6], dark: [0.1, 0.4, 0.1], blend: 'Screen', clip: { polygon: [140, -60, 140, 60, 200, 60, 200, -60], inverse: true, convex: true } },
    { ...base, slot: 'additive', z: 3, corners: corners.map((v, i) => i % 2 === 0 ? v + 300 : v), tint: [0.9, 0.6, 0.2, 0.4], dark: undefined, blend: 'Additive', clip: undefined },
  ];
  const box = bounds({ order }), renderer = host(box.width, box.height), camera = cameraFor(box), scene = new Scene();
  const a = new Group(), b = new Group(); scene.add(a, b); a.renderOrder = 0; b.renderOrder = 1;
  const settings = { sort: renderer.sortObjects, output: renderer.outputColorSpace, tone: renderer.toneMapping };
  const first = new ThreeRenderer(a, assets, renderer), second = new ThreeRenderer(b, assets, renderer);
  const translated: PosedFrame = { order: order.map((slot): PosedSlot => slot.kind === 'region' ? { ...slot, slot: slot.slot + '-second', tint: [slot.tint[0] / 2, slot.tint[1], slot.tint[2] / 2, slot.tint[3] / 2] } : slot) };
  const reference = new CanvasRenderer(document.createElement('div'), assets.pageImages); reference.pixelRatio = 1; reference.backend = 'webgl'; reference.viewport = { x: box.left, y: box.bottom, width: box.width, height: box.height };
  try {
    first.render({ order }); second.render(translated); reference.render({ order: [...order, ...translated.order] });
    const referencePng = composite(reference.canvas); renderer.render(scene, camera);
    const threePng = composite(renderer.domElement);
    const shared = new Set(views(a).map((m) => m.material)).size === 1;
    // Preserve renderer settings, and demonstrate its following ordinary mesh uses native material state.
    const marker = new Mesh(new PlaneGeometry(30, 30), new MeshBasicMaterial({ color: 0x41cc63, toneMapped: false })); marker.position.set(box.left + 15, box.top - 15, 10); marker.renderOrder = 999; scene.add(marker);
    renderer.render(scene, camera); const sentinel = new Uint8Array(4); renderer.getContext().readPixels(15, box.height - 15, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, sentinel);
    marker.geometry.dispose(); marker.material.dispose();
    return { referencePng, threePng, shared, pageCount: new Set(order.map((s) => s.page)).size, perInstanceMaterials: views(a)[0].material !== views(b)[0].material, sentinel: [...sentinel], settingsUnchanged: settings.sort === renderer.sortObjects && settings.output === renderer.outputColorSpace && settings.tone === renderer.toneMapping, glError: renderer.getContext().getError() };
  } finally { first.dispose(); second.dispose(); reference.dispose(); }
}
export async function refusals() {
  const { assets, frame } = await posed('figure', 'mask', 0.5), renderer = host(900, 640), root = new Group(), draw = new ThreeRenderer(root, assets, renderer);
  draw.render(frame); const previous = [...root.children], counts = JSON.stringify(draw.resourceCounts()), source = frame.order[0];
  const cases: Array<[string, PosedSlot]> = [
    ['page', { ...source, page: 'missing-page' }], ['blend', { ...source, blend: 'unknown' as PosedSlot['blend'] }],
    ['nonfinite', { ...source, tint: [NaN, 1, 1, 1] }], ['pma', { ...source, pma: undefined as unknown as boolean }], ['null-clip', { ...source, clip: null as unknown as NonNullable<PosedSlot['clip']> }],
    ['self-crossing', { ...source, clip: { polygon: [0, 0, 10, 10, 0, 10, 10, 0], convex: false, inverse: false } }],
    ['capacity', { ...source, clip: { polygon: new Array((renderer.capabilities.maxTextureSize + 1) * 2).fill(0), convex: false, inverse: false } }],
    ['index', { ...source, kind: 'mesh', vertices: [0, 0, 0, 1, 1, 0], uvs: [0, 0, 0, 1, 1, 0], triangles: [0, 1, 3], sequence: 0 }],
  ];
  try {
    const messages = cases.map(([name, bad]) => { let message = ''; try { draw.render({ order: [...frame.order, bad] }); } catch (error) { message = String(error); } return { name, message, atomic: root.children.every((c, i) => c === previous[i]) && root.children.length === previous.length && counts === JSON.stringify(draw.resourceCounts()) }; });
    draw.dispose(); let after = ''; try { draw.render(frame); } catch (e) { after = String(e); }
    return { messages, after, capacity: renderer.capabilities.maxTextureSize };
  } finally { draw.dispose(); }
}

const api = { format, geometry, picture, lifecycle, stateProbe, refusals, bufferBoundary, oracleRetentionProbe, liveLeaseProbe, livePictureProbe, poseColumnProbe };
declare global { interface Window { threeHarness: typeof api } }
window.threeHarness = api;

/** Same-count index transition and changing vertex capacities must not retain old native buffers. */
export async function bufferBoundary() {
  const { assets, frame } = await posed('glow', undefined, 0), original = frame.order[0];
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8; const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 8, 8);
  const image = new Image(); image.src = canvas.toDataURL(); await image.decode();
  const renderer = host(120, 120), root = new Group(), scene = new Scene(); scene.add(root); const camera = new OrthographicCamera(0, 120, 120, 0, 0.1, 2000); camera.position.z = 1000;
  const draw = new ThreeRenderer(root, { ...assets, pageImages: new Map([['boundary', image]]) }, renderer), observed = observe(renderer);
  const mesh = (count: number, index: number): PosedSlot => {
    const vertices = new Array<number>(count * 2).fill(0), uvs = new Array<number>(count * 2).fill(0.5);
    vertices[0] = vertices[1] = 20; vertices[2] = 100; vertices[3] = 20; vertices[index * 2] = 20; vertices[index * 2 + 1] = 100;
    return { ...original, kind: 'mesh', slot: 'boundary', page: 'boundary', vertices, uvs, triangles: [0, 1, index], sequence: 0, pma: false, blend: 'Normal', tint: [1, 1, 1, 1], dark: undefined, clip: undefined };
  };
  const pixels = () => { const out = new Uint8Array(4); renderer.getContext().readPixels(30, 30, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, out); return [...out]; };
  try {
    // Keep vertex count and index count fixed: only the final index crosses Three's restart boundary.
    const low = mesh(65536, 2); draw.render({ order: [low] }); renderer.render(scene, camera); const initialType = views(root)[0].geometry.getIndex()!.array.constructor.name;
    const high = mesh(65536, 65535); draw.render({ order: [high] }); renderer.render(scene, camera);
    const index = views(root)[0].geometry.getIndex()!, transition = { initialType, finalType: index.array.constructor.name, lastIndex: index.getX(2), pixel: pixels() };
    for (const count of [3, 19, 4, 37, 3, 65536, 4]) { draw.render({ order: [mesh(count, count - 1)] }); renderer.render(scene, camera); }
    const active = observed.read(); draw.dispose(); const destroyed = observed.read();
    return { transition, active, destroyed, glError: renderer.getContext().getError() };
  } finally { draw.dispose(); observed.restore(); }
}

export async function oracleRetentionProbe(rigName: string) {
  const assets = await assetsFor(rigName), renderer = host(900, 640);
  const rig = new ThreeRig(assets, { renderer, poser: 'oracle', liveFrameChecks: true });
  try {
    rig.play(rigName === 'figure' ? 'mask' : assets.animations[0].name);
    rig.advance(0.125);
    const drawn = rig.drawnFrame(), saved = JSON.stringify(drawn);
    const equalCurrent = saved === JSON.stringify(rig.player.posedFrame());
    const live = rig.player.liveFrame(), vertices = live.vertices, before = [...rig.children];
    rig.player.seek(0.7);
    const retainedLastDraw = rig.drawnFrame() === drawn && JSON.stringify(rig.drawnFrame()) === saved;
    let staleRefused = false, nestedStale = false;
    try { rig.renderer.render(live); } catch (error) { staleRefused = String(error).includes('LIVE_FRAME_STALE'); }
    try { void vertices[0]; } catch (error) { nestedStale = String(error).includes('LIVE_FRAME_STALE'); }
    const unchangedScene = before.length === rig.children.length && before.every((view, i) => view === rig.children[i]);
    rig.advance(1 / 60);
    return {
      poser: rig.player.poser, equalCurrent, retainedLastDraw, staleRefused, nestedStale, unchangedScene,
      retainedAfterNextDraw: JSON.stringify(drawn) === saved,
      nextEqualCurrent: JSON.stringify(rig.drawnFrame()) === JSON.stringify(rig.player.posedFrame()),
    };
  } finally { rig.destroy(); }
}

export async function liveLeaseProbe(options: { rigName: string; checked: boolean; mutant?: 'snapshot' | 'buffers' | 'last-drawn' | 'fresh-lease' | 'metadata-cache' }) {
  const assets = await loadModel({ modelUrl: `/bench/${options.rigName}/skeleton.model.json`, regions: 'none', setsUrl: null });
  const renderer = host(900, 640), scene = new Scene(), camera = new OrthographicCamera(-450, 450, 320, -320, 0.1, 2000); camera.position.z = 1000;
  const rig = new ThreeRig(assets, { renderer, liveFrameChecks: options.checked });
  scene.add(rig);
  try {
    rig.play('walk', { loop: true });
    const duration = assets.animations.find((a) => a.name === 'walk')!.duration;
    for (let i = 0; i <= Math.ceil(duration * 60); i++) rig.advance(1 / 60);
    renderer.render(scene, camera);
    const poser = rig.player.poser;
    const meshes = views(rig);
    const buffers = meshes.map((mesh) => [
      mesh.geometry.getAttribute('position'),
      mesh.geometry.getAttribute('uv'),
      mesh.geometry.getIndex(),
    ]);
    const snapshot = rig.player.posedFrame.bind(rig.player);
    let snapshotCalls = 0;
    rig.player.posedFrame = () => { snapshotCalls++; throw new Error('HOT_LOOP_SNAPSHOT'); };
    let hotError: string | null = null;
    try {
      rig.play('walk', { loop: true });
      for (let i = 0; i < 20; i++) {
        rig.advance(1 / 60);
        rig.seek((i + 1) / 60);
        if (options.mutant === 'snapshot') rig.player.posedFrame();
        if (options.mutant === 'buffers' && meshes[0]) meshes[0].geometry.setAttribute('position', new BufferAttribute(new Float32Array(meshes[0].geometry.getAttribute('position').array.length), 3));
      }
    } catch (error) { hotError = error instanceof Error ? error.message : String(error); }
    finally { rig.player.posedFrame = snapshot; }
    renderer.render(scene, camera);
    const stableBuffers = meshes.every((mesh, i) => buffers[i][0] === mesh.geometry.getAttribute('position') && buffers[i][1] === mesh.geometry.getAttribute('uv') && buffers[i][2] === mesh.geometry.getIndex());
    let staticIndexReads = 0;
    const watched = (source: LiveNumbers): LiveNumbers => new Proxy(source, {
      get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) staticIndexReads++;
        return Reflect.get(target, property, target);
      },
    });
    const raw = rig.player.liveFrame();
    const tracked: LiveFrame = {
      generation: raw.generation, count: raw.count, drawOrder: raw.drawOrder, vertices: raw.vertices, tint: raw.tint,
      attachments: raw.attachments.map((a) => ({ ...a, uvs: watched(a.uvs), triangles: watched(a.triangles) })),
    };
    rig.renderer.render(tracked);
    const firstStaticIndexReads = staticIndexReads;
    staticIndexReads = 0;
    rig.renderer.alwaysReuploadGeometry = options.mutant === 'metadata-cache';
    rig.renderer.render(tracked);
    rig.renderer.alwaysReuploadGeometry = false;
    const repeatedStaticIndexReads = staticIndexReads;
    const current = snapshot(), drawn = rig.drawnFrame(), rendererDrawn = rig.renderer.drawnFrame;
    const equalCurrent = JSON.stringify(drawn) === JSON.stringify(current);
    const rendererEqualCurrent = JSON.stringify(rendererDrawn) === JSON.stringify(current);
    const saved = JSON.stringify(drawn);
    if (options.mutant === 'last-drawn') rig.drawnFrame = () => rig.player.posedFrame();
    rig.player.advance(0.137);
    rig.player.liveFrame();
    const lastDrawSurvivesDirectMutation = JSON.stringify(rig.drawnFrame()) === saved;
    const rendererSurvivesNextLease = JSON.stringify(rig.renderer.drawnFrame) === saved && JSON.stringify(rendererDrawn) === saved;
    rig.advance(1 / 60);
    const retainedSurvivesNextDraw = JSON.stringify(drawn) === saved;
    const explicit = rig.draw();
    const explicitSnapshotIdentity = rig.drawnFrame() === explicit && rig.renderer.drawnFrame === explicit;
    const standaloneRoot = new Group();
    const standaloneRenderer = new ThreeRenderer(standaloneRoot, assets, renderer);
    const standalonePlayer = new RigPlayer(document.createElement('div'), assets, { mode: 'canvas', liveFrameChecks: options.checked });
    let standaloneEqualLast = false, standaloneSurvivesNextLease = false;
    try {
      standalonePlayer.play('walk', { loop: true });
      for (let i = 0; i < 5; i++) {
        standalonePlayer.advance(1 / 60);
        standaloneRenderer.render(standalonePlayer.liveFrame());
      }
      const expectedStandalone = JSON.stringify(standalonePlayer.posedFrame());
      const standaloneFirstRead = standaloneRenderer.drawnFrame;
      standaloneEqualLast = JSON.stringify(standaloneFirstRead) === expectedStandalone;
      standalonePlayer.advance(1 / 60);
      standalonePlayer.liveFrame();
      standaloneSurvivesNextLease =
        JSON.stringify(standaloneRenderer.drawnFrame) === expectedStandalone &&
        JSON.stringify(standaloneFirstRead) === expectedStandalone;
    } finally {
      standaloneRenderer.dispose();
      standalonePlayer.dispose();
    }
    const lease = rig.player.liveFrame();
    const vertices = lease.vertices, tint = lease.tint, metadata = lease.attachments[lease.drawOrder[0]], uvs = metadata.uvs;
    let readonlyRefused = false;
    if (options.checked) {
      try { void (vertices as unknown as { buffer: unknown }).buffer; }
      catch (error) { readonlyRefused = String(error).includes('LIVE_FRAME_READONLY'); }
    }
    rig.player.advance(1 / 60);
    const sceneState = (): string => JSON.stringify({
      resources: rig.resourceCounts(),
      uploads: [rig.renderer.positionUploadCount, rig.renderer.geometryUploadCount],
      views: views(rig).map((mesh) => ({
        name: mesh.name, renderOrder: mesh.renderOrder,
        positions: Array.from(mesh.geometry.getAttribute('position').array),
      })),
    });
    const before = sceneState();
    let staleRefused = false;
    try { rig.renderer.render(options.mutant === 'fresh-lease' ? rig.player.liveFrame() : lease); }
    catch (error) { staleRefused = String(error).includes('LIVE_FRAME_STALE'); }
    const sceneUnchanged = before === sceneState();
    const baseSnap = rig.player.posedFrame();
    const baseMesh = baseSnap.order.find((s): s is Extract<PosedSlot, { kind: 'mesh' }> => s.kind === 'mesh')!;
    const meshSlot = { ...baseMesh, uvs: [...baseMesh.uvs], triangles: [...baseMesh.triangles] };
    const validSnap: PosedFrame = { order: baseSnap.order.map((s) => (s === baseMesh ? meshSlot : s)) };
    rig.renderer.render(validSnap);
    const beforeMutate = sceneState();
    meshSlot.uvs.length = 2;
    let inPlaceUvTruncateRefused = false;
    try { rig.renderer.render(validSnap); }
    catch (error) {
      const msg = String(error);
      inPlaceUvTruncateRefused = msg.includes(meshSlot.slot) && msg.includes('uvs') && msg.includes('length');
    }
    const inPlaceUvSceneUnchanged = beforeMutate === sceneState();
    const triSlot = { ...baseMesh, uvs: [...baseMesh.uvs], triangles: [...baseMesh.triangles] };
    const validTriSnap: PosedFrame = { order: baseSnap.order.map((s) => (s === baseMesh ? triSlot : s)) };
    rig.renderer.render(validTriSnap);
    const beforeTriMutate = sceneState();
    triSlot.triangles.length = 1;
    let inPlaceTriangleTruncateRefused = false;
    try { rig.renderer.render(validTriSnap); }
    catch (error) {
      const msg = String(error);
      inPlaceTriangleTruncateRefused = msg.includes(triSlot.slot) && msg.includes('triangles');
    }
    const inPlaceSceneUnchanged = inPlaceUvSceneUnchanged && beforeTriMutate === sceneState();
    rig.draw();
    const stale = (read: () => unknown): boolean => {
      try { read(); return false; } catch (error) { return String(error).includes('LIVE_FRAME_STALE'); }
    };
    const nestedStale = options.checked ? [() => vertices[0], () => tint[0], () => uvs[0], () => metadata.page].every(stale) : null;
    let colorInvalidates = false;
    if (options.checked) {
      const colorLease = rig.player.liveFrame();
      rig.player.color[0] *= 0.5;
      rig.player.liveFrame();
      colorInvalidates = stale(() => colorLease.tint[0]);
    }
    return {
      poser, meshCount: meshes.length, snapshotCalls, hotError, stableBuffers, equalCurrent,
      rendererEqualCurrent, rendererSurvivesNextLease, standaloneEqualLast, standaloneSurvivesNextLease,
      inPlaceUvTruncateRefused, inPlaceTriangleTruncateRefused, inPlaceSceneUnchanged,
      firstStaticIndexReads, repeatedStaticIndexReads,
      lastDrawSurvivesDirectMutation, retainedSurvivesNextDraw, explicitSnapshotIdentity,
      readonlyRefused, staleRefused, sceneUnchanged, nestedStale, colorInvalidates,
    };
  } finally { rig.destroy(); assets.dispose(); }
}

export async function livePictureProbe(options: {
  rigName: string; animation?: string; time: number; pma?: boolean; poser?: 'auto' | 'oracle';
  mutant?: 'vertices' | 'clip' | 'dark' | 'pma' | 'order';
}) {
  const publicBench = options.rigName === 'spineboy' || options.rigName === 'raptor';
  const baseAssets = publicBench
    ? await loadModel({ modelUrl: `/bench/${options.rigName}/skeleton.model.json`, regions: 'none', setsUrl: null })
    : await assetsFor(options.rigName);
  const urls: string[] = [];
  let assets = baseAssets;
  if (options.pma) {
    const pages = new Map<string, HTMLImageElement>();
    for (const [name, page] of baseAssets.pageImages) {
      const twin = await makePremultipliedTwinImage(page);
      pages.set(name, twin.image); urls.push(twin.url);
    }
    assets = { ...baseAssets, pageImages: pages };
  }
  const player = new RigPlayer(document.createElement('div'), baseAssets, { mode: 'canvas', poser: options.poser ?? 'oracle', liveFrameChecks: true });
  const animation = options.animation ?? baseAssets.animations[0].name;
  player.play(animation, { loop: true }); player.seek(options.time);
  const original = player.posedFrame();
  const snapshot: PosedFrame = options.pma ? { order: original.order.map((slot) => ({ ...slot, pma: true })) } : original;
  const borrowed = player.liveFrame();
  let live: LiveFrame = borrowed;
  if (options.pma || options.mutant) {
    const vertices = new Float64Array(borrowed.vertices.length);
    for (let i = 0; i < vertices.length; i++) vertices[i] = borrowed.vertices[i] + (options.mutant === 'vertices' && i % 2 === 0 ? 20 : 0);
    const drawOrder = new Int32Array(borrowed.count);
    for (let i = 0; i < drawOrder.length; i++) drawOrder[i] = borrowed.drawOrder[options.mutant === 'order' ? drawOrder.length - 1 - i : i];
    const attachments = borrowed.attachments.map((a) => ({
      ...a,
      pma: options.mutant === 'pma' ? false : options.pma ? true : a.pma,
      clip: options.mutant === 'clip' ? null : a.clip,
      dark: options.mutant === 'dark' ? null : a.dark,
    }));
    live = { generation: borrowed.generation, count: borrowed.count, vertices, drawOrder, tint: borrowed.tint, attachments };
  }
  const box = bounds(snapshot), renderer = host(box.width, box.height), camera = cameraFor(box), scene = new Scene(), root = new Group(); scene.add(root);
  const gl = renderer.getContext();
  const readPixels = (): Uint8Array => {
    const out = new Uint8Array(box.width * box.height * 4);
    gl.finish(); gl.readPixels(0, 0, box.width, box.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const old = new ThreeRenderer(root, assets, renderer), liveRenderer = new ThreeRenderer(root, assets, renderer);
  try {
    old.render(snapshot); renderer.render(scene, camera); const expected = readPixels();
    old.dispose();
    liveRenderer.render(live); renderer.render(scene, camera); const actual = readPixels();
    let byteDifferences = 0, contentPixels = 0;
    for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) byteDifferences++;
    for (let i = 3; i < expected.length; i += 4) if (expected[i] !== 0) contentPixels++;
    return {
      byteDifferences, contentPixels, poser: player.poser, order: snapshot.order.length,
      clips: snapshot.order.filter((slot) => slot.clip).length, darks: snapshot.order.filter((slot) => slot.dark).length,
      blends: Array.from(new Set(snapshot.order.map((slot) => slot.blend))), pma: options.pma ?? false,
    };
  } finally {
    old.dispose(); liveRenderer.dispose(); player.dispose();
    if (publicBench) baseAssets.dispose();
    for (const url of urls) URL.revokeObjectURL(url);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * 0.5;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return Number((next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base]).toFixed(3));
}

export async function poseColumnProbe(options: { rigName: 'spineboy' | 'raptor'; instances?: number; warmupFrames?: number; measuredFrames?: number }) {
  const instances = options.instances ?? 100, warmupFrames = options.warmupFrames ?? 30, measuredFrames = options.measuredFrames ?? 120;
  const assets = await loadModel({ modelUrl: `/bench/${options.rigName}/skeleton.model.json`, regions: 'none', setsUrl: null });
  const renderer = host(900, 640), scene = new Scene(), camera = new OrthographicCamera(-450, 450, 320, -320, 0.1, 2000); camera.position.z = 1000;
  const gl = renderer.getContext();
  const duration = assets.animations.find((a) => a.name === 'walk')!.duration;
  const rigs: ThreeRig[] = [];
  const posedFrames = new Array<PosedFrame>(instances);
  const liveFrames = new Array<LiveFrame>(instances);
  for (let i = 0; i < instances; i++) {
    const rig = new ThreeRig(assets, { renderer, liveFrameChecks: false });
    scene.add(rig);
    rigs.push(rig);
  }
  const resetPhase = () => {
    for (let i = 0; i < instances; i++) {
      rigs[i].player.play('walk', { loop: true });
      const phase = ((i % instances) / instances) * duration;
      if (phase > 0) rigs[i].player.advance(phase);
    }
  };
  const runArm = (mode: 'snapshot' | 'live') => {
    resetPhase();
    const dt = 1 / 60;
    const poseStep = () => {
      for (let i = 0; i < instances; i++) {
        rigs[i].player.advance(dt);
        if (mode === 'snapshot') posedFrames[i] = rigs[i].player.posedFrame();
        else liveFrames[i] = rigs[i].player.liveFrame();
      }
    };
    const drawStep = () => {
      for (let i = 0; i < instances; i++) {
        if (mode === 'snapshot') rigs[i].renderer.render(posedFrames[i]);
        else rigs[i].renderFrame(liveFrames[i]);
      }
      renderer.render(scene, camera);
    };
    for (let f = 0; f < warmupFrames; f++) { poseStep(); drawStep(); }
    gl.finish();
    const poseTimes = new Array<number>(measuredFrames), drawTimes = new Array<number>(measuredFrames), frameTimes = new Array<number>(measuredFrames);
    for (let f = 0; f < measuredFrames; f++) {
      const t0 = performance.now();
      poseStep();
      const t1 = performance.now();
      drawStep(); gl.finish();
      const t2 = performance.now();
      poseTimes[f] = t1 - t0; drawTimes[f] = t2 - t1; frameTimes[f] = t2 - t0;
    }
    return { poseP50Ms: median(poseTimes), drawP50Ms: median(drawTimes), p50Ms: median(frameTimes) };
  };
  try {
    const before = runArm('snapshot');
    const after = runArm('live');
    return { rigName: options.rigName, instances, warmupFrames, measuredFrames, before, after };
  } finally {
    for (const rig of rigs) rig.destroy();
    assets.dispose();
  }
}
