/**
 * ============================================================================
 * PLAYER BEHAVIOUR MODEL — rolling tendencies, never permanent labels
 * ============================================================================
 *
 * ## What this is for
 *
 * The target feeling is "something intelligent is studying me". Studying means
 * noticing habits, and habits are the only thing about a player that a forest
 * creature could plausibly learn. So this observes six tendencies and hands
 * them to the brain as soft biases.
 *
 * ## Why rolling averages and not classification
 *
 * The tempting design is a classifier — tag the player `sprinter` or
 * `light-hoarder` and switch behaviour trees. Two reasons not to:
 *
 *   1. **It is legible.** A discrete mode change is a step function, and step
 *      functions are exactly what players reverse-engineer. "It started
 *      flanking after I ran three times" is a rule, and a known rule is a
 *      solved rule.
 *   2. **It is wrong about people.** Play style is not a trait, it is a
 *      response to the current situation. A player sprints because they are
 *      scared *right now*; ten minutes later they are creeping. A label
 *      outlives the behaviour it described and then acts on stale information.
 *
 * So every value here is an exponential moving average over roughly the last
 * minute or two of play, continuous in [0,1], and the brain multiplies rather
 * than branches. The adaptation is felt as "it seems to expect this" instead of
 * observed as "it switched modes".
 *
 * ## What the brain does with each
 *
 * `sprintReliance`      → weight sound-based tracking and route prediction up;
 *                         a running player is loud and committed to a line.
 * `flashlightReliance`  → extend effective visual detection range; a lit player
 *                         is visible from much further away, which is a fair
 *                         and discoverable trade rather than a hidden penalty.
 * `backwardChecking`    → prefer diagonal and *forward* positioning. A player
 *                         who constantly turns around has already covered the
 *                         behind-arc; putting the figure there wastes it.
 * `routePredictability` → make interception attractive and shrink prediction
 *                         error. This is the one that most directly rewards the
 *                         player for varying their route.
 * `stillness`           → favour observation and waiting over approach. Rushing
 *                         a stationary player collapses the tension they just
 *                         built by choosing to hold still.
 * `trailPreference`     → bias predicted destinations onto the path network,
 *                         and make blocked-path encounters land harder.
 */

/** Everything the model publishes. All 0..1, all rolling. */
export interface PlayerBehaviorSnapshot {
  sprintReliance: number;
  flashlightReliance: number;
  backwardChecking: number;
  routePredictability: number;
  stillness: number;
  trailPreference: number;
}

/** One observation, pushed on the behaviour cadence (~1 Hz). */
export interface BehaviorSample {
  x: number; z: number;
  /** planar facing, radians */
  yaw: number;
  sprinting: boolean;
  moving: boolean;
  lightOn: boolean;
  /** metres to the nearest authored path — trail preference reads this */
  trailDistance: number;
}

/**
 * EMA time constants, seconds.
 *
 * Different tendencies settle at different speeds on purpose. Flashlight use is
 * a deliberate, slow-changing choice; backward-checking is a reflex that spikes
 * during an encounter and should decay fast enough that it describes *this*
 * minute rather than the whole run.
 */
const TAU = {
  sprint: 45,
  light: 70,
  backward: 28,
  route: 80,
  stillness: 35,
  trail: 60,
} as const;

export class PlayerBehaviorModel {
  private snap: PlayerBehaviorSnapshot = {
    // Seeded at neutral-ish rather than zero. Starting every value at 0 would
    // mean the first minute of every run describes a player who never sprints,
    // never uses a torch and walks a perfectly unpredictable line — which is
    // a specific and wrong claim, not an absence of one.
    sprintReliance: 0.25,
    flashlightReliance: 0.4,
    backwardChecking: 0.25,
    routePredictability: 0.5,
    stillness: 0.25,
    trailPreference: 0.5,
  };

  /** Rolling history of positions, for the route-predictability estimate. */
  private trackX: number[] = [];
  private trackZ: number[] = [];
  private trackYaw: number[] = [];
  private readonly trackMax = 24;

  /** Accumulators between samples — filled per frame, drained on the cadence. */
  private accTime = 0;
  private accSprint = 0;
  private accMoving = 0;
  private accLight = 0;
  private accTurnBack = 0;
  private lastYaw: number | null = null;
  /** How much of the last sample window was spent facing behind travel. */
  private accLookBehind = 0;

  reset(): void {
    this.snap.sprintReliance = 0.25;
    this.snap.flashlightReliance = 0.4;
    this.snap.backwardChecking = 0.25;
    this.snap.routePredictability = 0.5;
    this.snap.stillness = 0.25;
    this.snap.trailPreference = 0.5;
    this.trackX.length = 0;
    this.trackZ.length = 0;
    this.trackYaw.length = 0;
    this.accTime = 0; this.accSprint = 0; this.accMoving = 0;
    this.accLight = 0; this.accTurnBack = 0; this.accLookBehind = 0;
    this.lastYaw = null;
  }

  /**
   * Per-frame accumulation.
   *
   * Deliberately trivial: four adds and one angle diff. The *analysis* happens
   * on the slow cadence in `sample()`. Splitting it this way is what lets the
   * model see every frame of input (so a fast flick of the mouse is not missed
   * by an unlucky sample boundary) while costing almost nothing.
   */
  observe(dt: number, s: BehaviorSample, velX: number, velZ: number): void {
    this.accTime += dt;
    if (s.sprinting) this.accSprint += dt;
    if (s.moving) this.accMoving += dt;
    if (s.lightOn) this.accLight += dt;

    // Backward checking has two components, and both matter:
    //
    //   1. Rapid yaw reversal — the over-the-shoulder flick.
    //   2. Sustained facing opposite to travel — walking backwards, which is
    //      the same anxiety expressed differently and would otherwise register
    //      as zero because the yaw is not *changing*.
    if (this.lastYaw !== null) {
      let d = s.yaw - this.lastYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      // A flick is a large angular change in a short time. Threshold at ~100°/s
      // so ordinary looking-around does not count.
      if (Math.abs(d) > dt * 1.75) this.accTurnBack += Math.min(dt * 4, Math.abs(d) * 0.3);
    }
    this.lastYaw = s.yaw;

    const vl = Math.hypot(velX, velZ);
    if (vl > 0.6) {
      const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
      const dot = (velX * fx + velZ * fz) / vl;
      if (dot < -0.25) this.accLookBehind += dt;
    }
  }

  /**
   * Slow analysis pass. Call at ~1 Hz.
   *
   * Everything expensive lives here, and "expensive" is still only a walk over
   * 24 cached positions.
   */
  sample(s: BehaviorSample): PlayerBehaviorSnapshot {
    const w = this.accTime;
    if (w <= 0.001) return this.snap;

    this.trackX.push(s.x); this.trackZ.push(s.z); this.trackYaw.push(s.yaw);
    if (this.trackX.length > this.trackMax) {
      this.trackX.shift(); this.trackZ.shift(); this.trackYaw.shift();
    }

    const movingFrac = this.accMoving / w;
    ema(this.snap, 'sprintReliance',
      // Fraction of *moving* time spent sprinting, not of wall time: standing
      // still is not evidence about how you run.
      movingFrac > 0.05 ? Math.min(1, (this.accSprint / w) / movingFrac) : this.snap.sprintReliance,
      w, TAU.sprint);
    ema(this.snap, 'flashlightReliance', this.accLight / w, w, TAU.light);
    ema(this.snap, 'backwardChecking',
      Math.min(1, (this.accTurnBack / w) * 1.3 + (this.accLookBehind / w) * 1.1),
      w, TAU.backward);
    ema(this.snap, 'stillness', 1 - movingFrac, w, TAU.stillness);
    // Trail preference: inside ~4 m of a path counts as "on it", falling off
    // smoothly to 16 m. Beyond that the player is genuinely bushwhacking.
    ema(this.snap, 'trailPreference',
      clamp01(1 - (s.trailDistance - 4) / 12), w, TAU.trail);
    ema(this.snap, 'routePredictability', this.estimatePredictability(), w, TAU.route);

    this.accTime = 0; this.accSprint = 0; this.accMoving = 0;
    this.accLight = 0; this.accTurnBack = 0; this.accLookBehind = 0;
    return this.snap;
  }

  /**
   * How straight and committed the recent route has been.
   *
   * Straightness = net displacement over path length. A player walking a
   * beeline to the next objective scores near 1; one who doubles back, circles
   * a clearing, or repeatedly changes their mind scores low.
   *
   * This is the honest measure of "can I anticipate this person", and using it
   * rather than something like "has visited a landmark before" matters: it
   * responds to what the player is doing *now*, and it improves the moment they
   * start varying their approach, which is the behaviour the system should
   * reward.
   */
  private estimatePredictability(): number {
    const n = this.trackX.length;
    if (n < 4) return this.snap.routePredictability;
    let pathLen = 0;
    for (let i = 1; i < n; i++) {
      pathLen += Math.hypot(this.trackX[i] - this.trackX[i - 1], this.trackZ[i] - this.trackZ[i - 1]);
    }
    if (pathLen < 4) {
      // Barely moved. A stationary player is *positionally* very predictable,
      // but predicting their route is meaningless, so decay toward neutral
      // instead of claiming certainty.
      return 0.5;
    }
    const net = Math.hypot(this.trackX[n - 1] - this.trackX[0], this.trackZ[n - 1] - this.trackZ[0]);
    const straightness = clamp01(net / pathLen);

    // Second term: heading variance. Straightness alone rates a wide, smooth
    // arc as unpredictable when it is in fact perfectly anticipatable — the
    // variance term catches that, because a smooth arc has low variance.
    let vsum = 0;
    for (let i = 1; i < n; i++) {
      let d = this.trackYaw[i] - this.trackYaw[i - 1];
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      vsum += Math.abs(d);
    }
    const jitter = clamp01(vsum / (n - 1) / 1.2);
    return clamp01(straightness * 0.68 + (1 - jitter) * 0.32);
  }

  get current(): PlayerBehaviorSnapshot { return this.snap; }

  snapshot(): PlayerBehaviorSnapshot {
    return {
      sprintReliance: +this.snap.sprintReliance.toFixed(3),
      flashlightReliance: +this.snap.flashlightReliance.toFixed(3),
      backwardChecking: +this.snap.backwardChecking.toFixed(3),
      routePredictability: +this.snap.routePredictability.toFixed(3),
      stillness: +this.snap.stillness.toFixed(3),
      trailPreference: +this.snap.trailPreference.toFixed(3),
    };
  }
}

function ema(
  o: PlayerBehaviorSnapshot, key: keyof PlayerBehaviorSnapshot,
  target: number, dt: number, tau: number,
): void {
  const a = 1 - Math.exp(-dt / tau);
  o[key] = clamp01(o[key] + (clamp01(target) - o[key]) * a);
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
