# Contributing

`rig-c/adapters` houses the web renderer and engine adapters (`@rig-c/pixi`, `@rig-c/phaser`, and `@rig-c/three`) that draw `rig-c` models posed through [`@rig-c/play`](https://github.com/rig-c/play). Read [AGENTS.md](AGENTS.md) before writing a first patch.

## Getting the code running

From a clone, with [Bun](https://bun.sh) 1.4.4+ and Node.js 22+ on `PATH`:

```sh
bun install --frozen-lockfile
bun run fetch-assets
bun run build:libraries
bun run dev
```

`bun run fetch-assets` builds the public gallery and test rigs into `public/rigs/`. `bun run dev` starts the local Vite demo, `bun run example:look` opens the pointer-dial example, `bun run build` builds the libraries and demo site, and `bun run preview` serves the built site.

## Before you open a pull request

Run the workspace library build, typecheck, linter, package and smoke checks, look-example unit tests, and workspace pack checks from `package.json` and `.github/workflows/ci.yml`:

```sh
bun run build:libraries
bun run typecheck
bun run lint
bun run check:packages
bun run smoke
bun run test:look
```

Verify that each published workspace package (`packages/pixi`, `packages/phaser`, `packages/three`) packs its expected file list with `npm pack --dry-run`.

Headless browser checks require Playwright Chromium and WebKit (`PLAYWRIGHT_SKIP_BROWSER_GC=1 bunx --no-install playwright install chromium webkit`), a distinct `TEST_PORT` when multiple checkouts are active, and `PIXI_BASELINE_BUNDLE` prepared by `bun scripts/prepare-pixi-baseline.mjs` for the Pixi origin-baseline spec:

```sh
bun run check:release
bun run test
bun run test:bench
bun run bench -- --smoke --json
```

`bun run verify` chains `build:libraries`, `typecheck`, `lint`, `check:packages`, `check:release`, `smoke`, `test:look`, and `test`. Full `bun run bench` runs are long browser benchmarks and belong on an isolated machine.

## Reporting a change

- **Issue first.** Open an issue before making a change, stating the decision, the acceptance bars, the command that measures each bar, and what is out of scope.
- **One issue per pull request.** Keep each pull request scoped to a single issue.
- **Conventional Commits.** Write commit messages, code, and documentation in English using [Conventional Commits](https://www.conventionalcommits.org/) with a scope (`feat(pixi):`, `fix(three):`, `test(phaser):`, `docs(readme):`). Include no private material or local paths.

## Where further rules live

- [AGENTS.md](AGENTS.md) — oracle contract, measurement and mutant rules, and code review criteria.
- [README.md](README.md) — package overview and quick-start examples.
- [NOTICE](NOTICE) and [LICENSE](LICENSE) — attribution and MIT licence terms.
