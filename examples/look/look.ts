import type { CompiledDocument } from 'rig-c/core';
import type { ModelAssets, RigPlayer } from '@rig-c/play';
import { PointerDials, PointerDialRefusal, readPointerDialBindings, type DialBoneNames, type PointerDialBindings } from './pointer-dials.ts';
export { pointerToNormalized, stepCriticallyDampedSpring2D, HEAD_SPRING_OMEGA0 } from './pointer-dials.ts';

export interface LookRig {
  readonly player: RigPlayer;
  play: RigPlayer['play'];
  advance(dt: number): void;
  draw(): unknown;
  bone: RigPlayer['bone'];
  bounds: RigPlayer['bounds'];
  posedFrame: RigPlayer['posedFrame'];
  drawnFrame: RigPlayer['posedFrame'];
  timescale: number;
  destroy(): void;
}

/** Bone names belong to this public example rig, never to the reusable helper. */
export const LOOK_DIAL_BONES = { yaw: 'yaw_dial', pitch: 'pitch_dial', roll: 'roll_dial', body: 'body_dial', gazeX: 'gaze_x_dial', gazeY: 'gaze_y_dial' } as const satisfies DialBoneNames;

/** Interim calibrated whole-rig input; replace with head-local physics input when supported. */
export const INTERIM_GLOBAL_PHYSICS_GAIN = 0.25;

export interface LookBandMap {
  readonly yaw: readonly [number, number];
  readonly pitch: readonly [number, number];
  readonly roll: readonly [number, number];
  readonly body: readonly [number, number];
  readonly gazeX: readonly [number, number];
  readonly gazeY: readonly [number, number];
}

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
  readonly yawProperty: string;
  readonly pitchBone: string | null;
  readonly pitchProperty: string;
  readonly rollBone: string | null;
  readonly rollProperty: string;
  readonly bodyBone: string | null;
  readonly bodyProperty: string;
  readonly eyeXBone: string | null;
  readonly eyeXProperty: string;
  readonly eyeYBone: string | null;
  readonly eyeYProperty: string;
  readonly bindings: PointerDialBindings;
  readonly hairPhysicsBones: readonly string[];
  /** Finite bands derived from the compiled slider constraints. */
  readonly modelThresholds: LookBandMap;
  /** Clamp bands enforced by the page before sending dial values to the rig. */
  readonly pageClamp: LookBandMap;
}

export type LookDialReadResult =
  | { readonly ok: true; readonly dials: LookDials }
  | { readonly ok: false; readonly missingAxis: string; readonly message: string };

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
  const firstKey = tl.keys[0] as
    | { readonly values?: readonly number[]; readonly value?: number }
    | undefined;
  const lastKey = tl.keys[tl.keys.length - 1] as
    | { readonly values?: readonly number[]; readonly value?: number }
    | undefined;
  const first = firstKey?.values?.[0] ?? firstKey?.value ?? 0;
  const last = lastKey?.values?.[0] ?? lastKey?.value ?? 0;
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
  for (const c of doc.constraints) {
    if (c.record?.kind !== 'physics') continue;
    const boneName = c.record.bone;
    if (typeof boneName === 'string' && isUnderHead(boneName) && !result.includes(boneName)) {
      result.push(boneName);
    }
  }
  return result;
}

/** All requested axes require real slider constraints; there are no guessed bands. */
export function readLookDials(doc: CompiledDocument, names: Required<DialBoneNames> = LOOK_DIAL_BONES): LookDialReadResult {
  let bindings: PointerDialBindings;
  try {
    bindings = readPointerDialBindings(doc, names);
  } catch (error) {
    if (!(error instanceof PointerDialRefusal)) throw error;
    const message = `[examples/look] Rig is missing required dial axis "${error.axis}" or its usable range: ${error.message}; rendering static pose.`;
    console.warn(message);
    return { ok: false, missingAxis: error.axis, message };
  }
  const band = (axis: keyof PointerDialBindings): readonly [number, number] => bindings[axis]!.range;
  const amplitude = (axis: keyof PointerDialBindings): number => Math.max(...band(axis).map(Math.abs));
  const animation = (axis: keyof PointerDialBindings): string | undefined => doc.constraints.find(c => c.name === bindings[axis]!.slider)?.animation;
  const modelThresholds: LookBandMap = {
    yaw: band('yaw'), pitch: band('pitch'), roll: band('roll'), body: band('body'), gazeX: band('gazeX'), gazeY: band('gazeY'),
  };
  const property = (axis: keyof PointerDialBindings): string => bindings[axis]!.channel === 'rotation' ? 'rotate' : bindings[axis]!.channel;
  return { ok: true, dials: {
    Y: amplitude('yaw'), P: amplitude('pitch'), R: amplitude('roll'), B: amplitude('body'),
    eyeXRange: amplitude('gazeX'), eyeYRange: amplitude('gazeY'),
    yawSign: detectSliderDirectionSign(doc, animation('yaw'), 'translatex'),
    pitchSign: detectSliderDirectionSign(doc, animation('pitch'), 'translatey'),
    yawBone: bindings.yaw!.bone, yawProperty: property('yaw'),
    pitchBone: bindings.pitch!.bone, pitchProperty: property('pitch'),
    rollBone: bindings.roll!.bone, rollProperty: property('roll'),
    bodyBone: bindings.body!.bone, bodyProperty: property('body'),
    eyeXBone: bindings.gazeX!.bone, eyeXProperty: property('gazeX'),
    eyeYBone: bindings.gazeY!.bone, eyeYProperty: property('gazeY'),
    bindings, hairPhysicsBones: findHeadDescendantPhysicsBones(doc), modelThresholds, pageClamp: modelThresholds,
  } };
}

function shortestAngleDeltaDeg(fromDeg: number, toDeg: number): number {
  let diff = ((toDeg - fromDeg + 180) % 360 + 360) % 360 - 180;
  if (Math.abs(diff) < 1e-12) diff = 0;
  return diff;
}

export class LookController {
  readonly rig: LookRig;
  readonly assets: ModelAssets;
  readonly dialResult: LookDialReadResult;

  private pointerFx = 0;
  private pointerFy = 0;
  private pointerPresent = false;
  private readonly pointerDials: PointerDials | null;

  private currentHeadYaw = 0;
  private currentHeadPitch = 0;
  private currentHeadRoll = 0;
  private currentBodyYaw = 0;
  private currentEyeX = 0;
  private currentEyeY = 0;

  private lastSnapshot: LookStepSnapshot;
  private previousHairRotations = new Map<string, number>();

  constructor(rig: LookRig, assets: ModelAssets, doc: CompiledDocument) {
    this.rig = rig;
    this.assets = assets;
    this.dialResult = readLookDials(doc);
    this.pointerDials = this.dialResult.ok ? new PointerDials(this.dialResult.dials.bindings, { yaw: this.dialResult.dials.yawSign, pitch: this.dialResult.dials.pitchSign }) : null;

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
    this.rig.player.adjust = this.pointerDials!.adjust;

    const idleAnim = assets.animations.find((a) => a.name === 'idle')?.name;
    if (idleAnim) {
      this.rig.play(idleAnim, { loop: true });
    } else if (assets.animations.length > 0) {
      this.rig.play(assets.animations[0].name, { loop: true });
    }
    this.rig.player.environment({ wind: [0, 0], gravity: [0, 0] });
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
    this.pointerDials?.setPointer(fx, fy);
    this.pointerPresent = true;
  }

  /** Clears pointer when leaving the canvas; absent pointer -> `(0, 0)`. */
  clearPointer(): void {
    this.pointerDials?.clearPointer();
    this.pointerFx = 0;
    this.pointerFy = 0;
    this.pointerPresent = false;
    this.currentEyeX = 0;
    this.currentEyeY = 0;
  }

  /** Advances the controller and underlying host rig by `dt` seconds. */
  step(dt: number): LookStepSnapshot {
    if (!this.dialResult.ok) {
      this.rig.draw();
      return this.lastSnapshot;
    }

    const { dials } = this.dialResult;
    const prevYaw = this.currentHeadYaw;
    const prevPitch = this.currentHeadPitch;
    const prevRoll = this.currentHeadRoll;

    const follow = this.pointerDials!.step(dt);
    const { hx, hy, values } = follow;
    this.pointerFx = follow.fx;
    this.pointerFy = follow.fy;
    this.currentHeadYaw = values.yaw! * dials.yawSign;
    this.currentHeadPitch = values.pitch! * dials.pitchSign;
    this.currentHeadRoll = values.roll!;
    this.currentBodyYaw = values.body!;
    this.currentEyeX = values.gazeX!;
    this.currentEyeY = values.gazeY!;
    const rollFactor = hx * hy;

    // 3. Interim calibrated global input: the shipped mesh turn has no moving hair roots.
    // Keep this explicitly global until play or the producer supplies head-local motion.
    const dYaw = this.currentHeadYaw - prevYaw;
    const dPitch = this.currentHeadPitch - prevPitch;
    const dRoll = this.currentHeadRoll - prevRoll;
    const angularDeltaDeg = Math.hypot(dYaw, dPitch, dRoll);
    const headAngularVelocityDegPerSec = dt > 0 ? angularDeltaDeg / dt : 0;
    const physicsRotationInputDeg =
      angularDeltaDeg > 1e-9
        ? INTERIM_GLOBAL_PHYSICS_GAIN * (-dYaw * 0.55 + dRoll - dPitch * 0.25)
        : 0;

    if (physicsRotationInputDeg !== 0) {
      this.rig.player.moved({ rotation: physicsRotationInputDeg });
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

}
