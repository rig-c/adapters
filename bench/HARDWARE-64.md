# Published-player hardware comparison (#64)

This separate report uses the posted #64 capture schedule and decision statistic; it preserves HARDWARE-62 as the historical result.

The RTX 4070 Ti capture completed the posted interleaved 3/6 protocol. At stage 3, six workload/metric rows met the descriptive gain rule and ten remained unresolved, so the predeclared stopping rule extended to 6. At stage 6, eight met the gain rule (four pose, three combined CPU, one GPU); eight retain the reader's unresolved label. Raptor at 100 instances has repeated positive submission and CPU cost and is called out below, rather than hidden behind that label.

Mac: **not re-captured (admission)**. Its actual browser verified all 18 fixture hashes, but the existing local runner refused the capture before launching a browser because memory pressure was 2. Mac recapture was explicitly not a bar. No new Mac timing result is claimed; HARDWARE-62 is unchanged. The old public Mac/Windows runners still schedule 2/2 and cannot produce this v2 capture; the reviewed private scheduler performed it.

## Frozen source, device and checks

Merged source `78e696b41fc07552a4861dde84cd8c85148cb8c4`. CI attempt 2 succeeded on the identical source tree; all 137 tracked local files matched the GitHub blobs. [CI evidence](https://github.com/rig-c/adapters/actions/runs/40432678142/attempts/2).

The source-bound controller records **NVIDIA GeForce RTX 4070 Ti**, driver **32.0.16.1088**, Chromium **155.0.8059.80**. Full renderer: `ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti (0x00002782) Direct3D11 vs_5_0 ps_5_0, D3D11)`. Adapter identity was natively re-enumerated and explicitly pinned for every fresh launch; the private renderer gate ran after all 18 fixture hashes and before controls/timing. Private engine/process observations were recorded before each launch for both adapters. **No quiet or idle claim** is made; process identities remain private.

The unchanged per-frame pairing implementation was rebuilt from the merged source with published players 1.17.1 and 1.18.0. This is a package comparison through the legacy snapshot adapter, not a core-only causal experiment. It does not measure a direct-buffer renderer, presentation/input-to-present latency or FPS. Wind-wave remains withdrawn.

Commands (remote preparation; private interactive Windows task; frozen reader copies):

```sh
bun scripts/hardware-bench.mjs --out test-results/phase2-merged
node windows-runner.cjs --execute --config run-config-capture.json
node reader/summarize-hardware-bench.mjs <private-capture-directory>
```

Preparation and the interactive task exited 0. Stage 3 reader checked 4320 paired frames and 144 half-image checks; stage 6 checked 8640 and 288. Original per-arm positive/mutant completeness, draw-call mutants/caps, half-image checks, frame/order checks and measured fixture maps were required. All 13 fresh launches (precheck plus 12 measurement launches) have complete owned-process cleanup records. A final bounded collection recovered all 34 files with matching SHA-256. The frozen reader replayed the recovered raw receipts with exit 0 at both stages and reproduced every original JSON value and original command output. Stage snapshots add a terminal LF; the original files and their distinct hashes are retained. An independent native audit found no surviving tracked browser identity, verified both in-process server-close events and Ready/result 0 tasks, and then removed only 14 owned profiles and 2 owned tasks. The compressed read bundle was persisted and hash-verified before cleanup, and every evidence hash was unchanged afterward.

## Predeclared schedule and decision

[Posted protocol](https://github.com/rig-c/adapters/issues/64#issuecomment-6431719313): AA1 AB1 AA2 AB2 AA3 AB3, 60 warmup and 180 measured paired frames per original workload. Any unresolved finite CI or mixed AB signs at 3 triggers AA4 AB4 AA5 AB5 AA6 AB6; unmeasured GPU alone does not. The initial stage remains immutable and 6 is the cap. No capture retry was made after connectivity was lost.

Each launch contributes its paired median. AA and AB mean ± t(.975,n−1)×sampleSD/√n are computed separately with sample variance denominator n−1. Gain requires AB upper<0, AB upper<AA lower and every AB launch median<0. The legacy max-absolute-AA-p05/p95 envelope is a comparison column only. Intervals are nominal descriptive 95%; adaptive looks and multiple comparisons have no guaranteed sequential/family-wise coverage.

The per-frame pairing identifier remains `hardware-same-frame-v1`; the capture identifier is `hardware-interleaved-ci-v2` and the decision identifier is `hardware-launch-median-t95-v1`. The schedule and decision supersede #62; its workloads, per-launch controls and exclusions are preserved.

## Stage 3 and stage 6 intervals

All numbers below are milliseconds, rounded to 9 decimals. Machine verdicts are preserved: G=gain under the posted rule; U=the reader's unresolved label. The positive-cost observations following the tables are additional explicit observations, not rewritten verdicts.

### Stage 3

| Workload | Metric | AA mean [lower, upper] | AB mean [lower, upper] | Legacy AA envelope | Verdict |
|---|---|---|---|---:|---|
| spineboy/1 | poseMs | 0.004999995 [-0.007420681, 0.017420672] | -0.041666706 [-0.048837873, -0.034495540] | 0.054999948 | G |
| spineboy/1 | submitMs | 0.000000000 [0.000000000, 0.000000000] | 0.000000000 [0.000000000, 0.000000000] | 0.029999971 | U |
| spineboy/1 | cpuMs | 0.003333370 [-0.003837797, 0.010504536] | -0.046666662 [-0.053837657, -0.039495666] | 0.065000057 | G |
| spineboy/1 | gpuMs | 0.000362667 [-0.001062296, 0.001787629] | -0.002144000 [-0.008611283, 0.004323283] | 0.007168000 | U |
| spineboy/100 | poseMs | 0.141666691 [-0.018040760, 0.301374141] | -2.393333356 [-2.717542813, -2.069123898] | 2.160000086 | G |
| spineboy/100 | submitMs | -0.151666681 [-0.210364624, -0.092968738] | -0.008333325 [-0.152291952, 0.135625301] | 0.605000019 | U |
| spineboy/100 | cpuMs | -0.074999968 [-0.314883241, 0.164883305] | -2.355000019 [-2.783648648, -1.926351390] | 2.375000000 | G |
| spineboy/100 | gpuMs | 0.004778667 [0.000893014, 0.008664320] | 0.003413333 [0.001944695, 0.004881972] | 1.085440000 | U |
| raptor/1 | poseMs | 0.009999990 [0.009999990, 0.009999990] | -0.018333316 [-0.025504397, -0.011162235] | 0.159999967 | G |
| raptor/1 | submitMs | 0.000000000 [0.000000000, 0.000000000] | 0.000000000 [0.000000000, 0.000000000] | 0.045000076 | U |
| raptor/1 | cpuMs | 0.010000030 [-0.002420647, 0.022420707] | -0.018333316 [-0.025504397, -0.011162235] | 0.179999948 | G |
| raptor/1 | gpuMs | -0.018773333 [-0.105310935, 0.067764268] | -0.028330667 [-0.104657508, 0.047996175] | 0.072704000 | U |
| raptor/100 | poseMs | 0.169999997 [-0.188052154, 0.528052148] | -0.171666662 [-0.498482471, 0.155149147] | 2.184999943 | U |
| raptor/100 | submitMs | 0.098333359 [0.039635593, 0.157031124] | 0.723333279 [0.557931227, 0.888735332] | 0.784999967 | U |
| raptor/100 | cpuMs | 0.258333286 [-0.108935874, 0.625602445] | 0.518333356 [0.156140174, 0.880526537] | 2.404999971 | U |
| raptor/100 | gpuMs | -0.022869333 [-0.044050343, -0.001688323] | -0.026282667 [-0.218909636, 0.166344303] | 1.156096000 | U |

### Stage 6

| Workload | Metric | AA mean [lower, upper] | AB mean [lower, upper] | Legacy AA envelope | Verdict |
|---|---|---|---|---:|---|
| spineboy/1 | poseMs | 0.005833328 [0.001883399, 0.009783256] | -0.040000061 [-0.043318665, -0.036681457] | 0.060000062 | G |
| spineboy/1 | submitMs | 0.000000000 [0.000000000, 0.000000000] | 0.000000000 [0.000000000, 0.000000000] | 0.034999967 | U |
| spineboy/1 | cpuMs | 0.004166663 [0.002024513, 0.006308812] | -0.044166664 [-0.050300811, -0.038032517] | 0.084999919 | G |
| spineboy/1 | gpuMs | 0.000522667 [-0.000054187, 0.001099521] | -0.003461333 [-0.005792260, -0.001130406] | 0.007168000 | G |
| spineboy/100 | poseMs | 0.092500011 [0.005850053, 0.179149970] | -2.327500045 [-2.444536837, -2.210463254] | 2.160000086 | G |
| spineboy/100 | submitMs | -0.149999996 [-0.170724739, -0.129275253] | 0.002500017 [-0.050050417, 0.055050452] | 0.605000019 | U |
| spineboy/100 | cpuMs | -0.053333342 [-0.163682163, 0.057015478] | -2.254999995 [-2.421195607, -2.088804384] | 2.375000000 | G |
| spineboy/100 | gpuMs | 0.009386667 [0.001565760, 0.017207573] | 0.002218667 [0.000367736, 0.004069597] | 1.265664000 | U |
| raptor/1 | poseMs | 0.009166658 [0.007024508, 0.011308807] | -0.015833318 [-0.021967501, -0.009699136] | 0.159999967 | G |
| raptor/1 | submitMs | 0.000000000 [0.000000000, 0.000000000] | 0.000000020 [-0.000000031, 0.000000071] | 0.045000076 | U |
| raptor/1 | cpuMs | 0.009166698 [0.005216791, 0.013116604] | -0.015833318 [-0.021967501, -0.009699136] | 0.179999948 | G |
| raptor/1 | gpuMs | -0.018602667 [-0.051200521, 0.013995188] | -0.034304000 [-0.064229862, -0.004378138] | 0.074752000 | U |
| raptor/100 | poseMs | 0.159999986 [0.022367787, 0.297632186] | -0.125833352 [-0.230430851, -0.021235854] | 2.184999943 | G |
| raptor/100 | submitMs | 0.078333338 [0.028370207, 0.128296469] | 0.672499955 [0.583344255, 0.761655655] | 0.784999967 | U |
| raptor/100 | cpuMs | 0.234166642 [0.092924223, 0.375409061] | 0.529166679 [0.402301365, 0.656031993] | 2.404999971 | U |
| raptor/100 | gpuMs | -0.019456000 [-0.039095435, 0.000183435] | -0.013824000 [-0.075801845, 0.048153845] | 1.164288000 | U |

## Legacy comparison is a different decision

Applying the original legacy rule to these same frozen rows—every AB launch median strictly below minus the maximum absolute AA p05/p95—resolves **one gain at stage 3 and one at stage 6**, only spineboy/100 poseMs. The new descriptive CI rule resolves **six and eight**, respectively. Those gain counts use different decision statistics and cannot be read as an apples-to-apples hardware, noise or code improvement relative to #62. The legacy columns above remain comparisons only.

Command: `python3 compare-legacy-envelope.py` (private analysis helper applying `all(v < -row["envelopeMs"] for v in row["deltaMs"])` to the frozen reader rows), exit 0: `stage3 legacy=1 ci=6; stage6 legacy=1 ci=8`. The JSON receipt retains the derived counts and sole legacy row.

## Raptor/100: repeated positive cost is explicit

For raptor/100, submission and combined CPU show **a repeated increase under the posted interval rule read in the other direction; the rule as posted named gains only, so this is an observation, and it is the bar for the next capture**. This does not retrofit a regression bar into this run or alter its machine verdicts.

| Metric | AA mean [CI] | AB mean [CI] | All 6 AB launch medians |
|---|---|---|---|
| cpuMs | +0.234167 [+0.092924, +0.375409] | +0.529167 [+0.402301, +0.656032] | +0.600000, +0.350000, +0.605000, +0.455000, +0.680000, +0.485000 |
| submitMs | +0.078333 [+0.028370, +0.128296] | +0.672500 [+0.583344, +0.761656] | +0.800000, +0.680000, +0.690000, +0.575000, +0.710000, +0.580000 |

## Added launches did not tighten every interval

Across the 32 AA/AB intervals, 25 narrowed, 4 widened and 3 were unchanged. Most narrowed; not all. In particular:

| Workload / metric | Interval | Stage 3 width | Stage 6 width |
|---|---|---:|---:|
| spineboy/100 gpuMs | AA | 0.00777130605271 | 0.0156418127553 |
| spineboy/100 gpuMs | AB | 0.00293727759681 | 0.00370186125504 |
| raptor/1 poseMs | AA | 0 | 0.00428429897356 |
| raptor/1 submitMs | AB | 0 | 1.02145744786e-07 |

SampleSD changes with added launches, so observed shrinkage was never guaranteed. The tiny raptor/1 submission widening is at floating-point scale and remains visible without a floor. The legacy maximum envelope cannot decrease with added AA launches.

## Refusals, observation limits and cleanup

Before measurement, Windows staging encountered an inline-script quoting refusal and then its first native task-registration XML-encoding refusal. Both reds were preserved. The declared XML-string recovery succeeded in a separate registration attempt; it was not a performance retry. Both actual-browser fixture verification receipts passed before precheck/capture.

SSH observability was lost during the autonomous capture; no task/browser/server was restarted and no capture resubmitted. After the owner-directed cooldown, one read-only recovery obtained the completed task (Ready/result 0), immutable stages and controller. The underlying cause of the connection outages is unknown; no diagnosed mechanism is claimed.

An actual out-of-scope Mac runtime-cache placement was recorded privately and the owned cache was removed after the first stopped receipts froze. Restored inputs use the approved scratch path. Final owned task/profile cleanup is complete. The restored local runtime scratch and unused isolated installation cache were also removed after raw receipts froze; the small site archive, receipt archive, hashes and logs remain. No unrelated process, global SSH setting, service, application or source checkout is changed.

## Receipt and preserved exclusions

[HARDWARE-64.json](HARDWARE-64.json) retains stage 3 and stage 6 launch medians, intervals, original verdicts, legacy comparison, measured fixture hashes and raw SHA-256 values. Raw capture data and native process/engine identities remain private.

This compares the published packages through the legacy adapter's snapshot
path. It does not isolate a core-only change, exercise a direct-buffer renderer,
measure input-to-present latency/FPS, or establish an idle RTX baseline.
Wind-wave was withdrawn rather than replaced by a stand-in.

No repository-wide suite was rerun for these private capture/report helpers; actual browser controls and frozen raw-reader replay were used. The implementation PR had already passed its targeted checks, typecheck/lint and unmodified full suite before merge.
