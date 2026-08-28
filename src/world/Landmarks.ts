import * as THREE from 'three';
import { Zone } from './HeightField';
import { Batch, plankWall, shingleRoof, boulder, saggingPanel, latticeBay, frame, KitCtx } from './LandmarkKit';
import { Practicals, PracticalDef, K2000, K2400, K2700, K3000, K4200 } from './Practicals';
import { SeededRandom } from '../core/SeededRandom';
import { landmark, LANDMARKS } from './PinewoodLayout';

/**
 * ── LANDMARK BUILDERS ─────────────────────────────────────────────────────────
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `PinewoodLayout` declares 13 landmarks and `HeightField` relaxes the terrain
 * into a flat clearing at each one (22-54 m radius). `MapGenerator` only had
 * builders for 4 of those ids, so 9 landmarks shipped as *bare flattened
 * ground* — the worst possible artefact, because the terrain visibly announces
 * "something should be here" and then nothing is.
 *
 * It also broke the game outright: `TapeSystem` places one tape per entry in
 * `MapGenerator.tapePools`, and a landmark with no builder never calls
 * `tapeSpot`, so it contributes no pool. Four of the eight required tapes could
 * never spawn and the run could not be completed.
 *
 * Every builder here does four things, and the fourth is the one that is easy
 * to forget:
 *   1. authored geometry via LandmarkKit (no primitive-with-a-label)
 *   2. colliders, so the silhouette and the walkable world agree
 *   3. tape spots — several per landmark, so the hiding place varies per run
 *   4. at least one PRACTICAL, because a structure with no warm source is
 *      invisible at night and reads as terrain
 *
 * Structures are placed with the landmark's own RNG fork, so the cabin is the
 * same cabin every run (players learn the map) while still being unique
 * board-for-board.
 */

export interface LandmarkCtx extends KitCtx {
  practicals: Practicals;
  /** register a tape hiding place */
  tape: (zoneId: string, x: number, z: number, dy?: number) => void;
  /** register a flapping object for the wind update */
  flap: (obj: THREE.Object3D, base: number, amp: number, speed: number) => void;
  /** ground height */
  g: (x: number, z: number) => number;
}

/** Dispatch: every landmark id in PinewoodLayout must land somewhere here. */
export function buildLandmark(ctx: LandmarkCtx, zn: Zone): void {
  const lm = LANDMARKS.find(l => l.id === zn.id);
  const kind = lm ? lm.kind : 'clearing';
  // A per-landmark fork keeps each structure stable regardless of build order.
  const rng = ctx.rng.fork(hashId(zn.id));
  const c: LandmarkCtx = { ...ctx, rng };
  switch (kind) {
    case 'cabin':     buildCabin(c, zn); break;
    case 'tower':     buildWatchtower(c, zn); break;
    case 'camp':      buildCampground(c, zn); break;
    case 'dock':      buildDock(c, zn); break;
    case 'quarry':    buildQuarry(c, zn); break;
    case 'shack':     buildShack(c, zn); break;
    case 'rocks':     buildRockFormation(c, zn); break;
    case 'ridge':     buildRidge(c, zn); break;
    case 'clearing':  buildClearing(c, zn); break;
    case 'hub':       buildJunction(c, zn); break;
    case 'trailhead': buildTrailhead(c, zn); break;
    case 'lake':      buildLakeShore(c, zn); break;
  }
}

function hashId(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h >>> 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   SHARED PROPS
   The signpost and notice board are the game's primary storytelling device —
   the references lean on them heavily — so they are built once, well, and
   reused rather than re-improvised per site.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * A trail signpost: a leaning post with 1-4 directional arms at different
 * heights and angles, plus an optional hanging lantern.
 *
 * The arms are what carry the information ("PINE LAKE ->"), and their varied
 * pitch/yaw is what stops it reading as a decal on a stick. A hung lantern
 * turns it into a light source with a reason to exist, which is exactly what
 * the reference frames use to anchor the middle distance.
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
  // Post leans: a plumb post in a forest looks maintained, and nothing here is.
  const leanX = rng.range(-0.05, 0.05), leanZ = rng.range(-0.06, 0.06);
  wood.box(0.15, h, 0.15, x, gy + h / 2, z, leanX, yaw, leanZ);
  // a second, shorter stub post — signposts accrete over years
  if (rng.next() < 0.45) {
    wood.box(0.11, h * 0.62, 0.11, x + rng.range(-0.5, 0.5), gy + h * 0.31, z + rng.range(-0.5, 0.5),
      rng.range(-0.07, 0.07), yaw + rng.range(-1, 1), rng.range(-0.07, 0.07));
  }
  for (let i = 0; i < arms.length; i++) {
    const a = arms[i];
    const v = h - 0.35 - i * rng.range(0.34, 0.46);
    if (v < 0.5) break;
    const len = 0.9 + a.label.length * 0.058;
    // Arm droops with age; the nail is one point so it rotates about it.
    const droop = rng.range(0.02, 0.13);
    const ax = x + Math.cos(a.bearing) * (len / 2 + 0.09);
    const az = z + Math.sin(a.bearing) * (len / 2 + 0.09);
    board.box(len, 0.19, 0.035, ax, gy + v, az, 0, -a.bearing, -droop);
    // arrow tip: a rotated square reads as a point at any distance
    board.box(0.14, 0.14, 0.035,
      x + Math.cos(a.bearing) * (len + 0.12), gy + v - droop * len * 0.5,
      z + Math.sin(a.bearing) * (len + 0.12), 0, -a.bearing, Math.PI / 4);
  }
  const wm = wood.build(ctx.mats.woodRot);
  if (wm) ctx.group.add(wm);
  const bm = board.build(ctx.mats.woodPlank);
  if (bm) ctx.group.add(bm);
  ctx.col.addBox({ x, z, hx: 0.24, hz: 0.24, yaw, y0: gy, y1: gy + h, kind: 'prop' });

  if (withLantern) {
    // Hung off a short bracket near the top — the reference's key middle-
    // distance anchor. Warm, low, guttering.
    const bx = x + Math.cos(yaw) * 0.42, bz = z + Math.sin(yaw) * 0.42;
    const br = new Batch();
    br.box(0.5, 0.06, 0.06, (x + bx) / 2, gy + h - 0.16, (z + bz) / 2, 0, -yaw, 0);
    // lantern cage: four uprights + cap
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      br.box(0.02, 0.24, 0.02, bx + Math.cos(a) * 0.075, gy + h - 0.44, bz + Math.sin(a) * 0.075);
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
 * A notice board: a roofed frame carrying weathered paper. This is where the
 * MISSING poster and the CAMP RULES live, and it is deliberately readable —
 * the horror is in what the text says, so it must not be hidden by fog.
 */
export function noticeBoard(
  ctx: LandmarkCtx, x: number, z: number, yaw: number, sheets = 4, lit = false,
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
  // backing boards, individually placed so gaps show
  const rows = 5;
  for (let r = 0; r < rows; r++) {
    const v = postH + 0.14 + r * (H / rows);
    wood.box(W - 0.08, H / rows - 0.02, 0.05, x, gy + v, z, 0, yaw, rng.range(-0.012, 0.012));
  }
  // little pitched roof so the paper survived: also catches the practical
  shingleRoof(wood, rng, x, gy + postH + H + 0.02, z, yaw, W + 0.24, 0.72, 0.2, 0.25);
  // sheets: varied size, angle, curl. Some half torn off.
  for (let i = 0; i < sheets; i++) {
    const sw = rng.range(0.28, 0.46), sh = rng.range(0.34, 0.52);
    const u = rng.range(-W / 2 + sw / 2 + 0.1, W / 2 - sw / 2 - 0.1);
    const v = postH + 0.22 + rng.range(0, H - sh - 0.3);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    paper.box(sw, sh, 0.008, x + u * c, gy + v + sh / 2, z + u * s,
      0, yaw, rng.range(-0.16, 0.16));
  }
  const wm = wood.build(ctx.mats.woodPlank);
  if (wm) ctx.group.add(wm);
  const pm = paper.build(ctx.mats.paperMat, false, true);
  if (pm) ctx.group.add(pm);
  ctx.col.addBox({
    x, z, hx: W / 2, hz: 0.2, yaw,
    y0: gy, y1: gy + postH + H, kind: 'wall',
  });
  if (lit) {
    // A small bulb under the roof lip pointed at the paper. Low intensity,
    // short range: it lights the notice and nothing else, which is why the
    // notice is the thing you look at.
    ctx.practicals.add({
      x: x + Math.cos(yaw) * 0.3, y: gy + postH + H - 0.1, z: z + Math.sin(yaw) * 0.3,
      color: K2700, intensity: 3.2, range: 7.5,
      flicker: 'lantern', bulb: 0.055, glow: 0.85, tag: 'notice',
    });
  }
}

/** A MISSING poster nailed to a trunk — the single most effective storytelling
 *  prop in the references. Placed against an existing tree, slightly curled. */
export function missingPoster(ctx: LandmarkCtx, x: number, z: number, yaw: number, y?: number): void {
  const gy = (y ?? ctx.g(x, z) + 1.55);
  const b = new Batch();
  b.box(0.34, 0.46, 0.006, x, gy, z, 0, yaw, ctx.rng.range(-0.09, 0.09));
  // a second, older, more decayed sheet behind it — implies this has happened before
  if (ctx.rng.next() < 0.5) {
    b.box(0.3, 0.4, 0.005, x + Math.cos(yaw + 1.57) * 0.1, gy - ctx.rng.range(0.1, 0.3),
      z + Math.sin(yaw + 1.57) * 0.1, 0, yaw, ctx.rng.range(-0.2, 0.2));
  }
  const m = b.build(ctx.mats.paperMat, false, true);
  if (m) ctx.group.add(m);
}

/* ══════════════════════════════════════════════════════════════════════════
   1. CABIN  — "Porch lamp still drawing current."
   The reference's hero structure: a small lit building seen through trees.
   ══════════════════════════════════════════════════════════════════════════ */
function buildCabin(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const gy = ctx.g(zn.x, zn.z);
  const yaw = rng.range(0, Math.PI * 2);
  const L = frame(zn.x, zn.z, yaw);
  const W = 6.4, D = 5.2, WH = 2.5;

  const clad = new Batch(), studs = new Batch(), roof = new Batch(), trim = new Batch();

  // floor platform, raised: you step UP into a cabin, which reads immediately
  const fy = gy + 0.42;
  clad.box(W + 0.5, 0.22, D + 0.5, zn.x, fy - 0.11, zn.z, 0, yaw, 0);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const p = L(sx * (W / 2 - 0.3), sz * (D / 2 - 0.3));
    studs.box(0.3, 0.55, 0.3, p.x, gy + 0.14, p.z, 0, yaw, 0);
  }

  // four walls; the front carries a door void and a window void
  const front = L(0, D / 2);
  plankWall(clad, studs, rng, front.x, fy, front.z, yaw, {
    len: W, h: WH, decay: 0.14,
    voids: [[-0.9, 1.05, 1.05, 2.1], [1.5, 1.6, 1.1, 0.9]],
  });
  const back = L(0, -D / 2);
  plankWall(clad, studs, rng, back.x, fy, back.z, yaw + Math.PI, {
    len: W, h: WH, decay: 0.2, voids: [[0.4, 1.6, 1.0, 0.85]],
  });
  const left = L(-W / 2, 0);
  plankWall(clad, studs, rng, left.x, fy, left.z, yaw + Math.PI / 2, {
    len: D, h: WH, decay: 0.17, voids: [[0.6, 1.6, 0.95, 0.85]],
  });
  const right = L(W / 2, 0);
  plankWall(clad, studs, rng, right.x, fy, right.z, yaw - Math.PI / 2, {
    len: D, h: WH, decay: 0.12, voids: [],
  });

  shingleRoof(roof, rng, zn.x, fy + WH, zn.z, yaw, W + 0.7, D + 0.9, 1.15, 0.22);

  // porch: roof on two posts, the classic readable cabin silhouette
  const pd = 1.7;
  const pc = L(0, D / 2 + pd / 2);
  clad.box(W * 0.78, 0.14, pd, pc.x, fy - 0.04, pc.z, 0, yaw, 0);
  for (const s of [-1, 1]) {
    const p = L(s * W * 0.34, D / 2 + pd - 0.15);
    trim.box(0.14, 2.25, 0.14, p.x, fy + 1.12, p.z, 0, yaw, rng.range(-0.02, 0.02));
  }
  shingleRoof(roof, rng, pc.x, fy + 2.25, pc.z, yaw, W * 0.82, pd + 0.5, 0.34, 0.3);
  // porch step
  const st = L(0, D / 2 + pd + 0.3);
  clad.box(1.5, 0.16, 0.5, st.x, gy + 0.14, st.z, 0, yaw, 0);

  const cm = clad.build(ctx.mats.woodPlank); if (cm) ctx.group.add(cm);
  const sm = studs.build(ctx.mats.woodRot); if (sm) ctx.group.add(sm);
  const rm = roof.build(ctx.mats.woodRot); if (rm) ctx.group.add(rm);
  const tm = trim.build(ctx.mats.woodRot); if (tm) ctx.group.add(tm);

  // walls as collision: one box per side rather than per board
  for (const [ox, oz, len, wyaw] of [
    [0, D / 2, W, yaw], [0, -D / 2, W, yaw],
    [-W / 2, 0, D, yaw + Math.PI / 2], [W / 2, 0, D, yaw + Math.PI / 2],
  ] as const) {
    const p = L(ox, oz);
    ctx.col.addBox({
      x: p.x, z: p.z, hx: len / 2, hz: 0.16, yaw: wyaw,
      y0: fy, y1: fy + WH, kind: 'wall',
    });
  }
  ctx.col.addPlatform({ x: zn.x, z: zn.z, hx: W / 2, hz: D / 2 + pd / 2, yaw, y: fy, step: 0.5 });

  // ── the light. This is the whole point of the cabin.
  // Porch bulb: warm, slightly failing, hung under the porch roof.
  const lampP = L(0, D / 2 + pd - 0.4);
  ctx.practicals.add({
    x: lampP.x, y: fy + 2.05, z: lampP.z,
    color: K2700, intensity: 11, range: 17,
    flicker: 'lantern', bulb: 0.1, glow: 2.2, tag: 'cabin',
  });
  // Interior spill through the door void — a second, deeper warm source so the
  // doorway reads as a lit interior rather than a black rectangle.
  const doorP = L(-0.9, D / 2 - 0.5);
  ctx.practicals.add({
    x: doorP.x, y: fy + 1.1, z: doorP.z,
    color: K2400, intensity: 6, range: 9,
    flicker: 'lantern', bulb: 0, glow: 1.4, tag: 'cabin',
  });
  // Window panes: emissive-only, no real light. Free, and they are what makes
  // the cabin legible from 150 m through the trees.
  for (const [ox, oz, wyaw] of [[1.5, D / 2, yaw], [0.4, -D / 2, yaw], [-W / 2, 0.6, yaw + Math.PI / 2]] as const) {
    const p = L(ox, oz);
    ctx.practicals.add({
      x: p.x, y: fy + 1.6, z: p.z, color: K2400,
      intensity: 0, range: 1, bulb: 0, glow: 1.1, tag: 'cabin-window',
    });
    void wyaw;
  }

  // dressing + storytelling
  const chair = L(W * 0.3, D / 2 + 0.9);
  const cb = new Batch();
  cb.box(0.5, 0.06, 0.48, chair.x, fy + 0.44, chair.z, 0, yaw + 0.6, 0);
  cb.box(0.5, 0.5, 0.06, chair.x, fy + 0.7, chair.z - 0.22, 0, yaw + 0.6, 0);
  for (const [dx, dz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]] as const) {
    cb.box(0.05, 0.44, 0.05, chair.x + dx, fy + 0.22, chair.z + dz, 0, yaw, 0);
  }
  const cbm = cb.build(ctx.mats.woodRot); if (cbm) ctx.group.add(cbm);

  noticeBoard(ctx, L(-W * 0.7, D / 2 + 2.6).x, L(-W * 0.7, D / 2 + 2.6).z, yaw + 0.3, 3, true);

  ctx.tape(zn.id, L(0, 0).x, L(0, 0).z, 0.85);                    // inside
  ctx.tape(zn.id, chair.x, chair.z, 0.95);                        // on the chair
  ctx.tape(zn.id, L(W * 0.6, -D * 0.7).x, L(W * 0.6, -D * 0.7).z, 0.5);
  ctx.tape(zn.id, L(-W * 0.55, D / 2 + 2.2).x, L(-W * 0.55, D / 2 + 2.2).z, 0.5);
}

/* ══════════════════════════════════════════════════════════════════════════
   2. WATCHTOWER — "Visible from most of the basin."
   The reference frame's distant searchlight. Must read at 200 m.
   ══════════════════════════════════════════════════════════════════════════ */
function buildWatchtower(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const gy = ctx.g(zn.x, zn.z);
  const legH = 13.5;
  const lattice = new Batch(), deck = new Batch(), cab = new Batch();

  // Four battered bays stacked: the see-through scaffold silhouette.
  const bays = 4;
  for (let i = 0; i < bays; i++) {
    const y0 = gy + (i / bays) * legH;
    const sb = 5.4 - (i / bays) * 2.1;
    const stp = 5.4 - ((i + 1) / bays) * 2.1;
    latticeBay(lattice, rng, zn.x, y0, zn.z, 0, sb, stp, legH / bays, 0.13);
  }
  // deck
  const dy = gy + legH;
  deck.box(4.6, 0.16, 4.6, zn.x, dy, zn.z);
  for (let i = 0; i < 14; i++) {
    // individual deck planks over the slab so the surface has grain and gaps
    const u = -2.2 + (i / 13) * 4.4;
    deck.box(4.5, 0.06, 0.28, zn.x, dy + 0.11, zn.z + u, 0, 0, rng.range(-0.01, 0.01));
  }
  // railing
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const nx = Math.cos(a) * 2.2, nz = Math.sin(a) * 2.2;
    deck.box(4.4, 0.07, 0.07, zn.x + nx, dy + 1.0, zn.z + nz, 0, a + Math.PI / 2, 0);
    for (let p = 0; p < 5; p++) {
      const t = -2.2 + (p / 4) * 4.4;
      deck.box(0.06, 1.0, 0.06,
        zn.x + nx + Math.cos(a + Math.PI / 2) * t, dy + 0.5, zn.z + nz + Math.sin(a + Math.PI / 2) * t);
    }
  }
  // cab: walls with big window voids, hipped roof
  const cy = dy + 0.2;
  const CW = 3.2, CH = 2.1;
  const cclad = new Batch();
  for (let s = 0; s < 4; s++) {
    const a = (s / 4) * Math.PI * 2;
    const ox = Math.cos(a) * (CW / 2), oz = Math.sin(a) * (CW / 2);
    plankWall(cclad, cab, rng, zn.x + ox, cy, zn.z + oz, a + Math.PI / 2, {
      len: CW, h: CH, decay: 0.1, voids: [[0, 1.35, CW * 0.66, 0.95]],
    });
  }
  shingleRoof(cab, rng, zn.x, cy + CH, zn.z, 0, CW + 0.7, CW + 0.7, 0.5, 0.2);

  // ladder up one face — makes the tower enterable, which the tape spot needs
  for (let i = 0; i < Math.floor(legH / 0.42); i++) {
    lattice.box(0.62, 0.045, 0.045, zn.x + 2.5, gy + 0.5 + i * 0.42, zn.z, 0, Math.PI / 2, 0);
  }

  const lm = lattice.build(ctx.mats.woodRot); if (lm) ctx.group.add(lm);
  const dm = deck.build(ctx.mats.woodPlank); if (dm) ctx.group.add(dm);
  const cm = cab.build(ctx.mats.woodRot); if (cm) ctx.group.add(cm);
  const ccm = cclad.build(ctx.mats.woodPlank); if (ccm) ctx.group.add(ccm);

  // legs collide; deck is a platform you can stand on
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    ctx.col.addBox({
      x: zn.x + sx * 2.6, z: zn.z + sz * 2.6, hx: 0.22, hz: 0.22, yaw: 0,
      y0: gy, y1: gy + legH, kind: 'entity-block',
    });
  }
  ctx.col.addPlatform({ x: zn.x, z: zn.z, hx: 2.3, hz: 2.3, yaw: 0, y: dy + 0.16, step: 0.5 });

  // ── the searchlight. Cool-warm (3000 K), high up, and the one practical in
  // the world with real reach. In the reference this is the element that gives
  // the frame its depth, because it puts a lit volume in the middle distance.
  ctx.practicals.add({
    x: zn.x, y: cy + 1.35, z: zn.z,
    color: K3000, intensity: 22, range: 46,
    flicker: 'fluor', bulb: 0.16, glow: 4.5, tag: 'tower',
  });
  // small red obstruction beacon on the roof peak — hard blink, long dark
  ctx.practicals.add({
    x: zn.x, y: cy + CH + 0.65, z: zn.z,
    color: 0xff3a22, intensity: 5, range: 12,
    flicker: 'beacon', bulb: 0.07, glow: 1.3, tag: 'tower-beacon',
  });

  // a guy cable that moves in wind
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 15, 4), ctx.mats.metalRust);
  cable.position.set(zn.x + 5, gy + legH * 0.5, zn.z + 5);
  cable.rotation.set(0.5, 0.8, 0.4);
  ctx.group.add(cable);
  ctx.flap(cable, cable.rotation.x, 0.05, 1.4);

  ctx.tape(zn.id, zn.x, zn.z, legH + 0.7);           // in the cab: climb for it
  ctx.tape(zn.id, zn.x + 3.1, zn.z + 2.4, 0.5);
  ctx.tape(zn.id, zn.x - 2.8, zn.z - 3.2, 0.5);
  ctx.tape(zn.id, zn.x + 1.2, zn.z - 4.4, 0.5);
  signpost(ctx, zn.x + 6.5, zn.z - 5.5, rng.range(0, 6.28), [
    { label: 'PINE LAKE', bearing: 1.9 }, { label: 'CAMPGROUND', bearing: 3.4 },
  ], true);
}

/* ══════════════════════════════════════════════════════════════════════════
   3. CAMPGROUND — "Tents still pitched, fire ring cold."
   Reference image 2. A live campfire is the strongest warm anchor in the game.
   ══════════════════════════════════════════════════════════════════════════ */
function buildCampground(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const gy = ctx.g(zn.x, zn.z);

  // ── fire ring: individually placed stones, ash, standing logs
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
  const sm = stone.build(ctx.mats.rock); if (sm) ctx.group.add(sm);

  // burnt logs leaning into the centre
  const burnt = new Batch();
  for (let i = 0; i < 5; i++) {
    const a = rng.range(0, 6.28);
    const len = rng.range(0.7, 1.15);
    burnt.cyl(rng.range(0.05, 0.09), rng.range(0.06, 0.1), len, 5,
      fx + Math.cos(a) * 0.35, fy + 0.18 + rng.range(0, 0.12), fz + Math.sin(a) * 0.35,
      rng.range(1.0, 1.5), a, rng.range(-0.3, 0.3));
  }
  const bm = burnt.build(ctx.mats.barkDead); if (bm) ctx.group.add(bm);

  // ── THE CAMPFIRE. Still burning. This is the "someone was here minutes ago"
  // beat the reference frame sells, and mechanically it is the brightest warm
  // source in the map.
  ctx.practicals.add({
    x: fx, y: fy + 0.32, z: fz,
    color: K2000, intensity: 17, range: 15,
    flicker: 'flame', bulb: 0.15, glow: 3.2, tag: 'campfire',
  });
  // a second, dimmer, higher node so the light has vertical extent — a single
  // point at ember height lights the ground and nothing else, which is why
  // most procedural campfires look like a glowing puddle.
  ctx.practicals.add({
    x: fx, y: fy + 0.85, z: fz,
    color: K2400, intensity: 7, range: 11,
    flicker: 'flame', bulb: 0.06, glow: 1.6, tag: 'campfire',
  });

  // ── tents: sagging fabric, not tent-shaped boxes
  const tentSpots: { x: number; z: number }[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const r = rng.range(6.5, 10.5);
    const tx = zn.x + Math.cos(a) * r, tz = zn.z + Math.sin(a) * r;
    const ty = ctx.g(tx, tz);
    const tyaw = rng.range(0, 6.28);
    tentSpots.push({ x: tx, z: tz });
    const pole = new Batch();
    const TL = rng.range(2.3, 2.9), TW = rng.range(1.7, 2.1), TH = rng.range(1.1, 1.45);
    // ridge pole + two A-frames
    pole.cyl(0.03, 0.03, TL, 5, tx, ty + TH, tz, 0, tyaw, Math.PI / 2);
    for (const s of [-1, 1]) {
      const ex = tx + Math.cos(tyaw) * s * TL / 2, ez = tz + Math.sin(tyaw) * s * TL / 2;
      pole.cyl(0.025, 0.03, TH * 1.18, 5, ex, ty + TH / 2, ez, 0.3, tyaw, 0);
    }
    const pm = pole.build(ctx.mats.metalRust); if (pm) ctx.group.add(pm);
    // two fly panels draped either side of the ridge
    for (const s of [-1, 1]) {
      const panel = saggingPanel(rng, TL, TW * 0.62, rng.range(0.1, 0.22), rng.range(0, 0.3));
      const mesh = new THREE.Mesh(panel, ctx.mats.tentFabric);
      mesh.position.set(tx, ty + TH * 0.62, tz);
      mesh.rotation.set(s * 0.72, tyaw, 0);
      mesh.castShadow = true; mesh.receiveShadow = true;
      ctx.group.add(mesh);
      ctx.flap(mesh, mesh.rotation.x, 0.035, rng.range(1.6, 2.6));
    }
    ctx.col.addBox({
      x: tx, z: tz, hx: TL / 2, hz: TW / 2, yaw: tyaw,
      y0: ty, y1: ty + TH, kind: 'obstacle',
    });
    ctx.tape(zn.id, tx, tz, 0.4);
  }

  // ── picnic table with a lantern on it (reference image 2, foreground)
  const ptA = rng.range(0, 6.28);
  const px = zn.x + Math.cos(ptA) * 4.4, pz = zn.z + Math.sin(ptA) * 4.4;
  const py = ctx.g(px, pz);
  const tbl = new Batch();
  const TA = rng.range(0, 6.28);
  const TF = frame(px, pz, TA);
  for (let i = 0; i < 5; i++) {
    tbl.box(2.1, 0.05, 0.24, TF(0, -0.5 + i * 0.25).x, py + 0.74, TF(0, -0.5 + i * 0.25).z,
      0, TA, rng.range(-0.012, 0.012));
  }
  for (const s of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      tbl.box(2.1, 0.05, 0.26, TF(0, s * (0.95 + i * 0.27)).x, py + 0.44, TF(0, s * (0.95 + i * 0.27)).z, 0, TA, 0);
    }
  }
  for (const s of [-1, 1]) {
    const l = TF(s * 0.85, 0);
    tbl.box(0.09, 0.74, 1.9, l.x, py + 0.37, l.z, 0, TA, 0);
  }
  const tm = tbl.build(ctx.mats.woodRot); if (tm) ctx.group.add(tm);
  ctx.col.addBox({ x: px, z: pz, hx: 1.1, hz: 1.3, yaw: TA, y0: py, y1: py + 0.78, kind: 'obstacle' });
  // the lantern
  const lp = TF(0.55, 0);
  const lb = new Batch();
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + 0.5;
    lb.box(0.022, 0.2, 0.022, lp.x + Math.cos(a) * 0.07, py + 0.88, lp.z + Math.sin(a) * 0.07);
  }
  lb.box(0.2, 0.03, 0.2, lp.x, py + 0.99, lp.z);
  lb.box(0.17, 0.035, 0.17, lp.x, py + 0.77, lp.z);
  const lbm = lb.build(ctx.mats.metalRust); if (lbm) ctx.group.add(lbm);
  ctx.practicals.add({
    x: lp.x, y: py + 0.88, z: lp.z, color: K2400,
    intensity: 8, range: 12, flicker: 'lantern', bulb: 0.07, glow: 1.5, tag: 'camp-lantern',
  });
  ctx.tape(zn.id, px, pz, 0.85);

  // ── the CAMPGROUND sign + CAMP RULES board (reference image 2's narrative core)
  const sA = rng.range(0, 6.28);
  const sx = zn.x + Math.cos(sA) * 13, sz = zn.z + Math.sin(sA) * 13;
  noticeBoard(ctx, sx, sz, sA + Math.PI, 5, true);
  signpost(ctx, zn.x + Math.cos(sA + 1.2) * 12, zn.z + Math.sin(sA + 1.2) * 12, sA, [
    { label: 'PINE LAKE', bearing: sA + 0.6 },
    { label: 'WATCHTOWER', bearing: sA + 2.6 },
    { label: 'TRAIL JUNCTION', bearing: sA + 4.3 },
  ], true);

  ctx.tape(zn.id, zn.x - 5, zn.z + 6.5, 0.5);
  ctx.tape(zn.id, sx + 1.4, sz - 1.1, 0.5);
  void tentSpots;
}

/* ══════════════════════════════════════════════════════════════════════════
   4. DOCK / 5. QUARRY — kept close to the versions that already worked, but
   re-homed onto the kit and given practicals.
   ══════════════════════════════════════════════════════════════════════════ */
function buildDock(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const lake = ctx.hf.layout.lake;
  const gy = ctx.g(zn.x, zn.z);
  const dirX = lake.x - zn.x, dirZ = lake.z - zn.z;
  const dl = Math.hypot(dirX, dirZ) || 1;
  const nx = dirX / dl, nz = dirZ / dl;
  const yaw = Math.atan2(nx, nz);

  const wood = new Batch();
  // planks: individually sized/tilted, some missing entirely
  for (let i = 0; i < 9; i++) {
    if (rng.next() < 0.12) continue;      // rotted through — a real gap
    const px = zn.x + nx * (i * 2 + 1), pz = zn.z + nz * (i * 2 + 1);
    for (let k = 0; k < 4; k++) {
      const off = -0.6 + k * 0.4;
      wood.box(rng.range(0.3, 0.38), 0.09, 2.0,
        px + Math.cos(yaw) * off, gy + 0.9 - i * 0.02 + rng.range(-0.02, 0.02), pz + Math.sin(yaw) * off,
        rng.range(-0.02, 0.02), yaw, rng.range(-0.03, 0.03));
    }
  }
  for (let i = 0; i < 5; i++) {
    const px = zn.x + nx * (i * 3.5 + 2) + nz * 0.85, pz = zn.z + nz * (i * 3.5 + 2) - nx * 0.85;
    wood.box(0.15, 1.7, 0.15, px, gy + 0.55, pz, rng.range(-0.04, 0.04), yaw, rng.range(-0.05, 0.05));
    const px2 = zn.x + nx * (i * 3.5 + 2) - nz * 0.85, pz2 = zn.z + nz * (i * 3.5 + 2) + nx * 0.85;
    wood.box(0.15, 1.7, 0.15, px2, gy + 0.55, pz2, rng.range(-0.04, 0.04), yaw, rng.range(-0.05, 0.05));
  }
  const wm = wood.build(ctx.mats.woodRot); if (wm) ctx.group.add(wm);
  ctx.col.addPlatform({ x: zn.x + nx * 9, z: zn.z + nz * 9, hx: 1.0, hz: 9.5, yaw, y: gy + 0.96, step: 0 });

  // half-sunk rowboat
  const bx = zn.x + nx * 13 + nz * 3.4, bz = zn.z + nz * 13 - nx * 3.4;
  const hull = new THREE.Mesh(
    new THREE.CylinderGeometry(0.72, 0.42, 2.9, 9, 1, false, 0, Math.PI), ctx.mats.woodRot);
  hull.rotation.set(0.26, yaw + 0.5, Math.PI / 2 + 0.12);
  hull.scale.set(1, 1, 0.5);
  hull.position.set(bx, lake.y + 0.15, bz);
  hull.castShadow = true;
  ctx.group.add(hull);
  ctx.col.addBox({ x: bx, z: bz, hx: 1.4, hz: 0.85, yaw: yaw + 0.5, y0: lake.y - 0.5, y1: lake.y + 1, kind: 'obstacle' });

  // A lamp on the last post: the reference's pier light, and the thing that
  // makes the lake read as a surface (it gives the water something to reflect).
  const lx = zn.x + nx * 16.5, lz = zn.z + nz * 16.5;
  const post = new Batch();
  post.box(0.13, 2.6, 0.13, lx, gy + 1.1, lz, 0, yaw, 0.03);
  post.box(0.34, 0.05, 0.34, lx, gy + 2.4, lz);
  const pm = post.build(ctx.mats.metalRust); if (pm) ctx.group.add(pm);
  ctx.practicals.add({
    x: lx, y: gy + 2.24, z: lz, color: K2700,
    intensity: 9, range: 20, flicker: 'lantern', bulb: 0.1, glow: 2.6, tag: 'dock',
  });

  ctx.tape(zn.id, zn.x + nx * 6, zn.z + nz * 6, 1.1);
  ctx.tape(zn.id, bx, bz, 0.8);
  ctx.tape(zn.id, zn.x - 3, zn.z + 4, 0.5);
  ctx.tape(zn.id, zn.x + 4, zn.z - 3, 0.5);
  signpost(ctx, zn.x - nx * 5 + nz * 4, zn.z - nz * 5 - nx * 4, yaw + 2.2, [
    { label: 'SOUTH DOCK', bearing: yaw }, { label: 'CAMPGROUND', bearing: yaw + 2.4 },
  ], false);
}

function buildQuarry(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const gy = ctx.g(zn.x, zn.z);
  // benched walls are terrain's job; we add the plant that died here
  const rock = new Batch();
  for (let i = 0; i < 26; i++) {
    const a = rng.range(0, 6.28), r = rng.range(3, zn.r * 0.78);
    const bx = zn.x + Math.cos(a) * r, bz = zn.z + Math.sin(a) * r;
    const b = boulder(rng, rng.range(0.4, 1.9), rng.range(0.5, 0.95));
    b.translate(bx, ctx.g(bx, bz) + rng.range(-0.15, 0.25), bz);
    rock.raw(b);
    if (i < 8) {
      ctx.col.addBox({
        x: bx, z: bz, hx: 0.9, hz: 0.9, yaw: 0,
        y0: ctx.g(bx, bz) - 0.5, y1: ctx.g(bx, bz) + 1.2, kind: 'obstacle',
      });
    }
  }
  const rm = rock.build(ctx.mats.rock); if (rm) ctx.group.add(rm);

  // the excavator: a body, a boom and the scoop, left where it stopped
  const mach = new Batch();
  const mx = zn.x + rng.range(-8, 8), mz = zn.z + rng.range(-8, 8);
  const my = ctx.g(mx, mz);
  const myaw = rng.range(0, 6.28);
  mach.box(2.6, 1.5, 3.4, mx, my + 1.15, mz, 0, myaw, 0);
  mach.box(2.2, 0.9, 2.0, mx, my + 2.2, mz, 0, myaw, 0);
  // boom, dropped
  const bA = myaw + 0.5;
  mach.box(0.4, 0.4, 4.2, mx + Math.cos(bA) * 2.2, my + 1.5, mz + Math.sin(bA) * 2.2, 0.35, bA, 0);
  // tracks
  for (const s of [-1, 1]) {
    mach.box(0.7, 0.8, 3.6, mx + Math.cos(myaw + 1.57) * s * 1.2, my + 0.4,
      mz + Math.sin(myaw + 1.57) * s * 1.2, 0, myaw, 0);
  }
  const mm = mach.build(ctx.mats.metalRust); if (mm) ctx.group.add(mm);
  ctx.col.addBox({ x: mx, z: mz, hx: 1.6, hz: 2.0, yaw: myaw, y0: my, y1: my + 2.6, kind: 'obstacle' });

  // A single failing floodlight on a pole, still fed from somewhere. The
  // stutter is the point: it makes the quarry feel electrically alive and
  // wrong, and it is the only cool-ish practical in the map besides the tower.
  const px = mx + Math.cos(myaw + 2) * 6, pz = mz + Math.sin(myaw + 2) * 6;
  const py = ctx.g(px, pz);
  const pole = new Batch();
  pole.box(0.16, 5.2, 0.16, px, py + 2.6, pz, 0, 0, 0.02);
  pole.box(0.5, 0.3, 0.42, px, py + 5.05, pz, 0.3, myaw, 0);
  const plm = pole.build(ctx.mats.metalPaint); if (plm) ctx.group.add(plm);
  ctx.practicals.add({
    x: px, y: py + 4.9, z: pz, color: K4200,
    intensity: 14, range: 26, flicker: 'fluor', bulb: 0.13, glow: 3.0, tag: 'quarry',
  });

  ctx.tape(zn.id, mx + 1.6, mz + 1.4, 0.9);
  ctx.tape(zn.id, zn.x - 6, zn.z + 6, 0.5);
  ctx.tape(zn.id, zn.x + 11, zn.z - 4, 0.5);
  ctx.tape(zn.id, zn.x - 2, zn.z - 8, 0.5);
  noticeBoard(ctx, zn.x + Math.cos(myaw + 3) * 14, zn.z + Math.sin(myaw + 3) * 14, myaw + 3, 3, false);
}

/* ══════════════════════════════════════════════════════════════════════════
   6. SHACK — "Door barred from the inside."
   Heavy decay: this is where plankWall's decay parameter earns its keep.
   ══════════════════════════════════════════════════════════════════════════ */
function buildShack(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const gy = ctx.g(zn.x, zn.z);
  const yaw = rng.range(0, 6.28);
  const L = frame(zn.x, zn.z, yaw);
  const W = 4.2, D = 3.6, WH = 2.2;
  const clad = new Batch(), studs = new Batch(), roof = new Batch();

  // decay 0.55: half the boards gone, studs exposed, dark gaps between them.
  // The interior darkness visible through the gaps is the whole effect.
  const sides: [number, number, number, number][] = [
    [0, D / 2, W, yaw], [0, -D / 2, W, yaw + Math.PI],
    [-W / 2, 0, D, yaw + Math.PI / 2], [W / 2, 0, D, yaw - Math.PI / 2],
  ];
  for (let i = 0; i < sides.length; i++) {
    const [ox, oz, len, wyaw] = sides[i];
    const p = L(ox, oz);
    plankWall(clad, studs, rng, p.x, gy, p.z, wyaw, {
      len, h: WH, decay: 0.42 + rng.range(0, 0.22),
      voids: i === 0 ? [[0, 1.0, 0.95, 2.0]] : [],
    });
    ctx.col.addBox({ x: p.x, z: p.z, hx: len / 2, hz: 0.14, yaw: wyaw, y0: gy, y1: gy + WH, kind: 'wall' });
  }
  // roof partially collapsed: one side present, one side sagged in
  shingleRoof(roof, rng, zn.x, gy + WH, zn.z, yaw, W + 0.5, D + 0.6, 0.75, 0.6);
  // the boards barring the door, nailed across on the OUTSIDE — which is the
  // detail that makes "barred from the inside" a lie, and that is the story.
  const dp = L(0, D / 2 + 0.06);
  for (let i = 0; i < 3; i++) {
    clad.box(1.5, 0.2, 0.05, dp.x, gy + 0.6 + i * 0.55, dp.z, 0, yaw, rng.range(-0.09, 0.09));
  }
  const cm = clad.build(ctx.mats.woodRot); if (cm) ctx.group.add(cm);
  const smh = studs.build(ctx.mats.woodRot); if (smh) ctx.group.add(smh);
  const rmh = roof.build(ctx.mats.woodRot); if (rmh) ctx.group.add(rmh);

  // No practical inside — this is the one structure that is genuinely dark,
  // and it matters that the map has one. A single dying lamp on a pole outside
  // gives it a rim so the silhouette still reads.
  const lp = L(W * 0.9, D * 0.9);
  ctx.practicals.add({
    x: lp.x, y: gy + 2.7, z: lp.z, color: K2700,
    intensity: 4.5, range: 12, flicker: 'fluor', bulb: 0.08, glow: 1.5, tag: 'shack',
  });
  const pole = new Batch();
  pole.box(0.12, 3.0, 0.12, lp.x, gy + 1.5, lp.z, 0, 0, rng.range(-0.05, 0.05));
  const pm = pole.build(ctx.mats.woodRot); if (pm) ctx.group.add(pm);

  ctx.tape(zn.id, zn.x, zn.z, 0.5);
  ctx.tape(zn.id, L(W * 0.7, -D * 0.6).x, L(W * 0.7, -D * 0.6).z, 0.5);
  ctx.tape(zn.id, L(-W * 0.8, D * 0.5).x, L(-W * 0.8, D * 0.5).z, 0.5);
  ctx.tape(zn.id, lp.x + 1.2, lp.z + 0.8, 0.5);
  missingPoster(ctx, L(-W / 2 - 0.1, 0.4).x, L(-W / 2 - 0.1, 0.4).z, yaw + Math.PI / 2, gy + 1.5);
}

/* ══════════════════════════════════════════════════════════════════════════
   7-13. NATURAL + NAVIGATION LANDMARKS
   These have no building, so their job is silhouette and orientation. Without
   them the terrain's flattened clearing is the only thing there — which is
   exactly the bug this file fixes.
   ══════════════════════════════════════════════════════════════════════════ */
function buildRockFormation(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const rock = new Batch();
  // A stacked outcrop: a few big masses with smaller debris skirting them, so
  // it reads as one formation rather than scattered rocks.
  const cores = 4;
  for (let i = 0; i < cores; i++) {
    const a = (i / cores) * 6.28 + rng.range(-0.5, 0.5);
    const r = rng.range(0, 7);
    const bx = zn.x + Math.cos(a) * r, bz = zn.z + Math.sin(a) * r;
    const by = ctx.g(bx, bz);
    const size = rng.range(3.2, 5.6);
    const b = boulder(rng, size, rng.range(0.55, 0.85));
    b.translate(bx, by + size * 0.28, bz);
    rock.raw(b);
    ctx.col.addBox({
      x: bx, z: bz, hx: size * 0.72, hz: size * 0.72, yaw: 0,
      y0: by - 1, y1: by + size * 0.8, kind: 'entity-block',
    });
    // climbable shelf on one side, so the formation is enterable
    if (i === 0) {
      ctx.col.addPlatform({ x: bx, z: bz, hx: size * 0.5, hz: size * 0.5, yaw: 0, y: by + size * 0.62, step: 0.7 });
      ctx.tape(zn.id, bx, bz, size * 0.62 + 0.35);
    }
  }
  for (let i = 0; i < 22; i++) {
    const a = rng.range(0, 6.28), r = rng.range(5, zn.r * 0.8);
    const bx = zn.x + Math.cos(a) * r, bz = zn.z + Math.sin(a) * r;
    const b = boulder(rng, rng.range(0.25, 1.1), rng.range(0.4, 0.9));
    b.translate(bx, ctx.g(bx, bz) + 0.1, bz);
    rock.raw(b);
  }
  const rm = rock.build(ctx.mats.rock); if (rm) ctx.group.add(rm);
  ctx.tape(zn.id, zn.x + 5, zn.z - 4, 0.5);
  ctx.tape(zn.id, zn.x - 6, zn.z + 3, 0.5);
  ctx.tape(zn.id, zn.x + 2, zn.z + 7, 0.5);
  // a lantern left on a rock by someone who came here before you
  const la = rng.range(0, 6.28);
  const lx = zn.x + Math.cos(la) * 8, lz = zn.z + Math.sin(la) * 8;
  ctx.practicals.add({
    x: lx, y: ctx.g(lx, lz) + 0.55, z: lz, color: K2400,
    intensity: 6, range: 11, flicker: 'lantern', bulb: 0.08, glow: 1.5, tag: 'left-lantern',
  });
}

function buildRidge(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  // The high ground: a survey marker cairn and a bench. Sightline landmark, so
  // the readable thing is the cairn's vertical against the sky.
  const rock = new Batch();
  const ch = 2.4;
  for (let i = 0; i < 14; i++) {
    const t = i / 14;
    const r = (1 - t) * 0.85 + 0.12;
    const a = rng.range(0, 6.28);
    const b = boulder(rng, r, rng.range(0.35, 0.6));
    b.translate(zn.x + Math.cos(a) * (1 - t) * 0.4, ctx.g(zn.x, zn.z) + t * ch + r * 0.3,
      zn.z + Math.sin(a) * (1 - t) * 0.4);
    rock.raw(b);
  }
  for (let i = 0; i < 16; i++) {
    const a = rng.range(0, 6.28), r = rng.range(4, zn.r * 0.7);
    const bx = zn.x + Math.cos(a) * r, bz = zn.z + Math.sin(a) * r;
    const b = boulder(rng, rng.range(0.3, 1.4), rng.range(0.4, 0.8));
    b.translate(bx, ctx.g(bx, bz) + 0.1, bz);
    rock.raw(b);
  }
  const rm = rock.build(ctx.mats.rock); if (rm) ctx.group.add(rm);
  const gy = ctx.g(zn.x, zn.z);
  ctx.col.addBox({ x: zn.x, z: zn.z, hx: 1.0, hz: 1.0, yaw: 0, y0: gy, y1: gy + ch, kind: 'obstacle' });

  // A survey tripod: unmistakably human, unmistakably abandoned.
  const tri = new Batch();
  const tA = rng.range(0, 6.28);
  for (let k = 0; k < 3; k++) {
    const a = tA + (k / 3) * 6.28;
    const ex = Math.cos(a) * 0.85, ez = Math.sin(a) * 0.85;
    tri.box(0.06, 2.5, 0.06, zn.x + 4 + ex / 2, gy + 1.2, zn.z + ex * 0 + ez / 2,
      Math.sin(a) * 0.32, 0, -Math.cos(a) * 0.32);
  }
  tri.box(0.3, 0.22, 0.3, zn.x + 4, gy + 2.42, zn.z);
  const tm = tri.build(ctx.mats.metalRust); if (tm) ctx.group.add(tm);
  ctx.practicals.add({
    x: zn.x + 4, y: gy + 2.5, z: zn.z, color: 0xff5533,
    intensity: 3.5, range: 9, flicker: 'beacon', bulb: 0.055, glow: 1.0, tag: 'ridge',
  });

  ctx.tape(zn.id, zn.x + 1.4, zn.z + 1.2, 0.6);
  ctx.tape(zn.id, zn.x + 4, zn.z + 0.6, 0.5);
  ctx.tape(zn.id, zn.x - 5, zn.z - 4, 0.5);
  signpost(ctx, zn.x - 6, zn.z + 5, rng.range(0, 6.28), [
    { label: 'NORTH RIDGE', bearing: 0.4 }, { label: 'QUARRY', bearing: 2.9 },
  ], true);
}

function buildClearing(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  // Windthrow gap: the trees that fell to make it are still lying here. This
  // is the explanation for the clearing, and without it the flat circle is
  // just an authoring artefact.
  const logs = new Batch();
  for (let i = 0; i < 9; i++) {
    const a = rng.range(0, 6.28), r = rng.range(2, zn.r * 0.75);
    const lx = zn.x + Math.cos(a) * r, lz = zn.z + Math.sin(a) * r;
    const ly = ctx.g(lx, lz);
    const len = rng.range(7, 15), rad = rng.range(0.3, 0.62);
    // All roughly aligned: a windthrow gap has a direction, and that direction
    // is a navigational cue the player can read.
    const dir = 1.15 + rng.range(-0.35, 0.35);
    logs.cyl(rad * rng.range(0.7, 1), rad, len, 7, lx, ly + rad * 0.85, lz,
      0, dir, Math.PI / 2 + rng.range(-0.06, 0.06));
    ctx.col.addBox({
      x: lx, z: lz, hx: len / 2, hz: rad * 1.3, yaw: dir,
      y0: ly, y1: ly + rad * 1.8, kind: 'obstacle',
    });
    // root plate at one end — the big vertical disc that makes a windthrow read
    if (i < 4) {
      const rx = lx + Math.cos(dir) * len / 2, rz = lz + Math.sin(dir) * len / 2;
      const rp = boulder(rng, rad * 3.4, 0.32);
      rp.translate(rx, ctx.g(rx, rz) + rad * 1.6, rz);
      logs.raw(rp);
    }
  }
  const lm = logs.build(ctx.mats.barkDead); if (lm) ctx.group.add(lm);

  ctx.tape(zn.id, zn.x + 3, zn.z - 2, 0.5);
  ctx.tape(zn.id, zn.x - 4, zn.z + 5, 0.5);
  ctx.tape(zn.id, zn.x + 6, zn.z + 4, 0.5);
  signpost(ctx, zn.x, zn.z, rng.range(0, 6.28), [
    { label: 'CABIN', bearing: 0.9 }, { label: 'TRAIL JUNCTION', bearing: 3.1 },
    { label: 'NORTH RIDGE', bearing: 4.9 },
  ], true);
  missingPoster(ctx, zn.x + 1.2, zn.z + 1.6, rng.range(0, 6.28), ctx.g(zn.x, zn.z) + 1.5);
}

function buildJunction(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  // The five-way junction. This is the map's origin and the player's anchor,
  // so it gets the most information density: big signpost, notice board, and
  // the brightest non-fire practical so it can be found from any approach.
  signpost(ctx, zn.x, zn.z, rng.range(0, 6.28), [
    { label: 'PINE LAKE', bearing: 1.55 }, { label: 'CABIN', bearing: 0.35 },
    { label: 'OLD QUARRY', bearing: 3.6 }, { label: 'WATCHTOWER', bearing: 2.6 },
    { label: 'EAST TRAIL', bearing: 5.4 },
  ], true);
  noticeBoard(ctx, zn.x + 3.4, zn.z + 1.2, rng.range(0, 6.28), 6, true);
  // a bench, and a boot left under it
  const gy = ctx.g(zn.x - 3, zn.z + 2);
  const b = new Batch();
  b.box(1.8, 0.07, 0.4, zn.x - 3, gy + 0.45, zn.z + 2, 0, 0.6, 0);
  for (const s of [-1, 1]) b.box(0.09, 0.45, 0.35, zn.x - 3 + s * 0.75, gy + 0.22, zn.z + 2, 0, 0.6, 0);
  const bm = b.build(ctx.mats.woodRot); if (bm) ctx.group.add(bm);
  ctx.tape(zn.id, zn.x - 3, zn.z + 2, 0.6);
  ctx.tape(zn.id, zn.x + 3.4, zn.z + 1.2, 0.5);
  ctx.tape(zn.id, zn.x - 1.5, zn.z - 3.5, 0.5);
  missingPoster(ctx, zn.x - 4.5, zn.z - 1, rng.range(0, 6.28), gy + 1.6);
}

function buildTrailhead(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  const gy = ctx.g(zn.x, zn.z);
  // A gate, a sign and a lamp. This is an EXIT, so it must be unmistakable
  // from a distance — it is the win condition made visible.
  const m = new Batch();
  for (const s of [-1, 1]) {
    m.box(0.22, 1.6, 0.22, zn.x, gy + 0.8, zn.z + s * 3.2, 0, 0, rng.range(-0.03, 0.03));
  }
  m.box(0.12, 0.12, 6.4, zn.x, gy + 1.2, zn.z, 0, 0, 0);
  const mm = m.build(ctx.mats.metalPaint); if (mm) ctx.group.add(mm);
  ctx.col.addBox({ x: zn.x, z: zn.z + 3.2, hx: 0.3, hz: 0.3, yaw: 0, y0: gy, y1: gy + 1.6, kind: 'prop' });
  ctx.col.addBox({ x: zn.x, z: zn.z - 3.2, hx: 0.3, hz: 0.3, yaw: 0, y0: gy, y1: gy + 1.6, kind: 'prop' });

  signpost(ctx, zn.x + 1.6, zn.z + 4.2, rng.range(0, 6.28), [
    { label: zn.name.toUpperCase(), bearing: 0 },
  ], true);
  noticeBoard(ctx, zn.x - 2.2, zn.z - 4.4, rng.range(0, 6.28), 4, true);
  // The exit lamp: brightest steady warm source in the map. Hope, basically.
  ctx.practicals.add({
    x: zn.x, y: gy + 3.3, z: zn.z, color: K2700,
    intensity: 13, range: 25, flicker: 'lantern', bulb: 0.12, glow: 3.4, tag: 'exit',
  });
  const pole = new Batch();
  pole.box(0.14, 3.6, 0.14, zn.x, gy + 1.8, zn.z, 0, 0, 0.015);
  pole.box(0.42, 0.06, 0.42, zn.x, gy + 3.5, zn.z);
  const pm = pole.build(ctx.mats.metalRust); if (pm) ctx.group.add(pm);

  ctx.tape(zn.id, zn.x + 2.4, zn.z + 2.0, 0.5);
  ctx.tape(zn.id, zn.x - 2.2, zn.z - 4.4, 0.5);
  ctx.tape(zn.id, zn.x + 4, zn.z - 2, 0.5);
}

function buildLakeShore(ctx: LandmarkCtx, zn: Zone): void {
  const { rng } = ctx;
  // Reed beds and driftwood along the west arm. The lake itself is water and
  // terrain; what it needs is a readable edge, otherwise the shoreline is a
  // hard geometric line between two flat planes.
  const drift = new Batch();
  const shore = ctx.hf.layout.lake.shore;
  for (let i = 0; i < 34; i++) {
    const p = shore[Math.floor(rng.next() * shore.length)];
    const a = Math.atan2(p.z - zn.z, p.x - zn.x);
    const px = p.x + Math.cos(a) * rng.range(0.5, 4.5);
    const pz = p.z + Math.sin(a) * rng.range(0.5, 4.5);
    const py = ctx.g(px, pz);
    if (rng.next() < 0.55) {
      const len = rng.range(1.6, 4.4), rad = rng.range(0.1, 0.3);
      drift.cyl(rad * 0.7, rad, len, 6, px, py + rad * 0.7, pz,
        0, rng.range(0, 6.28), Math.PI / 2 + rng.range(-0.1, 0.1));
    } else {
      const b = boulder(rng, rng.range(0.25, 0.8), rng.range(0.35, 0.7));
      b.translate(px, py + 0.08, pz);
      drift.raw(b);
    }
  }
  const dm = drift.build(ctx.mats.barkDead); if (dm) ctx.group.add(dm);

  /**
   * Walk outward from a shore vertex until the point is genuinely dry.
   *
   * `zn.x/zn.z` is the lake CENTROID, so any offset from it lands in open
   * water — the first version of this function placed all three tape spots and
   * the far-shore lamp under the surface, where the tape is unreachable and the
   * lamp is invisible. The lake is a traced polygon, not a circle, so there is
   * no radius that is reliably "just past the edge"; the only robust answer is
   * to step out along the outward normal and test.
   */
  const dryNear = (i: number): { x: number; z: number } => {
    const p = shore[i % shore.length];
    const a = Math.atan2(p.z - zn.z, p.x - zn.x);
    for (let step = 1; step <= 14; step++) {
      const qx = p.x + Math.cos(a) * step * 1.4;
      const qz = p.z + Math.sin(a) * step * 1.4;
      if (!ctx.hf.inLake(qx, qz)) return { x: qx, z: qz };
    }
    return { x: p.x + Math.cos(a) * 20, z: p.z + Math.sin(a) * 20 };
  };

  // Spread the hiding places right around the shoreline rather than clustering
  // them, so "the tape is somewhere on the lake" is a real search.
  const n = shore.length;
  for (const frac of [0.08, 0.34, 0.61, 0.86]) {
    const s = dryNear(Math.floor(frac * n));
    ctx.tape(zn.id, s.x, s.z, 0.5);
  }

  // A lamp on the far shore. Its only job is to be a warm point across water:
  // it gives the lake scale and tells the player the far side exists — and the
  // water gets something to reflect, which is what makes it read as a surface.
  const far = dryNear(Math.floor(rng.next() * n));
  ctx.practicals.add({
    x: far.x, y: ctx.g(far.x, far.z) + 2.2, z: far.z, color: K2400,
    intensity: 7, range: 22, flicker: 'lantern', bulb: 0.1, glow: 3.0, tag: 'far-shore',
  });
}

/** Practical-pool sizing per quality tier, exported so Config stays declarative. */
export function practicalPoolFor(tier: string): number {
  switch (tier) {
    case 'low': return 3;
    case 'medium': return 4;
    case 'high': return 6;
    default: return 8;
  }
}

export { landmark };
