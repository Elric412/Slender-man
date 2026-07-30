import * as THREE from 'three';
import { QualitySpec } from '../core/Config';

/**
 * Custom render graph — no EffectComposer.
 * Passes: scene(HDR, w/ depth+normals prepass targets) → AO → bloom chain →
 * TAA (Halton jitter + history) → composite (exposure, grade, static overlay, vignette) → screen.
 */

const BLIT_VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// Halton sequence for TAA jitter
function halton(i: number, base: number): number {
  let f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}

class FSQuad {
  readonly mesh: THREE.Mesh;
  readonly scene = new THREE.Scene();
  readonly cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  constructor(frag: string, uniforms: Record<string, THREE.IUniform>) {
    this.mat = new THREE.ShaderMaterial({ vertexShader: BLIT_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  render(r: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    r.setRenderTarget(target);
    r.render(this.scene, this.cam);
  }
  dispose(): void { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

export interface StaticState {
  level: number;        // 0..1 fear/static amount
  glimpse: number;      // 0..1 single-frame glimpse flash
  desat: number;
  time: number;
}

export class RenderPipeline {
  private renderer: THREE.WebGLRenderer;
  private spec: QualitySpec;

  private w = 2; private h = 2;      // render (scaled) size
  private cw = 2; private ch = 2;    // canvas (output) size
  renderScale: number;
  private minScale = 0.55;
  private maxScale: number;

  // targets
  private sceneRT!: THREE.WebGLRenderTarget;
  private depthRT!: THREE.DepthTexture;
  private normalRT!: THREE.WebGLRenderTarget;
  private aoRT!: THREE.WebGLRenderTarget | null;
  private bloomA!: THREE.WebGLRenderTarget;
  private bloomB!: THREE.WebGLRenderTarget;
  private taaA!: THREE.WebGLRenderTarget | null;
  private taaB!: THREE.WebGLRenderTarget | null;

  // normal material override
  private normalMat = new THREE.MeshNormalMaterial();

  // passes
  private aoPass!: FSQuad | null;
  private bloomBright!: FSQuad;
  private bloomBlur!: FSQuad;
  private taaPass!: FSQuad | null;
  private motionPass!: FSQuad;
  private compositePass!: FSQuad;

  // motion-blur state
  private mbPrev = new THREE.Matrix4();
  private mbPrevValid = false;
  private mbCurr = new THREE.Matrix4();
  private motionRT!: THREE.WebGLRenderTarget;
  private mbStrength = 0;
  private lastYaw = 0;
  private lastPitch = 0;

  // TAA state
  private jitterIdx = 0;
  private prevViewProj = new THREE.Matrix4();
  private taaHistoryValid = false;
  private jitter = new THREE.Vector2();

  // exposure (reactive-only metering — no pixel readback; robust across platforms)
  private exposure = 1.0;
  private exposureTarget = 1.0;

  // dynamic res
  private frameCostEma = 16.6;
  private lastAdjust = 0;

  enabled = { taa: true, ao: true, bloom: true };

  constructor(renderer: THREE.WebGLRenderer, spec: QualitySpec) {
    this.renderer = renderer;
    this.spec = spec;
    this.renderScale = spec.renderScale;
    this.maxScale = Math.min(1.0, spec.tier === 'low' ? 0.85 : 1.0);
    this.enabled.taa = spec.taa;
    this.enabled.ao = spec.ao;
    this.enabled.bloom = spec.bloom;
    this.buildPasses();
  }

  private rtType(): THREE.TextureDataType {
    // half float with fallback
    return THREE.HalfFloatType;
  }

  private makeRT(w: number, h: number, opts: { depth?: boolean; type?: THREE.TextureDataType; depthTexture?: THREE.DepthTexture } = {}): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: opts.type ?? this.rtType(),
      depthBuffer: opts.depth ?? false,
      depthTexture: opts.depthTexture,
      stencilBuffer: false,
    });
    return rt;
  }

  private buildPasses(): void {
    // ---- AO pass (depth+normal based SAO-lite) ----
    this.aoPass = new FSQuad(/* glsl */`
      varying vec2 vUv;
      uniform sampler2D tDepth; uniform sampler2D tNormal;
      uniform vec2 uTexel; uniform vec2 uClip; uniform float uIntensity;
      float linDepth(vec2 uv){
        float z = texture2D(tDepth, uv).x;
        float zn = z * 2.0 - 1.0;
        return (2.0 * uClip.x * uClip.y) / (uClip.y + uClip.x - zn * (uClip.y - uClip.x));
      }
      void main(){
        float d0 = linDepth(vUv);
        vec3 n0 = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
        float occ = 0.0;
        const int N = 6;
        vec2 offs[6];
        offs[0]=vec2(1.0,0.0); offs[1]=vec2(-1.0,0.0); offs[2]=vec2(0.0,1.0);
        offs[3]=vec2(0.0,-1.0); offs[4]=vec2(0.7,0.7); offs[5]=vec2(-0.7,0.7);
        float radius = 6.0;
        for (int i=0;i<N;i++){
          vec2 uv2 = vUv + offs[i] * uTexel * radius;
          float d1 = linDepth(uv2);
          vec3 n1 = texture2D(tNormal, uv2).xyz * 2.0 - 1.0;
          float dd = d0 - d1;
          float w = clamp(1.0 - abs(dd) * 0.15, 0.0, 1.0);
          occ += clamp(dd * 0.4, 0.0, 1.0) * w * clamp(dot(n0, n1), 0.3, 1.0);
        }
        float ao = 1.0 - clamp(occ / float(N), 0.0, 1.0) * uIntensity;
        // fade AO with distance
        ao = mix(ao, 1.0, clamp(d0 / 60.0, 0.0, 1.0));
        gl_FragColor = vec4(vec3(ao), 1.0);
      }`, {
      tDepth: { value: null }, tNormal: { value: null },
      uTexel: { value: new THREE.Vector2() }, uClip: { value: new THREE.Vector2(0.1, 400) },
      uIntensity: { value: 0.85 },
    });

    // ---- bloom bright ----
    this.bloomBright = new FSQuad(/* glsl */`
      varying vec2 vUv; uniform sampler2D tInput; uniform float uThresh;
      void main(){
        vec3 c = texture2D(tInput, vUv).rgb;
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor = vec4(c * smoothstep(uThresh, uThresh + 0.9, l), 1.0);
      }`, { tInput: { value: null }, uThresh: { value: 1.05 } });

    // ---- bloom blur (separable gaussian) ----
    this.bloomBlur = new FSQuad(/* glsl */`
      varying vec2 vUv; uniform sampler2D tInput; uniform vec2 uDir;
      void main(){
        vec3 s = texture2D(tInput, vUv).rgb * 0.227;
        s += texture2D(tInput, vUv + uDir * 1.384).rgb * 0.316;
        s += texture2D(tInput, vUv - uDir * 1.384).rgb * 0.316;
        s += texture2D(tInput, vUv + uDir * 3.230).rgb * 0.070;
        s += texture2D(tInput, vUv - uDir * 3.230).rgb * 0.070;
        gl_FragColor = vec4(s, 1.0);
      }`, { tInput: { value: null }, uDir: { value: new THREE.Vector2() } });

    // ---- motion blur: reproject previous composite toward current frame ----
    this.motionPass = new FSQuad(/* glsl */`
      varying vec2 vUv;
      uniform sampler2D tCurrent; uniform sampler2D tPrev;
      uniform mat4 uReproj; uniform float uAmount; uniform vec2 uTexel;
      void main(){
        vec3 cur = texture2D(tCurrent, vUv).rgb;
        vec4 clip = uReproj * vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
        vec2 prevUv = clip.xy / max(clip.w, 1e-4) * 0.5 + 0.5;
        vec2 delta = clamp(prevUv - vUv, vec2(-0.04), vec2(0.04));
        vec3 acc = cur;
        const int N = 4;
        for (int i = 1; i <= N; i++) {
          acc += texture2D(tCurrent, vUv + delta * (float(i) / float(N))).rgb;
        }
        acc /= float(N + 1);
        // screen-edge guard: don't smear outside
        float edge = step(0.0, prevUv.x) * step(prevUv.x, 1.0) * step(0.0, prevUv.y) * step(prevUv.y, 1.0);
        gl_FragColor = vec4(mix(cur, acc, uAmount * edge), 1.0);
      }`, {
      tCurrent: { value: null }, tPrev: { value: null },
      uReproj: { value: new THREE.Matrix4() }, uAmount: { value: 0 },
      uTexel: { value: new THREE.Vector2() },
    });

    // ---- TAA (history blend w/ clamp) ----
    this.taaPass = new FSQuad(/* glsl */`
      varying vec2 vUv;
      uniform sampler2D tCurrent; uniform sampler2D tHistory; uniform sampler2D tDepth;
      uniform float uBlend; uniform vec2 uTexel;
      void main(){
        vec3 cur = texture2D(tCurrent, vUv).rgb;
        vec3 lo = cur, hi = cur;
        for (int x=-1;x<=1;x++) for (int y=-1;y<=1;y++){
          vec3 c = texture2D(tCurrent, vUv + vec2(float(x),float(y)) * uTexel).rgb;
          lo = min(lo, c); hi = max(hi, c);
        }
        vec3 hist = texture2D(tHistory, vUv).rgb;
        hist = clamp(hist, lo, hi);
        float d = texture2D(tDepth, vUv).x;
        float blend = uBlend * (1.0 - step(0.9999, 1.0 - d) * 0.5); // sky re-accumulates faster
        gl_FragColor = vec4(mix(cur, hist, blend), 1.0);
      }`, {
      tCurrent: { value: null }, tHistory: { value: null }, tDepth: { value: null },
      uBlend: { value: 0.88 }, uTexel: { value: new THREE.Vector2() },
    });

    // ---- composite: exposure + grade + static overlay + vignette + tape-stop ----
    this.compositePass = new FSQuad(/* glsl */`
      varying vec2 vUv;
      uniform sampler2D tInput; uniform sampler2D tBloom; uniform sampler2D tAO;
      uniform float uExposure; uniform float uTime;
      uniform float uStatic; uniform float uGlimpse; uniform float uDesat;
      uniform vec2 uJitter;

      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

      vec3 aces(vec3 x){
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }

      void main(){
        vec2 uv = vUv;
        float s = uStatic;

        // tape-stop: bottom-to-top roll
        if (s > 0.985) {
          float roll = fract(uTime * 0.7);
          uv.y = fract(uv.y + roll);
        }

        // warp at high static
        float warp = s * s * 0.012;
        uv.x += sin(uv.y * 60.0 + uTime * 13.0) * warp;
        uv.y += sin(uv.x * 45.0 - uTime * 9.0) * warp * 0.5;

        // chromatic aberration scaled by static
        float ca = 0.0012 + s * 0.006;
        vec2 dir = (uv - 0.5) * ca;
        vec3 col;
        col.r = texture2D(tInput, uv + dir).r;
        col.g = texture2D(tInput, uv).g;
        col.b = texture2D(tInput, uv - dir).b;

        vec3 bloom = texture2D(tBloom, uv).rgb;
        col += bloom * 0.8;

        float ao = texture2D(tAO, uv).r;
        col *= ao;

        col *= uExposure;

        // fear desaturation + cool grade
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, vec3(lum), uDesat * (0.35 + s * 0.45));
        col = aces(col);
        // cool shadows / warm highlights grade
        col = pow(col, vec3(1.06, 1.0, 0.94));
        col *= vec3(0.96, 1.0, 1.08);

        // scanlines
        float scan = 0.92 + 0.08 * sin(uv.y * 900.0 + uTime * 8.0);
        col *= mix(1.0, scan, 0.25 + s * 0.6);

        // analog static noise (edge-weighted)
        float n = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 371.0);
        float edge = smoothstep(0.25, 0.85, length(uv - 0.5) * 1.6);
        float noiseAmt = s * (0.10 + edge * 0.5) + uGlimpse * 0.5;
        col = mix(col, vec3(n), clamp(noiseAmt, 0.0, 0.9));

        // film grain — always on, keeps dark areas alive
        float grain = (hash(uv * 911.0 + fract(uTime * 7.0) * 517.0) - 0.5) * 0.028;
        col += grain;

        // glimpse flash: brief brightness spike
        col += vec3(0.12, 0.13, 0.16) * uGlimpse;

        // peripheral narrowing (vignette tightens with static)
        float vig = smoothstep(1.25 - s * 0.35, 0.35, length(uv - 0.5) * 1.9);
        col *= mix(0.35, 1.0, vig);

        gl_FragColor = vec4(col, 1.0);
      }`, {
      tInput: { value: null }, tBloom: { value: null }, tAO: { value: null },
      uExposure: { value: 1.0 }, uTime: { value: 0 },
      uStatic: { value: 0 }, uGlimpse: { value: 0 }, uDesat: { value: 0.25 },
      uJitter: { value: new THREE.Vector2() },
    });
  }

  resize(canvasW: number, canvasH: number): void {
    this.cw = Math.max(2, canvasW); this.ch = Math.max(2, canvasH);
    const w = Math.max(2, Math.floor(this.cw * this.renderScale));
    const h = Math.max(2, Math.floor(this.ch * this.renderScale));
    if (w === this.w && h === this.h && this.sceneRT) return;
    this.w = w; this.h = h;
    this.disposeTargets();

    this.depthRT = new THREE.DepthTexture(w, h);
    this.depthRT.format = THREE.DepthFormat;
    this.depthRT.type = THREE.UnsignedIntType;

    this.sceneRT = this.makeRT(w, h, { depth: true, depthTexture: this.depthRT });
    this.normalRT = this.makeRT(w, h, { type: THREE.UnsignedByteType });
    this.aoRT = this.enabled.ao ? this.makeRT(Math.floor(w / 2), Math.floor(h / 2), { type: THREE.UnsignedByteType }) : null;

    const bw = Math.max(2, Math.floor(w / 4)), bh = Math.max(2, Math.floor(h / 4));
    this.bloomA = this.makeRT(bw, bh);
    this.bloomB = this.makeRT(bw, bh);

    if (this.enabled.taa) {
      this.taaA = this.makeRT(w, h);
      this.taaB = this.makeRT(w, h);
    }
    this.motionRT = this.makeRT(w, h);
    this.taaHistoryValid = false;
    this.mbPrevValid = false;
  }

  private disposeTargets(): void {
    this.sceneRT?.dispose(); this.normalRT?.dispose(); this.aoRT?.dispose();
    this.bloomA?.dispose(); this.bloomB?.dispose();
    this.taaA?.dispose(); this.taaB?.dispose();
    this.motionRT?.dispose();
  }

  setQuality(spec: QualitySpec): void {
    this.spec = spec;
    this.enabled.taa = spec.taa;
    this.enabled.ao = spec.ao;
    this.enabled.bloom = spec.bloom;
    this.renderScale = Math.min(this.renderScale, spec.tier === 'low' ? 0.85 : 1.0);
    this.maxScale = Math.min(1.0, spec.tier === 'low' ? 0.85 : 1.0);
    this.resize(this.cw, this.ch); // force re-alloc
  }

  /** dynamic resolution: conservative with hysteresis */
  adaptResolution(frameMs: number, now: number): void {
    this.frameCostEma = this.frameCostEma * 0.95 + frameMs * 0.05;
    if (now - this.lastAdjust < 1.5) return;
    if (this.frameCostEma > 19 && this.renderScale > this.minScale) {
      this.renderScale = Math.max(this.minScale, this.renderScale - 0.1);
      this.lastAdjust = now;
      this.resize(this.cw, this.ch);
    } else if (this.frameCostEma < 12 && this.renderScale < this.maxScale) {
      this.renderScale = Math.min(this.maxScale, this.renderScale + 0.05);
      this.lastAdjust = now;
      this.resize(this.cw, this.ch);
    }
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, statics: StaticState, dt: number): void {
    const r = this.renderer;
    if (!this.sceneRT) this.resize(this.cw, this.ch);

    // ---- TAA jitter ----
    if (this.enabled.taa && this.taaA) {
      this.jitterIdx = (this.jitterIdx + 1) % 8;
      const jx = halton(this.jitterIdx + 1, 2) - 0.5;
      const jy = halton(this.jitterIdx + 1, 3) - 0.5;
      this.jitter.set(jx / this.w, jy / this.h);
      camera.setViewOffset(this.w, this.h, jx, jy, this.w, this.h);
    } else {
      camera.clearViewOffset();
    }
    camera.updateMatrixWorld();

    // ---- main scene pass (HDR) ----
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    // ---- normals prepass (view-space) ----
    const oldOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.normalMat;
    r.setRenderTarget(this.normalRT);
    r.render(scene, camera);
    scene.overrideMaterial = oldOverride;

    // ---- AO ----
    if (this.enabled.ao && this.aoRT && this.aoPass) {
      const u = this.aoPass.mesh.material as THREE.ShaderMaterial;
      u.uniforms.tDepth.value = this.depthRT;
      u.uniforms.tNormal.value = this.normalRT.texture;
      (u.uniforms.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      (u.uniforms.uClip.value as THREE.Vector2).set(camera.near, camera.far);
      this.aoPass.render(r, this.aoRT);
    }

    // ---- TAA resolve ----
    let srcTex: THREE.Texture = this.sceneRT.texture;
    if (this.enabled.taa && this.taaA && this.taaB && this.taaPass) {
      const u = this.taaPass.mesh.material as THREE.ShaderMaterial;
      u.uniforms.tCurrent.value = this.sceneRT.texture;
      u.uniforms.tHistory.value = this.taaHistoryValid ? this.taaA.texture : this.sceneRT.texture;
      u.uniforms.tDepth.value = this.depthRT;
      (u.uniforms.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
      this.taaPass.render(r, this.taaB);
      const tmp = this.taaA; this.taaA = this.taaB; this.taaB = tmp;
      this.taaHistoryValid = true;
      srcTex = this.taaA.texture;
    }

    // ---- restrained motion blur (fast turns + fear sway only) ----
    {
      // rotational velocity drives blur amount — ordinary walking stays crisp
      const dYaw = camera.rotation.y - this.lastYaw;
      const dPitch = camera.rotation.x - this.lastPitch;
      this.lastYaw = camera.rotation.y; this.lastPitch = camera.rotation.x;
      const turnRate = Math.abs(dYaw) + Math.abs(dPitch) * 0.6;
      const target = Math.min(0.55, turnRate * 26 + statics.level * 0.12);
      this.mbStrength += (target - this.mbStrength) * Math.min(1, dt * 8);
      if (this.mbStrength > 0.02) {
        const u = this.motionPass.mesh.material as THREE.ShaderMaterial;
        u.uniforms.tCurrent.value = srcTex;
        u.uniforms.tPrev.value = this.motionRT.texture;
        // reprojection: current NDC → previous NDC via inverse VP × prev VP
        this.mbCurr.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const reproj = u.uniforms.uReproj.value as THREE.Matrix4;
        if (this.mbPrevValid) {
          reproj.copy(this.mbCurr).invert().multiply(this.mbPrev);
        } else reproj.identity();
        u.uniforms.uAmount.value = this.mbStrength;
        (u.uniforms.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
        this.motionPass.render(r, this.motionRT);
        srcTex = this.motionRT.texture;
      } else {
        // keep previous frame fresh for reprojection
        this.renderer.setRenderTarget(this.motionRT);
        this.renderer.clear();
      }
      this.mbPrev.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.mbPrevValid = true;
    }

    // ---- bloom ----
    if (this.enabled.bloom) {
      let u = this.bloomBright.mesh.material as THREE.ShaderMaterial;
      u.uniforms.tInput.value = srcTex;
      this.bloomBright.render(r, this.bloomA);
      u = this.bloomBlur.mesh.material as THREE.ShaderMaterial;
      u.uniforms.tInput.value = this.bloomA.texture;
      (u.uniforms.uDir.value as THREE.Vector2).set(1 / this.bloomA.width, 0);
      this.bloomBlur.render(r, this.bloomB);
      u.uniforms.tInput.value = this.bloomB.texture;
      (u.uniforms.uDir.value as THREE.Vector2).set(0, 1 / this.bloomA.height);
      this.bloomBlur.render(r, this.bloomA);
    }

    // ---- exposure adaptation (separate brighten/darken speeds, like eyes) ----
    {
      const speed = this.exposureTarget > this.exposure ? 0.55 : 1.8;
      this.exposure += (this.exposureTarget - this.exposure) * Math.min(1, speed * dt);
    }

    // ---- composite to screen ----
    {
      const u = this.compositePass.mesh.material as THREE.ShaderMaterial;
      u.uniforms.tInput.value = srcTex;
      u.uniforms.tBloom.value = this.enabled.bloom ? this.bloomA.texture : null;
      u.uniforms.tAO.value = this.enabled.ao && this.aoRT ? this.aoRT.texture : null;
      u.uniforms.uExposure.value = this.exposure;
      u.uniforms.uTime.value = statics.time;
      u.uniforms.uStatic.value = statics.level;
      u.uniforms.uGlimpse.value = statics.glimpse;
      u.uniforms.uDesat.value = statics.desat;
      this.compositePass.render(r, null);
    }

    camera.clearViewOffset();
  }

  /** Set the exposure adaptation goal each frame (e.g. higher when the flashlight is on). */
  setExposureGoal(goal: number): void {
    this.exposureTarget = THREE.MathUtils.clamp(goal, 0.35, 2.6);
  }

  invalidateHistory(): void { this.taaHistoryValid = false; this.jitterIdx = 0; this.mbPrevValid = false; this.mbStrength = 0; }

  dispose(): void {
    this.disposeTargets();
    this.aoPass?.dispose(); this.bloomBright.dispose(); this.bloomBlur.dispose();
    this.taaPass?.dispose(); this.motionPass.dispose(); this.compositePass.dispose();
    this.normalMat.dispose();
  }
}
