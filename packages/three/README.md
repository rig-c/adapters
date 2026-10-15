# @rig-c/three

Draw a rig-c model in a native Three.js scene through `@rig-c/play`. `ThreeRig`
is a flat `Group`: each drawn slot is a `Mesh` with native float32 geometry,
with one shared shader material per page per instance. It poses no bones itself.

## Install

```sh
npm install @rig-c/three three @rig-c/play
npm install --save-dev @types/three
```

## Minimal usage

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

Use the model document and image pages from `rigc build`, unchanged. Tested with
Three.js **0.186.1** and play **1.10.0**. The API is 0.x. See [`packages/three` in the repository](https://github.com/rig-c/adapters/tree/main/packages/three) for source and parity tests.

## Live object

`play(name, options)`, `seek(seconds)`, `advance(dt)` and `update(dt)` forward to
an independent `RigPlayer`; deltas are seconds, and the player's `timescale`
(alias `timeScale`) applies exactly once. The app owns the loop. `timescale = 0`
holds the drawn frame and uploads no geometry. `drawnFrame()` is the exact record
passed to the native renderer; `posedFrame(filter)`, `bone(name)` and `bounds()`
use play's readers. World bounds are in rig-local Y-up space, before this Group's
transform. `resourceCounts()` reports owned meshes, geometries, page materials,
clip textures and retained/shared pages. `destroy()` is idempotent and frees
only this object's resources; it neither destroys the application renderer nor
modifies another rig. Dispose the shared ModelAssets after all players using it
are destroyed; the adapter does not own the load's blob URLs. Mutating playback after destroy is refused.

Several rigs can share one `ModelAssets` load. Page textures are shared by image
identity until the last renderer releases them; instance geometry, clip data and
material uniforms remain separate. A page image cannot simultaneously declare
both straight and premultiplied pixels: conflicting `pma` records are refused.

## Native drawing and scene placement

`ThreeRenderer(root, assets, webglRenderer)` is available when the app owns the
player. Call `render(player.posedFrame())`, then render the scene normally.
No internal canvas, offscreen bitmap of the rig, or fallback renderer draws it.
Positions and page UVs come directly from the record; the full atlas page is
sampled, so packed rotation needs no separate rule. The root stays Y-up and may
be translated, rotated and scaled under an orthographic or perspective camera.
Use the Group's `renderOrder` to order separate flat rigs in overlapping scenes;
slot meshes have explicit internal draw order. Materials retain depth testing
for ordinary 3D occlusion and disable depth writing for translucent slots. They
are double-sided with a single draw pass. The adapter changes no global camera,
renderer colour space, sorting, depth or stencil state.

The shader matches play's premultiplied two-colour expression and explicit
Normal/Additive/Multiply/Screen RGB and alpha blend factors, without lighting,
tone mapping or an extra colour-space conversion. Straight pages are multiplied
once on upload; already-PMA pages are not. Texture UV orientation, linear
filtering and mipmap policy are explicit.

Clips are hard shader polygons in the same local plane as the geometry. Ordinary
concave polygons retain their shape; `convex: true` and inverse clips use the
convex hull, matching play's canvas reader. Per-slot point data is a float
DataTexture, never an array truncated to a guessed uniform limit. A clip with
more vertices than the actual renderer's `MAX_TEXTURE_SIZE` is refused as
`THREE_CLIP_CAPACITY` before any scene/resource change; malformed, crossing or
zero-area polygons are refused by slot and page as well. This is a WebGL2 host;
`WebGPURenderer` is not this package's renderer.

Geometry upload counters expose position, UV and triangle updates. Native
resources are reused when their arrays remain unchanged. Capacity changes dispose
the old geometry before replacing its attributes. The diagnostics
`alwaysReuploadGeometry` and `releasePageTexturesOnDispose` exist for planted
negative controls; keep their normal values `false` and `true` respectively.

## Demo and verification

From the repository, `bun run dev` serves `/three-demo.html`, including a flat
object in a perspective scene. Query parameters: `?rig=walk&anim=walk&time=0.5&timescale=0&count=3&view=perspective`.
The default camera is orthographic; paused queries permit deterministic capture.

`bun run verify` discovers this host without workflow changes. It checks native
float storage and transformed geometry, same-browser CanvasRenderer pictures,
planted picture faults, exact pose parity, fixed updates, native held uploads,
shared page lifetime, buffer deletion, package contents and installed exports.
The release pipeline registers this package independently of the other hosts.
