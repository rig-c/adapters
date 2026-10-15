import { RigPlayer, type ModelAssets } from '@rig-c/play';
import Phaser from 'phaser';
import { PhaserRenderer } from '@rig-c/phaser';

/** Installed consumer hook; deliberately needs no live PhaserRig. */
export async function smoke(assets: ModelAssets): Promise<number> {
  const { game, scene } = await new Promise<{ game: Phaser.Game; scene: Phaser.Scene }>((resolve) => {
    const game = new Phaser.Game({
      type: Phaser.WEBGL, width: 640, height: 480, transparent: true, banner: false,
      audio: { noAudio: true }, render: { preserveDrawingBuffer: true, antialias: false },
      scene: { create(this: Phaser.Scene) { queueMicrotask(() => { game.loop.stop(); resolve({ game, scene: this }); }); } },
    });
  });
  const player = new RigPlayer(document.createElement('div'), assets);
  const root = scene.add.container(320, 400).setScale(0.6);
  const renderer = new PhaserRenderer(root, assets);
  try {
    player.play('walk'); player.seek(0.5);
    const complete = player.posedFrame();
    const frame = player.posedFrame(complete.order.filter((slot) => slot.kind === 'region').map((slot) => slot.slot));
    renderer.render(frame); game.step(0, 0);
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('INSTALL_SMOKE_CONTEXT: absent 2d context');
    ctx.drawImage(game.canvas, 0, 0);
    const pixels = ctx.getImageData(0, 0, 640, 480).data;
    let drawn = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) drawn++;
    if (drawn === 0) throw new Error('INSTALL_SMOKE_PIXELS: Phaser region frame drew no pixels');
    return drawn;
  } finally {
    renderer.dispose(); player.dispose(); root.destroy(); game.destroy(true, false); game.step(0, 0);
  }
}
