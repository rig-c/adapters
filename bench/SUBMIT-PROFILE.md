# Pixi submit profile

`bun scripts/profile-pixi-submit.mjs --precheck` validates the diagnostic
reader and two attribution controls. `bun scripts/profile-pixi-submit.mjs`
records 100-instance spineboy and raptor profiles. Run timed commands through
the shared Nova runner with exclusive admission. The diagnostic expects a
frozen install, built libraries, Chromium and `bun run fetch-assets` first.

The underlying same-frame harness is #58 at
`0880a6404e62ec03fba158124eb7b5abdc5f013e`. Both arms draw in one frame,
AB/BA alternates, and the existing per-half pixel checks and draw-call limits
remain active. The diagnostic changes the browser's served benchmark module
through a Playwright route; it does not patch dependencies or product code.
It refuses unless the actual transformed rig draw-loop boundary matches once.

The split is measured with three clocks per rig-arm submission, not clocks
per slot:

- `adapterMs`: all instances' `PixiRenderer.render(frame)` calls, including
  validation, coordinate comparisons, scene-object updates and buffer updates.
- `hostMs`: the enclosing Pixi `WebGLRenderer.render` call, including scene
  traversal, transforms, batch packing, uploads and driver submission.
- `residual`: same-frame submit minus these two intervals, including scissor
  and timer-query bookkeeping and the profiling array write.

Neither interval measures CPU process time: both are wall time at CPU call
boundaries and can include driver back-pressure. The whole host interval is
an upper bound on removable scene-object cost, not an estimate of savings.

The precheck plants a 4 ms delay separately inside each split. Its targeted
median must increase by at least 3 ms while the other median changes by no
more than 1 ms. It also exercises the sampling reader. A missing split,
missing sampling boundary, pixel failure or draw-call failure refuses.

Uninstrumented, split-clock and sampled runs are separate. Report their
spread and instrumentation shift rather than accepting an instrumented run
as a speedup. The CDP sampler starts after warmup and stops after the measured
frame loop. Sample ancestry distinguishes adapter calls, Pixi traversal or
transforms, renderable updates (including packing), other host work, and
other samples (including pose, GC and completion waits). Sampling is
statistical; function attribution is not a removal experiment. Samples from
`gl.finish` must not be called scene-object overhead.

Raw records and CDP profiles are written under
`test-results/submit-profile/`. Preserve separate copies for independent
invocations. They describe the actual Nova browser/GPU reported in each
record, and do not establish performance on another machine. This diagnostic
has no candidate renderer and makes no before/after optimization claim.

## Recorded diagnostic result (#57)

Capture command: `python3 scripts/verify-nova.py --submit-profile`, through
Nova exclusive, exit 0. Receipt:
`20261026T075734Z-98b555edea7945b5b841a02625234bc4`.
Captured input SHA-256:
`96ad933b15ac5d6457d35ee16b9f2bc7819fd6060a4bb5a893b73ec2f4957088`.
This identifies the capture tree, before the offline attribution-reader fix.
The capture used Chromium 151 on ANGLE SwiftShader, four CPU affinity and
peak process-tree RSS 1,649,381,376 bytes under the existing 4 GiB guard.
These are software-renderer diagnostics, not native GPU performance.

Each invocation measured 100 instances, 60 warmup and 76 measured frames.
All rig frames used one draw call; all shared-half pixel checks passed.
Times below are milliseconds. Spread means p95 minus p05.

| Rig | Invocation | Submit p50 / p95 / spread | Adapter loop p50 / p95 | Pixi host p50 / p95 |
| --- | ---: | --- | --- | --- |
| spineboy | 1 | 1.500 / 2.235 / 1.075 | 0.895 / 1.295 | 0.575 / 0.715 |
| spineboy | 2 | 1.515 / 2.150 / 0.980 | 0.915 / 1.390 | 0.570 / 0.795 |
| raptor | 1 | 2.945 / 17.350 / 14.685 | 1.710 / 11.380 | 1.205 / 10.770 |
| raptor | 2 | 3.050 / 15.160 / 12.465 | 1.780 / 8.090 | 1.185 / 10.855 |

Independent-invocation submit median shifts were +1.00% and +3.57%, but
split versus uninstrumented median shifts ranged from -13.18% to +5.35%.
This does not demonstrate negligible instrumentation cost or an optimization.
The raptor tails are particularly noisy.

The initial sampler classification incorrectly expected a dependency filename
to contain `pixi`; Vite emits opaque chunk names. Raw CDP samples remain valid.
The corrected reader derives rig `drawAll` identity from the adapter's call
ancestry and excludes the official arm. Reproduce the corrected report with:

```sh
node scripts/report-pixi-submit.mjs <verification-output-directory>
bun test scripts/submit-profile-reader.test.mjs
```

Both commands exited 0; the targeted reader suite emitted `3 pass`, `0 fail`,
`4 expect() calls`. Controls cover opaque chunk attribution, official-arm
exclusion, missing adapter ancestry and invalid sample durations. The corrected
reader was tested against the sealed raw profiles without repeating the timed
capture. The final reader is newer than the captured input hash.

Direct transform self samples were 0.118 / 0.109 ms per frame for spineboy
and 0.223 / 0.220 ms for raptor. The broader inclusive traversal, validation
and transform category was 0.308 / 0.320 ms and 0.684 / 0.694 ms respectively;
it includes necessary packing, so it is only a generous envelope. These are
sampled attributions, not measured savings from removing objects.

Disposition: #57 was closed; the small transform target folds into #56,
where a batchable and direct buffer writes can be measured together. No
product renderer was changed. No before/after speedup is claimed. The parts
rig and example-specific performance runs were outside the profile-only
redirect and were not measured.
