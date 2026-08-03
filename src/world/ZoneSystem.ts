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

  /** creek centreline, authored below and shared with CreekSystem */
  readonly creek: { x: number; z: number }[] = [];
  /** the waterfall drop point along the creek */
  creekFallIndex = 0;

  private scratch = new Float32Array(7);

  constructor(private hf: HeightField, seed: number) {
    this.rng = new SeededRandom(seed ^ 0x20E5);
    this.half = hf.layout.size / 2;
    this.step = hf.layout.size / (this.res - 1);
    this.field = new Float32Array(this.res * this.res * 7);
    this.domIdx = new Uint8Array(this.res * this.res);
    this.buildCreek();
    this.bake();
    this.registerBaseExclusions();
  }

  // ==========================================================================
  // creek centreline
  // ==========================================================================

  /**
   * The creek runs from the high north-east ridge down to the lake in the
   * south-west — i.e. downhill, because water does. Authored as a coarse
   * control polyline, then resampled with noise wander so it never reads as a
   * straight cut.
   */
  private buildCreek(): void {
    const control = [
      { x: 128, z: -142 },
      { x: 96, z: -96 },
      { x: 58, z: -52 },
      { x: 22, z: -18 },
      { x: -14, z: 6 },
      { x: -52, z: 34 },
      { x: -84, z: 62 },
      { x: -112, z: 88 },
      { x: -132, z: 108 },
    ];
    const r = this.rng.fork(0x517E);
    for (let i = 0; i < control.length - 1; i++) {
      const a = control[i], b = control[i + 1];
      const segs = 7;
      for (let s = 0; s < segs; s++) {
        const t = s / segs;
        // catmull-ish smoothing against neighbours keeps curvature continuous
        const p0 = control[Math.max(0, i - 1)], p3 = control[Math.min(control.length - 1, i + 2)];
        const t2 = t * t, t3 = t2 * t;
        const cx = 0.5 * ((2 * a.x) + (-p0.x + b.x) * t + (2 * p0.x - 5 * a.x + 4 * b.x - p3.x) * t2 + (-p0.x + 3 * a.x - 3 * b.x + p3.x) * t3);
        const cz = 0.5 * ((2 * a.z) + (-p0.z + b.z) * t + (2 * p0.z - 5 * a.z + 4 * b.z - p3.z) * t2 + (-p0.z + 3 * a.z - 3 * b.z + p3.z) * t3);
        // perpendicular wander
        const dx = b.x - a.x, dz = b.z - a.z;
        const pl = Math.hypot(dx, dz) || 1;
        const wob = r.noise1(i * 4.7 + t * 3.3) * 5.5;
        this.creek.push({ x: cx - (dz / pl) * wob, z: cz + (dx / pl) * wob });
      }
    }
    this.creek.push(control[control.length - 1]);
    // waterfall sits about a third of the way down, where the ridge breaks
    this.creekFallIndex = Math.floor(this.creek.length * 0.3);
  }

  /** distance to the creek centreline (m) */
  creekDist(x: number, z: number): number {
    let best = Infinity;
    for (let i = 0; i < this.creek.length - 1; i++) {
      const a = this.creek[i], b = this.creek[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      let u = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = a.x + dx * u, pz = a.z + dz * u;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /** signed position along the creek, 0..1 from source to lake */
  creekParam(x: number, z: number): number {
    let best = Infinity, bestI = 0, bestU = 0;
    for (let i = 0; i < this.creek.length - 1; i++) {
      const a = this.creek[i], b = this.creek[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len2 = dx * dx + dz * dz || 1;
      let u = ((x - a.x) * dx + (z - a.z) * dz) / len2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const px = a.x + dx * u, pz = a.z + dz * u;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < best) { best = d; bestI = i; bestU = u; }
    }
    return (bestI + bestU) / (this.creek.length - 1);
  }

  // ==========================================================================
  // field bake
  // ==========================================================================

  private influences(): Influence[] {
    const z = this.hf.layout.zones;
    const byId = (id: string) => z.find(q => q.id === id)!;
    const station = byId('station'), quarry = byId('quarry'), dock = byId('dock');
    const camp = byId('camp'), mill = byId('mill'), tower = byId('tower');
    const radio = byId('radio'), tunnel = byId('tunnel');

    const inf: Influence[] = [
      // old growth: a broad belt centred on the station, reaching toward the tower
      { zone: 'oldGrowth', x: station.x, z: station.z, r: 34, feather: 40, strength: 1.35 },
      { zone: 'oldGrowth', x: station.x - 34, z: station.z - 26, r: 20, feather: 34, strength: 1.0 },
      { zone: 'oldGrowth', x: tower.x + 18, z: tower.z + 26, r: 18, feather: 32, strength: 0.9 },

      // storm fall: the quarry rim and the slope above it
      { zone: 'stormFall', x: quarry.x + 6, z: quarry.z - 6, r: 30, feather: 32, strength: 1.4 },
      { zone: 'stormFall', x: quarry.x - 24, z: quarry.z + 20, r: 16, feather: 26, strength: 0.95 },
      { zone: 'stormFall', x: radio.x - 18, z: radio.z + 14, r: 14, feather: 26, strength: 0.8 },

      // marsh: the lake basin and the dock approach
      { zone: 'marsh', x: this.hf.layout.lake.x, z: this.hf.layout.lake.z, r: 54, feather: 30, strength: 1.5 },
      { zone: 'marsh', x: dock.x + 10, z: dock.z - 12, r: 18, feather: 26, strength: 1.0 },

      // blight: one small, deliberately isolated patch between mill and radio,
      // off the main trail — you have to go slightly wrong to find it.
      { zone: 'blight', x: 108, z: -34, r: 17, feather: 15, strength: 2.2 },

      // thicket: everything between POIs that isn't otherwise claimed
      { zone: 'thicket', x: (mill.x + camp.x) / 2, z: (mill.z + camp.z) / 2, r: 26, feather: 40, strength: 1.0 },
      { zone: 'thicket', x: (camp.x + dock.x) / 2 + 14, z: (camp.z + dock.z) / 2, r: 24, feather: 36, strength: 1.0 },
      { zone: 'thicket', x: (tunnel.x + camp.x) / 2, z: (tunnel.z + camp.z) / 2, r: 28, feather: 38, strength: 1.05 },
      { zone: 'thicket', x: (mill.x + tower.x) / 2, z: (mill.z + tower.z) / 2 - 8, r: 24, feather: 36, strength: 1.0 },
      { zone: 'thicket', x: 150, z: 40, r: 26, feather: 34, strength: 0.95 },
      { zone: 'thicket', x: -60, z: -140, r: 24, feather: 34, strength: 0.9 },
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
        const h = this.hf.heightAt(x, z);
        w[uplandIdx] = 0.5 + Math.max(0, h) * 0.06;

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
    const lake = this.hf.layout.lake;
    const ld = Math.hypot(x - lake.x, z - lake.z);
    const lakeW = Math.max(0, 1 - Math.max(0, ld - lake.r) / 34);
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
      this.addExclusion({ x: zn.x, z: zn.z, r: zn.r * 0.86, tag: `poi:${zn.id}` });
    }
    const lake = this.hf.layout.lake;
    this.addExclusion({ x: lake.x, z: lake.z, r: lake.r + 3, tag: 'lake' });
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
