import type { ModelAssets } from '@rig-c/play';
import Phaser from 'phaser';
import { PhaserRig, getPhaserLivePageTextureCount } from '@rig-c/phaser';

/** Installed consumer hook: render one public walk frame through PhaserRig and report pixels. */
export async function smoke(assets: ModelAssets): Promise<number> {
  const { game, scene } = await new Promise<{ game: Phaser.Game; scene: Phaser.Scene }>((resolve) => {
    const game = new Phaser.Game({
      type: Phaser.WEBGL, width: 640, height: 480, transparent: true, banner: false,
      audio: { noAudio: true }, render: { preserveDrawingBuffer: true, antialias: false },
      scene: { create(this: Phaser.Scene) { queueMicrotask(() => { game.loop.stop(); resolve({ game, scene: this }); }); } },
    });
  });
  const native = game.renderer as Phaser.Renderer.WebGL.WebGLRenderer;
  const rig = new PhaserRig(scene, assets, { autoUpdate: false });
  scene.add.existing(rig);
  try {
    rig.setPosition(320, 400).setScale(0.6);
    rig.play('walk'); rig.seek(0.5);
    const bounds = rig.bounds();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new Error('INSTALL_SMOKE_BOUNDS: walk frame has no bounds');
    if (getPhaserLivePageTextureCount(native) === 0) throw new Error('INSTALL_SMOKE_PAGES: no live page textures retained');
    game.step(0, 0);
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('INSTALL_SMOKE_CONTEXT: absent 2d context');
    ctx.drawImage(game.canvas, 0, 0);
    const pixels = ctx.getImageData(0, 0, 640, 480).data;
    let drawn = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
    if (drawn === 0) throw new Error('INSTALL_SMOKE_PIXELS: PhaserRig walk frame drew no pixels');
    rig.destroy();
    if (getPhaserLivePageTextureCount(native) !== 0) throw new Error('INSTALL_SMOKE_RELEASE: live page textures remained after destroy');
    return drawn;
  } finally {
    rig.destroy(); game.destroy(true, false); game.step(0, 0);
  }
}
