import {
  type DrawNumbers,
  type DrawSlot,
  LiveDrawViews,
  numberCount,
  numberOffset,
  numberSource,
  RetainedRuntimeFrame,
} from '@rig-c/adapters-shared';
import { RigPlayer, type BlendMode, type LiveFrame, type LiveNumbers, type ModelAssets, type PosedFrame, type PosedSlot, type PlayOptions, type SlotFilter, type PoseBounds, type BoneWorld } from '@rig-c/play';
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

type Prepared = {
  slot: PosedSlot | DrawSlot;
  key: string;
  image: HTMLImageElement;
  positions: DrawNumbers;
  indices: LiveNumbers;
  polygon: number[] | null;
  light: [number, number, number, number];
  dark: [number, number, number];
  inverse: boolean;
  blend: BlendMode;
};
export interface ThreeSlotMesh extends Mesh<BufferGeometry, ShaderMaterial> { posedSlot: PosedSlot }
type Entry = {
  mesh: ThreeSlotMesh;
  polygon: DataTexture | null;
  polygonValues: number[];
  uvs: LiveNumbers | null;
  indices: LiveNumbers | null;
  light: [number, number, number, number];
  dark: [number, number, number];
  inverse: boolean;
  blend: BlendMode;
  needsWideIndex: boolean;
};
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
  private readonly liveViews = new LiveDrawViews('ThreeRenderer');
  constructor(readonly root: Group, readonly assets: ModelAssets, readonly host: WebGLRenderer) {
    if (!root?.isGroup || !assets || !(assets.pageImages instanceof Map) || !isWebGLHost(host)) throw new Error('ThreeRenderer: expected Group, ModelAssets.pageImages Map and WebGLRenderer');
  }
  get geometryUploadCount(): number { return this.positionUploadCount + this.uvUploadCount + this.triangleUploadCount; }
  get isDisposed(): boolean { return this.disposed; }
  resourceCounts(): ThreeRigResourceCounts {
    return { meshes: this.pool.size, geometries: this.pool.size, materials: this.materials.size, clipTextures: [...this.pool.values()].filter((e) => e.polygon !== null).length, retainedPages: this.retained.size, livePageTextures: livePages.size };
  }
  getPageTexture(name: string): Texture | undefined { const image = this.assets.pageImages.get(name); return image && this.retained.has(image) ? pages.get(image)?.texture : undefined; }
  private prepare(slot: PosedSlot | DrawSlot, key: string, indexed: boolean): Prepared {
    const detail = `ThreeRenderer: slot "${slot?.slot ?? '<unnamed>'}" on page "${slot?.page ?? '<unnamed>'}"`;
    const fail = (why: string): never => { throw new Error(`${detail}: ${why}`); };
    if (!slot || (slot.kind !== 'region' && slot.kind !== 'mesh')) fail(`kind=${String(slot && (slot as { kind?: unknown }).kind)} (expected region or mesh)`);
    if (typeof slot.slot !== 'string' || slot.slot.length === 0 || typeof slot.page !== 'string' || slot.page.length === 0) fail('expected non-empty slot and page names');
    if (!['Normal', 'Additive', 'Multiply', 'Screen'].includes(slot.blend)) fail(`blend=${slot.blend} (expected Normal, Additive, Multiply, Screen)`);
    if (typeof slot.pma !== 'boolean') fail(`pma=${String(slot.pma)} (expected boolean)`);
    if (!indexed && !Number.isFinite((slot as PosedSlot).z)) fail(`z=${String((slot as PosedSlot).z)} (expected finite draw-order index)`);
    const image = this.assets.pageImages.get(slot.page);
    if (!image || !(image.naturalWidth > 0 && image.naturalHeight > 0)) fail('page image absent or not decoded (expected positive naturalWidth/naturalHeight)');
    const valid = (values: DrawNumbers, count: number, field: string) => {
      const source = numberSource(values), offset = numberOffset(values), length = numberCount(values);
      if ((!indexed && !Array.isArray(values)) || length !== count) fail(`${field} length=${Array.isArray(values) || indexed ? length : undefined} (expected ${count})`);
      for (let i = 0; i < count; i++) {
        const value = source[offset + i];
        if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) fail(`${field}[${i}]=${String(value)} (expected finite float32)`);
      }
    };
    valid(slot.tint, 4, 'tint'); if (slot.dark !== undefined) valid(slot.dark, 3, 'dark');
    const coords = slot.kind === 'region' ? slot.corners : slot.vertices;
    const coordCount = numberCount(coords);
    if ((!indexed && !Array.isArray(coords)) || coordCount < 6 || coordCount % 2 !== 0) fail(`positions length=${Array.isArray(coords) || indexed ? coordCount : undefined} (expected even length >=6)`);
    valid(coords, slot.kind === 'region' ? 8 : coordCount, slot.kind === 'region' ? 'corners' : 'vertices');
    const prior = this.pool.get(key);
    const priorPositions = prior?.mesh.geometry.getAttribute('position');
    const sameVertexCount = !this.alwaysReuploadGeometry && prior !== undefined && priorPositions !== undefined && priorPositions.array.length === (coordCount / 2) * 3;
    if (!sameVertexCount || prior.uvs !== slot.uvs) {
      valid(slot.uvs, coordCount, 'uvs');
    }
    const indices = slot.kind === 'region' ? REGION_INDICES : slot.triangles;
    if (!sameVertexCount || prior.indices !== indices) {
      if ((!indexed && !Array.isArray(indices)) || indices.length < 3 || indices.length % 3 !== 0) fail(`triangles length=${indices?.length} (expected multiple of three >=3)`);
      for (let i = 0; i < indices.length; i++) {
        const v = indices[i];
        if (!Number.isInteger(v) || v < 0 || v >= coordCount / 2) fail(`triangles[${i}]=${v} (expected integer 0..${coordCount / 2 - 1})`);
      }
    }
    if (!indexed && slot.kind === 'mesh' && !Number.isInteger(slot.sequence)) fail(`sequence=${slot.sequence} (expected integer)`);
    const tintSource = numberSource(slot.tint), tintOffset = numberOffset(slot.tint);
    const light: [number, number, number, number] = [
      tintSource[tintOffset + 0],
      tintSource[tintOffset + 1],
      tintSource[tintOffset + 2],
      tintSource[tintOffset + 3],
    ];
    const dark: [number, number, number] = slot.dark ? [slot.dark[0], slot.dark[1], slot.dark[2]] : [0, 0, 0];
    return {
      slot,
      key,
      image: image!,
      positions: coords,
      indices,
      polygon: slot.clip !== undefined ? clipPolygon(slot.clip, detail, this.host.capabilities.maxTextureSize, indexed) : null,
      light,
      dark,
      inverse: slot.clip?.inverse ?? false,
      blend: slot.blend,
    };
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
  render(frame: PosedFrame | LiveFrame): void {
    if (this.disposed) throw new Error('ThreeRenderer: render called after dispose (expected active renderer)');
    if (!frame || typeof frame !== 'object') throw new Error('ThreeRenderer: frame.order absent (expected PosedSlot array)');
    if ('order' in frame) {
      if (!Array.isArray(frame.order)) throw new Error('ThreeRenderer: frame.order absent (expected PosedSlot array)');
      this.renderOrder(frame.order, false);
      return;
    }
    try {
      this.renderOrder(this.liveViews.read(frame), true);
    } finally {
      this.liveViews.release();
    }
  }
  private renderOrder(order: readonly (PosedSlot | DrawSlot)[], indexed: boolean): void {
    // Validate the complete frame, including cross-slot page conventions, before any allocation or scene mutation.
    const occurrences = new Map<string, number>();
    const prepared = order.map((s) => {
      const slotName = typeof s?.slot === 'string' && s.slot.length > 0 ? s.slot : '<unnamed>';
      const occurrence = occurrences.get(slotName) ?? 0; occurrences.set(slotName, occurrence + 1);
      return this.prepare(s, `${slotName}\0${occurrence}`, indexed);
    });
    const conventions = new Map<HTMLImageElement, boolean>();
    for (const item of prepared) {
      const pma = conventions.get(item.image) ?? pages.get(item.image)?.pma;
      if (pma !== undefined && pma !== item.slot.pma) throw new Error(`ThreeRenderer: slot "${item.slot.slot}" page "${item.slot.page}" pma=${item.slot.pma} conflicts with retained pma=${pma} (expected one convention per page image)`);
      conventions.set(item.image, item.slot.pma);
    }
    const active: ThreeSlotMesh[] = [];
    prepared.forEach((item, index) => {
      const { key } = item;
      let entry = this.pool.get(key);
      if (!entry) {
        const geometry = new BufferGeometry();
        const mesh = new Mesh(geometry, this.material(item)) as ThreeSlotMesh;
        mesh.frustumCulled = false; mesh.name = item.slot.slot;
        entry = {
          mesh,
          polygon: null,
          polygonValues: [],
          uvs: null,
          indices: null,
          light: item.light,
          dark: item.dark,
          inverse: item.inverse,
          blend: item.blend,
          needsWideIndex: false,
        };
        const current = entry;
        mesh.onBeforeRender = () => {
          const material = mesh.material;
          material.uniforms.light.value = current.light; material.uniforms.dark.value = current.dark;
          material.uniforms.polygon.value = current.polygon ?? material.uniforms.page.value;
          material.uniforms.points.value = current.polygon === null ? 0 : current.polygonValues.length / 2;
          material.uniforms.inverse.value = current.inverse;
          material.blendEquation = material.blendEquationAlpha = AddEquation;
          material.blendSrc = current.blend === 'Multiply' ? DstColorFactor : OneFactor;
          material.blendDst = current.blend === 'Additive' ? OneFactor : current.blend === 'Screen' ? OneMinusSrcColorFactor : OneMinusSrcAlphaFactor;
          material.blendSrcAlpha = OneFactor; material.blendDstAlpha = material.blendDst;
          material.uniformsNeedUpdate = true;
        };
        this.pool.set(key, entry);
      }
      const { mesh } = entry;
      const positionCount = numberCount(item.positions);
      const oldPositions = mesh.geometry.getAttribute('position'), oldUVs = mesh.geometry.getAttribute('uv'), oldIndex = mesh.geometry.getIndex();
      let needsWideIndex = entry.needsWideIndex;
      if (this.alwaysReuploadGeometry || entry.indices !== item.indices || !oldIndex) {
        needsWideIndex = false;
        if (positionCount / 2 > 65535) {
          for (let i = 0; i < item.indices.length; i++) if (item.indices[i] >= 65535) { needsWideIndex = true; break; }
        }
        entry.needsWideIndex = needsWideIndex;
      }
      if ((oldPositions && oldPositions.array.length !== positionCount / 2 * 3) || (oldUVs && oldUVs.array.length !== item.slot.uvs.length) || (oldIndex && (oldIndex.count !== item.indices.length || (needsWideIndex && !(oldIndex.array instanceof Uint32Array))))) {
        // Dispose while the old attributes are still attached, so Three deletes every old GPU buffer.
        mesh.geometry.dispose(); mesh.geometry = new BufferGeometry(); entry.uvs = entry.indices = null;
      }
      entry.light = item.light;
      entry.dark = item.dark;
      entry.inverse = item.inverse;
      entry.blend = item.blend;
      if (!indexed) {
        mesh.posedSlot = item.slot as PosedSlot;
      } else {
        const prior = mesh.posedSlot as Partial<PosedSlot> | undefined;
        if (!prior || prior.slot !== item.slot.slot || prior.page !== item.slot.page || prior.pma !== item.slot.pma || prior.kind !== item.slot.kind || prior.blend !== item.slot.blend) {
          mesh.posedSlot = (item.slot.kind === 'region'
            ? { kind: 'region', slot: item.slot.slot, z: 0, page: item.slot.page, region: item.slot.region, pma: item.slot.pma, blend: item.slot.blend, corners: [], uvs: [], tint: item.light }
            : { kind: 'mesh', slot: item.slot.slot, z: 0, page: item.slot.page, pma: item.slot.pma, blend: item.slot.blend, vertices: [], uvs: [], triangles: [], sequence: 0, tint: item.light }) as PosedSlot;
        }
      }
      mesh.material = this.material(item); mesh.renderOrder = index;
      const posLength = (positionCount / 2) * 3;
      let posAttr = mesh.geometry.getAttribute('position') as BufferAttribute | undefined;
      let posChanged = this.alwaysReuploadGeometry || !posAttr || posAttr.array.length !== posLength;
      if (!posAttr || posAttr.array.length !== posLength) {
        posAttr = new BufferAttribute(new Float32Array(posLength), 3).setUsage(DynamicDrawUsage);
        mesh.geometry.setAttribute('position', posAttr);
      }
      const posArray = posAttr.array as Float32Array;
      const posSource = numberSource(item.positions), posOffset = numberOffset(item.positions);
      for (let i = 0, out = 0; i < positionCount; i += 2, out += 3) {
        const x = Math.fround(posSource[posOffset + i]), y = Math.fround(posSource[posOffset + i + 1]);
        if (posArray[out] !== x || posArray[out + 1] !== y || posArray[out + 2] !== 0) {
          posArray[out] = x; posArray[out + 1] = y; posArray[out + 2] = 0;
          posChanged = true;
        }
      }
      if (posChanged) { posAttr.needsUpdate = true; this.positionUploadCount++; }

      if (this.alwaysReuploadGeometry || entry.uvs !== item.slot.uvs) {
        const uvs = item.slot.uvs;
        let uvAttr = mesh.geometry.getAttribute('uv') as BufferAttribute | undefined;
        let uvChanged = true;
        if (!uvAttr || uvAttr.array.length !== uvs.length) {
          uvAttr = new BufferAttribute(new Float32Array(uvs.length), 2).setUsage(DynamicDrawUsage);
          mesh.geometry.setAttribute('uv', uvAttr);
        }
        const uvArray = uvAttr.array as Float32Array;
        for (let i = 0; i < uvs.length; i++) {
          const v = Math.fround(uvs[i]);
          if (uvArray[i] !== v) { uvArray[i] = v; uvChanged = true; }
        }
        if (uvChanged) { uvAttr.needsUpdate = true; this.uvUploadCount++; }
        entry.uvs = uvs;
      }
      if (this.alwaysReuploadGeometry || entry.indices !== item.indices) {
        const before = mesh.geometry.getIndex();
        if (before && before.count === item.indices.length) {
          for (let i = 0; i < item.indices.length; i++) before.setX(i, item.indices[i]);
          before.needsUpdate = true;
        } else {
          const copied = new Array<number>(item.indices.length);
          for (let i = 0; i < item.indices.length; i++) copied[i] = item.indices[i];
          mesh.geometry.setIndex(copied);
        }
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

export interface ThreeRigOptions {
  renderer: WebGLRenderer;
  skin?: string;
  slots?: SlotFilter;
  timescale?: number;
  timeScale?: number;
  liveFrameChecks?: boolean;
  poser?: 'auto' | 'oracle';
}
/** A flat native Group. Advance from the app's loop using seconds, without an internal clock. */
export class ThreeRig extends Group {
  readonly player: RigPlayer;
  readonly renderer: ThreeRenderer;
  private readonly retainedRuntimeFrame = new RetainedRuntimeFrame('ThreeRig');
  private lastFrame: PosedFrame | null = null;
  private destroyed = false;
  constructor(readonly assets: ModelAssets, options: ThreeRigOptions) {
    super();
    if (!assets?.document || !(assets.pageImages instanceof Map) || !isWebGLHost(options?.renderer)) throw new Error('ThreeRig: expected ModelAssets and options.renderer WebGLRenderer');
    const scale = options.timescale ?? options.timeScale ?? 1;
    if (!Number.isFinite(scale) || scale < 0) throw new Error(`ThreeRig: timescale=${scale} (expected finite number >=0)`);
    this.player = new RigPlayer(document.createElement('div'), assets, {
      mode: assets.regions === 'none' ? 'canvas' : 'dom',
      skin: options.skin,
      slots: options.slots,
      liveFrameChecks: options.liveFrameChecks,
      poser: options.poser,
    });
    this.renderer = new ThreeRenderer(this, assets, options.renderer);
    this.timescale = scale;
    try { this.lastFrame = this.draw(); } catch (error) { this.renderer.dispose(); this.player.dispose(); throw error; }
  }
  private active(): void { if (this.destroyed) throw new Error('ThreeRig: called after destroy (expected active rig)'); }
  play(name: string, options: PlayOptions = {}): void { this.active(); this.player.play(name, options); this.drawCurrent(); }
  seek(time: number): void { this.active(); if (!Number.isFinite(time)) throw new Error(`ThreeRig: time=${time} (expected finite seconds)`); this.player.seek(time); this.drawCurrent(); }
  advance(dt: number): void {
    this.active();
    if (!Number.isFinite(dt) || dt < 0) throw new Error(`ThreeRig: dt=${dt} (expected finite seconds >=0)`);
    if (this.timescale === 0) return;
    this.player.advance(dt); this.drawCurrent();
  }
  update(dt: number): void { this.advance(dt); }
  draw(): PosedFrame { this.active(); const frame = this.player.posedFrame(); this.renderer.render(frame); this.lastFrame = frame; return frame; }
  renderFrame(frame: PosedFrame | LiveFrame): void {
    this.active();
    if ('order' in frame) {
      this.renderer.render(frame);
      this.lastFrame = frame;
      return;
    }
    if (frame.generation !== this.player.generation) {
      throw new Error(`ThreeRig: live frame generation ${frame.generation} needs current player generation ${this.player.generation}`);
    }
    if (this.player.poser !== 'runtime') {
      this.renderFrame(this.player.posedFrame());
      return;
    }
    this.renderer.render(frame);
    this.retainedRuntimeFrame.capture(frame, () => this.player.posedFrame());
    this.lastFrame = null;
  }
  private drawCurrent(): void {
    this.renderFrame(this.player.poser === 'runtime' ? this.player.liveFrame() : this.player.posedFrame());
  }
  drawnFrame(): PosedFrame { this.active(); return this.lastFrame ??= this.retainedRuntimeFrame.snapshot(); }
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
