/**
 * PALEBARK — procedural PBR texture synthesis.
 *
 * Raw pixel maths only: no canvas, no image decode, no sampled photo source.
 * The generators are plain functions over Uint8Array so the *same code* runs in
 * the browser (as DataTextures) and in Node (as PNG payloads for the exported
 * GLB), which keeps the shipped asset and the runtime asset identical.
 *
 * Two atlases, both authored against the UV layout in PalebarkGeometry:
 *
 *   SKIN   head · neck · body · palms · fingers
 *   COAT   coat body (hem at v=0) · sleeves · trousers · collar · shoes
 *
 * Channel packing:
 *   albedo  RGB  (A unused, 255)
 *   normal  RGB tangent-space (A 255)
 *   orm     R = AO, G = roughness, B = metalness, A = extra
 *            · skin → A = subsurface thickness (drives the SSS wrap term)
 *            · coat → A = grime/wear mask (blended live by uGrime, see §4)
 *
 * Generation is a generator function that yields after every row band, so the
 * caller can spread a 4K synthesis across frames instead of hitching the tab.
 */

export type AtlasKind = 'skin' | 'coat';

export interface MapSet {
  kind: AtlasKind;
  size: number;
  albedo: Uint8Array<ArrayBuffer>;
  normal: Uint8Array<ArrayBuffer>;
  orm: Uint8Array<ArrayBuffer>;
}

/* ------------------------------------------------------------------ noise */

function hash2i(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** tiling value noise on an N×N lattice (so the atlas can wrap horizontally) */
function vnoise2(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (a: number, b: number) => hash2i(((a % period) + period) % period, ((b % period) + period) % period, seed);
  const a = w(ix, iy), b = w(ix + 1, iy), c = w(ix, iy + 1), d = w(ix + 1, iy + 1);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

function fbm2(x: number, y: number, period: number, seed: number, oct = 4, gain = 0.5): number {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += vnoise2(x * f, y * f, Math.max(2, Math.round(period * f)), seed + i * 97) * amp;
    norm += amp; amp *= gain; f *= 2;
  }
  return s / norm;
}

/** ridged noise — used for veins and cloth creases */
function ridge2(x: number, y: number, period: number, seed: number, oct = 3): number {
  let s = 0, amp = 1, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = Math.abs(vnoise2(x * f, y * f, Math.max(2, Math.round(period * f)), seed + i * 131) * 2 - 1);
    s += (1 - n) * amp;
    norm += amp; amp *= 0.55; f *= 2.1;
  }
  return s / norm;
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** band membership: 1 inside [a,b], feathered by f */
function band(v: number, a: number, b: number, f = 0.02): number {
  return smooth(a - f, a + f, v) * (1 - smooth(b - f, b + f, v));
}

/* -------------------------------------------------------- height → normal */

function heightToNormal(height: Float32Array, size: number, out: Uint8Array<ArrayBuffer>, strength: number): void {
  const idx = (x: number, y: number) => ((y + size) % size) * size + ((x + size) % size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[idx(x - 1, y)], r = height[idx(x + 1, y)];
      const d = height[idx(x, y - 1)], u = height[idx(x, y + 1)];
      let nx = (l - r) * strength;
      let ny = (d - u) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len;
      const nzz = nz / len;
      const o = (y * size + x) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nzz * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
}

/* ------------------------------------------------------------------- skin */

/**
 * Pale, matte-to-waxy, cold. Mottling and vasculature are LOW contrast on
 * purpose: at flashlight range the face should reward inspection with texture,
 * never with decoration. Nothing here paints a feature — no lashes, brows,
 * lips, nostrils or iris exist in this atlas.
 */
function* synthSkinAtlas(size: number, seed: number): Generator<number, MapSet> {
  const albedo = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const P = 64;
  const bandRows = Math.max(8, size >> 5);

  for (let y0 = 0; y0 < size; y0 += bandRows) {
    const y1 = Math.min(size, y0 + bandRows);
    for (let y = y0; y < y1; y++) {
      const v = 1 - y / (size - 1);           // texture v (0 at bottom row)
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1);
        const i = y * size + x;
        const o = i * 4;

        const isHead = band(u, 0.02, 0.56, 0.01) * band(v, 0.36, 0.99, 0.01);
        const isFinger = band(u, 0.60, 1.0, 0.01) * band(v, 0.65, 1.0, 0.01);
        const isPalm = band(u, 0.60, 1.0, 0.01) * band(v, 0.38, 0.65, 0.01);
        const extremity = clamp01(isFinger + isPalm * 0.7);

        // --- base tone: bloodless, faintly green-grey, cooler on the cranium
        const mottle = fbm2(u * 9, v * 9, P, seed, 5) - 0.5;
        const blotch = Math.max(0, fbm2(u * 3.2 + 11, v * 3.2, P, seed + 31, 3) - 0.56) * 1.6;
        let base = 0.735 + mottle * 0.055 - blotch * 0.05;
        base -= extremity * 0.035;                       // hands read colder
        base -= smooth(0.86, 1.0, v) * isHead * 0.015;   // crown a touch darker

        // --- subdermal vasculature: only where skin is thin (temples, hands)
        const veinField = ridge2(u * 14, v * 14, P, seed + 7, 4);
        const veinMask = clamp01(Math.pow(veinField, 5) * 2.2)
          * (extremity * 0.9 + isHead * smooth(0.30, 0.05, Math.abs(u - 0.29)) * 0.35);
        const vein = veinMask * 0.5;

        let r = base + vein * -0.030;
        let g = base * 0.985 + vein * -0.012;
        let b = base * 0.945 + vein * 0.028;             // veins push blue-grey

        // --- micro relief: pores, fine wrinkle grain, knuckle creases
        const pore = fbm2(u * 220, v * 220, P * 4, seed + 3, 3) - 0.5;
        const grain = fbm2(u * 70, v * 70, P * 2, seed + 5, 3) - 0.5;
        const knuckle = isFinger * Math.pow(Math.abs(Math.sin(v * Math.PI * 26)), 6) * 0.55;
        const h = pore * 0.22 + grain * 0.5 + veinField * 0.10 * veinMask + knuckle * 0.6;
        height[i] = h;

        // pores darken very slightly — this is the only "detail" the face gets
        const poreShade = clamp01(0.5 - pore) * 0.02;
        r -= poreShade; g -= poreShade; b -= poreShade;

        albedo[o] = Math.round(clamp01(r) * 255);
        albedo[o + 1] = Math.round(clamp01(g) * 255);
        albedo[o + 2] = Math.round(clamp01(b) * 255);
        albedo[o + 3] = 255;

        // --- ORM: cavity AO, waxy-but-matte roughness, zero metal
        const cavity = clamp01(0.72 + (h - 0.1) * 0.45);
        const rough = clamp01(0.50 + grain * 0.12 - extremity * 0.05 + blotch * 0.10);
        // thickness: fingers and jaw glow at the beam's edge, cranium does not
        const thick = clamp01(0.28 + extremity * 0.55 + isHead * smooth(0.95, 0.55, v) * 0.22);
        orm[o] = Math.round(cavity * 255);
        orm[o + 1] = Math.round(rough * 255);
        orm[o + 2] = 0;
        orm[o + 3] = Math.round(thick * 255);
      }
    }
    yield y1 / size * 0.85;
  }
  heightToNormal(height, size, normal, size / 512 * 1.6);
  yield 1;
  return { kind: 'skin', size, albedo, normal, orm };
}

/* ------------------------------------------------------------------- coat */

/**
 * Heavy weathered wool/canvas. Twill weave at thread scale, broad fold shading,
 * seam lines exactly where the sculpt puts them, and a WEAR MASK (orm.a) that
 * concentrates at hem, cuffs, elbows, shoulders, knees and collar — the places
 * a coat actually dies. `uGrime` in the material blends that mask in as a run
 * escalates; no second texture is ever uploaded.
 */
function* synthCoatAtlas(size: number, seed: number): Generator<number, MapSet> {
  const albedo = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const P = 64;
  const bandRows = Math.max(8, size >> 5);

  for (let y0 = 0; y0 < size; y0 += bandRows) {
    const y1 = Math.min(size, y0 + bandRows);
    for (let y = y0; y < y1; y++) {
      const v = 1 - y / (size - 1);
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1);
        const i = y * size + x;
        const o = i * 4;

        const isBody = band(v, 0.0, 0.55, 0.005);
        const isSleeve = band(v, 0.56, 0.75, 0.005);
        const isTrouser = band(v, 0.75, 0.865, 0.005);
        const isCollar = band(v, 0.865, 0.945, 0.005);
        const isShoe = band(v, 0.945, 1.0, 0.005);

        // --- twill weave: two thread directions, slightly different sheen
        const warp = Math.sin((u * size / 3.2) * Math.PI * 2);
        const weft = Math.sin((v * size / 3.2) * Math.PI * 2 + warp * 0.6);
        const twill = Math.sin(((u + v) * size / 2.6) * Math.PI * 2) * 0.5;
        const weave = (warp * 0.35 + weft * 0.35 + twill * 0.5) * 0.5;
        const slub = fbm2(u * 120, v * 120, P * 2, seed + 17, 3) - 0.5;   // thread irregularity

        // --- macro drape: broad soft folds, strongest low on the coat
        const folds = (fbm2(u * 6, v * 3.5, P, seed + 23, 4) - 0.5) * (0.6 + smooth(0.55, 0.0, v) * 0.8);
        const creases = ridge2(u * 9, v * 5, P, seed + 41, 3);

        // --- seams: shoulder line, sleeve set-in, cuff, hem turn, placket
        const seam =
          Math.exp(-Math.pow((v - 0.545) / 0.0035, 2)) * 0.9 +          // shoulder/back yoke
          Math.exp(-Math.pow((v - 0.752) / 0.003, 2)) * 0.7 +           // trouser top
          Math.exp(-Math.pow((v - 0.562) / 0.003, 2)) * 0.7 +           // cuff
          Math.exp(-Math.pow((v - 0.028) / 0.004, 2)) * 0.8 +           // hem turn
          Math.exp(-Math.pow(((u > 0.5 ? 1 - u : u) - 0.005) / 0.004, 2)) * isBody * 0.6;

        // --- wear mask: where a field coat abrades
        const wear = clamp01(
          smooth(0.16, 0.0, v) * 0.95 * isBody +                          // hem
          Math.exp(-Math.pow((v - 0.655) / 0.035, 2)) * isSleeve * 0.85 + // elbows
          smooth(0.60, 0.56, v) * isSleeve * 0.7 +                        // cuffs
          Math.exp(-Math.pow((v - 0.535) / 0.02, 2)) * 0.6 +              // shoulders
          Math.exp(-Math.pow((v - 0.800) / 0.022, 2)) * isTrouser * 0.7 + // knees
          isCollar * 0.75 + isShoe * 0.9);
        const wearNoise = fbm2(u * 22, v * 22, P, seed + 53, 4);
        const grime = clamp01(wear * (0.55 + wearNoise * 0.9));
        // damp wicking up from the hem — mud spatter, not decoration
        const damp = clamp01(smooth(0.22, 0.0, v) * isBody * (0.4 + ridge2(u * 18, v * 26, P, seed + 61, 3) * 0.9));
        const spatter = clamp01(Math.max(0, fbm2(u * 46, v * 60, P, seed + 71, 3) - 0.62) * 3)
          * smooth(0.32, 0.02, v) * isBody;

        // --- albedo: near-black, desaturated, warmer where dirt sits
        let base = 0.049 + weave * 0.010 + slub * 0.010 + folds * 0.012;
        base += isCollar * 0.004 + isShoe * -0.012 + isTrouser * 0.003;
        base *= 1 - damp * 0.28;                       // wet cloth goes darker
        const dirt = clamp01(grime * 0.55 + spatter * 0.8);
        let r = base * (1 + dirt * 0.55);
        let g = base * (1 + dirt * 0.42);
        let b = base * (1 + dirt * 0.24);
        // abrasion lifts the nap: slightly lighter, greyer threads at wear peaks
        const abrade = clamp01((grime - 0.55) * 1.6) * (0.5 + slub);
        r += abrade * 0.020; g += abrade * 0.020; b += abrade * 0.021;

        albedo[o] = Math.round(clamp01(r) * 255);
        albedo[o + 1] = Math.round(clamp01(g) * 255);
        albedo[o + 2] = Math.round(clamp01(b) * 255);
        albedo[o + 3] = 255;

        // --- height for the normal map
        height[i] = weave * 0.42 + slub * 0.35 + folds * 0.85 + creases * 0.25
          + seam * 0.55 - abrade * 0.25;

        // --- ORM
        const cavity = clamp01(0.70 + folds * 0.5 - seam * 0.25);
        const rough = clamp01(0.86 + slub * 0.06 - damp * 0.34 + grime * 0.05);
        orm[o] = Math.round(cavity * 255);
        orm[o + 1] = Math.round(rough * 255);
        orm[o + 2] = 0;
        orm[o + 3] = Math.round(clamp01(grime * 0.75 + damp * 0.5 + spatter) * 255);
      }
    }
    yield y1 / size * 0.85;
  }
  heightToNormal(height, size, normal, size / 512 * 2.1);
  yield 1;
  return { kind: 'coat', size, albedo, normal, orm };
}

/* ------------------------------------------------------------------- api */

export function synthAtlas(kind: AtlasKind, size: number, seed: number): Generator<number, MapSet> {
  return kind === 'skin' ? synthSkinAtlas(size, seed) : synthCoatAtlas(size, seed);
}

/** Blocking convenience (used by the offline exporter and by tests). */
export function synthAtlasSync(kind: AtlasKind, size: number, seed: number): MapSet {
  const gen = synthAtlas(kind, size, seed);
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

/** Texture tier per quality level. 4K is the hero tier; mobile streams 1K/512. */
export const TEXTURE_TIERS = {
  low: { boot: 256, target: 512 },
  medium: { boot: 512, target: 1024 },
  high: { boot: 512, target: 2048 },
  ultra: { boot: 1024, target: 4096 },
} as const;
