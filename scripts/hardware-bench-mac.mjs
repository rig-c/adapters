import {chromium} from '@playwright/test';
import {spawn,spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {BENCH_CHROMIUM_ARGS} from './bench.mjs';
const out=resolve('test-results/hardware-bench/mac');mkdirSync(out,{recursive:true});
const precheck=process.argv.includes('--precheck');
const observe=()=>({at:new Date().toISOString(),top:spawnSync('top',['-l','1','-n','0'],{encoding:'utf8'}).stdout,processes:spawnSync('ps',['-axo','pid,pcpu,comm'],{encoding:'utf8'}).stdout});
const receipt={headful:true,args:[...BENCH_CHROMIUM_ARGS],before:observe(),quietWindow:'HQ granted; no other timing session; desktop panes idle',phases:[]};
const server=spawn('node',['scripts/hardware-bench-server.cjs','test-results/hardware-bench/site',out,'4362'],{stdio:'inherit'});
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:4362/manifest.json')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 for(const phase of precheck?['precheck']:['AA1','AA2','AB1','AB2']){
  const file=resolve(out,phase+'.json');if(existsSync(file))throw Error('HARDWARE_EXISTING_RECEIPT: '+phase);
  const browser=await chromium.launch({headless:false,args:[...BENCH_CHROMIUM_ARGS]});
  try {
   const page=await browser.newPage({viewport:{width:1800,height:700},deviceScaleFactor:1});
   page.on('pageerror',e=>console.error('PAGE_ERROR',String(e)));receipt.phases.push({phase,browser:browser.version(),before:observe()});
   await page.goto('http://127.0.0.1:4362/?phase='+phase);
   await page.waitForFunction(()=>document.body.textContent.includes('"status"'),{timeout:240000});
   for(let i=0;i<50&&!existsSync(file);i++)await new Promise(r=>setTimeout(r,100));
   const report=JSON.parse(readFileSync(file));
   console.log('HARDWARE_PHASE',phase,report.status,report.gpu.renderer,report.rows.map(r=>[r.skeleton,r.instances,r.gpuStatus]));
   if(report.status!=='passed')throw Error(report.error);
   if(phase==='AA2')writeFileSync(resolve(out,'aa-frozen.json'),JSON.stringify({at:new Date().toISOString(),status:'AA completed before AB'}));
  }finally{await browser.close();}
 }
}finally{receipt.after=observe();writeFileSync(resolve(out,precheck?'precheck-receipt.json':'receipt.json'),JSON.stringify(receipt,null,2));server.kill('SIGTERM');}
