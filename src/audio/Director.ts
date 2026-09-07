import { SeededRandom } from '../core/SeededRandom';
import { AudioBuses } from './AudioBuses';
import { DreadToolkit, DroneHandle, GranularHandle } from './DreadToolkit';

export type EntityPhase = 'dormant' | 'investigating' | 'stalking' | 'confronting';

export interface DirectorInput {
  entityState: EntityPhase;
  detection: number;        // 0..1
  fear: number;             // 0..1 smoothed player fear
  distToEntity: number;     // metres
  entityVisible: boolean;
  tapes: number;            // 0..8
  runTime: number;          // seconds
  sprinting: boolean;
  inOpen: boolean;          // in a clearing / off-trail exposure
  openness: number;         // 0..1 from the spatial probe
}

/** What the director is doing right now — logged, asserted on, shown in the HUD. */
export interface DirectorState {
  /** narrative arc phase, derived from run progress */
  act: 'opening' | 'middle' | 'late';
  /** 0..1 composed tension value the layers are driven from */
  tension: number;
  /** 0..1 how much *silence* the director is currently enforcing */
  silence: number;
  /** true while a deliberate cut-to-quiet is in effect */
  cutToQuiet: boolean;
  /** currently-eligible layer names */
  layers: string[];
  /** live layer intensities */
  sub: number;
  cluster: number;
  riser: number;
  air: number;
  /** total seconds of near-silence accumulated this run */
  silenceSeconds: number;
  /** budget spends this run, per event class */
  spends: Record<string, number>;
  /** why the director last changed mode */
  reason: string;
}

/**
 * Budget for "cliché" events — anything with stinger energy. Each entry is a
 * per-run cap. §9 of the brief: a stinger that fires every 40 seconds trains
 * the player and stops working by minute four, so the director spends these
 * like currency and varies timing/intensity/origin on every spend.
 */
const CLICHE_BUDGET: Record<string, number> = {
  riser: 4,          // escalation risers per run
  cutToQuiet: 6,     // engineered silences
  sighting: 12,      // sighting stings
  wrongness: 5,      // ring-mod'd diegetic corruption
  subBeat: 7,        // rare "extension/reach" sub-bass beats
};

/**
 * The Director: a small generative composer that reads real game state and
 * decides, moment to moment, what the mix is made of.
 *
 * There is deliberately no music track and no "combat music". The entire output
 * is: which dread-toolkit layers are running, at what intensity, and — just as
 * importantly — when *nothing* is running.
 *
 * ── Why silence is a first-class output ──────────────────────────────────────
 * A continuous ambient bed is trained out within minutes; the auditory system
 * habituates to any stationary stimulus. That means a game with wall-to-wall
 * ambience has *no* dynamic range left to scare with. Worse, the moment that
 * actually raises heart rate in this genre is the *cessation* of sound — a bed
 * dropping to near-nothing reads as a threat signal, because in the real world
 * things nearby going quiet usually means something started paying attention.
 * So the director tracks a silence budget, spends the opening act establishing
 * a genuinely sparse floor (so there's something to take away later), and
 * treats a cut-to-quiet as a scheduled, budgeted event.
 *
 * ── The arc ─────────────────────────────────────────────────────────────────
 * act 'opening'  (0 tapes, first ~150s): only naturalistic ambience is
 *                eligible. No dread layers at all. This act exists to set the
 *                floor — you cannot make a room go quiet if it was never quiet.
 * act 'middle'   (2+ tapes or 150s+): the dissonant cluster becomes eligible
 *                and enters on detection, cut-to-quiet becomes available, and
 *                the granular approach layer starts responding to the entity.
 * act 'late'     (5+ tapes or 420s+): the sub-bass dread layer and the Shepard
 *                riser both become eligible. Both are rationed.
 */
export class AudioDirector {
  private buses: AudioBuses;
  private kit: DreadToolkit;
  private rng: SeededRandom;

  // ---- layer handles ----
  private sub: DroneHandle | null = null;
  private cluster: DroneHandle | null = null;
  private riser: DroneHandle | null = null;
  /** low-level always-on "air" — the room tone that silence is measured against */
  private air: GranularHandle | null = null;

  // ---- arc state ----
  private tension = 0;
  private targetTension = 0;
  private silence = 0;
  private silenceSeconds = 0;
  private runTime = 0;
  private act: DirectorState['act'] = 'opening';
  private reason = 'init';

  // ---- scheduling ----
  private cutTimer = 0;
  private cutRemaining = 0;
  private riserTimer = 0;
  private riserRemaining = 0;
  private evalTimer = 0;
  private subBeatTimer = 0;

  private spends: Record<string, number> = {};
  private lastPhase: EntityPhase = 'dormant';

  /** highest tension reached this run — used by the escalation assertion in tests */
  peakTension = 0;
  /** per-act tension traces, for the seeded test that asserts escalation */
  actTrace: { act: string; tension: number; time: number }[] = [];

  onCutToQuiet: ((duration: number) => void) | null = null;
  onEscalation: ((kind: 'riser' | 'subBeat') => void) | null = null;

  constructor(buses: AudioBuses, kit: DreadToolkit, seed: number) {
    this.buses = buses;
    this.kit = kit;
    this.rng = new SeededRandom(seed ^ 0xD12EC7);
    this.resetBudget();
  }

  private resetBudget(): void {
    this.spends = {};
    for (const k of Object.keys(CLICHE_BUDGET)) this.spends[k] = 0;
  }

  private canSpend(kind: string): boolean {
    return (this.spends[kind] ?? 0) < (CLICHE_BUDGET[kind] ?? 0);
  }
  private spend(kind: string): void {
    this.spends[kind] = (this.spends[kind] ?? 0) + 1;
  }

  /** Begin a run. Starts only the air layer — the opening act is deliberately bare. */
  begin(seed: number): void {
    this.rng = new SeededRandom(seed ^ 0xD12EC7);
    this.kit.reseed(seed);
    this.resetBudget();
    this.tension = 0; this.targetTension = 0;
    this.silence = 0; this.silenceSeconds = 0;
    this.runTime = 0;
    this.act = 'opening';
    this.peakTension = 0;
    this.actTrace.length = 0;
    this.reason = 'run-start: opening act, dread layers ineligible';
    this.cutTimer = this.rng.range(70, 120);
    this.riserTimer = 90;
    this.subBeatTimer = 120;
    this.cutRemaining = 0;
    this.riserRemaining = 0;
    this.lastPhase = 'dormant';

    this.stopAll(0.4);
    if (!this.buses.ready) return;
    // The "air" layer: extremely sparse, wide, low-density grains. This is not
    // ambience (that's the AmbienceSystem's job) — it's the near-inaudible room
    // tone that makes a genuine cut-to-quiet perceptible as a *change* rather
    // than as the game's audio breaking.
    this.air = this.kit.granularTexture({
      density: 5, grainSize: 0.5, centre: 260, scatter: 1.6,
      resonance: 0.9, spread: 1.0, bus: 'ambience', reverbSend: 0.5,
    });
    this.air.set(0.05, 4);
  }

  stopAll(fade = 1.5): void {
    this.sub?.stop(fade); this.sub = null;
    this.cluster?.stop(fade); this.cluster = null;
    this.riser?.stop(fade); this.riser = null;
    this.air?.stop(fade); this.air = null;
  }

  // ------------------------------------------------------------------ update

  update(dt: number, input: DirectorInput): void {
    if (!this.buses.ready) return;
    this.runTime = input.runTime;

    // ---- act progression ----
    const prevAct = this.act;
    if (input.tapes >= 5 || input.runTime > 420) this.act = 'late';
    else if (input.tapes >= 2 || input.runTime > 150) this.act = 'middle';
    else this.act = 'opening';
    if (prevAct !== this.act) {
      this.reason = `act → ${this.act} (tapes ${input.tapes}, t=${input.runTime.toFixed(0)}s)`;
      this.actTrace.push({ act: this.act, tension: this.tension, time: input.runTime });
    }

    // ---- compose target tension ----
    // Tension is NOT just detection. It's a weighted composition of how much
    // the entity knows, how close it is, how exposed the player is, and how
    // deep into the run we are — so the same detection level late in a run
    // produces a heavier mix than it does at minute two.
    const phaseWeight: Record<EntityPhase, number> = {
      dormant: 0.0, investigating: 0.28, stalking: 0.55, confronting: 0.9,
    };
    const proximity = clamp01(1 - input.distToEntity / 70);
    const actFloor = this.act === 'opening' ? 0 : this.act === 'middle' ? 0.06 : 0.14;
    let t = Math.max(
      phaseWeight[input.entityState],
      input.detection * 0.85,
      input.fear * 0.9,
    );
    t = clamp01(t * (0.72 + proximity * 0.4)
      + actFloor
      + (input.entityVisible ? 0.18 : 0)
      + (input.inOpen && input.entityState !== 'dormant' ? 0.05 : 0)
      + (input.sprinting ? 0.04 : 0));
    this.targetTension = t;

    // Asymmetric slew. Tension arrives fast (a sighting must land now) and
    // leaves slowly (the body doesn't calm down in two seconds), which also
    // means the mix doesn't chatter when detection oscillates around a
    // threshold.
    const rate = t > this.tension ? 0.9 : 0.13;
    this.tension += (t - this.tension) * Math.min(1, dt * rate * 4);
    if (this.tension > this.peakTension) this.peakTension = this.tension;

    // ---- silence accounting ----
    // "Near-silence" for gate purposes = no dread layer above a whisper and low
    // composed tension. Tracked in seconds so a test can assert the run
    // actually contained quiet stretches rather than merely intending to.
    const dreadActive = (this.sub?.level ?? 0) + (this.cluster?.level ?? 0) + (this.riser?.level ?? 0);
    if (dreadActive < 0.06 && this.tension < 0.22) this.silenceSeconds += dt;

    // ---- scheduled events (evaluated at 4Hz, not per frame) ----
    this.evalTimer -= dt;
    if (this.evalTimer <= 0) {
      this.evalTimer = 0.25;
      this.evaluate(input);
    }

    // ---- cut-to-quiet ----
    if (this.cutRemaining > 0) {
      this.cutRemaining -= dt;
      // ease the silence in fast and out slowly — an abrupt return of the bed
      // is its own (cheap) jump scare, and we're not spending the budget on that
      this.silence += (1 - this.silence) * Math.min(1, dt * 6);
      if (this.cutRemaining <= 0) this.reason = 'cut-to-quiet released';
    } else {
      this.silence += (0 - this.silence) * Math.min(1, dt * 0.8);
    }
    this.cutTimer -= dt;

    // ---- riser lifetime ----
    if (this.riserRemaining > 0) {
      this.riserRemaining -= dt;
      if (this.riserRemaining <= 0) {
        // A riser must never resolve. Killing it mid-ascent (rather than letting
        // it top out) is what denies the release valve.
        this.riser?.stop(1.2); this.riser = null;
        this.reason = 'riser cut without resolution';
      }
    }
    this.riserTimer -= dt;
    this.subBeatTimer -= dt;

    // ---- drive the layers ----
    this.driveLayers(dt, input);

    // ---- entity ducking of the ambience bus ----
    const entityPresence = clamp01(
      phaseWeight[input.entityState] * 0.7 + proximity * 0.5 + (input.entityVisible ? 0.25 : 0));
    this.buses.setDuck(entityPresence * (1 - this.silence * 0.5));

    this.lastPhase = input.entityState;
  }

  /** Decision pass — runs at 4Hz. All randomness is seeded. */
  private evaluate(input: DirectorInput): void {
    // ================= cut-to-quiet =================
    // Fires when tension has just climbed into a meaningful band. The *reason*
    // it works is contrast: pulling the bed out at the moment the player expects
    // it to swell inverts their prediction, and prediction error is what the
    // startle response actually keys on.
    if (this.act !== 'opening' && this.cutRemaining <= 0 && this.cutTimer <= 0 &&
        this.canSpend('cutToQuiet')) {
      const eligible =
        // right after entering stalk/confront
        (this.lastPhase !== input.entityState && (input.entityState === 'stalking' || input.entityState === 'confronting')) ||
        // or on a rising tension shelf
        (this.tension > 0.35 && this.tension < 0.75 && this.rng.next() < 0.5);
      if (eligible) {
        this.spend('cutToQuiet');
        // varied every time — 1.4s to 5.2s. A fixed duration would be learned.
        this.cutRemaining = this.rng.range(1.4, 5.2);
        this.cutTimer = this.rng.range(45, 105);
        this.reason = `cut-to-quiet ${this.cutRemaining.toFixed(1)}s (tension ${this.tension.toFixed(2)})`;
        this.onCutToQuiet?.(this.cutRemaining);
        return;   // one big decision per pass
      }
    }

    // ================= escalation riser =================
    // Late act only, and only while detection is genuinely *climbing* toward a
    // confrontation. Riser during a stable stalk would just be noise.
    if (this.act === 'late' && !this.riser && this.riserTimer <= 0 && this.canSpend('riser') &&
        this.cutRemaining <= 0 &&
        (input.entityState === 'confronting' || (input.entityState === 'stalking' && input.detection > 0.5))) {
      this.spend('riser');
      this.riser = this.kit.shepardRiser({
        octaves: this.rng.int(5, 7),
        lowHz: this.rng.range(40, 58),
        sweepSeconds: this.rng.range(8, 15),
        bus: 'entity',
      });
      this.riser.set(0.5 + this.tension * 0.5, 1.6);
      this.riserRemaining = this.rng.range(7, 14);
      this.riserTimer = this.rng.range(70, 140);
      this.reason = `riser engaged (${this.riserRemaining.toFixed(1)}s, det ${input.detection.toFixed(2)})`;
      this.onEscalation?.('riser');
      return;
    }

    // ================= rare sub-bass "reach" beat =================
    // A short, deliberate swell of the low layer — the "it extended toward you"
    // beat. Strictly rationed; this is the most powerful thing in the kit and
    // running it continuously would both dull it and violate §11.
    if (this.act === 'late' && this.subBeatTimer <= 0 && this.canSpend('subBeat') &&
        !this.buses.lowFreqDisabled && input.detection > 0.4 && this.rng.next() < 0.4) {
      this.spend('subBeat');
      this.subBeatTimer = this.rng.range(50, 110);
      this.reason = `sub-bass reach beat (det ${input.detection.toFixed(2)})`;
      this.onEscalation?.('subBeat');
      // The beat itself is realised in driveLayers via subBeatBoost.
      this.subBeatBoost = 1;
      this.subBeatDecay = this.rng.range(3.5, 7);
    }
  }

  private subBeatBoost = 0;
  private subBeatDecay = 5;

  /**
   * Push the composed tension into the actual layers.
   *
   * Each layer has an eligibility gate (act + state) and its own intensity
   * curve. The curves are not linear in tension — the cluster comes in early
   * and plateaus, the sub comes in late and steeply, so the *character* of the
   * mix changes across the run rather than just its level.
   */
  private driveLayers(dt: number, input: DirectorInput): void {
    const quiet = this.silence;

    // ---- air / room tone ----
    // Ducked hard during a cut-to-quiet: this is the layer whose removal the
    // player actually notices.
    if (this.air) {
      const base = 0.045 + this.tension * 0.05 + input.openness * 0.02;
      this.air.set(base * (1 - quiet * 0.92), 0.8);
      // brighter and denser as tension rises — the air itself gets agitated
      this.air.shape({
        density: 4 + this.tension * 14,
        centre: 240 + this.tension * 520,
        grainSize: 0.5 - this.tension * 0.28,
      });
    }

    // ---- dissonant cluster: middle act onward ----
    const clusterEligible = this.act !== 'opening' && this.tension > 0.14 && quiet < 0.55;
    if (clusterEligible) {
      if (!this.cluster || !this.cluster.alive) {
        this.cluster = this.kit.dissonantCluster({
          base: this.rng.range(56, 104),
          voices: this.rng.int(3, 5),
          brightness: 0.3 + this.tension * 0.5,
          bus: 'entity',
        });
      }
      // sqrt curve: present early, then plateaus, so it doesn't fight the sub later
      const lvl = Math.sqrt(clamp01((this.tension - 0.12) / 0.88)) * (1 - quiet * 0.85);
      this.cluster.set(lvl, 2.0);
    } else if (this.cluster) {
      this.cluster.set(0, 1.4);
      if (this.tension < 0.08 || quiet > 0.8) { this.cluster.stop(3); this.cluster = null; }
    }

    // ---- sub-bass dread: late act, confront, or a rationed reach beat ----
    this.subBeatBoost = Math.max(0, this.subBeatBoost - dt / this.subBeatDecay);
    const subEligible = !this.buses.lowFreqDisabled && (
      (this.act === 'late' && (input.entityState === 'confronting' || this.tension > 0.62)) ||
      this.subBeatBoost > 0.01
    );
    if (subEligible) {
      if (!this.sub || !this.sub.alive) {
        this.sub = this.kit.subBassDrone({
          freq: this.rng.range(23, 37),
          beat: this.rng.range(0.4, 1.7),
        });
      }
      // Steep cubic curve above the eligibility threshold. The sub should be
      // essentially absent right up until it isn't — a gradual fade-in over 60
      // seconds would let the player habituate to it, wasting the tool.
      const core = clamp01((this.tension - 0.55) / 0.45);
      const lvl = clamp01(core * core * core * 0.85 + this.subBeatBoost * 0.75);
      // The sub deliberately survives a cut-to-quiet at reduced level: what the
      // silence removes is everything the player can consciously identify,
      // leaving the pressure they can't.
      this.sub.set(lvl * (1 - quiet * 0.35), 2.5);
    } else if (this.sub) {
      this.sub.set(0, 1.5);
      if (this.tension < 0.4) { this.sub.stop(4); this.sub = null; }
    }

    // ---- riser follows tension while alive ----
    if (this.riser && this.riserRemaining > 0) {
      this.riser.set((0.45 + this.tension * 0.55) * (1 - quiet * 0.6), 1.2);
    }
  }

  // -------------------------------------------------------------- accessors

  /** 0..1 how much other systems should suppress themselves for a cut-to-quiet */
  get silenceAmount(): number { return this.silence; }
  get tensionAmount(): number { return this.tension; }
  get currentAct(): DirectorState['act'] { return this.act; }

  /**
   * Externally-commanded silence — the `absence` encounter beat.
   *
   * Distinct from the director's own cut-to-quiet on purpose. A cut-to-quiet is
   * *rationed* out of the cliché budget because it is a startle-adjacent device
   * (pull the bed at the moment the player expects a swell). An absence beat is
   * the opposite instrument: the EncounterDirector has decided the world should
   * simply stop for a while, with no payoff attached, and that must not compete
   * for the same budget or it would starve the device that does have a payoff.
   *
   * Takes the longer of the two windows rather than overwriting, so a director
   * cut already in flight is never shortened by an absence request.
   */
  requestQuiet(seconds: number): void {
    const s = Math.max(0, Math.min(30, seconds));
    if (s <= this.cutRemaining) return;
    this.cutRemaining = s;
    // Push the director's own next cut out past this window: two silences
    // back to back read as an audio bug, not as an absence.
    this.cutTimer = Math.max(this.cutTimer, s + 25);
    this.reason = `absence beat ${s.toFixed(1)}s (external)`;
  }

  /** Ask permission to fire a budgeted stinger-class event. */
  requestSpend(kind: string): boolean {
    if (!this.canSpend(kind)) return false;
    this.spend(kind);
    return true;
  }
  remaining(kind: string): number {
    return Math.max(0, (CLICHE_BUDGET[kind] ?? 0) - (this.spends[kind] ?? 0));
  }

  snapshot(): DirectorState {
    const layers: string[] = [];
    if ((this.air?.level ?? 0) > 0.001) layers.push('air');
    if ((this.cluster?.level ?? 0) > 0.01) layers.push('cluster');
    if ((this.sub?.level ?? 0) > 0.01) layers.push('sub');
    if ((this.riser?.level ?? 0) > 0.01) layers.push('riser');
    return {
      act: this.act,
      tension: +this.tension.toFixed(4),
      silence: +this.silence.toFixed(4),
      cutToQuiet: this.cutRemaining > 0,
      layers,
      sub: +(this.sub?.level ?? 0).toFixed(4),
      cluster: +(this.cluster?.level ?? 0).toFixed(4),
      riser: +(this.riser?.level ?? 0).toFixed(4),
      air: +(this.air?.level ?? 0).toFixed(4),
      silenceSeconds: +this.silenceSeconds.toFixed(2),
      spends: { ...this.spends },
      reason: this.reason,
    };
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
