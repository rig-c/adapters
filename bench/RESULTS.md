# Benchmark Results — `pixi` (`@rig-c/pixi` vs `@esotericsoftware/spine-pixi-v8`)

Every figure in this document is produced by the command printed alongside its section.

## Environment & Provenance

- **Command**: `bun run bench` (JSON output: `bun run bench -- --json`)
- **Measured head commit**: `245085b`
- **Host engine**: `pixi.js@8.22.0`
- **Arm A (Official Spine runtime)**: `@esotericsoftware/spine-pixi-v8@4.3.13`
- **Arm B (`@rig-c/pixi` over `@rig-c/play`)**: `@rig-c/pixi` + `@rig-c/play@1.12.0` (`rigc v2.64.1`)
- **Upstream Spine examples ref**: `EsotericSoftware/spine-runtimes@38ddb1a0652c2e3473e8487ebd88b4b291ad9a7e`
- **Platform / CPU**: `darwin 25.6.0 (arm64)` — `Apple M4` (`10` cores, `32 GiB` RAM)
- **GPU / WebGL**: `ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)` (`WebGL 2.0 (OpenGL ES 3.0 Chromium)`)
- **Protocol**: Headless Chromium via Playwright, `900 x 640` WebGL canvas (`devicePixelRatio = 1`), `M = 7` runs, `60` warm-up frames + `76` measured frames (`1.27 s` at `dt = 1/60 s`) per run; median across runs reported.

## Bar 1 — Correctness Check Before Benchmark (`walk`, 3 sampled times)

Command: `bun run bench`

| Skeleton | Animation | Sample times (s) | Max whole-canvas MAE (px, <= 2.0) | Max content-union MAE (px, <= 6.0) | Max shift-tolerant `badRatio` (<= 0.005) | Max `contentMismatch` (<= 0.020) | Mutant (`+0.15s` offset) whole-canvas MAE | Mutant verdict | Verdict |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `spineboy` | `walk` | `0.00, 0.35, 0.70` | `0.0002` | `0.0023` | `0.000000` | `0.000000` | `7.2548` (`badRatio=0.7235`) | FAIL (caught) | PASS |
| `raptor` | `walk` | `0.00, 0.35, 0.70` | `0.0003` | `0.0021` | `0.000000` | `0.000013` | `11.2942` (`badRatio=0.6688`) | FAIL (caught) | PASS |

## Runtime JS Bundle Size (minified ESM, `Bun.build`)

Command: `bun run bench`

| Arm | Scope | Raw bytes | Gzip bytes (level 9) |
| --- | --- | ---: | ---: |
| `@esotericsoftware/spine-pixi-v8@4.3.13` | Adapter + Spine runtime (`pixi.js` external) | `202,530` | `58,700` |
| `@rig-c/pixi` + `@rig-c/play@1.12.0` | Adapter + `@rig-c/play` + `rig-c/core` (`pixi.js` external) | `244,923` | `77,824` |
| `@esotericsoftware/spine-pixi-v8@4.3.13` | Full bundle including `pixi.js@8.22.0` | `569,549` | `170,145` |
| `@rig-c/pixi` + `@rig-c/play@1.12.0` | Full bundle including `pixi.js@8.22.0` | `568,690` | `174,972` |

## Model Asset Byte Sizes (`rigc ingest --art none` -> `rigc build --atlas-in`)

Command: `bash scripts/fetch-assets.sh && cat public/bench/manifest.json`

| Skeleton | Artifact | Raw bytes | Gzip bytes | SHA-256 |
| --- | --- | ---: | ---: | --- |
| `spineboy` | Upstream `spineboy-pro.json` | `255,660` | `58,872` | `24ccffc13e334e721dfd427ee2b8aea05c25b59167b5fb0bb0f9685e11d2a7d3` |
| `spineboy` | Upstream `spineboy.atlas` | `1,552` | `629` | `fbd452640df513d637e0a34d21c1d3ea4edb27f57bd1856ffd5530b16ee83d00` |
| `spineboy` | Upstream `spineboy.png` | `242,791` | `242,628` | `ab874448a224f8a92188e133735062c86e5f93eb7286b0fc37c5d39864e6569f` |
| `spineboy` | Ingested `rig.json` | `157,020` | `17,903` | `189036b5f38b33e4732b738f89730d6556cd120a259f875f4aaf8a866d3d32f3` |
| `spineboy` | Ingested `motion.json` | `485,298` | `48,458` | `59797a1083d31ce14332a70889c562e876c5c191a5ae2423090f47cf723eb210` |
| `spineboy` | Built `skeleton.model.json` | `748,024` | `71,576` | `06bb683060a3e38866718885b78d295c2aa246739ff79efddb22bd7332dd8919` |
| `raptor` | Upstream `raptor-pro.json` | `293,164` | `72,924` | `2ba9fe06007bc7b44d412bdb5722b1cd8b5fbcd0f7a263ae1aa957a555e9742a` |
| `raptor` | Upstream `raptor.atlas` | `1,604` | `648` | `fb6e8532cb7665542b54ab661d0cadffe0171fcfe6b192595cd6ab622b08d8e6` |
| `raptor` | Upstream `raptor.png` | `418,144` | `417,299` | `c2fcb6ac6c363f5b37f622feb727aed64fbd0205897a7ba8b6b45f8a091ab125` |
| `raptor` | Ingested `rig.json` | `305,015` | `31,974` | `dba04cba8a141ff48f6b687c6d910cffc9e8d99e229fb4a5a8cc7d0fab4915ff` |
| `raptor` | Ingested `motion.json` | `503,148` | `51,130` | `85f7eb22187872bbd6b9af7e6bf544f77af032e830efd9104f0bf2f951c38457` |
| `raptor` | Built `skeleton.model.json` | `917,106` | `88,710` | `4b02193c4100e1da392929b409f4b12806c50d79aca7d8bc3738ad83a5aa18fc` |

## Load Time to First Rendered Frame

Command: `bun run bench`

> **Note**: The load-to-first-frame and back-to-back reproducibility figures in this run are not trusted until [#43](https://github.com/rig-c/adapters/issues/43) lands (`loadRigPlayModel` duplicate `skeleton.model.json` fetch, `collectPreparedRuns` frame interleaving, and `evaluateReproducibility` `3.0 ms` denominator floor).

| Skeleton | Arm | Runs ($M$) | Load `p50` (ms) | Load `p95` (ms) | First-frame draw calls |
| --- | --- | ---: | ---: | ---: | ---: |
| `spineboy` | `spine-pixi-v8` | `7` | `33.005` | `46.304` | `1` |
| `spineboy` | `rig-c-pixi` | `7` | `53.430` | `66.137` | `1` |
| `raptor` | `spine-pixi-v8` | `7` | `39.155` | `47.347` | `1` |
| `raptor` | `rig-c-pixi` | `7` | `46.340` | `50.805` | `1` |

## Steady-State Frame Time (`p50` / `p95`), Pose vs Draw Split, Draw Calls, and JS Heap (`1x`, `10x`, `50x`, `100x`)

Command: `bun run bench` (measured at commit `245085b`)

| Skeleton | Instances | Arm | Frame `p50` (ms) | Pose `p50` (ms) | Draw `p50` (ms) | Frame `p95` (ms) | Frame `mean` (ms) | Draw calls / frame | Triangles / frame | JS heap after warm-up (KiB) | Heap delta over empty stage (KiB) |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `spineboy` | `1x` | `spine-pixi-v8` | `0.075` | `0.040` | `0.040` | `0.181` | `0.089` | `1` | `343` | `12971.7` | `+87.0` |
| `spineboy` | `1x` | `rig-c-pixi` | `0.515` | `0.390` | `0.115` | `1.026` | `0.592` | `1` | `343` | `13010.1` | `+125.5` |
| `spineboy` | `10x` | `spine-pixi-v8` | `0.480` | `0.205` | `0.265` | `0.818` | `0.542` | `1` | `3430` | `13519.0` | `+634.4` |
| `spineboy` | `10x` | `rig-c-pixi` | `4.000` | `3.355` | `0.530` | `5.564` | `3.803` | `1` | `3430` | `14358.3` | `+1473.7` |
| `spineboy` | `50x` | `spine-pixi-v8` | `2.380` | `0.957` | `1.288` | `3.663` | `2.325` | `1` | `17150` | `16250.1` | `+3365.4` |
| `spineboy` | `50x` | `rig-c-pixi` | `17.635` | `15.228` | `2.648` | `22.624` | `17.782` | `1` | `17150` | `20456.9` | `+7572.3` |
| `spineboy` | `100x` | `spine-pixi-v8` | `5.363` | `2.237` | `3.023` | `6.886` | `4.988` | `1` | `34300` | `19546.6` | `+6662.0` |
| `spineboy` | `100x` | `rig-c-pixi` | `36.902` | `31.135` | `5.320` | `44.656` | `36.747` | `1` | `34300` | `27889.1` | `+15004.5` |
| `raptor` | `1x` | `spine-pixi-v8` | `0.105` | `0.050` | `0.058` | `0.270` | `0.134` | `1` | `775` | `12707.6` | `+0.0` |
| `raptor` | `1x` | `rig-c-pixi` | `0.748` | `0.555` | `0.165` | `1.320` | `0.793` | `1` | `776` | `12865.1` | `+0.0` |
| `raptor` | `10x` | `spine-pixi-v8` | `0.933` | `0.340` | `0.563` | `1.347` | `0.941` | `1` | `7754` | `13358.9` | `+474.3` |
| `raptor` | `10x` | `rig-c-pixi` | `6.258` | `5.145` | `1.147` | `8.556` | `6.111` | `1` | `7760` | `15157.4` | `+2272.7` |
| `raptor` | `50x` | `spine-pixi-v8` | `5.995` | `2.102` | `4.070` | `8.818` | `6.120` | `1` | `38771` | `16435.8` | `+3551.2` |
| `raptor` | `50x` | `rig-c-pixi` | `33.820` | `28.150` | `5.815` | `43.900` | `34.024` | `1` | `38800` | `25370.6` | `+12485.9` |
| `raptor` | `100x` | `spine-pixi-v8` | `12.482` | `4.257` | `8.175` | `32.004` | `13.747` | `1` | `77542` | `20135.3` | `+7250.7` |
| `raptor` | `100x` | `rig-c-pixi` | `70.130` | `58.165` | `11.168` | `87.860` | `71.621` | `1` | `77600` | `38080.4` | `+25195.8` |

## Issue #41 — Before vs Pin-Bump Control vs After (Same Host)

Command: `bun run bench -- --check-repro --write-results bench/RESULTS.md` (measured at commit `245085b`)

- **Before (`#39` baseline)**: `@rig-c/pixi@0.1.1` (unconditional `this.root.enableRenderGroup()`, `MeshGeometry` `batchMode = 'auto'`) + `@rig-c/play@1.10.0` (`rigc v2.52.0`).
- **Pin-Bump Control**: `@rig-c/pixi@0.1.1` (unmodified) + `@rig-c/play@1.12.0` (`rigc v2.64.1`). Built `skeleton.model.json` files for `spineboy` (`748,024 B`, SHA-256 `06bb6830...`) and `raptor` (`917,106 B`, SHA-256 `4b02193c...`) are byte-identical (`0 B` delta); draw calls at `100x` remained `100` (`spineboy`) and `300` (`raptor`); `raptor` frame `p50` improved from `0.792 ms -> 0.482 ms` (`1x`) and `47.222 ms -> 41.858 ms` (`100x`) from `@rig-c/play@1.12.0` alone.
- **After (`#41` batching fix)**: `@rig-c/pixi` (`RenderGroup` opt-in / clip-only + `geometry.batchMode = 'batch'` + cached static `uvs`/`triangles` validation and redundant `getGlobalTransform` removal) + `@rig-c/play@1.12.0` (`rigc v2.64.1`).

| Skeleton | Instances | Arm | Before (`#39`) `p50` (ms) | Before draw calls | Pin-Bump Control `p50` (ms) | Pin-Bump draw calls | After (`#41`) `p50` (ms) | After Pose `p50` (ms) | After Draw `p50` (ms) | After draw calls |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `spineboy` | `1x` | `spine-pixi-v8` | `0.055` | `1` | `0.095` | `1` | `0.075` | `0.040` | `0.040` | `1` |
| `spineboy` | `1x` | `rig-c-pixi` | `0.325` | `1` | `0.310` | `1` | `0.515` | `0.390` | `0.115` | `1` |
| `spineboy` | `10x` | `spine-pixi-v8` | `0.300` | `1` | `0.290` | `1` | `0.480` | `0.205` | `0.265` | `1` |
| `spineboy` | `10x` | `rig-c-pixi` | `3.190` | `10` | `2.305` | `10` | `4.000` | `3.355` | `0.530` | `1` |
| `spineboy` | `50x` | `spine-pixi-v8` | `1.535` | `1` | `1.180` | `1` | `2.380` | `0.957` | `1.288` | `1` |
| `spineboy` | `50x` | `rig-c-pixi` | `21.020` | `50` | `13.035` | `50` | `17.635` | `15.228` | `2.648` | `1` |
| `spineboy` | `100x` | `spine-pixi-v8` | `5.773` | `1` | `2.462` | `1` | `5.363` | `2.237` | `3.023` | `1` |
| `spineboy` | `100x` | `rig-c-pixi` | `27.985` | `100` | `28.725` | `100` | `36.902` | `31.135` | `5.320` | `1` |
| `raptor` | `1x` | `spine-pixi-v8` | `0.130` | `1` | `0.155` | `1` | `0.105` | `0.050` | `0.058` | `1` |
| `raptor` | `1x` | `rig-c-pixi` | `0.792` | `3` | `0.482` | `3` | `0.748` | `0.555` | `0.165` | `1` |
| `raptor` | `10x` | `spine-pixi-v8` | `1.005` | `1` | `0.550` | `1` | `0.933` | `0.340` | `0.563` | `1` |
| `raptor` | `10x` | `rig-c-pixi` | `7.622` | `30` | `4.080` | `30` | `6.258` | `5.145` | `1.147` | `1` |
| `raptor` | `50x` | `spine-pixi-v8` | `6.225` | `1` | `3.563` | `1` | `5.995` | `2.102` | `4.070` | `1` |
| `raptor` | `50x` | `rig-c-pixi` | `34.763` | `150` | `21.233` | `150` | `33.820` | `28.150` | `5.815` | `1` |
| `raptor` | `100x` | `spine-pixi-v8` | `7.530` | `1` | `6.235` | `1` | `12.482` | `4.257` | `8.175` | `1` |
| `raptor` | `100x` | `rig-c-pixi` | `47.222` | `300` | `41.858` | `300` | `70.130` | `58.165` | `11.168` | `1` |

- **Bar 1 Negative-Control Mutants (`100x` draw calls)**: `renderGroup: true` on `spineboy` -> `100` draw calls (`> 1`, `FAIL (caught)`); `meshBatchMode = 'auto'` alone on `raptor` -> `201` draw calls (`> 3`, `FAIL (caught)`); `renderGroup: true` + `meshBatchMode = 'auto'` on `raptor` -> `300` draw calls (`> 3`, `FAIL (caught)`).

## Bar 2 — Back-to-Back Reproducibility Check (`p50` within 5%)

Command: `bun run bench -- --check-repro`

> **Note**: The back-to-back reproducibility figures in this run are not trusted until [#43](https://github.com/rig-c/adapters/issues/43) lands (`evaluateReproducibility` `3.0 ms` denominator floor and `collectPreparedRuns` frame interleaving).

| Skeleton | Instances | Arm | Run 1 `p50` (ms) | Run 2 `p50` (ms) | Abs delta (ms) | Relative delta (`<= 0.0500`) | Verdict |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| `spineboy` | `1x` | `spine-pixi-v8` | `0.075` | `0.075` | `0.000` | `0.0000` | PASS |
| `spineboy` | `1x` | `rig-c-pixi` | `0.515` | `0.518` | `0.003` | `0.0010` | PASS |
| `spineboy` | `10x` | `spine-pixi-v8` | `0.480` | `0.475` | `0.005` | `0.0017` | PASS |
| `spineboy` | `10x` | `rig-c-pixi` | `4.000` | `4.040` | `0.040` | `0.0100` | PASS |
| `spineboy` | `50x` | `spine-pixi-v8` | `2.380` | `2.300` | `0.080` | `0.0267` | PASS |
| `spineboy` | `50x` | `rig-c-pixi` | `17.635` | `17.740` | `0.105` | `0.0060` | PASS |
| `spineboy` | `100x` | `spine-pixi-v8` | `5.363` | `5.348` | `0.015` | `0.0028` | PASS |
| `spineboy` | `100x` | `rig-c-pixi` | `36.902` | `36.245` | `0.657` | `0.0178` | PASS |
| `raptor` | `1x` | `spine-pixi-v8` | `0.105` | `0.120` | `0.015` | `0.0050` | PASS |
| `raptor` | `1x` | `rig-c-pixi` | `0.748` | `0.768` | `0.020` | `0.0067` | PASS |
| `raptor` | `10x` | `spine-pixi-v8` | `0.933` | `0.900` | `0.033` | `0.0110` | PASS |
| `raptor` | `10x` | `rig-c-pixi` | `6.258` | `6.345` | `0.087` | `0.0139` | PASS |
| `raptor` | `50x` | `spine-pixi-v8` | `5.995` | `6.257` | `0.262` | `0.0437` | PASS |
| `raptor` | `50x` | `rig-c-pixi` | `33.820` | `34.035` | `0.215` | `0.0064` | PASS |
| `raptor` | `100x` | `spine-pixi-v8` | `12.482` | `12.237` | `0.245` | `0.0196` | PASS |
| `raptor` | `100x` | `rig-c-pixi` | `70.130` | `69.288` | `0.842` | `0.0120` | PASS |

- Max relative delta across all 16 rows: `0.0437 <= 0.0500` (`PASS`)
- Synthetic drift mutant (`+25% + 1.0 ms` injected into Run 2 `p50`): `FAIL (caught)` (`PASS`)

## Bar 3 — Refusal by Name & Asset Hygiene

Command: `bun run bench` and `git status --porcelain public/bench`

- Tracked files under `public/bench`: `(empty)`
- Disk missing-asset mutant refusal: `BENCH_ASSET_MISSING: spineboy (public/bench/spineboy/skeleton.model.json) — run "bash scripts/fetch-assets.sh" first` (`PASS`)
- Browser missing-asset mutant refusal: `BENCH_ASSET_MISSING: spineboy (/bench-missing-dir/spineboy/skeleton.model.json) returned HTML fallback instead of asset — run "bash scripts/fetch-assets.sh"` (`PASS`)

## Diagnostic Notes — Draw Calls & Multi-Instance Scaling

- **Draw calls at `100x` (`1` on both `spineboy` and `raptor`)**: Removing unconditional `this.root.enableRenderGroup()` (leaving `RenderGroup` promotion to `options.renderGroup === true` or frames carrying a `clip` polygon) and setting `geometry.batchMode = 'batch'` after `new MeshGeometry(...)` (working around PixiJS v8.22.0's `MeshGeometry` constructor overwriting `this.batchMode = 'auto'`) reduces `rig-c-pixi` draw calls at `100x` from `100 -> 1` on `spineboy` and `300 -> 1` on `raptor`.
- **Pose (`@rig-c/play`) vs Draw (`@rig-c/pixi` + PixiJS WebGL) split at `100x`**: With draw calls reduced to `1`, the `@rig-c/pixi` adapter + PixiJS WebGL drawing phase (`Draw p50`) is within `2x` of the official `@esotericsoftware/spine-pixi-v8` arm on both skeletons. The remaining gap in total `Frame p50` (`Pose + Draw`) comes from stepping `100` independent `RigPlayer` instances on the CPU (`Pose p50` = $100 \times$ the `1x` `@rig-c/play` posing cost, ~83–86% of total frame time at `100x`).
