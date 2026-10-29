# rig-c adapters

Adapters for rig-c: a rig that rig-c built, playing inside the engine or renderer your
game already uses.

**Status: PixiJS, Phaser and Three.js adapters released; 0.x APIs.**

| Package | Status |
| --- | --- |
| `@rig-c/pixi` | [Released on npm](https://www.npmjs.com/package/@rig-c/pixi), PixiJS 8 adapter; 0.x API |
| `@rig-c/phaser` | [Released on npm](https://www.npmjs.com/package/@rig-c/phaser), Phaser 4.2+ (`PhaserRig`, `PhaserRenderer`, shared page textures); 0.x API |
| `@rig-c/three` | [Released on npm](https://www.npmjs.com/package/@rig-c/three), native Three.js 0.186.1 renderer and live Group; 0.x API |
| Native engine bridges | Planned |

Each host is independently versioned in `packages/<host>`. The private shared
workspace is bundled into host libraries and is never published. One manifest
release pipeline discovers every host; no engine is added merely by listing it.

## PixiJS usage

```sh
npm install @rig-c/pixi pixi.js @rig-c/play
```

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
// On removal: app.stage.removeChild(rig); rig.destroy();
```

The model document and image pages come from `rigc build`, unmodified. Choose an
animation name present in the model. `PixiRig` is a Pixi Container and owns its
player/renderer resources; `PixiRenderer` is available when you own the player.
Both `@rig-c/pixi` and `@rig-c/pixi/pixi` provide the same typed public exports.

## Phaser usage

```sh
npm install @rig-c/phaser phaser @rig-c/play
```

```ts
import { loadModel } from '@rig-c/play';
import { PhaserRig } from '@rig-c/phaser';

const assets = await loadModel({
  modelUrl: '/rigs/walk/skeleton.model.json',
  regions: 'none',
});
const rig = new PhaserRig(scene, assets);
rig.setPosition(400, 480);
rig.play('walk');
scene.add.existing(rig);
// On removal: rig.destroy(); assets.dispose();
```

`PhaserRig` is a Phaser Container owning its player/renderer resources while
sharing reference-counted GPU page textures across instances over one
`ModelAssets` load (`/?host=phaser` in the root demo); `PhaserRenderer` is
available when you own the player.

`bun run example:look` opens [`examples/look/`](examples/look/index.html), a
1080p pointer-follow page with PixiJS, Phaser and Three.js host links. Its
[reusable example-side helper](examples/look/README.md) normalizes pointers,
reads dial ranges from compiled slider constraints and applies the exact
critically damped omega 20 spring. Callers supply dial bone names; missing or
unsupported sliders refuse by name. Eyes follow immediately, head/body follow
on the spring, roll retains its existing mapping, and idle blink/breath plus
the calibrated global hair impulse remain in the example. The public slider
fixture is used today; refresh against the first released public depth rig is
pending that released input.

`bun install`, `bun run dev` runs the root demo; the [Three.js demo](three-demo.html)
provides orthographic and perspective scenes. `bun run verify` builds every
public library, checks tarballs/release discovery and installed smoke, then runs
the existing chromium + webkit parity suite. Public fixture recipes are built by
root `scripts/fetch-assets.sh` and shared comparison helpers live in
`packages/shared`. See [adding a host](docs/ADDING_A_HOST.md) for workspace/release
steps and the owner-only first-publish procedure for new hosts. Automated
publication is guarded by the owner-controlled `ADAPTERS_PUBLISH_ENABLED` gate. It
uses npm trusted publishing without an npm token secret; enabled
execution missing GitHub Actions OIDC context fails by name before invoking npm.


## Why this exists

rig-c compiles a rig into two things side by side: Spine 4.3 skeleton data, and its own
**model document** (`skeleton.model.json`). Alongside the adapters, a rig reaches a game in two other ways:

- **@rig-c/play** plays the model document in a web page, as DOM elements or one canvas.
  No Spine runtime is involved.
- **An official Spine runtime** (Unity, Godot, Unreal, Phaser, PixiJS…) loads the Spine
  skeleton data. That works today, and it brings the Spine Runtimes licence with it (see
  [rig-c's NOTICE](https://github.com/rig-c/core/blob/main/NOTICE.md)).

An adapter adds a third way: rig-c's own poser running **inside an engine's scene graph
and renderer**, reading the model document, with no Spine runtime. It is also the road
for the day the model document carries something Spine data cannot. The model document
is already the source, and Spine is one export of it.

## Scope, in order

1. **On the web first.** The adapter wraps @rig-c/play's poser and draws through
   the host's own renderer. These hosts are not all engines, and that matters for
   what an adapter must bring:
   - **Phaser**: a 2D game engine (scenes, input, physics, audio, loader).
   - **PixiJS**: a 2D renderer; games and engines are built on top of it.
   - **Three.js**: a 3D renderer, not a game engine. It is for 2D characters
     inside 3D scenes and interactive pages.

   **PixiJS came first** (decided 2026-10-15): it is a renderer, so the adapter touches
   the smallest surface (display object, ticker, texture, mesh), and Phaser now has a native renderer on its own WebGL engine.
2. **Native engines later** (Godot, Unity, …). These need the poser in the engine's
   language, so they come after the web adapters prove the model document is enough.

## What an adapter promises

- It plays what @rig-c/play plays: the same pose for the same time, held to the player's
  output by a test, as the player holds itself to the rig-c core.
- It loads the files `rigc build` writes, unmodified.
- It links no Spine runtime.

## Licence

MIT, like the rest of the rig-c tools.
