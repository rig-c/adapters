# @rig-c/phaser

A native Phaser 4.2+ WebGL renderer of `@rig-c/play`'s `PosedFrame` region slots.
The first release is held until the complete renderer and live-scene cards land.

```ts
import { loadModel, RigPlayer } from '@rig-c/play';
import { PhaserRenderer } from '@rig-c/phaser';

// In a running Phaser WebGL scene:
const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });
const player = new RigPlayer(document.createElement('div'), assets);
player.play('walk');
player.seek(0.5);
const root = scene.add.container(320, 400);
const renderer = new PhaserRenderer(root, assets);
renderer.render(player.posedFrame());
// At teardown:
renderer.dispose();
root.destroy();
player.dispose();
assets.dispose();
```

Load the model and page images `rigc build` wrote, unchanged. The caller owns
the scene, player, container and ModelAssets. The renderer creates native
`Phaser.GameObjects.Mesh2D` quads in the supplied container's child order,
samples full-page UVs, maps world `(x, y)` to scene `(x, -y)`, and uses Phaser's
tint, opacity and blend modes. It registers its own page textures and removes
them on `dispose`; it never disposes the shared input assets or images.
Each region completes its native Phaser batch so that its page texture state
stays isolated from other scene objects. The engine's texture limit is unchanged;
this phase uses one native draw per region rather than batching several pages.

This phase accepts regions only. Mesh slots, clip polygons, dark colour and
premultiplied pages are refused by slot/page name, before the last accepted
frame changes. For a mixed rig, select the intended region names explicitly
using `player.posedFrame(names)`; the renderer never silently drops slots.

`BLEND_PHASER` documents the four premultiplied RGB/alpha blend-factor tuples;
the renderer reuses matching native presets and registers native custom modes
for Phaser presets whose factors differ. One registry belongs to each engine;
ordinary Phaser blend presets remain unchanged. Transparent additive padding
must preserve the pixel beneath it exactly, checked against the original page's
zero-alpha texels with a native ADD-preset negative control.
`tintToPhaser` converts RGB to
Phaser RGB8 and preserves scalar alpha. `readRegionScreenCorners` reads native
mesh vertices through the native world matrix, for a default unscrolled scene
camera. Container transforms map the rig into that scene. Camera effects and
screenspace presentation remain the consumer's responsibility.

The parity suite compares native object geometry to that record, and pictures
to CanvasRenderer in the same Chromium/WebKit browser with planted failures.
No runtime from the skeleton export format is needed or linked.
