/** Read frozen hardware receipts; never infer a pass from missing samples. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assertFixtureMeasurements } from './hardware-fixtures.mjs';
import { judgeLaunchMedians } from './hardware-statistics.mjs';
import { assertCaptureProtocol, DECISION_PROTOCOL } from './hardware-protocol.mjs';

const roots = process.argv.slice(2);
if (!roots.length) throw Error('HARDWARE_SUMMARY_INPUT: provide capture directories');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const machines = [];
const stats = values => {
  if (values.length !== 180 || values.some(v => !Number.isFinite(v))) throw Error('HARDWARE_SUMMARY_SAMPLES');
  const sorted = [...values].sort((a, b) => a - b), q = p => sorted[Math.floor((sorted.length - 1) * p)];
  return { p05Ms: q(.05), p50Ms: q(.5), p95Ms: q(.95), samples: values.length };
};

for (const root of roots) {
  const files = readdirSync(root).filter(file => /^(AA|AB)\d+\.json$/.test(file));
  const pairs = files.length / 2;
  // Two pairs retain the historical reader control; new captures have 3 or 6.
  const phaseOrder = pairs === 2 ? ['AA1', 'AA2', 'AB1', 'AB2'] :
    Array.from({ length: Math.min(pairs, 6) }, (_, i) => [`AA${i + 1}`, `AB${i + 1}`]).flat();
  if (![2, 3, 6].includes(pairs) || phaseOrder.some(phase => !files.includes(`${phase}.json`))) {
    throw Error(`HARDWARE_SUMMARY_PHASE_SET: found ${files.sort().join(',')}; needed complete pairs 1..2, 1..3 or 1..6`);
  }
  const records = {}, hashes = {};
  let captureProtocol;
  for (const phase of phaseOrder) {
    const bytes = readFileSync(resolve(root, `${phase}.json`));
    hashes[phase] = sha(bytes);
    const r = records[phase] = JSON.parse(bytes);
    if (r.phase !== phase || r.status !== 'passed' || !Array.isArray(r.rows) || r.rows.length !== 4) throw Error(`HARDWARE_SUMMARY_PHASE: ${phase}`);
    captureProtocol = assertCaptureProtocol(r.manifest, pairs);
    assertFixtureMeasurements(r.manifest?.assets, r.fixtureMeasurements, phase);
    if (!r.gpu.renderer || /SwiftShader|software|llvmpipe/i.test(r.gpu.renderer)) throw Error('HARDWARE_SUMMARY_GPU');
    if (!r.checks.drawCallMutants.pass) throw Error('HARDWARE_SUMMARY_DRAW_MUTANTS');
    for (const skeleton of ['spineboy', 'raptor']) {
      const controls = r.checks[skeleton];
      const expectedArms = ['rig-c-pixi', 'rig-c-pixi-compare'];
      if (!Array.isArray(controls) || controls.length !== expectedArms.length || expectedArms.some(arm => controls.filter(c => c?.arm === arm).length !== 1) || controls.some(c => typeof c?.positive?.pass !== 'boolean' || typeof c?.mutant?.pass !== 'boolean')) throw Error(`HARDWARE_SUMMARY_CONTROLS: ${phase} ${skeleton} needs one positive and mutant outcome per expected arm`);
      for (const control of controls) if (!control.positive.pass || control.mutant.pass) throw Error('HARDWARE_SUMMARY_ORACLE');
    }
    const workloads = r.rows.map(row => `${row.skeleton}/${row.instances}`);
    if (JSON.stringify(workloads) !== JSON.stringify(['spineboy/1', 'spineboy/100', 'raptor/1', 'raptor/100'])) throw Error('HARDWARE_SUMMARY_WORKLOADS');
    for (const row of r.rows) {
      if (row.frames.length !== 180 || row.warmupFrames !== 60 || row.halves.length !== 6 || !row.halves.every(h => h.pass) || !row.drawCallsPass) throw Error('HARDWARE_SUMMARY_ROW');
      row.metrics = {};
      for (const metric of ['poseMs', 'submitMs', 'cpuMs']) row.metrics[metric] = {
        a: stats(row.frames.map(f => f.arms[0][metric])), b: stats(row.frames.map(f => f.arms[1][metric])), paired: stats(row.frames.map(f => f.arms[1][metric] - f.arms[0][metric])),
      };
      if (row.gpuStatus === 'available') {
        if (row.gpuSamplesMs.length !== 180 || row.gpuSamplesMs.some(pair => pair.length !== 2 || pair.some(v => v === null || !Number.isFinite(v) || v < 0))) throw Error('HARDWARE_SUMMARY_GPU_SAMPLES');
        row.metrics.gpuMs = { a: stats(row.gpuSamplesMs.map(f => f[0])), b: stats(row.gpuSamplesMs.map(f => f[1])), paired: stats(row.gpuSamplesMs.map(f => f[1] - f[0])) };
      } else row.metrics.gpuMs = null;
      for (let f = 0; f < row.frames.length; f++) if (JSON.stringify(row.frames[f].order) !== JSON.stringify(f % 2 ? [...row.arms].reverse() : row.arms)) throw Error('HARDWARE_SUMMARY_ORDER');
    }
  }
  const rr = Object.values(records);
  for (const r of rr) if (JSON.stringify(r.manifest.bundles) !== JSON.stringify(rr[0].manifest.bundles) || JSON.stringify(r.manifest.assets) !== JSON.stringify(rr[0].manifest.assets) || r.browser !== rr[0].browser || r.gpu.renderer !== rr[0].gpu.renderer) throw Error('HARDWARE_SUMMARY_PROVENANCE');
  for (let i = 0; i < phaseOrder.length; i++) {
    const r = records[phaseOrder[i]], start = Date.parse(r.started), finish = Date.parse(r.finished);
    if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start || (i > 0 && Date.parse(records[phaseOrder[i - 1]].finished) > start)) {
      throw Error(`HARDWARE_SUMMARY_LAUNCH_ORDER: ${phaseOrder[i]} needs a fresh nonoverlapping launch in ${phaseOrder.join(' ')}`);
    }
  }
  const summarizeStage = count => {
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const first = rr[0].rows[i];
      for (const metric of ['poseMs', 'submitMs', 'cpuMs', 'gpuMs']) {
        const aa = Array.from({ length: count }, (_, n) => records[`AA${n + 1}`].rows[i].metrics[metric]);
        const ab = Array.from({ length: count }, (_, n) => records[`AB${n + 1}`].rows[i].metrics[metric]);
        if ([...aa, ...ab].some(v => v === null)) { rows.push({ skeleton: first.skeleton, instances: first.instances, metric, verdict: 'unmeasured' }); continue; }
        // This maximum cannot shrink when further AA launches are added.
        const envelopeMs = Math.max(...aa.flatMap(v => [Math.abs(v.paired.p05Ms), Math.abs(v.paired.p95Ms)]));
        const deltaMs = ab.map(v => v.paired.p50Ms);
        rows.push({ skeleton: first.skeleton, instances: first.instances, metric, envelopeMs, aa, ab, deltaMs,
          ...judgeLaunchMedians(aa.map(v => v.paired.p50Ms), deltaMs) });
      }
    }
    return { pairs: count, rows };
  };
  const stages = (pairs === 6 ? [3, 6] : [pairs]).map(summarizeStage);
  const rows = stages.at(-1).rows;
  const output = { machine: rr[0].gpu, browser: rr[0].browser, clockMinStepMs: rr.map(r => r.clockMinStepMs), crossOriginIsolated: rr.every(r => r.crossOriginIsolated), input: rr[0].manifest,
    fixtureMeasurements: Object.fromEntries(rr.map(r => [r.phase, r.fixtureMeasurements])), rawSha256: hashes,
    phaseOrder, stages, captureProtocol, decisionProtocol: DECISION_PROTOCOL, decisionStatistic: 'descriptive 95% t intervals of launch paired medians; adaptive repeated looks and multiple comparisons are not coverage-adjusted', checks: { frames: rr.reduce((n, r) => n + r.rows.reduce((n, x) => n + x.frames.length, 0), 0), halves: rr.reduce((n, r) => n + r.rows.reduce((n, x) => n + x.halves.length, 0), 0), aaBeforeAb: pairs === 2, interleaved: pairs !== 2, launchPairs: pairs }, rows };
  writeFileSync(resolve(root, 'summary.json'), JSON.stringify(output, null, 2));
  const f = n => n.toFixed(6);
  const lines = ['# Hardware capture', '', rr[0].gpu.renderer, '', `Browser: ${rr[0].browser}`, '', `Capture protocol: ${captureProtocol}; decision protocol: ${DECISION_PROTOCOL}`, '', 'Paired candidate minus base milliseconds. Decisions use descriptive 95% t intervals of launch paired medians: AB upper < 0, AB upper < AA lower, and every AB median negative. Adaptive repeated looks and multiple comparisons have no sequential or family-wise coverage guarantee. CI width need not shrink when launches are added. The legacy AA envelope is comparison only and cannot decrease.'];
  for (const stage of stages) {
    const labels = Array.from({ length: stage.pairs }, (_, i) => `AB${i + 1}`).join(' / ');
    lines.push('', `## Stage: ${stage.pairs} AA and ${stage.pairs} AB launches`, '', `| Input | Instances | Metric | A p50 (${labels}) | B p50 (${labels}) | Legacy AA envelope | AA mean [95% CI] | AB mean [95% CI] | AB paired p50 | Verdict |`, '|---|---:|---|---|---|---:|---|---|---|---|');
    for (const row of stage.rows) lines.push(row.verdict === 'unmeasured' ? `| ${row.skeleton} | ${row.instances} | ${row.metric} | — | — | — | — | — | — | unmeasured |` : `| ${row.skeleton} | ${row.instances} | ${row.metric} | ${row.ab.map(v => f(v.a.p50Ms)).join(' / ')} | ${row.ab.map(v => f(v.b.p50Ms)).join(' / ')} | ${f(row.envelopeMs)} | ${f(row.aaInterval.meanMs)} [${f(row.aaInterval.lowerMs)}, ${f(row.aaInterval.upperMs)}] | ${f(row.abInterval.meanMs)} [${f(row.abInterval.lowerMs)}, ${f(row.abInterval.upperMs)}] | ${row.deltaMs.map(f).join(' / ')} | ${row.verdict} |`);
  }
  writeFileSync(resolve(root, 'summary.md'), lines.join('\n') + '\n');
  machines.push({ renderer: rr[0].gpu.renderer, checks: output.checks, improvements: rows.filter(r => r.verdict.startsWith('improvement')).map(r => `${r.skeleton}/${r.instances}/${r.metric}`) });
}
console.log('HARDWARE_SUMMARY', JSON.stringify(machines));
