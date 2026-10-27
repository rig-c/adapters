/** Exact served-code instrument and strict reader for the three submit components. */
export const COMPONENTS = ['rendererOwnMs', 'captureMs', 'metadataMs'];
export function replaceOnce(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw Error(`COMPONENT_SITE: needed one occurrence of ${needle}`);
  return source.replace(needle, replacement);
}
export function instrumentBench(source) {
  let body = replaceOnce(source, 'for (let f = -warmup; f < count; f++) {', 'for (let f = -warmup; f < count; f++) {');
  body = replaceOnce(body, '        drawArm(index);', '        window.__submitComponents.begin(f, arms[index]);\n        drawArm(index);\n        window.__submitComponents.end();');
  body = replaceOnce(body, 'if (snapshotOnly) rigs[i].renderer.render(posedFrames[i]);', 'if (snapshotOnly) rigs[i].renderer.render(posedFrames[i]);');
  const sites=[...body.matchAll(/else rigs\[i\]\.renderFrame\(liveFrames\[i\]\);\n    }\n    renderer\.render\(\{ container: stage, \.\.\.(options\d*) \}\);/g)];
  if(sites.length!==1) throw Error('COMPONENT_SITE: needed one live draw batch');
  return replaceOnce(body, sites[0][0], `else rigs[i].renderFrame(liveFrames[i]);
    }
    window.__submitComponents.batchEnd();
    const hostStart = performance.now();
    renderer.render({ container: stage, ...${sites[0][1]} });
    window.__submitComponents.hostEnd(hostStart);`);
}
export function quantile(values, p) {
  const sorted = [...values].sort((a,b) => a-b);
  if (!sorted.length || sorted.some(v => !Number.isFinite(v))) throw Error('COMPONENT_VALUES: empty or nonfinite');
  return sorted[Math.floor((sorted.length - 1) * p)];
}
export function summarize(values) {
  return { count: values.length, p50Ms: quantile(values,.5), p95Ms: quantile(values,.95), meanMs: values.reduce((a,b)=>a+b,0)/values.length };
}
export function readComponents(result, instances, frames, plant = null) {
  const rows = result.components;
  if (!Array.isArray(rows) || rows.length !== frames) throw Error('COMPONENT_FRAMES: wrong count');
  for (let i=0;i<frames;i++) {
    const r=rows[i];
    if(r.frame!==i || r.arm!=='rig-c-pixi') throw Error('COMPONENT_FRAMES: wrong identity');
    for(const k of [...COMPONENTS,'rendererInclusiveMs','batchMs','hostMs']) if(!Number.isFinite(r[k]) || r[k]<0) throw Error(`COMPONENT_MISSING: ${k}`);
    if (r.names?.join('|') !== COMPONENTS.join('|')) throw Error('COMPONENT_LABEL: wrong identity');
    if(r.counts.render!==instances || r.counts.capture!==instances || r.counts.read!==instances || r.counts.release!==instances) throw Error('COMPONENT_PATH: missing live instance');
    if(plant && (r.events.length!==1 || r.events[0].component!==plant)) throw Error('COMPONENT_PLANT: missing or misplaced event');
    if(!plant && r.events.length) throw Error('COMPONENT_PLANT: unexpected event');
    if(r.batchMs-COMPONENTS.reduce((s,k)=>s+r[k],0)<-0.005) throw Error('COMPONENT_ACCOUNTING: negative residual');
  }
  const table=Object.fromEntries([...COMPONENTS,'rendererInclusiveMs','batchMs','hostMs'].map(k=>[k,summarize(rows.map(r=>r[k]))]));
  table.residual=summarize(rows.map(r=>Math.abs(r.batchMs-COMPONENTS.reduce((s,k)=>s+r[k],0))));
  const limit=Math.max(.25,.05*table.batchMs.p50Ms);
  if(table.residual.p50Ms>limit) throw Error(`COMPONENT_ACCOUNTING: residual ${table.residual.p50Ms} > ${limit}`);
  table.outerResidual=summarize(rows.map((r,i)=>result.frames[i].arms[1].submitMs-r.batchMs-r.hostMs));
  return table;
}
