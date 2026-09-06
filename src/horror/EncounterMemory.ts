/**
 * ============================================================================
 * ENCOUNTER MEMORY — the reason a run feels authored
 * ============================================================================
 *
 * ## The failure this prevents
 *
 * A systemic horror game with no memory of what it has already done produces
 * the same encounter repeatedly, because the conditions that made one good tend
 * to persist for a while. The old brain had a partial version of this — a list
 * of sighting *positions* refused within 18 m — and that single axis was not
 * enough. Three sightings at three different treelines, all at 40 m, all in the
 * player's left periphery, all announced by the same sting, read as one
 * repeated event even though no position repeated.
 *
 * Identity of an encounter is at minimum: **type, place, distance band,
 * bearing sector**. This class scores a candidate against all four plus
 * recency, and returns a single novelty value the composer can weigh against
 * everything else it cares about.
 *
 * ## Why novelty is a score and not a veto
 *
 * A veto deadlocks. Late in a run, on a 560 m map, most of the good positions
 * have been used and most of the types have fired; a strict filter would either
 * refuse every candidate (empty forest) or force the composer to accept
 * whatever slipped through the filter, which is worse than choosing (the
 * survivors of a filter are arbitrary, not good). Scoring degrades gracefully:
 * when everything is stale the composer still picks the *least* stale option,
 * which is the correct behaviour.
 */

import { ENCOUNTER } from './HorrorConfig';

export type EncounterType =
  /** stands far away and watches, and is eventually noticed */
  | 'watcher'
  /** crosses a gap between trees, briefly, at a distance */
  | 'crossing'
  /** footsteps parallel to the player, no visual */
  | 'shadow'
  /** waiting near a predicted route point */
  | 'intercept'
  /** withdraws when noticed */
  | 'retreat'
  /** standing far down the route the player intended to take */
  | 'blocked'
  /** dangerously close with almost no warning */
  | 'closeSilence'
  /** the world goes quiet and nothing happens */
  | 'absence'
  /** a humanoid silhouette that turns out to be vegetation */
  | 'wrongTree'
  /** something in the periphery is gone when checked */
  | 'secondLook'
  /** a sound with no source */
  | 'falseCue'
  /** something about the world changed */
  | 'wrongness';

export interface EncounterRecord {
  type: EncounterType;
  /** run time, seconds */
  time: number;
  x: number; z: number;
  /** metres from the player at the time */
  distance: number;
  /** bearing relative to the player's facing, radians, -PI..PI */
  direction: number;
  /** 0..1 how strong the beat was */
  intensity: number;
}

export class EncounterMemory {
  private records: EncounterRecord[] = [];
  /** Counts per type, for the debug overlay and the variety assertions. */
  private counts = new Map<EncounterType, number>();

  reset(): void {
    this.records.length = 0;
    this.counts.clear();
  }

  record(r: EncounterRecord): void {
    this.records.push(r);
    if (this.records.length > ENCOUNTER.historyLength) this.records.shift();
    this.counts.set(r.type, (this.counts.get(r.type) ?? 0) + 1);
  }

  /**
   * How novel would this encounter be? 0 = identical to something recent,
   * 1 = nothing like it has happened.
   *
   * Each axis is penalised independently and then multiplied, so an encounter
   * that matches on *several* axes is punished far harder than one that matches
   * on one. That multiplicative shape is deliberate: repeating a type at a new
   * place is fine and normal, repeating a type at the same place from the same
   * bearing is the thing that reads as a loop.
   */
  novelty(
    type: EncounterType, x: number, z: number,
    distance: number, direction: number, now: number,
  ): number {
    let score = 1;
    let sameTypeIndex = -1;

    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      const age = now - r.time;
      if (age > ENCOUNTER.repeatMemorySeconds) continue;
      // Recency weight: something 20 s old is nearly disqualifying, something
      // three minutes old is barely a consideration.
      const recency = 1 - age / ENCOUNTER.repeatMemorySeconds;

      if (r.type === type) {
        if (sameTypeIndex < 0) sameTypeIndex = this.records.length - 1 - i;
        score *= 1 - 0.55 * recency;
      }
      const d = Math.hypot(r.x - x, r.z - z);
      if (d < ENCOUNTER.repeatRadius) {
        score *= 1 - 0.6 * recency * (1 - d / ENCOUNTER.repeatRadius);
      }
      if (Math.abs(r.distance - distance) < ENCOUNTER.distanceBand) {
        score *= 1 - 0.22 * recency;
      }
      if (angleDelta(r.direction, direction) < ENCOUNTER.bearingSector) {
        score *= 1 - 0.28 * recency;
      }
    }

    // Hard-ish type cooldown, expressed as a further multiplier rather than a
    // veto so it cannot deadlock a saturated late-game map.
    if (sameTypeIndex >= 0 && sameTypeIndex < ENCOUNTER.typeCooldown) {
      score *= 0.25 + (sameTypeIndex / ENCOUNTER.typeCooldown) * 0.55;
    }
    return Math.max(0, Math.min(1, score));
  }

  /** Has this exact type fired within the last `n` encounters? */
  recentlyUsed(type: EncounterType, n = ENCOUNTER.typeCooldown): boolean {
    const from = Math.max(0, this.records.length - n);
    for (let i = from; i < this.records.length; i++) {
      if (this.records[i].type === type) return true;
    }
    return false;
  }

  get last(): EncounterRecord | null {
    return this.records.length ? this.records[this.records.length - 1] : null;
  }
  get length(): number { return this.records.length; }
  get history(): readonly EncounterRecord[] { return this.records; }

  /** Distinct types used this run — the variety metric the tests assert on. */
  get distinctTypes(): number { return this.counts.size; }

  snapshot(): {
    length: number; distinctTypes: number;
    counts: Record<string, number>;
    recent: { type: string; t: number; d: number; i: number }[];
  } {
    const counts: Record<string, number> = {};
    for (const [k, v] of this.counts) counts[k] = v;
    return {
      length: this.records.length,
      distinctTypes: this.counts.size,
      counts,
      recent: this.records.slice(-6).map(r => ({
        type: r.type, t: +r.time.toFixed(1),
        d: +r.distance.toFixed(0), i: +r.intensity.toFixed(2),
      })),
    };
  }
}

/** Absolute shortest-arc difference between two angles. */
function angleDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
}
