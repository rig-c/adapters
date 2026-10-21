import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

import { BLEND_PIXI, darkTintColorMatrix, tintToPixi } from '../src/index.ts';
import {
  BAD_RATIO_LIMIT,
  CHANNEL_TOLERANCE,
  CONTENT_MISMATCH_LIMIT,
  diffBase64InPage,
} from '@rig-c/adapters-shared/parity';

const HARNESS_URL = '/packages/pixi/tests/harness.html';
const GALLERY_RIGS = ['walk', 'flex', 'ride'] as const;
const SAMPLE_TIMES = [0, 0.5, 1.2] as const;
const ISSUE3_TIMES = [0, 0.5, 1.0] as const;
const FIGURE_ANIMATIONS = ['walk', 'mask', 'tilted', 'window', 'inverse', 'nested'] as const;

const RIGS_DIR = join(process.cwd(), 'public', 'rigs');
const SRC_DIR = join(process.cwd(), 'packages', 'pixi', 'src');

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

test.describe('Issue #2 & #3 — PixiRenderer full PosedFrame verification', () => {
  test('Issue #2 Bar 1 & #3 Bar 1: Geometry — region corners and mesh vertices land where PosedFrame puts them (plus mutants)', async ({
    page,
  }, testInfo) => {
    await openHarness(page);

    // 1. Gallery rigs (walk, flex, ride) at t = 0, 0.5, 1.2s
    for (const rigName of GALLERY_RIGS) {
      for (const time of SAMPLE_TIMES) {
        const res = await page.evaluate(
          ({ r, t }) => window.rigAdaptersHarness.geometryProbe({ rigName: r, time: t }),
          { r: rigName, t: time },
        );

        console.log(
          `[bar1:gallery] ${testInfo.project.name} ${rigName}@${time}s: ` +
            `children=${res.childrenCount}/${res.orderCount} (region=${res.regionCount}, mesh=${res.meshCount}, verts=${res.meshVertexCount}), ` +
            `orderMatches=${res.orderMatches}, maxCornerDeltaPx=${res.maxCornerDeltaPx.toExponential(3)}, ` +
            `maxMeshF32Px=${res.maxMeshDeltaF32Px.toExponential(3)}, ` +
            `maxMeshF64Px=${res.maxMeshDeltaF64Px.toExponential(3)} (f32Quant=${res.maxMeshF32QuantizationPx.toExponential(3)}, beyondQuant=${res.maxMeshBeyondF32QuantizationPx.toExponential(3)})`,
        );

        expect(res.childrenCount).toBe(res.orderCount);
        expect(res.orderMatches).toBe(true);
        expect(res.childLabels).toEqual(res.orderNames);
        expect(res.maxCornerDeltaPx).toBeLessThanOrEqual(1e-6);
        expect(res.maxMeshDeltaF32Px).toBeLessThanOrEqual(1e-6);
        expect(res.maxMeshBeyondF32QuantizationPx).toBeLessThanOrEqual(1e-6);
      }
    }

    // 2. Issue #3 Bar 1 fixtures: figure (all 6 animations), glow, turned, duo
    for (const animation of FIGURE_ANIMATIONS) {
      for (const time of ISSUE3_TIMES) {
        const res = await page.evaluate(
          ({ a, t }) =>
            window.rigAdaptersHarness.geometryProbe({
              rigName: 'figure',
              animation: a,
              time: t,
            }),
          { a: animation, t: time },
        );

        console.log(
          `[bar1:figure] ${testInfo.project.name} figure/${animation}@${time}s: ` +
            `children=${res.childrenCount}/${res.orderCount} (region=${res.regionCount}, mesh=${res.meshCount}, verts=${res.meshVertexCount}), ` +
            `maxCornerDeltaPx=${res.maxCornerDeltaPx.toExponential(3)}, ` +
            `maxMeshF32Px=${res.maxMeshDeltaF32Px.toExponential(3)}, ` +
            `maxMeshF64Px=${res.maxMeshDeltaF64Px.toExponential(3)} (f32Quant=${res.maxMeshF32QuantizationPx.toExponential(3)}, beyondQuant=${res.maxMeshBeyondF32QuantizationPx.toExponential(3)}), ` +
            `rootMasked=${res.rootMasked}, maskedChildSlots=[${res.maskedChildSlots.join(',')}]`,
        );

        expect(res.childrenCount).toBe(res.orderCount);
        expect(res.meshCount).toBe(2);
        expect(res.meshVertexCount).toBe(39);
        expect(res.orderMatches).toBe(true);
        expect(res.maxCornerDeltaPx).toBeLessThanOrEqual(1e-6);
        expect(res.maxMeshDeltaF32Px).toBeLessThanOrEqual(1e-6);
        expect(res.maxMeshBeyondF32QuantizationPx).toBeLessThanOrEqual(1e-6);

        if (
          animation === 'window' ||
          animation === 'inverse' ||
          animation === 'tilted' ||
          animation === 'nested'
        ) {
          expect(res.rootMasked).toBe(true);
          expect(res.maskedChildSlots.length).toBe(0);
        } else if (animation === 'mask') {
          expect(res.rootMasked).toBe(false);
          expect(res.maskedChildSlots.length).toBe(11);
        } else {
          expect(res.rootMasked).toBe(false);
          expect(res.maskedChildSlots.length).toBe(0);
        }
      }
    }

    for (const rigName of ['glow', 'turned', 'duo'] as const) {
      for (const time of ISSUE3_TIMES) {
        const res = await page.evaluate(
          ({ r, t }) => window.rigAdaptersHarness.geometryProbe({ rigName: r, time: t }),
          { r: rigName, t: time },
        );

        console.log(
          `[bar1:${rigName}] ${testInfo.project.name} ${rigName}@${time}s: ` +
            `children=${res.childrenCount}/${res.orderCount} (region=${res.regionCount}, mesh=${res.meshCount}, verts=${res.meshVertexCount}), ` +
            `maxCornerDeltaPx=${res.maxCornerDeltaPx.toExponential(3)}, ` +
            `maxMeshF32Px=${res.maxMeshDeltaF32Px.toExponential(3)}, ` +
            `maxMeshF64Px=${res.maxMeshDeltaF64Px.toExponential(3)} (f32Quant=${res.maxMeshF32QuantizationPx.toExponential(3)}, beyondQuant=${res.maxMeshBeyondF32QuantizationPx.toExponential(3)})`,
        );

        expect(res.childrenCount).toBe(res.orderCount);
        expect(res.orderMatches).toBe(true);
        expect(res.maxCornerDeltaPx).toBeLessThanOrEqual(1e-6);
        expect(res.maxMeshDeltaF32Px).toBeLessThanOrEqual(1e-6);
        expect(res.maxMeshBeyondF32QuantizationPx).toBeLessThanOrEqual(1e-6);

        if (rigName === 'glow') {
          expect(res.regionCount).toBe(4);
          expect(res.meshCount).toBe(2);
          expect(res.meshVertexCount).toBe(321);
        } else if (rigName === 'turned') {
          expect(res.regionCount).toBe(2);
          expect(res.meshCount).toBe(0);
        } else if (rigName === 'duo') {
          expect(res.regionCount).toBe(1);
          expect(res.meshCount).toBe(1);
          expect(res.meshVertexCount).toBe(4);
        }
      }
    }

    // Negative controls (mutants): swapping children, shifting a region corner, or shifting a mesh vertex must fail Bar 1.
    const swapped = await page.evaluate(() =>
      window.rigAdaptersHarness.geometryProbe({
        rigName: 'figure',
        animation: 'walk',
        time: 0.5,
        mutant: 'swap-order',
      }),
    );
    expect(swapped.orderMatches).toBe(false);

    const shiftedCorner = await page.evaluate(() =>
      window.rigAdaptersHarness.geometryProbe({
        rigName: 'turned',
        time: 0.5,
        mutant: 'shift-corner',
      }),
    );
    expect(shiftedCorner.maxCornerDeltaPx).toBeGreaterThan(1e-6);

    const shiftedMesh = await page.evaluate(() =>
      window.rigAdaptersHarness.geometryProbe({
        rigName: 'figure',
        animation: 'walk',
        time: 0.5,
        mutant: 'shift-mesh-vertex',
      }),
    );
    console.log(
      `[bar1:mutant:shift-mesh-vertex] ${testInfo.project.name} figure/walk@0.5s: ` +
        `maxMeshF32Px=${shiftedMesh.maxMeshDeltaF32Px.toExponential(3)}`,
    );
    expect(shiftedMesh.maxMeshDeltaF32Px).toBeGreaterThan(1e-6);
  });

  test('Issue #2 Bar 2 & #3 Bar 2: Picture — adapter vs play CanvasRenderer across gallery and test fixtures (plus mutants)', async ({
    page,
  }, testInfo) => {
    await openHarness(page);

    // 1. Gallery rigs (walk, flex with 4 meshes, ride)
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
          `[bar2:gallery] ${testInfo.project.name} ${rigName}@${time}s: ${m.width}x${m.height}, ` +
            `content a=${m.contentA} b=${m.contentB} union=${m.contentUnion}, ` +
            `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(4)}% of content, ch>${CHANNEL_TOLERANCE}), ` +
            `maxDelta=${m.maxDelta}, contentMismatch=${(contentMismatch * 100).toFixed(4)}%`,
        );

        expect(m.contentUnion).toBeGreaterThan(5000);
        expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
        expect(contentMismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
      }
    }

    // 2. Issue #3 Bar 2 fixtures: figure (all 6 animations), glow, turned, duo at 3 times
    for (const animation of FIGURE_ANIMATIONS) {
      for (const time of ISSUE3_TIMES) {
        const cap = await page.evaluate(
          ({ a, t }) =>
            window.rigAdaptersHarness.pictureCaptureProbe({
              rigName: 'figure',
              animation: a,
              time: t,
            }),
          { a: animation, t: time },
        );
        expect(cap.canvasBackendActive).toBe('webgl');

        const m = await diffBase64InPage(page, cap.canvasPngBase64, cap.pixiPngBase64);
        const badRatio = m.bad / Math.max(1, m.contentUnion);
        const contentMismatch =
          Math.abs(m.contentA - m.contentB) / Math.max(1, m.contentA, m.contentB);

        console.log(
          `[bar2:figure] ${testInfo.project.name} figure/${animation}@${time}s: ${m.width}x${m.height}, ` +
            `content a=${m.contentA} b=${m.contentB} union=${m.contentUnion}, ` +
            `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(4)}% of content, ch>${CHANNEL_TOLERANCE}), ` +
            `maxDelta=${m.maxDelta}, contentMismatch=${(contentMismatch * 100).toFixed(4)}%`,
        );

        expect(m.contentUnion).toBeGreaterThan(5000);
        expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
        expect(contentMismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
      }
    }

    for (const rigName of ['glow', 'turned', 'duo'] as const) {
      for (const time of ISSUE3_TIMES) {
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
          `[bar2:${rigName}] ${testInfo.project.name} ${rigName}@${time}s: ${m.width}x${m.height}, ` +
            `content a=${m.contentA} b=${m.contentB} union=${m.contentUnion}, ` +
            `bad=${m.bad} of ${m.rawBad} raw (${(badRatio * 100).toFixed(4)}% of content, ch>${CHANNEL_TOLERANCE}), ` +
            `maxDelta=${m.maxDelta}, contentMismatch=${(contentMismatch * 100).toFixed(4)}%`,
        );

        if (rigName === 'turned') {
          expect(m.contentUnion).toBeGreaterThanOrEqual(2);
          expect(m.bad).toBe(0);
          expect(m.maxDelta).toBe(0);
        } else {
          expect(m.contentUnion).toBeGreaterThan(5000);
        }
        expect(badRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
        expect(contentMismatch).toBeLessThanOrEqual(CONTENT_MISMATCH_LIMIT);
      }
    }

    // 3. Issue #3 Bar 2 Negative Controls (Mutants):
    // Mutant A: a mesh drawn with its triangles reversed
    const revTriCap = await page.evaluate(() =>
      window.rigAdaptersHarness.pictureCaptureProbe({
        rigName: 'glow',
        animation: 'burn',
        time: 0.5,
        mutant: 'reverse-triangles',
      }),
    );
    const revTriDiff = await diffBase64InPage(
      page,
      revTriCap.canvasPngBase64,
      revTriCap.pixiPngBase64,
    );
    const revTriBadRatio = revTriDiff.bad / Math.max(1, revTriDiff.contentUnion);
    const revTriMismatch =
      Math.abs(revTriDiff.contentA - revTriDiff.contentB) /
      Math.max(1, revTriDiff.contentA, revTriDiff.contentB);
    console.log(
      `[bar2:mutant:reverse-triangles] ${testInfo.project.name} glow/burn@0.5s: ` +
        `bad=${revTriDiff.bad} (${(revTriBadRatio * 100).toFixed(3)}%), ` +
        `contentMismatch=${(revTriMismatch * 100).toFixed(3)}%, maxDelta=${revTriDiff.maxDelta}`,
    );
    expect(revTriBadRatio > BAD_RATIO_LIMIT || revTriMismatch > CONTENT_MISMATCH_LIMIT).toBe(true);

    // Mutant B: a clip ignored (tested on per-slot clip `figure/mask`, root clip `figure/window` + `figure/inverse` + `figure/tilted`, and nested `figure/nested`)
    for (const clipAnim of ['mask', 'tilted', 'window', 'inverse', 'nested'] as const) {
      const noClipCap = await page.evaluate(
        (a) =>
          window.rigAdaptersHarness.pictureCaptureProbe({
            rigName: 'figure',
            animation: a,
            time: 0.5,
            mutant: 'ignore-clip',
          }),
        clipAnim,
      );
      const noClipDiff = await diffBase64InPage(
        page,
        noClipCap.canvasPngBase64,
        noClipCap.pixiPngBase64,
      );
      const noClipBadRatio = noClipDiff.bad / Math.max(1, noClipDiff.contentUnion);
      const noClipMismatch =
        Math.abs(noClipDiff.contentA - noClipDiff.contentB) /
        Math.max(1, noClipDiff.contentA, noClipDiff.contentB);
      console.log(
        `[bar2:mutant:ignore-clip] ${testInfo.project.name} figure/${clipAnim}@0.5s: ` +
          `bad=${noClipDiff.bad} (${(noClipBadRatio * 100).toFixed(3)}%), ` +
          `contentMismatch=${(noClipMismatch * 100).toFixed(3)}%`,
      );
      expect(noClipBadRatio > BAD_RATIO_LIMIT || noClipMismatch > CONTENT_MISMATCH_LIMIT).toBe(
        true,
      );
    }

    // Mutant C: the dark colour dropped (tested on `duo/shift@0.5s`)
    const noDarkCap = await page.evaluate(() =>
      window.rigAdaptersHarness.pictureCaptureProbe({
        rigName: 'duo',
        animation: 'shift',
        time: 0.5,
        mutant: 'drop-dark',
      }),
    );
    const noDarkDiff = await diffBase64InPage(
      page,
      noDarkCap.canvasPngBase64,
      noDarkCap.pixiPngBase64,
    );
    const noDarkBadRatio = noDarkDiff.bad / Math.max(1, noDarkDiff.contentUnion);
    console.log(
      `[bar2:mutant:drop-dark] ${testInfo.project.name} duo/shift@0.5s: ` +
        `bad=${noDarkDiff.bad} (${(noDarkBadRatio * 100).toFixed(3)}%), maxDelta=${noDarkDiff.maxDelta}`,
    );
    expect(noDarkBadRatio).toBeGreaterThan(BAD_RATIO_LIMIT);

    // Mutant D & E: Issue #2 drop-slot and swap-order mutants
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
    expect(droppedBadRatio > BAD_RATIO_LIMIT || droppedMismatch > CONTENT_MISMATCH_LIMIT).toBe(
      true,
    );

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
    expect(swappedBadRatio).toBeGreaterThan(BAD_RATIO_LIMIT);
  });

  test('Issue #3 Bar 3: Identity — uvs and triangles arrays are reused by identity across frames without new geometry uploads (plus always-reupload mutant)', async ({
    page,
  }, testInfo) => {
    await openHarness(page);

    const times = [0, 0.25, 0.5, 0.75, 1.0];

    for (const { rigName, animation, expectedMeshes } of [
      { rigName: 'figure' as const, animation: 'walk', expectedMeshes: 2 },
      { rigName: 'glow' as const, animation: 'burn', expectedMeshes: 2 },
      { rigName: 'duo' as const, animation: 'shift', expectedMeshes: 1 },
      { rigName: 'flex' as const, animation: 'wave', expectedMeshes: 4 },
    ]) {
      const normal = await page.evaluate(
        ({ r, a, ts }) =>
          window.rigAdaptersHarness.identityProbe({
            rigName: r,
            animation: a,
            times: ts,
            mutant: 'none',
          }),
        { r: rigName, a: animation, ts: times },
      );

      const firstNormal = normal.uploadsPerFrame[0];
      const lastNormal = normal.uploadsPerFrame[normal.uploadsPerFrame.length - 1];

      console.log(
        `[bar3:identity] ${testInfo.project.name} ${rigName}/${animation} (${times.length} frames): ` +
          `meshCount=${normal.meshSlotCount}, uvsIdentical=${normal.uvsIdenticalAcrossFrames}, ` +
          `trisIdentical=${normal.trianglesIdenticalAcrossFrames}, ` +
          `frame1(geom=${firstNormal.meshGeometryCount}, uvUp=${firstNormal.uvUploadCount}, triUp=${firstNormal.triangleUploadCount}, totalUp=${firstNormal.geometryUploadCount}) -> ` +
          `frame${times.length}(geom=${lastNormal.meshGeometryCount}, uvUp=${lastNormal.uvUploadCount}, triUp=${lastNormal.triangleUploadCount}, totalUp=${lastNormal.geometryUploadCount})`,
      );

      expect(normal.meshSlotCount).toBe(expectedMeshes);
      expect(normal.uvsIdenticalAcrossFrames).toBe(true);
      expect(normal.trianglesIdenticalAcrossFrames).toBe(true);
      for (const f of normal.uploadsPerFrame) {
        expect(f.meshGeometryCount).toBe(expectedMeshes);
        expect(f.uvUploadCount).toBe(expectedMeshes);
        expect(f.triangleUploadCount).toBe(expectedMeshes);
        expect(f.geometryUploadCount).toBe(expectedMeshes * 2);
      }

      // Verify that passing genuinely new array instances (`clone-arrays`) triggers re-upload on every frame.
      const clonedArr = await page.evaluate(
        ({ r, a, ts }) =>
          window.rigAdaptersHarness.identityProbe({
            rigName: r,
            animation: a,
            times: ts,
            mutant: 'clone-arrays',
          }),
        { r: rigName, a: animation, ts: times },
      );
      const lastCloned = clonedArr.uploadsPerFrame[clonedArr.uploadsPerFrame.length - 1];
      expect(lastCloned.meshGeometryCount).toBe(expectedMeshes);
      expect(lastCloned.uvUploadCount).toBe(expectedMeshes * times.length);
      expect(lastCloned.triangleUploadCount).toBe(expectedMeshes * times.length);
      expect(lastCloned.geometryUploadCount).toBe(expectedMeshes * 2 * times.length);

      // Negative control (mutant): always-reupload grows the upload count on every frame even when arrays are identical.
      const mutant = await page.evaluate(
        ({ r, a, ts }) =>
          window.rigAdaptersHarness.identityProbe({
            rigName: r,
            animation: a,
            times: ts,
            mutant: 'always-reupload',
          }),
        { r: rigName, a: animation, ts: times },
      );
      const lastMutant = mutant.uploadsPerFrame[mutant.uploadsPerFrame.length - 1];

      console.log(
        `[bar3:identity:mutant] ${testInfo.project.name} ${rigName}/${animation}: ` +
          `frame${times.length}(geom=${lastMutant.meshGeometryCount}, uvUp=${lastMutant.uvUploadCount}, triUp=${lastMutant.triangleUploadCount}, totalUp=${lastMutant.geometryUploadCount})`,
      );

      expect(lastMutant.uvUploadCount).toBe(expectedMeshes * times.length);
      expect(lastMutant.triangleUploadCount).toBe(expectedMeshes * times.length);
      expect(lastMutant.geometryUploadCount).toBe(expectedMeshes * 2 * times.length);
    }
  });

  test('Issue #2 Bar 3 & #3 Bar 4: pma, tint, dark tint and blend — pma vs non-pma pages and glow additive slots pass under both (plus mutants)', async ({
    page,
  }, testInfo) => {
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
    expect(darkTintColorMatrix([1, 0.75, 0.5, 0.5], [0.25, 0.125, 0.0625])).toEqual([
      0.75, 0, 0, 0, 0.25,
      0, 0.625, 0, 0, 0.125,
      0, 0, 0.4375, 0, 0.0625,
      0, 0, 0, 0.5, 0,
    ]);

    await openHarness(page);

    for (const time of ISSUE3_TIMES) {
      const nonPmaRes = await page.evaluate(
        (t) =>
          window.rigAdaptersHarness.pmaProbe({
            rigName: 'glow',
            time: t,
            pma: false,
          }),
        time,
      );
      const pmaRes = await page.evaluate(
        (t) =>
          window.rigAdaptersHarness.pmaProbe({
            rigName: 'glow',
            time: t,
            pma: true,
          }),
        time,
      );
      const mutantRes = await page.evaluate(
        (t) =>
          window.rigAdaptersHarness.pmaProbe({
            rigName: 'glow',
            time: t,
            pma: true,
            mutantIgnorePmaFlag: true,
          }),
        time,
      );

      const nonPmaDiff = await diffBase64InPage(
        page,
        nonPmaRes.canvasPngBase64,
        nonPmaRes.pixiPngBase64,
      );
      const pmaDiff = await diffBase64InPage(page, pmaRes.canvasPngBase64, pmaRes.pixiPngBase64);
      const crossDiff = await diffBase64InPage(
        page,
        nonPmaRes.pixiPngBase64,
        pmaRes.pixiPngBase64,
      );
      const mutantDiff = await diffBase64InPage(
        page,
        pmaRes.canvasPngBase64,
        mutantRes.pixiPngBase64,
      );

      const nonPmaBadRatio = nonPmaDiff.bad / Math.max(1, nonPmaDiff.contentUnion);
      const pmaBadRatio = pmaDiff.bad / Math.max(1, pmaDiff.contentUnion);
      const crossBadRatio = crossDiff.bad / Math.max(1, crossDiff.contentUnion);
      const mutantBadRatio = mutantDiff.bad / Math.max(1, mutantDiff.contentUnion);

      const nonPmaModes = Array.from(new Set(Object.values(nonPmaRes.alphaModes)));
      const pmaModes = Array.from(new Set(Object.values(pmaRes.alphaModes)));

      console.log(
        `[bar4:pma] ${testInfo.project.name} glow@${time}s: ` +
          `alphaModes(nonPma=${nonPmaModes.join(',')}, pma=${pmaModes.join(',')}), ` +
          `additiveSlots=[${pmaRes.additiveSlots.join(',')}], ` +
          `nonPmaBad=${nonPmaDiff.bad} (${(nonPmaBadRatio * 100).toFixed(4)}%, maxDelta=${nonPmaDiff.maxDelta}), ` +
          `pmaBad=${pmaDiff.bad} (${(pmaBadRatio * 100).toFixed(4)}%, maxDelta=${pmaDiff.maxDelta}), ` +
          `crossBad=${crossDiff.bad} (${(crossBadRatio * 100).toFixed(4)}%, maxDelta=${crossDiff.maxDelta}), ` +
          `mutantIgnorePmaBad=${mutantDiff.bad} (${(mutantBadRatio * 100).toFixed(3)}%, maxDelta=${mutantDiff.maxDelta})`,
      );

      // 1. A non-pma page uses 'premultiply-alpha-on-upload' and a pma page uses 'premultiplied-alpha'
      expect(nonPmaModes).toEqual(['premultiply-alpha-on-upload']);
      expect(pmaModes).toEqual(['premultiplied-alpha']);
      expect(pmaRes.additiveSlots).toEqual(['halo', 'flame', 'spark_a', 'spark_b']);

      // 2. Both non-pma and pma glow (with 3 additive regions + 1 additive mesh + 1 normal region + 1 normal mesh) pass Bar 2
      expect(nonPmaBadRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
      expect(pmaBadRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);
      expect(crossBadRatio).toBeLessThanOrEqual(BAD_RATIO_LIMIT);

      // 3. Mutant: ignoring `pma: true` on a premultiplied page double-premultiplies semi-transparent pixels and fails
      expect(mutantBadRatio).toBeGreaterThan(BAD_RATIO_LIMIT);
    }

    // Issue #2 Bar 3 mutants on full glow (with additive `flame` mesh over `body`):
    const badBlendCap = await page.evaluate(() =>
      window.rigAdaptersHarness.pictureCaptureProbe({
        rigName: 'glow',
        time: 0.5,
        mutant: 'additive-as-normal',
      }),
    );
    const badBlendDiff = await diffBase64InPage(
      page,
      badBlendCap.canvasPngBase64,
      badBlendCap.pixiPngBase64,
    );
    const badBlendRatio = badBlendDiff.bad / Math.max(1, badBlendDiff.contentUnion);
    console.log(
      `[bar4:mutant:additive-as-normal] ${testInfo.project.name} glow@0.5s: ` +
        `bad=${badBlendDiff.bad} (${(badBlendRatio * 100).toFixed(3)}%), maxDelta=${badBlendDiff.maxDelta}`,
    );
    expect(badBlendRatio).toBeGreaterThan(BAD_RATIO_LIMIT);

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
      `[bar4:mutant:drop-tint] ${testInfo.project.name} glow@0.5s: ` +
        `bad=${badTintDiff.bad} (${(badTintRatio * 100).toFixed(3)}%), maxDelta=${badTintDiff.maxDelta}`,
    );
    expect(badTintRatio).toBeGreaterThan(BAD_RATIO_LIMIT);
  });

  test('Issue #3 Bar 5 (Issue #2 Bar 4): No external runtime in the graph or src/ (plus planted-hit mutant)', async () => {
    const lockPath = join(process.cwd(), 'bun.lock');
    const pkgPath = join(process.cwd(), 'package.json');
    const hits = scanForForbiddenReferences(SRC_DIR, lockPath, pkgPath);
    console.log(
      `[bar5:no-spine] hits in src/, bun.lock, package.json: ${hits.length === 0 ? '(empty)' : hits.join('; ')}`,
    );
    expect(hits).toEqual([]);

    const tempDir = mkdtempSync(join(tmpdir(), 'rig-adapters-bar4-'));
    try {
      const plantedSrc = join(tempDir, 'src');
      const plantedFile = join(plantedSrc, 'planted.ts');
      const plantedLock = join(tempDir, 'bun.lock');
      const plantedPkg = join(tempDir, 'package.json');
      writeFileSync(
        plantedPkg,
        JSON.stringify({ dependencies: { '@esotericsoftware/spine-core': '4.2.0' } }),
      );
      writeFileSync(plantedLock, '  "@esotericsoftware/spine-core@4.2.0": {}\n');
      mkdirSync(plantedSrc, { recursive: true });
      writeFileSync(plantedFile, 'import { Skeleton } from "@esotericsoftware/spine-core";\n');

      const plantedHits = scanForForbiddenReferences(plantedSrc, plantedLock, plantedPkg);
      console.log(`[bar5:no-spine:mutant] hits=${plantedHits.length}: ${plantedHits.join(' | ')}`);
      expect(plantedHits.length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('Issue #3 Bar 5 (Issue #2 Bar 6): Refusals by name — missing page, unbuildable clip shapes, malformed mesh, invalid blend/dark/kind', async ({
    page,
  }, testInfo) => {
    await openHarness(page);
    const cases = await page.evaluate(() => window.rigAdaptersHarness.refusalProbe());

    for (const c of cases) {
      console.log(
        `[bar5:refusals] ${testInfo.project.name} ${c.name}: threw=${c.threw}, ` +
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

    // 2. Unbuildable clip shapes refuse naming the slot, page, and exact reason, preserving previous valid render.
    const clipTooShort = byName.get('clip-too-short')!;
    expect(clipTooShort.message).toContain('slot "clip_too_short_slot"');
    expect(clipTooShort.message).toContain('fewer than 3 vertices');
    expect(clipTooShort.childrenAfterThrow).toBe(15);

    const clipSelfCrossing = byName.get('clip-self-crossing')!;
    expect(clipSelfCrossing.message).toContain('slot "clip_bowtie_slot"');
    expect(clipSelfCrossing.message).toContain('self-crossing');
    expect(clipSelfCrossing.childrenAfterThrow).toBe(15);

    const clipCollinear = byName.get('clip-collinear')!;
    expect(clipCollinear.message).toContain('slot "clip_collinear_slot"');
    expect(clipCollinear.message).toContain('collinear');
    expect(clipCollinear.childrenAfterThrow).toBe(15);

    const clipRepeated = byName.get('clip-repeated-vertices')!;
    expect(clipRepeated.message).toContain('slot "clip_repeated_vertex_slot"');
    expect(clipRepeated.message).toContain('repeated vertex');
    expect(clipRepeated.childrenAfterThrow).toBe(15);

    const clipNonConvex = byName.get('clip-nonconvex-marked-convex')!;
    expect(clipNonConvex.message).toContain('slot "clip_nonconvex_marked_convex_slot"');
    expect(clipNonConvex.message).toContain('non-convex clip polygon marked convex=true');
    expect(clipNonConvex.childrenAfterThrow).toBe(15);

    // 3. Malformed mesh buffers and out-of-range triangle indices refuse naming the slot.
    const meshBadIndex = byName.get('mesh-bad-triangles')!;
    expect(meshBadIndex.message).toContain('slot "broken_mesh_tris"');
    expect(meshBadIndex.message).toContain('out-of-range');
    expect(meshBadIndex.childrenAfterThrow).toBe(17);

    const meshUvMismatch = byName.get('mesh-uv-mismatch')!;
    expect(meshUvMismatch.message).toContain('slot "broken_mesh_uvs"');
    expect(meshUvMismatch.message).toContain('invalid uvs length');

    // 4. Invalid blend mode, dark tint, and slot kind refuse naming the slot.
    const badDark = byName.get('invalid-dark')!;
    expect(badDark.message).toContain('slot "bad_dark_slot"');
    expect(badDark.message).toContain('non-finite dark[1]');

    const badBlend = byName.get('invalid-blend')!;
    expect(badBlend.message).toContain('slot "bad_blend_slot"');
    expect(badBlend.message).toContain('unsupported blend mode "Subtract"');

    const badKind = byName.get('invalid-kind')!;
    expect(badKind.message).toContain('slot "bad_kind_slot"');
    expect(badKind.message).toContain('unsupported kind "point"');
  });

  test('Issue #3 Bar 5 (Issue #2 Bar 5): Unmodified inputs — every file rigc build wrote is byte-identical after the suite (plus mutant)', async () => {
    const afterDigests = snapshotDigests(RIGS_DIR);
    const diffs = compareDigests(initialRigDigests, afterDigests);
    console.log(
      `[bar5:inputs] hashed ${afterDigests.size} rig files across public/rigs/: diffs=${diffs.length === 0 ? '(empty)' : diffs.join(', ')}`,
    );
    expect(afterDigests.size).toBe(initialRigDigests.size);
    expect(diffs).toEqual([]);

    const mutatedAfter = new Map(afterDigests);
    const firstKey = mutatedAfter.keys().next().value as string;
    mutatedAfter.set(firstKey, '0'.repeat(64));
    const mutantDiffs = compareDigests(initialRigDigests, mutatedAfter);
    console.log(`[bar5:inputs:mutant] detected: ${mutantDiffs.join(', ')}`);
    expect(mutantDiffs.length).toBe(1);
    expect(mutantDiffs[0]).toContain(firstKey);
  });
});

test.describe('Issue #4 — PixiRig live player in a Pixi scene', () => {
  const ALL_RIGS = ['walk', 'flex', 'ride', 'figure', 'glow', 'turned', 'duo'] as const;
  const PARITY_TIMES = [0, 0.25, 0.5, 0.75, 1.2] as const;

  test('Issue #4 Bar 1: Parity — at the same time, PixiRig drawn frame is byte-equal (JSON) to player.posedFrame() of a bare RigPlayer (plus mutant)', async ({
    page,
  }, testInfo) => {
    await openHarness(page);

    for (const rigName of ALL_RIGS) {
      const res = await page.evaluate(
        ({ r, ts }) =>
          window.rigAdaptersHarness.parityProbe({
            rigName: r,
            times: ts,
          }),
        { r: rigName, ts: PARITY_TIMES },
      );

      console.log(
        `[issue4:bar1:parity] ${testInfo.project.name} ${rigName}/${res.animation}: ` +
          `times=${res.checkedTimes}, seekEqual=${res.allSeekFramesByteEqual}, ` +
          `advanceEqual=${res.allAdvanceFramesByteEqual}, bonesEqual=${res.allBonesByteEqual} (${res.checkedBones} bones)`,
      );

      expect(res.allSeekFramesByteEqual).toBe(true);
      expect(res.allAdvanceFramesByteEqual).toBe(true);
      expect(res.allBonesByteEqual).toBe(true);
      expect(res.firstMismatchDetail).toBeNull();
    }

    // Negative control (mutant): perturbing a drawn slot coordinate by +1e-3 fails byte-equality.
    const mutantRes = await page.evaluate(() =>
      window.rigAdaptersHarness.parityProbe({
        rigName: 'walk',
        times: [0.5],
        mutantPerturbPose: true,
      }),
    );
    console.log(
      `[issue4:bar1:mutant] ${testInfo.project.name} walk@0.5s: seekEqual=${mutantRes.allSeekFramesByteEqual}, detail=${mutantRes.firstMismatchDetail}`,
    );
    expect(mutantRes.allSeekFramesByteEqual).toBe(false);
  });

  test('Issue #4 Bar 2: Ticker — 300 ticks at fixed dt advance the pose exactly as advance(dt) called 300 times; timescale 0 holds the frame and reuses every geometry with zero uploads (plus mutants)', async ({
    page,
  }, testInfo) => {
    await openHarness(page);

    for (const rigName of ['walk', 'flex', 'ride', 'figure', 'glow', 'duo'] as const) {
      const res = await page.evaluate(
        (r) =>
          window.rigAdaptersHarness.tickerProbe({
            rigName: r,
            ticks: 300,
            dt: 1 / 60,
          }),
        rigName,
      );

      console.log(
        `[issue4:bar2:ticker] ${testInfo.project.name} ${rigName}/${res.animation}: ` +
          `ticks=${res.ticks}, dt=${res.dt.toFixed(6)}, all300Match=${res.allTicksMatchManualAdvance}, ` +
          `finalEqual=${res.finalRecordByteEqual}, t=${res.tickerTimeAfter300.toFixed(6)}s, ` +
          `binary20msCumMatches=${res.binaryExactCumulativeMatchesAll300}, ` +
          `naiveCumMismatches=${res.naiveCumulativeMismatchesOutOf300}/300 (drift=${res.naiveCumulativeTimeDriftAt300.toExponential(3)}s), ` +
          `heldAtTimescale0=${res.frameHeldWhenTimescaleZero}, ` +
          `uploadsAt0(uv=${res.uploadsDuringTimescaleZero.uvUploads}, tri=${res.uploadsDuringTimescaleZero.triangleUploads}, geom=${res.uploadsDuringTimescaleZero.geometryUploads}, pos=${res.uploadsDuringTimescaleZero.positionUploads}, newMeshes=${res.uploadsDuringTimescaleZero.newMeshGeometries})`,
      );

      expect(res.allTicksMatchManualAdvance).toBe(true);
      expect(res.finalRecordByteEqual).toBe(true);
      expect(res.tickerTimeAfter300).toBe(res.manualTimeAfter300);
      expect(res.binaryExactCumulativeMatchesAll300).toBe(true);
      expect(res.frameHeldWhenTimescaleZero).toBe(true);
      expect(res.uploadsDuringTimescaleZero).toEqual({
        uvUploads: 0,
        triangleUploads: 0,
        geometryUploads: 0,
        positionUploads: 0,
        newMeshGeometries: 0,
      });
    }

    // Mutant A: 299 ticks vs 300 manual advance(dt) calls fails record equality.
    const dropTickMutant = await page.evaluate(() =>
      window.rigAdaptersHarness.tickerProbe({
        rigName: 'flex',
        ticks: 300,
        dt: 1 / 60,
        mutant: 'drop-one-tick',
      }),
    );
    console.log(
      `[issue4:bar2:mutant:drop-one-tick] ${testInfo.project.name} flex: finalEqual=${dropTickMutant.finalRecordByteEqual}`,
    );
    expect(dropTickMutant.finalRecordByteEqual).toBe(false);

    // Mutant B: ignoring timescale=0 fails frame-hold and uploads new vertex positions across 300 ticks.
    const ignoreZeroScaleMutant = await page.evaluate(() =>
      window.rigAdaptersHarness.tickerProbe({
        rigName: 'flex',
        ticks: 300,
        dt: 1 / 60,
        mutant: 'ignore-zero-timescale',
      }),
    );
    console.log(
      `[issue4:bar2:mutant:ignore-zero-timescale] ${testInfo.project.name} flex: held=${ignoreZeroScaleMutant.frameHeldWhenTimescaleZero}, posUploads=${ignoreZeroScaleMutant.uploadsDuringTimescaleZero.positionUploads}`,
    );
    expect(ignoreZeroScaleMutant.frameHeldWhenTimescaleZero).toBe(false);
    expect(ignoreZeroScaleMutant.uploadsDuringTimescaleZero.positionUploads).toBeGreaterThan(0);

    // Mutant C: alwaysReuploadGeometry=true forces 300 * meshSlotCount UV, triangle, and position uploads during timescale=0.
    const alwaysReuploadMutant = await page.evaluate(() =>
      window.rigAdaptersHarness.tickerProbe({
        rigName: 'flex',
        ticks: 300,
        dt: 1 / 60,
        mutant: 'always-reupload',
      }),
    );
    console.log(
      `[issue4:bar2:mutant:always-reupload] ${testInfo.project.name} flex: geomUploads=${alwaysReuploadMutant.uploadsDuringTimescaleZero.geometryUploads}, posUploads=${alwaysReuploadMutant.uploadsDuringTimescaleZero.positionUploads}`,
    );
    expect(alwaysReuploadMutant.uploadsDuringTimescaleZero.geometryUploads).toBe(
      300 * 2 * alwaysReuploadMutant.meshSlotCount,
    );
    expect(alwaysReuploadMutant.uploadsDuringTimescaleZero.positionUploads).toBe(
      300 * alwaysReuploadMutant.meshSlotCount,
    );
  });

  test('Issue #4 Bar 3: Several instances — ten PixiRigs over one load draw ten different times; destroying one frees only its own objects; destroying the last frees the page textures (plus mutant)', async ({
    page,
  }, testInfo) => {
    await openHarness(page);

    for (const rigName of ['walk', 'flex', 'ride', 'figure', 'duo'] as const) {
      const res = await page.evaluate(
        (r) =>
          window.rigAdaptersHarness.multiInstanceProbe({
            rigName: r,
            instanceCount: 10,
          }),
        rigName,
      );

      const per = res.perRigCountsBefore;
      const before = res.aggregateBeforeDestroy;
      const after1 = res.aggregateAfterFirstDestroy;
      const after9 = res.aggregateAfterNineDestroys;
      const after10 = res.aggregateAfterLastDestroy;

      console.log(
        `[issue4:bar3:instances] ${testInfo.project.name} ${rigName}/${res.animation}: ` +
          `distinctFrames=${res.distinctDrawnFrames}/10, matchBare=${res.allTenMatchBarePlayers}, sharedSources=${res.sharedPageSourcesIdenticalAcrossAllTen} | ` +
          `before(rigs=${before.activeRigs}, sprites=${before.totalSprites}, meshes=${before.totalMeshes}, geom=${before.totalGeometries}, texViews=${before.totalTextureViews}, pageTex=${before.livePageTextures}, refCount=${before.minPageRefCount}..${before.maxPageRefCount}) -> ` +
          `after1(rigs=${after1.activeRigs}, sprites=${after1.totalSprites}, meshes=${after1.totalMeshes}, geom=${after1.totalGeometries}, texViews=${after1.totalTextureViews}, pageTex=${after1.livePageTextures}, refCount=${after1.minPageRefCount}..${after1.maxPageRefCount}) -> ` +
          `after9(rigs=${after9.activeRigs}, pageTex=${after9.livePageTextures}, refCount=${after9.minPageRefCount}..${after9.maxPageRefCount}) -> ` +
          `after10(rigs=${after10.activeRigs}, sprites=${after10.totalSprites}, meshes=${after10.totalMeshes}, geom=${after10.totalGeometries}, texViews=${after10.totalTextureViews}, pageTex=${after10.livePageTextures}, refCount=${after10.minPageRefCount}..${after10.maxPageRefCount}, sourcesDestroyed=${after10.allPageSourcesDestroyed})`,
      );

      // 1. Ten PixiRigs over one load draw ten distinct times, each matching a bare RigPlayer.
      expect(res.distinctDrawnFrames).toBe(10);
      expect(res.allTenMatchBarePlayers).toBe(true);
      expect(res.sharedPageSourcesIdenticalAcrossAllTen).toBe(true);

      // 2. Before destroy: 10 active rigs, each owning its sprites/meshes/geometries/textureViews, sharing `per.retainedPages` page textures with refCount = 10.
      expect(before.activeRigs).toBe(10);
      expect(before.totalSprites).toBe(10 * per.sprites);
      expect(before.totalMeshes).toBe(10 * per.meshes);
      expect(before.totalGeometries).toBe(10 * per.geometries);
      expect(before.totalTextureViews).toBe(10 * per.textureViews);
      expect(before.livePageTextures).toBe(per.retainedPages);
      expect(before.minPageRefCount).toBe(10);
      expect(before.maxPageRefCount).toBe(10);

      // 3. Destroying one frees ONLY its own objects; surviving 9 rigs keep theirs and page textures stay live with refCount = 9.
      expect(res.destroyedRigCountsAfterFirstDestroy.sprites).toBe(0);
      expect(res.destroyedRigCountsAfterFirstDestroy.meshes).toBe(0);
      expect(res.destroyedRigCountsAfterFirstDestroy.geometries).toBe(0);
      expect(res.destroyedRigCountsAfterFirstDestroy.textureViews).toBe(0);
      expect(res.destroyedRigCountsAfterFirstDestroy.retainedPages).toBe(0);
      expect(res.survivingRigCountsAfterFirstDestroy.sprites).toBe(per.sprites);
      expect(res.survivingRigCountsAfterFirstDestroy.meshes).toBe(per.meshes);

      expect(after1.activeRigs).toBe(9);
      expect(after1.totalSprites).toBe(9 * per.sprites);
      expect(after1.totalMeshes).toBe(9 * per.meshes);
      expect(after1.totalGeometries).toBe(9 * per.geometries);
      expect(after1.totalTextureViews).toBe(9 * per.textureViews);
      expect(after1.livePageTextures).toBe(per.retainedPages);
      expect(after1.minPageRefCount).toBe(9);
      expect(after1.maxPageRefCount).toBe(9);
      expect(after1.allPageSourcesDestroyed).toBe(false);

      // 4. After 9 destroys, 1 rig remains and page textures are still live with refCount = 1.
      expect(after9.activeRigs).toBe(1);
      expect(after9.livePageTextures).toBe(per.retainedPages);
      expect(after9.minPageRefCount).toBe(1);
      expect(after9.maxPageRefCount).toBe(1);
      expect(after9.allPageSourcesDestroyed).toBe(false);

      // 5. Destroying the last (10th) instance frees all shared page textures (livePageTextures = 0, refCount = 0, destroyed = true).
      expect(after10.activeRigs).toBe(0);
      expect(after10.totalSprites).toBe(0);
      expect(after10.totalMeshes).toBe(0);
      expect(after10.totalGeometries).toBe(0);
      expect(after10.totalTextureViews).toBe(0);
      expect(after10.livePageTextures).toBe(0);
      expect(after10.minPageRefCount).toBe(0);
      expect(after10.maxPageRefCount).toBe(0);
      expect(after10.allPageSourcesDestroyed).toBe(true);
    }

    // Negative control (mutant): skipping page source destruction on the last rig leaves page textures leaked.
    const leakMutant = await page.evaluate(() =>
      window.rigAdaptersHarness.multiInstanceProbe({
        rigName: 'walk',
        instanceCount: 10,
        mutantSkipLastPageRelease: true,
      }),
    );
    console.log(
      `[issue4:bar3:mutant:leak] ${testInfo.project.name} walk: after10 livePageTextures=${leakMutant.aggregateAfterLastDestroy.livePageTextures}, allDestroyed=${leakMutant.aggregateAfterLastDestroy.allPageSourcesDestroyed}`,
    );
    expect(leakMutant.aggregateAfterLastDestroy.livePageTextures).toBeGreaterThan(0);
    expect(leakMutant.aggregateAfterLastDestroy.allPageSourcesDestroyed).toBe(false);
  });

  test('Issue #4 Bar 4: bounds() — equals @rig-c/play bounds() for the same frame and slot filter across all rigs (plus mutants)', async ({
    page,
  }, testInfo) => {
    await openHarness(page);

    for (const rigName of ALL_RIGS) {
      const res = await page.evaluate(
        ({ r, ts }) =>
          window.rigAdaptersHarness.boundsProbe({
            rigName: r,
            times: ts,
          }),
        { r: rigName, ts: [0, 0.35, 0.7, 1.1] },
      );

      console.log(
        `[issue4:bar4:bounds] ${testInfo.project.name} ${rigName}/${res.animation}: ` +
          `cases=${res.totalCases}, allMatch=${res.allMatch}, sample@0.35s=${JSON.stringify(res.cases.find((c) => c.time === 0.35 && c.filterLabel === 'all')?.rigBounds)}`,
      );

      expect(res.totalCases).toBe(16);
      expect(res.allMatch).toBe(true);
      for (const c of res.cases) {
        expect(c.matches).toBe(true);
        if (c.filterLabel === 'only:[]') {
          expect(c.rigBounds).toBeNull();
          expect(c.bareBounds).toBeNull();
        } else {
          expect(c.rigBounds).not.toBeNull();
        }
      }
    }

    // Mutant A: ignoring slot filter fails bounds() equality on filtered slots.
    const ignoreFilterMutant = await page.evaluate(() =>
      window.rigAdaptersHarness.boundsProbe({
        rigName: 'walk',
        times: [0.35],
        mutant: 'ignore-filter',
      }),
    );
    console.log(
      `[issue4:bar4:mutant:ignore-filter] ${testInfo.project.name} walk: allMatch=${ignoreFilterMutant.allMatch}`,
    );
    expect(ignoreFilterMutant.allMatch).toBe(false);

    // Mutant B: inflating width by +5 fails bounds() equality.
    const inflateMutant = await page.evaluate(() =>
      window.rigAdaptersHarness.boundsProbe({
        rigName: 'flex',
        times: [0.35],
        mutant: 'inflate-width',
      }),
    );
    console.log(
      `[issue4:bar4:mutant:inflate-width] ${testInfo.project.name} flex: allMatch=${inflateMutant.allMatch}`,
    );
    expect(inflateMutant.allMatch).toBe(false);
  });

  test('Issue #4 Bar 5: Demo — index.html plays the gallery rigs in a Pixi stage with ?rig=, ?anim=, ?time=, ?timescale= deterministically', async ({
    page,
  }, testInfo) => {
    const demoCases = [
      { rig: 'walk', anim: 'walk', time: 0.35, timescale: 0, count: 1 },
      { rig: 'flex', anim: 'wave', time: 0.5, timescale: 0, count: 1 },
      { rig: 'ride', anim: 'ride', time: 0.4, timescale: 0, count: 1 },
      { rig: 'walk', anim: 'walk', time: 0.25, timescale: 0, count: 4 },
    ] as const;

    for (const c of demoCases) {
      const url = `/?rig=${c.rig}&anim=${c.anim}&time=${c.time}&timescale=${c.timescale}&count=${c.count}`;
      await page.goto(url);
      await page.waitForFunction(() => document.body.dataset.demoReady === 'true');

      const state1 = await page.evaluate(() => window.__rigAdaptersDemo!);
      const png1Base64 = await page.evaluate(() => {
        const canvas = document.querySelector('#pixi-stage canvas') as HTMLCanvasElement;
        return canvas.toDataURL('image/png').split(',')[1];
      });

      // Reload the exact same URL and verify the captured picture is 100% deterministic (0 differing pixels).
      await page.goto(url);
      await page.waitForFunction(() => document.body.dataset.demoReady === 'true');
      const png2Base64 = await page.evaluate(() => {
        const canvas = document.querySelector('#pixi-stage canvas') as HTMLCanvasElement;
        return canvas.toDataURL('image/png').split(',')[1];
      });

      await openHarness(page);
      const repeatDiff = await diffBase64InPage(page, png1Base64, png2Base64);

      console.log(
        `[issue4:bar5:demo] ${testInfo.project.name} ${url}: ` +
          `rig=${state1.rigName}, anim=${state1.animName}, t=${state1.time}s, timescale=${state1.timescale}, ` +
          `instances=${state1.instanceCount}, nonEmptyPixels=${state1.nonEmptyPixels}, ` +
          `pageTextures=${state1.livePageTextures}, deterministicDiff(bad=${repeatDiff.bad}, maxDelta=${repeatDiff.maxDelta})`,
      );

      expect(state1.rigName).toBe(c.rig);
      expect(state1.animName).toBe(c.anim);
      expect(state1.time).toBeCloseTo(c.time, 6);
      expect(state1.timescale).toBe(c.timescale);
      expect(state1.instanceCount).toBe(c.count);
      expect(state1.nonEmptyPixels).toBeGreaterThan(5000);
      expect(state1.bounds).not.toBeNull();
      expect(repeatDiff.bad).toBe(0);
      expect(repeatDiff.maxDelta).toBe(0);
    }

    // Negative control: two different ?time= query values produce different pictures.
    await page.goto('/?rig=walk&anim=walk&time=0.1&timescale=0');
    await page.waitForFunction(() => document.body.dataset.demoReady === 'true');
    const t1Png = await page.evaluate(() => {
      const canvas = document.querySelector('#pixi-stage canvas') as HTMLCanvasElement;
      return canvas.toDataURL('image/png').split(',')[1];
    });

    await page.goto('/?rig=walk&anim=walk&time=0.6&timescale=0');
    await page.waitForFunction(() => document.body.dataset.demoReady === 'true');
    const t2Png = await page.evaluate(() => {
      const canvas = document.querySelector('#pixi-stage canvas') as HTMLCanvasElement;
      return canvas.toDataURL('image/png').split(',')[1];
    });

    await openHarness(page);
    const timeDiff = await diffBase64InPage(page, t1Png, t2Png);
    console.log(
      `[issue4:bar5:demo:time-diff] ${testInfo.project.name} walk@0.1s vs walk@0.6s: bad=${timeDiff.bad}, maxDelta=${timeDiff.maxDelta}`,
    );
    expect(timeDiff.bad).toBeGreaterThan(1000);
  });

  test('Issue #4 Bar 6: Bars 4–6 of #2 still hold on PixiRig — no Spine, refusals by name, unmodified inputs and frozen ModelAssets', async ({
    page,
  }, testInfo) => {
    await openHarness(page);
    const res = await page.evaluate(() => window.rigAdaptersHarness.pixiRigRefusalAndFreezeProbe());

    for (const r of res.refusals) {
      console.log(
        `[issue4:bar6:refusal] ${testInfo.project.name} ${r.name}: threw=${r.threw}, message="${r.message}"`,
      );
      expect(r.threw).toBe(true);
    }

    const byName = new Map(res.refusals.map((r) => [r.name, r.message]));
    expect(byName.get('invalid-assets')).toContain('invalid assets');
    expect(byName.get('invalid-initial-timescale')).toContain('invalid timescale=-1');
    expect(byName.get('invalid-render-group')).toContain('invalid renderGroup=yes');
    expect(byName.get('unknown-animation')).toContain('nonexistent_animation_xyz');
    expect(byName.get('empty-animation-name')).toContain('invalid animation name');
    expect(byName.get('unknown-bone')).toContain('nonexistent_bone_xyz');
    expect(byName.get('empty-bone-name')).toContain('invalid bone name');
    expect(byName.get('negative-dt')).toContain('invalid dt=-0.016');
    expect(byName.get('nan-dt')).toContain('invalid dt=NaN');
    expect(byName.get('nan-seek')).toContain('invalid time=NaN');
    expect(byName.get('negative-timescale-setter')).toContain('invalid timescale=-0.5');
    expect(byName.get('play-after-destroy')).toContain('destroyed PixiRig');
    expect(byName.get('advance-after-destroy')).toContain('destroyed PixiRig');
    expect(byName.get('seek-after-destroy')).toContain('destroyed PixiRig');
    expect(byName.get('bone-after-destroy')).toContain('destroyed PixiRig');
    expect(byName.get('bounds-after-destroy')).toContain('destroyed PixiRig');

    expect(res.frozenAssetsLifecycleSucceeded).toBe(true);
    expect(res.defaultRenderGroupFalse).toBe(true);
    expect(res.optInRenderGroupTrue).toBe(true);
    expect(res.clippedRenderGroupTrue).toBe(true);
    expect(res.unclippedAfterClipRenderGroupFalse).toBe(true);
    expect(res.inPlaceMutatedVerticesUpdated).toBe(true);
    expect(res.allMeshGeometriesBatchMode).toBe(true);

    // Confirm on-disk rig files remain completely unmodified after all Issue #2, #3, and #4 tests.
    const afterDigests = snapshotDigests(RIGS_DIR);
    const diffs = compareDigests(initialRigDigests, afterDigests);
    expect(diffs).toEqual([]);
  });
});
