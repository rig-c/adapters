import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkDepthPayload, checkLookPayload, type DepthPayload, type ProducerReceipt } from '../../../scripts/check-look-payload.ts';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('../rig/', import.meta.url));
const model = (): DepthPayload => JSON.parse(readFileSync(`${dir}/skeleton.model.json`, 'utf8')) as DepthPayload;
test('LOOK45 depth carrier and deform contract', () => checkDepthPayload(model()));
test('LOOK45 shipped bytes match producer receipt', () => checkLookPayload(dir, JSON.parse(readFileSync(`${dir}/producer.json`, 'utf8')) as ProducerReceipt));
test('LOOK45 mutants: missing carriers, missing deform and changed output digest refuse by name', () => {
  const noCarrier = model(); noCarrier.bones = noCarrier.bones.filter(b => b.name !== 'faceshift');
  assert.throws(() => checkDepthPayload(noCarrier), /LOOK_DEPTH_CARRIER.*faceshift/);
  const noDeform = model(); noDeform.animations.find(a => a.name === 'turn')!.attachments = [];
  assert.throws(() => checkDepthPayload(noDeform), /LOOK_DEPTH_DEFORM.*turn\/face/);
  const receipt = JSON.parse(readFileSync(`${dir}/producer.json`, 'utf8')) as ProducerReceipt;
  receipt.outputs[0].sha256 = '0'.repeat(64);
  assert.throws(() => checkLookPayload(dir, receipt), /LOOK_PRODUCER_BYTES/);
});
