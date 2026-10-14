/** Public fixture URL used by every host parity harness. */
export function fixtureModelUrl(name: string): string {
  return `/rigs/${name}/skeleton.model.json`;
}
