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

    this.layout = { size, zones, spawn, exit, trail, lake };

    this.res = 160;
    this.half = size / 2;
    this.step = size / (this.res - 1);
    this.heights = new Float32Array(this.res * this.res);
    this.bake();
  }

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
    // zone flattening + trail smoothing pass (2 iterations to relax seams)
    for (let iter = 0; iter < 2; iter++) {
      this.flattenZones();
      this.smoothAlongTrail();
    }
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
