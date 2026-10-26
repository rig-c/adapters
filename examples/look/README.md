# Pointer-driven slider dials

Run `bun install --frozen-lockfile`, then `bun run example:look`. The page offers
PixiJS, Phaser and Three.js links (`?host=pixi`, `?host=phaser`, `?host=three`).
All three use the same pointer controller, idle animation and hair impulse; each
host owns only placement and drawing. `?manual=1` disables the page clock for tests.

## Reuse the helper

[`pointer-dials.ts`](pointer-dials.ts) is example-side TypeScript, not an adapter
package export. Copy it into an application, or import it from this checkout.
Supply the dial bone names that the compiled rig actually declares:

```ts
import { loadModel } from '@rig-c/play';
import { readModel } from 'rig-c/core';
import { PointerDials, readPointerDialBindings, pointerToNormalized } from './pointer-dials.ts';

const modelUrl = '/rig/skeleton.model.json';
const assets = await loadModel({ modelUrl, regions: 'none' });
const response = await fetch(modelUrl);
if (!response.ok) throw new Error(`Model fetch failed: ${response.status}`);
const doc = readModel(await response.text(), modelUrl);
const follow = new PointerDials(readPointerDialBindings(doc, {
  yaw: 'yaw_dial',
  pitch: 'pitch_dial',
  // Optional: roll, body, gazeX and gazeY, each a dial bone name.
}));

// Construct a PixiRig, PhaserRig or ThreeRig with assets, then:
rig.player.adjust = follow.adjust;
canvas.addEventListener('pointermove', event => {
  const { fx, fy } = pointerToNormalized(event.clientX, event.clientY, canvas.getBoundingClientRect());
  follow.setPointer(fx, fy);
});
canvas.addEventListener('pointerleave', () => follow.clearPointer());

// In the application's frame loop, dt is elapsed seconds:
follow.step(dt);
rig.advance(dt);
// Draw the host scene. Dispose the rig before assets.dispose().
```

Read the document through `rig-c/core`'s public `readModel(text, where?)` API.
`ModelAssets.document` is opaque in play's public API; the helper does not unwrap
it. The look page gives `readModel` and `loadModel` the same fetched document
bytes through the public fetch option. No core or player posing behavior changes.

`readPointerDialBindings(doc, names)` requires yaw and pitch; optional axes are
left untouched if omitted. Every requested bone must have exactly one **local,
non-looping** slider constraint with a finite nonzero scale and positive animation
duration. It inverts the compiled time mapping
`time = to + (value - from) * scale` at time zero and the animation duration,
orders the endpoints and freezes the resulting bands. The raw document's `max`
field is not the core's parsed slider range. No guessed angles or direct-bone
fallbacks are supplied. Missing, ambiguous or unsupported sliders throw
`PointerDialRefusal`, naming the axis and bone. The look page catches that refusal,
warns once and displays a static rig.

Client coordinates use the canvas's CSS rectangle: right is +X, up is +Y. Pointer
input is clamped to `[-1, 1]`; nonfinite coordinates and empty rectangles map to
zero. Each dial maps zero to zero clamped into its band, negative input toward
its minimum and positive input toward its maximum. Thus `[-7, 23]` stays
asymmetric; a sign reversal selects the opposite endpoint before mapping.
`PointerDials` accepts optional `{ yaw: -1, pitch: 1 }` directions; the look page's
existing animation-direction probe supplies these for its fixture.

Head yaw/pitch and body use the exact analytical critically damped spring with
omega 20 rad/s. From rest, the step error at 0.30 s is
`(1 + 20 * 0.30) * exp(-20 * 0.30) = 0.0173513`, below the frozen 2% bound.
Roll keeps the existing `-hx * hy` mapping; eyes use the unsmoothed pointer.
`clearPointer()` returns the target to neutral. Apply is a normal public
`BoneAdjust` callback and writes only each slider's declared local channel.
The example retains its calibrated global hair impulse; this helper does not
introduce depth production or change animation posing.

## Checks and input boundary

`bun run test:look` runs reader, refusal, normalization, asymmetric clamp,
channel-write and exact spring controls without a browser. `bun run test -- examples/look/tests/look.spec.ts` runs the actual three host paths in Chromium
and WebKit, including pointer input, pixels and moving pose checks. The normal
repository `bun run verify` includes the helper tests.

The committed public look fixture supplies these tests. Refreshing it against
the first released public depth rig from parts issue #763 is **pending an actual
released input**. Existing slider tests do not establish depth-rig acceptance.
