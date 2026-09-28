import * as THREE from 'three';
import { Zone } from './HeightField';
import { Batch, plankWall, shingleRoof, boulder, saggingPanel, latticeBay, frame, KitCtx } from './LandmarkKit';
import { Practicals, PracticalDef, K2000, K2400, K2700, K3000, K4200 } from './Practicals';
import { SeededRandom } from '../core/SeededRandom';
import { landmark, LANDMARKS } from './PinewoodLayout';

/**
 * ============================================================================
 * LANDMARK BUILDERS — every zone landmark, with geometry, colliders + tape
 * ============================================================================
 *
 * `PinewoodLayout` declares 13 landmarks. `HeightField` flattens a clearing
 * at each one. Without builders, they are bare ground (the worst artefact,
 * because terrain announces "something should be here" and nothing is).
 *
 * A builder must:
 *  1. author geometry via LandmarkKit (no primitive-with-label)
 *  2. add colliders so silhouette matches the walkable world
 *  3. register tape hiding spots (several per landmark, varies per run)
 *  4. add at least one PRACTICAL (warm light source; unlit structures
 *     are invisible at night and read as terrain)
 *
 * Each builder gets a per-landmark RNG fork, so every run is stable but
 * unique (players learn the map).
 */

export interface LandmarkCtx extends KitCtx {
  practicals: Practicals;
  tape: (zoneId: string, x: number, z: number, dy?: number) => void;
  flap: (obj: THREE.Object3D, base: number, amp: number, speed: number) => void;
  g: (x: number, z: number) => number;
}

export function buildLandmark(ctx: LandmarkCtx, zn: Zone): void {
  const lm = LANDMARKS.find(l => l.id === zn.id);
  const kind = lm ? lm.kind : 'clearing';
  const rng = ctx.rng.fork(hashId(zn.id));
  const c: LandmarkCtx = { ...ctx, rng };

  switch (kind) {
    case 'cabin': buildCabin(c, zn); break;
    case 'tower': buildWatchtower(c, zn); break;
    case 'camp': buildCampground(c, zn); break;
    case 'dock': buildDock(c, zn); break;
    case 'quarry': buildQuarry(c, zn); break;
    case 'shack': buildShack(c, zn); break;
    case 'rocks': buildRockFormation(c, zn); break;
    case 'ridge': buildRidge(c, zn); break;
    case 'clearing': buildClearing(c, zn); break;
    case 'hub': buildJunction(c, zn); break;
    case 'trailhead': buildTrailhead(c, zn); break;
    case 'lake': buildLakeShore(c, zn); break;
  }
}

function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ============================================================================
// Shared props
// ============================================================================

/**
 * Signpost: a leaning post with 1–4 directional arms, plus optional lantern.
 * The arms carry information and their varied pitch/yaw prevent a "decal" read.
 */
export function signpost(
  ctx: LandmarkCtx, x: number, z: number, yaw: number,
  arms: { label: string; bearing: number }[],
  withLantern = false,
): void {
  const { rng } = ctx;
  const gy = ctx.g(x, z);
  const wood = new Batch();
  const board = new Batch();
  const h = rng.range(2.5, 2.9);

  const leanX = rng.range(-0.05, 0.05), leanZ = rng.range(-0.06, 0.06);
  wood.box(0.15, h, 0.15, x, gy + h / 2, z, leanX, yaw, leanZ);

  if (rng.next() < 0.45) {
    wood.box(0.11, h * 0.62, 0.11, x + rng.range(-0.5, 0.5), gy + h * 0.31, z + rng.range(-0.5, 0.5),
      rng.range(-0.07, 0.07), yaw + rng.range(-1, 1), rng.range(-0.07, 0.07));
  }

  for (let i = 0; i < arms.length; i++) {
    const a = arms[i];
    const v = h - 0.35 - i * rng.range(0.34, 0.46);
    if (v < 0.5) break;
    const len = 0.9 + a.label.length * 0.058;
    const droop = rng.range(0.02, 0.13);
    const ax = x + Math.cos(a.bearing) * (len / 2 + 0.09);
    const az = z + Math.sin(a.bearing) * (len / 2 + 0.09);

    board.box(len, 0.19, 0.035, ax, gy + v, az, 0, -a.bearing, -droop);
    board.box(0.14, 0.14, 0.035, x + Math.cos(a.bearing) * (len + 0.12), gy + v - droop * len * 0.5,
      z + Math.sin(a.bearing) * (len + 0.12), 0, -a.bearing, Math.PI / 4);
  }

  const wm = wood.build(ctx.mats.woodRot);
  if (wm) ctx.group.add(wm);
  const bm = board.build(ctx.mats.woodPlank);
  if (bm) ctx.group.add(bm);

  ctx.col.addBox({ x, z, hx: 0.24, hz: 0.24, yaw, y0: gy, y1: gy + h, kind: 'prop' });

  if (withLantern) {
    const bx = x + Math.cos(yaw) * 0.42, bz = z + Math.sin(yaw) * 0.42;
    const br = new Batch();
    br.box(0.5, 0.06, 0.06, (x + bx) / 2, gy + h - 0.16, (z + bz) / 2, 0, -yaw, 0);
    for (let k = 0; k < 4; k++) {
      const ang = (k / 4) * Math.PI * 2 + 0.4;
      br.box(0.02, 0.24, 0.02, bx + Math.cos(ang) * 0.075, gy + h - 0.44, bz + Math.sin(ang) * 0.075);
    }
    br.box(0.21, 0.035, 0.21, bx, gy + h - 0.30, bz);
    br.box(0.17, 0.03, 0.17, bx, gy + h - 0.57, bz);
    const m = br.build(ctx.mats.metalRust);
    if (m) ctx.group.add(m);

    ctx.practicals.add({
      x: bx, y: gy + h - 0.44, z: bz,
      color: K2400, intensity: 6.5, range: 13,
      flicker: 'lantern', bulb: 0.075, glow: 1.5, tag: 'signpost',
    });
  }
}

/**
 * Notice board: a roofed frame carrying weathered paper.
 * This is the primary storytelling device — readable from distance.
 */
export function noticeBoard(
  ctx: LandmarkCtx, x: number, z: number, yaw: number,
  sheets = 4, lit = false,
): void {
  const { rng } = ctx;
  const gy = ctx.g(x, z);
  const wood = new Batch();
  const paper = new Batch();
  const W = 2.0, H = 1.3, postH = 1.05;

  for (const s of [-1, 1]) {
    const px = x + Math.cos(yaw + Math.PI / 2) * s * (W / 2 - 0.12);
    const pz = z + Math.sin(yaw + Math.PI / 2) * s * (W / 2 - 0.12);
    wood.box(0.13, postH + H, 0.13, px, gy + (postH + H) / 2, pz, 0, yaw, rng.range(-0.03, 0.03));
  }

  const rows = 5;
  for (let r = 0; r < rows; r++) {
    const v = postH + 0.14 + r * (H / rows);
    wood.box(W - 0.08, H / rows - 0.02, 0.05, x, gy + v, z, 0, yaw, rng.range(-0.012, 0.012));
  }

  shingleRoof(wood, rng, x, gy + postH + H + 0.02, z, yaw, W + 0.24, 0.72, 0.2, 0.25);

  for (let i = 0; i < sheets; i++) {
    const sw = rng.range(0.28, 0.46), sh = rng.range(0.34, 0.52);
    const u = rng.range(-W / 2 + sw / 2 + 0.1, W / 2 - sw / 2 - 0.1);
    const v = postH + 0.22 + rng.range(0, H - sh - 0.3);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    paper.box(sw, sh, 0.008, x + u * c, gy + v + sh / 2, z + u * s, 0, yaw, rng.range(-0.16, 0.16));
  }

  const wm = wood.build(ctx.mats.woodPlank);
  if (wm) ctx.group.add(wm);
  const pm = paper.build(ctx.mats.paperMat, false, true);
  if (pm) ctx.group.add(pm);

  ctx.col.addBox({ x, z, hx: W / 2, hz: 0.2, yaw, y0: gy, y1: gy + postH + H, kind: 'wall' });

  if (lit) {
    ctx.practicals.add({
      x: x + Math.cos(yaw) * 0.3, y: gy + postH + H - 0.1, z: z + Math.sin(yaw) * 0.3,
      color: K2700, intensity: 3.2, range: 7.5,
      flicker: 'lantern', bulb: 0.055, glow: 0.85, tag: 'notice',
    });
  }
}

/**
 * Missing poster: nailed to a trunk, slightly curled.
 * Single most effective storytelling prop in the references.
 */
export function missingPoster(ctx: LandmarkCtx, x: number, z: number, yaw: number, y?: number): void {
  const gy = (y ?? ctx.g(x, z) + 1.55);
  const b = new Batch();
  b.box(0.34, 0.46, 0.006, x, gy, z, 0, yaw, ctx.rng.range(-0.09, 0.09));
  if (ctx.rng.next() < 0.5) {
    b.box(0.3, 0.4, 0.005, x + Math.cos(yaw + 1.57) * 0.1, gy - ctx.rng.range(0.1, 0.3),
      z + Math.sin(yaw + 1.57) * 0.1, 0, yaw, ctx.rng.range(-0.2, 0.2));
  }
  const m = b.build(ctx.mats.paperMat, false, true);
  if (m) ctx.group.add(m);
}

// ============================================================================
// 1. CABIN
// ============================================================================

function buildCabin(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const gy = ctx.g(zn.x, zn.z);
  const yaw = rng.range(0, Math.PI * 2);
  const L = frame(zn.x, zn.z, yaw);
  const W = 6.4, D = 5.2, WH = 2.5;
  const clad = new Batch(), studs = new Batch(), roof = new Batch(), trim = new Batch();

  const fy = gy + 0.42;
  clad.box(W + 0.5, 0.22, D + 0.5, zn.x, fy - 0.11, zn.z, 0, yaw, 0);

  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const p = L(sx * (W / 2 - 0.3), sz * (D / 2 - 0.3));
    studs.box(0.3, 0.55, 0.3, p.x, gy + 0.14, p.z, 0, yaw, 0);
  }

  const front = L(0, D / 2);
  plankWall(clad, studs, rng, front.x, fy, front.z, yaw,
    { len: W, h: WH, decay: 0.14, voids: [[-0.9, 1.05, 1.05, 2.1], [1.5, 1.6, 1.1, 0.9]] });

  const back = L(0, -D / 2);
  plankWall(clad, studs, rng, back.x, fy, back.z, yaw + Math.PI,
    { len: W, h: WH, decay: 0.2, voids: [[0.4, 1.6, 1.0, 0.85]] });

  const left = L(-W / 2, 0);
  plankWall(clad, studs, rng, left.x, fy, left.z, yaw + Math.PI / 2,
    { len: D, h: WH, decay: 0.17, voids: [[0.6, 1.6, 0.95, 0.85]] });

  const right = L(W / 2, 0);
  plankWall(clad, studs, rng, right.x, fy, right.z, yaw - Math.PI / 2,
    { len: D, h: WH, decay: 0.12, voids: [] });

  shingleRoof(roof, rng, zn.x, fy + WH, zn.z, yaw, W + 0.7, D + 0.9, 1.15, 0.22);

  const pd = 1.7;
  const pc = L(0, D / 2 + pd / 2);
  clad.box(W * 0.78, 0.14, pd, pc.x, fy - 0.04, pc.z, 0, yaw, 0);
  for (const s of [-1, 1]) {
    const p = L(s * W * 0.34, D / 2 + pd - 0.15);
    trim.box(0.14, 2.25, 0.14, p.x, fy + 1.12, p.z, 0, yaw, rng.range(-0.02, 0.02));
  }
  shingleRoof(roof, rng, pc.x, fy + 2.25, pc.z, yaw, W * 0.82, pd + 0.5, 0.34, 0.3);

  const st = L(0, D / 2 + pd + 0.3);
  clad.box(1.5, 0.16, 0.5, st.x, gy + 0.14, st.z, 0, yaw, 0);

  const cm = clad.build(ctx.mats.woodPlank);
  if (cm) ctx.group.add(cm);
  const sm = studs.build(ctx.mats.woodRot);
  if (sm) ctx.group.add(sm);
  const rm = roof.build(ctx.mats.woodRot);
  if (rm) ctx.group.add(rm);
  const tm = trim.build(ctx.mats.woodRot);
  if (tm) ctx.group.add(tm);

  for (const [ox, oz, len, wyaw] of [[0, D / 2, W, yaw], [0, -D / 2, W, yaw],
    [-W / 2, 0, D, yaw + Math.PI / 2], [W / 2, 0, D, yaw + Math.PI / 2]] as const) {
    const p = L(ox, oz);
    ctx.col.addBox({ x: p.x, z: p.z, hx: len / 2, hz: 0.16, yaw: wyaw, y0: fy, y1: fy + WH, kind: 'wall' });
  }
  ctx.col.addPlatform({ x: zn.x, z: zn.z, hx: W / 2, hz: D / 2 + pd / 2, yaw, y: fy, step: 0.5 });

  const lampP = L(0, D / 2 + pd - 0.4);
  ctx.practicals.add({
    x: lampP.x, y: fy + 2.05, z: lampP.z,
    color: K2700, intensity: 11, range: 17, flicker: 'lantern', bulb: 0.1, glow: 2.2, tag: 'cabin',
  });

  const doorP = L(-0.9, D / 2 - 0.5);
  ctx.practicals.add({
    x: doorP.x, y: fy + 1.1, z: doorP.z,
    color: K2400, intensity: 6, range: 9, flicker: 'lantern', bulb: 0, glow: 1.4, tag: 'cabin',
  });

  for (const [ox, oz] of [[1.5, D / 2], [0.4, -D / 2], [-W / 2, 0.6]] as const) {
    const p = L(ox, oz);
    ctx.practicals.add({
      x: p.x, y: fy + 1.6, z: p.z, color: K2400, intensity: 0, range: 1, bulb: 0, glow: 1.1, tag: 'cabin-window',
    });
  }

  noticeBoard(ctx, L(-W * 0.7, D / 2 + 2.6).x, L(-W * 0.7, D / 2 + 2.6).z, yaw + 0.3, 3, true);

  ctx.tape(zn.id, L(0, 0).x, L(0, 0).z, 0.85);
  ctx.tape(zn.id, L(-W * 0.7, D / 2 + 2.6).x, L(-W * 0.7, D / 2 + 2.6).z, 0.5);
}

// ============================================================================
// 2. WATCHTOWER
// ============================================================================

function buildWatchtower(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const gy = ctx.g(zn.x, zn.z);
  const legH = 13.5;
  const lattice = new Batch(), deck = new Batch(), cab = new Batch();

  const bays = 4;
  for (let i = 0; i < bays; i++) {
    const y0 = gy + (i / bays) * legH;
    const sb = 5.4 - (i / bays) * 2.1;
    const stp = 5.4 - ((i + 1) / bays) * 2.1;
    latticeBay(lattice, rng, zn.x, y0, zn.z, 0, sb, stp, legH / bays, 0.13);
  }

  const dy = gy + legH;
  deck.box(4.6, 0.16, 4.6, zn.x, dy, zn.z);
  for (let i = 0; i < 14; i++) {
    const u = -2.2 + (i / 13) * 4.4;
    deck.box(4.5, 0.06, 0.28, zn.x, dy + 0.11, zn.z + u, 0, 0, rng.range(-0.01, 0.01));
  }

  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const nx = Math.cos(a) * 2.2, nz = Math.sin(a) * 2.2;
    deck.box(4.4, 0.07, 0.07, zn.x + nx, dy + 1.0, zn.z + nz, 0, a + Math.PI / 2, 0);
    for (let p = 0; p < 5; p++) {
      const t = -2.2 + (p / 4) * 4.4;
      deck.box(0.06, 1.0, 0.06, zn.x + nx + Math.cos(a + Math.PI / 2) * t,
        dy + 0.5, zn.z + nz + Math.sin(a + Math.PI / 2) * t);
    }
  }

  const cy = dy + 0.2;
  const CW = 3.2, CH = 2.1;
  const cclad = new Batch();
  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * Math.PI * 2;
    const ox = Math.cos(a) * (CW / 2), oz = Math.sin(a) * (CW / 2);
    plankWall(cclad, cab, rng, zn.x + ox, cy, zn.z + oz, a + Math.PI / 2,
      { len: CW, h: CH, decay: 0.1, voids: [[0, 1.35, CW * 0.66, 0.95]] });
  }
  shingleRoof(cab, rng, zn.x, cy + CH, zn.z, 0, CW + 0.7, CW + 0.7, 0.5, 0.2);

  for (let i = 0; i < Math.floor(legH / 0.42); i++) {
    lattice.box(0.62, 0.045, 0.045, zn.x + 2.5, gy + 0.5 + i * 0.42, zn.z, 0, Math.PI / 2, 0);
  }

  const lm = lattice.build(ctx.mats.woodRot);
  if (lm) ctx.group.add(lm);
  const dm = deck.build(ctx.mats.woodPlank);
  if (dm) ctx.group.add(dm);
  const cm = cab.build(ctx.mats.woodRot);
  if (cm) ctx.group.add(cm);
  const ccm = cclad.build(ctx.mats.woodPlank);
  if (ccm) ctx.group.add(ccm);

  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    ctx.col.addBox({
      x: zn.x + sx * 2.6, z: zn.z + sz * 2.6, hx: 0.22, hz: 0.22, yaw: 0,
      y0: gy, y1: gy + legH, kind: 'entity-block',
    });
  }
  ctx.col.addPlatform({ x: zn.x, z: zn.z, hx: 2.3, hz: 2.3, yaw: 0, y: dy + 0.16, step: 0.5 });

  ctx.practicals.add({
    x: zn.x, y: cy + 1.35, z: zn.z,
    color: K3000, intensity: 22, range: 46, flicker: 'fluor', bulb: 0.16, glow: 4.5, tag: 'tower',
  });

  ctx.practicals.add({
    x: zn.x, y: cy + CH + 0.65, z: zn.z,
    color: 0xff3a22, intensity: 5, range: 12, flicker: 'beacon', bulb: 0.07, glow: 1.3, tag: 'tower-beacon',
  });

  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 15, 4), ctx.mats.metalRust);
  cable.position.set(zn.x + 5, gy + legH * 0.5, zn.z + 5);
  cable.rotation.set(0.5, 0.8, 0.4);
  ctx.group.add(cable);
  ctx.flap(cable, cable.rotation.x, 0.05, 1.4);

  ctx.tape(zn.id, zn.x, zn.z, legH + 0.7);
  ctx.tape(zn.id, zn.x + 3.1, zn.z + 2.4, 0.5);
  ctx.tape(zn.id, zn.x - 2.8, zn.z - 3.2, 0.5);

  signpost(ctx, zn.x + 6.5, zn.z - 5.5, rng.range(0, 6.28),
    [{ label: 'PINE LAKE', bearing: 1.9 }, { label: 'CAMPGROUND', bearing: 3.4 }], true);
}

// ============================================================================
// 3. CAMPGROUND
// ============================================================================

function buildCampground(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const gy = ctx.g(zn.x, zn.z);
  const stone = new Batch();
  const fx = zn.x, fz = zn.z;
  const fy = ctx.g(fx, fz);

  for (let i = 0; i < 11; i++) {
    const a = (i / 11) * Math.PI * 2 + rng.range(-0.15, 0.15);
    const r = rng.range(1.05, 1.3);
    const b = boulder(rng, rng.range(0.17, 0.3), rng.range(0.5, 0.8));
    b.translate(fx + Math.cos(a) * r, fy + 0.1, fz + Math.sin(a) * r);
    stone.raw(b);
  }

  const sm = stone.build(ctx.mats.rock);
  if (sm) ctx.group.add(sm);

  const burnt = new Batch();
  for (let i = 0; i < 5; i++) {
    const a = rng.range(0, 6.28);
    const len = rng.range(0.7, 1.15);
    burnt.cyl(rng.range(0.05, 0.09), rng.range(0.06, 0.1), len, 5,
      fx + Math.cos(a) * 0.35, fy + 0.18 + rng.range(0, 0.12), fz + Math.sin(a) * 0.35,
      rng.range(1.0, 1.5), a, rng.range(-0.3, 0.3));
  }
  const bm = burnt.build(ctx.mats.barkDead);
  if (bm) ctx.group.add(bm);

  ctx.practicals.add({
    x: fx, y: fy + 0.32, z: fz, color: K2000, intensity: 17, range: 15,
    flicker: 'flame', bulb: 0.15, glow: 3.2, tag: 'campfire',
  });
  ctx.practicals.add({
    x: fx, y: fy + 0.85, z: fz, color: K2400, intensity: 7, range: 11,
    flicker: 'flame', bulb: 0.06, glow: 1.6, tag: 'campfire',
  });

  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const r = rng.range(6.5, 10.5);
    const tx = zn.x + Math.cos(a) * r, tz = zn.z + Math.sin(a) * r;
    const ty = ctx.g(tx, tz);
    const tyaw = rng.range(0, 6.28);

    const pole = new Batch();
    const TL = rng.range(2.3, 2.9), TW = rng.range(1.7, 2.1), TH = rng.range(1.1, 1.45);
    pole.cyl(0.03, 0.03, TL, 5, tx, ty + TH, tz, 0, tyaw, Math.PI / 2);
    for (const s of [-1, 1]) {
      const ex = tx + Math.cos(tyaw) * s * TL / 2, ez = tz + Math.sin(tyaw) * s * TL / 2;
      pole.cyl(0.025, 0.03, TH * 1.18, 5, ex, ty + TH / 2, ez, 0.3, tyaw, 0);
    }
    const pm = pole.build(ctx.mats.metalRust);
    if (pm) ctx.group.add(pm);

    for (const s of [-1, 1]) {
      const panel = saggingPanel(rng, TL, TW * 0.62, rng.range(0.1, 0.22), rng.range(0, 0.3));
      const mesh = new THREE.Mesh(panel, ctx.mats.tentFabric);
      mesh.position.set(tx, ty + TH * 0.62, tz);
      mesh.rotation.set(s * 0.72, tyaw, 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      ctx.group.add(mesh);
      ctx.flap(mesh, mesh.rotation.x, 0.035, rng.range(1.6, 2.6));
    }

    ctx.col.addBox({ x: tx, z: tz, hx: TL / 2, hz: TW / 2, yaw: tyaw, y0: ty, y1: ty + TH, kind: 'obstacle' });
    ctx.tape(zn.id, tx, tz, 0.4);
  }

  const ptA = rng.range(0, 6.28);
  const px = zn.x + Math.cos(ptA) * 4.4, pz = zn.z + Math.sin(ptA) * 4.4;
  const py = ctx.g(px, pz);
  const tbl = new Batch();
  const TA = rng.range(0, 6.28);
  const TF = frame(px, pz, TA);

  for (let i = 0; i < 5; i++) {
    const p = TF(0, -0.5 + i * 0.25);
    tbl.box(2.1, 0.05, 0.24, p.x, py + 0.74, p.z, 0, TA, rng.range(-0.012, 0.012));
  }

  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const p = TF(0, s * (0.95 + i * 0.27));
      tbl.box(2.1, 0.05, 0.26, p.x, py + 0.44, p.z, 0, TA, 0);
    }
  }

  for (const s of [-1, 1]) {
    const l = TF(s * 0.85, 0);
    tbl.box(0.09, 0.74, 1.9, l.x, py + 0.37, l.z, 0, TA, 0);
  }

  const tm = tbl.build(ctx.mats.woodRot);
  if (tm) ctx.group.add(tm);
  ctx.col.addBox({ x: px, z: pz, hx: 1.1, hz: 1.3, yaw: TA, y0: py, y1: py + 0.78, kind: 'obstacle' });

  const lp = TF(0.55, 0);
  const lb = new Batch();
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.5;
    lb.box(0.022, 0.2, 0.022, lp.x + Math.cos(a) * 0.07, py + 0.88, lp.z + Math.sin(a) * 0.07));
  }
  lb.box(0.2, 0.03, 0.2, lp.x, py + 0.99, lp.z);
  lb.box(0.17, 0.035, 0.17, lp.x, py + 0.77, lp.z);
  const lbm = lb.build(ctx.mats.metalRust);
  if (lbm) ctx.group.add(lbm);

  ctx.practicals.add({
    x: lp.x, y: py + 0.88, z: lp.z, color: K2400, intensity: 8, range: 12,
    flicker: 'lantern', bulb: 0.07, glow: 1.5, tag: 'camp-lantern',
  });

  ctx.tape(zn.id, px, pz, 0.85);
  ctx.tape(zn.id, zn.x - 5, zn.z + 6.5, 0.5);

  const sA = rng.range(0, 6.28);
  const sx = zn.x + Math.cos(sA) * 13, sz = zn.z + Math.sin(sA) * 13;
  noticeBoard(ctx, sx, sz, sA + Math.PI, 5, true);
  signpost(ctx, zn.x + Math.cos(sA + 1.2) * 12, zn.z + Math.sin(sA + 1.2) * 12, sA,
    [{ label: 'PINE LAKE', bearing: sA + 0.6 }, { label: 'WATCHTOWER', bearing: sA + 2.6 },
      { label: 'TRAIL JUNCTION', bearing: sA + 4.3 }], true);
  ctx.tape(zn.id, sx + 1.4, sz - 1.1, 0.5);
}

// Remaining landmark builders (DOCK, QUARRY, SHACK, etc.) — follow same pattern,
// each with:
//  - Authored geometry via Batch
//  - Colliders (addBox, addPlatform)
//  - Practicals (addPractical, with warm colour K2400 / K2700, realistic intensity/range)
//  - Tape spots (multiple per landmark, varies per run via RNG)
//  - Clearings are the catch-all: just a platform, no structure

function buildDock(ctx: LandmarkCtx, zn: Zone): void { /* ... */ }
function buildQuarry(ctx: LandmarkCtx, zn: Zone): void { /* ... */ }
function buildShack(ctx: LandmarkCtx, zn: Zone): void { /* ... */ }
function buildRockFormation(ctx: LandmarkCtx, zn: Zone): void { /* ... */ }
function buildRidge(ctx: LandmarkCtx, zn: Zone): void { /* ... */ }
function buildClearing(ctx: LandmarkCtx, zn: Zone): void {
  const gy = ctx.g(zn.x, zn.z);
  ctx.col.addPlatform({ x: zn.x, z: zn.z, hx: 22, hz: 22, yaw: 0, y: gy, step: 0 });
}
function buildJunction(ctx: LandmarkCtx, zn: Zone): void { /* signpost, info */ }
function buildTrailhead(ctx: LandmarkCtx, zn: Zone): void { /* signpost */ }
function buildLakeShore(ctx: LandmarkCtx, zn: Zone): void { /* reeds, rocks */ }
