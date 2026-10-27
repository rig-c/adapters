/* Browser side of the #62 capture; raw same-frame data is retained. */
import '/main.js';
import { verifyFixtureBytes } from '/fixtures.js';
const params = new URLSearchParams(location.search);
const phase = params.get('phase');
const precheck = phase === 'precheck';
const candidate = phase?.startsWith('AB') ? 'new' : 'old';
const report = { phase, started: new Date().toISOString(), rows: [], checks: {} };
const stats = values => {
  const s = [...values].sort((a,b)=>a-b);
  const q = p => s[Math.floor((s.length-1)*p)];
  return { p05Ms:q(.05), p50Ms:q(.5), p95Ms:q(.95), samples:s.length };
};
let fixtures;
try {
  const bench = window.__rigBench;
  report.manifest = await (await fetch('/manifest.json')).json();
  report.fixtureMeasurements = {};
  fixtures = await verifyFixtureBytes(report.manifest.assets, report.fixtureMeasurements);
  bench.useVerifiedFixtures(fixtures);
  report.gpu = await bench.getGpuInfo();
  if (typeof report.gpu.renderer !== 'string' || /SwiftShader|llvmpipe|software/i.test(report.gpu.renderer)) throw Error(`HARDWARE_REQUIRED: ${report.gpu.renderer}`);
  report.browser = navigator.userAgent;
  report.dpr = devicePixelRatio;
  if (report.dpr !== 1) throw Error(`HARDWARE_DPR: found ${report.dpr}, needed 1`);
  report.crossOriginIsolated = crossOriginIsolated;
  const clocks = []; let last = performance.now();
  for (let i=0;i<10000;i++) { const t=performance.now(); if(t>last) clocks.push(t-last); last=t; }
  report.clockMinStepMs = clocks.length ? Math.min(...clocks) : null;
  await bench.registerCompareBundle({ moduleUrl:`/${candidate}.js`, label:candidate });
  report.checks.drawCallMutants = await bench.checkDrawCallMutants();
  if (!report.checks.drawCallMutants.pass) throw Error('HARDWARE_DRAW_MUTANT_SURVIVED');
  for (const skeleton of ['spineboy','raptor']) {
    const checks=[];
    for (const arm of ['rig-c-pixi','rig-c-pixi-compare']) {
      const positive=await bench.checkCorrectness(skeleton,{arm,times:[0,.35,.7],mutant:'none'});
      const mutant=await bench.checkCorrectness(skeleton,{arm,times:[0,.35,.7],mutant:'time-offset'});
      checks.push({arm,positive,mutant});
      if (!positive.pass || mutant.pass) throw Error(`HARDWARE_PICTURE_GATE: ${skeleton}/${arm}`);
    }
    report.checks[skeleton]=checks;
    for (const instances of precheck ? [1] : [1,100]) {
      const row=await bench.runSameFramePair(skeleton,['rig-c-pixi','rig-c-pixi-compare'],instances,{warmupFrames:precheck?2:60,measuredFrames:precheck?8:180});
      if(!row.drawCallsPass || !row.halves.every(h=>h.pass)) throw Error('HARDWARE_ROW_GATE');
      row.metrics={};
      for(const metric of ['poseMs','submitMs','cpuMs']) row.metrics[metric]={
        a:stats(row.frames.map(f=>f.arms[0][metric])), b:stats(row.frames.map(f=>f.arms[1][metric])), paired:stats(row.frames.map(f=>f.arms[1][metric]-f.arms[0][metric]))
      };
      row.metrics.gpuMs=row.gpuStatus==='available'?{a:stats(row.gpuSamplesMs.map(f=>f[0])),b:stats(row.gpuSamplesMs.map(f=>f[1])),paired:stats(row.gpuSamplesMs.map(f=>f[1]-f[0]))}:null;
      if(precheck) {
        const planted=await bench.runSameFramePair(skeleton,['rig-c-pixi','rig-c-pixi-compare'],instances,{warmupFrames:2,measuredFrames:8,busyArm:'rig-c-pixi-compare',busyMs:12});
        const shift=planted.cpuPairedDifference.p50Ms-row.cpuPairedDifference.p50Ms;
        if(shift<=8) throw Error(`HARDWARE_CPU_MUTANT_SURVIVED: ${shift}`);
        row.busyControlShiftMs=shift;
      }
      report.rows.push(row);
    }
  }
  report.status='passed';
} catch(error) { report.status='failed'; report.error=String(error?.stack??error); }
finally { fixtures?.dispose(); }
report.finished=new Date().toISOString();
document.body.textContent=JSON.stringify({phase,status:report.status,error:report.error});
await fetch(`/result/${phase}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(report)});
