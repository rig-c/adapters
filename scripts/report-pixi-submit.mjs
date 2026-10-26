import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifySubmitProfile } from './submit-profile-reader.mjs';

const root = process.argv[2];
if (!root) throw Error('PROFILE_REPORT: expected the verification output directory');
const rows = [];
for (const invocation of [1, 2]) for (const skeleton of ['spineboy', 'raptor']) {
  const read = mode => JSON.parse(readFileSync(resolve(root, `profile-pass-${invocation}/${skeleton}-${mode}.json`)));
  const off = read('off');
  const split = read('split');
  const cpu = read('cpu-profile');
  const classification = classifySubmitProfile(cpu);
  const frames = split.measuredFrames;
  const transformsUs = classification.sampledCpuMicroseconds
    .filter(([name]) => name.startsWith('Pixi scene traversal, validation or transforms: ') && /: (updateTransformAndChildren|updateRenderGroupTransforms|updateRenderGroupTransform|updateLocalTransform)$/.test(name))
    .reduce((total, [, value]) => total + value, 0);
  rows.push({ invocation, skeleton, frames, gpu: split.gpu, offSubmit: off.submit,
    submit: split.submit, adapter: split.adapter, host: split.host,
    residual: split.residual, hostFractionMedian: split.hostShare.p50Ms,
    instrumentationP50ShiftPercent: (split.submit.p50Ms / off.submit.p50Ms - 1) * 100,
    drawCalls: [...new Set(split.frames.map(frame => frame.arms[1].drawCalls))],
    halvesPass: split.halves.every(half => half.pass),
    sampledTransformSelfMsPerFrame: transformsUs / frames / 1000,
    sampledSceneInclusiveMsPerFrame: (classification.sampledGroupMicroseconds['Pixi scene traversal, validation or transforms'] ?? 0) / frames / 1000,
    ...classification });
}
const betweenInvocations = ['spineboy', 'raptor'].map(skeleton => {
  const [a, b] = rows.filter(row => row.skeleton === skeleton);
  const shift = key => (b[key].p50Ms / a[key].p50Ms - 1) * 100;
  return { skeleton, submitP50ShiftPercent: shift('submit'), adapterP50ShiftPercent: shift('adapter'), hostP50ShiftPercent: shift('host') };
});
console.log(JSON.stringify({ protocol: 'submit-profile-report-v1', rows, betweenInvocations }, null, 2));
