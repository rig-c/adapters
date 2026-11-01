---
name: rig-pixi
description: Play a rig built by rigc (skeleton.model.json) inside a PixiJS 8 scene graph with @rig-c/pixi (PixiRig and PixiRenderer), posed through @rig-c/play with no Spine runtime. Use when the request puts a 2D rig into a PixiJS Application or Container, updates Pixi geometry buffers from play's LiveFrame or PosedFrame, or shares ModelAssets across Pixi instances. Not for standalone DOM/canvas pages without PixiJS (use the rig-play skill), Phaser 4 scenes (use rig-phaser), Three.js scenes (use rig-three), or compiling a rig (use rigc or rig-parts).
license: MIT
compatibility: Browser ES2022 runtime with PixiJS 8 (pixi.js ^8.0.0) and @rig-c/play (^1.20.0) installed as peerDependencies. The npm package is @rig-c/pixi (npm i @rig-c/pixi pixi.js @rig-c/play); links no Esoteric Software runtime.
---

# @rig-c/pixi — playing a rig-c model in PixiJS 8

Load this when a built rig (`skeleton.model.json` and its atlas page images from
`rigc build`) goes **inside a PixiJS 8 `Application` or `Container`**. Every
rule below is owned by the shipped
[README.md](https://github.com/rig-c/adapters/blob/main/packages/pixi/README.md)
and [`dist/index.d.ts`](https://github.com/rig-c/adapters/tree/main/packages/pixi);
this file says when to open them and what `@rig-c/pixi` will not do.

## Minimal loop

```ts
import { loadModel } from '@rig-c/play';
import { Application } from 'pixi.js';
import { PixiRig } from '@rig-c/pixi';

const app = new Application();
await app.init({ width: 800, height: 600 });
document.body.appendChild(app.canvas);

const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });
const rig = new PixiRig(assets, { ticker: app.ticker });
rig.play('walk');
app.stage.addChild(rig);

// On removal: detach and destroy the rig before disposing shared ModelAssets
app.stage.removeChild(rig);
rig.destroy();
assets.dispose();
```

`PixiRig` is a Pixi `Container` that owns its `RigPlayer` and `PixiRenderer`;
use `PixiRenderer` directly when you own the `RigPlayer` yourself. Both
`@rig-c/pixi` and `@rig-c/pixi/pixi` export the same typed surface.

## Non-negotiables

- **Load `skeleton.model.json` from `rigc build`, never a Spine export.** The
  model document and its page PNGs must stay together; `@rig-c/play`'s
  `loadModel` refuses `skeleton.json` and `.skel` by name before fetching —
  [README.md](https://github.com/rig-c/adapters/blob/main/packages/pixi/README.md).
- **Consume `liveFrame()` synchronously.** `advance()` and ticker updates
  consume the player's borrowed `LiveFrame` lease in place; if you step
  `rig.player` and call `rig.renderFrame(frame)` yourself, do so before any
  further player mutation, or use `drawnFrame()` / `posedFrame()` when a
  detached snapshot is needed —
  [README.md](https://github.com/rig-c/adapters/blob/main/packages/pixi/README.md#minimal-usage).
- **Destroy every `PixiRig` before `assets.dispose()`.** `rig.destroy()` frees
  the instance's Pixi display objects, geometry buffers and ticker binding;
  `assets.dispose()` revokes the shared region blob URLs once no rig draws from
  them.
- **Refuse by name, never guess.** An animation name not in the model or a
  malformed frame field is refused by name; no Spine runtime is linked.

## What this will not do

- Play on a plain DOM page without PixiJS (use `@rig-c/play` and the `rig-play`
  skill) or inside Phaser / Three.js (use `rig-phaser` or `rig-three`).
- Compile, gate or retarget a rig (use `rigc`, `rig-parts` or `rig-pose`).
- Promise a 1.0 freeze yet (`@rig-c/pixi` is 0.x and requires `@rig-c/play >=1.20.0 <2`).

## Read, in this order

1. `node_modules/@rig-c/pixi/README.md` ([on GitHub](https://github.com/rig-c/adapters/blob/main/packages/pixi/README.md)) —
   `PixiRig`, `PixiRenderer`, `liveFrameChecks`, `poser`, `draw()` vs
   `drawnFrame()`, and separate pose/draw staging.
2. `node_modules/@rig-c/pixi/dist/index.d.ts` — the exact exported types and
   options matching the installed version.
3. [@rig-c/play's REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md) —
   the underlying `loadModel`, `RigPlayer`, `LiveFrame` and `PosedFrame`
   contracts.
