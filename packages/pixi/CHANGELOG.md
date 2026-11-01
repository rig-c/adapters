# Changelog

## [0.2.0](https://github.com/rig-c/adapters/compare/pixi-v0.1.8...pixi-v0.2.0) (2026-11-01)


### Features

* ship an agent skill in each host package ([#123](https://github.com/rig-c/adapters/issues/123)) ([17509a1](https://github.com/rig-c/adapters/commit/17509a12a738749d94ecf6d5979340411f2080b1)), closes [#121](https://github.com/rig-c/adapters/issues/121)

## [0.1.8](https://github.com/rig-c/adapters/compare/pixi-v0.1.7...pixi-v0.1.8) (2026-11-01)


### Bug Fixes

* **readme:** show the npm badges ([#117](https://github.com/rig-c/adapters/issues/117)) ([ff4505a](https://github.com/rig-c/adapters/commit/ff4505aa67510b60f39fb02a0c9700fe70f9a87d)), closes [#116](https://github.com/rig-c/adapters/issues/116)

## [0.1.7](https://github.com/rig-c/adapters/compare/pixi-v0.1.6...pixi-v0.1.7) (2026-11-01)


### Bug Fixes

* show the shared banner ([#112](https://github.com/rig-c/adapters/issues/112)) ([1bed128](https://github.com/rig-c/adapters/commit/1bed1281f3b760d1a803eb652eeb3069a687b84c)), closes [#111](https://github.com/rig-c/adapters/issues/111)

## [0.1.6](https://github.com/rig-c/adapters/compare/pixi-v0.1.5...pixi-v0.1.6) (2026-10-28)


### Performance Improvements

* **shared:** skip re-translating a frozen attachment's draw-view metadata when its identity is unchanged ([#97](https://github.com/rig-c/adapters/issues/97)) ([9ca5d38](https://github.com/rig-c/adapters/commit/9ca5d3820140ce2b36ac4304f968212f122695af)), closes [#96](https://github.com/rig-c/adapters/issues/96)

## [0.1.5](https://github.com/rig-c/adapters/compare/pixi-v0.1.4...pixi-v0.1.5) (2026-10-27)


### Performance Improvements

* **phaser, three:** consume the player's live-frame lease instead of posedFrame() snapshots ([#81](https://github.com/rig-c/adapters/issues/81)) ([b532d2f](https://github.com/rig-c/adapters/commit/b532d2f40943a711b1f3ffb250b1826c425648d5))
* **pixi:** copy mesh positions natively and keep per-tuple validation in checked mode ([#80](https://github.com/rig-c/adapters/issues/80)) ([b5e072f](https://github.com/rig-c/adapters/commit/b5e072f959d40e9b7bf9d91c27b68d6e660f9087))
* **pixi:** stop the live loop allocating a draw-order Map and a typed-array view per mesh every frame ([#89](https://github.com/rig-c/adapters/issues/89)) ([d859c20](https://github.com/rig-c/adapters/commit/d859c2052e30fe93a7b740afb0544c8d62d8051d))
* **shared:** reuse the retained capture's dark and clip buffers instead of copying them per capture ([#87](https://github.com/rig-c/adapters/issues/87)) ([a06c80f](https://github.com/rig-c/adapters/commit/a06c80f047e39d44174ffb1a2dcef96e744423b6))

## [0.1.4](https://github.com/rig-c/adapters/compare/pixi-v0.1.3...pixi-v0.1.4) (2026-10-27)


### Performance Improvements

* **pixi:** cut the submit residual of the live-frame lease — frozen-field validation cache and whole-buffer copies ([#74](https://github.com/rig-c/adapters/issues/74)) ([0bc82ba](https://github.com/rig-c/adapters/commit/0bc82ba22010eff4a6f3fd9bd1f5736a81dfa5fa))

## [0.1.3](https://github.com/rig-c/adapters/compare/pixi-v0.1.2...pixi-v0.1.3) (2026-10-27)


### Performance Improvements

* **pixi:** consume the player's live-frame lease instead of posedFrame() snapshots ([#69](https://github.com/rig-c/adapters/issues/69)) ([6e700a2](https://github.com/rig-c/adapters/commit/6e700a2e37f812eafd9aaf4efe3d1c4ef9e23fd3))

## [0.1.2](https://github.com/rig-c/adapters/compare/pixi-v0.1.1...pixi-v0.1.2) (2026-10-26)


### Performance Improvements

* **pixi:** batch multi-instance rigs and large meshes ([#41](https://github.com/rig-c/adapters/issues/41)) ([#42](https://github.com/rig-c/adapters/issues/42)) ([ff1f283](https://github.com/rig-c/adapters/commit/ff1f28370528c89ad03ec724c4679ee1b8b2cd28))

## [0.1.1](https://github.com/rig-c/adapters/compare/pixi-v0.1.0...pixi-v0.1.1) (2026-10-15)


### Bug Fixes

* add package metadata and install usage across pixi, phaser and three ([#27](https://github.com/rig-c/adapters/issues/27)) ([#28](https://github.com/rig-c/adapters/issues/28)) ([eee426c](https://github.com/rig-c/adapters/commit/eee426c1da7d9a5713813fb2e9a829e39be6064c))
