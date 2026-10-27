# Benchmark timing protocols

`bun run bench` defaults to **gpu-complete-v2**. Each measured frame is:

```
t0 -> poseAll(dt) -> t1 -> drawAll() -> gl.finish() -> t2
```

Pose = `t1 - t0`; draw/completion = `t2 - t1`; frame = `t2 - t0`.
Both arms share this boundary. Pending warm-up work is drained before sampling.
This measures CPU wall time through GPU completion, including driver blocking.
It does not isolate GPU execution, presentation latency, throughput or FPS.
Pose and draw medians need not add up to the frame median.

Use `bun run bench -- --timing-protocol cpu-submit-v1` for the historical
boundary (the `--timing-protocol=cpu-submit-v1` spelling is also accepted): the final timestamp immediately follows drawing, and a final
`gl.finish()` drains the collected batches outside all samples. CPU work and
render submission can include driver back-pressure. The historical
[RESULTS.md](RESULTS.md) numbers belong to this series and remain unchanged.

JSON reports and frame rows carry `timingProtocol`. Generated Markdown describes
the boundary and omits historical timing comparisons for v2. Missing or mixed
row protocols and unknown CLI protocol names are refused by name. A v2-v1
wall-time difference cannot establish a runtime speedup. Compare only matching
protocols, fixture hashes, dependency versions, browser/GPU, workloads and
recorded host conditions. Retaining the v1 boundary does not make different
machines, dependency versions or desktop loads equivalent.

The remaining [#43](https://github.com/rig-c/adapters/issues/43) defects are
frame-interleaved `--check-repro` sets and the duplicate cold-load model fetch.
The reproducibility helper now uses the true relative delta without a denominator
floor, but the interleaved sets still do not establish independent repeatability.
Browser contract tests and software-GPU CI verify ordering/correctness; target
machine baselines require recorded hardware runs. Do not refresh historical
tables with a different protocol.

`bun run test:bench` traces actual WebGL drawing and completion calls around the
measurement timestamps for both arms and both collection paths. Missing and
batch-only finish mutants are applied to served modules without modifying source
files. These traces establish the wall-clock boundary; they do not time the GPU.

Headless Chromium launches with `--disable-renderer-backgrounding`,
`--disable-background-timer-throttling`, and
`--disable-backgrounding-occluded-windows` (`BENCH_CHROMIUM_ARGS`, recorded in
`report.machine.chromiumArgs`). For each `skeleton × instance` row, Pass 1
interleaves the two arms' measured runs (`A, B, A, B, …`) and records each arm's
per-run `p50` series in order (`runP50sMs`) alongside per-pair differences in
`report.pairedFrameTable` (`pairDiffsMs`, `pairRelDiffs`, `pairRatios`). Pass
`--compare-bundle <path>` to measure a candidate `@rig-c/play` package/bundle
or a module exporting `{ loadModel, PixiRig }` (`rig-c-pixi-compare`)
AB-interleaved against the base `rig-c-pixi` arm in one invocation.

## Same-frame paired mode

`bun run bench -- --same-frame --json` selects `same-frame-ab-v1`. This is
separate from the two historical timing protocols; combining it with
`--timing-protocol` or `--check-repro` refuses by name. `--compare-bundle` still
selects base/candidate; otherwise the official and rig-c arms share one canvas.
The canvas is 1800 × 640: each arm retains the original 900 × 640 workload,
instance count, placement and animation phase. This doubles the total canvas
workload relative to a single-arm run. AB/BA alternates every measured frame.
Each arm submits separately with the other half retained. Correctness compares
each shared half to its isolated rendering at 0, 0.35 and 0.7 seconds under the
existing limits, after the existing official-runtime cross-arm oracle and
negative controls have passed.

Per-frame raw samples retain pose, submit and combined CPU milliseconds for
each arm, draw counts, order, and CPU wall time through one final `gl.finish()`.
There is no per-arm finish. CPU submit includes query instrumentation and driver
back-pressure. Paired differences are signed B minus A; p50/p95, min/max and
p95-minus-p05 spread are reported. No claim of exact noise cancellation follows
from sharing a frame.

Where WebGL2 exposes `EXT_disjoint_timer_query_webgl2`, separate non-overlapping
queries wrap the arms' draws. Results are read asynchronously after availability;
any disjoint observation or five-second result timeout discards all arm GPU
samples for that run. Without the extension, GPU samples and paired GPU summary
are null with a reason. Whole-frame completion remains CPU wall time through GPU
completion, not GPU-only execution time. M4/ANGLE Metal extension availability
must be recorded by an actual target invocation, not inferred from another GPU.

`compareSameFrameReports(first, second)` compares the p50 of raw CPU paired
differences pooled across runs for each workload in two independent reports.
The relative spread is `abs(second - first) / abs(first)` with a fixed 5% limit,
no denominator floor; zero versus zero passes, zero versus nonzero is undefined
and cannot pass. Near-zero differences can be unstable by this definition and
must be reported honestly. The CLI does not turn internal batches into two
independent invocations. Raw GPU paired differences are reported separately;
CPU and GPU differences must not be mixed. The accepted [#66](https://github.com/rig-c/adapters/issues/66)
and [#68](https://github.com/rig-c/adapters/issues/68) protocols use independent,
interleaved launches with paired statistics and recorded load, without reviving
the historical quiet-window gate. Browser correctness tests do not establish
target repeatability or performance acceptance.
