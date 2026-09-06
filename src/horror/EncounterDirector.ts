/**
 * ============================================================================
 * ENCOUNTER DIRECTOR — composes horror shots out of the live world
 * ============================================================================
 *
 * ## What it is
 *
 * The bridge between "the director would like some pressure" and "a specific
 * thing happens in a specific place". It owns three jobs:
 *
 *   1. **Type selection.** Which of the twelve encounter vocabularies is the
 *      right one right now, given the act, the phase, what the player has been
 *      doing, and — crucially — what has already happened this run.
 *   2. **Composition.** Where exactly to put the figure, scored like a camera
 *      operator would score it: occlusion, bearing, distance, terrain,
 *      backdrop. A sighting is a *shot*, not a spawn.
 *   3. **False signals.** Cues that resemble Palebark and are not.
 *
 * ## Composition, and why partial occlusion wins
 *
 * The scoring in `composeSighting` prefers a figure that is roughly half hidden
 * — behind a trunk, over a rise, at the edge of the beam. Three reasons, in
 * increasing order of importance:
 *
 *   - A fully visible figure can be *assessed*. Once assessed it is a model
 *     with a silhouette and a walk cycle, and it stops being frightening
 *     around the third viewing.
 *   - A half-seen figure is completed by the player, and what they complete it
 *     with is always worse than anything that can be authored.
 *   - It preserves deniability. "Was that it?" is a better state to leave a
 *     player in than "that was it", and it is the state that makes the *next*
 *     ambiguous shape in the trees do work for free.
 *
 * Peripheral placement is preferred for the same reason, with one deliberate
 * exception: `blocked` wants to be dead ahead, because its whole content is
 * "the way you were going is occupied".
 *
 * ## False positives are load-bearing
 *
 * `FALSE_POSITIVE.farFraction` guarantees that most ambiguous cues fire while
 * Palebark is genuinely far away. Without that guarantee the player derives
 * "sound = proximity" within about ten minutes, at which point the audio design
 * is a radar and the silences are safe. With it, every cue is a question, and
 * the player's own pattern-matching becomes the thing working against them —
 * which is both cheaper and far more effective than any stinger.
 */

import { SeededRandom } from '../core/SeededRandom';
import { ENCOUNTER, FALSE_POSITIVE, CADENCE } from './HorrorConfig';
import { EncounterMemory, type EncounterType } from './EncounterMemory';
import type { HorrorProgressionSnapshot } from './HorrorProgression';
import type { ThreatState } from './ThreatModel';
import type { HorrorDirector, TensionPhase } from './HorrorDirector';
import type { PlayerBehaviorSnapshot } from './PlayerBehaviorModel';
import type { EntityBrain, EntityIntent } from '../ai/EntityBrain';

/** The world queries the composer needs. Injected so this module stays pure-ish. */
export interface WorldProbe {
  /** terrain height */
  heightAt(x: number, z: number): number;
  /** true if a clean line exists between two points */
  losClear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean;
  /** 0..1 canopy/vegetation cover at a point — drives occlusion estimates */
  coverAt(x: number, z: number): number;
  /** metres to the nearest authored trail */
  trailDist(x: number, z: number): number;
  /** true if the point is in water */
  inLake(x: number, z: number): boolean;
  /** half-extent of the world */
  worldHalf: number;
}

export interface PlayerProbe {
  x: number; z: number; eyeY: number;
  /** planar forward, unit */
  fwdX: number; fwdZ: number;
  yaw: number;
  moving: boolean;
  lightOn: boolean;
}

/** A composed cue the game should realise. */
export interface CueRequest {
  /** where the sound appears to come from */
  x: number; y: number; z: number;
  /** distance from the player */
  distance: number;
  /** which flavour of world sound */
  kind: 'snap' | 'footfall' | 'shift' | 'call';
  /** 0..1 how localisable it is (low = hard to place, raises uncertainty) */
  localisability: number;
  /** true when Palebark genuinely made it */
  genuine: boolean;
}

/** A composed sighting the game should realise. */
export interface SightingRequest {
  x: number; z: number;
  distance: number;
  /** bearing relative to player facing */
  bearing: number;
  /** 0..1 how much of the figure resolves — drives dread vs uncertainty split */
  completeness: number;
  type: EncounterType;
}

export interface EncounterDirectorState {
  lastType: EncounterType | null;
  lastAt: number;
  attempted: number;
  fired: number;
  refused: number;
  falseCues: number;
  genuineCues: number;
  memory: ReturnType<EncounterMemory['snapshot']>;
  reason: string;
}

/**
 * Per-type metadata.
 *
 * `intensity` feeds the director's budget and recovery logic. `needsSighting`
 * marks the types that require a composed position; the rest are audio or
 * world events, which is why an act with no plausible sightline is not an act
 * with no encounters.
 */
interface TypeSpec {
  intensity: number;
  needsSighting: boolean;
  /** minimum act index (see HORROR_ACTS) */
  minAct: number;
}

const TYPES: Record<EncounterType, TypeSpec> = {
  // ---- arrival act: ambiguity only -----------------------------------------
  wrongTree: { intensity: 0.15, needsSighting: false, minAct: 0 },
  falseCue: { intensity: 0.2, needsSighting: false, minAct: 0 },
  absence: { intensity: 0.25, needsSighting: false, minAct: 0 },
  watcher: { intensity: 0.45, needsSighting: true, minAct: 0 },
  // ---- unease: it starts doing things ---------------------------------------
  crossing: { intensity: 0.4, needsSighting: true, minAct: 1 },
  shadow: { intensity: 0.35, needsSighting: false, minAct: 1 },
  secondLook: { intensity: 0.3, needsSighting: true, minAct: 1 },
  wrongness: { intensity: 0.3, needsSighting: false, minAct: 1 },
  // ---- stalking: it starts reasoning ---------------------------------------
  intercept: { intensity: 0.65, needsSighting: true, minAct: 2 },
  blocked: { intensity: 0.6, needsSighting: true, minAct: 2 },
  retreat: { intensity: 0.5, needsSighting: true, minAct: 2 },
  // ---- revelation: it stops being careful ----------------------------------
  closeSilence: { intensity: 0.85, needsSighting: false, minAct: 3 },
};

export class EncounterDirector {
  private rng: SeededRandom;
  private memory = new EncounterMemory();

  private evalAcc = 0;
  private cueTimer = 0;
  private runTime = 0;

  private lastType: EncounterType | null = null;
  private lastAt = -999;
  private attempted = 0;
  private fired = 0;
  private refused = 0;
  private falseCues = 0;
  private genuineCues = 0;
  private reason = 'idle';

  /** Set when a `blocked` encounter wants a specific route denied. */
  private deniedRoute: { x: number; z: number } | null = null;

  // ---- outputs -------------------------------------------------------------
  onCue: ((c: CueRequest) => void) | null = null;
  onSighting: ((s: SightingRequest) => void) | null = null;
  /** an `absence` beat: the world should go quiet and stay quiet */
  onAbsence: ((seconds: number) => void) | null = null;
  /** the world should change something the player might notice later */
  onWrongness: (() => void) | null = null;

  constructor(seed: number) {
    this.rng = new SeededRandom((seed ^ 0xE7C0DE) >>> 0);
  }

  begin(seed: number): void {
    this.rng = new SeededRandom((seed ^ 0xE7C0DE) >>> 0);
    this.memory.reset();
    this.evalAcc = 0;
    this.runTime = 0;
    this.lastType = null;
    this.lastAt = -999;
    this.attempted = 0; this.fired = 0; this.refused = 0;
    this.falseCues = 0; this.genuineCues = 0;
    this.deniedRoute = null;
    this.reason = 'run start';
    this.cueTimer = this.rng.range(20, 50);
  }

  get denied(): { x: number; z: number } | null { return this.deniedRoute; }

  // ------------------------------------------------------------------- update

  update(
    dt: number,
    ctx: {
      progression: HorrorProgressionSnapshot;
      threat: ThreatState;
      director: HorrorDirector;
      behaviour: PlayerBehaviorSnapshot;
      brain: EntityBrain;
      world: WorldProbe;
      player: PlayerProbe;
      entityDistance: number;
      entityVisible: boolean;
      /** uncollected objective positions — `blocked` aims at one */
      objectives: readonly { x: number; z: number }[];
    },
  ): void {
    this.runTime += dt;

    // Ambiguous cues run on their own schedule, independent of the encounter
    // budget. That independence is the point: cues must keep arriving during
    // recovery windows, or the player learns that quiet means safe.
    this.cueTimer -= dt;
    if (this.cueTimer <= 0) {
      this.scheduleCue(ctx);
    }

    this.evalAcc += dt;
    if (this.evalAcc < 1 / CADENCE.encounter) return;
    this.evalAcc = 0;

    this.evaluate(ctx);
  }

  // -------------------------------------------------------------- cue dispatch

  /**
   * Fire an ambiguous world sound.
   *
   * The genuine/false split is decided *first*, from the configured fraction,
   * and only then is a position chosen to match. Doing it in that order is what
   * guarantees the statistical property; deciding position first and labelling
   * afterwards would let the world's geometry bias the ratio.
   */
  private scheduleCue(ctx: Parameters<EncounterDirector['update']>[1]): void {
    const act = ctx.progression.act;
    const base = FALSE_POSITIVE.interval[act] ?? 45;
    const j = FALSE_POSITIVE.intervalJitter;
    this.cueTimer = base * this.rng.range(1 - j, 1 + j);
    // Never during a composed panic — a stray branch snap while the player is
    // being actively pursued is noise in the literal sense.
    if (ctx.director.currentPhase === 'panic') return;

    const far = ctx.entityDistance > FALSE_POSITIVE.farDistance;
    // Must this one be a false positive to keep the ratio honest?
    const wantFalse = this.rng.next() < FALSE_POSITIVE.farFraction;
    const genuine = !wantFalse && !far && ctx.entityDistance < 55;

    const p = ctx.player;
    const range = FALSE_POSITIVE.placementRange;
    let cx: number, cz: number;
    if (genuine) {
      // Palebark's actual position, offset — the spatialiser adds its own error
      // on top, so careful listening yields a direction and never a fix.
      const e = ctx.brain.pos;
      cx = e.x + this.rng.range(-6, 6);
      cz = e.z + this.rng.range(-6, 6);
    } else {
      // Placed in the world around the player, biased *away* from their facing.
      // A snap behind you is a question; a snap in front of you is scenery.
      const behind = Math.atan2(-p.fwdX, -p.fwdZ);
      const a = behind + this.rng.range(-1.5, 1.5);
      const r = this.rng.range(range.min, range.max);
      cx = p.x + Math.sin(a) * r;
      cz = p.z + Math.cos(a) * r;
    }
    if (Math.abs(cx) > ctx.world.worldHalf - 6 || Math.abs(cz) > ctx.world.worldHalf - 6) return;
    if (ctx.world.inLake(cx, cz)) return;

    const dist = Math.hypot(cx - p.x, cz - p.z);
    // Localisability falls with distance and with cover. Low values are the
    // interesting ones — a sound the player cannot place is what drives the
    // uncertainty channel, and uncertainty is what makes dread stick.
    const cover = ctx.world.coverAt(cx, cz);
    const localisability = Math.max(0.1, 1 - dist / 60 - cover * 0.35);

    const kinds: CueRequest['kind'][] = genuine
      ? ['footfall', 'snap', 'shift']
      : ['snap', 'shift', 'call', 'footfall'];
    const kind = kinds[this.rng.int(0, kinds.length - 1)];

    this.onCue?.({
      x: cx, y: ctx.world.heightAt(cx, cz) + 1.3, z: cz,
      distance: dist, kind, localisability, genuine,
    });
    if (genuine) this.genuineCues++; else this.falseCues++;
    this.memory.record({
      type: 'falseCue', time: this.runTime, x: cx, z: cz,
      distance: dist, direction: this.bearing(ctx.player, cx, cz),
      intensity: 0.15,
    });
  }

  // --------------------------------------------------------------- evaluation

  private evaluate(ctx: Parameters<EncounterDirector['update']>[1]): void {
    const { progression: prog, threat, director } = ctx;

    // The pick is made *before* the affordability check so the intensity of the
    // chosen type can be weighed — asking "may I spend 0.85" is a different
    // question from "may I spend anything".
    const type = this.chooseType(ctx);
    if (!type) { this.reason = 'no eligible type'; return; }
    const spec = TYPES[type];

    this.attempted++;
    if (!director.canSolicit(spec.intensity, prog, threat)) {
      this.refused++;
      this.reason = `refused ${type} (${director.snapshot().recovering ? 'recovering' : 'budget/cooldown'})`;
      return;
    }

    const ok = this.realise(type, ctx);
    if (!ok) {
      this.refused++;
      this.reason = `could not compose ${type}`;
      return;
    }

    this.fired++;
    this.lastType = type;
    this.lastAt = this.runTime;
    director.noteEncounter(spec.intensity, prog);
    this.reason = `fired ${type} (i=${spec.intensity})`;
  }

  /**
   * Weigh every act-legal type and take the best.
   *
   * Novelty is folded in as a multiplier on the *appetite* rather than as a
   * filter, so a type that fits the moment perfectly can still win after one
   * repetition, while a type that only marginally fits will not.
   */
  private chooseType(ctx: Parameters<EncounterDirector['update']>[1]): EncounterType | null {
    const { progression: prog, threat, director, behaviour: b } = ctx;
    const phase = director.currentPhase;
    const p = ctx.player;

    let best: EncounterType | null = null;
    let bestScore = 0;

    for (const key of Object.keys(TYPES) as EncounterType[]) {
      const spec = TYPES[key];
      if (prog.actIndex < spec.minAct) continue;

      let appetite = this.appetite(key, ctx, phase);
      if (appetite <= 0) continue;

      // Novelty is evaluated against a *representative* geometry for the type
      // rather than the final composed one, because composition is expensive
      // and most candidates lose here. The representative distance and bearing
      // are close enough for the repetition axes to be meaningful.
      const repDist = this.representativeDistance(key);
      const repBearing = this.representativeBearing(key, p);
      const nov = this.memory.novelty(
        key, p.x + Math.sin(repBearing + p.yaw) * repDist,
        p.z + Math.cos(repBearing + p.yaw) * repDist,
        repDist, repBearing, this.runTime);

      const score = appetite * (0.25 + nov * 0.85) * this.rng.range(0.85, 1.15);
      if (score > bestScore) { bestScore = score; best = key; }
    }
    // A floor, so a moment where nothing genuinely fits produces *nothing*
    // rather than the least-bad option. Doing nothing is a legitimate output
    // and the director is explicitly built to allow it.
    return bestScore > 0.22 ? best : null;
  }

  /** How much does this type suit the current moment? 0 = not at all. */
  private appetite(
    type: EncounterType,
    ctx: Parameters<EncounterDirector['update']>[1],
    phase: TensionPhase,
  ): number {
    const { threat, behaviour: b, progression: prog } = ctx;
    const far = ctx.entityDistance > 60;
    const intent = ctx.brain.intent;

    switch (type) {
      case 'watcher':
        // Wants a calm-ish moment and a player who is not already looking at
        // something. Being *found* watching is the payload, so it is worthless
        // during panic and best when dread is still climbing.
        return (phase === 'unease' || phase === 'calm' || phase === 'anticipation')
          ? 0.55 + b.stillness * 0.3 + (threat.perceivedDread < 0.5 ? 0.2 : 0)
          : 0.05;

      case 'crossing':
        // A brief transit across a gap. Best when the player is moving, because
        // it reads as two things travelling in a shared world rather than as a
        // display put on for them.
        return ctx.player.moving ? 0.5 + (far ? 0.1 : 0.2) : 0.15;

      case 'shadow':
        // Parallel footsteps, no visual. Strongest against players who rely on
        // their ears — which is to say, against players who do not sprint.
        return 0.45 + (1 - b.sprintReliance) * 0.25
          + (phase === 'anticipation' ? 0.2 : 0);

      case 'secondLook':
        // Needs the player to have somewhere peripheral to *not* be looking.
        return 0.35 + b.backwardChecking * 0.4;

      case 'intercept':
        // Only meaningful if the entity is actually intercepting; otherwise it
        // would be a coincidence dressed as an inference.
        return (intent === 'intercept' || intent === 'flank')
          ? 0.55 + b.routePredictability * 0.4 : 0.05;

      case 'blocked':
        // The player must have somewhere they are evidently heading.
        return ctx.objectives.length > 0
          ? 0.4 + b.trailPreference * 0.3 + b.routePredictability * 0.25 : 0.05;

      case 'retreat':
        // Requires that the player is currently looking at it — which is
        // checked properly in `realise`; here it is just an appetite.
        return ctx.entityVisible ? 0.7 : 0.02;

      case 'closeSilence':
        // The dangerous one. Deliberately gated on *low* dread: its entire
        // content is that the game gave no warning, and a player who is already
        // frightened has effectively been warned.
        return threat.perceivedDread < 0.45 && phase !== 'panic'
          ? 0.45 + (0.45 - threat.perceivedDread) : 0.02;

      case 'absence':
        // Silence as an event. Wants a moment that *feels* like something
        // should happen — so it is most valuable at the top of anticipation,
        // where it inverts the prediction instead of fulfilling it.
        return phase === 'anticipation' ? 0.5
          : phase === 'unease' ? 0.3 : 0.08;

      case 'wrongTree':
        // Free, cheap, deniable. Always mildly welcome, and the arrival act
        // leans on it because it is the only vocabulary available.
        return 0.3 + (prog.act === 'arrival' ? 0.3 : 0);

      case 'wrongness':
        return prog.environmentalDistortionUnlocked
          ? 0.35 + prog.normalizedProgress * 0.3 : 0;

      case 'falseCue':
        // Handled by its own scheduler; never selected here.
        return 0;
    }
  }

  private representativeDistance(type: EncounterType): number {
    switch (type) {
      case 'watcher': return 58;
      case 'crossing': return 34;
      case 'blocked': return 52;
      case 'intercept': return 30;
      case 'closeSilence': return 9;
      case 'retreat': return 26;
      case 'secondLook': return 22;
      default: return 30;
    }
  }

  private representativeBearing(type: EncounterType, p: PlayerProbe): number {
    // `blocked` is the one type that wants to be dead ahead; everything else
    // prefers the periphery.
    if (type === 'blocked') return 0;
    if (type === 'secondLook') return this.rng.sign() * 1.2;
    return this.rng.sign() * this.rng.range(0.5, 1.4);
  }

  // ------------------------------------------------------------- realisation

  private realise(
    type: EncounterType,
    ctx: Parameters<EncounterDirector['update']>[1],
  ): boolean {
    const p = ctx.player;

    switch (type) {
      case 'absence': {
        const secs = this.rng.range(9, 22);
        this.onAbsence?.(secs);
        this.note(type, p.x, p.z, 0, 0, TYPES[type].intensity);
        return true;
      }

      case 'wrongness': {
        this.onWrongness?.();
        this.note(type, p.x, p.z, 0, 0, TYPES[type].intensity);
        return true;
      }

      case 'wrongTree': {
        // No entity involvement at all. A shape that is genuinely vegetation,
        // positioned where the player's own pattern-matching will do the work.
        // This is the cheapest encounter in the game and among the most
        // effective, because the player supplies the monster.
        const s = this.composeSighting(ctx, {
          minDist: 26, maxDist: 60, wantOcclusion: 0.72, peripheral: true,
        });
        if (!s) return false;
        this.onSighting?.({ ...s, completeness: 0.2, type });
        this.note(type, s.x, s.z, s.distance, s.bearing, TYPES[type].intensity);
        return true;
      }

      case 'secondLook': {
        // Something at the edge of vision that will not be there on the second
        // look — realised as a very brief, very incomplete sighting with no
        // entity relocation, so checking genuinely finds nothing.
        const s = this.composeSighting(ctx, {
          minDist: 16, maxDist: 34, wantOcclusion: 0.8, peripheral: true,
        });
        if (!s) return false;
        this.onSighting?.({ ...s, completeness: 0.15, type });
        this.note(type, s.x, s.z, s.distance, s.bearing, TYPES[type].intensity);
        return true;
      }

      case 'shadow': {
        // Footsteps travelling parallel to the player. Two cues, offset along
        // the player's own axis of travel, so the sound genuinely *moves* with
        // them rather than sitting at a point.
        const side = this.rng.sign();
        const perpX = -p.fwdZ * side, perpZ = p.fwdX * side;
        const off = this.rng.range(14, 26);
        const cx = p.x + perpX * off + p.fwdX * this.rng.range(-6, 10);
        const cz = p.z + perpZ * off + p.fwdZ * this.rng.range(-6, 10);
        if (ctx.world.inLake(cx, cz)) return false;
        const dist = Math.hypot(cx - p.x, cz - p.z);
        this.onCue?.({
          x: cx, y: ctx.world.heightAt(cx, cz) + 1.3, z: cz,
          distance: dist, kind: 'footfall',
          localisability: 0.45, genuine: ctx.entityDistance < 70,
        });
        this.note(type, cx, cz, dist, this.bearing(p, cx, cz), TYPES[type].intensity);
        return true;
      }

      case 'watcher': {
        const s = this.composeSighting(ctx, {
          minDist: 45, maxDist: ENCOUNTER.maxSightingDistance,
          wantOcclusion: 0.4, peripheral: false, preferHigh: true,
        });
        if (!s) return false;
        // A real relocation, fully guarded by the brain. If the guards refuse
        // (the player can see the current spot, or the destination, or it is
        // too near) the encounter simply does not happen — that refusal is
        // what makes the guarantee "no visible teleportation" real rather than
        // aspirational.
        if (!ctx.brain.stagePosition(s.x, s.z, p, { minDistance: 40 })) return false;
        this.onSighting?.({ ...s, completeness: 0.65, type });
        this.note(type, s.x, s.z, s.distance, s.bearing, TYPES[type].intensity);
        return true;
      }

      case 'crossing': {
        const s = this.composeSighting(ctx, {
          minDist: 24, maxDist: 48, wantOcclusion: 0.6, peripheral: true,
        });
        if (!s) return false;
        if (!ctx.brain.stagePosition(s.x, s.z, p, { minDistance: 30 })) return false;
        this.onSighting?.({ ...s, completeness: 0.35, type });
        this.note(type, s.x, s.z, s.distance, s.bearing, TYPES[type].intensity);
        return true;
      }

      case 'intercept': {
        // No relocation: the entity walked here on its own initiative. All this
        // does is confirm the sighting so the *player* registers the inference.
        const e = ctx.brain.pos;
        const dist = Math.hypot(e.x - p.x, e.z - p.z);
        if (dist < 12 || dist > 70) return false;
        if (!ctx.world.losClear(p.x, p.eyeY, p.z, e.x, e.y + 2.2, e.z)) return false;
        const bearing = this.bearing(p, e.x, e.z);
        this.onSighting?.({
          x: e.x, z: e.z, distance: dist, bearing,
          completeness: 0.55, type,
        });
        this.note(type, e.x, e.z, dist, bearing, TYPES[type].intensity);
        return true;
      }

      case 'blocked': {
        // Stand far down the route the player is evidently taking. Aimed at the
        // nearest objective rather than at the player, which is what makes it
        // read as "it knows where I'm going" instead of "it found me".
        let target = ctx.objectives[0];
        let bd = Infinity;
        for (const o of ctx.objectives) {
          const d = Math.hypot(o.x - p.x, o.z - p.z);
          if (d > 30 && d < bd) { bd = d; target = o; }
        }
        if (!target || bd === Infinity) return false;
        // Partway along the line to that objective, offset slightly so it is
        // beside the route rather than standing on it like a checkpoint.
        const t = this.rng.range(0.45, 0.75);
        const bx = p.x + (target.x - p.x) * t + this.rng.range(-7, 7);
        const bz = p.z + (target.z - p.z) * t + this.rng.range(-7, 7);
        if (ctx.world.inLake(bx, bz)) return false;
        const dist = Math.hypot(bx - p.x, bz - p.z);
        if (dist < 28) return false;
        if (!ctx.brain.stagePosition(bx, bz, p, { minDistance: 28 })) return false;
        this.deniedRoute = { x: bx, z: bz };
        this.onSighting?.({
          x: bx, z: bz, distance: dist,
          bearing: this.bearing(p, bx, bz), completeness: 0.5, type,
        });
        this.note(type, bx, bz, dist, this.bearing(p, bx, bz), TYPES[type].intensity);
        return true;
      }

      case 'retreat': {
        // The entity is being looked at and withdraws. Realised purely as a
        // sighting record — the *behaviour* belongs to the brain's `retreat`
        // intent, which the director cannot and should not force.
        if (!ctx.entityVisible) return false;
        const e = ctx.brain.pos;
        const dist = Math.hypot(e.x - p.x, e.z - p.z);
        const bearing = this.bearing(p, e.x, e.z);
        this.onSighting?.({
          x: e.x, z: e.z, distance: dist, bearing, completeness: 0.45, type,
        });
        this.note(type, e.x, e.z, dist, bearing, TYPES[type].intensity);
        return true;
      }

      case 'closeSilence': {
        // Dangerously near, with almost nothing given away. Placed behind cover
        // *out* of the player's view, so the danger channel spikes while dread
        // and the presentation stay almost flat — the exact divergence the
        // threat model exists to permit.
        for (let i = 0; i < 12; i++) {
          const behind = Math.atan2(-p.fwdX, -p.fwdZ);
          const a = behind + this.rng.range(-1.2, 1.2);
          const r = this.rng.range(8, 17);
          const x = p.x + Math.sin(a) * r, z = p.z + Math.cos(a) * r;
          if (ctx.world.inLake(x, z)) continue;
          const y = ctx.world.heightAt(x, z);
          // It must NOT be visible. A close reveal is a jumpscare; a close
          // concealment is dread with a fuse.
          if (ctx.world.losClear(p.x, p.eyeY, p.z, x, y + 2.2, z)) continue;
          if (!ctx.brain.stagePosition(x, z, p, { minDistance: 8 })) continue;
          this.note(type, x, z, r, this.bearing(p, x, z), TYPES[type].intensity);
          return true;
        }
        return false;
      }

      case 'falseCue':
        return false;
    }
  }

  /**
   * Score candidate positions and return the best composed shot.
   *
   * This is the camera department. Each term below is a real cinematographic
   * preference, and the weights are what stop the system placing the figure
   * dead centre at a comfortable distance — which is what an unweighted
   * "somewhere the player can see" sampler does, every time.
   */
  private composeSighting(
    ctx: Parameters<EncounterDirector['update']>[1],
    opts: {
      minDist: number; maxDist: number;
      wantOcclusion: number;
      peripheral: boolean;
      preferHigh?: boolean;
    },
  ): { x: number; z: number; distance: number; bearing: number } | null {
    const p = ctx.player;
    const w = ctx.world;
    let bx = 0, bz = 0, bDist = 0, bBearing = 0, bestScore = -Infinity, found = false;

    for (let i = 0; i < ENCOUNTER.candidates; i++) {
      // Sample in the *player's* frame so bearing is controllable directly.
      const bearing = opts.peripheral
        ? this.rng.sign() * this.rng.range(0.35, 1.25)
        : this.rng.range(-0.9, 0.9);
      const dist = this.rng.range(opts.minDist, opts.maxDist);
      const a = Math.atan2(p.fwdX, p.fwdZ) + bearing;
      const x = p.x + Math.sin(a) * dist;
      const z = p.z + Math.cos(a) * dist;

      if (Math.abs(x) > w.worldHalf - 8 || Math.abs(z) > w.worldHalf - 8) continue;
      if (w.inLake(x, z)) continue;
      const y = w.heightAt(x, z);

      // It must be *possible* to see — a composition nobody can see is not a
      // composition. The eye height is the figure's chest, not its feet, so a
      // shape behind low deadfall still qualifies.
      const visible = w.losClear(p.x, p.eyeY, p.z, x, y + 2.0, z);
      if (!visible) continue;

      let score = 0;

      // 1. Occlusion, weighted highest. `coverAt` is the vegetation density,
      //    which is the best available proxy for "how much of the figure is
      //    behind something".
      const cover = w.coverAt(x, z);
      score += (1 - Math.abs(cover - opts.wantOcclusion)) * 1.5;

      // 2. Peripherality. Distance from the ideal off-axis angle, not from
      //    centre — being exactly centred and being exactly 90° off are both
      //    wrong, for different reasons.
      const offAxis = Math.abs(bearing);
      if (opts.peripheral) {
        score += (1 - Math.abs(offAxis - 0.85) / 1.2) * 0.7;
      } else {
        score += (1 - offAxis / 1.6) * 0.4;
      }

      // 3. Distance band preference: mid-far reads as a figure, near reads as a
      //    model, very far reads as a smudge.
      const dn = (dist - opts.minDist) / Math.max(1, opts.maxDist - opts.minDist);
      score += (1 - Math.abs(dn - 0.55)) * 0.5;

      // 4. Elevation. A silhouette on a rise against the sky is the strongest
      //    single composition this world can produce, so `watcher` asks for it.
      if (opts.preferHigh) {
        score += Math.max(0, Math.min(1, (y - w.heightAt(p.x, p.z)) / 14)) * 0.8;
      }

      // 5. Off-trail. A figure standing on the graded trail reads as a person;
      //    one at the treeline reads as something that lives there.
      score += Math.min(1, w.trailDist(x, z) / 14) * 0.3;

      // 6. Novelty against everything already staged this run.
      score *= 0.3 + this.memory.novelty(
        'watcher', x, z, dist, bearing, this.runTime) * 0.9;

      if (score > bestScore) {
        bestScore = score; bx = x; bz = z; bDist = dist; bBearing = bearing; found = true;
      }
    }
    return found ? { x: bx, z: bz, distance: bDist, bearing: bBearing } : null;
  }

  private bearing(p: PlayerProbe, x: number, z: number): number {
    const dx = x - p.x, dz = z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len, nz = dz / len;
    const dot = nx * p.fwdX + nz * p.fwdZ;
    const cross = p.fwdX * nz - p.fwdZ * nx;
    return Math.atan2(cross, dot);
  }

  private note(
    type: EncounterType, x: number, z: number,
    distance: number, direction: number, intensity: number,
  ): void {
    this.memory.record({ type, time: this.runTime, x, z, distance, direction, intensity });
  }

  /** Palebark's own behaviour produced an encounter — fold it into the memory. */
  noteIntentEncounter(intent: EntityIntent, x: number, z: number, distance: number): void {
    const map: Partial<Record<EntityIntent, EncounterType>> = {
      intercept: 'intercept', retreat: 'retreat', observe: 'watcher',
      shadow: 'shadow', flank: 'crossing',
    };
    const t = map[intent];
    if (!t) return;
    this.memory.record({
      type: t, time: this.runTime, x, z, distance,
      direction: 0, intensity: TYPES[t].intensity * 0.5,
    });
  }

  get memoryRef(): EncounterMemory { return this.memory; }

  snapshot(): EncounterDirectorState {
    return {
      lastType: this.lastType,
      lastAt: +this.lastAt.toFixed(1),
      attempted: this.attempted,
      fired: this.fired,
      refused: this.refused,
      falseCues: this.falseCues,
      genuineCues: this.genuineCues,
      memory: this.memory.snapshot(),
      reason: this.reason,
    };
  }
}
