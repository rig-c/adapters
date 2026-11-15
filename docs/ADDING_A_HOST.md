# Adding a host

One workspace per host, one independent tag per publishable package.
The root stays private and owns CI, public fixture building and the demo.

1. Create `packages/<host>/src/index.ts`, `packages/<host>/tests/<host>.spec.ts`
   and `packages/<host>/tsconfig.build.json` following `packages/pixi`. The parity
   suite must compare the host's drawing with @rig-c/play's PosedFrame and same-
   browser CanvasRenderer, keeping declared tolerances and planted failures.
   Playwright discovers `packages/*/tests/*.spec.ts`; no workflow edit is needed.
2. Add `package.json`: name `@rig-c/<host>`, independent starting version, ESM,
   typed `.` export pointing at `dist/index.js` and `dist/index.d.ts`, `files`
   containing only `dist`, `skills`, README, LICENSE and NOTICE (`skills/rig-<host>/SKILL.md`), `sideEffects: false`.
   Use peers for the engine and @rig-c/play; shared helpers are a development
   workspace dependency, bundled by the root library build, never a runtime
   dependency. Copy the licence and write host usage/notice files.
3. Register the host prefix and path in `scripts/release-plan.mjs` and the
   tag trigger in `.github/workflows/release.yml`. Add it to the PR CI dry-run
   pack loop and selector tests. New public hosts need an owner-configured npm
   trusted publisher before publication. See [RELEASING.md](../RELEASING.md).
4. Run `bun install`, `bun run verify`, then report the package tarball, installed
   exports, no-runtime graph, parity suite and release checks. Add the package
   to the README status table. Library and package discovery uses `packages/*`
   metadata. Add `packages/<host>/smoke.ts` using the exported `smoke(assets)`
   contract described in the Pixi entry.

`bun run check:release` is release-only. CI also runs
`bun scripts/check-host-scaffold.mjs`, which creates a private `_example`
workspace in a temporary copy, discovers its Chromium/WebKit suite, builds and
serves its production harness, and checks development source resolution without
changing either workflow. This canvas is a registration probe, not engine parity.
The scaffold is removed on exit, including failure.

## Publication boundary

A release PR bumps a host version; after CI and HQ sign-off it is merged.
The release tower pushes `<host>-vX.Y.Z` on that merged commit. The tag-triggered
`release.yml` publishes only that host, subject to `ADAPTERS_PUBLISH_ENABLED`,
with the `npm` environment, GitHub-hosted OIDC and provenance. It uses npm 12.2.2
on Node 22. Recovery dispatch must use the existing tag as both ref and input.
First-publication ownership and recovery commands are in
[RELEASING.md](../RELEASING.md). Verification runs no real publication.

## Development-only independent raster oracle

The Phaser mesh tests reuse play's unchanged official raster adapter from commit
`e23405131a3bc43a9934dfe7131e62aee1b0bab2` in `tests/oracle`. Its private package is
not a workspace and is excluded from every host package. `bun run typecheck` and
the test site's prebuild install its pinned runtime with `npm ci --ignore-scripts`
using its own committed lockfile; the first run therefore needs network access.
Failure is an error, never an oracle SKIP. The normal host graph remains runtime
free and the package and installed-consumer gates inspect that graph separately.
To intentionally regenerate the isolated lock, use the guarded Nova runner's
`--update-oracle-lock` preparation and retrieve `oracle-package-lock.json`.
