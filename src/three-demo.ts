import { loadModel, type ModelAssets } from '@rig-c/play';
import { ThreeRig } from '@rig-c/three';
import { BoxGeometry, Mesh, MeshBasicMaterial, OrthographicCamera, PerspectiveCamera, Scene, WebGLRenderer, type Camera } from 'three';

const params = new URLSearchParams(location.search);
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rigInput = element<HTMLSelectElement>('rig'), animationInput = element<HTMLSelectElement>('animation'), viewInput = element<HTMLSelectElement>('view'), countInput = element<HTMLInputElement>('count'), speedInput = element<HTMLInputElement>('speed'), timeInput = element<HTMLInputElement>('time'), toggle = element<HTMLButtonElement>('toggle');
const number = (key: string, fallback: number, min: number, max: number) => { const raw = params.get(key), value = raw === null ? fallback : Number(raw); if (!Number.isFinite(value) || value < min || value > max) throw new Error(`DEMO_QUERY: ${key}=${raw} (expected ${min}..${max})`); return value; };
const renderer = new WebGLRenderer({ antialias: false, alpha: true, preserveDrawingBuffer: true }); renderer.setPixelRatio(1); renderer.setSize(1000, 600, false); renderer.setClearColor('#14161a'); element('stage').append(renderer.domElement);
const scene = new Scene(), cube = new Mesh(new BoxGeometry(75, 75, 75), new MeshBasicMaterial({ color: 0x33475d, wireframe: true })); cube.position.set(360, -140, -80); cube.rotation.set(0.4, 0.6, 0.2); scene.add(cube);
let currentAssets: ModelAssets | null = null;
let rigs: ThreeRig[] = [], camera: Camera, frameId = 0, previous: number | null = null;
let generation = 0, capture = { ready: false, error: '', rig: '', animation: '', times: [] as number[], timescale: 1, count: 0, view: 'orthographic' };
declare global { interface Window { threeDemoState: typeof capture } }
function draw() {
  renderer.render(scene, camera);
  capture = { ready: true, error: '', rig: rigInput.value, animation: animationInput.value, times: rigs.map((r) => r.time), timescale: Number(speedInput.value), count: rigs.length, view: viewInput.value }; window.threeDemoState = capture;
  timeInput.value = String(rigs[0]?.time ?? 0); element('clock').textContent = `${(rigs[0]?.time ?? 0).toFixed(3)} s`;
}
function setCamera() {
  if (viewInput.value === 'perspective') { const c = new PerspectiveCamera(35, 1000 / 600, 0.1, 5000); c.position.set(150, 80, 1100); c.lookAt(0, 0, 0); camera = c; }
  else { const c = new OrthographicCamera(-500, 500, 300, -300, 0.1, 5000); c.position.z = 1000; camera = c; }
}
async function load(time = 0, requested?: string) {
  const currentGeneration = ++generation; previous = null;
  const assets = await loadModel({ modelUrl: `/rigs/${rigInput.value}/skeleton.model.json` });
  if (currentGeneration !== generation) { assets.dispose(); return; }
  rigs.forEach((r) => r.destroy()); rigs = []; currentAssets?.dispose(); currentAssets = assets;
  animationInput.replaceChildren(...assets.animations.map((a) => new Option(a.name, a.name)));
  const animation = requested ?? assets.animations[0].name;
  if (!assets.animations.some((a) => a.name === animation)) throw new Error(`DEMO_ANIMATION: "${animation}" not in ${rigInput.value}`);
  animationInput.value = animation;
  const count = Number(countInput.value); if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error(`DEMO_COUNT: ${count} (expected integer 1..10)`);
  timeInput.max = String(Math.max(...assets.animations.map((a) => a.duration), 1));
  for (let i = 0; i < count; i++) {
    const rig = new ThreeRig(assets, { renderer, timescale: Number(speedInput.value) }); rig.renderOrder = i; rig.play(animation); rig.seek(time + i * 0.11);
    const box = rig.bounds(); if (!box || box.height <= 0) throw new Error(`DEMO_BOUNDS: ${rigInput.value} has no positive bounds`);
    const scale = Math.min(430 / box.height, 850 / count / Math.max(box.width, 1)); rig.scale.setScalar(scale);
    rig.position.set(-425 + 850 / count * (i + 0.5) - (box.x + box.width / 2) * scale, -(box.y + box.height / 2) * scale, 0); scene.add(rig); rigs.push(rig);
  }
  setCamera(); draw();
}
function tick(now: number) { if (previous !== null && rigs.length > 0 && Number(speedInput.value) > 0) { const dt = (now - previous) / 1000; rigs.forEach((r) => r.update(dt)); draw(); } previous = now; frameId = requestAnimationFrame(tick); }
function error(value: unknown) { const message = value instanceof Error ? value.message : String(value); element('error').textContent = message; window.threeDemoState = { ...capture, ready: false, error: message }; }
async function boot() {
  const rig = params.get('rig') ?? 'walk'; if (![...rigInput.options].some((o) => o.value === rig)) throw new Error(`DEMO_RIG: unknown "${rig}"`); rigInput.value = rig;
  countInput.value = String(number('count', 1, 1, 10)); speedInput.value = String(number('timescale', 1, 0, 4)); const view = params.get('view') ?? 'orthographic'; if (!['orthographic', 'perspective'].includes(view)) throw new Error(`DEMO_VIEW: ${view}`); viewInput.value = view;
  toggle.textContent = Number(speedInput.value) === 0 ? 'Play' : 'Pause';
  await load(number('time', 0, 0, 10000), params.get('anim') ?? undefined); frameId = requestAnimationFrame(tick);
  rigInput.addEventListener('change', () => { void load().catch(error); }); countInput.addEventListener('change', () => { void load().catch(error); });
  animationInput.addEventListener('change', () => { rigs.forEach((r) => r.play(animationInput.value)); draw(); });
  viewInput.addEventListener('change', () => { setCamera(); draw(); });
  speedInput.addEventListener('change', () => { const value = Number(speedInput.value); if (!Number.isFinite(value) || value < 0) { error('DEMO_SPEED: expected finite speed >=0'); return; } rigs.forEach((r) => r.timescale = value); toggle.textContent = value === 0 ? 'Play' : 'Pause'; previous = null; draw(); });
  timeInput.addEventListener('input', () => { rigs.forEach((r, i) => r.seek(Number(timeInput.value) + i * 0.11)); draw(); });
  toggle.addEventListener('click', () => { speedInput.value = Number(speedInput.value) === 0 ? '1' : '0'; speedInput.dispatchEvent(new Event('change')); });
}
window.addEventListener('pagehide', () => { cancelAnimationFrame(frameId); rigs.forEach((r) => r.destroy()); currentAssets?.dispose(); cube.geometry.dispose(); cube.material.dispose(); renderer.dispose(); });
void boot().catch(error);
