import type { ModelAssets } from '@rig-c/play';
import { OrthographicCamera, Scene, WebGLRenderer } from 'three';
import { ThreeRig } from '@rig-c/three';

/** Installed export consumer, using a real native WebGL scene. */
export async function smoke(assets: ModelAssets): Promise<number> {
  const renderer = new WebGLRenderer({ alpha: true, preserveDrawingBuffer: true }); renderer.setSize(640, 480);
  const scene = new Scene(), rig = new ThreeRig(assets, { renderer }); scene.add(rig);
  try {
    rig.play('walk'); rig.seek(0.5);
    const b = rig.bounds(); if (!b || b.width <= 0 || b.height <= 0) throw new Error('INSTALL_SMOKE_BOUNDS: walk has no positive bounds');
    const scale = Math.min(500 / b.width, 360 / b.height);
    rig.scale.setScalar(scale); rig.position.set(-(b.x + b.width / 2) * scale, -(b.y + b.height / 2) * scale, 0);
    const camera = new OrthographicCamera(-320, 320, 240, -240, 0.1, 2000); camera.position.z = 1000;
    renderer.render(scene, camera);
    const gl = renderer.getContext(), pixels = new Uint8Array(640 * 480 * 4); gl.readPixels(0, 0, 640, 480, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) count++;
    if (count === 0) throw new Error('INSTALL_SMOKE_PIXELS: ThreeRig rendered no pixels'); return count;
  } finally { rig.destroy(); renderer.dispose(); }
}
