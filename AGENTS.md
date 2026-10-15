# Working in this repository

Guidance for any AI agent working here — in an IDE, a CLI, or as a squad. The
repository is public; so is everything written to it.

## What this is

An adapter plays a rig that `rigc build` wrote inside a host renderer or engine,
through `@rig-c/play`'s core, with no Spine runtime. The first host is **PixiJS**
(a renderer, the smallest surface to touch); Phaser comes next with its own WebGL renderer.
Issues carry the work: each one states the decision, why, the bars it is held
to, and what is out of scope. An issue is the whole brief — nothing agreed in a
conversation counts until it is written there.

## The oracle is `@rig-c/play`

`@rig-c/play` poses the rig through `rig-c/core` and hands the renderer a plain
record, `PosedFrame` — every slot that draws, in draw order, with world-space
corners or mesh vertices (Y up), page UVs, tint, blend, and clip polygon. Its
README (*Drawing your own frames*, *Reading the pose*) documents it, and its
`DomRenderer` and `CanvasRenderer` are two renderers of that record. An adapter
here is a third: it loads with `loadModel`, poses with `RigPlayer`, and draws
`player.posedFrame()` through the host. So what an adapter has to prove is the
**drawing**, not the pose:

- every slot it draws sits where the record says, in the record's order, with
  the record's tint, blend and clip — read back from the host's scene objects
  and compared at a stated tolerance;
- a picture of the same frame, drawn by the adapter and by play's
  `CanvasRenderer` in the same browser, agrees under play's own shift-tolerant
  comparison (no committed golden images — they rot across GPUs);
- it loads the files `rigc build` writes, unmodified;
- it links no Spine runtime: a test greps the dependency tree and the sources.

Fixtures are rigs built by `rigc build` from public recipes — the gallery rigs
play's demo builds (`walk`, `flex`, `squash`, `portrait`, `nod`, `look`,
`ride`) and play's three test rigs (`figure`, `glow`, `turned`). Nothing
private is used or needed; the private corpus of the rig-c organisation does
not cross into this repository.

## Rules

1. **Do the work yourself.** No sub-agents and no delegation unless the issue
   says so. The name on the work is the agent that did it.
2. **Bars are posted before measuring**, on the issue, and do not move to fit a
   result. A bar that cannot be measured here (an input this repository does not
   have) is reported as *not measurable: <why>*, never as PASS from a stand-in.
3. **Numbers come from command output.** Every figure in a report has the
   command beside it. "Done" and "passes" are a machine's lines, quoted, with
   the exit code; an empty output is written `(empty)`.
4. **Refuse by name.** When an input is wrong, the adapter says which object,
   what it found, what it needed — the way `rigc` and `@rig-c/play` do. No
   silent fallback, no default guessed from the data.
5. **Every gate has a mutant.** A test that nobody has seen fail is not a test;
   a check whose data is absent reports SKIP, not PASS.
6. **No `any`** in sources. TypeScript, ESM. Bun for scripts and tests;
   Playwright for anything that needs a browser, in the way play's tests do.
7. **Report on the issue** that carried the work: the bar table (measured
   values, verdicts), what changed and why, what in the issue you refuted and
   with what measurement, and what you could not do. A pull request carries
   the argument and the measurement, not a summary of the diff.
8. **Keep the attempts bounded.** Four tries on one bar without movement is a
   STOP: write what blocked you on the issue and stop. Nothing here needs a
   guess to proceed.
9. **Public surface.** English in code, commits (Conventional Commits) and
   issues. No private data, no paths outside this repository, no model or
   session names in the tree.

## Code review rules

A reviewer reads a pull request for: a bar the PR claims without the command
that produced it; a tolerance chosen after the measurement; a fixture that is
not a public recipe; a Spine import; a test that cannot fail; a `PosedFrame`
field the adapter ignores without saying so (clip, dark colour, blend, pma).
