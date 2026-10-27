# @rig-c/pixi

PixiJS 8 adapter for rig-c model documents, posed through @rig-c/play. MIT.
No Spine runtime. The 0.x API may change before 1.0.
Requires `@rig-c/play >=1.20.0 <2` for its public live-frame contract.

## Install

```sh
npm install @rig-c/pixi pixi.js @rig-c/play
```

## Minimal usage

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
// On removal: app.stage.removeChild(rig); rig.destroy(); assets.dispose();
```

Use the animation name present in your model document. `PixiRig` is a Pixi
`Container`; it exposes the player's play/queue/seek/skin, events, bone and bounds
API and owns the renderer's resources. `PixiRenderer` draws a supplied `PosedFrame`
or `LiveFrame`
when you need to own the player separately. Both `@rig-c/pixi` and
`@rig-c/pixi/pixi` export the same implementation, with TypeScript declarations.

`advance()` and ticker updates consume the player's lease synchronously and
update existing Pixi geometry buffers by index. `liveFrameChecks` forwards to
play; leave it omitted for the development diagnostic default, or explicitly
set `false` when measuring production. `poser: 'oracle'` selects the reference
poser. Clipping, dark tint, blend, page alpha mode and draw order are preserved.

`draw()` still returns a detached `PosedFrame`; `drawnFrame()` returns the last
draw, including after direct mutations of `rig.player`. Runtime updates retain
the last drawn numbers in reusable Float64 buffers and materialize the record
only when requested. The first occurrence of a runtime attachment obtains a
real snapshot for metadata absent from the lease (`z` and mesh `sequence`).
Steady updates of known attachments do not request snapshots. The oracle path
keeps its snapshot fallback; no allocation-free claim covers that path.

For separately timed pose and draw stages, advance `rig.player`, acquire its
current `liveFrame()`, then call `rig.renderFrame(frame)` before any further
player mutation. This includes the cost of preserving the last-drawn values.

Keep `skeleton.model.json` and the image pages emitted by `rigc build` together.
See [`packages/pixi` in the repository](https://github.com/rig-c/adapters/tree/main/packages/pixi) for the demo, parity tests
and adding another host.
