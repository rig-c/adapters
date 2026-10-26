import type { CompiledDocument } from 'rig-c/core';
import type { AdjustableBones, BoneLocals } from '@rig-c/play';

export interface Spring2DState { x: number; y: number; vx: number; vy: number }
export type DialAxis = 'yaw' | 'pitch' | 'roll' | 'body' | 'gazeX' | 'gazeY';
export type DialBoneNames = Readonly<Record<'yaw' | 'pitch', string> & Partial<Record<Exclude<DialAxis, 'yaw' | 'pitch'>, string>>>;
export interface SliderDial {
  readonly bone: string;
  readonly slider: string;
  readonly channel: keyof BoneLocals;
  readonly range: readonly [number, number];
}
export type PointerDialBindings = Readonly<Partial<Record<DialAxis, SliderDial>>>;

export class PointerDialRefusal extends Error {
  constructor(readonly axis: DialAxis, readonly bone: string, detail: string) {
    super(`PointerDials: axis "${axis}", bone "${bone}": ${detail}`);
    this.name = 'PointerDialRefusal';
  }
}

/** Read a core-parsed document, never the opaque ModelAssets.document wrapper. */
export function readPointerDialBindings(doc: CompiledDocument, names: DialBoneNames): PointerDialBindings {
  const bindings: Partial<Record<DialAxis, SliderDial>> = {};
  const used = new Set<string>();
  for (const axis of ['yaw', 'pitch', 'roll', 'body', 'gazeX', 'gazeY'] as const) {
    const bone = names[axis];
    if (bone === undefined && axis !== 'yaw' && axis !== 'pitch') continue;
    const refuse = (detail: string): never => { throw new PointerDialRefusal(axis, bone ?? '', detail); };
    if (!bone || !doc.bones.some(b => b.name === bone)) return refuse('expected a declared dial bone');
    const matches = doc.constraints.filter(c => c.kind === 'slider' && c.record?.kind === 'slider' && c.record.bone === bone);
    if (matches.length !== 1) refuse(`found ${matches.length} slider constraints; expected exactly one`);
    const record = matches[0].record;
    if (record?.kind !== 'slider') return refuse('expected a parsed slider record');
    // Only local non-looping dial sources can be written through BoneAdjust.
    if (!record.local || record.loop) refuse('expected a local, non-looping slider');
    const { from, to, scale } = record;
    const duration = record.timelines.duration;
    if (![from, to, scale, duration].every(Number.isFinite) || scale === 0 || duration <= 0) {
      refuse('expected finite from/to, nonzero scale and positive animation duration');
    }
    const a = from - to / scale;
    const b = from + (duration - to) / scale;
    if (![a, b].every(Number.isFinite) || a === b) refuse('slider does not define a finite, nonzero dial range');
    const range: readonly [number, number] = a < b ? [a, b] : [b, a];
    const channel: keyof BoneLocals = record.property === 'rotate' ? 'rotation' : record.property;
    const key = `${bone}/${channel}`;
    if (used.has(key)) refuse('dial channel is already bound to another axis');
    used.add(key);
    bindings[axis] = Object.freeze({ bone, slider: matches[0].name, channel, range: Object.freeze(range) });
  }
  return Object.freeze(bindings);
}

/**
 * Natural frequency (rad/s) for a critically-damped 2D spring that settles within
 * 2 % of a step target in `0.30 s`: `(1 + 20 * 0.30) * exp(-20 * 0.30) = 0.01735 < 0.02`.
 */
export const HEAD_SPRING_OMEGA0 = 20;

export function clampRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(min, Math.min(max, value));
  return clamped === 0 ? 0 : clamped;
}

function clampUnit(value: number): number {
  return clampRange(value, -1, 1);
}

/**
 * Maps client pointer coordinates `(clientX, clientY)` relative to `rect` into
 * normalized `(fx, fy)` in `[-1, 1]` from canvas centre (`+fx` right, `+fy` up).
 */
export function pointerToNormalized(
  clientX: number,
  clientY: number,
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
): { fx: number; fy: number } {
  if (!(rect.width > 0) || !(rect.height > 0)) {
    return { fx: 0, fy: 0 };
  }
  const cx = rect.left + rect.width * 0.5;
  const cy = rect.top + rect.height * 0.5;
  const fx = clampUnit((clientX - cx) / (rect.width * 0.5));
  const fy = clampUnit((cy - clientY) / (rect.height * 0.5));
  return {
    fx: fx === 0 ? 0 : fx,
    fy: fy === 0 ? 0 : fy,
  };
}

/**
 * Exact analytical step of a 2D critically-damped spring:
 *   `x'' + 2 * omega0 * x' + omega0^2 * (x - target) = 0`
 */
export function stepCriticallyDampedSpring2D(
  state: Spring2DState,
  targetX: number,
  targetY: number,
  dt: number,
  omega0 = HEAD_SPRING_OMEGA0,
): void {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  const ex = state.x - targetX;
  const ey = state.y - targetY;
  if (ex === 0 && ey === 0 && state.vx === 0 && state.vy === 0) {
    state.x = targetX;
    state.y = targetY;
    return;
  }
  const tau = omega0 * dt;
  const exp = Math.exp(-tau);
  const nextX = targetX + (ex * (1 + tau) + state.vx * dt) * exp;
  const nextY = targetY + (ey * (1 + tau) + state.vy * dt) * exp;
  const nextVx = (state.vx * (1 - tau) - omega0 * omega0 * dt * ex) * exp;
  const nextVy = (state.vy * (1 - tau) - omega0 * omega0 * dt * ey) * exp;

  state.x = Math.abs(nextX - targetX) < 1e-12 && Math.abs(nextVx) < 1e-9 ? targetX : nextX;
  state.y = Math.abs(nextY - targetY) < 1e-12 && Math.abs(nextVy) < 1e-9 ? targetY : nextY;
  state.vx = state.x === targetX ? 0 : nextVx;
  state.vy = state.y === targetY ? 0 : nextVy;
}


/** Zero is the neutral where admitted; asymmetric sides keep their own extent. */
export function normalizedToDial(normalized: number, range: readonly [number, number]): number {
  const n = clampUnit(normalized);
  const neutral = clampRange(0, range[0], range[1]);
  return clampRange(neutral + Math.abs(n) * ((n < 0 ? range[0] : range[1]) - neutral), range[0], range[1]);
}

export interface PointerDialSnapshot {
  readonly fx: number;
  readonly fy: number;
  readonly hx: number;
  readonly hy: number;
  readonly values: Readonly<Partial<Record<DialAxis, number>>>;
}

/** Host-independent example helper. Call step before the host's advance(dt). */
export class PointerDials {
  private fx = 0;
  private fy = 0;
  private readonly spring: Spring2DState = { x: 0, y: 0, vx: 0, vy: 0 };
  private values: Partial<Record<DialAxis, number>> = {};

  constructor(
    readonly bindings: PointerDialBindings,
    readonly direction: { readonly yaw: 1 | -1; readonly pitch: 1 | -1 } = { yaw: 1, pitch: 1 },
  ) { this.step(0); }

  setPointer(fx: number, fy: number): void { this.fx = clampUnit(fx); this.fy = clampUnit(fy); }
  clearPointer(): void { this.setPointer(0, 0); }

  step(dt: number): PointerDialSnapshot {
    stepCriticallyDampedSpring2D(this.spring, this.fx, this.fy, dt);
    const hx = clampUnit(this.spring.x);
    const hy = clampUnit(this.spring.y);
    const normalized: Record<DialAxis, number> = {
      yaw: hx * this.direction.yaw, pitch: hy * this.direction.pitch,
      roll: -hx * hy, body: hx, gazeX: this.fx, gazeY: this.fy,
    };
    const values: Partial<Record<DialAxis, number>> = {};
    for (const axis of Object.keys(this.bindings) as DialAxis[]) {
      const dial = this.bindings[axis]!;
      values[axis] = normalizedToDial(normalized[axis], dial.range);
    }
    this.values = values;
    return { fx: this.fx, fy: this.fy, hx, hy, values: { ...values } };
  }

  /** The same callback works on PixiRig.player, PhaserRig.player and ThreeRig.player. */
  readonly adjust = (bones: AdjustableBones): void => {
    for (const axis of Object.keys(this.bindings) as DialAxis[]) {
      const dial = this.bindings[axis]!;
      bones.bone(dial.bone)[dial.channel] = clampRange(this.values[axis]!, dial.range[0], dial.range[1]);
    }
  };
}
