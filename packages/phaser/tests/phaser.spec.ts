import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { BAD_RATIO_LIMIT, CONTENT_MISMATCH_LIMIT, diffBase64InPage } from '@rig-c/adapters-shared/parity';
import type { PictureMutant } from './harness.ts';

const TIMES = [0, 0.5, 1.2];
const RIGS = ['walk', 'flex', 'ride'];
const rigDir = join(process.cwd(), 'public/rigs');
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]).sort();
}
function digests(): Record<string, string> {
  return Object.fromEntries(files(rigDir).map((file) => [relative(rigDir, file), createHash('sha256').update(readFileSync(file)).digest('hex')]));
}
function forbidden(paths: string[]): string[] {
  return paths.flatMap((path) => readFileSync(path, 'utf8').split('\n').flatMap((line, i) => /@esotericsoftware|spine-core/i.test(line) ? [`${path}:${i + 1}:${line.trim()}`] : []));
}
async function open(page: Page) {
  await page.goto('/packages/phaser/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.phaserHarness));
}
let before: Record<string, string>;
test.beforeAll(() => { before = digests(); expect(Object.keys(before).length).toBeGreaterThan(0); });

test('Phaser #17 bar 1: measured storage, native region corners and child order, with mutants', async ({ page }, info) => {
  await open(page);
  const storage = await page.evaluate(() => window.phaserHarness.storageProbe());
  console.log(`[phaser:bar1:storage] ${info.project.name} ${JSON.stringify(storage)}`);
  expect(storage.meshArray).toBe(true);
  expect(storage.vertexRetainsBinary64).toBe(true);
  expect(storage.matrixType).toBe('Float32Array');
  expect(storage.matrixQuantized).toBe(true);
  expect(storage.readbackTolerance).toBe(0);
  expect(storage.blendRegistration.actualFactors).toEqual([1, 1, 1, 1]);
  for (const rig of RIGS) for (const time of TIMES) {
    const result = await page.evaluate(({ rig, time }) => window.phaserHarness.geometryProbe(rig, time), { rig, time });
    console.log(`[phaser:bar1] ${info.project.name} ${rig}@${time} ${JSON.stringify(result)}`);
    expect(result.count).toBeGreaterThan(0);
    expect(result.coordinates).toBe(result.count * 8);
    expect(result.names).toEqual(result.expectedNames);
    expect(result.nativeRoutes).toEqual(Array.from({ length: result.count }, () => ({ triangles: false, ordered: true, indexCount: 8 })));
    expect(result.maxError).toBe(storage.readbackTolerance);
    expect(result.maxQuantization).toBeGreaterThan(0);
    if (rig === 'flex') expect(result.omitted.length).toBeGreaterThan(0);
  }
  const shifted = await page.evaluate(() => window.phaserHarness.geometryProbe('walk', 0.5, 'shift-corner'));
  const swapped = await page.evaluate(() => window.phaserHarness.geometryProbe('walk', 0.5, 'swap-order'));
  expect(shifted.maxError).toBeGreaterThan(0);
  expect(swapped.names).not.toEqual(swapped.expectedNames);
  console.log(`[phaser:bar1:mutants] ${info.project.name} shift=${shifted.maxError}, swap-order RED`);
});

async function picture(page: Page, rig: string, time: number, mutant: PictureMutant = 'none') {
  const cap = await page.evaluate(({ rig, time, mutant }) => window.phaserHarness.pictureProbe(rig, time, mutant), { rig, time, mutant });
  expect(cap.canvasBackend).toBe('webgl');
  expect(cap.states).toEqual(cap.expected);
  expect(cap.blendTable).toEqual(cap.nativeBlendTable);
  mkdirSync(test.info().outputDir, { recursive: true });
  for (const [name, data] of [['reference', cap.referencePng], ['phaser', cap.phaserPng]]) {
    writeFileSync(test.info().outputPath(`${rig}-${time}-${mutant}-${name}.png`), Buffer.from(data, 'base64'));
  }
  const m = await diffBase64InPage(page, cap.referencePng, cap.phaserPng);
  const badRatio = m.bad / Math.max(1, m.contentUnion);
  const contentMismatch = Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB);
  return { badRatio, contentMismatch, content: m.contentUnion, maxDelta: m.maxDelta, omitted: cap.omitted, gpu: cap.gpu };
}

test('Phaser #17 bars 2/3: same-browser pictures, source tint/blend table, drop/order/tint/UV mutants', async ({ page }, info) => {
  await open(page);
  for (const rig of [...RIGS, 'glow']) for (const time of TIMES) {
    const result = await picture(page, rig, time);
    console.log(`[phaser:bar2/3] ${info.project.name} ${rig}@${time} ${JSON.stringify(result)}`);
    expect(result.content).toBeGreaterThan(0);
    expect(result.badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
    expect(result.contentMismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
  }
  for (const [rig, mutant] of [['walk', 'drop-slot'], ['walk', 'swap-order'], ['glow', 'drop-tint'], ['walk', 'wrong-blend'], ['walk', 'flip-uv']] as const) {
    const result = await picture(page, rig, 0.5, mutant);
    console.log(`[phaser:bar2/3:mutant] ${info.project.name} ${rig}/${mutant} ${JSON.stringify(result)}`);
    expect(result.badRatio > BAD_RATIO_LIMIT || result.contentMismatch > CONTENT_MISMATCH_LIMIT).toBe(true);
  }
});

test('Phaser #17 bar 4: source/dependency graph contains no external runtime, planted hit red', () => {
  const paths = [...files(join(process.cwd(), 'packages/phaser/src')), join(process.cwd(), 'packages/phaser/package.json'), join(process.cwd(), 'package.json'), join(process.cwd(), 'bun.lock')];
  expect(forbidden(paths)).toEqual([]);
  const dir = mkdtempSync(join(tmpdir(), 'phaser-runtime-mutant-'));
  try {
    mkdirSync(join(dir, 'src'));
    const planted = join(dir, 'src/planted.ts');
    writeFileSync(planted, 'import "@esotericsoftware/spine-core";');
    expect(forbidden([planted])).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('[phaser:bar4] source/root+package dependency graph (empty); planted-hit RED');
});

test('Phaser #17 native batch isolation preserves ordinary objects around two region renderers', async ({ page }, info) => {
  await open(page);
  const result = await page.evaluate(() => window.phaserHarness.coexistenceProbe());
  console.log(`[phaser:coexistence] ${info.project.name} ${JSON.stringify(result)}`);
  expect(result.beforePixel).toEqual([255, 0, 0, 255]);
  expect(result.afterPixel).toEqual([0, 255, 0, 255]);
  expect(result.order).toEqual(['before', 'first', 'second', 'after']);
  expect(result.firstNames).toEqual(result.expectedNames);
  expect(result.secondNames).toEqual(result.expectedNames);
  expect(result.maxTexturesAfter).toBe(result.maxTexturesBefore);
  expect(result.nativeAddAfter).toEqual(result.nativeAddBefore);
  expect(result.error).toBe(0);
});

test('Phaser #17 bar 3: transparent additive padding preserves the underlying pixel, native ADD mutant red', async ({ page }, info) => {
  await open(page);
  for (const time of TIMES) {
    const results = await page.evaluate((time) => window.phaserHarness.transparentPaddingProbe(time), time);
    expect(results.map((result) => result.slot)).toEqual(['spark_a', 'spark_b']);
    for (const result of results) {
      console.log(`[phaser:bar3:transparent-padding] ${info.project.name} @${time} ${JSON.stringify(result)}`);
      expect(result.measured).toBeGreaterThan(0);
      expect(result.changed).toBe(0);
      expect(result.maxDelta).toBe(result.toleranceUNORM8);
    }
  }
  const mutant = await page.evaluate(() => window.phaserHarness.transparentPaddingProbe(0, true));
  for (const result of mutant) {
    console.log(`[phaser:bar3:transparent-padding:mutant] ${info.project.name} ${JSON.stringify(result)}`);
    expect(result.measured).toBeGreaterThan(0);
    expect(result.changed).toBeGreaterThan(0);
    expect(result.maxDelta).toBeGreaterThan(result.toleranceUNORM8);
  }
});

test('Phaser #17 bar 6: deferred kinds/clip/dark/pma and malformed data refuse by name atomically', async ({ page }, info) => {
  await open(page);
  const cases = await page.evaluate(() => window.phaserHarness.refusalProbe());
  expect(cases.length).toBeGreaterThanOrEqual(6);
  for (const result of cases) {
    console.log(`[phaser:bar6] ${info.project.name} ${JSON.stringify(result)}`);
    expect(result.message).toContain(`slot "${result.name}"`);
    expect(result.message).toContain('page "');
    expect(result.message).toContain('expected');
    expect(result.retained).toBe(true);
  }
});

test('Phaser #17 bar 5: all built inputs retain hashes, planted digest change red', () => {
  const after = digests();
  expect(after).toEqual(before);
  const key = Object.keys(after)[0];
  expect({ ...after, [key]: 'mutant' }).not.toEqual(before);
  console.log(`[phaser:bar5] ${Object.keys(after).length} built files byte-identical; digest-change RED`);
});
