import { SeededRandom } from '../core/SeededRandom';

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
  exit: { x: number; z: number };   // fire road gate
  trail: { x: number; z: number }[]; // polyline through POIs
  lake: { x: number; z: number; r: number; y: number };
  /** the creek ravine — carved terrain, shared with ZoneSystem + CreekSystem */
  creek: CarvedChannel;
}

/**
 * Terrain features carved *after* the base noise but *before* zone/trail
 * relaxation. The creek ravine is the only one so far, and it has to be a
 * first-class terrain edit rather than decoration: the player walks it, the nav
 * grid pathfinds it, water sits in it, and fog pools in it — all of which read
 * the same height function.
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
 * The creek centreline, authored as a coarse control polyline then Catmull-Rom
 * resampled with perpendicular noise wander so it never reads as a straight
 * cut. It runs from the high north-east ridge down to the lake in the
 * south-west — i.e. downhill, because water does.
 *
 * Lives here (not in ZoneSystem) because it *carves terrain*: the height
 * function is the single source of truth, so anything that changes ground
 * elevation has to be resolved before the field bakes.
 */
export function buildCreekChannel(r: SeededRandom): CarvedChannel {
  const control = [
    { x: 132, z: -146 }, { x: 98, z: -98 }, { x: 58, z: -52 }, { x: 22, z: -18 },
    { x: -14, z: 6 }, { x: -52, z: 34 }, { x: -84, z: 62 }, { x: -114, z: 88 },
    { x: -134, z: 110 },
  ];
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
      const wob = r.noise1(i * 4.7 + t * 3.3) * 5.5;
      path.push({ x: cx - (dz / pl) * wob, z: cz + (dx / pl) * wob });
    }
  }
  path.push(control[control.length - 1]);
  return {
    path, bedWidth: 2.4, bankWidth: 13.5, depth: 3.4,
    // waterfall about a third down, where the ridge breaks
    fall: { index: Math.floor(path.length * 0.3), height: 4.2, span: 3 },
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

/**
 * Analytic heightfield + world layout. Single source of truth: the terrain mesh,
 * character controller, nav grid and object placement all sample the same height function.
 */
export class HeightField {
  readonly layout: WorldLayout;
  private rng: SeededRandom;
  private res: number;
  private step: number;
  private half: number;
  heights: Float32Array;

  constructor(seed: number) {
    this.rng = new SeededRandom(seed);
    const size = 420;
    const zones: Zone[] = [
      { id: 'station', name: 'Ranger Station', x: -40, z: 30, r: 20 },
      { id: 'quarry', name: 'Quarry Cut', x: 100, z: 45, r: 24 },
      { id: 'tower', name: 'Fire Lookout', x: -95, z: -70, r: 16 },
      { id: 'dock', name: 'Lake Dock', x: -130, z: 105, r: 18 },
      { id: 'mill', name: 'Logging Mill', x: 55, z: -115, r: 22 },
      { id: 'radio', name: 'Radio Relay', x: 150, z: -90, r: 16 },
      { id: 'tunnel', name: 'Rail Tunnel', x: 175, z: 125, r: 20 },
      { id: 'camp', name: 'Campground', x: -35, z: 160, r: 20 },
    ];
    const spawn = { x: -172, z: -28 };
    const exit = { x: 196, z: 6 };
    // trail visits every POI then the exit; curves come from jittered midpoints
    const waypoints = [spawn, ...zones.map(z => ({ x: z.x, z: z.z })), exit];
    const trail: { x: number; z: number }[] = [];
    const tr = this.rng.fork(4242);
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      const segs = 6;
      for (let sIdx = 0; sIdx < segs; sIdx++) {
        const t = sIdx / segs;
        const mx = a.x + (b.x - a.x) * t, mz = a.z + (b.z - a.z) * t;
        // perpendicular wander, keeps trail from ever running dead straight
        const px = -(b.z - a.z), pz = (b.x - a.x);
        const pl = Math.hypot(px, pz) || 1;
        const wob = tr.noise1(i * 7.3 + t * 5.1) * 9;
        trail.push({ x: mx + (px / pl) * wob, z: mz + (pz / pl) * wob });
      }
    }
    trail.push(exit);
    const lake = { x: -148, z: 122, r: 46, y: -3.4 };

    const creek = buildCreekChannel(this.rng.fork(0x517E));

    this.layout = { size, zones, spawn, exit, trail, lake, creek };

    this.res = 160;
    this.half = size / 2;
    this.step = size / (this.res - 1);
    this.heights = new Float32Array(this.res * this.res);
    this.bake();
  }

  /** creek bed elevation profile, sampled once so the bed is monotonically downhill */
  private creekBedY: Float32Array | null = null;

  private bake(): void {
    const { lake } = this.layout;
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        let h = this.rawHeight(x, z);
        // lake basin flatten
        const dl = Math.hypot(x - lake.x, z - lake.z);
        if (dl < lake.r + 18) {
          const t = smooth01((lake.r + 18 - dl) / 18);
          const basin = lake.y - Math.max(0, (lake.r - dl)) * 0.06;
          h = h * (1 - t) + basin * t;
        }
        this.heights[j * this.res + i] = h;
      }
    }
    // The ravine has to be carved BEFORE zone/trail relaxation so the two
    // footbridge crossings sit on already-final banks.
    this.buildCreekProfile();
    this.carveCreek();
    // zone flattening + trail smoothing pass (2 iterations to relax seams)
    for (let iter = 0; iter < 2; iter++) {
      this.flattenZones();
      this.smoothAlongTrail();
    }
  }

  /**
   * Resolve the creek bed's elevation profile.
   *
   * Water only flows downhill, so the bed cannot simply track the raw terrain —
   * every local bump would become an uphill stretch. Instead we sample the raw
   * grade along the centreline and then force it monotonic by a downstream
   * running-minimum pass, injecting the waterfall as an explicit extra drop.
   * The result: a bed that is guaranteed non-increasing from source to lake,
   * with one visible vertical break.
   */
  private buildCreekProfile(): void {
    const c = this.layout.creek;
    const n = c.path.length;
    const prof = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = c.path[i];
      prof[i] = this.sampleGrid(p.x, p.z) - c.depth;
    }
    // extra drop at the fall — accumulated into everything downstream
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
    // terminate into the lake surface so the creek visibly feeds it
    const target = this.layout.lake.y + 1.35;
    if (prof[n - 1] < target) {
      const lift = target - prof[n - 1];
      for (let i = 0; i < n; i++) prof[i] += lift * smooth01(i / (n - 1));
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
   * Carve the ravine: a V-to-U cross-section blended into the existing grade.
   * Inside `bedWidth` the ground is pinned to the bed profile; out to
   * `bankWidth` it lerps back to the original terrain along a smoothstep, which
   * produces real banks the player has to walk down rather than a trench.
   */
  private carveCreek(): void {
    const c = this.layout.creek;
    const prof = this.creekBedY!;
    const segs = Math.max(1, c.path.length - 1);
    for (let j = 0; j < this.res; j++) {
      for (let i = 0; i < this.res; i++) {
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        const q = polylineDist(c.path, x, z);
        if (q.dist > c.bankWidth) continue;
        const idx = j * this.res + i;
        // bed elevation interpolated along the centreline
        const fi = q.t * segs;
        const i0 = Math.min(prof.length - 1, Math.floor(fi));
        const i1 = Math.min(prof.length - 1, i0 + 1);
        const bedY = prof[i0] + (prof[i1] - prof[i0]) * (fi - i0);
        // cross-section: flat bed, then rising banks
        let target: number;
        if (q.dist <= c.bedWidth) {
          target = bedY;
        } else {
          const k = smooth01((q.dist - c.bedWidth) / (c.bankWidth - c.bedWidth));
          // banks rise faster than linear so the ravine has shoulders
          target = bedY + (this.heights[idx] - bedY) * (k * k * (3 - 2 * k));
        }
        // blend weight fades at the very rim so there's no crease
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

  /** distance from the creek centreline */
  creekDist(x: number, z: number): number {
    return polylineDist(this.layout.creek.path, x, z).dist;
  }

  /** 0..1 downstream position along the creek */
  creekParam(x: number, z: number): number {
    return polylineDist(this.layout.creek.path, x, z).t;
  }

  /** true inside the wetted channel — used for footstep surface + scatter veto */
  inCreek(x: number, z: number): boolean {
    return this.creekDist(x, z) < this.layout.creek.bedWidth + 0.6;
  }

  /** raw terrain height before clearing/trail edits */
  private rawHeight(x: number, z: number): number {
    const r = this.rng;
    let h = r.fbm2(x * 0.008, z * 0.008, 4) * 9.0;       // broad rolling hills
    h += r.fbm2(x * 0.03 + 7.7, z * 0.03, 3) * 1.6;      // medium detail
    // ridgelines around the rim so the edge reads as terrain, not a wall
    const d = Math.max(Math.abs(x), Math.abs(z)) / (this.layout.size / 2);
    h += smooth01((d - 0.86) / 0.14) * 14.0;
    // quarry cut: carve into a raised rock shelf
    const q = this.layout.zones[1];
    const dq = Math.hypot(x - (q.x + 16), z - q.z);
    if (dq < 34) {
      const t = smooth01((34 - dq) / 34);
      h += t * 7.0; // shelf
      const cut = Math.max(0, 1 - Math.abs(x - (q.x + 16)) / 10) * smooth01((24 - Math.abs(z - q.z)) / 24);
      h -= cut * 9.5;
    }
    return h;
  }

  private flattenZones(): void {
    for (const zn of this.layout.zones) {
      const ch = this.rawHeight(zn.x, zn.z);
      const i0 = Math.max(0, Math.floor((zn.x - zn.r + this.half) / this.step));
      const i1 = Math.min(this.res - 1, Math.ceil((zn.x + zn.r + this.half) / this.step));
      const j0 = Math.max(0, Math.floor((zn.z - zn.r + this.half) / this.step));
      const j1 = Math.min(this.res - 1, Math.ceil((zn.z + zn.r + this.half) / this.step));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = -this.half + i * this.step, z = -this.half + j * this.step;
          const d = Math.hypot(x - zn.x, z - zn.z);
          if (d < zn.r) {
            const t = smooth01((zn.r - d) / (zn.r * 0.55));
            const idx = j * this.res + i;
            this.heights[idx] = this.heights[idx] * (1 - t) + ch * t;
          }
        }
      }
    }
  }

  private smoothAlongTrail(): void {
    const width = 3.4;
    for (let p = 0; p < this.layout.trail.length; p++) {
      const tp = this.layout.trail[p];
      const i0 = Math.max(1, Math.floor((tp.x - width * 2 + this.half) / this.step));
      const i1 = Math.min(this.res - 2, Math.ceil((tp.x + width * 2 + this.half) / this.step));
      const j0 = Math.max(1, Math.floor((tp.z - width * 2 + this.half) / this.step));
      const j1 = Math.min(this.res - 2, Math.ceil((tp.z + width * 2 + this.half) / this.step));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const x = -this.half + i * this.step, z = -this.half + j * this.step;
          const d = Math.hypot(x - tp.x, z - tp.z);
          if (d < width * 2) {
            const idx = j * this.res + i;
            // neighbor average for gentle grade
            const avg = (this.heights[idx] * 2 + this.heights[idx - 1] + this.heights[idx + 1]
              + this.heights[idx - this.res] + this.heights[idx + this.res]) / 6;
            const t = smooth01((width * 2 - d) / (width * 2)) * 0.7;
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

  /** distance from (x,z) to the trail polyline */
  trailDist(x: number, z: number): number {
    let best = Infinity;
    const t = this.layout.trail;
    for (let i = 0; i < t.length - 1; i++) {
      const ax = t[i].x, az = t[i].z, bx = t[i + 1].x, bz = t[i + 1].z;
      const dx = bx - ax, dz = bz - az;
      const len2 = dx * dx + dz * dz || 1;
      let u = ((x - ax) * dx + (z - az) * dz) / len2;
      u = Math.max(0, Math.min(1, u));
      const px = ax + dx * u, pz = az + dz * u;
      const d = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  zoneAt(x: number, z: number): Zone | null {
    for (const zn of this.layout.zones) {
      if (Math.hypot(x - zn.x, z - zn.z) < zn.r) return zn;
    }
    return null;
  }

  inLake(x: number, z: number): boolean {
    const l = this.layout.lake;
    return Math.hypot(x - l.x, z - l.z) < l.r - 4;
  }
}

function smooth01(t: number): number {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
}
