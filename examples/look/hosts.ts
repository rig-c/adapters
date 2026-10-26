import type { ModelAssets } from '@rig-c/play';
import type { LookRig } from './look.ts';

export type LookHostName = 'pixi' | 'phaser' | 'three';
export interface LookHost {
  readonly name: LookHostName;
  readonly canvas: HTMLCanvasElement;
  mount(assets: ModelAssets): LookRig;
  unmount(rig: LookRig): void;
  render(): void;
  countNonEmptyPixels(): number;
  placement(): readonly number[];
  destroy(): void;
}

/** Hosts own drawing and placement; pointer, spring and posing stay shared. */
export async function createLookHost(name: LookHostName, parent: HTMLElement, width: number, height: number): Promise<LookHost> {
  let canvas: HTMLCanvasElement;
  let gl: WebGLRenderingContext | WebGL2RenderingContext;
  let mount: LookHost['mount'];
  let unmount: LookHost['unmount'];
  let render: LookHost['render'];
  let placement: LookHost['placement'];
  let destroy: LookHost['destroy'];
  const framing = (rig: LookRig) => {
    const bounds = rig.bounds();
    if (!bounds) throw new Error(`LookHost ${name}: rig has no drawable bounds`);
    return {
      scale: Math.min(width * 0.82 / Math.max(1, bounds.width), height * 0.88 / Math.max(1, bounds.height)),
      cx: bounds.x + bounds.width * 0.5,
      cy: bounds.y + bounds.height * 0.5,
    };
  };
  if (name === 'pixi') {
    const [{ Container, WebGLRenderer }, { PixiRig }] = await Promise.all([import('pixi.js'), import('@rig-c/pixi')]);
    const renderer = new WebGLRenderer();
    await renderer.init({ width, height, backgroundAlpha: 0, antialias: true, resolution: 1, preserveDrawingBuffer: true, clearBeforeRender: true });
    canvas = renderer.canvas as HTMLCanvasElement;
    gl = renderer.gl;
    const stage = new Container();
    let current: InstanceType<typeof PixiRig> | null = null;
    mount = assets => {
      const rig = new PixiRig(assets, { ticker: null, autoUpdate: false });
      current = rig;
      const { scale, cx, cy } = framing(rig);
      rig.scale.set(scale);
      rig.position.set(width * 0.5 - cx * scale, height * 0.5 + cy * scale);
      stage.addChild(rig);
      return rig;
    };
    unmount = rig => { stage.removeChild(rig as InstanceType<typeof PixiRig>); rig.destroy(); current = null; };
    render = () => renderer.render({ container: stage });
    placement = () => current ? [current.x, current.y, current.scale.x, current.scale.y, current.rotation] : [];
    destroy = () => { stage.destroy(); renderer.destroy(); };
  } else if (name === 'phaser') {
    const [{ default: Phaser }, { PhaserRig }] = await Promise.all([import('phaser'), import('@rig-c/phaser')]);
    const { game, scene } = await new Promise<{ game: Phaser.Game; scene: Phaser.Scene }>(resolve => {
      const game = new Phaser.Game({
        type: Phaser.WEBGL, width, height, parent, transparent: true, banner: false, audio: { noAudio: true },
        render: { antialias: true, preserveDrawingBuffer: true },
        scene: { create(this: Phaser.Scene) { queueMicrotask(() => { game.loop.stop(); resolve({ game, scene: this }); }); } },
      });
    });
    canvas = game.canvas;
    gl = (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl;
    let current: InstanceType<typeof PhaserRig> | null = null;
    mount = assets => {
      const rig = new PhaserRig(scene, assets, { autoUpdate: false });
      current = rig;
      const { scale, cx, cy } = framing(rig);
      rig.setScale(scale);
      rig.setPosition(width * 0.5 - cx * scale, height * 0.5 + cy * scale);
      scene.add.existing(rig);
      return rig;
    };
    unmount = rig => { rig.destroy(); current = null; };
    render = () => game.step(0, 0);
    placement = () => current ? [current.x, current.y, current.scaleX, current.scaleY, current.rotation] : [];
    destroy = () => { game.destroy(true); game.step(0, 0); };
  } else {
    const [THREE, { ThreeRig }] = await Promise.all([import('three'), import('@rig-c/three')]);
    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(width, height, false);
    canvas = renderer.domElement;
    gl = renderer.getContext();
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(0, width, height, 0, -1000, 1000);
    let current: InstanceType<typeof ThreeRig> | null = null;
    mount = assets => {
      const rig = new ThreeRig(assets, { renderer });
      current = rig;
      const { scale, cx, cy } = framing(rig);
      rig.scale.set(scale, scale, 1);
      rig.position.set(width * 0.5 - cx * scale, height * 0.5 - cy * scale, 0);
      scene.add(rig);
      return rig;
    };
    unmount = rig => { rig.destroy(); current = null; };
    render = () => renderer.render(scene, camera);
    placement = () => current ? [...current.position.toArray(), ...current.scale.toArray(), ...camera.projectionMatrix.elements] : [];
    destroy = () => { renderer.dispose(); renderer.forceContextLoss(); };
  }
  if (canvas.parentElement !== parent) parent.appendChild(canvas);
  return {
    name, canvas, mount, unmount, render, placement, destroy,
    countNonEmptyPixels() {
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let count = 0;
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++;
      return count;
    },
  };
}
