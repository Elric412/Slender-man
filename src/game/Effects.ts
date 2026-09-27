import * as THREE from 'three';
import { HeightField } from '../world/HeightField';
import { SeededRandom } from '../core/SeededRandom';
import { SoftPoints, RainStreaks } from '../render/Particles';

/**
 * Atmosphere extras: ground fog wisps, fireflies and rain. Pooled, zero
 * per-frame allocation, seeded placement.
 *
 * Second-generation changes (same responsibilities, same public API, plus two
 * optional lighting hooks):
 *
 *  Fog wisps
 *   - Density is sampled in WORLD space (xz + slow drift), not UV space, so a
 *     wisp that drifts does not drag its own texture with it and neighbouring
 *     wisps line up into one continuous medium instead of reading as discs.
 *   - Grazing-angle fade: a horizontal sheet seen edge-on is the tell that
 *     exposes a plane. Opacity is scaled by |N·V| (with a floor) so sheets
 *     dissolve as the eye drops to their height.
 *   - Near-camera fade removes the "walking through a decal" pop.
 *   - Vertical softness via a per-vertex height offset (domain-warped), so the
 *     top of the sheet is not a flat cut.
 *   - Lighting: moon ambient term + the SAME flashlight cone the pipeline
 *     uses (cos-outer gate, inverse-square with aperture softening, forward
 *     HG-like lobe). No second beam shape: only the angular gate is shared,
 *     the fine profile lives in the volumetric pass.
 *
 *  Fireflies
 *   - Seeded clusters near damp low ground instead of uniform scatter.
 *   - Per-firefly orbit radius / speed, so no synchronous motion.
 *
 *  Rain
 *   - Unchanged ownership (RainStreaks); budget unchanged.
 */
export class Effects {
  private fogMat!: THREE.ShaderMaterial;
  private fogMesh!: THREE.InstancedMesh;
  private fogGeo!: THREE.PlaneGeometry;
  private fogCam = new THREE.Vector3();
  private fogMoonDir = new THREE.Vector3(0, -1, 0);
  private fogMoonCol = new THREE.Color(0.58, 0.66, 0.85);
  private fogSpotPos = new THREE.Vector3();
  private fogSpotDir = new THREE.Vector3(0, 0, -1);
  private fogSpotCol = new THREE.Color(1, 0.86, 0.66);

  private fireflies!: SoftPoints;
  private ffPos!: Float32Array;
  private ffBase!: Float32Array;
  private ffPhase!: Float32Array;
  private ffRad!: Float32Array;   // per-firefly wander radius
  private ffSpd!: Float32Array;   // per-firefly speed multiplier

  private rain: RainStreaks | null = null;
  rainOn = false;
  private rng = new SeededRandom(0xEF6C7);
  private rainBudget: number;
  private projH = 1080;
  private projFov = Math.PI / 3;

  constructor(private scene: THREE.Scene, private hf: HeightField, fogWispCount: number, particleBudget: number) {
    this.rainBudget = THREE.MathUtils.clamp(Math.round(particleBudget * 0.8), 160, 900);
    this.buildFog(fogWispCount);
    this.buildFireflies(Math.min(220, particleBudget));
  }

  setProjection(renderHeightPx: number, fovYRadians: number): void {
    this.projH = renderHeightPx;
    this.projFov = fovYRadians;
    this.fireflies?.setProjection(renderHeightPx, fovYRadians);
  }

  /** Optional: moon direction (direction light travels) + colour*intensity. */
  setMoonLight(dir: THREE.Vector3, color: THREE.Color, intensity: number): void {
    this.fogMoonDir.copy(dir).normalize();
    this.fogMoonCol.copy(color).multiplyScalar(intensity);
  }

  /**
   * Optional: the flashlight exactly as published to RenderPipeline.setBeam,
   * so wisps light up inside the same cone. `outerAngle` = SpotLight.angle.
   */
  setBeamLight(origin: THREE.Vector3, dir: THREE.Vector3, outerAngle: number,
    color: THREE.Color, intensity: number): void {
    this.fogSpotPos.copy(origin);
    this.fogSpotDir.copy(dir).normalize();
    this.fogSpotCol.copy(color);
    const u = this.fogMat.uniforms;
    u.uSpotCos.value = Math.cos(Math.min(Math.PI * 0.5, outerAngle));
    u.uSpotI.value = Math.max(0, intensity);
  }

  private buildFog(count: number): void {
    this.fogMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, // premultiplied
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: this.fogCam },
        uMoonDir: { value: this.fogMoonDir },
        uMoonCol: { value: this.fogMoonCol },
        uSpotPos: { value: this.fogSpotPos },
        uSpotDir: { value: this.fogSpotDir },
        uSpotCol: { value: this.fogSpotCol },
        uSpotCos: { value: 0.9 },
        uSpotI: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vWorld;
        varying vec3 vNrm;
        varying float vSeed;
        attribute float aDrift;
        attribute float aPhase;
        uniform float uTime;
        void main(){
          vUv = uv;
          vSeed = aPhase;
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          // two-scale drift: slow wander + slower large-scale advection
          float t = uTime * aDrift;
          wp.x += sin(t * 0.05 + aPhase) * 0.5 + t * 0.012;
          wp.z += cos(t * 0.04 + aPhase * 2.0) * 0.4 + t * 0.007;
          // soften the top: centre bulges, rim sinks toward the ground
          vec2 c = uv - 0.5;
          wp.y += (0.35 - dot(c, c) * 1.2) * 0.6;
          vec4 world = modelMatrix * wp;
          vWorld = world.xyz;
          vNrm = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */`
        varying vec2 vUv;
        varying vec3 vWorld;
        varying vec3 vNrm;
        varying float vSeed;
        uniform float uTime;
        uniform vec3 uCamPos;
        uniform vec3 uMoonDir;
        uniform vec3 uMoonCol;
        uniform vec3 uSpotPos;
        uniform vec3 uSpotDir;
        uniform vec3 uSpotCol;
        uniform float uSpotCos;
        uniform float uSpotI;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
                     mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
        }
        void main(){
          vec2 c = vUv - 0.5;
          float r = length(c) * 2.0;
          float edge = 1.0 - smoothstep(0.1, 1.0, r);

          // world-space, domain-warped, two octaves moving against each other
          vec2 p = vWorld.xz * 0.11;
          vec2 warp = vec2(noise(p * 0.7 + uTime * 0.013), noise(p * 0.7 + 17.3 - uTime * 0.011)) - 0.5;
          p += warp * 1.6;
          float n = noise(p + uTime * 0.021) * 0.62 + noise(p * 2.3 - uTime * 0.017) * 0.38;
          float dens = smoothstep(0.28, 0.85, n);

          vec3 toCam = uCamPos - vWorld;
          float dist = length(toCam);
          vec3 V = toCam / max(dist, 1e-3);

          // grazing fade hides the plane; near fade avoids the decal pass-through
          float facing = mix(0.25, 1.0, abs(dot(normalize(vNrm), V)));
          float nearF = smoothstep(1.5, 6.0, dist);
          float farF = 1.0 - smoothstep(95.0, 190.0, dist);

          float a = edge * dens * facing * nearF * farF * 0.13;
          if (a < 0.002) discard;

          // lighting: dim moon ambient + forward-scatter lobe, plus the flashlight cone
          float mu = dot(-V, -uMoonDir);
          vec3 light = uMoonCol * (0.6 + 0.4 * mu * mu) + vec3(0.030, 0.034, 0.042);
          if (uSpotI > 0.0) {
            vec3 L = uSpotPos - vWorld;
            float d2 = max(dot(L, L), 0.04);
            vec3 Ln = L * inversesqrt(d2);
            float cosA = dot(-Ln, uSpotDir);
            float cone = smoothstep(uSpotCos, mix(uSpotCos, 1.0, 0.35), cosA);
            float fwd = 0.35 + 0.65 * pow(max(dot(V, Ln), 0.0), 4.0);
            light += uSpotCol * (uSpotI * cone * fwd / (d2 + 0.72));
          }
          vec3 col = vec3(0.55, 0.62, 0.72) * light;
          gl_FragColor = vec4(col * a, a);
        }`,
    });

    this.fogGeo = new THREE.PlaneGeometry(26, 26, 4, 4);
    this.fogGeo.rotateX(-Math.PI / 2);
    this.fogMesh = new THREE.InstancedMesh(this.fogGeo, this.fogMat, count);
    this.fogMesh.frustumCulled = false;
    this.fogMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const drift = new Float32Array(count);
    const phase = new Float32Array(count);
    const dummy = new THREE.Object3D();
    const size = this.hf.layout.size;
    for (let i = 0; i < count; i++) {
      // bias toward low ground: take the lower of two seeded candidates
      let x = this.rng.range(-size / 2 + 30, size / 2 - 30);
      let z = this.rng.range(-size / 2 + 30, size / 2 - 30);
      const x2 = this.rng.range(-size / 2 + 30, size / 2 - 30);
      const z2 = this.rng.range(-size / 2 + 30, size / 2 - 30);
      if (this.hf.heightAt(x2, z2) < this.hf.heightAt(x, z)) { x = x2; z = z2; }
      dummy.position.set(x, this.hf.heightAt(x, z) + this.rng.range(0.4, 1.4), z);
      dummy.rotation.set(0, this.rng.range(0, Math.PI), 0);
      const s = this.rng.range(0.75, 1.35);
      dummy.scale.set(s, 1, s * this.rng.range(0.7, 1.2));
      dummy.updateMatrix();
      this.fogMesh.setMatrixAt(i, dummy.matrix);
      drift[i] = this.rng.range(0.2, 0.7);
      phase[i] = i;
    }
    this.fogMesh.instanceMatrix.needsUpdate = true;
    this.fogGeo.setAttribute('aDrift', new THREE.InstancedBufferAttribute(drift, 1));
    this.fogGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    this.scene.add(this.fogMesh);
  }

  private buildFireflies(count: number): void {
    this.ffPos = new Float32Array(count * 3);
    this.ffBase = new Float32Array(count * 3);
    this.ffPhase = new Float32Array(count);
    this.ffRad = new Float32Array(count);
    this.ffSpd = new Float32Array(count);
    const size = this.hf.layout.size;
    // seeded clusters: fireflies swarm over damp hollows, not uniformly
    const clusters = Math.max(4, Math.round(count / 18));
    const cx = new Float32Array(clusters), cz = new Float32Array(clusters);
    for (let c = 0; c < clusters; c++) {
      let x = this.rng.range(-size / 2 + 25, size / 2 - 25);
      let z = this.rng.range(-size / 2 + 25, size / 2 - 25);
      const x2 = this.rng.range(-size / 2 + 25, size / 2 - 25);
      const z2 = this.rng.range(-size / 2 + 25, size / 2 - 25);
      if (this.hf.heightAt(x2, z2) < this.hf.heightAt(x, z)) { x = x2; z = z2; }
      cx[c] = x; cz[c] = z;
    }
    for (let i = 0; i < count; i++) {
      const c = i % clusters;
      const ang = this.rng.range(0, Math.PI * 2);
      const rr = Math.sqrt(this.rng.next()) * this.rng.range(4, 11);
      const x = THREE.MathUtils.clamp(cx[c] + Math.cos(ang) * rr, -size / 2 + 20, size / 2 - 20);
      const z = THREE.MathUtils.clamp(cz[c] + Math.sin(ang) * rr, -size / 2 + 20, size / 2 - 20);
      this.ffBase[i * 3] = x;
      this.ffBase[i * 3 + 1] = this.hf.heightAt(x, z) + this.rng.range(0.4, 2.2);
      this.ffBase[i * 3 + 2] = z;
      this.ffPhase[i] = this.rng.range(0, Math.PI * 2);
      this.ffRad[i] = this.rng.range(0.5, 1.5);
      this.ffSpd[i] = this.rng.range(0.6, 1.4);
    }
    this.ffPos.set(this.ffBase);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.ffPos, 3));
    this.fireflies = new SoftPoints(geo, {
      color: 0xb8d97a, worldSize: 0.035, pixelRange: [1.0, 3.5],
      nearFade: [0.8, 3.0], farFade: [45, 80], opacity: 0.7, falloff: 1.4, additive: true,
    });
    this.fireflies.setProjection(this.projH, this.projFov);
    this.scene.add(this.fireflies.points);
  }

  setRain(on: boolean): void {
    if (on === this.rainOn) return;
    this.rainOn = on;
    if (on && !this.rain) {
      this.rain = new RainStreaks(this.rainBudget, 16, 14);
      this.scene.add(this.rain.lines);
    }
    if (this.rain) this.rain.lines.visible = on;
  }

  update(dt: number, time: number, camX: number, camY: number, camZ: number): void {
    this.fogMat.uniforms.uTime.value = time;
    this.fogCam.set(camX, camY, camZ);

    if (this.fireflies.points.visible) {
      const p = this.ffPos, b = this.ffBase;
      for (let i = 0, k = 0; i < p.length; i += 3, k++) {
        const ph = this.ffPhase[k], r = this.ffRad[k], s = this.ffSpd[k];
        p[i] = b[i] + Math.sin(time * 0.6 * s + ph) * r;
        p[i + 1] = b[i + 1] + Math.sin(time * 0.9 * s + ph * 1.7) * 0.45;
        p[i + 2] = b[i + 2] + Math.cos(time * 0.5 * s + ph * 0.9) * r;
      }
      (this.fireflies.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      // two incommensurate slow terms: breathing, never a metronome; rain suppresses them
      const breathe = 0.55 + Math.sin(time * 0.37) * 0.18 + Math.sin(time * 1.13 + 1.7) * 0.1;
      this.fireflies.fade = breathe * (this.rainOn ? 0.35 : 1.0);
    }

    if (this.rain && this.rain.lines.visible) {
      this.rain.update(dt, camX, camY, camZ, 1.6, 0.9);
    }
  }

  dispose(): void {
    this.scene.remove(this.fogMesh);
    this.fogMesh.dispose();
    this.fogGeo.dispose();
    this.fogMat.dispose();
    this.scene.remove(this.fireflies.points);
    this.fireflies.dispose();
    if (this.rain) { this.scene.remove(this.rain.lines); this.rain.dispose(); }
  }
}

