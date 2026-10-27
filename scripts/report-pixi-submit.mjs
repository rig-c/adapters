/** Replay the sealed explicit-frame component profile; never infer missing rows. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readComponents } from './submit-components.mjs';
const directory=process.argv[2];
if(!directory || directory==='--help') {
  console.log('bun scripts/report-pixi-submit.mjs <submit-components output directory>');
  process.exit(directory?0:2);
}
const read=name=>JSON.parse(readFileSync(resolve(directory,`${name}.json`),'utf8'));
const on=read('raptor-profile'),off=read('raptor-off');
const table=readComponents(on,100,180);
console.log(JSON.stringify({protocol:'explicit-frame-submit-components-v2',workload:'raptor/100',
  warmupFrames:on.warmupFrames,measuredFrames:on.measuredFrames,gpu:on.gpu,table,
  uninstrumentedSubmit:off.submit,instrumentedSubmit:on.submit,
  instrumentationP50ShiftMs:on.submit.p50Ms-off.submit.p50Ms,
  fixtureMeasurements:on.fixtureMeasurements,loadBefore:on.loadBefore,loadAfter:on.loadAfter,
  interpretation:'CPU component profile only; no hardware acceptance or overhead-corrected timing claim'},null,2));
