/**
 * PALEBARK — procedural sculpt.
 *
 * Everything here is closed-form maths: no imported base mesh, no asset-store
 * humanoid, no scanned anything. One `build(density)` call emits a fully
 * skinned, UV-mapped, two-material mesh, and the LOD chain is the same call at
 * three densities so the silhouette never changes shape between levels — only
 * its tessellation does. That is what lets the LODs cross-fade invisibly.
 *
 * Design pillars enforced here (see brief §3):
 *   • 2.62 m standing, shoulders 0.37 m wide  → narrow-for-height silhouette
 *   • arms reach to mid-shin, ~12 % longer than a human of this height
 *   • head is a smooth elongated oval. There is no eye, nose or mouth geometry
 *     anywhere in this file — only sub-3 mm surface topology suggesting where
 *     features "should" be. `faceFeatureCount()` proves it for the QA gate.
 *   • real anatomy under the coat (shoulder caps, ribcage taper, spinal groove,
 *     knee/elbow bulges) so the coat reads as cloth over a body
 *   • hem, cuffs and shoulders carry enough loops for the Verlet cloth solver
 */

import * as THREE from 'three';
import { BindData, bindData, COAT_LINKS, COAT_STRANDS } from './PalebarkSkeleton';

export type Weight = [number, number];   // [boneIndex, weight]

export interface BuildResult {
  geometry: THREE.BufferGeometry;
  triangles: number;
  vertices: number;
  /** group 0 = skin material, group 1 = coat material */
  groupCounts: [number, number];
}

/* ------------------------------------------------------------ mesh builder */

class MeshBuilder {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  /** two index buffers so the groups stay contiguous without a sort */
  idxSkin: number[] = [];
  idxCoat: number[] = [];
  private target: number[] = this.idxSkin;

  use(mat: 'skin' | 'coat'): void { this.target = mat === 'skin' ? this.idxSkin : this.idxCoat; }

  vert(x: number, y: number, z: number, u: number, v: number, w: Weight[], r = 1, g = 1, b = 1): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    // top-4, normalised
    const top = w.slice().sort((a, c) => c[1] - a[1]).slice(0, 4);
    let sum = 0;
    for (const t of top) sum += t[1];
    if (sum <= 1e-6) { top.length = 0; top.push([0, 1]); sum = 1; }
    for (let k = 0; k < 4; k++) {
      this.si.push(top[k] ? top[k][0] : 0);
      this.sw.push(top[k] ? top[k][1] / sum : 0);
    }
    return i;
  }

  tri(a: number, b: number, c: number): void { this.target.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void {
    this.target.push(a, b, c, a, c, d);
  }

  finish(): BuildResult {
    const g = new THREE.BufferGeometry();
    const posArr = new Float32Array(this.pos);
    g.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(this.si), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(this.sw), 4));
    const idx = this.idxSkin.concat(this.idxCoat);
    const IndexArray = posArr.length / 3 > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new IndexArray(idx), 1));
    g.addGroup(0, this.idxSkin.length, 0);
    g.addGroup(this.idxSkin.length, this.idxCoat.length, 1);
    g.computeVertexNormals();
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return {
      geometry: g,
      triangles: idx.length / 3,
      vertices: posArr.length / 3,
      groupCounts: [this.idxSkin.length / 3, this.idxCoat.length / 3],
    };
  }
}

/* --------------------------------------------------------- weight painting */

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

/** squared distance from p to the bind-pose segment bone→child (or the joint if leaf) */
function segDist2(bd: BindData, bone: number, child: number, px: number, py: number, pz: number): number {
  _a.set(bd.world[bone * 3], bd.world[bone * 3 + 1], bd.world[bone * 3 + 2]);
  if (child < 0) return _a.distanceToSquared(_v.set(px, py, pz));
  _b.set(bd.world[child * 3], bd.world[child * 3 + 1], bd.world[child * 3 + 2]);
  _ab.subVectors(_b, _a);
  _ap.set(px - _a.x, py - _a.y, pz - _a.z);
  const l2 = _ab.lengthSq();
  const t = l2 < 1e-9 ? 0 : Math.max(0, Math.min(1, _ap.dot(_ab) / l2));
  _a.addScaledVector(_ab, t);
  return _a.distanceToSquared(_v.set(px, py, pz));
}

interface Candidate { bone: number; child: number; bias: number }

function candidates(bd: BindData, list: (string | [string, string] | [string, string, number])[]): Candidate[] {
  const out: Candidate[] = [];
  for (const e of list) {
    if (typeof e === 'string') {
      out.push({ bone: bd.index.get(e)!, child: -1, bias: 1 });
    } else {
      out.push({
        bone: bd.index.get(e[0])!,
        child: bd.index.get(e[1] as string) ?? -1,
        bias: (e as [string, string, number])[2] ?? 1,
      });
    }
  }
  return out;
}

/** inverse-distance weighting over a restricted candidate set (no cross-limb bleed) */
function idw(bd: BindData, cands: Candidate[], x: number, y: number, z: number, power = 3.2): Weight[] {
  const w: Weight[] = [];
  for (const c of cands) {
    const d2 = segDist2(bd, c.bone, c.child, x, y, z);
    const d = Math.sqrt(d2) + 0.012;
    w.push([c.bone, (c.bias / Math.pow(d, power))]);
  }
  return w;
}

function mixWeights(a: Weight[], b: Weight[], t: number): Weight[] {
  const norm = (w: Weight[]) => {
    let s = 0; for (const e of w) s += e[1];
    return w.map(e => [e[0], e[1] / (s || 1)] as Weight);
  };
  const A = norm(a), B = norm(b);
  const m = new Map<number, number>();
  for (const [i, v] of A) m.set(i, (m.get(i) ?? 0) + v * (1 - t));
  for (const [i, v] of B) m.set(i, (m.get(i) ?? 0) + v * t);
  return [...m.entries()] as Weight[];
}

/* ------------------------------------------------------------ noise helper */

/** cheap deterministic value noise — identical in Node and the browser */
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2147483647);
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
}
function vnoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  let r = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const wgt = (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
    r += hash3(ix + dx, iy + dy, iz + dz) * wgt;
  }
  return r;
}
function fbm(x: number, y: number, z: number, oct = 3): number {
  let s = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { s += vnoise(x * f, y * f, z * f) * a; a *= 0.5; f *= 2.03; }
  return s;
}

/* ------------------------------------------------------------ surface sweep */

interface SweepOpts {
  rings: number;
  radial: number;
  /** spine position at t∈[0,1] */
  center(t: number): { x: number; y: number; z: number };
  /** local radius at (t, angle) — angle in radians, 0 = +Z (front) */
  radius(t: number, ang: number): { rx: number; rz: number };
  /** ring plane: 'xz' sweeps up Y (default), 'xy' sweeps along Z (feet) */
  plane?: 'xz' | 'xy';
  /** optional outward displacement (sculpt detail) in metres */
  detail?(t: number, ang: number, x: number, y: number, z: number): number;
  uv(t: number, u: number): [number, number];
  weights(t: number, ang: number, x: number, y: number, z: number): Weight[];
  color?(t: number, ang: number): [number, number, number];
  capTop?: boolean;
  capBottom?: boolean;
}

function sweep(mb: MeshBuilder, o: SweepOpts): void {
  const rows: number[][] = [];
  for (let i = 0; i <= o.rings; i++) {
    const t = i / o.rings;
    const c = o.center(t);
    const row: number[] = [];
    for (let j = 0; j <= o.radial; j++) {
      const u = j / o.radial;
      const ang = u * Math.PI * 2;
      const { rx, rz } = o.radius(t, ang);
      const sx = Math.sin(ang), cz = Math.cos(ang);
      let x = c.x + sx * rx;
      let y = c.y + (o.plane === 'xy' ? cz * rz : 0);
      let z = c.z + (o.plane === 'xy' ? 0 : cz * rz);
      if (o.detail) {
        const d = o.detail(t, ang, x, y, z);
        x += sx * d;
        if (o.plane === 'xy') y += cz * d; else z += cz * d;
      }
      const [uu, vv] = o.uv(t, u);
      const col = o.color ? o.color(t, ang) : [1, 1, 1];
      row.push(mb.vert(x, y, z, uu, vv, o.weights(t, ang, x, y, z), col[0], col[1], col[2]));
    }
    rows.push(row);
  }
  for (let i = 0; i < o.rings; i++) {
    for (let j = 0; j < o.radial; j++) {
      mb.quad(rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]);
    }
  }
  const cap = (row: number[], t: number, flip: boolean) => {
    const c = o.center(t);
    const [uu, vv] = o.uv(t, 0.5);
    const centre = mb.vert(c.x, c.y, c.z, uu, vv, o.weights(t, 0, c.x, c.y, c.z));
    for (let j = 0; j < o.radial; j++) {
      if (flip) mb.tri(centre, row[j + 1], row[j]);
      else mb.tri(centre, row[j], row[j + 1]);
    }
  };
  if (o.capBottom) cap(rows[0], 0, false);
  if (o.capTop) cap(rows[o.rings], 1, true);
}

/* ------------------------------------------------------------ head surface */

/** Head origin in bind space (crown-to-jaw oval centred above the neck). */
export function headCentre(bd: BindData): THREE.Vector3 {
  const i = bd.index.get('head')!;
  return new THREE.Vector3(bd.world[i * 3], bd.world[i * 3 + 1] + 0.108, bd.world[i * 3 + 2] + 0.004);
}

export const HEAD_RADII = { rx: 0.0985, ry: 0.152, rz: 0.1125 };

/**
 * The head, analytically.
 *
 * `features = false` returns the bare oval; `features = true` adds the entire
 * "where features should be" relief. The difference between the two is the
 * *whole* facial detail of this character, and the QA gate measures it directly
 * (`faceReliefStats`) instead of guessing from the triangle soup. It is capped
 * at +2.6 mm of convex relief and −2.1 mm of concavity: enough for a flashlight
 * to catch a brow shelf, nowhere near enough to read as an eye or a mouth.
 */
export function headPoint(u: number, v: number, features: boolean, out: THREE.Vector3): THREE.Vector3 {
  const phi = v * Math.PI;
  const th = u * TAU;
  let rx = HEAD_RADII.rx, ry = HEAD_RADII.ry, rz = HEAD_RADII.rz;
  const jaw = ss(0.62, 1.0, v);              // narrow, chinless jaw
  rx *= 1 - jaw * 0.30;
  rz *= 1 - jaw * 0.22;
  const backness = Math.max(0, -Math.cos(th));
  rz *= 1 + backness * 0.05 * (1 - jaw);     // cranium fuller at the back
  let x = Math.sin(phi) * Math.sin(th) * rx;
  let y = Math.cos(phi) * ry;
  let z = Math.sin(phi) * Math.cos(th) * rz;
  if (features) {
    const uc = u > 0.5 ? 1 - u : u;
    const front = Math.max(0, Math.cos(th));
    const faceMask = Math.pow(front, 2.2);
    const brow = Math.exp(-Math.pow((v - 0.455) / 0.055, 2)) * faceMask * 0.0024;
    const ridge = Math.exp(-Math.pow(uc / 0.045, 2))
      * ss(0.42, 0.58, v) * (1 - ss(0.60, 0.72, v)) * 0.0020;
    const orbital = -Math.exp(-Math.pow((uc - 0.085) / 0.045, 2))
      * Math.exp(-Math.pow((v - 0.50) / 0.045, 2)) * faceMask * 0.0019;
    const cheek = -Math.exp(-Math.pow((v - 0.60) / 0.09, 2)) * faceMask * 0.0014;
    const micro = fbm(x * 90, y * 90, z * 90, 3) * 0.0008;
    const disp = brow + ridge + orbital + cheek + micro;
    const nl = Math.hypot(x, y, z) || 1;
    x += (x / nl) * disp; y += (y / nl) * disp; z += (z / nl) * disp;
  }
  return out.set(x, y, z);
}

/** Max convex / concave relief anywhere on the face, in metres. QA gate #2. */
export function faceReliefStats(samples = 220): { maxOut: number; maxIn: number } {
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let maxOut = 0, maxIn = 0;
  for (let i = 0; i <= samples; i++) {
    const v = i / samples;
    for (let j = 0; j <= samples; j++) {
      const u = j / samples;
      headPoint(u, v, true, a);
      headPoint(u, v, false, b);
      const d = a.length() - b.length();
      if (d > maxOut) maxOut = d;
      if (d < maxIn) maxIn = d;
    }
  }
  return { maxOut, maxIn: -maxIn };
}

/* --------------------------------------------------------------- the sculpt */

export interface BuildOptions {
  /** tessellation multiplier: 1 ≈ LOD0 hero, 0.55 ≈ LOD1, 0.26 ≈ LOD2 */
  density: number;
}

const TAU = Math.PI * 2;

/** smooth 0→1 */
function ss(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Torso cross-section radius: real anatomy under the coat. */
function bodyRadius(y: number, ang: number): { rx: number; rz: number } {
  // y ranges roughly 1.15 (hip) → 2.12 (shoulder line)
  const t = (y - 1.15) / 0.97;
  const hip = ss(0.25, 0.0, t) * 0.028;
  const rib = Math.exp(-Math.pow((t - 0.68) / 0.30, 2)) * 0.036;
  const waist = -Math.exp(-Math.pow((t - 0.40) / 0.20, 2)) * 0.020;
  const base = 0.108 + hip + rib + waist;
  // shoulders: widen hard in X near the top, stay thin in Z
  const shoulder = ss(0.80, 1.0, t) * 0.085;
  const sx = Math.abs(Math.sin(ang));
  const rx = base + shoulder * sx * sx;
  // spinal groove at the back (ang ≈ π), sternum flat at the front
  const back = Math.max(0, -Math.cos(ang));
  const groove = -Math.pow(back, 6) * 0.012 * ss(0.15, 0.6, t);
  const rz = base * 0.80 + groove;
  return { rx, rz };
}

function coatRadius(y: number, ang: number, flare: number): { rx: number; rz: number } {
  const b = bodyRadius(Math.max(1.15, Math.min(2.12, y)), ang);
  const thick = 0.028;
  // below the hips the coat leaves the body and flares — heavy field coat
  const f = ss(1.30, 0.45, y);
  const spread = flare * f * f;
  return { rx: b.rx + thick + spread, rz: b.rz + thick + spread * 0.92 };
}

/**
 * Build the mesh. Deterministic: same density in → byte-identical mesh out
 * (browser or Node), which is what lets the offline GLB exporter and the
 * runtime agree.
 */
export function buildPalebark(opts: BuildOptions): BuildResult {
  const bd = bindData();
  const mb = new MeshBuilder();
  const D = opts.density;
  const q = (n: number) => Math.max(4, Math.round(n * D));
  const qr = (n: number) => Math.max(6, Math.round(n * D) + (Math.round(n * D) % 2)); // radial: keep even

  const B = (n: string) => bd.index.get(n)!;
  const P = (n: string) => {
    const i = B(n);
    return new THREE.Vector3(bd.world[i * 3], bd.world[i * 3 + 1], bd.world[i * 3 + 2]);
  };

  /* ---------------------------------------------------------------- HEAD */
  // A smooth elongated oval. Nothing on this surface exceeds 3 mm of relief and
  // there is not one concave feature deep enough to read as an eye or a mouth.
  {
    mb.use('skin');
    const headC = headCentre(bd);
    const lat = q(46), lon = qr(56);
    const cands = candidates(bd, [['head', 'head_top', 1.4], ['neck_2', 'head', 0.6]]);
    const rows: number[][] = [];
    const p = new THREE.Vector3();
    for (let i = 0; i <= lat; i++) {
      const v = i / lat;                    // 0 = crown, 1 = under-jaw
      const row: number[] = [];
      for (let j = 0; j <= lon; j++) {
        const u = j / lon;
        headPoint(u, v, true, p);
        const px = headC.x + p.x, py = headC.y + p.y, pz = headC.z + p.z;
        // skin atlas: head occupies u[0,0.58] v[0.34,1]
        const uu = 0.02 + u * 0.54;
        const vv = 0.36 + (1 - v) * 0.62;
        row.push(mb.vert(px, py, pz, uu, vv, idw(bd, cands, px, py, pz, 2.0)));
      }
      rows.push(row);
    }
    for (let i = 0; i < lat; i++) for (let j = 0; j < lon; j++) {
      mb.quad(rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]);
    }
  }

  /* ---------------------------------------------------------------- NECK */
  {
    mb.use('skin');
    const a = P('neck_1'), b = P('head').clone().add(new THREE.Vector3(0, 0.02, 0));
    const cands = candidates(bd, [['neck_1', 'neck_2'], ['neck_2', 'head'], ['chest', 'neck_1', 0.5]]);
    sweep(mb, {
      rings: q(14), radial: qr(26),
      center: (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }),
      radius: (t, ang) => {
        const r = 0.058 - t * 0.010 + Math.exp(-Math.pow((t - 0.15) / 0.3, 2)) * 0.006;
        // sterno-mastoid hint at the front sides
        const sm = Math.pow(Math.max(0, Math.cos(ang)), 3) * 0.003;
        return { rx: r + sm, rz: r * 0.94 };
      },
      detail: (t, ang) => fbm(t * 12, ang * 3, 4.2, 2) * 0.0007,
      uv: (t, u) => [0.02 + u * 0.46, 0.02 + t * 0.28],
      weights: (t, ang, x, y, z) => idw(bd, cands, x, y, z, 2.6),
    });
  }

  /* ------------------------------------------------------- BODY (anatomy) */
  {
    mb.use('skin');
    const cands = candidates(bd, [
      ['pelvis', 'spine_1'], ['spine_1', 'spine_x1'], ['spine_x1', 'spine_2'],
      ['spine_2', 'spine_x2'], ['spine_x2', 'chest'], ['chest', 'neck_1'],
      ['clavicle_l', 'upperarm_l', 0.5], ['clavicle_r', 'upperarm_r', 0.5],
    ]);
    const y0 = 1.14, y1 = 2.14;
    sweep(mb, {
      rings: q(30), radial: qr(30),
      center: (t) => ({ x: 0, y: y0 + (y1 - y0) * t, z: 0.004 * Math.sin(t * 2.4) }),
      radius: (t, ang) => bodyRadius(y0 + (y1 - y0) * t, ang),
      detail: (t, ang, x, y, z) => fbm(x * 26, y * 26, z * 26, 3) * 0.0018,
      uv: (t, u) => [0.60 + u * 0.38, 0.02 + t * 0.30],
      weights: (t, ang, x, y, z) => idw(bd, cands, x, y, z, 2.4),
      color: () => [0.92, 0.9, 0.88],
      capTop: true, capBottom: true,
    });
  }

  /* --------------------------------------------------------------- HANDS */
  for (const side of ['l', 'r'] as const) {
    mb.use('skin');
    const sgn = side === 'r' ? 1 : -1;
    const hand = P(`hand_${side}`);
    const handCands = candidates(bd, [
      [`hand_${side}`, `finger2_a_${side}`, 1.2], [`forearm_x_${side}`, `hand_${side}`, 0.8],
    ]);
    // palm — flattened, long
    sweep(mb, {
      rings: q(14), radial: qr(20),
      center: (t) => ({ x: hand.x, y: hand.y + 0.028 - t * 0.098, z: hand.z + 0.004 }),
      radius: (t) => {
        const w = 0.031 + Math.exp(-Math.pow((t - 0.55) / 0.42, 2)) * 0.014;
        return { rx: w, rz: 0.0155 + t * 0.003 };
      },
      detail: (t, ang, x, y, z) => fbm(x * 60, y * 60, z * 60, 3) * 0.0011,
      uv: (t, u) => [0.62 + u * 0.36, 0.40 + t * 0.24],
      weights: (t, ang, x, y, z) => idw(bd, handCands, x, y, z, 2.6),
      capTop: true,
    });
    // five long fingers, knuckle bulges every phalanx
    for (let f = 0; f < 5; f++) {
      const a = P(`finger${f}_a_${side}`), b = P(`finger${f}_b_${side}`);
      const tipDrop = 0.07 + f * 0.004;
      const fc = candidates(bd, [
        [`finger${f}_a_${side}`, `finger${f}_b_${side}`, 1.3],
        [`finger${f}_b_${side}`, '', 1.2] as unknown as [string, string, number],
        [`hand_${side}`, `finger${f}_a_${side}`, 0.7],
      ].filter(Boolean) as [string, string, number][]);
      sweep(mb, {
        rings: q(16), radial: qr(10),
        center: (t) => {
          const yy = t < 0.5
            ? a.y + (b.y - a.y) * (t / 0.5)
            : b.y - tipDrop * ((t - 0.5) / 0.5);
          const curl = Math.pow(t, 2) * 0.010;   // fingers hang slightly cupped
          return { x: a.x + (b.x - a.x) * Math.min(1, t / 0.5) + sgn * curl * 0.2, y: yy, z: a.z + curl };
        },
        radius: (t) => {
          // knuckle bulges: three swellings down the length = "too many knuckles"
          const k = Math.abs(Math.sin(t * Math.PI * 3.1)) * 0.0022;
          const taper = 0.0092 * (1 - t * 0.48);
          return { rx: taper + k, rz: taper + k * 0.9 };
        },
        detail: (t, ang, x, y, z) => fbm(x * 120, y * 120, z * 120, 2) * 0.0006,
        uv: (t, u) => [0.62 + (f / 5 + u / 5) * 0.36, 0.66 + t * 0.32],
        weights: (t, ang, x, y, z) => idw(bd, fc, x, y, z, 3.0),
        capTop: true,
      });
    }
  }

  /* ------------------------------------------------------------ TROUSERS */
  for (const side of ['l', 'r'] as const) {
    mb.use('coat');
    const hip = P(`thigh_${side}`), knee = P(`shin_${side}`), ankle = P(`foot_${side}`);
    const cands = candidates(bd, [
      [`thigh_${side}`, `thigh_x_${side}`], [`thigh_x_${side}`, `shin_${side}`],
      [`shin_${side}`, `shin_x_${side}`], [`shin_x_${side}`, `foot_${side}`],
      ['pelvis', `thigh_${side}`, 0.5],
    ]);
    sweep(mb, {
      rings: q(26), radial: qr(20),
      center: (t) => {
        // two-segment spine through the knee
        if (t < 0.55) {
          const k = t / 0.55;
          return { x: hip.x + (knee.x - hip.x) * k, y: hip.y + (knee.y - hip.y) * k, z: hip.z + (knee.z - hip.z) * k + Math.sin(k * Math.PI) * 0.006 };
        }
        const k = (t - 0.55) / 0.45;
        return { x: knee.x + (ankle.x - knee.x) * k, y: knee.y + (ankle.y - knee.y) * k, z: knee.z + (ankle.z - knee.z) * k };
      },
      radius: (t, ang) => {
        const thigh = 0.070 - t * 0.012;
        const kneeBulge = Math.exp(-Math.pow((t - 0.55) / 0.07, 2)) * 0.006;
        const calf = Math.exp(-Math.pow((t - 0.72) / 0.12, 2)) * 0.010 * Math.max(0, -Math.cos(ang));
        const cuff = ss(0.90, 1.0, t) * 0.006;
        const r = thigh + kneeBulge + calf + cuff;
        return { rx: r, rz: r * 0.97 };
      },
      detail: (t, ang, x, y, z) => fbm(x * 34, y * 20, z * 34, 3) * 0.0026 - ss(0.5, 0.62, t) * 0.001,
      uv: (t, u) => [(side === 'l' ? 0 : 0.5) + u * 0.5, 0.86 - t * 0.11],
      weights: (t, ang, x, y, z) => idw(bd, cands, x, y, z, 2.8),
      color: () => [0.86, 0.86, 0.88],
      capTop: true,
    });
  }

  /* ---------------------------------------------------------------- SHOES */
  for (const side of ['l', 'r'] as const) {
    mb.use('coat');
    const foot = P(`foot_${side}`);
    const cands = candidates(bd, [[`foot_${side}`, `toe_${side}`, 1.4], [`shin_x_${side}`, `foot_${side}`, 0.5]]);
    sweep(mb, {
      rings: q(18), radial: qr(16),
      plane: 'xy',
      center: (t) => ({
        x: foot.x,
        // sole sits on y≈0; the heel block is taller than the toe box
        y: 0.042 + Math.pow(1 - t, 2.2) * 0.030 - ss(0.80, 1.0, t) * 0.012,
        z: foot.z - 0.062 + t * 0.255,
      }),
      radius: (t, ang) => {
        const w = 0.050 * (0.72 + Math.sin(Math.min(1, t * 1.22) * Math.PI * 0.92) * 0.44)
          * (1 - ss(0.88, 1.0, t) * 0.6);
        const h = 0.042 * (1 - ss(0.55, 1.0, t) * 0.42) - Math.max(0, -Math.cos(ang)) * 0.004;
        return { rx: w, rz: h };
      },
      uv: (t, u) => [(side === 'l' ? 0 : 0.5) + u * 0.5, 0.95 + t * 0.05],
      weights: (t, ang, x, y, z) => idw(bd, cands, x, y, z, 2.6),
      color: () => [0.68, 0.68, 0.70],
      capTop: true, capBottom: true,
    });
  }

  /* ----------------------------------------------------------- COAT SHELL */
  {
    mb.use('coat');
    const spineC = candidates(bd, [
      ['pelvis', 'spine_1'], ['spine_1', 'spine_x1'], ['spine_x1', 'spine_2'],
      ['spine_2', 'spine_x2'], ['spine_x2', 'chest'], ['chest', 'neck_1', 0.7],
      ['clavicle_l', 'upperarm_l', 0.6], ['clavicle_r', 'upperarm_r', 0.6],
    ]);
    const clothC: Candidate[] = [];
    for (let i = 0; i < COAT_STRANDS; i++) {
      for (let k = 0; k < COAT_LINKS; k++) {
        clothC.push({
          bone: B(`coat${i}_${k}`),
          child: k + 1 < COAT_LINKS ? B(`coat${i}_${k + 1}`) : -1,
          bias: 1 + k * 0.35,
        });
      }
    }
    const yTop = 2.155, yHem = 0.415;
    sweep(mb, {
      rings: q(52), radial: qr(46),
      center: (t) => ({ x: 0, y: yTop + (yHem - yTop) * t, z: 0 }),
      radius: (t, ang) => coatRadius(yTop + (yHem - yTop) * t, ang, 0.135),
      detail: (t, ang, x, y, z) => {
        // heavy cloth: broad vertical folds that deepen toward the hem, plus a
        // raised front placket and a faint shoulder seam ridge
        const fold = Math.sin(ang * 7 + fbm(ang * 1.6, t * 2.4, 8.1, 2) * 2.4) * 0.0055 * ss(0.05, 0.75, t);
        const drape = fbm(ang * 2.2, t * 3.4, 1.7, 3) * 0.006 * ss(0.0, 0.6, t);
        const front = Math.pow(Math.max(0, Math.cos(ang)), 24);
        const placket = front * 0.0075 * (1 - ss(0.86, 1.0, t));
        const seam = Math.exp(-Math.pow((t - 0.045) / 0.02, 2)) * 0.0035;
        const hemRoll = ss(0.965, 1.0, t) * 0.004;
        return fold + drape + placket + seam + hemRoll;
      },
      uv: (t, u) => [u, 0.55 - t * 0.55],
      weights: (t, ang, x, y, z) => {
        const spine = idw(bd, spineC, x, y, z, 2.2);
        const cloth = idw(bd, clothC, x, y, z, 2.6);
        return mixWeights(spine, cloth, ss(0.42, 0.72, t));
      },
      capBottom: false,
    });
    // hem underside — a thin inward return so the coat has thickness from below
    const hemRing = q(3);
    sweep(mb, {
      rings: Math.max(2, hemRing), radial: qr(46),
      center: (t) => ({ x: 0, y: yHem - 0.004 + t * 0.03, z: 0 }),
      radius: (t, ang) => {
        const r = coatRadius(yHem, ang, 0.135);
        const k = 1 - t * 0.16;
        return { rx: r.rx * k, rz: r.rz * k };
      },
      uv: (t, u) => [u, 0.002 + t * 0.01],
      weights: (t, ang, x, y, z) => idw(bd, clothC, x, y, z, 2.6),
      color: () => [0.62, 0.62, 0.64],
    });
  }

  /* -------------------------------------------------------------- COLLAR */
  {
    mb.use('coat');
    const cands = candidates(bd, [['chest', 'neck_1', 1.2], ['neck_1', 'neck_2', 0.6]]);
    const y0 = 2.115, y1 = 2.315;
    sweep(mb, {
      rings: q(12), radial: qr(30),
      center: (t) => ({ x: 0, y: y0 + (y1 - y0) * t, z: -0.004 }),
      radius: (t, ang) => {
        // stiff standing collar, open a little at the front
        const front = Math.pow(Math.max(0, Math.cos(ang)), 3);
        const r = 0.098 + t * 0.030 + front * 0.010 * t;
        return { rx: r, rz: r * 1.03 };
      },
      detail: (t, ang) => Math.sin(ang * 14) * 0.0009 + ss(0.85, 1, t) * 0.002,
      uv: (t, u) => [u, 0.87 + t * 0.07],
      weights: (t, ang, x, y, z) => idw(bd, cands, x, y, z, 2.4),
      color: () => [0.94, 0.94, 0.96],
    });
  }

  /* ------------------------------------------------------------- SLEEVES */
  for (const side of ['l', 'r'] as const) {
    mb.use('coat');
    const sh = P(`upperarm_${side}`), el = P(`forearm_${side}`), wr = P(`hand_${side}`);
    const armC = candidates(bd, [
      [`clavicle_${side}`, `upperarm_${side}`, 0.8],
      [`upperarm_${side}`, `upperarm_x_${side}`], [`upperarm_x_${side}`, `forearm_${side}`],
      [`forearm_${side}`, `forearm_x_${side}`], [`forearm_x_${side}`, `hand_${side}`],
      ['chest', `clavicle_${side}`, 0.35],
    ]);
    const clothC = candidates(bd, [
      [`sleeve_a_${side}`, `sleeve_b_${side}`, 1.2], [`sleeve_b_${side}`, '', 1.0] as [string, string, number],
      [`forearm_x_${side}`, `hand_${side}`, 0.6],
    ]);
    sweep(mb, {
      rings: q(30), radial: qr(20),
      center: (t) => {
        if (t < 0.5) {
          const k = t / 0.5;
          return { x: sh.x + (el.x - sh.x) * k, y: sh.y + 0.055 + (el.y - sh.y - 0.055) * k, z: sh.z + (el.z - sh.z) * k };
        }
        const k = (t - 0.5) / 0.5;
        return { x: el.x + (wr.x - el.x) * k, y: el.y + (wr.y - el.y) * k, z: el.z + (wr.z - el.z) * k };
      },
      radius: (t, ang) => {
        // shoulder cap → tapered sleeve → slight cuff flare
        const cap = ss(0.10, 0.0, t) * 0.030;
        const elbow = Math.exp(-Math.pow((t - 0.5) / 0.075, 2)) * 0.005;
        const cuff = ss(0.93, 1.0, t) * 0.008;
        const r = 0.056 - t * 0.010 + cap + elbow + cuff;
        return { rx: r, rz: r * 0.97 };
      },
      detail: (t, ang, x, y, z) => {
        const crease = Math.exp(-Math.pow((t - 0.52) / 0.06, 2)) * Math.sin(ang * 9) * 0.0022;
        return fbm(x * 40, y * 26, z * 40, 3) * 0.0022 + crease;
      },
      uv: (t, u) => [(side === 'l' ? 0 : 0.5) + u * 0.5, 0.75 - t * 0.19],
      weights: (t, ang, x, y, z) => {
        const arm = idw(bd, armC, x, y, z, 2.6);
        const cloth = idw(bd, clothC, x, y, z, 2.8);
        return mixWeights(arm, cloth, ss(0.80, 0.99, t) * 0.85);
      },
      color: () => [0.97, 0.97, 0.99],
    });
  }

  return mb.finish();
}

/* ------------------------------------------------------------- QA helpers */

/**
 * Proof for quality gate #2, measured on the built mesh rather than the
 * analytic surface: no vertex on the frontal head band deviates from its own
 * ring's mean radius by more than 3.5 mm. A modelled eye, nostril or mouth
 * cannot exist inside that tolerance.
 */
export function faceFeatureCount(geometry: THREE.BufferGeometry): number {
  const pos = geometry.getAttribute('position');
  const c = { x: 0, y: 0, z: 0 };
  // head centre from the bind data (kept in sync with headCentre())
  const bd = bindData();
  const hc = headCentre(bd);
  c.x = hc.x; c.y = hc.y; c.z = hc.z;
  // bucket frontal head vertices by height, compare each to its band mean
  const BANDS = 26;
  const sum = new Float64Array(BANDS), cnt = new Float64Array(BANDS);
  const rec: { band: number; r: number }[] = [];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) - c.x, y = pos.getY(i) - c.y, z = pos.getZ(i) - c.z;
    if (y < -0.14 || y > 0.14) continue;
    if (z < 0.045) continue;                                   // frontal only
    const r = Math.hypot(x / HEAD_RADII.rx, y / HEAD_RADII.ry, z / HEAD_RADII.rz);
    if (r < 0.7 || r > 1.3) continue;                          // not head surface
    const band = Math.min(BANDS - 1, Math.max(0, Math.floor((y + 0.14) / 0.28 * BANDS)));
    sum[band] += r; cnt[band]++;
    rec.push({ band, r });
  }
  let bad = 0;
  for (const e of rec) {
    const mean = sum[e.band] / Math.max(1, cnt[e.band]);
    if (Math.abs(e.r - mean) * HEAD_RADII.rz > 0.0035) bad++;
  }
  return bad;
}

/** Silhouette height/width report used by the QA gate + the exporter log. */
export function silhouetteStats(geometry: THREE.BufferGeometry): {
  height: number; width: number; depth: number; slenderness: number;
} {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  const height = bb.max.y - bb.min.y;
  const width = bb.max.x - bb.min.x;
  const depth = bb.max.z - bb.min.z;
  return { height, width, depth, slenderness: height / width };
}
