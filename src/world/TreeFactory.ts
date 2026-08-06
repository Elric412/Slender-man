import * as THREE from 'three';
import { SeededRandom } from '../core/SeededRandom';
import { TILE, ATLAS_ATTRIBUTE } from './ForestAtlas';
import type { ArchetypeId, Condition } from './ZoneSystem';

/**
 * TreeFactory — 7 archetypes x 5 structural variants, x condition overlays.
 *
 * ## What was actually wrong
 *
 * The old system had three geometry makers (`makePine`, `makeBroadleaf`,
 * `makeBirch`) with a `variant` integer that only perturbed *scale and
 * proportion*. Three shapes, uniformly scaled, is why the forest read as one
 * tree nudged a few feet over: a viewer does not register "that trunk is 8%
 * thicker", they register **silhouette**. Two trees that share a branch layout
 * are the same tree at any scale.
 *
 * So every variant here differs in *structure*:
 *
 *  - where the crown starts as a fraction of height (a clean 60% bole vs.
 *    foliage to the ground are not the same tree);
 *  - whorl count and vertical spacing;
 *  - branch angle profile from apex to base (drooping vs. ascending);
 *  - whether the leader forks, and at what height;
 *  - crown radius *profile* (spire / ovoid / flat-topped / one-sided);
 *  - lean, and whether the crown re-corrects for the lean (phototropism) or
 *    follows it;
 *  - asymmetric suppression — a forest-grown tree with a neighbour on one side
 *    has almost no crown on that side, and that is the single most recognisable
 *    "real forest" cue there is.
 *
 * Absolute height is then a *finishing* jitter on top of that, exactly the
 * inverse of the old system's priority.
 *
 * ## Conditions are not tints
 *
 * `healthy | stormDamaged | dying | longDead | mossHeavy` change which atlas
 * tiles the verts point at, how much foliage exists at all, and whether extra
 * geometry appears (moss drapery, snapped stubs, bark-loss patches). A dying
 * conifer is not a green conifer with a brown multiplier — it is a *gappier*
 * crown with `needleSparse` cards and a thinner top.
 *
 * ## Two geometries, not two materials
 *
 * Each template emits a **bark** buffer and a **foliage** buffer, because those
 * are the only two materials in the forest (opaque vs. alpha-tested
 * double-sided). Everything else — which of the 16 atlas tiles, how many
 * repeats, what tint — rides on vertex data. That is what makes 35 geometries
 * cost the same as 3, and therefore what makes variety affordable at all.
 *
 * Output is raw typed arrays rather than `BufferGeometry` on purpose: the
 * scatter system concatenates transformed copies into one merged buffer per
 * chunk, so a chunk of forty different trees is two draw calls. Handing it
 * `BufferGeometry` would mean allocating and immediately discarding 35 GPU
 * resources per chunk.
 */

// ============================================================================
// tuning constants
// ============================================================================

/**
 * World size of one bark tile repeat, in metres.
 *
 * This is the texel-density knob for every trunk in the world. At a 512 atlas
 * each cell is ~124 usable texels, so 2.4 m gives ~52 texels/m — enough that
 * fissures resolve at arm's length, coarse enough that a 30 m trunk only tiles
 * ~12 times. Held constant across archetypes so a sapling and a veteran do not
 * visibly disagree about how big bark is, which is the "inconsistent texel
 * density" defect in the quality bar.
 */
const BARK_TILE_WORLD = 2.4;

/** Bark repeat size for thin stems — a 6 cm sapling stem needs finer bark. */
const BARK_TILE_WORLD_FINE = 0.9;

/** Radial segment counts per LOD. */
const RADIAL = [8, 6, 4];

/** Silhouette signature resolution — 32 height bands. */
const SIL_BINS = 32;

// ============================================================================
// raw geometry buffers
// ============================================================================

export interface RawGeo {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  color: Float32Array;
  /** vec3(tileIndex, repeatsU, repeatsV) — see ForestAtlas.ATLAS_ATTRIBUTE */
  tile: Float32Array;
  index: Uint32Array;
}

/** Bytes of GPU memory one RawGeo will occupy once uploaded. */
export function rawGeoBytes(g: RawGeo): number {
  return g.position.byteLength + g.normal.byteLength + g.uv.byteLength
       + g.color.byteLength + g.tile.byteLength + g.index.byteLength;
}

/** Turn a RawGeo into a real BufferGeometry (used by the verifier and by LOD0). */
export function rawToBufferGeometry(g: RawGeo): THREE.BufferGeometry {
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(g.position, 3));
  bg.setAttribute('normal', new THREE.BufferAttribute(g.normal, 3));
  bg.setAttribute('uv', new THREE.BufferAttribute(g.uv, 2));
  bg.setAttribute('color', new THREE.BufferAttribute(g.color, 3));
  bg.setAttribute(ATLAS_ATTRIBUTE, new THREE.BufferAttribute(g.tile, 3));
  bg.setIndex(new THREE.BufferAttribute(g.index, 1));
  bg.computeBoundingSphere();
  return bg;
}

/**
 * Growable vertex accumulator.
 *
 * Plain arrays rather than pre-sized typed arrays because branch counts are
 * data-driven and a mis-guessed capacity is a silent truncation. Copied out to
 * typed arrays exactly once, in `finish()`.
 */
class Builder {
  private px: number[] = [];
  private nx: number[] = [];
  private uvs: number[] = [];
  private cols: number[] = [];
  private tiles: number[] = [];
  private idx: number[] = [];

  get count(): number { return this.px.length / 3; }

  vert(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    r: number, g: number, b: number,
    tile: number, ru: number, rv: number,
  ): number {
    const i = this.px.length / 3;
    this.px.push(x, y, z);
    this.nx.push(nx, ny, nz);
    this.uvs.push(u, v);
    this.cols.push(r, g, b);
    this.tiles.push(tile, ru, rv);
    return i;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  finish(): RawGeo | null {
    if (this.idx.length === 0) return null;
    return {
      position: new Float32Array(this.px),
      normal: new Float32Array(this.nx),
      uv: new Float32Array(this.uvs),
      color: new Float32Array(this.cols),
      tile: new Float32Array(this.tiles),
      index: new Uint32Array(this.idx),
    };
  }
}

// ============================================================================
// small vector helpers (local, allocation-free where it matters)
// ============================================================================

interface V3 { x: number; y: number; z: number; }
const v3 = (x: number, y: number, z: number): V3 => ({ x, y, z });

function norm(v: V3): V3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function cross(a: V3, b: V3): V3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}
function dot(a: V3, b: V3): number { return a.x * b.x + a.y * b.y + a.z * b.z; }
function add(a: V3, b: V3): V3 { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
function scale(a: V3, s: number): V3 { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

// ============================================================================
// geometry primitives
// ============================================================================

interface LimbOpts {
  /** centreline, at least 2 points, ordered base → tip */
  path: V3[];
  /** radius at each path point */
  radii: number[];
  radialSegs: number;
  tile: number;
  /** metres per bark tile repeat — smaller for thin stems */
  tileWorld: number;
  /** vertex tint */
  r: number; g: number; b: number;
  /** close the tip into a cone (branches) or leave open (trunks that fork) */
  capTip?: boolean;
}

/**
 * Sweep a tapered tube along a path using **parallel transport frames**.
 *
 * A naive `up`-reference frame flips when the path approaches vertical, which
 * puts a visible twist and a UV shear in exactly the place you look at most: a
 * leaning trunk. Parallel transport carries the previous frame forward by the
 * minimal rotation, so the frame only rotates as much as the curve actually
 * bends.
 *
 * `repeatsU` is **rounded to an integer**, which is not optional: `u` wraps
 * 0→1 around a closed loop, and a fractional repeat count means `fract()` does
 * not return to 0 at the seam, producing a hard vertical stripe up every trunk.
 */
function limb(b: Builder, o: LimbOpts): void {
  const n = o.path.length;
  if (n < 2) return;

  // ---- tangents ----
  const tan: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = o.path[Math.max(0, i - 1)];
    const c = o.path[Math.min(n - 1, i + 1)];
    tan.push(norm(v3(c.x - a.x, c.y - a.y, c.z - a.z)));
  }

  // ---- parallel transport frames ----
  // Seed reference: anything not parallel to the first tangent.
  let ref: V3 = Math.abs(tan[0].y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
  const N: V3[] = [];
  const B: V3[] = [];
  for (let i = 0; i < n; i++) {
    const t = tan[i];
    // Gram-Schmidt the carried reference against the new tangent.
    let nrm = norm(add(ref, scale(t, -dot(ref, t))));
    if (!isFinite(nrm.x) || Math.hypot(nrm.x, nrm.y, nrm.z) < 1e-4) {
      nrm = norm(cross(t, v3(0.577, 0.577, 0.577)));
    }
    const bin = norm(cross(t, nrm));
    N.push(nrm); B.push(bin);
    ref = nrm;   // carry forward — this is the "parallel transport"
  }

  // ---- arc length for V, circumference for U ----
  const arc: number[] = [0];
  for (let i = 1; i < n; i++) {
    const p = o.path[i - 1], q = o.path[i];
    arc.push(arc[i - 1] + Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z));
  }
  const total = arc[n - 1] || 1;

  let rMax = 0;
  for (const r of o.radii) rMax = Math.max(rMax, r);
  const repeatsU = Math.max(1, Math.round((2 * Math.PI * rMax) / o.tileWorld));
  const repeatsV = Math.max(0.35, total / o.tileWorld);

  const seg = o.radialSegs;
  const base = b.count;

  for (let i = 0; i < n; i++) {
    const p = o.path[i], rad = o.radii[i];
    const v = arc[i] / total;
    // seg+1 verts so u can reach 1.0 — a shared seam vert would force u=0 and
    // u=1 onto one vertex and mirror the last column of bark.
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const nx = N[i].x * ca + B[i].x * sa;
      const ny = N[i].y * ca + B[i].y * sa;
      const nz = N[i].z * ca + B[i].z * sa;
      b.vert(
        p.x + nx * rad, p.y + ny * rad, p.z + nz * rad,
        nx, ny, nz,
        j / seg, v,
        o.r, o.g, o.b,
        o.tile, repeatsU, repeatsV,
      );
    }
  }

  const stride = seg + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const a = base + i * stride + j;
      b.quad(a, a + stride, a + stride + 1, a + 1);
    }
  }

  if (o.capTip && o.radii[n - 1] > 1e-4) {
    const tip = o.path[n - 1], t = tan[n - 1];
    const apex = b.vert(
      tip.x + t.x * o.radii[n - 1], tip.y + t.y * o.radii[n - 1], tip.z + t.z * o.radii[n - 1],
      t.x, t.y, t.z, 0.5, 1, o.r, o.g, o.b, o.tile, repeatsU, repeatsV,
    );
    const ring = base + (n - 1) * stride;
    for (let j = 0; j < seg; j++) b.tri(ring + j, apex, ring + j + 1);
  }
}

/**
 * A foliage card: a quad bowed into a 3x3 grid.
 *
 * Flat quads are the classic tell — a canopy of coplanar rectangles catches
 * light in flat facets and the eye reads "cards". Bowing costs 5 extra verts
 * and gives each card a curved normal, so light rolls across it and the crown
 * reads as volume. Normals are the *bowed surface* normals blended toward the
 * card's own axis, which keeps alpha-tested edges from going black.
 */
function card(
  b: Builder,
  cx: number, cy: number, cz: number,
  rx: number, ry: number, rz: number,   // half-width axis
  ux: number, uy: number, uz: number,   // half-height axis
  bow: number,
  tile: number,
  r: number, g: number, bl: number,
): void {
  // face normal
  let fx = ry * uz - rz * uy, fy = rz * ux - rx * uz, fz = rx * uy - ry * ux;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;

  const base = b.count;
  const G = 2;   // 2x2 quads = 3x3 verts
  for (let iy = 0; iy <= G; iy++) {
    const tv = iy / G, sv = tv * 2 - 1;
    for (let ix = 0; ix <= G; ix++) {
      const tu = ix / G, su = tu * 2 - 1;
      // Bow outward strongest at the centre of the card.
      const d = (1 - su * su) * (1 - sv * sv * 0.4) * bow;
      const px = cx + rx * su + ux * sv + fx * d;
      const py = cy + ry * su + uy * sv + fy * d;
      const pz = cz + rz * su + uz * sv + fz * d;
      // Normal tilts away from the face normal toward the card edges.
      let nx2 = fx - rx * su * bow * 1.6;
      let ny2 = fy - ry * su * bow * 1.6;
      let nz2 = fz - rz * su * bow * 1.6;
      const nl = Math.hypot(nx2, ny2, nz2) || 1;
      nx2 /= nl; ny2 /= nl; nz2 /= nl;
      b.vert(px, py, pz, nx2, ny2, nz2, tu, tv, r, g, bl, tile, 1, 1);
    }
  }
  const stride = G + 1;
  for (let iy = 0; iy < G; iy++) {
    for (let ix = 0; ix < G; ix++) {
      const a = base + iy * stride + ix;
      b.quad(a, a + 1, a + stride + 1, a + stride);
    }
  }
}

/**
 * Foliage along a branch: overlapping cards in a shallow helix.
 *
 * Cards are rolled progressively around the branch axis rather than all facing
 * one way, so the spray has no preferred viewing direction. Without the roll a
 * conifer whorl vanishes when viewed edge-on — the single most common instanced
 * -vegetation artefact.
 */
function spray(
  b: Builder, rng: SeededRandom,
  basePt: V3, dir: V3, len: number, width: number,
  count: number, tile: number,
  r: number, g: number, bl: number,
  droop: number,
): void {
  if (count <= 0 || len <= 0.05) return;
  const d = norm(dir);
  let side = norm(cross(d, Math.abs(d.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0)));
  const up = norm(cross(side, d));

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.55 : 0.14 + (i / (count - 1)) * 0.82;
    // Cards shrink toward the tip; the largest sits ~40% out, which is where a
    // real conifer branch carries most of its mass.
    const sz = width * (0.45 + Math.sin(Math.pow(t, 0.75) * Math.PI) * 0.72);
    const roll = t * 5.1 + rng.range(-0.5, 0.5) + i * 2.399;   // golden-ish
    const cr = Math.cos(roll), sr = Math.sin(roll);
    // axis in the plane perpendicular to d
    const ax = side.x * cr + up.x * sr;
    const ay = side.y * cr + up.y * sr;
    const az = side.z * cr + up.z * sr;

    const sag = -droop * t * t * len * 0.5;
    const px = basePt.x + d.x * len * t + ax * sz * 0.12;
    const py = basePt.y + d.y * len * t + ay * sz * 0.12 + sag;
    const pz = basePt.z + d.z * len * t + az * sz * 0.12;

    // Card lies along the branch (height axis = branch dir), width across it.
    card(
      b, px, py, pz,
      ax * sz, ay * sz, az * sz,
      d.x * sz * 1.15, d.y * sz * 1.15, d.z * sz * 1.15,
      sz * 0.22, tile,
      r * rng.range(0.86, 1.1), g * rng.range(0.86, 1.1), bl * rng.range(0.86, 1.1),
    );
  }
}

/**
 * Splintered fracture face for a snapped trunk.
 *
 * A storm break is not a flat cut. Long fibres tear out at different heights
 * around the circumference, so the silhouette above the break is a ragged
 * crown of spikes — which is the entire visual point of the `stormBroken`
 * archetype and reads at 60 m where the bark texture does not.
 */
function fractureCap(
  b: Builder, rng: SeededRandom,
  cx: number, cy: number, cz: number, radius: number,
  r: number, g: number, bl: number,
  severity: number,
): void {
  const spikes = 5 + Math.floor(severity * 5);
  for (let i = 0; i < spikes; i++) {
    const a0 = (i / spikes) * Math.PI * 2;
    const a1 = ((i + 1) / spikes) * Math.PI * 2;
    const h = radius * rng.range(0.5, 3.6) * (0.35 + severity);
    const rr = radius * rng.range(0.55, 1.0);
    const x0 = cx + Math.cos(a0) * rr, z0 = cz + Math.sin(a0) * rr;
    const x1 = cx + Math.cos(a1) * rr, z1 = cz + Math.sin(a1) * rr;
    const tipA = a0 + (a1 - a0) * rng.range(0.25, 0.75);
    const tx = cx + Math.cos(tipA) * rr * 0.5, tz = cz + Math.sin(tipA) * rr * 0.5;

    // Two triangles per fibre: an outer face and an inner face, so the spike
    // has thickness from every angle rather than being a billboard.
    const nA = norm(v3(Math.cos(tipA), 0.25, Math.sin(tipA)));
    const i0 = b.vert(x0, cy, z0, nA.x, nA.y, nA.z, 0, 0, r, g, bl, TILE.woodSplintered, 1, 1);
    const i1 = b.vert(x1, cy, z1, nA.x, nA.y, nA.z, 1, 0, r, g, bl, TILE.woodSplintered, 1, 1);
    const i2 = b.vert(tx, cy + h, tz, nA.x, nA.y, nA.z, 0.5, 1, r * 1.15, g * 1.12, bl * 1.05, TILE.woodSplintered, 1, 1);
    b.tri(i0, i1, i2);
    const cc = b.vert(cx, cy + h * 0.12, cz, 0, 1, 0, 0.5, 0, r * 0.7, g * 0.7, bl * 0.7, TILE.woodSplintered, 1, 1);
    b.tri(i1, i0, cc);
    b.tri(i0, i2, cc);
    b.tri(i2, i1, cc);
  }
}

/**
 * Root buttress flare.
 *
 * Big old trees do not meet the ground as cylinders. Adding three to six
 * flared roots at the base is the cheapest way to say "this tree is old", and
 * it also hides the trunk/terrain intersection, which otherwise shows as a
 * clean circle on sloping ground.
 */
function buttress(
  b: Builder, rng: SeededRandom,
  cx: number, cy: number, cz: number, trunkR: number,
  tile: number, r: number, g: number, bl: number, count: number,
): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const reach = trunkR * rng.range(1.9, 3.4);
    const rise = trunkR * rng.range(1.4, 2.8);
    const dx = Math.cos(a), dz = Math.sin(a);
    limb(b, {
      path: [
        v3(cx + dx * reach, cy - trunkR * 0.35, cz + dz * reach),
        v3(cx + dx * reach * 0.45, cy + rise * 0.35, cz + dz * reach * 0.45),
        v3(cx + dx * trunkR * 0.3, cy + rise, cz + dz * trunkR * 0.3),
      ],
      radii: [trunkR * 0.16, trunkR * 0.34, trunkR * 0.5],
      radialSegs: 4,
      tile, tileWorld: BARK_TILE_WORLD,
      r: r * 0.88, g: g * 0.88, b: bl * 0.88,
      capTip: false,
    });
  }
}

/**
 * Hanging moss drapery.
 *
 * Deliberately *not* a repeated shape: length, taper, sway offset and card
 * count all vary, because "reused moss-drapery shape" is an explicit forbidden
 * shortcut. Cards are hung in a slight arc so a drape reads as a curtain with
 * depth rather than a single plane.
 */
function drape(
  b: Builder, rng: SeededRandom,
  ax: number, ay: number, az: number, dirX: number, dirZ: number, span: number,
  r: number, g: number, bl: number,
): void {
  const strands = rng.int(2, 4);
  for (let i = 0; i < strands; i++) {
    const t = strands === 1 ? 0.5 : i / (strands - 1);
    const off = (t - 0.5) * span;
    const len = rng.range(0.55, 2.3) * (1 - Math.abs(t - 0.5) * 0.5);
    const w = rng.range(0.12, 0.34);
    const px = ax + dirX * off + rng.range(-0.1, 0.1);
    const pz = az + dirZ * off + rng.range(-0.1, 0.1);
    // Two crossed cards per strand: a drape seen edge-on must not vanish.
    for (let k = 0; k < 2; k++) {
      const a = rng.range(0, Math.PI) + k * Math.PI * 0.5;
      card(
        b, px, ay - len * 0.5, pz,
        Math.cos(a) * w, 0, Math.sin(a) * w,
        0, -len * 0.5, 0,
        w * 0.5, TILE.mossDrape,
        r, g, bl,
      );
    }
  }
}

// ============================================================================
// condition overlay
// ============================================================================

interface CondSpec {
  /** replacement bark tile, or null to keep the archetype's own */
  barkTile: number | null;
  /** foliage tile override */
  foliageTile: number | null;
  /** multiplier on foliage card count — 0 strips the crown entirely */
  foliageMul: number;
  /** trunk / branch tint multiplier */
  tint: [number, number, number];
  /** foliage tint multiplier */
  leafTint: [number, number, number];
  /** 0..1 chance any given branch is a bare dead stub instead of foliaged */
  stubChance: number;
  /** moss drapes per foliaged branch */
  drapeRate: number;
  /** fraction of the upper crown removed (a dying tree thins from the top) */
  topDieback: number;
}

function condSpec(c: Condition, arche: ArchetypeId): CondSpec {
  const dead = arche === 'snag';
  switch (c) {
    case 'healthy':
      return {
        barkTile: null, foliageTile: null, foliageMul: 1,
        tint: [1, 1, 1], leafTint: [1, 1, 1],
        stubChance: 0.04, drapeRate: 0.05, topDieback: 0,
      };
    case 'stormDamaged':
      // Physical damage, not discolouration: limbs are missing, and the ones
      // that remain are torn back to stubs on the windward side.
      return {
        barkTile: null, foliageTile: null, foliageMul: 0.62,
        tint: [0.94, 0.92, 0.9], leafTint: [0.9, 0.88, 0.82],
        stubChance: 0.34, drapeRate: 0.08, topDieback: 0.18,
      };
    case 'dying':
      // Thins from the apex down, and the needles that remain are `needleSparse`.
      return {
        barkTile: null, foliageTile: TILE.needleSparse, foliageMul: 0.48,
        tint: [0.9, 0.86, 0.8], leafTint: [1.15, 0.95, 0.68],
        stubChance: 0.3, drapeRate: 0.16, topDieback: 0.42,
      };
    case 'longDead':
      return {
        barkTile: TILE.barkSnag, foliageTile: TILE.twigsBare,
        foliageMul: dead ? 0 : 0.16,
        tint: [0.88, 0.86, 0.84], leafTint: [0.8, 0.74, 0.66],
        stubChance: 0.8, drapeRate: 0.1, topDieback: 0.55,
      };
    case 'mossHeavy':
      // Wet-side tree: bark is lost under bryophyte and it carries curtains.
      return {
        barkTile: TILE.barkMossy, foliageTile: null, foliageMul: 0.88,
        tint: [0.95, 1.0, 0.93], leafTint: [0.92, 1.0, 0.9],
        stubChance: 0.12, drapeRate: 0.72, topDieback: 0.05,
      };
  }
}

// ============================================================================
// template type
// ============================================================================

export interface TreeTemplate {
  /** stable cache key, e.g. `matureConifer:2:mossHeavy:0` */
  key: string;
  archetype: ArchetypeId;
  variant: number;
  condition: Condition;
  lod: number;
  /** human-readable structural description — used in the audit report */
  label: string;

  bark: RawGeo;
  foliage: RawGeo | null;

  /** total height in metres */
  height: number;
  /** height at which foliage begins, metres */
  crownBase: number;
  /** max horizontal crown reach, metres */
  crownRadius: number;
  /** trunk radius at 1.3 m, for collision */
  collideRadius: number;
  /**
   * Silhouette signature: SIL_BINS bands of max radius, then SIL_BINS bands of
   * foliage mass, both normalised. This is what the automated non-repetition
   * check compares — two variants whose signatures match are the same tree
   * wearing different numbers.
   */
  silhouette: Float32Array;
}

// ============================================================================
// archetype builders
// ============================================================================

interface BuildCtx {
  bark: Builder;
  fol: Builder;
  rng: SeededRandom;
  cond: CondSpec;
  lod: number;
  segs: number;
}

/** Per-variant structural parameters for the whorled conifers. */
interface ConiferSpec {
  label: string;
  height: number;
  /** crown base as a fraction of height */
  crownFrac: number;
  baseRadius: number;
  /** taper exponent — >1 means the trunk holds its girth then tapers fast */
  taper: number;
  whorls: number;
  perWhorl: number;
  /** branch length at the crown base, metres */
  reach: number;
  /** reach at the apex as a fraction of `reach` */
  reachTop: number;
  /** branch angle below horizontal at crown base / at apex, radians */
  droopBase: number;
  droopTop: number;
  leanDeg: number;
  /** does the crown correct back toward vertical against the lean? */
  phototropic: boolean;
  /** 0..1 crown suppression on one side */
  suppress: number;
  forkAt: number;      // 0 = no fork, else fraction of height
  buttressCount: number;
  flatTop: number;     // 0..1, flattens the apex (shade-suppressed / veteran)
}

function buildConifer(
  c: BuildCtx, s: ConiferSpec, barkTile: number, foliageTile: number,
  tint: [number, number, number], leaf: [number, number, number],
): { height: number; crownBase: number; crownRadius: number; collide: number } {
  const { bark, fol, rng, cond } = c;
  const lean = (s.leanDeg * Math.PI) / 180;
  const leanDir = rng.range(0, Math.PI * 2);
  const lx = Math.cos(leanDir), lz = Math.sin(leanDir);
  const suppressDir = rng.range(0, Math.PI * 2);

  const H = s.height;
  const rings = c.lod === 0 ? 9 : c.lod === 1 ? 6 : 4;

  // ---- trunk centreline ----
  // Lean is applied as an integral so the trunk *curves*; a straight tilted
  // cylinder reads as a felled pole, not a leaning tree.
  const path: V3[] = [];
  const radii: number[] = [];
  const topY = H * (s.forkAt > 0 ? s.forkAt : 1);
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const y = t * topY;
    // phototropic trees bend back: offset peaks mid-trunk then returns
    const bend = s.phototropic ? Math.sin(t * Math.PI) * 0.75 : t;
    const off = Math.tan(lean) * y * bend;
    const wob = rng.noise1(t * 3.7 + s.height) * H * 0.008;
    path.push(v3(lx * off + wob, y, lz * off - wob));
    const taperT = Math.pow(t, s.taper);
    radii.push(s.baseRadius * (1 - taperT * 0.93) + 0.02);
  }
  limb(bark, {
    path, radii, radialSegs: c.segs, tile: barkTile, tileWorld: BARK_TILE_WORLD,
    r: tint[0], g: tint[1], b: tint[2], capTip: s.forkAt === 0,
  });

  if (s.buttressCount > 0 && c.lod === 0) {
    buttress(bark, rng, path[0].x, 0, path[0].z, s.baseRadius, barkTile,
      tint[0], tint[1], tint[2], s.buttressCount);
  }

  // Sample the trunk centreline at an arbitrary height.
  const atY = (y: number): V3 => {
    const t = clamp(y / topY, 0, 1);
    const f = t * (rings - 1);
    const i = Math.min(rings - 2, Math.floor(f));
    const k = f - i;
    return v3(
      lerp(path[i].x, path[i + 1].x, k), y,
      lerp(path[i].z, path[i + 1].z, k),
    );
  };
  const radAtY = (y: number): number => {
    const t = clamp(y / topY, 0, 1);
    return s.baseRadius * (1 - Math.pow(t, s.taper) * 0.93) + 0.02;
  };

  // ---- second leader, if this variant forks ----
  if (s.forkAt > 0) {
    const forkY = H * s.forkAt;
    const fBase = atY(forkY);
    const fr = radAtY(forkY);
    for (let k = 0; k < 2; k++) {
      const a = leanDir + Math.PI * 0.5 + k * Math.PI + rng.range(-0.4, 0.4);
      const spread = rng.range(0.1, 0.26) * (k === 0 ? 1 : 0.8);
      const topH = H * (k === 0 ? 1 : rng.range(0.82, 0.95));
      const lp: V3[] = [], lr: number[] = [];
      const ln = c.lod === 0 ? 5 : 3;
      for (let i = 0; i < ln; i++) {
        const t = i / (ln - 1);
        const y = forkY + (topH - forkY) * t;
        const off = Math.sin(t * 1.2) * spread * (topH - forkY);
        lp.push(v3(fBase.x + Math.cos(a) * off, y, fBase.z + Math.sin(a) * off));
        lr.push(fr * 0.62 * (1 - t * 0.9) + 0.02);
      }
      limb(bark, {
        path: lp, radii: lr, radialSegs: Math.max(4, c.segs - 2),
        tile: barkTile, tileWorld: BARK_TILE_WORLD,
        r: tint[0], g: tint[1], b: tint[2], capTip: true,
      });
    }
  }

  // ---- whorls ----
  const crownBase = H * s.crownFrac;
  const liveTop = H * (1 - cond.topDieback);
  let crownRadius = 0;
  const whorls = Math.max(2, Math.round(s.whorls * (c.lod === 0 ? 1 : c.lod === 1 ? 0.7 : 0.45)));
  const perWhorl = Math.max(2, Math.round(s.perWhorl * (c.lod === 2 ? 0.6 : 1)));

  for (let w = 0; w < whorls; w++) {
    const t = whorls === 1 ? 0.5 : w / (whorls - 1);         // 0 at crown base
    const y = lerp(crownBase, H * 0.985, t);
    const trunkPt = atY(Math.min(y, topY));
    // Whorls rotate by a non-repeating increment so no two stack in line.
    const phase = w * 2.3999632 + rng.range(-0.3, 0.3);
    const reach = lerp(s.reach, s.reach * s.reachTop, Math.pow(t, 0.85))
                * (1 - s.flatTop * Math.pow(t, 4) * 0.55);
    const droop = lerp(s.droopBase, s.droopTop, t);

    for (let k = 0; k < perWhorl; k++) {
      const a = phase + (k / perWhorl) * Math.PI * 2 + rng.range(-0.18, 0.18);
      // One-sided suppression: neighbours steal the light on one bearing.
      const facing = Math.cos(a - suppressDir);
      const supp = 1 - s.suppress * Math.max(0, facing) * rng.range(0.6, 1.0);
      if (supp < 0.22) continue;
      const len = reach * supp * rng.range(0.78, 1.15);
      if (len < 0.25) continue;
      crownRadius = Math.max(crownRadius, len);

      const dirX = Math.cos(a), dirZ = Math.sin(a);
      // Branch sags along its length rather than leaving straight and drooping.
      const tipDrop = -Math.sin(droop) * len;
      const midDrop = tipDrop * 0.3;
      const bp: V3[] = [
        v3(trunkPt.x + dirX * radAtY(y) * 0.8, y, trunkPt.z + dirZ * radAtY(y) * 0.8),
        v3(trunkPt.x + dirX * len * 0.5, y + midDrop, trunkPt.z + dirZ * len * 0.5),
        v3(trunkPt.x + dirX * len, y + tipDrop, trunkPt.z + dirZ * len),
      ];
      const br = Math.min(0.13, len * 0.045);
      limb(bark, {
        path: bp, radii: [br, br * 0.55, br * 0.16], radialSegs: c.lod === 0 ? 4 : 3,
        tile: barkTile, tileWorld: BARK_TILE_WORLD_FINE,
        r: tint[0] * 0.9, g: tint[1] * 0.9, b: tint[2] * 0.9, capTip: true,
      });

      const isStub = rng.next() < cond.stubChance || y > liveTop;
      if (isStub || cond.foliageMul <= 0) continue;

      const cards = Math.max(1, Math.round(
        (c.lod === 0 ? 4 : c.lod === 1 ? 2 : 1) * cond.foliageMul * (0.7 + len / s.reach * 0.6),
      ));
      spray(
        fol, rng, bp[0],
        v3(dirX, tipDrop / len, dirZ), len, len * 0.42, cards, foliageTile,
        leaf[0], leaf[1], leaf[2], Math.sin(droop) * 0.5,
      );

      if (rng.next() < cond.drapeRate && c.lod === 0) {
        drape(fol, rng, bp[2].x, bp[2].y, bp[2].z, dirX, dirZ, len * 0.4,
          0.62, 0.66, 0.5);
      }
    }
  }

  return { height: H, crownBase, crownRadius, collide: radAtY(1.3) };
}

// ============================================================================
// broadleaf / recursive-branching archetypes
// ============================================================================

/** Per-variant structural parameters for recursively branching trees. */
interface BroadSpec {
  label: string;
  height: number;
  /** crown base as a fraction of height — where the bole ends */
  crownFrac: number;
  baseRadius: number;
  taper: number;
  /** primary limbs off the bole */
  primaries: number;
  /** recursion depth (2 = primaries + secondaries) */
  depth: number;
  /** children per branch at each split */
  childCount: number;
  /** child length as a fraction of parent */
  childScale: number;
  /** angle a child diverges from its parent, radians */
  divergence: number;
  /** how strongly branches turn back toward vertical each level (0..1) */
  upBias: number;
  /** primary limb length at the bole, metres */
  reach: number;
  leanDeg: number;
  /** 0..1 crown suppression on one bearing */
  suppress: number;
  /** 0 = single bole, else fraction of height where the bole splits in two */
  forkAt: number;
  buttressCount: number;
  /** vertical crown squash: <1 = wide flat crown, >1 = tall narrow crown */
  crownAspect: number;
  /** leaf clumps hung at each terminal branch */
  clumpsPerTip: number;
}

/**
 * Recursive limb growth.
 *
 * Whorled conifers and broadleaves are not the same algorithm with different
 * numbers — a conifer's branches all attach to the trunk, a broadleaf's attach
 * to each other. Sharing one builder is exactly how you end up with "the same
 * tree wearing a different texture", so this is deliberately separate code.
 *
 * `upBias` is the phototropism term: without it, recursive splitting produces
 * an even radial fan (unmistakably fractal). Real branches bend back toward the
 * light at every order, which is what gives an oak its characteristic
 * upward-cupping crown.
 */
function growBranch(
  c: BuildCtx, s: BroadSpec,
  base: V3, dir: V3, len: number, rad: number, depth: number,
  barkTile: number, foliageTile: number,
  tint: [number, number, number], leaf: [number, number, number],
  out: { crownRadius: number },
): void {
  const { bark, fol, rng, cond } = c;
  if (len < 0.22 || rad < 0.012) return;

  // Curve the limb: sag under its own weight, then lift at the tip.
  const segN = depth === 0 ? (c.lod === 0 ? 5 : 3) : 3;
  const lift = s.upBias * 0.55;
  const p: V3[] = [], r: number[] = [];
  for (let i = 0; i < segN; i++) {
    const t = i / (segN - 1);
    const d2 = norm(v3(dir.x, dir.y + lift * t * t, dir.z));
    // integrate the progressively lifted direction
    const seg = len * t;
    p.push(v3(
      base.x + dir.x * seg * (1 - t * 0.35) + d2.x * seg * t * 0.35,
      base.y + dir.y * seg * (1 - t * 0.35) + d2.y * seg * t * 0.35 - Math.sin(t * Math.PI) * len * 0.05,
      base.z + dir.z * seg * (1 - t * 0.35) + d2.z * seg * t * 0.35,
    ));
    r.push(rad * (1 - t * 0.72) + 0.012);
  }
  const reach = Math.hypot(p[segN - 1].x - 0, p[segN - 1].z - 0);
  out.crownRadius = Math.max(out.crownRadius, reach);

  limb(bark, {
    path: p, radii: r, radialSegs: depth === 0 ? Math.max(4, c.segs - 2) : 3,
    tile: barkTile, tileWorld: depth === 0 ? BARK_TILE_WORLD : BARK_TILE_WORLD_FINE,
    r: tint[0] * (1 - depth * 0.05), g: tint[1] * (1 - depth * 0.05), b: tint[2] * (1 - depth * 0.05),
    capTip: true,
  });

  const tip = p[segN - 1];
  const tipDir = norm(v3(tip.x - p[segN - 2].x, tip.y - p[segN - 2].y, tip.z - p[segN - 2].z));

  const terminal = depth >= s.depth || c.lod === 2 && depth >= 1;
  if (terminal) {
    if (cond.foliageMul <= 0) return;
    if (rng.next() < cond.stubChance) return;
    const clumps = Math.max(1, Math.round(
      s.clumpsPerTip * cond.foliageMul * (c.lod === 0 ? 1 : c.lod === 1 ? 0.6 : 0.35),
    ));
    for (let i = 0; i < clumps; i++) {
      const t = clumps === 1 ? 0.75 : 0.35 + (i / (clumps - 1)) * 0.72;
      const sz = len * rng.range(0.3, 0.52);
      const a = rng.range(0, Math.PI * 2), e = rng.range(-0.5, 0.5);
      const cx2 = base.x + (tip.x - base.x) * t, cy2 = base.y + (tip.y - base.y) * t;
      const cz2 = base.z + (tip.z - base.z) * t;
      card(
        fol, cx2, cy2, cz2,
        Math.cos(a) * sz, e * sz * 0.4, Math.sin(a) * sz,
        -Math.sin(a) * sz * 0.85, sz * 0.7, Math.cos(a) * sz * 0.85,
        sz * 0.26, foliageTile,
        leaf[0] * rng.range(0.85, 1.12), leaf[1] * rng.range(0.85, 1.12), leaf[2] * rng.range(0.85, 1.12),
      );
    }
    if (rng.next() < cond.drapeRate && c.lod === 0) {
      drape(fol, rng, tip.x, tip.y, tip.z, tipDir.x, tipDir.z, len * 0.35, 0.6, 0.64, 0.48);
    }
    return;
  }

  // ---- split ----
  const kids = Math.max(2, Math.round(s.childCount + rng.range(-0.49, 0.49)));
  // Perpendicular basis at the tip, for spreading children around the parent.
  const side = norm(cross(tipDir, Math.abs(tipDir.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0)));
  const up2 = norm(cross(side, tipDir));
  const phase = rng.range(0, Math.PI * 2);
  for (let k = 0; k < kids; k++) {
    const a = phase + (k / kids) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const div = s.divergence * rng.range(0.65, 1.35);
    const sd = Math.sin(div), cd = Math.cos(div);
    let nd = norm(v3(
      tipDir.x * cd + (side.x * Math.cos(a) + up2.x * Math.sin(a)) * sd,
      tipDir.y * cd + (side.y * Math.cos(a) + up2.y * Math.sin(a)) * sd,
      tipDir.z * cd + (side.z * Math.cos(a) + up2.z * Math.sin(a)) * sd,
    ));
    // phototropic correction, plus the crown-aspect squash
    nd = norm(v3(nd.x, nd.y * s.crownAspect + s.upBias * 0.4, nd.z));
    // one-sided suppression, applied at every order so it compounds
    const supp = 1 - s.suppress * Math.max(0, nd.x) * 0.5;
    const cl = len * s.childScale * rng.range(0.78, 1.18) * supp;
    growBranch(
      c, s, tip, nd, cl, rad * Math.pow(s.childScale, 0.72) * 0.85, depth + 1,
      barkTile, foliageTile, tint, leaf, out,
    );
  }
}

function buildBroadleaf(
  c: BuildCtx, s: BroadSpec, barkTile: number, foliageTile: number,
  tint: [number, number, number], leaf: [number, number, number],
): { height: number; crownBase: number; crownRadius: number; collide: number } {
  const { bark, rng } = c;
  const H = s.height;
  const lean = (s.leanDeg * Math.PI) / 180;
  const leanDir = rng.range(0, Math.PI * 2);
  const lx = Math.cos(leanDir), lz = Math.sin(leanDir);
  const boleTop = H * s.crownFrac;
  const rings = c.lod === 0 ? 7 : c.lod === 1 ? 5 : 3;

  const path: V3[] = [], radii: number[] = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const y = t * boleTop;
    const off = Math.tan(lean) * y * (0.4 + t * 0.6);
    const wob = rng.noise1(t * 4.3 + H) * boleTop * 0.02;
    path.push(v3(lx * off + wob, y, lz * off + wob * 0.6));
    radii.push(s.baseRadius * (1 - Math.pow(t, s.taper) * 0.42) + 0.02);
  }
  limb(bark, {
    path, radii, radialSegs: c.segs, tile: barkTile, tileWorld: BARK_TILE_WORLD,
    r: tint[0], g: tint[1], b: tint[2], capTip: false,
  });
  if (s.buttressCount > 0 && c.lod === 0) {
    buttress(bark, rng, 0, 0, 0, s.baseRadius, barkTile, tint[0], tint[1], tint[2], s.buttressCount);
  }

  const tipR = s.baseRadius * (1 - 0.42) + 0.02;
  const out = { crownRadius: 0 };

  if (s.forkAt > 0) {
    // A forked bole is a *different silhouette*, not a detail: two competing
    // leaders give the wide vase shape of an open-grown maple.
    const fy = H * s.forkAt;
    const fBase = v3(path[rings - 1].x, Math.min(fy, boleTop), path[rings - 1].z);
    for (let k = 0; k < 2; k++) {
      const a = leanDir + Math.PI * 0.5 + k * Math.PI;
      const d = norm(v3(Math.cos(a) * 0.42, 1, Math.sin(a) * 0.42));
      growBranch(c, s, fBase, d, (H - fy) * rng.range(0.55, 0.8), tipR * 0.72, 0,
        barkTile, foliageTile, tint, leaf, out);
    }
  }

  const boleTip = v3(path[rings - 1].x, boleTop, path[rings - 1].z);
  const prim = Math.max(3, Math.round(s.primaries * (c.lod === 2 ? 0.6 : 1)));
  const phase = rng.range(0, Math.PI * 2);
  for (let k = 0; k < prim; k++) {
    const a = phase + (k / prim) * Math.PI * 2 + rng.range(-0.3, 0.3);
    // Primaries attach over a *span* of the upper bole, not all at one node —
    // a single attachment node is the "broomstick" look.
    const attachT = rng.range(0.72, 1.0);
    const ay = boleTop * attachT;
    const ax = lerp(0, boleTip.x, attachT), az = lerp(0, boleTip.z, attachT);
    const rise = rng.range(0.55, 1.35) * s.crownAspect;
    const d = norm(v3(Math.cos(a), rise, Math.sin(a)));
    const facing = Math.cos(a - leanDir + Math.PI);
    const supp = 1 - s.suppress * Math.max(0, facing) * rng.range(0.5, 1.0);
    if (supp < 0.25) continue;
    growBranch(
      c, s, v3(ax, ay, az), d, s.reach * supp * rng.range(0.8, 1.25),
      tipR * rng.range(0.5, 0.82), 0,
      barkTile, foliageTile, tint, leaf, out,
    );
  }

  return {
    height: H, crownBase: boleTop * 0.9,
    crownRadius: Math.max(out.crownRadius, s.reach * 0.6),
    collide: s.baseRadius * (1 - Math.pow(1.3 / boleTop, s.taper) * 0.42) + 0.02,
  };
}

// ============================================================================
// variant tables
// ============================================================================

/**
 * Five mature conifers that are five *different trees*.
 *
 * Read the `crownFrac` column first: 0.34 → 0.68 means one of these carries
 * foliage from a third of the way up and another has two-thirds of clean bole.
 * Standing side by side those do not look related, which is the whole point.
 * Contrast with the old system, where every pine had the same crown fraction
 * and only the height changed.
 */
const MATURE_CONIFER: ConiferSpec[] = [
  {
    label: 'cathedral veteran — 68% clean bole, flat-topped, heavy buttress',
    height: 31, crownFrac: 0.68, baseRadius: 0.86, taper: 1.55,
    whorls: 9, perWhorl: 6, reach: 3.6, reachTop: 0.3,
    droopBase: 0.44, droopTop: 0.06, leanDeg: 1.5, phototropic: false,
    suppress: 0.12, forkAt: 0, buttressCount: 6, flatTop: 0.75,
  },
  {
    label: 'spire — narrow, foliage to 34%, steep whorls, no fork',
    height: 26, crownFrac: 0.34, baseRadius: 0.52, taper: 0.85,
    whorls: 14, perWhorl: 5, reach: 2.5, reachTop: 0.16,
    droopBase: 0.2, droopTop: -0.12, leanDeg: 2, phototropic: false,
    suppress: 0.08, forkAt: 0, buttressCount: 3, flatTop: 0,
  },
  {
    label: 'suppressed edge tree — 62% one-sided crown, strong lean, phototropic',
    height: 24, crownFrac: 0.44, baseRadius: 0.58, taper: 1.15,
    whorls: 10, perWhorl: 6, reach: 4.2, reachTop: 0.42,
    droopBase: 0.58, droopTop: 0.14, leanDeg: 11, phototropic: true,
    suppress: 0.62, forkAt: 0, buttressCount: 4, flatTop: 0.2,
  },
  {
    label: 'twin-leader — forks at 46%, two competing tops',
    height: 28, crownFrac: 0.4, baseRadius: 0.72, taper: 1.3,
    whorls: 11, perWhorl: 4, reach: 3.1, reachTop: 0.34,
    droopBase: 0.36, droopTop: 0.02, leanDeg: 4, phototropic: false,
    suppress: 0.2, forkAt: 0.46, buttressCount: 5, flatTop: 0.15,
  },
  {
    label: 'weeping giant — long drooping limbs, wide low crown, thick base',
    height: 29, crownFrac: 0.28, baseRadius: 0.95, taper: 2.1,
    whorls: 12, perWhorl: 7, reach: 5.0, reachTop: 0.22,
    droopBase: 0.86, droopTop: 0.3, leanDeg: 3, phototropic: false,
    suppress: 0.16, forkAt: 0, buttressCount: 6, flatTop: 0.4,
  },
];

/**
 * Young conifers. Not scaled-down mature ones — a sapling's whorls are closer
 * together, its branches are proportionally *longer* relative to its height,
 * and its bark is a different surface entirely (`barkYoungConifer`).
 */
const YOUNG_CONIFER: ConiferSpec[] = [
  {
    label: 'dense regrowth cone — foliage to ground, tight whorls',
    height: 7.5, crownFrac: 0.04, baseRadius: 0.15, taper: 0.7,
    whorls: 13, perWhorl: 6, reach: 1.5, reachTop: 0.12,
    droopBase: 0.18, droopTop: -0.16, leanDeg: 2, phototropic: false,
    suppress: 0.06, forkAt: 0, buttressCount: 0, flatTop: 0,
  },
  {
    label: 'leggy shade-drawn sapling — sparse, stretched, leaning to light',
    height: 9.5, crownFrac: 0.36, baseRadius: 0.12, taper: 0.55,
    whorls: 7, perWhorl: 4, reach: 1.15, reachTop: 0.4,
    droopBase: 0.3, droopTop: 0.08, leanDeg: 16, phototropic: true,
    suppress: 0.44, forkAt: 0, buttressCount: 0, flatTop: 0.1,
  },
  {
    label: 'browsed thicket bush — squat, wide, deer-damaged leader',
    height: 4.2, crownFrac: 0.02, baseRadius: 0.13, taper: 1.6,
    whorls: 9, perWhorl: 7, reach: 1.55, reachTop: 0.55,
    droopBase: 0.34, droopTop: 0.24, leanDeg: 6, phototropic: false,
    suppress: 0.18, forkAt: 0.55, buttressCount: 0, flatTop: 0.85,
  },
  {
    label: 'pole — vigorous single leader, half-height crown',
    height: 12.5, crownFrac: 0.5, baseRadius: 0.2, taper: 0.9,
    whorls: 9, perWhorl: 5, reach: 1.7, reachTop: 0.2,
    droopBase: 0.14, droopTop: -0.2, leanDeg: 3, phototropic: false,
    suppress: 0.1, forkAt: 0, buttressCount: 0, flatTop: 0,
  },
  {
    label: 'twin sapling — forks low at 18%, V silhouette',
    height: 6.5, crownFrac: 0.12, baseRadius: 0.11, taper: 0.8,
    whorls: 10, perWhorl: 5, reach: 1.25, reachTop: 0.34,
    droopBase: 0.24, droopTop: 0.0, leanDeg: 8, phototropic: true,
    suppress: 0.22, forkAt: 0.18, buttressCount: 0, flatTop: 0.2,
  },
];

/** Five hardwoods, differing in crown aspect, fork, branch order and reach. */
const HARDWOOD: BroadSpec[] = [
  {
    label: 'spreading oak — wide flat crown, 3rd-order, heavy buttress',
    height: 21, crownFrac: 0.36, baseRadius: 0.78, taper: 1.4,
    primaries: 6, depth: 3, childCount: 2.6, childScale: 0.66,
    divergence: 0.62, upBias: 0.5, reach: 4.4, leanDeg: 2,
    suppress: 0.14, forkAt: 0, buttressCount: 6, crownAspect: 0.62, clumpsPerTip: 4,
  },
  {
    label: 'vase maple — forks at 22%, two ascending leaders, tall crown',
    height: 19, crownFrac: 0.22, baseRadius: 0.58, taper: 1.1,
    primaries: 4, depth: 3, childCount: 2.2, childScale: 0.7,
    divergence: 0.42, upBias: 0.78, reach: 3.2, leanDeg: 3,
    suppress: 0.1, forkAt: 0.22, buttressCount: 4, crownAspect: 1.25, clumpsPerTip: 3,
  },
  {
    label: 'forest-grown ash — 58% bole, small crown squeezed by neighbours',
    height: 24, crownFrac: 0.58, baseRadius: 0.5, taper: 1.7,
    primaries: 5, depth: 2, childCount: 3.0, childScale: 0.62,
    divergence: 0.55, upBias: 0.66, reach: 2.6, leanDeg: 5,
    suppress: 0.55, forkAt: 0, buttressCount: 2, crownAspect: 1.0, clumpsPerTip: 4,
  },
  {
    label: 'gnarled veteran — short, thick, low twisted limbs, few orders',
    height: 13, crownFrac: 0.2, baseRadius: 0.92, taper: 2.3,
    primaries: 7, depth: 2, childCount: 3.4, childScale: 0.55,
    divergence: 0.95, upBias: 0.24, reach: 3.8, leanDeg: 9,
    suppress: 0.3, forkAt: 0, buttressCount: 6, crownAspect: 0.45, clumpsPerTip: 5,
  },
  {
    label: 'leaning streamside — 19 deg lean, one-sided reaching crown',
    height: 17, crownFrac: 0.3, baseRadius: 0.44, taper: 1.2,
    primaries: 5, depth: 3, childCount: 2.4, childScale: 0.68,
    divergence: 0.5, upBias: 0.42, reach: 3.6, leanDeg: 19,
    suppress: 0.68, forkAt: 0, buttressCount: 3, crownAspect: 0.85, clumpsPerTip: 3,
  },
];

/** Alder / understory stem trees: multi-stemmed, smooth bark, wet ground. */
const ALDER: BroadSpec[] = [
  {
    label: 'multi-stem clump alder — low fork, arching stems',
    height: 11, crownFrac: 0.14, baseRadius: 0.24, taper: 0.9,
    primaries: 5, depth: 2, childCount: 2.6, childScale: 0.66,
    divergence: 0.6, upBias: 0.6, reach: 2.1, leanDeg: 7,
    suppress: 0.2, forkAt: 0.14, buttressCount: 0, crownAspect: 1.05, clumpsPerTip: 3,
  },
  {
    label: 'single-stem alder — straight, narrow, high small crown',
    height: 14, crownFrac: 0.52, baseRadius: 0.22, taper: 1.25,
    primaries: 4, depth: 2, childCount: 2.8, childScale: 0.6,
    divergence: 0.48, upBias: 0.72, reach: 1.7, leanDeg: 4,
    suppress: 0.24, forkAt: 0, buttressCount: 0, crownAspect: 1.2, clumpsPerTip: 4,
  },
  {
    label: 'bank-leaning alder — 26 deg over water, crown all on one side',
    height: 10, crownFrac: 0.24, baseRadius: 0.2, taper: 1.0,
    primaries: 4, depth: 2, childCount: 2.4, childScale: 0.7,
    divergence: 0.66, upBias: 0.3, reach: 2.5, leanDeg: 26,
    suppress: 0.72, forkAt: 0, buttressCount: 0, crownAspect: 0.7, clumpsPerTip: 3,
  },
  {
    label: 'coppice stool — five stems from one base, fan silhouette',
    height: 8, crownFrac: 0.08, baseRadius: 0.3, taper: 0.7,
    primaries: 6, depth: 2, childCount: 2.2, childScale: 0.72,
    divergence: 0.34, upBias: 0.85, reach: 1.5, leanDeg: 2,
    suppress: 0.12, forkAt: 0.08, buttressCount: 0, crownAspect: 1.4, clumpsPerTip: 3,
  },
  {
    label: 'suppressed sub-canopy alder — thin, wide flat crown reaching for gaps',
    height: 12, crownFrac: 0.62, baseRadius: 0.16, taper: 1.5,
    primaries: 4, depth: 2, childCount: 3.2, childScale: 0.6,
    divergence: 0.85, upBias: 0.2, reach: 2.8, leanDeg: 12,
    suppress: 0.5, forkAt: 0, buttressCount: 0, crownAspect: 0.4, clumpsPerTip: 4,
  },
];

/**
 * Snags. A dead tree is not a live tree with the leaves switched off — the top
 * is *gone*, the branches are stubs of decreasing length, and the silhouette
 * is a bare spike. These are also the single most useful landmark-scale
 * vertical element in a night forest, so five distinct ones matter.
 */
interface SnagSpec {
  label: string;
  height: number;
  baseRadius: number;
  taper: number;
  /** how the top terminates */
  top: 'snapped' | 'spike' | 'forked-stub' | 'hollow';
  /** stub branches, base..top */
  stubs: number;
  stubReach: number;
  leanDeg: number;
  /** 0..1 how much bark has sloughed off (drives tile choice per-limb) */
  barkLoss: number;
  buttressCount: number;
  /** 0..1 severity for the fracture cap */
  severity: number;
}

const SNAG: SnagSpec[] = [
  {
    label: 'grey spike — tall, clean, near-branchless, silvered',
    height: 22, baseRadius: 0.5, taper: 1.9, top: 'spike',
    stubs: 5, stubReach: 0.9, leanDeg: 3, barkLoss: 0.9, buttressCount: 3, severity: 0.2,
  },
  {
    label: 'snapped-off stump-tower — 8 m, wide, ragged fracture crown',
    height: 8.5, baseRadius: 0.82, taper: 0.5, top: 'snapped',
    stubs: 4, stubReach: 1.4, leanDeg: 2, barkLoss: 0.5, buttressCount: 6, severity: 1.0,
  },
  {
    label: 'leaning widow-maker — 22 deg lean, long stubs, bark hanging',
    height: 17, baseRadius: 0.44, taper: 1.3, top: 'forked-stub',
    stubs: 9, stubReach: 2.2, leanDeg: 22, barkLoss: 0.35, buttressCount: 2, severity: 0.5,
  },
  {
    label: 'hollow shell — thick, short, gutted, cave-like base',
    height: 11, baseRadius: 1.0, taper: 0.9, top: 'hollow',
    stubs: 6, stubReach: 1.1, leanDeg: 6, barkLoss: 0.75, buttressCount: 5, severity: 0.7,
  },
  {
    label: 'candelabra — mid-height snapped, three surviving stub arms upright',
    height: 14, baseRadius: 0.6, taper: 1.05, top: 'forked-stub',
    stubs: 11, stubReach: 1.8, leanDeg: 8, barkLoss: 0.6, buttressCount: 4, severity: 0.85,
  },
];

function buildSnag(
  c: BuildCtx, s: SnagSpec, tint: [number, number, number],
): { height: number; crownBase: number; crownRadius: number; collide: number } {
  const { bark, fol, rng, cond } = c;
  const H = s.height;
  const lean = (s.leanDeg * Math.PI) / 180;
  const leanDir = rng.range(0, Math.PI * 2);
  const lx = Math.cos(leanDir), lz = Math.sin(leanDir);
  const rings = c.lod === 0 ? 8 : c.lod === 1 ? 5 : 3;

  // A `hollow` snag ends in a wide open bowl, so its taper inverts near the top.
  const path: V3[] = [], radii: number[] = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const y = t * H;
    const off = Math.tan(lean) * y;
    // Dead trunks keep the kinks they had in life; a dead-straight snag is a pole.
    const wob = rng.noise1(t * 5.1 + H * 0.3) * H * 0.02;
    path.push(v3(lx * off + wob, y, lz * off - wob * 0.7));
    let r = s.baseRadius * (1 - Math.pow(t, s.taper) * (s.top === 'spike' ? 0.95 : 0.55)) + 0.03;
    if (s.top === 'hollow' && t > 0.75) r *= 1 + (t - 0.75) * 1.6;   // flares open
    radii.push(r);
  }
  limb(bark, {
    path, radii, radialSegs: c.segs,
    tile: s.barkLoss > 0.55 ? TILE.barkSnag : (cond.barkTile ?? TILE.barkSnag),
    tileWorld: BARK_TILE_WORLD,
    r: tint[0], g: tint[1], b: tint[2],
    capTip: s.top === 'spike',
  });
  if (s.buttressCount > 0 && c.lod === 0) {
    buttress(bark, rng, path[0].x, 0, path[0].z, s.baseRadius,
      TILE.barkSnag, tint[0], tint[1], tint[2], s.buttressCount);
  }

  const topPt = path[rings - 1], topR = radii[rings - 1];
  if (s.top !== 'spike' && c.lod < 2) {
    fractureCap(bark, rng, topPt.x, topPt.y, topPt.z, topR,
      tint[0] * 1.1, tint[1] * 1.05, tint[2] * 0.95, s.severity);
  }
  if (s.top === 'forked-stub') {
    // Two or three upright stub arms — the candelabra silhouette.
    const arms = rng.int(2, 3);
    for (let k = 0; k < arms; k++) {
      const a = rng.range(0, Math.PI * 2);
      const len = H * rng.range(0.1, 0.24);
      limb(bark, {
        path: [
          v3(topPt.x, topPt.y - topR * 0.5, topPt.z),
          v3(topPt.x + Math.cos(a) * len * 0.3, topPt.y + len * 0.6, topPt.z + Math.sin(a) * len * 0.3),
          v3(topPt.x + Math.cos(a) * len * 0.55, topPt.y + len, topPt.z + Math.sin(a) * len * 0.55),
        ],
        radii: [topR * 0.7, topR * 0.42, topR * 0.14],
        radialSegs: 4, tile: TILE.barkSnag, tileWorld: BARK_TILE_WORLD,
        r: tint[0], g: tint[1], b: tint[2], capTip: true,
      });
    }
  }

  // ---- stubs ----
  let crownRadius = topR;
  const stubs = Math.max(2, Math.round(s.stubs * (c.lod === 0 ? 1 : c.lod === 1 ? 0.6 : 0.35)));
  for (let i = 0; i < stubs; i++) {
    const t = 0.18 + (i / stubs) * 0.74;
    const y = t * H;
    const a = i * 2.3999632 + rng.range(-0.4, 0.4);
    // Stubs shorten upward — the fine top branches rot off first.
    const len = s.stubReach * (1 - t * 0.6) * rng.range(0.4, 1.3);
    if (len < 0.18) continue;
    crownRadius = Math.max(crownRadius, len);
    const rr = s.baseRadius * (1 - Math.pow(t, s.taper) * 0.55);
    const bx = topPt.x * t, bz = topPt.z * t;
    const droop = rng.range(0.15, 0.7);
    limb(bark, {
      path: [
        v3(bx + Math.cos(a) * rr * 0.7, y, bz + Math.sin(a) * rr * 0.7),
        v3(bx + Math.cos(a) * len, y - len * droop, bz + Math.sin(a) * len),
      ],
      radii: [Math.min(0.14, len * 0.14), Math.min(0.05, len * 0.04)],
      radialSegs: 3, tile: TILE.barkSnag, tileWorld: BARK_TILE_WORLD_FINE,
      r: tint[0] * 0.92, g: tint[1] * 0.92, b: tint[2] * 0.92, capTip: true,
    });
    // Bare twig fans on a minority of stubs — a snag that has been dead only a
    // few years still carries fine wood, and it catches moonlight beautifully.
    if (rng.next() < 0.3 && c.lod === 0 && cond.foliageMul > 0) {
      spray(fol, rng, v3(bx + Math.cos(a) * rr, y, bz + Math.sin(a) * rr),
        v3(Math.cos(a), -droop, Math.sin(a)), len, len * 0.45, 2, TILE.twigsBare,
        0.5, 0.46, 0.42, droop * 0.4);
    }
    if (rng.next() < cond.drapeRate && c.lod === 0) {
      drape(fol, rng, bx + Math.cos(a) * len, y - len * droop, bz + Math.sin(a) * len,
        Math.cos(a), Math.sin(a), len * 0.5, 0.58, 0.62, 0.46);
    }
  }

  return {
    height: H, crownBase: H * 0.18, crownRadius,
    collide: s.baseRadius * (1 - Math.pow(1.3 / H, s.taper) * 0.55) + 0.03,
  };
}

/**
 * Storm-broken trees. Built as a conifer whose leader is truncated, plus a
 * fracture cap and surviving limbs *below* the break only — which is what makes
 * the silhouette instantly readable as damage rather than as a short tree.
 */
interface StormSpec {
  label: string;
  /** what the tree *would* have been */
  fullHeight: number;
  /** fraction of full height at which it snapped */
  breakAt: number;
  baseRadius: number;
  taper: number;
  whorls: number;
  perWhorl: number;
  reach: number;
  droop: number;
  leanDeg: number;
  severity: number;
  buttressCount: number;
  /** does a side limb take over as a new leader? */
  newLeader: boolean;
  /** hanging broken limb still attached at the break */
  hanger: boolean;
}

const STORM: StormSpec[] = [
  {
    label: 'snapped high — 78% break, small surviving crown, big fracture',
    fullHeight: 27, breakAt: 0.78, baseRadius: 0.72, taper: 1.4,
    whorls: 5, perWhorl: 5, reach: 3.0, droop: 0.45, leanDeg: 3,
    severity: 1.0, buttressCount: 5, newLeader: false, hanger: true,
  },
  {
    label: 'snapped low — 32% break, stump-tower with two live limbs',
    fullHeight: 25, breakAt: 0.32, baseRadius: 0.8, taper: 0.9,
    whorls: 3, perWhorl: 4, reach: 3.6, droop: 0.6, leanDeg: 2,
    severity: 0.9, buttressCount: 6, newLeader: false, hanger: false,
  },
  {
    label: 'recovered — 55% break, side limb turned up as a new leader',
    fullHeight: 24, breakAt: 0.55, baseRadius: 0.62, taper: 1.2,
    whorls: 6, perWhorl: 5, reach: 3.2, droop: 0.4, leanDeg: 6,
    severity: 0.6, buttressCount: 4, newLeader: true, hanger: false,
  },
  {
    label: 'wind-thrown lean — 42 deg, 62% break, crown all downwind',
    fullHeight: 22, breakAt: 0.62, baseRadius: 0.55, taper: 1.1,
    whorls: 6, perWhorl: 6, reach: 3.4, droop: 0.75, leanDeg: 32,
    severity: 0.75, buttressCount: 3, newLeader: false, hanger: true,
  },
  {
    label: 'shattered veteran — 46% break, hollowed, hanging limb, no crown left',
    fullHeight: 29, breakAt: 0.46, baseRadius: 0.95, taper: 1.7,
    whorls: 4, perWhorl: 3, reach: 2.4, droop: 0.9, leanDeg: 9,
    severity: 1.0, buttressCount: 6, newLeader: false, hanger: true,
  },
];

function buildStorm(
  c: BuildCtx, s: StormSpec, barkTile: number, foliageTile: number,
  tint: [number, number, number], leaf: [number, number, number],
): { height: number; crownBase: number; crownRadius: number; collide: number } {
  const { bark, fol, rng, cond } = c;
  const H = s.fullHeight * s.breakAt;
  const lean = (s.leanDeg * Math.PI) / 180;
  const leanDir = rng.range(0, Math.PI * 2);
  const lx = Math.cos(leanDir), lz = Math.sin(leanDir);
  const rings = c.lod === 0 ? 7 : c.lod === 1 ? 5 : 3;

  const path: V3[] = [], radii: number[] = [];
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const y = t * H;
    const off = Math.tan(lean) * y;
    path.push(v3(lx * off, y, lz * off));
    // Taper against *full* height, so the break face is as thick as it should
    // be for that height — a snap at 32% leaves a genuinely fat stump.
    const tFull = (y / s.fullHeight);
    radii.push(s.baseRadius * (1 - Math.pow(tFull, s.taper) * 0.93) + 0.05);
  }
  limb(bark, {
    path, radii, radialSegs: c.segs, tile: barkTile, tileWorld: BARK_TILE_WORLD,
    r: tint[0], g: tint[1], b: tint[2], capTip: false,
  });
  if (s.buttressCount > 0 && c.lod === 0) {
    buttress(bark, rng, 0, 0, 0, s.baseRadius, barkTile, tint[0], tint[1], tint[2], s.buttressCount);
  }

  const topPt = path[rings - 1], topR = radii[rings - 1];
  fractureCap(bark, rng, topPt.x, topPt.y, topPt.z, topR,
    tint[0] * 1.2, tint[1] * 1.14, tint[2] * 1.0, s.severity);

  let crownRadius = topR;

  // ---- hanging broken limb: still attached, swinging, pointing down ----
  if (s.hanger && c.lod < 2) {
    const a = rng.range(0, Math.PI * 2);
    const len = s.fullHeight * rng.range(0.18, 0.34);
    limb(bark, {
      path: [
        v3(topPt.x, topPt.y - topR * 0.3, topPt.z),
        v3(topPt.x + Math.cos(a) * len * 0.45, topPt.y - len * 0.45, topPt.z + Math.sin(a) * len * 0.45),
        v3(topPt.x + Math.cos(a) * len * 0.5, topPt.y - len, topPt.z + Math.sin(a) * len * 0.5),
      ],
      radii: [topR * 0.5, topR * 0.3, topR * 0.1],
      radialSegs: 4, tile: TILE.woodSplintered, tileWorld: BARK_TILE_WORLD,
      r: tint[0], g: tint[1], b: tint[2], capTip: true,
    });
    if (cond.foliageMul > 0) {
      spray(fol, rng, v3(topPt.x + Math.cos(a) * len * 0.45, topPt.y - len * 0.5, topPt.z + Math.sin(a) * len * 0.45),
        v3(Math.cos(a) * 0.2, -1, Math.sin(a) * 0.2), len * 0.6, len * 0.3, 3,
        // Foliage on a broken limb is dying whatever the parent condition is.
        TILE.needleSparse, leaf[0] * 1.1, leaf[1] * 0.85, leaf[2] * 0.6, 0.2);
    }
    crownRadius = Math.max(crownRadius, len * 0.5);
  }

  // ---- new leader from a side limb ----
  if (s.newLeader) {
    const a = rng.range(0, Math.PI * 2);
    const rise = s.fullHeight * rng.range(0.2, 0.34);
    const attachY = H * 0.85;
    const lp = [
      v3(lx * Math.tan(lean) * attachY, attachY, lz * Math.tan(lean) * attachY),
      v3(Math.cos(a) * rise * 0.35, attachY + rise * 0.4, Math.sin(a) * rise * 0.35),
      v3(Math.cos(a) * rise * 0.3, attachY + rise, Math.sin(a) * rise * 0.3),
    ];
    limb(bark, {
      path: lp, radii: [topR * 0.75, topR * 0.5, topR * 0.14], radialSegs: 4,
      tile: barkTile, tileWorld: BARK_TILE_WORLD,
      r: tint[0], g: tint[1], b: tint[2], capTip: true,
    });
    if (cond.foliageMul > 0) {
      for (let i = 0; i < 4; i++) {
        const t = i / 4;
        const y = attachY + rise * (0.35 + t * 0.6);
        const aa = a + i * 1.9;
        spray(fol, rng, v3(Math.cos(a) * rise * 0.32, y, Math.sin(a) * rise * 0.32),
          v3(Math.cos(aa), -0.15, Math.sin(aa)), s.reach * 0.7 * (1 - t * 0.5),
          s.reach * 0.3, 3, foliageTile, leaf[0], leaf[1], leaf[2], 0.3);
      }
    }
    crownRadius = Math.max(crownRadius, s.reach * 0.7);
  }

  // ---- surviving whorls, strictly below the break ----
  const whorls = Math.max(2, Math.round(s.whorls * (c.lod === 0 ? 1 : c.lod === 1 ? 0.7 : 0.45)));
  const perWhorl = Math.max(2, Math.round(s.perWhorl * (c.lod === 2 ? 0.6 : 1)));
  const crownBase = H * 0.34;
  for (let w = 0; w < whorls; w++) {
    const t = whorls === 1 ? 0.5 : w / (whorls - 1);
    const y = lerp(crownBase, H * 0.9, t);
    const phase = w * 2.3999632 + rng.range(-0.35, 0.35);
    const rr = s.baseRadius * (1 - Math.pow(y / s.fullHeight, s.taper) * 0.93) + 0.05;
    for (let k = 0; k < perWhorl; k++) {
      const a = phase + (k / perWhorl) * Math.PI * 2 + rng.range(-0.2, 0.2);
      // Downwind bias: the crown that survived is the sheltered side.
      const shelter = 0.55 + 0.45 * Math.cos(a - leanDir - Math.PI);
      const len = s.reach * rng.range(0.6, 1.2) * shelter;
      if (len < 0.3) continue;
      crownRadius = Math.max(crownRadius, len);
      const dirX = Math.cos(a), dirZ = Math.sin(a);
      const tipDrop = -s.droop * len;
      const bp: V3[] = [
        v3(lx * Math.tan(lean) * y + dirX * rr * 0.8, y, lz * Math.tan(lean) * y + dirZ * rr * 0.8),
        v3(lx * Math.tan(lean) * y + dirX * len * 0.5, y + tipDrop * 0.3, lz * Math.tan(lean) * y + dirZ * len * 0.5),
        v3(lx * Math.tan(lean) * y + dirX * len, y + tipDrop, lz * Math.tan(lean) * y + dirZ * len),
      ];
      const br = Math.min(0.14, len * 0.05);
      limb(bark, {
        path: bp, radii: [br, br * 0.55, br * 0.16], radialSegs: c.lod === 0 ? 4 : 3,
        tile: barkTile, tileWorld: BARK_TILE_WORLD_FINE,
        r: tint[0] * 0.9, g: tint[1] * 0.9, b: tint[2] * 0.9, capTip: true,
      });
      // Storm damage tears limbs back to stubs far more often than normal.
      if (rng.next() < Math.max(cond.stubChance, 0.3) || cond.foliageMul <= 0) continue;
      const cards = Math.max(1, Math.round((c.lod === 0 ? 4 : 2) * cond.foliageMul));
      spray(fol, rng, bp[0], v3(dirX, tipDrop / len, dirZ), len, len * 0.4, cards,
        foliageTile, leaf[0], leaf[1], leaf[2], s.droop * 0.5);
      if (rng.next() < cond.drapeRate && c.lod === 0) {
        drape(fol, rng, bp[2].x, bp[2].y, bp[2].z, dirX, dirZ, len * 0.4, 0.6, 0.64, 0.48);
      }
    }
  }

  return {
    height: H, crownBase, crownRadius,
    collide: s.baseRadius * (1 - Math.pow(1.3 / s.fullHeight, s.taper) * 0.93) + 0.05,
  };
}

/** Understory: small multi-stem shrub-trees, the layer between fern and canopy. */
const UNDERSTORY: BroadSpec[] = [
  {
    label: 'vine-maple sprawl — near-horizontal arching stems, 6 from base',
    height: 3.6, crownFrac: 0.06, baseRadius: 0.09, taper: 0.6,
    primaries: 6, depth: 2, childCount: 2.4, childScale: 0.7,
    divergence: 1.05, upBias: 0.18, reach: 1.9, leanDeg: 12,
    suppress: 0.35, forkAt: 0.06, buttressCount: 0, crownAspect: 0.3, clumpsPerTip: 4,
  },
  {
    label: 'hazel thicket stool — dense upright wands, fan',
    height: 4.4, crownFrac: 0.1, baseRadius: 0.1, taper: 0.5,
    primaries: 8, depth: 1, childCount: 3.0, childScale: 0.6,
    divergence: 0.28, upBias: 0.9, reach: 1.5, leanDeg: 3,
    suppress: 0.1, forkAt: 0.1, buttressCount: 0, crownAspect: 1.6, clumpsPerTip: 3,
  },
  {
    label: 'holly dome — compact rounded shrub, short internodes',
    height: 2.4, crownFrac: 0.14, baseRadius: 0.07, taper: 0.8,
    primaries: 7, depth: 2, childCount: 2.8, childScale: 0.58,
    divergence: 0.72, upBias: 0.45, reach: 0.95, leanDeg: 2,
    suppress: 0.08, forkAt: 0, buttressCount: 0, crownAspect: 0.8, clumpsPerTip: 4,
  },
  {
    label: 'elder — few thick soft stems, sparse wide crown, 22 deg lean',
    height: 5.2, crownFrac: 0.3, baseRadius: 0.12, taper: 1.0,
    primaries: 3, depth: 2, childCount: 2.2, childScale: 0.72,
    divergence: 0.58, upBias: 0.32, reach: 1.8, leanDeg: 22,
    suppress: 0.48, forkAt: 0, buttressCount: 0, crownAspect: 0.55, clumpsPerTip: 5,
  },
  {
    label: 'bramble mound — low, chaotic, high divergence, ground-hugging',
    height: 1.5, crownFrac: 0.04, baseRadius: 0.05, taper: 0.4,
    primaries: 9, depth: 2, childCount: 2.6, childScale: 0.75,
    divergence: 1.35, upBias: 0.06, reach: 1.25, leanDeg: 8,
    suppress: 0.22, forkAt: 0.04, buttressCount: 0, crownAspect: 0.2, clumpsPerTip: 3,
  },
];
