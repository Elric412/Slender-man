import { SeededRandom } from '../core/SeededRandom';
import { HeightField } from './HeightField';

/**
 * ============================================================================
 * STATIC — ecological zone system
 * ============================================================================
 *
 * The original forest had ONE density value and ONE species mix for the whole
 * 420 m map (see WORLD.md §0.4). This file is the fix: the map is divided into
 * seven zones, each with its own identity — density, species mix, condition
 * distribution, palette, ground treatment, canopy closure, climbing growth,
 * moisture and fog.
 *
 * Two design decisions worth stating:
 *
 * 1. **Zones are a blended field, not a partition.** Every sample carries a
 *    weight for all seven zones; the dominant one *names* the place. This makes
 *    transitions gradients tens of metres wide instead of visible seams, which
 *    is what lets a player feel they've entered somewhere new without ever
 *    seeing a boundary.
 *
 * 2. **It's baked, not evaluated.** Scatter asks "what is it like here?"
 *    hundreds of thousands of times. Walking influence polylines per query
 *    would dominate boot. So the whole field is baked once into a 160² grid of
 *    packed records and every later query is an array read + bilinear blend.
 */

export type ZoneId =
  | 'oldGrowth'
  | 'thicket'
  | 'stormFall'
  | 'marsh'
  | 'ravine'
  | 'blight'
  | 'dryUpland';

export const ZONE_IDS: readonly ZoneId[] = [
  'oldGrowth', 'thicket', 'stormFall', 'marsh', 'ravine', 'blight', 'dryUpland',
];

/** Tree archetype identifiers — see TreeFactory. */
export type ArchetypeId =
  | 'matureConifer'    // the cathedral tree: tall, high crown, clean lower trunk
  | 'youngConifer'     // dense regrowth, foliage all the way down
  | 'hardwood'         // broad deciduous, spreading asymmetric crown
  | 'snag'             // long dead, bare, no foliage at all
  | 'stormBroken'      // snapped crown, splintered top, surviving side limbs
  | 'understory'       // small multi-stem sapling / shrub tree
  | 'alder';           // water-tolerant wetland tree, leaning, mossy

export const ARCHETYPE_IDS: readonly ArchetypeId[] = [
  'matureConifer', 'youngConifer', 'hardwood', 'snag', 'stormBroken', 'understory', 'alder',
];

/** Condition drives per-instance tint, moss weight and foliage material. */
export type Condition = 'healthy' | 'stormDamaged' | 'dying' | 'longDead' | 'mossHeavy';

export const CONDITIONS: readonly Condition[] = [
  'healthy', 'stormDamaged', 'dying', 'longDead', 'mossHeavy',
];

export interface ZoneProfile {
  id: ZoneId;
  name: string;
  /** relative tree count multiplier (1 = baseline forest) */
  density: number;
  /** stands per hectare-ish — how many cluster seeds spawn */
  clusterRate: number;
  /** [min,max] cluster radius in metres */
  clusterRadius: [number, number];
  /** [min,max] members per cluster */
  clusterSize: [number, number];
  /** archetype selection weights (need not sum to 1) */
  species: Partial<Record<ArchetypeId, number>>;
  /** condition selection weights */
  condition: Partial<Record<Condition, number>>;
  /** overall scale multiplier applied to trees here */
  scale: [number, number];
  /** 0..1 how closed the canopy reads overhead */
  canopyClosure: number;
  /** 0..1 fern/low-plant coverage */
  fernDensity: number;
  /** 0..1 ground moss carpet */
  mossDensity: number;
  /** 0..1 climbing vine coverage on trunks */
  vineDensity: number;
  /** 0..1 hanging moss/lichen drapery from branches */
  drapeDensity: number;
  /** 0..1 deadfall log + stump coverage */
  deadfallDensity: number;
  /** 0..1 loose rock coverage */
  rockDensity: number;
  /** 0..1 leaf-litter card coverage */
  litterDensity: number;
  /** 0..1 mushroom / fungi coverage */
  fungiDensity: number;
  /** 0..1 reed clumps (wetland only) */
  reedDensity: number;
  /** ground albedo tint, linear-ish RGB triple */
  groundTint: [number, number, number];
  /** extra ground-fog weight on top of the global bed */
  fogWeight: number;
  /** fog colour bias */
  fogTint: [number, number, number];
  /** hemisphere/ambient light multiplier for this zone */
  ambient: number;
  /** direct-moonlight multiplier — broken canopy lets more through */
  moonlight: number;
  /** 0..1 mud/wet-soil weighting for the ground shader + footstep surface */
  wetness: number;
}

/**
 * The seven characters. Numbers here are the actual art direction — this table
 * is where "what kind of place is this?" is answered.
 */
export const ZONE_PROFILES: Record<ZoneId, ZoneProfile> = {
  // ── ancient forest around the ranger station ───────────────────────────────
  // Few trees, enormous ones. High crowns interlock; the floor is bare needle
  // duff. Long sightlines — deliberately the calm early-game pacing zone.
  oldGrowth: {
    id: 'oldGrowth', name: 'Old Growth',
    density: 0.62, clusterRate: 0.5, clusterRadius: [11, 22], clusterSize: [3, 7],
    species: { matureConifer: 7, hardwood: 2, snag: 0.7, understory: 0.4 },
    condition: { healthy: 6, mossHeavy: 3, dying: 0.8, longDead: 0.5 },
    scale: [1.25, 1.85], canopyClosure: 0.88,
    fernDensity: 0.16, mossDensity: 0.5, vineDensity: 0.1, drapeDensity: 0.36,
    deadfallDensity: 0.44, rockDensity: 0.22, litterDensity: 0.9, fungiDensity: 0.42,
    reedDensity: 0,
    groundTint: [0.30, 0.26, 0.20], fogWeight: 0.5, fogTint: [0.05, 0.07, 0.10],
    ambient: 0.72, moonlight: 0.5, wetness: 0.28,
  },

  // ── young regrowth choking the gaps between POIs ───────────────────────────
  // Highest density on the map, tightest spacing, no sightlines. Tension beats
  // and flanking routes live here.
  thicket: {
    id: 'thicket', name: 'Thicket',
    density: 2.05, clusterRate: 1.5, clusterRadius: [5, 11], clusterSize: [8, 24],
    species: { youngConifer: 7, understory: 4.5, hardwood: 1.6, matureConifer: 0.9, snag: 0.5 },
    condition: { healthy: 7, dying: 2.2, mossHeavy: 1.6, stormDamaged: 0.6 },
    scale: [0.62, 1.06], canopyClosure: 0.72,
    fernDensity: 0.92, mossDensity: 0.4, vineDensity: 0.44, drapeDensity: 0.2,
    deadfallDensity: 0.36, rockDensity: 0.12, litterDensity: 0.62, fungiDensity: 0.3,
    reedDensity: 0,
    groundTint: [0.22, 0.25, 0.17], fogWeight: 0.72, fogTint: [0.05, 0.08, 0.09],
    ambient: 0.5, moonlight: 0.24, wetness: 0.36,
  },

  // ── blowdown stand around the quarry ──────────────────────────────────────
  // Broken canopy, downed trunks, exposed rock. Sparser and more open, and the
  // only zone where direct moonlight reaches the floor in quantity.
  stormFall: {
    id: 'stormFall', name: 'Storm Fall',
    density: 0.58, clusterRate: 0.62, clusterRadius: [8, 17], clusterSize: [3, 9],
    species: { stormBroken: 6, snag: 3.4, matureConifer: 1.8, youngConifer: 1.3, understory: 1.1 },
    condition: { stormDamaged: 6, longDead: 3.4, dying: 1.8, healthy: 1.2 },
    scale: [0.85, 1.45], canopyClosure: 0.2,
    fernDensity: 0.26, mossDensity: 0.14, vineDensity: 0.12, drapeDensity: 0.05,
    deadfallDensity: 1.0, rockDensity: 0.9, litterDensity: 0.4, fungiDensity: 0.36,
    reedDensity: 0,
    groundTint: [0.32, 0.29, 0.25], fogWeight: 0.24, fogTint: [0.08, 0.10, 0.13],
    ambient: 0.95, moonlight: 1.4, wetness: 0.18,
  },

  // ── saturated lowland at the lake and dock ────────────────────────────────
  marsh: {
    id: 'marsh', name: 'Marsh Lowland',
    density: 0.86, clusterRate: 0.95, clusterRadius: [6, 14], clusterSize: [4, 13],
    species: { alder: 7, snag: 2.2, understory: 2.4, youngConifer: 1.1, hardwood: 0.8 },
    condition: { mossHeavy: 5.5, dying: 3, healthy: 2.4, longDead: 1.8 },
    scale: [0.78, 1.25], canopyClosure: 0.44,
    fernDensity: 0.6, mossDensity: 0.95, vineDensity: 0.28, drapeDensity: 0.5,
    deadfallDensity: 0.55, rockDensity: 0.08, litterDensity: 0.3, fungiDensity: 0.62,
    reedDensity: 1.0,
    groundTint: [0.20, 0.21, 0.17], fogWeight: 1.5, fogTint: [0.10, 0.13, 0.15],
    ambient: 0.85, moonlight: 0.8, wetness: 0.95,
  },

  // ── the creek corridor: lushest, dampest place on the map ─────────────────
  ravine: {
    id: 'ravine', name: 'Creek Ravine',
    density: 1.42, clusterRate: 1.2, clusterRadius: [5, 12], clusterSize: [5, 16],
    species: { alder: 4.4, matureConifer: 3.2, hardwood: 3, understory: 3.4, youngConifer: 1.6, snag: 0.7 },
    condition: { mossHeavy: 7, healthy: 4, dying: 1.4, longDead: 0.8 },
    scale: [0.9, 1.55], canopyClosure: 0.96,
    fernDensity: 1.0, mossDensity: 1.0, vineDensity: 0.95, drapeDensity: 0.9,
    deadfallDensity: 0.8, rockDensity: 0.7, litterDensity: 0.5, fungiDensity: 0.95,
    reedDensity: 0.3,
    groundTint: [0.17, 0.22, 0.16], fogWeight: 1.7, fogTint: [0.09, 0.13, 0.14],
    ambient: 0.42, moonlight: 0.16, wetness: 1.0,
  },

  // ── the wrong place ──────────────────────────────────────────────────────
  // Small and deliberately unnatural: bare grey trunks, zero undergrowth, no
  // fungi, no reeds, still air. Its wrongness only reads *because* every other
  // zone has a believable identity.
  blight: {
    id: 'blight', name: 'Blight',
    density: 1.15, clusterRate: 1.05, clusterRadius: [7, 13], clusterSize: [5, 14],
    species: { snag: 8, stormBroken: 2, matureConifer: 1 },
    condition: { longDead: 10, dying: 1.2 },
    scale: [0.9, 1.5], canopyClosure: 0.3,
    fernDensity: 0.0, mossDensity: 0.0, vineDensity: 0.0, drapeDensity: 0.0,
    deadfallDensity: 0.3, rockDensity: 0.2, litterDensity: 0.1, fungiDensity: 0.0,
    reedDensity: 0,
    groundTint: [0.26, 0.25, 0.24], fogWeight: 0.9, fogTint: [0.10, 0.10, 0.11],
    ambient: 0.6, moonlight: 0.9, wetness: 0.05,
  },

  // ── default: dry ridgelines and high ground ──────────────────────────────
  dryUpland: {
    id: 'dryUpland', name: 'Dry Upland',
    density: 0.72, clusterRate: 0.7, clusterRadius: [7, 16], clusterSize: [3, 10],
    species: { matureConifer: 4, youngConifer: 3, snag: 1.4, understory: 1.2, hardwood: 0.9, stormBroken: 0.6 },
    condition: { healthy: 6, dying: 2, longDead: 1.4, stormDamaged: 1, mossHeavy: 0.7 },
    scale: [0.72, 1.3], canopyClosure: 0.42,
    fernDensity: 0.28, mossDensity: 0.12, vineDensity: 0.1, drapeDensity: 0.08,
    deadfallDensity: 0.38, rockDensity: 0.62, litterDensity: 0.55, fungiDensity: 0.18,
    reedDensity: 0,
    groundTint: [0.31, 0.28, 0.22], fogWeight: 0.3, fogTint: [0.07, 0.09, 0.12],
    ambient: 0.9, moonlight: 1.1, wetness: 0.1,
  },
};

/** Result of a field query — a blend, plus the dominant zone for naming. */
export interface ZoneSample {
  dominant: ZoneId;
  /** weights per zone, normalised to sum 1, index-aligned to ZONE_IDS */
  weights: Float32Array;
  /** blended scalars — read these, not the profile, for continuous values */
  density: number;
  canopyClosure: number;
  fernDensity: number;
  mossDensity: number;
  vineDensity: number;
  drapeDensity: number;
  deadfallDensity: number;
  rockDensity: number;
  litterDensity: number;
  fungiDensity: number;
  reedDensity: number;
  fogWeight: number;
  ambient: number;
  moonlight: number;
  wetness: number;
  groundTint: [number, number, number];
  fogTint: [number, number, number];
}

/** An area nothing may spawn inside. */
export interface ExclusionVolume {
  x: number; z: number;
  /** circular radius, or half-extents when hx/hz set */
  r: number;
  hx?: number; hz?: number; yaw?: number;
  tag: string;
}

const FIELD_RES = 160;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Zone influence sources. Each contributes a falloff-weighted vote for its
 * zone; the field is the normalised sum. Authored by hand — this is the
 * "environment as a character" layer, so it is deliberately not procedural.
 */
interface Influence {
  zone: ZoneId;
  x: number; z: number;
  /** full-strength radius */
  r: number;
  /** falloff distance beyond r */
  feather: number;
  strength: number;
}

export class ZoneSystem {
  /** packed zone weights: FIELD_RES² × 7 */
  private field: Float32Array;
  /** dominant zone index per cell, for cheap naming queries */
  private domIdx: Uint8Array;
  private res = FIELD_RES;
  private step: number;
  private half: number;
  private rng: SeededRandom;

  readonly exclusions: ExclusionVolume[] = [];

  private scratch = new Float32Array(7);

  /** quarry rim centroid, cached for the exclusion + moisture passes */
  private qCx = 0;
  private qCz = 0;

  constructor(private hf: HeightField, seed: number) {
    this.rng = new SeededRandom(seed ^ 0x20E5);
    this.half = hf.layout.size / 2;
    this.step = hf.layout.size / (this.res - 1);
    for (const p of hf.layout.quarryRim) { this.qCx += p.x; this.qCz += p.z; }
    this.qCx /= hf.layout.quarryRim.length;
    this.qCz /= hf.layout.quarryRim.length;
    this.field = new Float32Array(this.res * this.res * 7);
    this.domIdx = new Uint8Array(this.res * this.res);
    this.bake();
    this.registerBaseExclusions();
  }

  // ==========================================================================
  // creek — delegated, NOT duplicated
  // ==========================================================================

  /**
   * The creek centreline is owned by `HeightField`, because there the channel is
   * *carved into the height grid* before zone/trail relaxation. Duplicating the
   * polyline here would let the ecology field and the actual terrain drift apart
   * — ferns growing on a bank the ground no longer has. So we read the one
   * authoritative copy.
   */
  get creek(): readonly { x: number; z: number }[] { return this.hf.layout.creek.path; }

  /** index along `creek` where the waterfall drops */
  get creekFallIndex(): number { return this.hf.layout.creek.fall?.index ?? 0; }

  /** distance to the creek centreline (m) */
  creekDist(x: number, z: number): number { return this.hf.creekDist(x, z); }

  /** position along the creek, 0..1 from source to lake */
  creekParam(x: number, z: number): number { return this.hf.creekParam(x, z); }

  // ==========================================================================
  // field bake
  // ==========================================================================

  /**
   * The ecology field for Pinewood Forest, derived from the survey map's own
   * logic rather than sprinkled around the POIs.
   *
   * The reasoning, region by region:
   *  - the North Ridge is high, exposed and wind-scoured  -> dryUpland + stormFall
   *  - the quarry destroyed its own soil                  -> blight + stormFall
   *  - the eastern shelf (cabin/rocks) is old and sheltered -> oldGrowth
   *  - the basin floor around Pine Lake is waterlogged    -> marsh
   *  - the creek corridor is a shaded cut                 -> ravine
   *  - everything the survey never cleared                -> thicket
   *
   * Because the field is *blended* (not a partition), the boundaries between
   * these are gradients you can feel walking through them — the ferns thin out
   * and the trunks thicken a good thirty metres before you reach the old growth.
   */
  private influences(): Influence[] {
    const z = this.hf.layout.zones;
    const byId = (id: string) => {
      const found = z.find(q => q.id === id);
      if (!found) throw new Error(`ZoneSystem: layout has no zone '${id}'`);
      return found;
    };
    const ridge = byId('ridge'), quarry = byId('quarry'), cabin = byId('cabin');
    const clearing = byId('clearing'), rocks = byId('rocks'), tower = byId('tower');
    const camp = byId('camp'), dock = byId('dock'), shack = byId('shack');
    const hub = byId('hub');

    const inf: Influence[] = [
      // ── old growth: the sheltered eastern shelf, cabin to rock formation.
      // Big trunks, high closed canopy, bare needle floor. The one part of the
      // forest that feels like it was here long before the survey.
      { zone: 'oldGrowth', x: cabin.x - 12, z: cabin.z + 20, r: 40, feather: 46, strength: 1.45 },
      { zone: 'oldGrowth', x: rocks.x - 22, z: rocks.z - 6, r: 30, feather: 40, strength: 1.15 },
      { zone: 'oldGrowth', x: (cabin.x + rocks.x) / 2 + 26, z: (cabin.z + rocks.z) / 2, r: 26, feather: 38, strength: 1.0 },
      // a second, smaller stand west of the junction — so old growth is not
      // simply "the east", and the player can be wrong about where they are
      { zone: 'oldGrowth', x: hub.x - 62, z: hub.z - 30, r: 20, feather: 34, strength: 0.9 },

      // ── storm fall: the exposed ridge crest and the quarry's wrecked lip.
      // Snapped crowns, leaning trunks, root plates torn out of the ground.
      { zone: 'stormFall', x: ridge.x + 10, z: ridge.z + 26, r: 46, feather: 44, strength: 1.5 },
      { zone: 'stormFall', x: ridge.x - 64, z: ridge.z + 40, r: 24, feather: 34, strength: 1.0 },
      { zone: 'stormFall', x: quarry.x + 30, z: quarry.z - 26, r: 26, feather: 32, strength: 1.2 },
      // the windthrow gap that made the Clearing in the first place
      { zone: 'stormFall', x: clearing.x + 4, z: clearing.z - 16, r: 22, feather: 30, strength: 1.25 },

      // ── marsh: the whole lake basin floor, heaviest on the reedy west arm
      { zone: 'marsh', x: this.hf.layout.lake.x, z: this.hf.layout.lake.z, r: 64, feather: 40, strength: 1.55 },
      { zone: 'marsh', x: this.hf.layout.lake.x - 44, z: this.hf.layout.lake.z + 6, r: 24, feather: 30, strength: 1.15 },
      { zone: 'marsh', x: dock.x + 6, z: dock.z - 16, r: 20, feather: 28, strength: 1.0 },
      // the low ground the campground was pitched on, which is why it flooded
      { zone: 'marsh', x: camp.x + 14, z: camp.z + 34, r: 22, feather: 32, strength: 0.95 },

      // ── blight: the quarry floor and its poisoned run-off. Deliberately the
      // only large dead zone, and you have to walk down into it.
      { zone: 'blight', x: quarry.x, z: quarry.z + 8, r: 34, feather: 22, strength: 2.4 },
      // one small isolated patch out on the shack spur — off every main route,
      // so finding it means you went slightly wrong
      { zone: 'blight', x: shack.x - 30, z: shack.z - 14, r: 15, feather: 14, strength: 2.1 },

      // ── dry upland: the ridge shoulders and the granite around the outcrop
      { zone: 'dryUpland', x: ridge.x - 20, z: ridge.z - 30, r: 40, feather: 44, strength: 1.3 },
      { zone: 'dryUpland', x: rocks.x + 16, z: rocks.z + 14, r: 26, feather: 32, strength: 1.15 },

      // ── thicket: everything the survey never cleared. These fill the gaps
      // between landmarks, which is where the player actually spends their
      // time being lost.
      { zone: 'thicket', x: (tower.x + camp.x) / 2 - 8, z: (tower.z + camp.z) / 2, r: 30, feather: 40, strength: 1.1 },
      { zone: 'thicket', x: (quarry.x + tower.x) / 2 - 10, z: (quarry.z + tower.z) / 2, r: 30, feather: 38, strength: 1.05 },
      { zone: 'thicket', x: (hub.x + rocks.x) / 2, z: (hub.z + rocks.z) / 2 + 22, r: 28, feather: 38, strength: 1.0 },
      { zone: 'thicket', x: shack.x - 4, z: shack.z + 26, r: 26, feather: 36, strength: 1.0 },
      { zone: 'thicket', x: camp.x - 76, z: camp.z + 8, r: 28, feather: 36, strength: 1.0 },
      { zone: 'thicket', x: clearing.x + 74, z: clearing.z + 58, r: 26, feather: 34, strength: 0.95 },
      { zone: 'thicket', x: -180, z: -30, r: 30, feather: 38, strength: 0.9 },
      { zone: 'thicket', x: 176, z: 150, r: 30, feather: 38, strength: 0.9 },
    ];

    // ravine: the creek corridor itself, sampled along the centreline
    for (let i = 0; i < this.creek.length; i += 2) {
      const p = this.creek[i];
      inf.push({ zone: 'ravine', x: p.x, z: p.z, r: 13, feather: 17, strength: 1.7 });
    }
    return inf;
  }

  private bake(): void {
    const inf = this.influences();
    const uplandIdx = ZONE_IDS.indexOf('dryUpland');
    const w = new Float32Array(7);

    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        w.fill(0);

        // dryUpland is the substrate: it always has some presence, and more of
        // it on high, steep, dry ground.
        //
        // The elevation term must be *bounded*. Scaling linearly with height
        // (h * 0.06, unbounded) reached ~4.0 on the 58 m ridge, which is larger
        // than every authored influence combined — so dryUpland won almost
        // everywhere and the forest read as one homogeneous biome regardless of
        // how carefully the influences were placed. A saturating curve keeps
        // "high ground is dry" true without letting altitude override the
        // ecology: full strength on the ridge tops, negligible in the basin.
        const h = this.hf.heightAt(x, z);
        const alt = clamp01((h - 6) / 34);                 // 0 in the valley, 1 by ~40 m
        w[uplandIdx] = 0.34 + alt * alt * 0.62;

        for (const s of inf) {
          const d = Math.hypot(x - s.x, z - s.z);
          if (d > s.r + s.feather) continue;
          const t = d <= s.r ? 1 : 1 - (d - s.r) / s.feather;
          // smoothstep the falloff so blends have no linear kink
          const f = t * t * (3 - 2 * t);
          w[ZONE_IDS.indexOf(s.zone)] += f * s.strength;
        }

        // normalise
        let sum = 0;
        for (let k = 0; k < 7; k++) sum += w[k];
        if (sum <= 1e-6) { w[uplandIdx] = 1; sum = 1; }
        const base = (j * this.res + i) * 7;
        let dom = 0, domV = -1;
        for (let k = 0; k < 7; k++) {
          const v = w[k] / sum;
          this.field[base + k] = v;
          if (v > domV) { domV = v; dom = k; }
        }
        this.domIdx[j * this.res + i] = dom;
      }
    }
  }

  // ==========================================================================
  // queries
  // ==========================================================================

  /** nearest-cell dominant zone — cheap, for naming and audio/light regions */
  dominantAt(x: number, z: number): ZoneId {
    const i = Math.round((x + this.half) / this.step);
    const j = Math.round((z + this.half) / this.step);
    const ci = i < 0 ? 0 : i >= this.res ? this.res - 1 : i;
    const cj = j < 0 ? 0 : j >= this.res ? this.res - 1 : j;
    return ZONE_IDS[this.domIdx[cj * this.res + ci]];
  }

  /** bilinear-blended weights into `out` (length 7); returns dominant index */
  weightsAt(x: number, z: number, out: Float32Array): number {
    const fx = (x + this.half) / this.step, fz = (z + this.half) / this.step;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; if (j < 0) j = 0;
    if (i > this.res - 2) i = this.res - 2;
    if (j > this.res - 2) j = this.res - 2;
    const tx = Math.max(0, Math.min(1, fx - i)), tz = Math.max(0, Math.min(1, fz - j));
    const b00 = (j * this.res + i) * 7, b10 = (j * this.res + i + 1) * 7;
    const b01 = ((j + 1) * this.res + i) * 7, b11 = ((j + 1) * this.res + i + 1) * 7;
    let dom = 0, domV = -1;
    for (let k = 0; k < 7; k++) {
      const v = (this.field[b00 + k] * (1 - tx) + this.field[b10 + k] * tx) * (1 - tz)
        + (this.field[b01 + k] * (1 - tx) + this.field[b11 + k] * tx) * tz;
      out[k] = v;
      if (v > domV) { domV = v; dom = k; }
    }
    return dom;
  }

  /** Full blended sample. Allocates — use for setup/queries, not hot loops. */
  sample(x: number, z: number): ZoneSample {
    const w = new Float32Array(7);
    const dom = this.weightsAt(x, z, w);
    const s: ZoneSample = {
      dominant: ZONE_IDS[dom], weights: w,
      density: 0, canopyClosure: 0, fernDensity: 0, mossDensity: 0, vineDensity: 0,
      drapeDensity: 0, deadfallDensity: 0, rockDensity: 0, litterDensity: 0,
      fungiDensity: 0, reedDensity: 0, fogWeight: 0, ambient: 0, moonlight: 0,
      wetness: 0, groundTint: [0, 0, 0], fogTint: [0, 0, 0],
    };
    for (let k = 0; k < 7; k++) {
      const wk = w[k];
      if (wk <= 0) continue;
      const p = ZONE_PROFILES[ZONE_IDS[k]];
      s.density += p.density * wk;
      s.canopyClosure += p.canopyClosure * wk;
      s.fernDensity += p.fernDensity * wk;
      s.mossDensity += p.mossDensity * wk;
      s.vineDensity += p.vineDensity * wk;
      s.drapeDensity += p.drapeDensity * wk;
      s.deadfallDensity += p.deadfallDensity * wk;
      s.rockDensity += p.rockDensity * wk;
      s.litterDensity += p.litterDensity * wk;
      s.fungiDensity += p.fungiDensity * wk;
      s.reedDensity += p.reedDensity * wk;
      s.fogWeight += p.fogWeight * wk;
      s.ambient += p.ambient * wk;
      s.moonlight += p.moonlight * wk;
      s.wetness += p.wetness * wk;
      for (let c = 0; c < 3; c++) {
        s.groundTint[c] += p.groundTint[c] * wk;
        s.fogTint[c] += p.fogTint[c] * wk;
      }
    }
    return s;
  }

  /**
   * Zero-alloc scalar blend for hot placement loops. `key` names a numeric
   * ZoneProfile field.
   */
  scalarAt(x: number, z: number, key: keyof ZoneProfile): number {
    const w = this.scratch;
    this.weightsAt(x, z, w);
    let v = 0;
    for (let k = 0; k < 7; k++) {
      if (w[k] <= 0) continue;
      v += (ZONE_PROFILES[ZONE_IDS[k]][key] as number) * w[k];
    }
    return v;
  }

  /**
   * How much of a zone's `fogTint` hue survives into the renderer.
   *
   * The profile tuples were authored as *absolute dark colours*, so their channel
   * ratios are stronger than intended as pure hues — old growth is `[0.05,0.07,0.10]`,
   * a 2:1 blue-to-red ratio, which normalised to full strength is a distinct blue
   * cast. The reference frames are near-monochrome; places differ by small hue
   * shifts, not palettes, and a heavy cool cast is exactly the "generic AI horror
   * game" look we are avoiding. This scales the normalised hue back toward neutral.
   *
   * Lives here, next to the tuples it applies to, because the look director and the
   * offline verifier both need it and a duplicated literal would silently drift.
   */
  static readonly TINT_SATURATION = 0.45;

  /**
   * Blend a `[r,g,b]` ZoneProfile tuple into `out`, without allocating.
   *
   * `sample()` returns the same information but builds a `ZoneSample` (two arrays
   * plus an object) every call, which is fine for placement-time code and not fine
   * for the per-frame look director. This exists so the renderer can read
   * `fogTint`/`groundTint` every frame under the zero-per-frame-allocation rule.
   *
   * @param key a ZoneProfile field whose value is a 3-tuple
   */
  tupleAt(
    x: number, z: number, key: 'groundTint' | 'fogTint', out: [number, number, number],
  ): [number, number, number] {
    const w = this.scratch;
    this.weightsAt(x, z, w);
    out[0] = 0; out[1] = 0; out[2] = 0;
    for (let k = 0; k < 7; k++) {
      const wk = w[k];
      if (wk <= 0) continue;
      const t = ZONE_PROFILES[ZONE_IDS[k]][key];
      out[0] += t[0] * wk; out[1] += t[1] * wk; out[2] += t[2] * wk;
    }
    return out;
  }

  /**
   * Pick an archetype using the blended species weights at this point, so
   * species mixes *interpolate* across a zone boundary rather than snapping.
   */
  pickArchetype(x: number, z: number, r: SeededRandom): ArchetypeId {
    const w = this.scratch;
    this.weightsAt(x, z, w);
    let total = 0;
    const acc: number[] = [];
    for (let a = 0; a < ARCHETYPE_IDS.length; a++) {
      let v = 0;
      for (let k = 0; k < 7; k++) {
        if (w[k] <= 0) continue;
        v += (ZONE_PROFILES[ZONE_IDS[k]].species[ARCHETYPE_IDS[a]] ?? 0) * w[k];
      }
      total += v; acc.push(total);
    }
    if (total <= 0) return 'matureConifer';
    const pick = r.next() * total;
    for (let a = 0; a < acc.length; a++) if (pick <= acc[a]) return ARCHETYPE_IDS[a];
    return ARCHETYPE_IDS[ARCHETYPE_IDS.length - 1];
  }

  /** Same idea for condition. */
  pickCondition(x: number, z: number, r: SeededRandom): Condition {
    const w = this.scratch;
    this.weightsAt(x, z, w);
    let total = 0;
    const acc: number[] = [];
    for (let c = 0; c < CONDITIONS.length; c++) {
      let v = 0;
      for (let k = 0; k < 7; k++) {
        if (w[k] <= 0) continue;
        v += (ZONE_PROFILES[ZONE_IDS[k]].condition[CONDITIONS[c]] ?? 0) * w[k];
      }
      total += v; acc.push(total);
    }
    if (total <= 0) return 'healthy';
    const pick = r.next() * total;
    for (let c = 0; c < acc.length; c++) if (pick <= acc[c]) return CONDITIONS[c];
    return 'healthy';
  }

  /** Blended scale range at a point. */
  scaleRangeAt(x: number, z: number): [number, number] {
    const w = this.scratch;
    this.weightsAt(x, z, w);
    let lo = 0, hi = 0;
    for (let k = 0; k < 7; k++) {
      if (w[k] <= 0) continue;
      const p = ZONE_PROFILES[ZONE_IDS[k]];
      lo += p.scale[0] * w[k]; hi += p.scale[1] * w[k];
    }
    return [lo || 0.8, hi || 1.2];
  }

  // ==========================================================================
  // moisture / exclusions
  // ==========================================================================

  /**
   * 0..1 soil moisture. Real inputs: creek proximity, lake proximity, terrain
   * hollowness (water runs downhill and pools), and absolute elevation.
   * This is what makes alder cluster in wet ground and upland pine avoid it —
   * i.e. placement driven by ecology instead of by a random number.
   */
  moistureAt(x: number, z: number): number {
    const cd = this.creekDist(x, z);
    const creek = Math.max(0, 1 - cd / 26);
    // distance outward from the actual waterline, not from a bounding circle:
    // the west arm's reed shelf is wet right up to the bank, while the steep
    // east shore dries out within a few metres
    const ld = this.hf.lakeSdf(x, z);
    const lakeW = Math.max(0, 1 - Math.max(0, ld) / 34);
    const h = this.hf.heightAt(x, z);
    // hollowness: how far below the local neighbourhood average this point sits
    const ring = (this.hf.heightAt(x + 9, z) + this.hf.heightAt(x - 9, z)
      + this.hf.heightAt(x, z + 9) + this.hf.heightAt(x, z - 9)) * 0.25;
    const hollow = Math.max(0, Math.min(1, (ring - h) / 3.2));
    const elev = Math.max(0, Math.min(1, 1 - (h + 4) / 22));
    return Math.max(0, Math.min(1,
      creek * 0.85 + lakeW * 0.8 + hollow * 0.45 + elev * 0.3));
  }

  /** local slope magnitude (metres of rise per ~1.5 m step, summed on both axes) */
  slopeAt(x: number, z: number): number {
    const h = this.hf.heightAt(x, z);
    return Math.abs(this.hf.heightAt(x + 1.5, z) - h) + Math.abs(this.hf.heightAt(x, z + 1.5) - h);
  }

  /** how far below the local neighbourhood a point sits — drives fog pooling */
  hollownessAt(x: number, z: number): number {
    const h = this.hf.heightAt(x, z);
    let ring = 0;
    for (const [dx, dz] of [[11, 0], [-11, 0], [0, 11], [0, -11], [8, 8], [-8, -8], [8, -8], [-8, 8]] as const) {
      ring += this.hf.heightAt(x + dx, z + dz);
    }
    ring /= 8;
    return Math.max(0, Math.min(1, (ring - h) / 3.6));
  }

  // ==========================================================================
  // exclusion volumes
  // ==========================================================================

  addExclusion(v: ExclusionVolume): void { this.exclusions.push(v); }

  /** POI clearings and the creek channel are excluded from the start. */
  private registerBaseExclusions(): void {
    for (const zn of this.hf.layout.zones) {
      // The lake, ridge and quarry are terrain, not built clearings: excluding
      // their whole radius would strip the shoreline reeds, the ridge crest
      // pines and the quarry-rim deadfall — exactly the vegetation that makes
      // them read as places. Their real footprints are handled below.
      if (zn.id === 'lake' || zn.id === 'ridge' || zn.id === 'quarry') continue;
      // trailheads are markers on a path, not clearings
      if (zn.id === 'east-trail' || zn.id === 'west-trail') continue;
      // the rock formation keeps trees between its shelves
      const k = zn.id === 'rocks' ? 0.5 : 0.86;
      this.addExclusion({ x: zn.x, z: zn.z, r: zn.r * k, tag: `poi:${zn.id}` });
    }
    // Pine Lake: exclude the open water only, sampled along the traced
    // shoreline so reeds and alder can still crowd the actual waterline.
    const shore = this.hf.layout.lake.shore;
    const lc = this.hf.layout.lake;
    for (let i = 0; i < shore.length; i++) {
      const p = shore[i];
      // pull each shore point inward toward the centre, then exclude a disc:
      // the union covers the water and stops a few metres short of the bank
      const dx = lc.x - p.x, dz = lc.z - p.z;
      const l = Math.hypot(dx, dz) || 1;
      this.addExclusion({ x: p.x + (dx / l) * 9, z: p.z + (dz / l) * 9, r: 11, tag: 'lake' });
    }
    this.addExclusion({ x: lc.x, z: lc.z, r: 26, tag: 'lake' });
    // Quarry: exclude the floor and the benched walls, but leave the rim.
    for (const p of this.hf.layout.quarryRim) {
      const dx = this.qCx - p.x, dz = this.qCz - p.z;
      const l = Math.hypot(dx, dz) || 1;
      this.addExclusion({ x: p.x + (dx / l) * 8, z: p.z + (dz / l) * 8, r: 10, tag: 'quarry' });
    }
    this.addExclusion({ x: this.qCx, z: this.qCz, r: 24, tag: 'quarry' });
    // creek channel — sampled, so the exclusion follows the meander
    for (let i = 0; i < this.creek.length; i += 1) {
      const p = this.creek[i];
      this.addExclusion({ x: p.x, z: p.z, r: 3.4, tag: 'creek' });
    }
  }

  /** true if (x,z) is inside any exclusion volume, with an optional pad */
  excluded(x: number, z: number, pad = 0): boolean {
    for (let i = 0; i < this.exclusions.length; i++) {
      const e = this.exclusions[i];
      if (e.hx !== undefined && e.hz !== undefined) {
        const yaw = e.yaw ?? 0;
        const c = Math.cos(-yaw), s = Math.sin(-yaw);
        const dx = x - e.x, dz = z - e.z;
        const lx = dx * c - dz * s, lz = dx * s + dz * c;
        if (Math.abs(lx) < e.hx + pad && Math.abs(lz) < e.hz + pad) return true;
      } else {
        const dx = x - e.x, dz = z - e.z;
        const rr = e.r + pad;
        if (dx * dx + dz * dz < rr * rr) return true;
      }
    }
    return false;
  }
}
