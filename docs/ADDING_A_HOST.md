# Adding a host

One workspace per host, one manifest release component per publishable package.
The root stays private and owns CI, public fixture building and the demo.

1. Create `packages/<host>/src/index.ts`, `packages/<host>/tests/<host>.spec.ts`
   and `packages/<host>/tsconfig.build.json` following `packages/pixi`. The parity
   suite must compare the host's drawing with @rig-c/play's PosedFrame and same-
   browser CanvasRenderer, keeping declared tolerances and planted failures.
   Playwright discovers `packages/*/tests/*.spec.ts`; no workflow edit is needed.
2. Add `package.json`: name `@rig-c/<host>`, independent starting version, ESM,
   typed `.` export pointing at `dist/index.js` and `dist/index.d.ts`, `files`
   containing only `dist`, README, LICENSE and NOTICE, `sideEffects: false`.
   Use peers for the engine and @rig-c/play; shared helpers are a development
   workspace dependency, bundled by the root library build, never a runtime
   dependency. Copy the licence and write host usage/notice files.
3. Add one `packages/<host>` component to `release-please-config.json` and one
   version row to `.release-please-manifest.json`. Match the package version.
   Release-please is manifest mode with separate package PRs; there is one release
   workflow. Shared helper changes that need a host release must include a
   Conventional Commit change under each affected host, rather than silently
   releasing all hosts or treating shared as a published component.
4. Run `bun install`, `bun run verify`, then report the package tarball, installed
   exports, no-runtime graph, parity suite and release dry run. Add the package
   to the README status table. CI/library/pack discovery comes from `packages/*`
   metadata. Release publication comes from release-please's `paths_released`.
   Add a host smoke entry at `packages/<host>/smoke.ts` using the exported
   `smoke(assets)` contract described in the Pixi entry; the generic installed
   smoke runner imports every declared runtime export and renders its walk frame.

`bun run check:release` follows these steps in a temporary copy for `_example`:
its package is private (never published), but is temporarily registered in the
release manifest solely to exercise the actual release-please dry-run algorithm.
It supplies confined commits for Pixi and `_example` in separate runs, checks
that only the matching component receives a PR, discovers the example parity
suite, and builds/serves its harness in a real headless production-preview test
without changing either workflow. The example canvas is a scaffold registration
probe, not a claim of engine parity. The scaffold is removed on exit, even
when the check fails. Its read-only GitHub fixture is input to release-please,
not a substitute implementation of release selection.

## Publication boundary

The first publish is the owner's action with npm 2FA. This change runs no
`npm publish`. Publication remains disabled until the owner sets the repository
variable `ADAPTERS_PUBLISH_ENABLED=true`; release PRs and plans can run beforehand.
Enabled publication with missing NPM_TOKEN fails as `PUBLISH_CREDENTIALS`.
All automated publications use `--provenance` in the GitHub Actions `npm`
environment with `id-token: write`, for this public repository. The owner checks
package contents/version, npm scope rights, 2FA and the environment/secrets before
that enable step. Never add a credential to a file or command line.

For the current package, build/check first and stop for the owner:

```sh
bun install --frozen-lockfile
bun run build:libraries
bun run check:packages
bun run smoke
cd packages/pixi
npm publish --access public --ignore-scripts
```

The final line is the owner-only first local publication and prompts for npm 2FA;
local publication does not claim npm provenance. To obtain provenance on the
first release, the owner instead configures the GitHub Actions npm environment
and NPM_TOKEN, enables publication, and manually dispatches the `release` workflow
on `main` with `publish_packages=["packages/pixi"]`. The workflow runs the exact
package command `npm publish --access public --provenance --ignore-scripts` from
`packages/pixi`. Subsequent merged release PRs select all released host paths
through the same pipeline. The owner must confirm 0.1.0 is available on npm before
treating installation examples as published, and should bootstrap the GitHub tag
`pixi-v0.1.0`/release to match the first npm version before normal release bumps.
