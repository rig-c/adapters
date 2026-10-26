/** Reproducible #62 hardware capture. Prepared files and receipts stay in test-results. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareCompareBundle } from './bench.mjs';
const out = resolve('test-results/hardware-bench');
const site = resolve(out, 'site');
mkdirSync(site, { recursive: true });
for (const [name,play,core] of [['old','1.17.1','2.70.0'],['new','1.18.0','2.72.0']]) {
  const directory=resolve(out,name);mkdirSync(directory,{recursive:true});
  writeFileSync(resolve(directory,'package.json'),JSON.stringify({private:true,type:'module',dependencies:{'@rig-c/play':play,'rig-c':core}},null,2));
  const install=spawnSync('bun',['install','--ignore-scripts'],{cwd:directory,encoding:'utf8'});
  if(install.status!==0)throw Error(`HARDWARE_INSTALL: ${name}: ${install.stderr}`);
}
const old = resolve(out, 'old/node_modules/@rig-c/play/dist/index.js');
const newer = resolve(out, 'new/node_modules/@rig-c/play/dist/index.js');
const oracle = createRequire(resolve('tests/oracle/package.json'));
const source = readFileSync('bench/main.ts', 'utf8');
const manifest = { protocol: 'hardware-same-frame-v1', sourceSha256: hash(source), dependencies: {}, assets: JSON.parse(readFileSync('public/bench/manifest.json')), bundles: {} };
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
for (const [name, entry] of [['old',old],['new',newer]]) {
  const dir = resolve(out, name, 'node_modules');
  const play = JSON.parse(readFileSync(resolve(dir,'@rig-c/play/package.json')));
  const core = JSON.parse(readFileSync(resolve(dir,'rig-c/package.json')));
  manifest.dependencies[name] = { play: play.version, verificationReferenceCore: core.version, declaredBuildCore: play.devDependencies['rig-c'], playSha256: hash(readFileSync(entry)) };
  const map = JSON.parse(readFileSync(`${entry}.map`));
  const embedded = map.sources.flatMap((source, i) => source.includes('/node_modules/rig-c/') ? [{ source: source.split('/node_modules/rig-c/')[1], content: map.sourcesContent[i] }] : []);
  if (embedded.length === 0 || embedded.some(item => readFileSync(resolve(dir,'rig-c',item.source),'utf8') !== item.content)) throw Error('HARDWARE_EMBEDDED_CORE_MISMATCH');
  manifest.dependencies[name].embeddedCoreSources = embedded.map(item => ({ source: item.source, sha256: hash(item.content) }));
  const bundle = await prepareCompareBundle(entry);
  writeFileSync(resolve(site,`${name}.js`), bundle.browserCode);
  manifest.bundles[name] = hash(bundle.browserCode);
}
const result = await Bun.build({ entrypoints: [resolve('bench/main.ts')], target:'browser', format:'esm', minify:true, plugins:[{name:'hardware-pins',setup(b){
 b.onResolve({filter:/^@rig-c\/play$/},()=>({path:old}));
 b.onResolve({filter:/^@rig-c\/pixi$/},()=>({path:resolve('packages/pixi/src/index.ts')}));
 b.onResolve({filter:/^@esotericsoftware\/spine-pixi-v8$/},()=>({path:oracle.resolve('@esotericsoftware/spine-pixi-v8')}));
}}] });
if (!result.success) throw Error(JSON.stringify(result.logs));
const bytes = new Uint8Array(await result.outputs[0].arrayBuffer());
writeFileSync(resolve(site,'main.js'),bytes); manifest.bundles.main = hash(bytes);
cpSync(resolve('public/bench'),resolve(site,'bench'),{recursive:true});
cpSync(resolve('scripts/hardware-bench-client.js'),resolve(site,'client.js'));
writeFileSync(resolve(site,'index.html'),'<!DOCTYPE html><meta charset="utf-8"><title>Hardware frame capture</title><body>Preparing capture<script type="module" src="/client.js"></script>');
manifest.captureClientSha256=hash(readFileSync(resolve(site,'client.js')));
manifest.harnessFiles=Object.fromEntries(['bench/main.ts','packages/pixi/src/pixi.ts','scripts/hardware-bench-client.js'].map(path=>[path,hash(readFileSync(path))]));
writeFileSync(resolve(site,'manifest.json'),JSON.stringify(manifest,null,2));
console.log('HARDWARE_PREPARED',JSON.stringify(manifest));
