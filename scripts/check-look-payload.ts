import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DepthPayload {
  bones: Array<{ name: string }>;
  animations: Array<{ name: string; attachments: Array<{ slots: Array<{ name: string; attachments: Array<{ deform?: Array<{ vertices?: number[] }> }> }> }> }>;
}
export interface ProducerReceipt {
  schema: string;
  producer: { parts: string; rigc: string; core: string };
  configSHA256: string;
  inputs: Array<{ id: string; sha256: string }>;
  outputs: Array<{ file: string; sha256: string }>;
}
const requiredFiles = ['skeleton.atlas', 'skeleton.json', 'skeleton.model.json', 'skeleton.png'];
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function need(ok: boolean, name: string, detail: string): void {
  if (!ok) throw new Error(`${name}: ${detail}`);
}
export function checkDepthPayload(model: DepthPayload): void {
  for (const name of ['faceshift', 'face_surface', 'bodyshift', 'body_rear_shift', 'topwear_surface']) {
    need(model.bones.some(b => b.name === name), 'LOOK_DEPTH_CARRIER', `missing bone "${name}"`);
  }
  for (const [animation, slot] of [['turn', 'face'], ['tilt', 'face'], ['body_turn', 'topwear']]) {
    const keys = model.animations.find(a => a.name === animation)?.attachments.flatMap(skin => skin.slots)
      .filter(s => s.name === slot).flatMap(s => s.attachments).flatMap(a => a.deform ?? []) ?? [];
    need(keys.some(k => k.vertices?.some(v => v !== 0) === true), 'LOOK_DEPTH_DEFORM', `missing nonzero ${animation}/${slot} deformation`);
  }
}
export function checkLookPayload(dir: string, receipt: ProducerReceipt): void {
  need(receipt.schema === 'look-producer/1', 'LOOK_PRODUCER_RECEIPT', 'expected look-producer/1');
  for (const key of ['parts', 'rigc', 'core'] as const) {
    need(/^\d+\.\d+\.\d+$/.test(receipt.producer[key]), 'LOOK_PRODUCER_RECEIPT', `invalid ${key} version`);
  }
  const hash = /^[0-9a-f]{64}$/;
  need(hash.test(receipt.configSHA256) && receipt.inputs.length > 0 && receipt.inputs.every(i => hash.test(i.sha256)), 'LOOK_PRODUCER_RECEIPT', 'missing config/input hashes');
  need(JSON.stringify(receipt.outputs.map(o => o.file).sort()) === JSON.stringify(requiredFiles), 'LOOK_PRODUCER_RECEIPT', 'expected exactly the four producer files');
  for (const output of receipt.outputs) {
    need(hash.test(output.sha256) && digest(readFileSync(join(dir, output.file))) === output.sha256, 'LOOK_PRODUCER_BYTES', `hash mismatch for ${output.file}`);
  }
  checkDepthPayload(JSON.parse(readFileSync(join(dir, 'skeleton.model.json'), 'utf8')) as DepthPayload);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2] ?? 'examples/look/rig');
  checkLookPayload(dir, JSON.parse(readFileSync(join(dir, 'producer.json'), 'utf8')) as ProducerReceipt);
  console.log('LOOK_PRODUCER_BYTES PASS: four files match receipt; depth carriers and face/body deformation present');
}
