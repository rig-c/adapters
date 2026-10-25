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
boundary: the final timestamp immediately follows drawing, and a final
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

The known [#43](https://github.com/rig-c/adapters/issues/43) defects remain:
`--check-repro` interleaves frames and uses a denominator floor, and cold-load
measurement fetches the model twice. Its output is not independent-repeatability
evidence. Use separate full benchmark commands and true relative p50 differences
with no floor for the #50 gate. Browser contract tests and software-GPU CI verify
ordering/correctness; only a recorded M4/ANGLE Metal run can establish the target
machine baseline. Do not refresh historical tables with a different protocol.

`bun run test:bench` traces actual WebGL drawing and completion calls around the
measurement timestamps for both arms and both collection paths. Missing and
batch-only finish mutants are applied to served modules without modifying source
files. These traces establish the wall-clock boundary; they do not time the GPU.
