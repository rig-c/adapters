import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.describe('Issue #66 live-frame contract', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/packages/pixi/tests/harness.html');
    await page.waitForFunction(() => Boolean(window.rigAdaptersHarness));
  });

  for (const rigName of ['spineboy', 'raptor']) for (const checked of [false, true]) {
    test(`runtime ${rigName}: checked=${checked}, no steady snapshots and stable buffers`, async ({ page }) => {
      const result = await page.evaluate(options => window.rigAdaptersHarness.liveLeaseProbe(options), { rigName, checked });
      console.log(JSON.stringify(result));
      expect(result.poser).toBe('runtime');
      expect(result.snapshotCalls).toBe(0);
      expect(result.hotError).toBeNull();
      expect(result.meshCount).toBeGreaterThan(0);
      expect(result.firstStaticIndexReads).toBeGreaterThan(0);
      expect(result.repeatedStaticIndexReads).toBe(0);
      for (const field of ['stableBuffers', 'equalCurrent', 'lastDrawSurvivesDirectMutation', 'retainedSurvivesNextDraw', 'explicitSnapshotIdentity'] as const) expect(result[field]).toBe(true);
      if (checked) for (const field of ['readonlyRefused', 'staleRefused', 'sceneUnchanged', 'nestedStale', 'colorInvalidates'] as const) expect(result[field]).toBe(true);
    });
  }

  test('defects: snapshot hot loop, buffer replacement, current-pose readback and fresh-lease substitution fail their gates', async ({ page }) => {
    for (const mutant of ['snapshot', 'buffers', 'last-drawn', 'fresh-lease', 'metadata-cache'] as const) {
      const result = await page.evaluate(options => window.rigAdaptersHarness.liveLeaseProbe(options), { rigName: 'raptor', checked: true, mutant });
      if (mutant === 'snapshot') expect(result.snapshotCalls).toBeGreaterThan(0);
      if (mutant === 'buffers') expect(result.stableBuffers).toBe(false);
      if (mutant === 'last-drawn') expect(result.lastDrawSurvivesDirectMutation).toBe(false);
      if (mutant === 'fresh-lease') expect(result.staleRefused).toBe(false);
      if (mutant === 'metadata-cache') expect(result.repeatedStaticIndexReads).toBeGreaterThan(0);
    }
  });

  test('oracle fallback retains the last draw and rejects checked stale leases before scene changes', async ({ page }) => {
    for (const rigName of ['figure', 'glow']) {
      const result = await page.evaluate(name => window.rigAdaptersHarness.oracleRetentionProbe(name), rigName);
      expect(result.poser).toContain('oracle:');
      for (const field of ['equalCurrent', 'retainedLastDraw', 'staleRefused', 'nestedStale', 'unchangedScene', 'retainedAfterNextDraw', 'nextEqualCurrent'] as const) expect(result[field]).toBe(true);
    }
  });

  const pictures = [
    { rigName: 'spineboy', time: 0.5, poser: 'auto' as const },
    { rigName: 'raptor', time: 0.5, poser: 'auto' as const },
    { rigName: 'flex', time: 0.5 },
    { rigName: 'figure', animation: 'mask', time: 0.5 },
    { rigName: 'figure', animation: 'inverse', time: 0.5 },
    { rigName: 'figure', animation: 'nested', time: 0.5 },
    { rigName: 'glow', time: 0.5 },
    { rigName: 'glow', time: 0.5, pma: true },
    { rigName: 'duo', animation: 'shift', time: 0.5 },
    { rigName: 'turned', time: 0.5 },
  ];
  test('runtime and oracle: snapshot and checked live pictures are byte-identical, including clip/dark/blend/pma/order', async ({ page }) => {
    for (const picture of pictures) for (const checked of [false, true]) {
      const options = { ...picture, checked };
      const result = await page.evaluate(options => window.rigAdaptersHarness.livePictureProbe(options), options);
      console.log(JSON.stringify({ ...options, ...result }));
      if (options.poser === 'auto') expect(result.poser).toBe('runtime');
      else expect(result.poser).toContain('oracle:');
      expect(result.contentPixels).toBeGreaterThan(0);
      expect(result.byteDifferences).toBe(0);
      if (options.rigName === 'figure') expect(result.clips).toBeGreaterThan(0);
      if (options.rigName === 'duo') expect(result.darks).toBeGreaterThan(0);
      if (options.rigName === 'glow') expect(result.blends).toContain('Additive');
    }
  });

  test('picture defects produce nonzero byte differences', async ({ page }) => {
    for (const mutant of ['vertices', 'clip', 'dark', 'pma', 'order'] as const) {
      const options = { rigName: mutant === 'clip' ? 'figure' : mutant === 'dark' ? 'duo' : mutant === 'order' ? 'walk' : 'glow',
        animation: mutant === 'clip' ? 'mask' : mutant === 'dark' ? 'shift' : undefined,
        time: 0.5, pma: mutant === 'pma', mutant };
      const result = await page.evaluate(options => window.rigAdaptersHarness.livePictureProbe(options), options);
      console.log(JSON.stringify({ mutant, ...result }));
      expect(result.contentPixels).toBeGreaterThan(0);
      expect(result.byteDifferences).toBeGreaterThan(0);
    }
  });

  test('immutable origin adapter and live adapter pictures have zero differing bytes', async ({ page }, testInfo) => {
    let originCode: string | undefined;
    const bundle = process.env.PIXI_BASELINE_BUNDLE;
    if (bundle !== undefined) {
      try {
        originCode = readFileSync(bundle, 'utf8');
      } catch {
        const message = 'HOLE: PIXI_ORIGIN_BASELINE_UNREADABLE: cannot read the supplied baseline bundle';
        console.log(message);
        throw new Error(message);
      }
    }
    if (originCode === undefined) {
      const message = `${process.env.CI ? 'HOLE' : 'SKIP'}: PIXI_ORIGIN_BASELINE_MISSING: supply PIXI_BASELINE_BUNDLE from prepare-pixi-baseline.mjs`;
      console.log(message);
      if (process.env.CI) throw new Error(message);
      test.skip(true, message);
      return;
    }
    if (originCode.trim().length === 0) {
      const message = 'HOLE: PIXI_ORIGIN_BASELINE_EMPTY: supplied baseline bundle is empty';
      console.log(message);
      throw new Error(message);
    }
    for (const picture of pictures) for (const checked of [false, true]) {
      const options = { ...picture, checked };
      const result = await page.evaluate(options => window.rigAdaptersHarness.livePictureProbe(options), { ...options, originCode });
      console.log(JSON.stringify({
        gate: 'PIXI_ORIGIN_BYTE_IDENTITY', browser: testInfo.project.name,
        rig: options.rigName, animation: options.animation ?? null, time: options.time, pma: options.pma ?? false,
        originBaseline: result.originBaseline, contentPixels: result.contentPixels, byteDifferences: result.byteDifferences,
      }));
      expect(result.originBaseline).toBe(true);
      expect(result.contentPixels).toBeGreaterThan(0);
      expect(result.byteDifferences).toBe(0);
    }
  });
});


test.describe('Issue #56 production tuple boundary', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/packages/pixi/tests/harness.html');
    await page.waitForFunction(() => Boolean(window.rigAdaptersHarness));
  });
  for (const field of ['tint', 'dark', 'corners', 'vertices'] as const) {
    test(`${field}: checked named refusals and unchecked validation negative control`, async ({ page }) => {
      for (const invalid of ['finite', 'length'] as const) {
        const result = await page.evaluate(options => window.rigAdaptersHarness.tupleValidationProbe(options), { checked: true, field, invalid });
        console.log(JSON.stringify(result));
        expect(result.message).toContain(result.slot);
        if (field === 'tint' && invalid === 'length') expect(result.message).toContain('tint slotIndex');
        else { expect(result.message).toContain(result.page!); expect(result.message).toContain(field); }
        // Plant the missing dynamic-check defect: the same input loses its named refusal.
        if (!(field === 'tint' && invalid === 'length')) {
          const mutant = await page.evaluate(options => window.rigAdaptersHarness.tupleValidationProbe(options), { checked: true, field, invalid, mutant: true });
          expect(mutant.message).not.toContain(result.message);
        }
      }
      const normal = await page.evaluate(options => window.rigAdaptersHarness.tupleValidationProbe(options), { checked: false, field });
      const mutant = await page.evaluate(options => window.rigAdaptersHarness.tupleValidationProbe(options), { checked: false, field, mutant: true });
      expect(normal.message).toBe('');
      expect(normal.reads).toBe(0);
      expect(mutant.reads).toBeGreaterThan(0);
      console.log(JSON.stringify({ field, uncheckedReads: normal.reads, plantedValidationReads: mutant.reads }));
    });
  }
});


test('Issue #56 native live mesh copy follows generations and holds buffers', async ({ page }) => {
  await page.goto('/packages/pixi/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigAdaptersHarness));
  const result = await page.evaluate(() => window.rigAdaptersHarness.liveMeshCopyProbe());
  console.log(JSON.stringify(result));
  expect(result.changed).toBe(true);
  expect(result.nativeSource).toBe(true);
  expect(result.mismatches).toBe(0);
  expect(result.stable).toBe(true);
  expect(result.heldUploads).toBe(0);
  expect(result.transientViews).toBe(0);
  expect(result.yScale).toBe(-1);
  const planted = await page.evaluate(() => window.rigAdaptersHarness.liveMeshCopyProbe(true));
  expect(planted.mismatches).toBeGreaterThan(0);
  const plantedView = await page.evaluate(() => window.rigAdaptersHarness.liveMeshCopyProbe(false, true));
  expect(plantedView.transientViews).toBeGreaterThan(0);
  expect(plantedView.mismatches).toBe(0);
});


test('Issue #88 slot counters reuse storage and reset occurrences across draws and rollover', async ({ page }) => {
  await page.goto('/packages/pixi/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.rigAdaptersHarness));
  const normal = await page.evaluate(() => window.rigAdaptersHarness.slotCounterProbe());
  console.log(JSON.stringify({ slotCounters: normal }));
  expect(normal.steadySets).toBe(0);
  for (const field of ['recordsReused', 'poolStable', 'positionsMatch', 'rolloverCorrect'] as const) expect(normal[field]).toBe(true);
  const rebuild = await page.evaluate(() => window.rigAdaptersHarness.slotCounterProbe('rebuild'));
  expect(rebuild.steadySets).toBeGreaterThan(0);
  expect(rebuild.recordsReused).toBe(false);
  const carry = await page.evaluate(() => window.rigAdaptersHarness.slotCounterProbe('carry'));
  expect(carry.poolStable).toBe(false);
});
