/** Explicit-frame submit component instrument; browsers run on the pool. */
import { chromium } from '@playwright/test';
import { createServer, build, preview } from 'vite';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadavg, freemem } from 'node:os';
import { BENCH_CHROMIUM_ARGS } from './bench.mjs';
import { instrumentBench, readComponents, COMPONENTS, summarize } from './submit-components.mjs';

if(process.argv.includes('--help')) {
  console.log('bun scripts/profile-pixi-submit.mjs --dry-run | --precheck | --profile [--out directory]');
  process.exit(0);
}
const args=process.argv.slice(2), get=(n,f)=>args.includes(n)?args[args.indexOf(n)+1]:f;
const out=resolve(get('--out','test-results/submit-components'));
const dry=args.includes('--dry-run');
process.env.RIG_BENCH='1';
const server=await createServer({server:{host:'127.0.0.1',port:4339,strictPort:true},cacheDir:resolve(out,'vite-cache'),optimizeDeps:{noDiscovery:true,include:['pixi.js','@rig-c/play']}});
let browser, staticServer;
const load=()=>({loadavg:loadavg(),freeBytes:freemem()});
try {
  for(const path of ['/bench/main.ts','/packages/pixi/src/pixi.ts','/packages/pixi/src/live.ts','/tests/oracle/pixi-spine-bridge.ts','/scripts/submit-components-browser.mjs']) {
    const r=await server.transformRequest(path); if(!r?.code) throw Error(`COMPONENT_READER: ${path}`);
    if(path==='/bench/main.ts') instrumentBench(r.code);
  }
  JSON.parse(readFileSync('public/bench/manifest.json','utf8'));
  for(const rig of ['spineboy','raptor']) JSON.parse(readFileSync(`public/bench/${rig}/skeleton.model.json`,'utf8'));
  if(dry) { console.log('COMPONENT_DRY_RUN: actual Vite transform and fixture readers PASS'); }
  else {
    mkdirSync(out,{recursive:true});
    await server.close();
    const site=resolve(out,'site');
    await build({build:{outDir:site,emptyOutDir:true,rollupOptions:{input:resolve('bench/index.html')}},
      resolve:{alias:[{find:/^@rig-c\/pixi(?:\/pixi)?$/,replacement:resolve('packages/pixi/src/index.ts')}]},
      plugins:[{name:'explicit-frame-components',enforce:'post',transform(code,id) {
        if(id!==resolve('bench/main.ts')) return;
        return {code:instrumentBench(code)+`
import { PixiRenderer as ComponentRenderer } from '../packages/pixi/src/pixi.ts';
import { LiveDrawViews as ComponentViews, RetainedRuntimeFrame as ComponentRetained } from '../packages/pixi/src/live.ts';
import { installComponents } from '../scripts/submit-components-browser.mjs';
import { verifyFixtureBytes } from '../scripts/hardware-fixtures.mjs';
window.__verifyBenchmarkFixtures = verifyFixtureBytes;
window.__installSubmitComponents = (plant,allocation) => installComponents({PixiRenderer:ComponentRenderer,LiveDrawViews:ComponentViews,RetainedRuntimeFrame:ComponentRetained},plant,allocation);
window.__submitComponents = {begin(){},end(){},batchEnd(){},hostEnd(){},rows:[]};
`,map:null};
      }}]});
    staticServer=await preview({configFile:false,build:{outDir:site},preview:{host:'127.0.0.1',port:4339,strictPort:true}});
    browser=await chromium.launch({headless:true,args:[...BENCH_CHROMIUM_ARGS]});
    async function sample(name,{instances=1,frames=12,warmup=8,plant=null,allocation=false,instrument=true,skeleton='spineboy'}={}) {
      const page=await browser.newPage(); const errors=[]; const before=load();
      await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));
      page.on('pageerror',e=>errors.push(String(e))); page.on('crash',()=>errors.push('PAGE_CRASH'));
      page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
      page.on('requestfailed',r=>errors.push(r.url()+': '+r.failure()?.errorText));
      page.on('response',r=>{if(r.status()>=400) errors.push(r.url()+': HTTP '+r.status());});

      try {
        await page.goto('http://127.0.0.1:4339/bench/index.html');
        await page.waitForFunction(()=>Boolean(window.__rigBench));
        const fixtureMeasurements=await page.evaluate(async assets=>{
          const measured={}; const fixtures=await window.__verifyBenchmarkFixtures(assets,measured);
          window.__rigBench.useVerifiedFixtures(fixtures); return measured;
        },JSON.parse(readFileSync('public/bench/manifest.json','utf8')));
        if(instrument) await page.evaluate(({plant,allocation})=>window.__installSubmitComponents(plant,allocation),{plant,allocation});
        const result=await page.evaluate(async ({skeleton,instances,frames,warmup,instrument})=>{
          const result=await window.__rigBench.runSameFramePair(skeleton,['spine-pixi-v8','rig-c-pixi'],instances,{measuredFrames:frames,warmupFrames:warmup});
          return {...result,components:instrument?window.__submitComponents.rows:[],gpu:await window.__rigBench.getGpuInfo()};
        },{skeleton,instances,frames,warmup,instrument});
        if(errors.length || !result.drawCallsPass || !result.halves.every(h=>h.pass)) throw Error(`COMPONENT_CORRECTNESS: ${JSON.stringify(errors)}`);
        result.table=instrument?readComponents(result,instances,frames,plant):null;
        result.submit=summarize(result.frames.map(f=>f.arms[1].submitMs));
        Object.assign(result,{name,fixtureMeasurements,loadBefore:before,loadAfter:load(),browserVersion:browser.version(),chromiumArgs:BENCH_CHROMIUM_ARGS});
        writeFileSync(resolve(out,`${name}.json`),JSON.stringify(result,null,2)+'\n');
        console.log('COMPONENT_SAMPLE',JSON.stringify({name,frames,instances,table:result.table,submit:result.submit,gpu:result.gpu}));
        return result;
      } catch(error) { writeFileSync(resolve(out,`${name}-failure.json`),JSON.stringify({error:String(error),errors},null,2)+'\n'); console.error('COMPONENT_FAILURE',JSON.stringify({name,error:String(error),errors})); throw error; } finally {await page.close();}
    }
    if(args.includes('--precheck')) {
      const base=await sample('normal-control');
      for(const component of COMPONENTS) {
        const r=await sample(`delay-${component}`,{plant:component});
        const delta=Object.fromEntries(COMPONENTS.map(k=>[k,r.table[k].p50Ms-base.table[k].p50Ms]));
        if(delta[component]<3 || delta[component]>6 || COMPONENTS.some(k=>k!==component&&Math.abs(delta[k])>1)) throw Error(`COMPONENT_DELAY: ${JSON.stringify(delta)}`);
        console.log('COMPONENT_DELAY_PASS',JSON.stringify({component,delta}));
      }
      const a=await sample('allocation',{plant:'captureMs',allocation:true});
      const events=a.components.flatMap(r=>r.events);
      const bytes=events.reduce((s,e)=>s+e.bytes,0),checksum=events.reduce((s,e)=>s+e.checksum,0);
      const expected=Array.from({length:12},(_,i)=>(i+1)*256*1024).reduce((a,b)=>a+b,0);
      if(bytes!==3145728||checksum!==expected) throw Error('COMPONENT_ALLOCATION');
      console.log('COMPONENT_ALLOCATION_PASS',JSON.stringify({events:events.length,bytes,checksum}));
      await sample('raptor-proof',{skeleton:'raptor',instances:100,frames:180,warmup:60});
      console.log('COMPONENT_INSTRUMENT_PROVEN');
    } else if(args.includes('--profile')) {
      const off=await sample('raptor-off',{skeleton:'raptor',instances:100,frames:180,warmup:60,instrument:false});
      const on=await sample('raptor-profile',{skeleton:'raptor',instances:100,frames:180,warmup:60});
      console.log('COMPONENT_OVERHEAD',JSON.stringify({uninstrumentedSubmitMs:off.submit.p50Ms,instrumentedSubmitMs:on.submit.p50Ms,shiftMs:on.submit.p50Ms-off.submit.p50Ms}));
    } else throw Error('COMPONENT_ARGUMENTS: expected --dry-run, --precheck or --profile');
  }
} finally {await browser?.close();if(staticServer) await new Promise(r=>staticServer.httpServer.close(r));await server.close();}
