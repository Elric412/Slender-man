import * as THREE from 'three';
import { NavWorld } from './NavWorld';
import { CollisionWorld } from '../physics/Collision';
import { HeightField } from '../world/HeightField';
import { SeededRandom } from '../core/SeededRandom';

export type EntityState = 'dormant' | 'investigating' | 'stalking' | 'confronting';

export interface SoundEvent {
  x: number; z: number; loudness: number; // 0..1
}

export interface EntitySnapshot {
  state: EntityState;
  detection: number;      // 0..1 accumulated
  x: number; y: number; z: number;
  visibleToPlayer: boolean;
  distToPlayer: number;
  speed: number;
}

/**
 * Palebark — a perceiving presence.
 * Real pathfinding, FOV cone + LOS raycasts, hearing with positional uncertainty,
 * gradual detection accumulation, staged escalation. No appearance timers; every
 * approach is walked. (One guarded exception: relocation when unobserved & far,
 * always to a plausible position off the player's recent path.)
 */
export class EntityBrain {
  state: EntityState = 'dormant';
  detection = 0;
  pos = new THREE.Vector3();
  yaw = 0;

  private nav: NavWorld;
  private col: CollisionWorld;
  private hf: HeightField;
  private rng: SeededRandom;

  private path: number[] = [];
  private pathIdx = 0;
  private pathScratch: number[] = [];
  private wp = { x: 0, z: 0 };
  private target = new THREE.Vector3();      // current goal
  private investigatePoint = new THREE.Vector3();
  private investigateTimer = 0;
  private repathTimer = 0;
  private suspicion = 0;                     // short-term "I notice something"
  private lastKnownPlayer = new THREE.Vector3();
  private hasLastKnown = false;
  private lookAtTimer = 0;                   // how long player has been looking at it
  private freezeTimer = 0;                   // freezes when observed closely (Weeping-angel-ish restraint)
  private relocateCooldown = 0;
  private glimpseRequested = false;
  private confrontCommitted = false;
  private escalation = 0;                    // rises with tapes collected (0..1)
  private visitMemory: number[] = [];        // recently visited POI timestamps

  // tunables
  private readonly walkSpeed = 2.2;
  private readonly stalkSpeed = 3.0;
  private readonly confrontSpeed = 4.6;
  private readonly eyeHeight = 2.6;

  onGlimpse: (() => void) | null = null;
  onCaptured: (() => void) | null = null;
  onFootfall: ((x: number, z: number, dist: number) => void) | null = null;

  constructor(nav: NavWorld, col: CollisionWorld, hf: HeightField, seed: number) {
    this.nav = nav; this.col = col; this.hf = hf;
    this.rng = new SeededRandom(seed ^ 0xE77177);
    this.respawnFar(new THREE.Vector3(hf.layout.spawn.x, 0, hf.layout.spawn.z));
  }

  respawnFar(playerPos: THREE.Vector3): void {
    // place at a POI far from spawn
    const zones = this.hf.layout.zones;
    let best = zones[0], bd = -1;
    for (const z of zones) {
      const d = Math.hypot(z.x - playerPos.x, z.z - playerPos.z);
      if (d > bd) { bd = d; best = z; }
    }
    this.pos.set(best.x + this.rng.range(-8, 8), 0, best.z + this.rng.range(-8, 8));
    this.pos.y = this.hf.heightAt(this.pos.x, this.pos.z);
    this.state = 'dormant';
    this.detection = 0;
    this.suspicion = 0;
    this.hasLastKnown = false;
    this.path.length = 0;
    this.escalation = 0;
    this.confrontCommitted = false;
  }

  setEscalation(t: number): void { this.escalation = Math.max(0, Math.min(1, t)); }

  /** consume a gameplay sound event */
  hear(ev: SoundEvent): void {
    const d = Math.hypot(ev.x - this.pos.x, ev.z - this.pos.z);
    const radius = 8 + ev.loudness * 55;          // loud events travel far
    if (d > radius) return;
    const certainty = Math.max(0.25, 1 - d / radius);
    // positional uncertainty — not a perfect ping
    const err = (1 - certainty) * 14;
    this.investigatePoint.set(
      ev.x + this.rng.range(-err, err), 0, ev.z + this.rng.range(-err, err));
    this.suspicion = Math.min(1, this.suspicion + ev.loudness * certainty * 1.2);
    if (this.state === 'dormant' || this.state === 'stalking') {
      if (this.suspicion > 0.35) {
        this.state = 'investigating';
        this.investigateTimer = 20 + this.rng.range(0, 10);
        this.path.length = 0;
      }
    }
  }

  /** player collected a tape — the forest notices */
  notifyTapePickup(x: number, z: number): void {
    this.setEscalation(this.escalation + 0.14);
    this.hear({ x, z, loudness: 0.55 });
    this.suspicion = Math.min(1, this.suspicion + 0.25);
    if (this.state === 'dormant' && this.escalation > 0.2) this.state = 'stalking';
  }

  update(dt: number, player: { pos: THREE.Vector3; eyeY: number; fwd: THREE.Vector3; sprinting: boolean; moving: boolean; lightOn: boolean }, time: number): EntitySnapshot {
    this.repathTimer -= dt;
    this.relocateCooldown -= dt;
    this.investigateTimer -= dt;

    const pp = player.pos;
    const dist = Math.hypot(pp.x - this.pos.x, pp.z - this.pos.z);

    // ================= PERCEPTION =================
    let visFactor = 0;
    if (dist < 90) {
      // entity vision: wide FOV, distance falloff, LOS against geometry
      const dx = pp.x - this.pos.x, dz = pp.z - this.pos.z;
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const dot = (dx * fx + dz * fz) / Math.max(dist, 0.01);
      const inFov = dot > Math.cos(1.35); // ~155° total
      if (inFov || dist < 6) {
        const eyeY = this.pos.y + this.eyeHeight;
        if (this.col.losClear(this.pos.x, eyeY, this.pos.z, pp.x, player.eyeY, pp.z)) {
          visFactor = Math.max(0, 1 - dist / 90);
          if (player.lightOn && dist < 45) visFactor *= 1.8;  // beam gives the player away
          if (player.sprinting) visFactor *= 1.5;
          if (dist < 7) visFactor = 2.0;
        }
      }
    }

    // detection accumulates, decays when unseen
    if (visFactor > 0) {
      this.detection = Math.min(1, this.detection + visFactor * dt * (0.10 + this.escalation * 0.16));
      this.suspicion = Math.min(1, this.suspicion + visFactor * dt * 0.8);
      this.lastKnownPlayer.copy(pp);
      this.hasLastKnown = true;
    } else {
      this.detection = Math.max(0, this.detection - dt * 0.035);
      this.suspicion = Math.max(0, this.suspicion - dt * 0.05);
    }

    // is the player looking at Palebark? (for glimpse requests + freeze behavior)
    const toEntX = this.pos.x - pp.x, toEntZ = this.pos.z - pp.z;
    const lookDot = (toEntX * player.fwd.x + toEntZ * player.fwd.z) / Math.max(Math.hypot(toEntX, toEntZ), 0.01);
    const playerLooking = lookDot > 0.94 && dist < 60 &&
      this.col.losClear(pp.x, player.eyeY, pp.z, this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
    if (playerLooking) {
      this.lookAtTimer += dt;
      if (this.lookAtTimer > 0.4 && this.rng.next() < dt * 0.5 && this.detection > 0.15) {
        this.glimpseRequested = true;
      }
      // close observation makes it hold unnaturally still
      if (dist < 16 && this.detection < 0.8) this.freezeTimer = Math.min(2.5, this.freezeTimer + dt * 3);
    } else {
      this.lookAtTimer = Math.max(0, this.lookAtTimer - dt * 2);
      this.freezeTimer = Math.max(0, this.freezeTimer - dt * 1.5);
    }

    // ================= STATE MACHINE =================
    switch (this.state) {
      case 'dormant': {
        // drift between POIs; escalate with time + tapes
        if (this.escalation > 0.12 || this.detection > 0.1 || this.suspicion > 0.3) {
          this.state = 'stalking'; this.path.length = 0;
        } else if (this.path.length === 0 && this.rng.next() < dt * 0.05) {
          const zn = this.rng.pick(this.hf.layout.zones);
          this.target.set(zn.x + this.rng.range(-6, 6), 0, zn.z + this.rng.range(-6, 6));
          this.requestPath();
        }
        break;
      }
      case 'investigating': {
        this.target.copy(this.investigatePoint);
        if (this.path.length === 0) this.requestPath();
        if (this.investigateTimer <= 0) {
          // nothing found → fall back to stalking with accumulated suspicion
          this.state = this.detection > 0.15 || this.escalation > 0.3 ? 'stalking' : 'dormant';
          this.path.length = 0;
        }
        if (this.detection > 0.55) { this.state = 'confronting'; this.confrontCommitted = false; this.path.length = 0; }
        break;
      }
      case 'stalking': {
        // shadow the player's general path — target a point offset from last-known position,
        // never perfectly on top of the player; keeps sightings partial
        if (this.hasLastKnown) {
          const ang = Math.atan2(this.pos.x - this.lastKnownPlayer.x, this.pos.z - this.lastKnownPlayer.z);
          const offsetDist = Math.max(10, 26 - this.escalation * 14);
          this.target.set(
            this.lastKnownPlayer.x + Math.sin(ang) * offsetDist,
            0,
            this.lastKnownPlayer.z + Math.cos(ang) * offsetDist);
          if (this.repathTimer <= 0) { this.requestPath(); this.repathTimer = 2.5 + this.rng.range(0, 1.5); }
        } else if (this.path.length === 0 && this.rng.next() < dt * 0.1) {
          const zn = this.rng.pick(this.hf.layout.zones);
          this.target.set(zn.x, 0, zn.z);
          this.requestPath();
        }
        if (this.detection > 0.6) { this.state = 'confronting'; this.confrontCommitted = false; this.path.length = 0; }
        if (this.detection <= 0.02 && this.suspicion <= 0.05 && this.escalation < 0.25) this.state = 'dormant';
        break;
      }
      case 'confronting': {
        // deliberate close — updates frequently toward actual player position if perceiving,
        // else last-known. Committed once close: no polite stopping.
        if (!this.confrontCommitted) {
          if (visFactor > 0 || this.hasLastKnown) {
            this.target.copy(visFactor > 0 ? pp : this.lastKnownPlayer);
            if (this.repathTimer <= 0) { this.requestPath(); this.repathTimer = 1.2; }
          }
          if (dist < 14) this.confrontCommitted = true;
          if (this.detection < 0.3) { this.state = 'stalking'; this.path.length = 0; }
        } else {
          // final approach — steer directly (still collision-resolved, still walked)
          this.target.copy(pp);
          this.path.length = 0;
        }
        // capture
        if (dist < 1.6 && Math.abs(pp.y - this.pos.y) < 2.6) {
          this.onCaptured?.();
        }
        break;
      }
    }

    // ================= MOVEMENT =================
    let speed = 0;
    if (this.freezeTimer > 0.2 && this.state !== 'confronting') {
      speed = 0; // held still under the player's gaze
    } else {
      switch (this.state) {
        case 'dormant': speed = this.walkSpeed * 0.7; break;
        case 'investigating': speed = this.walkSpeed; break;
        case 'stalking': speed = this.stalkSpeed; break;
        case 'confronting': speed = this.confrontCommitted ? this.confrontSpeed : this.stalkSpeed * 1.2; break;
      }
    }

    if (speed > 0) {
      let tx: number, tz: number;
      if (this.state === 'confronting' && this.confrontCommitted) {
        tx = this.target.x; tz = this.target.z;
      } else if (this.pathIdx < this.path.length) {
        this.nav.world(this.path[this.pathIdx], this.wp);
        tx = this.wp.x; tz = this.wp.z;
        if (Math.hypot(tx - this.pos.x, tz - this.pos.z) < this.nav.step * 0.7) {
          this.pathIdx++;
          if (this.pathIdx >= this.path.length) { this.path.length = 0; tx = this.pos.x; tz = this.pos.z; }
        }
      } else { tx = this.pos.x; tz = this.pos.z; }

      const mdx = tx - this.pos.x, mdz = tz - this.pos.z;
      const ml = Math.hypot(mdx, mdz);
      if (ml > 0.05) {
        const vx = (mdx / ml) * speed * dt, vz = (mdz / ml) * speed * dt;
        this.pos.x += vx; this.pos.z += vz;
        // resolve against static geometry
        const p2 = { x: this.pos.x, z: this.pos.z };
        this.col.resolve(p2, 0.5, this.pos.y, 2.8);
        this.pos.x = p2.x; this.pos.z = p2.z;
        // face travel direction (smoothly)
        const desiredYaw = Math.atan2(mdx, mdz);
        let dy = desiredYaw - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yaw += dy * Math.min(1, dt * 4);
      }
      // occasional distant footfall audio cue
      if (this.rng.next() < dt * (speed / 9) && dist < 55 && dist > 6) {
        this.onFootfall?.(this.pos.x, this.pos.z, dist);
      }
    } else if (this.state === 'confronting' || this.detection > 0.4) {
      // stand facing the player — the worst version of stillness
      const desiredYaw = Math.atan2(pp.x - this.pos.x, pp.z - this.pos.z);
      let dy = desiredYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, dt * 2);
    }

    this.pos.y = this.hf.heightAt(this.pos.x, this.pos.z);

    // ================= RELOCATION (guarded) =================
    // If it has lingered far away, unseen, while stalking — re-insert closer to the
    // player's flank, never ahead on their exact path, never within sight.
    if (this.state === 'stalking' && this.relocateCooldown <= 0 && dist > 70) {
      this.relocateCooldown = 14;
      for (let attempt = 0; attempt < 8; attempt++) {
        const ang = this.rng.range(0, Math.PI * 2);
        const r = this.rng.range(32, 48);
        const nx = pp.x + Math.sin(ang) * r, nz = pp.z + Math.cos(ang) * r;
        // must be out of player's current view
        const rx = nx - pp.x, rz = nz - pp.z;
        const rl = Math.hypot(rx, rz);
        const viewDot = (rx * player.fwd.x + rz * player.fwd.z) / rl;
        if (viewDot > 0.35) continue;
        // must have cover (no clean LOS from player)
        if (this.col.losClear(pp.x, player.eyeY, pp.z, nx, this.hf.heightAt(nx, nz) + 2, nz)) continue;
        const cell = this.nav.nearestWalkable(nx, nz);
        this.nav.world(cell, this.wp);
        this.pos.set(this.wp.x, 0, this.wp.z);
        this.pos.y = this.hf.heightAt(this.pos.x, this.pos.z);
        this.path.length = 0;
        break;
      }
    }

    // glimpse dispatch
    let glimpse = false;
    if (this.glimpseRequested) { glimpse = true; this.glimpseRequested = false; this.onGlimpse?.(); }

    return {
      state: this.state, detection: this.detection,
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      visibleToPlayer: playerLooking, distToPlayer: dist, speed,
    };
  }

  private requestPath(): void {
    this.nav.findPath(this.pos.x, this.pos.z, this.target.x, this.target.z, this.pathScratch);
    // copy into path buffer, skip first (current cell)
    this.path.length = 0;
    for (let i = 1; i < this.pathScratch.length; i++) this.path.push(this.pathScratch[i]);
    this.pathIdx = 0;
  }
}
