/**
 * ScatterSystem — the layer that turns the tree factory, the atlas and the zone
 * field into an actual forest.
 *
 * ## Why this file exists
 *
 * `TreeFactory` can build 7 archetypes x 5 structural variants x 5 conditions,
 * `ForestAtlas` can serve all of them from two materials, and `ZoneSystem`
 * knows what should grow where. None of that reaches the screen without a
 * placement layer, and the placement layer is where the hard problems live.
 *
 * ### 1. Draw calls vs. variety
 *
 * `InstancedMesh` needs one geometry per draw, so N distinct templates visible
 * at once costs N draws. That prices variety out — and a renderer that punishes
 * variety produces exactly the "same tree copied four hundred times" look.
 * Instead, every tree in a chunk is CPU-transformed into one shared vertex
 * buffer. A chunk of forty *different* trees is two draw calls, so template
 * count is free. We pay geometry memory instead, which is the next problem.
 *
 * ### 2. Memory
 *
 * Merging is only viable if the merged buffers are cheap. Measured on this
 * world, a naive merge (float32 everything, both LOD tiers resident for all 49
 * chunks) cost 189 MB — unshippable. Two fixes, together worth ~9x:
 *
 *  - **Quantised attributes.** Position and UV need float precision; normals,
 *    tints, tile selectors and sway weights do not. 60 bytes/vertex -> 30.
 *  - **Lazy near tier.** The far tier is tiny (~325 tri/tree) and stays
 *    resident for the whole map. The expensive near tier (~2800 tri/tree) is
 *    built only for chunks the player is actually close to, and evicted by LRU
 *    against a vertex budget. Placement is decided once at boot and stored, so
 *    a rebuild is a pure transform pass with no re-randomisation — a chunk
 *    always comes back byte-identical.
 *
 * ### 3. Distribution
 *
 * Independent uniform sampling looks like TV static, not like woodland. Real
 * stands are clustered: a parent seeds, offspring grow in its shade radius, and
 * the gaps between stands are what read as "clearing". So placement is
 * two-stage — stand seeds from the zone's clusterRate, then members inside a
 * radius — and gated by a two-octave density *product* so whole regions can
 * come out genuinely empty.
 *
 * ## What this file owns
 *
 * - occupancy field (canopy cover), consumed by lighting, audio and the AI
 * - trunk colliders, handed to CollisionWorld by MapGenerator
 * - two-tier chunk LOD with hysteresis and an amortised build budget
 * - the ground-detail layer (ferns, litter, reeds) as merged cards
 */

import * as THREE from 'three';
import { SeededRandom } from '../core/SeededRandom';
import { HeightField } from './HeightField';
import { ForestAtlas, ATLAS_ATTRIBUTE, TILE } from './ForestAtlas';
import { TreeCache, variantCount, type RawGeo, type TreeTemplate } from './TreeFactory';
import { ZoneSystem, ZONE_PROFILES, ZONE_IDS, type ArchetypeId } from './ZoneSystem';
import { patchForestWind } from './VegetationSystem';

/** Chunk edge in metres. 60 divides the 420 m world into 7x7. */
const CHUNK = 60;
/** Inside this radius a chunk uses LOD0 geometry. */
const NEAR_RANGE = 78;
/** Dead band so a chunk sitting on the boundary does not rebuild every frame. */
const LOD_HYST = 12;
/**
 * How far ahead of the player, in seconds of travel, the near-tier request
 * centre is biased.
 *
 * Chosen against the two costs it sits between: a merge takes at least one
 * frame to service (BUILDS_PER_FRAME=2) and may need an eviction first, so the
 * lead must cover a few frames of walking; but every metre of lead is a metre
 * the trailing edge gives up, and the near range is only ~78 m. At a 4.2 m/s
 * sprint, 1.6 s is ~6.7 m — about a tenth of the near radius, and roughly
 * three chunk-build opportunities of warning.
 */
const PREDICT_SECONDS = 1.6;
/** Stand seeds attempted per chunk before zone clusterRate scales it. */
const SEEDS_PER_CHUNK = 16;
/**
 * Hard ceiling on trees per chunk.
 *
 * A 60 m chunk is 0.36 ha, so 170 trees is ~470/ha — the low end of real closed
 * canopy forest, and roughly 3x what the first pass produced. Density this high
 * is only affordable because the near tier is lazy.
 */
const MAX_TREES_PER_CHUNK = 170;
/** Nothing plants within this distance of the trail centreline. */
const TRAIL_CLEAR = 2.9;
/**
 * Resident vertex budget for near-tier chunks (~30 B/vert, so ~30 MB).
 * Exceeding it evicts the least recently visible chunk.
 */
const NEAR_VERT_BUDGET = 1_000_000;
/**
 * Trees shorter than this are omitted from the far tier.
 *
 * Measured: understory scrub is 2880 tri at LOD0 and 435 at LOD2, and at 80 m a
 * 2 m bush is a couple of pixels of noise. Carrying it in the always-resident
 * far tier cost ~40 % of that tier's memory and bought nothing but aliasing.
 * Canopy is what reads at distance — that is what silhouettes are made of.
 */
const FAR_MIN_HEIGHT = 5.5;
/** Near-tier chunk merges allowed per frame, to amortise the hitch. */
const BUILDS_PER_FRAME = 2;

/**
 * Vertex-colour headroom.
 *
 * Tints occasionally exceed 1.0 (a healthy young conifer's leaf tint is 1.05,
 * and condition tints multiply on top). Storing colour as unsigned bytes means
 * 0..1, so the buffer holds `colour / COLOR_SCALE` and the material carries
 * `COLOR_SCALE` in its base colour to put it back. 8 bits over 0..1.5 is a
 * 0.6 % step — invisible, and it costs no shader work.
 */
const COLOR_SCALE = 1.5;

// ============================================================================
// merge target
// ============================================================================

/**
 * Accumulates transformed copies of template geometry into one packed buffer.
 *
 * Presized, not grown: the caller knows every template it is about to append,
 * so vertex and index totals are exact up front. The first implementation used
 * `Array.push` and spent 40 ms per chunk-tier in allocator churn; writing
 * straight into typed arrays removed effectively all of it.
 */
class MergeTarget {
  private pos: Float32Array;
  private uv: Float32Array;
  private nrm: Int8Array;
  private col: Uint8Array;
  private tile: Uint8Array;
  private sway: Uint8Array;
  private idx: Uint32Array;
  private v = 0;
  private i = 0;

  constructor(verts: number, indices: number) {
    this.pos = new Float32Array(verts * 3);
    this.uv = new Float32Array(verts * 2);
    this.nrm = new Int8Array(verts * 3);
    this.col = new Uint8Array(verts * 3);
    this.tile = new Uint8Array(verts * 3);
    this.sway = new Uint8Array(verts);
    this.idx = new Uint32Array(indices);
  }

  get triangles(): number { return this.i / 3; }
  get vertices(): number { return this.v; }
  get empty(): boolean { return this.i === 0; }

  /**
   * Append one instance.
   *
   * `swayRef` is the height over which the sway weight ramps 0 -> 1. It must be
   * the *tree's own* height, not a world coordinate: after merging, a vertex's
   * `position.y` is absolute elevation, so deriving wind from it would make
   * ridge trees whip while hollow trees stood still. The weight is baked here
   * and read back by `patchForestWind`.
   */
  add(
    g: RawGeo,
    x: number, y: number, z: number,
    yaw: number, scl: number, leanX: number, leanZ: number,
    tintR: number, tintG: number, tintB: number,
    swayBase: number, swayTop: number, swayRef: number,
  ): void {
    const base = this.v;
    const n = g.position.length / 3;

    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cx = Math.cos(leanX), sx = Math.sin(leanX);
    const cz = Math.cos(leanZ), sz = Math.sin(leanZ);

    // R = Rz(leanZ) * Rx(leanX) * Ry(yaw). Lean is applied outside yaw so that
    // rotating a leaning tree about its own axis does not change which way it
    // leans — otherwise the lean would read as a placement artefact.
    const m00 = cz * cy + sz * sx * sy, m01 = -sz * cx, m02 = -cz * sy + sz * sx * cy;
    const m10 = sz * cy - cz * sx * sy, m11 = cz * cx, m12 = -sz * sy - cz * sx * cy;
    const m20 = cx * sy, m21 = -sx, m22 = cx * cy;

    const invRef = swayRef > 0 ? 1 / swayRef : 0;
    const cr = (tintR / COLOR_SCALE) * 255, cg = (tintG / COLOR_SCALE) * 255;
    const cb = (tintB / COLOR_SCALE) * 255;

    for (let k = 0; k < n; k++) {
      const k3 = k * 3;
      const lx = g.position[k3] * scl;
      const ly = g.position[k3 + 1] * scl;
      const lz = g.position[k3 + 2] * scl;

      const o3 = (base + k) * 3;
      this.pos[o3] = x + m00 * lx + m01 * ly + m02 * lz;
      this.pos[o3 + 1] = y + m10 * lx + m11 * ly + m12 * lz;
      this.pos[o3 + 2] = z + m20 * lx + m21 * ly + m22 * lz;

      // Uniform scale, so the rotation part stays orthonormal and the inverse
      // transpose collapses back to R — no renormalise needed.
      const nx = g.normal[k3], ny = g.normal[k3 + 1], nz = g.normal[k3 + 2];
      this.nrm[o3] = Math.max(-127, Math.min(127, (m00 * nx + m01 * ny + m02 * nz) * 127));
      this.nrm[o3 + 1] = Math.max(-127, Math.min(127, (m10 * nx + m11 * ny + m12 * nz) * 127));
      this.nrm[o3 + 2] = Math.max(-127, Math.min(127, (m20 * nx + m21 * ny + m22 * nz) * 127));

      const o2 = (base + k) * 2;
      this.uv[o2] = g.uv[k * 2];
      this.uv[o2 + 1] = g.uv[k * 2 + 1];

      this.col[o3] = Math.min(255, g.color[k3] * cr);
      this.col[o3 + 1] = Math.min(255, g.color[k3 + 1] * cg);
      this.col[o3 + 2] = Math.min(255, g.color[k3 + 2] * cb);

      // Not normalised: the shader wants the literal tile index and repeat
      // counts, all small integers.
      this.tile[o3] = g.tile[k3];
      this.tile[o3 + 1] = Math.min(255, g.tile[k3 + 1]);
      this.tile[o3 + 2] = Math.min(255, g.tile[k3 + 2]);

      const t = Math.min(1, Math.max(0, ly * invRef));
      this.sway[base + k] = (swayBase + (swayTop - swayBase) * t) * 255;
    }
    this.v += n;

    for (let k = 0; k < g.index.length; k++) this.idx[this.i + k] = g.index[k] + base;
    this.i += g.index.length;
  }

  finish(): THREE.BufferGeometry | null {
    if (this.i === 0) return null;
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    bg.setAttribute('uv', new THREE.BufferAttribute(this.uv, 2));
    bg.setAttribute('normal', new THREE.BufferAttribute(this.nrm, 3, true));
    bg.setAttribute('color', new THREE.BufferAttribute(this.col, 3, true));
    bg.setAttribute(ATLAS_ATTRIBUTE, new THREE.BufferAttribute(this.tile, 3, false));
    bg.setAttribute('aSway', new THREE.BufferAttribute(this.sway, 1, true));
    // Uint32 unconditionally: a merged chunk crosses 65k verts routinely and a
    // silently-wrapping Uint16 index is the worst class of bug to chase.
    bg.setIndex(new THREE.BufferAttribute(this.idx, 1));
    bg.computeBoundingSphere();
    return bg;
  }
}

// ============================================================================
// types
// ============================================================================

/**
 * A decided tree, kept so a near-tier rebuild is a pure transform pass.
 *
 * Holding template *references* rather than keys avoids a map lookup per tree
 * per rebuild; the templates are immutable and shared out of the cache.
 */
interface Placement {
  near: TreeTemplate;
  far: TreeTemplate;
  x: number; y: number; z: number;
  yaw: number; scl: number;
  leanX: number; leanZ: number;
  tr: number; tg: number; tb: number;
  h: number;
}

/** A ground-detail card, decided once and re-merged on demand. */
/** Ground-cover families, kept as a closed union so a census cannot silently
 *  invent a category (or miss one) when a new card type is added. */
type FloorFamily = 'reed' | 'fern' | 'leafDry' | 'leafBroad';

interface FloorItem {
  geo: RawGeo;
  x: number; y: number; z: number;
  yaw: number; leanX: number; leanZ: number;
  tr: number; tg: number; tb: number;
  h: number;
  /**
   * Which ground-cover family this card belongs to.
   *
   * Stored rather than re-derived from `geo`, because the tile atlas is shared:
   * reeds and ferns both draw from TILE.fern and differ only in their aspect
   * ratio, so the geometry alone cannot answer "what is this". `detailCensus()`
   * reads this to prove the floor is a mix of distinct things and not one asset
   * repeated forty thousand times.
   */
  family: FloorFamily;
}

interface Chunk {
  cx: number; cz: number;
  placements: Placement[];
  floorItems: FloorItem[];
  /** always resident */
  farBark: THREE.Mesh | null;
  farFoliage: THREE.Mesh | null;
  /** built on demand, evictable */
  nearBark: THREE.Mesh | null;
  nearFoliage: THREE.Mesh | null;
  floor: THREE.Mesh | null;
  /** 0 = near tier wanted, 1 = far tier, -1 = culled */
  tier: number;
  /** monotonic tick when this chunk last wanted its near tier */
  lastUsed: number;
  nearVerts: number;
  triNear: number;
  triFar: number;
}

export interface TrunkCollider { x: number; z: number; r: number; h: number; }

export interface TreeRecord {
  x: number; z: number;
  /** collision radius at breast height */
  r: number;
  h: number;
  /** horizontal crown reach — drives the occupancy stamp */
  crown: number;
  archetype: ArchetypeId;
}

export interface ScatterStats {
  trees: number;
  chunks: number;
  templates: number;
  templateBytes: number;
  trianglesNear: number;
  trianglesFar: number;
  /** near-tier chunks currently merged and resident */
  residentNear: number;
  residentVerts: number;
  /** near-tier chunks still waiting to be merged */
  pending: number;
}

export interface ScatterOpts {
  /** >0 shrinks the LOD0 radius (mobile), <0 grows it */
  lodBias?: number;
  /** ground-card attempt multiplier, 0 disables the detail layer */
  floorDetail?: number;
  /** scales MAX_TREES_PER_CHUNK, for low-end tiers */
  densityScale?: number;
}

// ============================================================================
// ScatterSystem
// ============================================================================

export class ScatterSystem {
  readonly group = new THREE.Group();
  readonly trees: TreeRecord[] = [];
  readonly stats: ScatterStats = {
    trees: 0, chunks: 0, templates: 0, templateBytes: 0,
    trianglesNear: 0, trianglesFar: 0,
    residentNear: 0, residentVerts: 0, pending: 0,
  };

  private chunks: Chunk[] = [];
  private cache: TreeCache;
  private rng: SeededRandom;
  private nChunks: number;
  private half: number;
  private barkMat: THREE.MeshStandardMaterial;
  private foliageMat: THREE.MeshStandardMaterial;

  /** canopy occupancy, 4 m cells — cheap proxy for "how enclosed is it here" */
  private occ: Float32Array;
  private occRes: number;
  private occStep = 4;

  private nearRange: number;
  private floorDetail: number;
  private maxTrees: number;
  private residentVerts = 0;
  private tick = 0;
  /** Viewer velocity in m/s, fed by the game loop; drives predictive prefetch. */
  private velX = 0;
  private velZ = 0;
  /** Amortised merges per frame — governed, not constant. */
  private buildsPerFrame = BUILDS_PER_FRAME;
  private scratchW = new Float32Array(ZONE_IDS.length);

  /**
   * Field-sampling RNGs, kept separate from the placement streams.
   *
   * `SeededRandom.noise2` hashes against the generator's *current* state, and
   * `next()` mutates it. Sampling a noise field from a stream that is also
   * being drawn from therefore makes the field drift as placement proceeds —
   * the same coordinate returns different density depending on when it is
   * asked, so clearings would not agree across a chunk seam. These are never
   * advanced, so they are genuine spatial fields.
   */
  private fieldMacro: SeededRandom;
  private fieldMeso: SeededRandom;
  private fieldPatch: SeededRandom;

  /**
   * World-space spacing hash, 6 m cells.
   *
   * The first implementation rejected against a 24-entry tail of the current
   * chunk's own placements. Measured, that let the 5th-percentile
   * nearest-neighbour distance fall to 0.56 m — interpenetrating trunks, which
   * is the most obvious "generated" tell there is — and it could not see across
   * a chunk seam at all, so every chunk border had a seam of overlapping trees.
   * A shared grid is both exact and cheaper: a query touches 9 cells rather
   * than a fixed 24 candidates.
   */
  private spaceGrid = new Map<number, { x: number; z: number; r: number }[]>();
  private spaceCell = 6;

  constructor(
    private hf: HeightField,
    private zones: ZoneSystem,
    atlas: ForestAtlas,
    seed: number,
    opts: ScatterOpts = {},
  ) {
    this.rng = new SeededRandom(seed ^ 0x5ca77e);
    this.fieldMacro = new SeededRandom(seed ^ 0x1a2b3c);
    this.fieldMeso = new SeededRandom(seed ^ 0x4d5e6f);
    this.fieldPatch = new SeededRandom(seed ^ 0x7081a9);
    this.cache = new TreeCache(seed);
    this.half = hf.layout.size / 2;
    this.nChunks = Math.ceil(hf.layout.size / CHUNK);
    this.occRes = Math.ceil(hf.layout.size / this.occStep) + 1;
    this.occ = new Float32Array(this.occRes * this.occRes);

    this.nearRange = Math.max(34, NEAR_RANGE - (opts.lodBias ?? 0) * 22);
    this.floorDetail = opts.floorDetail ?? 1;
    this.maxTrees = Math.round(MAX_TREES_PER_CHUNK * (opts.densityScale ?? 1));

    this.barkMat = atlas.barkMat;
    this.foliageMat = atlas.foliageMat;
    // Undo the vertex-colour quantisation headroom. See COLOR_SCALE.
    this.barkMat.color.setScalar(COLOR_SCALE);
    this.foliageMat.color.setScalar(COLOR_SCALE);
    // Trunks flex a little, canopy flexes a lot. Two amplitudes, two patch
    // permutations, still two materials.
    patchForestWind(this.barkMat, 0.075);
    patchForestWind(this.foliageMat, 0.42);

    this.build();
  }

  // ── placement predicates ──────────────────────────────────────────────────

  /**
   * Can anything root here at all?
   *
   * Deliberately conservative and cheap: this runs tens of thousands of times
   * during boot. Species-specific suitability is `fitness()`, below.
   */
  private plantable(x: number, z: number): boolean {
    if (Math.abs(x) > this.half - 4 || Math.abs(z) > this.half - 4) return false;
    if (this.hf.inLake(x, z)) return false;
    if (this.hf.trailDist(x, z) < TRAIL_CLEAR) return false;
    if (this.zones.excluded(x, z, 1.5)) return false;
    return true;
  }

  private occIndex(x: number, z: number): number {
    const i = Math.round((x + this.half) / this.occStep);
    const j = Math.round((z + this.half) / this.occStep);
    if (i < 0 || j < 0 || i >= this.occRes || j >= this.occRes) return -1;
    return j * this.occRes + i;
  }

  private occAt(x: number, z: number): number {
    const k = this.occIndex(x, z);
    return k < 0 ? 0 : this.occ[k];
  }

  /** Splat a tree's crown into the occupancy field with a linear falloff. */
  private occStamp(x: number, z: number, radius: number, weight: number): void {
    const cells = Math.max(1, Math.ceil(radius / this.occStep));
    const ci = Math.round((x + this.half) / this.occStep);
    const cj = Math.round((z + this.half) / this.occStep);
    for (let j = cj - cells; j <= cj + cells; j++) {
      if (j < 0 || j >= this.occRes) continue;
      for (let i = ci - cells; i <= ci + cells; i++) {
        if (i < 0 || i >= this.occRes) continue;
        const dx = (i - ci) * this.occStep, dz = (j - cj) * this.occStep;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > radius) continue;
        this.occ[j * this.occRes + i] += weight * (1 - d / radius);
      }
    }
  }

  /**
   * Slope tolerance per archetype, in heightfield gradient units.
   *
   * This is the single most legible ecology rule in the system: a 30 m mature
   * conifer on a 40-degree bank looks wrong even to someone who has never
   * thought about trees, whereas alder and understory scrub on the same bank
   * look correct. Enforcing it is most of what makes terrain read as terrain
   * rather than as a surface things were sprinkled on.
   */
  private maxSlope(a: ArchetypeId): number {
    switch (a) {
      case 'matureConifer': return 0.55;
      case 'hardwood':      return 0.75;
      case 'snag':          return 1.05;
      case 'stormBroken':   return 1.30;
      case 'youngConifer':  return 1.55;
      case 'alder':         return 2.00;
      case 'understory':    return 3.00;
    }
  }

  /**
   * Species suitability at a point, as a multiplier on acceptance probability.
   *
   * Returning a weight rather than a boolean keeps transitions soft: alder
   * thins out as ground dries instead of stopping on a line, which is what
   * makes the marsh edge look grown rather than drawn.
   */
  private fitness(a: ArchetypeId, x: number, z: number, moisture: number): number {
    const cover = this.occAt(x, z);
    switch (a) {
      case 'alder':          return 0.06 + moisture * 1.9;
      case 'matureConifer':  return 1.25 - moisture * 0.55;
      case 'understory':     return cover > 0 ? 1.35 : 0.55;
      case 'youngConifer':   return cover > 3.5 ? 0.35 : 1.2;
      case 'snag':           return 0.8 + moisture * 0.3;
      case 'stormBroken':    return 0.9;
      case 'hardwood':       return 1.0 + moisture * 0.2;
    }
  }

  /**
   * Would a trunk of radius `r` at (x,z) overlap anything already placed?
   *
   * The 1.55 factor is deliberate slack over touching: real trunks of this size
   * do not grow rubbing against each other, and leaving air between them is
   * what lets a flashlight beam pick out individual trees instead of a wall.
   */
  private spaceClash(x: number, z: number, r: number): boolean {
    const s = this.spaceCell;
    const ci = Math.floor(x / s), cj = Math.floor(z / s);
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        const bucket = this.spaceGrid.get(i * 73856093 ^ j * 19349663);
        if (!bucket) continue;
        for (const p of bucket) {
          const dx = p.x - x, dz = p.z - z;
          const min = (p.r + r) * 1.55;
          if (dx * dx + dz * dz < min * min) return true;
        }
      }
    }
    return false;
  }

  private spaceInsert(x: number, z: number, r: number): void {
    const s = this.spaceCell;
    const key = Math.floor(x / s) * 73856093 ^ Math.floor(z / s) * 19349663;
    let bucket = this.spaceGrid.get(key);
    if (!bucket) { bucket = []; this.spaceGrid.set(key, bucket); }
    bucket.push({ x, z, r });
  }

  /** Blend a [min,max] tuple field across the zone weights at a point. */
  private blendRange(
    x: number, z: number, key: 'clusterRadius' | 'clusterSize' | 'scale',
  ): [number, number] {
    const w = this.scratchW;
    this.zones.weightsAt(x, z, w);
    let lo = 0, hi = 0;
    for (let i = 0; i < ZONE_IDS.length; i++) {
      const wi = w[i];
      if (wi <= 0) continue;
      const t = ZONE_PROFILES[ZONE_IDS[i]][key];
      lo += t[0] * wi; hi += t[1] * wi;
    }
    return [lo, hi];
  }

  // ── build ─────────────────────────────────────────────────────────────────

  private build(): void {
    for (let cj = 0; cj < this.nChunks; cj++) {
      for (let ci = 0; ci < this.nChunks; ci++) {
        const c = this.planChunk(ci, cj);
        if (c) this.chunks.push(c);
      }
    }
    // Far tier second, so occupancy is fully stamped before anything is merged
    // and the two passes cannot see a half-built field.
    for (const c of this.chunks) this.buildFar(c);

    this.stats.chunks = this.chunks.length;
    this.stats.trees = this.trees.length;
    this.stats.templates = this.cache.size;
    this.stats.templateBytes = this.cache.bytes();
  }

  /**
   * Decide what grows in a chunk. No geometry is merged here.
   *
   * Two-stage placement. Stand seeds first, then members inside each stand's
   * radius. The seed itself is gated by a *product* of two noise octaves at
   * very different scales: the low octave decides "is this a wooded region",
   * the high one breaks up its interior. A product rather than a sum because a
   * sum never reaches zero, and a forest with no genuinely empty ground has no
   * clearings, no sightlines and therefore no composition.
   */
  private planChunk(ci: number, cj: number): Chunk | null {
    const ox = -this.half + ci * CHUNK;
    const oz = -this.half + cj * CHUNK;
    const cx = ox + CHUNK / 2;
    const cz = oz + CHUNK / 2;

    const crng = this.rng.fork((cj * 131 + ci) * 7919 + 13);
    const placements: Placement[] = [];

    const zoneDensity = this.zones.scalarAt(cx, cz, 'density');
    const clusterRate = this.zones.scalarAt(cx, cz, 'clusterRate');
    const seeds = Math.max(1, Math.round(SEEDS_PER_CHUNK * clusterRate));

    for (let s = 0; s < seeds && placements.length < this.maxTrees; s++) {
      const sx = ox + crng.next() * CHUNK;
      const sz = oz + crng.next() * CHUNK;

      const macro = 0.5 + 0.5 * this.fieldMacro.fbm2(sx * 0.011, sz * 0.011, 3);
      const meso = 0.5 + 0.5 * this.fieldMeso.fbm2(sx * 0.037, sz * 0.037, 2);
      const density = macro * meso * zoneDensity;
      // Emergent clearing: not authored, not a circle, and different every
      // world. This is where the eye gets somewhere to rest and where a distant
      // silhouette becomes readable.
      if (density < 0.12) continue;

      const [rMin, rMax] = this.blendRange(sx, sz, 'clusterRadius');
      const radius = rMin + crng.next() * (rMax - rMin);
      const [nMin, nMax] = this.blendRange(sx, sz, 'clusterSize');
      // Stand size scales with density *relative to the field's own median*
      // (~0.21), not with the raw value. Multiplying by the raw density applied
      // the field twice — once as the gate above, once here — and collapsed
      // old-growth stands to under one member each, which is why the first
      // pass produced a sparse map no matter how high the caps went. Clamped
      // so a dense patch enriches a stand without exploding it.
      const boost = Math.min(2.2, Math.max(0.45, density / 0.21));
      const members = Math.max(1, Math.round((nMin + crng.next() * (nMax - nMin)) * boost));

      for (let m = 0; m < members && placements.length < this.maxTrees; m++) {
        // sqrt-biased radius so members fill the disc evenly instead of piling
        // at the centre; the 0.62 exponent biases slightly inward, which is how
        // real stands read — denser core, ragged edge.
        const ang = crng.next() * Math.PI * 2;
        const rad = Math.pow(crng.next(), 0.62) * radius;
        const x = sx + Math.cos(ang) * rad;
        const z = sz + Math.sin(ang) * rad;

        if (!this.plantable(x, z)) continue;

        const slope = this.zones.slopeAt(x, z);
        const moisture = this.zones.moistureAt(x, z);
        const arche = this.zones.pickArchetype(x, z, crng);
        if (slope > this.maxSlope(arche)) continue;
        if (crng.next() > Math.min(1, this.fitness(arche, x, z, moisture))) continue;

        const cond = this.zones.pickCondition(x, z, crng);
        const variant = crng.int(0, variantCount(arche) - 1);
        const near = this.cache.get(arche, variant, cond, 0);

        const [sMin, sMax] = this.blendRange(x, z, 'scale');
        const scl = sMin + crng.next() * (sMax - sMin);
        const rCollide = near.collideRadius * scl;

        if (this.spaceClash(x, z, rCollide)) continue;

        const y = this.hf.heightAt(x, z) - 0.25 * scl;
        const yaw = crng.next() * Math.PI * 2;
        // Lean magnitude tracks slope: trees on banks lean because they grew
        // toward light and away from a creeping root plate.
        const leanMag = Math.min(0.16, 0.02 + slope * 0.05) * (arche === 'snag' ? 2.1 : 1);
        const leanDir = crng.next() * Math.PI * 2;

        placements.push({
          near, far: this.cache.get(arche, variant, cond, 2),
          x, y, z, yaw, scl,
          leanX: Math.cos(leanDir) * leanMag,
          leanZ: Math.sin(leanDir) * leanMag,
          // Per-instance tint jitter, small on purpose. Large hue spread reads
          // as a hue slider, not as individuals; the real separation comes from
          // geometry and from which atlas tile the verts point at.
          tr: 0.9 + crng.next() * 0.2,
          tg: 0.92 + crng.next() * 0.16,
          tb: 0.9 + crng.next() * 0.2,
          h: near.height * scl,
        });

        this.spaceInsert(x, z, rCollide);
        this.trees.push({
          x, z, r: rCollide, h: near.height * scl,
          crown: near.crownRadius * scl, archetype: arche,
        });

        // Only canopy species contribute cover. A fern does not darken a floor.
        if (arche === 'matureConifer' || arche === 'hardwood' || arche === 'alder') {
          this.occStamp(x, z, near.crownRadius * scl, 1.35 * scl);
        } else if (arche === 'youngConifer') {
          this.occStamp(x, z, near.crownRadius * scl, 0.55 * scl);
        }
      }
    }

    const floorItems = this.planFloor(ox, oz, crng);
    if (placements.length === 0 && floorItems.length === 0) return null;

    return {
      cx, cz, placements, floorItems,
      farBark: null, farFoliage: null,
      nearBark: null, nearFoliage: null, floor: null,
      tier: -1, lastUsed: 0, nearVerts: 0, triNear: 0, triFar: 0,
    };
  }

  // ── mesh construction ─────────────────────────────────────────────────────

  private mkMesh(
    geo: THREE.BufferGeometry | null, mat: THREE.Material, cast: boolean,
  ): THREE.Mesh | null {
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    // Chunks are static and their bounds exact, so three's frustum cull is
    // accurate and free.
    m.frustumCulled = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.visible = false;
    this.group.add(m);
    return m;
  }

  /** Size a merge target exactly, then fill it. */
  private mergeTier(ps: Placement[], lod: 'near' | 'far'): {
    bark: THREE.BufferGeometry | null; foliage: THREE.BufferGeometry | null;
    tris: number; verts: number;
  } {
    const far = lod === 'far';
    let bv = 0, bi = 0, fv = 0, fi = 0;
    for (const p of ps) {
      if (far && p.h < FAR_MIN_HEIGHT) continue;
      const t = far ? p.far : p.near;
      bv += t.bark.position.length / 3; bi += t.bark.index.length;
      if (t.foliage) { fv += t.foliage.position.length / 3; fi += t.foliage.index.length; }
    }
    const bark = new MergeTarget(bv, bi);
    const fol = new MergeTarget(fv, fi);
    // Canopy sways much harder than trunk, and the far tier a little less than
    // the near so distant crowns do not shimmer against a coarse silhouette.
    const trunkTop = lod === 'near' ? 0.55 : 0.4;
    const folBase = lod === 'near' ? 0.25 : 0.2;
    const folTop = lod === 'near' ? 1 : 0.85;
    for (const p of ps) {
      if (far && p.h < FAR_MIN_HEIGHT) continue;
      const t = far ? p.far : p.near;
      bark.add(t.bark, p.x, p.y, p.z, p.yaw, p.scl, p.leanX, p.leanZ,
        p.tr, p.tg, p.tb, 0, trunkTop, p.h);
      if (t.foliage) {
        fol.add(t.foliage, p.x, p.y, p.z, p.yaw, p.scl, p.leanX, p.leanZ,
          p.tr, p.tg, p.tb, folBase, folTop, p.h);
      }
    }
    return {
      bark: bark.finish(), foliage: fol.finish(),
      tris: bark.triangles + fol.triangles,
      verts: bark.vertices + fol.vertices,
    };
  }

  private buildFar(c: Chunk): void {
    if (c.placements.length === 0) return;
    const r = this.mergeTier(c.placements, 'far');
    // Far tier does not cast: it exists behind the shadow cascade's useful
    // range, and coarse silhouettes in the shadow map produce visible blocky
    // shadow edges on nearby ground.
    c.farBark = this.mkMesh(r.bark, this.barkMat, false);
    c.farFoliage = this.mkMesh(r.foliage, this.foliageMat, false);
    c.triFar = r.tris;
  }

  private buildNear(c: Chunk): void {
    if (c.nearBark || c.placements.length === 0) return;
    const r = this.mergeTier(c.placements, 'near');
    c.nearBark = this.mkMesh(r.bark, this.barkMat, true);
    c.nearFoliage = this.mkMesh(r.foliage, this.foliageMat, true);
    c.triNear = r.tris;
    c.nearVerts = r.verts;
    this.residentVerts += r.verts;
    this.buildFloorMesh(c);
  }

  private freeNear(c: Chunk): void {
    for (const m of [c.nearBark, c.nearFoliage, c.floor]) {
      if (!m) continue;
      m.geometry.dispose();
      this.group.remove(m);
    }
    c.nearBark = null; c.nearFoliage = null; c.floor = null;
    this.residentVerts -= c.nearVerts;
    c.nearVerts = 0;
    c.triNear = 0;
  }

  // ── ground detail layer ───────────────────────────────────────────────────

  /**
   * A crossed pair of bowed cards.
   *
   * Bowed, not flat: a flat card is invisible edge-on and pops as it rotates
   * past the camera, and a cross of two flat cards has a hard X seam under a
   * flashlight. Three spans of curvature is enough to catch a gradient across
   * the leaf and kill both tells.
   */
  private cardGeo(tile: number, w: number, h: number, bow: number): RawGeo {
    const cols = 3, rows = 3;
    const verts = (cols + 1) * (rows + 1) * 2;
    const position = new Float32Array(verts * 3);
    const normal = new Float32Array(verts * 3);
    const uv = new Float32Array(verts * 2);
    const color = new Float32Array(verts * 3);
    const tileA = new Float32Array(verts * 3);
    const tris: number[] = [];

    let v = 0;
    for (let plane = 0; plane < 2; plane++) {
      const ca = plane === 0 ? 1 : 0, sa = plane === 0 ? 0 : 1;
      const start = v;
      for (let r = 0; r <= rows; r++) {
        const fy = r / rows;
        for (let c = 0; c <= cols; c++) {
          const fx = c / cols - 0.5;
          // Bow away from the axis, strongest at the tip.
          const off = bow * fy * fy;
          position[v * 3] = ca * fx * w + sa * off;
          position[v * 3 + 1] = fy * h;
          position[v * 3 + 2] = sa * fx * w + ca * off;
          // Normals tilted upward: ground foliage is lit mostly from above, and
          // a purely horizontal normal makes litter go black under a downward
          // flashlight cone.
          normal[v * 3] = sa * 0.5;
          normal[v * 3 + 1] = 0.8;
          normal[v * 3 + 2] = ca * 0.5;
          uv[v * 2] = fx + 0.5;
          uv[v * 2 + 1] = fy;
          // Darken toward the root — cheap contact occlusion, and it stops
          // cards from looking like they hover.
          const shade = 0.45 + 0.55 * fy;
          color[v * 3] = shade; color[v * 3 + 1] = shade; color[v * 3 + 2] = shade;
          tileA[v * 3] = tile; tileA[v * 3 + 1] = 1; tileA[v * 3 + 2] = 1;
          v++;
        }
      }
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const a = start + r * (cols + 1) + c;
          const b = a + 1, d = a + (cols + 1), e = d + 1;
          tris.push(a, d, b, b, d, e);
        }
      }
    }
    return { position, normal, uv, color, tile: tileA, index: new Uint32Array(tris) };
  }

  /**
   * Ground detail: ferns, litter, reeds, broadleaf scrub.
   *
   * Driven by the zone's own density scalars, so the floor changes character
   * with the forest above it rather than being one texture everywhere. This is
   * the layer that stops the ground reading as sterile.
   */
  private planFloor(ox: number, oz: number, crng: SeededRandom): FloorItem[] {
    if (this.floorDetail <= 0) return [];
    const out: FloorItem[] = [];
    const attempts = Math.round(340 * this.floorDetail);

    for (let i = 0; i < attempts; i++) {
      const x = ox + crng.next() * CHUNK;
      const z = oz + crng.next() * CHUNK;
      if (!this.plantable(x, z)) continue;

      const fern = this.zones.scalarAt(x, z, 'fernDensity');
      const litter = this.zones.scalarAt(x, z, 'litterDensity');
      const reed = this.zones.scalarAt(x, z, 'reedDensity');
      const total = fern + litter + reed;
      if (total <= 0.01) continue;
      // Coverage gate multiplied by a noise field, so density itself varies
      // within a zone — uniform ground cover is as much a tell as uniform trees.
      const patch = 0.5 + 0.5 * this.fieldPatch.fbm2(x * 0.09, z * 0.09, 2);
      if (crng.next() > Math.min(0.95, total * 0.62 * patch)) continue;

      const roll = crng.next() * total;
      let tile: number, w: number, h: number, bow: number;
      let family: FloorFamily;
      if (roll < reed) {
        // Tall and narrow: reads as a reed even though it shares the fern tile.
        tile = TILE.fern; w = 0.5; h = 1.15 + crng.next() * 0.7; bow = 0.28;
        family = 'reed';
      } else if (roll < reed + fern) {
        tile = TILE.fern; w = 1.15 + crng.next() * 0.6; h = 0.5 + crng.next() * 0.45; bow = 0.18;
        family = 'fern';
      } else {
        const dry = crng.next() < 0.45;
        tile = dry ? TILE.leafDry : TILE.leafBroad;
        w = 0.75 + crng.next() * 0.55; h = 0.22 + crng.next() * 0.28; bow = 0.1;
        family = dry ? 'leafDry' : 'leafBroad';
      }

      const tint = 0.78 + crng.next() * 0.34;
      out.push({
        geo: this.cardGeo(tile, w, h, bow),
        x, y: this.hf.heightAt(x, z) - 0.04, z,
        yaw: crng.next() * Math.PI * 2,
        // Ground cards lean with the slope so they sit on the surface instead
        // of standing plumb out of a bank.
        leanX: crng.range(-0.22, 0.22),
        leanZ: crng.range(-0.18, 0.18),
        tr: tint * 0.95, tg: tint, tb: tint * 0.9,
        h,
        family,
      });
    }
    return out;
  }

  private buildFloorMesh(c: Chunk): void {
    if (c.floor || c.floorItems.length === 0) return;
    let v = 0, i = 0;
    for (const f of c.floorItems) { v += f.geo.position.length / 3; i += f.geo.index.length; }
    const t = new MergeTarget(v, i);
    for (const f of c.floorItems) {
      t.add(f.geo, f.x, f.y, f.z, f.yaw, 1, f.leanX, f.leanZ,
        f.tr, f.tg, f.tb, 0.55, 1, f.h);
    }
    // Ground cards do not cast: hundreds of thin alpha-tested slivers in the
    // shadow map buy nothing and cost a lot of fill.
    c.floor = this.mkMesh(t.finish(), this.foliageMat, false);
    c.nearVerts += t.vertices;
    this.residentVerts += t.vertices;
  }

  // ── runtime ───────────────────────────────────────────────────────────────

  /**
   * Choose a LOD tier per chunk, then service the near-tier build queue.
   *
   * Hysteresis is applied against the tier the chunk is *currently* in, so a
   * chunk hovering at the boundary keeps whatever it has rather than flipping
   * every frame — which would be visible as a detail shimmer across a whole
   * band of forest.
   *
   * Near-tier merges are amortised at BUILDS_PER_FRAME and prioritised by
   * distance, so walking into fresh forest costs a couple of milliseconds a
   * frame instead of a single long stall. Until a chunk's near tier exists its
   * far tier stays visible, so there is never a hole.
   */
  setViewer(camX: number, camZ: number, drawDistance: number): void {
    this.tick++;
    const nearR = this.nearRange;
    let triN = 0, triF = 0, resident = 0, pending = 0;

    // ---- predictive request centre --------------------------------------
    //
    // This used to be the camera position, full stop. The system therefore discovered
    // it needed a chunk at the moment the player was already looking at it, then took
    // at least one frame per merge to produce it — possibly after evicting against the
    // 1M-vertex near budget first. The pop was structural, not a tuning failure.
    //
    // Biasing the centre along the velocity vector asks for chunks *before* they are
    // needed. The lead distance is capped at half a chunk so the trailing edge never
    // falls out of the near tier behind the player, which would trade a pop ahead for a
    // pop behind — and the one behind is worse, because turning around is instant
    // whereas walking forward is not.
    const leadX = this.velX * PREDICT_SECONDS;
    const leadZ = this.velZ * PREDICT_SECONDS;
    const leadLen = Math.hypot(leadX, leadZ);
    const leadScale = leadLen > CHUNK * 0.5 ? (CHUNK * 0.5) / leadLen : 1;
    const wantX = camX + leadX * leadScale;
    const wantZ = camZ + leadZ * leadScale;

    // queue of (distance, chunk) wanting a near tier they do not have
    let want: { d: number; c: Chunk }[] | null = null;

    for (const c of this.chunks) {
      const dx = c.cx - camX, dz = c.cz - camZ;
      const d = Math.sqrt(dx * dx + dz * dz);
      // Distance from the *predicted* centre. Used only to bring chunks in
      // early — never to push one out, hence the min() below. A chunk behind
      // the player keeps its tier on true camera distance, so turning round is
      // still free.
      const pdx = c.cx - wantX, pdz = c.cz - wantZ;
      const dPred = Math.sqrt(pdx * pdx + pdz * pdz);
      const dSel = Math.min(d, dPred);

      let tier: number;
      if (d > drawDistance + CHUNK) {
        tier = -1;
      } else {
        const bound = c.tier === 0 ? nearR + LOD_HYST : nearR - LOD_HYST;
        tier = dSel < bound ? 0 : 1;
      }
      c.tier = tier;
      if (tier === 0) c.lastUsed = this.tick;

      if (tier === 0 && !c.nearBark && c.placements.length > 0) {
        // Queue priority is the predicted distance: what the player is about to
        // walk into outranks what is already beside them, because the chunk
        // beside them is already showing its far tier and reads as forest,
        // whereas the one ahead is the one that will pop.
        (want ??= []).push({ d: dPred, c });
        pending++;
      }

      // A chunk that wants the near tier but has not been merged yet shows its
      // far tier — never nothing.
      const hasNear = !!c.nearBark;
      const showNear = tier === 0 && hasNear;
      const showFar = tier === 1 || (tier === 0 && !hasNear);

      if (c.nearBark) c.nearBark.visible = showNear;
      if (c.nearFoliage) c.nearFoliage.visible = showNear;
      if (c.farBark) c.farBark.visible = showFar;
      if (c.farFoliage) c.farFoliage.visible = showFar;
      // Ground detail is near-only: at 80 m a 30 cm card is subpixel and all it
      // contributes is aliasing.
      if (c.floor) c.floor.visible = showNear;

      if (showNear) { triN += c.triNear; resident++; }
      else if (showFar) triF += c.triFar;
      else if (hasNear) resident++;
    }

    if (want) {
      want.sort((a, b) => a.d - b.d);
      const budget = this.buildsPerFrame;
      for (let i = 0; i < want.length && i < budget; i++) {
        this.evictFor(want[i].c);
        this.buildNear(want[i].c);
      }
    }

    this.stats.trianglesNear = triN;
    this.stats.trianglesFar = triF;
    this.stats.residentNear = resident;
    this.stats.residentVerts = this.residentVerts;
    this.stats.pending = pending;
  }

  /**
   * Report the viewer's horizontal velocity, in m/s.
   *
   * Kept separate from `setViewer` rather than added as parameters because the
   * caller already has the vector and the streaming system is not the only
   * consumer of it — passing it in explicitly keeps the prefetch lead honest
   * (a finite-differenced position would alias badly at variable frame rate,
   * and would make the lead vector jitter with frame time rather than with
   * actual motion).
   */
  setVelocity(vx: number, vz: number): void {
    this.velX = vx;
    this.velZ = vz;
  }

  /**
   * Shift the near/far LOD boundary at runtime.
   *
   * The constructor's `lodBias` was a boot-time-only quality decision, which
   * meant the single largest vegetation cost in the frame — resident near-tier
   * triangle count — was the one thing the adaptive quality layer could not
   * touch. Same mapping as the constructor so a governed bias and a preset bias
   * are interchangeable.
   *
   * Chunks are not rebuilt here; the next `setViewer` re-evaluates tiers
   * against the new range, and the hysteresis band absorbs the transition.
   */
  setLodBias(bias: number): void {
    const next = Math.max(34, NEAR_RANGE - bias * 22);
    if (Math.abs(next - this.nearRange) < 0.5) return;
    this.nearRange = next;
  }

  /**
   * Cap merges per frame.
   *
   * A merge is a synchronous CPU transform pass over a whole chunk, so it is
   * exactly the wrong work to be doing when the frame is already CPU-bound.
   * When the governor attributes a stall to `cpu-sim` it can drop this to 1 (or
   * 0 for a frame) and the forest degrades into showing far tiers slightly
   * longer, which is far cheaper perceptually than a hitch.
   */
  setMergeBudget(n: number): void {
    this.buildsPerFrame = Math.max(0, Math.min(4, Math.round(n)));
  }

  /** Free least-recently-wanted near tiers until the incoming chunk fits. */
  private evictFor(incoming: Chunk): void {
    if (this.residentVerts < NEAR_VERT_BUDGET) return;
    const live = this.chunks
      .filter(c => c.nearBark && c !== incoming && c.tier !== 0)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const c of live) {
      if (this.residentVerts < NEAR_VERT_BUDGET * 0.85) break;
      this.freeNear(c);
    }
  }

  /** Trunk colliders for CollisionWorld. */
  colliders(): TrunkCollider[] {
    const out: TrunkCollider[] = [];
    for (const t of this.trees) {
      // Understory scrub is walk-through: solid bushes make the forest feel
      // like a maze of invisible walls, which reads as cheap.
      if (t.archetype === 'understory') continue;
      out.push({ x: t.x, z: t.z, r: Math.max(0.22, t.r), h: t.h });
    }
    return out;
  }

  /**
   * Canopy cover in 0..1. Shared by the lighting (how much moon gets through),
   * the audio (rain attenuation, reverb) and the AI (where it can hide).
   *
   * One field feeding all three is what makes "standing under old growth"
   * change how the place looks, sounds *and* behaves at the same time.
   */
  coverAt(x: number, z: number): number {
    return Math.min(1, this.occAt(x, z) / 3.2);
  }

  // ── census / instrumentation ───────────────────────────────────────────────
  //
  // These two exist for `tools/forest-census.ts`, which is the measuring
  // instrument for the forest's density requirements. They are on the class
  // rather than in the tool because the tool must not reimplement placement
  // logic — a census that counts differently from what is drawn would let the
  // forest get sparser while the report claimed it had not.

  /**
   * How many placed items are within `r` metres of (x, z).
   *
   * Counts trees *and* ground detail, because the requirement being measured is
   * "would the player see anything here", and a fern answers that as well as a
   * trunk does. Trunks are tested against their own radius so a point standing
   * inside a 1.4 m-radius mature bole counts as occupied rather than as bare
   * ground two metres from a tree.
   *
   * Linear over the tree list, which is fine at this call site: the census runs
   * offline in Node and does ~19 k probes. It is deliberately NOT wired into
   * anything per-frame — the occupancy grid (`occAt`) is what runtime uses.
   */
  countNear(x: number, z: number, r: number): number {
    let n = 0;
    const r2 = r * r;
    for (const t of this.trees) {
      const dx = t.x - x, dz = t.z - z;
      const reach = r + t.r;
      if (dx * dx + dz * dz <= reach * reach) n++;
    }
    for (const c of this.chunks) {
      // Chunk-level reject first: a 60 m chunk whose centre is 90 m away cannot
      // contain anything within a 2 m radius, and skipping it avoids walking
      // tens of thousands of floor items per probe.
      const cdx = c.cx - x, cdz = c.cz - z;
      if (Math.abs(cdx) > CHUNK && Math.abs(cdz) > CHUNK) continue;
      for (const f of c.floorItems) {
        const dx = f.x - x, dz = f.z - z;
        if (dx * dx + dz * dz <= r2) n++;
      }
    }
    return n;
  }

  /**
   * Ground-detail population by family, across the whole map.
   *
   * Reported per family rather than as one total because the brief's ground
   * layer is a list of distinct things (ferns, twigs, stones, mushrooms,
   * deadwood…), and one aggregate number cannot show that a family is missing
   * — which is exactly the failure mode where a floor has 40 k items and still
   * looks like three assets repeated.
   */
  detailCensus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const c of this.chunks) {
      for (const f of c.floorItems) {
        out[f.family] = (out[f.family] ?? 0) + 1;
      }
    }
    return out;
  }

  dispose(): void {
    for (const c of this.chunks) {
      for (const m of [c.nearBark, c.nearFoliage, c.farBark, c.farFoliage, c.floor]) {
        if (!m) continue;
        m.geometry.dispose();
        this.group.remove(m);
      }
    }
    this.chunks.length = 0;
    this.trees.length = 0;
    this.residentVerts = 0;
    this.cache.clear();
  }
}
