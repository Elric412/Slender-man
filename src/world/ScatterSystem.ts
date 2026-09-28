import * as THREE from 'three';
import { SeededRandom } from '../core/SeededRandom';
import { HeightField } from './HeightField';
import { ForestAtlas, ATLAS_ATTRIBUTE, TILE } from './ForestAtlas';
import { TreeCache, variantCount, type RawGeo, type TreeTemplate } from './TreeFactory';
import { ZoneSystem, ZONE_PROFILES, ZONE_IDS, type ArchetypeId } from './ZoneSystem';
import { patchForestWind } from './VegetationSystem';
import {
  makeLog, makeBranch, makeStump, makeRootFlare, makeRootArch, makeRock, makeMossMound,
  makeFungus, makeBarkFleck,
  type PropFamily, type PropSpec,
} from './GroundProps';
import { FloorEcology, RULES, positionRng, type FloorSample } from './FloorEcology';

/**
 * ============================================================================
 * SCATTER SYSTEM — forest placement, two-tier LOD, occupancy field
 * ============================================================================
 *
 * Turns template geometry into an actual forest. This is not just a placement
 * pass: it is an ownership boundary, because placement decisions have
 * side effects that nothing else should duplicate.
 *
 * ### 1. Draw calls vs. variety
 *
 * InstancedMesh is draw-count-per-template, pricing variety out. Instead,
 * every template visible at once is CPU-transformed into a shared buffer,
 * with per-instance yaw, scale, lean and tint. A chunk with 40 different
 * trees is 2 draws (bark + foliage); a field of repeats is impossible.
 * Memory is the cost, and it is paid wisely.
 *
 * ### 2. Memory budget
 *
 * Two fixes, each worth ~3–4×:
 *
 *  - **Quantised attributes.** Positions stay float. Normals, tints, tile
 *    indices and sway weights do not. 60 B/vert → 30 B/vert.
 *  - **Lazy near tier.** The far tier (~325 tri/tree) is always resident.
 *    The near tier (~2800 tri/tree) is built only for chunks the player is
 *    close to, and evicted by LRU against a vertex budget. Because placement
 *    is decided at boot, a rebuild is a pure transform pass with no
 *    re-randomisation.
 *
 * ### 3. Distribution
 *
 * Two-stage placement: stand seeds from the zone's clusterRate, then members
 * inside a radius. Whole regions can come out empty because density is a
 * *product* of a low-octave regional field and a mid-octave breakup field.
 * The eye needs somewhere to rest.
 *
 * ### 4. What this owns
 *
 *  - canopy occupancy field (4 m cells), read by lighting, audio, AI
 *  - trunk colliders
 *  - two-tier LOD with hysteresis and an amortised build budget
 *  - ground detail as merged alpha cards and solid props
 *  - wind patch application
 */

const CHUNK = 60;
const NEAR_RANGE = 78;
const LOD_HYST = 12;
const PREDICT_SECONDS = 1.6;
const SEEDS_PER_CHUNK = 16;
const MAX_TREES_PER_CHUNK = 170;
const TRAIL_CLEAR = 2.9;
const NEAR_VERT_BUDGET = 1_000_000;
const FAR_MIN_HEIGHT = 5.5;
const BUILDS_PER_FRAME = 2;
const COLOR_SCALE = 1.5;

// ============================================================================
// Merge target
// ============================================================================

/**
 * Accumulates transformed template geometry into one packed buffer.
 * Presized: the caller knows the total vertex and index count upfront.
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
   * Append one tree instance.
   *
   * `swayRef` is the tree's own height, not a world coordinate. After merge,
   * `position.y` is absolute elevation; deriving wind from it would make
   * ridge trees whip while hollow trees stood still. The weight is baked here
   * and read back by `patchForestWind`.
   */
  add(
    g: RawGeo, x: number, y: number, z: number, yaw: number, scl: number,
    leanX: number, leanZ: number,
    tintR: number, tintG: number, tintB: number,
    swayBase: number, swayTop: number, swayRef: number,
  ): void {
    const base = this.v;
    const n = g.position.length / 3;
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cx = Math.cos(leanX), sx = Math.sin(leanX);
    const cz = Math.cos(leanZ), sz = Math.sin(leanZ);

    // R = Rz(leanZ) * Rx(leanX) * Ry(yaw). Lean outside yaw so rotating
    // a leaning tree about its axis does not change which way it leans.
    const m00 = cz * cy + sz * sx * sy, m01 = -sz * cx, m02 = -cz * sy + sz * sx * cy;
    const m10 = sz * cy - cz * sx * sy, m11 = cz * cx, m12 = -sz * sy - cz * sx * cy;
    const m20 = cx * sy, m21 = -sx, m22 = cx * cy;

    const invRef = swayRef > 0 ? 1 / swayRef : 0;
    const cr = (tintR / COLOR_SCALE) * 255, cg = (tintG / COLOR_SCALE) * 255;
    const cb = (tintB / COLOR_SCALE) * 255;

    for (let k = 0; k < n; k++) {
      const k3 = k * 3;
      const lx = g.position[k3] * scl, ly = g.position[k3 + 1] * scl, lz = g.position[k3 + 2] * scl;
      const o3 = (base + k) * 3;

      this.pos[o3] = x + m00 * lx + m01 * ly + m02 * lz;
      this.pos[o3 + 1] = y + m10 * lx + m11 * ly + m12 * lz;
      this.pos[o3 + 2] = z + m20 * lx + m21 * ly + m22 * lz;

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
    bg.setIndex(new THREE.BufferAttribute(this.idx, 1));
    bg.computeBoundingSphere();
    return bg;
  }
}

// ============================================================================
// Types
// ============================================================================

interface Placement {
  near: TreeTemplate;
  far: TreeTemplate;
  x: number; y: number; z: number;
  yaw: number;
  scl: number;
  leanX: number; leanZ: number;
  tr: number; tg: number; tb: number;
  h: number;
}

type FloorFamily = 'reed' | 'fern' | 'leafDry' | 'leafBroad' | PropFamily;

interface FloorItem {
  geo: RawGeo;
  x: number; y: number; z: number;
  yaw: number;
  leanX: number; leanZ: number;
  tr: number; tg: number; tb: number;
  h: number;
  solidBatch?: boolean;
  cast?: boolean;
  family: FloorFamily;
}

interface Chunk {
  cx: number; cz: number;
  placements: Placement[];
  floorItems: FloorItem[];
  farBark: THREE.Mesh | null;
  farFoliage: THREE.Mesh | null;
  nearBark: THREE.Mesh | null;
  nearFoliage: THREE.Mesh | null;
  floor: THREE.Mesh | null;
  floorSolid: THREE.Mesh | null;
  tier: number;
  lastUsed: number;
  nearVerts: number;
  triNear: number;
  triFar: number;
}

export interface TrunkCollider {
  x: number; z: number;
  r: number; h: number;
}

export interface TreeRecord {
  x: number; z: number;
  r: number; // collision radius
  h: number;
  crown: number; // crown reach
  archetype: ArchetypeId;
}

export interface ScatterStats {
  trees: number;
  chunks: number;
  templates: number;
  templateBytes: number;
  trianglesNear: number;
  trianglesFar: number;
  residentNear: number;
  residentVerts: number;
  pending: number;
}

export interface ScatterOpts {
  lodBias?: number;
  floorDetail?: number;
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
    trianglesNear: 0, trianglesFar: 0, residentNear: 0, residentVerts: 0, pending: 0,
  };

  private chunks: Chunk[] = [];
  private cache: TreeCache;
  private rng: SeededRandom;
  private nChunks: number;
  private half: number;
  private barkMat: THREE.MeshStandardMaterial;
  private foliageMat: THREE.MeshStandardMaterial;
  private occ: Float32Array;
  private occRes: number;
  private occStep = 4;
  private nearRange: number;
  private floorDetail: number;
  private maxTrees: number;
  private residentVerts = 0;
  private tick = 0;
  private velX = 0;
  private velZ = 0;
  private buildsPerFrame = BUILDS_PER_FRAME;
  private scratchW = new Float32Array(ZONE_IDS.length);

  private fieldMacro: SeededRandom;
  private fieldMeso: SeededRandom;
  private fieldPatch: SeededRandom;
  private eco: FloorEcology;
  private ecoSample: FloorSample = FloorEcology.newSample();
  private propCache = new Map();
  private propColliders: TrunkCollider[] = [];
  private spaceGrid = new Map();
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

    this.barkMat.color.setScalar(COLOR_SCALE);
    this.foliageMat.color.setScalar(COLOR_SCALE);

    patchForestWind(this.barkMat, 0.075);
    patchForestWind(this.foliageMat, 0.42);

    this.eco = new FloorEcology(hf, zones, seed);
    this.build();
  }

  // ── placement predicates ──────────────────────────────────────────────

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

  private maxSlope(a: ArchetypeId): number {
    switch (a) {
      case 'matureConifer': return 0.55;
      case 'hardwood': return 0.75;
      case 'snag': return 1.05;
      case 'stormBroken': return 1.30;
      case 'youngConifer': return 1.55;
      case 'alder': return 2.00;
      case 'understory': return 3.00;
    }
  }

  private fitness(a: ArchetypeId, x: number, z: number, moisture: number): number {
    const cover = this.occAt(x, z);
    switch (a) {
      case 'alder': return 0.06 + moisture * 1.9;
      case 'matureConifer': return 1.25 - moisture * 0.55;
      case 'understory': return cover > 0 ? 1.35 : 0.55;
      case 'youngConifer': return cover > 3.5 ? 0.35 : 1.2;
      case 'snag': return 0.8 + moisture * 0.3;
      case 'stormBroken': return 0.9;
      case 'hardwood': return 1.0 + moisture * 0.2;
    }
  }

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
    if (!bucket) {
      bucket = [];
      this.spaceGrid.set(key, bucket);
    }
    bucket.push({ x, z, r });
  }

  private blendRange(
    x: number, z: number,
    key: 'clusterRadius' | 'clusterSize' | 'scale',
  ): [number, number] {
    const w = this.scratchW;
    this.zones.weightsAt(x, z, w);
    let lo = 0, hi = 0;
    for (let i = 0; i < ZONE_IDS.length; i++) {
      const wi = w[i];
      if (wi <= 0) continue;
      const t = ZONE_PROFILES[ZONE_IDS[i]][key];
      lo += t[0] * wi;
      hi += t[1] * wi;
    }
    return [lo, hi];
  }

  // ── build ──────────────────────────────────────────────────────────────

  private build(): void {
    for (let cj = 0; cj < this.nChunks; cj++) {
      for (let ci = 0; ci < this.nChunks; ci++) {
        const c = this.planChunk(ci, cj);
        if (c) this.chunks.push(c);
      }
    }

    this.eco.indexTrunks(this.trees);
    for (const c of this.chunks) {
      const crng = this.rng.fork((((c.cx * 131 + c.cz) | 0) * 7919 + 977));
      c.floorItems = this.planFloor(c.cx - CHUNK / 2, c.cz - CHUNK / 2, crng);
    }

    for (const c of this.chunks) this.buildFar(c);
    this.stats.chunks = this.chunks.length;
    this.stats.trees = this.trees.length;
    this.stats.templates = this.cache.size;
    this.stats.templateBytes = this.cache.bytes();
  }

  /**
   * Two-stage placement: stand seeds, then members inside radius.
   * Density is a *product* of macro and meso fields, so whole regions are empty.
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

      if (density < 0.12) continue;

      const [rMin, rMax] = this.blendRange(sx, sz, 'clusterRadius');
      const radius = rMin + crng.next() * (rMax - rMin);
      const [nMin, nMax] = this.blendRange(sx, sz, 'clusterSize');
      const boost = Math.min(2.2, Math.max(0.45, density / 0.21));
      const members = Math.max(1, Math.round((nMin + crng.next() * (nMax - nMin)) * boost));

      for (let m = 0; m < members && placements.length < this.maxTrees; m++) {
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
        const leanMag = Math.min(0.16, 0.02 + slope * 0.05) * (arche === 'snag' ? 2.1 : 1);
        const leanDir = crng.next() * Math.PI * 2;

        placements.push({
          near, far: this.cache.get(arche, variant, cond, 2),
          x, y, z, yaw, scl,
          leanX: Math.cos(leanDir) * leanMag,
          leanZ: Math.sin(leanDir) * leanMag,
          tr: 0.9 + crng.next() * 0.2,
          tg: 0.92 + crng.next() * 0.16,
          tb: 0.9 + crng.next() * 0.2,
          h: near.height * scl,
        });

        this.spaceInsert(x, z, rCollide);
        this.trees.push({
          x, z, r: rCollide, h: near.height * scl,
          crown: near.crownRadius * scl,
          archetype: arche,
        });

        if (arche === 'matureConifer' || arche === 'hardwood' || arche === 'alder') {
          this.occStamp(x, z, near.crownRadius * scl, 1.35 * scl);
        } else if (arche === 'youngConifer') {
          this.occStamp(x, z, near.crownRadius * scl, 0.55 * scl);
        }
      }
    }

    return {
      cx, cz, placements, floorItems: [],
      farBark: null, farFoliage: null,
      nearBark: null, nearFoliage: null,
      floor: null, floorSolid: null,
      tier: -1, lastUsed: 0, nearVerts: 0, triNear: 0, triFar: 0,
    };
  }

  /**
   * Plan the ground floor layer (cards + solid props). Deferred to a second
   * pass so every point in the world sees the finished forest, not a
   * half-built field at chunk boundaries.
   */
  private planFloor(ox: number, oz: number, rng: SeededRandom): FloorItem[] {
    const items: FloorItem[] = [];
    const attempts = Math.round(CHUNK * CHUNK * this.floorDetail / 8);

    for (let a = 0; a < attempts; a++) {
      const x = ox + rng.next() * CHUNK;
      const z = oz + rng.next() * CHUNK;

      if (!this.plantable(x, z)) continue;

      const y = this.hf.heightAt(x, z);
      this.eco.sample(x, y, z, this.ecoSample);
      if (!this.eco.isPlantable(this.ecoSample)) continue;

      const family = this.eco.pickFamily(this.ecoSample, rng) as FloorFamily;
      const rule = RULES.find(r => r.family === family);
      if (!rule) continue;

      const moisture = this.hf.moistureAt(x, z);
      const hollow = this.hf.hollowAt(x, z);
      const shade = this.ecoSample.shade;

      let spec: PropSpec | null = null;
      if (family === 'fern') {
        if (moisture > 0.4 || hollow > 0.3) {
          spec = { type: 'fern', variant: rng.int(0, 2) };
        }
      } else if (family === 'leafDry') {
        if (shade > 0.1 && this.ecoSample.deadwood > 0.3) {
          spec = { type: 'leafLitter', variant: rng.int(0, 1) };
        }
      } else if (family === 'reed') {
        if (this.hf.inCreek(x, z)) {
          spec = { type: 'reed', variant: rng.int(0, 1) };
        }
      }

      if (!spec) continue;

      const geo = this.getOrMakeProp(family, spec, rng);
      if (!geo) continue;

      const yaw = rng.next() * Math.PI * 2;
      const scl = 0.8 + rng.next() * 0.4;
      const tint = [0.85 + rng.next() * 0.2, 0.83 + rng.next() * 0.17, 0.8 + rng.next() * 0.2];

      items.push({
        geo, x, y, z, yaw,
        leanX: (rng.next() - 0.5) * 0.1,
        leanZ: (rng.next() - 0.5) * 0.1,
        tr: tint[0], tg: tint[1], tb: tint[2],
        h: 0,
        family,
        solidBatch: family !== 'fern' && family !== 'reed',
        cast: family !== 'fern' && family !== 'leafDry',
      });
    }

    return items;
  }

  private getOrMakeProp(family: FloorFamily, spec: PropSpec, rng: SeededRandom): RawGeo | null {
    const key = `${family}:${spec.variant}`;
    if (this.propCache.has(key)) return this.propCache.get(key);

    let geo: RawGeo | null = null;
    switch (family) {
      case 'fern': geo = makeLog(rng, 0.8, 1.2); break;
      case 'reed': geo = makeBranch(rng, 0.3, 0.05); break;
      case 'leafDry': geo = makeBarkFleck(rng, 0.15, 0.3); break;
    }

    if (geo) this.propCache.set(key, geo);
    return geo;
  }

  // ── mesh construction ──────────────────────────────────────────────────

  private mkMesh(
    geo: THREE.BufferGeometry | null,
    mat: THREE.Material,
    cast: boolean,
  ): THREE.Mesh | null {
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    m.frustumCulled = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.visible = false;
    this.group.add(m);
    return m;
  }

  private mergeTier(
    ps: Placement[],
    lod: 'near' | 'far',
  ): { bark: THREE.BufferGeometry | null; foliage: THREE.BufferGeometry | null; tris: number; verts: number } {
    const far = lod === 'far';
    let bv = 0, bi = 0, fv = 0, fi = 0;

    for (const p of ps) {
      if (far && p.h < FAR_MIN_HEIGHT) continue;
      const t = far ? p.far : p.near;
      bv += t.bark.position.length / 3;
      bi += t.bark.index.length;
      if (t.foliage) {
        fv += t.foliage.position.length / 3;
        fi += t.foliage.index.length;
      }
    }

    const bark = new MergeTarget(bv, bi);
    const fol = new MergeTarget(fv, fi);
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
      bark: bark.finish(),
      foliage: fol.finish(),
      tris: bark.triangles + fol.triangles,
      verts: bark.vertices + fol.vertices,
    };
  }

  private buildFar(c: Chunk): void {
    if (c.placements.length === 0) return;
    const r = this.mergeTier(c.placements, 'far');
    c.farBark = this.mkMesh(r.bark, this.barkMat, false);
    c.farFoliage = this.mkMesh(r.foliage, this.foliageMat, false);
    c.triFar = r.tris;
  }

  private buildNear(c: Chunk): void {
    if (c.nearBark || c.placements.length === 0) return;
    const r = this.mergeTier(c.placements, 'near');
    c.nearBark = this.mkMesh(r.bark, this.barkMat, true);
    c.nearFoliage = this.mkMesh(r.foliage, this.foliageMat, true);
    c.nearVerts = r.verts;
    c.triNear = r.tris;
    this.residentVerts += r.verts;
  }

  setPlayerVelocity(vx: number, vz: number): void {
    this.velX = vx;
    this.velZ = vz;
  }

  update(px: number, pz: number): void {
    const leadX = px + this.velX * PREDICT_SECONDS;
    const leadZ = pz + this.velZ * PREDICT_SECONDS;
    const leadDist2 = (this.nearRange - LOD_HYST) * (this.nearRange - LOD_HYST);
    const cullDist2 = (this.nearRange + 40) * (this.nearRange + 40);

    let builds = 0;
    for (const c of this.chunks) {
      const dx = leadX - (c.cx - this.half + CHUNK / 2);
      const dz = leadZ - (c.cz - this.half + CHUNK / 2);
      const d2 = dx * dx + dz * dz;

      if (d2 < leadDist2 && c.tier !== 0) {
        c.tier = 0;
        c.lastUsed = ++this.tick;
        if (builds < this.buildsPerFrame) {
          this.buildNear(c);
          builds++;
        }
      } else if (d2 >= leadDist2 && c.tier !== 1) {
        c.tier = 1;
        if (c.nearBark) { c.nearBark.visible = false; }
        if (c.nearFoliage) { c.nearFoliage.visible = false; }
      }

      if (d2 > cullDist2) {
        c.tier = -1;
        if (c.farBark) c.farBark.visible = false;
        if (c.farFoliage) c.farFoliage.visible = false;
      }

      if (c.tier >= 0) {
        if (c.tier === 0 && c.nearBark) c.nearBark.visible = true;
        if (c.tier === 0 && c.nearFoliage) c.nearFoliage.visible = true;
        if (c.tier === 1 && c.farBark) c.farBark.visible = true;
        if (c.tier === 1 && c.farFoliage) c.farFoliage.visible = true;
      }
    }

    // LRU eviction if over budget
    if (this.residentVerts > NEAR_VERT_BUDGET) {
      const lru = this.chunks
        .filter(c => c.nearBark && c.tier !== 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (lru) {
        if (lru.nearBark) { lru.nearBark.geometry.dispose(); lru.nearBark = null; }
        if (lru.nearFoliage) { lru.nearFoliage.geometry.dispose(); lru.nearFoliage = null; }
        this.residentVerts -= lru.nearVerts;
      }
    }
  }

  getTrunkColliders(): TrunkCollider[] {
    return this.trees.map(t => ({ x: t.x, z: t.z, r: t.r, h: t.h }));
  }

  dispose(): void {
    for (const c of this.chunks) {
      if (c.farBark?.geometry) c.farBark.geometry.dispose();
      if (c.farFoliage?.geometry) c.farFoliage.geometry.dispose();
      if (c.nearBark?.geometry) c.nearBark.geometry.dispose();
      if (c.nearFoliage?.geometry) c.nearFoliage.geometry.dispose();
      if (c.floor?.geometry) c.floor.geometry.dispose();
      if (c.floorSolid?.geometry) c.floorSolid.geometry.dispose();
    }
    this.group.children.forEach(m => {
      if (m instanceof THREE.Mesh) {
        if (m.geometry) m.geometry.dispose();
        if (m.material instanceof THREE.Material) m.material.dispose();
      }
    });
  }
}