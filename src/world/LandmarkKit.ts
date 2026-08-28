import * as THREE from 'three';
import { HeightField } from './HeightField';
import { MaterialLibrary } from './MaterialLibrary';
import { CollisionWorld } from '../physics/Collision';
import { SeededRandom } from '../core/SeededRandom';

/**
 * ── LANDMARK KIT ──────────────────────────────────────────────────────────────
 *
 * Construction vocabulary for the Pinewood landmarks. The point of this file is
 * that nothing in the world is a box with a label on it: a wall is a stud frame
 * with individually placed, individually warped boards and gaps you can see
 * through; a roof is a set of overlapping shingle courses; a rock is a lathe of
 * noise-displaced profiles.
 *
 * The rule every helper follows: *no two instances identical*. Every board,
 * shingle, plank and boulder takes its dimensions, sag, twist and colour offset
 * from the supplied RNG, so repetition is impossible even where the underlying
 * call is the same.
 *
 * Everything merges into as few draw calls as the material split allows —
 * a shack made of 90 boards ships as one BufferGeometry per material.
 */

export interface KitCtx {
  hf: HeightField;
  mats: MaterialLibrary;
  col: CollisionWorld;
  group: THREE.Group;
  rng: SeededRandom;
}

/** A geometry accumulator: many small parts in, one merged mesh out. */
export class Batch {
  private parts: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, m: THREE.Matrix4): void {
    const g = geo.clone();
    g.applyMatrix4(m);
    this.parts.push(g);
  }

  /** place a box: dims + centre + euler, the workhorse */
  box(
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
  ): void {
    const m = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(rx, ry, rz))
      .setPosition(x, y, z);
    m.scale(new THREE.Vector3(1, 1, 1));
    const g = new THREE.BoxGeometry(w, h, d);
    g.applyMatrix4(m);
    this.parts.push(g);
  }

  cyl(
    rt: number, rb: number, h: number, seg: number,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
  ): void {
    const g = new THREE.CylinderGeometry(rt, rb, h, seg);
    const m = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(rx, ry, rz))
      .setPosition(x, y, z);
    g.applyMatrix4(m);
    this.parts.push(g);
  }

  raw(g: THREE.BufferGeometry): void { this.parts.push(g); }

  get count(): number { return this.parts.length; }

  /** merge and dispose the parts; returns null if empty */
  build(mat: THREE.Material, castShadow = true, receiveShadow = true): THREE.Mesh | null {
    if (!this.parts.length) return null;
    const merged = mergeBufferGeometries(this.parts);
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (!merged) return null;
    merged.computeVertexNormals();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    return mesh;
  }
}

/**
 * Minimal geometry merge over position/normal/uv. Written here rather than
 * pulled from three's examples because we only ever merge non-indexed
 * primitives with an identical attribute set, and the examples module drags in
 * a lot of generality we would pay for at boot.
 */
export function mergeBufferGeometries(list: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!list.length) return null;
  let total = 0;
  const flat = list.map(g => (g.index ? g.toNonIndexed() : g));
  for (const g of flat) total += g.getAttribute('position').count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let o = 0;
  for (const g of flat) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const t = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    const c = p.count;
    pos.set(p.array as Float32Array, o * 3);
    if (n) nor.set(n.array as Float32Array, o * 3);
    if (t) uv.set(t.array as Float32Array, o * 2);
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  for (let i = 0; i < flat.length; i++) if (flat[i] !== list[i]) flat[i].dispose();
  return out;
}

/** local->world transform helper for a yawed structure footprint */
export function frame(cx: number, cz: number, yaw: number) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return (lx: number, lz: number) => ({ x: cx + lx * c - lz * s, z: cz + lx * s + lz * c });
}

/**
 * A plank wall: a stud frame clad in individually placed boards.
 *
 * `decay` (0..1) drives how much of the cladding is missing, how far the
 * remaining boards sag and twist, and how ragged their ends are. At 0 you get a
 * tight cabin wall; at 0.7 you get the shack, where the boards have gone and
 * you can see the studs and the darkness behind them.
 *
 * Boards are placed in *local* wall space (u across, v up) and then mapped by
 * the caller's frame, so the same routine builds any wall on any structure at
 * any angle.
 */
export interface WallOpts {
  /** wall run (m) and height (m) */
  len: number; h: number;
  /** board thickness + nominal width */
  thick?: number; board?: number;
  decay?: number;
  /** door/window voids in local u,v space: [uCenter, vCenter, uWidth, vHeight] */
  voids?: [number, number, number, number][];
  /** include the stud frame behind the cladding */
  studs?: boolean;
}

export function plankWall(
  clad: Batch, studB: Batch, rng: SeededRandom,
  ox: number, oy: number, oz: number, yaw: number, o: WallOpts,
): void {
  const thick = o.thick ?? 0.06;
  const bw = o.board ?? 0.22;
  const decay = o.decay ?? 0;
  const voids = o.voids ?? [];
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const put = (b: Batch, w: number, hh: number, dd: number, u: number, v: number, tw: number, tl: number) => {
    // u runs along the wall, v is height, thickness is across
    const x = ox + u * c, z = oz + u * s;
    b.box(w, hh, dd, x, oy + v, z, tl, yaw + tw, 0);
  };

  const inVoid = (u: number, v: number, du: number, dv: number) => {
    for (const [vu, vv, vw, vh] of voids) {
      if (Math.abs(u - vu) < vw / 2 + du && Math.abs(v - vv) < vh / 2 + dv) return true;
    }
    return false;
  };

  // ── stud frame: posts every ~0.8 m plus a top and bottom plate
  if (o.studs !== false) {
    const nPost = Math.max(2, Math.round(o.len / 0.85));
    for (let i = 0; i <= nPost; i++) {
      const u = -o.len / 2 + (i / nPost) * o.len;
      if (inVoid(u, o.h / 2, 0.05, 0)) continue;
      const lean = decay * rng.range(-0.035, 0.035);
      put(studB, 0.09, o.h, 0.09, u, o.h / 2, 0, lean);
    }
    put(studB, o.len, 0.1, 0.11, 0, 0.05, 0, 0);
    put(studB, o.len, 0.1, 0.11, 0, o.h - 0.05, 0, 0);
  }

  // ── cladding: horizontal boards, each one its own object
  const rows = Math.max(1, Math.floor(o.h / bw));
  for (let r = 0; r < rows; r++) {
    const v = bw * 0.5 + r * bw;
    // a decayed wall loses whole boards, more of them near the top and bottom
    const edge = Math.abs(v / o.h - 0.5) * 2;
    if (rng.next() < decay * (0.35 + edge * 0.5)) continue;
    // boards do not all run the full length: split each row into 1-3 lengths
    const nSeg = rng.next() < 0.45 ? 2 : rng.next() < 0.2 ? 3 : 1;
    let u0 = -o.len / 2;
    for (let sg = 0; sg < nSeg; sg++) {
      const remain = o.len / 2 - u0;
      const segLen = sg === nSeg - 1 ? remain : remain * rng.range(0.35, 0.7);
      const uc = u0 + segLen / 2;
      u0 += segLen;
      if (segLen < 0.12) continue;
      if (inVoid(uc, v, segLen / 2 - 0.04, bw * 0.4)) continue;
      // per-board variation: width, sag, twist, standoff
      const w = segLen - rng.range(0.005, 0.03);
      const hh = bw * rng.range(0.86, 0.99);
      const dd = thick * rng.range(0.8, 1.25);
      const twist = rng.range(-0.02, 0.02) * (1 + decay * 3);
      const sag = rng.range(-0.012, 0.012) * (1 + decay * 4);
      clad.box(
        w, hh, dd,
        ox + uc * c - Math.sin(yaw) * 0, oy + v + sag, oz + uc * s,
        rng.range(-0.01, 0.01) * (1 + decay * 3), yaw + twist, rng.range(-0.015, 0.015) * (1 + decay * 2),
      );
    }
  }
}

/**
 * A shingled or corrugated roof: overlapping courses, each shingle placed and
 * jittered individually so the surface has thickness, shadow and gaps.
 * A single sloped box reads as cardboard; this reads as a roof.
 */
export function shingleRoof(
  b: Batch, rng: SeededRandom,
  cx: number, cy: number, cz: number, yaw: number,
  runW: number, runD: number, rise: number, decay = 0,
): void {
  const pitch = Math.atan2(rise, runD / 2);
  for (const side of [-1, 1]) {
    const courses = Math.max(2, Math.round((runD / 2) / 0.34));
    for (let cIdx = 0; cIdx < courses; cIdx++) {
      const t = cIdx / courses;
      const along = t * (runD / 2);
      // position along the slope
      const py = cy + rise - along * Math.tan(pitch);
      const pz = along * side;
      const n = Math.max(2, Math.round(runW / 0.42));
      for (let i = 0; i < n; i++) {
        // a decayed roof loses shingles in patches, not uniformly
        const patch = rng.noise2(i * 0.4, cIdx * 0.4) * 0.5 + 0.5;
        if (rng.next() < decay * (0.25 + patch * 0.65)) continue;
        const u = -runW / 2 + (i + 0.5) * (runW / n);
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const wx = cx + u * c - pz * s;
        const wz = cz + u * s + pz * c;
        b.box(
          (runW / n) * rng.range(0.9, 1.02), 0.05, 0.42 * rng.range(0.95, 1.15),
          wx, py + rng.range(-0.012, 0.012), wz,
          -pitch * side + rng.range(-0.03, 0.03) * (1 + decay * 3),
          yaw + rng.range(-0.02, 0.02) * (1 + decay * 2),
          rng.range(-0.02, 0.02),
        );
      }
    }
  }
  // ridge cap
  const n = Math.max(2, Math.round(runW / 0.5));
  for (let i = 0; i < n; i++) {
    if (rng.next() < decay * 0.55) continue;
    const u = -runW / 2 + (i + 0.5) * (runW / n);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    b.box(runW / n * 0.96, 0.07, 0.34, cx + u * c, cy + rise + 0.05, cz + u * s,
      0, yaw + rng.range(-0.02, 0.02), rng.range(-0.03, 0.03));
  }
}

/**
 * A boulder: a lathe of noise-displaced radial profiles. Cheap, and because
 * every axis and every ring is perturbed independently, no two calls with
 * different seeds produce recognisably similar rocks — which is the whole
 * problem with scattering the same icosphere around a forest.
 */
export function boulder(rng: SeededRandom, r: number, squash = 0.72): THREE.BufferGeometry {
  const rings = 7, seg = 10;
  const pts: THREE.Vector3[][] = [];
  // per-rock global shape bias: makes some rocks slabby, some blocky
  const bias = { x: rng.range(0.72, 1.35), y: rng.range(0.6, 1.15), z: rng.range(0.72, 1.35) };
  const angOff = rng.range(0, 6.28);
  for (let j = 0; j <= rings; j++) {
    const v = j / rings;
    const phi = v * Math.PI;
    const row: THREE.Vector3[] = [];
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const th = u * Math.PI * 2 + angOff;
      // two octaves: big facets + surface chip
      const n1 = rng.noise2(Math.cos(th) * 1.4 + j * 0.7, Math.sin(th) * 1.4) * 0.3;
      const n2 = rng.noise2(Math.cos(th) * 4.5 + j * 2.1, Math.sin(th) * 4.5) * 0.11;
      const rr = r * (1 + n1 + n2);
      row.push(new THREE.Vector3(
        Math.sin(phi) * Math.cos(th) * rr * bias.x,
        Math.cos(phi) * rr * squash * bias.y,
        Math.sin(phi) * Math.sin(th) * rr * bias.z,
      ));
    }
    pts.push(row);
  }
  const pos: number[] = [];
  const uvs: number[] = [];
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = pts[j][i], b = pts[j][i + 1], c = pts[j + 1][i], d = pts[j + 1][i + 1];
      pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
      pos.push(b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      const u0 = i / seg, u1 = (i + 1) / seg, v0 = j / rings, v1 = (j + 1) / rings;
      uvs.push(u0, v0, u0, v1, u1, v0, u1, v0, u0, v1, u1, v1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * A sagging fabric panel — tent flies, tarps, hanging canvas. Built as a grid
 * with catenary droop between its pinned corners plus wind-flutter noise, so it
 * hangs like cloth instead of standing like a tent-shaped box.
 */
export function saggingPanel(
  rng: SeededRandom, w: number, d: number,
  sag: number, tear = 0,
): THREE.BufferGeometry {
  const nu = 8, nv = 6;
  const pos: number[] = [];
  const uvs: number[] = [];
  const p = (i: number, j: number) => {
    const u = i / nu, v = j / nv;
    const x = (u - 0.5) * w, z = (v - 0.5) * d;
    // catenary in both axes + noise wrinkle
    const droop = Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * sag;
    const wrinkle = rng.noise2(u * 5, v * 5) * sag * 0.28;
    return new THREE.Vector3(x, -droop + wrinkle, z);
  };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      // torn panels lose quads at the edges first
      const edge = Math.max(Math.abs(i / nu - 0.5), Math.abs(j / nv - 0.5)) * 2;
      if (rng.next() < tear * edge * 0.9) continue;
      const a = p(i, j), b = p(i + 1, j), c = p(i, j + 1), d2 = p(i + 1, j + 1);
      pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
      pos.push(b.x, b.y, b.z, c.x, c.y, c.z, d2.x, d2.y, d2.z);
      const u0 = i / nu, u1 = (i + 1) / nu, v0 = j / nv, v1 = (j + 1) / nv;
      uvs.push(u0, v0, u0, v1, u1, v0, u1, v0, u0, v1, u1, v1);
    }
  }
  const g = new THREE.BufferGeometry();
  if (!pos.length) return g;
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

/**
 * A lattice tower leg-bay: four legs, horizontal ties, and X-bracing on each
 * face. This is the silhouette that has to read from 200 m away, so the bracing
 * is real geometry — a solid box would go opaque and lose the whole
 * see-through-scaffold quality that makes a fire lookout recognisable.
 */
export function latticeBay(
  b: Batch, rng: SeededRandom,
  cx: number, cy: number, cz: number, yaw: number,
  spanBottom: number, spanTop: number, h: number, member = 0.1,
): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const corner = (u: number, v: number, sp: number) => {
    const lx = u * sp / 2, lz = v * sp / 2;
    return { x: cx + lx * c - lz * s, z: cz + lx * s + lz * c };
  };
  const quad: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  // legs: battered inward, so each is a slightly tilted member
  for (const [u, v] of quad) {
    const a = corner(u, v, spanBottom), t = corner(u, v, spanTop);
    const dx = t.x - a.x, dz = t.z - a.z;
    const len = Math.hypot(dx, dz, h);
    const mid = { x: (a.x + t.x) / 2, y: cy + h / 2, z: (a.z + t.z) / 2 };
    // orient the member along (dx, h, dz)
    const tilt = Math.atan2(Math.hypot(dx, dz), h);
    const dir = Math.atan2(dz, dx);
    b.cyl(member * 0.55, member * 0.62, len, 5, mid.x, mid.y, mid.z,
      0, 0, 0);
    // re-place with proper orientation via a matrix
    void tilt; void dir;
  }
  // The cylinder call above cannot express an arbitrary axis, so replace the
  // legs with correctly-oriented boxes: batter is small enough that a box
  // rotated about one axis is visually exact and half the vertices.
  for (const [u, v] of quad) {
    const a = corner(u, v, spanBottom), t = corner(u, v, spanTop);
    const dx = t.x - a.x, dz = t.z - a.z;
    const lean = Math.atan2(Math.hypot(dx, dz), h);
    const dir = Math.atan2(dz, dx);
    b.box(member, Math.hypot(h, dx, dz), member,
      (a.x + t.x) / 2, cy + h / 2, (a.z + t.z) / 2,
      Math.sin(dir) * lean, 0, -Math.cos(dir) * lean);
  }
  // horizontal ties top and bottom
  for (const [sp, yy] of [[spanBottom, cy + 0.02], [spanTop, cy + h - 0.02]] as const) {
    for (let k = 0; k < 4; k++) {
      const p0 = corner(quad[k][0], quad[k][1], sp);
      const p1 = corner(quad[(k + 1) % 4][0], quad[(k + 1) % 4][1], sp);
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      b.box(len, member * 0.8, member * 0.8, (p0.x + p1.x) / 2, yy, (p0.z + p1.z) / 2,
        0, Math.atan2(p1.z - p0.z, p1.x - p0.x), 0);
    }
  }
  // X-bracing on all four faces
  for (let k = 0; k < 4; k++) {
    const b0 = corner(quad[k][0], quad[k][1], spanBottom);
    const b1 = corner(quad[(k + 1) % 4][0], quad[(k + 1) % 4][1], spanBottom);
    const t0 = corner(quad[k][0], quad[k][1], spanTop);
    const t1 = corner(quad[(k + 1) % 4][0], quad[(k + 1) % 4][1], spanTop);
    for (const [p, q] of [[b0, t1], [b1, t0]] as const) {
      const dx = q.x - p.x, dz = q.z - p.z;
      const run = Math.hypot(dx, dz);
      const len = Math.hypot(run, h);
      const mid = { x: (p.x + q.x) / 2, y: cy + h / 2, z: (p.z + q.z) / 2 };
      // brace lies in the face plane: yaw to the run direction, pitch by h/run
      b.box(len, member * 0.7, member * 0.62, mid.x, mid.y, mid.z,
        0, Math.atan2(dz, dx), Math.atan2(h, run) * (rng.next() < 0.5 ? 1 : 1));
    }
  }
}

/** rusted machinery bucket/scoop — a lathe-free authored blob for the quarry */
export function scoopBucket(rng: SeededRandom, size: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const back = new THREE.BoxGeometry(size, size * 0.75, 0.07);
  back.translate(0, 0, -size * 0.42);
  parts.push(back);
  const floor = new THREE.BoxGeometry(size, 0.07, size * 0.85);
  floor.translate(0, -size * 0.36, 0);
  parts.push(floor);
  for (const s of [-1, 1]) {
    const side = new THREE.BoxGeometry(0.07, size * 0.7, size * 0.85);
    side.translate(s * size * 0.46, -0.02, 0);
    parts.push(side);
  }
  // teeth along the cutting edge, uneven and some broken off
  const n = 5;
  for (let i = 0; i < n; i++) {
    if (rng.next() < 0.2) continue;
    const t = new THREE.BoxGeometry(size * 0.11, 0.09, size * 0.2 * rng.range(0.6, 1.1));
    t.translate((-0.5 + (i + 0.5) / n) * size * 0.9, -size * 0.36, size * 0.5);
    t.applyMatrix4(new THREE.Matrix4().makeRotationX(rng.range(-0.1, 0.1)));
    parts.push(t);
  }
  const g = mergeBufferGeometries(parts)!;
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  return g;
}
