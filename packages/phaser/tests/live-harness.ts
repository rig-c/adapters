import Phaser from 'phaser';
import { RigPlayer, loadModel, type PosedFrame, type ModelAssets, type SlotFilter, type PoseBounds } from '@rig-c/play';
import { PhaserRig, getPhaserLivePageTextureCount, getPhaserPageRefCount, getPhaserPageTexture } from '../src/index.ts';
import { assetsFor, gameFor, composite } from './harness.ts';
import { slotViews } from './full-harness.ts';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function native(game: Phaser.Game) { return game.renderer as Phaser.Renderer.WebGL.WebGLRenderer; }
function pixels(game: Phaser.Game): number {
  const canvas = document.createElement('canvas'); canvas.width = game.canvas.width; canvas.height = game.canvas.height;
  const ctx = canvas.getContext('2d')!; ctx.drawImage(game.canvas, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data; let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]) n++; return n;
}
function bare(assets: ModelAssets) { return new RigPlayer(document.createElement('div'), assets, { mode: 'canvas' }); }

export async function parity(rigName: string, animation: string, time: number, mutant = false) {
  const assets = await assetsFor(rigName), { scene } = await gameFor();
  const rig = new PhaserRig(scene, assets, { autoUpdate: false }), player = bare(assets);
  scene.add.existing(rig);
  let ingress: PosedFrame | null = null;
  const render = rig.renderer.render.bind(rig.renderer);
  rig.renderer.render = (frame) => { const submitted = mutant ? { order: frame.order.slice(1) } : frame; ingress = submitted; render(submitted); };
  try {
    const initial = same(rig.drawnFrame(), player.posedFrame());
    rig.play(animation); player.play(animation); rig.seek(time); player.seek(time);
    const seekEqual = same(ingress, player.posedFrame()) && ingress === rig.drawnFrame();
    rig.advance(1 / 60); player.advance(1 / 60);
    const advanceEqual = same(ingress, player.posedFrame()) && ingress === rig.drawnFrame();
    rig.setPosition(123, 456).setScale(0.75, 1.25);
    let boneNames: readonly string[] = [];
    player.adjust = (bones) => { boneNames = bones.names; };
    player.adjust = null;
    const allBones = boneNames.every((name) => same(rig.bone(name), player.bone(name)));
    return {
      initial,
      equal: seekEqual && advanceEqual,
      seekEqual,
      advanceEqual,
      exactObject: ingress === rig.drawnFrame(),
      bounds: same(rig.bounds(), player.bounds()),
      bone: same(rig.bone('root'), player.bone('root')),
      allBones,
      boneCount: boneNames.length,
      bytes: JSON.stringify(ingress).length,
    };
  } finally { rig.destroy(); player.dispose(); }
}

export type TickMutant = 'none' | 'drop-update' | 'double-scale' | 'ignore-zero' | 'always-upload';
export async function fixedUpdates(scale: number, mutant: TickMutant = 'none', manual = false) {
  const assets = await assetsFor('glow'), { game, scene } = await gameFor(), gl = native(game).gl;
  const baseline = scene.sys.events.listenerCount(Phaser.Scenes.Events.UPDATE);
  const rig = new PhaserRig(scene, assets, { timescale: scale, autoUpdate: !manual }), player = bare(assets);
  scene.add.existing(rig); rig.setPosition(300, 450); rig.play('burn'); player.play('burn'); player.timeScale = scale;
  rig.seek(0.5); player.seek(0.5); game.step(0, 0);
  const handles = new Set(slotViews(rig).flatMap((view) => [view.slotBuffers!.position.webGLBuffer, view.slotBuffers!.uv.webGLBuffer, view.slotBuffers!.index.webGLBuffer]));
  const data = gl.bufferData.bind(gl), sub = gl.bufferSubData.bind(gl), image = gl.texImage2D.bind(gl);
  let uploaded = 0, textureUploads = 0;
  const counts = (target: number, length: number) => { if (handles.has(gl.getParameter(target === gl.ARRAY_BUFFER ? gl.ARRAY_BUFFER_BINDING : gl.ELEMENT_ARRAY_BUFFER_BINDING))) uploaded += length; };
  gl.bufferData = ((target: number, source: number | BufferSource | null, usage: number) => { counts(target, typeof source === 'number' ? source : source?.byteLength ?? 0); data(target, source as BufferSource, usage); }) as typeof gl.bufferData;
  gl.bufferSubData = (target, offset, source) => { counts(target, source.byteLength); sub(target, offset, source); };
  gl.texImage2D = ((...args: Parameters<typeof gl.texImage2D>) => { textureUploads++; image(...args); }) as typeof gl.texImage2D;
  const calls: number[] = [], delivered: number[][] = [];
  const advance = rig.advance.bind(rig); rig.advance = (dt) => {
    calls.push(dt);
    if (mutant === 'drop-update' && calls.length === 1) return;
    if (mutant === 'double-scale') dt *= rig.timescale;
    if (mutant === 'ignore-zero' && scale === 0) rig.player.timeScale = 1;
    advance(dt);
  };
  rig.renderer.alwaysReuploadGeometry = mutant === 'always-upload';
  const observe = (time: number, delta: number) => delivered.push([time, delta]); scene.sys.events.on(Phaser.Scenes.Events.UPDATE, observe);
  const deltaMS = 1000 / 60, dt = deltaMS / 1000, N = 60;
  let equal = true, timeEqual = true;
  try {
    for (let i = 0; i < N; i++) {
      game.step(100 + i * deltaMS, deltaMS);
      if (!manual) player.advance(dt);
      equal &&= same(rig.drawnFrame(), player.posedFrame()); timeEqual &&= Object.is(rig.time, player.time);
    }
    const deliveredExact = delivered.every(([t, d], i) => Object.is(t, 100 + i * deltaMS) && Object.is(d, deltaMS));
    const heldManual = manual && rig.time === 0.5;
    if (manual) { rig.advance(dt); player.advance(dt); equal &&= same(rig.drawnFrame(), player.posedFrame()); timeEqual &&= Object.is(rig.time, player.time); }
    const rigTime = rig.time, bareTime = player.time;
    scene.sys.events.off(Phaser.Scenes.Events.UPDATE, observe);
    rig.destroy();
    return {
      scale, N, deltaMS, dt,
      firstDelivered: delivered[0], lastDelivered: delivered.at(-1), deliveredCount: delivered.length,
      deliveredExact, calls: calls.length,
      conversionExact: calls.every((value) => Object.is(value, dt)),
      equal, timeEqual, rigTime, bareTime,
      uploaded, textureUploads, heldManual,
      listenerDelta: scene.sys.events.listenerCount(Phaser.Scenes.Events.UPDATE) - baseline,
    };
  } finally { scene.sys.events.off(Phaser.Scenes.Events.UPDATE, observe); gl.bufferData = data; gl.bufferSubData = sub; gl.texImage2D = image; rig.destroy(); player.dispose(); }
}

export async function realTimeStep() {
  const assets = await assetsFor('glow'), { game, scene } = await gameFor(), rig = new PhaserRig(scene, assets), player = bare(assets);
  scene.add.existing(rig); rig.play('burn'); player.play('burn');
  const delivered: number[][] = []; let equal = true;
  try {
    await new Promise<void>((resolve) => {
      const observe = (time: number, delta: number) => {
        delivered.push([time, delta]); player.advance(delta / 1000);
        equal &&= same(rig.drawnFrame(), player.posedFrame()) && Object.is(rig.time, player.time);
        if (delivered.length === 6) { scene.sys.events.off(Phaser.Scenes.Events.UPDATE, observe); game.loop.sleep(); resolve(); }
      };
      scene.sys.events.on(Phaser.Scenes.Events.UPDATE, observe); game.loop.wake();
    });
    game.loop.sleep(); return { delivered, equal, rigTime: rig.time, bareTime: player.time };
  } finally { game.loop.sleep(); rig.destroy(); player.dispose(); }
}

export async function sharedPages(leak = false, rigName = 'glow', animation = 'burn') {
  const assets = await assetsFor(rigName), { game, scene } = await gameFor(), renderer = native(game), gl = renderer.gl;
  const baseline = scene.sys.events.listenerCount(Phaser.Scenes.Events.UPDATE), rigs = [0, 0.3, 0.6].map((time, i) => {
    const rig = new PhaserRig(scene, assets); scene.add.existing(rig); rig.setPosition(150 + i * 220, 450).setScale(0.6); rig.play(animation); rig.seek(time); return rig;
  });
  game.scale.resize(800, 600); game.step(0, 0);
  const images = [...new Set(rigs[0].drawnFrame().order.map((slot) => assets.pageImages.get(slot.page)!))];
  const textures = images.map((img) => getPhaserPageTexture(renderer, img)!);
  const handleList = textures.map((texture) => texture.source[0].glTexture!.webGLTexture);
  const handles = new Set(handleList);
  const deletes: Array<WebGLTexture | null> = [], del = gl.deleteTexture.bind(gl); gl.deleteTexture = (texture) => { if (handles.has(texture)) deletes.push(texture); del(texture); };
  const remove = scene.textures.remove.bind(scene.textures);
  if (leak) scene.textures.remove = (key) => { if (textures.some((texture) => key === texture || key === texture.key)) return scene.textures; return remove(key); };
  const owned = rigs.map((rig) => slotViews(rig).map((view) => view.slotBuffers!));
  const shared = images.every((img) => getPhaserPageRefCount(renderer, img) === 3) && rigs.every((rig) => slotViews(rig).every((view) => view.texture === getPhaserPageTexture(renderer, assets.pageImages.get(view.posedSlot.page)!)));
  const distinct = new Set(rigs.map((rig) => JSON.stringify(rig.drawnFrame()))).size === 3;
  const phases = [];
  try {
    for (const [i, rig] of rigs.entries()) {
      rig.destroy(); rig.destroy(); game.step(0, 0);
      phases.push({ remaining: images.map((img) => getPhaserPageRefCount(renderer, img)), deleted: deletes.length, freedBuffers: owned[i].every((b) => !renderer.glBufferWrappers.includes(b.position) && !renderer.glBufferWrappers.includes(b.uv) && !renderer.glBufferWrappers.includes(b.index) && !renderer.glVAOWrappers.includes(b.vao)), pixels: pixels(game) });
    }
    return { shared, distinct, pages: images.length, phases, exactlyOnce: handleList.every((expected) => deletes.filter((handle) => handle === expected).length === 1), deleted: deletes.length, live: getPhaserLivePageTextureCount(renderer), listenerDelta: scene.sys.events.listenerCount(Phaser.Scenes.Events.UPDATE) - baseline, png: composite(game.canvas) };
  } finally { scene.textures.remove = remove; for (const rig of rigs) rig.destroy(); for (const texture of textures) if (scene.textures.exists(texture.key)) remove(texture); gl.deleteTexture = del; }
}

export async function newGame(create: (scene: Phaser.Scene) => void): Promise<{ game: Phaser.Game; scene: Phaser.Scene }> {
  return new Promise((resolve) => {
    const game = new Phaser.Game({ type: Phaser.WEBGL, width: 400, height: 500, transparent: true, banner: false, audio: { noAudio: true }, render: { antialias: false, antialiasGL: false, preserveDrawingBuffer: true }, scene: { key: 'lifecycle', create(this: Phaser.Scene) { create(this); queueMicrotask(() => { game.loop.stop(); resolve({ game, scene: this }); }); } } });
  });
}

export async function lifecycle(wholeGame = false) {
  const assets = await assetsFor('glow'); let generation = 0; const rigs: PhaserRig[] = [], listenerDeltas: number[] = [];
  const { game, scene } = await newGame((scene) => { const baseline = scene.sys.events.listenerCount(Phaser.Scenes.Events.UPDATE); const rig = new PhaserRig(scene, assets); scene.add.existing(rig); rig.play('burn'); rigs.push(rig); generation++; listenerDeltas.push(scene.sys.events.listenerCount(Phaser.Scenes.Events.UPDATE) - baseline); });
  const renderer = native(game); const images = [...assets.pageImages.values()];
  const tags = new Set<WebGLTexture | null>(), deleted: Array<WebGLTexture | null> = [], gl = renderer.gl, del = gl.deleteTexture.bind(gl);
  const tag = () => { for (const img of images) { const texture = getPhaserPageTexture(renderer, img); if (texture) tags.add(texture.source[0].glTexture!.webGLTexture); } };
  gl.deleteTexture = (texture) => { if (tags.has(texture)) deleted.push(texture); del(texture); }; tag();
  try {
    if (!wholeGame) {
      scene.scene.restart(); game.step(1, 16); await Promise.resolve(); tag();
      scene.scene.stop(); game.step(2, 16); const stopped = getPhaserLivePageTextureCount(renderer) === 0;
      scene.scene.start('lifecycle'); game.step(3, 16); await Promise.resolve(); tag();
      game.scene.remove('lifecycle'); game.step(4, 16);
      return { generation, listenerDeltas, destroyed: rigs.every((rig) => rig.isDestroyed), live: getPhaserLivePageTextureCount(renderer), deleted: deleted.length, allocated: tags.size, stopped };
    }
    game.destroy(true, false); game.step(0, 0);
    return { generation, listenerDeltas, destroyed: rigs.every((rig) => rig.isDestroyed), live: getPhaserLivePageTextureCount(renderer), deleted: deleted.length, allocated: tags.size, stopped: true };
  } finally { if (!wholeGame) { game.destroy(true, false); game.step(0, 0); } }
}

export async function contextIsolation() {
  const assets = await loadModel({ modelUrl: '/rigs/glow/skeleton.model.json', regions: 'none' });
  const owned: PhaserRig[] = [];
  const a = await newGame((scene) => { const rig = new PhaserRig(scene, assets); scene.add.existing(rig); rig.play('burn'); owned.push(rig); });
  const b = await newGame((scene) => { const rig = new PhaserRig(scene, assets); scene.add.existing(rig); rig.play('burn'); owned.push(rig); });
  try { const img = assets.pageImages.values().next().value!; return { separate: getPhaserPageTexture(native(a.game), img) !== getPhaserPageTexture(native(b.game), img), refs: [getPhaserPageRefCount(native(a.game), img), getPhaserPageRefCount(native(b.game), img)] }; }
  finally { for (const rig of owned) rig.destroy(); for (const { game } of [a,b]) { game.destroy(true,false); game.step(0,0); } assets.dispose(); }
}

export async function boundsProbe(rigName: string, mutant: 'none' | 'ignore-filter' | 'inflate' = 'none') {
  const assets = await assetsFor(rigName), { scene } = await gameFor();
  const animation = assets.animations[0].name;
  const rig = new PhaserRig(scene, assets, { autoUpdate: false }), player = bare(assets);
  scene.add.existing(rig);
  rig.setPosition(180, 420).setScale(0.75, 1.25).setRotation(0.2);
  try {
    rig.play(animation); player.play(animation);
    rig.seek(0); player.seek(0);
    const slotNames = Array.from(new Set(player.posedFrame().order.map((s) => s.slot)));
    const firstSlot = slotNames[0] ?? '';
    const lastSlot = slotNames[slotNames.length - 1] ?? '';
    const filters: Array<{ label: string; filter: SlotFilter | null }> = [
      { label: 'all', filter: null },
      { label: `only:[${firstSlot},${lastSlot}]`, filter: [firstSlot, lastSlot] },
      { label: `hide:[${firstSlot}]`, filter: (slot: string) => slot !== firstSlot },
      { label: 'only:[]', filter: [] },
    ];
    const times = [0, 0.35, 0.7, 1.1];
    const cases: Array<{ time: number; label: string; equal: boolean; rigBounds: PoseBounds | null; bareBounds: PoseBounds | null }> = [];
    for (const time of times) {
      for (const { label, filter } of filters) {
        rig.slots = mutant === 'ignore-filter' ? null : filter;
        player.slots = filter;
        rig.seek(time); player.seek(time);
        let rb = rig.bounds();
        if (mutant === 'inflate' && rb) rb = { ...rb, width: rb.width + 5 };
        const bb = player.bounds();
        cases.push({ time, label, equal: same(rb, bb), rigBounds: rb, bareBounds: bb });
      }
    }
    return { rigName, animation, totalCases: cases.length, allEqual: cases.every((c) => c.equal), cases };
  } finally { rig.destroy(); player.dispose(); }
}

export async function refusalAndFreezeProbe() {
  const assets = await assetsFor('walk'), { game, scene } = await gameFor(), renderer = native(game);
  const baselineListeners = scene.sys.events.listenerCount(Phaser.Scenes.Events.UPDATE);
  const baselinePages = getPhaserLivePageTextureCount(renderer);
  const checkThrow = (name: string, fn: () => unknown) => {
    let threw = false, message = '';
    try { fn(); } catch (error) { threw = true; message = String(error); }
    return { name, threw, message };
  };
  const live = new PhaserRig(scene, assets, { autoUpdate: false });
  live.play('walk');
  const refusals = [
    checkThrow('invalid-scene', () => new PhaserRig(null as unknown as Phaser.Scene, assets)),
    checkThrow('invalid-assets', () => new PhaserRig(scene, {} as unknown as ModelAssets)),
    checkThrow('invalid-initial-timescale', () => new PhaserRig(scene, assets, { timescale: -1 })),
    checkThrow('nan-initial-timescale', () => new PhaserRig(scene, assets, { timescale: Number.NaN })),
    checkThrow('empty-animation-name', () => live.play('')),
    checkThrow('unknown-animation', () => live.play('nonexistent_animation_xyz')),
    checkThrow('empty-bone-name', () => live.bone('')),
    checkThrow('unknown-bone', () => live.bone('nonexistent_bone_xyz')),
    checkThrow('negative-dt', () => live.advance(-0.016)),
    checkThrow('nan-dt', () => live.advance(Number.NaN)),
    checkThrow('negative-seek', () => live.seek(-1)),
    checkThrow('nan-seek', () => live.seek(Number.NaN)),
    checkThrow('negative-timescale-setter', () => { live.timescale = -0.5; }),
  ];
  live.destroy();
  for (const [name, fn] of [
    ['play-after-destroy', () => live.play('walk')],
    ['advance-after-destroy', () => live.advance(0.016)],
    ['seek-after-destroy', () => live.seek(0.2)],
    ['draw-after-destroy', () => live.draw()],
    ['drawnFrame-after-destroy', () => live.drawnFrame()],
    ['posedFrame-after-destroy', () => live.posedFrame()],
    ['bone-after-destroy', () => live.bone('root')],
    ['bounds-after-destroy', () => live.bounds()],
    ['timescale-after-destroy', () => { live.timescale = 1; }],
  ] as const) {
    refusals.push(checkThrow(name, fn));
  }
  const listenerLeak = scene.sys.events.listenerCount(Phaser.Scenes.Events.UPDATE) - baselineListeners;
  const pageLeak = getPhaserLivePageTextureCount(renderer) - baselinePages;
  const frozenAssets = Object.freeze({ ...assets, document: Object.freeze({ ...assets.document }) });
  const frozenRig = new PhaserRig(scene, frozenAssets, { autoUpdate: false });
  frozenRig.play('walk'); frozenRig.seek(0.25);
  const frozenOk = frozenRig.drawnFrame().order.length > 0 && frozenRig.bounds() !== null;
  frozenRig.destroy();
  return { refusals, listenerLeak, pageLeak, frozenOk };
}
