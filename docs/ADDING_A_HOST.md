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

The first publish and publication enable step are the owner's actions. Verification
runs no real `npm publish`. Publication remains disabled until the owner sets the
repository variable `ADAPTERS_PUBLISH_ENABLED=true`; release PRs and plans can run
beforehand.
Automated publication uses npm trusted publishing without an npm token secret.
The workflow grants `id-token: write`, runs on GitHub-hosted `ubuntu-latest`,
and installs npm 11.5.1 on Node 22. npm requires Node >=22.14.0 and npm >=11.5.1
for [trusted publishing](https://docs.npmjs.com/trusted-publishers/).
Enabled execution missing GitHub-hosted Actions OIDC request context fails as
`PUBLISH_PROVENANCE` before invoking npm. The preflight checks context presence;
npm verifies the real token and configured publisher during publication.
The release check uses a confined npm stub to verify both refusal and the
token-free command path; it does not exchange an OIDC token or publish a package.

`@rig-c/pixi` 0.1.0 is already bootstrapped on npm and in the
[`pixi-v0.1.0` GitHub release](https://github.com/rig-c/adapters/releases/tag/pixi-v0.1.0).
Its next release uses the trusted-publishing workflow after the owner enables the
gate; do not repeat the initial 0.1.0 publication.

For a new, unpublished host package, build/check first and stop for the owner:

```sh
bun install --frozen-lockfile
bun run build:libraries
bun run check:packages
bun run smoke
```

From that unpublished host's package directory, the owner may run
`npm publish --access public --ignore-scripts` for its first local publication
with npm 2FA; local publication does not claim npm provenance. For automated
publication, the owner configures the package's npm trusted publisher
for GitHub organization `rig-c`, repository `adapters`, workflow filename
`release.yml` and environment `npm`, allowing direct `npm publish`. The workflow
and environment names must match the run's identity; each new host package needs
its own trusted publisher. After checking package contents/version, scope rights
and the GitHub `npm` environment, the owner enables publication. Subsequent merged
release PRs select all released host paths through the same pipeline.
The owner-only `workflow_dispatch` on `main` can bootstrap a new host or retry
a released version that npm has not received; `publish_packages` is a JSON array
of those workspace paths. It must not select an already published version.
For Pixi, the workflow runs the exact
package command `npm publish --access public --provenance --ignore-scripts` from
`packages/pixi`. After any first publication, the owner confirms the version
is available on npm and bootstraps the matching host tag/release before normal
release bumps.
