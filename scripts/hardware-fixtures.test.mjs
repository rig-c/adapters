/** Integrity and reader controls only. No runSameFramePair or hardware capture. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { chromium } from '@playwright/test';
import { fixtureEntries, assertFixtureMeasurements } from './hardware-fixtures.mjs';
import { prepareCompareBundle } from './bench.mjs';
import { captureProtocols, FRAME_PROTOCOL, CAPTURE_PROTOCOL, DECISION_PROTOCOL } from './hardware-protocol.mjs';

const assets = JSON.parse(readFileSync('public/bench/manifest.json', 'utf8'));
const entries = fixtureEntries(assets);
const measured = Object.fromEntries(entries.map(({ path, sha256, bytes }) => [path, { sha256, bytes }]));
const scratch = mkdtempSync(join(tmpdir(), 'hardware-fixture-controls-'));
let server, browser, mainCode, compareCodes;
let mutatePath = '', changeAfterFirst = false;
let hits = new Map(), receipt;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  if (process.env.HARDWARE_TEST_SITE) {
    const manifest = JSON.parse(readFileSync(resolve(process.env.HARDWARE_TEST_SITE, 'manifest.json'), 'utf8'));
    expect(manifest.captureProtocol).toBe(CAPTURE_PROTOCOL);
    expect(manifest.decisionProtocol).toBe(DECISION_PROTOCOL);
    console.log('PUBLISHED_SITE_PROTOCOL', JSON.stringify({ manifestSha256: sha(readFileSync(resolve(process.env.HARDWARE_TEST_SITE, 'manifest.json'))), protocol: manifest.protocol, captureProtocol: manifest.captureProtocol, decisionProtocol: manifest.decisionProtocol, players: Object.fromEntries(Object.entries(manifest.dependencies).map(([name, value]) => [name, { play: value.play, playSha256: value.playSha256 }])) }));
    mainCode = readFileSync(resolve(process.env.HARDWARE_TEST_SITE, 'main.js'), 'utf8');
    compareCodes = Object.fromEntries(['old', 'new'].map(name => [name, readFileSync(resolve(process.env.HARDWARE_TEST_SITE, `${name}.js`), 'utf8')]));
  } else {
  const built = await Bun.build({ entrypoints: [resolve('bench/main.ts')], target: 'browser', format: 'esm', plugins: [{ name: 'fixture-control-source', setup(build) {
    build.onResolve({ filter: /^@rig-c\/pixi$/ }, () => ({ path: resolve('packages/pixi/src/index.ts') }));
  } }] });
  if (!built.success) throw Error(JSON.stringify(built.logs));
  mainCode = await built.outputs[0].text();
  compareCodes = { old: (await prepareCompareBundle('node_modules/@rig-c/play')).browserCode };
  }
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/result/')) { receipt = await request.json(); return new Response('saved'); }
    if (url.pathname === '/manifest.json') return Response.json({ assets });
    if (url.pathname === '/main.js') return new Response(mainCode, { headers: { 'Content-Type': 'text/javascript' } });
    if (/^\/(old|new)\.js$/.test(url.pathname)) return new Response(compareCodes[url.pathname.slice(1, -3)], { headers: { 'Content-Type': 'text/javascript' } });
    if (['/client.js', '/fixtures.js'].includes(url.pathname)) {
      const file = url.pathname === '/client.js' ? 'scripts/hardware-bench-client.js' : 'scripts/hardware-fixtures.mjs';
      return new Response(readFileSync(file), { headers: { 'Content-Type': 'text/javascript' } });
    }
    if (url.pathname.startsWith('/bench/')) {
      const path = url.pathname.slice('/bench/'.length);
      if (!entries.some(entry => entry.path === path)) return new Response('missing', { status: 404 });
      const bytes = Buffer.from(readFileSync(resolve('public/bench', path)));
      hits.set(path, (hits.get(path) ?? 0) + 1);
      if (path === mutatePath || (changeAfterFirst && hits.get(path) > 1)) bytes[0] ^= 1;
      return new Response(bytes, { headers: { 'Cache-Control': 'no-store' } });
    }
    return new Response('<!DOCTYPE html><body>Fixture controls only', { headers: { 'Content-Type': 'text/html' } });
  } });
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => { await browser?.close(); server?.stop(true); rmSync(scratch, { recursive: true, force: true }); });

async function clientControl(path = '') {
  hits = new Map(); mutatePath = path; changeAfterFirst = false; receipt = undefined;
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}?phase=AA1`);
    await page.evaluate(async () => {
      await import('/main.js');
      window.__controlCalls = 0;
      // This sentinel proves ordering; it supplies no hardware result or timings.
      window.__rigBench.getGpuInfo = async () => { window.__controlCalls++; throw Error('CONTROL_ONLY_NO_CAPTURE'); };
      await import('/client.js');
    });
    expect(receipt).toBeDefined();
    return { report: receipt, calls: await page.evaluate(() => window.__controlCalls) };
  } finally { await page.close(); }
}

test('all 18 receiving-host measurements finish before setup; no capture', async () => {
  const { report, calls } = await clientControl();
  expect(calls).toBe(1);
  expect(report.error).toContain('CONTROL_ONLY_NO_CAPTURE');
  expect(report.rows).toEqual([]);
  expect(report.fixtureMeasurements).toEqual(measured);
  expect([...hits.values()]).toEqual(entries.map(() => 1));
  console.log('FIXTURE_BYTES_VERIFIED', JSON.stringify(report.fixtureMeasurements));
});

for (const path of ['spineboy/skeleton.model.json', 'raptor/raptor.png', 'raptor/skeleton.atlas']) {
  test(`serving-side one-byte mutant refuses ${path} before setup and AA1`, async () => {
    const { report, calls } = await clientControl(path);
    expect(report.status).toBe('failed');
    expect(report.error).toContain(`HARDWARE_FIXTURE_MISMATCH: ${path}`);
    expect(report.fixtureMeasurements[path].sha256).not.toBe(measured[path].sha256);
    expect(calls).toBe(0);
    expect(report.checks).toEqual({}); expect(report.rows).toEqual([]);
    console.log('RED_FIXTURE_MUTANT', report.error.split('\n')[0]);
  });
}

test('both player loaders and official image decode consume verified bytes after server changes', async () => {
  mutatePath = ''; changeAfterFirst = true; hits = new Map();
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    const result = await page.evaluate(async candidates => {
      await import('/main.js');
      const { verifyFixtureBytes } = await import('/fixtures.js');
      const { assets } = await (await fetch('/manifest.json')).json();
      const measurements = {};
      const fixtures = await verifyFixtureBytes(assets, measurements);
      const bench = window.__rigBench;
      bench.useVerifiedFixtures(fixtures);
      const checks = [];
      for (const candidate of candidates) {
      await bench.registerCompareBundle({ moduleUrl: `/${candidate}.js` });
      for (const skeleton of ['spineboy', 'raptor']) {
        await bench.verifyAssets(skeleton);
        for (const arm of ['rig-c-pixi', 'rig-c-pixi-compare']) {
          const result = await bench.checkCorrectness(skeleton, { arm, times: [0], mutant: 'none' });
          checks.push({ candidate, skeleton, arm, pass: result.pass });
        }
      }
      }
      let unknown;
      try { await fixtures.fetch('/bench/spineboy/unlisted.json'); } catch (error) { unknown = String(error); }
      let order;
      try { bench.useVerifiedFixtures(fixtures); } catch (error) { order = String(error); }
      fixtures.dispose();
      return { measurements, checks, unknown, order };
    }, Object.keys(compareCodes));
    expect(result.measurements).toEqual(measured);
    expect(result.checks).toHaveLength(4 * Object.keys(compareCodes).length);
    expect(result.checks.every(check => check.pass)).toBe(true);
    expect(result.unknown).toContain('HARDWARE_FIXTURE_UNVERIFIED: /bench/spineboy/unlisted.json');
    expect(result.order).toContain('HARDWARE_FIXTURE_ORDER');
    expect([...hits.values()]).toEqual(entries.map(() => 1));
    console.log('VERIFIED_CONSUMPTION', JSON.stringify({ checks: result.checks, requests: Object.fromEntries(hits) }));
  } finally { await page.close(); changeAfterFirst = false; }
}, 60_000);

test('missing SubtleCrypto refuses before fetching any fixture', async () => {
  hits = new Map(); mutatePath = '';
  const page = await browser.newPage();
  try {
    await page.goto(server.url.href);
    const error = await page.evaluate(async () => {
      const { verifyFixtureBytes } = await import('/fixtures.js');
      const { assets } = await (await fetch('/manifest.json')).json();
      Object.defineProperty(crypto, 'subtle', { value: undefined });
      try { await verifyFixtureBytes(assets, {}); } catch (error) { return String(error); }
    });
    expect(error).toContain('HARDWARE_FIXTURE_CRYPTO');
    expect(hits.size).toBe(0);
  } finally { await page.close(); }
});

function syntheticReport(phase, pairs = 2) {
  const order = pairs === 2 ? ['AA1', 'AA2', 'AB1', 'AB2'] : Array.from({ length: pairs }, (_, i) => [`AA${i + 1}`, `AB${i + 1}`]).flat();
  const launchTime = Date.parse('2020-01-01T00:00:00Z') + order.indexOf(phase) * 2000;
  const arms = ['rig-c-pixi', 'rig-c-pixi-compare'];
  return { phase, status: 'passed', started: new Date(launchTime).toISOString(), finished: new Date(launchTime + 1000).toISOString(),
    manifest: { ...(pairs === 2 ? { protocol: FRAME_PROTOCOL } : captureProtocols()), assets: structuredClone(assets), bundles: {} }, fixtureMeasurements: structuredClone(measured), browser: 'reader-control', gpu: { renderer: 'reader-control' },
    checks: { drawCallMutants: { pass: true }, ...Object.fromEntries(['spineboy', 'raptor'].map(name => [name, arms.map(arm => ({ arm, positive: { pass: true }, mutant: { pass: false } }))])) },
    rows: ['spineboy', 'raptor'].flatMap(skeleton => [1, 100].map(instances => ({ skeleton, instances, arms,
      warmupFrames: 60, halves: Array.from({ length: 6 }, () => ({ pass: true })), drawCallsPass: true, gpuStatus: 'unavailable',
      frames: Array.from({ length: 180 }, (_, index) => ({ order: index % 2 ? [...arms].reverse() : arms, arms: arms.map(() => ({ poseMs: 1, submitMs: 1, cpuMs: 2 })) })),
    }))),
  };
}

const summaryControls = [
  ['valid synthetic reader control', null, 'HARDWARE_SUMMARY'],
  ['absent', r => { delete r.fixtureMeasurements; }, 'HARDWARE_SUMMARY_FIXTURES'],
  ['empty', r => { r.fixtureMeasurements = {}; }, 'HARDWARE_SUMMARY_FIXTURES'],
  ['missing path', r => { delete r.fixtureMeasurements['raptor/raptor.png']; }, 'HARDWARE_SUMMARY_FIXTURES'],
  ['different digest', r => { r.fixtureMeasurements['spineboy/skeleton.model.json'].sha256 = '0'.repeat(64); }, 'HARDWARE_SUMMARY_FIXTURES'],
  ['different length', r => { r.fixtureMeasurements['raptor/raptor.png'].bytes++; }, 'HARDWARE_SUMMARY_FIXTURES'],
  ['extra path', r => { r.fixtureMeasurements.extra = measured['raptor/raptor.png']; }, 'HARDWARE_SUMMARY_FIXTURES'],
  ['missing manifest role', r => { delete r.manifest.assets.skeletons.raptor.files.builtModel; }, 'HARDWARE_SUMMARY_FIXTURES'],
  ['empty per-arm controls', r => { r.checks.spineboy = []; }, 'HARDWARE_SUMMARY_CONTROLS'],
  ['partial per-arm controls', r => { r.checks.raptor.pop(); }, 'HARDWARE_SUMMARY_CONTROLS'],
  ['missing mutant', r => { delete r.checks.raptor[1].mutant; }, 'HARDWARE_SUMMARY_CONTROLS'],
  ['failed half', r => { r.rows[0].halves[0].pass = false; }, 'HARDWARE_SUMMARY_ROW'],
];
for (const [name, mutate, code] of summaryControls) test(`summary ${name}`, () => {
  const directory = join(scratch, name.replaceAll(' ', '-')); mkdirSync(directory);
  for (const phase of ['AA1', 'AA2', 'AB1', 'AB2']) {
    const report = syntheticReport(phase);
    if (phase === 'AB2' && mutate) mutate(report);
    writeFileSync(join(directory, `${phase}.json`), JSON.stringify(report));
  }
  const run = spawnSync('bun', ['scripts/summarize-hardware-bench.mjs', directory], { encoding: 'utf8' });
  expect(run.status).toBe(mutate ? 1 : 0);
  expect(mutate ? run.stderr : run.stdout).toContain(code);
  console.log('SUMMARY_READER_CONTROL', name, 'exit', run.status, code, '(synthetic; not capture)');
});

test('manifest missing and malformed entries refuse; receipt accepts actual file hashes', () => {
  const actual = Object.fromEntries(entries.map(entry => {
    const bytes = readFileSync(resolve('public/bench', entry.path));
    return [entry.path, { sha256: sha(bytes), bytes: bytes.length }];
  }));
  expect(() => assertFixtureMeasurements(assets, actual, 'control')).not.toThrow();
  for (const bad of [undefined, {}, { skeletons: {} }]) expect(() => fixtureEntries(bad)).toThrow('HARDWARE_FIXTURE_MANIFEST');
  const malformed = structuredClone(assets); malformed.skeletons.spineboy.files.builtModel.bytes = 0;
  expect(() => fixtureEntries(malformed)).toThrow('spineboy/skeleton.model.json');
});

// These are synthetic reader fixtures, never accepted hardware captures.
for (const pairs of [3, 6]) test(`summary accepts ${pairs} interleaved pairs and retains stage envelopes`, () => {
  const directory = join(scratch, `interleaved-${pairs}`); mkdirSync(directory);
  for (let i = 1; i <= pairs; i++) for (const kind of ['AA', 'AB']) {
    const phase = `${kind}${i}`, report = syntheticReport(phase, pairs);
    for (const row of report.rows) for (const frame of row.frames) { frame.arms[0].cpuMs = 10; frame.arms[1].cpuMs = kind === 'AA' ? 10 + i : 5; }
    writeFileSync(join(directory, `${phase}.json`), JSON.stringify(report));
  }
  const run = spawnSync('bun', ['scripts/summarize-hardware-bench.mjs', directory], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  const summary = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8'));
  expect(summary.checks.frames).toBe(1440 * pairs);
  expect(summary.checks.launchPairs).toBe(pairs);
  expect(summary.checks.interleaved).toBe(true);
  expect(summary.stages.map(stage => stage.pairs)).toEqual(pairs === 6 ? [3, 6] : [3]);
  expect(summary.stages[0].rows.find(row => row.metric === 'cpuMs').envelopeMs).toBe(3);
  expect(summary.stages.at(-1).rows.find(row => row.metric === 'cpuMs').envelopeMs).toBe(pairs);
  expect(Object.keys(summary.fixtureMeasurements)).toHaveLength(2 * pairs);
  const cpu = summary.stages.at(-1).rows.find(row => row.metric === 'cpuMs');
  expect(cpu.aaInterval.meanMs).toBe((pairs + 1) / 2);
  expect(cpu.abInterval.meanMs).toBe(-5);
  expect(cpu.abInterval.upperMs).toBe(-5);
  expect(cpu.abInterval.n).toBe(pairs);
  expect(cpu.verdict).toStartWith('improvement');
  if (pairs === 6) expect(cpu.deltaMs.every(value => value > -cpu.envelopeMs)).toBe(true);

  console.log('INTERLEAVED_READER_CONTROL', JSON.stringify({ pairs, frames: summary.checks.frames, cpuEnvelopes: summary.stages.map(stage => stage.rows.find(row => row.metric === 'cpuMs').envelopeMs) }), '(synthetic; not capture)');
});

for (const name of ['missing-phase', 'unbalanced-phase', 'extra-phase', 'wrong-order', 'late-missing-measurement', 'missing-protocol', 'different-decision-protocol']) test(`interleaved summary refuses ${name}`, () => {
  const directory = join(scratch, name); mkdirSync(directory);
  for (let i = 1; i <= 3; i++) for (const kind of ['AA', 'AB']) {
    const phase = `${kind}${i}`, report = syntheticReport(phase, 3);
    if (name === 'missing-phase' && phase === 'AB3') continue;
    if (name === 'unbalanced-phase' && phase === 'AB3') continue;
    if (name === 'wrong-order' && phase === 'AA2') report.started = '2020-01-01T00:00:00Z';
    if (name === 'late-missing-measurement' && phase === 'AB3') delete report.fixtureMeasurements;
    if (name === 'missing-protocol' && phase === 'AB3') delete report.manifest.captureProtocol;
    if (name === 'different-decision-protocol' && phase === 'AB3') report.manifest.decisionProtocol = 'wrong-decision';
    writeFileSync(join(directory, `${phase}.json`), JSON.stringify(report));
  }
  if (name === 'extra-phase' || name === 'unbalanced-phase') writeFileSync(join(directory, 'AA4.json'), JSON.stringify(syntheticReport('AA4', 6)));
  const run = spawnSync('bun', ['scripts/summarize-hardware-bench.mjs', directory], { encoding: 'utf8' });
  expect(run.status).toBe(1);
  const code = name.includes('protocol') ? 'HARDWARE_SUMMARY_PROTOCOL' : name === 'wrong-order' ? 'HARDWARE_SUMMARY_LAUNCH_ORDER' : name === 'late-missing-measurement' ? 'HARDWARE_SUMMARY_FIXTURES' : 'HARDWARE_SUMMARY_PHASE_SET';
  expect(run.stderr).toContain(code);
  console.log('INTERLEAVED_READER_MUTANT', name, 'exit', run.status, code, '(synthetic; not capture)');
});

test('real loopback result sink accepts all interleaved phase names through six', async () => {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const site = join(scratch, 'sink-site'), results = join(scratch, 'sink-results'); mkdirSync(site);
  const sink = spawn('node', ['scripts/hardware-bench-server.cjs', site, results, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('SINK_START_TIMEOUT')), 5000);
      sink.stdout.on('data', data => { if (String(data).includes('HARDWARE_SERVER_READY')) { clearTimeout(timer); resolve(); } });
      sink.once('error', error => { clearTimeout(timer); reject(error); });
      sink.once('exit', code => { clearTimeout(timer); reject(Error(`SINK_START_EXIT: ${code}`)); });
    });
    for (const phase of ['precheck', ...Array.from({ length: 6 }, (_, i) => [`AA${i + 1}`, `AB${i + 1}`]).flat()]) {
      const response = await fetch(`http://127.0.0.1:${port}/result/${phase}`, { method: 'POST', body: JSON.stringify({ phase, status: 'control-only' }) });
      expect(response.status).toBe(200);
      expect(JSON.parse(readFileSync(join(results, `${phase}.json`), 'utf8')).phase).toBe(phase);
    }
    const refused = await fetch(`http://127.0.0.1:${port}/result/AA7`, { method: 'POST', body: '{}' });
    expect(refused.status).toBe(404);
    console.log('INTERLEAVED_SINK_CONTROL', '13 phase names saved; AA7 refused; no capture');
  } finally { if (sink.exitCode === null) { const stopped = once(sink, 'exit'); sink.kill('SIGTERM'); await stopped; } }
});
