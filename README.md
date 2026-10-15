# rig-c adapters

Adapters for rig-c: a rig that rig-c built, playing inside the engine or renderer your
game already uses.

**Status: PixiJS 0.1.0 published; automated publication remains owner-gated.**

| Package | Status |
| --- | --- |
| `@rig-c/pixi` | [0.1.0 released](https://github.com/rig-c/adapters/releases/tag/pixi-v0.1.0), PixiJS 8 adapter; 0.x API |
| `@rig-c/phaser` | Native region/mesh renderer prepared for Phaser 4.2+; first release follows the live-scene card |
| `@rig-c/three` | Planned |
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

`bun install`, `bun run dev` runs the root demo; `bun run verify` builds every
public library, checks tarballs/release discovery and installed smoke, then runs
the existing chromium + webkit parity suite. Public fixture recipes are built by
root `scripts/fetch-assets.sh` and shared comparison helpers live in
`packages/shared`. See [adding a host](docs/ADDING_A_HOST.md) for workspace/release
steps and the owner-only first-publish procedure for new hosts. Automated
publication is disabled behind the owner-controlled `ADAPTERS_PUBLISH_ENABLED` gate. It
uses npm trusted publishing without an npm token secret; enabled
execution missing GitHub Actions OIDC context fails by name before invoking npm.


## Why this exists

rig-c compiles a rig into two things side by side: Spine 4.3 skeleton data, and its own
**model document** (`skeleton.model.json`). Today a rig reaches a game in one of two ways:

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

1. **On the web first.** The adapter wraps @rig-c/play's core poser and draws through
   the host's own renderer. The candidates are not all engines, and that matters for
   what an adapter must bring:
   - **Phaser**: a 2D game engine (scenes, input, physics, audio, loader).
   - **PixiJS**: a 2D renderer; games and engines are built on top of it.
   - **Three.js**: a 3D renderer, not a game engine. It would be for 2D characters
     inside 3D scenes and interactive pages.

   **PixiJS is first** (decided 2026-10-15): it is a renderer, so the adapter touches
   the smallest surface (display object, ticker, texture, mesh), and Phaser follows with a native renderer on its own WebGL engine.
2. **Native engines later** (Godot, Unity, …). These need the poser in the engine's
   language, so they come after the web adapters prove the model document is enough.

## What an adapter promises

- It plays what @rig-c/play plays: the same pose for the same time, held to the player's
  output by a test, as the player holds itself to the rig-c core.
- It loads the files `rigc build` writes, unmodified.
- It links no Spine runtime.

## Licence

MIT, like the rest of the rig-c tools.
