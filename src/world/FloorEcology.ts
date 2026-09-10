/**
 * ============================================================================
 * FLOOR ECOLOGY — the semantic field the ground layer is scattered against
 * ============================================================================
 *
 * ## Why the floor needed its own field
 *
 * `ZoneSystem` already answers "what grows here", but it answers it in terms of
 * *authored zone identity* — old growth, marsh, blight — blended over a few
 * hundred metres. That is the right granularity for choosing tree species and
 * the wrong one for choosing where a log lies.
 *
 * A log is not a consequence of being in old growth. It is a consequence of a
 * big tree having stood *right there*, of the ground being flat enough that it
 * did not roll away, and of the spot being wet enough to have kept it rather
 * than dried it to splinters. Those are metre-scale facts, and none of them is
 * expressible as a zone weight.
 *
 * So this layer derives four continuous fields that ground props can actually
 * reason about, and exposes them as one reusable sample struct:
 *
 *   `trunkInfluence`  how much standing timber is nearby, from the real trunk
 *                     list — so debris genuinely accumulates around trees
 *                     rather than being sprinkled uniformly and *looking* like
 *                     it accumulates.
 *   `moisture`        zone wetness modulated by local terrain concavity, since
 *                     water collects in dips regardless of which zone the dip
 *                     is in. Drives moss and fungus.
 *   `drainage`        slope-driven; the inverse consideration. Gravel and
 *                     stones survive where water moves, moss does not.
 *   `openness`        canopy gap. Light reaching the floor decides whether a
 *                     dead thing rots under moss or bleaches in the open.
 *
 * ## Why the rules live here rather than in the scatterer
 *
 * `RULES` is a table of pure functions from a sample to a placement weight. It
 * sits next to the field it reads because the two are one idea: a rule that
 * asked for a field this class does not produce would be meaningless, and
 * keeping them apart is how a scatterer ends up with fifteen inline magic
 * expressions that nobody can audit against each other.
 *
 * Written as weights rather than booleans on purpose. A boolean gate produces
 * hard ecological boundaries — a wall of moss that stops dead at a contour —
 * whereas a weight produces a gradient, and gradients are what real transitions
 * look like.
 */

import { SeededRandom } from '../core/SeededRandom';
import type { HeightField } from './HeightField';
import type { ZoneSystem } from './ZoneSystem';

/** One evaluation of the floor's semantic fields. Reused; never allocated hot. */
export interface FloorSample {
  /** 0..~1.4 how much standing timber is within a few metres */
  trunkInfluence: number;
  /** 0..1 how wet the ground is here */
  moisture: number;
  /** 0..1 how freely water leaves — high on slopes, low in hollows */
  drainage: number;
  /** 0..1 how much sky reaches the floor */
  openness: number;
  /** 0..1 zone litter density, passed through for the leaf/twig families */
  litter: number;
  /** 0..1 zone rock density */
  rock: number;
  /** 0..1 zone deadfall density — the authored "this place has fallen wood" */
  deadfall: number;
  /** 0..1 zone fungi density */
  fungi: number;
}

/**
 * Deterministic per-position RNG.
 *
 * The scatterer needs randomness that is a pure function of *where* rather than
 * of iteration order, because a chunk is planned lazily and may be planned at a
 * different point in the sequence on a second visit. A chunk-sequential stream
 * would then produce a different floor for the same ground, and the forest
 * would visibly reshuffle as the player walked away and came back.
 *
 * Hashing the quantised position instead makes every prop's shape a property of
 * its location, so the same metre of ground always grows the same log.
 */
export function positionRng(x: number, z: number, salt: number): SeededRandom {
  // Quantise to 1 cm so floating-point drift in the sample position cannot
  // change the hash, then mix with two large odd constants.
  const ix = Math.round(x * 100) | 0;
  const iz = Math.round(z * 100) | 0;
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b1);
  h = (h ^ (h >>> 15)) | 0;
  return new SeededRandom((h >>> 0) || 1);
}

/** Trunk footprint, as the ecology needs it. Structural so it matches TreeRecord. */
interface TrunkRef { x: number; z: number; r: number; crown: number }

/**
 * Placement rules, one per ground-prop family.
 *
 * Each returns an unnormalised 0..~1 weight. The scatterer multiplies it by a
 * macro patchiness field and then uses it as an acceptance probability, so the
 * absolute scale only has to be self-consistent within a family — what matters
 * is the *shape* of each response.
 */
export const RULES = {
  /**
   * Big sound logs. Need a mature stand (something had to fall) and ground that
   * is not steep (a log on a hillside rolls to the bottom).
   */
  log: (s: FloorSample): number =>
    s.trunkInfluence * 0.7 * (0.35 + s.deadfall * 0.9) * (1 - s.drainage * 0.45),

  /**
   * Broken/rotted log sections. Wetter and more decayed than a sound log, so
   * they favour moisture, and they survive in places a whole trunk would not.
   */
  logBroken: (s: FloorSample): number =>
    (0.25 + s.trunkInfluence * 0.55) * (0.3 + s.moisture * 0.8) * (0.4 + s.deadfall * 0.7),

  /** Stumps mark where a tree *was*, so they track trunk influence hardest. */
  stump: (s: FloorSample): number =>
    s.trunkInfluence * 0.85 * (0.4 + s.deadfall * 0.6),

  /**
   * Root arches — exposed root systems bridging a gap. Rare by design: they
   * need old timber AND eroded ground, which is drainage and slope together.
   */
  rootArch: (s: FloorSample): number =>
    Math.max(0, s.trunkInfluence - 0.45) * 0.8 * (0.2 + s.drainage * 0.9),

  /** Fallen branches: common anywhere there are trees at all. */
  branch: (s: FloorSample): number =>
    (0.2 + s.trunkInfluence * 0.8) * (0.35 + s.deadfall * 0.75),

  /**
   * Twigs. The workhorse family — this is what stops the floor reading as bare
   * ground, so its weight is deliberately high and nearly unconditional.
   */
  twig: (s: FloorSample): number =>
    0.35 + s.litter * 0.6 + s.trunkInfluence * 0.25,

  /**
   * Boulders are geology, not ecology: they ignore trees entirely and follow
   * the zone's rock density and drainage. Placing them from trunk influence is
   * the classic tell that a floor was scattered by one rule.
   */
  boulder: (s: FloorSample): number =>
    s.rock * (0.35 + s.drainage * 0.75),

  stone: (s: FloorSample): number =>
    s.rock * 0.9 * (0.3 + s.drainage * 0.6) + 0.04,

  /** Pebbles drift where water has moved: high drainage, low moisture. */
  pebble: (s: FloorSample): number =>
    (0.1 + s.rock * 0.8) * (0.25 + s.drainage * 0.95) * (1 - s.moisture * 0.4),

  /**
   * Moss mounds are the counterpart to pebbles — they want standing damp and
   * shade, so the openness term is inverted.
   */
  mossMound: (s: FloorSample): number =>
    s.moisture * (1 - s.openness * 0.6) * (0.3 + s.trunkInfluence * 0.6),

  /** Fungus: damp, shaded, and on or near dead wood. */
  fungus: (s: FloorSample): number =>
    s.fungi * (0.25 + s.moisture * 1.0) * (1 - s.openness * 0.5)
    * (0.35 + s.trunkInfluence * 0.8),

  /**
   * Bark plates shed from standing trunks. Meaningless away from a trunk, so
   * this is almost pure trunk influence — the scatterer additionally requires
   * a real trunk within range before it emits, since a weight alone would give
   * a haze of flecks across the forest.
   */
  barkFleck: (s: FloorSample): number =>
    Math.max(0, s.trunkInfluence - 0.25) * 1.1,
} as const;

/**
 * The field itself.
 *
 * Holds a coarse spatial hash of trunk positions so `trunkInfluence` and
 * `trunkNear` are cheap. Everything else is analytic and stateless.
 */
export class FloorEcology {
  private hf: HeightField;
  private zones: ZoneSystem;
  /** macro patchiness, so density varies within a zone */
  private patchNoise: SeededRandom;

  /** Trunk hash: cell key → trunks in that cell. */
  private grid = new Map<number, TrunkRef[]>();
  private readonly cell = 12;
  private static readonly GRID_SPAN = 4096;

  /** Reused result for `trunkNear`, so the hot path allocates nothing. */
  private nearResult: { nearest: TrunkRef | null; count: number; dist: number } = {
    nearest: null, count: 0, dist: Infinity,
  };

  constructor(hf: HeightField, zones: ZoneSystem, seed: number) {
    this.hf = hf;
    this.zones = zones;
    this.patchNoise = new SeededRandom((seed ^ 0xF100E0) >>> 0);
  }

  /** A blank sample, for callers to allocate once and reuse. */
  static newSample(): FloorSample {
    return {
      trunkInfluence: 0, moisture: 0, drainage: 0, openness: 0,
      litter: 0, rock: 0, deadfall: 0, fungi: 0,
    };
  }

  /**
   * Index the standing trunks.
   *
   * Called once after the forest is scattered and before the floor is planned.
   * The ordering is load-bearing: debris that accumulates around trees can only
   * be placed if the trees already exist, which is why the scatterer builds
   * canopy first and floor second.
   */
  indexTrunks(trees: readonly TrunkRef[]): void {
    this.grid.clear();
    for (const t of trees) {
      const k = this.key(t.x, t.z);
      let list = this.grid.get(k);
      if (!list) { list = []; this.grid.set(k, list); }
      list.push(t);
    }
  }

  private key(x: number, z: number): number {
    const i = Math.floor(x / this.cell) + FloorEcology.GRID_SPAN;
    const j = Math.floor(z / this.cell) + FloorEcology.GRID_SPAN;
    return j * (FloorEcology.GRID_SPAN * 2) + i;
  }

  /**
   * Fill `out` with the floor's semantic fields at a point.
   *
   * Writes into a caller-owned struct rather than returning one: this is called
   * a few hundred times per chunk across a dozen families, and AGENTS.md
   * forbids per-frame allocation in generation hot loops for exactly this
   * reason — a returned object here is tens of thousands of short-lived
   * allocations during streaming, which shows up as GC hitches while walking.
   */
  sample(x: number, z: number, out: FloorSample): FloorSample {
    // ---- trunk influence -------------------------------------------------
    // Summed falloff over the 3x3 neighbourhood of cells, weighted by trunk
    // radius so a mature trunk contributes more than a sapling. Not a count:
    // a count makes a thicket of ten thin stems look like old growth, which is
    // precisely backwards for debris.
    let influence = 0;
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const list = this.grid.get(
          (cj + dj + FloorEcology.GRID_SPAN) * (FloorEcology.GRID_SPAN * 2)
          + (ci + di + FloorEcology.GRID_SPAN));
        if (!list) continue;
        for (const t of list) {
          const dx = t.x - x, dz = t.z - z;
          const d2 = dx * dx + dz * dz;
          const reach = 3.5 + t.r * 9;
          const r2 = reach * reach;
          if (d2 > r2) continue;
          influence += (1 - d2 / r2) * (0.35 + t.r * 1.6);
        }
      }
    }
    out.trunkInfluence = Math.min(1.4, influence);

    // ---- terrain-derived terms -------------------------------------------
    const slope = this.hf.slopeAt(x, z);
    // Drainage is slope, saturating: past about a 1:2 grade everything drains
    // and further steepness changes nothing about what survives on the surface.
    out.drainage = Math.min(1, slope / 0.5);

    // Concavity: is this point lower than its surroundings? Sampled as a small
    // cross rather than a true Laplacian — four extra height lookups against
    // an analytic field, and the sign is all that matters.
    const h = this.hf.heightAt(x, z);
    const ring = (
      this.hf.heightAt(x + 4, z) + this.hf.heightAt(x - 4, z)
      + this.hf.heightAt(x, z + 4) + this.hf.heightAt(x, z - 4)
    ) * 0.25;
    // Positive when the point sits in a dip.
    const concavity = Math.max(-1, Math.min(1, (ring - h) / 1.8));

    const zoneWet = this.zones.scalarAt(x, z, 'wetness');
    out.moisture = Math.max(0, Math.min(1,
      zoneWet * 0.72
      + Math.max(0, concavity) * 0.45
      - out.drainage * 0.3));

    const closure = this.zones.scalarAt(x, z, 'canopyClosure');
    out.openness = Math.max(0, Math.min(1, 1 - closure));

    // ---- authored zone densities, passed through -------------------------
    out.litter = this.zones.scalarAt(x, z, 'litterDensity');
    out.rock = this.zones.scalarAt(x, z, 'rockDensity');
    out.deadfall = this.zones.scalarAt(x, z, 'deadfallDensity');
    out.fungi = this.zones.scalarAt(x, z, 'fungiDensity');
    return out;
  }

  /**
   * Macro patchiness multiplier, 0..~1.3.
   *
   * Applied on top of every rule so density itself varies at a scale larger
   * than any single prop. Without it a correct set of ecological rules still
   * produces an *evenly* correct floor, and even correctness reads as
   * procedural — real ground has bare patches next to choked ones for reasons
   * no rule captures.
   */
  patch(x: number, z: number): number {
    const a = this.patchNoise.fbm2(x * 0.021, z * 0.021, 3);
    const b = this.patchNoise.fbm2(x * 0.085 + 31.7, z * 0.085 - 12.3, 2);
    return Math.max(0, 0.62 + a * 0.52 + b * 0.22);
  }

  /**
   * Nearest trunk within `radius`, plus how many are in range.
   *
   * Returns a reused struct. Callers must not retain it — the bark-fleck pass
   * reads `nearest` immediately and discards, which is the only intended use.
   */
  trunkNear(x: number, z: number, radius: number): { nearest: TrunkRef | null; count: number; dist: number } {
    const r = this.nearResult;
    r.nearest = null; r.count = 0; r.dist = Infinity;
    const span = Math.max(1, Math.ceil(radius / this.cell));
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    const r2 = radius * radius;
    for (let dj = -span; dj <= span; dj++) {
      for (let di = -span; di <= span; di++) {
        const list = this.grid.get(
          (cj + dj + FloorEcology.GRID_SPAN) * (FloorEcology.GRID_SPAN * 2)
          + (ci + di + FloorEcology.GRID_SPAN));
        if (!list) continue;
        for (const t of list) {
          const dx = t.x - x, dz = t.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          r.count++;
          if (d2 < r.dist) { r.dist = d2; r.nearest = t; }
        }
      }
    }
    r.dist = r.dist === Infinity ? Infinity : Math.sqrt(r.dist);
    return r;
  }

  /** Trunks indexed, for the census/debug overlay. */
  get indexedTrunks(): number {
    let n = 0;
    for (const list of this.grid.values()) n += list.length;
    return n;
  }
}
