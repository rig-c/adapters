import {
  loadModel,
  type ModelAssets,
  type PoseBounds,
  type PosedFrame,
} from '@rig-c/play';
import { Container, Ticker, WebGLRenderer } from 'pixi.js';
import {
  getLivePageTextureCount,
  PixiRig,
  type PixiRigResourceCounts,
} from '@rig-c/pixi';

export interface RigAdaptersDemoState {
  rigName: string;
  animName: string;
  time: number;
  timescale: number;
  instanceCount: number;
  bounds: PoseBounds | null;
  drawnFrame: PosedFrame;
  resourceCounts: PixiRigResourceCounts;
  livePageTextures: number;
  nonEmptyPixels: number;
}

declare global {
  interface Window {
    __rigAdaptersDemo?: RigAdaptersDemoState;
    __rigAdaptersDemoError?: string;
  }
}

const KNOWN_RIGS = ['walk', 'flex', 'ride', 'figure', 'glow', 'turned', 'duo'] as const;
const STAGE_WIDTH = 800;
const STAGE_HEIGHT = 600;

const assetsCache = new Map<string, ModelAssets>();

async function getAssets(rigName: string): Promise<ModelAssets> {
  const cached = assetsCache.get(rigName);
  if (cached) return cached;
  const assets = await loadModel({ modelUrl: `/rigs/${rigName}/skeleton.model.json` });
  assetsCache.set(rigName, assets);
  return assets;
}

function measureAnimationBounds(
  assets: ModelAssets,
  animName: string,
): PoseBounds {
  const probe = new PixiRig(assets, { ticker: null, autoUpdate: false });
  probe.play(animName);
  const anim = assets.animations.find((a) => a.name === animName);
  const duration = anim ? anim.duration : 1;
  const sampleTimes =
    duration > 0 ? [0, duration * 0.25, duration * 0.5, duration * 0.75] : [0];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const t of sampleTimes) {
    probe.seek(t);
    const b = probe.bounds();
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  probe.destroy();

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { x: -200, y: -200, width: 400, height: 400 };
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function positionRigsInStage(
  rigs: readonly PixiRig[],
  unionBounds: PoseBounds,
): void {
  const count = rigs.length;
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const cellW = STAGE_WIDTH / cols;
  const cellH = STAGE_HEIGHT / rows;

  const worldCenterX = unionBounds.x + unionBounds.width * 0.5;
  const screenMinY = -(unionBounds.y + unionBounds.height);
  const screenMaxY = -unionBounds.y;
  const screenCenterY = (screenMinY + screenMaxY) * 0.5;

  const scale = Math.min(
    (cellW * 0.78) / unionBounds.width,
    (cellH * 0.78) / unionBounds.height,
  );

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const centerX = (col + 0.5) * cellW;
    const centerY = (row + 0.5) * cellH;
    const rig = rigs[i];
    rig.scale.set(scale, scale);
    rig.position.set(
      centerX - worldCenterX * scale,
      centerY - screenCenterY * scale,
    );
  }
}

function countNonEmptyPixels(renderer: WebGLRenderer): number {
  const gl = (renderer as unknown as { gl: WebGLRenderingContext | WebGL2RenderingContext }).gl;
  const width = STAGE_WIDTH;
  const height = STAGE_HEIGHT;
  const pixels = new Uint8Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let nonEmpty = 0;
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] > 0) nonEmpty++;
  }
  return nonEmpty;
}

async function bootDemo(): Promise<void> {
  const stageHost = document.getElementById('pixi-stage') as HTMLDivElement;
  const statusBar = document.getElementById('status-bar') as HTMLDivElement;
  const rigSelect = document.getElementById('rig-select') as HTMLSelectElement;
  const animSelect = document.getElementById('anim-select') as HTMLSelectElement;
  const timeInput = document.getElementById('time-input') as HTMLInputElement;
  const timescaleInput = document.getElementById('timescale-input') as HTMLInputElement;
  const countInput = document.getElementById('count-input') as HTMLInputElement;
  const toggleBtn = document.getElementById('toggle-btn') as HTMLButtonElement;

  const params = new URLSearchParams(window.location.search);
  const requestedRig = params.get('rig') ?? 'walk';
  const initialRig = (KNOWN_RIGS as readonly string[]).includes(requestedRig)
    ? requestedRig
    : 'walk';
  const requestedAnim = params.get('anim');
  const requestedTimeParam = params.get('time');
  const requestedTimescaleParam = params.get('timescale');
  const requestedCountParam = params.get('count');

  const hasExplicitTime =
    requestedTimeParam !== null &&
    requestedTimeParam.trim() !== '' &&
    Number.isFinite(Number(requestedTimeParam));
  const initialTime = hasExplicitTime ? Math.max(0, Number(requestedTimeParam)) : 0;

  const hasExplicitTimescale =
    requestedTimescaleParam !== null &&
    requestedTimescaleParam.trim() !== '' &&
    Number.isFinite(Number(requestedTimescaleParam)) &&
    Number(requestedTimescaleParam) >= 0;
  // When ?time= is provided without an explicit ?timescale=, hold the frame (timescale = 0)
  // so deterministic screenshots can be captured at that exact timestamp.
  const initialTimescale = hasExplicitTimescale
    ? Number(requestedTimescaleParam)
    : hasExplicitTime
      ? 0
      : 1;

  const initialCount =
    requestedCountParam !== null && Number.isFinite(Number(requestedCountParam))
      ? Math.max(1, Math.min(24, Math.floor(Number(requestedCountParam))))
      : 1;

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
  const ticker = new Ticker();
  ticker.autoStart = false;

  let activeRigs: PixiRig[] = [];
  let currentRigName = initialRig;
  let currentAnimName = '';
  let currentTimescale = initialTimescale;

  function destroyActiveRigs(): void {
    for (const rig of activeRigs) {
      stage.removeChild(rig);
      rig.destroy();
    }
    activeRigs = [];
  }

  function renderStageAndPublishState(): void {
    renderer.render({ container: stage });
    const primary = activeRigs[0];
    if (!primary) return;

    const bounds = primary.bounds();
    const counts = primary.resourceCounts();
    const livePageTextures = getLivePageTextureCount();
    const nonEmptyPixels = countNonEmptyPixels(renderer);

    window.__rigAdaptersDemo = {
      rigName: currentRigName,
      animName: currentAnimName,
      time: primary.time,
      timescale: primary.timescale,
      instanceCount: activeRigs.length,
      bounds,
      drawnFrame: primary.drawnFrame(),
      resourceCounts: counts,
      livePageTextures,
      nonEmptyPixels,
    };

    const boundsText = bounds
      ? `bounds=(${bounds.x.toFixed(1)}, ${bounds.y.toFixed(1)}, ${bounds.width.toFixed(1)}×${bounds.height.toFixed(1)})`
      : 'bounds=null';
    statusBar.textContent =
      `rig=${currentRigName}  anim=${currentAnimName}  t=${primary.time.toFixed(3)}s  ` +
      `timescale=${primary.timescale}  instances=${activeRigs.length}  ` +
      `sprites=${counts.sprites}  meshes=${counts.meshes}  pageTextures=${livePageTextures}  ${boundsText}`;
  }

  ticker.add(() => {
    if (activeRigs.length === 0) return;
    renderer.render({ container: stage });
    const primary = activeRigs[0];
    if (primary) {
      timeInput.value = primary.time.toFixed(2);
      const bounds = primary.bounds();
      const counts = primary.resourceCounts();
      const livePageTextures = getLivePageTextureCount();
      if (window.__rigAdaptersDemo) {
        window.__rigAdaptersDemo.time = primary.time;
        window.__rigAdaptersDemo.timescale = primary.timescale;
        window.__rigAdaptersDemo.bounds = bounds;
        window.__rigAdaptersDemo.drawnFrame = primary.drawnFrame();
        window.__rigAdaptersDemo.resourceCounts = counts;
        window.__rigAdaptersDemo.livePageTextures = livePageTextures;
      }
      const boundsText = bounds
        ? `bounds=(${bounds.x.toFixed(1)}, ${bounds.y.toFixed(1)}, ${bounds.width.toFixed(1)}×${bounds.height.toFixed(1)})`
        : 'bounds=null';
      statusBar.textContent =
        `rig=${currentRigName}  anim=${currentAnimName}  t=${primary.time.toFixed(3)}s  ` +
        `timescale=${primary.timescale}  instances=${activeRigs.length}  ` +
        `sprites=${counts.sprites}  meshes=${counts.meshes}  pageTextures=${livePageTextures}  ${boundsText}`;
    }
  });

  async function loadScene(
    rigName: string,
    preferredAnim: string | null,
    seekTime: number,
    timescale: number,
    instanceCount: number,
  ): Promise<void> {
    document.body.dataset.demoReady = 'false';
    destroyActiveRigs();

    const assets = await getAssets(rigName);
    const animNames = assets.animations.map((a) => a.name);
    const chosenAnim =
      preferredAnim && animNames.includes(preferredAnim)
        ? preferredAnim
        : (animNames[0] ?? '');

    animSelect.innerHTML = '';
    for (const name of animNames) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === chosenAnim) opt.selected = true;
      animSelect.appendChild(opt);
    }

    currentRigName = rigName;
    currentAnimName = chosenAnim;
    currentTimescale = timescale;

    const animDuration =
      assets.animations.find((a) => a.name === chosenAnim)?.duration ?? 1;
    const unionBounds = measureAnimationBounds(assets, chosenAnim);

    for (let i = 0; i < instanceCount; i++) {
      const rig = new PixiRig(assets, {
        ticker,
        autoUpdate: true,
        timescale,
      });
      rig.play(chosenAnim);
      const offset =
        instanceCount > 1 && animDuration > 0
          ? (seekTime + (i * animDuration) / instanceCount) % animDuration
          : seekTime;
      rig.seek(offset);
      stage.addChild(rig);
      activeRigs.push(rig);
    }

    positionRigsInStage(activeRigs, unionBounds);
    renderStageAndPublishState();

    rigSelect.value = rigName;
    timeInput.value = seekTime.toFixed(2);
    timescaleInput.value = String(timescale);
    countInput.value = String(instanceCount);
    toggleBtn.textContent = timescale === 0 ? 'Play' : 'Pause';

    if (timescale > 0) {
      ticker.start();
    } else {
      ticker.stop();
    }

    document.body.dataset.demoReady = 'true';
  }

  rigSelect.addEventListener('change', () => {
    void loadScene(
      rigSelect.value,
      null,
      0,
      currentTimescale,
      Math.max(1, Math.min(24, Number(countInput.value) || 1)),
    );
  });

  animSelect.addEventListener('change', () => {
    void loadScene(
      currentRigName,
      animSelect.value,
      0,
      currentTimescale,
      activeRigs.length || 1,
    );
  });

  timeInput.addEventListener('change', () => {
    const t = Math.max(0, Number(timeInput.value) || 0);
    for (let i = 0; i < activeRigs.length; i++) {
      activeRigs[i].seek(t);
    }
    renderStageAndPublishState();
  });

  timescaleInput.addEventListener('change', () => {
    const ts = Math.max(0, Number(timescaleInput.value) || 0);
    currentTimescale = ts;
    for (const rig of activeRigs) {
      rig.timescale = ts;
    }
    toggleBtn.textContent = ts === 0 ? 'Play' : 'Pause';
    if (ts > 0) {
      ticker.start();
    } else {
      ticker.stop();
    }
    renderStageAndPublishState();
  });

  countInput.addEventListener('change', () => {
    const nextCount = Math.max(1, Math.min(24, Math.floor(Number(countInput.value) || 1)));
    const primaryTime = activeRigs[0]?.time ?? 0;
    void loadScene(currentRigName, currentAnimName, primaryTime, currentTimescale, nextCount);
  });

  toggleBtn.addEventListener('click', () => {
    const nextTimescale = currentTimescale === 0 ? 1 : 0;
    currentTimescale = nextTimescale;
    timescaleInput.value = String(nextTimescale);
    for (const rig of activeRigs) {
      rig.timescale = nextTimescale;
    }
    toggleBtn.textContent = nextTimescale === 0 ? 'Play' : 'Pause';
    if (nextTimescale > 0) {
      ticker.start();
    } else {
      ticker.stop();
    }
    renderStageAndPublishState();
  });

  await loadScene(
    initialRig,
    requestedAnim,
    initialTime,
    initialTimescale,
    initialCount,
  );
}

bootDemo().catch((err: unknown) => {
  window.__rigAdaptersDemoError = err instanceof Error ? err.message : String(err);
  document.body.dataset.demoReady = 'error';
});
