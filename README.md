# rig-c adapters

Adapters for rig-c: a rig that rig-c built, playing inside the engine or renderer your
game already uses.

> **Status: pilot, not published.** A PixiJS adapter is being built against
> `@rig-c/play` 1.10 as the first host (issues #1–#3). The toolchain is still
> moving, so nothing is published and the API here is not stable. `AGENTS.md`
> says how work is done in this repository.

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
   the smallest surface (display object, ticker, texture, mesh), and Phaser is built
   on it, so the Phaser adapter is the next step rather than a second start.
2. **Native engines later** (Godot, Unity, …). These need the poser in the engine's
   language, so they come after the web adapters prove the model document is enough.

## What an adapter promises

- It plays what @rig-c/play plays: the same pose for the same time, held to the player's
  output by a test, as the player holds itself to the rig-c core.
- It loads the files `rigc build` writes, unmodified.
- It links no Spine runtime.

## Licence

MIT, like the rest of the rig-c tools.
