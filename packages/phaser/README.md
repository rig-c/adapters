# @rig-c/phaser

A native Phaser 4.2+ WebGL renderer of `@rig-c/play`'s `PosedFrame` regions and meshes.
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
`Phaser.GameObjects.Mesh2D` objects in the supplied container's child order,
samples full-page UVs, maps world `(x, y)` to scene `(x, -y)`, and submits persistent native position, UV and element buffers through a Phaser
RenderNode. Light/dark tint uses the record’s full float precision, and native
container opacity applies once. It registers its own page textures and removes
them on `dispose`; it never disposes the shared input assets or images.
Each slot completes its native draw independently; the engine texture limit and
ordinary scene objects keep their own settings. Unchanged UV and triangle array
identities upload zero new static bytes, independently of position updates.
Held Float32 positions upload zero bytes too. A changed UV array leaves the
index buffer intact, and a changed triangle array leaves the UV buffer intact.

Convex, concave and inverse `PosedClip` polygons use native stencil layers,
including a shared clip around the entire rig. Their hard geometry is independent
of parent opacity, and the matching subtract operation restores previous stencil
layers. Numerically equal clips retain their helper objects. PMA pages remain
premultiplied; straight pages are multiplied once on upload. Page identities with
different PMA interpretation receive separate native textures.

Malformed data is refused by slot/page name before the accepted frame changes.
This native UNSIGNED_SHORT path supports at most 65,535 vertices per mesh
(indices 0 through 65,534); index 65,535 is reserved primitive restart in WebGL2.
`drawnFrame` exposes the exact accepted record for consumer integration.

`BLEND_PHASER` documents the four premultiplied RGB/alpha blend-factor tuples;
the renderer reuses matching native presets and registers native custom modes
for Phaser presets whose factors differ. One registry belongs to each engine;
ordinary Phaser blend presets remain unchanged. Transparent additive padding
must preserve the pixel beneath it exactly, checked against the original page's
zero-alpha texels with a native ADD-preset negative control.
`tintToPhaser` exposes the RGB8 inspection value and preserves scalar alpha;
the actual shader retains the original light/dark RGB values. `readRegionScreenCorners` reads native
mesh vertices through the native world matrix, for a default unscrolled scene
camera. `readMeshScreenVertices` reads the actual Float32 native position buffer after
a completed draw. Container transforms map the rig into that scene. Camera effects and
screenspace presentation remain the consumer's responsibility.

The parity suite compares native object geometry to that record, and pictures
to CanvasRenderer in the same Chromium/WebKit browser with planted failures.
The independent official raster oracle is development-only and isolated under
`tests/oracle`; no skeleton-format runtime is needed or linked by this package.
