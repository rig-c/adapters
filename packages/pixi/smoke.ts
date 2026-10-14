import type { ModelAssets } from '@rig-c/play';
import { Container, WebGLRenderer } from 'pixi.js';
import { PixiRig } from '@rig-c/pixi';

/** Installed consumer hook: render one public walk frame and report pixels. */
export async function smoke(assets: ModelAssets): Promise<number> {
  const renderer = new WebGLRenderer();
  await renderer.init({ width: 640, height: 480, backgroundAlpha: 0, preserveDrawingBuffer: true });
  const stage = new Container();
  const rig = new PixiRig(assets, { ticker: null, autoUpdate: false });
  rig.play('walk');
  rig.seek(0.5);
  const bounds = rig.bounds();
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new Error('INSTALL_SMOKE_BOUNDS: walk frame has no bounds');
  const scale = Math.min(500 / bounds.width, 360 / bounds.height);
  rig.scale.set(scale);
  rig.position.set(320 - (bounds.x + bounds.width / 2) * scale, 240 + (bounds.y + bounds.height / 2) * scale);
  stage.addChild(rig);
  renderer.render({ container: stage });
  const pixels = renderer.extract.pixels(stage).pixels;
  let drawn = 0;
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
  rig.destroy();
  renderer.destroy();
  if (drawn === 0) throw new Error('INSTALL_SMOKE_PIXELS: walk frame rendered no pixels');
  return drawn;
}
