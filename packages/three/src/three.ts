import { RigPlayer, type ModelAssets, type PosedFrame, type PosedSlot, type PlayOptions, type SlotFilter, type PoseBounds, type BoneWorld } from '@rig-c/play';
import {
  AddEquation, BufferAttribute, BufferGeometry, CustomBlending, DataTexture, DoubleSide,
  DstColorFactor, DynamicDrawUsage, FloatType, GLSL3, Group, LinearFilter, Mesh, NearestFilter,
  NoColorSpace, OneFactor, OneMinusSrcAlphaFactor, OneMinusSrcColorFactor, RGBAFormat,
  ShaderMaterial, Texture, Vector3, type Camera, type WebGLRenderer,
} from 'three';
import { clipPolygon } from './clip.ts';

function isWebGLHost(value: unknown): value is WebGLRenderer { return typeof value === 'object' && value !== null && 'isWebGLRenderer' in value && value.isWebGLRenderer === true; }

type SharedPage = { texture: Texture; pma: boolean; holders: Set<ThreeRenderer> };
const pages = new WeakMap<HTMLImageElement, SharedPage>();
const livePages = new Set<Texture>();
export const getLivePageTextureCount = () => livePages.size;
export const getPageRefCount = (image: HTMLImageElement) => pages.get(image)?.holders.size ?? 0;
export const getSharedPageTexture = (image: HTMLImageElement) => pages.get(image)?.texture;
const REGION_INDICES = [0, 1, 2, 2, 3, 0];
const VERTEX = `
out vec2 vUV;
out vec2 vPosition;
void main() {
  vUV = uv;
  vPosition = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = `
precision highp float;
uniform sampler2D page;
uniform sampler2D polygon;
uniform int points;
uniform bool inverse;
uniform vec4 light;
uniform vec3 dark;
in vec2 vUV;
in vec2 vPosition;
out vec4 outColor;
void main() {
  if (points > 0) {
    bool inside = false;
    vec2 b = texelFetch(polygon, ivec2(points - 1, 0), 0).xy;
    for (int i = 0; i < points; i++) {
      vec2 a = texelFetch(polygon, ivec2(i, 0), 0).xy;
      if ((a.y > vPosition.y) != (b.y > vPosition.y)) {
        float x = (b.x - a.x) * (vPosition.y - a.y) / (b.y - a.y) + a.x;
        if (vPosition.x < x) inside = !inside;
      }
      b = a;
    }
    if (inverse ? inside : !inside) discard;
  }
  vec4 t = texture(page, vUV);
  outColor = vec4((t.rgb * light.rgb + (t.a - t.rgb) * dark) * light.a, t.a * light.a);
}`;

type Prepared = { slot: PosedSlot; image: HTMLImageElement; positions: number[]; indices: readonly number[]; polygon: number[] | null };
export interface ThreeSlotMesh extends Mesh<BufferGeometry, ShaderMaterial> { posedSlot: PosedSlot }
type Entry = { mesh: ThreeSlotMesh; polygon: DataTexture | null; polygonValues: number[]; uvs: readonly number[] | null; indices: readonly number[] | null };
export interface ThreeRigResourceCounts { meshes: number; geometries: number; materials: number; clipTextures: number; retainedPages: number; livePageTextures: number }

/** Native meshes in Y-up local space. The application owns the WebGL renderer and camera. */
export class ThreeRenderer {
  positionUploadCount = 0;
  uvUploadCount = 0;
  triangleUploadCount = 0;
  alwaysReuploadGeometry = false;
  /** Negative-control switch; normal disposal always releases retained page textures. */
  releasePageTexturesOnDispose = true;
  private disposed = false;
  private readonly pool = new Map<string, Entry>();
  private readonly materials = new Map<HTMLImageElement, ShaderMaterial>();
  private readonly retained = new Set<HTMLImageElement>();
  constructor(readonly root: Group, readonly assets: ModelAssets, readonly host: WebGLRenderer) {
    if (!root?.isGroup || !assets || !(assets.pageImages instanceof Map) || !isWebGLHost(host)) throw new Error('ThreeRenderer: expected Group, ModelAssets.pageImages Map and WebGLRenderer');
  }
  get geometryUploadCount(): number { return this.positionUploadCount + this.uvUploadCount + this.triangleUploadCount; }
  get isDisposed(): boolean { return this.disposed; }
  resourceCounts(): ThreeRigResourceCounts {
    return { meshes: this.pool.size, geometries: this.pool.size, materials: this.materials.size, clipTextures: [...this.pool.values()].filter((e) => e.polygon !== null).length, retainedPages: this.retained.size, livePageTextures: livePages.size };
  }
  getPageTexture(name: string): Texture | undefined { const image = this.assets.pageImages.get(name); return image && this.retained.has(image) ? pages.get(image)?.texture : undefined; }
  private prepare(slot: PosedSlot): Prepared {
    const detail = `ThreeRenderer: slot "${slot?.slot ?? '<unnamed>'}" on page "${slot?.page ?? '<unnamed>'}"`;
    const fail = (why: string): never => { throw new Error(`${detail}: ${why}`); };
    if (!slot || (slot.kind !== 'region' && slot.kind !== 'mesh')) fail(`kind=${String(slot && (slot as { kind?: unknown }).kind)} (expected region or mesh)`);
    if (typeof slot.slot !== 'string' || slot.slot.length === 0 || typeof slot.page !== 'string' || slot.page.length === 0) fail('expected non-empty slot and page names');
    if (!['Normal', 'Additive', 'Multiply', 'Screen'].includes(slot.blend)) fail(`blend=${slot.blend} (expected Normal, Additive, Multiply, Screen)`);
    if (typeof slot.pma !== 'boolean') fail(`pma=${String(slot.pma)} (expected boolean)`);
    if (!Number.isFinite(slot.z)) fail(`z=${String(slot.z)} (expected finite draw-order index)`);
    const image = this.assets.pageImages.get(slot.page);
    if (!image || !(image.naturalWidth > 0 && image.naturalHeight > 0)) fail('page image absent or not decoded (expected positive naturalWidth/naturalHeight)');
    const valid = (values: readonly number[], count: number, field: string) => {
      if (!Array.isArray(values) || values.length !== count) fail(`${field} length=${values?.length} (expected ${count})`);
      for (let i = 0; i < count; i++) if (!Number.isFinite(values[i]) || !Number.isFinite(Math.fround(values[i]))) fail(`${field}[${i}]=${String(values[i])} (expected finite float32)`);
    };
    valid(slot.tint, 4, 'tint'); if (slot.dark !== undefined) valid(slot.dark, 3, 'dark');
    const coords = slot.kind === 'region' ? slot.corners : slot.vertices;
    if (!Array.isArray(coords) || coords.length < 6 || coords.length % 2 !== 0) fail(`positions length=${coords?.length} (expected even length >=6)`);
    valid(coords, slot.kind === 'region' ? 8 : coords.length, slot.kind === 'region' ? 'corners' : 'vertices');
    valid(slot.uvs, coords.length, 'uvs');
    const indices = slot.kind === 'region' ? REGION_INDICES : slot.triangles;
    if (!Array.isArray(indices) || indices.length < 3 || indices.length % 3 !== 0) fail(`triangles length=${indices?.length} (expected multiple of three >=3)`);
    indices.forEach((v, i) => { if (!Number.isInteger(v) || v < 0 || v >= coords.length / 2) fail(`triangles[${i}]=${v} (expected integer 0..${coords.length / 2 - 1})`); });
    if (slot.kind === 'mesh' && !Number.isInteger(slot.sequence)) fail(`sequence=${slot.sequence} (expected integer)`);
    return { slot, image: image!, positions: coords, indices, polygon: slot.clip !== undefined ? clipPolygon(slot.clip, detail, this.host.capabilities.maxTextureSize) : null };
  }
  private material(item: Prepared): ShaderMaterial {
    let material = this.materials.get(item.image);
    if (material) return material;
    let page = pages.get(item.image);
    if (!page) {
      const texture = new Texture(item.image);
      texture.flipY = false; texture.premultiplyAlpha = !item.slot.pma;
      texture.generateMipmaps = false; texture.minFilter = texture.magFilter = LinearFilter;
      texture.colorSpace = NoColorSpace; texture.needsUpdate = true;
      page = { texture, pma: item.slot.pma, holders: new Set() }; pages.set(item.image, page); livePages.add(texture);
    }
    page.holders.add(this); this.retained.add(item.image);
    material = new ShaderMaterial({
      glslVersion: GLSL3, vertexShader: VERTEX, fragmentShader: FRAGMENT,
      uniforms: { page: { value: page.texture }, polygon: { value: page.texture }, points: { value: 0 }, inverse: { value: false }, light: { value: [1, 1, 1, 1] }, dark: { value: [0, 0, 0] } },
      transparent: true, depthWrite: false, depthTest: true, side: DoubleSide, forceSinglePass: true, toneMapped: false, blending: CustomBlending,
    });
    this.materials.set(item.image, material); return material;
  }
  render(frame: PosedFrame): void {
    if (this.disposed) throw new Error('ThreeRenderer: render called after dispose (expected active renderer)');
    if (!frame || !Array.isArray(frame.order)) throw new Error('ThreeRenderer: frame.order absent (expected PosedSlot array)');
    // Validate the complete frame, including cross-slot page conventions, before any allocation or scene mutation.
    const prepared = frame.order.map((s) => this.prepare(s));
    const conventions = new Map<HTMLImageElement, boolean>();
    for (const item of prepared) {
      const pma = conventions.get(item.image) ?? pages.get(item.image)?.pma;
      if (pma !== undefined && pma !== item.slot.pma) throw new Error(`ThreeRenderer: slot "${item.slot.slot}" page "${item.slot.page}" pma=${item.slot.pma} conflicts with retained pma=${pma} (expected one convention per page image)`);
      conventions.set(item.image, item.slot.pma);
    }
    const occurrences = new Map<string, number>();
    const active: ThreeSlotMesh[] = [];
    prepared.forEach((item, index) => {
      const occurrence = occurrences.get(item.slot.slot) ?? 0; occurrences.set(item.slot.slot, occurrence + 1);
      const key = `${item.slot.slot}\0${occurrence}`;
      let entry = this.pool.get(key);
      if (!entry) {
        const geometry = new BufferGeometry();
        const mesh = new Mesh(geometry, this.material(item)) as ThreeSlotMesh;
        mesh.frustumCulled = false; mesh.name = item.slot.slot;
        entry = { mesh, polygon: null, polygonValues: [], uvs: null, indices: null };
        this.pool.set(key, entry);
      }
      const { mesh } = entry;
      const oldPositions = mesh.geometry.getAttribute('position'), oldUVs = mesh.geometry.getAttribute('uv'), oldIndex = mesh.geometry.getIndex();
      const needsWideIndex = item.indices.some((v) => v >= 65535);
      if ((oldPositions && oldPositions.array.length !== item.positions.length / 2 * 3) || (oldUVs && oldUVs.array.length !== item.slot.uvs.length) || (oldIndex && (oldIndex.count !== item.indices.length || (needsWideIndex && !(oldIndex.array instanceof Uint32Array))))) {
        // Dispose while the old attributes are still attached, so Three deletes every old GPU buffer.
        mesh.geometry.dispose(); mesh.geometry = new BufferGeometry(); entry.uvs = entry.indices = null;
      }
      mesh.posedSlot = item.slot; mesh.material = this.material(item); mesh.renderOrder = index;
      const update = (name: 'position' | 'uv', values: number[], size: number, force: boolean) => {
        let attribute = mesh.geometry.getAttribute(name) as BufferAttribute | undefined;
        let changed = force || !attribute || attribute.array.length !== values.length;
        if (!attribute || attribute.array.length !== values.length) { attribute = new BufferAttribute(new Float32Array(values.length), size).setUsage(DynamicDrawUsage); mesh.geometry.setAttribute(name, attribute); }
        const array = attribute.array as Float32Array;
        for (let i = 0; i < values.length; i++) if (array[i] !== Math.fround(values[i])) { array[i] = values[i]; changed = true; }
        if (changed) { attribute.needsUpdate = true; if (name === 'position') this.positionUploadCount++; else this.uvUploadCount++; }
      };
      const xyz: number[] = [];
      for (let i = 0; i < item.positions.length; i += 2) xyz.push(item.positions[i], item.positions[i + 1], 0);
      update('position', xyz, 3, this.alwaysReuploadGeometry);
      if (this.alwaysReuploadGeometry || entry.uvs !== item.slot.uvs) { update('uv', item.slot.uvs, 2, true); entry.uvs = item.slot.uvs; }
      if (this.alwaysReuploadGeometry || entry.indices !== item.indices) {
        const before = mesh.geometry.getIndex();
        if (before && before.count === item.indices.length) { for (let i = 0; i < item.indices.length; i++) before.setX(i, item.indices[i]); before.needsUpdate = true; }
        else mesh.geometry.setIndex([...item.indices]);
        this.triangleUploadCount++; entry.indices = item.indices;
      }
      if (item.polygon !== null && (entry.polygon === null || item.polygon.length !== entry.polygonValues.length || item.polygon.some((v, i) => v !== entry!.polygonValues[i]))) {
        const data = new Float32Array(item.polygon.length * 2);
        for (let i = 0; i < item.polygon.length; i += 2) { data[i * 2] = item.polygon[i]; data[i * 2 + 1] = item.polygon[i + 1]; }
        entry.polygon?.dispose();
        entry.polygon = new DataTexture(data, item.polygon.length / 2, 1, RGBAFormat, FloatType);
        entry.polygon.minFilter = entry.polygon.magFilter = NearestFilter; entry.polygon.needsUpdate = true;
        entry.polygonValues = item.polygon;
      } else if (item.polygon === null && entry.polygon !== null) { entry.polygon.dispose(); entry.polygon = null; entry.polygonValues = []; }
      const current = entry;
      mesh.onBeforeRender = () => {
        const material = mesh.material, slot = mesh.posedSlot;
        material.uniforms.light.value = slot.tint; material.uniforms.dark.value = slot.dark ?? [0, 0, 0];
        material.uniforms.polygon.value = current.polygon ?? material.uniforms.page.value;
        material.uniforms.points.value = current.polygon === null ? 0 : current.polygonValues.length / 2;
        material.uniforms.inverse.value = slot.clip?.inverse ?? false;
        material.blendEquation = material.blendEquationAlpha = AddEquation;
        material.blendSrc = slot.blend === 'Multiply' ? DstColorFactor : OneFactor;
        material.blendDst = slot.blend === 'Additive' ? OneFactor : slot.blend === 'Screen' ? OneMinusSrcColorFactor : OneMinusSrcAlphaFactor;
        material.blendSrcAlpha = OneFactor; material.blendDstAlpha = material.blendDst;
        material.uniformsNeedUpdate = true;
      };
      active.push(mesh);
    });
    // Remove only our display objects; application-owned siblings survive.
    for (const entry of this.pool.values()) if (entry.mesh.parent === this.root) this.root.remove(entry.mesh);
    for (const mesh of active) this.root.add(mesh);
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const e of this.pool.values()) { e.mesh.removeFromParent(); e.mesh.geometry.dispose(); e.polygon?.dispose(); }
    this.pool.clear();
    for (const material of this.materials.values()) material.dispose(); this.materials.clear();
    if (this.releasePageTexturesOnDispose) for (const image of this.retained) {
      const page = pages.get(image); if (!page) continue;
      page.holders.delete(this);
      if (page.holders.size === 0) { page.texture.dispose(); livePages.delete(page.texture); pages.delete(image); }
    }
    this.retained.clear();
  }
}

/** Read native float32 positions through the application's world and camera mapping. */
export function readMeshScreenVertices(mesh: ThreeSlotMesh, camera: Camera, width: number, height: number): number[] {
  mesh.updateWorldMatrix(true, false); camera.updateWorldMatrix(true, false);
  const positions = mesh.geometry.getAttribute('position'), result: number[] = [];
  for (let i = 0; i < positions.count; i++) {
    const p = new Vector3().fromBufferAttribute(positions, i).applyMatrix4(mesh.matrixWorld).project(camera);
    result.push((p.x + 1) * width / 2, (1 - p.y) * height / 2);
  }
  return result;
}

export interface ThreeRigOptions { renderer: WebGLRenderer; skin?: string; slots?: SlotFilter; timescale?: number; timeScale?: number }
/** A flat native Group. Advance from the app's loop using seconds, without an internal clock. */
export class ThreeRig extends Group {
  readonly player: RigPlayer;
  readonly renderer: ThreeRenderer;
  private lastFrame: PosedFrame;
  private destroyed = false;
  constructor(readonly assets: ModelAssets, options: ThreeRigOptions) {
    super();
    if (!assets?.document || !(assets.pageImages instanceof Map) || !isWebGLHost(options?.renderer)) throw new Error('ThreeRig: expected ModelAssets and options.renderer WebGLRenderer');
    const scale = options.timescale ?? options.timeScale ?? 1;
    if (!Number.isFinite(scale) || scale < 0) throw new Error(`ThreeRig: timescale=${scale} (expected finite number >=0)`);
    this.player = new RigPlayer(document.createElement('div'), assets, { mode: assets.regions === 'none' ? 'canvas' : 'dom', skin: options.skin, slots: options.slots });
    this.renderer = new ThreeRenderer(this, assets, options.renderer);
    this.timescale = scale;
    try { this.lastFrame = this.draw(); } catch (error) { this.renderer.dispose(); this.player.dispose(); throw error; }
  }
  private active(): void { if (this.destroyed) throw new Error('ThreeRig: called after destroy (expected active rig)'); }
  play(name: string, options: PlayOptions = {}): void { this.active(); this.player.play(name, options); this.draw(); }
  seek(time: number): void { this.active(); if (!Number.isFinite(time)) throw new Error(`ThreeRig: time=${time} (expected finite seconds)`); this.player.seek(time); this.draw(); }
  advance(dt: number): void {
    this.active();
    if (!Number.isFinite(dt) || dt < 0) throw new Error(`ThreeRig: dt=${dt} (expected finite seconds >=0)`);
    if (this.timescale === 0) return;
    this.player.advance(dt); this.draw();
  }
  update(dt: number): void { this.advance(dt); }
  draw(): PosedFrame { this.active(); const frame = this.player.posedFrame(); this.renderer.render(frame); this.lastFrame = frame; return frame; }
  drawnFrame(): PosedFrame { this.active(); return this.lastFrame; }
  posedFrame(slots?: SlotFilter | null): PosedFrame { this.active(); return this.player.posedFrame(slots); }
  bone(name: string): BoneWorld { this.active(); return this.player.bone(name); }
  bounds(): PoseBounds | null { this.active(); return this.player.bounds(); }
  get time(): number { return this.player.time; }
  get current(): string | null { return this.player.current; }
  get timescale(): number { return this.player.timeScale; }
  set timescale(value: number) { this.active(); if (!Number.isFinite(value) || value < 0) throw new Error(`ThreeRig: timescale=${value} (expected finite number >=0)`); this.player.timeScale = value; }
  get timeScale(): number { return this.timescale; }
  set timeScale(value: number) { this.timescale = value; }
  resourceCounts(): ThreeRigResourceCounts { return this.renderer.resourceCounts(); }
  destroy(): void { if (this.destroyed) return; this.destroyed = true; this.renderer.dispose(); this.player.dispose(); this.removeFromParent(); }
}
