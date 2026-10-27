# Receiving-host fixture integrity (#64)

Each fresh hardware-capture launch fetches all 18 public fixture files with
`cache: no-store`, computes SHA-256 with the browser's SubtleCrypto, and compares
both digest and byte length to the prepared manifest. All files finish checking
before GPU setup, correctness controls or sampling. A mismatch refuses with
`HARDWARE_FIXTURE_MISMATCH`, the fixture path, and found/required digest and size.
Missing metadata, fetch errors and unavailable SubtleCrypto also refuse.

The verified bodies are retained as immutable Blobs. Both player loaders receive
a custom `fetch` for the model and `resolvePage` for images; the official oracle
reads its JSON, atlas and images from those same Blobs. No fixture is fetched
again after verification. An unlisted model/page reference refuses with
`HARDWARE_FIXTURE_UNVERIFIED`. The frozen public fixtures have no attachment-set
sidecar, so these loads explicitly disable the optional `sets.json` probe.
Blob URLs are released when the launch finishes.

The raw receipt's `fixtureMeasurements` maps each fixture path to its measured
`sha256` and `bytes`. The summarizer checks every phase against its manifest and
refuses missing, partial, extra or differing measurements with
`HARDWARE_SUMMARY_FIXTURES`. The summary retains every launch measurement map.
Older captures without this field cannot satisfy the new reader; this does not
revise the separately hand-verified historical #62 figures.

Run integrity controls after the normal frozen install, oracle preparation and
`scripts/fetch-assets.sh` fixture preparation:

```sh
bun test scripts/hardware-fixtures.test.mjs scripts/hardware-statistics.test.mjs scripts/hardware-protocol.test.mjs
bun run typecheck
bun run lint
```

These tests use real Chromium on loopback. Serving-side one-byte changes to a
model, PNG and the last fixture must refuse before setup. Another control changes
every endpoint after its first response: both player arms and the official
picture oracle must still consume the verified snapshot with one request per
file. Receipt-reader controls use explicitly synthetic records, preserve the
per-arm completeness and failed-half refusals, and are not hardware captures.
`HARDWARE_TEST_SITE` can point the controls at a prepared standalone site's real
published player bundles instead of the root test dependency.

`hardware-bench.mjs --out directory` prepares a standalone site in a designated
output directory. It includes the fixture verifier and its hash. Preparation and
integrity controls do not run AA1/AA2/AB1/AB2 performance sampling. The original per-launch controls, workloads and exclusions in
[HARDWARE-62.md](HARDWARE-62.md) are preserved. The interleaved launch schedule
and t-interval decision below supersede that capture's AA-before-AB schedule
and maximum-envelope decision.
The next hardware capture requires the merged instrument rebuilt from that
revision and the owner's separate host-admission conditions.

## Interleaved receipt support

The reader accepts the historical two-pair AA1 AA2 AB1 AB2 order for reader
controls, and complete three- or six-pair captures in AA1 AB1 AA2 AB2 ... order.
The loopback result sink accepts AA1 through AA6 and AB1 through AB6. The runner's
launch scheduling and adaptive stopping remain a separate capture-phase task.
Missing/unbalanced phase files or overlapping/out-of-order launch timestamps
refuse by name. All existing per-launch controls still apply.

For six pairs, JSON and Markdown show stages at the first three pairs and at all
six. For each workload/metric, each launch contributes one paired median. AA and
AB intervals are computed separately as mean ± t(0.975, n−1) × sampleSD / sqrt(n),
using the sample standard deviation (n−1 denominator). Fixed t values are
4.302652729696142 at n=3 and 2.570581835636305 at n=6; the historical n=2 reader
control uses 12.706204736432095. These are the two-sided 95% quantiles in the
[NIST t table](https://www.itl.nist.gov/div898/handbook/eda/section3/eda3672.htm),
retained at greater precision and tested against independent t CDF formulas.

Gain requires AB upper < 0, AB upper < AA lower, and every AB launch median < 0.
Equality, a zero/positive AB launch, or overlapping intervals is unresolved.
Every launch median, interval and legacy max-absolute-AA-p05/p95 envelope is
retained. The legacy envelope is a comparability column only, and cannot
decrease with added AA launches; it is no longer the decision statistic.

These are nominal descriptive 95% intervals. Adaptive repeated looks and
multiple workload/metric comparisons do not provide guaranteed sequential or
family-wise 95% coverage. Adding launches may change sampleSD and does not
guarantee observed CI shrinkage. The coordinator owns the predeclared stopping
schedule and capture; the reader reports both stages without choosing a new run.

## Protocol identities

The prepared manifest retains `protocol: hardware-same-frame-v1` for the
unchanged per-frame pairing implementation. It additionally declares
`captureProtocol: hardware-interleaved-ci-v2` for the new interleaved three/six
launch-pair schedule, and `decisionProtocol: hardware-launch-median-t95-v1` for
the descriptive t-interval decision. These identifiers travel in every raw
receipt's manifest. The summary requires both new identifiers on all three/six
pair receipts and emits them at the top level. Missing or different identifiers
refuse with `HARDWARE_SUMMARY_PROTOCOL`; the new capture cannot be compared as
though the old schedule and decision were unchanged.

Two-pair historical reader controls retain their original manifest identifier;
the summary labels their schedule `hardware-aa-before-ab-v1` and explicitly
labels its current decision protocol. A two-pair receipt claiming the new
interleaved schedule refuses. Existing Mac/Windows launch helpers still follow
the historical two-pair schedule: the coordinator must update the actual capture
runner before using the newly prepared site. Preparation does not authorize or
trigger that capture.
