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
      depthTest: false, depthWrite: false, toneMapped: false,
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
  /**
   * Albedo of the suspended medium, multiplying all in-scattered light.
   *
   * This is the knob that makes one forest read as several places. A marsh
   * scatters warm-grey (silt, rotting reeds), a creek ravine scatters cold
   * green-grey (moss, spray), a dry upland barely scatters at all and what it
   * does is blue. Without it every zone shares the moon's single colour and the
   * whole 560 m map looks like one procedurally generated surface — which is
   * exactly the tell we are trying to remove.
   */
  tint: THREE.Color;
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
  private fog: FogParams = {
    density: 0.022, baseHeight: 0, falloff: 9, turbulence: 0.55,
    tint: new THREE.Color(1, 1, 1),
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

  // ======================================================================
  // configuration hooks used by the game layer
  // ======================================================================

  /**
   * Hand the pipeline the flashlight so volumetrics can shadow-march it.
   *
   * `origin`/`direction` are optional but strongly preferred: the volumetric
   * pass runs *before* `renderer.render()` walks the scene graph, so deriving
   * the beam axis from `light.target.matrixWorld` here samples last frame's
   * transform. That one-frame skew is visible as the in-scattered shaft
   * trailing its own lit geometry during a turn. `Flashlight` publishes the
   * exact vectors it used for the surface lighting, so passing them through
   * keeps the two in lockstep.
   */
  setBeam(
    light: THREE.SpotLight | null, intensity = 1,
    origin?: THREE.Vector3, direction?: THREE.Vector3,
  ): void {
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

  /**
   * `tint` is *copied* into the existing Color rather than assigned.
   *
   * `Object.assign` would alias `this.fog.tint` to the caller's instance — and the
   * caller (`StaticGame.zoneAtmo.tint`) mutates its colour every frame under the
   * zero-allocation rule. The pipeline would then be holding a live reference into
   * game state, so the later `uFogTint.copy(this.fog.tint)` becomes a self-copy and
   * any future clamping or blending done here would silently write back into the
   * look director. Scalars are safe to assign; object fields are not.
   */
  setFog(p: Partial<Omit<FogParams, 'tint'>> & { tint?: THREE.Color }): void {
    if (p.density !== undefined) this.fog.density = p.density;
    if (p.baseHeight !== undefined) this.fog.baseHeight = p.baseHeight;
    if (p.falloff !== undefined) this.fog.falloff = p.falloff;
    if (p.turbulence !== undefined) this.fog.turbulence = p.turbulence;
    if (p.tint) this.fog.tint.copy(p.tint);
  }

  /** Exposure compensation goal (stops-ish multiplier around the auto value). */
  setExposureGoal(goal: number): void {
    this.exposureComp = THREE.MathUtils.clamp(goal, 0.35, 2.6);
  }

  get gpuMs(): number { return this.timer.lastMs; }
  get effort(): number { return this.effortBias; }

  /**
   * Current exposure compensation.
   *
   * Exposed because it is a free perceptibility signal: a value above 1 means
   * auto-exposure has opened up to find something to look at, i.e. the frame is
   * genuinely dark and the AgX transform is crushing its shadows — which is precisely
   * when fine detail cannot be resolved by the player. `Perceptibility` reads it
   * rather than re-deriving darkness from scratch.
   */
  get exposureLevel(): number { return this.exposureComp; }

  /**
   * Per-pixel effort multipliers from the perceptibility field, 0..1 each.
   *
   * These are *separate* from the quality knobs on purpose. Knobs answer "what can
   * this machine sustain"; these answer "how much of it would the player notice". A
   * knob change may reallocate render targets and recompile shaders, so it is rate
   * limited and quantised. These are continuous uniform scales applied every frame,
   * so they cost nothing to move and can track the beam and the static level in real
   * time.
   */
  private perceptAo = 1;
  private perceptVol = 1;
  private perceptSharp = 1;

  setPerceptibility(ao: number, volumetric: number, sharpness: number): void {
    this.perceptAo = THREE.MathUtils.clamp(ao, 0.25, 1);
    this.perceptVol = THREE.MathUtils.clamp(volumetric, 0.4, 1);
    this.perceptSharp = THREE.MathUtils.clamp(sharpness, 0.3, 1);
  }

  /**
   * Apply the governor's continuous knobs.
   *
   * This replaces `adaptResolution()`, which watched CPU frame time and moved two
   * knobs (resolution, then sample counts). The problems with that were structural
   * rather than tuning: it acted on the wrong signal, it could not tell a GPU-bound
   * frame from a CPU-bound one, and reducing resolution is the *most* perceptible
   * response available — so the one thing it always reached for was the one thing the
   * player would always notice.
   *
   * Everything here that implies a shader recompile is quantised and compared before
   * assignment, so a continuously-drifting scalar cannot cause a recompile storm.
   * `renderScale` goes through the pool's ladder for the same reason: the old
   * controller moved it in raw 0.05 steps, so the set of allocated target sizes was
   * unbounded and no allocation could ever be reused.
   */
  applyKnobs(k: {
    renderScale: number; aoQuality: 0 | 1 | 2; volumetric: 0 | 1 | 2; volSteps: number;
    taa: boolean; motionBlur: boolean; bloom: boolean; dof: boolean; streak: boolean;
    sharpen: number;
  }): void {
    const nextScale = quantiseScale(Math.min(k.renderScale, this.maxScale));
    const scaleChanged = Math.abs(nextScale - this.renderScale) > 1e-4;
    // Recovery may enable a pass without changing resolution. Its shader and
    // target must become live together, including quarter/half-res fog changes.
    const targetsChanged = this.enabled.ao !== (k.aoQuality > 0)
      || this.enabled.taa !== k.taa || this.spec.volumetric !== k.volumetric;

    this.spec.aoQuality = k.aoQuality;
    this.spec.volumetric = k.volumetric;
    this.spec.sharpen = k.sharpen;
    this.enabled.ao = k.aoQuality > 0;
    this.enabled.volumetric = k.volumetric > 0;
    this.enabled.bloom = k.bloom;
    this.enabled.dof = k.dof;
    this.enabled.motionBlur = k.motionBlur;
    this.enabled.taa = k.taa;

    // Only re-issue defines that actually changed — each one dirties a program.
    const aoDirs = k.aoQuality >= 2 ? 4 : 3;
    if (aoDirs !== this.lastAoDirs) {
      this.aoPass.define('AO_DIRS', aoDirs);
      this.aoPass.define('AO_STEPS', aoDirs);
      this.lastAoDirs = aoDirs;
    }
    // Step counts snap to even numbers: the visual difference between 13 and 14 steps
    // is nil, and halving the number of distinct values halves the recompile risk.
    const volSteps = Math.max(6, Math.round(k.volSteps / 2) * 2);
    if (volSteps !== this.lastVolSteps) {
      this.volPass.define('VOL_STEPS', volSteps);
      this.lastVolSteps = volSteps;
    }
    const volShadow = k.volumetric >= 2 ? 1 : 0;
    if (volShadow !== this.lastVolShadow) {
      this.volPass.define('VOL_SPOT_SHADOW', volShadow);
      this.volPass.define('VOL_MOON_SHADOW', volShadow);
      this.lastVolShadow = volShadow;
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
      uniform vec3  uFogTint;     // medium albedo — see FogParams.tint
      uniform float uTurb;
      uniform float uExtinction;

      uniform vec3 uSpotPos;
      uniform vec3 uSpotDir;
      uniform vec3 uSpotColor;
      uniform vec2 uSpotCos;      // (coneCos, penumbraCos) — rim reject only
      uniform float uSpotOuter;   // cone half-angle, radians (profile index)
      uniform float uSpotAperture2; // finite-emitter softening radius, squared
      uniform float uSpotRange;
      uniform float uSpotIntensity;

      uniform vec3 uMoonDir;      // direction light travels
      uniform vec3 uMoonColor;
      uniform float uMoonIntensity;

      #if VOL_SPOT_SHADOW
        uniform sampler2D tSpotShadow;
        uniform mat4 uSpotShadowMatrix;
        uniform float uSpotShadowBias;
        uniform float uSpotShadowValid;   // 0 until three has allocated the map
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
        float sd = unpackRGBAToDepth(texture(map, sc.xy));
        return step(sc.z + bias, sd);
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
              // The SAME fitted profile the cookie bakes — see GLSL_BEAM_PROFILE.
              // A smoothstep over the (now 1.5°) penumbra band would be a step
              // function and would give the shaft a hard geometric edge.
              float cone = beamProfileFromCos(cosA, uSpotOuter);
              // Finite-aperture softening, matching the surface lighting model,
              // so the in-scatter does not blow out where the ray passes within
              // centimetres of the emitter.
              float atten = cone / (dist2 + uSpotAperture2);
              atten *= max(1.0 - dist / uSpotRange, 0.0);
              #if VOL_SPOT_SHADOW
                atten *= mix(1.0, shadowLookup(tSpotShadow, uSpotShadowMatrix, wp, uSpotShadowBias), uSpotShadowValid);
              #endif
              inl += uSpotColor * (atten * henyeyGreenstein(dot(rd, -Ln), 0.62) * uSpotIntensity);
            }
          }

          // ---- moonlight shafts ----
          if (uMoonIntensity > 0.0) {
            float lit = 1.0;
            #if VOL_MOON_SHADOW
              lit = mix(1.0, shadowLookup(tMoonShadow, uMoonShadowMatrix, wp, uMoonShadowBias), uMoonShadowValid);
            #endif
            inl += uMoonColor * (uMoonIntensity * lit * henyeyGreenstein(dot(rd, -uMoonDir), 0.28));
          }

          acc += inl * uFogTint * sigma * trans;
          trans *= exp(-sigma * uExtinction);
        }
        fragColor = vec4(acc, 1.0 - trans);
      }`, [GLSL_HASH, GLSL_DEPTH, GLSL_PHASE, GLSL_BEAM_PROFILE, GLSL_UNPACK_DEPTH]), {
      tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() },
      uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      uFrame: { value: 0 }, uTime: { value: 0 }, uMaxDist: { value: 42 },
      uFogDensity: { value: 0.022 }, uFogBase: { value: 0 }, uFogFalloff: { value: 9 },
      uFogTint: { value: new THREE.Color(1, 1, 1) },
      uTurb: { value: 0.5 }, uExtinction: { value: 1.1 },
      uSpotPos: { value: new THREE.Vector3() }, uSpotDir: { value: new THREE.Vector3(0, 0, -1) },
      uSpotColor: { value: new THREE.Color(1, 0.86, 0.66) },
      uSpotCos: { value: new THREE.Vector2(0.92, 0.96) },
      uSpotOuter: { value: 0.455 }, uSpotAperture2: { value: 0.7225 },
      uSpotRange: { value: 55 }, uSpotIntensity: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonColor: { value: new THREE.Color(0.58, 0.66, 0.85) },
      uMoonIntensity: { value: 0.02 },
      tSpotShadow: { value: null }, uSpotShadowMatrix: { value: new THREE.Matrix4() },
      uSpotShadowBias: { value: 0.0018 }, uSpotShadowValid: { value: 0 },
      tMoonShadow: { value: null }, uMoonShadowMatrix: { value: new THREE.Matrix4() },
      uMoonShadowBias: { value: 0.0025 }, uMoonShadowValid: { value: 0 },
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
        // STATIC must stay dark, but not *illegible*. The old clamp (0.055, cap
        // 1.55) crushed the shadow floor to ~8/255 — the forest read as flat
        // black silhouettes. Opening the ceiling and nudging the key up lets the
        // eye adapt enough to separate bark, ground and depth, while the slow
        // dilate / fast close below keeps it feeling like a camcorder at night.
        float autoE = clamp(0.078 / max(avg, 1e-4), 0.6, 2.15);
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
  /**
   * The one full-res pass. Order matters: everything scene-referred (AO,
   * in-scattering, bloom, DOF) happens in HDR *before* AgX, and everything
   * camera/medium related (grain, scanlines, static, vignette, dither) happens
   * after it — that's what keeps the camcorder look from bleaching the image.
   */
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
      /**
       * Master scale over every noise-like artefact: signal noise, film grain,
       * scanlines and dropout rows. 1 = the tuned camcorder look, 0 = a clean
       * image. Exposed as an accessibility setting; some players read heavy grain
       * as blur or motion sickness rather than as texture.
       */
      uniform float uNoise;

      void main(){
        vec2 uv = vUv;
        vec2 cc = uv - 0.5;
        float s = uStatic;

        // ---- camcorder optics: mild barrel + tape wobble ----
        float barrel = uViewfinder * 0.05;
        uv = 0.5 + cc * (1.0 + barrel * dot(cc, cc));

        // tape-stop roll at extreme static
        if (s > 0.985) uv.y = fract(uv.y + fract(uTime * 0.7));

        // head-switching wobble: a couple of horizontal bands that shear
        float band = smoothstep(0.92, 1.0, fract(uv.y * 3.0 - uTime * 0.35));
        uv.x += band * (uViewfinder * 0.002 + s * s * 0.02) * (hash12(vec2(floor(uv.y * 180.0), floor(uTime * 24.0))) - 0.5);

        float warp = s * s * 0.010;
        uv.x += sin(uv.y * 64.0 + uTime * 13.0) * warp;
        uv.y += sin(uv.x * 47.0 - uTime * 9.0) * warp * 0.5;
        uv = clamp(uv, vec2(0.0005), vec2(0.9995));

        // ---- chromatic aberration (lateral, grows toward the edges) ----
        float ca = s * s * 0.003 + uViewfinder * 0.0012;
        vec2 caDir = cc * ca;
        vec3 col;
        col.r = texture(tInput, uv + caDir).r;
        col.g = texture(tInput, uv).g;
        col.b = texture(tInput, uv - caDir).b;

        // ---- neighbour taps: shared by sharpening and the FXAA fallback ----
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

        // contrast-adaptive sharpening: recovers the detail dynamic-res eats
        {
          vec3 blur = (nN + nS + nE + nW) * 0.25;
          float localContrast = clamp(luminance(abs(col - blur)) * 6.0, 0.0, 1.0);
          col += (col - blur) * uSharpen * (1.0 - localContrast * 0.4);
          col = max(col, vec3(0.0));
        }

        // ---- depth of field: far defocus from the veil chain ----
        float rawD = texture(tDepth, uv).x;
        float lin = linearizeDepth(rawD, uClip);
        #if USE_DOF
        {
          float coc = smoothstep(uDofRange.x, uDofRange.y, lin) * uDofStrength;
          coc = max(coc, (1.0 - smoothstep(0.10, 0.42, lin)) * 0.5 * uDofStrength); // macro near blur
          col = mix(col, texture(tVeil, uv).rgb, clamp(coc, 0.0, 0.85));
        }
        #endif

        // ---- ambient occlusion (scene-referred, distance-faded upstream) ----
        #if USE_AO
          float ao = texture(tAO, uv).r;
          col *= mix(1.0, ao, uAoStrength);
        #endif

        // ---- volumetric in-scattering ----
        #if USE_VOL
          col += texture(tVol, uv).rgb * uVolStrength;
        #endif

        // ---- bloom + anamorphic streak, through a procedural dirty lens ----
        #if USE_BLOOM
        {
          float d1 = sin(uv.x * 21.0 + 1.7) * sin(uv.y * 17.0 - 0.9);
          float d2 = sin(uv.x * 47.0 - 2.3) * sin(uv.y * 39.0 + 1.1);
          float dirt = 0.78 + 0.30 * (d1 * 0.6 + d2 * 0.4);
          col += texture(tBloom, uv).rgb * uBloomStrength * dirt;
          #if USE_STREAK
            col += texture(tStreak, uv).rgb * uStreakStrength * vec3(0.72, 0.82, 1.0);
          #endif
        }
        #endif

        // ---- exposure (GPU eye adaptation) ----
        col *= texture(tExposure, vec2(0.5)).r;

        // ---- wet-night response: deepens contrast, cools the low end ----
        col = mix(col, col * vec3(0.94, 0.99, 1.08) * 1.03, uWetness);

        // ---- display transform ----
        float sat = 1.0 - uDesat * (0.42 + s * 0.4);
        col = agx(col, sat, 1.0 + s * 0.06);

        // ---- filmic grade: cool shadows, warm speculars ----
        float l = luminance(col);
        vec3 shadowTint = col * vec3(0.90, 0.97, 1.14);
        vec3 lightTint  = col * vec3(1.07, 1.00, 0.90);
        col = mix(shadowTint, lightTint, smoothstep(0.22, 0.85, l));

        // ---- toe lift: separate the crushed blacks into readable near-black ----
        // Only touches the deepest shadows (smooth gate on l), so mids/highlights
        // and the overall exposure are unchanged — the scene stays dark, but bark,
        // ground and the entity's silhouette stop collapsing into one flat black.
        // A faint cool bias keeps the lifted floor from going muddy/warm.
        float shadowFloor = 1.0 - smoothstep(0.0, 0.085, l);
        col += vec3(0.016, 0.020, 0.031) * shadowFloor;

        // ---- CCD / tape artefacts ----
        // Scanlines are a *permanent* 1100-cycle pattern over the whole frame, so
        // they cost real resolution everywhere. Kept for the camcorder identity but
        // pulled back hard outside the viewfinder, where they belong.
        float scan = 0.96 + 0.04 * sin(uv.y * 1100.0 + uTime * 8.0);
        col *= mix(1.0, scan, (0.06 + s * 0.16 + uViewfinder * 0.42) * uNoise);

        // ---- signal noise -------------------------------------------------
        // NOTE: no backticks anywhere in this shader source — it lives inside a JS
        // template literal, so a stray backtick silently terminates the string and
        // the file stops parsing.
        //
        // Was s * (0.09 + edge * 0.45), which at high fear replaced up to 54% of
        // every peripheral pixel with white noise and 9% of the centre. Stacked on
        // top of film grain, scanlines and dropout rows, the frame stopped being an
        // image. Geometry, materials and lighting are supposed to carry this game;
        // noise was hiding them.
        //
        // Three changes: the periphery ramp is cut from 0.45 to 0.10, the whole term
        // is squared so it stays near zero through the low- and mid-fear states where
        // most of the playtime is, and the ceiling drops from 0.90 to 0.30 so an
        // image always survives. uNoise scales all of it for the accessibility
        // setting.
        float n = hash12(uv * vec2(1920.0, 1080.0) + fract(uTime) * 371.0);
        float edge = smoothstep(0.25, 0.85, length(cc) * 1.6);
        float noiseAmt = (s * s * (0.035 + edge * 0.10) + uGlimpse * 0.16) * uNoise;
        col = mix(col, vec3(n), clamp(noiseAmt, 0.0, 0.30));

        // dropout scratches — sparse, only when the signal is bad. Rarer (0.9975 ->
        // 0.9992) and dimmer, so they read as an occasional tape fault rather than
        // constant streaking.
        float dropRow = step(0.9992, hash12(vec2(floor(uv.y * 240.0), floor(uTime * 12.0))));
        col = mix(col, vec3(0.62), dropRow * s * 0.22 * uNoise);

        col += vec3(0.11, 0.12, 0.16) * uGlimpse;

        // Film grain, luminance-weighted. The weighting is inverted from before:
        // it used to be *strongest* on dark pixels (mix(0.6,1.4,1-l) = 1.4 at black),
        // which is exactly backwards — this game is mostly near-black, so grain was
        // loudest where the image is quietest, and it visibly boiled in the shadows.
        // Real film grain is most visible in the mid-tones and vanishes in the toe.
        float g = (hash12(uv * 911.0 + fract(uTime * 7.0) * 517.0) - 0.5);
        float grainWeight = smoothstep(0.0, 0.22, l) * mix(1.0, 0.55, smoothstep(0.5, 1.0, l));
        col += g * uGrain * grainWeight * uNoise;

        // peripheral narrowing
        // GLSL smoothstep requires edge0 < edge1. Reversed edges are undefined
        // on mobile drivers and can black out the entire periphery.
        float vig = 1.0 - smoothstep(0.34, 1.28 - s * 0.34, length(cc) * 1.9);
        col *= mix(uVignette, 1.0, vig);

        // ordered dither on the final 8-bit quantisation — no banding in the dark
        col += (ign(gl_FragCoord.xy + uFrame) - 0.5) * (1.0 / 255.0);

        fragColor = vec4(max(col, vec3(0.0)), 1.0);
      }`, [GLSL_HASH, GLSL_DEPTH, GLSL_COLOR, GLSL_TONEMAP]), {
      tInput: { value: null }, tBloom: { value: null }, tStreak: { value: null },
      tVeil: { value: null }, tAO: { value: null }, tVol: { value: null },
      tDepth: { value: null }, tExposure: { value: null },
      uTexel: { value: V2() }, uClip: { value: new THREE.Vector2(0.08, 900) },
      uTime: { value: 0 }, uFrame: { value: 0 },
      uStatic: { value: 0 }, uGlimpse: { value: 0 }, uDesat: { value: 0.25 },
      uWetness: { value: 0 }, uViewfinder: { value: 0 },
      uSharpen: { value: 0.3 }, uBloomStrength: { value: 0.18 },
      uStreakStrength: { value: 0.0 }, uVolStrength: { value: 1.0 },
      uAoStrength: { value: 0.8 },
      uDofRange: { value: new THREE.Vector2(26, 90) }, uDofStrength: { value: 0.7 },
      uVignette: { value: 0.88 }, uGrain: { value: 0.026 },
      uNoise: { value: 1 },
    }, {
      USE_BLOOM: 1, USE_AO: 1, USE_VOL: 1, USE_DOF: 1, USE_STREAK: 1,
    });
  }

  // ======================================================================
  // render targets
  // ======================================================================
  private makeRT(w: number, h: number, opts: {
    depthTexture?: THREE.DepthTexture; type?: THREE.TextureDataType;
    filter?: THREE.MagnificationTextureFilter;
  } = {}): THREE.WebGLRenderTarget {
    const filter = opts.filter ?? THREE.LinearFilter;
    return new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: filter, magFilter: filter,
      format: THREE.RGBAFormat, type: opts.type ?? THREE.HalfFloatType,
      depthBuffer: !!opts.depthTexture,
      depthTexture: opts.depthTexture,
      stencilBuffer: false,
      generateMipmaps: false,
    });
  }

  resize(canvasW: number, canvasH: number): void {
    this.cw = Math.max(2, canvasW); this.ch = Math.max(2, canvasH);
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

    const mips = 4;
    for (let i = 0; i < mips; i++) {
      const mw = Math.max(2, w >> (i + 1)), mh = Math.max(2, h >> (i + 1));
      this.bloomDown.push(this.makeRT(mw, mh));
      this.bloomUp.push(this.makeRT(mw, mh));
    }
    this.streakRT = this.makeRT(Math.max(2, w >> 3), Math.max(2, h >> 3));

    this.expA = this.makeRT(1, 1, { filter: THREE.NearestFilter });
    this.expB = this.makeRT(1, 1, { filter: THREE.NearestFilter });

    this.invalidateHistory();
  }

  private disposeTargets(): void {
    const kill = (rt: THREE.WebGLRenderTarget | null | undefined) => rt?.dispose();
    kill(this.sceneRT);
    kill(this.aoRT); kill(this.aoHistA); kill(this.aoHistB);
    kill(this.volRT); kill(this.volHistA); kill(this.volHistB);
    kill(this.taaA); kill(this.taaB); kill(this.motionRT);
    kill(this.veilA); kill(this.veilB); kill(this.streakRT);
    kill(this.expA); kill(this.expB);
    for (const rt of this.bloomDown) rt.dispose();
    for (const rt of this.bloomUp) rt.dispose();
    this.bloomDown.length = 0; this.bloomUp.length = 0;
    this.aoRT = this.aoHistA = this.aoHistB = null;
    this.volRT = this.volHistA = this.volHistB = null;
    this.taaA = this.taaB = null;
  }

  /** Push the active quality spec into shader `#define`s. */
  private syncDefines(): void {
    const spec = this.spec;
    this.aoPass.define('AO_DIRS', spec.aoQuality >= 2 ? 4 : 3);
    this.aoPass.define('AO_STEPS', spec.aoQuality >= 2 ? 4 : 3);
    this.volPass.define('VOL_STEPS', spec.volumetric >= 2 ? 16 : 10);
    this.volPass.define('VOL_SPOT_SHADOW', spec.volumetric >= 2 ? 1 : 0);
    this.volPass.define('VOL_MOON_SHADOW', spec.volumetric >= 2 ? 1 : 0);
    this.compositePass.define('USE_AO', this.enabled.ao);
    this.compositePass.define('USE_VOL', this.enabled.volumetric);
    this.compositePass.define('USE_BLOOM', this.enabled.bloom);
    this.compositePass.define('USE_DOF', this.enabled.dof);
    this.compositePass.define('USE_STREAK', spec.tier === 'high' || spec.tier === 'ultra');
    this.compositePass.define('USE_FXAA', !spec.taa);
    this.compositePass.u.uSharpen.value = spec.sharpen;
    this.motionPass.define('MB_TAPS', spec.tier === 'ultra' ? 7 : 5);
  }

  setQuality(spec: QualitySpec): void {
    this.spec = spec;
    this.applySpecFlags(spec);
    this.renderScale = Math.min(spec.renderScale, spec.tier === 'low' ? 0.85 : 1.0);
    this.maxScale = Math.min(1.0, spec.tier === 'low' ? 0.85 : 1.0);
    this.syncDefines();
    // force reallocation for the new target set
    this.w = this.h = 0;
    this.resize(this.cw, this.ch);
  }

  // ======================================================================
  // frame
  // ======================================================================
  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, statics: StaticState, dt: number): void {
    const r = this.renderer;
    if (!this.sceneRT) this.resize(this.cw, this.ch);
    r.info.autoReset = false;
    r.info.reset();
    this.timer.begin();
    this.frameIndex++;
    const frameMod = this.frameIndex % 64;

    // ---- matrices: capture the *unjittered* transform first so TAA and
    //      motion blur reproject against a stable reference ----------------
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.projNoJitter.copy(camera.projectionMatrix);
    this.viewMatrix.copy(camera.matrixWorldInverse);
    this.camWorld.copy(camera.matrixWorld);
    this.viewProj.multiplyMatrices(this.projNoJitter, this.viewMatrix);

    let jx = 0, jy = 0;
    if (this.enabled.taa) {
      const idx = (this.frameIndex % 8) + 1;
      jx = halton(idx, HALTON_BASES[0]) - 0.5;
      jy = halton(idx, HALTON_BASES[1]) - 0.5;
      camera.setViewOffset(this.w, this.h, jx, jy, this.w, this.h);
      camera.updateProjectionMatrix();
    }
    this.jitter.set(jx, jy);
    this.invProjJit.copy(camera.projectionMatrix).invert();
    this.invViewProjJit.multiplyMatrices(camera.projectionMatrix, this.viewMatrix).invert();
    const projScaleUV = 0.5 / Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);

    // ---- 1. main scene (HDR + depth) ------------------------------------
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    let passes = 1;

    // ---- 2. HBAO --------------------------------------------------------
    let aoTex: THREE.Texture | null = null;
    if (this.enabled.ao && this.aoRT && this.aoHistA && this.aoHistB) {
      const u = this.aoPass.u;
      u.tDepth.value = this.depthTex;
      (u.uInvProj.value as THREE.Matrix4).copy(this.invProjJit);
      (u.uClip.value as THREE.Vector2).set(camera.near, camera.far);
      (u.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      u.uProjScaleUV.value = projScaleUV;
      u.uFrame.value = frameMod;
      // AO strength scaled by perceptibility. AO is a low-frequency darkening of
      // already-dark regions — the first thing the composite's static noise erases and
      // the last thing a player could name as missing — so it is the most degradable
      // term in the whole pipeline and takes the largest share of the saving.
      u.uIntensity.value = 1.1 * this.effortBias * this.perceptAo;
      this.aoPass.render(r, this.aoRT);

      const ur = this.aoResolve.u;
      ur.tAO.value = this.aoRT.texture;
      ur.tHistory.value = this.aoHistA.texture;
      ur.tDepth.value = this.depthTex;
      (ur.uInvViewProj.value as THREE.Matrix4).copy(this.invViewProjJit);
      (ur.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj);
      (ur.uTexel.value as THREE.Vector2).set(1 / this.aoRT.width, 1 / this.aoRT.height);
      ur.uValid.value = this.aoHistoryValid && this.historyValid ? 1 : 0;
      this.aoResolve.render(r, this.aoHistB);
      const t = this.aoHistA; this.aoHistA = this.aoHistB; this.aoHistB = t;
      this.aoHistoryValid = true;
      aoTex = this.aoHistA.texture;
      passes += 2;
    }

    // ---- 3. volumetrics -------------------------------------------------
    let volTex: THREE.Texture | null = null;
    if (this.enabled.volumetric && this.volRT && this.volHistA && this.volHistB) {
      const u = this.volPass.u;
      u.tDepth.value = this.depthTex;
      (u.uInvProj.value as THREE.Matrix4).copy(this.invProjJit);
      (u.uCamWorld.value as THREE.Matrix4).copy(this.camWorld);
      camera.getWorldPosition(this.tmpA);
      (u.uCamPos.value as THREE.Vector3).copy(this.tmpA);
      u.uFrame.value = frameMod;
      u.uTime.value = statics.time;
      u.uFogDensity.value = this.fog.density;
      u.uFogBase.value = this.fog.baseHeight;
      u.uFogFalloff.value = this.fog.falloff;
      (u.uFogTint.value as THREE.Color).copy(this.fog.tint);
      u.uTurb.value = this.fog.turbulence;

      // hero light
      const sl = this.beam.light;
      let spotI = 0;
      if (sl && sl.intensity > 0 && this.beam.intensity > 0) {
        // Prefer the vectors the light source itself published this frame; fall
        // back to the scene graph only when nobody supplied them. See setBeam().
        if (this.beamExplicit) {
          (u.uSpotPos.value as THREE.Vector3).copy(this.beamOrigin);
          (u.uSpotDir.value as THREE.Vector3).copy(this.beamDir);
        } else {
          sl.getWorldPosition(this.tmpA);
          (u.uSpotPos.value as THREE.Vector3).copy(this.tmpA);
          sl.target.getWorldPosition(this.tmpB);
          (u.uSpotDir.value as THREE.Vector3).copy(this.tmpB).sub(this.tmpA).normalize();
        }
        (u.uSpotColor.value as THREE.Color).copy(sl.color);
        // Only the .x term is still used, as a cheap early reject outside the
        // cone. The visible falloff comes from beamProfileFromCos().
        (u.uSpotCos.value as THREE.Vector2).set(
          Math.cos(Math.min(Math.PI * 0.5, sl.angle * 1.35)),
          Math.cos(sl.angle * (1 - sl.penumbra)));
        u.uSpotOuter.value = sl.angle;
        u.uSpotRange.value = sl.distance > 0 ? sl.distance : 60;
        // Surface intensity already includes LED drive/battery. Applying beam
        // strength twice makes the shaft disappear before the surface light.
        spotI = sl.intensity * 0.00145;
        u.uSpotShadowBias.value = sl.shadow.bias;
        const smap = sl.shadow.map;
        if (smap && this.spec.volumetric >= 2) {
          u.tSpotShadow.value = smap.texture;
          (u.uSpotShadowMatrix.value as THREE.Matrix4).copy(sl.shadow.matrix);
          u.uSpotShadowValid.value = 1;
        } else {
          u.uSpotShadowValid.value = 0;
        }
      }
      u.uSpotIntensity.value = spotI;

      // moonlight
      const mn = this.moon;
      if (mn && mn.intensity > 0) {
        mn.getWorldPosition(this.tmpA);
        mn.target.getWorldPosition(this.tmpB);
        (u.uMoonDir.value as THREE.Vector3).copy(this.tmpB).sub(this.tmpA).normalize();
        (u.uMoonColor.value as THREE.Color).copy(mn.color);
        u.uMoonIntensity.value = mn.intensity * 0.055;
        u.uMoonShadowBias.value = mn.shadow.bias;
        const msmap = mn.shadow.map;
        if (msmap && this.spec.volumetric >= 2) {
          u.tMoonShadow.value = msmap.texture;
          (u.uMoonShadowMatrix.value as THREE.Matrix4).copy(mn.shadow.matrix);
          u.uMoonShadowValid.value = 1;
        } else {
          u.uMoonShadowValid.value = 0;
        }
      } else {
        u.uMoonIntensity.value = 0;
      }
      this.volPass.render(r, this.volRT);

      const ur = this.volResolve.u;
      ur.tVol.value = this.volRT.texture;
      ur.tHistory.value = this.volHistA.texture;
      ur.tDepth.value = this.depthTex;
      (ur.uInvViewProj.value as THREE.Matrix4).copy(this.invViewProjJit);
      (ur.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj);
      (ur.uTexel.value as THREE.Vector2).set(1 / this.volRT.width, 1 / this.volRT.height);
      ur.uValid.value = this.volHistoryValid && this.historyValid ? 1 : 0;
      this.volResolve.render(r, this.volHistB);
      const t = this.volHistA; this.volHistA = this.volHistB; this.volHistB = t;
      this.volHistoryValid = true;
      volTex = this.volHistA.texture;
      passes += 2;
    }

    // ---- 4. TAA ---------------------------------------------------------
    let srcTex: THREE.Texture = this.sceneRT.texture;
    if (this.enabled.taa && this.taaA && this.taaB) {
      const u = this.taaPass.u;
      u.tCurrent.value = this.sceneRT.texture;
      u.tHistory.value = this.taaA.texture;
      u.tDepth.value = this.depthTex;
      (u.uInvViewProjJit.value as THREE.Matrix4).copy(this.invViewProjJit);
      (u.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj);
      (u.uTexSize.value as THREE.Vector2).set(this.w, this.h);
      (u.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      u.uValid.value = this.historyValid ? 1 : 0;
      this.taaPass.render(r, this.taaB);
      const t = this.taaA; this.taaA = this.taaB; this.taaB = t;
      srcTex = this.taaA.texture;
      passes++;
    }

    // ---- 5. motion blur (rotation-led; walking stays crisp) -------------
    if (this.enabled.motionBlur) {
      const dYaw = camera.rotation.y - this.lastYaw;
      const dPitch = camera.rotation.x - this.lastPitch;
      this.lastYaw = camera.rotation.y; this.lastPitch = camera.rotation.x;
      const turnRate = Math.abs(dYaw) + Math.abs(dPitch) * 0.6;
      const target = Math.min(1.0, turnRate * 22 + statics.level * 0.18);
      this.mbStrength += (target - this.mbStrength) * Math.min(1, dt * 9);
      if (this.mbStrength > 0.04 && this.historyValid) {
        const u = this.motionPass.u;
        u.tCurrent.value = srcTex;
        u.tDepth.value = this.depthTex;
        (u.uInvViewProjJit.value as THREE.Matrix4).copy(this.invViewProjJit);
        (u.uPrevViewProj.value as THREE.Matrix4).copy(this.prevViewProj);
        u.uAmount.value = 0.22 * this.mbStrength;
        this.motionPass.render(r, this.motionRT);
        srcTex = this.motionRT.texture;
        passes++;
      }
    }

    // ---- 6. veil chain (DOF source + veiling glare + exposure metering) --
    {
      const u = this.downPass.u;
      u.tInput.value = srcTex;
      (u.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      this.downPass.render(r, this.veilA);
      const b = this.blurPass.u;
      b.tInput.value = this.veilA.texture;
      (b.uDir.value as THREE.Vector2).set(1 / this.veilA.width, 0);
      this.blurPass.render(r, this.veilB);
      b.tInput.value = this.veilB.texture;
      (b.uDir.value as THREE.Vector2).set(0, 1 / this.veilA.height);
      this.blurPass.render(r, this.veilA);
      passes += 3;
    }

    // ---- 7. bloom (Karis bright-pass → 4-mip down → tent up) ------------
    if (this.enabled.bloom && this.bloomDown.length) {
      const bp = this.brightPass.u;
      bp.tInput.value = srcTex;
      (bp.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      this.brightPass.render(r, this.bloomDown[0]);
      for (let i = 1; i < this.bloomDown.length; i++) {
        const u = this.bloomDownPass.u;
        u.tInput.value = this.bloomDown[i - 1].texture;
        (u.uTexel.value as THREE.Vector2).set(
          1 / this.bloomDown[i - 1].width, 1 / this.bloomDown[i - 1].height);
        this.bloomDownPass.render(r, this.bloomDown[i]);
      }
      const last = this.bloomDown.length - 1;
      for (let i = last - 1; i >= 0; i--) {
        const u = this.bloomUpPass.u;
        const lower = i === last - 1 ? this.bloomDown[last] : this.bloomUp[i + 1];
        u.tLower.value = lower.texture;
        u.tSame.value = this.bloomDown[i].texture;
        (u.uTexel.value as THREE.Vector2).set(1 / lower.width, 1 / lower.height);
        this.bloomUpPass.render(r, this.bloomUp[i]);
      }
      passes += this.bloomDown.length * 2;

      if (this.streakRT && this.bloomDown.length > 2) {
        const u = this.streakPass.u;
        u.tInput.value = this.bloomDown[2].texture;
        (u.uTexel.value as THREE.Vector2).set(1 / this.bloomDown[2].width, 0);
        this.streakPass.render(r, this.streakRT);
        passes++;
      }
    }

    // ---- 8. exposure (1×1, GPU-side eye adaptation) ----------------------
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

    // ---- 9. composite to the backbuffer ---------------------------------
    {
      const u = this.compositePass.u;
      u.tInput.value = srcTex;
      u.tBloom.value = this.enabled.bloom && this.bloomUp.length ? this.bloomUp[0].texture : null;
      u.tStreak.value = this.streakRT ? this.streakRT.texture : null;
      u.tVeil.value = this.veilA.texture;
      u.tAO.value = aoTex;
      u.tVol.value = volTex;
      u.tDepth.value = this.depthTex;
      u.tExposure.value = this.expA.texture;
      (u.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      (u.uClip.value as THREE.Vector2).set(camera.near, camera.far);
      u.uTime.value = statics.time;
      u.uFrame.value = frameMod;
      u.uStatic.value = statics.level;
      u.uGlimpse.value = statics.glimpse;
      u.uDesat.value = statics.desat;
      u.uWetness.value = statics.wetness ?? 0;
      u.uViewfinder.value = statics.viewfinder ?? 0;
      // Sharpening rises as perceptibility falls — the inverse coupling is the point.
      // CAS is what makes a low internal resolution readable, so the two knobs must
      // move together; letting resolution drop without raising sharpen is how dynamic
      // resolution earns its reputation for looking like mud.
      u.uSharpen.value = this.spec.sharpen * (1 + (1 - this.perceptSharp) * 0.45);
      this.compositePass.render(r, null);
      passes++;
    }

    // ---- bookkeeping ----------------------------------------------------
    this.prevViewProj.copy(this.viewProj);
    this.historyValid = true;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
    this.timer.end();
    this.gpuStats.calls = r.info.render.calls;
    this.gpuStats.triangles = r.info.render.triangles;
    this.gpuStats.gpuMs = this.timer.lastMs;
    this.gpuStats.passes = passes;
    // memory counters for leak hunting: these must stay flat over a session
    this.gpuStats.geometries = r.info.memory.geometries;
    this.gpuStats.textures = r.info.memory.textures;
    this.gpuStats.programs = r.info.programs ? r.info.programs.length : 0;
  }

  /**
   * Frame-cost EMA, retained purely as a diagnostic readout.
   *
   * The controller that used to live here — two hysteretic knobs, resolution then
   * sample counts, gated on `frameCostEma > 19.5` — has been **removed** and replaced
   * by `PerfGovernor` plus `applyKnobs()`. The reasons were structural, not tuning:
   *
   *  1. **It watched the wrong signal.** `frameMs` was CPU wall time. A frame made
   *     long by an A* repath (0.50 ms/query measured), a 1M-vertex chunk merge, or a
   *     tab refocus reduced *internal resolution* — degrading the image to relieve
   *     pressure on a resource that was never the constraint.
   *  2. **It could not attribute cost.** With no CPU/GPU split it had no way to know
   *     whether pixels or JavaScript were the problem, so it always assumed pixels.
   *  3. **It reached for the most perceptible knob first.** Resolution is the one
   *     change a player always notices. The governor now has ~20 knobs and orders
   *     them by perceptual cost, so resolution is nearly the last resort rather than
   *     the first.
   *  4. **Its 0.05/0.1 steps made the target-size set unbounded**, so no render-target
   *     allocation could ever be reused. `applyKnobs()` quantises through
   *     `SCALE_LADDER` for exactly this reason.
   *
   * Kept as a no-op-with-telemetry rather than deleted outright so the F3 overlay and
   * the debug API keep a stable shape.
   */
  observeFrameCost(frameMs: number): void {
    this.frameCostEma = this.frameCostEma * 0.94 + frameMs * 0.06;
  }

  get frameCostMs(): number { return this.frameCostEma; }

  /** Tuning hooks used by the game director (weather, fear, viewfinder). */
  setGrade(opts: {
    bloom?: number; streak?: number; volumetric?: number; ao?: number;
    grain?: number; vignette?: number; dofRange?: [number, number]; dof?: number;
    noise?: number;
  }): void {
    const u = this.compositePass.u;
    if (opts.bloom !== undefined) u.uBloomStrength.value = opts.bloom;
    if (opts.streak !== undefined) u.uStreakStrength.value = opts.streak;
    if (opts.volumetric !== undefined) u.uVolStrength.value = opts.volumetric;
    if (opts.ao !== undefined) u.uAoStrength.value = opts.ao;
    if (opts.grain !== undefined) u.uGrain.value = opts.grain;
    if (opts.noise !== undefined) u.uNoise.value = opts.noise;
    if (opts.vignette !== undefined) u.uVignette.value = opts.vignette;
    if (opts.dof !== undefined) u.uDofStrength.value = opts.dof;
    if (opts.dofRange) (u.uDofRange.value as THREE.Vector2).set(opts.dofRange[0], opts.dofRange[1]);
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

