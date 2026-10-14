import type { Page } from '@playwright/test';

/**
 * Screenshot differ shared with `@rig-c/play` (`tests/pixelDiff.ts`).
 *
 * Decodes both PNGs in the browser page (`getImageData`) and reduces them to
 * shift-tolerant and raw pixel counts over the drawn content.
 */

/** Max per-channel delta a pixel may show before it counts as "bad". */
export const CHANNEL_TOLERANCE = 24;

/** Shift-tolerant bad pixels allowed as a fraction of the drawn-content union. */
export const BAD_RATIO_LIMIT = 0.005;

/** Allowed relative difference in drawn-content pixel counts. */
export const CONTENT_MISMATCH_LIMIT = 0.015;

export interface DiffOptions {
  tolerance?: number;
  directional?: number | null;
  withMask?: boolean;
  floorStrip?: boolean;
}

export interface DiffMetrics {
  width: number;
  height: number;
  rawBad: number;
  bad: number;
  badAB: number;
  badBA: number;
  maxDelta: number;
  contentA: number;
  contentB: number;
  contentUnion: number;
  darker: number;
  lighter: number;
  darkerMean: number;
  darkerMax: number;
  mask?: {
    pngBase64: string;
    direction: 'a-vs-b' | 'b-vs-a';
    red: number;
    yellow: number;
  };
}

export async function diffBase64InPage(
  page: Page,
  aB64: string,
  bB64: string,
  options: DiffOptions = {},
): Promise<DiffMetrics> {
  return page.evaluate(
    async ({ aB64, bB64, tolerance, directional, withMask, floorStrip }): Promise<DiffMetrics> => {
      const decode = async (b64: string): Promise<ImageData> => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('2d context unavailable');
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, canvas.width, canvas.height);
      };
      const [da, db] = await Promise.all([decode(aB64), decode(bB64)]);
      if (da.width !== db.width || da.height !== db.height) {
        throw new Error(
          `screenshot size mismatch: ${da.width}x${da.height} vs ${db.width}x${db.height}`,
        );
      }
      const pa = da.data;
      const pb = db.data;
      const w = da.width;
      const h = da.height;
      const stripAt = w * (h - 1) * 4;
      const bg = [pa[0], pa[1], pa[2]];
      const strip = [pa[stripAt], pa[stripAt + 1], pa[stripAt + 2]];
      const isContent = (p: Uint8ClampedArray, i: number): boolean => {
        const nearBg =
          Math.abs(p[i] - bg[0]) <= 8 &&
          Math.abs(p[i + 1] - bg[1]) <= 8 &&
          Math.abs(p[i + 2] - bg[2]) <= 8;
        if (nearBg) return false;
        if (!floorStrip) return true;
        return !(
          Math.abs(p[i] - strip[0]) <= 8 &&
          Math.abs(p[i + 1] - strip[1]) <= 8 &&
          Math.abs(p[i + 2] - strip[2]) <= 8
        );
      };
      const matchesNear = (
        from: Uint8ClampedArray,
        i: number,
        into: Uint8ClampedArray,
      ): boolean => {
        const px = (i / 4) % w;
        const py = (i / 4 - px) / w;
        for (let dy = -1; dy <= 1; dy++) {
          const y = py + dy;
          if (y < 0 || y >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x = px + dx;
            if (x < 0 || x >= w) continue;
            const j = (y * w + x) * 4;
            if (
              Math.abs(from[i] - into[j]) <= tolerance &&
              Math.abs(from[i + 1] - into[j + 1]) <= tolerance &&
              Math.abs(from[i + 2] - into[j + 2]) <= tolerance
            ) {
              return true;
            }
          }
        }
        return false;
      };
      const luma = (p: Uint8ClampedArray, i: number): number =>
        p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;

      let rawBad = 0;
      let badAB = 0;
      let badBA = 0;
      let maxDelta = 0;
      let contentA = 0;
      let contentB = 0;
      let contentUnion = 0;
      let darker = 0;
      let lighter = 0;
      let darkerSum = 0;
      let darkerMax = 0;
      const maskData = withMask ? new Uint8ClampedArray(pa.length) : null;
      const flags = withMask ? new Uint8Array(pa.length / 4) : null;
      for (let i = 0; i < pa.length; i += 4) {
        const delta = Math.max(
          Math.abs(pa[i] - pb[i]),
          Math.abs(pa[i + 1] - pb[i + 1]),
          Math.abs(pa[i + 2] - pb[i + 2]),
        );
        if (delta > maxDelta) maxDelta = delta;
        if (delta > tolerance) {
          rawBad++;
          const missAB = !matchesNear(pa, i, pb);
          const missBA = !matchesNear(pb, i, pa);
          if (missAB) badAB++;
          if (missBA) badBA++;
          if (flags) flags[i / 4] = 1 | (missAB ? 2 : 0) | (missBA ? 4 : 0);
        }
        if (maskData) {
          const grey = ((pa[i] * 0.299 + pa[i + 1] * 0.587 + pa[i + 2] * 0.114) * 0.45) | 0;
          maskData[i] = grey;
          maskData[i + 1] = grey;
          maskData[i + 2] = grey;
          maskData[i + 3] = 255;
        }
        const ca = isContent(pa, i);
        const cb = isContent(pb, i);
        if (ca) contentA++;
        if (cb) contentB++;
        if (ca || cb) contentUnion++;
        if (directional !== null && (ca || cb) && delta > directional) {
          const drop = luma(pa, i) - luma(pb, i);
          if (drop > 0) {
            darker++;
            darkerSum += drop;
            if (drop > darkerMax) darkerMax = drop;
          } else {
            lighter++;
          }
        }
      }
      const bad = Math.max(badAB, badBA);
      let mask: DiffMetrics['mask'];
      if (maskData && flags) {
        const redBit = badAB >= badBA ? 2 : 4;
        for (let p = 0; p < flags.length; p++) {
          if (!(flags[p] & 1)) continue;
          const i = p * 4;
          maskData[i] = 255;
          maskData[i + 1] = flags[p] & redBit ? 0 : 255;
          maskData[i + 2] = 0;
        }
        let red = 0;
        let yellow = 0;
        for (let i = 0; i < maskData.length; i += 4) {
          if (maskData[i] !== 255 || maskData[i + 2] !== 0) continue;
          if (maskData[i + 1] === 0) red++;
          else if (maskData[i + 1] === 255) yellow++;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2d context unavailable');
        ctx.putImageData(new ImageData(maskData, w, h), 0, 0);
        mask = {
          pngBase64: canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, ''),
          direction: badAB >= badBA ? 'a-vs-b' : 'b-vs-a',
          red,
          yellow,
        };
      }
      return {
        width: w,
        height: h,
        rawBad,
        bad,
        badAB,
        badBA,
        maxDelta,
        contentA,
        contentB,
        contentUnion,
        darker,
        lighter,
        darkerMean: darker ? Math.round((darkerSum / darker) * 100) / 100 : 0,
        darkerMax: Math.round(darkerMax * 100) / 100,
        mask,
      };
    },
    {
      aB64,
      bB64,
      tolerance: options.tolerance ?? CHANNEL_TOLERANCE,
      directional: options.directional ?? null,
      withMask: options.withMask ?? false,
      floorStrip: options.floorStrip ?? false,
    },
  );
}

export async function diffInPage(
  page: Page,
  a: Buffer,
  b: Buffer,
  options: DiffOptions = {},
): Promise<DiffMetrics> {
  return diffBase64InPage(page, a.toString('base64'), b.toString('base64'), options);
}
