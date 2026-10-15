import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { BAD_RATIO_LIMIT, CONTENT_MISMATCH_LIMIT, diffBase64InPage } from '@rig-c/adapters-shared/parity';
import type { Mutant } from './full-harness.ts';

const TIMES = [0, 0.5, 1];
const MATRIX = [
  ...['walk', 'mask', 'tilted', 'window', 'inverse', 'nested'].map((animation) => ({ rig: 'figure', animation })),
  { rig: 'glow', animation: 'burn' }, { rig: 'turned', animation: 'hold' }, { rig: 'duo', animation: 'shift' },
];
async function open(page: Page) {
  await page.goto('/packages/phaser/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.phaserMeshHarness));
}
async function picture(page: Page, rig: string, animation: string, time: number, mutant: Mutant = 'none', pma = false) {
  const cap = await page.evaluate(({ rig, animation, time, mutant, pma }) => window.phaserMeshHarness.fullPicture(rig, animation, time, mutant, pma), { rig, animation, time, mutant, pma });
  expect(cap.backend).toBe('webgl'); expect(cap.nativeGlError).toBe(0);
  mkdirSync(test.info().outputDir, { recursive: true });
  for (const [name, png] of [['reference', cap.referencePng], ['phaser', cap.phaserPng]]) writeFileSync(test.info().outputPath(`${rig}-${animation}-${time}-${mutant}-${pma}-${name}.png`), Buffer.from(png, 'base64'));
  const m = await diffBase64InPage(page, cap.referencePng, cap.phaserPng);
  return { bad: m.bad / Math.max(1, m.contentUnion), mismatch: Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB), content: m.contentUnion, maxDelta: m.maxDelta, uploadPma: cap.uploadPma };
}

test('Phaser #18 bar 1: actual native mesh positions equal Float32-quantized stage mapping', async ({ page }, info) => {
  await open(page);
  for (const { rig, animation } of MATRIX) for (const time of TIMES) {
    const result = await page.evaluate(({ rig, animation, time }) => window.phaserMeshHarness.fullGeometry(rig, animation, time), { rig, animation, time });
    console.log(`[phaser18:bar1] ${info.project.name} ${rig}/${animation}@${time} ${JSON.stringify(result)}`);
    expect(result.names).toEqual(result.expectedNames);
    if (rig !== 'turned') expect(result.coordinates).toBeGreaterThan(0);
    expect(result.maxError).toBe(0);
  }
});

test('Phaser #18 bar 2: full pictures and reverse-index/clip/dark negative controls', async ({ page }, info) => {
  await open(page);
  for (const { rig, animation } of MATRIX) for (const time of TIMES) {
    const result = await picture(page, rig, animation, time);
    console.log(`[phaser18:bar2] ${info.project.name} ${rig}/${animation}@${time} ${JSON.stringify(result)}`);
    expect(result.content).toBeGreaterThan(0);
    expect(result.bad).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
    expect(result.mismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
  }
  for (const [rig, animation, mutant] of [['glow', 'burn', 'reverse-map'], ['figure', 'mask', 'ignore-clip'], ['figure', 'window', 'ignore-clip'], ['figure', 'inverse', 'ignore-clip'], ['figure', 'nested', 'ignore-clip'], ['duo', 'shift', 'drop-dark']] as const) {
    const result = await picture(page, rig, animation, 0.5, mutant);
    console.log(`[phaser18:bar2:mutant] ${info.project.name} ${rig}/${animation}/${mutant} ${JSON.stringify(result)}`);
    expect(result.bad > BAD_RATIO_LIMIT || result.mismatch > CONTENT_MISMATCH_LIMIT).toBe(true);
  }
});

test('Phaser #18 bar 3: actual GL UV/index upload bytes remain zero on moving and held frames', async ({ page }, info) => {
  await open(page);
  const normal = await page.evaluate(() => window.phaserMeshHarness.uploadProbe());
  console.log(`[phaser18:bar3] ${info.project.name} ${JSON.stringify(normal)}`);
  expect(normal.initial.uv).toBeGreaterThan(0); expect(normal.initial.index).toBeGreaterThan(0);
  expect(normal.moving.uv).toBe(0); expect(normal.moving.index).toBe(0); expect(normal.moving.position).toBeGreaterThan(0);
  expect(normal.uvOnly.uv).toBeGreaterThan(0); expect(normal.uvOnly.index).toBe(0);
  expect(normal.indexOnly.index).toBeGreaterThan(0); expect(normal.indexOnly.uv).toBe(0);
  expect(normal.held).toEqual({ uv: 0, index: 0, position: 0 });
  expect(normal.movingStaticRetained).toBe(true); expect(normal.heldStaticRetained).toBe(true);
  expect(normal.unchangedIndexRetained).toBe(true); expect(normal.unchangedUVRetained).toBe(true);
  expect(normal.sameUVs).toBe(true); expect(normal.sameWrappers).toBe(true); expect(normal.staticRemoved).toBe(true);
  const mutant = await page.evaluate(() => window.phaserMeshHarness.uploadProbe(true));
  console.log(`[phaser18:bar3:mutant] ${info.project.name} ${JSON.stringify(mutant)}`);
  expect(mutant.moving.uv).toBeGreaterThan(0); expect(mutant.moving.index).toBeGreaterThan(0);
  expect(mutant.held.uv).toBeGreaterThan(0); expect(mutant.held.index).toBeGreaterThan(0);
});

test('Phaser #18 bar 4: premultiplied pages and additive glow, double upload multiplication red', async ({ page }, info) => {
  await open(page);
  for (const pma of [false, true]) for (const time of TIMES) {
    const result = await picture(page, 'glow', 'burn', time, 'none', pma);
    console.log(`[phaser18:bar4] ${info.project.name} pma=${pma}@${time} ${JSON.stringify(result)}`);
    expect(result.bad).toBeLessThanOrEqual(BAD_RATIO_LIMIT); expect(result.mismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
    expect(result.uploadPma.every((slot) => slot.nativeMultiply === !slot.pma)).toBe(true);
  }
  const mutant = await picture(page, 'glow', 'burn', 0.5, 'double-pma', true);
  console.log(`[phaser18:bar4:mutant] ${info.project.name} ${JSON.stringify(mutant)}`);
  expect(mutant.bad > BAD_RATIO_LIMIT || mutant.mismatch > CONTENT_MISMATCH_LIMIT).toBe(true);
});


test('Phaser #18 bar 5: independent official reader raster with original paired files and declared history', async ({ page }, info) => {
  await open(page);
  try { for (const { rig, animation } of MATRIX) for (const time of TIMES) {
    const result = await page.evaluate(({ rig, animation, time }) => window.phaserMeshHarness.officialPicture(rig, animation, time), { rig, animation, time });
    mkdirSync(info.outputDir, { recursive: true });
    for (const [name, png] of [['official', result.referencePng], ['phaser', result.phaserPng]]) writeFileSync(info.outputPath(`${rig}-${animation}-${time}-${name}.png`), Buffer.from(png, 'base64'));
    const m = await diffBase64InPage(page, result.referencePng, result.phaserPng);
    const metrics = { bad: m.bad / Math.max(1, m.contentUnion), mismatch: Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB), content: m.contentUnion, maxDelta: m.maxDelta };
    console.log(`[phaser18:bar5] ${info.project.name} ${rig}/${animation}@${time} ${JSON.stringify({ ...result, referencePng: undefined, phaserPng: undefined, metrics })}`);
    expect(result.generation).toBe('4.3.13'); expect(result.stats.triangles).toBeGreaterThan(0); expect(result.maxGeometryDelta).toBe(0); expect(result.nativeGlError).toBe(0);
    expect(metrics.content).toBeGreaterThan(0); expect(metrics.bad).toBeLessThanOrEqual(BAD_RATIO_LIMIT); expect(metrics.mismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
  } } finally { await page.evaluate(() => window.phaserMeshHarness.disposeOfficialOracle()); }
});


test('Phaser #18 integration: shared root clips, parent alpha, numeric helper cache and following overlapping native scene', async ({ page }, info) => {
  await open(page);
  for (const animation of ['window', 'inverse'] as const) for (const sentinel of [false, true]) {
    const cap = await page.evaluate(({ animation, sentinel }) => window.phaserMeshHarness.clipIntegration(animation, sentinel), { animation, sentinel });
    const m = await diffBase64InPage(page, cap.referencePng, cap.phaserPng);
    mkdirSync(info.outputDir, { recursive: true });
    for (const [name, png] of [['reference', cap.referencePng], ['phaser', cap.phaserPng]]) writeFileSync(info.outputPath(`${animation}-sentinel-${sentinel}-${name}.png`), Buffer.from(png, 'base64'));
    console.log(`[phaser18:clip-integration] ${info.project.name} ${animation} sentinel=${sentinel} ${JSON.stringify({ ...cap, referencePng: undefined, phaserPng: undefined, metrics: m })}`);
    expect(cap.helperCount).toBe(2); expect(cap.retained).toBe(true); expect(cap.nativeGlError).toBe(0);
    expect(m.bad / Math.max(1, m.contentUnion)).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
    expect(Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB)).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
  }
  const boundary = await page.evaluate(() => window.phaserMeshHarness.boundaryProbe());
  console.log(`[phaser18:index-boundary] ${info.project.name} ${JSON.stringify(boundary)}`);
  expect(boundary.actualLastIndex).toBe(65534); expect(boundary.visiblePixels).toBeGreaterThan(3000); expect(boundary.inside).toEqual([255,255,255,255]); expect(boundary.outside).toEqual([0,0,0,0]); expect(boundary.glError).toBe(0); expect(boundary.acceptedRetained).toBe(true); expect(boundary.message).toContain('at most 65535');
});


test('Phaser sampling and accepted clip normalization controls', async ({ page }, info) => {
  await open(page);
  const sampler = await page.evaluate(() => window.phaserMeshHarness.samplerProbe());
  console.log(`[phaser18:sampler] ${info.project.name} ${JSON.stringify(sampler)}`);
  expect(sampler.created).toEqual([9729, 9729]); expect(sampler.explicitLinear).toEqual([9729, 9729]); expect(sampler.antialias).toBe(false);
  const clips = await page.evaluate(() => window.phaserMeshHarness.clipValidationProbe());
  console.log(`[phaser18:clip-normalization] ${info.project.name} ${JSON.stringify(clips)}`);
  expect(clips.closing).toBe(true); expect(clips.adjacent).toBe(true); expect(clips.message).toContain('nonadjacent repeated'); expect(clips.acceptedRetained).toBe(true);
});


test('Phaser native index updates preserve other VAOs; omitted-unbind mutant red', async ({ page }, info) => {
  await open(page);
  for (const mutant of [false, true]) {
    const cap = await page.evaluate((mutant) => window.phaserMeshHarness.vaoIsolation(mutant), mutant);
    const m = await diffBase64InPage(page, cap.referencePng, cap.phaserPng);
    const bad = m.bad / Math.max(1, m.contentUnion);
    console.log(`[phaser18:vao-isolation] ${info.project.name} mutant=${mutant} ${JSON.stringify({ mismatches: cap.mismatches, glError: cap.glError, bad })}`);
    if (mutant) expect(cap.mismatches > 0 || cap.glError !== 0 || bad > BAD_RATIO_LIMIT).toBe(true);
    else { expect(cap.mismatches).toBe(0); expect(cap.glError).toBe(0); expect(bad).toBeLessThanOrEqual(BAD_RATIO_LIMIT); }
  }
});
