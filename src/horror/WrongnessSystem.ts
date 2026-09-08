/**
 * ============================================================================
 * WRONGNESS — the forest disagreeing with your memory of it
 * ============================================================================
 *
 * ## The effect being engineered
 *
 * Not a scare. The target reaction is the much quieter, much longer-lasting
 * "…was that always like that?" — and the design consequence of that target is
 * unusual enough to be worth stating plainly: **most of these changes will
 * never be noticed, and that is correct.**
 *
 * A change the player definitely notices is an event. Events are processed,
 * attributed, and filed away. A change the player *might* have noticed is never
 * resolved, so it stays live: they start checking things, and once they are
 * checking things the forest is doing the work without the game spending
 * anything. The hit rate is deliberately poor because the misses are free and
 * the hits are enormous.
 *
 * ## Rules that make it work rather than annoy
 *
 * **1. Never change anything the player can see.** Enforced, not intended — a
 * change that happens in view is a special effect, and it converts an
 * unexplainable observation into an explainable one ("the game did that"). The
 * whole value is deniability.
 *
 * **2. Never change anything nearby.** Same reason, plus a practical one: at
 * close range the player has a precise memory to compare against and will be
 * *certain*. Certainty is the failure state.
 *
 * **3. Deniability decays across the run.** Early changes have mundane
 * explanations (a lamp burned out, a marker was always crooked). Late ones do
 * not. The escalation is in *explicability*, not in magnitude, which is why
 * this system never needs to shout.
 *
 * **4. Budgeted per act.** Ten changes in a minute is a haunted house. Three in
 * ten minutes is a place that is wrong.
 *
 * ## Why the changes are cheap
 *
 * Every effect here mutates state the world already owns — a light's on/off, a
 * prop's yaw, an anchor's registered position. None allocates geometry, none
 * touches a material, none requires a rebuild. That is a hard constraint rather
 * than an optimisation: the system fires from a background cadence, and
 * anything that could hitch would announce itself on exactly the frames it most
 * needs to be invisible.
 */

import * as THREE from 'three';
import { SeededRandom } from '../core/SeededRandom';
import { WRONGNESS } from './HorrorConfig';
import type { HorrorProgressionSnapshot } from './HorrorProgression';
import type { ViewerProbe } from '../ai/EntityBrain';

/**
 * Something in the world that may be quietly altered.
 *
 * Registered by the map builder rather than discovered by traversing the scene
 * graph: a traversal would find every merged batch in the forest and have no
 * way to know which of them a player could plausibly *remember*. Only things
 * with a remembered identity — a signpost, a lantern, a marker — are worth
 * changing, and only the builder knows which those are.
 */
export interface WrongnessAnchor {
  kind: 'marker' | 'prop' | 'light' | 'door';
  x: number; z: number;
  /** the object to mutate, if this anchor owns discrete geometry */
  obj?: THREE.Object3D;
  /** its authored yaw, so a rotation can be measured and reverted */
  baseYaw?: number;
  /** human-readable id, for the debug overlay */
  id?: string;
  /** set once this anchor has been used; each is only good once */
  used?: boolean;
}

export type WrongnessKind =
  /** a trail marker or signpost now points somewhere else */
  | 'rotatedMarker'
  /** a lamp that was burning is out */
  | 'dousedLight'
  /** a prop has moved a few metres from where it was */
  | 'movedProp'
  /** a prop is subtly not upright any more */
  | 'tiltedProp';

export interface WrongnessEvent {
  kind: WrongnessKind;
  x: number; z: number;
  /** 0..1 how hard this is to explain away; rises across the run */
  inexplicability: number;
  /** run time it happened */
  time: number;
  id: string;
}

/** What the system needs from the world to place and validate a change. */
export interface WrongnessWorld {
  /** extinguish the nearest lamp to a point; returns where, or null */
  douseLight(x: number, z: number, minDistance: number): { x: number; y: number; z: number } | null;
  /** true if the player can currently see this point */
  playerCanSee(p: ViewerProbe, x: number, z: number): boolean;
  heightAt(x: number, z: number): number;
}

export class WrongnessSystem {
  private rng: SeededRandom;
  private anchors: WrongnessAnchor[] = [];
  private events: WrongnessEvent[] = [];

  private timer = 0;
  private runTime = 0;
  private actSpent = 0;
  private actOf = '';
  private reason = 'idle';

  /** Fired when a change lands, so dread can rise if the player later notices. */
  onChange: ((e: WrongnessEvent) => void) | null = null;

  constructor(seed: number) {
    this.rng = new SeededRandom((seed ^ 0x1C0FFEE) >>> 0);
  }

  /** Register the props the world considers memorable. Called once at build. */
  setAnchors(list: readonly WrongnessAnchor[]): void {
    this.anchors = list.map(a => ({ ...a, used: false }));
  }

  begin(seed: number): void {
    this.rng = new SeededRandom((seed ^ 0x1C0FFEE) >>> 0);
    this.events.length = 0;
    this.actSpent = 0;
    this.actOf = '';
    this.runTime = 0;
    this.reason = 'run start';
    // Restore every anchor to its authored pose. Wrongness is per-run state,
    // and a second run that opens with the previous run's rotated markers has
    // spent its whole budget before the player has seen anything straight.
    for (const a of this.anchors) {
      a.used = false;
      if (a.obj && a.baseYaw !== undefined) a.obj.rotation.y = a.baseYaw;
    }
    this.timer = WRONGNESS.interval * this.rng.range(0.8, 1.4);
  }

  /**
   * Slow tick. Called at `CADENCE.wrongness` (0.5 Hz) — this is background
   * work by definition, and evaluating it per frame would be absurd.
   */
  update(
    dt: number,
    ctx: {
      progression: HorrorProgressionSnapshot;
      player: ViewerProbe;
      world: WrongnessWorld;
    },
  ): void {
    this.runTime += dt;
    const act = ctx.progression.act;
    if (act !== this.actOf) { this.actOf = act; this.actSpent = 0; }

    if (!ctx.progression.environmentalDistortionUnlocked) return;

    this.timer -= dt;
    if (this.timer > 0) return;
    const j = WRONGNESS.intervalJitter;
    this.timer = WRONGNESS.interval * this.rng.range(1 - j, 1 + j);

    const budget = WRONGNESS.budget[act] ?? 0;
    if (this.actSpent >= budget) { this.reason = `budget spent for ${act}`; return; }

    if (this.attempt(ctx)) this.actSpent++;
  }

  private attempt(ctx: {
    progression: HorrorProgressionSnapshot;
    player: ViewerProbe;
    world: WrongnessWorld;
  }): boolean {
    const p = ctx.player;
    // Inexplicability climbs with the act. Early: a lamp went out. Late: a
    // signpost is pointing at a direction the trail does not go.
    const inexplicability = 0.2 + ctx.progression.normalizedProgress * 0.65;

    // Lights first when available: the cheapest change, the most deniable, and
    // the one that alters the *feel* of a place rather than its contents.
    if (this.rng.next() < 0.45) {
      const hit = ctx.world.douseLight(p.x, p.z, WRONGNESS.minPlayerDistance);
      if (hit && !ctx.world.playerCanSee(p, hit.x, hit.z)) {
        return this.commit('dousedLight', hit.x, hit.z, inexplicability, 'lamp');
      }
    }

    // Otherwise pick an unused anchor that is far away and out of sight.
    const candidates: WrongnessAnchor[] = [];
    for (const a of this.anchors) {
      if (a.used) continue;
      const d = Math.hypot(a.x - p.x, a.z - p.z);
      if (d < WRONGNESS.minPlayerDistance) continue;
      // Far enough that the player has probably *left* it and may come back —
      // a change 200 m away that they never revisit is wasted budget.
      if (d > 190) continue;
      if (WRONGNESS.requireUnobserved && ctx.world.playerCanSee(p, a.x, a.z)) continue;
      candidates.push(a);
    }
    if (!candidates.length) { this.reason = 'no eligible anchor'; return false; }

    const a = candidates[this.rng.int(0, candidates.length - 1)];
    a.used = true;

    switch (a.kind) {
      case 'marker': {
        // Rotate a signpost. The magnitude matters more than it looks: a small
        // nudge is invisible, a 180° flip is obviously the game doing
        // something. A third to a half turn is the band where the arm now
        // points somewhere plausible but wrong, which is the only version of
        // this that produces doubt rather than either nothing or certainty.
        if (!a.obj) return false;
        const turn = this.rng.sign() * this.rng.range(0.9, 2.1);
        a.obj.rotation.y = (a.baseYaw ?? a.obj.rotation.y) + turn;
        return this.commit('rotatedMarker', a.x, a.z, inexplicability, a.id ?? 'marker');
      }
      case 'prop': {
        if (!a.obj) return false;
        // Move it, or tilt it. Movement is the stronger read; tilt is the more
        // deniable, so the roll is weighted by how far into the run we are.
        if (this.rng.next() < 0.35 + ctx.progression.normalizedProgress * 0.3) {
          const ang = this.rng.range(0, Math.PI * 2);
          const r = this.rng.range(1.6, 4.2);
          a.obj.position.x += Math.cos(ang) * r;
          a.obj.position.z += Math.sin(ang) * r;
          a.obj.position.y = ctx.world.heightAt(a.obj.position.x, a.obj.position.z);
          return this.commit('movedProp', a.x, a.z, inexplicability, a.id ?? 'prop');
        }
        a.obj.rotation.z += this.rng.sign() * this.rng.range(0.08, 0.22);
        return this.commit('tiltedProp', a.x, a.z, inexplicability * 0.7, a.id ?? 'prop');
      }
      case 'light': {
        const hit = ctx.world.douseLight(a.x, a.z, 0);
        if (!hit) return false;
        return this.commit('dousedLight', hit.x, hit.z, inexplicability, a.id ?? 'lamp');
      }
      case 'door': {
        if (!a.obj) return false;
        a.obj.rotation.y = (a.baseYaw ?? 0) + this.rng.sign() * this.rng.range(0.6, 1.4);
        return this.commit('rotatedMarker', a.x, a.z, inexplicability, a.id ?? 'door');
      }
    }
    return false;
  }

  private commit(
    kind: WrongnessKind, x: number, z: number,
    inexplicability: number, id: string,
  ): boolean {
    const e: WrongnessEvent = {
      kind, x, z, inexplicability: Math.min(1, inexplicability),
      time: this.runTime, id,
    };
    this.events.push(e);
    if (this.events.length > 24) this.events.shift();
    this.reason = `${kind} @ ${id}`;
    this.onChange?.(e);
    return true;
  }

  /**
   * Has the player come back to somewhere that was altered?
   *
   * This is where wrongness actually becomes dread. The change itself costs
   * nothing psychologically — it happened while nobody was looking. It only
   * pays out when the player *returns*, sees it, and cannot resolve it, so the
   * dread is credited here rather than at the moment of the change.
   *
   * Each event pays out once. A player who camps next to a doused lamp should
   * not accumulate dread for staring at it.
   *
   * @returns total inexplicability newly observed this tick, 0 if nothing.
   */
  observe(p: ViewerProbe, canSee: (x: number, z: number) => boolean): number {
    let credited = 0;
    for (const e of this.events) {
      if ((e as WrongnessEvent & { seen?: boolean }).seen) continue;
      const d = Math.hypot(e.x - p.x, e.z - p.z);
      // Must be close enough to actually resolve, and actually in view.
      if (d > 30) continue;
      if (!canSee(e.x, e.z)) continue;
      (e as WrongnessEvent & { seen?: boolean }).seen = true;
      credited += e.inexplicability;
    }
    return credited;
  }

  get count(): number { return this.events.length; }

  snapshot(): {
    count: number; actSpent: number; reason: string;
    events: { kind: string; id: string; t: number; seen: boolean }[];
  } {
    return {
      count: this.events.length,
      actSpent: this.actSpent,
      reason: this.reason,
      events: this.events.slice(-8).map(e => ({
        kind: e.kind, id: e.id, t: +e.time.toFixed(1),
        seen: !!(e as WrongnessEvent & { seen?: boolean }).seen,
      })),
    };
  }
}
