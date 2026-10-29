import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readModel } from 'rig-c/core';
import type { AdjustableBones, BoneLocals } from '@rig-c/play';
import {
  PointerDials, PointerDialRefusal, readPointerDialBindings, normalizedToDial,
  pointerToNormalized, stepCriticallyDampedSpring2D, HEAD_SPRING_OMEGA0,
} from '../pointer-dials.ts';

import { readLookDials } from '../look.ts';

const text = readFileSync(new URL('../rig/skeleton.model.json', import.meta.url), 'utf8');
const names = { yaw: 'yaw_dial', pitch: 'pitch_dial', roll: 'roll_dial', body: 'body_dial', gazeX: 'gaze_x_dial', gazeY: 'gaze_y_dial' } as const;
const doc = () => readModel(text, 'public look fixture');
const close = (a: number, b: number, tolerance = 1e-12) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);

function assertNamedRefusal(run: () => unknown, axis: string, bone: string): void {
  assert.throws(run, (error: unknown) => error instanceof PointerDialRefusal && error.name === 'PointerDialRefusal' && error.axis === axis && error.bone === bone && error.message.includes(bone));
}

test('PD01 normalization: offset CSS rectangle, Y-up, clamped edges and absent area', () => {
  const rect = { left: 120, top: 40, width: 960, height: 540 };
  assert.deepEqual(pointerToNormalized(600, 310, rect), { fx: 0, fy: 0 });
  assert.deepEqual(pointerToNormalized(1080, 40, rect), { fx: 1, fy: 1 });
  assert.deepEqual(pointerToNormalized(-100, 1000, rect), { fx: -1, fy: -1 });
  assert.deepEqual(pointerToNormalized(NaN, Infinity, rect), { fx: 0, fy: 0 });
  assert.deepEqual(pointerToNormalized(1, 1, { ...rect, width: 0 }), { fx: 0, fy: 0 });
});

test('PD02 real compiled reader: six declared bands, caller-provided bone names', () => {
  const bindings = readPointerDialBindings(doc(), names);
  assert.deepEqual(Object.values(bindings).map(x => x.range), [[-15, 15], [-12, 12], [-8, 8], [-15, 15], [-1, 1], [-1, 1]]);
  assert.equal(bindings.yaw?.channel, 'rotation');
  const renamed = text.replaceAll('"yaw_dial"', '"horizontal_control"');
  assert.deepEqual(readPointerDialBindings(readModel(renamed), { yaw: 'horizontal_control', pitch: names.pitch }).yaw?.range, [-15, 15]);
});

test('PD03 asymmetric ranges: inverse compiled time, negative scale, both endpoints and neutral', () => {
  const raw = JSON.parse(text) as { constraints: Array<{ kind: string; name: string; from: number; to: number; scale: number }> };
  const yaw = raw.constraints.find(c => c.kind === 'slider' && c.name === 'yaw')!;
  // t = .25 + (value + 3) * .0625 -> [-7, 23].
  yaw.from = -3; yaw.to = 0.25;
  const pitch = raw.constraints.find(c => c.kind === 'slider' && c.name === 'pitch')!;
  pitch.from = 11; pitch.to = 0; pitch.scale = -0.125; // [-1, 11]
  const model = readModel(JSON.stringify(raw), 'asymmetric public look control');
  const bindings = readPointerDialBindings(model, names);
  assert.deepEqual(bindings.yaw?.range, [-7, 23]);
  assert.deepEqual(bindings.pitch?.range, [-1, 11]);
  for (const [n, expected] of [[-10, -7], [-1, -7], [-0.5, -3.5], [0, 0], [0.5, 11.5], [1, 23], [10, 23]]) close(normalizedToDial(n, bindings.yaw!.range), expected);
  assert.equal(normalizedToDial(0, [2, 9]), 2);
  const follow = new PointerDials(bindings, { yaw: -1, pitch: 1 });
  follow.setPointer(3, -4);
  const snap = follow.step(2);
  assert.equal(snap.fx, 1); assert.equal(snap.fy, -1);
  close(snap.values.yaw!, -7); close(snap.values.pitch!, -1);
});

test('PD04 named refusal: absent slider, missing bone, ambiguous binding, optional axes omitted', () => {
  const missing = doc();
  missing.constraints = missing.constraints.filter(c => c.kind !== 'slider');
  assertNamedRefusal(() => readPointerDialBindings(missing, names), 'yaw', names.yaw);
  assertNamedRefusal(() => readPointerDialBindings(doc(), { ...names, pitch: 'missing_control' }), 'pitch', 'missing_control');
  const ambiguous = doc(); ambiguous.constraints.push(ambiguous.constraints.find(c => c.name === 'yaw')!);
  assertNamedRefusal(() => readPointerDialBindings(ambiguous, names), 'yaw', names.yaw);
  assert.deepEqual(Object.keys(readPointerDialBindings(doc(), { yaw: names.yaw, pitch: names.pitch })), ['yaw', 'pitch']);
});

test('PD05 named refusal: zero/nonfinite scale, degenerate duration, loop and world source', () => {
  for (const fault of ['zero', 'infinity', 'duration', 'loop', 'world'] as const) {
    const model = doc(); const slider = model.constraints.find(c => c.name === 'yaw')!.record;
    if (slider?.kind !== 'slider') throw new Error('fixture slider missing');
    if (fault === 'zero') slider.scale = 0;
    if (fault === 'infinity') slider.scale = Infinity;
    if (fault === 'duration') slider.timelines = { ...slider.timelines, duration: 0 };
    if (fault === 'loop') slider.loop = true;
    if (fault === 'world') slider.local = false;
    assertNamedRefusal(() => readPointerDialBindings(model, names), 'yaw', names.yaw);
  }
});

test('PD06 exact spring: omega 20, frozen 2% at 0.30s and not yet at 0.15s', () => {
  assert.equal(HEAD_SPRING_OMEGA0, 20);
  const state = { x: 0, y: 0, vx: 0, vy: 0 };
  stepCriticallyDampedSpring2D(state, 1, -1, 0.15);
  assert.ok(1 - state.x > 0.02);
  stepCriticallyDampedSpring2D(state, 1, -1, 0.15);
  const error = 1 - state.x;
  close(error, 7 * Math.exp(-6));
  assert.ok(error <= 0.02);
  close(state.y, -state.x);
  console.log(`[pointer-dials:settling] omega=${HEAD_SPRING_OMEGA0} t=0.30 error=${error} limit=0.02`);
});

test('PD07 exact spring: partition invariance, nonzero velocity and invalid dt', () => {
  const state = { x: -0.8, y: 0.4, vx: 1.7, vy: -0.2 };
  const partitioned = { ...state };
  stepCriticallyDampedSpring2D(state, 0.9, -0.7, 0.3);
  for (let i = 0; i < 18; i++) stepCriticallyDampedSpring2D(partitioned, 0.9, -0.7, 1 / 60);
  for (const key of ['x', 'y', 'vx', 'vy'] as const) close(state[key], partitioned[key]);
  const before = { ...state };
  for (const dt of [0, -1, NaN, Infinity]) stepCriticallyDampedSpring2D(state, 1, 1, dt);
  assert.deepEqual(state, before);
});

test('PD08 apply: correct declared channels, immediate eyes, spring head, roll and clear', () => {
  const model = doc();
  const pitch = model.constraints.find(c => c.name === 'pitch')!.record;
  if (pitch?.kind !== 'slider') throw new Error('fixture slider missing');
  pitch.property = 'x';
  const bindings = readPointerDialBindings(model, names);
  const follow = new PointerDials(bindings);
  const locals = new Map<string, BoneLocals>(Object.values(names).map(name => [name, { rotation: 0, x: 0, y: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 }]));
  const bones: AdjustableBones = { names: Object.values(names), bone: name => { const b = locals.get(name); if (!b) throw new Error(`unknown bone ${name}`); return b; } };
  follow.setPointer(4, -4);
  const first = follow.step(1 / 60); follow.adjust(bones);
  assert.equal(first.values.gazeX, 1); assert.equal(first.values.gazeY, -1);
  assert.ok(first.values.yaw! > 0 && first.values.yaw! < 15 * 0.5);
  follow.step(2); follow.adjust(bones);
  close(locals.get(names.yaw)!.rotation, 15);
  close(locals.get(names.pitch)!.x, -12);
  assert.equal(locals.get(names.pitch)!.rotation, 0);
  close(locals.get(names.roll)!.rotation, 8);
  close(locals.get(names.body)!.rotation, 15);
  follow.clearPointer(); const cleared = follow.step(1 / 60);
  assert.equal(cleared.values.gazeX, 0); assert.equal(cleared.values.gazeY, 0);
  assert.ok(cleared.values.yaw! > 0);
  const neutral = follow.step(2);
  close(neutral.values.yaw!, 0);
});


test('LOOK45 page maps the producer body dial to its original six-degree excursion', () => {
  const result = readLookDials(doc());
  assert.ok(result.ok);
  assert.deepEqual(result.dials.modelThresholds.body, [-15, 15]);
  assert.deepEqual(result.dials.pageClamp.body, [-6, 6]);
  assert.equal(result.dials.B, 6);
  const follow = new PointerDials(result.dials.bindings);
  follow.setPointer(1, 0);
  close(follow.step(2).values.body!, 6);
  follow.setPointer(-1, 0);
  close(follow.step(2).values.body!, -6);
  // A bypass that sends the full producer range must fail the page ceiling.
  const bypass = new PointerDials(readPointerDialBindings(doc(), names));
  bypass.setPointer(1, 0);
  assert.ok(bypass.step(2).values.body! > result.dials.B);
});


test('LOOK45 direction comes from posed world motion when the local nose track is stationary', () => {
  const result = readLookDials(doc());
  assert.ok(result.ok);
  assert.equal(result.dials.yawSign, -1);
  assert.equal(result.dials.pitchSign, -1);
});
