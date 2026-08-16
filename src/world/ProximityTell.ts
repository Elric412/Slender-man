import type { EntitySnapshot } from '../ai/EntityBrain';

/**
 * ============================================================================
 * PROXIMITY TELL — optional "something is nearby" signalling
 * ============================================================================
 *
 * ## Why this exists, and why it is off-by-default-shaped
 *
 * STATIC's core tension is *ambiguity*: you are never certain whether the thing
 * is near. That is the design, and it is also, for some players, unplayable —
 * either because the ambiguity reads as unfairness ("I had no warning"), or
 * because they cannot use the audio cues the game leans on, or simply because
 * they want to explore without the dread budget.
 *
 * So this is a deliberate, player-owned dial rather than a difficulty setting.
 * It has three positions:
 *
 *   `off`      — nothing. The intended experience.
 *   `subtle`   — diegetic only: the tell is folded into things the world already
 *                does (the tape-static veil creeps in earlier, the frame
 *                breathes). Nothing new appears on screen. A player who wants a
 *                fair warning gets one without a HUD element admitting it.
 *   `explicit` — an actual on-screen indicator with a direction and an
 *                intensity. Unambiguous, accessible, and honest about being a
 *                game affordance.
 *
 * ## Why it reads detection and not distance
 *
 * The naive version is a distance meter. That is worse than nothing: it leaks
 * information the entity does not have, so the player learns to trust a number
 * that has no relationship to whether they are actually in danger. Palebark
 * standing 20 m away, dormant, facing away, is *safe*; Palebark at 60 m in
 * confront state with a clean LOS is not.
 *
 * So the tell is a function of the same detection state that drives everything
 * else (brief §8, single source of truth), attenuated by distance rather than
 * defined by it. The consequence is that the indicator answers the question the
 * player actually has — "am I in trouble" — instead of "where is the model".
 *
 * ## Hysteresis
 *
 * Detection oscillates near its thresholds as LOS is made and broken by trunks.
 * A tell wired straight to it would flicker, which is both ugly and misleading
 * (a flickering warning reads as *more* urgent than a steady one). So rise is
 * fast — a warning that arrives late is useless — and fall is slow, with a
 * minimum on-time, so a genuine contact cannot blink out the instant the player
 * steps behind a tree.
 */

export type TellMode = 'off' | 'subtle' | 'explicit';

export interface TellState {
  /** 0..1 how strongly the tell is currently asserting */
  intensity: number;
  /**
   * Bearing to the entity relative to the player's facing, radians, -PI..PI.
   * 0 = dead ahead, positive = to the right. Only meaningful in `explicit`.
   */
  bearing: number;
  /** true while the tell is asserting at all (drives element visibility) */
  active: boolean;
  /**
   * Coarse band, for callers that want words rather than a number. Kept coarse
   * on purpose: a precise readout would turn the game into a numbers game.
   */
  band: 'none' | 'near' | 'close' | 'imminent';
}

/** Distance at which even a fully-detected entity no longer registers. */
const MAX_RANGE = 85;

export class ProximityTell {
  mode: TellMode = 'off';

  private value = 0;
  private holdFor = 0;
  private state: TellState = {
    intensity: 0, bearing: 0, active: false, band: 'none',
  };

  reset(): void {
    this.value = 0;
    this.holdFor = 0;
    this.state.intensity = 0;
    this.state.bearing = 0;
    this.state.active = false;
    this.state.band = 'none';
  }

  /**
   * @param snap    the authoritative entity snapshot this frame
   * @param px,pz   player position
   * @param fwdX,fwdZ  player facing (unit, planar)
   */
  update(
    dt: number,
    snap: EntitySnapshot,
    px: number, pz: number,
    fwdX: number, fwdZ: number,
  ): TellState {
    if (this.mode === 'off') {
      if (this.value !== 0) this.reset();
      return this.state;
    }

    // ---- raw signal -------------------------------------------------------
    // Detection is the substance; distance only attenuates it. A confronting
    // entity at range still registers, because that is genuinely dangerous,
    // while a dormant one underfoot barely does.
    const dist = snap.distToPlayer;
    const prox = Math.max(0, 1 - dist / MAX_RANGE);
    // Squared so the signal stays quiet through the middle distances and only
    // becomes insistent when it is genuinely close — a linear ramp spends most
    // of its range mildly alarmed, which desensitises the player.
    const range = prox * prox;

    let raw = snap.detection * range;
    // State floor: once it is actively closing, the tell must not depend on
    // detection dipping behind a tree.
    if (snap.state === 'confronting') raw = Math.max(raw, 0.55 * range + 0.30);
    else if (snap.state === 'stalking') raw = Math.max(raw, 0.22 * range);
    raw = Math.min(1, raw);

    // ---- hysteresis -------------------------------------------------------
    if (raw > this.value) {
      // fast attack: ~0.25 s to arrive
      this.value += (raw - this.value) * Math.min(1, dt * 4.0);
      if (raw > 0.12) this.holdFor = 1.6;
    } else {
      this.holdFor -= dt;
      // Slow release, and refuse to fall at all during the hold window.
      if (this.holdFor <= 0) {
        this.value += (raw - this.value) * Math.min(1, dt * 0.7);
      }
    }
    if (this.value < 0.004) this.value = 0;

    // ---- bearing ----------------------------------------------------------
    // Signed angle from the player's facing to the entity, so an arrow or an
    // edge-glow can point at it. Computed with a cross/dot pair rather than two
    // atan2 calls and a wrap, which is where sign errors normally creep in.
    const dx = snap.x - px, dz = snap.z - pz;
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len, nz = dz / len;
    const dot = nx * fwdX + nz * fwdZ;
    const cross = fwdX * nz - fwdZ * nx;
    this.state.bearing = Math.atan2(cross, dot);

    this.state.intensity = this.value;
    this.state.active = this.value > 0.02;
    this.state.band =
      this.value > 0.68 ? 'imminent' :
      this.value > 0.38 ? 'close' :
      this.value > 0.02 ? 'near' : 'none';
    return this.state;
  }

  /**
   * Extra static/veil to fold into the fear system in `subtle` mode.
   *
   * Kept small and additive: it must read as the tape reacting a little sooner,
   * not as a second effect layered on top. In `explicit` mode it returns 0 —
   * the on-screen indicator is already carrying the information, and doubling it
   * up would cost the player visibility for no extra clarity.
   */
  staticBoost(): number {
    if (this.mode !== 'subtle') return 0;
    return this.value * 0.16;
  }

  get current(): TellState { return this.state; }
}
