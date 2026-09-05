/**
 * ============================================================================
 * THREAT MODEL — danger, dread and uncertainty, kept deliberately apart
 * ============================================================================
 *
 * ## What was wrong with "fear"
 *
 * `FearSystem` smoothed one number out of Palebark's detection level and fed it
 * to the static overlay, the tremor, the wind and the audio bed. It worked, and
 * that was the problem: because a single value drove every channel, and because
 * that value was a monotone function of detection and distance, the veil on
 * screen *was* a proximity readout. Within a few minutes players stop looking
 * at the forest and start reading the overlay, and once they can read the
 * overlay the forest holds nothing — they know when they are safe.
 *
 * ## Three channels, allowed to disagree
 *
 * `actualDanger`    Is the player genuinely in trouble right now? Distance,
 *                   line of sight, detection, current intent, whether an
 *                   interception is live. This drives *consequences*, and it is
 *                   the channel the player is least allowed to read.
 *
 * `perceivedDread`  How bad does this *feel*? Recent sightings, unexplained
 *                   sounds, darkness, silence, isolation, environmental
 *                   wrongness, narrative weight. This drives almost all of the
 *                   presentation, and it is the channel the player learns to
 *                   read — which is fine, because it is often wrong.
 *
 * `uncertainty`     How little does the player reliably know? Rises when
 *                   Palebark vanishes, when cues are hard to localise, when a
 *                   sighting was partial, when the last known position has gone
 *                   stale. Drives ambiguity in the mix and the *width* of the
 *                   presentation rather than its intensity.
 *
 * The design requirement is divergence, and it is worth being explicit about
 * the two cases that matter:
 *
 *   danger 0.15 · dread 0.90 · uncertainty 0.95
 *     Palebark is on the far ridge. The player is terrified. Nothing is wrong.
 *     This is where most of a run should live.
 *
 *   danger 0.90 · dread 0.20 · uncertainty 0.40
 *     Palebark is nine metres behind a rock, intent to confront, and the game
 *     is telling the player almost nothing. This is the moment the whole
 *     separation exists to permit — and it is impossible to build with one
 *     number, because one number cannot be simultaneously high and quiet.
 *
 * ## Why the presentation is mostly dread
 *
 * Deliberate. The overlay is a *feeling* meter, not a sensor. Danger is allowed
 * a small share (§THREAT.staticDangerWeight) because a total decoupling reads
 * as unfair — some tiny physiological leak makes the near-misses land in
 * hindsight — but it is small enough that it cannot be used as a locator.
 */

import { THREAT } from './HorrorConfig';
import type { HorrorProgressionSnapshot } from './HorrorProgression';

export interface ThreatState {
  actualDanger: number;
  perceivedDread: number;
  uncertainty: number;
}

/** Everything the model needs from the rest of the game, once per tick. */
export interface ThreatInput {
  /** true distance to Palebark, metres */
  entityDistance: number;
  /** Palebark's detection accumulator, 0..1 */
  detection: number;
  /** Palebark currently has clean LOS to the player */
  entityHasLos: boolean;
  /** the player can currently see Palebark */
  entityVisible: boolean;
  /** Palebark's current intent, as a danger weight 0..1 (see INTENT_DANGER) */
  intentDanger: number;
  /** an interception is actively being executed against the player's route */
  intercepting: boolean;
  /** how confident Palebark is about where the player is, 0..1 */
  knowledgeConfidence: number;
  /** seconds since Palebark last had *any* contact with the player */
  contactAge: number;

  /** 0..1 how dark it is where the player stands (canopy + no moon + no beam) */
  darkness: number;
  /** 0..1 how exposed/open the player's position is */
  exposure: number;
  /** 0..1 how quiet the world currently is, from the audio director */
  silence: number;
  /** the player is sprinting — physiologically loud, narrows attention */
  sprinting: boolean;
  /** flashlight is on — comforting, and a beacon */
  lightOn: boolean;
  /** battery 0..1; a dying lamp is its own dread source */
  battery: number;

  progression: HorrorProgressionSnapshot;
}

/** Named intents mapped to how dangerous they actually are. */
export const INTENT_DANGER: Record<string, number> = {
  dormant: 0.0,
  observe: 0.08,
  investigate: 0.18,
  search: 0.16,
  shadow: 0.34,
  flank: 0.45,
  intercept: 0.6,
  hide: 0.12,
  retreat: 0.04,
  confront: 0.9,
  pursue: 0.95,
  disengage: 0.02,
};

/**
 * A decaying impression. Sightings and unexplained cues do not raise dread
 * instantaneously and then vanish — they *sit* on the player, which is why the
 * ten seconds after a glimpse are worse than the glimpse.
 */
interface Impression {
  weight: number;
  halfLife: number;
}

export class ThreatModel {
  private state: ThreatState = { actualDanger: 0, perceivedDread: 0, uncertainty: 0 };

  /** Decaying dread sources, kept as a small fixed set rather than a list. */
  private sighting: Impression = { weight: 0, halfLife: THREAT.sightingHalfLife };
  private cue: Impression = { weight: 0, halfLife: THREAT.cueHalfLife };
  private wrongness: Impression = { weight: 0, halfLife: 40 };

  /** Seconds since literally anything happened — silence becomes a signal. */
  private quietFor = 0;
  /** Seconds since the player last saw Palebark. */
  private sinceSighting = 999;
  /** Localisation quality of the most recent cue, 0 (pinpoint) .. 1 (nowhere). */
  private cueAmbiguity = 0;

  /** One-frame flash amount, for the composite's glimpse channel. */
  glimpse = 0;
  private glimpseCooldown = 0;

  reset(): void {
    this.state.actualDanger = 0;
    this.state.perceivedDread = 0;
    this.state.uncertainty = 0;
    this.sighting.weight = 0;
    this.cue.weight = 0;
    this.wrongness.weight = 0;
    this.quietFor = 0;
    this.sinceSighting = 999;
    this.cueAmbiguity = 0;
    this.glimpse = 0;
    this.glimpseCooldown = 0;
  }

  // ------------------------------------------------------------------- events

  /**
   * The player confirmed a sighting.
   *
   * `completeness` is how much of the figure was resolvable — a full-body
   * silhouette across a clearing is 1, a shape three-quarters behind a trunk is
   * 0.3. Partial sightings raise *less* dread and *more* uncertainty, which is
   * the whole reason the composition system prefers them.
   */
  notifySighting(distance: number, completeness: number): void {
    const near = 1 - Math.min(1, distance / 70);
    this.sighting.weight = Math.min(1.4,
      this.sighting.weight + THREAT.sightingDread * (0.55 + near * 0.75));
    this.sinceSighting = 0;
    this.quietFor = 0;
    // An incomplete sighting is the one that keeps working: the player knows
    // they saw *something* and cannot say what.
    this.cueAmbiguity = Math.max(this.cueAmbiguity, 1 - Math.min(1, completeness));
    if (this.glimpseCooldown <= 0) {
      this.glimpse = 0.65 + completeness * 0.35;
      this.glimpseCooldown = 5;
    }
  }

  /**
   * An unexplained cue reached the player.
   *
   * Called for real Palebark footfalls *and* for false positives, with no way
   * for the model to tell them apart — which is correct, because the player
   * cannot either. `ambiguity` is how hard it was to localise.
   */
  notifyCue(strength: number, ambiguity: number): void {
    this.cue.weight = Math.min(1.3, this.cue.weight + THREAT.cueDread * strength);
    this.cueAmbiguity = Math.max(this.cueAmbiguity * 0.6, ambiguity);
    this.quietFor = 0;
  }

  /** The player noticed something about the world that should not have changed. */
  notifyWrongness(strength: number): void {
    this.wrongness.weight = Math.min(1.2, this.wrongness.weight + THREAT.wrongnessDread * strength);
    this.quietFor = 0;
  }

  // ------------------------------------------------------------------- update

  update(dt: number, input: ThreatInput): ThreatState {
    this.decay(dt);
    const target = this.composeTargets(input);

    // Asymmetric slew on each channel independently, with deliberately
    // different personalities:
    //
    //   danger      snaps up and drains quickly — it is a fact about the world,
    //               and lagging it would make the model lie about safety.
    //   dread       climbs fast, leaves slowly. Bodies do not calm down in two
    //               seconds, and this is the channel that models the body.
    //   uncertainty drifts both ways. Confusion neither arrives nor resolves
    //               abruptly; it accumulates.
    this.state.actualDanger = slew(this.state.actualDanger, target.actualDanger,
      dt, THREAT.dangerRise, THREAT.dangerFall);
    this.state.perceivedDread = slew(this.state.perceivedDread, target.perceivedDread,
      dt, THREAT.dreadRise, THREAT.dreadFall);
    this.state.uncertainty = slew(this.state.uncertainty, target.uncertainty,
      dt, THREAT.uncertaintyRise, THREAT.uncertaintyFall);

    this.glimpse = Math.max(0, this.glimpse - dt * 4);
    this.glimpseCooldown = Math.max(0, this.glimpseCooldown - dt);
    return this.state;
  }

  private decay(dt: number): void {
    decayImpression(this.sighting, dt);
    decayImpression(this.cue, dt);
    decayImpression(this.wrongness, dt);
    this.quietFor += dt;
    this.sinceSighting += dt;
    this.cueAmbiguity = Math.max(0, this.cueAmbiguity - dt * 0.05);
  }

  /** Compose the three raw targets. Pure — no state written. */
  private composeTargets(i: ThreatInput): ThreatState {
    // ================= ACTUAL DANGER =================
    // What could plausibly go wrong in the next few seconds. Intent is the
    // dominant term rather than distance, because a dormant Palebark at ten
    // metres is harmless and an intercepting one at fifty is not.
    const prox = i.entityDistance <= THREAT.dangerCloseRange ? 1
      : Math.max(0, 1 - (i.entityDistance - THREAT.dangerCloseRange)
          / Math.max(1, THREAT.dangerRange - THREAT.dangerCloseRange));
    let danger = i.intentDanger * (0.35 + prox * 0.65);
    // Knowing where you are is most of the work; LOS is the rest.
    danger = Math.max(danger, i.detection * i.knowledgeConfidence * prox);
    if (i.entityHasLos) danger = Math.max(danger, 0.22 + prox * 0.5);
    if (i.intercepting) danger = Math.max(danger, 0.45 + prox * 0.35);
    // Genuinely adjacent is genuinely lethal regardless of what it is doing.
    if (i.entityDistance < 6) danger = Math.max(danger, 0.85);
    danger = clamp01(danger);

    // ================= PERCEIVED DREAD =================
    // Deliberately built from things the *player* has experienced, not from
    // Palebark's state. Note that nothing in this block reads
    // `entityDistance` on its own — proximity is not frightening, it is only
    // dangerous, and conflating them is what made the old system a radar.
    const p = i.progression;
    // A slow narrative floor: the same forest is worse once you know what the
    // tapes say about it.
    const narrativeFloor = 0.04 + p.normalizedProgress * 0.2
      + (p.escapeActive ? 0.12 : 0);
    // Silence only becomes dreadful once it has gone on long enough to feel
    // deliberate. Below the onset it is just a quiet forest.
    const silenceDread = i.silence
      * clamp01((this.quietFor - THREAT.silenceDreadOnset) / 60) * 0.34;
    // Being watched is worse than being hunted, so a visible figure carries
    // more dread than a close invisible one.
    const watched = i.entityVisible ? 0.4 + (1 - Math.min(1, i.entityDistance / 60)) * 0.28 : 0;
    // Vulnerability: dark, exposed, out of battery, out of breath.
    const vulnerability =
      i.darkness * 0.22
      + i.exposure * 0.12
      + (1 - i.battery) * (i.lightOn ? 0.16 : 0.06)
      + (i.sprinting ? 0.05 : 0);

    let dread =
      narrativeFloor
      + this.sighting.weight * 0.62
      + this.cue.weight * 0.5
      + this.wrongness.weight * 0.55
      + silenceDread
      + watched
      + vulnerability;
    // Uncertainty amplifies dread rather than adding to it: not knowing is only
    // frightening when there is something to not know about.
    dread *= 1 + this.state.uncertainty * 0.22;
    dread = clamp01(dread);

    // ================= UNCERTAINTY =================
    // The player's information deficit. Rises with staleness — the longer since
    // Palebark was located, the less any belief the player holds is worth.
    const staleness = clamp01(this.sinceSighting / THREAT.staleKnowledgeSeconds);
    // A figure that *was* there and is now gone is the single strongest
    // uncertainty source in the genre; a figure currently in view is the
    // weakest, because it resolves the question.
    const vanished = i.entityVisible ? 0
      : clamp01((6 - Math.min(6, this.sinceSighting)) / 6) * 0.55;
    let uncertainty =
      0.1
      + staleness * 0.4
      + vanished
      + this.cueAmbiguity * 0.3
      + i.darkness * 0.16
      + this.wrongness.weight * 0.25
      // Knowing that *it* knows where you are is, perversely, clarifying.
      - i.knowledgeConfidence * 0.12;
    if (i.entityVisible) uncertainty -= 0.3;
    uncertainty = clamp01(uncertainty);

    return { actualDanger: danger, perceivedDread: dread, uncertainty };
  }

  // -------------------------------------------------------------- presentation

  get current(): ThreatState { return this.state; }
  get danger(): number { return this.state.actualDanger; }
  get dread(): number { return this.state.perceivedDread; }
  get uncertainty(): number { return this.state.uncertainty; }
  /** Seconds since the last event of any kind — the director protects this. */
  get quietSeconds(): number { return this.quietFor; }
  get secondsSinceSighting(): number { return this.sinceSighting; }

  /**
   * Static/veil amount for the composite.
   *
   * Mostly dread, a little danger. The squared curve keeps the overlay honest
   * at low values: a light haze at dread 0.3 would be a permanent fixture, and
   * a permanent fixture carries no information at all.
   */
  get staticLevel(): number {
    const v = this.state.perceivedDread * THREAT.staticDreadWeight
      + this.state.actualDanger * THREAT.staticDangerWeight;
    return Math.min(1, v * v * 1.15);
  }

  get desat(): number {
    return 0.2 + this.state.perceivedDread * 0.42;
  }

  /**
   * Camera tremor.
   *
   * Driven by dread with a *floor* from danger, so a player who is genuinely
   * about to be caught in silence gets the faintest physical hint without the
   * screen announcing it.
   */
  get tremor(): number {
    return Math.max(this.state.perceivedDread * 0.85, this.state.actualDanger * 0.2);
  }

  /**
   * Legacy single-value accessor.
   *
   * Retained because the wind, the fog density and the exposure grade all took
   * a scalar, and re-deriving art direction from three channels is not what
   * this change is for. It is dread, not danger — those consumers are all
   * *presentation*, and presentation follows feeling.
   */
  get value(): number { return this.state.perceivedDread; }

  /** Debug/QA override. Sets dread only; danger is owned by the world. */
  forceDread(v: number): void {
    this.state.perceivedDread = clamp01(v);
  }

  snapshot(): ThreatState & {
    quietSeconds: number; sinceSighting: number; cueAmbiguity: number;
  } {
    return {
      actualDanger: +this.state.actualDanger.toFixed(4),
      perceivedDread: +this.state.perceivedDread.toFixed(4),
      uncertainty: +this.state.uncertainty.toFixed(4),
      quietSeconds: +this.quietFor.toFixed(2),
      sinceSighting: +Math.min(999, this.sinceSighting).toFixed(2),
      cueAmbiguity: +this.cueAmbiguity.toFixed(3),
    };
  }
}

function decayImpression(im: Impression, dt: number): void {
  if (im.weight <= 0) { im.weight = 0; return; }
  im.weight *= Math.pow(0.5, dt / im.halfLife);
  if (im.weight < 0.002) im.weight = 0;
}

function slew(cur: number, target: number, dt: number, rise: number, fall: number): number {
  const rate = target > cur ? rise : fall;
  return cur + (target - cur) * Math.min(1, dt * rate);
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
