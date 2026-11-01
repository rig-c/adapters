---
name: rig-three
description: Play a rig built by rigc (skeleton.model.json) inside a native Three.js WebGL2 scene with @rig-c/three (ThreeRig and ThreeRenderer), posed through @rig-c/play under an orthographic or perspective camera with no Spine runtime. Use when the request puts a 2D rig into a Three.js Scene or Group, orders flat rigs in 3D space, or renders LiveFrame/PosedFrame as native Three.js Mesh objects. Not for standalone DOM/canvas pages (use rig-play), PixiJS (use rig-pixi), Phaser (use rig-phaser), WebGPURenderer, or compiling a rig (use rigc or rig-parts).
license: MIT
compatibility: Browser ES2022 runtime with Three.js (three ^0.186.1, plus @types/three for TypeScript) and @rig-c/play (^1.20.0) installed as peerDependencies. The npm package is @rig-c/three (npm i @rig-c/three three @rig-c/play); requires Three.js WebGLRenderer (WebGL2) and links no Esoteric Software runtime.
---

# @rig-c/three — playing a rig-c model in Three.js

Load this when a built rig (`skeleton.model.json` and its atlas page images from
`rigc build`) goes **inside a Three.js `Scene` (orthographic or perspective)**
as a native `Group` (`ThreeRig`) or through `ThreeRenderer`. Every rule below is
owned by the shipped
[README.md](https://github.com/rig-c/adapters/blob/main/packages/three/README.md)
and [`dist/index.d.ts`](https://github.com/rig-c/adapters/tree/main/packages/three);
this file says when to open them and what `@rig-c/three` will not do.

## Minimal loop

```ts
import { loadModel } from '@rig-c/play';
import { OrthographicCamera, Scene, WebGLRenderer } from 'three';
import { ThreeRig } from '@rig-c/three';

const renderer = new WebGLRenderer({ alpha: true });
renderer.setSize(800, 600);
document.body.appendChild(renderer.domElement);

const scene = new Scene();
const camera = new OrthographicCamera(-400, 400, 300, -300, 0.1, 2000);
camera.position.z = 1000;

const assets = await loadModel({ modelUrl: '/rigs/walk/skeleton.model.json' });
const rig = new ThreeRig(assets, { renderer });
rig.play('walk');
scene.add(rig);

// The app owns the loop: call rig.update(dt) in seconds before renderer.render
let previous: number | undefined;
function frame(now: number) {
  if (previous !== undefined) rig.update((now - previous) / 1000);
  previous = now;
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// On removal: rig.destroy(); assets.dispose(); renderer.dispose();
```

## Non-negotiables

- **The application owns the render loop and `WebGLRenderer`.** Pass `{ renderer }`
  (`Three.WebGLRenderer`, WebGL2) to `new ThreeRig(assets, { renderer })` and
  call `rig.update(dt)` (or `rig.advance(dt)`, in seconds) before
  `renderer.render(scene, camera)`; `WebGPURenderer` is not supported —
  [README.md](https://github.com/rig-c/adapters/blob/main/packages/three/README.md#live-object).
- **World bounds are Y-up in rig-local space.** `ThreeRig` is a `Group` that can
  be translated, rotated and scaled under an orthographic or perspective camera;
  use the `Group`'s `renderOrder` to order separate flat rigs in overlapping
  scenes —
  [README.md](https://github.com/rig-c/adapters/blob/main/packages/three/README.md#native-drawing-and-scene-placement).
- **Clips are shader polygons bounded by `MAX_TEXTURE_SIZE`.** A clip polygon
  with more vertices than the renderer's `MAX_TEXTURE_SIZE` is refused as
  `THREE_CLIP_CAPACITY` before any scene or resource change, and malformed,
  crossing, zero-area or conflicting-`pma` inputs are refused by slot/page name —
  [README.md](https://github.com/rig-c/adapters/blob/main/packages/three/README.md#native-drawing-and-scene-placement).
- **Destroy every `ThreeRig` before `assets.dispose()`.** `rig.destroy()` is
  idempotent and frees only that rig's meshes, geometries, materials, clip
  textures and shared page-texture references; it never disposes the
  application's `WebGLRenderer` or `ModelAssets`.

## What this will not do

- Run on `WebGPURenderer` or rasterize the rig into an offscreen 2D canvas.
- Apply Three.js scene lights or tone mapping to the rig's shader (it matches
  `@rig-c/play`'s premultiplied two-colour expression and blend factors).
- Play on a plain DOM page without Three.js (use `rig-play`) or inside PixiJS /
  Phaser (use `rig-pixi` or `rig-phaser`).
- Compile, gate or retarget a rig (use `rigc`, `rig-parts` or `rig-pose`).

## Read, in this order

1. `node_modules/@rig-c/three/README.md` ([on GitHub](https://github.com/rig-c/adapters/blob/main/packages/three/README.md)) —
   `ThreeRig`, `ThreeRenderer`, `resourceCounts()`, shared page textures, depth
   and `renderOrder`, shader blend/tint rules and `THREE_CLIP_CAPACITY`.
2. `node_modules/@rig-c/three/dist/index.d.ts` — the exact exported types and
   options matching the installed version.
3. [@rig-c/play's REFERENCE.md](https://github.com/rig-c/play/blob/main/docs/REFERENCE.md) —
   the underlying `loadModel`, `RigPlayer`, `LiveFrame` and `PosedFrame`
   contracts.
