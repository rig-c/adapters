import type { CompiledDocument } from 'rig-c/core';
import type { AdjustableBones, ModelAssets } from '@rig-c/play';
import type { PixiRig } from '@rig-c/pixi';

export interface LookDials {
  /** Declared head yaw amplitude in degrees (`head yaw = fx * Y`). */
  readonly Y: number;
  /** Declared head pitch amplitude in degrees (`head pitch = fy * P`). */
  readonly P: number;
  /** Declared head roll amplitude in degrees (`head roll = fx * fy * (-R)`). */
  readonly R: number;
  /** Declared body yaw amplitude in degrees (`body yaw = fx * B`). */
  readonly B: number;
  /** Declared eye horizontal dial amplitude. */
  readonly eyeXRange: number;
  /** Declared eye vertical dial amplitude. */
  readonly eyeYRange: number;
  /** Sign aligning positive `headYaw` (`+fx`) with viewer-right (`+x`). */
  readonly yawSign: 1 | -1;
  /** Sign aligning positive `headPitch` (`+fy`) with viewer-up (`+y`). */
  readonly pitchSign: 1 | -1;
  readonly yawBone: string;
  readonly pitchBone: string | null;
  readonly rollBone: string | null;
  readonly rollDirectBone: string | null;
  readonly bodyBone: string | null;
  readonly bodyDirectBone: string | null;
  readonly eyeXBone: string | null;
  readonly eyeYBone: string | null;
  readonly eyeDirectBones: readonly string[];
  readonly hairPhysicsBones: readonly string[];
}

export type LookDialReadResult =
  | { readonly ok: true; readonly dials: LookDials }
  | { readonly ok: false; readonly missingAxis: string; readonly message: string };

export interface Spring2DState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface LookStepSnapshot {
  readonly fx: number;
  readonly fy: number;
  readonly pointerPresent: boolean;
  readonly hx: number;
  readonly hy: number;
  readonly headYaw: number;
  readonly headPitch: number;
  readonly headRoll: number;
  /** Normalized roll sign factor `fx * fy = -headRoll / R` (matches `sign(fx * fy)`). */
  readonly rollFactor: number;
  readonly bodyYaw: number;
  readonly eyeX: number;
  readonly eyeY: number;
  readonly headAngularVelocityDegPerSec: number;
  readonly physicsRotationInputDeg: number;
  readonly maxHairBoneDeltaDeg: number;
  readonly hairBoneDeltasDeg: Readonly<Record<string, number>>;
}

/**
 * Natural frequency (rad/s) for a critically-damped 2D spring that settles within
 * 2 % of a step target in `0.15 s`: `(1 + 40 * 0.15) * exp(-40 * 0.15) = 0.01735 < 0.02`.
 */
export const HEAD_SPRING_OMEGA0 = 40;

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
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

interface CompiledConstraintEntry {
  readonly kind: string;
  readonly name: string;
  readonly animation?: string;
  readonly record: {
    readonly bone?: string;
    readonly property?: string;
    readonly from?: number;
    readonly to?: number;
    readonly scale?: number;
  };
}

function readCompiledDoc(assets: ModelAssets): CompiledDocument {
  const holder = assets.document as { readonly doc?: CompiledDocument };
  if (holder && holder.doc) return holder.doc;
  return assets.document as unknown as CompiledDocument;
}

function sliderAmplitude(
  assets: ModelAssets,
  slider: CompiledConstraintEntry,
): number {
  const from = slider.record.from ?? 0;
  const to = slider.record.to ?? 0;
  const scale = slider.record.scale ?? 1;
  const anim = assets.animations.find((a) => a.name === slider.animation);
  const duration = anim?.duration ?? 0;
  if (!(scale !== 0) || !Number.isFinite(scale)) {
    return Math.abs(from);
  }
  const minVal = from - to / scale;
  const maxVal = from + (duration - to) / scale;
  const raw = Math.max(Math.abs(minVal), Math.abs(maxVal));
  return Math.round(raw * 1e5) / 1e5;
}

function detectSliderDirectionSign(
  doc: CompiledDocument,
  animationName: string | undefined,
  channel: 'translatex' | 'translatey',
): 1 | -1 {
  if (!animationName) return 1;
  const anim = doc.animations.find((a) => a.name === animationName);
  if (!anim) return 1;
  const probeBone =
    anim.timelines.bones.find((b) => b.name === 'nose') ??
    anim.timelines.bones.find((b) => b.name === 'eye_r') ??
    anim.timelines.bones[0];
  if (!probeBone) return 1;
  const tl = probeBone.timelines.find((t) => t.kind === channel);
  if (!tl || tl.keys.length < 2) return 1;
  const firstKey = tl.keys[0] as { readonly value?: number } | undefined;
  const lastKey = tl.keys[tl.keys.length - 1] as { readonly value?: number } | undefined;
  const first = firstKey?.value ?? 0;
  const last = lastKey?.value ?? 0;
  return last < first ? -1 : 1;
}

function findHeadDescendantPhysicsBones(doc: CompiledDocument): string[] {
  const parentByBone = new Map<string, string | null>();
  for (const b of doc.bones) {
    parentByBone.set(b.name, b.parent ?? null);
  }
  const isUnderHead = (boneName: string): boolean => {
    let cur: string | null | undefined = boneName;
    const visited = new Set<string>();
    while (cur && !visited.has(cur)) {
      if (cur === 'head' || cur === 'head_ctl' || cur === 'neck') return true;
      visited.add(cur);
      cur = parentByBone.get(cur) ?? null;
    }
    return /^(bang|hair|bun|lock|ponytail|braid|ahoge)/i.test(boneName);
  };

  const result: string[] = [];
  for (const c of doc.constraints as unknown as readonly CompiledConstraintEntry[]) {
    if (c.kind !== 'physics') continue;
    const boneName = c.record.bone;
    if (typeof boneName === 'string' && isUnderHead(boneName) && !result.includes(boneName)) {
      result.push(boneName);
    }
  }
  return result;
}

/**
 * Reads `Y, P, R, B` and eye dial ranges from the compiled rig's declared
 * constraints and bone/track structure. If the rig declares no `yaw` dial, logs
 * one console warning naming `"yaw"` and returns `{ ok: false, missingAxis: "yaw" }`
 * without throwing (Bar 2).
 */
export function readLookDials(assets: ModelAssets): LookDialReadResult {
  const doc = readCompiledDoc(assets);
  const constraints = doc.constraints as unknown as readonly CompiledConstraintEntry[];
  const sliders = constraints.filter((c) => c.kind === 'slider');
  const boneNames = new Set(doc.bones.map((b) => b.name));

  const yawSlider = sliders.find(
    (s) => s.name === 'yaw' || s.animation === 'turn' || s.record.bone === 'yaw_dial',
  );
  if (!yawSlider || !yawSlider.record.bone || !boneNames.has(yawSlider.record.bone)) {
    const message =
      '[examples/look] Rig is missing required dial axis "yaw" (no "yaw" slider constraint found); rendering static pose.';
    console.warn(message);
    return { ok: false, missingAxis: 'yaw', message };
  }

  const Y = sliderAmplitude(assets, yawSlider);
  if (!(Y > 0)) {
    const message =
      '[examples/look] Rig dial axis "yaw" has zero range; rendering static pose.';
    console.warn(message);
    return { ok: false, missingAxis: 'yaw', message };
  }

  const pitchSlider = sliders.find(
    (s) =>
      s.name === 'pitch' ||
      s.name === 'tilt' ||
      s.animation === 'tilt' ||
      s.record.bone === 'pitch_dial',
  );
  const P = pitchSlider ? sliderAmplitude(assets, pitchSlider) : Y;

  const rollSlider = sliders.find(
    (s) => s.name === 'roll' || s.animation === 'roll' || s.record.bone === 'roll_dial',
  );
  const R = rollSlider ? sliderAmplitude(assets, rollSlider) : Math.round(P * 0.32 * 100) / 100;
  const rollDirectBone =
    !rollSlider && boneNames.has('head_ctl')
      ? 'head_ctl'
      : !rollSlider && boneNames.has('head')
        ? 'head'
        : null;

  const bodySlider = sliders.find(
    (s) => s.name === 'body' || s.animation === 'body_turn' || s.record.bone === 'body_dial',
  );
  const B = bodySlider ? sliderAmplitude(assets, bodySlider) : Math.round(Y * 0.2 * 100) / 100;
  const bodyDirectBone =
    !bodySlider && boneNames.has('body_ctl')
      ? 'body_ctl'
      : !bodySlider && boneNames.has('chest_ctl')
        ? 'chest_ctl'
        : !bodySlider && boneNames.has('chest')
          ? 'chest'
          : null;

  const eyeXSlider = sliders.find(
    (s) => s.name === 'eye_x' || s.animation === 'gaze_x' || s.record.bone === 'eye_x_dial',
  );
  const eyeYSlider = sliders.find(
    (s) => s.name === 'eye_y' || s.animation === 'gaze_y' || s.record.bone === 'eye_y_dial',
  );

  const eyeDirectBones: string[] = [];
  if (!eyeXSlider || !eyeYSlider) {
    if (boneNames.has('iris_r') && boneNames.has('iris_l')) {
      eyeDirectBones.push('iris_r', 'iris_l');
    } else if (boneNames.has('eye_r') && boneNames.has('eye_l')) {
      eyeDirectBones.push('eye_r', 'eye_l');
    }
  }

  // Derive fallback eye pixel clearance from page dimensions of eyewhite vs iris when no eye slider is present.
  let fallbackEyeX = 4;
  let fallbackEyeY = 2.5;
  if ((!eyeXSlider || !eyeYSlider) && doc.pages) {
    const whitePage = doc.pages.find((p) => p.name.includes('eyewhite_r'));
    const irisPage = doc.pages.find((p) => p.name.includes('iris_r'));
    if (whitePage && irisPage) {
      fallbackEyeX = Math.max(2, (whitePage.width - irisPage.width) * 0.5);
      fallbackEyeY = Math.max(1.5, (whitePage.height - irisPage.height) * 0.5);
    }
  }

  const eyeXRange = eyeXSlider ? sliderAmplitude(assets, eyeXSlider) : fallbackEyeX;
  const eyeYRange = eyeYSlider ? sliderAmplitude(assets, eyeYSlider) : fallbackEyeY;

  const yawSign = detectSliderDirectionSign(doc, yawSlider.animation, 'translatex');
  const pitchSign = detectSliderDirectionSign(doc, pitchSlider?.animation, 'translatey');
  const hairPhysicsBones = findHeadDescendantPhysicsBones(doc);

  return {
    ok: true,
    dials: {
      Y,
      P,
      R,
      B,
      eyeXRange,
      eyeYRange,
      yawSign,
      pitchSign,
      yawBone: yawSlider.record.bone,
      pitchBone:
        pitchSlider?.record.bone && boneNames.has(pitchSlider.record.bone)
          ? pitchSlider.record.bone
          : null,
      rollBone:
        rollSlider?.record.bone && boneNames.has(rollSlider.record.bone)
          ? rollSlider.record.bone
          : null,
      rollDirectBone,
      bodyBone:
        bodySlider?.record.bone && boneNames.has(bodySlider.record.bone)
          ? bodySlider.record.bone
          : null,
      bodyDirectBone,
      eyeXBone:
        eyeXSlider?.record.bone && boneNames.has(eyeXSlider.record.bone)
          ? eyeXSlider.record.bone
          : null,
      eyeYBone:
        eyeYSlider?.record.bone && boneNames.has(eyeYSlider.record.bone)
          ? eyeYSlider.record.bone
          : null,
      eyeDirectBones,
      hairPhysicsBones,
    },
  };
}

function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  let diff = ((toDeg - fromDeg + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(diff) < 1e-12) diff = 0;
  return diff;
}

export class LookController {
  readonly rig: PixiRig;
  readonly assets: ModelAssets;
  readonly dialResult: LookDialReadResult;

  private pointerFx = 0;
  private pointerFy = 0;
  private pointerPresent = false;
  private readonly spring: Spring2DState = { x: 0, y: 0, vx: 0, vy: 0 };

  private currentHeadYaw = 0;
  private currentHeadPitch = 0;
  private currentHeadRoll = 0;
  private currentBodyYaw = 0;
  private currentEyeX = 0;
  private currentEyeY = 0;

  private lastSnapshot: LookStepSnapshot;
  private previousHairRotations = new Map<string, number>();

  constructor(rig: PixiRig, assets: ModelAssets) {
    this.rig = rig;
    this.assets = assets;
    this.dialResult = readLookDials(assets);

    this.lastSnapshot = {
      fx: 0,
      fy: 0,
      pointerPresent: false,
      hx: 0,
      hy: 0,
      headYaw: 0,
      headPitch: 0,
      headRoll: 0,
      rollFactor: 0,
      bodyYaw: 0,
      eyeX: 0,
      eyeY: 0,
      headAngularVelocityDegPerSec: 0,
      physicsRotationInputDeg: 0,
      maxHairBoneDeltaDeg: 0,
      hairBoneDeltasDeg: {},
    };

    if (!this.dialResult.ok) {
      // Bar 2: render static without throwing when a required dial is missing.
      if (assets.animations.length > 0) {
        this.rig.play(assets.animations[0].name, { loop: false });
      }
      this.rig.timescale = 0;
      this.rig.draw();
      return;
    }

    const { dials } = this.dialResult;
    this.rig.adjust = (bones: AdjustableBones) => {
      this.applyDialsToBones(bones, dials);
    };

    const idleAnim = assets.animations.find((a) => a.name === 'idle')?.name;
    if (idleAnim) {
      this.rig.play(idleAnim, { loop: true });
    } else if (assets.animations.length > 0) {
      this.rig.play(assets.animations[0].name, { loop: true });
    }
    this.rig.environment({ wind: [0, 0], gravity: [0, 0] });
    this.captureHairRotations(dials.hairPhysicsBones);
  }

  get isStaticFallback(): boolean {
    return !this.dialResult.ok;
  }

  get dials(): LookDials | null {
    return this.dialResult.ok ? this.dialResult.dials : null;
  }

  get snapshot(): LookStepSnapshot {
    return this.lastSnapshot;
  }

  /** Sets normalized pointer coordinates `(fx, fy)` in `[-1, 1]`. */
  setPointer(fx: number, fy: number): void {
    this.pointerFx = clampUnit(fx);
    this.pointerFy = clampUnit(fy);
    this.pointerPresent = true;
    // Eyes follow at once (within 1 frame).
    this.currentEyeX = this.pointerFx;
    this.currentEyeY = this.pointerFy;
  }

  /** Clears pointer when leaving the canvas; absent pointer -> `(0, 0)`. */
  clearPointer(): void {
    this.pointerFx = 0;
    this.pointerFy = 0;
    this.pointerPresent = false;
    this.currentEyeX = 0;
    this.currentEyeY = 0;
  }

  /** Advances the controller and underlying `PixiRig` by `dt` seconds. */
  step(dt: number): LookStepSnapshot {
    if (!this.dialResult.ok) {
      this.rig.draw();
      return this.lastSnapshot;
    }

    const { dials } = this.dialResult;
    const prevYaw = this.currentHeadYaw;
    const prevPitch = this.currentHeadPitch;
    const prevRoll = this.currentHeadRoll;

    // 1. Eyes follow at once.
    this.currentEyeX = this.pointerFx;
    this.currentEyeY = this.pointerFy;

    // 2. Head target follows through a critically-damped spring (~0.15s settle).
    stepCriticallyDampedSpring2D(this.spring, this.pointerFx, this.pointerFy, dt);
    const hx = this.spring.x;
    const hy = this.spring.y;

    this.currentHeadYaw = hx * dials.Y;
    this.currentHeadPitch = hy * dials.P;
    const rollFactor = hx * hy;
    this.currentHeadRoll = rollFactor * -dials.R;
    this.currentBodyYaw = hx * dials.B;

    // 3. Feed head angular velocity into play's world physics input (`rig.moved`).
    const dYaw = this.currentHeadYaw - prevYaw;
    const dPitch = this.currentHeadPitch - prevPitch;
    const dRoll = this.currentHeadRoll - prevRoll;
    const angularDeltaDeg = Math.hypot(dYaw, dPitch, dRoll);
    const headAngularVelocityDegPerSec = dt > 0 ? angularDeltaDeg / dt : 0;
    const physicsRotationInputDeg =
      angularDeltaDeg > 1e-9 ? -dYaw * 0.55 + dRoll - dPitch * 0.25 : 0;

    if (physicsRotationInputDeg !== 0) {
      this.rig.moved({ rotation: physicsRotationInputDeg });
    }

    this.rig.advance(dt);

    // 4. Measure hair physics bone deltas across this step.
    const hairBoneDeltasDeg: Record<string, number> = {};
    let maxHairBoneDeltaDeg = 0;
    for (const boneName of dials.hairPhysicsBones) {
      const currentRot = this.rig.bone(boneName).rotationX;
      const prevRot = this.previousHairRotations.get(boneName) ?? currentRot;
      const delta = Math.abs(shortestAngleDeltaDeg(prevRot, currentRot));
      hairBoneDeltasDeg[boneName] = delta;
      if (delta > maxHairBoneDeltaDeg) {
        maxHairBoneDeltaDeg = delta;
      }
      this.previousHairRotations.set(boneName, currentRot);
    }

    this.lastSnapshot = {
      fx: this.pointerFx,
      fy: this.pointerFy,
      pointerPresent: this.pointerPresent,
      hx,
      hy,
      headYaw: this.currentHeadYaw,
      headPitch: this.currentHeadPitch,
      headRoll: this.currentHeadRoll,
      rollFactor: rollFactor === 0 ? 0 : rollFactor,
      bodyYaw: this.currentBodyYaw,
      eyeX: this.currentEyeX,
      eyeY: this.currentEyeY,
      headAngularVelocityDegPerSec,
      physicsRotationInputDeg,
      maxHairBoneDeltaDeg,
      hairBoneDeltasDeg,
    };

    return this.lastSnapshot;
  }

  private captureHairRotations(hairBones: readonly string[]): void {
    this.previousHairRotations.clear();
    for (const boneName of hairBones) {
      this.previousHairRotations.set(boneName, this.rig.bone(boneName).rotationX);
    }
  }

  private applyDialsToBones(bones: AdjustableBones, dials: LookDials): void {
    bones.bone(dials.yawBone).rotation = dials.yawSign * this.currentHeadYaw;
    if (dials.pitchBone) {
      bones.bone(dials.pitchBone).rotation = dials.pitchSign * this.currentHeadPitch;
    }
    if (dials.rollBone) {
      bones.bone(dials.rollBone).rotation = this.currentHeadRoll;
    } else if (dials.rollDirectBone) {
      bones.bone(dials.rollDirectBone).rotation += this.currentHeadRoll;
    }
    if (dials.bodyBone) {
      bones.bone(dials.bodyBone).rotation = this.currentBodyYaw;
    } else if (dials.bodyDirectBone) {
      bones.bone(dials.bodyDirectBone).rotation -= this.currentBodyYaw;
    }
    if (dials.eyeXBone) {
      bones.bone(dials.eyeXBone).x = this.currentEyeX * dials.eyeXRange;
    }
    if (dials.eyeYBone) {
      bones.bone(dials.eyeYBone).y = this.currentEyeY * dials.eyeYRange;
    }
    if (!dials.eyeXBone && !dials.eyeYBone && dials.eyeDirectBones.length > 0) {
      for (const eyeBone of dials.eyeDirectBones) {
        const b = bones.bone(eyeBone);
        b.x += this.currentEyeX * dials.eyeXRange;
        b.y += this.currentEyeY * dials.eyeYRange;
      }
    }
  }
}
