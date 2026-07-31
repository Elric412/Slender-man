import * as THREE from 'three';
import { QualitySpec } from '../core/Config';
import {
  GLSL_HASH, GLSL_DEPTH, GLSL_COLOR, GLSL_TONEMAP, GLSL_PHASE,
  GLSL_UNPACK_DEPTH, GLSL_CATMULL_ROM, POST_VERT, buildFrag,
} from './ShaderChunks';

/**
 * ============================================================================
 * STATIC — deferred-ish forward render graph (no EffectComposer, WebGL2 only)
 * ============================================================================
 *
 * Frame graph (arrows = texture dependencies):
 *
 *   scene (HDR RGBA16F + depth)
 *     ├─ HBAO            half-res, depth-only normals ──┐ temporal + bilateral
 *     ├─ VOLUMETRICS     half/quarter-res raymarch,     │ shadow-mapped beam
 *     │                  HG phase, height fog          │ temporal reprojection
 *     ├─ TAA             depth-reprojected history,      │ YCoCg variance clip,
 *     │                  Catmull-Rom resample           │ Halton(2,3) jitter
 *     ├─ MOTION BLUR     per-pixel velocity from depth   │
 *     ├─ VEIL CHAIN      quarter-res blur → DOF + glare  │
 *     ├─ BLOOM           4-mip Karis down / tent up      │
 *     ├─ STREAK          anamorphic horizontal smear     │
 *     ├─ EXPOSURE        1×1 GPU eye-adaptation (no readback)
 *     └─ COMPOSITE       CAS sharpen, DOF, bloom, AO, inscatter, AgX,
 *                        camcorder grade, grain, dither → backbuffer
 *
 * Design rules that keep this affordable in a browser:
 *  1. **No normal prepass.** View normals are reconstructed from depth, so AO
 *     costs one half-res pass instead of a second full scene draw.
 *  2. **Everything expensive is temporal.** AO and volumetrics march few samples
 *     with per-pixel/per-frame interleaved-gradient dithering and accumulate
 *     across frames with depth-rejected reprojection.
 *  3. **One composite.** Grading, tonemap, sharpening, DOF, vignette, static and
 *     dither all happen in a single full-res pass — bandwidth is the enemy.
 *  4. **Every stage is switchable per quality tier** and can be degraded at
 *     runtime by the dynamic-resolution controller.
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

  constructor(frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, string | number> = {}) {
    if (!Pass.geo) Pass.geo = new THREE.PlaneGeometry(2, 2);
    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: POST_VERT,
      fragmentShader: frag,
      uniforms, defines,
      depthTest: false, depthWrite: false,
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

/**
 * Optional real GPU timing via EXT_disjoint_timer_query_webgl2. CPU frame time
 * lies on GPU-bound scenes; this tells us which half of the pipeline to blame.
 */
class GpuTimer {
  private ext: {
    TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number;
    beginQueryEXT?: unknown;
  } | null = null;
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
    // drain: only ever read fully-resolved queries so we never stall
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
  level: number;        // 0..1 fear/static amount
  glimpse: number;      // 0..1 single-frame glimpse flash
  desat: number;
  time: number;
  /** 0..1 camcorder viewfinder weight (extra CA + scanlines + tape wobble) */
  viewfinder?: number;
  /** 0..1 surface wetness — drives specular veil + puddle glint in the grade */
  wetness?: number;
}

/** Everything the volumetric pass needs to know about the hero light. */
export interface BeamParams {
  light: THREE.SpotLight | null;
  /** extra multiplier applied to in-scattering (flicker / battery sag) */
  intensity: number;
}

export interface FogParams {
  /** in-scattering coefficient at ground level */
  density: number;
  /** height (world Y) where density starts falling off */
  baseHeight: number;
  /** e-folding distance of the height falloff, metres */
  falloff: number;
  /** 0..1 how much the fog is stirred by animated noise */
  turbulence: number;
}

export class RenderPipeline {
  private renderer: THREE.WebGLRenderer;
  private spec: QualitySpec;
  private timer: GpuTimer;

  private w = 2; private h = 2;      // render (scaled) size
  private cw = 2; private ch = 2;    // canvas (output) size
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
  /** 1 = full feature set, drops toward 0.5 when we can't hold frame time */
  private effortBias = 1;

  enabled = { taa: true, ao: true, bloom: true, volumetric: true, dof: true, motionBlur: true };

  private beam: BeamParams = { light: null, intensity: 1 };
  private moon: THREE.DirectionalLight | null = null;
  private fog: FogParams = { density: 0.022, baseHeight: 0, falloff: 9, turbulence: 0.55 };

  readonly gpuStats = { calls: 0, triangles: 0, gpuMs: 0, passes: 0 };

  constructor(renderer: THREE.WebGLRenderer, spec: QualitySpec) {
    this.renderer = renderer;
    this.spec = spec;
    this.renderScale = spec.renderScale;
    this.maxScale = Math.min(1.0, spec.tier === 'low' ? 0.85 : 1.0);
    this.applySpecFlags(spec);
    this.timer = new GpuTimer(renderer);
    this.buildPasses();
  }

  private applySpecFlags(spec: QualitySpec): void {
    this.enabled.taa = spec.taa;
    this.enabled.ao = spec.aoQuality > 0;
    this.enabled.bloom = spec.bloom;
    this.enabled.volumetric = spec.volumetric > 0;
    this.enabled.dof = spec.dof;
    this.enabled.motionBlur = spec.motionBlur;
  }

  // ======================================================================
  // configuration hooks used by the game layer
  // ======================================================================

  /** Hand the pipeline the flashlight so volumetrics can shadow-march it. */
  setBeam(light: THREE.SpotLight | null, intensity = 1): void {
    this.beam.light = light;
    this.beam.intensity = intensity;
  }

  setMoon(light: THREE.DirectionalLight | null): void { this.moon = light; }

  setFog(p: Partial<FogParams>): void { Object.assign(this.fog, p); }

  /** Exposure compensation goal (stops-ish multiplier around the auto value). */
  setExposureGoal(goal: number): void {
    this.exposureComp = THREE.MathUtils.clamp(goal, 0.35, 2.6);
  }

  get gpuMs(): number { return this.timer.lastMs; }
  get effort(): number { return this.effortBias; }

  invalidateHistory(): void {
    this.historyValid = false;
    this.aoHistoryValid = false;
    this.volHistoryValid = false;
    this.frameIndex = 0;
    this.mbStrength = 0;
  }

  // ======================================================================
  // pass construction
  // ======================================================================
  private buildPasses(): void {
    const V2 = () => new THREE.Vector2();

    // ------------------------------------------------------------------ HBAO
    // Horizon-based AO from depth alone. Normals are rebuilt with the
    // "closest neighbour" trick (Drobot) so silhouettes don't smear, and the
    // sampling ring is rotated per pixel/frame by interleaved gradient noise —
    // the temporal resolve turns 9 taps into a ~100-tap-looking result.
    this.aoPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tDepth;
      uniform mat4 uInvProj;
      uniform vec2 uClip;
      uniform vec2 uTexel;        // full-res texel size
      uniform float uRadius;      // world-space radius (m)
      uniform float uIntensity;
      uniform float uProjScaleUV; // 0.5 / tan(fovY/2)
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

        float radiusUV = clamp(uRadius * uProjScaleUV / max(viewDist, 0.2), uTexel.x * 2.0, 0.09);
        float rot = ignT(gl_FragCoord.xy, uFrame) * 6.28318531;
        float occ = 0.0;

        for (int i = 0; i < AO_DIRS; i++){
          float a = rot + float(i) * (6.28318531 / float(AO_DIRS));
          vec2 dir = vec2(cos(a), sin(a));
          float top = 0.0;
          for (int s = 0; s < AO_STEPS; s++){
            float t = (float(s) + 0.7) / float(AO_STEPS);
            vec3 q = vp(vUv + dir * radiusUV * t);
            vec3 v = q - p;
            float len = length(v) + 1e-5;
            float falloff = clamp(1.0 - len / uRadius, 0.0, 1.0);
            top = max(top, (dot(n, v) / len - 0.10) * falloff);
          }
          occ += top;
        }
        float ao = clamp(1.0 - occ / float(AO_DIRS) * uIntensity, 0.0, 1.0);
        // AO is a contact cue: let it die off with distance so the forest
        // interior doesn't turn into a grey wash under fog.
        ao = mix(ao, 1.0, smoothstep(28.0, 70.0, viewDist));
        fragColor = vec4(ao, viewDist / uClip.y, 0.0, 1.0);
      }`, [GLSL_HASH, GLSL_DEPTH]), {
      tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() },
      uClip: { value: V2() }, uTexel: { value: V2() },
      uRadius: { value: 0.85 }, uIntensity: { value: 1.15 },
      uProjScaleUV: { value: 0.8 }, uFrame: { value: 0 },
    }, { AO_DIRS: 3, AO_STEPS: 3 });

    // ---- AO temporal + bilateral resolve --------------------------------
    this.aoResolve = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tAO;
      uniform sampler2D tHistory;
      uniform sampler2D tDepth;
      uniform mat4 uInvViewProj;
      uniform mat4 uPrevViewProj;
      uniform vec2 uTexel;      // half-res texel
      uniform float uBlend;
      uniform float uValid;

      void main(){
        vec2 c = texture(tAO, vUv).rg;
        float depth = c.g;
        // 3x3 depth-weighted blur — cheap, keeps creases sharp
        float sum = 0.0, wsum = 0.0;
        for (int y = -1; y <= 1; y++){
          for (int x = -1; x <= 1; x++){
            vec2 o = vec2(float(x), float(y)) * uTexel;
            vec2 s = texture(tAO, vUv + o).rg;
            float w = exp(-abs(s.g - depth) * 220.0);
            sum += s.r * w; wsum += w;
          }
        }
        float cur = wsum > 0.0 ? sum / wsum : c.r;

        float ao = cur;
        if (uValid > 0.5) {
          float d = texture(tDepth, vUv).x;
          vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          wp /= wp.w;
          vec4 pc = uPrevViewProj * wp;
          vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
          if (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
            vec2 hs = texture(tHistory, puv).rg;
            float rel = abs(hs.g - depth) / max(depth, 1e-4);
            float trust = uBlend * (1.0 - smoothstep(0.01, 0.06, rel));
            ao = mix(cur, hs.r, trust);
          }
        }
        fragColor = vec4(ao, depth, 0.0, 1.0);
      }`), {
      tAO: { value: null }, tHistory: { value: null }, tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uTexel: { value: V2() }, uBlend: { value: 0.9 }, uValid: { value: 0 },
    });

    // ---------------------------------------------------------- VOLUMETRICS
    // Ray-marched single-scattering. The flashlight is marched against its own
    // shadow map, so trees carve real shafts out of the beam; the moon term
    // does the same for canopy god-rays. Height fog + animated wisps give the
    // medium structure so the beam isn't a clean geometric cone.
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
      uniform float uTurb;
      uniform float uExtinction;

      uniform vec3 uSpotPos;
      uniform vec3 uSpotDir;
      uniform vec3 uSpotColor;
      uniform vec2 uSpotCos;      // (coneCos, penumbraCos)
      uniform float uSpotRange;
      uniform float uSpotIntensity;

      uniform vec3 uMoonDir;      // direction light travels
      uniform vec3 uMoonColor;
      uniform float uMoonIntensity;

      #if VOL_SPOT_SHADOW
        uniform sampler2D tSpotShadow;
        uniform mat4 uSpotShadowMatrix;
        uniform float uSpotShadowBias;
      #endif
      #if VOL_MOON_SHADOW
        uniform sampler2D tMoonShadow;
        uniform mat4 uMoonShadowMatrix;
        uniform float uMoonShadowBias;
      #endif

      float shadowLookup(sampler2D map, mat4 mtx, vec3 wp, float bias){
        vec4 sc = mtx * vec4(wp, 1.0);
        sc.xyz /= max(sc.w, 1e-5);
        if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
        float sd = unpackRGBAToDepth(texture(map, sc.xy));
        return step(sc.z - bias, sd);
      }

      void main(){
        float d = texture(tDepth, vUv).x;
        vec3 pView = viewPosFromDepth(vUv, min(d, 0.999999), uInvProj);
        float sceneDist = length(pView);
        vec3 rd = normalize((uCamWorld * vec4(normalize(pView), 0.0)).xyz);
        float maxT = min(d >= 0.999999 ? uMaxDist : sceneDist, uMaxDist);

        float jitter = ignT(gl_FragCoord.xy, uFrame);
        float stepLen = maxT / float(VOL_STEPS);
        vec3 acc = vec3(0.0);
        float trans = 1.0;

        for (int i = 0; i < VOL_STEPS; i++){
          float t = (float(i) + jitter) * stepLen;
          vec3 wp = uCamPos + rd * t;

          float dens = uFogDensity * exp(-max(wp.y - uFogBase, 0.0) / uFogFalloff);
          dens *= 1.0 + uTurb * (
              sin(wp.x * 0.31 + uTime * 0.21) * sin(wp.z * 0.27 - uTime * 0.17)
            + 0.5 * sin(wp.y * 0.9 + uTime * 0.11));
          dens = max(dens, 0.0);
          float sigma = dens * stepLen;
          if (sigma < 1e-6) continue;

          vec3 inl = vec3(0.0);

          // ---- hero light ----
          if (uSpotIntensity > 0.0) {
            vec3 L = uSpotPos - wp;
            float dist2 = max(dot(L, L), 0.04);
            float dist = sqrt(dist2);
            vec3 Ln = L / dist;
            float cosA = dot(-Ln, uSpotDir);
            if (cosA > uSpotCos.x) {
              float atten = smoothstep(uSpotCos.x, uSpotCos.y, cosA) / dist2;
              atten *= max(1.0 - dist / uSpotRange, 0.0);
              #if VOL_SPOT_SHADOW
                atten *= shadowLookup(tSpotShadow, uSpotShadowMatrix, wp, uSpotShadowBias);
              #endif
              inl += uSpotColor * (atten * henyeyGreenstein(dot(rd, -Ln), 0.62) * uSpotIntensity);
            }
          }

          // ---- moonlight shafts ----
          if (uMoonIntensity > 0.0) {
            float lit = 1.0;
            #if VOL_MOON_SHADOW
              lit = shadowLookup(tMoonShadow, uMoonShadowMatrix, wp, uMoonShadowBias);
            #endif
            inl += uMoonColor * (uMoonIntensity * lit * henyeyGreenstein(dot(rd, -uMoonDir), 0.28));
          }

          acc += inl * sigma * trans;
          trans *= exp(-sigma * uExtinction);
        }
        fragColor = vec4(acc, 1.0 - trans);
      }`, [GLSL_HASH, GLSL_DEPTH, GLSL_PHASE, GLSL_UNPACK_DEPTH]), {
      tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uFrame: { value: 0 }, uTime: { value: 0 }, uMaxDist: { value: 42 },
      uFogDensity: { value: 0.022 }, uFogBase: { value: 0 }, uFogFalloff: { value: 9 },
      uTurb: { value: 0.5 }, uExtinction: { value: 1.1 },
      uSpotPos: { value: new THREE.Vector3() }, uSpotDir: { value: new THREE.Vector3(0, 0, -1) },
      uSpotColor: { value: new THREE.Color(1, 0.86, 0.66) },
      uSpotCos: { value: new THREE.Vector2(0.92, 0.96) },
      uSpotRange: { value: 55 }, uSpotIntensity: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonColor: { value: new THREE.Color(0.58, 0.66, 0.85) },
      uMoonIntensity: { value: 0.02 },
      tSpotShadow: { value: null }, uSpotShadowMatrix: { value: new THREE.Matrix4() },
      uSpotShadowBias: { value: 0.0018 },
      tMoonShadow: { value: null }, uMoonShadowMatrix: { value: new THREE.Matrix4() },
      uMoonShadowBias: { value: 0.0025 },
    }, { VOL_STEPS: 16, VOL_SPOT_SHADOW: 1, VOL_MOON_SHADOW: 0 });

    // ---- volumetric temporal resolve ------------------------------------
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
        vec4 cur = texture(tVol, vUv);
        // small cross blur first: the dither pattern lives at 1px, this eats it
        cur = (cur * 2.0
             + texture(tVol, vUv + vec2(uTexel.x, 0.0))
             + texture(tVol, vUv - vec2(uTexel.x, 0.0))
             + texture(tVol, vUv + vec2(0.0, uTexel.y))
             + texture(tVol, vUv - vec2(0.0, uTexel.y))) / 6.0;

        vec4 outc = cur;
        if (uValid > 0.5) {
          float d = texture(tDepth, vUv).x;
          vec4 wp = uInvViewProj * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          wp /= wp.w;
          vec4 pc = uPrevViewProj * wp;
          vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
          if (all(greaterThan(puv, vec2(0.0))) && all(lessThan(puv, vec2(1.0)))) {
            vec4 hist = texture(tHistory, puv);
            // clamp history to a generous local range: stops beam ghosting
            // when the light whips around, keeps the smoothing everywhere else
            vec4 lo = min(cur * 0.4, cur - 0.02);
            vec4 hi = max(cur * 2.6, cur + 0.02);
            hist = clamp(hist, lo, hi);
            outc = mix(cur, hist, uBlend);
          }
        }
        fragColor = outc;
      }`), {
      tVol: { value: null }, tHistory: { value: null }, tDepth: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uTexel: { value: V2() }, uBlend: { value: 0.82 }, uValid: { value: 0 },
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

      void main(){
        vec3 cur = texture(tCurrent, vUv).rgb;
        if (uValid < 0.5) { fragColor = vec4(cur, 1.0); return; }

        // ---- neighbourhood statistics in YCoCg (variance clipping) ----
        vec3 m1 = vec3(0.0), m2 = vec3(0.0);
        for (int y = -1; y <= 1; y++){
          for (int x = -1; x <= 1; x++){
            vec3 c = rgbToYCoCg(texture(tCurrent, vUv + vec2(float(x), float(y)) * uTexel).rgb);
            m1 += c; m2 += c * c;
          }
        }
        vec3 mu = m1 / 9.0;
        vec3 sigma = sqrt(max(m2 / 9.0 - mu * mu, vec3(0.0)));
        vec3 lo = mu - 1.35 * sigma;
        vec3 hi = mu + 1.35 * sigma;

        // ---- reproject through the depth buffer ----
        float d = texture(tDepth, vUv).x;
        vec4 wp = uInvViewProjJit * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        wp /= wp.w;
        vec4 pc = uPrevViewProj * wp;
        vec2 puv = pc.xy / max(pc.w, 1e-5) * 0.5 + 0.5;
        if (any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) {
          fragColor = vec4(cur, 1.0); return;
        }

        vec3 hist = sampleCatmullRom(tHistory, puv, uTexSize);
        hist = yCoCgToRgb(clamp(rgbToYCoCg(hist), lo, hi));

        // fast screen-space motion → trust the new frame more (less smearing)
        float vel = length((puv - vUv) * uTexSize);
        float blend = uBlend * exp(-vel * 0.06);
        fragColor = vec4(mix(cur, hist, blend), 1.0);
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
      void main(){
        vec3 cur = texture(tCurrent, vUv).rgb;
        float d = texture(tDepth, vUv).x;
        vec4 wp = uInvViewProjJit * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
        wp /= wp.w;
        vec4 pc = uPrevViewProj * wp;
        vec2 puv = pc.xy / max(pc.w, 1e-5) * 0.5 + 0.5;
        vec2 vel = clamp((puv - vUv) * uAmount, vec2(-0.03), vec2(0.03));
        vec3 acc = cur;
        for (int i = 1; i <= MB_TAPS; i++){
          acc += texture(tCurrent, vUv + vel * (float(i) / float(MB_TAPS))).rgb;
        }
        fragColor = vec4(acc / float(MB_TAPS + 1), 1.0);
      }`, [GLSL_DEPTH]), {
      tCurrent: { value: null }, tDepth: { value: null },
      uInvViewProjJit: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
      uAmount: { value: 0 },
    }, { MB_TAPS: 5 });

    // ------------------------------------------------- VEIL CHAIN (DOF/glare)
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

    // ---------------------------------------------------------------- BLOOM
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
        // 4-tap Karis average — stops single fireflies from popping
        vec3 a = texture(tInput, vUv + vec2( uTexel.x,  uTexel.y)).rgb;
        vec3 b = texture(tInput, vUv + vec2(-uTexel.x,  uTexel.y)).rgb;
        vec3 c = texture(tInput, vUv + vec2( uTexel.x, -uTexel.y)).rgb;
        vec3 e = texture(tInput, vUv + vec2(-uTexel.x, -uTexel.y)).rgb;
        float wa = 1.0 / (luminance(a) + 1.0), wb = 1.0 / (luminance(b) + 1.0);
        float wc = 1.0 / (luminance(c) + 1.0), we = 1.0 / (luminance(e) + 1.0);
        vec3 col = (a * wa + b * wb + c * wc + e * we) / max(wa + wb + wc + we, 1e-4);
        fragColor = vec4(prefilter(col), 1.0);
      }`, [GLSL_COLOR]), {
      tInput: { value: null }, uTexel: { value: V2() },
      uThreshold: { value: 0.85 }, uKnee: { value: 0.5 },
    });

    // COD-style 13-tap downsample
    this.bloomDownPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tInput; uniform vec2 uTexel;
      void main(){
        vec2 t = uTexel;
        vec3 a = texture(tInput, vUv + vec2(-2.0, 2.0) * t).rgb;
        vec3 b = texture(tInput, vUv + vec2( 0.0, 2.0) * t).rgb;
        vec3 c = texture(tInput, vUv + vec2( 2.0, 2.0) * t).rgb;
        vec3 d = texture(tInput, vUv + vec2(-2.0, 0.0) * t).rgb;
        vec3 e = texture(tInput, vUv).rgb;
        vec3 f = texture(tInput, vUv + vec2( 2.0, 0.0) * t).rgb;
        vec3 g = texture(tInput, vUv + vec2(-2.0,-2.0) * t).rgb;
        vec3 h = texture(tInput, vUv + vec2( 0.0,-2.0) * t).rgb;
        vec3 i = texture(tInput, vUv + vec2( 2.0,-2.0) * t).rgb;
        vec3 j = texture(tInput, vUv + vec2(-1.0, 1.0) * t).rgb;
        vec3 k = texture(tInput, vUv + vec2( 1.0, 1.0) * t).rgb;
        vec3 l = texture(tInput, vUv + vec2(-1.0,-1.0) * t).rgb;
        vec3 m = texture(tInput, vUv + vec2( 1.0,-1.0) * t).rgb;
        vec3 col = e * 0.125;
        col += (a + c + g + i) * 0.03125;
        col += (b + d + f + h) * 0.0625;
        col += (j + k + l + m) * 0.125;
        fragColor = vec4(col, 1.0);
      }`), { tInput: { value: null }, uTexel: { value: V2() } });

    // 9-tap tent upsample + additive accumulation of the finer mip
    this.bloomUpPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tLower;   // coarser mip (already accumulated)
      uniform sampler2D tSame;    // this mip from the down chain
      uniform vec2 uTexel;        // texel of tLower
      uniform float uScatter;
      void main(){
        vec2 t = uTexel;
        vec3 s = texture(tLower, vUv + vec2(-1.0,  1.0) * t).rgb * 1.0;
        s += texture(tLower, vUv + vec2( 0.0,  1.0) * t).rgb * 2.0;
        s += texture(tLower, vUv + vec2( 1.0,  1.0) * t).rgb * 1.0;
        s += texture(tLower, vUv + vec2(-1.0,  0.0) * t).rgb * 2.0;
        s += texture(tLower, vUv).rgb * 4.0;
        s += texture(tLower, vUv + vec2( 1.0,  0.0) * t).rgb * 2.0;
        s += texture(tLower, vUv + vec2(-1.0, -1.0) * t).rgb * 1.0;
        s += texture(tLower, vUv + vec2( 0.0, -1.0) * t).rgb * 2.0;
        s += texture(tLower, vUv + vec2( 1.0, -1.0) * t).rgb * 1.0;
        s /= 16.0;
        fragColor = vec4(texture(tSame, vUv).rgb + s * uScatter, 1.0);
      }`), {
      tLower: { value: null }, tSame: { value: null },
      uTexel: { value: V2() }, uScatter: { value: 0.85 },
    });

    // -------------------------------------------------- ANAMORPHIC STREAK
    this.streakPass = new Pass(buildFrag(/* glsl */`
      uniform sampler2D tInput; uniform vec2 uTexel;
      void main(){
        vec3 s = vec3(0.0);
        float wsum = 0.0;
        for (int i = -8; i <= 8; i++){
          float w = 1.0 - abs(float(i)) / 9.0;
          s += texture(tInput, vUv + vec2(uTexel.x * float(i) * 2.0, 0.0)).rgb * w;
          wsum += w;
        }
        fragColor = vec4(s / wsum, 1.0);
      }`), { tInput: { value: null }, uTexel: { value: V2() } });

    // -------------------------------------------------------- AUTO EXPOSURE
    // 1x1 target, 36 weighted taps of the quarter-res veil buffer, EMA'd
    // against its own previous value. No readPixels, no CPU sync, no stalls.
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
            sum += log(max(luminance(texture(tSmall, uv).rgb), 2e-4)) * w;
            n += w;
          }
        }
        float avg = exp(sum / max(n, 1e-4));
        // deliberately narrow: STATIC must stay dark. This is eye adaptation,
        // not an exposure meter trying to make the forest legible.
        float autoE = clamp(0.055 / max(avg, 1e-4), 0.6, 1.55);
        float target = uComp * pow(autoE, 0.65);
        float prev = texture(tPrev, vec2(0.5)).r;
        if (uValid < 0.5) prev = target;
        float rate = target > prev ? 0.5 : 1.7;   // dilating is slow, closing fast
        float e = mix(prev, target, clamp(uDt * rate, 0.0, 1.0));
        fragColor = vec4(e, avg, 0.0, 1.0);
      }`, [GLSL_COLOR]), {
      tSmall: { value: null }, tPrev: { value: null },
      uDt: { value: 0.016 }, uComp: { value: 1 }, uValid: { value: 0 },
    });

    this.buildComposite();
  }
// __COMPOSITE__
// __RENDER__
// __RENDER__
}
