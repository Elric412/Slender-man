import { HeightField } from '../world/HeightField';
import { CollisionWorld } from '../physics/Collision';

/**
 * Navigation grid over the world. Built once from terrain + static colliders.
 * A* with octile heuristic + straight-line smoothing (string pulling via LOS).
 */
export class NavWorld {
  res: number;
  step: number;
  half: number;
  walk: Uint8Array;      // 1 = walkable
  private g: Float32Array;
  private fScore: Float32Array;
  private cameFrom: Int32Array;
  private closed: Uint8Array;
  private heap: number[] = [];

  constructor(private hf: HeightField, private col: CollisionWorld) {
    this.res = 168;
    this.half = hf.layout.size / 2;
    this.step = hf.layout.size / this.res;
    this.walk = new Uint8Array(this.res * this.res).fill(1);
    this.g = new Float32Array(this.res * this.res);
    this.fScore = new Float32Array(this.res * this.res);
    this.cameFrom = new Int32Array(this.res * this.res);
    this.closed = new Uint8Array(this.res * this.res);
    this.build();
  }

  private build(): void {
    const R = this.res;
    // slope check
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const x = -this.half + (i + 0.5) * this.step;
        const z = -this.half + (j + 0.5) * this.step;
        const h = this.hf.heightAt(x, z);
        const hx = this.hf.heightAt(x + this.step, z);
        const hz = this.hf.heightAt(x, z + this.step);
        const slope = Math.max(Math.abs(hx - h), Math.abs(hz - h)) / this.step;
        if (slope > 0.75) { this.walk[j * R + i] = 0; continue; }
        if (this.hf.inLake(x, z)) { this.walk[j * R + i] = 0; continue; }
      }
    }
    // block cells containing solid colliders
    for (const b of this.col.boxes) {
      if (b.kind === 'entity-block') continue;
      if (b.y1 - b.y0 < 0.8) continue; // low obstacles don't block the entity
      const r = Math.max(b.hx, b.hz) + 0.5;
      const i0 = Math.max(0, Math.floor((b.x - r + this.half) / this.step));
      const i1 = Math.min(R - 1, Math.floor((b.x + r + this.half) / this.step));
      const j0 = Math.max(0, Math.floor((b.z - r + this.half) / this.step));
      const j1 = Math.min(R - 1, Math.floor((b.z + r + this.half) / this.step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        this.walk[j * R + i] = 0;
      }
    }
    // ensure spawn & POI cells walkable (carve small disks)
    const carve = (wx: number, wz: number, rad: number) => {
      const i0 = Math.max(0, Math.floor((wx - rad + this.half) / this.step));
      const i1 = Math.min(R - 1, Math.floor((wx + rad + this.half) / this.step));
      const j0 = Math.max(0, Math.floor((wz - rad + this.half) / this.step));
      const j1 = Math.min(R - 1, Math.floor((wz + rad + this.half) / this.step));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = -this.half + (i + 0.5) * this.step, z = -this.half + (j + 0.5) * this.step;
        if (Math.hypot(x - wx, z - wz) >= rad) continue;
        // Water is never made walkable, no matter who asks. Callers guard their
        // *centre* point, but a carve writes a whole disc — the dock approach
        // runs to the very edge of the lake, so a dry centre one cell from the
        // waterline still reached across it and left walkable cells stranded
        // out in the water. Enforcing it per-cell here makes the rule a
        // property of the operation rather than of each call site.
        if (this.hf.inLake(x, z)) continue;
        this.walk[j * R + i] = 1;
      }
    };
    // Guarantee the landmarks themselves are reachable — but NEVER carve into
    // water. Pine Lake's zone centre is out in the middle of the lake, so the
    // old unconditional carve punched a walkable disc there: an island of
    // walkable cells completely ringed by unwalkable water, which A* can enter
    // only if it starts there. That is exactly why every leg touching the lake
    // reported NO ROUTE. For a water landmark the reachable place is the
    // *shore*, so we carve the nearest dry ground instead.
    for (const zn of this.hf.layout.zones) {
      if (this.hf.inLake(zn.x, zn.z)) { this.carveNearestDry(zn.x, zn.z, carve); continue; }
      carve(zn.x, zn.z, 4);
    }
    carve(this.hf.layout.spawn.x, this.hf.layout.spawn.z, 4);
    carve(this.hf.layout.exit.x, this.hf.layout.exit.z, 5);
    if (this.hf.layout.altExit) {
      carve(this.hf.layout.altExit.x, this.hf.layout.altExit.z, 5);
    }
    // Paths are the navigable skeleton of the world. If terrain relaxation or a
    // collider clipped a single cell on a route, A* loses the whole corridor, so
    // we assert the graph the level design promises.
    for (const edge of this.hf.layout.paths) {
      for (const p of edge.pts) {
        if (this.hf.inLake(p.x, p.z)) continue;
        carve(p.x, p.z, Math.max(2.2, this.step * 0.75));
      }
    }
  }

  /**
   * Walk outward from a point in the water until dry, climbable ground is found,
   * then make that patch walkable. Used so lakeside landmarks resolve to a
   * standing spot on the bank rather than a spot in the lake.
   */
  private carveNearestDry(
    wx: number, wz: number,
    carve: (x: number, z: number, r: number) => void,
  ): void {
    for (let ring = 1; ring < 40; ring++) {
      const rad = ring * this.step;
      const steps = Math.max(8, ring * 6);
      for (let a = 0; a < steps; a++) {
        const th = (a / steps) * Math.PI * 2;
        const x = wx + Math.cos(th) * rad, z = wz + Math.sin(th) * rad;
        if (Math.abs(x) > this.half - 4 || Math.abs(z) > this.half - 4) continue;
        if (this.hf.inLake(x, z)) continue;
        if (this.hf.slopeAt(x, z) > 0.7) continue;
        carve(x, z, 4);
        return;
      }
    }
  }

  idx(wx: number, wz: number): number {
    const i = Math.max(0, Math.min(this.res - 1, Math.floor((wx + this.half) / this.step)));
    const j = Math.max(0, Math.min(this.res - 1, Math.floor((wz + this.half) / this.step)));
    return j * this.res + i;
  }

  world(i: number, out: { x: number; z: number }): void {
    out.x = -this.half + (i % this.res + 0.5) * this.step;
    out.z = -this.half + (Math.floor(i / this.res) + 0.5) * this.step;
  }

  /** nearest walkable cell to a world point (spiral search) */
  nearestWalkable(wx: number, wz: number): number {
    let idx = this.idx(wx, wz);
    if (this.walk[idx]) return idx;
    for (let ring = 1; ring < 24; ring++) {
      const ci = idx % this.res, cj = Math.floor(idx / this.res);
      for (let dj = -ring; dj <= ring; dj++) for (let di = -ring; di <= ring; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= this.res || j >= this.res) continue;
        if (this.walk[j * this.res + i]) return j * this.res + i;
      }
    }
    return idx;
  }

  private h(a: number, b: number): number {
    const ax = a % this.res, ay = (a / this.res) | 0;
    const bx = b % this.res, by = (b / this.res) | 0;
    const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
    return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
  }

  /** A* — returns array of cell indices from start to goal (or empty). */
  findPath(sx: number, sz: number, gx: number, gz: number, out: number[]): number[] {
    out.length = 0;
    const start = this.nearestWalkable(sx, sz);
    const goal = this.nearestWalkable(gx, gz);
    if (start === goal) { out.push(goal); return out; }
    this.g.fill(Infinity); this.closed.fill(0);
    this.heap.length = 0;
    this.g[start] = 0;
    this.fScore[start] = this.h(start, goal);
    this.cameFrom[start] = -1;
    this.heapPush(start);
    const R = this.res;
    let iter = 0;
    while (this.heap.length > 0 && iter++ < 20000) {
      const cur = this.heapPop();
      if (cur === goal) {
        // reconstruct
        let n = goal;
        while (n !== -1) { out.push(n); n = this.cameFrom[n]; }
        out.reverse();
        return out;
      }
      if (this.closed[cur]) continue;
      this.closed[cur] = 1;
      const cx = cur % R, cy = (cur / R) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0) continue;
        const nx = cx + di, ny = cy + dj;
        if (nx < 0 || ny < 0 || nx >= R || ny >= R) continue;
        const ni = ny * R + nx;
        if (!this.walk[ni] || this.closed[ni]) continue;
        // no corner cutting through blocked diagonals
        if (di !== 0 && dj !== 0 && (!this.walk[cy * R + nx] || !this.walk[ny * R + cx])) continue;
        const cost = this.g[cur] + (di !== 0 && dj !== 0 ? Math.SQRT2 : 1);
        if (cost < this.g[ni]) {
          this.g[ni] = cost;
          this.cameFrom[ni] = cur;
          this.fScore[ni] = cost + this.h(ni, goal);
          this.heapPush(ni);
        }
      }
    }
    return out;
  }

  private heapPush(i: number): void {
    const h = this.heap;
    h.push(i);
    let c = h.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.fScore[h[p]] <= this.fScore[h[c]]) break;
      const t = h[p]; h[p] = h[c]; h[c] = t; c = p;
    }
  }

  private heapPop(): number {
    const h = this.heap;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < h.length && this.fScore[h[l]] < this.fScore[h[m]]) m = l;
        if (r < h.length && this.fScore[h[r]] < this.fScore[h[m]]) m = r;
        if (m === i) break;
        const t = h[i]; h[i] = h[m]; h[m] = t; i = m;
      }
    }
    return top;
  }
}
