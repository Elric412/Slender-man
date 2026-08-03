/**
 * PALEBARK — coat cloth.
 *
 * Verlet strands, no physics library (the project bans one). Eight strands of
 * four links carry the hem, one two-link strand per sleeve carries the cuff.
 * Each strand integrates in WORLD space so the coat inherits real inertia from
 * the entity's motion, then the positions are converted back into bone
 * rotations.
 *
 * Tuned to hang, not flutter: heavy damping, over-strength gravity, a hard cone
 * limit off straight-down, and wind that only reaches the cloth through a
 * low-passed gust term. The result lags the body by roughly a third of a second
 * — the "beat of lag" the brief asks for — and settles dead still when the
 * entity does, which is what makes its stillness read as unnatural.
 *
 * Fixed 60 Hz substeps: the coat behaves identically at 30 and 144 fps, which
 * matters because the same solver runs on a phone and on a desktop.
 */

import * as THREE from 'three';
import { COAT_LINKS, COAT_STRANDS, PalebarkRigBones } from './PalebarkSkeleton';

interface Strand {
  bones: THREE.Bone[];
  /** world-space particle positions; index 0 = root (kinematic, follows the bone) */
  p: THREE.Vector3[];
  prev: THREE.Vector3[];
  len: number[];
  /** max deviation (radians) from straight-down for each link */
  cone: number;
  /** extra drag on this strand — sleeves are lighter than the hem */
  drag: number;
}

const UP_NEG = new THREE.Vector3(0, -1, 0);

export class PalebarkCloth {
  private strands: Strand[] = [];
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private q = new THREE.Quaternion();
  private qp = new THREE.Quaternion();
  private gust = new THREE.Vector3();
  private accum = 0;
  private bodyCentre = new THREE.Vector3();
  private groundY = 0;
  /** world-space body radius the hem may not pass inside */
  private bodyRadius = 0.185;
  /** debug/QA: peak hem displacement from rest this frame */
  swing = 0;

  constructor(private rig: PalebarkRigBones) {
    for (let i = 0; i < COAT_STRANDS; i++) {
      const bones: THREE.Bone[] = [];
      for (let k = 0; k < COAT_LINKS; k++) bones.push(rig.byName.get(`coat${i}_${k}`)!);
      this.strands.push(this.makeStrand(bones, 0.225, 0.62, 1.0));
    }
    for (const s of ['l', 'r'] as const) {
      const bones = [rig.byName.get(`sleeve_a_${s}`)!, rig.byName.get(`sleeve_b_${s}`)!];
      this.strands.push(this.makeStrand(bones, 0.16, 0.48, 1.25));
    }
    this.reset();
  }

  private makeStrand(bones: THREE.Bone[], linkLen: number, cone: number, drag: number): Strand {
    const p: THREE.Vector3[] = [];
    const prev: THREE.Vector3[] = [];
    const len: number[] = [];
    for (let k = 0; k <= bones.length; k++) {
      p.push(new THREE.Vector3());
      prev.push(new THREE.Vector3());
      if (k > 0) len.push(linkLen);
    }
    return { bones, p, prev, len, cone, drag };
  }

  /** Snap every particle to the current bind/pose position — call on warp/respawn. */
  reset(): void {
    for (const s of this.strands) for (const b of s.bones) b.quaternion.identity();
    this.rig.root.updateMatrixWorld(true);
    for (const s of this.strands) {
      s.bones[0].getWorldPosition(s.p[0]);
      s.prev[0].copy(s.p[0]);
      for (let k = 1; k < s.p.length; k++) {
        if (k < s.bones.length) {
          s.bones[k].getWorldPosition(s.p[k]);
        } else {
          // final particle: extend the last bone's local -Y by its link length
          s.bones[k - 1].getWorldQuaternion(this.q);
          this.tmpA.copy(UP_NEG).applyQuaternion(this.q).multiplyScalar(s.len[k - 1]);
          s.p[k].copy(s.p[k - 1]).add(this.tmpA);
        }
        s.prev[k].copy(s.p[k]);
      }
    }
    this.accum = 0;
    this.gust.set(0, 0, 0);
    this.swing = 0;
  }

  /**
   * @param dt          frame delta
   * @param wind        world wind vector (the vegetation system's value works directly)
   * @param groundY     terrain height under the entity
   * @param bodyCentre  world pelvis position (the collision capsule's axis)
   * @param bodyVel     world velocity of the body — drives the swing
   */
  update(dt: number, wind: THREE.Vector3, groundY: number, bodyCentre: THREE.Vector3, bodyVel: THREE.Vector3): void {
    this.groundY = groundY;
    this.bodyCentre.copy(bodyCentre);
    // Low-pass the wind hard. A field coat in wool does not respond to gusts on
    // a per-frame basis; it responds to the swell behind them.
    this.gust.lerp(this.tmpA.copy(wind).addScaledVector(bodyVel, -0.55), Math.min(1, dt * 0.8));

    const STEP = 1 / 60;
    this.accum = Math.min(this.accum + dt, 0.08);   // never simulate more than 5 substeps
    let steps = 0;
    while (this.accum >= STEP && steps < 5) {
      this.accum -= STEP;
      steps++;
      this.step(STEP);
    }
    if (steps > 0) this.applyToBones();
  }

  private step(dt: number): void {
    // Deliberately heavier than real gravity. Real 9.81 with this damping reads
    // as light fabric; this reads as soaked wool.
    const gravity = -16.5;
    const damp = 0.885;
    let swing = 0;
    for (const s of this.strands) {
      // root particle is kinematic: it goes wherever the body put the bone
      s.bones[0].getWorldPosition(s.p[0]);
      s.prev[0].copy(s.p[0]);
      for (let k = 1; k < s.p.length; k++) {
        const p = s.p[k], pr = s.prev[k];
        this.tmpA.subVectors(p, pr).multiplyScalar(damp);
        pr.copy(p);
        p.add(this.tmpA);
        p.y += gravity * dt * dt;
        // wind bites harder further down the strand (longer lever arm)
        p.addScaledVector(this.gust, dt * dt * 5.2 * s.drag * (0.35 + k * 0.35));
      }
      // ---- constraints, 3 relaxation passes ----
      for (let iter = 0; iter < 3; iter++) {
        // link length; parent is authoritative so the strand can't stretch
        for (let k = 1; k < s.p.length; k++) {
          const a = s.p[k - 1], b = s.p[k];
          this.tmpA.subVectors(b, a);
          const d = this.tmpA.length() || 1e-5;
          b.addScaledVector(this.tmpA, -(d - s.len[k - 1]) / d);
        }
        // cone limit off straight-down: stops the coat folding up over itself
        for (let k = 1; k < s.p.length; k++) {
          const a = s.p[k - 1], b = s.p[k];
          this.tmpA.subVectors(b, a).normalize();
          const cosMax = Math.cos(s.cone);
          if (-this.tmpA.y < cosMax) {
            this.tmpB.set(this.tmpA.x, 0, this.tmpA.z);
            const hl = this.tmpB.length();
            const sinMax = Math.sqrt(Math.max(0, 1 - cosMax * cosMax));
            if (hl > 1e-4) this.tmpB.multiplyScalar(sinMax / hl);
            else this.tmpB.set(sinMax, 0, 0);
            this.tmpB.y = -cosMax;
            b.copy(a).addScaledVector(this.tmpB, s.len[k - 1]);
          }
        }
        // body capsule push-out — the coat never clips into the torso
        for (let k = 1; k < s.p.length; k++) {
          const b = s.p[k];
          const dx = b.x - this.bodyCentre.x, dz = b.z - this.bodyCentre.z;
          const r = Math.hypot(dx, dz);
          // capsule narrows toward the ankles so the hem can close in below the knee
          const drop = Math.min(1, Math.max(0, (this.bodyCentre.y - b.y) / 1.15));
          const want = this.bodyRadius * (1 - drop * 0.30);
          if (r < want) {
            if (r > 1e-4) { b.x = this.bodyCentre.x + (dx / r) * want; b.z = this.bodyCentre.z + (dz / r) * want; }
            else { b.x = this.bodyCentre.x + want; }
          }
        }
        // and never sinks into the ground
        for (let k = 1; k < s.p.length; k++) {
          if (s.p[k].y < this.groundY + 0.015) s.p[k].y = this.groundY + 0.015;
        }
      }
      // swing metric: how far the tip is from directly below its root
      const tip = s.p[s.p.length - 1], root = s.p[0];
      swing = Math.max(swing, Math.hypot(tip.x - root.x, tip.z - root.z));
    }
    this.swing = swing;
  }

  /** Aim each bone at its child particle: world positions → local bone rotations. */
  private applyToBones(): void {
    for (const s of this.strands) {
      for (let k = 0; k < s.bones.length; k++) {
        const bone = s.bones[k];
        this.tmpA.subVectors(s.p[k + 1], s.p[k]);
        if (this.tmpA.lengthSq() < 1e-9) continue;
        this.tmpA.normalize();
        this.q.setFromUnitVectors(UP_NEG, this.tmpA);
        // local = parentWorld⁻¹ * desiredWorld
        bone.parent!.getWorldQuaternion(this.qp);
        bone.quaternion.copy(this.qp.invert()).multiply(this.q);
        bone.updateMatrixWorld(true);
      }
    }
  }
}
