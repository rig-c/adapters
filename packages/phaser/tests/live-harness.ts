import Phaser from 'phaser';
import { RigPlayer, loadModel, type PosedFrame, type LiveFrame, type LiveNumbers, type ModelAssets, type SlotFilter, type PoseBounds } from '@rig-c/play';
import { RetainedRuntimeFrame } from '@rig-c/adapters-shared';
import { PhaserRenderer, PhaserRig, getPhaserLivePageTextureCount, getPhaserPageRefCount, getPhaserPageTexture } from '../src/index.ts';
import { assetsFor, gameFor, composite } from './harness.ts';
import { bounds, slotViews } from './full-harness.ts';
import { makePremultipliedTwinImage } from './png.ts';

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
  const verifier = new RetainedRuntimeFrame('PhaserRig');
  let ingress: PosedFrame | null = null;
  const render = rig.renderer.render.bind(rig.renderer);
  rig.renderer.render = (frame) => {
    let submitted: PosedFrame | LiveFrame = frame;
    if (mutant) {
      if ('order' in frame) {
        submitted = { order: frame.order.slice(1) };
      } else {
        const count = Math.max(0, frame.count - 1);
        const drawOrder = new Int32Array(count);
        for (let i = 0; i < count; i++) drawOrder[i] = frame.drawOrder[i + 1];
        submitted = { ...frame, count, drawOrder };
      }
    }
    render(submitted);
    if ('order' in submitted) {
      ingress = submitted;
    } else {
      verifier.capture(submitted, () => ({ order: rig.player.posedFrame().order.slice(mutant ? 1 : 0) }));
      ingress = verifier.snapshot();
    }
  };
  try {
    const initial = same(rig.drawnFrame(), player.posedFrame());
    rig.play(animation); player.play(animation); rig.seek(time); player.seek(time);
    if (!mutant && same(ingress, rig.drawnFrame())) ingress = rig.drawnFrame();
    const seekEqual = same(ingress, player.posedFrame()) && ingress === rig.drawnFrame();
    rig.advance(1 / 60); player.advance(1 / 60);
    if (!mutant && same(ingress, rig.drawnFrame())) ingress = rig.drawnFrame();
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

export async function oracleRetentionProbe(rigName: string) {
  const assets = await assetsFor(rigName), { scene } = await gameFor();
  const rig = new PhaserRig(scene, assets, { autoUpdate: false, poser: 'oracle', liveFrameChecks: true });
  try {
    rig.play(rigName === 'figure' ? 'mask' : assets.animations[0].name);
    rig.advance(0.125);
    const drawn = rig.drawnFrame(), saved = JSON.stringify(drawn);
    const equalCurrent = saved === JSON.stringify(rig.player.posedFrame());
    const live = rig.player.liveFrame(), vertices = live.vertices, before = [...rig.list];
    rig.player.seek(0.7);
    const retainedLastDraw = rig.drawnFrame() === drawn && JSON.stringify(rig.drawnFrame()) === saved;
    let staleRefused = false, nestedStale = false;
    try { rig.renderer.render(live); } catch (error) { staleRefused = String(error).includes('LIVE_FRAME_STALE'); }
    try { void vertices[0]; } catch (error) { nestedStale = String(error).includes('LIVE_FRAME_STALE'); }
    const unchangedScene = before.length === rig.list.length && before.every((view, i) => view === rig.list[i]);
    rig.advance(1 / 60);
    return {
      poser: rig.player.poser, equalCurrent, retainedLastDraw, staleRefused, nestedStale, unchangedScene,
      retainedAfterNextDraw: JSON.stringify(drawn) === saved,
      nextEqualCurrent: JSON.stringify(rig.drawnFrame()) === JSON.stringify(rig.player.posedFrame()),
    };
  } finally { rig.destroy(); }
}

export async function liveLeaseProbe(options: { rigName: string; checked: boolean; mutant?: 'snapshot' | 'buffers' | 'last-drawn' | 'fresh-lease' | 'metadata-cache' }) {
  const assets = await loadModel({ modelUrl: `/bench/${options.rigName}/skeleton.model.json`, regions: 'none', setsUrl: null });
  const { game, scene } = await gameFor();
  const rig = new PhaserRig(scene, assets, { autoUpdate: false, liveFrameChecks: options.checked });
  scene.add.existing(rig);
  try {
    rig.play('walk', { loop: true });
    const duration = assets.animations.find((a) => a.name === 'walk')!.duration;
    for (let i = 0; i <= Math.ceil(duration * 60); i++) rig.advance(1 / 60);
    game.step(0, 0);
    const poser = rig.player.poser;
    const views = slotViews(rig);
    const buffers = views.map((view) => [view.slotBuffers!.position, view.slotBuffers!.uv, view.slotBuffers!.index]);
    const snapshot = rig.player.posedFrame.bind(rig.player);
    let snapshotCalls = 0;
    rig.player.posedFrame = () => { snapshotCalls++; throw new Error('HOT_LOOP_SNAPSHOT'); };
    let hotError: string | null = null;
    try {
      rig.play('walk', { loop: true });
      for (let i = 0; i < 20; i++) {
        rig.advance(1 / 60);
        rig.seek((i + 1) / 60);
        if (options.mutant === 'snapshot') rig.player.posedFrame();
      }
      if (options.mutant === 'buffers' && views[0]?.slotBuffers) {
        views[0].slotBuffers.position = { ...views[0].slotBuffers.position } as NonNullable<typeof views[0]['slotBuffers']>['position'];
      }
    } catch (error) { hotError = error instanceof Error ? error.message : String(error); }
    finally { rig.player.posedFrame = snapshot; }
    const stableBuffers = views.every((view, i) => buffers[i][0] === view.slotBuffers?.position && buffers[i][1] === view.slotBuffers?.uv && buffers[i][2] === view.slotBuffers?.index);
    if (options.mutant === 'buffers' && views[0]?.slotBuffers) views[0].slotBuffers.position = buffers[0][0];
    game.step(0, 0);
    let staticIndexReads = 0;
    const watched = (source: LiveNumbers): LiveNumbers => new Proxy(source, {
      get(target, property) {
        if (typeof property === 'string' && /^\d+$/.test(property)) staticIndexReads++;
        return Reflect.get(target, property, target);
      },
    });
    const raw = rig.player.liveFrame();
    const tracked: LiveFrame = {
      generation: raw.generation, count: raw.count, drawOrder: raw.drawOrder, vertices: raw.vertices, tint: raw.tint,
      attachments: raw.attachments.map((a) => ({ ...a, uvs: watched(a.uvs), triangles: watched(a.triangles) })),
    };
    rig.renderer.render(tracked); game.step(0, 0);
    const firstStaticIndexReads = staticIndexReads;
    staticIndexReads = 0;
    rig.renderer.alwaysReuploadGeometry = options.mutant === 'metadata-cache';
    rig.renderer.render(tracked); game.step(0, 0);
    rig.renderer.alwaysReuploadGeometry = false;
    const repeatedStaticIndexReads = staticIndexReads;
    const current = snapshot(), drawn = rig.drawnFrame();
    const equalCurrent = JSON.stringify(drawn) === JSON.stringify(current);
    const saved = JSON.stringify(drawn);
    if (options.mutant === 'last-drawn') rig.drawnFrame = () => rig.player.posedFrame();
    rig.player.advance(0.137);
    const lastDrawSurvivesDirectMutation = JSON.stringify(rig.drawnFrame()) === saved;
    rig.advance(1 / 60);
    const retainedSurvivesNextDraw = JSON.stringify(drawn) === saved;
    const explicit = rig.draw();
    const explicitSnapshotIdentity = rig.drawnFrame() === explicit;
    const lease = rig.player.liveFrame();
    const vertices = lease.vertices, tint = lease.tint, metadata = lease.attachments[lease.drawOrder[0]], uvs = metadata.uvs;
    let readonlyRefused = false;
    if (options.checked) {
      try { void (vertices as unknown as { buffer: unknown }).buffer; }
      catch (error) { readonlyRefused = String(error).includes('LIVE_FRAME_READONLY'); }
    }
    rig.player.advance(1 / 60);
    const sceneState = (): string => JSON.stringify(slotViews(rig).map((view) => ({
      name: view.name, tint: view.tint, alpha: view.alpha, vertices: view.vertices,
    })));
    const before = sceneState();
    let staleRefused = false;
    try { rig.renderer.render(options.mutant === 'fresh-lease' ? rig.player.liveFrame() : lease); }
    catch (error) { staleRefused = String(error).includes('LIVE_FRAME_STALE'); }
    const sceneUnchanged = before === sceneState();
    const stale = (read: () => unknown): boolean => {
      try { read(); return false; } catch (error) { return String(error).includes('LIVE_FRAME_STALE'); }
    };
    const nestedStale = options.checked ? [() => vertices[0], () => tint[0], () => uvs[0], () => metadata.page].every(stale) : null;
    let colorInvalidates = false;
    if (options.checked) {
      const colorLease = rig.player.liveFrame();
      rig.player.color[0] *= 0.5;
      rig.player.liveFrame();
      colorInvalidates = stale(() => colorLease.tint[0]);
    }
    return {
      poser, meshCount: views.length, snapshotCalls, hotError, stableBuffers, equalCurrent,
      firstStaticIndexReads, repeatedStaticIndexReads,
      lastDrawSurvivesDirectMutation, retainedSurvivesNextDraw, explicitSnapshotIdentity,
      readonlyRefused, staleRefused, sceneUnchanged, nestedStale, colorInvalidates,
    };
  } finally { rig.destroy(); assets.dispose(); }
}

export async function livePictureProbe(options: {
  rigName: string; animation?: string; time: number; pma?: boolean; poser?: 'auto' | 'oracle';
  mutant?: 'vertices' | 'clip' | 'dark' | 'pma' | 'order';
}) {
  const publicBench = options.rigName === 'spineboy' || options.rigName === 'raptor';
  const baseAssets = publicBench
    ? await loadModel({ modelUrl: `/bench/${options.rigName}/skeleton.model.json`, regions: 'none', setsUrl: null })
    : await assetsFor(options.rigName);
  const urls: string[] = [];
  let assets = baseAssets;
  if (options.pma) {
    const pages = new Map<string, HTMLImageElement>();
    for (const [name, page] of baseAssets.pageImages) {
      const twin = await makePremultipliedTwinImage(page);
      pages.set(name, twin.image); urls.push(twin.url);
    }
    assets = { ...baseAssets, pageImages: pages };
  }
  const player = new RigPlayer(document.createElement('div'), baseAssets, { mode: 'canvas', poser: options.poser ?? 'oracle', liveFrameChecks: true });
  const animation = options.animation ?? baseAssets.animations[0].name;
  player.play(animation, { loop: true }); player.seek(options.time);
  const original = player.posedFrame();
  const snapshot: PosedFrame = options.pma ? { order: original.order.map((slot) => ({ ...slot, pma: true })) } : original;
  const borrowed = player.liveFrame();
  let live: LiveFrame = borrowed;
  if (options.pma || options.mutant) {
    const vertices = new Float64Array(borrowed.vertices.length);
    for (let i = 0; i < vertices.length; i++) vertices[i] = borrowed.vertices[i] + (options.mutant === 'vertices' && i % 2 === 0 ? 20 : 0);
    const drawOrder = new Int32Array(borrowed.count);
    for (let i = 0; i < drawOrder.length; i++) drawOrder[i] = borrowed.drawOrder[options.mutant === 'order' ? drawOrder.length - 1 - i : i];
    const attachments = borrowed.attachments.map((a) => ({
      ...a,
      pma: options.mutant === 'pma' ? false : options.pma ? true : a.pma,
      clip: options.mutant === 'clip' ? null : a.clip,
      dark: options.mutant === 'dark' ? null : a.dark,
    }));
    live = { generation: borrowed.generation, count: borrowed.count, vertices, drawOrder, tint: borrowed.tint, attachments };
  }
  const box = bounds(snapshot), { game, scene } = await gameFor();
  game.scale.resize(box.width, box.height);
  const gl = (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl;
  const readPixels = (): Uint8Array => {
    const out = new Uint8Array(box.width * box.height * 4);
    gl.finish(); gl.readPixels(0, 0, box.width, box.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  };
  const root = scene.add.container(-box.left, box.top);
  const old = new PhaserRenderer(root, assets), renderer = new PhaserRenderer(root, assets);
  try {
    old.render(snapshot); game.step(0, 0); const expected = readPixels();
    old.dispose();
    renderer.render(live); game.step(0, 0); const actual = readPixels();
    let byteDifferences = 0, contentPixels = 0;
    for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) byteDifferences++;
    for (let i = 3; i < expected.length; i += 4) if (expected[i] !== 0) contentPixels++;
    return {
      byteDifferences, contentPixels, poser: player.poser, order: snapshot.order.length,
      clips: snapshot.order.filter((slot) => slot.clip).length, darks: snapshot.order.filter((slot) => slot.dark).length,
      blends: Array.from(new Set(snapshot.order.map((slot) => slot.blend))), pma: options.pma ?? false,
    };
  } finally {
    old.dispose(); renderer.dispose(); root.destroy(); player.dispose();
    if (publicBench) baseAssets.dispose();
    for (const url of urls) URL.revokeObjectURL(url);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * 0.5;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return Number((next !== undefined ? sorted[base] + rest * (next - sorted[base]) : sorted[base]).toFixed(3));
}

export async function poseColumnProbe(options: { rigName: 'spineboy' | 'raptor'; instances?: number; warmupFrames?: number; measuredFrames?: number }) {
  const instances = options.instances ?? 100, warmupFrames = options.warmupFrames ?? 30, measuredFrames = options.measuredFrames ?? 120;
  const assets = await loadModel({ modelUrl: `/bench/${options.rigName}/skeleton.model.json`, regions: 'none', setsUrl: null });
  const { game, scene } = await gameFor();
  game.scale.resize(900, 640);
  const gl = (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl;
  const duration = assets.animations.find((a) => a.name === 'walk')!.duration;
  const rigs: PhaserRig[] = [];
  const posedFrames = new Array<PosedFrame>(instances);
  const liveFrames = new Array<LiveFrame>(instances);
  for (let i = 0; i < instances; i++) {
    const rig = new PhaserRig(scene, assets, { autoUpdate: false, liveFrameChecks: false });
    scene.add.existing(rig);
    rigs.push(rig);
  }
  const resetPhase = () => {
    for (let i = 0; i < instances; i++) {
      rigs[i].player.play('walk', { loop: true });
      const phase = ((i % instances) / instances) * duration;
      if (phase > 0) rigs[i].player.advance(phase);
    }
  };
  const runArm = (mode: 'snapshot' | 'live') => {
    resetPhase();
    const dt = 1 / 60;
    const poseStep = () => {
      for (let i = 0; i < instances; i++) {
        rigs[i].player.advance(dt);
        if (mode === 'snapshot') posedFrames[i] = rigs[i].player.posedFrame();
        else liveFrames[i] = rigs[i].player.liveFrame();
      }
    };
    const drawStep = () => {
      for (let i = 0; i < instances; i++) {
        if (mode === 'snapshot') rigs[i].renderer.render(posedFrames[i]);
        else rigs[i].renderFrame(liveFrames[i]);
      }
      game.step(0, 0);
    };
    for (let f = 0; f < warmupFrames; f++) { poseStep(); drawStep(); }
    gl.finish();
    const poseTimes = new Array<number>(measuredFrames), drawTimes = new Array<number>(measuredFrames), frameTimes = new Array<number>(measuredFrames);
    for (let f = 0; f < measuredFrames; f++) {
      const t0 = performance.now();
      poseStep();
      const t1 = performance.now();
      drawStep(); gl.finish();
      const t2 = performance.now();
      poseTimes[f] = t1 - t0; drawTimes[f] = t2 - t1; frameTimes[f] = t2 - t0;
    }
    return { poseP50Ms: median(poseTimes), drawP50Ms: median(drawTimes), p50Ms: median(frameTimes) };
  };
  try {
    const before = runArm('snapshot');
    const after = runArm('live');
    return { rigName: options.rigName, instances, warmupFrames, measuredFrames, before, after };
  } finally {
    for (const rig of rigs) rig.destroy();
    assets.dispose();
  }
}
