# Published-player hardware comparison (#62)

The Mac capture resolves a combined CPU improvement for spineboy at 1 and 100
instances, and raptor at 1 instance. Raptor at 100 instances, every submission
delta and every GPU delta remain unresolved by the predeclared A/A envelope.
On Windows RTX 4070 Ti, no improvement repeats beyond the A/A envelope.
Background GPU activity was observed; this is not an uncontended RTX baseline.

This compares published default products through the same legacy Pixi adapter:
play 1.17.1 versus play 1.18.0. It is a package comparison, not an isolated causal
measurement of the runtime poser or a presentation/FPS result. Play 1.17.1's
package declares build-time core 2.67.0; its 18 embedded core source-map entries
also match core 2.70.0 byte for byte. Play 1.18.0 declares core 2.72.0 and all 21
embedded core source entries match it. Installing another core next to a bundled
play package does not alter that package. No product rebuild, event waiver,
model injection or poser override was used.

The [bars](https://github.com/rig-c/adapters/issues/62#issuecomment-6423701930)
and [dependency correction](https://github.com/rig-c/adapters/issues/62#issuecomment-6423734822)
preceded A/A timing. Wind-wave was withdrawn because it was never admitted to
the #58 bench. Both admitted fixtures are unchanged; all 18 fixture-file hashes
match their existing manifest.

## Protocol and reproducibility

A/A uses old/old, A/B old/new. Each machine runs AA1, AA2, AB1, AB2 in four fresh
headful browser launches: 60 warmup and 180 measured paired frames per workload,
1 and 100 instances, 1800x640 shared canvas, DPR 1. The original `runSameFramePair`
function is byte-identical to `b35105b` (verified against origin) and bundled unchanged; AB/BA alternates every frame. All A/A launches
finish before any A/B launch. For each workload and metric the envelope is the
maximum absolute p05/p95 paired A/A difference over both launches. An improvement
requires both A/B paired medians to be negative and strictly beyond that envelope.
Medians of separate columns need not subtract to the paired median.

Before sampling, both arms pass the existing official-runtime picture oracle,
the time-offset negative control fails that oracle, and the existing draw-call
mutants are detected. Every measured workload also passes the original shared
half-versus-isolated picture checks at 0, 0.35 and 0.7 seconds, and draw-call caps.
The precheck plants a 12 ms busy interval only in B and requires its paired CPU
shift to exceed 8 ms. Failed or missing controls refuse by name.

Preparation commands, exit 0 in this capture:

```sh
bun install --frozen-lockfile
bun scripts/prepare-oracle.mjs
# Prepare the pinned public fixtures using the repository's fetch-assets script,
# or reuse a frozen copy whose complete manifest hashes are verified.
bun scripts/hardware-bench.mjs
bun scripts/hardware-bench-mac.mjs --precheck
```

`hardware-bench.mjs` installs the two exact published player versions in isolated
ignored directories, verifies embedded core sources, and prepares a standalone
site under `test-results/hardware-bench/site`. Its host Pixi version comes from
the root frozen lock. Run the Mac capture through `nova-run` local exclusive
with the required label, owner and actual session identity:

```sh
bun scripts/hardware-bench-mac.mjs
bun scripts/summarize-hardware-bench.mjs test-results/hardware-bench/mac
```

For Windows, copy that same site plus `hardware-bench-server.cjs` and
`hardware-bench-windows.cjs` to an isolated capture directory. An interactive
Windows scheduled task starts Node there. The runner starts the installed
Chromium with its own per-launch profiles, serves the frozen site on loopback,
saves JSON results, terminates only its own browser process trees and server,
and writes the terminal receipt. There is no WSL render or LAN server.
`--force-high-performance-gpu` selected the RTX after the default selection was
observed to use Intel; the actual GL string is the acceptance evidence. The
[Chromium switch definition](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/gpu/config/gpu_switches.cc)
provides the browser-local option. An unexpected GPU refuses before A/A.

## Mac receipt

Command: `bun scripts/hardware-bench-mac.mjs`, local exclusive, exit **0**.
Summary command: `bun scripts/summarize-hardware-bench.mjs test-results/hardware-bench/mac`,
exit **0**, output `HARDWARE_SUMMARY`: **2880** paired frames, **96** half checks.
A copied report with one failed half is rejected by the same summary command,
exit **1**, named `HARDWARE_SUMMARY_ROW`.

`system_profiler SPDisplaysDataType SPSoftwareDataType` recorded Apple M4
(10 GPU cores), ANGLE Metal, Chromium **151.0.7922.34**;
macOS 26.6.1 (25G76), Darwin 25.6.0. The Apple graphics driver is integrated
with the OS; no independent driver version was exposed. The timer extension
**was available**, and no measured row reported disjoint or timeout.
Cross-origin isolation was active; the observed minimum clock step was about
0.005 ms. Whole-frame `gl.finish` completion is CPU wall time and is not used
as per-arm GPU execution time.

The granted window excluded other measuring sessions and builds; desktop
application panes were idle. `top -l 1 -n 0` recorded load 3.51/3.07/2.76 before
and 4.40/3.40/2.90 after, CPU idle 70.73% and 68.22%. The machine still had normal
background desktop work and compressed memory; swapout count did not change.
This is the observed window, not a claim that the whole OS had zero load.

| Input | Instances | Metric | A p50 (AB1 / AB2) | B p50 (AB1 / AB2) | AA envelope | AB paired p50 | Verdict |
|---|---:|---|---|---|---:|---|---|
| spineboy | 1 | poseMs | 0.105000 / 0.110000 | 0.065000 / 0.065000 | 0.030000 | -0.050000 / -0.050000 | improvement outside A/A envelope |
| spineboy | 1 | submitMs | 0.020000 / 0.020000 | 0.020000 / 0.020000 | 0.015000 | 0.000000 / 0.000000 | unresolved by A/A envelope |
| spineboy | 1 | cpuMs | 0.125000 / 0.130000 | 0.080000 / 0.085000 | 0.035000 | -0.055000 / -0.050000 | improvement outside A/A envelope |
| spineboy | 1 | gpuMs | 0.165000 / 0.105708 | 0.162250 / 0.108374 | 0.145292 | -0.002917 / 0.002833 | unresolved by A/A envelope |
| spineboy | 100 | poseMs | 7.435000 / 8.340000 | 4.885000 / 5.360000 | 1.600000 | -2.585000 / -2.940000 | improvement outside A/A envelope |
| spineboy | 100 | submitMs | 1.260000 / 1.485000 | 1.330000 / 1.545000 | 0.370000 | 0.070000 / 0.065000 | unresolved by A/A envelope |
| spineboy | 100 | cpuMs | 8.635000 / 9.800000 | 6.230000 / 6.945000 | 1.705000 | -2.535000 / -2.970000 | improvement outside A/A envelope |
| spineboy | 100 | gpuMs | 0.435416 / 0.376624 | 0.446083 / 0.527541 | 0.504334 | 0.005750 / 0.010875 | unresolved by A/A envelope |
| raptor | 1 | poseMs | 0.160000 / 0.165000 | 0.115000 / 0.125000 | 0.030000 | -0.050000 / -0.055000 | improvement outside A/A envelope |
| raptor | 1 | submitMs | 0.055000 / 0.060000 | 0.060000 / 0.065000 | 0.015000 | 0.005000 / 0.005000 | unresolved by A/A envelope |
| raptor | 1 | cpuMs | 0.210000 / 0.225000 | 0.175000 / 0.190000 | 0.040000 | -0.045000 / -0.050000 | improvement outside A/A envelope |
| raptor | 1 | gpuMs | 0.131083 / 0.136625 | 0.134166 / 0.137208 | 0.119125 | 0.002542 / -0.006250 | unresolved by A/A envelope |
| raptor | 100 | poseMs | 11.010000 / 10.790000 | 10.200000 / 10.000000 | 1.325000 | -0.795000 / -0.790000 | unresolved by A/A envelope |
| raptor | 100 | submitMs | 2.800000 / 2.720000 | 2.985000 / 2.865000 | 0.490000 | 0.215000 / 0.185000 | unresolved by A/A envelope |
| raptor | 100 | cpuMs | 13.845000 / 13.520000 | 13.235000 / 12.935000 | 1.370000 | -0.620000 / -0.630000 | unresolved by A/A envelope |
| raptor | 100 | gpuMs | 1.591250 / 1.094916 | 1.278375 / 1.589625 | 0.637499 | -0.507459 / 0.105083 | unresolved by A/A envelope |

## Windows RTX receipt

Interactive task command: `node hardware-bench-windows.cjs`,
`Get-ScheduledTaskInfo` reported **LastTaskResult 0**, state **Ready**.
The task used **NVIDIA GeForce RTX 4070 Ti / ANGLE D3D11**, driver
**32.0.16.1088**, installed Chromium **155.0.8059.80**, Windows 11 Pro
10.0.26300 (build 26300). The site was copied to Windows and served on loopback;
the renderer did not run under SSH or WSL. No ComfyUI instance was changed.

`bun scripts/summarize-hardware-bench.mjs test-results/hardware-bench/mac test-results/hardware-bench/windows`,
exit **0**, printed `HARDWARE_SUMMARY`: **2880** paired frames and **96** half
checks on each machine. Every Windows timer row was available with no disjoint
or timeout. The same browser-side minimum clock step was about 0.005 ms with
cross-origin isolation active. Both machines used identical frozen bundle and
fixture hashes; their browser builds and drivers differ, so this is not a
cross-machine speed comparison.

`Get-CimInstance` observations retained by the task recorded CPU **24%** before
and **37%** after. During **18:14:51Z–18:16:17Z**, an **unrelated desktop application** (named in the private receipt) used the
selected display adapter (LUID **0x17C10**) at **22% before / 21% after**, with
`dwm` at **3%** on the same LUID. The host-condition review identified this as
the display GPU used by the benchmark. The **78%** Python engine was on
**0x181F0**, the other card; it is not attributed to the measured 4070 Ti.
Per-phase counter identities and observations remain in the receipt.
The same-adapter game load contaminates an idle-GPU interpretation. No
whole-machine exclusivity or uncontended-RTX baseline is claimed; those
processes were left running.

All Windows metrics remain unresolved by the predeclared A/A bar. This means
this capture does not establish a repeatable improvement; it does not prove
that the packages have equal performance or that the runtime poser has no benefit.

| Input | Instances | Metric | A p50 (AB1 / AB2) | B p50 (AB1 / AB2) | AA envelope | AB paired p50 | Verdict |
|---|---:|---|---|---|---:|---|---|
| spineboy | 1 | poseMs | 0.090000 / 0.100000 | 0.050000 / 0.050000 | 0.095000 | -0.040000 / -0.050000 | unresolved by A/A envelope |
| spineboy | 1 | submitMs | 0.025000 / 0.025000 | 0.025000 / 0.025000 | 0.040000 | 0.000000 / 0.000000 | unresolved by A/A envelope |
| spineboy | 1 | cpuMs | 0.120000 / 0.130000 | 0.075000 / 0.075000 | 0.110000 | -0.040000 / -0.050000 | unresolved by A/A envelope |
| spineboy | 1 | gpuMs | 0.005120 / 0.005120 | 0.005120 / 0.005120 | 0.009216 | -0.001024 / -0.001024 | unresolved by A/A envelope |
| spineboy | 100 | poseMs | 8.355000 / 9.550000 | 5.900000 / 8.300000 | 2.380000 | -2.360000 / -1.495000 | unresolved by A/A envelope |
| spineboy | 100 | submitMs | 1.880000 / 2.675000 | 1.865000 / 2.505000 | 0.640000 | 0.010000 / -0.135000 | unresolved by A/A envelope |
| spineboy | 100 | cpuMs | 10.435000 / 12.205000 | 7.965000 / 10.765000 | 2.585000 | -2.330000 / -1.515000 | unresolved by A/A envelope |
| spineboy | 100 | gpuMs | 0.127936 / 0.141312 | 0.126976 / 0.125952 | 0.156672 | 0.000000 / -0.019456 | unresolved by A/A envelope |
| raptor | 1 | poseMs | 0.125000 / 0.135000 | 0.095000 / 0.085000 | 0.100000 | -0.025000 / -0.040000 | unresolved by A/A envelope |
| raptor | 1 | submitMs | 0.030000 / 0.040000 | 0.035000 / 0.035000 | 0.025000 | 0.005000 / 0.000000 | unresolved by A/A envelope |
| raptor | 1 | cpuMs | 0.165000 / 0.175000 | 0.140000 / 0.125000 | 0.120000 | -0.030000 / -0.035000 | unresolved by A/A envelope |
| raptor | 1 | gpuMs | 0.010240 / 0.004096 | 0.005120 / 0.008896 | 0.013312 | -0.008192 / 0.000704 | unresolved by A/A envelope |
| raptor | 100 | poseMs | 10.975000 / 13.950000 | 10.745000 / 16.200000 | 2.040000 | 0.000000 / 2.360000 | unresolved by A/A envelope |
| raptor | 100 | submitMs | 2.730000 / 4.775000 | 3.235000 / 5.550000 | 0.880000 | 0.520000 / 0.700000 | unresolved by A/A envelope |
| raptor | 100 | cpuMs | 13.685000 / 19.030000 | 13.970000 / 22.040000 | 2.410000 | 0.445000 / 3.005000 | unresolved by A/A envelope |
| raptor | 100 | gpuMs | 0.368640 / 0.386048 | 0.365568 / 0.391168 | 0.498688 | -0.057344 / -0.010240 | unresolved by A/A envelope |

## Side-by-side envelopes and judgment

Command: `bun scripts/summarize-hardware-bench.mjs test-results/hardware-bench/mac test-results/hardware-bench/windows`,
exit **0**. All values below are milliseconds; A/B is paired B minus A, shown
as the two independent medians. This compares each result to its own local
noise bar, not the speed of one GPU against another.

| Input | Instances | Metric | M4 A/A envelope | M4 A/B | RTX A/A envelope | RTX A/B |
|---|---:|---|---:|---|---:|---|
| spineboy | 1 | poseMs | 0.030000 | -0.050000 / -0.050000 | 0.095000 | -0.040000 / -0.050000 |
| spineboy | 1 | submitMs | 0.015000 | 0.000000 / 0.000000 | 0.040000 | 0.000000 / 0.000000 |
| spineboy | 1 | cpuMs | 0.035000 | -0.055000 / -0.050000 | 0.110000 | -0.040000 / -0.050000 |
| spineboy | 1 | gpuMs | 0.145292 | -0.002917 / 0.002833 | 0.009216 | -0.001024 / -0.001024 |
| spineboy | 100 | poseMs | 1.600000 | -2.585000 / -2.940000 | 2.380000 | -2.360000 / -1.495000 |
| spineboy | 100 | submitMs | 0.370000 | 0.070000 / 0.065000 | 0.640000 | 0.010000 / -0.135000 |
| spineboy | 100 | cpuMs | 1.705000 | -2.535000 / -2.970000 | 2.585000 | -2.330000 / -1.515000 |
| spineboy | 100 | gpuMs | 0.504334 | 0.005750 / 0.010875 | 0.156672 | 0.000000 / -0.019456 |
| raptor | 1 | poseMs | 0.030000 | -0.050000 / -0.055000 | 0.100000 | -0.025000 / -0.040000 |
| raptor | 1 | submitMs | 0.015000 | 0.005000 / 0.005000 | 0.025000 | 0.005000 / 0.000000 |
| raptor | 1 | cpuMs | 0.040000 | -0.045000 / -0.050000 | 0.120000 | -0.030000 / -0.035000 |
| raptor | 1 | gpuMs | 0.119125 | 0.002542 / -0.006250 | 0.013312 | -0.008192 / 0.000704 |
| raptor | 100 | poseMs | 1.325000 | -0.795000 / -0.790000 | 2.040000 | 0.000000 / 2.360000 |
| raptor | 100 | submitMs | 0.490000 | 0.215000 / 0.185000 | 0.880000 | 0.520000 / 0.700000 |
| raptor | 100 | cpuMs | 1.370000 | -0.620000 / -0.630000 | 2.410000 | 0.445000 / 3.005000 |
| raptor | 100 | gpuMs | 0.637499 | -0.507459 / 0.105083 | 0.498688 | -0.057344 / -0.010240 |

The RTX A/A envelopes are wider for **pose, submission and combined CPU in all
four workloads**. Its GPU-time envelopes are smaller than the M4's; the claim
of wider noise must not be extended to those timer metrics.

The A/A bar absorbs the variability observed between those identical arms for
admission purposes: **no RTX A/B gain clears it in both repeats**. It does not
remove persistent game contention, and cannot guarantee that it absorbs all
later drift. Raptor at 100 instances illustrates the limit: paired CPU deltas
are **+0.445 / +3.005 ms** against a **2.410 ms** envelope. The second is beyond
the envelope, but the first does not repeat it; this is no repeated regression
claim and is not attributed solely to the load.

Judgment: this is a valid, explicitly contended hardware capture, inconclusive
about an uncontended RTX gain. A quiet rerun is needed to answer that narrower
question. No rerun is scheduled; a quiet window is reserved for the owner to
approve through the coordinator.

## Refusals, recovery and remaining scope

The first Mac precheck omitted `await` on the async GPU-info reader and recorded
empty device metadata. It was excluded and corrected before A/A. The first
Windows launch selected Intel integrated graphics. That capture was preserved
and rejected as RTX evidence. The corrected Windows runner explicitly refuses
an unexpected renderer before starting A/A.

SSH disconnected while the existing RTX task ran. After the requested ten-minute
cooldown, one recovery read found the task complete. No task was resubmitted.
`Get-FileHash` matched all **7** recovered JSON files to their remote SHA-256;
all five browser-process-tree cleanup calls returned exit **0**, and the
capture server had no remaining listener. The one-shot task and generated
browser profiles were removed after recovery; raw results remain available.

This compares the published packages through the legacy adapter's snapshot
path. It does not isolate a core-only change, exercise a direct-buffer renderer,
measure input-to-present latency/FPS, or establish an idle RTX baseline.
Wind-wave was withdrawn rather than replaced by a stand-in. No repository-wide
suite was run for these standalone capture/report helpers; actual browser
controls, raw-reader rejection and syntax checks were used.

Raw receipts stay under the ignored capture output. [HARDWARE-62.json](HARDWARE-62.json)
retains small summaries, commands, input and raw-report hashes. No PR, commit or
merge was made by this measurement lane; integration belongs to the coordinator.

## Retro

1. The missing `nova` skill was resolved by an explicitly revised interactive
   Windows route. Direct execution followed the repository's no-delegation rule.
2. Current issue text, origin source, package bytes/maps and raw outputs were
   used; no historical measurement was substituted.
3. Authored files and capture data stayed in the designated worktree output;
   the shared runner and bridge used their designated evidence/scratch stores.
4. The invalid metadata precheck and Intel capture cost extra work. Their explicit
   rejection, corrected async read and early RTX gate prevent them from being
   promoted into accepted evidence. No optional third arm or full suite was run.
