# Isolated development oracle

`officialOracle.ts` is copied unchanged from rig-c/play commit
`e23405131a3bc43a9934dfe7131e62aee1b0bab2`, `tests/officialOracle.ts`.
Source SHA256: `46731a6121725531a4b7f41833244c118c7de6a96c5b4eae93c9dca03c9caf0d`. Its source licence is
rig-c/play's MIT licence. The official runtime is independently installed here
with its own Spine Runtimes License; it is never a root workspace, adapter
dependency, emitted library import or published file. `prepare-oracle.mjs` pins
its version and installs with scripts disabled. The package/installed-consumer
gates independently inspect the shipped host graph. The oracle reads the
original paired skeleton JSON/atlas/pages, checks the pair hash and advances
its own reader through the same declared history. It never consumes PosedFrame.
