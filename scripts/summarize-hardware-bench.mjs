/** Read frozen #62 raw receipts; never infer a pass from missing samples. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const roots=process.argv.slice(2);if(!roots.length)throw Error('HARDWARE_SUMMARY_INPUT: provide capture directories');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const machines=[];
const stats=values=>{
 if(values.length!==180||values.some(v=>!Number.isFinite(v)))throw Error('HARDWARE_SUMMARY_SAMPLES');
 const sorted=[...values].sort((a,b)=>a-b),q=p=>sorted[Math.floor((sorted.length-1)*p)];
 return {p05Ms:q(.05),p50Ms:q(.5),p95Ms:q(.95),samples:values.length};
};
for(const root of roots){
 const records={};const hashes={};
 for(const phase of ['AA1','AA2','AB1','AB2']){
  const bytes=readFileSync(resolve(root,phase+'.json'));hashes[phase]=sha(bytes);records[phase]=JSON.parse(bytes);
  const r=records[phase];if(r.phase!==phase||r.status!=='passed'||r.rows.length!==4)throw Error('HARDWARE_SUMMARY_PHASE: '+phase);
  if(!r.gpu.renderer||/SwiftShader|software|llvmpipe/i.test(r.gpu.renderer))throw Error('HARDWARE_SUMMARY_GPU');
  if(!r.checks.drawCallMutants.pass)throw Error('HARDWARE_SUMMARY_DRAW_MUTANTS');
  for(const skeleton of ['spineboy','raptor']){
   const controls=r.checks[skeleton];
   const expectedArms=['rig-c-pixi','rig-c-pixi-compare'];
   if(!Array.isArray(controls)||controls.length!==expectedArms.length||expectedArms.some(arm=>controls.filter(c=>c?.arm===arm).length!==1)||controls.some(c=>typeof c?.positive?.pass!=='boolean'||typeof c?.mutant?.pass!=='boolean'))throw Error(`HARDWARE_SUMMARY_CONTROLS: ${phase} ${skeleton} needs one positive and mutant outcome per expected arm`);
   for(const control of controls)if(!control.positive.pass||control.mutant.pass)throw Error('HARDWARE_SUMMARY_ORACLE');
  }
  const workloads=r.rows.map(row=>`${row.skeleton}/${row.instances}`);
  if(JSON.stringify(workloads)!==JSON.stringify(['spineboy/1','spineboy/100','raptor/1','raptor/100']))throw Error('HARDWARE_SUMMARY_WORKLOADS');
  for(const row of r.rows){
   if(row.frames.length!==180||row.warmupFrames!==60||row.halves.length!==6||!row.halves.every(h=>h.pass)||!row.drawCallsPass)throw Error('HARDWARE_SUMMARY_ROW');
   row.metrics={};
   for(const metric of ['poseMs','submitMs','cpuMs'])row.metrics[metric]={
    a:stats(row.frames.map(f=>f.arms[0][metric])),b:stats(row.frames.map(f=>f.arms[1][metric])),paired:stats(row.frames.map(f=>f.arms[1][metric]-f.arms[0][metric]))
   };
   if(row.gpuStatus==='available'){
    if(row.gpuSamplesMs.length!==180||row.gpuSamplesMs.some(pair=>pair.length!==2||pair.some(v=>v===null||!Number.isFinite(v)||v<0)))throw Error('HARDWARE_SUMMARY_GPU_SAMPLES');
    row.metrics.gpuMs={a:stats(row.gpuSamplesMs.map(f=>f[0])),b:stats(row.gpuSamplesMs.map(f=>f[1])),paired:stats(row.gpuSamplesMs.map(f=>f[1]-f[0]))};
   }else row.metrics.gpuMs=null;
   for(let f=0;f<row.frames.length;f++)if(JSON.stringify(row.frames[f].order)!==JSON.stringify(f%2?[...row.arms].reverse():row.arms))throw Error('HARDWARE_SUMMARY_ORDER');
  }
 }
 const rr=Object.values(records);
 for(const r of rr)if(JSON.stringify(r.manifest.bundles)!==JSON.stringify(rr[0].manifest.bundles)||JSON.stringify(r.manifest.assets)!==JSON.stringify(rr[0].manifest.assets)||r.browser!==rr[0].browser||r.gpu.renderer!==rr[0].gpu.renderer)throw Error('HARDWARE_SUMMARY_PROVENANCE');
 if(Date.parse(records.AA2.finished)>Date.parse(records.AB1.started))throw Error('HARDWARE_SUMMARY_AA_ORDER');
 const rows=[];
 for(let i=0;i<4;i++){
  const first=rr[0].rows[i];
  for(const metric of ['poseMs','submitMs','cpuMs','gpuMs']){
   const aa=[records.AA1.rows[i],records.AA2.rows[i]].map(r=>r.metrics[metric]);
   const ab=[records.AB1.rows[i],records.AB2.rows[i]].map(r=>r.metrics[metric]);
   if([...aa,...ab].some(v=>v===null)){rows.push({skeleton:first.skeleton,instances:first.instances,metric,verdict:'unmeasured'});continue;}
   const envelopeMs=Math.max(...aa.flatMap(v=>[Math.abs(v.paired.p05Ms),Math.abs(v.paired.p95Ms)]));
   const deltaMs=ab.map(v=>v.paired.p50Ms);
   rows.push({skeleton:first.skeleton,instances:first.instances,metric,envelopeMs,aa,ab,deltaMs,verdict:deltaMs.every(d=>d < -envelopeMs)?'improvement outside A/A envelope':'unresolved by A/A envelope'});
  }
 }
 const output={machine:rr[0].gpu,browser:rr[0].browser,clockMinStepMs:rr.map(r=>r.clockMinStepMs),crossOriginIsolated:rr.every(r=>r.crossOriginIsolated),input:rr[0].manifest,rawSha256:hashes,checks:{frames:rr.reduce((n,r)=>n+r.rows.reduce((n,x)=>n+x.frames.length,0),0),halves:rr.reduce((n,r)=>n+r.rows.reduce((n,x)=>n+x.halves.length,0),0),aaBeforeAb:true},rows};
 writeFileSync(resolve(root,'summary.json'),JSON.stringify(output,null,2));
 const f=n=>n.toFixed(6);
 const lines=['# Hardware capture', '',rr[0].gpu.renderer,'',`Browser: ${rr[0].browser}`,'','Paired candidate minus base milliseconds; two independent AB launches.','', '| Input | Instances | Metric | A p50 (AB1 / AB2) | B p50 (AB1 / AB2) | AA envelope | AB paired p50 | Verdict |','|---|---:|---|---|---|---:|---|---|'];
 for(const row of rows)lines.push(row.verdict==='unmeasured'?`| ${row.skeleton} | ${row.instances} | ${row.metric} | — | — | — | — | unmeasured |`:`| ${row.skeleton} | ${row.instances} | ${row.metric} | ${row.ab.map(v=>f(v.a.p50Ms)).join(' / ')} | ${row.ab.map(v=>f(v.b.p50Ms)).join(' / ')} | ${f(row.envelopeMs)} | ${row.deltaMs.map(f).join(' / ')} | ${row.verdict} |`);
 writeFileSync(resolve(root,'summary.md'),lines.join('\n')+'\n');
 machines.push({renderer:rr[0].gpu.renderer,checks:output.checks,improvements:rows.filter(r=>r.verdict.startsWith('improvement')).map(r=>`${r.skeleton}/${r.instances}/${r.metric}`)});
}
console.log('HARDWARE_SUMMARY',JSON.stringify(machines));
