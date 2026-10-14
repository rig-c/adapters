import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { BLEND_PIXI, tintToPixi } from '../src/index.ts';
import {
  BAD_RATIO_LIMIT,
  CHANNEL_TOLERANCE,
  CONTENT_MISMATCH_LIMIT,
  diffBase64InPage,
} from './pixelDiff.ts';

const HARNESS_URL = '/tests/harness.html';
const GALLERY_RIGS = ['walk', 'flex', 'ride'] as const;
const SAMPLE_TIMES = [0, 0.5, 1.2] as const;

const RIGS_DIR = join(process.cwd(), 'public', 'rigs');
const SRC_DIR = join(process.cwd(), 'src');

function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results.sort();
}

function snapshotDigests(baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const file of walkFiles(baseDir)) {
    const rel = relative(baseDir, file);
    const hash = createHash('sha256').update(readFileSync(file)).digest('hex');
    map.set(rel, hash);
  }
  return map;
}

function compareDigests(before: Map<string, string>, after: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const [file, hash] of before.entries()) {
    const afterHash = after.get(file);
    if (afterHash === undefined) {
      diffs.push(`deleted: ${file}`);
    } else if (afterHash !== hash) {
      diffs.push(`modified: ${file} (${hash.slice(0, 12)} -> ${afterHash.slice(0, 12)})`);
    }
  }
  for (const file of after.keys()) {
    if (!before.has(file)) {
      diffs.push(`added: ${file}`);
    }
  }
  return diffs;
}

const FORBIDDEN_PATTERNS = [/@esotericsoftware/i, /\bspine\b/i, /spine-core/i];

function scanForForbiddenReferences(
  srcDir: string,
  lockfilePath: string,
  pkgJsonPath: string,
): string[] {
  const hits: string[] = [];

  for (const file of walkFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pat of FORBIDDEN_PATTERNS) {
        if (pat.test(lines[i])) {
          hits.push(`${relative(srcDir, file)}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  }

  if (statSync(lockfilePath, { throwIfNoEntry: false })) {
    const lockText = readFileSync(lockfilePath, 'utf8');
    const lines = lockText.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const pat of FORBIDDEN_PATTERNS) {
        if (pat.test(lines[i])) {
          hits.push(`bun.lock:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
  }

  if (statSync(pkgJsonPath, { throwIfNoEntry: false })) {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies'] as const) {
      const deps = pkg[section] ?? {};
      for (const name of Object.keys(deps)) {
        for (const pat of FORBIDDEN_PATTERNS) {
          if (pat.test(name)) {
            hits.push(`package.json#${section}: ${name}`);
          }
        }
      }
    }
  }

  return hits;
}

async function openHarness(page: Page): Promise<void> {
  await page.goto(HARNESS_URL);
  await page.waitForFunction(() => Boolean(window.rigAdaptersHarness));
}

let initialRigDigests: Map<string, string>;

test.beforeAll(() => {
  initialRigDigests = snapshotDigests(RIGS_DIR);
  expect(initialRigDigests.size).toBeGreaterThan(0);
});

test.describe('Issue #2 — PixiRenderer for region slots', () => {
  test('Bar 1: Geometry — every region slot lands where PosedFrame puts it (plus mutant controls)', async ({
    page,
  }, testInfo) => {
    await openHarness(page);

    for (const rigName of GALLERY_RIGS) {
      const inventory = await page.evaluate(
        (r) => window.rigAdaptersHarness.inspectRigSlots(r, 0),
        rigName,
      );
      console.log(
        `[bar1:inventory] ${testInfo.project.name} ${rigName} (${inventory.animation}): ` +
          `total=${inventory.totalSlots}, region=${inventory.regionSlots.length}, ` +
          `mesh=${inventory.meshSlots.length}` +
          (inventory.meshSlots.length > 0
            ? ` (${inventory.meshSlots.map((m) => m.slot).join(', ')})`
            : ''),
      );

      for (const time of SAMPLE_TIMES) {
        const res = await page.evaluate(
          ({ r, t }) => window.rigAdaptersHarness.geometryProbe({ rigName: r, time: t }),
          { r: rigName, t: time },
        );

        console.log(
          `[bar1] ${testInfo.project.name} ${rigName}@${time}s: ` +
            `children=${res.childrenCount}/${res.orderCount}, ` +
            `orderMatches=${res.orderMatches}, ` +
            `maxCornerDeltaPx=${res.maxCornerDeltaPx.toExponential(3)}`,
        );

        expect(res.childrenCount).toBe(res.orderCount);
        expect(res.childrenCount).toBeGreaterThan(0);
        expect(res.orderMatches).toBe(true);
        expect(res.childLabels).toEqual(res.orderNames);
        expect(res.maxCornerDeltaPx).toBeLessThanOrEqual(1e-6);

        if (rigName === 'flex') {
          expect(res.unfilteredMeshCount).toBe(4);
          expect(res.unfilteredRefusalMessage).toContain('flag_a');
          expect(res.unfilteredRefusalMessage).toContain('parts/flag_a.png');
        } else {
          expect(res.unfilteredMeshCount).toBe(0);
        }
      }
    }

    // Negative controls (mutants): swapping children or shifting a corner must fail Bar 1.
    const swapped = await page.evaluate(() =>
      window.rigAdaptersHarness.geometryProbe({
        rigName: 'walk',
        time: 0.5,
        mutant: 'swap-order',
      }),
    );
    expect(swapped.orderMatches).toBe(false);

    const shifted = await page.evaluate(() =>
      window.rigAdaptersHarness.geometryProbe({
        rigName: 'walk',
        time: 0.5,
        mutant: 'shift-corner',
      }),
    );
    expect(shifted.maxCornerDeltaPx).toBeGreaterThan(1e-6);
  });

  test('Bar 2: Picture — matches @rig-c/play CanvasRenderer on walk, flex, ride at t=0, 0.5, 1.2s (plus drop/swap mutants)', async ({
    page,
  }, testInfo) => {
    await openHarness(page);

    for (const rigName of GALLERY_RIGS) {
      for (const time of SAMPLE_TIMES) {
        const cap = await page.evaluate(
          ({ r, t }) => window.rigAdaptersHarness.pictureCaptureProbe({ rigName: r, time: t }),
          { r: rigName, t: time },
        );
        expect(cap.canvasBackendActive).toBe('webgl');

        const m = await diffBase64InPage(page, cap.canvasPngBase64, cap.pixiPngBase64);
        const badRatio = m.bad / Math.max(1, m.contentUnion);
        const contentMismatch =
          Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB);

        console.log(
          `[bar2] ${testInfo.project.name} ${rigName}@${time}s: ${m.width}x${m.height}, ` +
            `content a=${m.contentA} b=${m.contentB} union=${m.contentUnion}, ` +
            `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(4)}% of content, ch>${CHANNEL_TOLERANCE}), ` +
            `maxDelta=${m.maxDelta}, contentMismatch=${(contentMismatch * 100).toFixed(4)}%`,
        );

        expect(m.contentUnion).toBeGreaterThan(5000);
        expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
        expect(contentMismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
      }
    }

    // Negative control 1: dropping one slot must fail the picture check.
    const droppedCap = await page.evaluate(() =>
      window.rigAdaptersHarness.pictureCaptureProbe({
        rigName: 'walk',
        time: 0.5,
        mutant: 'drop-slot',
      }),
    );
    const droppedDiff = await diffBase64InPage(
      page,
      droppedCap.canvasPngBase64,
      droppedCap.pixiPngBase64,
    );
    const droppedBadRatio = droppedDiff.bad / Math.max(1, droppedDiff.contentUnion);
    const droppedMismatch =
      Math.abs(droppedDiff.contentA - droppedDiff.contentB) /
      Math.max(1, droppedDiff.contentA, droppedDiff.contentB);
    console.log(
      `[bar2:mutant:drop-slot] ${testInfo.project.name} walk@0.5s: ` +
        `bad=${droppedDiff.bad} (${(droppedBadRatio * 100).toFixed(3)}%), ` +
        `contentMismatch=${(droppedMismatch * 100).toFixed(3)}%`,
    );
    expect(droppedBadRatio > BAD_RATIO_LIMIT || droppedMismatch > CONTENT_MISMATCH_LIMIT).toBe(
      true,
    );

    // Negative control 2: swapping two slots in order must fail the picture check.
    const swappedCap = await page.evaluate(() =>
      window.rigAdaptersHarness.pictureCaptureProbe({
        rigName: 'walk',
        time: 0.5,
        mutant: 'swap-order',
      }),
    );
    const swappedDiff = await diffBase64InPage(
      page,
      swappedCap.canvasPngBase64,
      swappedCap.pixiPngBase64,
    );
    const swappedBadRatio = swappedDiff.bad / Math.max(1, swappedDiff.contentUnion);
    console.log(
      `[bar2:mutant:swap-order] ${testInfo.project.name} walk@0.5s: ` +
        `bad=${swappedDiff.bad} (${(swappedBadRatio * 100).toFixed(3)}%)`,
    );
    expect(swappedBadRatio).toBeGreaterThan(BAD_RATIO_LIMIT);
  });

  test('Bar 3: Tint and blend — table mapping and glow rig additive slots pass Bar 2 (plus blend/tint mutants)', async ({
    page,
  }, testInfo) => {
    // 1. Verify table mapping of all four blend modes and tint helper.
    expect(BLEND_PIXI).toEqual({
      Normal: 'normal',
      Additive: 'add',
      Multiply: 'multiply',
      Screen: 'screen',
    });
    expect(tintToPixi([1, 0.5, 0, 0.75])).toEqual({
      color: 0xff8000,
      alpha: 0.75,
    });

    await openHarness(page);

    const glowInventory = await page.evaluate(() =>
      window.rigAdaptersHarness.inspectRigSlots('glow', 0.5),
    );
    console.log(
      `[bar3:inventory] ${testInfo.project.name} glow (${glowInventory.animation}): ` +
        `total=${glowInventory.totalSlots}, region=${glowInventory.regionSlots.join(',')}, ` +
        `mesh=${glowInventory.meshSlots.map((m) => m.slot).join(',')}`,
    );
    expect(glowInventory.regionSlots).toEqual(['halo', 'body', 'spark_a', 'spark_b']);
    expect(glowInventory.meshSlots.map((m) => m.slot)).toEqual(['flame', 'core']);

    for (const time of SAMPLE_TIMES) {
      const cap = await page.evaluate(
        (t) => window.rigAdaptersHarness.pictureCaptureProbe({ rigName: 'glow', time: t }),
        time,
      );
      expect(cap.canvasBackendActive).toBe('webgl');

      const additiveSlots = cap.slotStates.filter((s) => s.blend === 'Additive');
      expect(additiveSlots.map((s) => s.slot)).toEqual(['halo', 'spark_a', 'spark_b']);
      for (const state of cap.slotStates) {
        expect(state.pixiBlendMode).toBe(
          BLEND_PIXI[state.blend as keyof typeof BLEND_PIXI],
        );
        expect(state.pixiTintHex).toBe(state.expectedTintHex);
        expect(state.pixiAlpha).toBeCloseTo(state.expectedAlpha, 6);
      }

      const m = await diffBase64InPage(page, cap.canvasPngBase64, cap.pixiPngBase64);
      const badRatio = m.bad / Math.max(1, m.contentUnion);
      const contentMismatch =
        Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB);

      console.log(
        `[bar3] ${testInfo.project.name} glow@${time}s: ${m.width}x${m.height}, ` +
          `content a=${m.contentA} b=${m.contentB} union=${m.contentUnion}, ` +
          `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(4)}% of content, ch>${CHANNEL_TOLERANCE}), ` +
          `maxDelta=${m.maxDelta}, contentMismatch=${(contentMismatch * 100).toFixed(4)}%`,
      );

      expect(m.contentUnion).toBeGreaterThan(5000);
      expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
      expect(contentMismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
    }

    // Negative control 1: rendering Additive slots as Normal on glow@0.5s.
    // Because `halo` is drawn first onto transparent canvas (behind `body`) and
    // `flame` is a mesh slot, the region-only overlap of `spark_a`/`spark_b` over
    // `halo`'s outer fringe has channel delta <= 22 (under CHANNEL_TOLERANCE=24),
    // but diverges from CanvasRenderer's 0-delta match under exact comparison (tolerance=0).
    const badBlendCap = await page.evaluate(() =>
      window.rigAdaptersHarness.pictureCaptureProbe({
        rigName: 'glow',
        time: 0.5,
        mutant: 'additive-as-normal',
      }),
    );
    const badBlendDiff24 = await diffBase64InPage(
      page,
      badBlendCap.canvasPngBase64,
      badBlendCap.pixiPngBase64,
    );
    const badBlendDiff0 = await diffBase64InPage(
      page,
      badBlendCap.canvasPngBase64,
      badBlendCap.pixiPngBase64,
      { tolerance: 0 },
    );
    console.log(
      `[bar3:mutant:additive-as-normal] ${testInfo.project.name} glow@0.5s: ` +
        `ch>24 bad=${badBlendDiff24.bad}, ch>0 rawBad=${badBlendDiff0.rawBad} bad=${badBlendDiff0.bad} maxDelta=${badBlendDiff0.maxDelta}`,
    );
    expect(badBlendDiff0.bad).toBeGreaterThan(100);
    expect(badBlendDiff0.maxDelta).toBeGreaterThanOrEqual(10);

    // Negative control 2: dropping slot tint on glow must fail the picture gate (ch>24).
    const badTintCap = await page.evaluate(() =>
      window.rigAdaptersHarness.pictureCaptureProbe({
        rigName: 'glow',
        time: 0.5,
        mutant: 'drop-tint',
      }),
    );
    const badTintDiff = await diffBase64InPage(
      page,
      badTintCap.canvasPngBase64,
      badTintCap.pixiPngBase64,
    );
    const badTintRatio = badTintDiff.bad / Math.max(1, badTintDiff.contentUnion);
    console.log(
      `[bar3:mutant:drop-tint] ${testInfo.project.name} glow@0.5s: ` +
        `bad=${badTintDiff.bad} (${(badTintRatio * 100).toFixed(3)}%), maxDelta=${badTintDiff.maxDelta}`,
    );
    expect(badTintRatio).toBeGreaterThan(BAD_RATIO_LIMIT);
  });

  test('Bar 4: No external runtime in the graph or src/ (plus planted-hit mutant)', async () => {
    const lockPath = join(process.cwd(), 'bun.lock');
    const pkgPath = join(process.cwd(), 'package.json');
    const hits = scanForForbiddenReferences(SRC_DIR, lockPath, pkgPath);
    console.log(`[bar4] hits in src/, bun.lock, package.json: ${hits.length === 0 ? '(empty)' : hits.join('; ')}`);
    expect(hits).toEqual([]);

    // Negative control: plant a hit in a temp directory and verify the scanner catches it.
    const tempDir = mkdtempSync(join(tmpdir(), 'rig-adapters-bar4-'));
    try {
      const plantedSrc = join(tempDir, 'src');
      const plantedFile = join(plantedSrc, 'planted.ts');
      const plantedLock = join(tempDir, 'bun.lock');
      const plantedPkg = join(tempDir, 'package.json');
      writeFileSync(plantedPkg, JSON.stringify({ dependencies: { '@esotericsoftware/spine-core': '4.2.0' } }));
      writeFileSync(plantedLock, '  "@esotericsoftware/spine-core@4.2.0": {}\n');
      mkdirSync(plantedSrc, { recursive: true });
      writeFileSync(plantedFile, 'import { Skeleton } from "@esotericsoftware/spine-core";\n');

      const plantedHits = scanForForbiddenReferences(plantedSrc, plantedLock, plantedPkg);
      console.log(`[bar4:mutant:planted] hits=${plantedHits.length}: ${plantedHits.join(' | ')}`);
      expect(plantedHits.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('Bar 6: Refusals by name — missing page, mesh kind, clip, dark, pma, invalid blend', async ({
    page,
  }, testInfo) => {
    await openHarness(page);
    const cases = await page.evaluate(() => window.rigAdaptersHarness.refusalProbe());

    for (const c of cases) {
      console.log(
        `[bar6] ${testInfo.project.name} ${c.name}: threw=${c.threw}, ` +
          `childrenAfterThrow=${c.childrenAfterThrow}, message="${c.message}"`,
      );
      expect(c.threw).toBe(true);
    }

    const byName = new Map(cases.map((c) => [c.name, c]));

    // 1. Missing page in assets.pageImages names both the slot and the missing page.
    const missingPage = byName.get('missing-page')!;
    expect(missingPage.message).toMatch(/slot "[^"]+"/);
    expect(missingPage.message).toMatch(/page "parts\/[^"]+\.png"/);
    expect(missingPage.message).toContain('missing from assets.pageImages');
    expect(missingPage.childrenAfterThrow).toBe(0);

    // 2. Unfiltered `flex` refuses on its first mesh slot (`flag_a`, `parts/flag_a.png`)
    //    and preserves the previous valid render's 15 children.
    const flexMesh = byName.get('real-flex-mesh')!;
    expect(flexMesh.message).toContain('slot "flag_a"');
    expect(flexMesh.message).toContain('page "parts/flag_a.png"');
    expect(flexMesh.message).toContain('unsupported kind "mesh"');
    expect(flexMesh.childrenAfterThrow).toBe(15);

    // 3. Unfiltered `glow` refuses on its first mesh slot (`flame`, `parts/flame.png`)
    //    and preserves the previous valid render's 4 children.
    const glowMesh = byName.get('real-glow-mesh')!;
    expect(glowMesh.message).toContain('slot "flame"');
    expect(glowMesh.message).toContain('page "parts/flame.png"');
    expect(glowMesh.message).toContain('unsupported kind "mesh"');
    expect(glowMesh.childrenAfterThrow).toBe(4);

    // 4. Synthetic mesh slot names `synthetic_cloth` and its page.
    const synthMesh = byName.get('synthetic-mesh')!;
    expect(synthMesh.message).toContain('slot "synthetic_cloth"');
    expect(synthMesh.message).toContain('unsupported kind "mesh"');
    expect(synthMesh.childrenAfterThrow).toBe(0);

    // 5. Unhandled PosedFrame fields (`clip`, `dark`, `pma`) and invalid `blend` refuse by name.
    expect(byName.get('unsupported-clip')!.message).toContain('slot "clipped_visor"');
    expect(byName.get('unsupported-clip')!.message).toContain('clip polygon');
    expect(byName.get('unsupported-dark')!.message).toContain('slot "dark_tinted_head"');
    expect(byName.get('unsupported-dark')!.message).toContain('dark tint');
    expect(byName.get('unsupported-pma')!.message).toContain('slot "pma_region_slot"');
    expect(byName.get('unsupported-pma')!.message).toContain('pma=true');
    expect(byName.get('invalid-blend')!.message).toContain('slot "bad_blend_slot"');
    expect(byName.get('invalid-blend')!.message).toContain('unsupported blend mode "Subtract"');
  });

  test('Bar 5: Unmodified inputs — every file rigc build wrote is byte-identical after the suite (plus mutant)', async () => {
    const afterDigests = snapshotDigests(RIGS_DIR);
    const diffs = compareDigests(initialRigDigests, afterDigests);
    console.log(
      `[bar5] hashed ${afterDigests.size} rig files across public/rigs/: diffs=${diffs.length === 0 ? '(empty)' : diffs.join(', ')}`,
    );
    expect(afterDigests.size).toBe(initialRigDigests.size);
    expect(diffs).toEqual([]);

    // Negative control: mutate one digest entry and verify compareDigests catches it.
    const mutatedAfter = new Map(afterDigests);
    const firstKey = mutatedAfter.keys().next().value as string;
    mutatedAfter.set(firstKey, '0'.repeat(64));
    const mutantDiffs = compareDigests(initialRigDigests, mutatedAfter);
    console.log(`[bar5:mutant] detected: ${mutantDiffs.join(', ')}`);
    expect(mutantDiffs.length).toBe(1);
    expect(mutantDiffs[0]).toContain(firstKey);
  });
});
