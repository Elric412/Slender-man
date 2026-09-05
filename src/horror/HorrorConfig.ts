/**
 * ============================================================================
 * HORROR TUNING — the single place the horror layer's magic numbers live
 * ============================================================================
 *
 * Before this file existed the same idea was spelled three different ways in
 * three different modules: `EntityBrain.MILESTONES` said stalking began at 3
 * tapes, `AudioDirector` said the "middle" act began at 2 tapes *or* 150
 * seconds, and `FearSystem` had its own opinion about what 40 metres meant. All
 * three were defensible in isolation; together they meant the game had no
 * definition of what act it was in, and a change to one silently desynchronised
 * the others.
 *
 * The rule going forward: if a number decides *when* horror behaviour is
 * allowed, how strongly it responds, or how often it may repeat, it belongs
 * here. Numbers that describe a single subsystem's internals (a filter cutoff,
 * an easing rate that only affects that module's own smoothing) stay local —
 * hoisting those would just turn this file into a junk drawer.
 */

import type { HorrorAct } from './HorrorProgression';

/** Tape counts at which each act begins. The escape act needs all eight. */
export const ACT_TAPE_THRESHOLDS: Record<HorrorAct, number> = {
  arrival: 0,
  unease: 2,
  stalking: 4,
  revelation: 6,
  escape: 8,
};

/**
 * Time-only drift.
 *
 * A player who refuses to collect tapes must not be able to farm a permanently
 * empty forest — but time must also never hand out the *late* vocabulary, or
 * loitering becomes a way to see the endgame without earning it. So dwell can
 * carry the run as far as `stalking` and no further, and the thresholds are
 * long enough that a player making normal progress never notices them.
 */
export const ACT_TIME_DRIFT: { seconds: number; act: HorrorAct }[] = [
  { seconds: 300, act: 'unease' },
  { seconds: 660, act: 'stalking' },
];

/** Highest act that time alone may reach. */
export const ACT_TIME_CEILING: HorrorAct = 'stalking';

/**
 * How far *ahead* of the AI the audio layer is allowed to hint.
 *
 * This is the one deliberate desynchronisation in the design, and it exists
 * because foreshadowing is how a horror score earns its later moments: the mix
 * should imply capability slightly before Palebark actually has it, so that
 * when the behaviour finally appears it feels predicted rather than bolted on.
 * Zero would make the audio purely reactive; two would make it a liar.
 */
export const AUDIO_FORESHADOW_ACTS = 1;

// ---------------------------------------------------------------------------
// Perception & knowledge
// ---------------------------------------------------------------------------

export const PERCEPTION = {
  /** Beyond this Palebark cannot see the player at all, LOS or not. */
  visionRange: 92,
  /** Half-angle of the vision cone, radians (~155° total). */
  visionHalfAngle: 1.35,
  /** Inside this radius it perceives regardless of facing. */
  visionOmniRadius: 6,
  /** Flashlight multiplier on visibility, and the range it applies within. */
  beamGain: 1.8,
  beamRange: 45,
  /** Sprinting is loud and fast — easier to resolve visually too. */
  sprintGain: 1.5,
  /** Standing still in cover is genuinely good play, and is rewarded. */
  stillnessAttenuation: 0.55,
  /** Detection accumulation and decay rates (per second, at full signal). */
  detectionGain: 0.115,
  detectionGainPerAct: 0.05,
  detectionDecay: 0.035,
  /** Hearing radius at zero and full loudness. */
  hearingBase: 8,
  hearingPerLoudness: 55,
} as const;

/**
 * The belief model's error budget.
 *
 * These are the numbers that decide whether Palebark feels like a hunter or a
 * cheat. Confidence decay is the important one: it is what makes breaking
 * contact *mean* something, and it is why the entity can be found searching the
 * wrong ridge two minutes after losing you.
 */
export const MEMORY = {
  /** Confidence lost per second with no contact of any kind. */
  confidenceDecay: 0.085,
  /** Confidence floor below which the belief is discarded entirely. */
  confidenceFloor: 0.06,
  /** Confidence a clean visual contact asserts. */
  visualConfidence: 1.0,
  /** Confidence a sound contact asserts, before distance attenuation. */
  soundConfidence: 0.55,
  /** Metres of positional error injected per unit of *lost* confidence. */
  positionErrorPerUncertainty: 26,
  /** Metres of error a sound contact carries at the edge of hearing. */
  soundErrorMax: 16,
  /**
   * Prediction lookahead, seconds. Longer than this and the guess is fantasy;
   * shorter and it is indistinguishable from chasing the last known position.
   */
  predictionHorizon: 7.5,
  /** Angular error applied to the predicted heading, radians, at zero skill. */
  predictionAngleError: 0.85,
  /** How much route predictability shrinks that error (0..1 of it). */
  predictabilityReliefFactor: 0.7,
  /**
   * Chance a prediction is deliberately committed to the *second* best guess.
   *
   * This is the "waited at the path you almost took" mechanic. It is not noise
   * for its own sake: a stalker that is always right is a tracker, and a
   * tracker is a puzzle to be solved rather than a presence to be feared.
   */
  wrongGuessChance: 0.3,
} as const;

// ---------------------------------------------------------------------------
// Threat model
// ---------------------------------------------------------------------------

export const THREAT = {
  /** Distance at which proximity stops contributing to actual danger. */
  dangerRange: 60,
  /** Distance inside which danger is effectively maximal regardless of state. */
  dangerCloseRange: 12,
  /** Rise/fall rates for each channel (per second). */
  dangerRise: 3.2, dangerFall: 1.1,
  dreadRise: 0.9, dreadFall: 0.16,
  uncertaintyRise: 0.55, uncertaintyFall: 0.3,
  /** Dread contribution of a fresh sighting, and how long it lingers. */
  sightingDread: 0.55,
  sightingHalfLife: 22,
  /** Dread contribution of an unexplained cue (false positive or real). */
  cueDread: 0.22,
  cueHalfLife: 14,
  /** Dread from environmental wrongness being noticed. */
  wrongnessDread: 0.3,
  /** Seconds of nothing-at-all after which silence itself becomes dreadful. */
  silenceDreadOnset: 45,
  /** Seconds of staleness after which last-known-position is worthless. */
  staleKnowledgeSeconds: 40,
  /**
   * How much the static overlay is allowed to follow actual danger.
   *
   * Deliberately small. The overlay used to be driven by detection, which made
   * it a proximity radar: players learned to read the veil instead of the
   * forest. Now it mostly tracks *dread* — how the situation feels — so it can
   * be loud when nothing is there and almost absent when something is.
   */
  staticDangerWeight: 0.22,
  staticDreadWeight: 0.78,
} as const;

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

export const PACING = {
  /** Minimum seconds of low-pressure recovery after a strong encounter. */
  recoverySeconds: 42,
  /** Recovery is shorter late on, but never zero. */
  recoveryMinSeconds: 22,
  /** Seconds of enforced calm the run opens with. */
  openingCalmSeconds: 55,
  /** Target seconds between *any* two encounters, before act scaling. */
  encounterInterval: 78,
  /** Jitter applied to that interval, ± fraction. */
  encounterIntervalJitter: 0.4,
  /** Encounters allowed per act, per run. Escape has its own pressure model. */
  encounterBudget: { arrival: 3, unease: 6, stalking: 9, revelation: 9, escape: 12 } as Record<HorrorAct, number>,
  /** Above this dread the director prefers to do nothing at all. */
  dreadSaturation: 0.82,
  /** Seconds a tension peak is held before release is forced. */
  peakHoldSeconds: 18,
  /** Seconds of quiet the director protects once release begins. */
  releaseSeconds: 26,
} as const;

// ---------------------------------------------------------------------------
// Encounters
// ---------------------------------------------------------------------------

export const ENCOUNTER = {
  /** Metres within which a candidate position counts as "the same place". */
  repeatRadius: 22,
  /** Seconds a location stays "used" for repetition purposes. */
  repeatMemorySeconds: 210,
  /** How many recent records the memory keeps. */
  historyLength: 16,
  /** A type may not repeat within this many encounters. */
  typeCooldown: 3,
  /** Bearing sector width (radians) used for direction-repetition scoring. */
  bearingSector: 0.9,
  /** Distance band width (metres) used for distance-repetition scoring. */
  distanceBand: 14,
  /** Candidate positions evaluated per composition attempt. */
  candidates: 14,
  /**
   * Sighting composition preferences.
   *
   * Partial occlusion is weighted above everything else because a fully visible
   * figure is a *character*, and a character can be assessed and dismissed. A
   * silhouette three-quarters behind a trunk cannot, which is why it keeps
   * working on the fourth viewing.
   */
  idealOcclusion: 0.55,
  peripheralIdealDot: 0.45,
  minSightingDistance: 16,
  maxSightingDistance: 78,
} as const;

// ---------------------------------------------------------------------------
// False positives & wrongness
// ---------------------------------------------------------------------------

export const FALSE_POSITIVE = {
  /** Base seconds between candidate false cues, per act. */
  interval: { arrival: 52, unease: 40, stalking: 36, revelation: 34, escape: 46 } as Record<HorrorAct, number>,
  intervalJitter: 0.55,
  /**
   * Fraction of ambiguous cues that must fire while Palebark is genuinely far
   * away. This is the anti-inference guarantee: if every branch-snap meant
   * proximity, the player would have a free radar within ten minutes.
   */
  farFraction: 0.62,
  /** Distance beyond which Palebark counts as "not responsible" for a cue. */
  farDistance: 70,
  /** A cue placed this far from the player at most. */
  placementRange: { min: 11, max: 40 },
} as const;

export const WRONGNESS = {
  /** Seconds between wrongness evaluations. */
  interval: 62,
  intervalJitter: 0.5,
  /** Per-act budget of environmental changes. */
  budget: { arrival: 1, unease: 3, stalking: 5, revelation: 7, escape: 4 } as Record<HorrorAct, number>,
  /** A change may only be applied outside this radius (metres) of the player. */
  minPlayerDistance: 26,
  /** …and only if the player cannot currently see the spot. */
  requireUnobserved: true,
} as const;

// ---------------------------------------------------------------------------
// Cadences
// ---------------------------------------------------------------------------

/**
 * How often each layer thinks, in hertz.
 *
 * Movement is per-frame because it is the only thing whose smoothness the
 * player can see. Everything else is a decision, and decisions taken sixty
 * times a second are both wasteful and *worse* — a stalker that re-evaluates
 * its intent every 16 ms twitches, because it keeps changing its mind before
 * any choice has had consequences.
 */
export const CADENCE = {
  perception: 12,
  intent: 3,
  behaviour: 1,
  encounter: 2,
  wrongness: 0.5,
} as const;
