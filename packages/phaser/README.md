# @rig-c/phaser

Play a rig that `rigc build` wrote inside a Phaser 4.2+ WebGL scene through `@rig-c/play`'s core, with no Spine runtime.

## Install

```sh
npm install @rig-c/phaser phaser @rig-c/play
```

## Minimal usage

```ts
import { loadModel } from '@rig-c/play';
import { PhaserRig } from '@rig-c/phaser';

// In a running Phaser WebGL scene:
const assets = await loadModel({
  modelUrl: '/rigs/walk/skeleton.model.json',
  regions: 'none',
});
const rig = new PhaserRig(scene, assets);
rig.setPosition(320, 400);
rig.play('walk');
scene.add.existing(rig);

// Several PhaserRigs may share one ModelAssets load:
const second = new PhaserRig(scene, assets, { timescale: 0.5 });
second.setPosition(520, 400);
second.play('walk');
scene.add.existing(second);

// On removal (before finally calling assets.dispose()):
rig.destroy();
second.destroy();
assets.dispose();
```

`PhaserRig` is a native `Phaser.GameObjects.Container` that owns an independent `RigPlayer` and `PhaserRenderer`, advances from `Phaser.Scenes.Events.UPDATE` (`play`, `advance(dt)`, `seek(t)`, `timescale`), exposes `bone(name)`, `bounds()`, `drawnFrame()` and `posedFrame(slots?)`, and releases its native slot meshes, stencil clip helpers, GPU vertex/UV/index buffers, VAOs, shader program and reference-counted page textures on `destroy()` (or scene `SHUTDOWN` / `DESTROY`). Pass `{ autoUpdate: false }` to step manually.

Several `PhaserRig` instances over one `ModelAssets` load share the underlying native Phaser page textures within the same `WebGLRenderer` context (`getPhaserLivePageTextureCount`, `getPhaserPageRefCount`, `getPhaserPageTexture`). Destroying one instance frees only its own meshes, buffers and listener; destroying the last holder removes the shared page textures from `scene.textures` and deletes their `WebGLTexture` handles.

When you own the `RigPlayer` and container directly, use `PhaserRenderer(container, assets)` and call `renderer.render(player.posedFrame())` and `renderer.dispose()`.

## Renderer contract

Load the model and page images `rigc build` wrote, unchanged (`regions: 'none'` skips unused per-region image cutting). The renderer creates native `Phaser.GameObjects.Mesh2D` objects in the supplied container's child order, samples full-page UVs, maps world `(x, y)` to scene `(x, -y)`, and submits persistent native position, UV and element buffers through a Phaser `RenderNode`. Light/dark tint uses the record's full float precision, and native container opacity applies once. Unchanged UV and triangle array identities upload zero new static bytes, independently of position updates; held Float32 positions upload zero bytes too.

Convex, concave and inverse `PosedClip` polygons use native stencil layers, including a shared clip around the entire rig. PMA pages remain premultiplied; straight pages are multiplied once on upload. Page identities with different PMA interpretation receive separate native textures. Malformed data is refused by slot/page name before the accepted frame changes. This native `UNSIGNED_SHORT` path supports at most 65,535 vertices per mesh (indices 0 through 65,534; index 65,535 is reserved primitive restart in WebGL2).

`BLEND_PHASER` documents the four premultiplied RGB/alpha blend-factor tuples; `tintToPhaser` exposes the RGB8 inspection value and scalar alpha; `readRegionScreenCorners` and `readMeshScreenVertices` read native geometry after transform/draw. See [`packages/phaser` in the repository](https://github.com/rig-c/adapters/tree/main/packages/phaser) for the demo and parity suite.
