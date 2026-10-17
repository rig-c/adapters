import { loadModel, type ModelAssets } from '@rig-c/play';
import { Container, WebGLRenderer } from 'pixi.js';
import { PixiRig } from '@rig-c/pixi';
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

export interface LookDemoApi {
  readonly ready: boolean;
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

function frameRigInStage(rig: PixiRig, viewMode: string | null): void {
  const bounds = rig.bounds();
  if (!bounds) {
    rig.position.set(STAGE_WIDTH * 0.5, STAGE_HEIGHT * 0.85);
    return;
  }
  if (viewMode === 'full') {
    const scale = Math.min(
      (STAGE_WIDTH * 0.82) / Math.max(1, bounds.width),
      (STAGE_HEIGHT * 0.88) / Math.max(1, bounds.height),
    );
    const cx = bounds.x + bounds.width * 0.5;
    const cy = -(bounds.y + bounds.height * 0.5);
    rig.scale.set(scale, scale);
    rig.position.set(STAGE_WIDTH * 0.5 - cx * scale, STAGE_HEIGHT * 0.5 - cy * scale);
    return;
  }

  // Portrait/bust framing centred on the head, eyes, hair, and breathing chest
  // while keeping the entire rig in the PixiJS display list at 1080p.
  let focusX = bounds.x + bounds.width * 0.5;
  let focusY = bounds.y + bounds.height * 0.78;
  try {
    const headBone = rig.bone('head');
    focusX = headBone.x;
    focusY = headBone.y - 10;
  } catch {
    // Rig without a 'head' bone falls back to upper bounds centre.
  }
  const scale = Math.min(1.55, (STAGE_HEIGHT * 1.42) / Math.max(1, bounds.height));
  rig.scale.set(scale, scale);
  rig.position.set(STAGE_WIDTH * 0.5 - focusX * scale, STAGE_HEIGHT * 0.52 + focusY * scale);
}

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
  const viewMode = params.get('view');
  const manualMode = params.get('manual') === '1';

  const stageHost = document.getElementById('look-stage') as HTMLDivElement;
  const hud = document.getElementById('hud') as HTMLDivElement;

  const renderer = new WebGLRenderer();
  await renderer.init({
    width: STAGE_WIDTH,
    height: STAGE_HEIGHT,
    backgroundAlpha: 0,
    antialias: true,
    resolution: 1,
    preserveDrawingBuffer: true,
    clearBeforeRender: true,
  });
  stageHost.innerHTML = '';
  stageHost.appendChild(renderer.canvas);

  const stage = new Container();

  let currentAssets: ModelAssets | null = null;
  let currentRig: PixiRig | null = null;
  let controller: LookController | null = null;
  let currentModelUrl = initialModelUrl;
  let lastFrameMs = 0;

  async function mountRig(modelUrl: string): Promise<LookController> {
    document.body.dataset.lookReady = 'false';
    if (currentRig) {
      stage.removeChild(currentRig);
      renderer.render({ container: stage });
      currentRig.destroy();
      currentRig = null;
    }
    const assets = await loadModel({
      modelUrl,
      regions: 'none',
    });
    const rig = new PixiRig(assets, {
      ticker: null,
      autoUpdate: false,
    });
    stage.addChild(rig);
    const ctrl = new LookController(rig, assets);
    frameRigInStage(rig, viewMode);
    renderer.render({ container: stage });

    currentAssets = assets;
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
    renderer.render({ container: stage });
    lastFrameMs = performance.now() - t0;
    updateHud(hud, controller, lastFrameMs);
    return snap;
  };

  renderer.canvas.addEventListener('pointermove', (ev: PointerEvent) => {
    if (!controller) return;
    const rect = renderer.canvas.getBoundingClientRect();
    const { fx, fy } = pointerToNormalized(ev.clientX, ev.clientY, rect);
    controller.setPointer(fx, fy);
  });

  renderer.canvas.addEventListener('pointerleave', () => {
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

  const api: LookDemoApi = {
    get ready(): boolean {
      return document.body.dataset.lookReady === 'true';
    },
    get modelUrl(): string {
      return currentModelUrl;
    },
    get canvasWidth(): number {
      return renderer.canvas.width;
    },
    get canvasHeight(): number {
      return renderer.canvas.height;
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
      const rect = renderer.canvas.getBoundingClientRect();
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
      let snap = controller!.snapshot;
      for (let i = 0; i < count; i++) {
        snap = stepOnce(dt);
      }
      return snap;
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
        renderer.render({ container: stage });
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
      void currentAssets;
      const ctrl = await mountRig(modelUrl);
      return {
        isStaticFallback: ctrl.isStaticFallback,
        missingAxis: ctrl.dialResult.ok ? null : ctrl.dialResult.missingAxis,
        dials: ctrl.dials,
      };
    },
    countNonEmptyPixels(): number {
      const gl = (renderer as unknown as { gl: WebGLRenderingContext | WebGL2RenderingContext })
        .gl;
      const pixels = new Uint8Array(STAGE_WIDTH * STAGE_HEIGHT * 4);
      gl.readPixels(0, 0, STAGE_WIDTH, STAGE_HEIGHT, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let nonEmpty = 0;
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] > 0) nonEmpty++;
      }
      return nonEmpty;
    },
  };

  window.__lookDemo = api;
}

bootLookDemo().catch((err: unknown) => {
  window.__lookDemoError = err instanceof Error ? err.message : String(err);
  document.body.dataset.lookReady = 'error';
});
