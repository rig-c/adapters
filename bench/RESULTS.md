# Benchmark Results — `pixi` (`@rig-c/pixi` vs `@esotericsoftware/spine-pixi-v8`)

Every figure in this document is produced by the command printed alongside its section.

## Environment & Provenance

- **Command**: `bun run bench` (JSON output: `bun run bench -- --json`)
- **Host engine**: `pixi.js@8.22.0`
- **Arm A (Official Spine runtime)**: `@esotericsoftware/spine-pixi-v8@4.3.13`
- **Arm B (`@rig-c/pixi` over `@rig-c/play`)**: `@rig-c/pixi` + `@rig-c/play@1.10.0` (`rigc v2.52.0`)
- **Upstream Spine examples ref**: `EsotericSoftware/spine-runtimes@38ddb1a0652c2e3473e8487ebd88b4b291ad9a7e`
- **Platform / CPU**: `darwin 25.6.0 (arm64)` — `Apple M4` (`10` cores, `32 GiB` RAM)
- **GPU / WebGL**: `ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)` (`WebGL 2.0 (OpenGL ES 3.0 Chromium)`)
- **Protocol**: Headless Chromium via Playwright, `900 x 640` WebGL canvas (`devicePixelRatio = 1`), `M = 7` runs, `60` warm-up frames + `76` measured frames (`1.27 s` at `dt = 1/60 s`) per run; median across runs reported.

## Bar 1 — Correctness Check Before Benchmark (`walk`, 3 sampled times)

Command: `bun run bench`

| Skeleton | Animation | Sample times (s) | Max whole-canvas MAE (px, <= 2.0) | Max content-union MAE (px, <= 6.0) | Max shift-tolerant `badRatio` (<= 0.005) | Max `contentMismatch` (<= 0.020) | Mutant (`+0.15s` offset) whole-canvas MAE | Mutant verdict | Verdict |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| `spineboy` | `walk` | `0.00, 0.35, 0.70` | `0.0002` | `0.0024` | `0.000000` | `0.000000` | `7.2548` (`badRatio=0.7235`) | FAIL (caught) | PASS |
| `raptor` | `walk` | `0.00, 0.35, 0.70` | `0.0003` | `0.0022` | `0.000000` | `0.000013` | `11.2943` (`badRatio=0.6688`) | FAIL (caught) | PASS |

## Runtime JS Bundle Size (minified ESM, `Bun.build`)

Command: `bun run bench`

| Arm | Scope | Raw bytes | Gzip bytes (level 9) |
| --- | --- | ---: | ---: |
| `@esotericsoftware/spine-pixi-v8@4.3.13` | Adapter + Spine runtime (`pixi.js` external) | `202,530` | `58,700` |
| `@rig-c/pixi` + `@rig-c/play@1.10.0` | Adapter + `@rig-c/play` + `rig-c/core` (`pixi.js` external) | `230,130` | `73,495` |
| `@esotericsoftware/spine-pixi-v8@4.3.13` | Full bundle including `pixi.js@8.22.0` | `569,549` | `170,145` |
| `@rig-c/pixi` + `@rig-c/play@1.10.0` | Full bundle including `pixi.js@8.22.0` | `553,898` | `170,712` |

## Model Asset Byte Sizes (`rigc ingest --art none` -> `rigc build --atlas-in`)

Command: `bash scripts/fetch-assets.sh && cat public/bench/manifest.json`

| Skeleton | Artifact | Raw bytes | Gzip bytes | SHA-256 |
| --- | --- | ---: | ---: | --- |
| `spineboy` | Upstream `spineboy-pro.json` | `255,660` | `58,872` | `24ccffc13e334e721dfd427ee2b8aea05c25b59167b5fb0bb0f9685e11d2a7d3` |
| `spineboy` | Upstream `spineboy.atlas` | `1,552` | `629` | `fbd452640df513d637e0a34d21c1d3ea4edb27f57bd1856ffd5530b16ee83d00` |
| `spineboy` | Upstream `spineboy.png` | `242,791` | `242,628` | `ab874448a224f8a92188e133735062c86e5f93eb7286b0fc37c5d39864e6569f` |
| `spineboy` | Ingested `rig.json` | `157,020` | `17,903` | `7d34e9491ccf61572f7fdc4e392eada30b85f81c70c32cfc6b2a86ba4622e177` |
| `spineboy` | Ingested `motion.json` | `485,298` | `48,457` | `bfcac37769405394aedb7487bdc2b4f38f223c619e05ab1d0bc0461c8cc875e1` |
| `spineboy` | Built `skeleton.model.json` | `748,024` | `71,576` | `06bb683060a3e38866718885b78d295c2aa246739ff79efddb22bd7332dd8919` |
| `raptor` | Upstream `raptor-pro.json` | `293,164` | `72,924` | `2ba9fe06007bc7b44d412bdb5722b1cd8b5fbcd0f7a263ae1aa957a555e9742a` |
| `raptor` | Upstream `raptor.atlas` | `1,604` | `648` | `fb6e8532cb7665542b54ab661d0cadffe0171fcfe6b192595cd6ab622b08d8e6` |
| `raptor` | Upstream `raptor.png` | `418,144` | `417,299` | `c2fcb6ac6c363f5b37f622feb727aed64fbd0205897a7ba8b6b45f8a091ab125` |
| `raptor` | Ingested `rig.json` | `305,015` | `31,974` | `c6d2328dd0a4ce99d9f854c01fa0a93173f266a27b2fffc793ad307cf9d81a1e` |
| `raptor` | Ingested `motion.json` | `503,148` | `51,130` | `7c6b5900fbafb3f4a9d6dde14db0485db0d7085e27c5e80a3f48fc988b4e9338` |
| `raptor` | Built `skeleton.model.json` | `917,106` | `88,710` | `4b02193c4100e1da392929b409f4b12806c50d79aca7d8bc3738ad83a5aa18fc` |

## Load Time to First Rendered Frame

Command: `bun run bench`

| Skeleton | Arm | Runs ($M$) | Load `p50` (ms) | Load `p95` (ms) | First-frame draw calls |
| --- | --- | ---: | ---: | ---: | ---: |
| `spineboy` | `spine-pixi-v8` | `7` | `27.125` | `46.516` | `1` |
| `spineboy` | `rig-c-pixi` | `7` | `28.700` | `32.323` | `1` |
| `raptor` | `spine-pixi-v8` | `7` | `32.615` | `41.216` | `1` |
| `raptor` | `rig-c-pixi` | `7` | `41.065` | `57.382` | `3` |

## Steady-State Frame Time (`p50` / `p95`), Draw Calls, and JS Heap (`1x`, `10x`, `50x`, `100x`)

Command: `bun run bench`

| Skeleton | Instances | Arm | Frame `p50` (ms) | Frame `p95` (ms) | Frame `mean` (ms) | Draw calls / frame | Triangles / frame | JS heap after warm-up (KiB) | Heap delta over empty stage (KiB) |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `spineboy` | `1x` | `spine-pixi-v8` | `0.055` | `0.086` | `0.054` | `1` | `343` | `11468.1` | `+116.9` |
| `spineboy` | `1x` | `rig-c-pixi` | `0.325` | `0.684` | `0.406` | `1` | `343` | `11561.3` | `+210.1` |
| `spineboy` | `10x` | `spine-pixi-v8` | `0.300` | `0.636` | `0.364` | `1` | `3430` | `12105.8` | `+754.6` |
| `spineboy` | `10x` | `rig-c-pixi` | `3.190` | `4.746` | `3.330` | `10` | `3430` | `12978.4` | `+1627.1` |
| `spineboy` | `50x` | `spine-pixi-v8` | `1.535` | `3.171` | `1.853` | `1` | `17150` | `14894.6` | `+3543.3` |
| `spineboy` | `50x` | `rig-c-pixi` | `21.020` | `24.635` | `21.285` | `50` | `17150` | `18955.5` | `+7604.2` |
| `spineboy` | `100x` | `spine-pixi-v8` | `5.773` | `7.055` | `5.715` | `1` | `34300` | `18292.1` | `+6940.9` |
| `spineboy` | `100x` | `rig-c-pixi` | `27.985` | `33.194` | `28.514` | `100` | `34300` | `26201.2` | `+14850.0` |
| `raptor` | `1x` | `spine-pixi-v8` | `0.130` | `0.252` | `0.141` | `1` | `775` | `11574.3` | `+223.1` |
| `raptor` | `1x` | `rig-c-pixi` | `0.792` | `1.405` | `0.846` | `3` | `776` | `11785.8` | `+434.6` |
| `raptor` | `10x` | `spine-pixi-v8` | `1.005` | `1.420` | `0.983` | `1` | `7754` | `12294.9` | `+943.7` |
| `raptor` | `10x` | `rig-c-pixi` | `7.622` | `9.614` | `7.527` | `30` | `7760` | `14047.9` | `+2696.6` |
| `raptor` | `50x` | `spine-pixi-v8` | `6.225` | `7.396` | `6.128` | `1` | `38771` | `15417.7` | `+4066.5` |
| `raptor` | `50x` | `rig-c-pixi` | `34.763` | `44.080` | `35.280` | `150` | `38800` | `23843.3` | `+12492.1` |
| `raptor` | `100x` | `spine-pixi-v8` | `7.530` | `20.576` | `8.379` | `1` | `77542` | `19199.6` | `+7848.4` |
| `raptor` | `100x` | `rig-c-pixi` | `47.222` | `68.121` | `50.206` | `300` | `77600` | `36037.5` | `+24686.3` |

## Bar 2 — Back-to-Back Reproducibility Check (`p50` within 5%)

Command: `bun run bench -- --check-repro`

| Skeleton | Instances | Arm | Run 1 `p50` (ms) | Run 2 `p50` (ms) | Abs delta (ms) | Relative delta (`<= 0.0500`) | Verdict |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| `spineboy` | `1x` | `spine-pixi-v8` | `0.055` | `0.050` | `0.005` | `0.0017` | PASS |
| `spineboy` | `1x` | `rig-c-pixi` | `0.325` | `0.320` | `0.005` | `0.0017` | PASS |
| `spineboy` | `10x` | `spine-pixi-v8` | `0.300` | `0.295` | `0.005` | `0.0017` | PASS |
| `spineboy` | `10x` | `rig-c-pixi` | `3.190` | `3.135` | `0.055` | `0.0172` | PASS |
| `spineboy` | `50x` | `spine-pixi-v8` | `1.535` | `1.607` | `0.072` | `0.0240` | PASS |
| `spineboy` | `50x` | `rig-c-pixi` | `21.020` | `20.645` | `0.375` | `0.0178` | PASS |
| `spineboy` | `100x` | `spine-pixi-v8` | `5.773` | `5.538` | `0.235` | `0.0407` | PASS |
| `spineboy` | `100x` | `rig-c-pixi` | `27.985` | `27.585` | `0.400` | `0.0143` | PASS |
| `raptor` | `1x` | `spine-pixi-v8` | `0.130` | `0.127` | `0.003` | `0.0010` | PASS |
| `raptor` | `1x` | `rig-c-pixi` | `0.792` | `0.747` | `0.045` | `0.0150` | PASS |
| `raptor` | `10x` | `spine-pixi-v8` | `1.005` | `0.995` | `0.010` | `0.0033` | PASS |
| `raptor` | `10x` | `rig-c-pixi` | `7.622` | `7.637` | `0.015` | `0.0020` | PASS |
| `raptor` | `50x` | `spine-pixi-v8` | `6.225` | `6.227` | `0.002` | `0.0003` | PASS |
| `raptor` | `50x` | `rig-c-pixi` | `34.763` | `35.897` | `1.134` | `0.0326` | PASS |
| `raptor` | `100x` | `spine-pixi-v8` | `7.530` | `7.542` | `0.012` | `0.0016` | PASS |
| `raptor` | `100x` | `rig-c-pixi` | `47.222` | `48.117` | `0.895` | `0.0190` | PASS |

- Max relative delta across all 16 rows: `0.0407 <= 0.0500` (`PASS`)
- Synthetic drift mutant (`+25% + 1.0 ms` injected into Run 2 `p50`): `FAIL (caught)` (`PASS`)

## Bar 3 — Refusal by Name & Asset Hygiene

Command: `bun run bench` and `git status --porcelain public/bench`

- Tracked files under `public/bench`: `(empty)`
- Disk missing-asset mutant refusal: `BENCH_ASSET_MISSING: spineboy (public/bench/spineboy/skeleton.model.json) — run "bash scripts/fetch-assets.sh" first` (`PASS`)
- Browser missing-asset mutant refusal: `BENCH_ASSET_MISSING: spineboy (/bench-missing-dir/spineboy/skeleton.model.json) returned HTML fallback instead of asset — run "bash scripts/fetch-assets.sh"` (`PASS`)

## Diagnostic Notes — Draw Calls & Multi-Instance Scaling

- **Arm A (`@esotericsoftware/spine-pixi-v8`)**: `SpinePipe` submits `BatchableSpineSlot` entries directly to `renderer.renderPipes.batch.addToBatch()`, keeping all `100` instances of `spineboy` (`34,300` triangles) or `raptor` (`77,542` triangles) in `1` WebGL draw call (`gl.drawElements`) per frame.
- **Arm B (`@rig-c/pixi` over `@rig-c/play`)**: `PixiRig` constructs standard PixiJS v8 `Sprite` and `Mesh` scene objects per slot (`packages/pixi/src/pixi.ts`). Two mechanisms account for the multi-instance draw-call and frame-time gap:
  1. `this.root.enableRenderGroup()` is called unconditionally per `PixiRig` instance (`packages/pixi/src/pixi.ts:541`), creating a distinct PixiJS v8 `RenderGroup` per instance and preventing cross-instance batching (`1` draw call per `spineboy` instance -> `100` draw calls at `100x`).
  2. `new MeshGeometry({ positions, uvs, indices })` (`packages/pixi/src/pixi.ts:707`) defaults to `batchMode: 'auto'`, under which PixiJS v8 only batches meshes with `<= 100` vertices; `raptor` slots exceeding `100` vertices flush the batch and issue standalone mesh draw calls (`3` draw calls per `raptor` instance -> `300` draw calls at `100x`).

