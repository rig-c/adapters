import Phaser from 'phaser';
import type { DrawSlot } from '@rig-c/adapters-shared';
import type { LiveNumbers, PosedSlot } from '@rig-c/play';

type Renderer = Phaser.Renderer.WebGL.WebGLRenderer;
type Buffer = Phaser.Renderer.WebGL.Wrappers.WebGLBufferWrapper;
type Program = Phaser.Renderer.WebGL.Wrappers.WebGLProgramWrapper;
type VAO = Phaser.Renderer.WebGL.Wrappers.WebGLVAOWrapper;
type Layout = Phaser.Renderer.WebGL.Wrappers.WebGLVertexBufferLayoutWrapper;
type Context = Phaser.Renderer.WebGL.DrawingContext;
type Transformer = Phaser.Renderer.WebGL.RenderNodes.TransformerVertex;

// Runtime 4.2.1 takes three arguments; its declaration still lists an obsolete
// program argument. Likewise createVAO consumes layout wrappers, not raw layouts.
const NativeLayout = Phaser.Renderer.WebGL.Wrappers.WebGLVertexBufferLayoutWrapper as unknown as {
  new(renderer: Renderer, layout: { count: number; usage: number; layout: Array<{ name: string; size: number; type: 'FLOAT' }> }, buffer: Buffer): Layout;
};
const vertexShader = `
attribute vec2 aPosition;
attribute vec2 aUV;
uniform mat4 uProjection;
uniform float uFlipV;
varying vec2 vUV;
void main(){ vUV=vec2(aUV.x,mix(aUV.y,1.0-aUV.y,uFlipV)); gl_Position=uProjection*vec4(aPosition,1.0,1.0); }
`;
const fragmentShader = `
precision mediump float;
uniform sampler2D uTexture;
uniform vec3 uLight;
uniform vec3 uDark;
uniform float uAlpha;
varying vec2 vUV;
void main(){ vec4 t=texture2D(uTexture,vUV); gl_FragColor=vec4((t.rgb*uLight+(t.a-t.rgb)*uDark)*uAlpha,t.a*uAlpha); }
`;

/** Native wrappers retained on the actual host object for geometry inspection. */
export interface SlotBuffers {
  position: Buffer;
  uv: Buffer;
  index: Buffer;
  vao: VAO;
  uvs: LiveNumbers;
  triangles: LiveNumbers;
  count: number;
}
export interface SlotView extends Phaser.GameObjects.Mesh2D {
  tint: number;
  posedSlot: PosedSlot;
  slotLight: [number, number, number];
  slotDark: [number, number, number];
  slotBuffers?: SlotBuffers;
}
const regionTriangles = [0, 1, 2, 0, 2, 3];

function unbindVAO(renderer: Renderer): void {
  const update = renderer.glWrapper.updateVAO as unknown as (state: { vao: VAO | null }) => void;
  update.call(renderer.glWrapper, { vao: null });
}

function deleteVAO(renderer: Renderer, vao: VAO): void {
  unbindVAO(renderer);
  Phaser.Utils.Array.Remove(renderer.glVAOWrappers, vao);
  vao.destroy();
}

function toFloat32(source: LiveNumbers): Float32Array<ArrayBuffer> {
  const out = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = source[i];
  return out;
}

function toUint16(source: LiveNumbers): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = source[i];
  return out;
}

/** Native standalone drawing: positions change independently of UV/topology. */
export class FrameSubmitter extends Phaser.Renderer.WebGL.RenderNodes.RenderNode {
  readonly program: Program;
  private readonly owned = new Map<SlotView, SlotBuffers>();
  /** Deliberately exposed diagnostic control; it forces actual native uploads. */
  alwaysReuploadGeometry = false;

  constructor(readonly renderer: Renderer) {
    super('RigcPosedFrame', renderer.renderNodes);
    this.program = renderer.createProgram(vertexShader, fragmentShader);
  }

  private allocate(view: SlotView, slot: PosedSlot | DrawSlot): SlotBuffers {
    const renderer = this.renderer, gl = renderer.gl;
    const triangles = slot.kind === 'region' ? regionTriangles : slot.triangles;
    const vertexCount = view.vertices.length / 4;
    unbindVAO(renderer);
    const position = renderer.createVertexBuffer(new ArrayBuffer(vertexCount * 8), gl.DYNAMIC_DRAW);
    const uv = renderer.createVertexBuffer(toFloat32(slot.uvs).buffer, gl.STATIC_DRAW);
    const index = renderer.createIndexBuffer(toUint16(triangles).buffer, gl.STATIC_DRAW);
    const vao = this.createVAO(position, uv, index, vertexCount);
    const buffers: SlotBuffers = { position, uv, index, vao, uvs: slot.uvs, triangles, count: triangles.length };
    this.owned.set(view, buffers); view.slotBuffers = buffers;
    return buffers;
  }

  private createVAO(position: Buffer, uv: Buffer, index: Buffer, count: number): VAO {
    const renderer = this.renderer, gl = renderer.gl;
    const pLayout = new NativeLayout(renderer, { count, usage: gl.DYNAMIC_DRAW, layout: [{ name: 'aPosition', size: 2, type: 'FLOAT' }] }, position);
    const uvLayout = new NativeLayout(renderer, { count, usage: gl.STATIC_DRAW, layout: [{ name: 'aUV', size: 2, type: 'FLOAT' }] }, uv);
    const createVAO = renderer.createVAO as unknown as (program: Program, index: Buffer, layouts: Layout[]) => VAO;
    return createVAO.call(renderer, this.program, index, [pLayout, uvLayout]);
  }

  syncBuffers(view: SlotView, slot: PosedSlot | DrawSlot): SlotBuffers {
    const renderer = this.renderer;
    const triangles = slot.kind === 'region' ? regionTriangles : slot.triangles;
    let buffers = this.owned.get(view);
    if (!buffers) {
      buffers = this.allocate(view, slot);
      if (this.alwaysReuploadGeometry) {
        buffers.uv.update();
        unbindVAO(renderer);
        buffers.index.update();
      }
      return buffers;
    }
    let rebuildVAO = false;
    const replace = (field: 'position' | 'uv' | 'index', values: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>, index = false) => {
      if (!rebuildVAO) { deleteVAO(renderer, buffers!.vao); rebuildVAO = true; }
      renderer.deleteBuffer(buffers![field]);
      unbindVAO(renderer);
      buffers![field] = index ? renderer.createIndexBuffer(values.buffer, renderer.gl.STATIC_DRAW) : renderer.createVertexBuffer(values.buffer, field === 'position' ? renderer.gl.DYNAMIC_DRAW : renderer.gl.STATIC_DRAW);
    };
    const vertexCount = view.vertices.length / 4;
    if (buffers.position.dataBuffer.byteLength !== vertexCount * 8) replace('position', new Float32Array(vertexCount * 2));
    if (this.alwaysReuploadGeometry || buffers.uvs !== slot.uvs) {
      const values = toFloat32(slot.uvs);
      if (buffers.uv.dataBuffer.byteLength !== values.byteLength) replace('uv', values);
      else { buffers.uv.viewF32!.set(values); buffers.uv.update(); }
      buffers.uvs = slot.uvs;
    }
    if (this.alwaysReuploadGeometry || buffers.triangles !== triangles) {
      const values = toUint16(triangles);
      if (buffers.index.dataBuffer.byteLength !== values.byteLength) replace('index', values, true);
      else { unbindVAO(renderer); buffers.index.viewU16!.set(values); buffers.index.update(); }
      buffers.triangles = triangles; buffers.count = triangles.length;
    }
    if (rebuildVAO) buffers.vao = this.createVAO(buffers.position, buffers.uv, buffers.index, vertexCount);
    return buffers;
  }

  override run(context: Context, gameObject: Phaser.GameObjects.GameObject, parentMatrix: Phaser.GameObjects.Components.TransformMatrix, transformer: Transformer): void {
    const view = gameObject as SlotView, slot = view.posedSlot, renderer = this.renderer;
    renderer.renderNodes.finishBatch();
    if (this.program.compiling) {
      this.program.checkParallelCompile();
      if (this.program.compiling) throw new Error(`PhaserRenderer: slot "${slot.slot}" shader is still compiling (expected ready program before drawing)`);
    }
    const buffers = this.owned.get(view) ?? this.syncBuffers(view, slot);
    if (this.alwaysReuploadGeometry) { buffers.uv.update(); unbindVAO(renderer); buffers.index.update(); }
    transformer.setupMatrix(context, view, parentMatrix);
    const point = new Phaser.Math.Vector2();
    const positions = buffers.position.viewF32!;
    let changed = false;
    for (let i = 0; i < view.vertices.length; i += 4) {
      point.set(view.vertices[i], view.vertices[i + 1]); transformer.transformVertex(point);
      const offset = i / 2, x = Math.fround(point.x), y = Math.fround(point.y);
      if (positions[offset] !== x || positions[offset + 1] !== y) changed = true;
      positions[offset] = x; positions[offset + 1] = y;
    }
    if (changed) buffers.position.update();
    const drawContext = context.getClone();
    drawContext.setBlendMode(Number(view.blendMode)); drawContext.use();
    try {
      renderer.setProjectionMatrixFromDrawingContext(drawContext);
      this.program.setUniform('uProjection', renderer.projectionMatrix.val);
      this.program.setUniform('uTexture', 0);
      this.program.setUniform('uFlipV', view.flipV ? 1 : 0);
      this.program.setUniform('uLight', view.slotLight);
      this.program.setUniform('uDark', view.slotDark);
      this.program.setUniform('uAlpha', view.alpha);
      const page = view.texture.source[0].glTexture;
      if (!page) throw new Error(`PhaserRenderer: slot "${slot.slot}" has no native texture (expected uploaded page)`);
      renderer.drawElements(drawContext, [page], this.program, buffers.vao, buffers.count, 0, renderer.gl.TRIANGLES);
    } finally { drawContext.release(); }
  }

  remove(view: SlotView): void {
    const buffers = this.owned.get(view);
    if (!buffers) return;
    this.renderer.renderNodes.finishBatch(); deleteVAO(this.renderer, buffers.vao);
    for (const buffer of [buffers.position, buffers.uv, buffers.index]) this.renderer.deleteBuffer(buffer);
    this.owned.delete(view); view.slotBuffers = undefined;
  }

  dispose(): void {
    for (const view of this.owned.keys()) this.remove(view);
    this.renderer.deleteProgram(this.program);
  }
}

/** Float32 screen coordinates actually stored in the native position wrapper. */
export function readMeshScreenVertices(view: Phaser.GameObjects.Mesh2D): number[] {
  const buffers = (view as SlotView).slotBuffers;
  if (!buffers) throw new Error(`PhaserRenderer: slot "${view.name}" has no drawn geometry (expected a completed native draw)`);
  return [...buffers.position.viewF32!];
}
