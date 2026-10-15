import { expect, test, type Page } from '@playwright/test';
import { diffBase64InPage } from '@rig-c/adapters-shared/parity';

const RIGS: ReadonlyArray<{ rig: string; animation: string }> = [
  { rig: 'walk', animation: 'walk' },
  { rig: 'flex', animation: 'wave' },
  { rig: 'ride', animation: 'ride' },
  { rig: 'figure', animation: 'walk' },
  { rig: 'glow', animation: 'burn' },
  { rig: 'turned', animation: 'hold' },
  { rig: 'duo', animation: 'shift' },
];
const TIMES = [0, 0.5, 1];

async function open(page: Page) {
  await page.goto('/packages/phaser/tests/harness.html');
  await page.waitForFunction(() => Boolean(window.phaserLiveHarness));
}

test('Phaser #19 bar 1: PhaserRig drawn frame and ingress frame are byte-equal (JSON) to bare RigPlayer.posedFrame() across all rigs, with mutant', async ({ page }, info) => {
  await open(page);
  for (const { rig, animation } of RIGS) {
    for (const time of TIMES) {
      const result = await page.evaluate(({ rig, animation, time }) => window.phaserLiveHarness.parity(rig, animation, time), { rig, animation, time });
      console.log(`[phaser19:bar1] ${info.project.name} ${rig}/${animation}@${time} ${JSON.stringify(result)}`);
      expect(result.initial).toBe(true);
      expect(result.seekEqual).toBe(true);
      expect(result.advanceEqual).toBe(true);
      expect(result.equal).toBe(true);
      expect(result.exactObject).toBe(true);
      expect(result.bounds).toBe(true);
      expect(result.bone).toBe(true);
      expect(result.allBones).toBe(true);
      expect(result.bytes).toBeGreaterThan(2);
    }
  }
  const mutant = await page.evaluate(() => window.phaserLiveHarness.parity('walk', 'walk', 0.5, true));
  console.log(`[phaser19:bar1:mutant] ${info.project.name} ${JSON.stringify(mutant)}`);
  expect(mutant.equal).toBe(false);
});

test('Phaser #19 bar 2: scene UPDATE loop fixed-delta arithmetic, real-time loop parity, timescale 0 zero-upload hold, and mutants', async ({ page }, info) => {
  await open(page);
  for (const scale of [1, 0.5, 2]) {
    const result = await page.evaluate((s) => window.phaserLiveHarness.fixedUpdates(s), scale);
    console.log(`[phaser19:bar2:fixed] ${info.project.name} scale=${scale} ${JSON.stringify(result)}`);
    expect(result.deliveredCount).toBe(60);
    expect(result.calls).toBe(60);
    expect(result.deliveredExact).toBe(true);
    expect(result.conversionExact).toBe(true);
    expect(result.equal).toBe(true);
    expect(result.timeEqual).toBe(true);
    expect(result.listenerDelta).toBe(0);
    expect(result.uploaded).toBeGreaterThan(0);
    expect(result.textureUploads).toBe(0);
  }

  const zero = await page.evaluate(() => window.phaserLiveHarness.fixedUpdates(0));
  console.log(`[phaser19:bar2:zero] ${info.project.name} ${JSON.stringify(zero)}`);
  expect(zero.deliveredCount).toBe(60);
  expect(zero.calls).toBe(60);
  expect(zero.rigTime).toBe(0.5);
  expect(zero.bareTime).toBe(0.5);
  expect(zero.equal).toBe(true);
  expect(zero.timeEqual).toBe(true);
  expect(zero.uploaded).toBe(0);
  expect(zero.textureUploads).toBe(0);

  const manual = await page.evaluate(() => window.phaserLiveHarness.fixedUpdates(1, 'none', true));
  console.log(`[phaser19:bar2:manual] ${info.project.name} ${JSON.stringify(manual)}`);
  expect(manual.heldManual).toBe(true);
  expect(manual.calls).toBe(1);
  expect(manual.equal).toBe(true);
  expect(manual.timeEqual).toBe(true);

  const realtime = await page.evaluate(() => window.phaserLiveHarness.realTimeStep());
  console.log(`[phaser19:bar2:realtime] ${info.project.name} ${JSON.stringify(realtime)}`);
  expect(realtime.delivered).toHaveLength(6);
  expect(realtime.equal).toBe(true);
  expect(Object.is(realtime.rigTime, realtime.bareTime)).toBe(true);

  const dropMutant = await page.evaluate(() => window.phaserLiveHarness.fixedUpdates(1, 'drop-update'));
  const doubleScaleMutant = await page.evaluate(() => window.phaserLiveHarness.fixedUpdates(0.5, 'double-scale'));
  const ignoreZeroMutant = await page.evaluate(() => window.phaserLiveHarness.fixedUpdates(0, 'ignore-zero'));
  const alwaysUploadMutant = await page.evaluate(() => window.phaserLiveHarness.fixedUpdates(0, 'always-upload'));
  console.log(`[phaser19:bar2:mutants] ${info.project.name} drop=${dropMutant.equal} doubleScale=${doubleScaleMutant.equal} ignoreZeroUploads=${ignoreZeroMutant.uploaded} alwaysUpload=${alwaysUploadMutant.uploaded}`);
  expect(dropMutant.equal).toBe(false);
  expect(doubleScaleMutant.equal).toBe(false);
  expect(ignoreZeroMutant.rigTime).toBeGreaterThan(0.5);
  expect(ignoreZeroMutant.uploaded).toBeGreaterThan(0);
  expect(alwaysUploadMutant.uploaded).toBeGreaterThan(0);
});

test('Phaser #19 bar 3: several instances over one load, per-instance buffer/listener teardown, last-instance GL texture release, scene lifecycle and context isolation, with leak mutant', async ({ page }, info) => {
  await open(page);
  for (const [rigName, animation, expectedPages] of [['glow', 'burn', 5], ['duo', 'shift', 1]] as const) {
    const result = await page.evaluate(({ rigName, animation }) => window.phaserLiveHarness.sharedPages(false, rigName, animation), { rigName, animation });
    console.log(`[phaser19:bar3:shared] ${info.project.name} ${rigName} ${JSON.stringify({ ...result, png: undefined })}`);
    expect(result.pages).toBe(expectedPages);
    expect(result.shared).toBe(true);
    expect(result.distinct).toBe(true);
    expect(result.phases[0].remaining).toEqual(Array(expectedPages).fill(2));
    expect(result.phases[0].deleted).toBe(0);
    expect(result.phases[0].freedBuffers).toBe(true);
    expect(result.phases[0].pixels).toBeGreaterThan(0);
    expect(result.phases[1].remaining).toEqual(Array(expectedPages).fill(1));
    expect(result.phases[1].deleted).toBe(0);
    expect(result.phases[1].freedBuffers).toBe(true);
    expect(result.phases[1].pixels).toBeGreaterThan(0);
    expect(result.phases[2].remaining).toEqual(Array(expectedPages).fill(0));
    expect(result.phases[2].deleted).toBe(expectedPages);
    expect(result.phases[2].freedBuffers).toBe(true);
    expect(result.phases[2].pixels).toBe(0);
    expect(result.exactlyOnce).toBe(true);
    expect(result.deleted).toBe(expectedPages);
    expect(result.live).toBe(0);
    expect(result.listenerDelta).toBe(0);
  }

  const leak = await page.evaluate(() => window.phaserLiveHarness.sharedPages(true, 'glow', 'burn'));
  console.log(`[phaser19:bar3:mutant:leak] ${info.project.name} ${JSON.stringify({ deleted: leak.deleted, exactlyOnce: leak.exactlyOnce })}`);
  expect(leak.deleted).toBe(0);
  expect(leak.exactlyOnce).toBe(false);

  const sceneLifecycle = await page.evaluate(() => window.phaserLiveHarness.lifecycle(false));
  const gameLifecycle = await page.evaluate(() => window.phaserLiveHarness.lifecycle(true));
  const isolation = await page.evaluate(() => window.phaserLiveHarness.contextIsolation());
  console.log(`[phaser19:bar3:lifecycle] ${info.project.name} scene=${JSON.stringify(sceneLifecycle)} game=${JSON.stringify(gameLifecycle)} isolation=${JSON.stringify(isolation)}`);
  expect(sceneLifecycle.generation).toBe(3);
  expect(sceneLifecycle.listenerDeltas).toEqual([1, 1, 1]);
  expect(sceneLifecycle.destroyed).toBe(true);
  expect(sceneLifecycle.stopped).toBe(true);
  expect(sceneLifecycle.live).toBe(0);
  expect(sceneLifecycle.deleted).toBe(sceneLifecycle.allocated);
  expect(gameLifecycle.destroyed).toBe(true);
  expect(gameLifecycle.live).toBe(0);
  expect(gameLifecycle.deleted).toBe(gameLifecycle.allocated);
  expect(isolation.separate).toBe(true);
  expect(isolation.refs).toEqual([1, 1]);
});

test('Phaser #19 bar 4: bounds() equals @rig-c/play bounds() across all rigs, times, slot filters and non-identity scene transforms, with mutants', async ({ page }, info) => {
  await open(page);
  for (const { rig } of RIGS) {
    const result = await page.evaluate((r) => window.phaserLiveHarness.boundsProbe(r), rig);
    console.log(`[phaser19:bar4:bounds] ${info.project.name} ${rig}/${result.animation} cases=${result.totalCases} allEqual=${result.allEqual}`);
    expect(result.totalCases).toBe(16);
    expect(result.allEqual).toBe(true);
    for (const item of result.cases) {
      expect(item.equal).toBe(true);
      if (item.label === 'only:[]') {
        expect(item.rigBounds).toBeNull();
        expect(item.bareBounds).toBeNull();
      } else {
        expect(item.rigBounds).not.toBeNull();
      }
    }
  }
  const ignoreFilter = await page.evaluate(() => window.phaserLiveHarness.boundsProbe('walk', 'ignore-filter'));
  const inflate = await page.evaluate(() => window.phaserLiveHarness.boundsProbe('flex', 'inflate'));
  console.log(`[phaser19:bar4:mutants] ${info.project.name} ignoreFilter=${ignoreFilter.allEqual} inflate=${inflate.allEqual}`);
  expect(ignoreFilter.allEqual).toBe(false);
  expect(inflate.allEqual).toBe(false);
});

test('Phaser #19 bar 5: demo page (?host=phaser&rig=&anim=&time=&timescale=&count=) renders deterministically in a Phaser scene, with negative controls', async ({ page }, info) => {
  const cases = [
    { rig: 'walk', anim: 'walk', time: 0.35, timescale: 0, count: 1 },
    { rig: 'flex', anim: 'wave', time: 0.5, timescale: 0, count: 1 },
    { rig: 'ride', anim: 'ride', time: 0.4, timescale: 0, count: 1 },
    { rig: 'glow', anim: 'burn', time: 0.25, timescale: 0, count: 3 },
    { rig: 'duo', anim: 'shift', time: 0.5, timescale: 0, count: 2 },
  ] as const;

  for (const c of cases) {
    const url = `/?host=phaser&rig=${c.rig}&anim=${c.anim}&time=${c.time}&timescale=${c.timescale}&count=${c.count}`;
    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.demoReady === 'true');
    const state1 = await page.evaluate(() => window.__rigAdaptersDemo!);
    const png1 = await page.evaluate(() => (document.querySelector('#pixi-stage canvas') as HTMLCanvasElement).toDataURL('image/png').split(',')[1]);

    await page.goto(url);
    await page.waitForFunction(() => document.body.dataset.demoReady === 'true');
    const state2 = await page.evaluate(() => window.__rigAdaptersDemo!);
    const png2 = await page.evaluate(() => (document.querySelector('#pixi-stage canvas') as HTMLCanvasElement).toDataURL('image/png').split(',')[1]);

    await open(page);
    const diff = await diffBase64InPage(page, png1, png2);
    console.log(`[phaser19:bar5:demo] ${info.project.name} ${url} pixels=${state1.nonEmptyPixels} pageTextures=${state1.livePageTextures} refs=${JSON.stringify(state1.pageRefCounts)} bad=${diff.bad} maxDelta=${diff.maxDelta}`);
    expect(state1.host).toBe('phaser');
    expect(state1.rigName).toBe(c.rig);
    expect(state1.animName).toBe(c.anim);
    expect(state1.time).toBeCloseTo(c.time, 6);
    expect(state1.timescale).toBe(c.timescale);
    expect(state1.instanceCount).toBe(c.count);
    expect(state1.nonEmptyPixels).toBeGreaterThan(2000);
    expect(state1.bounds).not.toBeNull();
    expect(state1.pageRefCounts?.every((ref) => ref === c.count)).toBe(true);
    expect(JSON.stringify(state1.drawnFrame)).toBe(JSON.stringify(state2.drawnFrame));
    expect(diff.bad).toBe(0);
    expect(diff.maxDelta).toBe(0);
  }

  await page.goto('/?host=phaser&rig=walk&anim=walk&time=0.1&timescale=0');
  await page.waitForFunction(() => document.body.dataset.demoReady === 'true');
  const t1 = await page.evaluate(() => (document.querySelector('#pixi-stage canvas') as HTMLCanvasElement).toDataURL('image/png').split(',')[1]);
  await page.goto('/?host=phaser&rig=walk&anim=walk&time=0.6&timescale=0');
  await page.waitForFunction(() => document.body.dataset.demoReady === 'true');
  const t2 = await page.evaluate(() => (document.querySelector('#pixi-stage canvas') as HTMLCanvasElement).toDataURL('image/png').split(',')[1]);
  await open(page);
  const timeDiff = await diffBase64InPage(page, t1, t2);
  console.log(`[phaser19:bar5:demo:time-diff] ${info.project.name} bad=${timeDiff.bad} maxDelta=${timeDiff.maxDelta}`);
  expect(timeDiff.bad).toBeGreaterThan(1000);

  await page.goto('/?host=phaser&rig=unknown_rig');
  await page.waitForFunction(() => document.body.dataset.demoReady === 'error');
  const err = await page.evaluate(() => window.__rigAdaptersDemoError);
  console.log(`[phaser19:bar5:demo:refusal] ${info.project.name} error="${err}"`);
  expect(err).toContain('unsupported rig "unknown_rig"');
});

test('Phaser #19 refusals by name, constructor rollback and frozen ModelAssets', async ({ page }, info) => {
  await open(page);
  const result = await page.evaluate(() => window.phaserLiveHarness.refusalAndFreezeProbe());
  console.log(`[phaser19:refusals] ${info.project.name} count=${result.refusals.length} listenerLeak=${result.listenerLeak} pageLeak=${result.pageLeak} frozenOk=${result.frozenOk}`);
  for (const item of result.refusals) {
    expect(item.threw).toBe(true);
  }
  const byName = new Map(result.refusals.map((item) => [item.name, item.message]));
  expect(byName.get('invalid-scene')).toContain('invalid scene');
  expect(byName.get('invalid-assets')).toContain('invalid assets');
  expect(byName.get('invalid-initial-timescale')).toContain('invalid timescale=-1');
  expect(byName.get('nan-initial-timescale')).toContain('invalid timescale=NaN');
  expect(byName.get('empty-animation-name')).toContain('invalid animation name');
  expect(byName.get('unknown-animation')).toContain('nonexistent_animation_xyz');
  expect(byName.get('empty-bone-name')).toContain('invalid bone name');
  expect(byName.get('unknown-bone')).toContain('nonexistent_bone_xyz');
  expect(byName.get('negative-dt')).toContain('invalid dt=-0.016');
  expect(byName.get('nan-dt')).toContain('invalid dt=NaN');
  expect(byName.get('negative-seek')).toContain('invalid time=-1');
  expect(byName.get('nan-seek')).toContain('invalid time=NaN');
  expect(byName.get('negative-timescale-setter')).toContain('invalid timescale=-0.5');
  expect(byName.get('play-after-destroy')).toContain('destroyed PhaserRig');
  expect(byName.get('advance-after-destroy')).toContain('destroyed PhaserRig');
  expect(byName.get('seek-after-destroy')).toContain('destroyed PhaserRig');
  expect(byName.get('bone-after-destroy')).toContain('destroyed PhaserRig');
  expect(byName.get('bounds-after-destroy')).toContain('destroyed PhaserRig');
  expect(result.listenerLeak).toBe(0);
  expect(result.pageLeak).toBe(0);
  expect(result.frozenOk).toBe(true);
});
