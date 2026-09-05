/**
 * ============================================================================
 * HORROR PROGRESSION — the one authority on what act the run is in
 * ============================================================================
 *
 * ## The problem this replaces
 *
 * The game previously had two progression systems that did not know about each
 * other:
 *
 *   EntityBrain.MILESTONES   0–2 tapes investigate · 3–5 stalk · 6–8 confront
 *   AudioDirector            opening <2 tapes · middle 2+ · late 5+
 *
 * Both were reasonable. Together they meant that at three tapes the AI had just
 * unlocked stalking while the mix had been in its "middle" act for a while, and
 * at five tapes the score went late a full tape before confrontation existed.
 * Nothing was *broken*, which is exactly why it survived: the run simply had no
 * coherent shape, and every attempt to tune the shape moved one of the two
 * definitions and desynchronised them further.
 *
 * ## What this is
 *
 * A tiny, pure state object. It owns the act, derives every capability gate
 * from it, and publishes one immutable-shaped snapshot that every other system
 * reads. It has no dependencies on the world, the renderer, or audio — which is
 * what makes it testable in isolation and impossible to fork accidentally.
 *
 * ## Progression means *vocabulary*, not numbers
 *
 * The single most important property: advancing an act never makes Palebark
 * faster or more perceptive. It makes it capable of *new kinds of behaviour*.
 *
 *   arrival     Almost a normal forest. Wandering, distant ambiguity, the
 *               occasional silhouette that is probably a tree.
 *   unease      Footsteps that belong to something. Partial sightings.
 *               Observation. Environmental fakeouts.
 *   stalking    Shadowing, flanking, route prediction, interception,
 *               withdrawal when noticed, adaptation to how you play.
 *   revelation  Confrontation. Close stalking. The world itself starts
 *               agreeing with the thing inside it.
 *   escape      The objective changes. Pressure comes from route denial and
 *               interception, not from a speed multiplier.
 *
 * A careless player in `arrival` still gets investigated aggressively — real
 * perception is never relaxed or tightened by the act. They simply never get
 * confronted, because that verb does not exist yet.
 */

import {
  ACT_TAPE_THRESHOLDS, ACT_TIME_DRIFT, ACT_TIME_CEILING, AUDIO_FORESHADOW_ACTS,
} from './HorrorConfig';

export type HorrorAct =
  | 'arrival'
  | 'unease'
  | 'stalking'
  | 'revelation'
  | 'escape';

/** Canonical order. Index arithmetic elsewhere depends on this being ascending. */
export const HORROR_ACTS: readonly HorrorAct[] = [
  'arrival', 'unease', 'stalking', 'revelation', 'escape',
] as const;

export function actIndex(act: HorrorAct): number {
  return HORROR_ACTS.indexOf(act);
}

/** Is `a` at least as advanced as `b`? */
export function actAtLeast(a: HorrorAct, b: HorrorAct): boolean {
  return actIndex(a) >= actIndex(b);
}

/**
 * The shared snapshot.
 *
 * Every consumer reads this and nothing else. The boolean gates are derived
 * rather than stored so there is exactly one definition of each capability —
 * a consumer that wants to know whether interception is legal asks
 * `predictionUnlocked`, it does not compare tape counts.
 */
export interface HorrorProgressionSnapshot {
  act: HorrorAct;
  /** index of `act` in HORROR_ACTS — cheap comparisons without a lookup */
  actIndex: number;
  tapeCount: number;
  tapesTotal: number;
  /** 0..1 across the whole arc, tapes only (time drift does not inflate it) */
  normalizedProgress: number;
  /** seconds since the run began */
  runTime: number;
  /** seconds since the act last changed — pacing uses this to settle */
  timeInAct: number;

  stalkingUnlocked: boolean;
  predictionUnlocked: boolean;
  confrontationUnlocked: boolean;
  environmentalDistortionUnlocked: boolean;
  escapeActive: boolean;

  /**
   * The act the *audio* layer is allowed to imply.
   *
   * Explicitly a separate field rather than a fudge inside the mixer, so that
   * "the score is ahead of the AI" is a stated design decision with a knob,
   * not an accident somebody has to reverse-engineer later.
   */
  audioAct: HorrorAct;
}

export class HorrorProgression {
  private act: HorrorAct = 'arrival';
  private tapes = 0;
  private total = 8;
  private time = 0;
  private actEnteredAt = 0;
  private snap: HorrorProgressionSnapshot;

  /** Fired when the act advances. Never fired on regression (there is none). */
  onActChange: ((act: HorrorAct, previous: HorrorAct) => void) | null = null;

  constructor(tapesTotal = 8) {
    this.total = Math.max(1, tapesTotal);
    this.snap = this.compose();
  }

  reset(tapesTotal = this.total): void {
    this.total = Math.max(1, tapesTotal);
    this.act = 'arrival';
    this.tapes = 0;
    this.time = 0;
    this.actEnteredAt = 0;
    this.snap = this.compose();
  }

  /** Advance the clock. Cheap enough to call every frame. */
  tick(dt: number): void {
    this.time += dt;
    this.evaluate();
  }

  /** A recording was recovered. This is the primary progression input. */
  setTapes(count: number): void {
    const c = Math.max(0, Math.min(this.total, Math.floor(count)));
    if (c === this.tapes) return;
    this.tapes = c;
    this.evaluate();
  }

  /**
   * Test/debug hook: jump the run forward without playing it.
   *
   * Deliberately routed through the same `evaluate()` as everything else, so a
   * forced run cannot reach a state a real one could not.
   */
  force(o: { tapes?: number; runTime?: number }): void {
    if (o.runTime !== undefined) this.time = Math.max(0, o.runTime);
    if (o.tapes !== undefined) this.tapes = Math.max(0, Math.min(this.total, Math.floor(o.tapes)));
    this.evaluate();
  }

  // ------------------------------------------------------------------ internals

  /**
   * Recompute the act from tapes and time, and take the *higher* of the two.
   *
   * Monotonic on purpose. An act can never regress — an escalation that can be
   * undone is not an escalation, it is a difficulty oscillation, and players
   * read oscillation as the game being buggy rather than as the forest calming
   * down.
   */
  private evaluate(): void {
    let byTapes: HorrorAct = 'arrival';
    for (const a of HORROR_ACTS) {
      if (this.tapes >= ACT_TAPE_THRESHOLDS[a]) byTapes = a;
    }
    // The escape act is gated on *all* tapes, never on time.
    if (byTapes === 'escape' && this.tapes < this.total) byTapes = 'revelation';

    let byTime: HorrorAct = 'arrival';
    for (const d of ACT_TIME_DRIFT) {
      if (this.time >= d.seconds && actIndex(d.act) > actIndex(byTime)) byTime = d.act;
    }
    if (actIndex(byTime) > actIndex(ACT_TIME_CEILING)) byTime = ACT_TIME_CEILING;

    const want = actIndex(byTapes) >= actIndex(byTime) ? byTapes : byTime;
    if (actIndex(want) > actIndex(this.act)) {
      const prev = this.act;
      this.act = want;
      this.actEnteredAt = this.time;
      this.snap = this.compose();
      this.onActChange?.(this.act, prev);
      return;
    }
    this.snap = this.compose();
  }

  private compose(): HorrorProgressionSnapshot {
    const idx = actIndex(this.act);
    const audioIdx = Math.min(HORROR_ACTS.length - 1, idx + AUDIO_FORESHADOW_ACTS);
    return {
      act: this.act,
      actIndex: idx,
      tapeCount: this.tapes,
      tapesTotal: this.total,
      normalizedProgress: this.tapes / this.total,
      runTime: this.time,
      timeInAct: this.time - this.actEnteredAt,

      // ---- capability gates -------------------------------------------------
      // Each of these is the *only* definition of its capability anywhere in
      // the codebase. If a system needs a new one, it is added here rather than
      // reconstructed from `act` at the call site — that reconstruction is what
      // produced two progression systems in the first place.
      stalkingUnlocked: idx >= actIndex('unease'),
      predictionUnlocked: idx >= actIndex('stalking'),
      confrontationUnlocked: idx >= actIndex('revelation'),
      environmentalDistortionUnlocked: idx >= actIndex('unease'),
      escapeActive: this.act === 'escape',

      audioAct: HORROR_ACTS[audioIdx],
    };
  }

  /** The shared snapshot. Recomposed only when something changed. */
  get snapshot(): HorrorProgressionSnapshot { return this.snap; }
  get current(): HorrorAct { return this.act; }
}
