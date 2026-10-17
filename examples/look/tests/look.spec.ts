import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { expect, test } from '@playwright/test';
import type { LookDemoApi } from '../main.ts';

declare global {
  interface Window {
    __lookDemo?: LookDemoApi;
    __lookDemoError?: string;
  }
}

const LOOK_URL = '/examples/look/index.html?manual=1';

function walkRepoFiles(dir: string): string[] {
  const ignoredDirs = new Set([
    '.git',
    'node_modules',
    'dist',
    'test-results',
    'playwright-report',
    '.worktrees',
  ]);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkRepoFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort();
}

test.describe('Issue #34 — examples/look pointer-follow page on @rig-c/pixi', () => {
  test('Bars 1–4: 1080p 60fps perf, rig-declared dials + missing-yaw static fallback, 4-corner spring/eye settle, and hair physics velocity', async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    const consoleWarnings: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'warning') {
        consoleWarnings.push(msg.text());
      }
    });

    const response = await page.goto(LOOK_URL);
    expect(response?.status()).toBe(200);
    await page.waitForFunction(
      () => document.body.dataset.lookReady === 'true' || document.body.dataset.lookReady === 'error',
    );
    const bootError = await page.evaluate(() => window.__lookDemoError ?? null);
    expect(bootError).toBeNull();
    expect(pageErrors).toEqual([]);

    // --- Bar 1: 1080p stage & 60 fps (p95 <= 16.7 ms) ---
    const stageInfo = await page.evaluate(() => {
      const api = window.__lookDemo!;
      return {
        width: api.canvasWidth,
        height: api.canvasHeight,
        nonEmptyPixels: api.countNonEmptyPixels(),
        dials: api.dials,
        isStaticFallback: api.isStaticFallback,
      };
    });
    expect(stageInfo.width).toBe(1920);
    expect(stageInfo.height).toBe(1080);
    expect(stageInfo.nonEmptyPixels).toBeGreaterThan(20_000);
    expect(stageInfo.isStaticFallback).toBe(false);
    expect(stageInfo.dials).not.toBeNull();

    const perf = await page.evaluate(() => window.__lookDemo!.measureFrameTimesMs(120));
    console.log(
      `[look:bar1:perf] ${testInfo.project.name} 1920x1080 (120 frames): ` +
        `p50=${perf.p50Ms.toFixed(2)}ms, p95=${perf.p95Ms.toFixed(2)}ms, mean=${perf.meanMs.toFixed(2)}ms, nonEmptyPixels=${stageInfo.nonEmptyPixels}`,
    );
    expect(perf.p95Ms).toBeLessThanOrEqual(16.7);

    // --- Bar 3 & Bar 4: Reset to fresh dev rig for deterministic corner & physics measurements ---
    await page.evaluate(() => window.__lookDemo!.loadRig('/examples/look/rig/skeleton.model.json'));
    const dials = (await page.evaluate(() => window.__lookDemo!.dials))!;
    expect(dials.Y).toBe(30);
    expect(dials.P).toBe(25);
    expect(dials.R).toBe(8);
    expect(dials.B).toBe(6);
    expect(dials.eyeXRange).toBe(1);
    expect(dials.eyeYRange).toBe(1);
    expect(dials.hairPhysicsBones).toEqual([
      'bang_r0',
      'bang_r1',
      'bang_c0',
      'bang_c1',
      'bang_l0',
      'bang_l1',
      'bun',
    ]);

    // Bar 4 part A: When the pointer is still at (0, 0), hair bone delta is 0.
    const stillSnap = await page.evaluate(() => {
      const api = window.__lookDemo!;
      api.clearPointer();
      return api.step(1 / 60);
    });
    expect(stillSnap.fx).toBe(0);
    expect(stillSnap.fy).toBe(0);
    expect(stillSnap.headAngularVelocityDegPerSec).toBe(0);
    expect(stillSnap.physicsRotationInputDeg).toBe(0);
    expect(stillSnap.maxHairBoneDeltaDeg).toBe(0);

    // Bar 4 part B: When the pointer crosses the canvas, head angular velocity reaches physics
    // and hair swings with a non-zero delta on the crossing frame.
    const crossingSnap = await page.evaluate(() => {
      const api = window.__lookDemo!;
      api.setPointerNormalized(-1, 0);
      api.stepFrames(60, 1 / 60);
      // Settle at (-1, 0), then cross to (+1, 0) in one frame:
      api.setPointerNormalized(1, 0);
      return api.step(1 / 60);
    });
    console.log(
      `[look:bar4:physics] ${testInfo.project.name}: ` +
        `stillHairDelta=${stillSnap.maxHairBoneDeltaDeg.toFixed(6)}deg, ` +
        `crossingAngVel=${crossingSnap.headAngularVelocityDegPerSec.toFixed(1)}deg/s, ` +
        `crossingPhysInput=${crossingSnap.physicsRotationInputDeg.toFixed(3)}deg, ` +
        `crossingMaxHairDelta=${crossingSnap.maxHairBoneDeltaDeg.toFixed(3)}deg`,
    );
    expect(crossingSnap.headAngularVelocityDegPerSec).toBeGreaterThan(100);
    expect(Math.abs(crossingSnap.physicsRotationInputDeg)).toBeGreaterThan(1);
    expect(crossingSnap.maxHairBoneDeltaDeg).toBeGreaterThan(5);
    for (const hairBone of dials.hairPhysicsBones) {
      expect(crossingSnap.hairBoneDeltasDeg[hairBone]).toBeGreaterThan(1);
    }

    // Bar 3: Pointer at the four corners for 1 s:
    // - Eyes reach (±1, ±1) within one frame.
    // - Head angles settle within 2% of (±Y, ±P) and roll sign matches fx*fy (headRoll = fx*fy*(-R)).
    const corners: Array<readonly [number, number]> = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    for (const [fx, fy] of corners) {
      const cornerReport = await page.evaluate(
        ({ targetFx, targetFy }) => {
          const api = window.__lookDemo!;
          api.clearPointer();
          api.stepFrames(60, 1 / 60);
          api.setPointerNormalized(targetFx, targetFy);
          const frame1 = api.step(1 / 60);
          // Step remaining 59 frames to complete 1.0 s (60 frames total at 60 Hz)
          const settled = api.stepFrames(59, 1 / 60);
          return { frame1, settled };
        },
        { targetFx: fx, targetFy: fy },
      );

      // Eyes reach (±1, ±1) on frame 1 while head is still on the spring:
      expect(cornerReport.frame1.eyeX).toBe(fx);
      expect(cornerReport.frame1.eyeY).toBe(fy);
      expect(Math.abs(cornerReport.frame1.headYaw)).toBeLessThan(dials.Y * 0.5);
      expect(Math.abs(cornerReport.frame1.headPitch)).toBeLessThan(dials.P * 0.5);

      const expectedYaw = fx * dials.Y;
      const expectedPitch = fy * dials.P;
      const expectedRoll = fx * fy * -dials.R;
      const expectedBody = fx * dials.B;

      const yawErrorRatio = Math.abs(cornerReport.settled.headYaw - expectedYaw) / dials.Y;
      const pitchErrorRatio = Math.abs(cornerReport.settled.headPitch - expectedPitch) / dials.P;
      const rollErrorRatio = Math.abs(cornerReport.settled.headRoll - expectedRoll) / dials.R;
      const bodyErrorRatio = Math.abs(cornerReport.settled.bodyYaw - expectedBody) / dials.B;

      console.log(
        `[look:bar3:corner] ${testInfo.project.name} (${fx}, ${fy}): ` +
          `frame1Eyes=(${cornerReport.frame1.eyeX}, ${cornerReport.frame1.eyeY}), ` +
          `settledYaw=${cornerReport.settled.headYaw.toFixed(3)} (err=${(yawErrorRatio * 100).toFixed(4)}%), ` +
          `settledPitch=${cornerReport.settled.headPitch.toFixed(3)} (err=${(pitchErrorRatio * 100).toFixed(4)}%), ` +
          `settledRoll=${cornerReport.settled.headRoll.toFixed(3)} (rollFactor=${cornerReport.settled.rollFactor.toFixed(3)}), ` +
          `settledBody=${cornerReport.settled.bodyYaw.toFixed(3)}`,
      );

      expect(yawErrorRatio).toBeLessThanOrEqual(0.02);
      expect(pitchErrorRatio).toBeLessThanOrEqual(0.02);
      expect(rollErrorRatio).toBeLessThanOrEqual(0.02);
      expect(bodyErrorRatio).toBeLessThanOrEqual(0.02);
      expect(Math.sign(cornerReport.settled.rollFactor)).toBe(Math.sign(fx * fy));
      expect(Math.sign(cornerReport.settled.headRoll)).toBe(Math.sign(fx * fy * -1));
      expect(cornerReport.settled.eyeX).toBe(fx);
      expect(cornerReport.settled.eyeY).toBe(fy);
    }

    // Absent pointer -> (0, 0)
    const absentReport = await page.evaluate(() => {
      const api = window.__lookDemo!;
      api.clearPointer();
      const frame1 = api.step(1 / 60);
      const settled = api.stepFrames(59, 1 / 60);
      return { frame1, settled };
    });
    expect(absentReport.frame1.eyeX).toBe(0);
    expect(absentReport.frame1.eyeY).toBe(0);
    expect(Math.abs(absentReport.settled.headYaw)).toBeLessThan(1e-6);
    expect(Math.abs(absentReport.settled.headPitch)).toBeLessThan(1e-6);
    expect(Math.abs(absentReport.settled.headRoll)).toBeLessThan(1e-6);

    // --- Bar 2: Dial values read dynamically + rig without a yaw dial renders static with 1 console warning ---
    const rawModelText = readFileSync(
      join(process.cwd(), 'examples/look/rig/skeleton.model.json'),
      'utf8',
    );
    await page.route('**/examples/look/rig/custom-dials.model.json', async (route) => {
      const modified = JSON.parse(rawModelText) as {
        constraints: Array<{
          kind: string;
          name: string;
          from?: number;
          scale?: number;
        }>;
      };
      for (const c of modified.constraints) {
        if (c.kind === 'slider' && c.name === 'yaw') {
          // duration = 3.0; from = -18, scale = 3.0 / 36 = 0.08333333333333333 -> Y = 18
          c.from = -18;
          c.scale = 3.0 / 36;
        }
        if (c.kind === 'slider' && c.name === 'pitch') {
          // duration = 2.5; from = -15, scale = 2.5 / 30 = 0.08333333333333333 -> P = 15
          c.from = -15;
          c.scale = 2.5 / 30;
        }
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(modified),
      });
    });

    const customDialResult = await page.evaluate(() =>
      window.__lookDemo!.loadRig('/examples/look/rig/custom-dials.model.json'),
    );
    expect(customDialResult.isStaticFallback).toBe(false);
    expect(customDialResult.dials?.Y).toBeCloseTo(18, 5);
    expect(customDialResult.dials?.P).toBeCloseTo(15, 5);

    // Negative control (Bar 2): Open page with `/rigs/walk/skeleton.model.json` which has no `yaw` dial.
    consoleWarnings.length = 0;
    const walkResponse = await page.goto(
      '/examples/look/index.html?manual=1&rig=/rigs/walk/skeleton.model.json',
    );
    expect(walkResponse?.status()).toBe(200);
    await page.waitForFunction(() => document.body.dataset.lookReady === 'true');
    const walkResult = await page.evaluate(() => {
      const api = window.__lookDemo!;
      const pixelsBefore = api.countNonEmptyPixels();
      api.setPointerNormalized(1, 1);
      api.step(1 / 60);
      const pixelsAfter = api.countNonEmptyPixels();
      return {
        isStaticFallback: api.isStaticFallback,
        missingAxis: api.missingAxis,
        dials: api.dials,
        pixelsBefore,
        pixelsAfter,
      };
    });

    console.log(
      `[look:bar2:no-yaw] ${testInfo.project.name}: ` +
        `isStaticFallback=${walkResult.isStaticFallback}, missingAxis=${walkResult.missingAxis}, ` +
        `warnings=${consoleWarnings.length} (${JSON.stringify(consoleWarnings[0] ?? '')}), ` +
        `pixels=${walkResult.pixelsBefore}/${walkResult.pixelsAfter}`,
    );

    expect(pageErrors).toEqual([]);
    expect(walkResult.isStaticFallback).toBe(true);
    expect(walkResult.missingAxis).toBe('yaw');
    expect(walkResult.pixelsBefore).toBeGreaterThan(1000);
    expect(walkResult.pixelsAfter).toBe(walkResult.pixelsBefore);
    expect(consoleWarnings.length).toBe(1);
    expect(consoleWarnings[0]).toMatch(/missing required dial axis "yaw"/);
  });

  test('Bar 5: Repository hygiene — no video files, no full-sheet source plates, no external model or third-party character names', () => {
    const root = process.cwd();
    const files = walkRepoFiles(root);
    const videoExts = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.ogv', '.flv']);

    const allowedPartNames = new Set([
      'bottomwear',
      'brow_l',
      'brow_r',
      'ear_l',
      'ear_r',
      'eyewhite_l',
      'eyewhite_r',
      'face',
      'forearm_l',
      'forearm_r',
      'hair_back',
      'hair_front',
      'hairpin',
      'iris_l',
      'iris_r',
      'lash_l',
      'lash_r',
      'mouth',
      'neck',
      'nose',
      'shins',
      'shoe_l',
      'shoe_r',
      'sleevefront_l',
      'thigh_l',
      'thigh_r',
      'topwear',
      'upperarm_l',
      'upperarm_r',
    ]);

    const allowedLookTopFiles = new Set([
      'examples/look/index.html',
      'examples/look/look.ts',
      'examples/look/main.ts',
      'examples/look/look-corners.webp',
      'examples/look/tests/look.spec.ts',
      'examples/look/rig/skeleton.model.json',
      'examples/look/rig/skeleton.json',
      'examples/look/rig/skeleton.atlas',
    ]);

    const violations: string[] = [];
    for (const file of files) {
      const rel = relative(root, file).replace(/\\/g, '/');
      const ext = extname(file).toLowerCase();
      if (videoExts.has(ext)) {
        violations.push(`video file: ${rel}`);
      }
      if (rel.startsWith('examples/look/')) {
        if (rel.startsWith('examples/look/rig/images/')) {
          const base = rel.slice('examples/look/rig/images/'.length);
          const partName = base.endsWith('.png') ? base.slice(0, -4) : '';
          if (!allowedPartNames.has(partName)) {
            violations.push(`unallowed rig image or source plate: ${rel}`);
          }
        } else if (!allowedLookTopFiles.has(rel)) {
          violations.push(`unallowed file in examples/look: ${rel}`);
        }
      }
    }

    // Verify skeleton.atlas only references the allowed cut part PNGs (no full-sheet plate)
    const atlasText = readFileSync(join(root, 'examples/look/rig/skeleton.atlas'), 'utf8');
    const atlasPages = atlasText
      .split(/\r?\n/)
      .filter((line) => line.endsWith('.png'))
      .map((line) => line.trim());
    expect(atlasPages.length).toBe(allowedPartNames.size);
    for (const page of atlasPages) {
      const partName =
        page.startsWith('images/') && page.endsWith('.png')
          ? page.slice('images/'.length, -4)
          : '';
      if (!allowedPartNames.has(partName)) {
        violations.push(`unallowed atlas page: ${page}`);
      }
    }

    console.log(
      `[look:bar5:hygiene] scanned ${files.length} repository files; atlasPages=${atlasPages.length}; violations=${violations.length}`,
    );
    expect(violations).toEqual([]);
  });
});
