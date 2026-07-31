import { HeightField } from '../world/HeightField';

/** Axis-aligned box collider (rotated boxes use yaw) */
export interface BoxCollider {
  x: number; z: number;          // center
  hx: number; hz: number;        // half extents
  yaw: number;                   // rotation
  y0: number; y1: number;        // vertical span
  kind: 'wall' | 'obstacle' | 'prop' | 'entity-block';
}

/** Ground plane / walkable platform override */
export interface Platform {
  x: number; z: number; hx: number; hz: number; yaw: number;
  y: number;                     // top surface height
  step: number;                  // stairs rise (0 = flat)
}

export interface Vaultable {
  x: number; z: number; hx: number; hz: number; yaw: number; topY: number;
}

/**
 * Collision world: static grid hash of boxes + platforms, analytic terrain via HeightField.
 * Also provides LOS raycasts (grid DDA + box slab tests + terrain march).
 */
export class CollisionWorld {
  private hf: HeightField;
  boxes: BoxCollider[] = [];
  platforms: Platform[] = [];
  vaultables: Vaultable[] = [];
  private cell = 8;
  private grid = new Map<number, number[]>();
  private losTested = new Set<number>();   // reused scratch for losClear (no per-call alloc)

  constructor(hf: HeightField) { this.hf = hf; }

  addBox(b: BoxCollider): void { this.boxes.push(b); this.insert(this.boxes.length - 1, b); }
  addPlatform(p: Platform): void { this.platforms.push(p); }
  addVaultable(v: Vaultable): void { this.vaultables.push(v); }

  private insert(idx: number, b: BoxCollider): void {
    const r = Math.max(b.hx, b.hz) + 1;
    const x0 = Math.floor((b.x - r) / this.cell), x1 = Math.floor((b.x + r) / this.cell);
    const z0 = Math.floor((b.z - r) / this.cell), z1 = Math.floor((b.z + r) / this.cell);
    for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
      const key = this.key(gx, gz);
      let arr = this.grid.get(key);
      if (!arr) { arr = []; this.grid.set(key, arr); }
      arr.push(idx);
    }
  }

  /** numeric grid key (no string allocation on the hot path) */
  private key(gx: number, gz: number): number { return (gx + 512) * 1024 + (gz + 512); }

  private nearby(x: number, z: number, out: number[]): number[] {
    out.length = 0;
    const gx = Math.floor(x / this.cell), gz = Math.floor(z / this.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const arr = this.grid.get(this.key(gx + dx, gz + dz));
      if (arr) for (let i = 0; i < arr.length; i++) {
        if (out.indexOf(arr[i]) === -1) out.push(arr[i]);
      }
    }
    return out;
  }

  /** transform world point into box local space */
  private toLocal(b: { x: number; z: number; yaw: number }, px: number, pz: number, out: { x: number; z: number }): void {
    const dx = px - b.x, dz = pz - b.z;
    const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw);
    out.x = dx * c - dz * s;
    out.z = dx * s + dz * c;
  }

  /**
   * Resolve a capsule (as circle) against boxes and map bounds.
   * Mutates pos {x,z}. Returns true if any push occurred.
   */
  private scratch: number[] = [];
  private loc = { x: 0, z: 0 };
  resolve(pos: { x: number; z: number }, radius: number, footY: number, height: number): boolean {
    let pushed = false;
    const list = this.nearby(pos.x, pos.z, this.scratch);
    for (let k = 0; k < list.length; k++) {
      const b = this.boxes[list[k]];
      if (footY + 0.25 > b.y1 || footY + height < b.y0) continue; // vertical miss
      this.toLocal(b, pos.x, pos.z, this.loc);
      const cx = Math.max(-b.hx, Math.min(b.hx, this.loc.x));
      const cz = Math.max(-b.hz, Math.min(b.hz, this.loc.z));
      let dx = this.loc.x - cx, dz = this.loc.z - cz;
      let d2 = dx * dx + dz * dz;
      if (d2 >= radius * radius) continue;
      let push: number, nx: number, nz: number;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        push = radius - d; nx = dx / d; nz = dz / d;
      } else {
        // center inside box — push along smallest penetration axis
        const px = b.hx - Math.abs(this.loc.x), pz = b.hz - Math.abs(this.loc.z);
        if (px < pz) { push = px + radius; nx = this.loc.x >= 0 ? 1 : -1; nz = 0; }
        else { push = pz + radius; nx = 0; nz = this.loc.z >= 0 ? 1 : -1; }
      }
      // rotate normal back to world space
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const wx = nx * c - nz * s, wz = nx * s + nz * c;
      pos.x += wx * push; pos.z += wz * push;
      pushed = true;
    }
    // map bounds
    const half = this.hf.layout.size / 2 - 6;
    pos.x = Math.max(-half, Math.min(half, pos.x));
    pos.z = Math.max(-half, Math.min(half, pos.z));
    return pushed;
  }

  /** ground height at point including platforms */
  groundAt(x: number, z: number, footY: number): number {
    let g = this.hf.heightAt(x, z);
    for (let i = 0; i < this.platforms.length; i++) {
      const p = this.platforms[i];
      if (p.y > footY + 0.6) continue;   // too high to stand on
      this.toLocal(p, x, z, this.loc);
      if (Math.abs(this.loc.x) <= p.hx && Math.abs(this.loc.z) <= p.hz) {
        if (p.y > g) g = p.y;
      }
    }
    return g;
  }

  /** find a vaultable obstacle in front of the player */
  findVault(x: number, z: number, dirX: number, dirZ: number, footY: number): Vaultable | null {
    for (let i = 0; i < this.vaultables.length; i++) {
      const v = this.vaultables[i];
      const dx = v.x - x, dz = v.z - z;
      const dist = Math.hypot(dx, dz);
      if (dist > 1.7) continue;
      if ((dx * dirX + dz * dirZ) / Math.max(dist, 0.01) < 0.5) continue; // must face it
      const top = v.topY;
      if (top - footY > 1.15 || top - footY < 0.25) continue;
      return v;
    }
    return null;
  }

  /**
   * Line of sight test — true if clear. Samples terrain along the ray and
   * slab-tests nearby boxes. Cylinder obstacles (trees) registered as thin boxes.
   */
  losClear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < 0.01) return true;
    // terrain march
    const steps = Math.min(48, Math.ceil(dist / 1.5));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const px = x0 + dx * t, py = y0 + dy * t, pz = z0 + dz * t;
      if (this.hf.heightAt(px, pz) > py) return false;
    }
    // box tests (coarse — only boxes along the segment's midpoint neighborhood chain)
    const segs = Math.ceil(dist / this.cell);
    const tested = this.losTested; tested.clear(); // reused scratch — no per-call Set alloc
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      const px = x0 + dx * t, pz = z0 + dz * t;
      const list = this.nearby(px, pz, this.scratch);
      for (let k = 0; k < list.length; k++) {
        const bi = list[k];
        if (tested.has(bi)) continue;
        tested.add(bi);
        const b = this.boxes[bi];
        if (b.kind === 'entity-block') continue; // foliage soft blockers don't hard-stop LOS
        if (this.segmentHitsBox(b, x0, y0, z0, x1, y1, z1)) return false;
      }
    }
    return true;
  }

  /** slab test vs yaw-rotated box (zero-alloc: no dims array / destructuring) */
  private segmentHitsBox(b: BoxCollider, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
    // rotate endpoints into box space
    const c = Math.cos(-b.yaw), s = Math.sin(-b.yaw);
    const ax = (x0 - b.x) * c - (z0 - b.z) * s, az = (x0 - b.x) * s + (z0 - b.z) * c;
    const bx = (x1 - b.x) * c - (z1 - b.z) * s, bz = (x1 - b.x) * s + (z1 - b.z) * c;
    let tmin = 0, tmax = 1;
    tmin = this.slab(ax, bx - ax, -b.hx, b.hx, tmin);
    if (tmin > (tmax = this.slabMax(ax, bx - ax, -b.hx, b.hx, tmax))) return false;
    const yd = y1 - y0;
    tmin = this.slab(y0, yd, b.y0, b.y1, tmin);
    if (tmin > (tmax = this.slabMax(y0, yd, b.y0, b.y1, tmax))) return false;
    const azd = bz - az;
    tmin = this.slab(az, azd, -b.hz, b.hz, tmin);
    if (tmin > (tmax = this.slabMax(az, azd, -b.hz, b.hz, tmax))) return false;
    return true;
  }
  private slab(p: number, d: number, lo: number, hi: number, tmin: number): number {
    if (Math.abs(d) < 1e-9) return (p < lo || p > hi) ? 2 : tmin; // 2 forces miss via tmin>tmax
    let t1 = (lo - p) / d, t2 = (hi - p) / d;
    if (t1 > t2) { const tt = t1; t1 = t2; }
    return Math.max(tmin, t1);
  }
  private slabMax(p: number, d: number, lo: number, hi: number, tmax: number): number {
    if (Math.abs(d) < 1e-9) return tmax;
    let t1 = (lo - p) / d, t2 = (hi - p) / d;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    return Math.min(tmax, t2);
  }
}
