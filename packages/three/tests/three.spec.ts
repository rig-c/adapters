import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { BAD_RATIO_LIMIT, CHANNEL_TOLERANCE, CONTENT_MISMATCH_LIMIT, diffBase64InPage } from '@rig-c/adapters-shared/parity';

const MATRIX = [
  ['walk', undefined], ['flex', undefined], ['ride', undefined],
  ...['walk', 'mask', 'tilted', 'window', 'inverse', 'nested'].map((animation) => ['figure', animation]),
  ['glow', undefined], ['duo', undefined], ['turned', undefined],
] as Array<[string, string | undefined]>;
const TIMES = [0, 0.5, 1];
async function open(page: Page) { await page.goto('/packages/three/tests/harness.html'); await page.waitForFunction(() => Boolean(window.threeHarness)); }
function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]).sort(); }
function hashes() { return Object.fromEntries(files(join(process.cwd(), 'public/rigs')).map((p) => [relative(process.cwd(), p), createHash('sha256').update(readFileSync(p)).digest('hex')])); }
let initial: ReturnType<typeof hashes>;
test.beforeAll(() => { initial = hashes(); expect(Object.keys(initial).length).toBeGreaterThan(0); });
test.afterAll(() => { expect(hashes()).toEqual(initial); console.log('[three:inputs] public rig files byte-identical before/after'); });

test('native storage format is measured before the geometry verdict', async ({ page }) => {
  await open(page); const measured = await page.evaluate(() => window.threeHarness.format());
  console.log('[three:format]', JSON.stringify(measured)); expect(measured.format).toBe('Float32Array'); expect(measured.stored).toBe(measured.quantized); expect(measured.stored).not.toBe(measured.input); expect(measured.beyondQuantization).toBe(0);
});
for (const [rig, animation] of MATRIX) {
  test(`geometry ${rig}/${animation ?? 'default'} reads native buffers through transformed Group and camera`, async ({ page }) => {
    await open(page);
    for (const time of TIMES) {
      const result = await page.evaluate(({ rig, animation, time }) => window.threeHarness.geometry(rig, animation, time), { rig, animation, time });
      console.log(`[three:geometry] ${rig}/${animation ?? 'default'}@${time}`, JSON.stringify(result));
      expect(result.coordinates).toBeGreaterThan(0); expect(result.maxLocalError).toBe(0); expect(result.maxError).toBe(0); expect(result.names).toEqual(result.expected); expect(result.meshCount).toBe(result.expected.length); expect(result.materialCount).toBe(result.pageCount); expect(result.glError).toBe(0);
    }
  });
  test(`picture ${rig}/${animation ?? 'default'} equals same-browser CanvasRenderer`, async ({ page }, info) => {
    await open(page);
    for (const time of TIMES) {
      const result = await page.evaluate(({ rig, animation, time }) => window.threeHarness.picture(rig, animation, time), { rig, animation, time });
      expect(result.backend).toBe('webgl'); expect(result.glError).toBe(0);
      const measured = await diffBase64InPage(page, result.referencePng, result.threePng);
      const badRatio = measured.bad / Math.max(1, measured.contentUnion), mismatch = Math.abs(measured.contentA - measured.contentB) / Math.max(1, measured.contentA, measured.contentB);
      console.log(`[three:picture] ${info.project.name} ${rig}/${animation ?? 'default'}@${time}: tolerance=${CHANNEL_TOLERANCE}`, JSON.stringify({ ...measured, badRatio, mismatch }));
      expect(measured.contentUnion).toBeGreaterThan(rig === 'turned' ? 0 : 5000); expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT); expect(mismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
      if (rig === 'turned') { expect(measured.bad).toBe(0); expect(measured.maxDelta).toBe(0); }
      if (time === 0.5) { for (const [label, image] of [['three', result.threePng], ['reference', result.referencePng]]) { const name = `${rig}-${animation ?? 'default'}-${label}.png`, path = info.outputPath(name); writeFileSync(path, Buffer.from(image, 'base64')); await info.attach(name, { path, contentType: 'image/png' }); } }
    }
  });
}
test('geometry mutants and a flat object in perspective expose coordinate/order faults', async ({ page }) => {
  await open(page);
  const perspective = await page.evaluate(() => window.threeHarness.geometry('figure', 'nested', 0.5, 'none', true)); expect(perspective.maxError).toBe(0); expect(perspective.glError).toBe(0);
  const shifted = await page.evaluate(() => window.threeHarness.geometry('figure', 'walk', 0.5, 'shift-vertex')); expect(shifted.maxError).toBeGreaterThan(0);
  const order = await page.evaluate(() => window.threeHarness.geometry('figure', 'walk', 0.5, 'swap-order')); expect(order.names).not.toEqual(order.expected);
  console.log('[three:geometry-mutants]', JSON.stringify({ perspective, shifted: shifted.maxError, orderRed: order.names.join() !== order.expected.join() }));
});
test('all picture mutants exceed the immutable comparison bars', async ({ page }, info) => {
  await open(page);
  const cases = [ ['walk', undefined, 'drop-slot', false], ['walk', undefined, 'swap-order', false], ['figure', 'mask', 'ignore-clip', false], ['figure', 'nested', 'ignore-clip', false], ['duo', undefined, 'drop-dark', false], ['glow', undefined, 'ignore-pma', true] ] as const;
  for (const [rig, animation, mutant, pma] of cases) {
    const result = await page.evaluate(({ rig, animation, mutant, pma }) => window.threeHarness.picture(rig, animation, 0.5, mutant, pma), { rig, animation, mutant, pma });
    const measured = await diffBase64InPage(page, result.referencePng, result.threePng), bad = measured.bad / Math.max(1, measured.contentUnion), mismatch = Math.abs(measured.contentA - measured.contentB) / Math.max(1, measured.contentA, measured.contentB);
    writeFileSync(info.outputPath(`${rig}-${animation ?? 'default'}-${mutant}-three.png`), Buffer.from(result.threePng, 'base64'));
    console.log(`[three:mutant] ${mutant} ${rig}`, JSON.stringify({ bad, mismatch })); expect(bad > BAD_RATIO_LIMIT || mismatch > CONTENT_MISMATCH_LIMIT).toBe(true);
  }
  const control = await page.evaluate(() => window.threeHarness.picture('glow', undefined, 0.5, 'none', true)), difference = await diffBase64InPage(page, control.referencePng, control.threePng);
  expect(difference.bad / Math.max(1, difference.contentUnion)).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
  writeFileSync(info.outputPath('glow-pma-control-three.png'), Buffer.from(control.threePng, 'base64')); writeFileSync(info.outputPath('glow-pma-control-reference.png'), Buffer.from(control.referencePng, 'base64'));
});
test('same-page per-draw light/dark/clip/blend resets and two independent instances coexist with native meshes', async ({ page }) => {
  await open(page); const result = await page.evaluate(() => window.threeHarness.stateProbe());
  const difference = await diffBase64InPage(page, result.referencePng, result.threePng), bad = difference.bad / Math.max(1, difference.contentUnion), mismatch = Math.abs(difference.contentA - difference.contentB) / Math.max(1, difference.contentA, difference.contentB);
  console.log('[three:state]', JSON.stringify({ ...result, referencePng: undefined, threePng: undefined, bad, mismatch })); expect(result.shared).toBe(true); expect(result.perInstanceMaterials).toBe(true); expect(bad).toBeLessThanOrEqual(BAD_RATIO_LIMIT); expect(mismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT); expect(result.settingsUnchanged).toBe(true); expect(result.sentinel).toEqual([65, 204, 99, 255]); expect(result.glError).toBe(0);
});
test('ThreeRig frame parity, 300 fixed updates, held GPU uploads and actual texture/buffer destruction', async ({ page }) => {
  await open(page); const r = await page.evaluate(() => window.threeHarness.lifecycle());
  console.log('[three:lifetime]', JSON.stringify(r)); expect(r.ingress).toBe(true); expect(r.getterIngress).toBe(true); expect(r.ingressUpdates).toBe(true); expect(r.survivorsUnchanged).toBe(true); expect(r.survivingTexturesLiveBeforeDraw).toBe(true); expect(r.survivingTexturesLive).toBe(true); expect(r.survivorDrawn).toBeGreaterThan(0); expect(r.updates).toBe(true); expect(r.time).toBe(r.bareTime); expect(r.boundsEqual).toBe(true); expect(r.filterEqual).toBe(true); expect(r.distinct).toBe(10); expect(r.heldEqual).toBe(true); expect(r.heldCounters).toBe(0); expect(r.held.calls).toBe(0); expect(r.held.bytes).toBe(0); expect(r.held.textureUploads).toBe(0); expect(r.refsBefore.some((x) => x === 10)).toBe(true); expect(r.refsOne.every((x) => x === 9 || x === 0)).toBe(true); expect(r.refsFinal.every((x) => x === 0)).toBe(true); expect(r.allDestroyed).toBe(true); expect(r.final.liveBuffers).toBe(0); expect(r.final.liveTextures).toBe(0); expect(r.final.deletedTextures).toBe(r.final.textures); expect(r.final.deleted).toBe(r.final.buffers); expect(r.texturesDeleted).toBe(true); expect(r.textureHandles).toBeGreaterThan(0); expect(r.livePages).toBe(0);
});
test('leak mutant remains live after its last destroy and makes release bar red', async ({ page }) => {
  await open(page); const r = await page.evaluate(() => window.threeHarness.lifecycle(true)); console.log('[three:leak-mutant]', JSON.stringify({ leak: r.leakDetected, livePages: r.livePages })); expect(r.leakDetected).toBe(true); expect(r.livePages).toBeGreaterThan(0);
});
test('named refusals are atomic, including actual GPU clip capacity', async ({ page }) => {
  await open(page); const r = await page.evaluate(() => window.threeHarness.refusals()); console.log('[three:refusals]', JSON.stringify(r));
  for (const item of r.messages) { expect(item.message).toContain('ThreeRenderer: slot'); expect(item.atomic).toBe(true); }
  expect(r.messages.find((x) => x.name === 'capacity')!.message).toContain(`MAX_TEXTURE_SIZE=${r.capacity}`); expect(r.after).toContain('after dispose');
});
test('normal runtime source and package graph contain no prohibited runtime', () => {
  const source = files(join(process.cwd(), 'packages/three/src')).map((p) => readFileSync(p, 'utf8')).join('\n');
  expect(source).not.toMatch(/@esotericsoftware|spine-core|CanvasRenderer/);
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'packages/three/package.json'), 'utf8'));
  expect(JSON.stringify([pkg.dependencies, pkg.peerDependencies])).not.toMatch(/spine|esotericsoftware|adapters-shared/);
  console.log('[three:runtime] source/declared runtime graph prohibited references (empty)');
});

test('native Uint16-to-Uint32 boundary draws vertex 65535 and resizing deletes replaced buffers', async ({ page }) => {
  await open(page); const r = await page.evaluate(() => window.threeHarness.bufferBoundary()); console.log('[three:buffer-boundary]', JSON.stringify(r));
  expect(r.transition.initialType).toBe('Uint16Array'); expect(r.transition.finalType).toBe('Uint32Array'); expect(r.transition.lastIndex).toBe(65535); expect(r.transition.pixel).toEqual([255, 255, 255, 255]); expect(r.active.liveBuffers).toBe(3); expect(r.destroyed.liveBuffers).toBe(0); expect(r.destroyed.deleted).toBe(r.destroyed.buffers); expect(r.glError).toBe(0);
});
test('deterministic Three demo exposes fixed query time, instances and native perspective scene', async ({ page }, info) => {
  await page.goto('/three-demo.html?rig=figure&anim=mask&time=0.5&timescale=0&count=3&view=perspective'); await page.waitForFunction(() => window.threeDemoState?.ready || window.threeDemoState?.error);
  const initial = await page.evaluate(() => window.threeDemoState); expect(initial.error).toBe(''); expect(initial.times).toEqual([0.5, 0.61, 0.72]); expect(initial.count).toBe(3); expect(initial.view).toBe('perspective'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.waitForTimeout(100); expect(await page.evaluate(() => window.threeDemoState.times)).toEqual(initial.times); const screenshot = info.outputPath('three-perspective-demo.png'); await page.screenshot({ path: screenshot, fullPage: true }); await info.attach('three-perspective-demo.png', { path: screenshot, contentType: 'image/png' });
  await page.locator('#view').selectOption('orthographic'); expect(await page.evaluate(() => window.threeDemoState.view)).toBe('orthographic'); await page.screenshot({ path: info.outputPath('three-orthographic-demo.png'), fullPage: true });
});

test('a ThreeRig ingress drop-slot mutant is red even while its frame getter stays correct', async ({ page }) => {
  await open(page); const r = await page.evaluate(() => window.threeHarness.lifecycle(false, true)); console.log('[three:ingress-mutant]', JSON.stringify({ actualIngress: r.ingress, actualUpdates: r.ingressUpdates, getter: r.getterIngress, updateGetter: r.updates })); expect(r.getterIngress).toBe(true); expect(r.updates).toBe(true); expect(r.ingress).toBe(false); expect(r.ingressUpdates).toBe(false);
});

test('fresh development server resolves Three source with no dist artifacts', async ({ page }) => {
  const { spawn } = await import('node:child_process'), { createServer } = await import('node:net');
  const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve)); const address = probe.address(); if (!address || typeof address === 'string') throw new Error('DEV_PORT: expected assigned TCP port'); const port = address.port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  const server = spawn('bunx', ['--no-install', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: process.cwd(), stdio: 'ignore' });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) { if (server.exitCode !== null) throw new Error(`DEV_SERVER: exited ${server.exitCode}`); try { ready = (await fetch(`http://127.0.0.1:${port}/three-demo.html`)).ok; } catch { /* Server has not bound yet. */ } if (ready) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
    expect(ready).toBe(true); const source = await (await fetch(`http://127.0.0.1:${port}/src/three-demo.ts`)).text(); expect(source).toContain('/packages/three/src/index.ts');
    await page.goto(`http://127.0.0.1:${port}/three-demo.html?rig=walk&time=0.5&timescale=0`); await page.waitForFunction(() => window.threeDemoState?.ready || window.threeDemoState?.error); const state = await page.evaluate(() => window.threeDemoState); expect(state.error).toBe(''); expect(state.times).toEqual([0.5]);
    console.log('[three:dev] fresh Vite resolves source entry and plays native ThreeRig at fixed time');
  } finally { server.kill('SIGTERM'); await new Promise<void>((resolve) => { if (server.exitCode !== null) resolve(); else server.once('exit', () => resolve()); }); }
});
