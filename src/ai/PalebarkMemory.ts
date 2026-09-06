/**
 * ============================================================================
 * PALEBARK MEMORY — a belief about where the player is, not the answer
 * ============================================================================
 *
 * ## Why the old brain felt like it was cheating
 *
 * `EntityBrain` kept a single `lastKnownPlayer` vector that was overwritten
 * with the player's *exact* position every frame it had line of sight, and a
 * `hasLastKnown` flag that never expired. The consequences compounded:
 *
 *   - Breaking contact was meaningless. The belief stayed pinpoint-accurate
 *     forever, so hiding only postponed the arrival.
 *   - There was no such thing as being wrong, so there was no such thing as
 *     outwitting it — and a stalker you cannot outwit is a timer.
 *   - Because it was always right, its correct guesses carried no weight
 *     either. Being found is only chilling if being missed was possible.
 *
 * ## What this models instead
 *
 * A belief with four properties: a position, an age, a confidence, and an
 * estimated heading. Confidence decays continuously and is the *only* thing
 * that grants precision — the position Palebark actually acts on is the true
 * last-known point plus an error term that grows as confidence falls. So a
 * fresh visual gives it a fix; forty seconds later it is searching a
 * twenty-metre-wide guess; a minute after that it has nothing and goes back to
 * patrolling the forest.
 *
 * ## Prediction, and the deliberate mistake
 *
 * `predict()` extrapolates the player's heading, snaps toward whichever nearby
 * landmark best matches that heading (people walk to places, not along
 * bearings), and then — with a configured probability — commits to the
 * *second* best candidate instead.
 *
 * That last part is the most important line of code in this file. A predictor
 * that is always right is a tracker, and a tracker is a puzzle: the player
 * solves it once and then routes around it forever. A predictor that is right
 * most of the time and occasionally waits at the path you *almost* took is
 * something else entirely, because the near-misses are indistinguishable from
 * the hits until after the fact. "It was waiting at the fork I didn't choose"
 * is a better story than "it knew", and it is also the honest description of
 * what an intelligent thing with incomplete information would do.
 */

import { SeededRandom } from '../core/SeededRandom';
import { MEMORY } from '../horror/HorrorConfig';

export type ContactKind = 'none' | 'visual' | 'sound';

export interface Landmark { x: number; z: number; id?: string }

/** What the brain reads. Positions here are the *believed* ones, with error. */
export interface Belief {
  /** believed player position — true last-known plus confidence-scaled error */
  x: number; z: number;
  /** exact last-known, for internal bookkeeping only; the brain must not use it */
  trueX: number; trueZ: number;
  /** 0..1 */
  confidence: number;
  /** seconds since the last contact of any kind */
  age: number;
  /** last contact type */
  lastContact: ContactKind;
  /** estimated planar heading, radians (atan2(dx, dz)), or null if unknown */
  heading: number | null;
  /** estimated speed, m/s */
  speed: number;
  /** true once confidence has decayed past the floor */
  stale: boolean;
}

export class PalebarkMemory {
  private rng: SeededRandom;

  private trueX = 0; private trueZ = 0;
  private beliefX = 0; private beliefZ = 0;
  private confidence = 0;
  private age = 999;
  private contact: ContactKind = 'none';
  private heading: number | null = null;
  private speed = 0;

  /** Error offset, re-rolled on a slow cadence rather than every tick. */
  private errX = 0; private errZ = 0;
  private errTimer = 0;

  /** Where the belief was one sample ago, for heading estimation. */
  private prevX = 0; private prevZ = 0;
  private prevT = -1;
  private clock = 0;

  /** Cached prediction so consumers can read it without re-rolling the error. */
  private predX = 0; private predZ = 0;
  private predValid = false;
  private predTimer = 0;
  /** true when the last prediction deliberately committed to the wrong branch */
  private predWasGuess = false;

  private belief: Belief = {
    x: 0, z: 0, trueX: 0, trueZ: 0, confidence: 0, age: 999,
    lastContact: 'none', heading: null, speed: 0, stale: true,
  };

  constructor(seed: number) {
    this.rng = new SeededRandom((seed ^ 0x8ADFACE) >>> 0);
  }

  reseed(seed: number): void {
    this.rng = new SeededRandom((seed ^ 0x8ADFACE) >>> 0);
    this.forget();
  }

  forget(): void {
    this.confidence = 0;
    this.age = 999;
    this.contact = 'none';
    this.heading = null;
    this.speed = 0;
    this.errX = 0; this.errZ = 0;
    this.predValid = false;
    this.prevT = -1;
  }

  // -------------------------------------------------------------- observations

  /**
   * A clean visual contact.
   *
   * `quality` is the perception strength (0..1): a figure at the edge of the
   * cone through three trunks is not the same information as one in the open at
   * fifteen metres, and it should not produce the same certainty.
   */
  seePlayer(x: number, z: number, quality: number): void {
    this.recordContact(x, z, 'visual',
      MEMORY.visualConfidence * Math.max(0.35, Math.min(1, quality)));
  }

  /**
   * A sound contact. Inherently vague: the position is offset before it is even
   * stored, because Palebark never *had* the exact figure — it had a direction
   * and a rough range, which is what hearing gives you in a forest.
   */
  hearPlayer(x: number, z: number, certainty: number): void {
    const c = Math.max(0, Math.min(1, certainty));
    const err = MEMORY.soundErrorMax * (1 - c);
    this.recordContact(
      x + this.rng.range(-err, err), z + this.rng.range(-err, err),
      'sound', MEMORY.soundConfidence * (0.4 + c * 0.6));
  }

  private recordContact(x: number, z: number, kind: ContactKind, conf: number): void {
    // Heading is estimated from successive *contacts*, not from the player's
    // real velocity. That is the point: Palebark infers where you are going
    // from where it has seen you, so a player who changes direction while
    // unobserved has genuinely misled it until the next contact.
    if (this.prevT >= 0) {
      const gap = this.clock - this.prevT;
      if (gap > 0.25 && gap < 12) {
        const dx = x - this.prevX, dz = z - this.prevZ;
        const d = Math.hypot(dx, dz);
        if (d > 0.8) {
          const h = Math.atan2(dx, dz);
          // Blend rather than replace, so one erratic sample cannot spin the
          // estimate — real tracking is cumulative.
          this.heading = this.heading === null ? h : blendAngle(this.heading, h, 0.55);
          this.speed = this.speed * 0.5 + Math.min(6, d / gap) * 0.5;
        }
      }
    }
    this.prevX = x; this.prevZ = z; this.prevT = this.clock;

    this.trueX = x; this.trueZ = z;
    // Confidence takes the *max*, not a sum: a strong contact should not be
    // weakened by a weak one arriving a moment later.
    this.confidence = Math.min(1, Math.max(this.confidence * 0.7, conf));
    this.age = 0;
    this.contact = kind;
    this.errTimer = 0;
    this.rollError();
    this.predValid = false;
  }

  // ------------------------------------------------------------------- ticking

  /**
   * Decay the belief.
   *
   * Called on the perception cadence, not per frame — this is bookkeeping, and
   * the difference between decaying at 12 Hz and 60 Hz is invisible while the
   * cost is not.
   */
  tick(dt: number): Belief {
    this.clock += dt;
    this.age += dt;
    if (this.confidence > 0) {
      this.confidence = Math.max(0, this.confidence - dt * MEMORY.confidenceDecay);
      if (this.confidence < MEMORY.confidenceFloor) {
        // Below the floor the belief is worse than nothing: acting on it would
        // send Palebark confidently to a place the player left a minute ago,
        // which reads as stupidity rather than as searching. Discard it and let
        // the brain fall back to patrolling.
        this.confidence = 0;
        this.heading = null;
        this.predValid = false;
      }
    }

    // The error offset drifts on its own slow schedule. Re-rolling it every
    // tick would make the believed position jitter, and a jittering target
    // produces a visibly indecisive walk; re-rolling it never would make the
    // error a constant bias the player could learn to exploit.
    this.errTimer -= dt;
    if (this.errTimer <= 0) {
      this.errTimer = 2.5 + this.rng.next() * 3;
      this.rollError();
    }
    this.predTimer -= dt;
    if (this.predTimer <= 0) this.predValid = false;

    this.beliefX = this.trueX + this.errX;
    this.beliefZ = this.trueZ + this.errZ;
    return this.read();
  }

  private rollError(): void {
    const spread = (1 - this.confidence) * MEMORY.positionErrorPerUncertainty;
    if (spread <= 0.01) { this.errX = 0; this.errZ = 0; return; }
    // Polar rather than per-axis, so the error cloud is a disc and not a
    // square — a square biases the guess toward the diagonals, and a stalker
    // that consistently misses at 45° is a pattern.
    const a = this.rng.range(0, Math.PI * 2);
    const r = Math.sqrt(this.rng.next()) * spread;
    this.errX = Math.cos(a) * r;
    this.errZ = Math.sin(a) * r;
  }

  private read(): Belief {
    const b = this.belief;
    b.x = this.beliefX; b.z = this.beliefZ;
    b.trueX = this.trueX; b.trueZ = this.trueZ;
    b.confidence = this.confidence;
    b.age = this.age;
    b.lastContact = this.contact;
    b.heading = this.heading;
    b.speed = this.speed;
    b.stale = this.confidence <= 0;
    return b;
  }

  get current(): Belief { return this.read(); }
  get hasBelief(): boolean { return this.confidence > 0; }
  get confidenceValue(): number { return this.confidence; }
  get lastPredictionWasGuess(): boolean { return this.predWasGuess; }

  // ---------------------------------------------------------------- prediction

  /**
   * Guess where the player will be, and return a point worth going to.
   *
   * Three inputs are combined:
   *
   *   1. **Ballistic extrapolation** of the estimated heading. Cheap, and
   *      correct for anyone walking a trail.
   *   2. **Landmark snapping.** People do not walk along bearings, they walk to
   *      *places* — a tape site, a junction, a lit structure. Scoring nearby
   *      landmarks by how well they match the heading turns a bearing into an
   *      intention, and intention is what makes an interception feel like it
   *      was reasoned rather than rolled.
   *   3. **Error.** An angular offset scaled by how predictably the player has
   *      been moving, plus a chance of committing to the runner-up.
   *
   * Returns `null` when there is no belief to extrapolate from. Callers must
   * handle that rather than falling back to the true position — that fallback
   * is precisely the omniscience this class exists to remove.
   *
   * @param routePredictability 0..1 from PlayerBehaviorModel. High values
   *        *shrink* the error: a player who always takes the graded trail is
   *        genuinely easier to anticipate, and rewarding that inference is what
   *        makes the adaptation legible without being announced.
   */
  predict(
    landmarks: readonly Landmark[],
    routePredictability: number,
    horizon = MEMORY.predictionHorizon,
  ): { x: number; z: number; isGuess: boolean } | null {
    if (this.confidence <= 0 || this.heading === null) return null;
    if (this.predValid) {
      return { x: this.predX, z: this.predZ, isGuess: this.predWasGuess };
    }

    const relief = Math.min(1, Math.max(0, routePredictability)) * MEMORY.predictabilityReliefFactor;
    const errScale = (1 - relief) * (0.4 + (1 - this.confidence) * 0.6);
    const angErr = this.rng.range(-1, 1) * MEMORY.predictionAngleError * errScale;
    const h = this.heading + angErr;
    const reach = Math.max(6, this.speed * horizon);

    // 1. ballistic
    let bx = this.beliefX + Math.sin(h) * reach;
    let bz = this.beliefZ + Math.cos(h) * reach;

    // 2. landmark scoring: prefer places that lie in the direction of travel
    //    and are plausibly reachable within the horizon.
    let best: Landmark | null = null, bestScore = -Infinity;
    let second: Landmark | null = null, secondScore = -Infinity;
    for (const lm of landmarks) {
      const dx = lm.x - this.beliefX, dz = lm.z - this.beliefZ;
      const d = Math.hypot(dx, dz);
      if (d < 8 || d > reach * 2.6) continue;
      const align = (Math.sin(h) * dx + Math.cos(h) * dz) / d;   // -1..1
      if (align < 0.15) continue;
      // Closer and better-aligned wins; the distance term is gentle so a
      // strongly-aligned far landmark can still beat a weakly-aligned near one.
      const score = align * 1.6 - (d / (reach * 2.6)) * 0.5 + this.rng.range(0, 0.18);
      if (score > bestScore) {
        second = best; secondScore = bestScore;
        best = lm; bestScore = score;
      } else if (score > secondScore) {
        second = lm; secondScore = score;
      }
    }

    // 3. the deliberate mistake
    this.predWasGuess = false;
    let target = best;
    if (second && this.rng.next() < MEMORY.wrongGuessChance * (1 - relief * 0.5)) {
      target = second;
      this.predWasGuess = true;
    }

    if (target) {
      // Pull the ballistic point toward the chosen place rather than replacing
      // it: Palebark is anticipating a destination, not teleporting its
      // attention to one, and the blend keeps the guess on the plausible side
      // of the player's actual line of travel.
      const w = 0.62;
      bx = bx * (1 - w) + target.x * w;
      bz = bz * (1 - w) + target.z * w;
    } else if (this.rng.next() < MEMORY.wrongGuessChance * 0.5) {
      // No landmark to anchor on — mis-guess by fanning the bearing wide. This
      // is the "waited on the wrong side of the ridge" case.
      const wide = this.rng.sign() * this.rng.range(0.5, 1.1);
      bx = this.beliefX + Math.sin(h + wide) * reach;
      bz = this.beliefZ + Math.cos(h + wide) * reach;
      this.predWasGuess = true;
    }

    this.predX = bx; this.predZ = bz;
    this.predValid = true;
    // Predictions are re-rolled on a slow cadence so a committed interception
    // is actually *committed* — recomputing it every tick would let Palebark
    // home in by accident, restoring the omniscience by the back door.
    this.predTimer = 4 + this.rng.next() * 4;
    return { x: bx, z: bz, isGuess: this.predWasGuess };
  }

  snapshot(): Record<string, number | string | boolean | null> {
    return {
      confidence: +this.confidence.toFixed(3),
      age: +Math.min(999, this.age).toFixed(2),
      contact: this.contact,
      believedX: +this.beliefX.toFixed(1),
      believedZ: +this.beliefZ.toFixed(1),
      errorMetres: +Math.hypot(this.errX, this.errZ).toFixed(1),
      heading: this.heading === null ? null : +this.heading.toFixed(3),
      speed: +this.speed.toFixed(2),
      predictedX: this.predValid ? +this.predX.toFixed(1) : null,
      predictedZ: this.predValid ? +this.predZ.toFixed(1) : null,
      predictionIsGuess: this.predWasGuess,
      stale: this.confidence <= 0,
    };
  }
}

/** Shortest-arc angle blend. */
function blendAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
