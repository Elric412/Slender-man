import * as THREE from 'three';
import {
  allocSurface, dataTexture, heightToNormalData, bakeCavityAO, packORM, setRGB,
  registerShaderPatch, applyShaderPatch, surfaceUniforms,
  type SurfaceBuffers,
} from './MaterialLibrary';

/**
 * ForestAtlas — one texture set, one material, for the entire forest.
 *
 * ## Why an atlas at all
 *
 * The old vegetation system had five trunk materials and five foliage
 * materials, which forced five-plus instanced meshes *per chunk*. That capped
 * how many genuinely different trees we could afford: every new archetype cost
 * another material and another handful of draw calls. Variety was therefore
 * priced out by the renderer, which is the real reason the forest looked cloned.
 *
 * Packing every bark and every leaf card into one atlas inverts that: variety
 * becomes free. A merged tree can carry bark verts *and* needle verts in the
 * same buffer, so one archetype is one geometry, and a whole chunk of thirty
 * different trees is **one draw call**. We can afford 35 distinct geometries
 * precisely because they cost nothing extra to draw.
 *
 * ## Tiling inside an atlas
 *
 * Atlases normally can't tile — `RepeatWrapping` would wrap across the whole
 * sheet into the neighbouring tile. But bark *must* tile vertically, or a 28 m
 * mature conifer stretches its bark over 28 m and the texel density collapses
 * (one of the defects called out in the quality bar).
 *
 * So the sampling is done manually in the fragment shader:
 *
 *   - geometry UVs are **unbounded** — a tall trunk simply has `uv.y` running
 *     0…6, meaning six bark repeats, giving constant texel density regardless
 *     of trunk height;
 *   - the shader does `fract()` per fragment, then maps into the tile's rect;
 *   - mip selection uses `textureGrad` with the derivatives of the *unfracted*
 *     UV, because `fract()` produces a derivative spike at the wrap line and
 *     naive sampling would pick mip 8 there — a visible dark seam every repeat.
 *
 * ## Bleeding
 *
 * Each cell reserves a wrap-around gutter. Content is generated at `inner`
 * resolution and blitted into the middle of the cell with the ring around it
 * filled by wrapping (bark) or edge-clamping (foliage). Mip levels then bleed
 * into the gutter — which is a continuation of the same tile — instead of into
 * an unrelated neighbour.
 */

// ============================================================================
// atlas layout
// ============================================================================

export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;

/**
 * Tile indices. Bark occupies the first eight, foliage the last eight; the
 * TreeFactory refers to these by name so a re-layout can't silently swap a
 * canopy for a trunk.
 */
export const TILE = {
  // ── bark: eight genuinely different surfaces, not one bark at eight tints ──
  /** thick fissured plates — old Douglas-fir / ponderosa */
  barkMatureConifer: 0,
  /** tight, smooth, resin-blistered — a young tree's bark is not a small
   *  version of an old tree's bark, it is a different surface entirely */
  barkYoungConifer: 1,
  /** interlacing diamond ridges — oak / hardwood */
  barkHardwood: 2,
  /** papery white with horizontal lenticels and peeling curls — birch */
  barkPale: 3,
  /** silvered, weather-checked, bark sloughing to expose wood — long-dead snag */
  barkSnag: 4,
  /** raw splintered fibre — a storm-snapped trunk's fracture face */
  woodSplintered: 5,
  /** bark almost lost under moss and foliose lichen */
  barkMossy: 6,
  /** smooth grey-green with lichen blotches — alder / understory stem */
  barkAlder: 7,

  // ── foliage: alpha cards ──────────────────────────────────────────────────
  /** dense healthy needle spray */
  needleDense: 8,
  /** thin, browning, gappy needle spray — a dying crown */
  needleSparse: 9,
  /** summer hardwood leaf cluster */
  leafHardwood: 10,
  /** dry, curled, desaturated leaf cluster */
  leafDry: 11,
  /** bare twig fan — what a dead crown actually reads as */
  twigsBare: 12,
  /** fern frond, pinnate */
  fern: 13,
  /** broad understory leaf clump (salal / thimbleberry read) */
  leafBroad: 14,
  /** hanging moss / old-man's-beard drapery */
  mossDrape: 15,
} as const;

export type TileId = typeof TILE[keyof typeof TILE];

/** Tiles that are alpha-cut foliage rather than opaque bark. */
export const FOLIAGE_TILES: readonly number[] = [
  TILE.needleDense, TILE.needleSparse, TILE.leafHardwood, TILE.leafDry,
  TILE.twigsBare, TILE.fern, TILE.leafBroad, TILE.mossDrape,
];

// ============================================================================
// anisotropic tileable noise
// ============================================================================

/**
 * Like the material library's `PeriodicNoise`, but with **independent periods
 * per axis**.
 *
 * Bark is strongly anisotropic — fissures run along the grain, so the noise
 * must be stretched maybe 8:1 vertically. A single shared period can't express
 * that and stay seamless: scaling y by 2 while the lattice wraps at 8 leaves a
 * hard seam where v returns to 0. Separate periods make anisotropic *and*
 * seam-free possible, which is what lets bark tile up a trunk invisibly.
 */
class TileNoise {
  constructor(private seed: number) {}

  private h2(ix: number, iy: number): number {
    let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(this.seed, 1442695041)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  }

  /** smooth value noise, lattice wrapped independently at px / py */
  value(x: number, y: number, px: number, py: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const wx = (v: number) => ((v % px) + px) % px;
    const wy = (v: number) => ((v % py) + py) % py;
    const x0 = wx(ix), x1 = wx(ix + 1), y0 = wy(iy), y1 = wy(iy + 1);
    const a = this.h2(x0, y0), b = this.h2(x1, y0);
    const c = this.h2(x0, y1), d = this.h2(x1, y1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  }

  fbm(x: number, y: number, px: number, py: number, oct = 4, gain = 0.5): number {
    let amp = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      sum += this.value(x * f, y * f, Math.max(1, Math.round(px * f)), Math.max(1, Math.round(py * f))) * amp;
      norm += amp; amp *= gain; f *= 2;
    }
    return sum / norm;
  }

  /** ridged multifractal — the sharp creases bark fissures need */
  ridged(x: number, y: number, px: number, py: number, oct = 4, gain = 0.5): number {
    let amp = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < oct; o++) {
      const n = 1 - Math.abs(this.value(x * f, y * f,
        Math.max(1, Math.round(px * f)), Math.max(1, Math.round(py * f))) * 2 - 1);
      sum += n * n * amp;
      norm += amp; amp *= gain; f *= 2;
    }
    return sum / norm;
  }

  /** worley with independent cell counts per axis — stretched cells for plates */
  worley(u: number, v: number, cx: number, cy: number): { f1: number; f2: number; id: number } {
    const gx = u * cx, gy = v * cy;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    let f1 = 8, f2 = 8, id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const ccx = ix + ox, ccy = iy + oy;
        const wx = ((ccx % cx) + cx) % cx, wy = ((ccy % cy) + cy) % cy;
        const jx = ccx + this.h2(wx, wy) * 0.9 + 0.05;
        const jy = ccy + this.h2(wy + 71, wx + 17) * 0.9 + 0.05;
        const dx = jx - gx, dy = jy - gy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) { f2 = f1; f1 = d; id = this.h2(wx + 5, wy + 11); }
        else if (d < f2) { f2 = d; }
      }
    }
    return { f1: Math.min(1, f1), f2: Math.min(1, f2), id };
  }

  /** domain warp — stops fissures reading as parallel stripes */
  warped(x: number, y: number, px: number, py: number, amount = 1.2, oct = 4): number {
    const wx = this.fbm(x + 5.2, y + 1.3, px, py, 2) - 0.5;
    const wy = this.fbm(x + 9.7, y + 7.1, px, py, 2) - 0.5;
    return this.fbm(x + wx * amount, y + wy * amount, px, py, oct);
  }
}

// ============================================================================
// small raster helpers for the foliage cards
// ============================================================================

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v: number) => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Distance from point to a line segment in UV space. Foliage cards are drawn by
 * stroking needles / veins / twigs as capsules, which gives crisp tapered shapes
 * that noise thresholding can't — a needle spray thresholded out of fbm looks
 * like mould, not like a conifer.
 */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1e-6;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t, cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

// ============================================================================
// bark surfaces
// ============================================================================

/** A single atlas cell being painted, in its own local 0..1 UV space. */
interface Cell {
  /** inner resolution (content area, excluding gutter) */
  n: number;
  /** write a texel: u,v in [0,1) tile space */
  put(ix: number, iy: number, r: number, g: number, b: number, h: number, ao: number, rough: number, alpha: number): void;
}

/**
 * Mature conifer: thick, deeply fissured plates.
 *
 * Built as stretched worley cells (the plates) with the *cell borders* driving
 * fissure depth, plus ridged noise inside each plate for the coarse flaking. The
 * per-cell random id shifts each plate's tone slightly, which is what stops the
 * surface reading as a regular pattern — real bark plates differ in weathering.
 */
function barkMatureConifer(c: Cell, seed: number): void {
  const nz = new TileNoise(seed);
  const n = c.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      // plates are tall and narrow: 5 across, 3 up, but sampled with an
      // 8:1 vertical stretch so they elongate along the grain
      const w = nz.worley(u, v * 0.34, 5, 3);
      // border proximity → fissure. f2-f1 is near zero at a cell boundary.
      const border = 1 - smooth01((w.f2 - w.f1) * 3.6);
      const fissure = Math.pow(border, 1.5);
      // coarse flaking inside the plate, along the grain
      const grain = nz.ridged(u * 7, v * 34, 7, 34, 4, 0.55);
      // fine cross-checking
      const fine = nz.fbm(u * 26, v * 62, 26, 62, 3);

      let h = 0.62 - fissure * 0.55 + grain * 0.16 + fine * 0.07;
      h += (w.id - 0.5) * 0.09;             // plate-to-plate height variance
      h = clamp01(h);

      // colour: greyed brown, darker and redder deep in the fissures where
      // it stays damp; plate faces are lighter and dustier
      const dark = fissure * 0.8;
      const tone = 0.5 + (w.id - 0.5) * 0.34 + grain * 0.22;
      const r = mix(0.30, 0.14, dark) * mix(0.82, 1.14, tone);
      const g = mix(0.245, 0.098, dark) * mix(0.85, 1.10, tone);
      const b = mix(0.185, 0.078, dark) * mix(0.88, 1.06, tone);
      // fissures are damp and dark → rougher; plate faces are dusty but flatter
      const rough = clamp01(0.82 + fissure * 0.14 - grain * 0.08);
      c.put(x, y, r, g, b, h, 1, rough, 1);
    }
  }
}

/**
 * Young conifer: tight, near-smooth, with resin blisters.
 *
 * Deliberately *not* the mature bark scaled down. A sapling's bark is smooth
 * with raised resin vesicles and horizontal branch scars — reusing the fissured
 * plate texture at a smaller tiling is exactly the "one bark, eight tints"
 * shortcut that makes a forest read as cloned.
 */
function barkYoungConifer(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0x2b1);
  const n = c.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      const grain = nz.fbm(u * 9, v * 46, 9, 46, 4);
      // resin blisters: sparse worley pits raised above the surface
      const bl = nz.worley(u, v, 7, 9);
      const blister = Math.pow(clamp01(1 - bl.f1 * 4.2), 2) * (bl.id > 0.52 ? 1 : 0);
      // shallow horizontal branch scars, irregularly spaced
      const scarBand = nz.value(u * 2.0, v * 11, 2, 11);
      const scar = Math.pow(clamp01(1 - Math.abs(scarBand - 0.5) * 7), 3);

      const h = clamp01(0.55 + grain * 0.16 + blister * 0.3 - scar * 0.3);
      const tone = grain;
      // grey-brown with a faint purple cast, typical of young fir
      const r = mix(0.235, 0.315, tone) - scar * 0.08 + blister * 0.05;
      const g = mix(0.205, 0.268, tone) - scar * 0.075 + blister * 0.035;
      const b = mix(0.192, 0.238, tone) - scar * 0.06 + blister * 0.02;
      // resin is glossy — a real, localised roughness break rather than a
      // single flat value across the surface
      const rough = clamp01(0.86 - blister * 0.42 + scar * 0.06);
      c.put(x, y, r, g, b, h, 1, rough, 1);
    }
  }
}

/**
 * Hardwood: interlacing diamond ridge network.
 *
 * Oak bark's signature is a *lattice* — ridges that fork and rejoin, not
 * parallel plates. Two ridged noise fields at different anisotropies multiplied
 * together produce that interlock; a single field only ever gives stripes.
 */
function barkHardwood(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0x77d);
  const n = c.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      // vertical-dominant ridges
      const a = nz.ridged(u * 6, v * 17, 6, 17, 4, 0.5);
      // shallower diagonal set, warped so the lattice is irregular
      const b2 = nz.ridged((u + v * 0.35) * 7, v * 9, 7, 9, 3, 0.55);
      const lattice = clamp01(a * 0.62 + b2 * 0.55);
      const fissure = 1 - lattice;
      const fine = nz.warped(u * 22, v * 40, 22, 40, 0.8, 3);

      const h = clamp01(0.5 + lattice * 0.42 - fissure * 0.18 + fine * 0.08);
      const dark = Math.pow(fissure, 1.3);
      // warm mid-brown, deep shadow in the fissure network
      const r = mix(0.335, 0.115, dark) * mix(0.9, 1.08, fine);
      const g = mix(0.272, 0.092, dark) * mix(0.9, 1.06, fine);
      const b = mix(0.198, 0.072, dark) * mix(0.92, 1.04, fine);
      const rough = clamp01(0.84 + dark * 0.12 - fine * 0.06);
      c.put(x, y, r, g, b, h, 1, rough, 1);
    }
  }
}

/**
 * Pale bark: papery white with horizontal lenticels and peeling curls.
 *
 * The bright, high-value one. Narratively load-bearing too — the entity's
 * camouflage reads against this, so the peeling curls need real shadowed lips,
 * not just a light tint.
 */
function barkPale(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0x9ae);
  const n = c.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      // lenticels: short dark horizontal dashes
      const lRow = Math.floor(v * 26);
      const lJit = nz.value(lRow * 3.1, 0.5, 26, 1);
      const lu = (u * 7 + lJit * 3.7) % 1;
      const lenticel = Math.pow(clamp01(1 - Math.abs(lu - 0.5) * 3.4), 3)
        * Math.pow(clamp01(1 - Math.abs((v * 26) % 1 - 0.5) * 9), 2)
        * (nz.value(lRow * 7.7, lu * 5, 26, 5) > 0.42 ? 1 : 0);
      // peeling: bands of bark lifting away, with a shadow under the lip
      const peelBand = nz.fbm(u * 3.4, v * 5.5, 4, 6, 3);
      const peel = smooth01((peelBand - 0.56) * 7);
      const lip = Math.pow(clamp01(1 - Math.abs(peelBand - 0.56) * 14), 2);
      // faint grey smudging / soot streaks so it isn't a flat white
      const smudge = nz.warped(u * 5, v * 6, 5, 6, 1.1, 4);

      const h = clamp01(0.6 + peel * 0.22 - lip * 0.3 - lenticel * 0.35);
      let base = mix(0.72, 0.86, smudge);
      base -= lenticel * 0.5;
      base -= lip * 0.2;
      base = clamp01(base);
      // slightly warm in the peel where the inner bark shows
      const r = base * mix(1.0, 1.03, peel);
      const g = base * mix(0.985, 0.95, peel);
      const b = base * mix(0.955, 0.86, peel);
      const rough = clamp01(0.74 + smudge * 0.14 + lenticel * 0.1);
      c.put(x, y, r, g, b, h, 1, rough, 1);
    }
  }
}

/**
 * Long-dead snag: bark mostly gone, silvered wood exposed, deep weather checks.
 *
 * A dead tree is not a living tree with grey bark — the *structure* changes:
 * bark sloughs off in sheets leaving smooth silvered sapwood, and the exposed
 * wood splits along the grain into long checks. Both features are here.
 */
function barkSnag(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0x51c);
  const n = c.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      // where bark still clings, in large irregular patches
      const patch = nz.warped(u * 2.6, v * 3.2, 3, 3, 1.5, 3);
      const hasBark = smooth01((patch - 0.52) * 6);
      // exposed wood: long vertical checks
      const check = nz.ridged(u * 11, v * 3, 11, 3, 3, 0.6);
      const deepCheck = Math.pow(clamp01((check - 0.55) * 3), 1.4);
      const woodGrain = nz.fbm(u * 14, v * 60, 14, 60, 3);
      // remaining bark is coarse and flaking off
      const barkTex = nz.ridged(u * 8, v * 26, 8, 26, 4, 0.5);

      const woodH = 0.5 + woodGrain * 0.1 - deepCheck * 0.42;
      const barkH = 0.66 + barkTex * 0.2;
      const h = clamp01(mix(woodH, barkH, hasBark));

      // silvered grey wood, faintly warm; clinging bark is darker and browner
      const wr = mix(0.40, 0.50, woodGrain) - deepCheck * 0.22;
      const wg = mix(0.385, 0.478, woodGrain) - deepCheck * 0.215;
      const wb = mix(0.355, 0.44, woodGrain) - deepCheck * 0.2;
      const br = mix(0.20, 0.135, barkTex);
      const bg = mix(0.175, 0.118, barkTex);
      const bb = mix(0.155, 0.105, barkTex);
      const r = mix(wr, br, hasBark), g = mix(wg, bg, hasBark), b = mix(wb, bb, hasBark);
      // weathered wood is very rough; the silvered faces slightly less so
      const rough = clamp01(mix(0.88 - woodGrain * 0.1, 0.95, hasBark));
      c.put(x, y, r, g, b, h, 1, rough, 1);
    }
  }
}

/**
 * Splintered wood: the fracture face of a storm-snapped trunk.
 *
 * Long fibre splinters torn along the grain, pale where freshly broken. Used on
 * the broken crowns so a snapped tree shows an actual break, not a flat cap.
 */
function woodSplintered(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0x3f7);
  const n = c.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      // fibres: extremely stretched worley — long thin slivers
      const f = nz.worley(u, v * 0.08, 15, 2);
      const fibreEdge = 1 - smooth01((f.f2 - f.f1) * 5.5);
      const along = nz.fbm(u * 20, v * 90, 20, 90, 3);
      // torn ends where fibres broke at different heights
      const tear = nz.fbm(u * 13, v * 4, 13, 4, 2);

      const h = clamp01(0.55 + (f.id - 0.5) * 0.3 + along * 0.16 - fibreEdge * 0.4 + tear * 0.12);
      // fresh-broken wood is pale, straw coloured, going grey at the tips
      const age = clamp01(tear * 0.7 + 0.15);
      const tone = 0.5 + (f.id - 0.5) * 0.4 + along * 0.2;
      const r = mix(0.56, 0.40, age) * mix(0.86, 1.12, tone) - fibreEdge * 0.16;
      const g = mix(0.48, 0.365, age) * mix(0.88, 1.1, tone) - fibreEdge * 0.15;
      const b = mix(0.355, 0.30, age) * mix(0.9, 1.06, tone) - fibreEdge * 0.13;
      const rough = clamp01(0.9 + fibreEdge * 0.08 - along * 0.06);
      c.put(x, y, r, g, b, h, 1, rough, 1);
    }
  }
}

/**
 * Moss-heavy bark: the substrate barely visible under bryophyte and lichen.
 *
 * This is a *condition* tile. It carries its own thick, lumpy moss height so a
 * moss-heavy tree in the ravine silhouettes differently at the trunk than the
 * same geometry in the dry upland — condition variation you can see, not just
 * a tint swap.
 */
function barkMossy(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0x6cc);
  const n = c.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      // underlying bark still reads through the gaps
      const barkTex = nz.ridged(u * 6, v * 22, 6, 22, 4, 0.5);
      // moss coverage: clumpy, thicker low and in crevices
      const cover = nz.warped(u * 4.2, v * 5.4, 5, 5, 1.6, 4);
      const mossAmt = smooth01((cover - 0.34) * 3.4);
      // moss micro-structure — fine, dense, slightly directional
      const mossTex = nz.fbm(u * 30, v * 34, 30, 34, 4, 0.6);
      // foliose lichen: pale grey-green rosettes on the exposed bark
      const li = nz.worley(u, v, 9, 9);
      const lichen = Math.pow(clamp01(1 - li.f1 * 3.0), 1.6) * (li.id > 0.58 ? 1 : 0) * (1 - mossAmt * 0.7);

      const h = clamp01(0.5 + barkTex * 0.16 + mossAmt * (0.22 + mossTex * 0.24) + lichen * 0.06);

      // bark base
      let r = mix(0.20, 0.145, barkTex), g = mix(0.172, 0.122, barkTex), b = mix(0.148, 0.108, barkTex);
      // moss: desaturated green, darker in its own crevices. Kept low-chroma —
      // saturated green would read as arcade grass under moonlight.
      const mt = mossTex;
      r = mix(r, mix(0.105, 0.185, mt), mossAmt);
      g = mix(g, mix(0.165, 0.268, mt), mossAmt);
      b = mix(b, mix(0.088, 0.135, mt), mossAmt);
      // lichen: pale mineral grey-green
      r = mix(r, 0.44, lichen * 0.8);
      g = mix(g, 0.465, lichen * 0.8);
      b = mix(b, 0.40, lichen * 0.8);

      // moss is a diffuse, light-trapping surface: maximum roughness
      const rough = clamp01(mix(0.85 + barkTex * 0.08, 0.98, mossAmt) - lichen * 0.08);
      c.put(x, y, r, g, b, h, 1, rough, 1);
    }
  }
}

/**
 * Alder / understory stem: smooth grey-green with flat lichen blotches.
 *
 * Small trees need their own surface. Painting a sapling with oak bark is the
 * fastest way to destroy scale reading — texel density tells the eye how big
 * something is, so a thin stem must carry a fine, low-relief surface.
 */
function barkAlder(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0x8d2);
  const n = c.n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      const grain = nz.fbm(u * 11, v * 38, 11, 38, 4);
      // flat crustose lichen blotches with hard-ish edges
      const l1 = nz.warped(u * 6, v * 7, 6, 7, 1.7, 3);
      const blotch = smooth01((l1 - 0.55) * 9);
      const l2 = nz.worley(u, v, 12, 13);
      const spot = Math.pow(clamp01(1 - l2.f1 * 4.5), 2) * (l2.id > 0.62 ? 1 : 0);
      // faint vertical striping
      const stripe = nz.value(u * 14, v * 2, 14, 2);

      const h = clamp01(0.56 + grain * 0.13 + blotch * 0.05 + spot * 0.07);
      let r = mix(0.255, 0.315, grain) * mix(0.96, 1.04, stripe);
      let g = mix(0.252, 0.312, grain) * mix(0.96, 1.04, stripe);
      let b = mix(0.228, 0.278, grain);
      // lichen shifts it grey-green and lighter
      r = mix(r, 0.40, blotch * 0.55); g = mix(g, 0.43, blotch * 0.55); b = mix(b, 0.36, blotch * 0.55);
      r = mix(r, 0.52, spot * 0.7); g = mix(g, 0.53, spot * 0.7); b = mix(b, 0.47, spot * 0.7);
      const rough = clamp01(0.8 + grain * 0.1 + blotch * 0.1);
      c.put(x, y, r, g, b, h, 1, rough, 1);
    }
  }
}

// ============================================================================
// foliage cards
// ============================================================================

/**
 * Needle spray.
 *
 * Drawn, not noise-thresholded. A central rachis with needles stroked off it at
 * a swept angle, each needle a tapered capsule. `density` thins the spray and
 * `brown` shifts it toward a dying crown, so the same routine produces the
 * healthy and the dying tile without them being a hue rotation of each other:
 * the sparse version genuinely has fewer, shorter, gappier needles.
 */
function needleCard(c: Cell, seed: number, density: number, brown: number): void {
  const nz = new TileNoise(seed ^ 0x1f0);
  const n = c.n;
  // Pre-generate the needle segments once, then rasterise. Building the shape
  // list up front means every texel tests the same geometry — no per-pixel
  // random, which would produce fizz instead of clean needle edges.
  interface Ndl { ax: number; ay: number; bx: number; by: number; w: number; t: number; }
  const ndl: Ndl[] = [];
  const sprays = 3;
  for (let s = 0; s < sprays; s++) {
    // each spray is a shoot running up the card with a slight curve
    const baseX = 0.5 + (s - 1) * 0.27;
    const curve = (nz.value(s * 7.3, 0.5, 8, 1) - 0.5) * 0.22;
    const segs = 14;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const sx0 = baseX + curve * t0 * t0, sy0 = 0.04 + t0 * 0.92;
      const sx1 = baseX + curve * t1 * t1, sy1 = 0.04 + t1 * 0.92;
      // the rachis itself, a thin woody stem
      ndl.push({ ax: sx0, ay: sy0, bx: sx1, by: sy1, w: 0.009 * (1 - t0 * 0.5), t: -1 });
      // needles in opposite pairs, swept upward, shorter toward the tip
      const perSide = 2;
      for (let k = 0; k < perSide; k++) {
        for (const sign of [-1, 1]) {
          const jj = nz.value(i * 3.7 + k * 11.3 + s * 23.1, sign + 1.5, 32, 4);
          if (jj > density) continue;                 // thinning happens here
          const tt = t0 + (k / perSide) / segs;
          const len = (0.10 + jj * 0.05) * (1 - tt * 0.45) * mix(0.62, 1.0, density);
          const sweep = 0.5 + jj * 0.35;             // upward sweep angle
          const px = baseX + curve * tt * tt, py = 0.04 + tt * 0.92;
          ndl.push({
            ax: px, ay: py,
            bx: px + sign * len, by: py + len * sweep,
            w: 0.0075 + jj * 0.003,
            t: jj,
          });
        }
      }
    }
  }

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let best = 1e9, bestT = 0, isStem = false;
      for (let i = 0; i < ndl.length; i++) {
        const s2 = ndl[i];
        const d = segDist(u, v, s2.ax, s2.ay, s2.bx, s2.by) - s2.w;
        if (d < best) { best = d; bestT = s2.t < 0 ? 0.5 : s2.t; isStem = s2.t < 0; }
      }
      // 1.4 texels of feather: enough to antialias, tight enough that alpha-test
      // in the shader doesn't chew the needles to lace at distance
      const alpha = clamp01(1 - best * n / 1.4);
      if (alpha <= 0.004) { c.put(x, y, 0, 0, 0, 0.5, 1, 0.9, 0); continue; }

      // per-needle tone variance + a dark spine down each needle
      const spine = clamp01(1 - Math.abs(best) * n * 0.5);
      const tone = 0.5 + (bestT - 0.5) * 0.7;
      // Needle green: very desaturated and dark. Under a moonlit night grade,
      // anything brighter than ~0.2 luma reads as daylight foliage.
      let r = mix(0.052, 0.098, tone);
      let g = mix(0.088, 0.155, tone);
      let b = mix(0.048, 0.082, tone);
      if (isStem) { r = 0.09; g = 0.075; b = 0.055; }
      // browning for the dying variant: chlorophyll goes first, carotenoid stays
      const br = brown * mix(0.5, 1.0, tone);
      r = mix(r, 0.175, br); g = mix(g, 0.115, br); b = mix(b, 0.058, br);
      // waxy cuticle → a real specular break along the needle centre
      const rough = clamp01(mix(0.62, 0.86, 1 - spine) + brown * 0.14);
      const h = 0.5 + spine * 0.3;
      c.put(x, y, r, g, b, h, 1, rough, alpha);
    }
  }
}

/**
 * Broad leaf cluster — hardwood canopy or understory.
 *
 * Leaves are drawn as pointed ovals with a midrib and secondary veins, laid out
 * on a short branching twig. `dry` curls and desaturates them; `lobed` cuts the
 * margin into lobes (oak) rather than leaving it entire (understory).
 */
function leafCard(c: Cell, seed: number, dry: number, lobed: number, scale: number): void {
  const nz = new TileNoise(seed ^ 0x4c2);
  const n = c.n;
  interface Leaf { cx: number; cy: number; a: number; len: number; wid: number; tone: number; }
  const leaves: Leaf[] = [];
  const twigs: { ax: number; ay: number; bx: number; by: number; w: number }[] = [];
  // a main twig with a couple of side branches
  twigs.push({ ax: 0.5, ay: 0.0, bx: 0.5, by: 0.62, w: 0.011 });
  twigs.push({ ax: 0.5, ay: 0.3, bx: 0.24, by: 0.58, w: 0.008 });
  twigs.push({ ax: 0.5, ay: 0.42, bx: 0.77, by: 0.66, w: 0.008 });
  const count = 7;
  for (let i = 0; i < count; i++) {
    const j1 = nz.value(i * 5.1, 0.3, 16, 1);
    const j2 = nz.value(i * 9.7, 0.7, 16, 1);
    const j3 = nz.value(i * 3.3, 0.1, 16, 1);
    // anchor leaves near the twig ends so the cluster reads as attached
    const anchor = i % 3;
    const t = 0.35 + j1 * 0.6;
    const ax = anchor === 0 ? 0.5 : anchor === 1 ? mix(0.5, 0.24, t) : mix(0.5, 0.77, t);
    const ay = anchor === 0 ? mix(0.1, 0.62, t) : anchor === 1 ? mix(0.3, 0.58, t) : mix(0.42, 0.66, t);
    const len = (0.17 + j2 * 0.1) * scale;
    const a = (j3 - 0.5) * 2.6 + Math.PI * 0.5;   // mostly upward, splayed
    leaves.push({
      cx: ax + Math.cos(a) * len * 0.55,
      cy: ay + Math.sin(a) * len * 0.55,
      a, len, wid: len * mix(0.5, 0.68, j1), tone: j2,
    });
  }

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let alpha = 0, tone = 0.5, vein = 0, edge = 0;
      // twigs first so leaves paint over them
      for (const t of twigs) {
        const d = segDist(u, v, t.ax, t.ay, t.bx, t.by) - t.w;
        const a2 = clamp01(1 - d * n / 1.4);
        if (a2 > alpha) { alpha = a2; tone = -1; }
      }
      for (const lf of leaves) {
        // into leaf-local space
        const dx = u - lf.cx, dy = v - lf.cy;
        const ca = Math.cos(-lf.a), sa = Math.sin(-lf.a);
        const lx = dx * ca - dy * sa;            // across the leaf
        const ly = dx * sa + dy * ca;            // along the leaf
        const hl = lf.len * 0.5;
        if (Math.abs(ly) > hl * 1.25 || Math.abs(lx) > lf.wid) continue;
        const tt = clamp01((ly + hl) / (hl * 2));
        // pointed-oval margin: widest at 40% from base, tapering to a tip
        let w = lf.wid * Math.sin(Math.pow(tt, 0.78) * Math.PI) * 1.02;
        // lobes cut into the margin, oak-style
        if (lobed > 0) {
          const lobe = 0.5 + 0.5 * Math.cos(tt * Math.PI * 5.2);
          w *= mix(1, mix(0.52, 1.0, lobe), lobed);
        }
        // ragged, insect-eaten edges — a perfectly smooth margin looks CG
        w *= 1 - nz.value(tt * 22 + lf.tone * 30, lx > 0 ? 3 : 9, 24, 12) * 0.14;
        const d = Math.abs(lx) - w;
        const a2 = clamp01(1 - d * n / 1.4);
        if (a2 > alpha) {
          alpha = a2; tone = lf.tone;
          const rel = Math.abs(lx) / (w + 1e-5);
          // midrib
          vein = Math.pow(clamp01(1 - rel * 9), 2);
          // secondary veins fanning off it
          const sv = Math.abs(((tt * 9 + rel * 2.1) % 1) - 0.5);
          vein = Math.max(vein, Math.pow(clamp01(1 - sv * 7), 3) * 0.55);
          edge = Math.pow(clamp01(1 - (1 - rel) * 5), 2);   // rim darkening
        }
      }
      if (alpha <= 0.004) { c.put(x, y, 0, 0, 0, 0.5, 1, 0.9, 0); continue; }
      if (tone < 0) {   // twig
        c.put(x, y, 0.105, 0.086, 0.066, 0.62, 1, 0.9, alpha);
        continue;
      }
      // Leaf green, desaturated for night. Veins are lighter (they scatter),
      // margins darker (thinner + more shaded).
      let r = mix(0.068, 0.118, tone);
      let g = mix(0.102, 0.168, tone);
      let b = mix(0.055, 0.086, tone);
      r += vein * 0.045; g += vein * 0.055; b += vein * 0.03;
      r *= 1 - edge * 0.35; g *= 1 - edge * 0.38; b *= 1 - edge * 0.35;
      // drying: green → ochre → dead brown, and the margin goes first
      const d2 = clamp01(dry * mix(0.7, 1.25, tone) + edge * dry * 0.5);
      r = mix(r, 0.215, d2); g = mix(g, 0.142, d2); b = mix(b, 0.072, d2);
      // living leaves have a waxy sheen; dry leaves are matte and papery
      const rough = clamp01(mix(0.55, 0.9, d2) + vein * 0.08);
      const h = 0.5 + vein * 0.25 - edge * 0.15;
      c.put(x, y, r, g, b, h, 1, rough, alpha);
    }
  }
}

/**
 * Bare twig fan — what a dead crown actually looks like.
 *
 * Recursively branched, thinning at each order. This tile is what makes a snag
 * read as dead from a distance: a *fine, open, grey* silhouette instead of a
 * solid mass. Tinting a needle card grey would still give a solid blob.
 */
function twigCard(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0x7e1);
  const n = c.n;
  const segs: { ax: number; ay: number; bx: number; by: number; w: number }[] = [];
  let sc = 0;
  const branch = (x: number, y: number, ang: number, len: number, w: number, depth: number) => {
    if (depth > 4 || len < 0.02 || sc > 260) return;
    const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
    segs.push({ ax: x, ay: y, bx: ex, by: ey, w }); sc++;
    const j = nz.value(sc * 4.3, depth * 3.1, 64, 8);
    const j2 = nz.value(sc * 8.9, depth * 5.7, 64, 8);
    // fork angle widens with depth — real twigs get more divaricate at the tips
    const spread = 0.36 + depth * 0.14;
    branch(ex, ey, ang - spread * (0.6 + j * 0.8), len * (0.62 + j * 0.16), w * 0.66, depth + 1);
    branch(ex, ey, ang + spread * (0.6 + j2 * 0.8), len * (0.6 + j2 * 0.18), w * 0.66, depth + 1);
    // occasional third shoot keeps it from looking like a binary tree diagram
    if (j > 0.66) branch(ex, ey, ang + (j2 - 0.5) * 0.3, len * 0.5, w * 0.55, depth + 2);
  };
  branch(0.5, 0.02, Math.PI * 0.5, 0.3, 0.016, 0);
  branch(0.5, 0.16, Math.PI * 0.5 - 0.5, 0.2, 0.012, 1);
  branch(0.5, 0.2, Math.PI * 0.5 + 0.55, 0.21, 0.012, 1);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let best = 1e9, bw = 0;
      for (const s of segs) {
        const d = segDist(u, v, s.ax, s.ay, s.bx, s.by) - s.w;
        if (d < best) { best = d; bw = s.w; }
      }
      const alpha = clamp01(1 - best * n / 1.3);
      if (alpha <= 0.004) { c.put(x, y, 0, 0, 0, 0.5, 1, 0.9, 0); continue; }
      // thicker twigs keep some brown; fine tips are bleached grey
      const thin = clamp01(1 - bw * 55);
      const lit = clamp01(1 + best * n * 0.6);   // fake round shading
      const r = mix(0.155, 0.30, thin) * mix(0.75, 1.05, lit);
      const g = mix(0.132, 0.285, thin) * mix(0.78, 1.04, lit);
      const b = mix(0.112, 0.262, thin) * mix(0.8, 1.03, lit);
      c.put(x, y, r, g, b, 0.5 + lit * 0.2, 1, clamp01(0.9 + thin * 0.06), alpha);
    }
  }
}

/**
 * Fern frond — pinnate, with pinnae stepping down in length toward the tip.
 *
 * The single most recognisable damp-forest-floor shape, so it gets its own tile
 * rather than being a scaled leaf card. Ferns are also the ground layer that
 * signals moisture, which is how the marsh and ravine read as wetter.
 */
function fernCard(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0x2ee);
  const n = c.n;
  const segs: { ax: number; ay: number; bx: number; by: number; w: number; t: number }[] = [];
  // rachis arcs over — a fern frond is a curve, not a spike
  const pts: { x: number; y: number }[] = [];
  const steps = 18;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    pts.push({ x: 0.5 + Math.pow(t, 1.9) * 0.2, y: 0.02 + t * 0.94 - Math.pow(t, 3) * 0.1 });
  }
  for (let i = 0; i < steps; i++) {
    segs.push({ ax: pts[i].x, ay: pts[i].y, bx: pts[i + 1].x, by: pts[i + 1].y, w: 0.011 * (1 - i / steps * 0.7), t: -1 });
    const t = i / steps;
    // pinna length peaks low and tapers to the tip
    const pl = (0.055 + Math.sin(Math.pow(t, 0.7) * Math.PI) * 0.15) * (1 - t * 0.25);
    for (const sign of [-1, 1]) {
      const j = nz.value(i * 6.1, sign + 2, 24, 4);
      const sweep = 0.42 + j * 0.3;
      const ex = pts[i].x + sign * pl, ey = pts[i].y + pl * sweep;
      segs.push({ ax: pts[i].x, ay: pts[i].y, bx: ex, by: ey, w: 0.016 + j * 0.006, t: j });
      // each pinna is itself lobed — sub-pinnules give the lacy read
      const sub = 3;
      for (let k = 1; k <= sub; k++) {
        const ft = k / (sub + 1);
        const mx = pts[i].x + sign * pl * ft, my = pts[i].y + pl * sweep * ft;
        segs.push({
          ax: mx, ay: my,
          bx: mx + sign * pl * 0.22, by: my + pl * 0.3,
          w: 0.009, t: j,
        });
      }
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let best = 1e9, bt = 0, stem = false;
      for (const s of segs) {
        const d = segDist(u, v, s.ax, s.ay, s.bx, s.by) - s.w;
        if (d < best) { best = d; bt = s.t < 0 ? 0.5 : s.t; stem = s.t < 0; }
      }
      const alpha = clamp01(1 - best * n / 1.4);
      if (alpha <= 0.004) { c.put(x, y, 0, 0, 0, 0.5, 1, 0.9, 0); continue; }
      const tone = 0.5 + (bt - 0.5) * 0.8;
      // fern green is yellower and lighter than conifer needle
      let r = mix(0.072, 0.128, tone);
      let g = mix(0.112, 0.192, tone);
      let b = mix(0.052, 0.084, tone);
      if (stem) { r = 0.10; g = 0.115; b = 0.062; }
      const rough = clamp01(0.66 + tone * 0.16);
      c.put(x, y, r, g, b, 0.5 + alpha * 0.2, 1, rough, alpha);
    }
  }
}

/**
 * Hanging moss drapery — old-man's-beard / usnea.
 *
 * Long filaments hanging from a top edge, tangling and clumping. Alpha runs to
 * zero at the bottom so a drape mesh fades out instead of ending in a hard line.
 * Sightline-breaking geometry lives on this tile; the shapes are varied by the
 * drape geometry itself so no two drapes read identically.
 */
function mossDrapeCard(c: Cell, seed: number): void {
  const nz = new TileNoise(seed ^ 0xa17);
  const n = c.n;
  interface Fil { x0: number; drift: number; len: number; w: number; t: number; }
  const fils: Fil[] = [];
  for (let i = 0; i < 34; i++) {
    const j = nz.value(i * 3.7, 0.4, 34, 1);
    const j2 = nz.value(i * 8.1, 0.8, 34, 1);
    fils.push({
      x0: (i / 34 + j * 0.02) % 1,
      drift: (j2 - 0.5) * 0.34,
      len: 0.42 + j * 0.56,
      w: 0.006 + j2 * 0.007,
      t: j,
    });
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = x / n, v = y / n;
      let alpha = 0, tone = 0.5;
      for (const f of fils) {
        if (v > f.len) continue;
        // filament wanders as it descends, and tangles pull it sideways
        const tv = v / f.len;
        const fx = f.x0 + f.drift * tv * tv + (nz.value(f.x0 * 40, v * 9, 40, 9) - 0.5) * 0.05;
        // horizontal distance with wrap, so the tile tiles horizontally
        let dx = Math.abs(u - fx);
        dx = Math.min(dx, 1 - dx);
        const d = dx - f.w * (1 - tv * 0.55);
        // fade toward the filament tip
        const fade = clamp01(1 - Math.pow(tv, 2.4));
        const a2 = clamp01(1 - d * n / 1.5) * fade;
        if (a2 > alpha) { alpha = a2; tone = f.t; }
      }
      if (alpha <= 0.004) { c.put(x, y, 0, 0, 0, 0.5, 1, 0.9, 0); continue; }
      // pale grey-green, almost colourless — usnea is not "green moss"
      const t2 = 0.5 + (tone - 0.5) * 0.7;
      const r = mix(0.215, 0.295, t2);
      const g = mix(0.238, 0.318, t2);
      const b = mix(0.192, 0.252, t2);
      // extremely diffuse; it's basically a light-trapping fibre mat
      c.put(x, y, r, g, b, 0.5, 1, 0.97, alpha);
    }
  }
}

// ============================================================================
// atlas assembly
// ============================================================================

/**
 * Per-tile shader constants, uploaded once as a uniform array. The shader needs
 * to know each tile's rect and how many times to repeat within it.
 */
export interface TileRect {
  /** origin of the content area in atlas UV */
  ox: number; oy: number;
  /** size of the content area in atlas UV */
  sx: number; sy: number;
}

/**
 * Vertex attribute carrying the per-vertex tile selection and repeat count.
 *
 * `x` = tile index (0..15, integer stored as float — one atlas cell)
 * `y` = repeats along U
 * `z` = repeats along V
 *
 * Because this rides on the *vertex*, a single merged geometry can mix bark
 * verts and foliage verts and still resolve to the right cell per fragment,
 * which is what collapses a whole chunk to one draw call.
 */
export const ATLAS_ATTRIBUTE = 'aTile';

/**
 * Patch a material to sample the atlas manually.
 *
 * Three problems have to be solved simultaneously, and they interact:
 *
 *  1. **Tiling inside an atlas.** `RepeatWrapping` is unusable — it would wrap
 *     across the whole sheet into the neighbouring cell. So the UV is fracted
 *     per fragment and then mapped into the tile's rect. Geometry UVs are
 *     therefore *unbounded* (a 28 m trunk may run `uv.y` 0…6), which is what
 *     keeps texel density constant regardless of trunk height.
 *
 *  2. **The derivative spike.** `fract()` is discontinuous at the wrap line, so
 *     the hardware's implicit derivatives blow up there and mip selection jumps
 *     to the smallest level — a visible dark seam at *every* repeat. The fix is
 *     to compute the gradients from the *unfracted* UV (which is smooth) and
 *     sample with `textureGrad`. `texture2DGradEXT` is three's alias, defined to
 *     `textureGrad` on WebGL2, so this stays portable.
 *
 *  3. **Gutter clamping.** Even with correct mips, bilinear taps at the content
 *     edge can reach past it. The fracted coordinate is inset by half a texel
 *     of the *content area* so a tap can never leave the tile.
 *
 * Everything varies per-vertex via `aTile`, so no uniform branching and no
 * material permutations: two materials serve the entire forest.
 */
function atlasPatch(
  mat: THREE.Material, rects: TileRect[], foliage: boolean, atlasSize: number,
): void {
  // The rect table is baked into the source as a constant array rather than
  // uploaded as a uniform: it is fixed for the lifetime of the atlas, and a
  // compile-time constant lets the driver fold the indexing.
  const table = rects
    .map(r => `vec4(${r.ox.toFixed(6)},${r.oy.toFixed(6)},${r.sx.toFixed(6)},${r.sy.toFixed(6)})`)
    .join(',\n    ');
  const key = `atlas:${foliage ? 'foliage' : 'bark'}:${rects.length}:${atlasSize}:${table.length}`;

  registerShaderPatch(key, () => (shader) => {
    shader.uniforms.uAtlasTexel = { value: 1 / atlasSize };

    // ---- vertex: forward tile + repeats, and the unbounded UV ----
    shader.vertexShader = `attribute vec3 aTile;
varying vec3 vAtlasTile;
varying vec2 vAtlasUv;
` + shader.vertexShader.replace(
      '#include <uv_vertex>',
      `#include <uv_vertex>
      vAtlasTile = aTile;
      // Unbounded, un-fracted UV. Kept separate from vMapUv so three's own
      // transform pipeline is untouched and the gradients stay smooth.
      vAtlasUv = uv * vec2(aTile.y, aTile.z);`,
    );

    // ---- fragment: resolve tile rect, fract, sample with explicit gradients ----
    shader.fragmentShader = `varying vec3 vAtlasTile;
varying vec2 vAtlasUv;
uniform float uAtlasTexel;

const vec4 ATLAS_RECTS[${rects.length}] = vec4[${rects.length}](
    ${table}
);

// Gradients of the *unfracted* UV — smooth across the wrap line.
vec2 atlasDx, atlasDy;
vec4 atlasRect;

vec4 atlasSample(sampler2D tex) {
  vec2 f = fract(vAtlasUv);
  // Inset by half a texel of the content area: a bilinear tap can then never
  // cross into the gutter, let alone the next cell.
  vec2 inset = vec2(uAtlasTexel * 0.5) / max(atlasRect.zw, vec2(1e-5));
  f = clamp(f, inset, 1.0 - inset);
  vec2 uvA = atlasRect.xy + f * atlasRect.zw;
  // Gradients must be scaled into atlas space too, or the mip chain is picked
  // for the wrong footprint (too sharp, and distant trunks alias badly).
  return texture2DGradEXT(tex, uvA, atlasDx * atlasRect.zw, atlasDy * atlasRect.zw);
}
` + shader.fragmentShader
      // Establish the shared per-fragment state before any map is read. Sits at
      // the very top of main() because derivatives must be taken in uniform
      // control flow — inside a branch they are undefined.
      .replace(
        'void main() {',
        `void main() {
        atlasDx = dFdx(vAtlasUv);
        atlasDy = dFdy(vAtlasUv);
        {
          int ti = int(vAtlasTile.x + 0.5);
          ti = clamp(ti, 0, ${rects.length - 1});
          atlasRect = ATLAS_RECTS[ti];
        }`,
      )
      // albedo
      .replace(
        '#include <map_fragment>',
        `{
          vec4 sampledDiffuseColor = atlasSample(map);
          diffuseColor *= sampledDiffuseColor;
        }`,
      )
      // tangent-space normal
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec3 mapN = atlasSample(normalMap).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
        }`,
      )
      // packed ORM — one fetch, three parameters
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness;
        vec4 atlasOrm = atlasSample(roughnessMap);
        roughnessFactor *= atlasOrm.g;`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `float metalnessFactor = metalness;
        metalnessFactor *= atlasOrm.b;`,
      )
      .replace(
        '#include <aomap_fragment>',
        `{
          float ambientOcclusion = (atlasOrm.r - 1.0) * aoMapIntensity + 1.0;
          reflectedLight.indirectDiffuse *= ambientOcclusion;
          #if defined( USE_SHEEN )
            sheenSpecularIndirect *= ambientOcclusion;
          #endif
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            float dotNVao = saturate(dot(geometryNormal, geometryViewDir));
            reflectedLight.indirectSpecular *= computeSpecularOcclusion(
              dotNVao, ambientOcclusion, material.roughness);
          #endif
        }`,
      );

    if (foliage) {
      // Alpha comes from the atlas fetch, not from three's alphaMap path. The
      // test must also compensate for mip-chain alpha erosion: averaging a leaf
      // card's alpha across mips pulls the mean down, so a fixed threshold eats
      // distant foliage entirely and canopies visibly thin out with distance.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <alphatest_fragment>',
        `{
          float mipBias = clamp(
            log2(max(length(atlasDx * atlasRect.zw), length(atlasDy * atlasRect.zw))
                 / max(uAtlasTexel, 1e-6)), 0.0, 4.0);
          float thr = alphaTest * (1.0 - mipBias * 0.16);
          if (diffuseColor.a < thr) discard;
        }`,
      );
    }
  });

  applyShaderPatch(mat, key);
}

export class ForestAtlas {
  readonly albedo: THREE.DataTexture;
  readonly normal: THREE.DataTexture;
  readonly orm: THREE.DataTexture;
  readonly rects: TileRect[] = [];

  /** the single opaque material every trunk / log / stump / rock-free bark uses */
  readonly barkMat: THREE.MeshStandardMaterial;
  /** the single alpha-tested material every leaf / needle / fern / drape uses */
  readonly foliageMat: THREE.MeshStandardMaterial;

  private constructor(
    albedo: THREE.DataTexture, normal: THREE.DataTexture, orm: THREE.DataTexture,
    rects: TileRect[], anisotropy: number,
  ) {
    this.albedo = albedo; this.normal = normal; this.orm = orm; this.rects = rects;

    // ── the two materials ───────────────────────────────────────────────────
    // Two, not sixteen. Bark is opaque and двусторонне irrelevant; foliage is
    // alpha-tested and double-sided. Everything else — which tile, how many
    // repeats, what tint — travels as *vertex data*, so material count stays at
    // two no matter how many archetypes and variants we add.
    this.barkMat = new THREE.MeshStandardMaterial({
      map: albedo, normalMap: normal, aoMap: orm, roughnessMap: orm, metalnessMap: orm,
      roughness: 1, metalness: 0,
      vertexColors: true,
    });
    this.foliageMat = new THREE.MeshStandardMaterial({
      map: albedo, normalMap: normal, aoMap: orm, roughnessMap: orm, metalnessMap: orm,
      roughness: 1, metalness: 0,
      vertexColors: true,
      transparent: false,
      // Alpha *test*, not blend: foliage must write depth or the canopy sorts
      // wrong against itself and against fog, and we'd pay a full sort per frame.
      alphaTest: 0.38,
      side: THREE.DoubleSide,
    });

    // The atlas is square, so one edge length gives the texel size the shader
    // needs for its gutter inset and mip-bias maths.
    const atlasSize = albedo.image.width;
    atlasPatch(this.barkMat, rects, false, atlasSize);
    atlasPatch(this.foliageMat, rects, true, atlasSize);

    // Anisotropy is applied here rather than at texture creation so both
    // materials are guaranteed to agree — grazing angles on a trunk are exactly
    // where an atlas seam would show first.
    for (const t of [albedo, normal, orm]) t.anisotropy = anisotropy;
  }

  /**
   * Build the atlas.
   *
   * `size` is the *full sheet* edge in texels; each of the 16 cells therefore
   * gets `size/4`, of which a 4-texel ring is gutter. At the default 1024 that
   * is a 256 cell with 248 usable — plenty for bark, and foliage cards read
   * fine because their silhouette is what matters, not their interior detail.
   */
  static build(seed: number, opts: { size: number; anisotropy: number }): ForestAtlas {
    const size = opts.size;
    const cell = Math.floor(size / ATLAS_COLS);
    // Gutter scales with cell size so the bleed survives the same number of mip
    // levels regardless of quality tier.
    const gutter = Math.max(2, Math.round(cell / 64));
    const inner = cell - gutter * 2;

    const surf = allocSurface(size);
    const alphaBuf = new Float32Array(size * size);
    const rects: TileRect[] = [];

    for (let tile = 0; tile < ATLAS_COLS * ATLAS_ROWS; tile++) {
      const cx = (tile % ATLAS_COLS) * cell;
      const cy = Math.floor(tile / ATLAS_COLS) * cell;
      const isFoliage = FOLIAGE_TILES.includes(tile);

      rects.push({
        ox: (cx + gutter) / size,
        oy: (cy + gutter) / size,
        sx: inner / size,
        sy: inner / size,
      });

      // Painter writes into the inner area. We keep a local alpha plane because
      // SurfaceBuffers' albedo alpha byte is where the foliage cutout lives and
      // we also need it as float for the gutter fill.
      const c: Cell = {
        n: inner,
        put: (ix, iy, r, g, b, h, ao, rough, alpha) => {
          const px = cx + gutter + ix, py = cy + gutter + iy;
          const i = py * size + px;
          setRGB(surf, i, r, g, b);
          surf.albedo[i * 4 + 3] = Math.max(0, Math.min(255, alpha * 255));
          alphaBuf[i] = alpha;
          surf.height[i] = h;
          surf.ao[i] = ao;
          surf.rough[i] = rough;
          surf.metal[i] = 0;
        },
      };

      switch (tile) {
        case TILE.barkMatureConifer: barkMatureConifer(c, seed + tile * 977); break;
        case TILE.barkYoungConifer: barkYoungConifer(c, seed + tile * 977); break;
        case TILE.barkHardwood: barkHardwood(c, seed + tile * 977); break;
        case TILE.barkPale: barkPale(c, seed + tile * 977); break;
        case TILE.barkSnag: barkSnag(c, seed + tile * 977); break;
        case TILE.woodSplintered: woodSplintered(c, seed + tile * 977); break;
        case TILE.barkMossy: barkMossy(c, seed + tile * 977); break;
        case TILE.barkAlder: barkAlder(c, seed + tile * 977); break;
        case TILE.needleDense: needleCard(c, seed + tile * 977, 0.86, 0.0); break;
        case TILE.needleSparse: needleCard(c, seed + tile * 977, 0.40, 0.62); break;
        case TILE.leafHardwood: leafCard(c, seed + tile * 977, 0.05, 0.85, 1.0); break;
        case TILE.leafDry: leafCard(c, seed + tile * 977, 0.78, 0.5, 0.92); break;
        case TILE.twigsBare: twigCard(c, seed + tile * 977); break;
        case TILE.fern: fernCard(c, seed + tile * 977); break;
        case TILE.leafBroad: leafCard(c, seed + tile * 977, 0.12, 0.0, 1.18); break;
        case TILE.mossDrape: mossDrapeCard(c, seed + tile * 977); break;
      }

      // ── gutter fill ──────────────────────────────────────────────────────
      // Bark wraps (it tiles, so the opposite edge *is* the correct neighbour);
      // foliage clamps to transparent-edge (a leaf card does not tile, and
      // wrapping it would paste leaf tips onto the opposite side).
      fillGutter(surf, alphaBuf, size, cx, cy, cell, gutter, inner, !isFoliage);
    }

    // AO from the height field. Bark fissures and leaf-vein troughs both want
    // contact darkening; doing it here means every tile gets it for free.
    bakeCavityAO(surf.height, surf.ao, size, Math.max(2, Math.round(size / 128)), 0.55);

    const albedoData = new Uint8Array(surf.albedo);   // copy: albedo keeps alpha
    const albedo = dataTexture(albedoData, size, { srgb: true, anisotropy: opts.anisotropy });
    const normal = dataTexture(
      heightToNormalData(surf.height, size, 2.1), size, { anisotropy: opts.anisotropy });
    const orm = dataTexture(packORM(surf), size, { anisotropy: opts.anisotropy });

    // Manual UV math means we must NOT let the sampler wrap: a fract() slightly
    // outside [0,1) plus a repeat wrap would sample the far side of the sheet.
    for (const t of [albedo, normal, orm]) {
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.repeat.set(1, 1);
    }

    return new ForestAtlas(albedo, normal, orm, rects, opts.anisotropy);
  }

  dispose(): void {
    this.albedo.dispose(); this.normal.dispose(); this.orm.dispose();
    this.barkMat.dispose(); this.foliageMat.dispose();
  }
}

/**
 * Fill a cell's gutter ring so mip generation bleeds *within* the tile.
 *
 * Without this, mip level 3+ of a bark tile contains averaged foliage from the
 * cell next door, which shows up as bright fringing on distant trunks — the
 * classic atlas artefact.
 */
function fillGutter(
  surf: SurfaceBuffers, alphaBuf: Float32Array, size: number,
  cx: number, cy: number, cell: number, gutter: number, inner: number, wrap: boolean,
): void {
  const copy = (fromX: number, fromY: number, toX: number, toY: number) => {
    const fi = (cy + fromY) * size + (cx + fromX);
    const ti = (cy + toY) * size + (cx + toX);
    surf.albedo[ti * 4] = surf.albedo[fi * 4];
    surf.albedo[ti * 4 + 1] = surf.albedo[fi * 4 + 1];
    surf.albedo[ti * 4 + 2] = surf.albedo[fi * 4 + 2];
    surf.albedo[ti * 4 + 3] = surf.albedo[fi * 4 + 3];
    surf.height[ti] = surf.height[fi];
    surf.ao[ti] = surf.ao[fi];
    surf.rough[ti] = surf.rough[fi];
    surf.metal[ti] = surf.metal[fi];
    alphaBuf[ti] = alphaBuf[fi];
  };
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const inX = x >= gutter && x < gutter + inner;
      const inY = y >= gutter && y < gutter + inner;
      if (inX && inY) continue;
      // map into content space
      let sx: number, sy: number;
      if (wrap) {
        sx = gutter + (((x - gutter) % inner) + inner) % inner;
        sy = gutter + (((y - gutter) % inner) + inner) % inner;
      } else {
        sx = Math.min(gutter + inner - 1, Math.max(gutter, x));
        sy = Math.min(gutter + inner - 1, Math.max(gutter, y));
      }
      copy(sx, sy, x, y);
      if (!wrap) {
        // clamped foliage gutter must be fully transparent, otherwise the mip
        // chain drags opaque leaf colour outward and the card grows a halo
        const ti = (cy + y) * size + (cx + x);
        surf.albedo[ti * 4 + 3] = 0;
        alphaBuf[ti] = 0;
      }
    }
  }
}
