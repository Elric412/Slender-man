import * as THREE from 'three';
import { NavWorld } from './NavWorld';
import { CollisionWorld } from '../physics/Collision';
import { HeightField } from '../world/HeightField';
import { SeededRandom } from '../core/SeededRandom';
import { PalebarkMemory, type Landmark } from './PalebarkMemory';
import {
  HorrorProgression, type HorrorProgressionSnapshot, actAtLeast,
} from '../horror/HorrorProgression';
import { PERCEPTION, CADENCE } from '../horror/HorrorConfig';
import type { PlayerBehaviorSnapshot } from '../horror/PlayerBehaviorModel';

/**
 * ============================================================================
 * PALEBARK — a patient thing with incomplete information
 * ============================================================================
 *
 * ## What changed, and why the old shape had to go
 *
 * The previous brain was a four-state machine —
 * `dormant → investigating → stalking → confronting` — driven by a single
 * `detection` accumulator, with an act ceiling clamping how far up the ladder
 * it could climb. It worked, and it had two structural problems that no amount
 * of tuning could reach:
 *
 * **1. Escalation was one-dimensional.** Every state was strictly more
 * dangerous than the one below it, so the only decision the brain ever made was
 * "how alarmed am I". A creature that can only become *more* interested cannot
 * do the things that make a stalker frightening: withdraw when noticed, wait
 * somewhere you are going to walk, watch from a ridge and then leave, decline
 * an opportunity it has clearly earned. Those are lateral moves, and a ladder
 * has no lateral moves.
 *
 * **2. It knew everything.** `lastKnownPlayer` was the player's exact position,
 * refreshed on every frame with line of sight and never expiring. So the
 * "stalk" state was really "walk to the player with an offset", and breaking
 * contact changed nothing.
 *
 * ## The shape now
 *
 * Two vocabularies, held apart on purpose:
 *
 * - **Intent** (twelve verbs) is what the brain reasons about. Intents are
 *   *scored* against each other a few times a second, not transitioned between,
 *   so choosing to hide can beat choosing to close even when the opportunity is
 *   excellent — which is the entire difference between a predator and a
 *   pursuit AI.
 * - **State** (the original four) is a *projection* of intent, kept because the
 *   animator reasons about bodies and the audio director reasons about phases.
 *   `main.ts` already documented that separation; this makes it real.
 *
 * Knowledge lives in `PalebarkMemory` and is a belief with error and decay.
 * This class is not permitted to read the player's true position for any
 * decision — only for perception tests (can I see you *right now*) and for the
 * capture check. Every target it walks to is derived from what it believes.
 *
 * ## Scoring, not maximising
 *
 * `chooseIntent` does not pick the intent with the highest chance of catching
 * the player. It weighs each verb's *appetite* against the director's permitted
 * pressure and against how recently it has done anything at all. A high-scoring
 * confront is refused outright when the director is protecting a recovery
 * window. That refusal is the feature: a thing that could have taken you and
 * did not is far worse than a thing that tried and failed.
 */

/** The projection consumed by the animator and the audio phase. */
export type EntityState = 'dormant' | 'investigating' | 'stalking' | 'confronting';

/**
 * What Palebark is actually trying to do.
 *
 * Ordered roughly by escalation, but the ordering is *not* load-bearing — the
 * point of intents is that they are alternatives rather than rungs.
 */
export type EntityIntent =
  /** no belief, no interest; drifting between places */
  | 'dormant'
  /** hold a distant position with sight of the believed player, and watch */
  | 'observe'
  /** go and check a specific noise */
  | 'investigate'
  /** belief has gone stale; sweep the area it last covered */
  | 'search'
  /** move parallel to the believed route, matching pace, staying off it */
  | 'shadow'
  /** swing wide around the player's facing to approach from an unwatched arc */
  | 'flank'
  /** go to a *predicted* future position and wait there */
  | 'intercept'
  /** break sightline and stand still behind cover */
  | 'hide'
  /** withdraw from a position the player is currently looking at */
  | 'retreat'
  /** close deliberately, with the intention of being seen doing it */
  | 'confront'
  /** committed final approach */
  | 'pursue'
  /** deliberately abandon the encounter and leave */
  | 'disengage';

export interface SoundEvent {
  x: number; z: number; loudness: number; // 0..1
}

/**
 * A flattened view of whoever is looking.
 *
 * Deliberately not `Player` and not a THREE.Vector3 pair: the visibility guards
 * are the most safety-critical code in this file (they are what makes "no
 * visible teleportation" true rather than intended), and they must be callable
 * from the encounter director without that module having to construct fake
 * Vector3s. A flat struct also makes them trivially testable.
 */
export interface ViewerProbe {
  x: number; z: number;
  /** eye height in world Y */
  eyeY: number;
  /** planar forward, unit */
  fwdX: number; fwdZ: number;
}

/**
 * Guidance from the HorrorDirector.
 *
 * The brain is *capable* of more than it is usually allowed to do. This is how
 * pacing reaches the AI without the AI having to know what pacing is.
 */
export interface BrainDirective {
  /** 0..1 how much pressure the director currently wants applied */
  pressure: number;
  /** false during a protected recovery window: no new escalation may begin */
  allowEscalation: boolean;
  /** the director would like a sighting composed; encourages observe/flank */
  wantSighting: boolean;
  /** the director is protecting quiet: prefer hide/disengage/dormant */
  wantQuiet: boolean;
}

export interface EntitySnapshot {
  state: EntityState;
  /** the richer decision — what it is actually doing */
  intent: EntityIntent;
  detection: number;      // 0..1 accumulated
  x: number; y: number; z: number;
  visibleToPlayer: boolean;
  distToPlayer: number;
  speed: number;
  /** legacy milestone act (0 early / 1 mid / 2 late), derived from progression */
  act: 0 | 1 | 2;
  /** the extension/reach beat may play at all */
  extensionEligible: boolean;
  /** the brain is asking for the extension beat *this frame* */
  extensionRequest: boolean;

  // ---- knowledge (for the threat model, the HUD and the tests) ----
  /** 0..1 how sure it is about where the player is */
  knowledgeConfidence: number;
  /** seconds since it had any contact with the player */
  contactAge: number;
  /** it currently has clean line of sight to the player */
  hasLos: boolean;
  /** an interception is live against a predicted route point */
  intercepting: boolean;
  /** 0..1 danger weight of the current intent (see INTENT_DANGER) */
  intentDanger: number;
}

/**
 * Danger weight per intent.
 *
 * Mirrors `INTENT_DANGER` in ThreatModel and is exported from here because the
 * brain is the authority on what its own verbs mean. Note how flat the top of
 * the range is and how *low* observe/hide/retreat sit: most of what a stalker
 * does is not dangerous, which is exactly why the moments that are land.
 */
export const INTENT_DANGER: Record<EntityIntent, number> = {
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

/** Intent → body/phase projection. */
const INTENT_STATE: Record<EntityIntent, EntityState> = {
  dormant: 'dormant',
  observe: 'investigating',
  investigate: 'investigating',
  search: 'investigating',
  shadow: 'stalking',
  flank: 'stalking',
  intercept: 'stalking',
  hide: 'stalking',
  retreat: 'stalking',
  confront: 'confronting',
  pursue: 'confronting',
  disengage: 'dormant',
};

/**
 * Movement speeds, metres per second, by intent.
 *
 * **These do not scale with the act.** That is a hard design rule, not an
 * oversight: "more tapes = faster monster" is the failure mode this whole pass
 * exists to avoid. What the late game unlocks is *which of these verbs are
 * legal*, and the escape act adds pressure by intercepting more often and
 * denying routes — never by multiplying a number here.
 */
const INTENT_SPEED: Record<EntityIntent, number> = {
  dormant: 1.5,
  observe: 0.0,        // standing still is the whole point
  investigate: 2.2,
  search: 2.0,
  shadow: 2.9,
  flank: 3.1,
  intercept: 3.3,      // it has somewhere to be *before* you
  hide: 2.4,
  retreat: 2.6,
  confront: 3.4,
  pursue: 4.6,
  disengage: 2.2,
};

/** Which intents each act permits. The only thing progression actually gates. */
const ACT_INTENTS: Record<string, readonly EntityIntent[]> = {
  arrival: ['dormant', 'investigate', 'search', 'observe', 'hide', 'disengage'],
  unease: ['dormant', 'investigate', 'search', 'observe', 'hide', 'disengage',
    'shadow', 'retreat'],
  stalking: ['dormant', 'investigate', 'search', 'observe', 'hide', 'disengage',
    'shadow', 'retreat', 'flank', 'intercept'],
  revelation: ['dormant', 'investigate', 'search', 'observe', 'hide', 'disengage',
    'shadow', 'retreat', 'flank', 'intercept', 'confront', 'pursue'],
  escape: ['dormant', 'investigate', 'search', 'observe', 'hide', 'disengage',
    'shadow', 'retreat', 'flank', 'intercept', 'confront', 'pursue'],
};

const LEGACY_ACT: Record<string, 0 | 1 | 2> = {
  arrival: 0, unease: 1, stalking: 1, revelation: 2, escape: 2,
};

export class EntityBrain {
  /** legacy projection, read by the animator, the audio phase and the tell */
  state: EntityState = 'dormant';
  /** the real decision */
  intent: EntityIntent = 'dormant';
  detection = 0;
  pos = new THREE.Vector3();
  yaw = 0;

  /** Palebark's belief about the player. Public so the HUD can show it. */
  readonly memory: PalebarkMemory;

  private nav: NavWorld;
  private col: CollisionWorld;
  private hf: HeightField;
  private rng: SeededRandom;

  private path: number[] = [];
  private pathIdx = 0;
  private pathScratch: number[] = [];
  private wp = { x: 0, z: 0 };
  private target = new THREE.Vector3();
  private investigatePoint = new THREE.Vector3();
  private investigateTimer = 0;
  private repathTimer = 0;
  private suspicion = 0;
  private lookAtTimer = 0;
  private freezeTimer = 0;
  private relocateCooldown = 0;
  private glimpseRequested = false;
  private confrontCommitted = false;

  /** Progression is read, never owned. One authority, per HorrorProgression. */
  private prog: HorrorProgressionSnapshot;
  private directive: BrainDirective = {
    pressure: 0.3, allowEscalation: true, wantSighting: false, wantQuiet: false,
  };
  private behaviour: PlayerBehaviorSnapshot = {
    sprintReliance: 0.25, flashlightReliance: 0.4, backwardChecking: 0.25,
    routePredictability: 0.5, stillness: 0.25, trailPreference: 0.5,
  };

  /** Landmarks the prediction model may snap to. Set once per run. */
  private landmarks: Landmark[] = [];

  // ---- intent bookkeeping ----
  /** seconds the current intent has been held — intents have inertia */
  private intentAge = 0;
  /** minimum hold before the intent may be reconsidered at all */
  private intentMinHold = 2;
  /** live interception goal, or null */
  private interceptAt: { x: number; z: number; isGuess: boolean } | null = null;
  private interceptWait = 0;
  /** where observe/hide chose to stand */
  private postAt: { x: number; z: number } | null = null;
  private postHold = 0;
  /** seconds since the last escalation of any kind — feeds intent appetite */
  private sinceEscalation = 0;

  // ---- cadences ----
  private perceptAcc = 0;
  private intentAcc = 0;

  // ---- extension / reach beat ----
  private extensionCooldown = 0;
  private extensionRequest = false;

  // ---- anti-repetition ----
  /**
   * Per-run seeded jitter, forked from a different salt than `rng` so movement
   * noise and choice noise cannot correlate. If they shared a stream the
   * entity's route would predict its decisions, which is a subtle but real
   * source of learnability.
   */
  private variation: SeededRandom;
  private sightingSites: { x: number; z: number; t: number }[] = [];
  private holdFor = 0;
  private stalkBias = 0;
  private stalkRange = 1;

  private readonly eyeHeight = 2.6;

  onGlimpse: (() => void) | null = null;
  onCaptured: (() => void) | null = null;
  onFootfall: ((x: number, z: number, dist: number) => void) | null = null;
  /** Fired when the intent changes — the encounter director listens. */
  onIntentChange: ((intent: EntityIntent, previous: EntityIntent) => void) | null = null;

  constructor(nav: NavWorld, col: CollisionWorld, hf: HeightField, seed: number) {
    this.nav = nav; this.col = col; this.hf = hf;
    this.rng = new SeededRandom(seed ^ 0xE77177);
    this.variation = new SeededRandom(seed ^ 0x9E3779B9);
    this.memory = new PalebarkMemory(seed);
    // A private progression is held so the brain is never in an undefined state
    // before main.ts pushes the shared one. It is immediately overwritten.
    this.prog = new HorrorProgression().snapshot;
    this.landmarks = hf.layout.zones.map(z => ({ x: z.x, z: z.z, id: z.id }));
    this.respawnFar(new THREE.Vector3(hf.layout.spawn.x, 0, hf.layout.spawn.z));
  }

  /**
   * Re-seed the discretionary choices for a new run.
   *
   * The world seed stays fixed (the map must be consistent and benchmarkable),
   * so this — plus the encounter director's own stream — is what makes run two
   * differ from run one.
   */
  reseed(runSeed: number): void {
    this.variation = new SeededRandom(runSeed ^ 0x9E3779B9);
    this.rng = new SeededRandom(runSeed ^ 0xE77177);
    this.memory.reseed(runSeed);
    this.sightingSites.length = 0;
    this.extensionCooldown = 0;
    this.extensionRequest = false;
    this.holdFor = 0;
    this.intent = 'dormant';
    this.state = 'dormant';
    this.intentAge = 0;
    this.interceptAt = null;
    this.postAt = null;
    this.sinceEscalation = 0;
  }

  respawnFar(playerPos: THREE.Vector3): void {
    const zones = this.hf.layout.zones;
    let best = zones[0], bd = -1;
    for (const z of zones) {
      const d = Math.hypot(z.x - playerPos.x, z.z - playerPos.z);
      if (d > bd) { bd = d; best = z; }
    }
    this.pos.set(best.x + this.rng.range(-8, 8), 0, best.z + this.rng.range(-8, 8));
    this.pos.y = this.hf.heightAt(this.pos.x, this.pos.z);
    this.state = 'dormant';
    this.intent = 'dormant';
    this.detection = 0;
    this.suspicion = 0;
    this.memory.forget();
    this.path.length = 0;
    this.confrontCommitted = false;
    this.extensionCooldown = 0;
    this.extensionRequest = false;
    this.interceptAt = null;
    this.postAt = null;
  }

  // ------------------------------------------------------------------ inputs

  /** Push the canonical progression snapshot. Called every frame by main. */
  setProgression(p: HorrorProgressionSnapshot): void { this.prog = p; }

  /** Push the director's pacing guidance. */
  setDirective(d: BrainDirective): void { this.directive = d; }

  /** Push the rolling behavioural model. */
  setBehaviour(b: PlayerBehaviorSnapshot): void { this.behaviour = b; }

  /**
   * Extra destinations the prediction model may consider.
   *
   * Uncollected tape sites are the strongest possible signal about where a
   * player is *going*, and a creature that has watched several survey crews do
   * exactly this would plausibly know it. Passed in rather than queried so the
   * brain keeps no dependency on the tape system.
   */
  setPredictionTargets(points: readonly Landmark[]): void {
    this.landmarks.length = 0;
    for (const z of this.hf.layout.zones) this.landmarks.push({ x: z.x, z: z.z, id: z.id });
    for (const p of points) this.landmarks.push(p);
  }

  /** Legacy shim. Escalation is progression's job now; kept for call sites. */
  setEscalation(_t: number): void { /* progression owns the arc */ }

  get currentAct(): 0 | 1 | 2 { return LEGACY_ACT[this.prog.act] ?? 0; }
  get extensionEligible(): boolean { return this.prog.confrontationUnlocked; }
  get intentDanger(): number { return INTENT_DANGER[this.intent]; }

  /** consume a gameplay sound event */
  hear(ev: SoundEvent): void {
    const d = Math.hypot(ev.x - this.pos.x, ev.z - this.pos.z);
    const radius = PERCEPTION.hearingBase + ev.loudness * PERCEPTION.hearingPerLoudness;
    if (d > radius) return;
    const certainty = Math.max(0.25, 1 - d / radius);
    // The memory applies its own positional error, so the brain does not need
    // to fuzz the point again here — doing it twice was how the old code ended
    // up with a hearing model that was either uselessly vague or a free fix
    // depending on which constant you read.
    this.memory.hearPlayer(ev.x, ev.z, certainty);
    this.suspicion = Math.min(1, this.suspicion + ev.loudness * certainty * 1.2);
    if (this.suspicion > 0.35 && (this.intent === 'dormant' || this.intent === 'search')) {
      this.investigatePoint.set(this.memory.current.x, 0, this.memory.current.z);
      // Seeded, so how long it persists at a noise differs run to run. A fixed
      // 20 s would teach players exactly how long to stay hidden.
      this.investigateTimer = 14 + this.variation.range(0, 18);
      this.setIntent('investigate', 3);
    }
  }

  /**
   * A tape was collected.
   *
   * Note what this no longer does: it does not increment a private tape count
   * or advance a private act. Progression is owned by `HorrorProgression`, and
   * the brain only reacts — a recording being lifted off a stump is a *noise*,
   * and the forest noticing it is a perception event like any other.
   */
  notifyTapePickup(x: number, z: number): void {
    this.hear({ x, z, loudness: 0.55 });
    this.suspicion = Math.min(1, this.suspicion + 0.25);
  }

  // -------------------------------------------------------- staged repositions

  /**
   * Ask to be repositioned to a composed position (the encounter director's
   * only way to move the entity).
   *
   * Every guard here is a promise to the player, and the order matters:
   *
   *  1. **Cooldown.** Relocation is rare punctuation, not locomotion.
   *  2. **Never while the destination is in view.** Checked with the same LOS
   *     code the entity uses against the player, so it cannot disagree.
   *  3. **Never while the entity's *current* position is in view.** This is the
   *     one the original code missed: vanishing from a spot the player is
   *     looking at is exactly as bad as appearing in one.
   *  4. **Far enough away.** A relocation across ten metres is a teleport with
   *     extra steps.
   *  5. **Navigable and unfamiliar.** No staging a sighting the player has
   *     already had in that spot this run.
   */
  stagePosition(
    x: number, z: number,
    player: ViewerProbe,
    opts: { minDistance?: number; allowVisibleDestination?: boolean } = {},
  ): boolean {
    if (this.relocateCooldown > 0) return false;
    const minD = opts.minDistance ?? 34;
    const here = Math.hypot(player.x - this.pos.x, player.z - this.pos.z);
    if (here < minD) return false;
    // (3) the player must not be watching where it currently stands
    if (this.playerCanSee(player, this.pos.x, this.pos.z)) return false;
    // (2) …nor where it is going, unless the caller explicitly composed a
    // *visible* reveal and accepts responsibility for the timing
    if (!opts.allowVisibleDestination && this.playerCanSee(player, x, z)) return false;
    if (this.sightingTooFamiliar(x, z)) return false;

    const cell = this.nav.nearestWalkable(x, z);
    this.nav.world(cell, this.wp);
    // Refuse if the nav grid dragged the request somewhere unrelated — better
    // to skip the beat than to place the figure in a nonsensical spot.
    if (Math.hypot(this.wp.x - x, this.wp.z - z) > 12) return false;

    this.pos.set(this.wp.x, 0, this.wp.z);
    this.pos.y = this.hf.heightAt(this.pos.x, this.pos.z);
    this.path.length = 0;
    this.relocateCooldown = 16 + this.variation.range(0, 10);
    return true;
  }

  /** True if the player has both facing and clean LOS to a world point. */
  private playerCanSee(player: ViewerProbe, x: number, z: number): boolean {
    const dx = x - player.x, dz = z - player.z;
    const len = Math.hypot(dx, dz) || 1;
    const dot = (dx * player.fwdX + dz * player.fwdZ) / len;
    // Generous cone (~100° half-angle equivalent): peripheral vision counts,
    // because a figure appearing at the edge of the screen is still a figure
    // appearing on screen.
    if (dot < -0.18) return false;
    return this.col.losClear(
      player.x, player.eyeY, player.z,
      x, this.hf.heightAt(x, z) + 1.8, z);
  }

  /** Adapt a full player object to the flat probe the visibility guards want. */
  private probe = { x: 0, z: 0, eyeY: 0, fwdX: 0, fwdZ: 0 };
  private asProbe(player: { pos: THREE.Vector3; eyeY: number; fwd: THREE.Vector3 }): ViewerProbe {
    const p = this.probe;
    p.x = player.pos.x; p.z = player.pos.z; p.eyeY = player.eyeY;
    p.fwdX = player.fwd.x; p.fwdZ = player.fwd.z;
    return p;
  }

  private sightingTooFamiliar(x: number, z: number): boolean {
    for (const s of this.sightingSites) {
      if (Math.hypot(s.x - x, s.z - z) < 18) return true;
    }
    return false;
  }

  private recordSighting(x: number, z: number, t: number): void {
    this.sightingSites.push({ x, z, t });
    if (this.sightingSites.length > 12) this.sightingSites.shift();
  }

  private rollStalkBias(): void {
    // Never exactly 0: a bias of zero is "directly behind", which is both the
    // most obvious place to check and the least interesting sightline.
    const mag = this.variation.range(0.35, 1.5);
    this.stalkBias = this.variation.next() < 0.5 ? -mag : mag;
    this.stalkRange = this.variation.range(0.8, 1.35);
  }

  // ------------------------------------------------------------------- update

  update(
    dt: number,
    player: {
      pos: THREE.Vector3; eyeY: number; fwd: THREE.Vector3;
      sprinting: boolean; moving: boolean; lightOn: boolean;
    },
    time: number,
  ): EntitySnapshot {
    this.repathTimer -= dt;
    this.relocateCooldown -= dt;
    this.investigateTimer -= dt;
    this.extensionCooldown -= dt;
    this.holdFor -= dt;
    this.intentAge += dt;
    this.sinceEscalation += dt;
    this.interceptWait = Math.max(0, this.interceptWait - dt);
    this.postHold = Math.max(0, this.postHold - dt);
    this.extensionRequest = false;

    const pp = player.pos;
    const dist = Math.hypot(pp.x - this.pos.x, pp.z - this.pos.z);

    // ================= PERCEPTION (throttled) =================
    // Raycasting the player every brain tick is the single most expensive thing
    // in here. At 12 Hz the worst-case staleness is 83 ms — well under human
    // reaction time and far below the intent cadence that consumes it.
    this.perceptAcc += dt;
    const perceptPeriod = 1 / CADENCE.perception;
    let visFactor = this.lastVisFactor;
    if (this.perceptAcc >= perceptPeriod) {
      visFactor = this.perceive(this.perceptAcc, player, dist);
      this.lastVisFactor = visFactor;
      this.memory.tick(this.perceptAcc);
      this.perceptAcc = 0;
    }

    // detection accumulates while perceiving, decays when not
    if (visFactor > 0) {
      const gain = PERCEPTION.detectionGain
        + this.prog.actIndex * PERCEPTION.detectionGainPerAct * 0.25;
      this.detection = Math.min(1, this.detection + visFactor * dt * gain);
      this.suspicion = Math.min(1, this.suspicion + visFactor * dt * 0.8);
    } else {
      this.detection = Math.max(0, this.detection - dt * PERCEPTION.detectionDecay);
      this.suspicion = Math.max(0, this.suspicion - dt * 0.05);
    }

    // ================= BEING WATCHED =================
    // Evaluated every tick rather than on the perception cadence: this is the
    // input that drives freeze and retreat, and a quarter-second of lag there
    // is the difference between "it stopped when I looked" and "it kept walking
    // while I stared at it", which is the tell that breaks the illusion.
    const toEntX = this.pos.x - pp.x, toEntZ = this.pos.z - pp.z;
    const toEntLen = Math.max(Math.hypot(toEntX, toEntZ), 0.01);
    const lookDot = (toEntX * player.fwd.x + toEntZ * player.fwd.z) / toEntLen;
    const playerLooking = lookDot > 0.94 && dist < 60 &&
      this.col.losClear(pp.x, player.eyeY, pp.z, this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);

    if (playerLooking) {
      this.lookAtTimer += dt;
      this.considerGlimpse(dt, dist);
      // Close observation makes it hold unnaturally still — but only while it
      // has no reason to be brave. In the stalking act and later it may instead
      // choose to withdraw, which is handled in the intent scorer.
      if (dist < 16 && this.detection < 0.8) {
        this.freezeTimer = Math.min(2.5, this.freezeTimer + dt * 3);
      }
    } else {
      this.lookAtTimer = Math.max(0, this.lookAtTimer - dt * 2);
      this.freezeTimer = Math.max(0, this.freezeTimer - dt * 1.5);
    }

    // ================= INTENT (throttled) =================
    // A stalker that re-decides sixty times a second twitches, because it keeps
    // changing its mind before any choice has had a consequence. Three times a
    // second is fast enough to react to being seen and slow enough to commit.
    this.intentAcc += dt;
    if (this.intentAcc >= 1 / CADENCE.intent) {
      this.chooseIntent(playerLooking, dist, visFactor);
      this.intentAcc = 0;
    }

    // ================= EXECUTE =================
    this.executeIntent(dt, player, dist, visFactor);

    // ================= MOVEMENT =================
    const speed = this.moveSpeed(playerLooking);
    this.integrate(dt, speed, pp, dist);

    this.pos.y = this.hf.heightAt(this.pos.x, this.pos.z);

    // capture — the only place the true player position may decide anything
    if ((this.intent === 'pursue' || this.intent === 'confront')
        && dist < 1.6 && Math.abs(pp.y - this.pos.y) < 2.6) {
      this.onCaptured?.();
    }

    this.considerExtension(dt, playerLooking, dist, speed);

    if (this.glimpseRequested) {
      this.glimpseRequested = false;
      this.recordSighting(this.pos.x, this.pos.z, time);
      this.onGlimpse?.();
    }

    const belief = this.memory.current;
    return {
      state: this.state,
      intent: this.intent,
      detection: this.detection,
      x: this.pos.x, y: this.pos.y, z: this.pos.z,
      visibleToPlayer: playerLooking,
      distToPlayer: dist,
      speed,
      act: this.currentAct,
      extensionEligible: this.extensionEligible,
      extensionRequest: this.extensionRequest,
      knowledgeConfidence: belief.confidence,
      contactAge: belief.age,
      hasLos: visFactor > 0,
      intercepting: this.intent === 'intercept' && this.interceptAt !== null,
      intentDanger: INTENT_DANGER[this.intent],
    };
  }

  private lastVisFactor = 0;

  // --------------------------------------------------------------- perception

  /**
   * Can it see the player, and how well?
   *
   * Returns a 0..2 signal strength. The behavioural model feeds in here rather
   * than into the decision layer, which is deliberate: a player who leans on
   * their flashlight is genuinely easier to *see*, and expressing that as a
   * perception change rather than as an AI cheat keeps the trade honest and
   * discoverable. Standing still likewise attenuates the signal, so choosing to
   * freeze is real play rather than superstition.
   */
  private perceive(
    dt: number,
    player: {
      pos: THREE.Vector3; eyeY: number; fwd: THREE.Vector3;
      sprinting: boolean; moving: boolean; lightOn: boolean;
    },
    dist: number,
  ): number {
    if (dist >= PERCEPTION.visionRange) return 0;
    const pp = player.pos;
    const dx = pp.x - this.pos.x, dz = pp.z - this.pos.z;
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const dot = (dx * fx + dz * fz) / Math.max(dist, 0.01);
    const inFov = dot > Math.cos(PERCEPTION.visionHalfAngle);
    if (!inFov && dist >= PERCEPTION.visionOmniRadius) return 0;

    const eyeY = this.pos.y + this.eyeHeight;
    if (!this.col.losClear(this.pos.x, eyeY, this.pos.z, pp.x, player.eyeY, pp.z)) return 0;

    let vis = Math.max(0, 1 - dist / PERCEPTION.visionRange);
    if (player.lightOn && dist < PERCEPTION.beamRange) {
      // The lamp gives you away, and habitual users give themselves away
      // further — a beam that has been sweeping for ten minutes is a known
      // quantity in this forest.
      vis *= PERCEPTION.beamGain * (0.85 + this.behaviour.flashlightReliance * 0.3);
    }
    if (player.sprinting) vis *= PERCEPTION.sprintGain;
    if (!player.moving) vis *= PERCEPTION.stillnessAttenuation;
    if (dist < 7) vis = 2.0;

    this.memory.seePlayer(pp.x, pp.z, Math.min(1, vis));
    return vis;
  }

  /**
   * Should the player get a confirmed sighting right now?
   *
   * Rate is act-scaled and the early act additionally requires *distance*:
   * arrival-act sightings must be rare and far, so the player is never sure
   * they saw anything. Later acts allow closer, more frequent confirmation
   * because by then ambiguity has done its job and withholding further would
   * read as the game having nothing to show.
   */
  private considerGlimpse(dt: number, dist: number): void {
    const rate = this.prog.confrontationUnlocked ? 0.7
      : this.prog.predictionUnlocked ? 0.42
      : this.prog.stalkingUnlocked ? 0.3 : 0.16;
    const farEnough = this.prog.stalkingUnlocked || dist > 28;
    if (this.lookAtTimer > 0.4 && farEnough
        && this.rng.next() < dt * rate && this.detection > 0.15) {
      this.glimpseRequested = true;
    }
  }

  // ------------------------------------------------------------------ deciding

  private setIntent(next: EntityIntent, minHold: number): void {
    if (next === this.intent) return;
    const prev = this.intent;
    this.intent = next;
    this.state = INTENT_STATE[next];
    this.intentAge = 0;
    this.intentMinHold = minHold;
    this.path.length = 0;
    if (INTENT_DANGER[next] > INTENT_DANGER[prev]) this.sinceEscalation = 0;
    if (next !== 'confront' && next !== 'pursue') this.confrontCommitted = false;
    if (next !== 'intercept') this.interceptAt = null;
    if (next !== 'observe' && next !== 'hide') this.postAt = null;
    this.onIntentChange?.(next, prev);
  }

  /**
   * Score every permitted intent and take the best.
   *
   * Scoring rather than transitioning is what buys the lateral moves. Each
   * appetite below is written to answer "why would a patient, intelligent thing
   * choose this now", and several of them are *negative* appetites — reasons to
   * do less than it could.
   */
  private chooseIntent(playerLooking: boolean, dist: number, visFactor: number): void {
    if (this.intentAge < this.intentMinHold) return;

    const allowed = ACT_INTENTS[this.prog.act] ?? ACT_INTENTS.arrival;
    const belief = this.memory.current;
    const conf = belief.confidence;
    const d = this.directive;
    const b = this.behaviour;
    // The director's pressure is a *ceiling* on appetite, not a multiplier on
    // capability. During a protected recovery window nothing above `shadow`
    // scores at all, so the forest genuinely lets go.
    const ceiling = d.allowEscalation ? 1 : 0.36;
    const quiet = d.wantQuiet;

    let best: EntityIntent = 'dormant';
    let bestScore = -Infinity;

    const consider = (intent: EntityIntent, score: number): void => {
      if (!allowed.includes(intent)) return;
      if (INTENT_DANGER[intent] > ceiling) return;
      // A little seeded noise on every score. Without it two runs with the same
      // player route make identical decisions, and a second playthrough becomes
      // a memory test rather than another run.
      const s = score + this.variation.range(-0.07, 0.07);
      if (s > bestScore) { bestScore = s; best = intent; }
    };

    // ---- dormant: the baseline. Always available, never attractive. --------
    consider('dormant', 0.12 + (quiet ? 0.3 : 0));

    // ---- investigate: a specific noise, still worth checking ---------------
    if (this.investigateTimer > 0 && this.suspicion > 0.2) {
      consider('investigate', 0.5 + this.suspicion * 0.4);
    }

    // ---- search: it believes something but the belief is going cold --------
    if (conf > 0 && conf < 0.5) {
      consider('search', 0.34 + (0.5 - conf) * 0.6);
    }

    // ---- observe: hold a distant post and watch ---------------------------
    // The most under-used verb in stalker AI and the most valuable. Appetite
    // rises when the player is *stationary* (rushing a player who has chosen to
    // hold still collapses the tension they just built), when the director
    // wants a sighting composed, and when nothing has happened for a while.
    if (conf > 0.15) {
      consider('observe',
        0.3
        + b.stillness * 0.4
        + (d.wantSighting ? 0.45 : 0)
        + Math.min(0.3, this.sinceEscalation / 120)
        + (dist > 45 ? 0.15 : -0.1)
        - (playerLooking ? 0.25 : 0));
    }

    // ---- shadow: match the route from off to one side ---------------------
    if (conf > 0.25) {
      consider('shadow',
        0.34 + conf * 0.3 + d.pressure * 0.3
        - (quiet ? 0.4 : 0));
    }

    // ---- flank: approach from the arc the player is not watching ----------
    // A player who habitually checks behind them has already covered that arc,
    // so the *forward* and diagonal approaches become the valuable ones. This
    // is the clearest example of the behavioural model being used as a bias
    // rather than as a switch: high backwardChecking makes flanking attractive,
    // it does not turn a flanking mode on.
    if (conf > 0.3) {
      consider('flank',
        0.3 + b.backwardChecking * 0.45 + d.pressure * 0.25
        + (dist > 25 && dist < 70 ? 0.15 : -0.15)
        - (quiet ? 0.4 : 0));
    }

    // ---- intercept: be somewhere before the player gets there -------------
    // Wants a predictable route and a live heading estimate. Sprinting players
    // are the best interception targets in the game: committed to a line, loud
    // enough to keep the belief fresh, and moving too fast to re-plan.
    if (this.prog.predictionUnlocked && conf > 0.3 && belief.heading !== null) {
      consider('intercept',
        0.24
        + b.routePredictability * 0.5
        + b.sprintReliance * 0.3
        + b.trailPreference * 0.2
        + d.pressure * 0.3
        + (this.prog.escapeActive ? 0.4 : 0)
        - (quiet ? 0.5 : 0));
    }

    // ---- retreat: it has been seen, and it does not like being seen -------
    // This is the behaviour that most reliably reads as intelligence, because
    // it is the one that costs the creature something. It only exists from the
    // unease act onward; before that a watched Palebark simply freezes, which
    // is the more animal response and the right one for a run that has not yet
    // established that the thing is *deciding*.
    if (playerLooking && this.prog.stalkingUnlocked) {
      consider('retreat',
        0.2 + (dist < 40 ? 0.45 : 0.1)
        + (this.detection < 0.6 ? 0.25 : -0.2)
        // Not while it is committed. Withdrawing mid-confrontation would be a
        // cheat in the player's favour and would make the confront meaningless.
        - (this.confrontCommitted ? 5 : 0));
    }

    // ---- hide: break the sightline and stop --------------------------------
    if (quiet || (playerLooking && dist < 25)) {
      consider('hide', 0.3 + (quiet ? 0.45 : 0) + (playerLooking ? 0.2 : 0));
    }

    // ---- confront: close, and be seen closing ------------------------------
    if (this.prog.confrontationUnlocked && conf > 0.45 && this.detection > 0.5) {
      consider('confront',
        0.1 + this.detection * 0.5 + d.pressure * 0.5
        + (visFactor > 0 ? 0.25 : 0)
        - (quiet ? 2 : 0));
    }

    // ---- pursue: already committed -----------------------------------------
    if (this.confrontCommitted && this.prog.confrontationUnlocked) {
      // Deliberately huge. Once the final approach begins there is no polite
      // stopping — an encounter that can be walked out of by turning around is
      // not an encounter.
      consider('pursue', 3);
    }

    // ---- disengage: leave -------------------------------------------------
    // Sometimes the correct answer is to abandon a perfectly good opportunity.
    // Scored on how *long* it has been applying pressure rather than on
    // failure, so the creature reads as losing interest rather than as giving
    // up. This is the single cheapest way to make an AI feel like it has its
    // own agenda.
    const applying = this.intent === 'shadow' || this.intent === 'flank'
      || this.intent === 'intercept' || this.intent === 'confront';
    if (applying && this.intentAge > 40) {
      consider('disengage', 0.35 + Math.min(0.4, (this.intentAge - 40) / 90));
    }

    // Hysteresis: hold the current intent unless something beats it clearly.
    // Without this the top two scores trade places every pass and the entity
    // dithers, which looks like a bug and destroys the sense of purpose.
    const stickiness = 0.12 + Math.min(0.18, this.intentAge / 60);
    if (best !== this.intent && bestScore < this.currentIntentFloor() + stickiness) return;

    // Minimum holds are per-intent: a retreat must last long enough to
    // actually break the sightline, an observation long enough to be observed.
    const holds: Partial<Record<EntityIntent, number>> = {
      observe: 8, hide: 6, retreat: 5, intercept: 10, disengage: 12,
      confront: 4, pursue: 2, shadow: 6, flank: 7, search: 5, investigate: 4,
      dormant: 4,
    };
    this.setIntent(best, holds[best] ?? 3);
  }

  /**
   * What the current intent would score if re-evaluated.
   *
   * Approximated rather than recomputed: the full scorer is written as a
   * one-pass `consider` sweep, and re-entering it for a single intent would
   * either duplicate every appetite or require restructuring it into a table.
   * The approximation only feeds hysteresis, where being roughly right is
   * enough.
   */
  private currentIntentFloor(): number {
    return 0.3 + INTENT_DANGER[this.intent] * 0.15;
  }

  // ----------------------------------------------------------------- executing

  /** Turn the chosen intent into a movement target. */
  private executeIntent(
    dt: number,
    player: { pos: THREE.Vector3; eyeY: number; fwd: THREE.Vector3 },
    dist: number, visFactor: number,
  ): void {
    const belief = this.memory.current;

    switch (this.intent) {
      case 'dormant': {
        // Drift between places. Multi-second, variable holds: a fixed cadence
        // is the single clearest tell that a wanderer is on a timer.
        if (this.path.length === 0 && this.holdFor <= 0 && this.rng.next() < dt * 0.35) {
          const zn = this.variation.pick(this.hf.layout.zones);
          this.target.set(zn.x + this.variation.range(-9, 9), 0, zn.z + this.variation.range(-9, 9));
          this.requestPath();
          this.holdFor = this.variation.range(3, 11);
        }
        break;
      }

      case 'investigate': {
        this.target.copy(this.investigatePoint);
        if (this.path.length === 0) this.requestPath();
        break;
      }

      case 'search': {
        // Sweep *around* the believed position rather than standing on it. The
        // belief already carries a positional error, so walking exactly to it
        // would be searching a point that was never claimed to be accurate.
        if (this.path.length === 0 || this.repathTimer <= 0) {
          const spread = 12 + (1 - belief.confidence) * 26;
          const a = this.variation.range(0, Math.PI * 2);
          this.target.set(
            belief.x + Math.sin(a) * this.variation.range(spread * 0.4, spread), 0,
            belief.z + Math.cos(a) * this.variation.range(spread * 0.4, spread));
          this.requestPath();
          this.repathTimer = 5 + this.variation.range(0, 5);
        }
        break;
      }

      case 'observe': {
        // Find a post: far, with sight of the believed player, ideally
        // partially screened. Chosen once and then *held* — an observer that
        // keeps repositioning is not observing, it is circling.
        if (!this.postAt || this.postHold <= 0) {
          this.postAt = this.findObservationPost(belief.x, belief.z, this.asProbe(player));
          this.postHold = 10 + this.variation.range(0, 14);
          if (this.postAt) {
            this.target.set(this.postAt.x, 0, this.postAt.z);
            this.requestPath();
          }
        }
        break;
      }

      case 'shadow': {
        // Parallel the route from a flank, never converging on the belief. The
        // seeded angular bias stops it settling on one relative bearing — a
        // fixed bearing is learnable, and once learned the player simply never
        // looks that way again.
        if (this.repathTimer <= 0 || this.path.length === 0) {
          const ang = Math.atan2(this.pos.x - belief.x, this.pos.z - belief.z) + this.stalkBias;
          const offset = Math.max(12, 26 - this.prog.actIndex * 3) * this.stalkRange;
          this.target.set(
            belief.x + Math.sin(ang) * offset, 0,
            belief.z + Math.cos(ang) * offset);
          this.requestPath();
          this.repathTimer = 2.5 + this.variation.range(0, 2.5);
          if (this.variation.next() < 0.25) this.rollStalkBias();
        }
        break;
      }

      case 'flank': {
        // Swing to the arc the player is *not* covering. Derived from the
        // player's own facing, so it is genuinely a response to where they are
        // looking rather than a fixed offset from their position.
        if (this.repathTimer <= 0 || this.path.length === 0) {
          const facing = Math.atan2(player.fwd.x, player.fwd.z);
          // Perpendicular, on the side the entity is already nearer to, so the
          // approach is an arc rather than a lap of the player.
          const side = this.variation.next() < 0.5 ? 1 : -1;
          const ang = facing + side * (Math.PI * 0.45 + this.variation.range(-0.25, 0.25));
          const r = 20 + this.variation.range(0, 16);
          this.target.set(belief.x + Math.sin(ang) * r, 0, belief.z + Math.cos(ang) * r);
          this.requestPath();
          this.repathTimer = 3 + this.variation.range(0, 2);
        }
        break;
      }

      case 'intercept': {
        // Commit to a predicted point and then *wait* there. The waiting is the
        // encounter: arriving and immediately re-planning would turn an
        // interception into a chase with extra steps.
        if (!this.interceptAt) {
          this.interceptAt = this.memory.predict(
            this.landmarks, this.behaviour.routePredictability);
          if (this.interceptAt) {
            this.target.set(this.interceptAt.x, 0, this.interceptAt.z);
            this.requestPath();
            this.interceptWait = 0;
          }
        } else {
          const dToPost = Math.hypot(this.interceptAt.x - this.pos.x, this.interceptAt.z - this.pos.z);
          if (dToPost < 4 && this.interceptWait <= 0) {
            // Arrived. Hold — including, and especially, when the prediction was
            // the deliberate wrong guess. Standing at the fork the player did
            // not take is the creepiest thing this system does, and it only
            // works if the entity is willing to be wrong in public.
            this.interceptWait = 12 + this.variation.range(0, 10);
          } else if (this.interceptWait <= 0 && dToPost >= 4 && this.path.length === 0) {
            this.requestPath();
          }
        }
        break;
      }

      case 'retreat': {
        // Move directly away from the player's sightline, into cover. Not away
        // from the *player* — away from where they are looking, which is a
        // different and much better direction.
        if (this.path.length === 0 || this.repathTimer <= 0) {
          const spot = this.findCover(this.asProbe(player), 26);
          if (spot) {
            this.target.set(spot.x, 0, spot.z);
            this.requestPath();
          }
          this.repathTimer = 3;
        }
        break;
      }

      case 'hide': {
        if (!this.postAt || this.postHold <= 0) {
          this.postAt = this.findCover(this.asProbe(player), 18) ?? null;
          this.postHold = 8 + this.variation.range(0, 10);
          if (this.postAt) {
            this.target.set(this.postAt.x, 0, this.postAt.z);
            this.requestPath();
          }
        }
        break;
      }

      case 'confront': {
        // Approach the believed position — *not* the true one — until it has
        // genuine perception, at which point it may steer at what it can see.
        const tx = visFactor > 0 ? player.pos.x : belief.x;
        const tz = visFactor > 0 ? player.pos.z : belief.z;
        this.target.set(tx, 0, tz);
        if (this.repathTimer <= 0) { this.requestPath(); this.repathTimer = 1.2; }
        if (dist < 14 && visFactor > 0) this.confrontCommitted = true;
        break;
      }

      case 'pursue': {
        // Final approach: steer directly, still collision-resolved, still
        // walked. No teleporting, no speed ramp beyond the one constant.
        this.target.copy(player.pos);
        this.path.length = 0;
        break;
      }

      case 'disengage': {
        if (this.path.length === 0) {
          // Leave toward the furthest landmark: a departure the player might
          // actually witness, rather than a fade-out.
          let far = this.hf.layout.zones[0], fd = -1;
          for (const z of this.hf.layout.zones) {
            const dd = Math.hypot(z.x - player.pos.x, z.z - player.pos.z);
            if (dd > fd) { fd = dd; far = z; }
          }
          this.target.set(far.x + this.variation.range(-10, 10), 0, far.z + this.variation.range(-10, 10));
          this.requestPath();
          // Deliberately drop interest. Without this the creature "leaves" and
          // then turns round the moment its detection ticks up again, which
          // reads as indecision rather than as a decision.
          this.detection *= 0.35;
          this.suspicion *= 0.3;
        }
        break;
      }
    }
  }

  /**
   * A place to stand and watch from.
   *
   * Scored, not sampled: distance in a preferred band, clean sight of the
   * believed player, and — the important term — *not* somewhere the player is
   * currently looking. An observation post the player is already staring at is
   * not an observation, it is an appearance.
   */
  private findObservationPost(
    bx: number, bz: number,
    player: ViewerProbe,
  ): { x: number; z: number } | null {
    let bestX = 0, bestZ = 0, bestScore = -Infinity, found = false;
    for (let i = 0; i < 8; i++) {
      const a = this.variation.range(0, Math.PI * 2);
      const r = this.variation.range(38, 74);
      const x = bx + Math.sin(a) * r, z = bz + Math.cos(a) * r;
      if (Math.abs(x) > this.hf.layout.size / 2 - 8) continue;
      if (Math.abs(z) > this.hf.layout.size / 2 - 8) continue;
      if (this.hf.inLake(x, z)) continue;
      const y = this.hf.heightAt(x, z);
      // It must be able to see the player's area from there — an observer with
      // no sightline is just a thing standing in a wood.
      const sees = this.col.losClear(x, y + this.eyeHeight, z, bx, y + 1.6, bz);
      let score = (sees ? 0.6 : 0) + r / 100;
      // Height advantage: a figure on a ridge silhouette is the strongest
      // composition this world can produce, so prefer it when available.
      score += Math.max(0, (y - this.hf.heightAt(bx, bz)) / 20) * 0.4;
      if (this.playerCanSee(player, x, z)) score -= 0.55;
      if (this.sightingTooFamiliar(x, z)) score -= 0.6;
      if (score > bestScore) { bestScore = score; bestX = x; bestZ = z; found = true; }
    }
    return found ? { x: bestX, z: bestZ } : null;
  }

  /** Nearest point that breaks the player's sightline. */
  private findCover(player: ViewerProbe, radius: number): { x: number; z: number } | null {
    // Bias the search away from the player's facing rather than sampling
    // uniformly: the useful cover is behind the entity relative to the viewer,
    // and sampling a full circle wastes most of its attempts in front.
    const away = Math.atan2(this.pos.x - player.x, this.pos.z - player.z);
    for (let i = 0; i < 10; i++) {
      const a = away + this.variation.range(-1.1, 1.1);
      const r = this.variation.range(radius * 0.5, radius);
      const x = this.pos.x + Math.sin(a) * r, z = this.pos.z + Math.cos(a) * r;
      if (Math.abs(x) > this.hf.layout.size / 2 - 8) continue;
      if (Math.abs(z) > this.hf.layout.size / 2 - 8) continue;
      if (this.hf.inLake(x, z)) continue;
      if (this.playerCanSee(player, x, z)) continue;
      return { x, z };
    }
    return null;
  }

  // ------------------------------------------------------------------ movement

  private moveSpeed(playerLooking: boolean): number {
    // Frozen under close observation — except when committed, where stopping
    // would be a gift.
    if (this.freezeTimer > 0.2 && this.intent !== 'pursue' && this.intent !== 'confront') return 0;
    // An observer that has reached its post stands still. So does an
    // interceptor that has arrived and is waiting.
    if (this.intent === 'observe' && this.postAt
        && Math.hypot(this.postAt.x - this.pos.x, this.postAt.z - this.pos.z) < 3) return 0;
    if (this.intent === 'hide' && this.postAt
        && Math.hypot(this.postAt.x - this.pos.x, this.postAt.z - this.pos.z) < 3) return 0;
    if (this.intent === 'intercept' && this.interceptWait > 0) return 0;
    let s = INTENT_SPEED[this.intent];
    // Being watched slows everything that is not committed. A figure that keeps
    // its pace while you stare at it reads as an animation loop; one that
    // slows, and then is somehow closer later, does not.
    if (playerLooking && this.intent !== 'pursue') s *= 0.55;
    return s;
  }

  private integrate(dt: number, speed: number, pp: THREE.Vector3, dist: number): void {
    if (speed > 0) {
      let tx: number, tz: number;
      if (this.intent === 'pursue') {
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
        this.pos.x += (mdx / ml) * speed * dt;
        this.pos.z += (mdz / ml) * speed * dt;
        const p2 = { x: this.pos.x, z: this.pos.z };
        this.col.resolve(p2, 0.5, this.pos.y, 2.8);
        this.pos.x = p2.x; this.pos.z = p2.z;
        this.faceToward(Math.atan2(mdx, mdz), dt * 4);
      }
      if (this.rng.next() < dt * (speed / 9) && dist < 55 && dist > 6) {
        this.onFootfall?.(this.pos.x, this.pos.z, dist);
      }
    } else if (this.intent === 'observe' || this.intent === 'confront'
               || this.intent === 'pursue' || this.detection > 0.4) {
      // Standing and facing the player — the worst version of stillness, and
      // the reason `observe` has a speed of exactly zero.
      this.faceToward(Math.atan2(pp.x - this.pos.x, pp.z - this.pos.z), dt * 2);
    }
  }

  private faceToward(desiredYaw: number, rate: number): void {
    let dy = desiredYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, rate);
  }

  // ----------------------------------------------------------------- extension

  /**
   * The reserved "reach" beat.
   *
   * Requested by the brain, still gated by the animator's own cooldown, so both
   * halves have to agree before it plays. Conditions are deliberately narrow:
   * late act, actually being looked at, high detection, mid-range (too far and
   * the silhouette change is invisible; too close and it reads as an attack
   * animation, which it is not). The probability is per-second, not per-frame,
   * so frame rate cannot change how often it happens.
   */
  private considerExtension(dt: number, playerLooking: boolean, dist: number, speed: number): void {
    if (!this.extensionEligible || this.extensionCooldown > 0) return;
    if (!playerLooking || this.detection <= 0.55) return;
    if (dist <= 8 || dist >= 34 || speed >= 0.6) return;
    if (this.rng.next() < dt * 0.09) {
      this.extensionRequest = true;
      this.extensionCooldown = 40 + this.variation.range(0, 25);
    }
  }

  private requestPath(): void {
    this.nav.findPath(this.pos.x, this.pos.z, this.target.x, this.target.z, this.pathScratch);
    this.path.length = 0;
    for (let i = 1; i < this.pathScratch.length; i++) this.path.push(this.pathScratch[i]);
    this.pathIdx = 0;
  }

  // -------------------------------------------------------------------- debug

  debug(): Record<string, unknown> {
    return {
      intent: this.intent,
      state: this.state,
      intentAge: +this.intentAge.toFixed(1),
      intentDanger: INTENT_DANGER[this.intent],
      detection: +this.detection.toFixed(3),
      suspicion: +this.suspicion.toFixed(3),
      act: this.prog.act,
      sinceEscalation: +this.sinceEscalation.toFixed(1),
      interceptAt: this.interceptAt
        ? { x: +this.interceptAt.x.toFixed(1), z: +this.interceptAt.z.toFixed(1), guess: this.interceptAt.isGuess }
        : null,
      interceptWait: +this.interceptWait.toFixed(1),
      freeze: +this.freezeTimer.toFixed(2),
      relocateCooldown: +Math.max(0, this.relocateCooldown).toFixed(1),
      memory: this.memory.snapshot(),
      sightingSites: this.sightingSites.length,
    };
  }
}


