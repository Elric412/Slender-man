import * as THREE from 'three';
import { QualitySpec } from '../core/Config';
import { quantiseScale } from '../engine/TargetPool';
import {
  GLSL_HASH, GLSL_DEPTH, GLSL_COLOR, GLSL_TONEMAP, GLSL_PHASE,
  GLSL_BEAM_PROFILE, GLSL_UNPACK_DEPTH, GLSL_CATMULL_ROM, POST_VERT, buildFrag,
} from './ShaderChunks';

/**
 * ============================================================================
 * STATIC — deferred-ish forward render graph (no EffectComposer, WebGL2 only)
 * ============================================================================
 *
 *   scene (HDR RGBA16F + depth)
 *     ├─ HBAO         half-res, depth normals      → temporal + relative-depth bilateral
 *     ├─ VOLUMETRICS  half/quarter-res, quadratic step distribution, IGN jitter,
 *     │               shadow-marched beam + moon, analytic height fog, 3D noise
 *     │               → temporal resolve with neighbourhood min/max clamp
 *     ├─ TAA          closest-depth dilated reprojection, YCoCg clip-toward-mean,
 *     │               Catmull-Rom history, anti-flicker, disocclusion trust
 *     ├─ MOTION BLUR  camera-velocity from depth
 *     ├─ VEIL         quarter-res blur → DOF + exposure metering
 *     ├─ BLOOM        Karis prefilter (wetness-aware threshold) / tent up
 *     ├─ STREAK       anamorphic
 *     ├─ EXPOSURE     1×1 GPU, log2-EV adaptation, hotspot-compressed metering
 *     └─ COMPOSITE    CAS, DOF, AO, inscatter, bloom+halation, exposure, AgX,
 *                     grade, event-driven camcorder artefacts, grain, dither
 *
 * Second generation, same graph. What changed and why:
 *  - Camera cuts (teleport, respawn) are detected from camera translation and
 *    invalidate every history, so TAA/AO/vol never smear across a cut.
 *  - TAA reprojects the nearest surface in 3x3, so thin branches carry their own
 *    motion instead of the sky's. Clip toward the mean (not per-axis clamp)
 *    preserves hue; a luma anti-flicker term calms sub-pixel twigs.
 *  - Volumetric samples are packed toward the camera (t ∝ u²), where the
 *    flashlight shaft lives; far fog is smooth and needs fewer samples.
 *  - Exposure adapts in EV, so opening and closing feel symmetric to the eye,
 *    and the metering compresses hotspots so a lit trunk at 1 m doesn't close the iris.
 *  - Scanlines are no longer permanent: they are gated by static/viewfinder only.
 */

const HALTON_BASES: [number, number] = [2, 3];
function halton(i: number, base: number): number {
  let f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

/** A fullscreen shader pass. GLSL3 so we get textureLod / explicit outputs. */
class Pass {
  readonly material: THREE.ShaderMaterial;
  private static geo: THREE.BufferGeometry | null = null;
  private static cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mesh: THREE.Mesh;
  private scene = new THREE.Scene();

  constructor(frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, number | string> = {}) {
    if (!Pass.geo) Pass.geo = new THREE.PlaneGeometry(2, 2);
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: POST_VERT, fragmentShader: frag,
      uniforms, defines, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(Pass.geo, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  get u(): Record<string, THREE.IUniform> { return this.material.uniforms; }
  define(name: string, value: string | number | boolean): void {
    const defs = this.material.defines as Record<string, unknown>;
    const v = typeof value === 'boolean' ? (value ? 1 : 0) : value;
    if (defs[name] === v) return;
    defs[name] = v;
    this.material.needsUpdate = true;
  }
  render(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    r.setRenderTarget(target);
    r.render(this.scene, Pass.cam);
  }
  dispose(): void { this.material.dispose(); }
}

/** Non-blocking GPU timing via EXT_disjoint_timer_query_webgl2. */
class GpuTimer {
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  lastMs = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    try {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
      if (ext) { this.gl = gl; this.ext = ext as unknown as GpuTimer['ext']; }
    } catch { /* timing is a luxury */ }
  }
  begin(): void {
    if (!this.gl || !this.ext || this.active) return;
    const q = this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  end(): void {
    if (!this.gl || !this.ext || !this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    const gl = this.gl;
    while (this.pending.length) {
      const q = this.pending[0];
      const available = gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE) as boolean;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT) as boolean;
      if (!available) break;
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
        this.lastMs = this.lastMs * 0.8 + (ns / 1e6) * 0.2;
      }
      gl.deleteQuery(q);
      this.pending.shift();
      if (this.pending.length > 4) continue;
      break;
    }
  }
}

export interface StaticState {
  level: number;
  glimpse: number;
  desat: number;
  time: number;
  /** 0..1 camcorder viewfinder weight */
  viewfinder?: number;
  /** 0..1 surface wetness — drives bloom threshold, specular veil, grade */
  wetness?: number;
}

export interface BeamParams {
  light: THREE.SpotLight | null;
  intensity: number;
}

export interface FogParams {
  density: number;
  baseHeight: number;
  falloff: number;
  turbulence: number;
  /** Albedo of the suspended medium (per-zone character). */
  tint: THREE.Color;
}

/** Camera translation per frame (m) above which history is considered a cut. */
const CUT_DISTANCE = 3.0;

export class RenderPipeline {
  private renderer: THREE.WebGLRenderer;
  private spec: QualitySpec;
  private timer: GpuTimer;

  private w = 2; private h = 2;
  private cw = 2; private ch = 2;
  renderScale: number;
  private minScale = 0.55;
  private maxScale: number;

  // ---- targets ----
  private sceneRT!: THREE.WebGLRenderTarget;
  private depthTex!: THREE.DepthTexture;
  private aoRT: THREE.WebGLRenderTarget | null = null;
  private aoHistA: THREE.WebGLRenderTarget | null = null;
  private aoHistB: THREE.WebGLRenderTarget | null = null;
  private volRT: THREE.WebGLRenderTarget | null = null;
  private volHistA: THREE.WebGLRenderTarget | null = null;
  private volHistB: THREE.WebGLRenderTarget | null = null;
  private taaA: THREE.WebGLRenderTarget | null = null;
  private taaB: THREE.WebGLRenderTarget | null = null;
  private motionRT!: THREE.WebGLRenderTarget;
  private veilA!: THREE.WebGLRenderTarget;
  private veilB!: THREE.WebGLRenderTarget;
  private bloomDown: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private streakRT: THREE.WebGLRenderTarget | null = null;
  private expA!: THREE.WebGLRenderTarget;
  private expB!: THREE.WebGLRenderTarget;

  // ---- passes ----
  private aoPass!: Pass;
  private aoResolve!: Pass;
  private volPass!: Pass;
  private volResolve!: Pass;
  private taaPass!: Pass;
  private motionPass!: Pass;
  private downPass!: Pass;
  private blurPass!: Pass;
  private brightPass!: Pass;
  private bloomDownPass!: Pass;
  private bloomUpPass!: Pass;
  private streakPass!: Pass;
  private exposurePass!: Pass;
  private compositePass!: Pass;

  // ---- camera / temporal state ----
  private frameIndex = 0;
  private jitter = new THREE.Vector2();
  private projNoJitter = new THREE.Matrix4();
  private viewProj = new THREE.Matrix4();
  private prevViewProj = new THREE.Matrix4();
  private invViewProjJit = new THREE.Matrix4();
  private invProjJit = new THREE.Matrix4();
  private viewMatrix = new THREE.Matrix4();
  private camWorld = new THREE.Matrix4();
  private camPos = new THREE.Vector3();
  private prevCamPos = new THREE.Vector3();
  private hasPrevCam = false;
  private historyValid = false;
  private aoHistoryValid = false;
  private volHistoryValid = false;

  // ---- exposure / dynamics ----
  private exposureComp = 1.0;
  private mbStrength = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private focusDistance = 12;

  // ---- adaptive quality ----
  private frameCostEma = 16.6;
  private lastAdjust = 0;
  private effortBias = 1;

  enabled = { taa: true, ao: true, bloom: true, volumetric: true, dof: true, motionBlur: true };

  private beam: BeamParams = { light: null, intensity: 1 };
  private moon: THREE.DirectionalLight | null = null;
  private fog: FogParams = {
    density: 0.022, baseHeight: 0, falloff: 9, turbulence: 0.55, tint: new THREE.Color(1, 1, 1),
  };

  readonly gpuStats = { calls: 0, triangles: 0, gpuMs: 0, passes: 0, geometries: 0, textures: 0, programs: 0 };

  constructor(renderer: THREE.WebGLRenderer, spec: QualitySpec) {
    this.renderer = renderer;
    this.spec = spec;
    this.renderScale = spec.renderScale;
    this.maxScale = Math.min(1.0, spec.tier === 'low' ? 0.85 : 1.0);
    this.applySpecFlags(spec);
    this.timer = new GpuTimer(renderer);
    this.buildPasses();
    this.syncDefines();
  }

  private applySpecFlags(spec: QualitySpec): void {
    this.enabled.taa = spec.taa;
    this.enabled.ao = spec.aoQuality > 0;
    this.enabled.bloom = spec.bloom;
    this.enabled.volumetric = spec.volumetric > 0;
    this.enabled.dof = spec.dof;
    this.enabled.motionBlur = spec.motionBlur;
  }

  // ====================================================================== hooks

  setBeam(light: THREE.SpotLight | null, intensity = 1, origin?: THREE.Vector3, direction?: THREE.Vector3): void {
    this.beam.light = light;
    this.beam.intensity = intensity;
    if (origin && direction) {
      this.beamOrigin.copy(origin);
      this.beamDir.copy(direction);
      this.beamExplicit = true;
    } else {
      this.beamExplicit = false;
    }
  }
  private beamOrigin = new THREE.Vector3();
  private beamDir = new THREE.Vector3(0, 0, -1);
  private beamExplicit = false;

  setMoon(light: THREE.DirectionalLight | null): void { this.moon = light; }

  /** `tint` is copied, never aliased (caller mutates its colour every frame). */
  setFog(p: Partial<Omit<FogParams, 'tint'>> & { tint?: THREE.Color }): void {
    if (p.density !== undefined) this.fog.density = p.density;
    if (p.baseHeight !== undefined) this.fog.baseHeight = p.baseHeight;
    if (p.falloff !== undefined) this.fog.falloff = p.falloff;
    if (p.turbulence !== undefined) this.fog.turbulence = p.turbulence;
    if (p.tint) this.fog.tint.copy(p.tint);
  }

  setExposureGoal(goal: number): void { this.exposureComp = THREE.MathUtils.clamp(goal, 0.35, 2.6); }
  get gpuMs(): number { return this.timer.lastMs; }
  get effort(): number { return this.effortBias; }
  get exposureLevel(): number { return this.exposureComp; }

  private perceptAo = 1;
  private perceptVol = 1;
  private perceptSharp = 1;
  setPerceptibility(ao: number, volumetric: number, sharpness: number): void {
    this.perceptAo = THREE.MathUtils.clamp(ao, 0.25, 1);
    this.perceptVol = THREE.MathUtils.clamp(volumetric, 0.4, 1);
    this.perceptSharp = THREE.MathUtils.clamp(sharpness, 0.3, 1);
  }

  applyKnobs(k: {
    renderScale: number; aoQuality: 0 | 1 | 2; volumetric: 0 | 1 | 2; volSteps: number;
    taa: boolean; motionBlur: boolean; bloom: boolean; dof: boolean; streak: boolean; sharpen: number;
  }): void {
    const nextScale = quantiseScale(Math.min(k.renderScale, this.maxScale));
    const scaleChanged = Math.abs(nextScale - this.renderScale) > 1e-4;
    const targetsChanged =
      this.enabled.ao !== (k.aoQuality > 0) ||
      this.enabled.taa !== k.taa ||
      this.spec.volumetric !== k.volumetric;

    this.spec.aoQuality = k.aoQuality;
    this.spec.volumetric = k.volumetric;
    this.spec.sharpen = k.sharpen;
    this.enabled.ao = k.aoQuality > 0;
    this.enabled.volumetric = k.volumetric > 0;
    this.enabled.bloom = k.bloom;
    this.enabled.dof = k.dof;
    this.enabled.motionBlur = k.motionBlur;
    this.enabled.taa = k.taa;

    const aoDirs = k.aoQuality >= 2 ? 4 : 3;
    if (aoDirs !== this.lastAoDirs) {
      this.aoPass.define('AO_DIRS', aoDirs);
      this.aoPass.define('AO_STEPS', aoDirs);
      this.lastAoDirs = aoDirs;
    }
    const volSteps = Math.max(6, Math.round(k.volSteps / 2) * 2);
    if (volSteps !== this.lastVolSteps) {
      this.volPass.define('VOL_STEPS', volSteps);
      this.lastVolSteps = volSteps;
    }
    const volHi = k.volumetric >= 2 ? 1 : 0;
    if (volHi !== this.lastVolShadow) {
      this.volPass.define('VOL_SPOT_SHADOW', volHi);
      this.volPass.define('VOL_MOON_SHADOW', volHi);
      this.volPass.define('VOL_NOISE3D', volHi);
      this.lastVolShadow = volHi;
    }
    this.compositePass.define('USE_AO', this.enabled.ao);
    this.compositePass.define('USE_VOL', this.enabled.volumetric);
    this.compositePass.define('USE_BLOOM', this.enabled.bloom);
    this.compositePass.define('USE_DOF', this.enabled.dof);
    this.compositePass.define('USE_STREAK', k.streak);
    this.compositePass.define('USE_FXAA', !k.taa);
    this.compositePass.u.uSharpen.value = k.sharpen;

    if (scaleChanged || targetsChanged) {
      this.renderScale = nextScale;
      if (targetsChanged) this.w = this.h = 0;
      this.resize(this.cw, this.ch);
    }
  }
  private lastAoDirs = -1;
  private lastVolSteps = -1;
  private lastVolShadow = -1;

  invalidateHistory(): void {
    this.historyValid = false;
    this.aoHistoryValid = false;
    this.volHistoryValid = false;
    this.frameIndex = 0;
    this.mbStrength = 0;
  }

  // ====================================================================== passes

  private buildPasses(): void {
    const V2 = () => new THREE.Vector2();

    // ------------------------------------------------------------------ HBAO
    this.aoPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tDepth;
      uniform mat4 uInvProj;
      uniform vec2 uClip;
      uniform vec2 uTexel;
      uniform float uRadius;
      uniform float uIntensity;
      uniform float uProjScaleUV;
      uniform float uFrame;

      vec3 vp(vec2 uv){ return viewPosFromDepth(uv, texture(tDepth, uv).x, uInvProj); }

      void main(){
        float d = texture(tDepth, vUv).x;
        if (d >= 0.999999) { fragColor = vec4(1.0, 1.0, 0.0, 1.0); return; }
        vec3 p = viewPosFromDepth(vUv, d, uInvProj);
        float viewDist = -p.z;

        vec3 pr = vp(vUv + vec2(uTexel.x, 0.0));
        vec3 pl = vp(vUv - vec2(uTexel.x, 0.0));
        vec3 pu = vp(vUv + vec2(0.0, uTexel.y));
        vec3 pd = vp(vUv - vec2(0.0, uTexel.y));
        vec3 dx = abs(pr.z - p.z) < abs(pl.z - p.z) ? (pr - p) : (p - pl);
        vec3 dy = abs(pu.z - p.z) < abs(pd.z - p.z) ? (pu - p) : (p - pd);
        vec3 n = normalize(cross(dx, dy));

        // Grazing surfaces (ground seen far ahead) self-occlude through the
        // depth-normal error; raise the bias there instead of darkening the path.
        float grazing = 1.0 - abs(dot(n, normalize(-p)));
        float bias = 0.10 + grazing * 0.12;

        float radiusUV = clamp(uRadius * uProjScaleUV / max(viewDist, 0.2), uTexel.x * 2.0, 0.09);
        float rot = ignT(gl_FragCoord.xy, uFrame) * 6.28318531;
        float jit = ign(gl_FragCoord.yx + uFrame * 7.0);
        float occ = 0.0;
        for (int i = 0; i < AO_DIRS; i++){
          float a = rot + float(i) * (6.28318531 / float(AO_DIRS));
          vec2 dir = vec2(cos(a), sin(a));
          float top = 0.0;
          for (int s = 0; s < AO_STEPS; s++){
            float t = (float(s) + 0.35 + jit * 0.6) / float(AO_STEPS);
            vec3 q = vp(vUv + dir * radiusUV * t * t);
            vec3 v = q - p;
            float len = length(v) + 1e-5;
            float falloff = clamp(1.0 - len * len / (uRadius * uRadius), 0.0, 1.0);
            top = max(top, (dot(n, v) / len - bias) * falloff);
          }
          occ += top;
        }
        float ao = clamp(1.0 - occ / float(AO_DIRS) * uIntensity, 0.0, 1.0);
        ao = mix(ao, 1.0, smoothstep(28.0, 70.0, viewDist));
        fragColor = vec4(ao, viewDist / uClip.y, 0.0, 1.0);
      }`, [GLSL_HASH, GLSL_DEPTH]), {
      tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() },
      uClip: { value: V2() }, uTexel: { value: V2() },
      uRadius: { value: 0.85 }, uIntensity: { value: 1.15 },
      uProjScaleUV: { value: 0.8 }, uFrame: { value: 0 },
    }, { AO_DIRS: 3, AO_STEPS: 3 });

    // ---- AO temporal + relative-depth bilateral ----------------------------
    this.aoResolve = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tAO;
      uniform sampler2D tHistory;
      uniform sampler2D tDepth;
      uniform mat4 uInvViewProj;
      uniform mat4 uPrevViewProj;
      uniform vec2 uTexel;
      uniform float uBlend;
      uniform float uValid;

      void main(){
        vec2 c = texture(tAO, vUv).rg;
        float depth = c.g;
        float sum = 0.0, wsum = 0.0, mn = 1.0, mx = 0.0;
        for (int y = -1; y <= 1; y++){
          for (int x = -1; x <= 1; x++){
            vec2 s = texture(tAO, vUv + vec2(float(x), float(y)) * uTexel).rg;
            // relative depth: trunks 40 m away blur as much as roots at 2 m
            float w = exp(-abs(s.g - depth) / max(depth, 1e-4) * 40.0);
            sum += s.r * w; wsum += w;
            mn = min(mn, s.r); mx = max(mx, s.r);
          }
        }
        float cur = wsum > 1e-4 ? sum / wsum : c.r;
        float ao = cur;
        if (uValid > 0.5) {
          float d = texture(tDepth, vUv).x;
          vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          wp /= wp.w;
          vec4 pc = uPrevViewProj * wp;
          if (pc.w > 1e-5) {
            vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
            if (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
              vec2 hs = texture(tHistory, puv).rg;
              float rel = abs(hs.g - depth) / max(depth, 1e-4);
              float trust = uBlend * (1.0 - smoothstep(0.01, 0.06, rel));
              float h = clamp(hs.r, mn - 0.08, mx + 0.08);
              ao = mix(cur, h, trust);
            }
          }
        }
        fragColor = vec4(ao, depth, 0.0, 1.0);
      }`), {
      tAO: { value: null }, tHistory: { value: null }, tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uTexel: { value: V2() }, uBlend: { value: 0.9 }, uValid: { value: 0 },
    });

    // ---------------------------------------------------------- VOLUMETRICS
    this.volPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tDepth;
      uniform mat4 uInvProj;
      uniform mat4 uCamWorld;
      uniform vec3 uCamPos;
      uniform float uFrame;
      uniform float uTime;
      uniform float uMaxDist;
      uniform float uFogDensity;
      uniform float uFogBase;
      uniform float uFogFalloff;
      uniform vec3 uFogTint;
      uniform float uTurb;
      uniform float uExtinction;
      uniform vec3 uWind;

      uniform vec3 uSpotPos;
      uniform vec3 uSpotDir;
      uniform vec3 uSpotColor;
      uniform vec2 uSpotCos;
      uniform float uSpotOuter;
      uniform float uSpotAperture2;
      uniform float uSpotRange;
      uniform float uSpotIntensity;

      uniform vec3 uMoonDir;
      uniform vec3 uMoonColor;
      uniform float uMoonIntensity;
      uniform vec3 uAmbient;

      #if VOL_SPOT_SHADOW
      uniform sampler2D tSpotShadow;
      uniform mat4 uSpotShadowMatrix;
      uniform float uSpotShadowBias;
      uniform float uSpotShadowValid;
      #endif
      #if VOL_MOON_SHADOW
      uniform sampler2D tMoonShadow;
      uniform mat4 uMoonShadowMatrix;
      uniform float uMoonShadowBias;
      uniform float uMoonShadowValid;
      #endif

      float shadowLookup(sampler2D map, mat4 mtx, vec3 wp, float bias){
        vec4 sc = mtx * vec4(wp, 1.0);
        sc.xyz /= max(sc.w, 1e-5);
        if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z < 0.0 || sc.z > 1.0) return 1.0;
        return step(sc.z + bias, unpackRGBAToDepth(texture(map, sc.xy)));
      }

      #if VOL_NOISE3D
      float hash13(vec3 p){
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
      }
      float vnoise(vec3 p){
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = mix(hash13(i), hash13(i + vec3(1,0,0)), f.x);
        float b = mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x);
        float c = mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x);
        float e = mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x);
        return mix(mix(a, b, f.y), mix(c, e, f.y), f.z);
      }
      #endif

      float mediumDensity(vec3 wp){
        float h = max(wp.y - uFogBase, 0.0);
        float dens = uFogDensity * exp(-h / max(uFogFalloff, 0.1));
        vec3 q = wp - uWind * uTime;
        #if VOL_NOISE3D
          // one octave of world-space value noise: pockets and drifts, not stripes
          float n = vnoise(q * vec3(0.16, 0.30, 0.16)) * 2.0 - 1.0;
        #else
          float n = sin(q.x * 0.31) * sin(q.z * 0.27) + 0.5 * sin(q.y * 0.9 + uTime * 0.11);
        #endif
        return max(dens * (1.0 + uTurb * n), 0.0);
      }

      void main(){
        float d = texture(tDepth, vUv).x;
        vec3 pView = viewPosFromDepth(vUv, min(d, 0.999999), uInvProj);
        float sceneDist = length(pView);
        vec3 rd = normalize((uCamWorld * vec4(pView / max(sceneDist, 1e-4), 0.0)).xyz);
        float maxT = min(d >= 0.999999 ? uMaxDist : sceneDist, uMaxDist);

        float jitter = ignT(gl_FragCoord.xy, uFrame);
        float invN = 1.0 / float(VOL_STEPS);
        float cosMoon = dot(rd, -uMoonDir);
        float phaseMoon = henyeyGreenstein(cosMoon, 0.28) * 0.7 + henyeyGreenstein(cosMoon, -0.15) * 0.3;

        vec3 acc = vec3(0.0);
        float trans = 1.0;
        for (int i = 0; i < VOL_STEPS; i++){
          // quadratic distribution: dense near camera where the beam lives
          float u = (float(i) + jitter) * invN;
          float t = maxT * u * u;
          float dt = maxT * 2.0 * u * invN + 1e-3;
          vec3 wp = uCamPos + rd * t;
          float dens = mediumDensity(wp);
          float sigma = dens * dt;
          if (sigma < 1e-6) continue;

          vec3 inl = uAmbient;
          if (uSpotIntensity > 0.0) {
            vec3 L = uSpotPos - wp;
            float dist2 = max(dot(L, L), 0.04);
            float dist = sqrt(dist2);
            vec3 Ln = L / dist;
            float cosA = dot(-Ln, uSpotDir);
            if (cosA > uSpotCos.x) {
              float cone = beamProfileFromCos(cosA, uSpotOuter);
              float atten = cone / (dist2 + uSpotAperture2);
              atten *= max(1.0 - dist / uSpotRange, 0.0);
              #if VOL_SPOT_SHADOW
                atten *= mix(1.0, shadowLookup(tSpotShadow, uSpotShadowMatrix, wp, uSpotShadowBias), uSpotShadowValid);
              #endif
              inl += uSpotColor * (atten * henyeyGreenstein(dot(rd, -Ln), 0.62) * uSpotIntensity);
            }
          }
          if (uMoonIntensity > 0.0) {
            float lit = 1.0;
            #if VOL_MOON_SHADOW
              lit = mix(1.0, shadowLookup(tMoonShadow, uMoonShadowMatrix, wp, uMoonShadowBias), uMoonShadowValid);
            #endif
            inl += uMoonColor * (uMoonIntensity * lit * phaseMoon);
          }
          // energy-conserving integration of a homogeneous segment (Hillaire)
          float ext = max(sigma * uExtinction, 1e-6);
          float segT = exp(-ext);
          acc += inl * uFogTint * trans * (1.0 - segT) / uExtinction;
          trans *= segT;
          if (trans < 0.01) break;
        }
        fragColor = vec4(max(acc, vec3(0.0)), 1.0 - trans);
      }`, [GLSL_HASH, GLSL_DEPTH, GLSL_PHASE, GLSL_BEAM_PROFILE, GLSL_UNPACK_DEPTH]), {
      tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uFrame: { value: 0 }, uTime: { value: 0 }, uMaxDist: { value: 42 },
      uFogDensity: { value: 0.022 }, uFogBase: { value: 0 }, uFogFalloff: { value: 9 },
      uFogTint: { value: new THREE.Color(1, 1, 1) }, uTurb: { value: 0.5 },
      uExtinction: { value: 1.1 }, uWind: { value: new THREE.Vector3(0.35, 0.02, 0.22) },
      uSpotPos: { value: new THREE.Vector3() }, uSpotDir: { value: new THREE.Vector3(0, 0, -1) },
      uSpotColor: { value: new THREE.Color(1, 0.86, 0.66) }, uSpotCos: { value: new THREE.Vector2(0.92, 0.96) },
      uSpotOuter: { value: 0.455 }, uSpotAperture2: { value: 0.7225 },
      uSpotRange: { value: 55 }, uSpotIntensity: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) }, uMoonColor: { value: new THREE.Color(0.58, 0.66, 0.85) },
      uMoonIntensity: { value: 0.02 }, uAmbient: { value: new THREE.Color(0, 0, 0) },
      tSpotShadow: { value: null }, uSpotShadowMatrix: { value: new THREE.Matrix4() },
      uSpotShadowBias: { value: 0.0018 }, uSpotShadowValid: { value: 0 },
      tMoonShadow: { value: null }, uMoonShadowMatrix: { value: new THREE.Matrix4() },
      uMoonShadowBias: { value: 0.0025 }, uMoonShadowValid: { value: 0 },
    }, { VOL_STEPS: 16, VOL_SPOT_SHADOW: 1, VOL_MOON_SHADOW: 0, VOL_NOISE3D: 1 });

    // ---- volumetric temporal resolve ----------------------------------------
    this.volResolve = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tVol;
      uniform sampler2D tHistory;
      uniform sampler2D tDepth;
      uniform mat4 uInvViewProj;
      uniform mat4 uPrevViewProj;
      uniform vec2 uTexel;
      uniform float uBlend;
      uniform float uValid;

      void main(){
        vec4 c0 = texture(tVol, vUv);
        vec4 c1 = texture(tVol, vUv + vec2(uTexel.x, 0.0));
        vec4 c2 = texture(tVol, vUv - vec2(uTexel.x, 0.0));
        vec4 c3 = texture(tVol, vUv + vec2(0.0, uTexel.y));
        vec4 c4 = texture(tVol, vUv - vec2(0.0, uTexel.y));
        vec4 cur = (c0 * 2.0 + c1 + c2 + c3 + c4) / 6.0;
        vec4 lo = min(c0, min(min(c1, c2), min(c3, c4)));
        vec4 hi = max(c0, max(max(c1, c2), max(c3, c4)));
        vec4 pad = (hi - lo) * 0.35 + 0.003;
        lo -= pad; hi += pad;

        vec4 outc = cur;
        if (uValid > 0.5) {
          float d = texture(tDepth, vUv).x;
          float dd = abs(texture(tDepth, vUv + vec2(uTexel.x, 0.0)).x - d)
                   + abs(texture(tDepth, vUv + vec2(0.0, uTexel.y)).x - d);
          vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          wp /= wp.w;
          vec4 pc = uPrevViewProj * wp;
          if (pc.w > 1e-5) {
            vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
            if (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
              vec4 hist = clamp(texture(tHistory, puv), lo, hi);
              float edge = smoothstep(0.0004, 0.004, dd);
              outc = mix(cur, hist, uBlend * (1.0 - 0.45 * edge));
            }
          }
        }
        fragColor = max(outc, vec4(0.0));
      }`), {
      tVol: { value: null }, tHistory: { value: null }, tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uTexel: { value: V2() }, uBlend: { value: 0.86 }, uValid: { value: 0 },
    });

    // ------------------------------------------------------------------ TAA
    this.taaPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tCurrent;
      uniform sampler2D tHistory;
      uniform sampler2D tDepth;
      uniform mat4 uInvViewProjJit;
      uniform mat4 uPrevViewProj;
      uniform vec2 uTexSize;
      uniform vec2 uTexel;
      uniform float uBlend;
      uniform float uValid;

      vec3 clipToBox(vec3 h, vec3 mu, vec3 ext){
        vec3 v = h - mu;
        vec3 a = abs(v / max(ext, vec3(1e-5)));
        float m = max(a.x, max(a.y, a.z));
        return m > 1.0 ? mu + v / m : h;
      }

      void main(){
        vec3 cur = texture(tCurrent, vUv).rgb;
        if (uValid < 0.5) { fragColor = vec4(cur, 1.0); return; }

        vec3 m1 = vec3(0.0), m2 = vec3(0.0);
        float dMin = 1.0; vec2 dUv = vUv;
        for (int y = -1; y <= 1; y++){
          for (int x = -1; x <= 1; x++){
            vec2 o = vec2(float(x), float(y)) * uTexel;
            vec3 c = rgbToYCoCg(texture(tCurrent, vUv + o).rgb);
            m1 += c; m2 += c * c;
            float dd = texture(tDepth, vUv + o).x;
            if (dd < dMin) { dMin = dd; dUv = vUv + o; }
          }
        }
        vec3 mu = m1 / 9.0;
        vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));

        vec4 wp = uInvViewProjJit * vec4(dUv * 2.0 - 1.0, dMin * 2.0 - 1.0, 1.0);
        wp /= wp.w;
        vec4 pc = uPrevViewProj * wp;
        if (pc.w <= 1e-5) { fragColor = vec4(cur, 1.0); return; }
        vec2 puv = vUv + (pc.xy / pc.w * 0.5 + 0.5 - dUv);
        if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) {
          fragColor = vec4(cur, 1.0); return;
        }

        float speed = length((puv - vUv) * uTexSize);
        float gamma = mix(1.25, 0.9, clamp(speed * 0.08, 0.0, 1.0));

        vec3 hY = rgbToYCoCg(sampleCatmullRom(tHistory, puv, uTexSize));
        vec3 hC = clipToBox(hY, mu, sigma * gamma + vec3(1e-4));

        float outside = length((hY - hC) / max(sigma + 0.02, vec3(1e-3)));
        float trust = exp(-outside * 0.6);

        float lc = rgbToYCoCg(cur).x, lh = hC.x;
        float diff = abs(lc - lh) / max(max(lc, lh), 0.2);
        float af = 1.0 - diff * diff * 0.5;

        float blend = clamp(uBlend * exp(-speed * 0.05) * mix(0.55, 1.0, trust) * af, 0.0, 0.96);
        fragColor = vec4(max(mix(cur, yCoCgToRgb(hC), blend), vec3(0.0)), 1.0);
      }`, [GLSL_COLOR, GLSL_CATMULL_ROM]), {
      tCurrent: { value: null }, tHistory: { value: null }, tDepth: { value: null },
      uInvViewProjJit: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uTexSize: { value: V2() }, uTexel: { value: V2() },
      uBlend: { value: 0.9 }, uValid: { value: 0 },
    });

    // --------------------------------------------------------- MOTION BLUR
    this.motionPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tCurrent;
      uniform sampler2D tDepth;
      uniform mat4 uInvViewProjJit;
      uniform mat4 uPrevViewProj;
      uniform float uAmount;
      uniform float uFrame;
      void main(){
        vec3 cur = texture(tCurrent, vUv).rgb;
        float d = texture(tDepth, vUv).x;
        vec4 wp = uInvViewProjJit * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        wp /= wp.w;
        vec4 pc = uPrevViewProj * wp;
        vec2 puv = pc.xy / max(pc.w, 1e-5) * 0.5 + 0.5;
        vec2 vel = clamp((puv - vUv) * uAmount, vec2(-0.03), vec2(0.03));
        float j = ignT(gl_FragCoord.xy, uFrame) - 0.5;
        vec3 acc = cur;
        for (int i = 1; i <= MB_TAPS; i++){
          acc += texture(tCurrent, vUv + vel * ((float(i) + j) / float(MB_TAPS))).rgb;
        }
        fragColor = vec4(acc / float(MB_TAPS + 1), 1.0);
      }`, [GLSL_HASH, GLSL_DEPTH]), {
      tCurrent: { value: null }, tDepth: { value: null },
      uInvViewProjJit: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uAmount: { value: 0 }, uFrame: { value: 0 },
    }, { MB_TAPS: 5 });

    // ------------------------------------------------- VEIL CHAIN
    this.downPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tInput; uniform vec2 uTexel;
      void main(){
        vec3 s = texture(tInput, vUv + vec2( uTexel.x,  uTexel.y)).rgb
               + texture(tInput, vUv + vec2(-uTexel.x,  uTexel.y)).rgb
               + texture(tInput, vUv + vec2( uTexel.x, -uTexel.y)).rgb
               + texture(tInput, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;
        fragColor = vec4(s * 0.25, 1.0);
      }`), { tInput: { value: null }, uTexel: { value: V2() } });

    this.blurPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tInput; uniform vec2 uDir;
      void main(){
        vec3 s = texture(tInput, vUv).rgb * 0.2270270270;
        s += texture(tInput, vUv + uDir * 1.3846153846).rgb * 0.3162162162;
        s += texture(tInput, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
        s += texture(tInput, vUv + uDir * 3.2307692308).rgb * 0.0702702703;
        s += texture(tInput, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
        fragColor = vec4(s, 1.0);
      }`), { tInput: { value: null }, uDir: { value: V2() } });

    // ------------------------------------------------------------ BLOOM
    this.brightPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tInput; uniform vec2 uTexel;
      uniform float uThreshold; uniform float uKnee;
      vec3 prefilter(vec3 c){
        float l = max(max(c.r, c.g), c.b);
        float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
        soft = soft * soft / (4.0 * uKnee + 1e-4);
        float contrib = max(soft, l - uThreshold) / max(l, 1e-4);
        return c * contrib;
      }
      void main(){
        vec3 a = texture(tInput, vUv + vec2( uTexel.x,  uTexel.y)).rgb;
        vec3 b = texture(tInput, vUv + vec2(-uTexel.x,  uTexel.y)).rgb;
        vec3 c = texture(tInput, vUv + vec2( uTexel.x, -uTexel.y)).rgb;
        vec3 e = texture(tInput, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;
        float wa = 1.0 / (luminance(a) + 1.0), wb = 1.0 / (luminance(b) + 1.0);
        float wc = 1.0 / (luminance(c) + 1.0), we = 1.0 / (luminance(e) + 1.0);
        vec3 col = (a * wa + b * wb + c * wc + e * we) / max(wa + wb + wc + we, 1e-4);
        // cap: a single specular spike must not become a white disc
        col = min(col, vec3(24.0));
        fragColor = vec4(prefilter(col), 1.0);
      }`, [GLSL_TONEMAP]), {
      tInput: { value: null }, uTexel: { value: V2() },
      uThreshold: { value: 0.85 }, uKnee: { value: 0.5 },
    });

    this.bloomDownPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tInput; uniform vec2 uTexel;
      void main(){
        vec2 t = uTexel;
        vec3 a = texture(tInput, vUv + vec2(-2.0,  2.0) * t).rgb;
        vec3 b = texture(tInput, vUv + vec2( 0.0,  2.0) * t).rgb;
        vec3 c = texture(tInput, vUv + vec2( 2.0,  2.0) * t).rgb;
        vec3 d = texture(tInput, vUv + vec2(-2.0,  0.0) * t).rgb;
        vec3 e = texture(tInput, vUv).rgb;
        vec3 f = texture(tInput, vUv + vec2( 2.0,  0.0) * t).rgb;
        vec3 g = texture(tInput, vUv + vec2(-2.0, -2.0) * t).rgb;
        vec3 h = texture(tInput, vUv + vec2( 0.0, -2.0) * t).rgb;
        vec3 i = texture(tInput, vUv + vec2( 2.0, -2.0) * t).rgb;
        vec3 j = texture(tInput, vUv + vec2(-1.0,  1.0) * t).rgb;
        vec3 k = texture(tInput, vUv + vec2( 1.0,  1.0) * t).rgb;
        vec3 l = texture(tInput, vUv + vec2(-1.0, -1.0) * t).rgb;
        vec3 m = texture(tInput, vUv + vec2( 1.0, -1.0) * t).rgb;
        vec3 s = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
        fragColor = vec4(s, 1.0);
      }`), { tInput: { value: null }, uTexel: { value: V2() } });

    this.bloomUpPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tLower; uniform sampler2D tSame;
      uniform vec2 uTexel; uniform float uScatter;
      void main(){
        vec2 t = uTexel;
        vec3 s = texture(tLower, vUv).rgb * 4.0;
        s += texture(tLower, vUv + vec2(-1.0,  0.0) * t).rgb * 2.0;
        s += texture(tLower, vUv + vec2( 1.0,  0.0) * t).rgb * 2.0;
        s += texture(tLower, vUv + vec2( 0.0,  1.0) * t).rgb * 2.0;
        s += texture(tLower, vUv + vec2( 0.0, -1.0) * t).rgb * 2.0;
        s += texture(tLower, vUv + vec2(-1.0,  1.0) * t).rgb;
        s += texture(tLower, vUv + vec2( 1.0,  1.0) * t).rgb;
        s += texture(tLower, vUv + vec2(-1.0, -1.0) * t).rgb;
        s += texture(tLower, vUv + vec2( 1.0, -1.0) * t).rgb;
        s /= 16.0;
        fragColor = vec4(texture(tSame, vUv).rgb + s * uScatter, 1.0);
      }`), { tLower: { value: null }, tSame: { value: null }, uTexel: { value: V2() }, uScatter: { value: 0.85 } });

    this.streakPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tInput; uniform vec2 uTexel;
      void main(){
        vec3 s = vec3(0.0);
        float wsum = 0.0;
        for (int i = -8; i <= 8; i++){
          float w = 1.0 - abs(float(i)) / 9.0;
          w *= w;
          s += texture(tInput, vUv + vec2(uTexel.x * float(i) * 2.0, 0.0)).rgb * w;
          wsum += w;
        }
        fragColor = vec4(s / wsum, 1.0);
      }`), { tInput: { value: null }, uTexel: { value: V2() } });

    // ------------------------------------------------------------ EXPOSURE
    this.exposurePass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tSmall;
      uniform sampler2D tPrev;
      uniform float uDt;
      uniform float uComp;
      uniform float uValid;
      void main(){
        float sum = 0.0, n = 0.0;
        for (int y = 0; y < 6; y++){
          for (int x = 0; x < 6; x++){
            vec2 uv = (vec2(float(x), float(y)) + 0.5) / 6.0;
            float w = 1.0 - 0.55 * length(uv - 0.5) * 2.0;
            float l = max(luminance(texture(tSmall, uv).rgb), 2e-4);
            l = l / (1.0 + l * 0.8);   // hotspot compression
            sum += log2(l) * w;
            n += w;
          }
        }
        float avg = exp2(sum / max(n, 1e-4));
        float autoE = clamp(0.078 / max(avg, 1e-4), 0.6, 2.15);
        float target = uComp * pow(autoE, 0.65);
        float prev = texture(tPrev, vec2(0.5)).r;
        if (uValid < 0.5 || !(prev > 0.0)) prev = target;
        float evP = log2(max(prev, 1e-4)), evT = log2(max(target, 1e-4));
        float err = evT - evP;
        // dilate slowly (rod adaptation), close fast (pupil); larger error moves a bit faster
        float rate = (err > 0.0 ? 0.45 : 1.6) * (1.0 + min(abs(err), 2.0) * 0.35);
        float ev = evP + err * clamp(uDt * rate, 0.0, 1.0);
        fragColor = vec4(exp2(ev), avg, 0.0, 1.0);
      }`, [GLSL_TONEMAP]), {
      tSmall: { value: null }, tPrev: { value: null },
      uDt: { value: 0.016 }, uComp: { value: 1 }, uValid: { value: 0 },
    });

    this.buildComposite();
  }

  private buildComposite(): void {
    const V2 = () => new THREE.Vector2();
    this.compositePass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tInput;
      uniform sampler2D tBloom;
      uniform sampler2D tStreak;
      uniform sampler2D tVeil;
      uniform sampler2D tAO;
      uniform sampler2D tVol;
      uniform sampler2D tDepth;
      uniform sampler2D tExposure;

      uniform vec2 uTexel;
      uniform vec2 uClip;
      uniform float uTime;
      uniform float uFrame;
      uniform float uStatic;
      uniform float uGlimpse;
      uniform float uDesat;
      uniform float uWetness;
      uniform float uViewfinder;
      uniform float uSharpen;
      uniform float uBloomStrength;
      uniform float uStreakStrength;
      uniform float uVolStrength;
      uniform float uAoStrength;
      uniform vec2  uDofRange;
      uniform float uDofStrength;
      uniform float uVignette;
      uniform float uGrain;
      uniform float uNoise;
      uniform float uHalation;

      void main(){
        vec2 uv = vUv;
        vec2 cc = uv - 0.5;
        float s = uStatic;

        // ---- event-driven optics only (viewfinder / static) ----
        float barrel = uViewfinder * 0.05;
        uv = 0.5 + cc * (1.0 + barrel * dot(cc, cc));
        if (s > 0.985) uv.y = fract(uv.y + fract(uTime * 0.7));
        float band = smoothstep(0.92, 1.0, fract(uv.y * 3.0 - uTime * 0.35));
        uv.x += band * (uViewfinder * 0.002 + s * s * 0.02) * (hash12(vec2(floor(uv.y * 180.0), floor(uTime * 24.0))) - 0.5);
        float warp = s * s * 0.010;
        uv.x += sin(uv.y * 64.0 + uTime * 13.0) * warp;
        uv.y += sin(uv.x * 47.0 - uTime * 9.0) * warp * 0.5;
        uv = clamp(uv, vec2(0.0005), vec2(0.9995));

        float ca = s * s * 0.003 + uViewfinder * 0.0012;
        vec2 caDir = cc * ca;
        vec3 col;
        col.r = texture(tInput, uv + caDir).r;
        col.g = texture(tInput, uv).g;
        col.b = texture(tInput, uv - caDir).b;

        vec3 nN = texture(tInput, uv + vec2(0.0, uTexel.y)).rgb;
        vec3 nS = texture(tInput, uv - vec2(0.0, uTexel.y)).rgb;
        vec3 nE = texture(tInput, uv + vec2(uTexel.x, 0.0)).rgb;
        vec3 nW = texture(tInput, uv - vec2(uTexel.x, 0.0)).rgb;

        #if USE_FXAA
        {
          float lC = luminance(col), lN = luminance(nN), lS = luminance(nS);
          float lE = luminance(nE), lW = luminance(nW);
          float range = max(max(lN, lS), max(lE, max(lW, lC))) - min(min(lN, lS), min(lE, min(lW, lC)));
          float amt = clamp((range - 0.05) * 3.5, 0.0, 0.65);
          col = mix(col, (nN + nS + nE + nW + col) * 0.2, amt);
        }
        #endif

        // CAS: sharpen in perceptual (sqrt) space so near-black detail isn't amplified into noise
        {
          vec3 blur = (nN + nS + nE + nW) * 0.25;
          vec3 mn = min(min(nN, nS), min(nE, nW));
          vec3 mx = max(max(nN, nS), max(nE, nW));
          float lmx = luminance(max(mx, col)), lmn = luminance(min(mn, col));
          float amp = sqrt(clamp(min(lmn, 1.0 - min(lmx, 1.0)) / max(lmx, 1e-4), 0.0, 1.0));
          col += (col - blur) * uSharpen * amp;
          col = max(col, vec3(0.0));
        }

        float rawD = texture(tDepth, uv).x;
        float lin = linearizeDepth(rawD, uClip);
        #if USE_DOF
        {
          float coc = smoothstep(uDofRange.x, uDofRange.y, lin) * uDofStrength;
          coc = max(coc, (1.0 - smoothstep(0.10, 0.42, lin)) * 0.5 * uDofStrength);
          col = mix(col, texture(tVeil, uv).rgb, clamp(coc, 0.0, 0.85));
        }
        #endif

        #if USE_AO
          // AO only multiplies the indirect-ish floor: bright direct light (flashlight)
          // keeps its contact shadows from the shadow map instead of double-darkening
          float ao = texture(tAO, uv).r;
          float direct = smoothstep(0.08, 0.6, luminance(col));
          col *= mix(1.0, ao, uAoStrength * (1.0 - direct * 0.5));
        #endif

        #if USE_VOL
          vec4 vol = texture(tVol, uv);
          // extinction of the surface behind the medium, then in-scattering
          col = col * (1.0 - vol.a * 0.35) + vol.rgb * uVolStrength;
        #endif

        #if USE_BLOOM
        {
          vec3 bl = texture(tBloom, uv).rgb;
          float dirt = 0.85 + 0.15 * sin(uv.x * 21.0 + 1.7) * sin(uv.y * 17.0 - 0.9);
          col += bl * uBloomStrength * dirt;
          // halation: film-base red scatter hugging practical lights
          col += bl * vec3(1.0, 0.45, 0.25) * uHalation * uBloomStrength;
          #if USE_STREAK
            col += texture(tStreak, uv).rgb * uStreakStrength * vec3(0.72, 0.82, 1.0);
          #endif
        }
        #endif

        col *= texture(tExposure, vec2(0.5)).r;

        // wet night: slightly cooler low end, no global darkening
        col = mix(col, col * vec3(0.95, 0.99, 1.06), uWetness * 0.8);

        float sat = 1.0 - uDesat * (0.42 + s * 0.4);
        col = agx(col, sat, 1.0 + s * 0.06);

        float l = luminance(col);
        vec3 shadowTint = col * vec3(0.93, 0.98, 1.09);
        vec3 lightTint  = col * vec3(1.06, 1.00, 0.91);
        col = mix(shadowTint, lightTint, smoothstep(0.18, 0.8, l));

        // toe separation: near-black keeps information
        float shadowFloor = 1.0 - smoothstep(0.0, 0.085, l);
        col += vec3(0.014, 0.017, 0.024) * shadowFloor;

        // scanlines: event-driven only
        float scan = 0.96 + 0.04 * sin(uv.y * 1100.0 + uTime * 8.0);
        col *= mix(1.0, scan, (s * 0.16 + uViewfinder * 0.42) * uNoise);

        // NOTE: no backticks in this shader source (JS template literal)
        float n = hash12(uv * vec2(1920.0, 1080.0) + fract(uTime) * 371.0);
        float edge = smoothstep(0.25, 0.85, length(cc) * 1.6);
        float noiseAmt = (s * s * (0.035 + edge * 0.10) + uGlimpse * 0.16) * uNoise;
        col = mix(col, vec3(n), clamp(noiseAmt, 0.0, 0.30));

        float dropRow = step(0.9992, hash12(vec2(floor(uv.y * 240.0), floor(uTime * 12.0))));
        col = mix(col, vec3(0.62), dropRow * s * 0.22 * uNoise);
        col += vec3(0.11, 0.12, 0.16) * uGlimpse;

        // grain: mid-tone weighted, chroma-free
        float g = hash12(uv * 911.0 + fract(uTime * 7.0) * 517.0) - 0.5;
        float grainWeight = smoothstep(0.0, 0.22, l) * mix(1.0, 0.55, smoothstep(0.5, 1.0, l));
        col += g * uGrain * grainWeight * uNoise;

        float vig = 1.0 - smoothstep(0.34, 1.28 - s * 0.34, length(cc) * 1.9);
        col *= mix(uVignette, 1.0, vig);

        col += (ign(gl_FragCoord.xy + uFrame) - 0.5) * (1.0 / 255.0);
        fragColor = vec4(max(col, vec3(0.0)), 1.0);
      }`, [GLSL_HASH, GLSL_DEPTH, GLSL_TONEMAP, GLSL_COLOR]), {
      tInput: { value: null }, tBloom: { value: null }, tStreak: { value: null },
      tVeil: { value: null }, tAO: { value: null }, tVol: { value: null },
      tDepth: { value: null }, tExposure: { value: null },
      uTexel: { value: V2() }, uClip: { value: new THREE.Vector2(0.08, 900) },
      uTime: { value: 0 }, uFrame: { value: 0 }, uStatic: { value: 0 },
      uGlimpse: { value: 0 }, uDesat: { value: 0.25 }, uWetness: { value: 0 },
      uViewfinder: { value: 0 }, uSharpen: { value: 0.3 },
      uBloomStrength: { value: 0.18 }, uStreakStrength: { value: 0 },
      uVolStrength: { value: 1 }, uAoStrength: { value: 0.8 },
      uDofRange: { value: new THREE.Vector2(26, 90) }, uDofStrength: { value: 0.7 },
      uVignette: { value: 0.88 }, uGrain: { value: 0.026 }, uNoise: { value: 1 },
      uHalation: { value: 0.12 },
    }, { USE_BLOOM: 1, USE_AO: 1, USE_VOL: 1, USE_DOF: 1, USE_STREAK: 1, USE_FXAA: 0 });
  }

  // ====================================================================== targets

  private makeRT(w: number, h: number, o: { filter?: THREE.MagnificationTextureFilter; type?: THREE.TextureDataType; depthTexture?: THREE.DepthTexture } = {}): THREE.WebGLRenderTarget {
    const f = o.filter ?? THREE.LinearFilter;
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: f, magFilter: f, format: THREE.RGBAFormat,
      type: o.type ?? THREE.HalfFloatType,
      depthBuffer: !!o.depthTexture, depthTexture: o.depthTexture,
      stencilBuffer: false, generateMipmaps: false,
    });
  }

  resize(cw: number, ch: number): void {
    this.cw = Math.max(2, cw);
    this.ch = Math.max(2, ch);
    const w = Math.max(2, Math.floor(this.cw * this.renderScale));
    const h = Math.max(2, Math.floor(this.ch * this.renderScale));
    if (w === this.w && h === this.h && this.sceneRT) return;
    this.w = w; this.h = h;
    this.disposeTargets();

    this.depthTex = new THREE.DepthTexture(w, h);
    this.depthTex.format = THREE.DepthFormat;
    this.depthTex.type = THREE.UnsignedIntType;
    this.depthTex.minFilter = THREE.NearestFilter;
    this.depthTex.magFilter = THREE.NearestFilter;
    this.sceneRT = this.makeRT(w, h, { depthTexture: this.depthTex });

    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    if (this.enabled.ao) {
      this.aoRT = this.makeRT(hw, hh);
      this.aoHistA = this.makeRT(hw, hh);
      this.aoHistB = this.makeRT(hw, hh);
    }
    if (this.enabled.volumetric) {
      const div = this.spec.volumetric >= 2 ? 2 : 4;
      const vw = Math.max(2, Math.floor(w / div)), vh = Math.max(2, Math.floor(h / div));
      this.volRT = this.makeRT(vw, vh);
      this.volHistA = this.makeRT(vw, vh);
      this.volHistB = this.makeRT(vw, vh);
    }
    if (this.enabled.taa) {
      this.taaA = this.makeRT(w, h);
      this.taaB = this.makeRT(w, h);
    }
    this.motionRT = this.makeRT(w, h);
    const qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2);
    this.veilA = this.makeRT(qw, qh);
    this.veilB = this.makeRT(qw, qh);
    for (let i = 0; i < 4; i++) {
      const bw = Math.max(2, w >> (i + 1)), bh = Math.max(2, h >> (i + 1));
      this.bloomDown.push(this.makeRT(bw, bh));
      this.bloomUp.push(this.makeRT(bw, bh));
    }
    this.streakRT = this.makeRT(Math.max(2, w >> 3), Math.max(2, h >> 3));
    this.expA = this.makeRT(1, 1, { filter: THREE.NearestFilter });
    this.expB = this.makeRT(1, 1, { filter: THREE.NearestFilter });
    this.invalidateHistory();
  }

  private disposeTargets(): void {
    const d = (t: THREE.WebGLRenderTarget | null | undefined) => t?.dispose();
    d(this.sceneRT); d(this.aoRT); d(this.aoHistA); d(this.aoHistB);
    d(this.volRT); d(this.volHistA); d(this.volHistB);
    d(this.taaA); d(this.taaB); d(this.motionRT);
    d(this.veilA); d(this.veilB); d(this.streakRT); d(this.expA); d(this.expB);
    this.depthTex?.dispose();
    for (const t of this.bloomDown) t.dispose();
    for (const t of this.bloomUp) t.dispose();
    this.bloomDown.length = 0; this.bloomUp.length = 0;
    this.aoRT = this.aoHistA = this.aoHistB = null;
    this.volRT = this.volHistA = this.volHistB = null;
    this.taaA = this.taaB = null;
  }

  private syncDefines(): void {
    const s = this.spec;
    this.aoPass.define('AO_DIRS', s.aoQuality >= 2 ? 4 : 3);
    this.aoPass.define('AO_STEPS', s.aoQuality >= 2 ? 4 : 3);
    this.volPass.define('VOL_STEPS', s.volumetric >= 2 ? 16 : 10);
    this.volPass.define('VOL_SPOT_SHADOW', s.volumetric >= 2 ? 1 : 0);
    this.volPass.define('VOL_MOON_SHADOW', s.volumetric >= 2 ? 1 : 0);
    this.volPass.define('VOL_NOISE3D', s.volumetric >= 2 ? 1 : 0);
    this.compositePass.define('USE_AO', this.enabled.ao);
    this.compositePass.define('USE_VOL', this.enabled.volumetric);
    this.compositePass.define('USE_BLOOM', this.enabled.bloom);
    this.compositePass.define('USE_DOF', this.enabled.dof);
    this.compositePass.define('USE_STREAK', s.tier === 'high' || s.tier === 'ultra');
    this.compositePass.define('USE_FXAA', !s.taa);
    this.compositePass.u.uSharpen.value = s.sharpen;
    this.motionPass.define('MB_TAPS', s.tier === 'ultra' ? 7 : 5);
    // TAA accumulates longer on high tiers (more samples to reach), shorter on low
    this.taaPass.u.uBlend.value = s.tier === 'low' ? 0.86 : 0.9;
  }

  setQuality(spec: QualitySpec): void {
    this.spec = spec;
    this.applySpecFlags(spec);
    this.renderScale = Math.min(spec.renderScale, spec.tier === 'low' ? 0.85 : 1);
    this.maxScale = Math.min(1, spec.tier === 'low' ? 0.85 : 1);
    this.lastAoDirs = this.lastVolSteps = this.lastVolShadow = -1;
    this.syncDefines();
    this.w = this.h = 0;
    this.resize(this.cw, this.ch);
  }

  // ====================================================================== frame

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, st: StaticState, dt: number): void {
    const r = this.renderer;
    if (!this.sceneRT) this.resize(this.cw, this.ch);
    r.info.autoReset = false;
    r.info.reset();
    this.timer.begin();

    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    // ---- camera-cut detection: teleports must not reproject ----
    camera.getWorldPosition(this.camPos);
    if (this.hasPrevCam && this.camPos.distanceToSquared(this.prevCamPos) > CUT_DISTANCE * CUT_DISTANCE) {
      this.invalidateHistory();
    }
    this.prevCamPos.copy(this.camPos);
    this.hasPrevCam = true;

    this.frameIndex++;
    const frame = this.frameIndex % 64;

    this.projNoJitter.copy(camera.projectionMatrix);
    this.viewMatrix.copy(camera.matrixWorldInverse);
    this.camWorld.copy(camera.matrixWorld);
    this.viewProj.multiplyMatrices(this.projNoJitter, this.viewMatrix);

    let jx = 0, jy = 0;
    if (this.enabled.taa) {
      const i = (this.frameIndex % 8) + 1;
      jx = halton(i, HALTON_BASES[0]) - 0.5;
      jy = halton(i, HALTON_BASES[1]) - 0.5;
      camera.setViewOffset(this.w, this.h, jx, jy, this.w, this.h);
      camera.updateProjectionMatrix();
    }
    this.jitter.set(jx, jy);
    this.invProjJit.copy(camera.projectionMatrix).invert();
    this.invViewProjJit.multiplyMatrices(camera.projectionMatrix, this.viewMatrix).invert();
    const projScaleUV = 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const wet = st.wetness ?? 0;

    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    let passes = 1;

    // ---------------------------------------------------------------- AO
    let aoTex: THREE.Texture | null = null;
    if (this.enabled.ao && this.aoRT && this.aoHistA && this.aoHistB) {
      const u = this.aoPass.u;
      u.tDepth.value = this.depthTex;
      u.uInvProj.value.copy(this.invProjJit);
      u.uClip.value.set(camera.near, camera.far);
      u.uTexel.value.set(1 / this.w, 1 / this.h);
      u.uProjScaleUV.value = projScaleUV;
      u.uFrame.value = frame;
      u.uIntensity.value = 1.1 * this.effortBias * this.perceptAo;
      this.aoPass.render(r, this.aoRT);

      const s = this.aoResolve.u;
      s.tAO.value = this.aoRT.texture;
      s.tHistory.value = this.aoHistA.texture;
      s.tDepth.value = this.depthTex;
      s.uInvViewProj.value.copy(this.invViewProjJit);
      s.uPrevViewProj.value.copy(this.prevViewProj);
      s.uTexel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
      s.uValid.value = this.aoHistoryValid && this.historyValid ? 1 : 0;
      this.aoResolve.render(r, this.aoHistB);
      const t = this.aoHistA; this.aoHistA = this.aoHistB; this.aoHistB = t;
      this.aoHistoryValid = true;
      aoTex = this.aoHistA.texture;
      passes += 2;
    }

    // -------------------------------------------------------- VOLUMETRICS
    let volTex: THREE.Texture | null = null;
    if (this.enabled.volumetric && this.volRT && this.volHistA && this.volHistB) {
      const u = this.volPass.u;
      u.tDepth.value = this.depthTex;
      u.uInvProj.value.copy(this.invProjJit);
      u.uCamWorld.value.copy(this.camWorld);
      u.uCamPos.value.copy(this.camPos);
      u.uFrame.value = frame;
      u.uTime.value = st.time;
      // rain thickens the near medium slightly; perceptibility trims cost-free
      u.uFogDensity.value = this.fog.density * (1 + wet * 0.25);
      u.uFogBase.value = this.fog.baseHeight;
      u.uFogFalloff.value = this.fog.falloff;
      u.uFogTint.value.copy(this.fog.tint);
      u.uTurb.value = this.fog.turbulence;
      u.uMaxDist.value = 42 * (0.75 + 0.25 * this.perceptVol);

      const spot = this.beam.light;
      let spotI = 0;
      if (spot && spot.intensity > 0 && this.beam.intensity > 0) {
        if (this.beamExplicit) {
          u.uSpotPos.value.copy(this.beamOrigin);
          u.uSpotDir.value.copy(this.beamDir);
        } else {
          spot.getWorldPosition(this.tmpA);
          u.uSpotPos.value.copy(this.tmpA);
          spot.target.getWorldPosition(this.tmpB);
          u.uSpotDir.value.copy(this.tmpB).sub(this.tmpA).normalize();
        }
        u.uSpotColor.value.copy(spot.color);
        u.uSpotCos.value.set(Math.cos(Math.min(Math.PI * 0.5, spot.angle * 1.35)), Math.cos(spot.angle * (1 - spot.penumbra)));
        u.uSpotOuter.value = spot.angle;
        u.uSpotRange.value = spot.distance > 0 ? spot.distance : 60;
        spotI = spot.intensity * 0.00145 * this.beam.intensity;
        u.uSpotShadowBias.value = spot.shadow.bias;
        const map = spot.shadow.map;
        if (map && this.spec.volumetric >= 2) {
          u.tSpotShadow.value = map.texture;
          u.uSpotShadowMatrix.value.copy(spot.shadow.matrix);
          u.uSpotShadowValid.value = 1;
        } else {
          u.uSpotShadowValid.value = 0;
        }
      }
      u.uSpotIntensity.value = spotI;

      const moon = this.moon;
      if (moon && moon.intensity > 0) {
        moon.getWorldPosition(this.tmpA);
        moon.target.getWorldPosition(this.tmpB);
        u.uMoonDir.value.copy(this.tmpB).sub(this.tmpA).normalize();
        u.uMoonColor.value.copy(moon.color);
        u.uMoonIntensity.value = moon.intensity * 0.055;
        // faint multiply-scattered skylight so fog never becomes pure black
        u.uAmbient.value.copy(moon.color).multiplyScalar(moon.intensity * 0.0035);
        u.uMoonShadowBias.value = moon.shadow.bias;
        const map = moon.shadow.map;
        if (map && this.spec.volumetric >= 2) {
          u.tMoonShadow.value = map.texture;
          u.uMoonShadowMatrix.value.copy(moon.shadow.matrix);
          u.uMoonShadowValid.value = 1;
        } else {
          u.uMoonShadowValid.value = 0;
        }
      } else {
        u.uMoonIntensity.value = 0;
        u.uAmbient.value.setRGB(0, 0, 0);
      }
      this.volPass.render(r, this.volRT);

      const s = this.volResolve.u;
      s.tVol.value = this.volRT.texture;
      s.tHistory.value = this.volHistA.texture;
      s.tDepth.value = this.depthTex;
      s.uInvViewProj.value.copy(this.invViewProjJit);
      s.uPrevViewProj.value.copy(this.prevViewProj);
      s.uTexel.value.set(1 / this.volRT.width, 1 / this.volRT.height);
      s.uValid.value = this.volHistoryValid && this.historyValid ? 1 : 0;
      this.volResolve.render(r, this.volHistB);
      const t = this.volHistA; this.volHistA = this.volHistB; this.volHistB = t;
      this.volHistoryValid = true;
      volTex = this.volHistA.texture;
      passes += 2;
    }

    // ---------------------------------------------------------------- TAA
    let color: THREE.Texture = this.sceneRT.texture;
    if (this.enabled.taa && this.taaA && this.taaB) {
      const u = this.taaPass.u;
      u.tCurrent.value = this.sceneRT.texture;
      u.tHistory.value = this.taaA.texture;
      u.tDepth.value = this.depthTex;
      u.uInvViewProjJit.value.copy(this.invViewProjJit);
      u.uPrevViewProj.value.copy(this.prevViewProj);
      u.uTexSize.value.set(this.w, this.h);
      u.uTexel.value.set(1 / this.w, 1 / this.h);
      u.uValid.value = this.historyValid ? 1 : 0;
      this.taaPass.render(r, this.taaB);
      const t = this.taaA; this.taaA = this.taaB; this.taaB = t;
      color = this.taaA.texture;
      passes++;
    }

    // -------------------------------------------------------- MOTION BLUR
    if (this.enabled.motionBlur) {
      const dy = camera.rotation.y - this.lastYaw;
      const dp = camera.rotation.x - this.lastPitch;
      this.lastYaw = camera.rotation.y;
      this.lastPitch = camera.rotation.x;
      const turn = Math.abs(dy) + Math.abs(dp) * 0.6;
      const target = Math.min(1, turn * 22 + st.level * 0.18);
      this.mbStrength += (target - this.mbStrength) * Math.min(1, dt * 9);
      if (this.mbStrength > 0.04 && this.historyValid) {
        const u = this.motionPass.u;
        u.tCurrent.value = color;
        u.tDepth.value = this.depthTex;
        u.uInvViewProjJit.value.copy(this.invViewProjJit);
        u.uPrevViewProj.value.copy(this.prevViewProj);
        u.uAmount.value = 0.22 * this.mbStrength;
        u.uFrame.value = frame;
        this.motionPass.render(r, this.motionRT);
        color = this.motionRT.texture;
        passes++;
      }
    }

    // -------------------------------------------------------------- VEIL
    {
      const u = this.downPass.u;
      u.tInput.value = color;
      u.uTexel.value.set(1 / this.w, 1 / this.h);
      this.downPass.render(r, this.veilA);
      const b = this.blurPass.u;
      b.tInput.value = this.veilA.texture;
      b.uDir.value.set(1 / this.veilA.width, 0);
      this.blurPass.render(r, this.veilB);
      b.tInput.value = this.veilB.texture;
      b.uDir.value.set(0, 1 / this.veilA.height);
      this.blurPass.render(r, this.veilA);
      passes += 3;
    }

    // ------------------------------------------------------------- BLOOM
    if (this.enabled.bloom && this.bloomDown.length) {
      const u = this.brightPass.u;
      u.tInput.value = color;
      u.uTexel.value.set(1 / this.w, 1 / this.h);
      // wet specular glints may bloom a little; dry scenes keep deep blacks
      u.uThreshold.value = 0.85 - wet * 0.12;
      this.brightPass.render(r, this.bloomDown[0]);
      for (let i = 1; i < this.bloomDown.length; i++) {
        const d = this.bloomDownPass.u;
        d.tInput.value = this.bloomDown[i - 1].texture;
        d.uTexel.value.set(1 / this.bloomDown[i - 1].width, 1 / this.bloomDown[i - 1].height);
        this.bloomDownPass.render(r, this.bloomDown[i]);
      }
      const last = this.bloomDown.length - 1;
      for (let i = last - 1; i >= 0; i--) {
        const up = this.bloomUpPass.u;
        const lower = i === last - 1 ? this.bloomDown[last] : this.bloomUp[i + 1];
        up.tLower.value = lower.texture;
        up.tSame.value = this.bloomDown[i].texture;
        up.uTexel.value.set(1 / lower.width, 1 / lower.height);
        this.bloomUpPass.render(r, this.bloomUp[i]);
      }
      passes += this.bloomDown.length * 2;
      if (this.streakRT && this.bloomDown.length > 2) {
        const s = this.streakPass.u;
        s.tInput.value = this.bloomDown[2].texture;
        s.uTexel.value.set(1 / this.bloomDown[2].width, 0);
        this.streakPass.render(r, this.streakRT);
        passes++;
      }
    }

    // ----------------------------------------------------------- EXPOSURE
    {
      const u = this.exposurePass.u;
      u.tSmall.value = this.veilA.texture;
      u.tPrev.value = this.expA.texture;
      u.uDt.value = Math.min(dt, 0.1);
      u.uComp.value = this.exposureComp;
      u.uValid.value = this.historyValid ? 1 : 0;
      this.exposurePass.render(r, this.expB);
      const t = this.expA; this.expA = this.expB; this.expB = t;
      passes++;
    }

    // ---------------------------------------------------------- COMPOSITE
    {
      const u = this.compositePass.u;
      u.tInput.value = color;
      u.tBloom.value = this.enabled.bloom && this.bloomUp.length ? this.bloomUp[0].texture : null;
      u.tStreak.value = this.streakRT ? this.streakRT.texture : null;
      u.tVeil.value = this.veilA.texture;
      u.tAO.value = aoTex;
      u.tVol.value = volTex;
      u.tDepth.value = this.depthTex;
      u.tExposure.value = this.expA.texture;
      u.uTexel.value.set(1 / this.w, 1 / this.h);
      u.uClip.value.set(camera.near, camera.far);
      u.uTime.value = st.time;
      u.uFrame.value = frame;
      u.uStatic.value = st.level;
      u.uGlimpse.value = st.glimpse;
      u.uDesat.value = st.desat;
      u.uWetness.value = wet;
      u.uViewfinder.value = st.viewfinder ?? 0;
      u.uSharpen.value = this.spec.sharpen * (1 + (1 - this.perceptSharp) * 0.45);
      this.compositePass.render(r, null);
      passes++;
    }

    this.prevViewProj.copy(this.viewProj);
    this.historyValid = true;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    this.timer.end();

    this.gpuStats.calls = r.info.render.calls;
    this.gpuStats.triangles = r.info.render.triangles;
    this.gpuStats.gpuMs = this.timer.lastMs;
    this.gpuStats.passes = passes;
    this.gpuStats.geometries = r.info.memory.geometries;
    this.gpuStats.textures = r.info.memory.textures;
    this.gpuStats.programs = r.info.programs ? r.info.programs.length : 0;
  }

  observeFrameCost(ms: number): void { this.frameCostEma = this.frameCostEma * 0.94 + ms * 0.06; }
  get frameCostMs(): number { return this.frameCostEma; }

  setGrade(g: {
    bloom?: number; streak?: number; volumetric?: number; ao?: number; grain?: number;
    noise?: number; vignette?: number; dof?: number; dofRange?: [number, number]; halation?: number;
  }): void {
    const u = this.compositePass.u;
    if (g.bloom !== undefined) u.uBloomStrength.value = g.bloom;
    if (g.streak !== undefined) u.uStreakStrength.value = g.streak;
    if (g.volumetric !== undefined) u.uVolStrength.value = g.volumetric;
    if (g.ao !== undefined) u.uAoStrength.value = g.ao;
    if (g.grain !== undefined) u.uGrain.value = g.grain;
    if (g.noise !== undefined) u.uNoise.value = g.noise;
    if (g.vignette !== undefined) u.uVignette.value = g.vignette;
    if (g.dof !== undefined) u.uDofStrength.value = g.dof;
    if (g.dofRange) u.uDofRange.value.set(g.dofRange[0], g.dofRange[1]);
    if (g.halation !== undefined) u.uHalation.value = g.halation;
  }

  dispose(): void {
    this.disposeTargets();
    this.aoPass.dispose(); this.aoResolve.dispose();
    this.volPass.dispose(); this.volResolve.dispose();
    this.taaPass.dispose(); this.motionPass.dispose();
    this.downPass.dispose(); this.blurPass.dispose();
    this.brightPass.dispose(); this.bloomDownPass.dispose(); this.bloomUpPass.dispose();
    this.streakPass.dispose(); this.exposurePass.dispose(); this.compositePass.dispose();
  }
}
