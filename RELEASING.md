# Releasing

Each host has an independent version and tag: `pixi-vX.Y.Z`,
`phaser-vX.Y.Z`, or `three-vX.Y.Z`. One tag publishes one package.

1. Prepare a release PR that bumps the chosen host's `package.json` version
   and records its changes in that host's changelog. Keep the root private.
2. Wait for PR CI, review and HQ sign-off, then merge the release PR.
3. The release tower creates the matching tag on the merged commit and pushes
   that tag. Creating a version commit or merging a PR alone publishes nothing.
4. `.github/workflows/release.yml` validates the tag and publishes that host
   with `npm publish --access public --provenance --ignore-scripts`.

Publication retains `ADAPTERS_PUBLISH_ENABLED=true`, the `npm` environment,
GitHub-hosted runners and publish-job-only `id-token: write`. No npm token is
needed. The workflow filename and environment are trusted-publisher identity
fields and must not change without the owner's npm configuration decision.
Node 22 and npm **12.2.2** run the release build/package checks; PR CI runs the
same build and package checks and finishes with dry-run packs for all hosts.

The selector refuses a non-tag ref, malformed tag, dispatch/tag mismatch,
a remote/fetched tag or HEAD that differs from `GITHUB_SHA`, a commit not
reachable from `origin/main`, a package name/version mismatch, an already
served version, or a version below a served stable version. Registry lookup
failures refuse publication. npm provenance names `GITHUB_SHA`, so checking out
another commit cannot repair a mismatched run.

For recovery, dispatch on the existing tag and supply the same tag input:

```sh
gh workflow run release.yml --ref pixi-vX.Y.Z -f tag=pixi-vX.Y.Z
```

Do not move tags or retry an already published version. Confirm the version
on npm after publication. Recovery runs the workflow from the tagged tree;
it cannot retrofit this workflow onto older tags.

## Publisher identity and first publication

A tag run presents `refs/tags/<host>-vX.Y.Z` and workflow
`rig-c/adapters/.github/workflows/release.yml@refs/tags/<host>-vX.Y.Z`, with
environment `npm`. This differs from the earlier main-branch provenance.
The [npm GitHub trusted-publisher configuration](https://docs.npmjs.com/trusted-publishers/)
selects organization, repository, workflow filename and optional environment;
it has no branch/tag-ref field. GitHub environment deployment restrictions
are separate and must permit the release tags. These documented fields do not
prove an individual package's live npm settings or a successful OIDC exchange.

For an unpublished host, stop for the owner to bootstrap publication and
configure its trusted publisher: organization `rig-c`, repository `adapters`,
workflow filename `release.yml`, environment `npm`, direct publication allowed.
No local dry run claims provenance or publisher acceptance.

## Verification

`bun scripts/check-pack-json.mjs` checks npm 11 array and npm 12 keyed-object
pack output and planted malformed inputs. `bun run check:release` checks tag
selection, workflow identity and publication refusal controls with confined
command fixtures; it never publishes. The existing CI browser scaffold checks
run separately through `bun scripts/check-host-scaffold.mjs`.
