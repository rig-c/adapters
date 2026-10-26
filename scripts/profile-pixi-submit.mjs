/** Profile #58's submit boundary without changing production renderer code. */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BENCH_CHROMIUM_ARGS } from './bench.mjs';
import { classifySubmitProfile } from './submit-profile-reader.mjs';

const out = resolve('test-results/submit-profile');
mkdirSync(out, { recursive: true });
const precheck = process.argv.includes('--precheck');
const port = 4339;
const server = spawn('bunx', ['--no-install', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  env: { ...process.env, RIG_BENCH: '1' }, stdio: 'inherit',
});
const url = `http://127.0.0.1:${port}/bench/index.html`;
let browser;
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const q = p => sorted[Math.floor((sorted.length - 1) * p)];
  return { count: sorted.length, p50Ms: q(0.5), p95Ms: q(0.95), spreadMs: q(0.95) - q(0.05), meanMs: values.reduce((a, b) => a + b, 0) / values.length };
};
async function sample(skeleton, mode, { instances = 100, frames = 76, warmup = 60, profile = false } = {}) {
  const page = await browser.newPage();
  let replacements = 0;
  if (mode !== 'off') await page.route('**/bench/main.ts', async route => {
    const response = await route.fetch();
    const original = await response.text();
    const pattern = /const drawAll = \(options\d* = \{\}\) => \{\s*for \(let i = 0; i < rigs.length; i\+\+\) \{\s*rigs\[i\].renderer.render\(posedFrames\[i\]\);\s*\}\s*renderer.render\(\{ container: stage, \.\.\.options\d* \}\);\s*\};/g;
    let body = original.replace(pattern, () => {
      replacements++;
      return `const drawAll = (options = {}) => {
        const t0 = performance.now();
        for (let i = 0; i < rigs.length; i++) rigs[i].renderer.render(posedFrames[i]);
        ${mode === 'adapter-control' ? 'const until = performance.now() + 4; while (performance.now() < until) {}' : ''}
        const t1 = performance.now();
        renderer.render({ container: stage, ...options });
        ${mode === 'host-control' ? 'const until = performance.now() + 4; while (performance.now() < until) {}' : ''}
        const t2 = performance.now();
        (window.__submitProfile ??= []).push({ adapterMs: t1-t0, hostMs: t2-t1 });
      };`;
    });
    if (profile) {
      const start = 'if (f === 0) gl.finish();';
      const stop = 'if (gl2 && ext) {\n      const deadline';
      if (!body.includes(start) || !body.includes(stop)) throw Error('PROFILE_SAMPLING_BOUNDARY: missing measured-loop markers');
      body = body.replace(start, 'if (f === 0) { gl.finish(); await window.__startSubmitSampler(); }');
      body = body.replace(stop, 'await window.__stopSubmitSampler(); ' + stop);
    }
    if (replacements !== 1) throw Error(`PROFILE_BOUNDARY: expected one rig drawAll replacement, found ${replacements}`);
    await route.fulfill({ response, body });
  });
  try {
    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.__rigBench));
    const cdp = await page.context().newCDPSession(page);
    let cpu;
    if (profile) {
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 100 });
      await page.exposeFunction('__startSubmitSampler', () => cdp.send('Profiler.start'));
      await page.exposeFunction('__stopSubmitSampler', async () => { cpu = (await cdp.send('Profiler.stop')).profile; });
    }
    const result = await page.evaluate(async ({ skeleton, instances, frames, warmup }) => {
      const result = await window.__rigBench.runSameFramePair(skeleton, ['spine-pixi-v8', 'rig-c-pixi'], instances, { measuredFrames: frames, warmupFrames: warmup });
      return { ...result, split: (window.__submitProfile ?? []).slice(-frames), gpu: await window.__rigBench.getGpuInfo() };
    }, { skeleton, instances, frames, warmup });
    if (profile) {
      if (!cpu) throw Error('PROFILE_SAMPLING_BOUNDARY: measured-loop sampler did not finish');
      writeFileSync(resolve(out, `${skeleton}-cpu-profile.json`), JSON.stringify(cpu));
      Object.assign(result, classifySubmitProfile(cpu));
    }
    if (!result.drawCallsPass || !result.halves.every(h => h.pass)) throw Error(`PROFILE_CORRECTNESS: ${skeleton} ${mode}`);
    if (mode !== 'off' && result.split.length !== frames) throw Error('PROFILE_MISSING_SPLIT');
    result.mode = mode;
    result.submit = summary(result.frames.map(f => f.arms[1].submitMs));
    result.pose = summary(result.frames.map(f => f.arms[1].poseMs));
    if (result.split.length) {
      result.adapter = summary(result.split.map(s => s.adapterMs));
      result.host = summary(result.split.map(s => s.hostMs));
      result.hostShare = summary(result.split.map(s => s.hostMs / (s.adapterMs + s.hostMs)));
      result.residual = summary(result.frames.map((f, i) => f.arms[1].submitMs - result.split[i].adapterMs - result.split[i].hostMs));
    }
    writeFileSync(resolve(out, `${skeleton}-${mode}.json`), JSON.stringify(result, null, 2));
    console.log('SUBMIT_PROFILE', JSON.stringify({ skeleton, mode, submit: result.submit, pose: result.pose, adapter: result.adapter, host: result.host, hostShare: result.hostShare, residual: result.residual, drawCalls: [...new Set(result.frames.map(f => f.arms[1].drawCalls))], gpu: result.gpu, sampledGroupMicroseconds: result.sampledGroupMicroseconds, sampledCpuMicroseconds: result.sampledCpuMicroseconds?.slice(0, 25) }));
    return result;
  } finally { await page.close(); }
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* server starting */ }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!ready) throw Error('PROFILE_SERVER: not ready');
  browser = await chromium.launch({ headless: true, args: [...BENCH_CHROMIUM_ARGS] });
  // Reader and attribution precheck is distinct from performance acceptance.
  const base = await sample('spineboy', 'split', { instances: 1, frames: 12, warmup: 8 });
  for (const mode of ['adapter-control', 'host-control']) {
    const row = await sample('spineboy', mode, { instances: 1, frames: 12, warmup: 8 });
    const target = mode === 'adapter-control' ? 'adapter' : 'host';
    const other = target === 'adapter' ? 'host' : 'adapter';
    const targetDelta = row[target].p50Ms - base[target].p50Ms;
    const otherDelta = row[other].p50Ms - base[other].p50Ms;
    if (targetDelta < 3 || Math.abs(otherDelta) > 1) throw Error(`PROFILE_CONTROL: ${mode} target=${targetDelta} other=${otherDelta}`);
    console.log('SUBMIT_CONTROL', JSON.stringify({ mode, targetDeltaMs: targetDelta, otherDeltaMs: otherDelta, pass: true }));
  }
  if (precheck) await sample('spineboy', 'sampled', { instances: 1, frames: 12, warmup: 8, profile: true });
  if (!precheck) for (const skeleton of ['spineboy', 'raptor']) {
    await sample(skeleton, 'off');
    await sample(skeleton, 'split');
    // Sampling runs separately so profiling overhead is not accepted as a timing baseline.
    await sample(skeleton, 'sampled', { profile: true });
  }
  console.log('SUBMIT_PROFILE_DONE', JSON.stringify({ precheck, output: 'test-results/submit-profile' }));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(r => server.once('exit', r));
}
