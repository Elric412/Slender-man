import { SeededRandom } from '../core/SeededRandom';
import {
  WORLD_SIZE, LANDMARKS, landmark, LAKE_SHORE, LAKE_Y, SPAWN_PX, EXIT_ID, ALT_EXIT_ID,
  CREEK_CTL_PX, QUARRY_FLOOR_DEPTH, QUARRY_RAMP_PX,
  buildQuarryRim, buildPathNetwork, pxToWorld, polySdf, polyCentroid,
  type PathEdge, type PathClass, type Vec2,
} from './PinewoodLayout';

export interface Zone {
  id: string;
  name: string;
  x: number; z: number;   // world coords
  r: number;              // clearing radius
}

export interface WorldLayout {
  size: number;           // map span (m), centered on origin
  zones: Zone[];
  spawn: { x: number; z: number };
  exit: { x: number; z: number };   // primary trailhead out of the survey area
  altExit: { x: number; z: number };
  /** the main graded spine — kept as a polyline for consumers that want "the road" */
  trail: { x: number; z: number }[];
  /** the full path graph: loops, spurs, shortcuts, trailheads */
  paths: PathEdge[];
  /**
   * Pine Lake. `shore` is the authoritative irregular outline; `x/z/r` is its
   * bounding circle, kept because ambience, fog and distance queries only ever
   * need a cheap "how far to the water" scalar.
   */
  lake: { x: number; z: number; r: number; y: number; shore: Vec2[] };
  /** the excavation rim polygon — walls, shadow pooling and fall damage read it */
  quarryRim: Vec2[];
  /** the creek ravine — carved terrain, shared with ZoneSystem + audio */
  creek: CarvedChannel;
}

/**
 * Terrain features carved *after* the base noise but *before* zone/trail
 * relaxation. The creek ravine and the quarry haul ramp are both of these, and
 * they have to be first-class terrain edits rather than decoration: the player
 * walks them, the nav grid pathfinds them, water sits in them, and fog pools in
 * them — all of which read the same height function.
 */
export interface CarvedChannel {
  /** centreline, world space */
  path: { x: number; z: number }[];
  /** channel half-width at the bed */
  bedWidth: number;
  /** total half-width including banks */
  bankWidth: number;
  /** how deep the bed cuts below the surrounding grade */
  depth: number;
  /** vertical drop applied over a short stretch — the waterfall */
  fall?: { index: number; height: number; span: number };
}

/**
 * The creek centreline: authored in map space (see CREEK_CTL_PX) then
 * Catmull-Rom resampled with perpendicular noise wander so it never reads as a
 * straight cut. It runs from the high north down to Pine Lake in the south —
 * i.e. downhill, because water does.
 *
 * Lives here (not in ZoneSystem) because it *carves terrain*: the height
 * function is the single source of truth, so anything that changes ground
 * elevation has to be resolved before the field bakes.
 */
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
      const cx = 0.5 * ((2 * a.x) + (-p0.x + b.x) * t
        + (2 * p0.x - 5 * a.x + 4 * b.x - p3.x) * t2
        + (-p0.x + 3 * a.x - 3 * b.x + p3.x) * t3);
      const cz = 0.5 * ((2 * a.z) + (-p0.z + b.z) * t
        + (2 * p0.z - 5 * a.z + 4 * b.z - p3.z) * t2
        + (-p0.z + 3 * a.z - 3 * b.z + p3.z) * t3);
      const dx = b.x - a.x, dz = b.z - a.z;
      const pl = Math.hypot(dx, dz) || 1;
      const wob = r.noise1(i * 4.7 + t * 3.3) * 6.5;
      path.push({ x: cx - (dz / pl) * wob, z: cz + (dx / pl) * wob });
    }
  }
  path.push(control[control.length - 1]);
  return {
    path, bedWidth: 2.4, bankWidth: 14.5, depth: 3.6,
    // waterfall where the ridge shelf breaks, about a third down
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

/* Path-distance field resolution. 2 m cells over the whole world: consumers
 * only ever test thresholds under ~14 m, so anything past PATH_FAR is clamped
 * and the grid stays a 320 KB array instead of a per-call loop over 25
 * polylines (which the vegetation bake would have to pay a million times). */
const PATH_RES = 281;
const PATH_FAR = 30;

/**
 * Analytic heightfield + world layout. Single source of truth: the terrain mesh,
 * character controller, nav grid, scatter placement, landmark geometry and the
 * in-game survey map all sample the same functions in here.
 */
export class HeightField {
  readonly layout: WorldLayout;
  private rng: SeededRandom;
  private res: number;
  private step: number;
  private half: number;
  heights: Float32Array;

  /** baked min-distance-to-any-path field, and the class of the nearest path */
  private pathDist: Float32Array;
  private pathKind: Uint8Array;
  private pathStep: number;

  constructor(seed: number) {
    this.rng = new SeededRandom(seed);
    const size = WORLD_SIZE;

    // Zones ARE the landmarks: one list, so a landmark can never exist in the
    // world without the terrain, nav grid and map agreeing that it is there.
    const zones: Zone[] = LANDMARKS.map(l => ({
      id: l.id, name: l.name, x: l.x, z: l.z, r: l.r,
    }));

    const spawn = pxToWorld(SPAWN_PX[0], SPAWN_PX[1]);
    const ex = landmark(EXIT_ID), ax = landmark(ALT_EXIT_ID);
    const exit = { x: ex.x, z: ex.z };
    const altExit = { x: ax.x, z: ax.z };

    const paths = buildPathNetwork(this.rng.fork(0x9A7418));
    // the "spine" for legacy single-polyline consumers: junction -> clearing ->
    // cabin -> rocks -> east trailhead, i.e. the objective route
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

    // 256² over 560 m = 2.19 m cells. 192 gave 2.92 m, which is coarser than a
    // quarry bench tread (~2.4 m) — the terraces were being averaged out of
    // existence by the sampler before anything could ever see them. Detail
     // features (benches, creek bed, ramp) set the floor on this number.
    this.res = 256;
    this.half = size / 2;
    this.step = size / (this.res - 1);
    this.heights = new Float32Array(this.res * this.res);

    this.pathStep = size / (PATH_RES - 1);
    this.pathDist = new Float32Array(PATH_RES * PATH_RES).fill(PATH_FAR);
    this.pathKind = new Uint8Array(PATH_RES * PATH_RES);
    this.bakePathField();

    this.bake();
  }

  /** creek bed elevation profile, sampled once so the bed is monotonically downhill */
  private creekBedY: Float32Array | null = null;
  private rampBedY: Float32Array | null = null;

  /* ── path distance field ────────────────────────────────────────────────── */

  /**
   * Stamp every path into a min-distance grid. Sampling the centrelines at 1 m
   * and stamping a local disc is ~4 M cheap ops once at boot, and it turns
   * `trailDist` — called per-vertex by the terrain, per-cell by the vegetation
   * bake and per-candidate by the scatter — into two array reads.
   */
  private bakePathField(): void {
    const R = PATH_RES, st = this.pathStep, half = this.half;
    const rad = Math.ceil(PATH_FAR / st);
    const classId: Record<PathClass, number> = { main: 1, trail: 2, faint: 3 };
    for (const edge of this.layout.paths) {
      const kind = classId[edge.cls];
      for (let s = 0; s < edge.pts.length - 1; s++) {
        const a = edge.pts[s], b = edge.pts[s + 1];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        const steps = Math.max(1, Math.round(seg));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const sx = a.x + (b.x - a.x) * t, sz = a.z + (b.z - a.z) * t;
          const ci = Math.round((sx + half) / st), cj = Math.round((sz + half) / st);
          for (let j = cj - rad; j <= cj + rad; j++) {
            if (j < 0 || j >= R) continue;
            const wz = -half + j * st;
            for (let i = ci - rad; i <= ci + rad; i++) {
              if (i < 0 || i >= R) continue;
              const wx = -half + i * st;
              const d = Math.hypot(wx - sx, wz - sz);
              if (d >= PATH_FAR) continue;
              const idx = j * R + i;
              if (d < this.pathDist[idx]) { this.pathDist[idx] = d; this.pathKind[idx] = kind; }
            }
          }
        }
      }
    }
  }

  /** distance to the nearest path of any class (clamped at 30 m) */
  trailDist(x: number, z: number): number {
    const R = PATH_RES, st = this.pathStep;
    const fx = (x + this.half) / st, fz = (z + this.half) / st;
    let i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= R - 1 || j >= R - 1) {
      const ci = Math.max(0, Math.min(R - 1, i)), cj = Math.max(0, Math.min(R - 1, j));
      return this.pathDist[cj * R + ci];
    }
    const tx = fx - i, tz = fz - j;
    const a = this.pathDist[j * R + i], b = this.pathDist[j * R + i + 1];
    const c = this.pathDist[(j + 1) * R + i], d = this.pathDist[(j + 1) * R + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  /** class of the nearest path — drives ground material, width and wear */
  pathClassAt(x: number, z: number): PathClass | null {
    const R = PATH_RES, st = this.pathStep;
    const i = Math.max(0, Math.min(R - 1, Math.round((x + this.half) / st)));
    const j = Math.max(0, Math.min(R - 1, Math.round((z + this.half) / st)));
    const k = this.pathKind[j * R + i];
    return k === 1 ? 'main' : k === 2 ? 'trail' : k === 3 ? 'faint' : null;
  }

  /**
   * Cleared half-width of the nearest path. Graded road is wide and bare;
   * a faint route is barely a gap in the undergrowth. This is what stops the
   * whole network reading as one uniform corridor.
   */
  pathWidthAt(x: number, z: number): number {
    const c = this.pathClassAt(x, z);
    return c === 'main' ? 2.6 : c === 'trail' ? 1.9 : c === 'faint' ? 1.35 : 0;
  }

  /** true where the ground is worn bare by traffic */
  onPath(x: number, z: number): boolean {
    return this.trailDist(x, z) < this.pathWidthAt(x, z);
  }

  /* ── terrain bake ───────────────────────────────────────────────────────── */

  private bake(): void {
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        this.heights[j * this.res + i] = this.rawHeight(x, z);
      }
    }
    // Order matters. The lake basin defines the low point of the watershed, so
    // it resolves first; the quarry is an excavation into already-final grade;
    // the creek has to know both before it can run downhill into the lake.
    this.carveLakeBasin();
    this.carveQuarry();
    this.buildCreekProfile();
    this.carveChannel(this.layout.creek, this.creekBedY!);
    this.buildRampProfile();
    // zone flattening + path smoothing (2 iterations to relax seams)
    for (let iter = 0; iter < 2; iter++) {
      this.flattenZones();
      this.smoothAlongPaths();
    }
    // Enforced last, because every pass above can raise ground: the creek carve
    // lifts terrain toward its banks, `smoothAlongPaths` averages the shoreline
    // with the bank behind it, and `flattenZones` levels the dock apron. Any of
    // them can push a cell inside the shore polygon back above the waterline,
    // which reads as a dry patch floating in the lake. Rather than tune each
    // pass to be individually safe — which breaks again the next time one is
    // touched — the invariant "inside the shoreline is under water" is asserted
    // once, at the end, where nothing can subsequently violate it.
    this.enforceLakeBed();
  }

  /**
   * Clamp every cell inside the shoreline to below the waterline.
   *
   * The clamp is depth-aware rather than a flat ceiling: right at the shore it
   * only needs to dip under the surface, so the shelving beach survives, while
   * further in it must respect the bowl. Only cells that actually violate the
   * invariant are touched, so this cannot flatten a correctly-carved basin.
   */
  private enforceLakeBed(): void {
    const shore = this.layout.lake.shore;
    const y = this.layout.lake.y;
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        const sd = polySdf(shore, x, z);
        if (sd >= 0) continue;
        const dep = -sd;
        // 0.25 m under at the very edge, deepening as you go in
        const ceil = y - 0.25 - Math.min(6.0, Math.pow(dep, 0.8) * 0.55);
        const idx = j * this.res + i;
        if (this.heights[idx] > ceil) this.heights[idx] = ceil;
      }
    }
  }

  /**
   * Regional elevation. The map is read as a watershed: the North Ridge is the
   * high ground, the whole basin drains south into Pine Lake, and the eastern
   * shelf (cabin / rock formation) sits a storey above the central valley.
   * This is the reason the world is navigable without a compass — downhill is
   * always toward the lake, and the ridge is always uphill.
   */
  private regionalGrade(x: number, z: number): number {
    // north(-z) high -> south(+z) low, eased so the fall is not a uniform ramp
    const n = clamp01((-z + 224) / 448);            // 1 at far north, 0 at far south
    let h = -8 + Math.pow(n, 1.35) * 40;
    // eastern shelf: the cabin/rocks stand is raised and drier
    h += smooth01((x - 40) / 150) * 9.5;
    // the central valley the junction sits in — a shallow trough running south
    h -= Math.exp(-Math.pow((x + 6) / 74, 2)) * 5.0;
    return h;
  }

  /** raw terrain height before basin/excavation/clearing edits */
  private rawHeight(x: number, z: number): number {
    const r = this.rng;
    let h = this.regionalGrade(x, z);
    h += r.fbm2(x * 0.0062, z * 0.0062, 4) * 8.0;        // broad rolling hills
    h += r.fbm2(x * 0.021 + 7.7, z * 0.021, 3) * 2.4;    // medium detail
    h += r.fbm2(x * 0.075 - 3.1, z * 0.075, 2) * 0.7;    // fine breakup

    // North Ridge: a real dome, so it reads as a summit and not just "north"
    const rg = landmark('ridge');
    const dr = Math.hypot((x - rg.x) * 0.72, z - rg.z);
    h += Math.exp(-Math.pow(dr / 78, 2)) * 22.0;
    // and a ridgeline crest running east-west along it, broken by noise
    h += Math.exp(-Math.pow((z - rg.z + 6) / 26, 2)) * (7.5 + r.noise1(x * 0.021) * 4.5);

    // Watchtower knoll. A fire lookout is sited on high ground — that is the
    // entire point of one, and the survey map puts this tower in the middle of
    // the valley's old-growth stand where matureConifers run 40-55 m tall. On
    // flat valley grade the cab tops out around 29 m, i.e. *below its own
    // canopy*, and the offline sightline check measured it as findable from only
    // 2.2% of the world — a wayfinding beacon you cannot see. Raising the siting
    // ground rather than stretching the structure keeps the tower's proportions
    // believable and gives the climb somewhere to arrive.
    const tw = landmark('tower');
    const dt = Math.hypot((x - tw.x) * 0.9, (z - tw.z) * 1.1);
    h += Math.exp(-Math.pow(dt / 52, 2)) * 15.0;

    // Rock Formation: granite outcrop breaking the canopy
    const rk = landmark('rocks');
    const dk = Math.hypot((x - rk.x) * 1.15, (z - rk.z) * 0.85);
    h += Math.exp(-Math.pow(dk / 40, 2)) * 13.0;

    // quarry spoil shelf: the excavation cuts into raised ground, which is why
    // its walls are tall on three sides and breached on the fourth
    const q = landmark('quarry');
    const dq = Math.hypot(x - q.x, (z - q.z) * 1.1);
    h += Math.exp(-Math.pow(dq / 86, 2)) * 12.5;

    // rim ridgeline so the world edge reads as terrain, not a wall
    const d = Math.max(Math.abs(x), Math.abs(z)) / this.half;
    h += smooth01((d - 0.84) / 0.16) * 20.0;
    return h;
  }

  /**
   * Pine Lake basin. Cut from the traced shoreline polygon rather than a
   * circle: the west arm's shallow reed shelf and the pinched south end are
   * what make the water read as a filled basin, and they give the shore trail
   * its awkward turns.
   */
  private carveLakeBasin(): void {
    const shore = this.layout.lake.shore;
    const y = this.layout.lake.y;
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        const sd = polySdf(shore, x, z);
        if (sd > 30) continue;
        const idx = j * this.res + i;
        if (sd <= 0) {
          // Bowl floor. This is a `min`, not a lerp, and that matters: a lerp
          // leaves the shallow shelf part-way between the old grade and the
          // bed, so the first few metres inside the shoreline can sit *above*
          // the waterline — a lake with dry patches in it. Clamping instead
          // guarantees every point inside the shore polygon is submerged,
          // while the concave profile still gives a wadeable shelving beach
          // rather than a bathtub step.
          const dep = -sd;
          const floor = y - 0.35 - Math.min(7.2, Math.pow(dep, 0.78) * 0.95);
          this.heights[idx] = Math.min(this.heights[idx], floor);
        } else {
          // beach + bank: rise away from the waterline
          const t = 1 - smooth01(sd / 30);
          const bank = y + 0.35 + Math.pow(sd / 30, 0.72) * 9.0;
          this.heights[idx] = this.heights[idx] * (1 - t) + bank * t;
        }
      }
    }
  }

  /**
   * The Old Quarry. Benched excavation walls stepping down to a flat floor,
   * cut from the lobed rim polygon. The terraces are the point: a smooth cone
   * would read as a crater, while risers and flat benches read as something
   * that was dug in stages by people who then left.
   */
  private carveQuarry(): void {
    const rim = this.layout.quarryRim;
    const q = landmark('quarry');
    // grade of the ground the excavation was dug into, sampled at the rim
    let rimY = 0;
    for (const p of rim) rimY += this.sampleGrid(p.x, p.z);
    rimY /= rim.length;
    const floorY = rimY - QUARRY_FLOOR_DEPTH;
    const rn = this.rng.fork(0x2B77);

    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        const sd = polySdf(rim, x, z);
        if (sd > 26) continue;
        const idx = j * this.res + i;
        if (sd < 0) {
          const dep = -sd;
          // 3 benches over the first 22 m in from the rim, then the floor
          // Terraces. The wobble is applied to *where the bench edge falls*,
          // not to the bench elevation: perturbing the height directly tilts
          // every bench into a ramp and the excavation reads as a smooth
          // crater again. Perturbing the radial coordinate instead keeps each
          // bench dead level (which is what makes it read as cut by machines)
          // while making the terrace *outlines* wander irregularly in plan.
          const jitter = rn.noise2(x * 0.028, z * 0.028) * 2.6;
          const s = clamp01((dep + jitter) / 20);
          const STEPS = 3;
          const si = Math.min(STEPS - 1, Math.floor(s * STEPS));
          const frac = s * STEPS - si;
          // sharp riser on the outer edge (first 30% of the tread), then flat
          const riser = smooth01(frac / 0.3);
          const prog = (si + riser) / STEPS;
          const target = rimY - QUARRY_FLOOR_DEPTH * clamp01(prog);
          // rubble and standing-water hollows on the floor
          const rubble = dep > 22 ? rn.fbm2(x * 0.09, z * 0.09, 2) * 0.85 : 0;
          this.heights[idx] = Math.min(this.heights[idx], target + rubble);
          if (dep > 24) this.heights[idx] = Math.min(this.heights[idx], floorY + rubble);
        } else {
          // spoil lip: a low berm thrown up outside the rim
          const t = 1 - smooth01(sd / 26);
          this.heights[idx] += t * (1.6 + rn.noise2(x * 0.05, z * 0.05) * 1.4);
        }
      }
    }
    void q;
  }

  /**
   * The haul ramp — the one place the quarry floor is reachable on foot.
   * Without it the excavation is a hole to look into; with it, it is a place
   * with an inside, and the walk down is the moment the walls close over you.
   */
  private buildRampProfile(): void {
    const pts = QUARRY_RAMP_PX.map(p => pxToWorld(p[0], p[1]));
    // densify so the carve is smooth
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
      const t = i / (path.length - 1);
      // eased descent: gentler at the top where you commit, steeper below
      prof[i] = topY + (endY - topY) * smooth01(t);
    }
    this.rampBedY = prof;
    this.carveChannel(
      { path, bedWidth: 3.2, bankWidth: 9.0, depth: 0 },
      prof,
    );
  }

  /**
   * Resolve the creek bed's elevation profile.
   *
   * Water only flows downhill, so the bed cannot simply track the raw terrain —
   * every local bump would become an uphill stretch. Instead we sample the raw
   * grade along the centreline and then force it monotonic by a downstream
   * running-minimum pass, injecting the waterfall as an explicit extra drop.
   * The result: a bed guaranteed non-increasing from source to lake, with one
   * visible vertical break.
   */
  private buildCreekProfile(): void {
    const c = this.layout.creek;
    const n = c.path.length;
    const prof = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = c.path[i];
      prof[i] = this.sampleGrid(p.x, p.z) - c.depth;
    }
    if (c.fall) {
      for (let i = c.fall.index; i < n; i++) {
        const k = Math.min(1, (i - c.fall.index) / c.fall.span);
        prof[i] -= c.fall.height * smooth01(k);
      }
    }
    // monotone downhill: running minimum with a guaranteed minimum gradient
    for (let i = 1; i < n; i++) {
      const seg = Math.hypot(c.path[i].x - c.path[i - 1].x, c.path[i].z - c.path[i - 1].z);
      const cap = prof[i - 1] - seg * 0.012;   // ~1.2% minimum fall
      if (prof[i] > cap) prof[i] = cap;
    }
    // Terminate into the lake surface so the creek visibly feeds it.
    //
    // This has to be an *affine re-anchor*, not an additive ramp. Adding
    // `lift * smooth01(i/n)` is monotonically increasing in i, so it fights the
    // fall we just guaranteed and reintroduces uphill stretches wherever the
    // ramp climbs faster than the bed drops — water running backwards up its
    // own channel. Rescaling about the source keeps the source fixed, lands the
    // mouth exactly on target, and — because the scale factor is positive —
    // provably preserves the monotonicity of every segment.
    // The mouth must sit *below* the lake surface, not above it. Targeting
    // `lake.y + 1.1` put the creek bed 1.1 m proud of the water it drains into,
    // so the channel carve then lifted the lake bed around the inflow back above
    // the waterline — dry ground in the middle of the lake. A submerged mouth is
    // also just correct: a stream enters a lake underwater.
    const target = this.layout.lake.y - 0.5;
    const src = prof[0], mouth = prof[n - 1];
    if (mouth < target && src > target + 1e-3) {
      const k = (src - target) / (src - mouth);          // > 0, so order-preserving
      for (let i = 0; i < n; i++) prof[i] = src - (src - prof[i]) * k;
    }
    this.creekBedY = prof;
  }

  /** raw bilinear read of the height grid (used during baking, pre-carve) */
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

  /**
   * Carve a channel: a V-to-U cross-section blended into the existing grade.
   * Inside `bedWidth` the ground is pinned to the supplied bed profile; out to
   * `bankWidth` it lerps back to the original terrain along a smoothstep, which
   * produces real banks the player has to walk down rather than a trench.
   */
  private carveChannel(c: CarvedChannel, prof: Float32Array): void {
    const segs = Math.max(1, c.path.length - 1);
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        const q = polylineDist(c.path, x, z);
        if (q.dist > c.bankWidth) continue;
        const idx = j * this.res + i;
        const fi = q.t * segs;
        const i0 = Math.min(prof.length - 1, Math.floor(fi));
        const i1 = Math.min(prof.length - 1, i0 + 1);
        const bedY = prof[i0] + (prof[i1] - prof[i0]) * (fi - i0);
        let target: number;
        if (q.dist <= c.bedWidth) {
          target = bedY;
        } else {
          const k = smooth01((q.dist - c.bedWidth) / (c.bankWidth - c.bedWidth));
          target = bedY + (this.heights[idx] - bedY) * (k * k * (3 - 2 * k));
        }
        const w = 1 - smooth01((q.dist - c.bedWidth) / (c.bankWidth - c.bedWidth) * 0.92);
        this.heights[idx] = this.heights[idx] * (1 - w) + target * w;
      }
    }
  }

  /** bed surface elevation of the creek at the closest point to (x,z) */
  creekBedAt(x: number, z: number): number {
    const c = this.layout.creek;
    const prof = this.creekBedY;
    if (!prof) return this.heightAt(x, z);
    const q = polylineDist(c.path, x, z);
    const segs = Math.max(1, c.path.length - 1);
    const fi = q.t * segs;
    const i0 = Math.min(prof.length - 1, Math.floor(fi));
    const i1 = Math.min(prof.length - 1, i0 + 1);
    return prof[i0] + (prof[i1] - prof[i0]) * (fi - i0);
  }

  creekDist(x: number, z: number): number {
    return polylineDist(this.layout.creek.path, x, z).dist;
  }

  creekParam(x: number, z: number): number {
    return polylineDist(this.layout.creek.path, x, z).t;
  }

  /** true inside the wetted channel — used for footstep surface + scatter veto */
  inCreek(x: number, z: number): boolean {
    return this.creekDist(x, z) < this.layout.creek.bedWidth + 0.6;
  }

  private flattenZones(): void {
    for (const zn of this.layout.zones) {
      // The quarry, lake and ridge ARE terrain features — flattening them would
      // undo the excavation, the basin and the summit. Trailheads are just
      // markers on a path. Only the built/occupied clearings get levelled.
      if (zn.id === 'quarry' || zn.id === 'lake' || zn.id === 'ridge') continue;
      const lmk = LANDMARKS.find(l => l.id === zn.id);
      if (lmk && lmk.kind === 'trailhead') continue;
      // rocks: level a usable apron around the outcrop, not the outcrop itself
      const r = zn.id === 'rocks' ? zn.r * 0.55 : zn.r;
      const ch = this.sampleGrid(zn.x, zn.z);
      const i0 = Math.max(0, Math.floor((zn.x - r + this.half) / this.step));
      const i1 = Math.min(this.res - 1, Math.ceil((zn.x + r + this.half) / this.step));
      const j0 = Math.max(0, Math.floor((zn.z - r + this.half) / this.step));
      const j1 = Math.min(this.res - 1, Math.ceil((zn.z + r + this.half) / this.step));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = -this.half + i * this.step, z = -this.half + j * this.step;
          const d = Math.hypot(x - zn.x, z - zn.z);
          if (d < r) {
            // partial flatten: clearings keep a little grade so they never read
            // as a poured slab
            const t = smooth01((r - d) / (r * 0.6)) * 0.86;
            const idx = j * this.res + i;
            this.heights[idx] = this.heights[idx] * (1 - t) + ch * t;
          }
        }
      }
    }
  }

  /**
   * Grade the paths into the terrain. Graded road gets a wide, strongly
   * smoothed corridor; a faint route barely gets levelled at all, so it still
   * has roots and steps in it. That difference is legible underfoot.
   */
  private smoothAlongPaths(): void {
    const strength: Record<PathClass, number> = { main: 0.78, trail: 0.55, faint: 0.3 };
    const reach: Record<PathClass, number> = { main: 7.0, trail: 5.0, faint: 3.4 };
    for (const edge of this.layout.paths) {
      const w = reach[edge.cls], s = strength[edge.cls];
      for (const tp of edge.pts) {
        const i0 = Math.max(1, Math.floor((tp.x - w + this.half) / this.step));
        const i1 = Math.min(this.res - 2, Math.ceil((tp.x + w + this.half) / this.step));
        const j0 = Math.max(1, Math.floor((tp.z - w + this.half) / this.step));
        const j1 = Math.min(this.res - 2, Math.ceil((tp.z + w + this.half) / this.step));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const x = -this.half + i * this.step, z = -this.half + j * this.step;
            const d = Math.hypot(x - tp.x, z - tp.z);
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

  /** bilinear height sample — used by controller, nav, placement */
  heightAt(x: number, z: number): number {
    const fx = (x + this.half) / this.step, fz = (z + this.half) / this.step;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= this.res - 1 || j >= this.res - 1) {
      const cx = Math.max(0, Math.min(this.res - 1, i));
      const cz = Math.max(0, Math.min(this.res - 1, j));
      return this.heights[cz * this.res + cx];
    }
    const tx = fx - i, tz = fz - j;
    const a = this.heights[j * this.res + i], b = this.heights[j * this.res + i + 1];
    const c = this.heights[(j + 1) * this.res + i], d = this.heights[(j + 1) * this.res + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  zoneAt(x: number, z: number): Zone | null {
    let best: Zone | null = null, bestD = Infinity;
    for (const zn of this.layout.zones) {
      const d = Math.hypot(x - zn.x, z - zn.z);
      if (d < zn.r && d < bestD) { best = zn; bestD = d; }
    }
    return best;
  }

  /** true inside the lake's waterline (polygon, inset so the shore is walkable) */
  inLake(x: number, z: number): boolean {
    return polySdf(this.layout.lake.shore, x, z) < -1.5;
  }

  /** signed distance to the shoreline: negative in the water */
  lakeSdf(x: number, z: number): number {
    return polySdf(this.layout.lake.shore, x, z);
  }

  /** signed distance to the quarry rim: negative inside the excavation */
  quarrySdf(x: number, z: number): number {
    return polySdf(this.layout.quarryRim, x, z);
  }

  /** true where the player is down inside the excavation */
  inQuarry(x: number, z: number): boolean {
    return this.quarrySdf(x, z) < -2;
  }

  /** local slope magnitude (rise/run) — shared by nav, scatter and footing */
  slopeAt(x: number, z: number): number {
    const e = 2.0;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.hypot(dx, dz) / (2 * e);
  }
}

function smooth01(t: number): number {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
function clamp01(t: number): number { return t < 0 ? 0 : t > 1 ? 1 : t; }
