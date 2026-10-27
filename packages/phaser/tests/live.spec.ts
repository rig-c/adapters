import { expect, test } from '@playwright/test';

test.describe('Issue #76 Phaser live-frame contract', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/packages/phaser/tests/harness.html');
    await page.waitForFunction(() => Boolean(window.phaserLiveHarness));
  });

  for (const rigName of ['spineboy', 'raptor']) for (const checked of [false, true]) {
    test(`runtime ${rigName}: checked=${checked}, no steady snapshots and stable buffers`, async ({ page }) => {
      const result = await page.evaluate((options) => window.phaserLiveHarness.liveLeaseProbe(options), { rigName, checked });
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
      const result = await page.evaluate((options) => window.phaserLiveHarness.liveLeaseProbe(options), { rigName: 'raptor', checked: true, mutant });
      if (mutant === 'snapshot') expect(result.snapshotCalls).toBeGreaterThan(0);
      if (mutant === 'buffers') expect(result.stableBuffers).toBe(false);
      if (mutant === 'last-drawn') expect(result.lastDrawSurvivesDirectMutation).toBe(false);
      if (mutant === 'fresh-lease') expect(result.staleRefused).toBe(false);
      if (mutant === 'metadata-cache') expect(result.repeatedStaticIndexReads).toBeGreaterThan(0);
    }
  });

  test('oracle fallback retains the last draw and rejects checked stale leases before scene changes', async ({ page }) => {
    for (const rigName of ['figure', 'glow']) {
      const result = await page.evaluate((name) => window.phaserLiveHarness.oracleRetentionProbe(name), rigName);
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
    for (const options of pictures) {
      const result = await page.evaluate((options) => window.phaserLiveHarness.livePictureProbe(options), options);
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
      const options = {
        rigName: mutant === 'clip' ? 'figure' : mutant === 'dark' ? 'duo' : mutant === 'order' ? 'walk' : 'glow',
        animation: mutant === 'clip' ? 'mask' : mutant === 'dark' ? 'shift' : undefined,
        time: 0.5, pma: mutant === 'pma', mutant,
      };
      const result = await page.evaluate((options) => window.phaserLiveHarness.livePictureProbe(options), options);
      console.log(JSON.stringify({ mutant, ...result }));
      expect(result.contentPixels).toBeGreaterThan(0);
      expect(result.byteDifferences).toBeGreaterThan(0);
    }
  });

  test('pose-column before/after figure (spineboy and raptor, 100 instances, same run)', async ({ page }, testInfo) => {
    for (const rigName of ['spineboy', 'raptor'] as const) {
      const result = await page.evaluate((options) => window.phaserLiveHarness.poseColumnProbe(options), { rigName, instances: 100 });
      console.log(JSON.stringify({ engine: 'phaser', browser: testInfo.project.name, ...result }));
      expect(result.instances).toBe(100);
      expect(result.before.poseP50Ms).toBeGreaterThan(0);
      expect(result.after.poseP50Ms).toBeGreaterThan(0);
    }
  });
});
