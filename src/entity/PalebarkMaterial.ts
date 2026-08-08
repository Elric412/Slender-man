/**
 * PALEBARK — materials.
 *
 * Two MeshPhysicalMaterials (skin, coat) sharing one uniform block, each patched
 * through `onBeforeCompile` with three things stock Three.js will not do:
 *
 *  1. SUBSURFACE — a wrap-diffuse + back-scatter term driven by the ORM alpha
 *     (thickness). It reads the real spot/directional lights, so the flashlight
 *     bleeds through the fingers and the jaw exactly when you point it at them.
 *     This is what stops the face reading as painted plastic at close range.
 *
 *  2. GRIME — orm.a on the coat atlas is a wear mask (hem, cuffs, elbows,
 *     shoulders, knees, collar). `uGrime` (0..1, driven by the tape-collection
 *     milestone) blends it into albedo + roughness live. No texture swap, no
 *     second material, no LOD desync.
 *
 *  3. LOD CROSS-FADE — an ordered-dither `discard` keyed to `uFade`, with a
 *     complementary pattern offset per level so two levels rendering at once
 *     still cover ~100 % of the silhouette. That is the anti-pop mechanism.
 *
 * Texture streaming lives here too: a cheap tier is generated at boot so the
 * entity is never untextured, then the hero tier is synthesised in idle slices
 * and swapped in.
 */

import * as THREE from 'three';
import { AtlasKind, MapSet, synthAtlas, TEXTURE_TIERS } from './PalebarkTextures';
import type { QualityTier } from '../core/Config';

export interface PalebarkUniforms {
  uFade: { value: number };
  uGrime: { value: number };
  uWetness: { value: number };
  uSSS: { value: number };
  uDither: { value: number };
  uSkinExtra: { value: THREE.Texture | null };
  uCoatExtra: { value: THREE.Texture | null };
}

const CLIP_FADE = /* glsl */`
  // ---- Palebark LOD cross-fade (ordered dither, complementary per level) ----
  {
    float bayer;
    ivec2 p = ivec2(mod(gl_FragCoord.xy, 4.0));
    int bi = p.y * 4 + p.x;
    float m[16];
    m[0]=0.0;  m[1]=8.0;  m[2]=2.0;  m[3]=10.0;
    m[4]=12.0; m[5]=4.0;  m[6]=14.0; m[7]=6.0;
    m[8]=3.0;  m[9]=11.0; m[10]=1.0; m[11]=9.0;
    m[12]=15.0;m[13]=7.0; m[14]=13.0;m[15]=5.0;
    bayer = m[bi] / 16.0;
    bayer = fract(bayer + uDither);
    if (uFade < 0.999 && bayer >= uFade) discard;
  }
`;

const SSS_FRAGMENT = /* glsl */`
  // ---- Palebark subsurface: wrap diffuse + back-scatter through thin tissue --
  {
    float thickness = texture2D(uSkinExtra, vMapUv).a;
    vec3 vpos = geometryPosition;               // fragment, view space
    vec3 V = geometryViewDir;
    vec3 N = geometryNormal;
    vec3 sss = vec3(0.0);
    #if NUM_SPOT_LIGHTS > 0
      for (int i = 0; i < NUM_SPOT_LIGHTS; i++) {
        vec3 lv = spotLights[i].position - vpos;
        float ld = length(lv);
        vec3 L = lv / max(ld, 0.0001);
        float ang = dot(L, -spotLights[i].direction);
        float spot = getSpotAttenuation(spotLights[i].coneCos, spotLights[i].penumbraCos, ang);
        if (spot > 0.0) {
          float att = spot * getDistanceAttenuation(ld, spotLights[i].distance, spotLights[i].decay);
          float wrap = max(0.0, (dot(N, L) + 0.55) / 1.55);
          float back = pow(clamp(dot(V, -L) * 0.5 + 0.5, 0.0, 1.0), 5.0);
          sss += spotLights[i].color * att * (wrap * 0.35 + back * 0.9) * thickness;
        }
      }
    #endif
    #if NUM_DIR_LIGHTS > 0
      for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
        vec3 L = directionalLights[i].direction;
        float wrap = max(0.0, (dot(N, L) + 0.6) / 1.6);
        sss += directionalLights[i].color * wrap * 0.18 * thickness;
      }
    #endif
    // deep, cold flesh tint — never warm, never glowing.
    // Added to the direct diffuse accumulator: the BRDF has already run, so
    // this is a pure additive translucency term, not a light injection.
    reflectedLight.directDiffuse += sss * diffuseColor.rgb * vec3(1.0, 0.82, 0.74) * uSSS;
  }
`;

export interface PalebarkMaterialSet {
  skin: THREE.MeshPhysicalMaterial;
  coat: THREE.MeshPhysicalMaterial;
  uniforms: PalebarkUniforms;
  /** per-LOD clones sharing textures but owning their own uFade/uDither */
  forLevel(level: number): [THREE.Material, THREE.Material];
  setFade(level: number, v: number): void;
  dispose(): void;
}

function patchSkin(mat: THREE.MeshPhysicalMaterial, u: PalebarkUniforms, own: { uFade: { value: number }; uDither: { value: number } }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFade = own.uFade;
    shader.uniforms.uDither = own.uDither;
    shader.uniforms.uSkinExtra = u.uSkinExtra;
    shader.uniforms.uSSS = u.uSSS;
    shader.uniforms.uWetness = u.uWetness;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `
        uniform float uFade;
        uniform float uDither;
        uniform float uSSS;
        uniform float uWetness;
        uniform sampler2D uSkinExtra;
        void main() {`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CLIP_FADE}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor - uWetness * 0.22, 0.05, 1.0);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>\n${SSS_FRAGMENT}`);
  };
  mat.customProgramCacheKey = () => 'palebark-skin';
}

function patchCoat(mat: THREE.MeshPhysicalMaterial, u: PalebarkUniforms, own: { uFade: { value: number }; uDither: { value: number } }): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFade = own.uFade;
    shader.uniforms.uDither = own.uDither;
    shader.uniforms.uCoatExtra = u.uCoatExtra;
    shader.uniforms.uGrime = u.uGrime;
    shader.uniforms.uWetness = u.uWetness;
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `
        uniform float uFade;
        uniform float uDither;
        uniform float uGrime;
        uniform float uWetness;
        uniform sampler2D uCoatExtra;
        float pbGrime;
        void main() {`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${CLIP_FADE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        // ---- Palebark grime / damp blend (§4) ----
        pbGrime = texture2D(uCoatExtra, vMapUv).a * uGrime;
        vec3 pbDirt = diffuseColor.rgb * vec3(1.42, 1.20, 0.92);
        diffuseColor.rgb = mix(diffuseColor.rgb, pbDirt, pbGrime * 0.75);
        diffuseColor.rgb *= 1.0 - pbGrime * 0.18 - uWetness * 0.20;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(
          roughnessFactor + pbGrime * 0.10 - uWetness * (0.34 + pbGrime * 0.14), 0.06, 1.0);`);
  };
  mat.customProgramCacheKey = () => 'palebark-coat';
}

function makeTexture(
  data: Uint8Array<ArrayBuffer>, size: number, srgb: boolean, aniso: number,
): THREE.DataTexture {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

export interface MaterialOptions {
  tier: QualityTier;
  anisotropy: number;
  seed: number;
  /** called with 0..1 while the boot tier is synthesised */
  onProgress?: (f: number, label: string) => void;
}

export class PalebarkMaterials implements PalebarkMaterialSet {
  skin!: THREE.MeshPhysicalMaterial;
  coat!: THREE.MeshPhysicalMaterial;
  uniforms: PalebarkUniforms = {
    uFade: { value: 1 },
    uGrime: { value: 0 },
    uWetness: { value: 0 },
    uSSS: { value: 1 },
    uDither: { value: 0 },
    uSkinExtra: { value: null },
    uCoatExtra: { value: null },
  };

  private levelMats: [THREE.MeshPhysicalMaterial, THREE.MeshPhysicalMaterial][] = [];
  private levelUniforms: { uFade: { value: number }; uDither: { value: number } }[] = [];
  private textures: THREE.Texture[] = [];
  private tier: QualityTier;
  private aniso: number;
  private seed: number;
  /** upgrade job state */
  private upgrade: { gen: Generator<number, MapSet>; kind: AtlasKind } | null = null;
  private upgradeQueue: AtlasKind[] = [];
  private targetSize = 512;
  currentSize = 256;
  upgrading = false;

  private constructor(opts: MaterialOptions) {
    this.tier = opts.tier;
    this.aniso = opts.anisotropy;
    this.seed = opts.seed;
  }

  static async create(opts: MaterialOptions): Promise<PalebarkMaterials> {
    const m = new PalebarkMaterials(opts);
    const tiers = TEXTURE_TIERS[opts.tier];
    m.targetSize = tiers.target;
    m.currentSize = tiers.boot;
    const skinMaps = await m.runGen(synthAtlas('skin', tiers.boot, opts.seed), f => opts.onProgress?.(f * 0.5, 'palebark skin'));
    const coatMaps = await m.runGen(synthAtlas('coat', tiers.boot, opts.seed ^ 0x5a5a), f => opts.onProgress?.(0.5 + f * 0.5, 'palebark coat'));
    m.build(skinMaps, coatMaps);
    if (tiers.target > tiers.boot) m.upgradeQueue = ['skin', 'coat'];
    return m;
  }

  private async runGen(gen: Generator<number, MapSet>, onP: (f: number) => void): Promise<MapSet> {
    // Budget-batched: consume generator steps until an 8ms slice elapses, then
    // yield one frame to the browser. (The generator now yields PER ROW, so one
    // step per rAF would take 512+ frames — this keeps boot time unchanged.)
    for (;;) {
      const t0 = performance.now();
      for (;;) {
        const r = gen.next();
        if (r.done) return r.value;
        onP(r.value);
        if (performance.now() - t0 >= 8) break;
      }
      await new Promise<void>(res => requestAnimationFrame(() => res()));
    }
  }

  private build(skinMaps: MapSet, coatMaps: MapSet): void {
    const mk = (m: MapSet) => {
      const albedo = makeTexture(m.albedo, m.size, true, this.aniso);
      const normal = makeTexture(m.normal, m.size, false, this.aniso);
      const orm = makeTexture(m.orm, m.size, false, this.aniso);
      this.textures.push(albedo, normal, orm);
      return { albedo, normal, orm };
    };
    const s = mk(skinMaps), c = mk(coatMaps);
    this.uniforms.uSkinExtra.value = s.orm;
    this.uniforms.uCoatExtra.value = c.orm;

    this.skin = new THREE.MeshPhysicalMaterial({
      map: s.albedo, normalMap: s.normal, aoMap: s.orm, roughnessMap: s.orm, metalnessMap: s.orm,
      color: 0xf0ece2, roughness: 1, metalness: 0,
      normalScale: new THREE.Vector2(0.75, 0.75),
      sheen: 0.35, sheenRoughness: 0.85, sheenColor: new THREE.Color(0xbfc4c0),
      clearcoat: 0.12, clearcoatRoughness: 0.75,
      envMapIntensity: 0.35,
      vertexColors: true,
      side: THREE.FrontSide,
      dithering: true,
    });
    this.coat = new THREE.MeshPhysicalMaterial({
      map: c.albedo, normalMap: c.normal, aoMap: c.orm, roughnessMap: c.orm, metalnessMap: c.orm,
      color: 0xffffff, roughness: 1, metalness: 0,
      normalScale: new THREE.Vector2(1.15, 1.15),
      sheen: 0.5, sheenRoughness: 0.95, sheenColor: new THREE.Color(0x2a2c30),
      envMapIntensity: 0.18,
      vertexColors: true,
      side: THREE.DoubleSide,          // the coat is a shell — never show a hole
      dithering: true,
    });

    // three per-level clones: same textures, own fade uniforms
    for (let i = 0; i < 3; i++) {
      const own = { uFade: { value: i === 0 ? 1 : 0 }, uDither: { value: i * 0.37 } };
      this.levelUniforms.push(own);
      const sk = this.skin.clone();
      const co = this.coat.clone();
      patchSkin(sk, this.uniforms, own);
      patchCoat(co, this.uniforms, own);
      sk.needsUpdate = true; co.needsUpdate = true;
      this.levelMats.push([sk, co]);
    }
  }

  forLevel(level: number): [THREE.Material, THREE.Material] {
    return this.levelMats[level] as [THREE.Material, THREE.Material];
  }

  setFade(level: number, v: number): void {
    this.levelUniforms[level].uFade.value = v;
  }

  setGrime(v: number): void { this.uniforms.uGrime.value = THREE.MathUtils.clamp(v, 0, 1); }
  setWetness(v: number): void { this.uniforms.uWetness.value = THREE.MathUtils.clamp(v, 0, 1); }
  setEnvIntensity(scale: number): void {
    for (const [a, b] of this.levelMats) {
      (a as THREE.MeshPhysicalMaterial).envMapIntensity = 0.35 * scale;
      (b as THREE.MeshPhysicalMaterial).envMapIntensity = 0.18 * scale;
    }
  }

  /**
   * Hero-texture streaming. Called every frame with a time budget in ms; it
   * chews through the generator in slices, then hot-swaps the maps. Nothing
   * blocks, and if the player never gets close the upgrade simply finishes late.
   */
  streamStep(budgetMs: number): void {
    if (this.targetSize <= this.currentSize && !this.upgrade && this.upgradeQueue.length === 0) return;
    const t0 = performance.now();
    if (!this.upgrade) {
      const kind = this.upgradeQueue.shift();
      if (!kind) { this.upgrading = false; return; }
      this.upgrading = true;
      this.upgrade = {
        kind,
        gen: synthAtlas(kind, this.targetSize, kind === 'skin' ? this.seed : this.seed ^ 0x5a5a),
      };
    }
    while (performance.now() - t0 < budgetMs) {
      const r = this.upgrade.gen.next();
      if (r.done) {
        this.applyUpgrade(r.value);
        this.upgrade = null;
        if (this.upgradeQueue.length === 0) {
          this.currentSize = this.targetSize;
          this.upgrading = false;
        }
        return;
      }
    }
  }

  private applyUpgrade(m: MapSet): void {
    const albedo = makeTexture(m.albedo, m.size, true, this.aniso);
    const normal = makeTexture(m.normal, m.size, false, this.aniso);
    const orm = makeTexture(m.orm, m.size, false, this.aniso);
    const old: (THREE.Texture | null)[] = [];
    for (const [sk, co] of this.levelMats) {
      const target = (m.kind === 'skin' ? sk : co) as THREE.MeshPhysicalMaterial;
      old.push(target.map, target.normalMap, target.aoMap);
      target.map = albedo;
      target.normalMap = normal;
      target.aoMap = orm;
      target.roughnessMap = orm;
      target.metalnessMap = orm;
      target.needsUpdate = true;
    }
    const base = m.kind === 'skin' ? this.skin : this.coat;
    base.map = albedo; base.normalMap = normal; base.aoMap = orm;
    base.roughnessMap = orm; base.metalnessMap = orm;
    if (m.kind === 'skin') this.uniforms.uSkinExtra.value = orm;
    else this.uniforms.uCoatExtra.value = orm;
    for (const t of old) {
      if (t && this.textures.includes(t)) {
        t.dispose();
        this.textures.splice(this.textures.indexOf(t), 1);
      }
    }
    this.textures.push(albedo, normal, orm);
  }

  dispose(): void {
    for (const t of this.textures) t.dispose();
    this.textures.length = 0;
    for (const [a, b] of this.levelMats) { a.dispose(); b.dispose(); }
    this.skin.dispose(); this.coat.dispose();
  }
}
