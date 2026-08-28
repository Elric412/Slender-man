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
  /** which milestone act the run is in (see MILESTONES) */
  act: 0 | 1 | 2;
  /** the extension/reach beat may play at all */
  extensionEligible: boolean;
  /** the brain is asking for the extension beat *this frame* */
  extensionRequest: boolean;
}

/**
 * ============================================================================
 * Milestone escalation curve
 * ============================================================================
 *
 * Adapted from the pacing model of the 2012 forest-horror lineage: what changes
 * over a run is not the entity's *speed* but the size of its permitted
 * vocabulary. Real perception still gates every individual moment — the
 * milestone only sets the **ceiling**.
 *
 * The distinction matters because it is the difference between a stalker and a
 * difficulty slider. If the milestone drove detection directly, late game would
 * just be "the monster is faster", and players would learn to read a number. By
 * capping the vocabulary instead, an early-game player who is genuinely careless
 * still gets investigated aggressively; they simply never get confronted. And a
 * late-game player who is genuinely careful still sees nothing, because LOS and
 * detection have not been relaxed for them.
 *
 * Act 0 (0–2 tapes)  dormant + investigate only. Rare, brief, distant sightings.
 *                    Never repositions into the player's forward view.
 * Act 1 (3–5 tapes)  stalk unlocked. Repositioning is *walked*, never instant.
 * Act 2 (6–8 tapes)  confront unlocked, may close directly, may appear ahead,
 *                    extension/reach becomes eligible.
 */
export const MILESTONES = {
  /** tape count at which stalking becomes available */
  stalk: 3,
  /** tape count at which confronting + extension become available */
  confront: 6,
} as const;

function actForTapes(tapes: number): 0 | 1 | 2 {
  if (tapes >= MILESTONES.confront) return 2;
  if (tapes >= MILESTONES.stalk) return 1;
  return 0;
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

  // ---- milestone escalation ----
  /** tapes collected; the *only* input to the vocabulary ceiling */
  private tapes = 0;
  private act: 0 | 1 | 2 = 0;
  /** cooldown so the reach beat stays a rare punctuation, not a mechanic */
  private extensionCooldown = 0;
  private extensionRequest = false;

  // ---- anti-repetition ----
  /**
   * Per-run seeded jitter. Every discretionary choice (which POI, how long to
   * hold, which flank to route around) draws from this, so two runs with the
   * same player route still differ. Without it, "real perception" produces
   * *deterministic* perception, and a second playthrough becomes a memory test.
   */
  private variation: SeededRandom;
  /** world positions of confirmed sightings this run, to refuse repeats */
  private sightingSites: { x: number; z: number; t: number }[] = [];
  /** idle-hold duration currently in force, re-rolled each time it expires */
  private holdFor = 0;
  /** angular offset of the stalk flank, and a range multiplier; both re-rolled */
  private stalkBias = 0;
  private stalkRange = 1;

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
    // Forked from a *different* salt than `rng`: movement noise and choice noise
    // must not correlate, or the entity's route would predict its decisions.
    this.variation = new SeededRandom(seed ^ 0x9E3779B9);
    this.respawnFar(new THREE.Vector3(hf.layout.spawn.x, 0, hf.layout.spawn.z));
  }

  /**
   * Re-seed the discretionary choices for a new run.
   *
   * The world seed stays fixed (the map must be consistent and benchmarkable),
   * so this is the *only* thing that makes run 2 differ from run 1.
   */
  reseed(runSeed: number): void {
    this.variation = new SeededRandom(runSeed ^ 0x9E3779B9);
    this.sightingSites.length = 0;
    this.tapes = 0;
    this.act = 0;
    this.extensionCooldown = 0;
    this.extensionRequest = false;
    this.holdFor = 0;
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
    this.extensionCooldown = 0;
    this.extensionRequest = false;
  }

  setEscalation(t: number): void { this.escalation = Math.max(0, Math.min(1, t)); }

  /** Current milestone act (0 early / 1 mid / 2 late). */
  get currentAct(): 0 | 1 | 2 { return this.act; }

  /**
   * Highest state the milestone permits right now.
   *
   * Every transition in the state machine is filtered through this, so there is
   * exactly one place that decides "is this even allowed yet" — as opposed to
   * sprinkling `if (tapes > n)` through the transitions, which is how a stray
   * early-game confront eventually ships.
   */
  private ceiling(): EntityState {
    if (this.act >= 2) return 'confronting';
    if (this.act >= 1) return 'stalking';
    return 'investigating';
  }

  private static readonly ORDER: Record<EntityState, number> = {
    dormant: 0, investigating: 1, stalking: 2, confronting: 3,
  };

  /** Clamp a desired state to the milestone ceiling. */
  private permit(desired: EntityState): EntityState {
    const cap = EntityBrain.ORDER[this.ceiling()];
    return EntityBrain.ORDER[desired] <= cap ? desired : this.ceiling();
  }

  /** May the reach beat play at all? Late act only. */
  get extensionEligible(): boolean { return this.act >= 2; }

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
        // Seeded, so how long it persists at a noise differs run to run. A fixed
        // 20 s would teach players exactly how long to stay hidden.
        this.investigateTimer = 14 + this.variation.range(0, 18);
        this.path.length = 0;
      }
    }
  }

  /** player collected a tape — the forest notices */
  notifyTapePickup(x: number, z: number): void {
    this.tapes++;
    this.act = actForTapes(this.tapes);
    this.setEscalation(this.escalation + 0.14);
    this.hear({ x, z, loudness: 0.55 });
    this.suspicion = Math.min(1, this.suspicion + 0.25);
    // Crossing into act 1 is what unlocks stalking; before that a pickup can
    // only ever provoke an investigation.
    if (this.state === 'dormant' && this.escalation > 0.2) {
      this.state = this.permit('stalking');
    }
  }

  /**
   * Has a confirmed sighting already happened near here this run?
   *
   * Quality gate #6 asks that no two sightings in one run be identical. Position
   * is the strongest component of a sighting's identity \u2014 the same figure at the
   * same treeline reads as a repeated cutscene even if the timing differs \u2014 so
   * candidate positions within 18 m of a previous one are refused.
   */
  private sightingTooFamiliar(x: number, z: number): boolean {
    for (const s of this.sightingSites) {
      if (Math.hypot(s.x - x, s.z - z) < 18) return true;
    }
    return false;
  }

  /** Pick a fresh flank + standoff distance for the stalk arc. */
  private rollStalkBias(): void {
    // Deliberately never 0: a bias of exactly 0 is "directly behind", which is
    // both the most obvious place to check and the least interesting sightline.
    const mag = this.variation.range(0.35, 1.5);
    this.stalkBias = this.variation.next() < 0.5 ? -mag : mag;
    this.stalkRange = this.variation.range(0.8, 1.35);
  }

  private recordSighting(x: number, z: number, t: number): void {
    this.sightingSites.push({ x, z, t });
    // Bounded: after a dozen the map is saturated and refusing more would just
    // freeze the entity in place.
    if (this.sightingSites.length > 12) this.sightingSites.shift();
  }

  update(dt: number, player: { pos: THREE.Vector3; eyeY: number; fwd: THREE.Vector3; sprinting: boolean; moving: boolean; lightOn: boolean }, time: number): EntitySnapshot {
    this.repathTimer -= dt;
    this.relocateCooldown -= dt;
    this.investigateTimer -= dt;
    this.extensionCooldown -= dt;
    this.holdFor -= dt;
    this.extensionRequest = false;

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
      // Sighting frequency is milestone-scaled, and act 0 additionally requires
      // *distance*: early-game sightings must be rare and far, so the player is
      // never sure they saw anything. Later acts allow closer, more frequent
      // confirmation because by then ambiguity has done its job.
      const rate = this.act >= 2 ? 0.7 : this.act >= 1 ? 0.42 : 0.16;
      const farEnough = this.act >= 1 || dist > 28;
      if (this.lookAtTimer > 0.4 && farEnough
          && this.rng.next() < dt * rate && this.detection > 0.15) {
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
        // Drift between POIs; escalate with time + tapes. In act 0 `permit`
        // collapses the stalk request down to an investigation, which is what
        // makes early game feel like something is *wandering* rather than
        // hunting.
        if (this.escalation > 0.12 || this.detection > 0.1 || this.suspicion > 0.3) {
          this.state = this.permit('stalking'); this.path.length = 0;
        } else if (this.path.length === 0 && this.holdFor <= 0
                   && this.rng.next() < dt * 0.05) {
          const zn = this.variation.pick(this.hf.layout.zones);
          this.target.set(
            zn.x + this.variation.range(-9, 9), 0, zn.z + this.variation.range(-9, 9));
          this.requestPath();
          // Re-roll the next hold. Multi-second and variable: a fixed cadence is
          // the single clearest tell that a wanderer is on a timer.
          this.holdFor = this.variation.range(3, 11);
        }
        break;
      }
      case 'investigating': {
        this.target.copy(this.investigatePoint);
        if (this.path.length === 0) this.requestPath();
        if (this.investigateTimer <= 0) {
          // nothing found → fall back to stalking with accumulated suspicion
          const want: EntityState =
            this.detection > 0.15 || this.escalation > 0.3 ? 'stalking' : 'dormant';
          this.state = this.permit(want);
          this.path.length = 0;
        }
        if (this.detection > 0.55) {
          const next = this.permit('confronting');
          if (next !== this.state) { this.state = next; this.confrontCommitted = false; this.path.length = 0; }
        }
        break;
      }
      case 'stalking': {
        // shadow the player's general path — target a point offset from last-known position,
        // never perfectly on top of the player; keeps sightings partial
        if (this.hasLastKnown) {
          // Shadow from a *flank*, not from directly behind. The seeded angular
          // bias is what stops the entity converging on the same relative
          // bearing every run — a fixed bearing is learnable, and once learned
          // the player simply never looks that way again.
          const ang = Math.atan2(this.pos.x - this.lastKnownPlayer.x, this.pos.z - this.lastKnownPlayer.z)
            + this.stalkBias;
          const offsetDist = Math.max(10, 26 - this.escalation * 14) * this.stalkRange;
          this.target.set(
            this.lastKnownPlayer.x + Math.sin(ang) * offsetDist,
            0,
            this.lastKnownPlayer.z + Math.cos(ang) * offsetDist);
          if (this.repathTimer <= 0) {
            this.requestPath();
            this.repathTimer = 2.5 + this.variation.range(0, 2.5);
            // Re-roll the flank occasionally so a long stalk isn't one arc.
            if (this.variation.next() < 0.25) this.rollStalkBias();
          }
        } else if (this.path.length === 0 && this.rng.next() < dt * 0.1) {
          const zn = this.variation.pick(this.hf.layout.zones);
          this.target.set(
            zn.x + this.variation.range(-7, 7), 0, zn.z + this.variation.range(-7, 7));
          this.requestPath();
        }
        if (this.detection > 0.6) {
          const next = this.permit('confronting');
          if (next !== this.state) { this.state = next; this.confrontCommitted = false; this.path.length = 0; }
        }
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
    //
    // Act 0 never relocates at all: early game must feel like a thing that is
    // somewhere else, and a repositioning entity is precisely the thing the
    // brief forbids while the player still has 0–2 tapes.
    if (this.act >= 1 && this.state === 'stalking' && this.relocateCooldown <= 0 && dist > 70) {
      this.relocateCooldown = 14;
      // Act 1 may not place itself anywhere near the forward view; act 2 may.
      // `viewDot` is the cosine to the player's facing, so a lower cap is a
      // stricter "stay out of sight".
      const viewCap = this.act >= 2 ? 0.62 : 0.20;
      for (let attempt = 0; attempt < 10; attempt++) {
        const ang = this.variation.range(0, Math.PI * 2);
        const r = this.variation.range(32, 52);
        const nx = pp.x + Math.sin(ang) * r, nz = pp.z + Math.cos(ang) * r;
        // must be out of player's current view
        const rx = nx - pp.x, rz = nz - pp.z;
        const rl = Math.hypot(rx, rz);
        const viewDot = (rx * player.fwd.x + rz * player.fwd.z) / rl;
        if (viewDot > viewCap) continue;
        // must have cover (no clean LOS from player)
        if (this.col.losClear(pp.x, player.eyeY, pp.z, nx, this.hf.heightAt(nx, nz) + 2, nz)) continue;
        // and must not re-stage a sighting the player has already had
        if (this.sightingTooFamiliar(nx, nz)) continue;
        const cell = this.nav.nearestWalkable(nx, nz);
        this.nav.world(cell, this.wp);
        this.pos.set(this.wp.x, 0, this.wp.z);
        this.pos.y = this.hf.heightAt(this.pos.x, this.pos.z);
        this.path.length = 0;
        break;
      }
    }

    // ================= EXTENSION / REACH =================
    // The reserved beat. Requested by the brain, still gated by the animator's
    // own cooldown, so both halves have to agree before it plays.
    //
    // Conditions are deliberately narrow: late act, actually being looked at,
    // high detection, mid-range (too far and the silhouette change is invisible;
    // too close and it reads as an attack animation, which it is not). The
    // probability is per-second, not per-frame, so frame rate cannot change how
    // often it happens.
    if (this.extensionEligible && this.extensionCooldown <= 0
        && playerLooking && this.detection > 0.55
        && dist > 8 && dist < 34 && speed < 0.6) {
      if (this.rng.next() < dt * 0.09) {
        this.extensionRequest = true;
        this.extensionCooldown = 40 + this.variation.range(0, 25);
      }
    }

    // glimpse dispatch
    if (this.glimpseRequested) {
      this.glimpseRequested = false;
      this.recordSighting(this.pos.x, this.pos.z, time);
      this.onGlimpse?.();
    }

    return {
      state: this.state, detection: this.detection,
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      visibleToPlayer: playerLooking, distToPlayer: dist, speed,
      act: this.act,
      extensionEligible: this.extensionEligible,
      extensionRequest: this.extensionRequest,
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
