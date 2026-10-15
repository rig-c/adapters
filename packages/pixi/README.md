# @rig-c/pixi

PixiJS 8 adapter for rig-c model documents, posed through @rig-c/play. MIT.
No Spine runtime. The 0.x API may change before 1.0.

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
API and owns the renderer's resources. `PixiRenderer` draws a supplied PosedFrame
when you need to own the player separately. Both `@rig-c/pixi` and
`@rig-c/pixi/pixi` export the same implementation, with TypeScript declarations.

Keep `skeleton.model.json` and the image pages emitted by `rigc build` together.
See [`packages/pixi` in the repository](https://github.com/rig-c/adapters/tree/main/packages/pixi) for the demo, parity tests
and adding another host.
