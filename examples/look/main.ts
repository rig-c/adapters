import { loadModel, type ModelAssets } from '@rig-c/play';
import { readModel, type CompiledDocument } from 'rig-c/core';
import { createLookHost, type LookHostName } from './hosts.ts';
import type { LookRig } from './look.ts';
import {
  LookController,
  pointerToNormalized,
  type LookDials,
  type LookStepSnapshot,
} from './look.ts';

export interface FrameTimingReport {
  readonly samplesMs: number[];
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly meanMs: number;
}

export interface PoseInspection {
  readonly bones: Record<string, { x: number; y: number; rotationX: number }>;
  readonly slotBounds: Record<string, { minX: number; minY: number; maxX: number; maxY: number }>;
}

export interface ThreeAdapterVerificationReport {
  readonly cornersChecked: number;
  readonly maxBoneDiff: number;
  readonly pixiOrderCount: number;
  readonly phaserOrderCount: number;
  readonly threeOrderCount: number;
  readonly cameraFixed: boolean;
}

export interface LookDemoApi {
  readonly ready: boolean;
  readonly host: LookHostName;
  dispose(): void;
  readonly modelUrl: string;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  readonly isStaticFallback: boolean;
  readonly missingAxis: string | null;
  readonly dials: LookDials | null;
  readonly snapshot: LookStepSnapshot;
  setPointerNormalized(fx: number, fy: number): void;
  setPointerClient(clientX: number, clientY: number): void;
  clearPointer(): void;
  step(dt?: number): LookStepSnapshot;
  stepFrames(count: number, dt?: number): LookStepSnapshot;
  measureFrameTimesMs(frames?: number): Promise<FrameTimingReport>;
  loadRig(modelUrl: string): Promise<{
    isStaticFallback: boolean;
    missingAxis: string | null;
    dials: LookDials | null;
  }>;
  countNonEmptyPixels(): number;
  inspectPose(boneNames?: readonly string[]): PoseInspection;
  verifyThreeAdapters(): Promise<ThreeAdapterVerificationReport>;
}

declare global {
  interface Window {
    __lookDemo?: LookDemoApi;
    __lookDemoError?: string;
  }
}

const STAGE_WIDTH = 1920;
const STAGE_HEIGHT = 1080;
const DEFAULT_MODEL_URL = '/examples/look/rig/skeleton.model.json';

function updateHud(
  hud: HTMLElement,
  controller: LookController,
  lastFrameMs: number,
): void {
  if (!controller.dialResult.ok) {
    hud.textContent =
      `examples/look — static fallback (missing axis "${controller.dialResult.missingAxis}")\n` +
      `${controller.dialResult.message}`;
    return;
  }
  const { dials } = controller.dialResult;
  const s = controller.snapshot;
  hud.textContent =
    `examples/look  pointer=(${s.fx.toFixed(2)}, ${s.fy.toFixed(2)})  spring=(${s.hx.toFixed(2)}, ${s.hy.toFixed(2)})  frame=${lastFrameMs.toFixed(2)}ms\n` +
    `dials [Y=${dials.Y} P=${dials.P} R=${dials.R} B=${dials.B}]  ` +
    `yaw=${s.headYaw.toFixed(1)}°  pitch=${s.headPitch.toFixed(1)}°  roll=${s.headRoll.toFixed(1)}°  ` +
    `eyes=(${s.eyeX.toFixed(2)}, ${s.eyeY.toFixed(2)})  body=${s.bodyYaw.toFixed(1)}°  hairΔ=${s.maxHairBoneDeltaDeg.toFixed(3)}°`;
}

async function bootLookDemo(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const initialModelUrl = params.get('rig') ?? DEFAULT_MODEL_URL;
  const manualMode = params.get('manual') === '1';

  const stageHost = document.getElementById('look-stage') as HTMLDivElement;
  const hud = document.getElementById('hud') as HTMLDivElement;

  const hostName = params.get('host') ?? 'pixi';
  if (hostName !== 'pixi' && hostName !== 'phaser' && hostName !== 'three') throw new Error(`LookDemo: unknown host "${hostName}"`);
  stageHost.innerHTML = '';
  const host = await createLookHost(hostName, stageHost, STAGE_WIDTH, STAGE_HEIGHT);
  let currentAssets: ModelAssets | null = null;
  let currentDocument: CompiledDocument | null = null;
  let currentRig: LookRig | null = null;
  let controller: LookController | null = null;
  let currentModelUrl = initialModelUrl;
  let lastFrameMs = 0;

  async function mountRig(modelUrl: string): Promise<LookController> {
    document.body.dataset.lookReady = 'false';
    if (currentRig) {
      host.unmount(currentRig);
      currentAssets?.dispose();
      currentAssets = null;
      currentRig = null;
    }
    const response = await fetch(modelUrl);
    if (!response.ok) throw new Error(`LookDemo: model fetch ${modelUrl} failed (${response.status})`);
    const text = await response.text();
    const doc = readModel(text, modelUrl);
    // Give both public readers the exact same response bytes.
    const assets = await loadModel({
      modelUrl, regions: 'none',
      fetch: (input, init) => input === modelUrl
        ? Promise.resolve(new Response(text, { headers: { 'Content-Type': 'application/json' } }))
        : fetch(input, init),
    });
    const rig = host.mount(assets);
    const ctrl = new LookController(rig, assets, doc);
    host.render();

    currentAssets = assets;
    currentDocument = doc;
    currentRig = rig;
    controller = ctrl;
    currentModelUrl = modelUrl;
    updateHud(hud, ctrl, 0);
    document.body.dataset.lookReady = 'true';
    return ctrl;
  }

  await mountRig(initialModelUrl);

  const stepOnce = (dt = 1 / 60): LookStepSnapshot => {
    if (!controller) {
      throw new Error('LookDemo: controller not initialized');
    }
    const t0 = performance.now();
    const snap = controller.step(dt);
    host.render();
    lastFrameMs = performance.now() - t0;
    updateHud(hud, controller, lastFrameMs);
    return snap;
  };

  host.canvas.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!controller) return;
    const rect = host.canvas.getBoundingClientRect();
    const { fx, fy } = pointerToNormalized(ev.clientX, ev.clientY, rect);
    controller.setPointer(fx, fy);
  });

  host.canvas.addEventListener('pointerleave', () => {
    if (!controller) return;
    controller.clearPointer();
  });

  let rafId = 0;
  let lastRafTime = performance.now();
  const onFrame = (now: number): void => {
    const rawDt = (now - lastRafTime) / 1000;
    lastRafTime = now;
    const dt = rawDt > 0 && rawDt < 0.1 ? rawDt : 1 / 60;
    stepOnce(dt);
    rafId = requestAnimationFrame(onFrame);
  };
  if (!manualMode) {
    rafId = requestAnimationFrame(onFrame);
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(rafId);
    rafId = 0;
    if (currentRig) host.unmount(currentRig);
    currentRig = null;
    controller = null;
    currentAssets?.dispose();
    currentAssets = null;
    currentDocument = null;
    host.destroy();
    document.body.dataset.lookReady = 'false';
  };
  window.addEventListener('pagehide', dispose, { once: true });
  const api: LookDemoApi = {
    host: hostName,
    dispose,
    get ready(): boolean {
      return document.body.dataset.lookReady === 'true';
    },
    get modelUrl(): string {
      return currentModelUrl;
    },
    get canvasWidth(): number {
      return host.canvas.width;
    },
    get canvasHeight(): number {
      return host.canvas.height;
    },
    get isStaticFallback(): boolean {
      return controller?.isStaticFallback ?? false;
    },
    get missingAxis(): string | null {
      if (!controller || controller.dialResult.ok) return null;
      return controller.dialResult.missingAxis;
    },
    get dials(): LookDials | null {
      return controller?.dials ?? null;
    },
    get snapshot(): LookStepSnapshot {
      return controller!.snapshot;
    },
    setPointerNormalized(fx: number, fy: number): void {
      controller?.setPointer(fx, fy);
    },
    setPointerClient(clientX: number, clientY: number): void {
      if (!controller) return;
      const rect = host.canvas.getBoundingClientRect();
      const { fx, fy } = pointerToNormalized(clientX, clientY, rect);
      controller.setPointer(fx, fy);
    },
    clearPointer(): void {
      controller?.clearPointer();
    },
    step(dt = 1 / 60): LookStepSnapshot {
      return stepOnce(dt);
    },
    stepFrames(count: number, dt = 1 / 60): LookStepSnapshot {
      if (!controller) {
        throw new Error('LookDemo: controller not initialized');
      }
      if (count <= 0) {
        return controller.snapshot;
      }
      for (let i = 0; i < count - 1; i++) {
        controller.step(dt);
      }
      return stepOnce(dt);
    },
    async measureFrameTimesMs(frames = 120): Promise<FrameTimingReport> {
      const wasRunningRaf = rafId !== 0;
      if (wasRunningRaf) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      const samplesMs: number[] = [];
      for (let i = 0; i < frames; i++) {
        const angle = (i / frames) * Math.PI * 2;
        controller?.setPointer(Math.cos(angle) * 0.85, Math.sin(angle) * 0.85);
        const t0 = performance.now();
        controller?.step(1 / 60);
        host.render();
        const elapsed = performance.now() - t0;
        samplesMs.push(elapsed);
      }
      const sorted = [...samplesMs].sort((a, b) => a - b);
      const p50Ms = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
      const p95Ms = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
      const meanMs = samplesMs.reduce((acc, v) => acc + v, 0) / Math.max(1, samplesMs.length);
      if (wasRunningRaf && !manualMode) {
        lastRafTime = performance.now();
        rafId = requestAnimationFrame(onFrame);
      }
      return { samplesMs, p50Ms, p95Ms, meanMs };
    },
    async loadRig(modelUrl: string) {
      const ctrl = await mountRig(modelUrl);
      return {
        isStaticFallback: ctrl.isStaticFallback,
        missingAxis: ctrl.dialResult.ok ? null : ctrl.dialResult.missingAxis,
        dials: ctrl.dials,
      };
    },
    countNonEmptyPixels(): number {
      return host.countNonEmptyPixels();
    },
    inspectPose(
      boneNames = [
        'head',
        'head_ctl',
        'neck',
        'chest_ctl',
        'eye_r',
        'eye_l',
        'iris_r',
        'iris_l',
        'brow_r',
        'brow_l',
        'nose',
        'mouth',
        'ear_r',
        'ear_l',
      ],
    ): PoseInspection {
      if (!currentRig) {
        return { bones: {}, slotBounds: {} };
      }
      const bones: Record<string, { x: number; y: number; rotationX: number }> = {};
      for (const name of boneNames) {
        try {
          const b = currentRig.bone(name);
          bones[name] = { x: b.x, y: b.y, rotationX: b.rotationX };
        } catch {
          // Ignore bones absent on alternate rigs.
        }
      }
      const slotBounds: Record<string, { minX: number; minY: number; maxX: number; maxY: number }> =
        {};
      const frame = currentRig.posedFrame();
      for (const slot of frame.order) {
        const pts = slot.kind === 'region' ? slot.corners : slot.vertices;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let i = 0; i < pts.length; i += 2) {
          const px = pts[i]!;
          const py = pts[i + 1]!;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
        if (Number.isFinite(minX)) {
          slotBounds[slot.slot] = { minX, minY, maxX, maxY };
        }
      }
      return { bones, slotBounds };
    },
    async verifyThreeAdapters(): Promise<ThreeAdapterVerificationReport> {
      if (!currentAssets || !currentDocument || !currentRig || !controller || !controller.dialResult.ok) {
        throw new Error('LookDemo: rig not ready for adapter verification');
      }
      const initialPlacement = host.placement();
      const probeParent = document.createElement('div');
      probeParent.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(probeParent);
      const probes: Array<{ host: Awaited<ReturnType<typeof createLookHost>>; rig: LookRig; controller: LookController }> = [];
      const corners: Array<readonly [number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      let maxBoneDiff = 0;
      const counts: Record<LookHostName, number> = { pixi: 0, phaser: 0, three: 0 };
      try {
        for (const name of ['pixi', 'phaser', 'three'] as const) {
          const probeHost = await createLookHost(name, probeParent, 256, 256);
          const rig = probeHost.mount(currentAssets);
          probes.push({ host: probeHost, rig, controller: new LookController(rig, currentAssets, currentDocument) });
        }
        for (const [fx, fy] of corners) {
          for (const probe of probes) {
            probe.controller.setPointer(fx, fy);
            for (let i = 0; i < 18; i++) probe.controller.step(1 / 60);
            probe.host.render();
            counts[probe.host.name] = probe.rig.drawnFrame().order.length;
          }
          for (const name of ['head', 'nose', 'eye_r', 'eye_l', 'iris_r', 'iris_l', 'mouth']) {
            const reference = probes[0].rig.bone(name);
            for (const probe of probes.slice(1)) {
              const bone = probe.rig.bone(name);
              maxBoneDiff = Math.max(maxBoneDiff, Math.abs(reference.x - bone.x), Math.abs(reference.y - bone.y));
            }
          }
        }
      } finally {
        for (const probe of probes) { probe.host.unmount(probe.rig); probe.host.destroy(); }
        probeParent.remove();
      }
      return {
        cornersChecked: corners.length, maxBoneDiff,
        pixiOrderCount: counts.pixi, phaserOrderCount: counts.phaser, threeOrderCount: counts.three,
        cameraFixed: JSON.stringify(initialPlacement) === JSON.stringify(host.placement()),
      };
    },
  };

  window.__lookDemo = api;
}

bootLookDemo().catch((err: unknown) => {
  window.__lookDemoError = err instanceof Error ? err.message : String(err);
  document.body.dataset.lookReady = 'error';
});
