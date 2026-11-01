---
name: rig-phaser
description: Play a rig built by rigc (skeleton.model.json) inside a Phaser 4.2+ WebGL scene with @rig-c/phaser (PhaserRig and PhaserRenderer), posed through @rig-c/play with shared GPU page textures and no Spine runtime. Use when the request puts a 2D rig into a Phaser Scene or Container, shares ModelAssets across PhaserRig instances, or renders LiveFrame/PosedFrame through native Phaser Mesh2D and RenderNode objects. Not for standalone DOM/canvas pages (use rig-play), PixiJS (use rig-pixi), Three.js (use rig-three), or compiling a rig (use rigc or rig-parts).
license: MIT
compatibility: Browser ES2022 runtime with Phaser 4.2+ WebGL (phaser ^4.2.0) and @rig-c/play (^1.20.0) installed as peerDependencies. The npm package is @rig-c/phaser (npm i @rig-c/phaser phaser @rig-c/play); links no Esoteric Software runtime.
---

# @rig-c/phaser — playing a rig-c model in Phaser 4.2+

Load this when a built rig (`skeleton.model.json` and its atlas page images from
`rigc build`) goes **inside a Phaser 4.2+ WebGL `Scene`**. Every rule below is
owned by the shipped
[README.md](https://github.com/rig-c/adapters/blob/main/packages/phaser/README.md)
and [`dist/index.d.ts`](https://github.com/rig-c/adapters/tree/main/packages/phaser);
this file says when to open them and what `@rig-c/phaser` will not do.

## Minimal loop

```ts
import { loadModel } from '@rig-c/play';
import { PhaserRig } from '@rig-c/phaser';

// Inside a running Phaser 4.2+ WebGL scene:
const assets = await loadModel({
  modelUrl: '/rigs/walk/skeleton.model.json',
  regions: 'none', // PhaserRenderer samples full-page UVs; skip unused region blob cuts
});
const rig = new PhaserRig(scene, assets);
rig.setPosition(320, 400);
rig.play('walk');
scene.add.existing(rig);

// On removal: destroy every PhaserRig using `assets` before assets.dispose()
rig.destroy();
assets.dispose();
```

`PhaserRig` is a `Phaser.GameObjects.Container` that steps on
`Phaser.Scenes.Events.UPDATE` (pass `{ autoUpdate: false }` to step manually with
`rig.advance(dt)`). Use `PhaserRenderer(container, assets)` when you own the
`RigPlayer` and container directly.

## Non-negotiables

- **Pass `regions: 'none'` to `loadModel` for Phaser-only loads.** `PhaserRenderer`
  draws native `Phaser.GameObjects.Mesh2D` objects sampling full-page UVs, so
  per-region blob cutting is unused overhead —
  [README.md](https://github.com/rig-c/adapters/blob/main/packages/phaser/README.md#renderer-contract).
- **Keep meshes within WebGL2 `UNSIGNED_SHORT` indices (≤ 65,535 vertices).**
  Indices `0..65534` are usable (`65535` is WebGL2 primitive restart); a
  malformed or out-of-range slot, clip or conflicting `pma` page is refused by
  name before the accepted frame changes —
  [README.md](https://github.com/rig-c/adapters/blob/main/packages/phaser/README.md#renderer-contract).
- **Destroy every `PhaserRig` before `assets.dispose()`.** Multiple `PhaserRig`
  instances over one `ModelAssets` load share reference-counted Phaser page
  textures on the same `WebGLRenderer`; destroying the last holder removes those
  textures from `scene.textures` and deletes their `WebGLTexture` handles —
  [README.md](https://github.com/rig-c/adapters/blob/main/packages/phaser/README.md#minimal-usage).
- **Consume `liveFrame()` synchronously.** Do not mutate `rig.player` between
  acquiring `liveFrame()` and calling `renderFrame(frame)`; use `drawnFrame()`
  or `posedFrame()` when a detached snapshot is required.

## What this will not do

- Run on Phaser 3 or a Canvas2D-only Phaser renderer (requires Phaser 4.2+ WebGL).
- Play on a plain DOM page without Phaser (use `rig-play`) or inside PixiJS /
  Three.js (use `rig-pixi` or `rig-three`).
- Compile, gate or retarget a rig (use `rigc`, `rig-parts` or `rig-pose`).

## Read, in this order

1. `node_modules/@rig-c/phaser/README.md` ([on GitHub](https://github.com/rig-c/adapters/blob/main/packages/phaser/README.md)) —
   `PhaserRig`, `PhaserRenderer`, shared page-texture ref-counting, stencil
   clips, two-colour tint, `BLEND_PHASER` and screen-vertex readers.
2. `node_modules/@rig-c/phaser/dist/index.d.ts` — the exact exported types and
   options matching the installed version.
3. [@rig-c/play's REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md) —
   the underlying `loadModel`, `RigPlayer`, `LiveFrame` and `PosedFrame`
   contracts.
