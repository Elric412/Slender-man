import * as THREE from 'three';
import { SeededRandom } from '../core/SeededRandom';

/**
 * ============================================================================
 * STATIC — procedural PBR material library
 * ============================================================================
 *
 * Every surface in the game is synthesised at boot. Nothing is downloaded.
 *
 * What makes this version "AAA-shaped" rather than "noise on a canvas":
 *
 *  1. **Real texture sets.** Each surface produces albedo + tangent-space
 *     normal + a *packed* ORM map (AO in R, roughness in G, metalness in B) —
 *     the same channel packing Unreal/Frostbite ship, which lets three sample
 *     one texture for three parameters instead of three textures.
 *  2. **Tileable-by-construction noise.** Value/worley/ridged fBm on a periodic
 *     integer lattice, so no seams and no visible "the artist forgot to wrap".
 *  3. **Detail normals.** A shared high-frequency normal map is blended in at a
 *     second UV scale (RNM-style whiteout blend) so grazing flashlight angles
 *     keep producing micro-shadowing right up against the lens.
 *  4. **Macro variation.** Large-scale albedo modulation breaks up the tiling
 *     on the terrain, which is the single most obvious "it's a game" tell.
 *  5. **A wetness model.** One global uniform darkens albedo, collapses
 *     roughness and boosts specular on up-facing geometry, so when the weather
 *     turns the whole forest reads as soaked — porosity is per material.
 *  6. **Foliage translucency.** Leaves/needles pick up a wrapped + back-lit
 *     term from the flashlight and the moon, which is what makes a beam through
 *     a canopy look like light and not like a decal.
 *  7. **Composable shader patches.** `onBeforeCompile` is a single slot, so we
 *     keep a registry of named patches per material (wind, wetness, detail,
 *     translucency…) and derive a correct `customProgramCacheKey` from it.
 */

// ============================================================================
// composable shader patches
// ============================================================================

type ShaderLike = {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
  defines?: Record<string, unknown>;
};
type ShaderPatch = (shader: ShaderLike) => void;

const patchRegistry = new Map<string, ShaderPatch>();

/** Register (or fetch) a named patch. Keys must encode their parameters. */
export function registerShaderPatch(key: string, make: () => ShaderPatch): string {
  if (!patchRegistry.has(key)) patchRegistry.set(key, make());
  return key;
}

/**
 * Attach a named patch to a material, composing with any patch already there
 * and keeping the program cache key honest (a stale cache key silently gives
 * two materials the same compiled program — that's how wind amplitudes end up
 * mysteriously identical).
 */
export function applyShaderPatch(mat: THREE.Material, key: string): void {
  const ud = mat.userData as { __patches?: string[] };
  if (!ud.__patches) ud.__patches = [];
  if (ud.__patches.includes(key)) return;
  ud.__patches.push(key);
  const keys = ud.__patches;
  mat.onBeforeCompile = (shader) => {
    for (const k of keys) patchRegistry.get(k)?.(shader as unknown as ShaderLike);
  };
  mat.customProgramCacheKey = () => keys.join('|');
  mat.needsUpdate = true;
}

/**
 * `Material.clone()` does not carry `onBeforeCompile` (it's an instance slot,
 * not a copied property) but it *does* deep-copy `userData`. So a clone still
 * knows which patches it wants — this re-binds them.
 */
export function cloneMaterial<T extends THREE.Material>(mat: T): T {
  const c = mat.clone() as T;
  const keys = ((c.userData as { __patches?: string[] }).__patches ?? []).slice();
  (c.userData as { __patches?: string[] }).__patches = [];
  for (const k of keys) applyShaderPatch(c, k);
  return c;
}

// ============================================================================
// shared uniforms (live across clones — they're module singletons)
// ============================================================================

export const surfaceUniforms = {
  /** 0..1 global wetness, driven by the weather director */
  uWetness: { value: 0 },
  /** shared high-frequency normal map for detail blending */
  uDetailNormal: { value: null as THREE.Texture | null },
  /** shared low-frequency mask used to break up tiling */
  uMacroMask: { value: null as THREE.Texture | null },
};

// ============================================================================
// periodic noise
// ============================================================================

/**
 * Seeded, *tileable* noise. Everything takes an explicit integer period and
 * wraps its lattice, which is what keeps 512² textures seam-free.
 */
class PeriodicNoise {
  constructor(private seed: number) {}

  private h2(ix: number, iy: number): number {
    let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(this.seed, 1442695041)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177) | 0;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  }

  /** smooth value noise in [0,1], lattice wrapped at `period` */
  value(x: number, y: number, period: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const w = (v: number) => ((v % period) + period) % period;
    const x0 = w(ix), x1 = w(ix + 1), y0 = w(iy), y1 = w(iy + 1);
    const a = this.h2(x0, y0), b = this.h2(x1, y0);
    const c = this.h2(x0, y1), d = this.h2(x1, y1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  }

  /** fractional Brownian motion in [0,1] */
  fbm(x: number, y: number, period: number, octaves = 5, gain = 0.5, lac = 2): number {
    let amp = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.value(x * f, y * f, Math.max(1, Math.round(period * f))) * amp;
      norm += amp; amp *= gain; f *= lac;
    }
    return sum / norm;
  }

  /** ridged multifractal — sharp creases, ideal for bark fissures and rock */
  ridged(x: number, y: number, period: number, octaves = 5, gain = 0.5): number {
    let amp = 1, f = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.value(x * f, y * f, Math.max(1, Math.round(period * f))) * 2 - 1);
      sum += n * n * amp;
      norm += amp; amp *= gain; f *= 2;
    }
    return sum / norm;
  }

  /** periodic worley F1/F2 on a `cells`×`cells` jittered grid, uv in [0,1) */
  worley(u: number, v: number, cells: number): { f1: number; f2: number } {
    const gx = u * cells, gy = v * cells;
    const ix = Math.floor(gx), iy = Math.floor(gy);
    let f1 = 8, f2 = 8;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = ix + ox, cy = iy + oy;
        const wx = ((cx % cells) + cells) % cells, wy = ((cy % cells) + cells) % cells;
        const jx = cx + this.h2(wx, wy);
        const jy = cy + this.h2(wy + 71, wx + 17);
        const dx = jx - gx, dy = jy - gy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
      }
    }
    return { f1: Math.min(1, f1), f2: Math.min(1, f2) };
  }

  /** domain-warped fbm: the cheapest way to stop noise looking like noise */
  warped(x: number, y: number, period: number, amount = 1.4, octaves = 4): number {
    const wx = this.fbm(x + 5.2, y + 1.3, period, 3) - 0.5;
    const wy = this.fbm(x + 9.7, y + 7.1, period, 3) - 0.5;
    return this.fbm(x + wx * amount, y + wy * amount, period, octaves);
  }
}


// ============================================================================
// texture assembly
// ============================================================================

interface SurfaceBuffers {
  size: number;
  albedo: Uint8Array<ArrayBuffer>;   // RGBA
  height: Float32Array; // 0..1
  ao: Float32Array;     // 0..1
  rough: Float32Array;  // 0..1
  metal: Float32Array;  // 0..1
}

function allocSurface(size: number): SurfaceBuffers {
  const n = size * size;
  const s: SurfaceBuffers = {
    size,
    albedo: new Uint8Array(n * 4),
    height: new Float32Array(n),
    ao: new Float32Array(n),
    rough: new Float32Array(n),
    metal: new Float32Array(n),
  };
  s.ao.fill(1); s.rough.fill(0.9);
  return s;
}

function dataTexture(
  data: Uint8Array<ArrayBuffer>, size: number,
  opts: { srgb?: boolean; repeat?: number | [number, number]; anisotropy?: number },
): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const rep = opts.repeat ?? 1;
  if (Array.isArray(rep)) t.repeat.set(rep[0], rep[1]); else t.repeat.set(rep, rep);
  if (opts.srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = opts.anisotropy ?? 4;
  t.needsUpdate = true;
  return t;
}

/** Sobel-ish height → tangent-space normal, wrapping at the edges. */
function heightToNormalData(height: Float32Array, size: number, strength: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 3x3 sobel gives smoother, less staircased normals than central differences
      const tl = at(x - 1, y - 1), t = at(x, y - 1), tr = at(x + 1, y - 1);
      const l = at(x - 1, y), r = at(x + 1, y);
      const bl = at(x - 1, y + 1), b = at(x, y + 1), br = at(x + 1, y + 1);
      const dx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const dy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      const nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      const i = (y * size + x) * 4;
      out[i] = (nx * inv * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Cheap screen-space-free cavity AO baked from the height field. */
function bakeCavityAO(height: Float32Array, ao: Float32Array, size: number, radius: number, strength: number): void {
  const at = (x: number, y: number) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const r = Math.max(1, radius | 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const h = at(x, y);
      let occ = 0;
      occ += Math.max(0, at(x + r, y) - h);
      occ += Math.max(0, at(x - r, y) - h);
      occ += Math.max(0, at(x, y + r) - h);
      occ += Math.max(0, at(x, y - r) - h);
      occ += Math.max(0, at(x + r, y + r) - h) * 0.7;
      occ += Math.max(0, at(x - r, y - r) - h) * 0.7;
      const i = y * size + x;
      ao[i] = Math.max(0.15, Math.min(1, ao[i] - occ * strength));
    }
  }
}

function packORM(s: SurfaceBuffers): Uint8Array<ArrayBuffer> {
  const n = s.size * s.size;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = Math.max(0, Math.min(255, s.ao[i] * 255));
    out[i * 4 + 1] = Math.max(0, Math.min(255, s.rough[i] * 255));
    out[i * 4 + 2] = Math.max(0, Math.min(255, s.metal[i] * 255));
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Write an sRGB-ish colour into the albedo buffer. */
function setRGB(s: SurfaceBuffers, i: number, r: number, g: number, b: number): void {
  s.albedo[i * 4] = Math.max(0, Math.min(255, r * 255));
  s.albedo[i * 4 + 1] = Math.max(0, Math.min(255, g * 255));
  s.albedo[i * 4 + 2] = Math.max(0, Math.min(255, b * 255));
  s.albedo[i * 4 + 3] = 255;
}

const frame = (): Promise<void> =>
  new Promise((res) => (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(() => res())
    : setTimeout(res, 0)));

// ============================================================================
// the patches themselves
// ============================================================================

/**
 * Wetness. Physically: water fills surface pores, which (a) darkens diffuse
 * because light gets trapped in the film, and (b) collapses roughness because
 * the film is smooth. Up-facing geometry gets it worst — rain falls down.
 */
function wetnessPatch(porosity: number): string {
  const key = `wet:${porosity.toFixed(2)}`;
  return registerShaderPatch(key, () => (shader) => {
    shader.uniforms.uWetness = surfaceUniforms.uWetness;
    shader.fragmentShader = 'uniform float uWetness;\n' + shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      /* glsl */`
      {
        // view→world without an inverse: transpose-multiply an orthonormal basis
        vec3 wetWorldN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
        float up = clamp(wetWorldN.y, 0.0, 1.0);
        float wet = uWetness * ${porosity.toFixed(3)} * mix(0.22, 1.0, up * up);
        diffuseColor.rgb *= mix(1.0, 0.5, wet);
        roughnessFactor = mix(roughnessFactor, 0.08, wet);
      }
      #include <lights_physical_fragment>`);
  });
}

/** Micro-normal detail at a second UV scale — keeps close-ups from going flat. */
function detailNormalPatch(scale: number, strength: number): string {
  const key = `detail:${scale}:${strength}`;
  return registerShaderPatch(key, () => (shader) => {
    shader.uniforms.uDetailNormal = surfaceUniforms.uDetailNormal;
    shader.fragmentShader = 'uniform sampler2D uDetailNormal;\n' + shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      /* glsl */`
      #include <normal_fragment_maps>
      #ifdef USE_NORMALMAP_TANGENTSPACE
      {
        vec3 dn = texture2D(uDetailNormal, vNormalMapUv * ${scale.toFixed(2)}).xyz * 2.0 - 1.0;
        normal = normalize(normal + tbn * vec3(dn.xy * ${strength.toFixed(2)}, 0.0));
      }
      #endif`);
  });
}

/** Low-frequency albedo modulation: the cheapest cure for visible tiling. */
function macroVariationPatch(scale: number, strength: number): string {
  const key = `macro:${scale}:${strength}`;
  return registerShaderPatch(key, () => (shader) => {
    shader.uniforms.uMacroMask = surfaceUniforms.uMacroMask;
    shader.fragmentShader = 'uniform sampler2D uMacroMask;\n' + shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */`
      #include <map_fragment>
      #ifdef USE_MAP
      {
        vec3 m = texture2D(uMacroMask, vMapUv * ${scale.toFixed(4)}).rgb;
        diffuseColor.rgb *= mix(vec3(1.0), m * 1.55, ${strength.toFixed(2)});
      }
      #endif`);
  });
}

/**
 * Foliage translucency. Leaves are thin dielectric sheets: light punches
 * through them. We add a wrapped diffuse term plus an explicit back-lit lobe
 * for the flashlight and the moon, evaluated against three's own light structs
 * so attenuation matches the direct lighting exactly.
 */
function translucencyPatch(amount: number): string {
  const key = `translucent:${amount.toFixed(2)}`;
  return registerShaderPatch(key, () => (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      /* glsl */`
      #include <lights_fragment_end>
      {
        float transAmt = ${amount.toFixed(3)};
        #if NUM_SPOT_LIGHTS > 0
        #pragma unroll_loop_start
        for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
          // NOTE: three's unroller *strips* the for-header and its braces and
          // pastes the body N times, so every iteration must open its own scope
          // or the second copy redefines lVec/L/atten and the shader won't link.
          {
            vec3 lVec = spotLights[i].position - geometryPosition;
            float lDist = length(lVec);
            vec3 L = lVec / max(lDist, 1e-4);
            float atten = getSpotAttenuation(spotLights[i].coneCos, spotLights[i].penumbraCos, dot(L, spotLights[i].direction))
                        * getDistanceAttenuation(lDist, spotLights[i].distance, spotLights[i].decay);
            float back = clamp(-dot(geometryNormal, L), 0.0, 1.0);
            float wrapd = clamp((dot(geometryNormal, L) + 0.6) / 1.6, 0.0, 1.0);
            reflectedLight.directDiffuse += spotLights[i].color * atten *
              (back * 0.75 + wrapd * 0.20) * transAmt * diffuseColor.rgb;
          }
        }
        #pragma unroll_loop_end
        #endif
        #if NUM_DIR_LIGHTS > 0
        #pragma unroll_loop_start
        for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
          {
            vec3 L = directionalLights[i].direction;
            float back = clamp(-dot(geometryNormal, L), 0.0, 1.0);
            reflectedLight.directDiffuse += directionalLights[i].color * back * 0.35 * transAmt * diffuseColor.rgb;
          }
        }
        #pragma unroll_loop_end
        #endif
      }`);
  });
}

// ============================================================================
// the library
// ============================================================================

export interface MaterialLibraryOptions {
  /** procedural texture resolution (power of two) */
  size?: number;
  anisotropy?: number;
  /** yields to the browser between surfaces so the loader can paint */
  onProgress?: (fraction: number, label: string) => void;
}

interface TexSet {
  map: THREE.DataTexture;
  normalMap: THREE.DataTexture;
  ormMap: THREE.DataTexture;
}

export class MaterialLibrary {
  readonly rng: SeededRandom;

  // ---- surfaces ----
  bark!: THREE.MeshStandardMaterial;
  barkDead!: THREE.MeshStandardMaterial;
  birchBark!: THREE.MeshStandardMaterial;
  foliage!: THREE.MeshStandardMaterial;
  foliageDead!: THREE.MeshStandardMaterial;
  ground!: THREE.MeshStandardMaterial;
  rock!: THREE.MeshStandardMaterial;
  woodPlank!: THREE.MeshStandardMaterial;
  woodRot!: THREE.MeshStandardMaterial;
  metalRust!: THREE.MeshStandardMaterial;
  metalPaint!: THREE.MeshStandardMaterial;
  glass!: THREE.MeshPhysicalMaterial;
  tentFabric!: THREE.MeshStandardMaterial;
  paperMat!: THREE.MeshStandardMaterial;
  mudPuddle!: THREE.MeshPhysicalMaterial;
  palebarkSuit!: THREE.MeshStandardMaterial;
  palebarkSkin!: THREE.MeshPhysicalMaterial;
  bone!: THREE.MeshStandardMaterial;
  concrete!: THREE.MeshStandardMaterial;
  fabric!: THREE.MeshStandardMaterial;
  knurl!: THREE.MeshStandardMaterial;

  /** shared micro-detail normal, also exposed for anything bespoke */
  detailNormal!: THREE.DataTexture;
  macroMask!: THREE.DataTexture;

  private disposables: (THREE.Texture | THREE.Material)[] = [];
  private size: number;
  private aniso: number;
  private noise: PeriodicNoise;

  private constructor(seed: number, opts: MaterialLibraryOptions) {
    this.rng = new SeededRandom(seed ^ 0x51AB);
    this.size = opts.size ?? 512;
    this.aniso = opts.anisotropy ?? 4;
    this.noise = new PeriodicNoise(seed ^ 0x9E37);
  }

  /**
   * Async factory: synthesis is CPU-heavy (millions of noise evaluations), so
   * we hand a frame back to the browser between surfaces. The loading bar
   * actually animates and mobile Safari doesn't kill us for jank.
   */
  static async create(seed: number, opts: MaterialLibraryOptions = {}): Promise<MaterialLibrary> {
    const lib = new MaterialLibrary(seed, opts);
    const steps: [string, () => void][] = [
      ['detail grain', () => lib.buildShared()],
      ['bark', () => lib.buildBark()],
      ['birch', () => lib.buildBirch()],
      ['foliage', () => lib.buildFoliage()],
      ['forest floor', () => lib.buildGround()],
      ['granite', () => lib.buildRock()],
      ['timber', () => lib.buildWood()],
      ['corroded steel', () => lib.buildMetal()],
      ['concrete', () => lib.buildConcrete()],
      ['fabric & kit', () => lib.buildFabrics()],
      ['the thing in the trees', () => lib.buildEntity()],
    ];
    for (let i = 0; i < steps.length; i++) {
      const [label, fn] = steps[i];
      fn();
      opts.onProgress?.((i + 1) / steps.length, label);
      await frame();
    }
    return lib;
  }

  // ---------------------------------------------------------------- plumbing
  private track<T extends THREE.Texture | THREE.Material>(t: T): T { this.disposables.push(t); return t; }

  private finish(s: SurfaceBuffers, opts: {
    repeat?: number | [number, number];
    normalStrength?: number;
    aoRadius?: number;
    aoStrength?: number;
  }): TexSet {
    if (opts.aoStrength !== undefined) {
      bakeCavityAO(s.height, s.ao, s.size, opts.aoRadius ?? 3, opts.aoStrength);
    }
    const map = this.track(dataTexture(s.albedo, s.size, { srgb: true, repeat: opts.repeat, anisotropy: this.aniso }));
    const normalMap = this.track(dataTexture(
      heightToNormalData(s.height, s.size, opts.normalStrength ?? 2.5), s.size,
      { repeat: opts.repeat, anisotropy: this.aniso }));
    const ormMap = this.track(dataTexture(packORM(s), s.size, { repeat: opts.repeat, anisotropy: this.aniso }));
    return { map, normalMap, ormMap };
  }

  /** Assemble a standard material from a texture set with ORM channel routing. */
  private standard(t: TexSet, params: THREE.MeshStandardMaterialParameters & {
    patches?: string[];
  }): THREE.MeshStandardMaterial {
    const { patches, ...rest } = params;
    const m = this.track(new THREE.MeshStandardMaterial({
      map: t.map,
      normalMap: t.normalMap,
      roughnessMap: t.ormMap,     // reads .g
      metalnessMap: t.ormMap,     // reads .b
      aoMap: t.ormMap,            // reads .r — indirect light only, correctly
      roughness: 1.0,
      metalness: 1.0,
      ...rest,
    }));
    for (const p of patches ?? []) applyShaderPatch(m, p);
    return m;
  }

  // ------------------------------------------------------------------ shared
  /**
   * Two global helper textures:
   *  - `detailNormal`: isotropic micro-grain, blended into every hard surface.
   *  - `macroMask`: very low frequency luminance blotches to kill tiling.
   */
  private buildShared(): void {
    const S = 128;
    {
      const h = new Float32Array(S * S);
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const u = x / S, v = y / S;
          h[y * S + x] =
            this.noise.fbm(u * 24, v * 24, 24, 3, 0.55) * 0.7 +
            this.noise.worley(u, v, 22).f1 * 0.3;
        }
      }
      this.detailNormal = this.track(dataTexture(heightToNormalData(h, S, 1.6), S, { anisotropy: this.aniso }));
      surfaceUniforms.uDetailNormal.value = this.detailNormal;
    }
    {
      const M = 128;
      const data = new Uint8Array(M * M * 4);
      for (let y = 0; y < M; y++) {
        for (let x = 0; x < M; x++) {
          const u = x / M, v = y / M;
          const n = this.noise.warped(u * 4, v * 4, 4, 1.1, 4);
          const warm = this.noise.fbm(u * 2 + 11, v * 2 + 3, 2, 3);
          const i = (y * M + x) * 4;
          const base = 0.52 + n * 0.5;
          data[i] = Math.min(255, base * 255 * (0.96 + warm * 0.1));
          data[i + 1] = Math.min(255, base * 255);
          data[i + 2] = Math.min(255, base * 255 * (1.02 - warm * 0.08));
          data[i + 3] = 255;
        }
      }
      this.macroMask = this.track(dataTexture(data, M, { anisotropy: 2 }));
      surfaceUniforms.uMacroMask.value = this.macroMask;
    }
  }

  // -------------------------------------------------------------------- bark
  private buildBark(): void {
    const S = this.size;
    const s = allocSurface(S);
    const n = this.noise;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = x / S, v = y / S;
        // fissures run vertically: squash the domain on v, warp on u
        const fis = n.ridged(u * 26, v * 5, 26, 5, 0.55);
        const coarse = n.warped(u * 7, v * 3, 7, 1.6, 4);
        const flake = n.worley(u * 1.0, v * 0.55, 14).f1;
        let h = fis * 0.55 + coarse * 0.3 + flake * 0.15;
        h = Math.pow(h, 1.15);
        s.height[i] = h;

        // colour: cold grey-brown, redder in the crevices, moss creeping up
        const depth = 1 - h;
        let r = 0.30 + h * 0.24 - depth * 0.10;
        let g = 0.25 + h * 0.20 - depth * 0.09;
        let b = 0.19 + h * 0.14 - depth * 0.07;
        const moss = Math.max(0, n.fbm(u * 5 + 60, v * 5, 5, 3) - 0.48) * 2.2 * (1 - v) * (1 - v);
        r *= 1 - moss * 0.55; g *= 1 + moss * 0.35; b *= 1 - moss * 0.72;
        const lichen = Math.max(0, n.worley(u * 1.7 + 0.3, v * 1.7, 30).f1 < 0.12 ? 1 : 0);
        if (lichen > 0) { r += 0.10; g += 0.11; b += 0.09; }
        setRGB(s, i, r, g, b);

        s.rough[i] = 0.86 + (1 - h) * 0.14;
        s.metal[i] = 0;
      }
    }
    const t = this.finish(s, { repeat: [1.6, 1.6], normalStrength: 3.2, aoRadius: 4, aoStrength: 0.55 });
    const patches = [
      detailNormalPatch(7, 0.45),
      wetnessPatch(0.85),
    ];
    this.bark = this.standard(t, {
      color: 0x8a7660, envMapIntensity: 0.55, patches,
      normalScale: new THREE.Vector2(1.35, 1.35),
    });
    this.barkDead = this.standard(t, {
      color: 0xa89f92, envMapIntensity: 0.5, patches,
      normalScale: new THREE.Vector2(1.6, 1.6),
    });
  }

  // ------------------------------------------------------------------- birch
  private buildBirch(): void {
    const S = Math.min(512, this.size);
    const s = allocSurface(S);
    const n = this.noise;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = x / S, v = y / S;
        const paper = n.fbm(u * 9, v * 9, 9, 4);
        // horizontal lenticel scars
        const bandPhase = v * 26 + n.fbm(u * 3, v * 2, 3, 2) * 5;
        const band = Math.abs(Math.sin(bandPhase * Math.PI));
        const lent = band > 0.93 ? 1 : 0;
        // peeling curls
        const peel = n.warped(u * 6 + 20, v * 6, 6, 1.2, 3);
        const peeled = peel > 0.56 ? 1 : 0;

        const h = paper * 0.35 + (1 - lent) * 0.4 + peeled * 0.25;
        s.height[i] = h;
        let base = 0.72 + paper * 0.24;
        if (lent) base *= 0.28;
        if (peeled) base *= 0.72;
        setRGB(s, i, base * 1.0, base * 0.985, base * 0.94);
        s.rough[i] = lent ? 0.9 : 0.6 + paper * 0.2;
        s.metal[i] = 0;
      }
    }
    const t = this.finish(s, { repeat: [1.2, 1.2], normalStrength: 1.5, aoRadius: 2, aoStrength: 0.35 });
    this.birchBark = this.standard(t, {
      color: 0xd9d5c9, envMapIntensity: 0.7,
      patches: [detailNormalPatch(9, 0.3), wetnessPatch(0.6)],
    });
  }

  // ----------------------------------------------------------------- foliage
  /**
   * Foliage is the one place a canvas beats typed arrays: we want *shapes*
   * (needle strokes, leaf blobs) with real alpha, and 2D path rendering is the
   * right tool. The result is alpha-tested with translucency + wind patches.
   */
  private buildFoliage(): void {
    const S = Math.min(512, this.size);
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, S, S);
    const fr = this.rng.fork(2);

    // soft clusters first — these carry the silhouette at distance
    for (let i = 0; i < 700; i++) {
      const x = fr.range(0, S), y = fr.range(0, S), r = fr.range(4, 13);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const sh = fr.range(0.45, 1.15);
      g.addColorStop(0, `rgba(${(38 * sh) | 0},${(58 * sh) | 0},${(33 * sh) | 0},0.96)`);
      g.addColorStop(0.7, `rgba(${(26 * sh) | 0},${(42 * sh) | 0},${(24 * sh) | 0},0.55)`);
      g.addColorStop(1, 'rgba(18,28,16,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    // needles: thousands of short strokes give a fractal edge that alpha-test
    // turns into convincing sub-branch detail
    for (let i = 0; i < 3600; i++) {
      const x = fr.range(0, S), y = fr.range(0, S);
      const a = fr.range(0, Math.PI * 2), l = fr.range(2.5, 9);
      const sh = fr.range(0.35, 1.25);
      ctx.strokeStyle = `rgba(${(32 * sh) | 0},${(52 * sh) | 0},${(28 * sh) | 0},${fr.range(0.3, 0.85)})`;
      ctx.lineWidth = fr.range(0.5, 1.5);
      ctx.beginPath(); ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      ctx.stroke();
    }
    // a few bright rim specks: catches the beam, reads as wet needles
    for (let i = 0; i < 260; i++) {
      const x = fr.range(0, S), y = fr.range(0, S);
      ctx.fillStyle = `rgba(${fr.int(90, 140)},${fr.int(120, 165)},${fr.int(80, 110)},${fr.range(0.3, 0.7)})`;
      ctx.beginPath(); ctx.arc(x, y, fr.range(0.6, 1.6), 0, Math.PI * 2); ctx.fill();
    }

    const tex = this.track(new THREE.CanvasTexture(c));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.aniso;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;

    const common: THREE.MeshStandardMaterialParameters = {
      map: tex, alphaTest: 0.4, side: THREE.DoubleSide,
      roughness: 0.88, metalness: 0, envMapIntensity: 0.35,
    };
    this.foliage = this.track(new THREE.MeshStandardMaterial({ ...common, color: 0x8fa47f }));
    this.foliageDead = this.track(new THREE.MeshStandardMaterial({ ...common, color: 0x8a7a56, roughness: 0.95 }));
    for (const m of [this.foliage, this.foliageDead]) {
      applyShaderPatch(m, translucencyPatch(0.55));
    }
  }

  // ------------------------------------------------------------ forest floor
  private buildGround(): void {
    const S = this.size;
    const s = allocSurface(S);
    const n = this.noise;
    const r = this.rng.fork(31);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = x / S, v = y / S;
        const soil = n.warped(u * 10, v * 10, 10, 1.3, 5);
        const clods = n.worley(u, v, 26).f1;
        const h = soil * 0.6 + (1 - clods) * 0.4;
        s.height[i] = h;
        // damp humus: brown, slightly green where moss takes hold
        const moss = Math.max(0, n.fbm(u * 6 + 90, v * 6, 6, 3) - 0.52) * 2.4;
        const rr = 0.26 + soil * 0.20;
        const gg = 0.22 + soil * 0.17 + moss * 0.10;
        const bb = 0.16 + soil * 0.11;
        setRGB(s, i, rr, gg, bb);
        s.rough[i] = 0.9 + soil * 0.1;
        s.metal[i] = 0;
      }
    }
    // stamped litter: leaves, twigs, grit. Cheap sprite-splatting into the
    // buffers with wrap so the tile still tiles.
    const stampLeaf = (cx: number, cy: number) => {
      const len = r.range(3, 9), wid = r.range(1.6, 3.4), rot = r.range(0, Math.PI);
      const cs = Math.cos(rot), sn = Math.sin(rot);
      const cr = r.range(0.22, 0.42), cg = r.range(0.16, 0.32), cb = r.range(0.08, 0.17);
      for (let dy = -len; dy <= len; dy++) {
        for (let dx = -len; dx <= len; dx++) {
          const lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs;
          if ((lx * lx) / (len * len) + (ly * ly) / (wid * wid) > 1) continue;
          const px = ((cx + dx) % S + S) % S, py = ((cy + dy) % S + S) % S;
          const i = py * S + px;
          setRGB(s, i, cr, cg, cb);
          s.height[i] = Math.min(1, s.height[i] + 0.16);
          s.rough[i] = 0.95;
        }
      }
    };
    for (let k = 0; k < Math.round(S * 1.4); k++) stampLeaf(r.int(0, S), r.int(0, S));
    const stampPebble = (cx: number, cy: number) => {
      const rad = r.range(1.2, 3.2);
      const g = r.range(0.30, 0.46);
      for (let dy = -rad; dy <= rad; dy++) {
        for (let dx = -rad; dx <= rad; dx++) {
          if (dx * dx + dy * dy > rad * rad) continue;
          const px = ((cx + dx) % S + S) % S, py = ((cy + dy) % S + S) % S;
          const i = py * S + px;
          setRGB(s, i, g, g * 0.98, g * 0.92);
          s.height[i] = Math.min(1, s.height[i] + 0.3 * (1 - (dx * dx + dy * dy) / (rad * rad)));
          s.rough[i] = 0.7;
        }
      }
    };
    for (let k = 0; k < Math.round(S * 0.5); k++) stampPebble(r.int(0, S), r.int(0, S));

    const t = this.finish(s, { repeat: 90, normalStrength: 2.2, aoRadius: 3, aoStrength: 0.5 });
    this.ground = this.standard(t, {
      color: 0x93887a, envMapIntensity: 0.45,
      normalScale: new THREE.Vector2(1.25, 1.25),
      patches: [
        detailNormalPatch(4, 0.35),
        // 90 tiles across the terrain / 30 → ~3 macro blotches per map edge
        macroVariationPatch(1 / 30, 0.55),
        wetnessPatch(1.0),
      ],
    });
  }

  // -------------------------------------------------------------------- rock
  private buildRock(): void {
    const S = this.size;
    const s = allocSurface(S);
    const n = this.noise;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = x / S, v = y / S;
        const w = n.worley(u, v, 9);
        const facets = 1 - Math.min(1, (w.f2 - w.f1) * 3.2);  // crystalline edges
        const strata = Math.sin((v * 7 + n.fbm(u * 3, v * 2, 3, 3) * 3) * Math.PI) * 0.5 + 0.5;
        const grain = n.ridged(u * 20, v * 20, 20, 4, 0.5);
        const h = grain * 0.4 + strata * 0.25 + (1 - facets) * 0.35;
        s.height[i] = h;
        const tone = 0.30 + h * 0.24 + strata * 0.06;
        let rr = tone * 1.0, gg = tone * 1.02, bb = tone * 1.08;
        const lich = Math.max(0, n.fbm(u * 8 + 7, v * 8 + 3, 8, 3) - 0.55) * 2.5;
        rr += lich * 0.10; gg += lich * 0.14; bb += lich * 0.06;
        setRGB(s, i, rr, gg, bb);
        s.rough[i] = 0.72 + grain * 0.22;
        s.metal[i] = 0.02;
      }
    }
    const t = this.finish(s, { repeat: [2, 2], normalStrength: 3.0, aoRadius: 4, aoStrength: 0.6 });
    this.rock = this.standard(t, {
      color: 0x8a8c92, envMapIntensity: 0.6,
      normalScale: new THREE.Vector2(1.3, 1.3),
      patches: [detailNormalPatch(6, 0.4), wetnessPatch(0.7)],
    });
  }

  // -------------------------------------------------------------------- wood
  private buildWood(): void {
    const S = this.size;
    const s = allocSurface(S);
    const n = this.noise;
    const planks = 6;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = x / S, v = y / S;
        const plank = Math.floor(v * planks);
        const inPlank = (v * planks) % 1;
        const seam = inPlank < 0.045 || inPlank > 0.955 ? 1 : 0;
        // grain: stretched fbm + rings around occasional knots
        const grainPhase = u * 30 + n.fbm(u * 4, plank * 3.3, 4, 3) * 6 + plank * 11.7;
        const grain = Math.abs(Math.sin(grainPhase)) * 0.6 + n.fbm(u * 40, v * 8, 40, 3) * 0.4;
        const knotC = n.worley(u * 0.9, v * 0.9 + plank * 0.13, 5);
        const knot = knotC.f1 < 0.13 ? 1 - knotC.f1 / 0.13 : 0;
        let h = grain * 0.5 + 0.25 + knot * 0.2;
        if (seam) h -= 0.45;
        s.height[i] = Math.max(0, h);
        // weathered grey-brown, darker at seams, water stains running across
        const stain = Math.max(0, n.fbm(u * 2 + 55, v * 14, 2, 3) - 0.45) * 1.6;
        let rr = 0.34 + grain * 0.18 - stain * 0.13;
        let gg = 0.28 + grain * 0.15 - stain * 0.12;
        let bb = 0.21 + grain * 0.11 - stain * 0.09;
        if (knot > 0) { rr *= 0.62; gg *= 0.58; bb *= 0.55; }
        if (seam) { rr *= 0.32; gg *= 0.32; bb *= 0.32; }
        setRGB(s, i, rr, gg, bb);
        s.rough[i] = 0.72 + grain * 0.2 + stain * 0.06;
        s.metal[i] = 0;
      }
    }
    const t = this.finish(s, { repeat: [1, 1], normalStrength: 2.4, aoRadius: 3, aoStrength: 0.5 });
    const patches = [detailNormalPatch(5, 0.4), wetnessPatch(0.95)];
    this.woodPlank = this.standard(t, { color: 0x9a8265, envMapIntensity: 0.4, patches });
    this.woodRot = this.standard(t, { color: 0x6a6555, envMapIntensity: 0.3, patches });
  }

  // ------------------------------------------------------------------- metal
  private buildMetal(): void {
    const S = Math.min(512, this.size);
    // ---- corroded steel: rust is a *dielectric*, bare steel is a conductor,
    // so metalness varies across the surface. This is what ORM packing is for.
    {
      const s = allocSurface(S);
      const n = this.noise;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          const u = x / S, v = y / S;
          const rust = n.warped(u * 7, v * 7, 7, 1.5, 5);
          const pit = n.worley(u, v, 34).f1;
          const rustAmt = Math.max(0, Math.min(1, (rust - 0.42) * 3.2));
          const h = (1 - pit) * 0.35 + rust * 0.4 + rustAmt * 0.25;
          s.height[i] = h;
          const steel = 0.40 + n.fbm(u * 25, v * 25, 25, 2) * 0.12;
          const rr = steel * (1 - rustAmt) + 0.46 * rustAmt;
          const gg = steel * (1 - rustAmt) + 0.24 * rustAmt;
          const bb = steel * (1 - rustAmt) + 0.13 * rustAmt;
          setRGB(s, i, rr, gg, bb);
          s.rough[i] = 0.34 + rustAmt * 0.6;
          s.metal[i] = 0.95 * (1 - rustAmt * 0.85);
        }
      }
      const t = this.finish(s, { repeat: [1.5, 1.5], normalStrength: 2.0, aoRadius: 2, aoStrength: 0.4 });
      this.metalRust = this.standard(t, {
        color: 0xa9a29a, envMapIntensity: 0.9,
        patches: [detailNormalPatch(8, 0.35), wetnessPatch(0.45)],
      });
    }
    // ---- painted / peeling metal ----
    {
      const s = allocSurface(S);
      const n = this.noise;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          const u = x / S, v = y / S;
          const peelN = n.warped(u * 8 + 40, v * 8, 8, 1.4, 4);
          const peeled = peelN > 0.55 ? 1 : 0;
          const chip = n.fbm(u * 30, v * 30, 30, 2);
          s.height[i] = peeled ? 0.35 + chip * 0.2 : 0.7 + chip * 0.2;
          const paint = [0.24, 0.31, 0.27];
          const bare = [0.42, 0.24, 0.15];
          const k = peeled ? 1 : 0;
          setRGB(s, i,
            paint[0] * (1 - k) + bare[0] * k,
            paint[1] * (1 - k) + bare[1] * k,
            paint[2] * (1 - k) + bare[2] * k);
          s.rough[i] = peeled ? 0.82 : 0.42 + chip * 0.1;
          s.metal[i] = peeled ? 0.35 : 0.15;
        }
      }
      const t = this.finish(s, { repeat: [1.5, 1.5], normalStrength: 1.6, aoRadius: 2, aoStrength: 0.35 });
      this.metalPaint = this.standard(t, {
        color: 0x74847a, envMapIntensity: 0.8,
        patches: [detailNormalPatch(8, 0.3), wetnessPatch(0.35)],
      });
    }
    // ---- knurled aluminium (the flashlight body in the viewmodel) ----
    {
      const K = 128;
      const s = allocSurface(K);
      for (let y = 0; y < K; y++) {
        for (let x = 0; x < K; x++) {
          const i = y * K + x;
          const d = (Math.sin(x * 0.78) * Math.sin(y * 0.78) * 0.5 + 0.5);
          s.height[i] = d;
          const g = 0.20 + d * 0.10;
          setRGB(s, i, g, g * 1.01, g * 1.05);
          s.rough[i] = 0.28 + (1 - d) * 0.22;
          s.metal[i] = 0.92;
        }
      }
      const t = this.finish(s, { repeat: [4, 4], normalStrength: 2.2, aoRadius: 2, aoStrength: 0.5 });
      this.knurl = this.standard(t, { color: 0x4b5259, envMapIntensity: 1.1 });
    }
  }

  // ---------------------------------------------------------------- concrete
  private buildConcrete(): void {
    const S = Math.min(512, this.size);
    const s = allocSurface(S);
    const n = this.noise;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = x / S, v = y / S;
        const agg = n.worley(u, v, 40).f1;
        const stain = n.warped(u * 5, v * 5, 5, 1.2, 4);
        const crack = n.ridged(u * 6, v * 6, 6, 3, 0.6);
        const isCrack = crack > 0.86 ? 1 : 0;
        s.height[i] = 0.6 + agg * 0.3 - isCrack * 0.5;
        const g = 0.34 + stain * 0.16 - isCrack * 0.14;
        setRGB(s, i, g, g * 0.995, g * 0.97);
        s.rough[i] = 0.86 + agg * 0.1;
        s.metal[i] = 0;
      }
    }
    const t = this.finish(s, { repeat: [2, 2], normalStrength: 1.4, aoRadius: 3, aoStrength: 0.45 });
    this.concrete = this.standard(t, {
      color: 0x8a8a84, envMapIntensity: 0.5,
      patches: [detailNormalPatch(6, 0.3), wetnessPatch(1.0)],
    });

    // wet mud / puddles: a smooth dielectric film. With the sky probe bound
    // this is what actually makes puddles *reflect the treeline*.
    this.mudPuddle = this.track(new THREE.MeshPhysicalMaterial({
      color: 0x241f1a, roughness: 0.075, metalness: 0.0,
      envMapIntensity: 1.35, clearcoat: 0.85, clearcoatRoughness: 0.12,
      reflectivity: 0.6,
    }));

    // glass: thin, filthy, mostly reflective at grazing angles
    this.glass = this.track(new THREE.MeshPhysicalMaterial({
      color: 0x151b20, roughness: 0.14, metalness: 0.0,
      transparent: true, opacity: 0.42,
      envMapIntensity: 1.2, clearcoat: 1.0, clearcoatRoughness: 0.06,
      ior: 1.5, transmission: 0,
    }));
  }

  // ----------------------------------------------------------------- fabrics
  private buildFabrics(): void {
    const S = 256;
    // canvas tent / tarp: visible weave + sheen
    {
      const s = allocSurface(S);
      const n = this.noise;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          const u = x / S, v = y / S;
          const weave = ((x % 6 < 3) !== (y % 6 < 3)) ? 1 : 0.62;
          const wear = n.fbm(u * 8, v * 8, 8, 3);
          s.height[i] = weave * 0.6 + wear * 0.4;
          const g = 0.30 + wear * 0.16;
          setRGB(s, i, g * 1.05 * weave, g * 1.0 * weave, g * 0.72 * weave);
          s.rough[i] = 0.88;
          s.metal[i] = 0;
        }
      }
      const t = this.finish(s, { repeat: [3, 3], normalStrength: 1.5, aoRadius: 2, aoStrength: 0.3 });
      this.tentFabric = this.standard(t, {
        color: 0x77734f, side: THREE.DoubleSide, envMapIntensity: 0.35,
        patches: [wetnessPatch(1.0)],
      });
    }
    // jacket sleeve for the viewmodel: darker, tighter weave, slight sheen
    {
      const s = allocSurface(S);
      const n = this.noise;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) {
          const i = y * S + x;
          const u = x / S, v = y / S;
          const twill = ((x + y) % 5 < 2) ? 1 : 0.68;
          const fuzz = n.fbm(u * 26, v * 26, 26, 3);
          s.height[i] = twill * 0.55 + fuzz * 0.45;
          const g = (0.16 + fuzz * 0.09) * twill;
          setRGB(s, i, g * 0.92, g * 1.0, g * 1.05);
          s.rough[i] = 0.9;
          s.metal[i] = 0;
        }
      }
      const t = this.finish(s, { repeat: [3, 3], normalStrength: 1.3, aoRadius: 2, aoStrength: 0.3 });
      this.fabric = this.standard(t, { color: 0x394045, envMapIntensity: 0.3 });
    }
    // paper: fibrous, slightly translucent-looking
    {
      const P = 128;
      const s = allocSurface(P);
      const n = this.noise;
      for (let y = 0; y < P; y++) {
        for (let x = 0; x < P; x++) {
          const i = y * P + x;
          const u = x / P, v = y / P;
          const fib = n.fbm(u * 30, v * 12, 30, 3);
          const foxing = Math.max(0, n.fbm(u * 5 + 3, v * 5, 5, 3) - 0.55) * 2;
          s.height[i] = fib;
          const g = 0.62 + fib * 0.16 - foxing * 0.2;
          setRGB(s, i, g, g * 0.96, g * 0.86);
          s.rough[i] = 0.95;
          s.metal[i] = 0;
        }
      }
      const t = this.finish(s, { repeat: [1, 1], normalStrength: 0.9 });
      this.paperMat = this.standard(t, { color: 0xb9b19c, envMapIntensity: 0.25 });
    }
    // bone: dry, slightly waxy
    this.bone = this.track(new THREE.MeshStandardMaterial({
      color: 0xb8b0a0, roughness: 0.62, metalness: 0, envMapIntensity: 0.5,
    }));
  }

  // ------------------------------------------------------- the thing itself
  /**
   * Palebark. Deliberately *under*-detailed: a matte, almost featureless dark
   * suit that swallows the flashlight, and skin with a faint waxy sheen so the
   * silhouette reads before any surface detail does. Legibility is the horror.
   */
  private buildEntity(): void {
    const S = 128;
    const s = allocSurface(S);
    const n = this.noise;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = y * S + x;
        const u = x / S, v = y / S;
        const cloth = n.fbm(u * 20, v * 20, 20, 3);
        const crease = n.ridged(u * 5, v * 5, 5, 3, 0.5);
        s.height[i] = cloth * 0.6 + crease * 0.4;
        const g = 0.055 + cloth * 0.035;
        setRGB(s, i, g, g * 1.02, g * 1.06);
        s.rough[i] = 0.55 + cloth * 0.2;
        s.metal[i] = 0.05;
      }
    }
    const t = this.finish(s, { repeat: [2, 2], normalStrength: 1.6, aoRadius: 2, aoStrength: 0.4 });
    this.palebarkSuit = this.standard(t, { color: 0x2b2f34, envMapIntensity: 0.25 });

    this.palebarkSkin = this.track(new THREE.MeshPhysicalMaterial({
      color: 0xd6d0c4, roughness: 0.38, metalness: 0,
      clearcoat: 0.35, clearcoatRoughness: 0.5,
      sheen: 0.6, sheenRoughness: 0.7, sheenColor: new THREE.Color(0xe8e2d2),
      envMapIntensity: 0.55,
    }));
  }

  // ------------------------------------------------------------------- state
  /** 0 = bone dry, 1 = soaked. Drives every patched surface at once. */
  setWetness(v: number): void {
    surfaceUniforms.uWetness.value = THREE.MathUtils.clamp(v, 0, 1);
    const wet = surfaceUniforms.uWetness.value;
    // puddles and glass aren't patched (they're already films) — tune directly
    this.mudPuddle.roughness = 0.075 - wet * 0.03;
    this.mudPuddle.envMapIntensity = 1.2 + wet * 0.5;
  }

  get wetness(): number { return surfaceUniforms.uWetness.value; }

  /** Scale image-based lighting once the sky probe exists. */
  setEnvIntensity(scale: number): void {
    for (const d of this.disposables) {
      const m = d as THREE.MeshStandardMaterial;
      if (m.isMaterial && 'envMapIntensity' in m) {
        m.envMapIntensity = (m.userData.__baseEnv ??= m.envMapIntensity) * scale;
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
