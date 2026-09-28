import { SeededRandom } from '../core/SeededRandom';
import {
  WORLD_SIZE, LANDMARKS, landmark, LAKE_SHORE, LAKE_Y, SPAWN_PX, EXIT_ID, ALT_EXIT_ID,
  CREEK_CTL_PX, QUARRY_FLOOR_DEPTH, QUARRY_RAMP_PX, buildQuarryRim, buildPathNetwork,
  pxToWorld, polySdf, polyCentroid,
  type PathEdge, type PathClass, type Vec2,
} from './PinewoodLayout';

/**
 * ============================================================================
 * HEIGHT FIELD — terrain + world layout, single source of truth
 * ============================================================================
 *
 * Terrain mesh, character controller, nav grid, scatter, landmarks and the
 * survey map all sample this. Every public query keeps its previous contract.
 *
 * What changed vs. the previous revision, and why it reads better on screen:
 *
 *  - Domain-warped medium/fine octaves. Value-noise fbm on its own produces
 *    round "blobby" hills on a visible lattice; warping only the upper octaves
 *    breaks that up without moving the broad basin, ridge or knolls, which the
 *    gameplay layout (tower sightlines, drainage to the lake) depends on.
 *  - Slope-weighted ridged breakup. Steep ground gets crisp, rocky micro-relief;
 *    flat ground stays calm. This is the cheapest single cue for "eroded".
 *  - Sediment infill. Concavities are partially filled toward their local mean,
 *    producing flat-bottomed forest hollows instead of noise pits. Crests are
 *    untouched, so ridgelines stay sharp.
 *  - Benched trails. Trails are now cut *level across* the slope, following a
 *    smoothed centreline profile — a cut bank on the uphill side and fill on
 *    the downhill side, exactly what hand-built forest trails look like. The
 *    bench fades out in the creek ravine and at the lakeshore so a crossing
 *    never becomes a causeway damming the channel.
 *  - Robust, organic zone levelling. Clearings level to an area-weighted mean
 *    (not one noisy centre sample) with a noise-wobbled edge instead of a circle.
 *  - Baked creek-distance field (exact per cell), so `creekDist`/`inCreek`
 *    no longer walk ~70 segments per call away from the channel.
 *  - Bounding-box culling on channel carves (identical result, faster boot).
 *  - New queries: `normalAt`, `hollowAt`, `moistureAt` for scatter/vegetation/
 *    material systems that want damp hollows, creek-side moss, etc.
 */

export interface Zone {
  id: string;
  name: string;
  x: number; z: number; // world coords
  r: number;            // clearing radius
}

export interface WorldLayout {
  size: number;
  zones: Zone[];
  spawn: { x: number; z: number };
  exit: { x: number; z: number };
  altExit: { x: number; z: number };
  /** the main graded spine — kept as a polyline for consumers that want "the road" */
  trail: { x: number; z: number }[];
  /** the full path graph: loops, spurs, shortcuts, trailheads */
  paths: PathEdge[];
  /** Pine Lake. `shore` is authoritative; x/z/r is its bounding circle. */
  lake: { x: number; z: number; r: number; y: number; shore: Vec2[] };
  /** the excavation rim polygon */
  quarryRim: Vec2[];
  /** the creek ravine */
  creek: CarvedChannel;
}

export interface CarvedChannel {
  path: { x: number; z: number }[];
  bedWidth: number;
  bankWidth: number;
  depth: number;
  fall?: { index: number; height: number; span: number };
}

/** Creek centreline: authored control points, Catmull-Rom + perpendicular wander. */
export function buildCreekChannel(r: SeededRandom): CarvedChannel {
  const control = CREEK_CTL_PX.map(p => pxToWorld(p[0], p[1]));
  const path: { x: number; z: number }[] = [];
  for (let i = 0; i < control.length - 1; i++) {
    const a = control[i], b = control[i + 1];
    const p0 = control[Math.max(0, i - 1)];
    const p3 = control[Math.min(control.length - 1, i + 2)];
    const segs = 7;
    for (let s = 0; s < segs; s++) {
      const t = s / segs, t2 = t * t, t3 = t2 * t;
      const cx = 0.5 * ((2 * a.x) + (-p0.x + b.x) * t + (2 * p0.x - 5 * a.x + 4 * b.x - p3.x) * t2 + (-p0.x + 3 * a.x - 3 * b.x + p3.x) * t3);
      const cz = 0.5 * ((2 * a.z) + (-p0.z + b.z) * t + (2 * p0.z - 5 * a.z + 4 * b.z - p3.z) * t2 + (-p0.z + 3 * a.z - 3 * b.z + p3.z) * t3);
      const dx = b.x - a.x, dz = b.z - a.z;
      const pl = Math.hypot(dx, dz) || 1;
      const wob = r.noise1(i * 4.7 + t * 3.3) * 6.5;
      path.push({ x: cx - (dz / pl) * wob, z: cz + (dx / pl) * wob });
    }
  }
  path.push(control[control.length - 1]);
  return {
    path,
    bedWidth: 2.4,
    bankWidth: 14.5,
    depth: 3.6,
    fall: { index: Math.floor(path.length * 0.28), height: 4.6, span: 3 },
  };
}

/** distance from (x,z) to a polyline, plus the arc parameter of the closest point */
export function polylineDist(
  path: { x: number; z: number }[], x: number, z: number,
): { dist: number; t: number; index: number; u: number } {
  let best = Infinity, bestI = 0, bestU = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz || 1;
    let u = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const px = a.x + dx * u, pz = a.z + dz * u;
    const d = (x - px) * (x - px) + (z - pz) * (z - pz);
    if (d < best) { best = d; bestI = i; bestU = u; }
  }
  const segs = Math.max(1, path.length - 1);
  return { dist: Math.sqrt(best), t: (bestI + bestU) / segs, index: bestI, u: bestU };
}

/* Auxiliary 2 m fields (paths, creek). */
const PATH_RES = 281;
const PATH_FAR = 30;
/** below this distance creek queries fall back to the exact polyline */
const CREEK_EXACT_BAND = 6;

/** Trail benching: how hard each class is levelled across-slope. */
interface BenchSpec { reach: number; strength: number; maxDev: number; width: number }
const BENCH: Record<PathClass, BenchSpec> = {
  main:  { width: 2.6,  reach: 6.5, strength: 0.85, maxDev: 1.4 },
  trail: { width: 1.9,  reach: 4.8, strength: 0.62, maxDev: 0.9 },
  faint: { width: 1.35, reach: 3.2, strength: 0.30, maxDev: 0.45 },
};
const SMOOTH_STRENGTH: Record<PathClass, number> = { main: 0.78, trail: 0.55, faint: 0.3 };
const SMOOTH_REACH: Record<PathClass, number> = { main: 7.0, trail: 5.0, faint: 3.4 };

export class HeightField {
  readonly layout: WorldLayout;
  private rng: SeededRandom;
  /** independent streams so new detail never perturbs the authored base noise */
  private warpRng: SeededRandom;
  private detailRng: SeededRandom;
  private res: number;
  private step: number;
  private half: number;
  heights: Float32Array;

  private pathDist: Float32Array;
  private pathKind: Uint8Array;
  private pathStep: number;
  /** exact creek distance at every 2 m cell (unclamped) */
  private creekField: Float32Array;
  /** 0..1 concavity — how much of a hollow each cell sits in */
  private hollow: Float32Array;

  private creekBedY: Float32Array | null = null;
  private rampBedY: Float32Array | null = null;

  constructor(seed: number) {
    this.rng = new SeededRandom(seed);
    this.warpRng = this.rng.fork(0x3A7F11);
    this.detailRng = this.rng.fork(0x5C0DE5);
    const size = WORLD_SIZE;

    const zones: Zone[] = LANDMARKS.map(l => ({ id: l.id, name: l.name, x: l.x, z: l.z, r: l.r }));
    const spawn = pxToWorld(SPAWN_PX[0], SPAWN_PX[1]);
    const ex = landmark(EXIT_ID), ax = landmark(ALT_EXIT_ID);
    const exit = { x: ex.x, z: ex.z };
    const altExit = { x: ax.x, z: ax.z };
    const paths = buildPathNetwork(this.rng.fork(0x9A7418));

    const spineIds = ['hub-clearing', 'clearing-cabin', 'cabin-rocks', 'rocks-junction', 'east-trail'];
    const trail: { x: number; z: number }[] = [];
    for (const id of spineIds) {
      const e = paths.find(p => p.id === id);
      if (e) for (const p of e.pts) trail.push({ x: p.x, z: p.z });
    }

    const lc = polyCentroid(LAKE_SHORE);
    let lr = 0;
    for (const p of LAKE_SHORE) lr = Math.max(lr, Math.hypot(p.x - lc.x, p.z - lc.z));
    const lake = { x: lc.x, z: lc.z, r: lr, y: LAKE_Y, shore: LAKE_SHORE };
    const quarryRim = buildQuarryRim(this.rng.fork(0x0D1A));
    const creek = buildCreekChannel(this.rng.fork(0x517E));

    this.layout = { size, zones, spawn, exit, altExit, trail, paths, lake, quarryRim, creek };

    this.res = 256;
    this.half = size / 2;
    this.step = size / (this.res - 1);
    this.heights = new Float32Array(this.res * this.res);
    this.hollow = new Float32Array(this.res * this.res);

    this.pathStep = size / (PATH_RES - 1);
    this.pathDist = new Float32Array(PATH_RES * PATH_RES).fill(PATH_FAR);
    this.pathKind = new Uint8Array(PATH_RES * PATH_RES);
    this.creekField = new Float32Array(PATH_RES * PATH_RES);

    this.bakePathField();
    this.bakeCreekField();
    this.bake();
    this.bakeHollowField();
  }

  /* ── auxiliary fields ─────────────────────────────────────────────────── */

  private bakePathField(): void {
    const R = PATH_RES, st = this.pathStep, half = this.half;
    const rad = Math.ceil(PATH_FAR / st);
    const classId: Record<PathClass, number> = { main: 1, trail: 2, faint: 3 };
    for (const edge of this.layout.paths) {
      const kind = classId[edge.cls];
      for (let s = 0; s < edge.pts.length - 1; s++) {
        const a = edge.pts[s], b = edge.pts[s + 1];
        const steps = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z)));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const sx = a.x + (b.x - a.x) * t, sz = a.z + (b.z - a.z) * t;
          const ci = Math.round((sx + half) / st), cj = Math.round((sz + half) / st);
          for (let j = cj - rad; j <= cj + rad; j++) {
            if (j < 0 || j >= R) continue;
            const wz = -half + j * st;
            for (let i = ci - rad; i <= ci + rad; i++) {
              if (i < 0 || i >= R) continue;
              const d = Math.hypot(-half + i * st - sx, wz - sz);
              if (d >= PATH_FAR) continue;
              const idx = j * R + i;
              if (d < this.pathDist[idx]) { this.pathDist[idx] = d; this.pathKind[idx] = kind; }
            }
          }
        }
      }
    }
  }

  /**
   * Exact distance-to-creek at every 2 m cell. ~79k cells × ~70 segments is a
   * few million multiply-adds once at boot, and removes the per-call polyline
   * walk from every scatter candidate, footstep and ambience query.
   */
  private bakeCreekField(): void {
    const R = PATH_RES, st = this.pathStep, half = this.half;
    const path = this.layout.creek.path;
    for (let j = 0; j < R; j++) {
      const z = -half + j * st;
      for (let i = 0; i < R; i++) {
        this.creekField[j * R + i] = polylineDist(path, -half + i * st, z).dist;
      }
    }
  }

  /** bilinear read of a PATH_RES field */
  private sampleField(field: Float32Array, x: number, z: number): number {
    const R = PATH_RES, st = this.pathStep;
    const fx = (x + this.half) / st, fz = (z + this.half) / st;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= R - 1 || j >= R - 1) {
      const ci = Math.max(0, Math.min(R - 1, i)), cj = Math.max(0, Math.min(R - 1, j));
      return field[cj * R + ci];
    }
    const tx = fx - i, tz = fz - j;
    const a = field[j * R + i], b = field[j * R + i + 1];
    const c = field[(j + 1) * R + i], d = field[(j + 1) * R + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** bilinear read of a height-resolution field */
  private sampleRes(field: Float32Array, x: number, z: number): number {
    const fx = (x + this.half) / this.step, fz = (z + this.half) / this.step;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= this.res - 1 || j >= this.res - 1) {
      const cx = Math.max(0, Math.min(this.res - 1, i));
      const cz = Math.max(0, Math.min(this.res - 1, j));
      return field[cz * this.res + cx];
    }
    const tx = fx - i, tz = fz - j;
    const a = field[j * this.res + i], b = field[j * this.res + i + 1];
    const c = field[(j + 1) * this.res + i], d = field[(j + 1) * this.res + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /* ── path queries ─────────────────────────────────────────────────────── */

  trailDist(x: number, z: number): number {
    return this.sampleField(this.pathDist, x, z);
  }

  pathClassAt(x: number, z: number): PathClass | null {
    const R = PATH_RES, st = this.pathStep;
    const i = Math.max(0, Math.min(R - 1, Math.round((x + this.half) / st)));
    const j = Math.max(0, Math.min(R - 1, Math.round((z + this.half) / st)));
    const k = this.pathKind[j * R + i];
    return k === 1 ? 'main' : k === 2 ? 'trail' : k === 3 ? 'faint' : null;
  }

  pathWidthAt(x: number, z: number): number {
    const c = this.pathClassAt(x, z);
    return c ? BENCH[c].width : 0;
  }

  onPath(x: number, z: number): boolean {
    return this.trailDist(x, z) < this.pathWidthAt(x, z);
  }

  /* ── terrain bake ─────────────────────────────────────────────────────── */

  private bake(): void {
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        this.heights[j * this.res + i] =
          this.rawHeight(-this.half + i * this.step, -this.half + j * this.step);
      }
    }

    // Natural-surface passes run on the raw grade, *before* any authored carve,
    // so every carve (basin, benches, ravine, ramp) stays authoritative.
    this.slopeBreakup();
    this.sedimentInfill();

    this.carveLakeBasin();
    this.carveQuarry();
    this.buildCreekProfile();
    this.carveChannel(this.layout.creek, this.creekBedY!);
    this.buildRampProfile();

    for (let iter = 0; iter < 2; iter++) {
      this.flattenZones();
      this.smoothAlongPaths(1);
    }
    // Bench the trails into the now-final grade, then feather the cut edges.
    this.benchPaths();
    this.smoothAlongPaths(0.35);

    // Invariant, asserted last: inside the shoreline is under water.
    this.enforceLakeBed();
  }

  private regionalGrade(x: number, z: number): number {
    const n = clamp01((-z + 224) / 448);
    let h = -8 + Math.pow(n, 1.35) * 40;
    h += smooth01((x - 40) / 150) * 9.5;
    h -= Math.exp(-Math.pow((x + 6) / 74, 2)) * 5.0;
    return h;
  }

  private rawHeight(x: number, z: number): number {
    const r = this.rng;
    let h = this.regionalGrade(x, z);

    // Broad hills unwarped: they define the drainage the whole layout relies on.
    h += r.fbm2(x * 0.0062, z * 0.0062, 4) * 8.0;

    // Upper octaves domain-warped (±13 m) to kill the value-noise lattice look.
    const wx = this.warpRng.fbm2(x * 0.011 + 3.3, z * 0.011, 2) * 13;
    const wz = this.warpRng.fbm2(x * 0.011, z * 0.011 - 5.1, 2) * 13;
    h += r.fbm2((x + wx) * 0.021 + 7.7, (z + wz) * 0.021, 3) * 2.4;
    h += r.fbm2((x + wx) * 0.075 - 3.1, (z + wz) * 0.075, 2) * 0.7;

    const rg = landmark('ridge');
    const dr = Math.hypot((x - rg.x) * 0.72, z - rg.z);
    h += Math.exp(-Math.pow(dr / 78, 2)) * 22.0;
    h += Math.exp(-Math.pow((z - rg.z + 6) / 26, 2)) * (7.5 + r.noise1(x * 0.021) * 4.5);

    // Watchtower knoll — keeps the cab above the old-growth canopy.
    const tw = landmark('tower');
    const dt = Math.hypot((x - tw.x) * 0.9, (z - tw.z) * 1.1);
    h += Math.exp(-Math.pow(dt / 52, 2)) * 15.0;

    const rk = landmark('rocks');
    const dk = Math.hypot((x - rk.x) * 1.15, (z - rk.z) * 0.85);
    h += Math.exp(-Math.pow(dk / 40, 2)) * 13.0;

    const q = landmark('quarry');
    const dq = Math.hypot(x - q.x, (z - q.z) * 1.1);
    h += Math.exp(-Math.pow(dq / 86, 2)) * 12.5;

    const d = Math.max(Math.abs(x), Math.abs(z)) / this.half;
    h += smooth01((d - 0.84) / 0.16) * 20.0;
    return h;
  }

  /**
   * Ridged micro-relief weighted by slope. Flat ground stays calm (walkable,
   * legible), steep flanks get crisp breakup that catches the moon key and
   * the flashlight grazing angle — the "eroded" read.
   */
  private slopeBreakup(): void {
    const R = this.res, st = this.step, half = this.half;
    const src = this.heights.slice();
    const rn = this.detailRng;
    for (let j = 1; j < R - 1; j++) {
      const z = -half + j * st;
      for (let i = 1; i < R - 1; i++) {
        const idx = j * R + i;
        const gx = (src[idx + 1] - src[idx - 1]) / (2 * st);
        const gz = (src[idx + R] - src[idx - R]) / (2 * st);
        const w = smooth01((Math.hypot(gx, gz) - 0.22) / 0.5);
        if (w <= 0) continue;
        const x = -half + i * st;
        const n = 1 - Math.abs(rn.fbm2(x * 0.085, z * 0.085, 3));
        this.heights[idx] += (n * n - 0.5) * 0.9 * w;
      }
    }
  }

  /**
   * Partial fill of concavities toward the local mean — sediment settles in
   * hollows, crests shed it. Gives flat-floored forest dips instead of pits.
   */
  private sedimentInfill(): void {
    const blur = this.boxBlur(this.heights, 3);
    for (let k = 0; k < this.heights.length; k++) {
      const d = blur[k] - this.heights[k];
      if (d > 0) this.heights[k] += d * 0.3;
    }
  }

  /** separable box blur on the height grid, clamped edges */
  private boxBlur(src: Float32Array, r: number): Float32Array {
    const R = this.res, n = 2 * r + 1;
    const tmp = new Float32Array(R * R), out = new Float32Array(R * R);
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += src[j * R + Math.max(0, Math.min(R - 1, i + k))];
        tmp[j * R + i] = s / n;
      }
    }
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        let s = 0;
        for (let k = -r; k <= r; k++) s += tmp[Math.max(0, Math.min(R - 1, j + k)) * R + i];
        out[j * R + i] = s / n;
      }
    }
    return out;
  }

  private enforceLakeBed(): void {
    const shore = this.layout.lake.shore;
    const y = this.layout.lake.y;
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step, z = -this.half + j * this.step;
        const sd = polySdf(shore, x, z);
        if (sd >= 0) continue;
        const ceil = y - 0.25 - Math.min(6.0, Math.pow(-sd, 0.8) * 0.55);
        const idx = j * this.res + i;
        if (this.heights[idx] > ceil) this.heights[idx] = ceil;
      }
    }
  }

  private carveLakeBasin(): void {
    const shore = this.layout.lake.shore;
    const y = this.layout.lake.y;
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step, z = -this.half + j * this.step;
        const sd = polySdf(shore, x, z);
        if (sd > 30) continue;
        const idx = j * this.res + i;
        if (sd <= 0) {
          const floor = y - 0.35 - Math.min(7.2, Math.pow(-sd, 0.78) * 0.95);
          this.heights[idx] = Math.min(this.heights[idx], floor);
        } else {
          const t = 1 - smooth01(sd / 30);
          const bank = y + 0.35 + Math.pow(sd / 30, 0.72) * 9.0;
          this.heights[idx] = this.heights[idx] * (1 - t) + bank * t;
        }
      }
    }
  }

  /** Benched excavation — level treads, wandering outlines, rubble floor. */
  private carveQuarry(): void {
    const rim = this.layout.quarryRim;
    let rimY = 0;
    for (const p of rim) rimY += this.sampleGrid(p.x, p.z);
    rimY /= rim.length;
    const floorY = rimY - QUARRY_FLOOR_DEPTH;
    const rn = this.rng.fork(0x2B77);

    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step, z = -this.half + j * this.step;
        const sd = polySdf(rim, x, z);
        if (sd > 26) continue;
        const idx = j * this.res + i;
        if (sd < 0) {
          const dep = -sd;
          const jitter = rn.noise2(x * 0.028, z * 0.028) * 2.6;
          const s = clamp01((dep + jitter) / 20);
          const STEPS = 3;
          const si = Math.min(STEPS - 1, Math.floor(s * STEPS));
          const riser = smooth01((s * STEPS - si) / 0.3);
          const target = rimY - QUARRY_FLOOR_DEPTH * clamp01((si + riser) / STEPS);
          const rubble = dep > 22 ? rn.fbm2(x * 0.09, z * 0.09, 2) * 0.85 : 0;
          this.heights[idx] = Math.min(this.heights[idx], target + rubble);
          if (dep > 24) this.heights[idx] = Math.min(this.heights[idx], floorY + rubble);
        } else {
          const t = 1 - smooth01(sd / 26);
          this.heights[idx] += t * (1.6 + rn.noise2(x * 0.05, z * 0.05) * 1.4);
        }
      }
    }
  }

  private buildRampProfile(): void {
    const pts = QUARRY_RAMP_PX.map(p => pxToWorld(p[0], p[1]));
    const path: Vec2[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const steps = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 3));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        path.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
    }
    path.push(pts[pts.length - 1]);
    const topY = this.sampleGrid(path[0].x, path[0].z);
    const endY = this.sampleGrid(path[path.length - 1].x, path[path.length - 1].z);
    const prof = new Float32Array(path.length);
    for (let i = 0; i < path.length; i++) {
      prof[i] = topY + (endY - topY) * smooth01(i / (path.length - 1));
    }
    this.rampBedY = prof;
    this.carveChannel({ path, bedWidth: 3.2, bankWidth: 9.0, depth: 0 }, prof);
  }

  /** Monotone-downhill creek bed with an explicit waterfall, mouth submerged. */
  private buildCreekProfile(): void {
    const c = this.layout.creek;
    const n = c.path.length;
    const prof = new Float32Array(n);
    for (let i = 0; i < n; i++) prof[i] = this.sampleGrid(c.path[i].x, c.path[i].z) - c.depth;

    if (c.fall) {
      for (let i = c.fall.index; i < n; i++) {
        prof[i] -= c.fall.height * smooth01(Math.min(1, (i - c.fall.index) / c.fall.span));
      }
    }
    for (let i = 1; i < n; i++) {
      const seg = Math.hypot(c.path[i].x - c.path[i - 1].x, c.path[i].z - c.path[i - 1].z);
      const cap = prof[i - 1] - seg * 0.012;
      if (prof[i] > cap) prof[i] = cap;
    }
    // affine re-anchor about the source: lands the mouth under the lake surface
    // while provably preserving monotonicity
    const target = this.layout.lake.y - 0.5;
    const src = prof[0], mouth = prof[n - 1];
    if (mouth < target && src > target + 1e-3) {
      const k = (src - target) / (src - mouth);
      for (let i = 0; i < n; i++) prof[i] = src - (src - prof[i]) * k;
    }
    this.creekBedY = prof;
  }

  private sampleGrid(x: number, z: number): number {
    const fx = (x + this.half) / this.step, fz = (z + this.half) / this.step;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0) i = 0; if (j < 0) j = 0;
    if (i > this.res - 2) i = this.res - 2;
    if (j > this.res - 2) j = this.res - 2;
    const tx = fx - i, tz = fz - j;
    const a = this.heights[j * this.res + i], b = this.heights[j * this.res + i + 1];
    const c2 = this.heights[(j + 1) * this.res + i], d = this.heights[(j + 1) * this.res + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c2 * (1 - tx) + d * tx) * tz;
  }

  /** V-to-U channel blended into grade. Bbox-culled; result identical to a full sweep. */
  private carveChannel(c: CarvedChannel, prof: Float32Array): void {
    const R = this.res, st = this.step, half = this.half;
    const segs = Math.max(1, c.path.length - 1);
    const span = Math.max(1e-3, c.bankWidth - c.bedWidth);

    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of c.path) {
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
      if (p.z < z0) z0 = p.z; if (p.z > z1) z1 = p.z;
    }
    const i0 = Math.max(0, Math.floor((x0 - c.bankWidth + half) / st));
    const i1 = Math.min(R - 1, Math.ceil((x1 + c.bankWidth + half) / st));
    const j0 = Math.max(0, Math.floor((z0 - c.bankWidth + half) / st));
    const j1 = Math.min(R - 1, Math.ceil((z1 + c.bankWidth + half) / st));

    for (let j = j0; j <= j1; j++) {
      const z = -half + j * st;
      for (let i = i0; i <= i1; i++) {
        const x = -half + i * st;
        const q = polylineDist(c.path, x, z);
        if (q.dist > c.bankWidth) continue;
        const idx = j * R + i;
        const fi = q.t * segs;
        const a0 = Math.min(prof.length - 1, Math.floor(fi));
        const a1 = Math.min(prof.length - 1, a0 + 1);
        const bedY = prof[a0] + (prof[a1] - prof[a0]) * (fi - a0);
        let target: number;
        if (q.dist <= c.bedWidth) {
          target = bedY;
        } else {
          const k = smooth01((q.dist - c.bedWidth) / span);
          target = bedY + (this.heights[idx] - bedY) * (k * k * (3 - 2 * k));
        }
        const w = 1 - smooth01(((q.dist - c.bedWidth) / span) * 0.92);
        this.heights[idx] = this.heights[idx] * (1 - w) + target * w;
      }
    }
  }

  /**
   * Level the built clearings. The level is an area-weighted mean of the inner
   * disc (a single centre sample lands on whatever noise bump is there), and
   * the edge radius wobbles with angle so a clearing never reads as a circle.
   */
  private flattenZones(): void {
    const R = this.res, st = this.step, half = this.half, rn = this.detailRng;
    for (const zn of this.layout.zones) {
      if (zn.id === 'quarry' || zn.id === 'lake' || zn.id === 'ridge') continue;
      const lmk = LANDMARKS.find(l => l.id === zn.id);
      if (lmk && lmk.kind === 'trailhead') continue;

      const r = zn.id === 'rocks' ? zn.r * 0.55 : zn.r;
      const rMax = r * 1.14;
      const i0 = Math.max(0, Math.floor((zn.x - rMax + half) / st));
      const i1 = Math.min(R - 1, Math.ceil((zn.x + rMax + half) / st));
      const j0 = Math.max(0, Math.floor((zn.z - rMax + half) / st));
      const j1 = Math.min(R - 1, Math.ceil((zn.z + rMax + half) / st));

      let sum = 0, wsum = 0;
      const inner = r * 0.5;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(-half + i * st - zn.x, -half + j * st - zn.z);
          if (d >= inner) continue;
          const w = 1 - d / inner;
          sum += this.heights[j * R + i] * w; wsum += w;
        }
      }
      const level = wsum > 0 ? sum / wsum : this.sampleGrid(zn.x, zn.z);

      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = -half + i * st, z = -half + j * st;
          const d = Math.hypot(x - zn.x, z - zn.z);
          const a = Math.atan2(z - zn.z, x - zn.x);
          const rr = r * (1 + 0.12 * rn.noise2(Math.cos(a) * 1.6 + zn.x * 0.013, Math.sin(a) * 1.6 + zn.z * 0.013));
          if (d >= rr) continue;
          const t = smooth01((rr - d) / (rr * 0.6)) * 0.86;
          const idx = j * R + i;
          this.heights[idx] = this.heights[idx] * (1 - t) + level * t;
        }
      }
    }
  }

  /** Neighbour-average relaxation along paths; `scale` multiplies class strength. */
  private smoothAlongPaths(scale: number): void {
    for (const edge of this.layout.paths) {
      const w = SMOOTH_REACH[edge.cls], s = SMOOTH_STRENGTH[edge.cls] * scale;
      for (const tp of edge.pts) {
        const i0 = Math.max(1, Math.floor((tp.x - w + this.half) / this.step));
        const i1 = Math.min(this.res - 2, Math.ceil((tp.x + w + this.half) / this.step));
        const j0 = Math.max(1, Math.floor((tp.z - w + this.half) / this.step));
        const j1 = Math.min(this.res - 2, Math.ceil((tp.z + w + this.half) / this.step));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const d = Math.hypot(-this.half + i * this.step - tp.x, -this.half + j * this.step - tp.z);
            if (d >= w) continue;
            const idx = j * this.res + i;
            const avg = (this.heights[idx] * 2 + this.heights[idx - 1] + this.heights[idx + 1]
              + this.heights[idx - this.res] + this.heights[idx + this.res]) / 6;
            const t = smooth01((w - d) / w) * s;
            this.heights[idx] = this.heights[idx] * (1 - t) + avg * t;
          }
        }
      }
    }
  }

  /**
   * Cut trails level across the slope.
   *
   * Each edge samples its centreline, smooths that profile along its length
   * (bounded by `maxDev` so a trail never tunnels through a knoll), and every
   * cell in the corridor is pulled toward the profile height of its *nearest*
   * path. Result: flat tread, cut bank uphill, fill downhill — the strongest
   * single "someone built this" cue a forest trail has. Junctions resolve
   * cleanly because each cell only listens to its closest segment.
   *
   * Faded out inside the creek banks and at the lake edge: a crossing must
   * not raise a causeway that dams the ravine or dries the shallows.
   */
  private benchPaths(): void {
    const R = this.res, st = this.step, half = this.half;
    const bestD = new Float32Array(R * R).fill(Infinity);
    const bestT = new Float32Array(R * R);
    const bestW = new Float32Array(R * R);

    for (const edge of this.layout.paths) {
      const spec = BENCH[edge.cls];
      const pts = edge.pts, n = pts.length;
      if (n < 2) continue;

      const raw = new Float32Array(n);
      for (let k = 0; k < n; k++) raw[k] = this.sampleGrid(pts[k].x, pts[k].z);
      let prof = raw.slice();
      const tmp = new Float32Array(n);
      for (let pass = 0; pass < 3; pass++) {
        tmp[0] = prof[0]; tmp[n - 1] = prof[n - 1];
        for (let k = 1; k < n - 1; k++) tmp[k] = (prof[k - 1] + 2 * prof[k] + prof[k + 1]) * 0.25;
        prof = tmp.slice();
      }
      for (let k = 0; k < n; k++) {
        const dv = prof[k] - raw[k];
        prof[k] = raw[k] + Math.max(-spec.maxDev, Math.min(spec.maxDev, dv));
      }

      const core = spec.width * 0.85;
      const reach = Math.max(spec.reach, spec.width + 2);
      for (let s = 0; s < n - 1; s++) {
        const a = pts[s], b = pts[s + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len2 = dx * dx + dz * dz || 1;
        const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach + half) / st));
        const i1 = Math.min(R - 1, Math.ceil((Math.max(a.x, b.x) + reach + half) / st));
        const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z) - reach + half) / st));
        const j1 = Math.min(R - 1, Math.ceil((Math.max(a.z, b.z) + reach + half) / st));
        for (let j = j0; j <= j1; j++) {
          const z = -half + j * st;
          for (let i = i0; i <= i1; i++) {
            const x = -half + i * st;
            let u = ((x - a.x) * dx + (z - a.z) * dz) / len2;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const d = Math.hypot(x - (a.x + dx * u), z - (a.z + dz * u));
            if (d >= reach) continue;
            const idx = j * R + i;
            if (d >= bestD[idx]) continue;
            bestD[idx] = d;
            bestT[idx] = prof[s] + (prof[s + 1] - prof[s]) * u;
            bestW[idx] = spec.strength * (d <= core ? 1 : 1 - smooth01((d - core) / (reach - core)));
          }
        }
      }
    }

    const creek = this.layout.creek;
    const shore = this.layout.lake.shore;
    const creekSpan = creek.bankWidth - creek.bedWidth;
    for (let j = 0; j < R; j++) {
      const z = -half + j * st;
      for (let i = 0; i < R; i++) {
        const idx = j * R + i;
        if (bestD[idx] === Infinity || bestW[idx] <= 0) continue;
        const x = -half + i * st;
        const cd = this.sampleField(this.creekField, x, z);
        const creekKeep = smooth01((cd - (creek.bedWidth + 1.0)) / creekSpan);
        if (creekKeep <= 0) continue;
        const lakeKeep = smooth01((polySdf(shore, x, z) - 1.0) / 6.0);
        const w = bestW[idx] * creekKeep * lakeKeep;
        if (w <= 0) continue;
        this.heights[idx] = this.heights[idx] * (1 - w) + bestT[idx] * w;
      }
    }
  }

  /** concavity field on the *final* terrain — damp hollows, fog pools, ferns */
  private bakeHollowField(): void {
    const blur = this.boxBlur(this.heights, 4);
    for (let k = 0; k < this.heights.length; k++) {
      this.hollow[k] = clamp01((blur[k] - this.heights[k]) / 1.1);
    }
  }

  /* ── creek queries ────────────────────────────────────────────────────── */

  creekBedAt(x: number, z: number): number {
    const c = this.layout.creek;
    const prof = this.creekBedY;
    if (!prof) return this.heightAt(x, z);
    const q = polylineDist(c.path, x, z);
    const fi = q.t * Math.max(1, c.path.length - 1);
    const i0 = Math.min(prof.length - 1, Math.floor(fi));
    const i1 = Math.min(prof.length - 1, i0 + 1);
    return prof[i0] + (prof[i1] - prof[i0]) * (fi - i0);
  }

  /** Field-accelerated; exact polyline within 6 m of the channel. */
  creekDist(x: number, z: number): number {
    const f = this.sampleField(this.creekField, x, z);
    if (f > CREEK_EXACT_BAND) return f;
    return polylineDist(this.layout.creek.path, x, z).dist;
  }

  creekParam(x: number, z: number): number {
    return polylineDist(this.layout.creek.path, x, z).t;
  }

  inCreek(x: number, z: number): boolean {
    const lim = this.layout.creek.bedWidth + 0.6;
    if (this.sampleField(this.creekField, x, z) > lim + 3) return false;
    return polylineDist(this.layout.creek.path, x, z).dist < lim;
  }

  /* ── general queries ──────────────────────────────────────────────────── */

  /** bilinear height sample — controller, nav, placement */
  heightAt(x: number, z: number): number {
    return this.sampleRes(this.heights, x, z);
  }

  /** unit surface normal (central differences), allocation-free with `out` */
  normalAt(
    x: number, z: number,
    out: { x: number; y: number; z: number } = { x: 0, y: 1, z: 0 },
  ): { x: number; y: number; z: number } {
    const e = this.step * 0.5;
    const nx = this.heightAt(x - e, z) - this.heightAt(x + e, z);
    const nz = this.heightAt(x, z - e) - this.heightAt(x, z + e);
    const ny = 2 * e;
    const l = Math.hypot(nx, ny, nz) || 1;
    out.x = nx / l; out.y = ny / l; out.z = nz / l;
    return out;
  }

  /** 0..1 — how deep in a local hollow this point sits */
  hollowAt(x: number, z: number): number {
    return this.sampleRes(this.hollow, x, z);
  }

  /**
   * 0..1 ground moisture: creek banks, lake margin, hollows, the quarry
   * floor's standing water, plus a mild low-elevation bias. For moss,
   * ferns, puddles, wet-material masks and ground-fog density.
   */
  moistureAt(x: number, z: number): number {
    const c = this.layout.creek;
    const creek = 1 - smooth01((this.sampleField(this.creekField, x, z) - c.bedWidth) / 16);
    const lake = 1 - smooth01(this.lakeSdf(x, z) / 24);
    const hol = this.hollowAt(x, z);
    const pit = this.quarrySdf(x, z) < -24 ? 0.55 : 0;
    const low = 1 - smooth01((this.heightAt(x, z) - this.layout.lake.y) / 26);
    return clamp01(Math.max(creek, lake * 0.9, hol * 0.85, pit) + low * 0.18);
  }

  zoneAt(x: number, z: number): Zone | null {
    let best: Zone | null = null, bestD = Infinity;
    for (const zn of this.layout.zones) {
      const d = Math.hypot(x - zn.x, z - zn.z);
      if (d < zn.r && d < bestD) { best = zn; bestD = d; }
    }
    return best;
  }

  inLake(x: number, z: number): boolean { return polySdf(this.layout.lake.shore, x, z) < -1.5; }
  lakeSdf(x: number, z: number): number { return polySdf(this.layout.lake.shore, x, z); }
  quarrySdf(x: number, z: number): number { return polySdf(this.layout.quarryRim, x, z); }
  inQuarry(x: number, z: number): boolean { return this.quarrySdf(x, z) < -2; }

  slopeAt(x: number, z: number): number {
    const dx = this.heightAt(x + 2, z) - this.heightAt(x - 2, z);
    const dz = this.heightAt(x, z + 2) - this.heightAt(x, z - 2);
    return Math.hypot(dx, dz) / 4;
  }
}

function smooth01(t: number): number {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
