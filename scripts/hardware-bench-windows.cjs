/* Runs only inside an explicitly scheduled interactive Windows task. */
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path');
const root=__dirname,out=path.join(root,'results'),site=path.join(root,'site');
fs.mkdirSync(out,{recursive:true});
const chrome='C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const args=['--enable-gpu','--ignore-gpu-blocklist','--force-high-performance-gpu','--js-flags=--expose-gc','--enable-precise-memory-info','--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--force-device-scale-factor=1','--no-first-run','--no-default-browser-check','--window-size=1800,800'];
const ps=script=>{const p=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',timeout:20000});return {exitCode:p.status,stdout:p.stdout,stderr:p.stderr};};
const observe=()=>ps(`$c=Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"; $g=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Where-Object {$_.UtilizationPercentage -gt 0} | ForEach-Object { $id=if($_.Name -match '^pid_(\\d+)_') {[int]$Matches[1]} else {0}; $p=Get-Process -Id $id -ErrorAction SilentlyContinue; @{engine=$_.Name;percent=$_.UtilizationPercentage;process=$p.ProcessName} }); @{at=(Get-Date).ToUniversalTime().ToString('o');cpuPercent=$c.PercentProcessorTime;activeGpuEngines=$g;gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion);browser=(Get-Item '${chrome}').VersionInfo.ProductVersion;os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber)} | ConvertTo-Json -Depth 5 -Compress`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let server,browser;
const receipt={headful:true,route:'interactive Windows scheduled task; standalone loopback site copied from Mac',args,before:observe(),phases:[]};
(async()=>{
 try{
  server=spawn(process.execPath,[path.join(root,'hardware-bench-server.cjs'),site,out,'4362'],{stdio:'inherit'});
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:4362/manifest.json')).ok){ready=true;break;}}catch{}await sleep(100);}if(!ready)throw Error('HARDWARE_SERVER_NOT_READY');
  for(const phase of ['precheck','AA1','AA2','AB1','AB2']){
   const file=path.join(out,phase+'.json');if(fs.existsSync(file))throw Error('HARDWARE_EXISTING_RECEIPT: '+phase);
   const observation=observe();receipt.phases.push({phase,before:observation});
   browser=spawn(chrome,[...args,'--user-data-dir='+path.join(root,'profiles',phase),'--app=http://127.0.0.1:4362/?phase='+phase],{stdio:'ignore'});
   const deadline=Date.now()+240000;
   while(!fs.existsSync(file)){if(Date.now()>deadline)throw Error('HARDWARE_RESULT_TIMEOUT: '+phase);await sleep(500);}
   const report=JSON.parse(fs.readFileSync(file));
   console.log('HARDWARE_PHASE',phase,report.status,report.gpu);
   const closed=spawnSync('taskkill.exe',['/PID',String(browser.pid),'/T','/F'],{encoding:'utf8'});receipt.phases.at(-1).browserCleanup={exitCode:closed.status,stdout:closed.stdout,stderr:closed.stderr};browser=null;
   if(report.status!=='passed')throw Error(report.error);
   if(!/NVIDIA.*RTX (4070|5070) Ti/i.test(report.gpu.renderer))throw Error('HARDWARE_RTX_REQUIRED: '+report.gpu.renderer);
   if(phase==='AA2')fs.writeFileSync(path.join(out,'aa-frozen.json'),JSON.stringify({at:new Date().toISOString(),status:'AA completed before AB'}));
   await sleep(1500);
  }
  receipt.status='passed';
 }catch(error){receipt.status='failed';receipt.error=String(error.stack??error);process.exitCode=1;}
 finally{
  if(browser)spawnSync('taskkill.exe',['/PID',String(browser.pid),'/T','/F'],{encoding:'utf8'});
  if(server)server.kill();receipt.after=observe();fs.writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2));
 }
})();
