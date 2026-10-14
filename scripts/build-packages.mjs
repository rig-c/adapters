import { build } from 'tsup';
import { publishable } from './workspaces.mjs';

const selected = process.argv.includes('--package') ? process.argv[process.argv.indexOf('--package') + 1] : undefined;
const packages = publishable().filter((pkg) => selected === undefined || pkg.path === selected);
if (packages.length === 0) throw new Error(`BUILD_PACKAGE: no publishable package matches ${selected ?? '(all)'}`);
for (const pkg of packages) {
  await build({
    entry: [ `${pkg.dir}/src/index.ts` ],
    outDir: `${pkg.dir}/dist`,
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    dts: true,
    splitting: false,
    clean: true,
    external: Object.keys(pkg.peerDependencies ?? {}),
    noExternal: ['@rig-c/adapters-shared'],
    tsconfig: `${pkg.dir}/tsconfig.build.json`,
  });
  console.log(`BUILD_PACKAGE: ${pkg.name} -> ${pkg.path}/dist (ESM + declarations)`);
}
