# rig-c adapters

Game-engine adapters for rig-c: a rig that rig-c built, playing inside the engine your
game already uses.

> **Status: planned, not started.** Work begins once the toolchain (rig-c, @rig-c/parts,
> @rig-c/pose, @rig-c/play) is stable. Nothing here is published yet.

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

1. **Web engines first.** The adapter wraps @rig-c/play's core poser and draws through
   the engine's own renderer. Candidates: PixiJS, Phaser, Three.js. The first is picked
   by measurement before any code: how many games use each, and how much of the engine
   the adapter has to touch (display object, ticker, texture and mesh API).
2. **Native engines later** (Godot, Unity, …). These need the poser in the engine's
   language, so they come after the web adapters prove the model document is enough.

## What an adapter promises

- It plays what @rig-c/play plays: the same pose for the same time, held to the player's
  output by a test, as the player holds itself to the rig-c core.
- It loads the files `rigc build` writes, unmodified.
- It links no Spine runtime.

## Licence

MIT, like the rest of the rig-c tools.
