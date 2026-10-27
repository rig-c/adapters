import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { transformWithEsbuild } from 'vite';
import { COMPONENTS, instrumentBench, readComponents } from './submit-components.mjs';

function normal() {
  return {components:[{frame:0,arm:'rig-c-pixi',names:[...COMPONENTS],rendererOwnMs:1,
    captureMs:1,metadataMs:1,rendererInclusiveMs:2,batchMs:3.1,hostMs:1,
    counts:{render:1,read:1,release:1,capture:1},events:[]}],frames:[{arms:[{}, {submitMs:4.2}]}]};
}
test('actual esbuild-transformed current benchmark has exact instrument sites', async()=>{
  const {code}=await transformWithEsbuild(readFileSync('bench/main.ts','utf8'),'bench/main.ts');
  const body=instrumentBench(code);
  expect(body).toContain('__submitComponents.begin(f, arms[index])');
  expect(()=>instrumentBench(code+code)).toThrow('COMPONENT_SITE');
});
test('complete exclusive accounting reads; mutants refuse by name',()=>{
  expect(readComponents(normal(),1,1).residual.p50Ms).toBeCloseTo(.1);
  const mutants=[
    [r=>delete r.components[0].captureMs,'COMPONENT_MISSING'],
    [r=>r.components.pop(),'COMPONENT_FRAMES'],
    [r=>r.components[0].names.reverse(),'COMPONENT_LABEL'],
    [r=>r.components[0].counts.read=0,'COMPONENT_PATH'],
    [r=>r.components[0].batchMs=2,'COMPONENT_ACCOUNTING'],
  ];
  for(const [mutate,code] of mutants) {const r=normal();mutate(r);expect(()=>readComponents(r,1,1)).toThrow(code);}
  expect(()=>readComponents(normal(),1,1,'captureMs')).toThrow('COMPONENT_PLANT');
});
