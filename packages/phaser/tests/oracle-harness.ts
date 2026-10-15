import { RigPlayer } from '@rig-c/play';
import Phaser from 'phaser';
import { OfficialOracle, MeshAttachment, RegionAttachment } from '../../../tests/oracle/bridge.ts';
import { assetsFor, gameFor, composite } from './harness.ts';
import { bounds } from './full-harness.ts';
import { PhaserRenderer } from '../src/index.ts';

let oracle: OfficialOracle | undefined;
export function disposeOfficialOracle(): void {
  if (!oracle) return;
  const release = oracle.context.gl.getExtension('WEBGL_lose_context');
  oracle.dispose(); release?.loseContext(); oracle = undefined;
}

/** Two independent readers advance through one explicit history, with original paired files. */
export async function officialPicture(rig: string, animation: string, time: number) {
  if (devicePixelRatio !== 1) throw new Error(`ORACLE_DPR: expected 1, found ${devicePixelRatio}`);
  const assets = await assetsFor(rig), player = new RigPlayer(document.createElement('div'), assets);
  player.play(animation, { loop: true });
  // Framing alone may read the player's frame; the official reader never does.
  const provisional = bounds(player.posedFrame());
  const canvas = oracle?.canvas ?? document.createElement('canvas');
  const official = oracle ??= new OfficialOracle(canvas, { width: provisional.width, height: provisional.height, originX: -provisional.left, originY: provisional.top, scale: 1, pixelRatio: 1 });
  const prefix = `/rigs/${rig}/`;
  const spine = await official.load({ jsonUrl: `${prefix}skeleton.json`, atlasUrl: `${prefix}skeleton.atlas` });
  const raw = await (await fetch(`${prefix}skeleton.model.json`)).json() as { spec?: string; spine?: { sha256?: string } };
  if (raw.spec !== 'rigc-compiled/3' || raw.spine?.sha256 !== spine.jsonSha256) throw new Error(`ORACLE_PAIR: ${rig} original model/Spine hash mismatch`);
  const instance = official.createInstance(spine, { animation, loop: true });
  const step = 1 / 60; let at = 0;
  for (let i = 0; i < Math.floor(time / step); i++) { player.advance(step); instance.advance(step); at += step; }
  if (time > at) { player.advance(time - at); instance.advance(time - at); }
  const frame = player.posedFrame(), box = bounds(frame);
  official.setViewport({ width: box.width, height: box.height, originX: -box.left, originY: box.top, scale: 1, pixelRatio: 1 });
  const expected = new Map<string, number[]>();
  for (const slot of instance.skeleton.drawOrder.appliedPose) {
    if (!slot.bone.active) continue;
    const pose = slot.appliedPose, attachment = pose.attachment;
    if (attachment instanceof RegionAttachment) {
      const vertices = new Array<number>(8); attachment.computeWorldVertices(slot, attachment.getOffsets(pose), vertices, 0, 2); expected.set(slot.data.name, vertices);
    } else if (attachment instanceof MeshAttachment) {
      const vertices = new Array<number>(attachment.worldVerticesLength); attachment.computeWorldVertices(instance.skeleton, slot, 0, attachment.worldVerticesLength, vertices, 0, 2); expected.set(slot.data.name, vertices);
    }
  }
  let maxGeometryDelta = 0;
  for (const slot of frame.order) {
    const vertices = slot.kind === 'mesh' ? slot.vertices : slot.corners, reference = expected.get(slot.slot);
    if (!reference || reference.length !== vertices.length) throw new Error(`ORACLE_SLOT: ${slot.slot} geometry length differs`);
    for (let i = 0; i < vertices.length; i++) maxGeometryDelta = Math.max(maxGeometryDelta, Math.abs(vertices[i] - reference[i]));
  }
  if (expected.size !== frame.order.length) throw new Error('ORACLE_SLOTS: independent draw slot count differs');
  const stats = official.draw([{ instance }]), referencePng = composite(official.canvas);
  const { game, scene } = await gameFor(); game.scale.resize(box.width, box.height);
  const root = scene.add.container(-box.left, box.top), renderer = new PhaserRenderer(root, assets);
  try {
    renderer.render(frame); game.step(0, 0);
    return { referencePng, phaserPng: composite(game.canvas), maxGeometryDelta, pairHash: spine.jsonSha256, generation: spine.generation, pages: spine.pages, stats, nativeGlError: (game.renderer as Phaser.Renderer.WebGL.WebGLRenderer).gl.getError() };
  } finally { renderer.dispose(); root.destroy(); player.dispose(); }
}
