/**
 * PALEBARK — animation.
 *
 * There are no imported animation clips. Instead: a small set of *authored base
 * poses* (plain bone-rotation tables, below) plus five procedural layers that
 * blend on top of them. Every layer is additive in local bone space and every
 * transition is eased, so nothing in this character can snap.
 *
 *   LAYER 0  base pose          held pose per state, cross-faded
 *   LAYER 1  stillness          multi-second micro-drift. NOT a breathing idle.
 *   LAYER 2  locomotion         glide-walk: reduced vertical bob, long stance
 *   LAYER 3  terrain IK         two-bone leg IK + pelvis drop, feet plant
 *   LAYER 4  gaze              head/neck tracking with a lag and a hold
 *   LAYER 5  extension/reach    the reserved beat. Writes the `*_x` joints.
 *
 * ── Why stillness is a layer and not an absence ──────────────────────────────
 * Every organic thing in this forest moves continuously (wind on foliage, rain,
 * insects). If Palebark simply froze, engine-wise it would look like a paused
 * asset; the eye reads "bug", not "threat". So the stillness layer runs a
 * genuinely tiny, genuinely slow drift — amplitude in the single-millimetre
 * range, periods of 7–19 seconds, with hard *holds* where nothing at all moves
 * for seconds at a time. It never uses a breathing cycle, never shifts weight
 * between feet, and never fidgets. The result reads as a thing choosing to be
 * motionless rather than an object that is motionless.
 *
 * ── The extension layer (§5, §9) ─────────────────────────────────────────────
 * This is the only code in the project permitted to write to a `*_x` joint. It
 * is gated three ways: the AI must grant eligibility (late-game milestone), the
 * cooldown must be clear, and the blend-in ramp takes 0.9 s so it can never
 * appear as a hard cut. `extensionActive` is exposed so QA can assert rarity.
 */

import * as THREE from 'three';
import { PalebarkRigBones } from './PalebarkSkeleton';

export type AnimState = 'dormant' | 'transit' | 'stalk' | 'confront';

export interface AnimInput {
  state: AnimState;
  /** world-space planar speed, m/s */
  speed: number;
  /** entity yaw, radians */
  yaw: number;
  /** where the entity is looking (world point) — usually the player's head */
  gaze: THREE.Vector3 | null;
  /** 0..1 how strongly it is regarding the player */
  gazeWeight: number;
  /** terrain sampler for foot planting */
  groundAt(x: number, z: number): number;
  /** 0..1 AI detection — tightens the pose */
  detection: number;
  /** may the extension beat play at all? (late-game milestone gate) */
  extensionEligible: boolean;
  /** request a specific extension now (AI-driven, still cooldown-gated) */
  extensionRequest: boolean;
  /** deterministic per-run variation */
  rand: () => number;
}

/* -------------------------------------------------------------- base poses */

type PoseTable = Record<string, [number, number, number]>;   // euler XYZ, radians

/**
 * Authored held poses. Deliberately sparse — these set the *character* of a
 * state (how the shoulders hang, how far the neck is craned) and the procedural
 * layers do the rest. Values are hand-tuned, not captured.
 */
const POSE: Record<AnimState, PoseTable> = {
  // Dormant: perfectly vertical, arms dead at the sides, head level. The
  // "wrong formality" pose — a person standing at attention in a forest.
  dormant: {
    spine_1: [0.004, 0, 0], spine_2: [0.004, 0, 0], chest: [-0.010, 0, 0],
    neck_1: [0.012, 0, 0], neck_2: [0.006, 0, 0], head: [-0.014, 0, 0],
    clavicle_l: [0, 0, 0.030], clavicle_r: [0, 0, -0.030],
    upperarm_l: [0.020, 0, 0.048], upperarm_r: [0.020, 0, -0.048],
    forearm_l: [0.030, 0, 0.012], forearm_r: [0.030, 0, -0.012],
    hand_l: [0.05, 0, 0], hand_r: [0.05, 0, 0],
    thigh_l: [-0.006, 0, 0.008], thigh_r: [-0.006, 0, -0.008],
    shin_l: [0.014, 0, 0], shin_r: [0.014, 0, 0],
  },
  // Transit: a fractional forward lean from the hips, arms still hanging.
  // Crucially the shoulders do NOT counter-rotate — no human walk cadence.
  transit: {
    spine_1: [0.026, 0, 0], spine_2: [0.020, 0, 0], chest: [-0.018, 0, 0],
    neck_1: [0.030, 0, 0], neck_2: [0.014, 0, 0], head: [-0.050, 0, 0],
    clavicle_l: [0, 0, 0.026], clavicle_r: [0, 0, -0.026],
    upperarm_l: [0.055, 0, 0.052], upperarm_r: [0.055, 0, -0.052],
    forearm_l: [0.075, 0, 0.014], forearm_r: [0.075, 0, -0.014],
    hand_l: [0.08, 0, 0], hand_r: [0.08, 0, 0],
    thigh_l: [0, 0, 0.006], thigh_r: [0, 0, -0.006],
    shin_l: [0.020, 0, 0], shin_r: [0.020, 0, 0],
  },
  // Stalk: lowered head, shoulders drawn very slightly forward — the pose of
  // something conserving movement, not preparing to sprint.
  stalk: {
    spine_1: [0.045, 0, 0], spine_2: [0.030, 0, 0], chest: [0.010, 0, 0],
    neck_1: [0.055, 0, 0], neck_2: [0.030, 0, 0], head: [-0.095, 0, 0],
    clavicle_l: [0.030, 0, 0.040], clavicle_r: [0.030, 0, -0.040],
    upperarm_l: [0.10, 0, 0.070], upperarm_r: [0.10, 0, -0.070],
    forearm_l: [0.14, 0, 0.020], forearm_r: [0.14, 0, -0.020],
    hand_l: [0.10, 0, 0], hand_r: [0.10, 0, 0],
    thigh_l: [-0.020, 0, 0.010], thigh_r: [-0.020, 0, -0.010],
    shin_l: [0.045, 0, 0], shin_r: [0.045, 0, 0],
  },
  // Confront: fully upright again, head level and squared on. Arms hang open
  // and slightly away from the body. No aggression posture, no arms raised —
  // the threat is that it is simply facing you and closing.
  confront: {
    spine_1: [-0.014, 0, 0], spine_2: [-0.010, 0, 0], chest: [-0.026, 0, 0],
    neck_1: [-0.006, 0, 0], neck_2: [0, 0, 0], head: [0.010, 0, 0],
    clavicle_l: [-0.020, 0, 0.055], clavicle_r: [-0.020, 0, -0.055],
    upperarm_l: [-0.030, 0, 0.115], upperarm_r: [-0.030, 0, -0.115],
    forearm_l: [0.045, 0, 0.030], forearm_r: [0.045, 0, -0.030],
    hand_l: [0.02, 0, 0], hand_r: [0.02, 0, 0],
    thigh_l: [0, 0, 0.008], thigh_r: [0, 0, -0.008],
    shin_l: [0.010, 0, 0], shin_r: [0.010, 0, 0],
  },
};

const ALL_POSED = [...new Set(Object.values(POSE).flatMap(p => Object.keys(p)))];

/* ------------------------------------------------------------------ helpers */

function damp(cur: number, target: number, lambda: number, dt: number): number {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

function shortestAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Extension beat descriptor — which chain elongates, and by how much. */
interface ExtensionBeat {
  kind: 'arm-l' | 'arm-r' | 'neck';
  /** peak extra length in metres, distributed across the `_x` joints */
  amount: number;
  /** total duration: in → hold → out */
  inT: number; holdT: number; outT: number;
}

export class PalebarkAnimator {
  private rig: PalebarkRigBones;
  /** per-state blend weights, always summing to ~1 */
  private w: Record<AnimState, number> = { dormant: 1, transit: 0, stalk: 0, confront: 0 };
  private state: AnimState = 'dormant';

  // ---- stillness layer ----
  private drift = 0;
  private driftTarget = 0;
  private holdTimer = 4;
  private holding = true;
  private stillPhase = [0, 0, 0];

  // ---- locomotion ----
  private stridePhase = 0;
  private strideBlend = 0;
  /** eased speed — the entity never accelerates instantly */
  private smoothSpeed = 0;

  // ---- foot IK ----
  private footPlant: { x: number; z: number; y: number; locked: boolean }[] = [
    { x: 0, z: 0, y: 0, locked: false }, { x: 0, z: 0, y: 0, locked: false },
  ];
  private pelvisDrop = 0;
  /** QA: set true if any foot ends a frame above/below its target beyond tolerance */
  footError = 0;

  // ---- gaze ----
  private gazeYaw = 0;
  private gazePitch = 0;
  private gazeHold = 0;

  // ---- extension ----
  private beat: ExtensionBeat | null = null;
  private beatT = 0;
  private beatWeight = 0;
  private extensionCooldown = 24;
  /** count of extension beats this run — QA asserts rarity */
  extensionCount = 0;
  get extensionActive(): boolean { return this.beatWeight > 0.01; }
  get extensionWeight(): number { return this.beatWeight; }

  /** freshly-computed root offsets the caller applies to the group */
  rootYOffset = 0;
  /** whether the animator considers the character to be visually moving */
  get moving(): boolean { return this.strideBlend > 0.02; }

  private tmpV = new THREE.Vector3();
  private euler = new THREE.Euler();
  private q = new THREE.Quaternion();
  /** accumulator: local euler per posed bone, rebuilt every frame */
  private acc = new Map<string, [number, number, number]>();

  constructor(rig: PalebarkRigBones) {
    this.rig = rig;
    for (const n of ALL_POSED) this.acc.set(n, [0, 0, 0]);
    for (const n of ['spine_x1', 'spine_x2']) this.acc.set(n, [0, 0, 0]);
  }

  reset(): void {
    this.w = { dormant: 1, transit: 0, stalk: 0, confront: 0 };
    this.state = 'dormant';
    this.stridePhase = 0; this.strideBlend = 0; this.smoothSpeed = 0;
    this.drift = 0; this.driftTarget = 0; this.holdTimer = 4; this.holding = true;
    this.gazeYaw = 0; this.gazePitch = 0; this.gazeHold = 0;
    this.beat = null; this.beatT = 0; this.beatWeight = 0;
    this.extensionCooldown = 24;
    this.extensionCount = 0;
    this.pelvisDrop = 0; this.footError = 0;
    for (const f of this.footPlant) f.locked = false;
    // clear every extra joint back to inert
    for (const n of ['spine_x1', 'spine_x2',
      'upperarm_x_l', 'upperarm_x_r', 'forearm_x_l', 'forearm_x_r',
      'thigh_x_l', 'thigh_x_r', 'shin_x_l', 'shin_x_r']) {
      const b = this.rig.byName.get(n);
      if (b) { b.quaternion.identity(); b.scale.set(1, 1, 1); }
    }
  }

  /* ------------------------------------------------------------------ main */

  update(dt: number, time: number, input: AnimInput, entityPos: THREE.Vector3): void {
    this.transitionTo(input.state, dt);
    this.smoothSpeed = damp(this.smoothSpeed, input.speed, 3.2, dt);

    // reset the accumulator
    for (const [, v] of this.acc) { v[0] = 0; v[1] = 0; v[2] = 0; }

    this.layerBase();
    this.layerStillness(dt, time);
    this.layerLocomotion(dt, input);
    this.layerGaze(dt, input, entityPos);
    this.layerExtension(dt, input);

    // commit accumulated eulers to bones
    for (const [name, e] of this.acc) {
      const bone = this.rig.byName.get(name);
      if (!bone) continue;
      this.euler.set(e[0], e[1], e[2], 'XYZ');
      bone.quaternion.setFromEuler(this.euler);
    }
    // extra joints stay rotationally inert unless the extension layer is live
    if (this.beatWeight <= 0.001) this.clearExtras();

    this.rig.root.updateMatrixWorld(true);
    this.solveFootIK(dt, input, entityPos);
    this.rig.root.updateMatrixWorld(true);
  }

  private clearExtras(): void {
    for (const n of ['spine_x1', 'spine_x2',
      'upperarm_x_l', 'upperarm_x_r', 'forearm_x_l', 'forearm_x_r']) {
      const b = this.rig.byName.get(n);
      if (b) {
        b.quaternion.identity();
        // restore bind translation (the extension layer moves these)
        const spec = this.rig.bind.specs[this.rig.index.get(n)!];
        b.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
      }
    }
  }

  /** Eased state cross-fade. Nothing here is allowed to be instantaneous. */
  private transitionTo(next: AnimState, dt: number): void {
    this.state = next;
    // Contrast is the point: leaving stillness is SLOWER than entering motion
    // elsewhere would be, so the "it was still / it is now closing" beat lands.
    const rate = next === 'confront' ? 3.4 : 1.9;
    for (const k of Object.keys(this.w) as AnimState[]) {
      const target = k === next ? 1 : 0;
      this.w[k] = damp(this.w[k], target, k === next ? rate : rate * 0.85, dt);
    }
    // renormalise
    let sum = 0;
    for (const k of Object.keys(this.w) as AnimState[]) sum += this.w[k];
    if (sum > 1e-4) for (const k of Object.keys(this.w) as AnimState[]) this.w[k] /= sum;
  }

  /* --------------------------------------------------------- LAYER 0: base */

  private layerBase(): void {
    for (const st of Object.keys(POSE) as AnimState[]) {
      const weight = this.w[st];
      if (weight < 0.001) continue;
      const table = POSE[st];
      for (const name in table) {
        const a = this.acc.get(name);
        if (!a) continue;
        const t = table[name];
        a[0] += t[0] * weight; a[1] += t[1] * weight; a[2] += t[2] * weight;
      }
    }
  }

  /* ---------------------------------------------------- LAYER 1: stillness */

  /**
   * Micro-drift with holds. Amplitude is single-millimetre at the head; the
   * periods (7.3 s / 11.9 s / 19.1 s) are mutually prime so the pattern never
   * visibly loops. During a hold, output is frozen entirely — no interpolation
   * ticking along underneath, genuinely zero motion.
   */
  private layerStillness(dt: number, time: number): void {
    const stillness = this.w.dormant + this.w.stalk * 0.55;
    if (stillness < 0.001) { this.holding = false; return; }

    this.holdTimer -= dt;
    if (this.holdTimer <= 0) {
      this.holding = !this.holding;
      // holds are LONG: 2.5–7 s of literal nothing, then 1.5–4 s of drift
      this.holdTimer = this.holding ? 2.5 + Math.random() * 4.5 : 1.5 + Math.random() * 2.5;
      if (!this.holding) this.driftTarget = (Math.random() * 2 - 1);
    }
    if (!this.holding) {
      this.drift = damp(this.drift, this.driftTarget, 0.42, dt);
      this.stillPhase[0] += dt / 7.3;
      this.stillPhase[1] += dt / 11.9;
      this.stillPhase[2] += dt / 19.1;
    }
    const s = stillness;
    const a = Math.sin(this.stillPhase[0] * Math.PI * 2);
    const b = Math.sin(this.stillPhase[1] * Math.PI * 2);
    const c = Math.sin(this.stillPhase[2] * Math.PI * 2);

    // A whole-body lean of ~0.4°, distributed so nothing reads as a joint move
    const lean = (a * 0.0026 + b * 0.0016) * s;
    const twist = (c * 0.0022 + this.drift * 0.0016) * s;
    this.add('spine_1', lean * 0.4, twist * 0.5, 0);
    this.add('spine_2', lean * 0.3, twist * 0.3, 0);
    this.add('chest', lean * 0.2, twist * 0.2, 0);
    // the head compensates *against* the lean — reads as unnervingly deliberate
    this.add('neck_1', -lean * 0.6, twist * 0.8, 0);
    this.add('head', -lean * 0.5, -twist * 0.4, 0);
    // arms are dead weight: they do not swing, they only follow the torso
    this.add('upperarm_l', lean * 0.15, 0, -twist * 0.2);
    this.add('upperarm_r', lean * 0.15, 0, twist * 0.2);
  }

  /* --------------------------------------------------- LAYER 2: locomotion */

  /**
   * The glide-walk. Three deliberate departures from a human gait:
   *   • vertical bob is ~20 % of normal (0.010 m vs ~0.05 m)
   *   • stride is very long and the stance phase is stretched, so there is no
   *     visible "push off" impulse
   *   • arms do NOT counter-swing with the legs. They hang. This is the single
   *     biggest cue that reads as wrong at distance.
   */
  private layerLocomotion(dt: number, input: AnimInput): void {
    const wantMove = this.smoothSpeed > 0.12 ? 1 : 0;
    this.strideBlend = damp(this.strideBlend, wantMove, 2.6, dt);
    if (this.strideBlend < 0.002) { this.rootYOffset = 0; return; }

    // cadence deliberately slower than the speed implies — long, gliding steps
    const cadence = 0.62 + this.smoothSpeed * 0.34;
    this.stridePhase += dt * cadence;
    const ph = this.stridePhase * Math.PI * 2;
    const k = this.strideBlend * Math.min(1, this.smoothSpeed / 2.4);

    // long stance: shape the sine so the foot spends more time planted
    const shape = (x: number) => Math.sign(Math.sin(x)) * Math.pow(Math.abs(Math.sin(x)), 0.72);
    const lSwing = shape(ph), rSwing = shape(ph + Math.PI);

    this.add('thigh_l', lSwing * 0.34 * k, 0, 0);
    this.add('thigh_r', rSwing * 0.34 * k, 0, 0);
    // knee only bends on the swing half (negative = flex for this rig)
    this.add('shin_l', Math.max(0, -lSwing) * 0.46 * k, 0, 0);
    this.add('shin_r', Math.max(0, -rSwing) * 0.46 * k, 0, 0);
    this.add('foot_l', -Math.max(0, -lSwing) * 0.20 * k, 0, 0);
    this.add('foot_r', -Math.max(0, -rSwing) * 0.20 * k, 0, 0);

    // Arms: a fraction of a *passive* sway, in phase with the torso rather than
    // counter to the legs. No human walks like this and that is the point.
    const passive = Math.sin(ph * 0.5) * 0.030 * k;
    this.add('upperarm_l', passive, 0, 0);
    this.add('upperarm_r', passive, 0, 0);
    this.add('forearm_l', Math.abs(passive) * 0.4, 0, 0);
    this.add('forearm_r', Math.abs(passive) * 0.4, 0, 0);

    // Vertical bob at 2× cadence, deliberately tiny.
    this.rootYOffset = Math.abs(Math.sin(ph)) * 0.010 * k - 0.004 * k;
    // pelvis counter-rotates a hair so the legs don't look detached
    this.add('pelvis', 0, lSwing * 0.028 * k, 0);
  }

  /* --------------------------------------------------------- LAYER 4: gaze */

  /**
   * Head tracking with a lag and a hold. It does not smoothly follow the player
   * like a turret; it arrives late, then locks and stops moving entirely, which
   * is far more unpleasant than continuous tracking.
   */
  private layerGaze(dt: number, input: AnimInput, entityPos: THREE.Vector3): void {
    if (!input.gaze || input.gazeWeight < 0.01) {
      this.gazeYaw = damp(this.gazeYaw, 0, 1.1, dt);
      this.gazePitch = damp(this.gazePitch, 0, 1.1, dt);
      this.gazeHold = 0;
    } else {
      this.tmpV.subVectors(input.gaze, entityPos);
      const wantYaw = shortestAngle(Math.atan2(this.tmpV.x, this.tmpV.z) - input.yaw);
      const horiz = Math.hypot(this.tmpV.x, this.tmpV.z);
      const wantPitch = -Math.atan2(this.tmpV.y - 2.42, Math.max(horiz, 0.01));
      // lock once we're close, then hold dead still until the error grows
      const err = Math.abs(shortestAngle(wantYaw - this.gazeYaw));
      if (err < 0.06) this.gazeHold = Math.min(2.5, this.gazeHold + dt);
      else if (err > 0.22) this.gazeHold = 0;
      if (this.gazeHold < 0.8) {
        const rate = 1.6 + input.detection * 2.2;
        this.gazeYaw = damp(this.gazeYaw, wantYaw, rate, dt);
        this.gazePitch = damp(this.gazePitch, wantPitch, rate, dt);
      }
    }
    const w = input.gazeWeight;
    // distribute across neck + head; clamp so the neck never breaks
    const yaw = THREE.MathUtils.clamp(this.gazeYaw, -1.5, 1.5) * w;
    const pitch = THREE.MathUtils.clamp(this.gazePitch, -0.5, 0.5) * w;
    this.add('neck_1', pitch * 0.30, yaw * 0.34, 0);
    this.add('neck_2', pitch * 0.28, yaw * 0.30, 0);
    this.add('head', pitch * 0.42, yaw * 0.36, 0);
    // beyond ~70° the whole chest turns rather than the neck snapping
    const over = Math.max(0, Math.abs(yaw) - 1.22) * Math.sign(yaw);
    if (over !== 0) {
      this.add('chest', 0, over * 0.5, 0);
      this.add('spine_2', 0, over * 0.3, 0);
    }
  }

  /* ---------------------------------------------------- LAYER 5: extension */

  /**
   * The reserved beat. Elongates one arm chain or the neck by translating the
   * `*_x` joints along their own axis, blended in over ~0.9 s and out over
   * ~1.3 s. Because the mesh is skinned to those joints, the limb genuinely
   * stretches instead of separating.
   *
   * Gating (all three must pass):
   *   1. `input.extensionEligible` — the AI's late-game milestone ceiling
   *   2. cooldown expired (>= 34 s since the last one)
   *   3. an explicit `extensionRequest` from the AI
   */
  private layerExtension(dt: number, input: AnimInput): void {
    this.extensionCooldown -= dt;

    if (!this.beat && input.extensionEligible && input.extensionRequest && this.extensionCooldown <= 0) {
      const roll = input.rand();
      const kind: ExtensionBeat['kind'] = roll < 0.42 ? 'arm-r' : roll < 0.84 ? 'arm-l' : 'neck';
      this.beat = {
        kind,
        amount: kind === 'neck' ? 0.20 + input.rand() * 0.10 : 0.30 + input.rand() * 0.16,
        inT: 0.85 + input.rand() * 0.25,
        holdT: 0.5 + input.rand() * 0.7,
        outT: 1.15 + input.rand() * 0.35,
      };
      this.beatT = 0;
      this.extensionCount++;
      this.extensionCooldown = 34 + input.rand() * 26;
    }

    if (!this.beat) {
      this.beatWeight = damp(this.beatWeight, 0, 4, dt);
      if (this.beatWeight < 0.002) this.beatWeight = 0;
    } else {
      this.beatT += dt;
      const b = this.beat;
      const total = b.inT + b.holdT + b.outT;
      let w: number;
      if (this.beatT < b.inT) {
        const t = this.beatT / b.inT;
        w = t * t * (3 - 2 * t);                       // ease-in-out, never a cut
      } else if (this.beatT < b.inT + b.holdT) {
        w = 1;
      } else {
        const t = (this.beatT - b.inT - b.holdT) / b.outT;
        w = 1 - t * t * (3 - 2 * t);
      }
      this.beatWeight = Math.max(0, Math.min(1, w));
      if (this.beatT >= total) { this.beat = null; this.beatWeight = 0; }
    }

    if (this.beatWeight <= 0.001) return;

    const b = this.beat;
    const kind = b ? b.kind : 'arm-r';
    const amount = (b ? b.amount : 0) * this.beatWeight;

    if (kind === 'neck') {
      // spine_x1/x2 carry the elongation; the neck also cranes forward as it goes
      for (const n of ['spine_x1', 'spine_x2'] as const) {
        const bone = this.rig.byName.get(n)!;
        const spec = this.rig.bind.specs[this.rig.index.get(n)!];
        bone.position.set(spec.pos[0], spec.pos[1] + amount * 0.5, spec.pos[2]);
      }
      this.add('neck_1', amount * 0.55, 0, 0);
      this.add('neck_2', amount * 0.40, 0, 0);
      this.add('head', -amount * 0.30, 0, 0);
    } else {
      const s = kind === 'arm-l' ? 'l' : 'r';
      const sgn = s === 'r' ? 1 : -1;
      for (const n of [`upperarm_x_${s}`, `forearm_x_${s}`]) {
        const bone = this.rig.byName.get(n)!;
        const spec = this.rig.bind.specs[this.rig.index.get(n)!];
        bone.position.set(spec.pos[0], spec.pos[1] - amount * 0.5, spec.pos[2]);
      }
      // and the arm raises toward the player as it extends — the "reach"
      this.add(`clavicle_${s}`, -amount * 0.35, 0, 0);
      this.add(`upperarm_${s}`, -amount * 1.55 * this.beatWeight, sgn * amount * 0.35, sgn * -amount * 0.55);
      this.add(`forearm_${s}`, amount * 0.30, 0, 0);
      this.add(`hand_${s}`, amount * 0.5, 0, 0);
      // fingers splay
      for (let f = 0; f < 5; f++) {
        this.accEnsure(`finger${f}_a_${s}`);
        this.add(`finger${f}_a_${s}`, -amount * 0.6, 0, (f - 2) * amount * 0.35);
      }
    }
  }

  /* ------------------------------------------------------- LAYER 3: footIK */

  /**
   * Two-bone analytic IK per leg + a pelvis drop pass. Runs AFTER the pose is
   * committed, reading the animated foot positions as targets, snapping them to
   * the terrain, then solving the knee. Guarantees quality gate #9: no floating
   * foot, no hyperextended knee, no T-pose leak.
   */
  private solveFootIK(dt: number, input: AnimInput, entityPos: THREE.Vector3): void {
    const legs: ['l' | 'r', number][] = [['l', 0], ['r', 1]];
    let lowest = 0;
    const targets: { x: number; y: number; z: number }[] = [];

    for (const [s, i] of legs) {
      const foot = this.rig.byName.get(`foot_${s}`)!;
      foot.getWorldPosition(this.tmpV);
      const gy = input.groundAt(this.tmpV.x, this.tmpV.z);
      // ankle sits one shoe-height above the ground plane
      const wantY = gy + 0.075;
      targets.push({ x: this.tmpV.x, y: wantY, z: this.tmpV.z });
      lowest = Math.min(lowest, wantY - this.tmpV.y);
      this.footPlant[i].x = this.tmpV.x;
      this.footPlant[i].z = this.tmpV.z;
      this.footPlant[i].y = wantY;
    }

    // Pelvis drops to whichever leg needs the most reach, so the far foot can
    // reach the ground on a slope instead of hovering.
    this.pelvisDrop = damp(this.pelvisDrop, Math.min(0, lowest) * 0.55, 7, dt);
    const pelvis = this.rig.byName.get('pelvis')!;
    const pspec = this.rig.bind.specs[this.rig.index.get('pelvis')!];
    pelvis.position.y = pspec.pos[1] + this.pelvisDrop + this.rootYOffset;
    this.rig.root.updateMatrixWorld(true);

    this.footError = 0;
    for (const [s, i] of legs) {
      this.solveTwoBone(
        `thigh_${s}`, `thigh_x_${s}`, `shin_${s}`, `shin_x_${s}`, `foot_${s}`,
        targets[i]);
    }
    this.rig.root.updateMatrixWorld(true);
    // measure residual error for the QA gate
    for (const [s, i] of legs) {
      const foot = this.rig.byName.get(`foot_${s}`)!;
      foot.getWorldPosition(this.tmpV);
      this.footError = Math.max(this.footError, Math.abs(this.tmpV.y - targets[i].y));
    }
  }

  /**
   * Analytic two-bone IK with a fixed knee-forward hint.
   *
   * The `*_x` joints sit mid-segment, so "upper leg" = thigh→shin distance and
   * "lower leg" = shin→foot distance, both measured in the CURRENT pose (they
   * change during an extension beat, and the solver must respect that).
   */
  private solveTwoBone(
    hipName: string, _hipX: string, kneeName: string, _kneeX: string, footName: string,
    target: { x: number; y: number; z: number },
  ): void {
    const hip = this.rig.byName.get(hipName)!;
    const knee = this.rig.byName.get(kneeName)!;
    const foot = this.rig.byName.get(footName)!;

    const hipW = new THREE.Vector3(), kneeW = new THREE.Vector3(), footW = new THREE.Vector3();
    hip.getWorldPosition(hipW); knee.getWorldPosition(kneeW); foot.getWorldPosition(footW);

    const l1 = hipW.distanceTo(kneeW);
    const l2 = kneeW.distanceTo(footW);
    const tgt = new THREE.Vector3(target.x, target.y, target.z);
    let d = hipW.distanceTo(tgt);
    const maxReach = (l1 + l2) * 0.995;               // never fully lock the knee
    const minReach = Math.abs(l1 - l2) + 0.02;
    if (d > maxReach) {
      tgt.sub(hipW).multiplyScalar(maxReach / d).add(hipW);
      d = maxReach;
    } else if (d < minReach) {
      tgt.sub(hipW).multiplyScalar(minReach / Math.max(d, 1e-4)).add(hipW);
      d = minReach;
    }

    // knee bend angle from the law of cosines
    const cosKnee = THREE.MathUtils.clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1);
    const kneeAngle = Math.PI - Math.acos(cosKnee);
    const cosHip = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
    const hipOffset = Math.acos(cosHip);

    // aim the thigh at the target, then rotate back by hipOffset around the
    // knee axis (character-local X, i.e. knee bends forward)
    const parentQ = new THREE.Quaternion();
    hip.parent!.getWorldQuaternion(parentQ);
    const dirW = tgt.clone().sub(hipW).normalize();
    const dirLocal = dirW.clone().applyQuaternion(parentQ.clone().invert());
    const aim = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirLocal);
    const bendAxis = new THREE.Vector3(1, 0, 0);
    aim.multiply(new THREE.Quaternion().setFromAxisAngle(bendAxis, -hipOffset));
    hip.quaternion.copy(aim);
    knee.quaternion.setFromAxisAngle(bendAxis, kneeAngle);
    hip.updateMatrixWorld(true);

    // level the foot to the ground plane so the sole doesn't tilt off a slope
    foot.getWorldQuaternion(parentQ);
    const footEuler = new THREE.Euler().setFromQuaternion(parentQ, 'XYZ');
    const correct = new THREE.Quaternion().setFromEuler(new THREE.Euler(-footEuler.x * 0.85, 0, 0, 'XYZ'));
    foot.quaternion.premultiply(correct);
  }

  /* ------------------------------------------------------------- utilities */

  private accEnsure(name: string): void {
    if (!this.acc.has(name)) this.acc.set(name, [0, 0, 0]);
  }

  private add(name: string, x: number, y: number, z: number): void {
    let a = this.acc.get(name);
    if (!a) { a = [0, 0, 0]; this.acc.set(name, a); }
    a[0] += x; a[1] += y; a[2] += z;
  }

  /** Diagnostic snapshot for the debug HUD and the QA harness. */
  debug(): {
    state: AnimState; weights: Record<AnimState, number>; stride: number;
    holding: boolean; extension: number; extensionCount: number; footError: number;
    pelvisDrop: number;
  } {
    return {
      state: this.state, weights: { ...this.w }, stride: this.strideBlend,
      holding: this.holding, extension: this.beatWeight,
      extensionCount: this.extensionCount, footError: this.footError,
      pelvisDrop: this.pelvisDrop,
    };
  }
}
