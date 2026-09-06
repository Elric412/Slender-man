/**
 * ============================================================================
 * HORROR DIRECTOR — the pacing authority
 * ============================================================================
 *
 * ## What was missing
 *
 * The game had two things that shaped intensity and neither of them was pacing.
 * `AudioDirector` composed a tension value and rationed stinger-class events —
 * genuinely good work, but scoped to the mix. `EntityBrain` escalated on its
 * own perception. Nothing anywhere asked the question a horror director asks:
 * *given everything that has already happened to this player, what should the
 * next ninety seconds feel like?*
 *
 * Without that question the answer defaults to "whatever the AI happens to do",
 * and what an unsupervised perception-driven AI happens to do is apply pressure
 * continuously. Continuous pressure is the most common failure in the genre and
 * it is a *dynamic range* failure: if the player is never calm, nothing can
 * make them afraid, because fear is a derivative.
 *
 * ## The phase machine
 *
 *   calm → unease → anticipation → encounter → panic → release → calm
 *
 * These are not difficulty tiers. They are positions in a breath, and the
 * important ones are the last two. `release` is protected — while it is active
 * the brain is told `allowEscalation: false`, so no new escalation may begin no
 * matter how good the opportunity looks. `calm` has a floor duration.
 *
 * ## Why "do nothing" is a first-class decision
 *
 * `evaluate()` can and frequently does decide to spend nothing. Three
 * mechanisms push it there:
 *
 *   - **Recovery windows** after a strong encounter, sized by act.
 *   - **Dread saturation.** Above `PACING.dreadSaturation` the player is
 *     already frightened, and adding a stimulus is strictly wasteful — worse
 *     than wasteful, since it converts an unbearable silence into a knowable
 *     event.
 *   - **Budgets.** Per-act encounter caps, so a long act cannot degenerate into
 *     a conveyor belt.
 *
 * ## What it does not do
 *
 * It does not move the entity, choose an encounter type, or play a sound. It
 * publishes a directive (how much pressure is welcome, whether escalation is
 * permitted, whether a sighting is wanted, whether quiet is being protected)
 * and lets the systems that own those things decide how to honour it. That
 * separation is why the brain can refuse a sighting request when it has no
 * plausible way to compose one, instead of being teleported into frame.
 */

import { SeededRandom } from '../core/SeededRandom';
import { PACING } from './HorrorConfig';
import type { HorrorAct, HorrorProgressionSnapshot } from './HorrorProgression';
import type { ThreatState } from './ThreatModel';
import type { BrainDirective } from '../ai/EntityBrain';

export type TensionPhase =
  | 'calm'
  | 'unease'
  | 'anticipation'
  | 'encounter'
  | 'panic'
  | 'release';

export interface DirectorInput {
  progression: HorrorProgressionSnapshot;
  threat: ThreatState;
  /** seconds since the player last had any event at all */
  quietSeconds: number;
  /** seconds since the player last confirmed a sighting */
  sinceSighting: number;
  /** the entity's current intent danger weight, 0..1 */
  intentDanger: number;
  /** the player can see the entity right now */
  entityVisible: boolean;
  /** how confident the entity is about the player's position */
  knowledgeConfidence: number;
  /** distance to the entity, metres */
  entityDistance: number;
  /** 0..1 how exposed the player's position is */
  exposure: number;
}

export interface HorrorDirectorState {
  phase: TensionPhase;
  /** 0..1 the pressure the director currently *wants* */
  pressure: number;
  /** seconds the current phase has been held */
  phaseAge: number;
  /** true while a recovery window is protecting quiet */
  recovering: boolean;
  recoveryRemaining: number;
  /** encounters spent, this act and total */
  spent: number;
  actSpent: number;
  actBudget: number;
  /** seconds until the director would like the next encounter */
  nextEncounterIn: number;
  /** whether an encounter is currently being solicited */
  soliciting: boolean;
  reason: string;
}

export class HorrorDirector {
  private rng: SeededRandom;

  private phase: TensionPhase = 'calm';
  private phaseAge = 0;
  private pressure = 0.15;
  private targetPressure = 0.15;

  /** Protected quiet after a strong encounter. */
  private recovery = 0;
  /** Countdown to the next *solicited* encounter. */
  private nextEncounter = 0;
  /** How long the run has been going, for the opening calm floor. */
  private runTime = 0;

  private spent = 0;
  private actSpent = 0;
  private actOfSpend: HorrorAct = 'arrival';
  private reason = 'run start';

  /** Peak dread reached this run — the tests assert an arc exists. */
  peakDread = 0;
  /** Total seconds spent in calm or release. Proves recovery periods exist. */
  quietSecondsTotal = 0;
  /** Phase transition trace, for debugging and for the pacing test. */
  readonly phaseTrace: { phase: TensionPhase; t: number; act: HorrorAct }[] = [];

  private directive: BrainDirective = {
    pressure: 0.15, allowEscalation: false, wantSighting: false, wantQuiet: true,
  };

  onPhaseChange: ((phase: TensionPhase, previous: TensionPhase) => void) | null = null;

  constructor(seed: number) {
    this.rng = new SeededRandom((seed ^ 0x40D1EC) >>> 0);
  }

  begin(seed: number): void {
    this.rng = new SeededRandom((seed ^ 0x40D1EC) >>> 0);
    this.phase = 'calm';
    this.phaseAge = 0;
    this.pressure = 0.12;
    this.targetPressure = 0.12;
    this.recovery = 0;
    this.runTime = 0;
    this.spent = 0;
    this.actSpent = 0;
    this.actOfSpend = 'arrival';
    this.peakDread = 0;
    this.quietSecondsTotal = 0;
    this.phaseTrace.length = 0;
    this.reason = 'run start: opening calm';
    // The first solicited encounter cannot land before the opening calm floor
    // has elapsed. A scare in the first thirty seconds costs the entire
    // establishing act, and the establishing act is what the rest is measured
    // against.
    this.nextEncounter = PACING.openingCalmSeconds + this.rng.range(0, 40);
  }

  // ------------------------------------------------------------------- update

  update(dt: number, i: DirectorInput): void {
    this.runTime += dt;
    this.phaseAge += dt;
    this.recovery = Math.max(0, this.recovery - dt);
    this.nextEncounter -= dt;
    if (i.threat.perceivedDread > this.peakDread) this.peakDread = i.threat.perceivedDread;
    if (this.phase === 'calm' || this.phase === 'release') this.quietSecondsTotal += dt;

    // Act change resets the per-act budget. Deliberately not the *total*: a run
    // that has already had thirty encounters should feel spent even if the act
    // just turned over.
    if (i.progression.act !== this.actOfSpend) {
      this.actOfSpend = i.progression.act;
      this.actSpent = 0;
    }

    this.updatePhase(i);
    this.updatePressure(dt, i);
    this.publishDirective(i);
  }

  /**
   * Advance the breath.
   *
   * Transitions are driven by what the player is *experiencing* (danger, dread,
   * visibility) rather than by a script, with two exceptions that are
   * deliberately time-driven: a peak cannot be held indefinitely, and a release
   * has a floor. Both exist because the alternative is emergent, and emergent
   * pacing has no rhythm — it just tracks the AI.
   */
  private updatePhase(i: DirectorInput): void {
    const t = i.threat;
    const prev = this.phase;
    let next = this.phase;

    switch (this.phase) {
      case 'calm':
        // Unease begins when something is genuinely accumulating, or when the
        // quiet has gone on long enough that continuing it would read as an
        // empty game rather than as restraint.
        if (t.perceivedDread > 0.3 || t.actualDanger > 0.25) next = 'unease';
        else if (this.phaseAge > 70 && this.nextEncounter < 12) next = 'unease';
        break;

      case 'unease':
        if (t.actualDanger > 0.45 || i.intentDanger > 0.4) next = 'anticipation';
        else if (t.perceivedDread < 0.16 && this.phaseAge > 25) next = 'calm';
        break;

      case 'anticipation':
        // The encounter phase begins on *contact* — a sighting, or real danger.
        // Not on a timer: an anticipation that resolves on schedule is a
        // cutscene, and the player can feel the difference immediately.
        if (i.entityVisible || t.actualDanger > 0.6) next = 'encounter';
        else if (this.phaseAge > 55 && t.actualDanger < 0.3) {
          // Nothing came of it. This is the good outcome — the anticipation
          // that resolves into nothing is what makes the next one work.
          next = 'release';
          this.reason = 'anticipation dissolved without contact';
        }
        break;

      case 'encounter':
        if (t.actualDanger > 0.8 && i.entityDistance < 20) next = 'panic';
        else if (this.phaseAge > PACING.peakHoldSeconds
                 && t.actualDanger < 0.4 && !i.entityVisible) next = 'release';
        break;

      case 'panic':
        // Panic is never held: physiologically it cannot be sustained, and
        // mechanically a permanent panic is a chase, which this game is not.
        if (this.phaseAge > 14 || (t.actualDanger < 0.45 && !i.entityVisible)) {
          next = 'release';
          this.reason = 'panic resolved → protected release';
        }
        break;

      case 'release':
        if (this.phaseAge > PACING.releaseSeconds) next = 'calm';
        // A release can be interrupted, but only by *real* danger — dread
        // alone must not, or the recovery window is worthless.
        else if (i.threat.actualDanger > 0.7) next = 'encounter';
        break;
    }

    if (next !== prev) {
      this.phase = next;
      this.phaseAge = 0;
      this.phaseTrace.push({ phase: next, t: +this.runTime.toFixed(1), act: i.progression.act });
      if (this.phaseTrace.length > 64) this.phaseTrace.shift();
      // Entering release opens the protected recovery window. Length is
      // act-scaled: later acts recover faster (the run has momentum by then)
      // but never instantly.
      if (next === 'release') {
        const lerp = i.progression.actIndex / 4;
        this.recovery = PACING.recoverySeconds
          + (PACING.recoveryMinSeconds - PACING.recoverySeconds) * lerp;
        this.reason = `release: ${this.recovery.toFixed(0)}s protected recovery`;
      }
      this.onPhaseChange?.(next, prev);
    }
  }

  /** Pressure is the phase's ambition, damped so it cannot chatter. */
  private updatePressure(dt: number, i: DirectorInput): void {
    const base: Record<TensionPhase, number> = {
      calm: 0.1, unease: 0.3, anticipation: 0.55,
      encounter: 0.8, panic: 1.0, release: 0.08,
    };
    let p = base[this.phase];
    // Later acts raise the floor, never the ceiling — the ceiling is the phase's
    // job, and letting progression raise it would reintroduce "later = harder".
    p = Math.max(p, i.progression.actIndex * 0.06);
    if (this.recovery > 0) p = Math.min(p, 0.2);
    // Already terrified: adding pressure now buys nothing and spends a moment
    // that would be better kept.
    if (i.threat.perceivedDread > PACING.dreadSaturation) p *= 0.55;
    this.targetPressure = p;
    // Slower to fall than to rise, matching the body it is modelling.
    const rate = p > this.pressure ? 1.4 : 0.35;
    this.pressure += (p - this.pressure) * Math.min(1, dt * rate);
  }

  private publishDirective(i: DirectorInput): void {
    const d = this.directive;
    d.pressure = this.pressure;
    d.allowEscalation = this.recovery <= 0
      && this.phase !== 'release'
      && this.runTime > PACING.openingCalmSeconds * 0.6;
    // A sighting is wanted when the player has been left alone visually for a
    // while and the phase is in the right part of the breath. Explicitly *not*
    // during panic: a player already in trouble does not need to be shown the
    // thing that is causing it.
    d.wantSighting =
      (this.phase === 'unease' || this.phase === 'anticipation')
      && i.sinceSighting > 70
      && this.recovery <= 0;
    d.wantQuiet = this.recovery > 0 || this.phase === 'release'
      || (this.phase === 'calm' && this.phaseAge < 30);
  }

  // -------------------------------------------------------------- encounter API

  /**
   * May an encounter of this intensity fire right now?
   *
   * The single gate every encounter must pass. Consolidating it here — rather
   * than letting each encounter type carry its own cooldown — is what makes
   * "pressure, release, uncertainty, pressure" enforceable instead of
   * aspirational.
   */
  canSolicit(intensity: number, prog: HorrorProgressionSnapshot, threat: ThreatState): boolean {
    if (this.nextEncounter > 0) return false;
    if (this.runTime < PACING.openingCalmSeconds) return false;
    // Strong beats are refused outright during recovery; gentle ambiguous ones
    // (a distant crossing, a sound) are allowed through, because a recovery
    // window must not be *empty* — an empty forest is a bug, not a rest.
    if (this.recovery > 0 && intensity > 0.35) return false;
    if (this.phase === 'panic') return false;
    const budget = PACING.encounterBudget[prog.act] ?? 4;
    if (this.actSpent >= budget) return false;
    if (threat.perceivedDread > PACING.dreadSaturation && intensity > 0.5) return false;
    return true;
  }

  /**
   * Record that an encounter fired, and schedule the next window.
   *
   * The interval is jittered every time. A fixed cadence is the clearest
   * possible tell that a director exists, and once a player can feel the
   * metronome they start waiting for beats instead of watching the forest.
   */
  noteEncounter(intensity: number, prog: HorrorProgressionSnapshot): void {
    this.spent++;
    this.actSpent++;
    const j = PACING.encounterIntervalJitter;
    // Stronger beats buy longer silences. This is the core of the rhythm: the
    // price of a good scare is the time before the next one.
    const scale = 0.55 + intensity * 0.9;
    const base = PACING.encounterInterval * scale
      * (prog.escapeActive ? 0.55 : 1);
    this.nextEncounter = base * this.rng.range(1 - j, 1 + j);
    if (intensity > 0.6) {
      this.phase = 'encounter';
      this.phaseAge = 0;
    }
    this.reason = `encounter i=${intensity.toFixed(2)} → next in ${this.nextEncounter.toFixed(0)}s`;
  }

  /** The brain reads this every frame. */
  get brainDirective(): BrainDirective { return this.directive; }
  get currentPhase(): TensionPhase { return this.phase; }
  get pressureAmount(): number { return this.pressure; }
  get isRecovering(): boolean { return this.recovery > 0; }
  /** 0..1 how much the audio layer should lean on ambiguity rather than mass. */
  get soliciting(): boolean { return this.nextEncounter <= 0; }

  snapshot(): HorrorDirectorState {
    return {
      phase: this.phase,
      pressure: +this.pressure.toFixed(4),
      phaseAge: +this.phaseAge.toFixed(1),
      recovering: this.recovery > 0,
      recoveryRemaining: +this.recovery.toFixed(1),
      spent: this.spent,
      actSpent: this.actSpent,
      actBudget: PACING.encounterBudget[this.actOfSpend] ?? 0,
      nextEncounterIn: +Math.max(0, this.nextEncounter).toFixed(1),
      soliciting: this.nextEncounter <= 0,
      reason: this.reason,
    };
  }
}
