import * as THREE from 'three';
import { HeightField } from '../world/HeightField';
import { SeededRandom } from '../core/SeededRandom';
import { SoftPoints, RainStreaks } from '../render/Particles';

/**
 * Atmosphere extras: ground fog wisps (drifting, height-falloff), fireflies and
 * rain. All pooled, zero per-frame allocation.
 *
 * Both particle systems used to be `THREE.PointsMaterial` with
 * `sizeAttenuation`, which draws *hard-edged squares* whose pixel size explodes
 * as a particle nears the eye — the same defect that turned flashlight dust
 * into white blocks. Fireflies now go through `SoftPoints` (clamped
 * `gl_PointSize`, radial falloff, near fade) and rain became `RainStreaks`
 * (line segments whose length tracks fall speed), which reads as motion instead
 * of confetti and costs one draw call.
 */
export class Effects {
  private fogMat!: THREE.ShaderMaterial;
  /** All wisps in ONE instanced draw: N meshes -> 1 InstancedMesh. */
  private fogMesh!: THREE.InstancedMesh;
  private fogGeo!: THREE.PlaneGeometry;
  private fogCam = new THREE.Vector3();
  private fireflies!: SoftPoints;
  private ffPos!: Float32Array;
  private ffBase!: Float32Array;
  private ffPhase!: Float32Array;
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

  /** Keep sprite sizing physically correct across resize / FOV change. */
  setProjection(renderHeightPx: number, fovYRadians: number): void {
    this.projH = renderHeightPx;
    this.projFov = fovYRadians;
    this.fireflies?.setProjection(renderHeightPx, fovYRadians);
  }

  /**
   * Fog wisps as ONE instanced draw. The old version made a Mesh per wisp
   * (6–30 draw calls by quality tier) plus a per-frame CPU loop that moved
   * them and toggled `visible` at a hard 130 m ring — visible as wisps
   * popping in/out. Drift now lives in the vertex shader (zero CPU per
   * frame) and the per-wisp distance fade is computed in the fragment
   * shader, so far wisps dissolve instead of snapping. Same look, ~29 fewer
   * draw calls at ultra, and no per-frame JS.
   */
  private buildFog(count: number): void {
    this.fogMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: {
        uTime: { value: 0 },
        uCamPos: { value: this.fogCam },
      },
      vertexShader: `
        varying vec2 vUv;
        varying float vDist;
        attribute float aDrift;
        attribute float aPhase;
        uniform float uTime;
        uniform vec3 uCamPos;
        void main(){
          vUv = uv;
          // drift the instance offset in world space (same sin/cos churn the
          // CPU loop used to apply), then let the instance matrix place it.
          vec4 wp = instanceMatrix * vec4(position, 1.0);
          wp.x += sin(uTime * 0.05 * aDrift + aPhase) * 0.5;
          wp.z += cos(uTime * 0.04 * aDrift + aPhase * 2.0) * 0.4;
          vec4 world = modelMatrix * wp;
          vDist = distance(world.xyz, uCamPos);
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: `
        varying vec2 vUv;
        varying float vDist;
        uniform float uTime;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p){
          vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y);
        }
        void main(){
          vec2 c = vUv - 0.5;
          float r = length(c) * 2.0;
          // two octaves drifting against each other so the sheet churns
          float n = noise(vUv * 5.0 + uTime * 0.05) * 0.6 + noise(vUv * 11.0 - uTime * 0.03) * 0.4;
          float a = (1.0 - smoothstep(0.15, 1.0, r)) * n * 0.14;
          // soft distance dissolve instead of the old 130 m visibility pop
          a *= (1.0 - smoothstep(95.0, 190.0, vDist));
          if (a < 0.002) discard;
          gl_FragColor = vec4(vec3(0.55, 0.62, 0.72) * a, a);   // premultiplied
        }`,
    });
    this.fogGeo = new THREE.PlaneGeometry(26, 26);
    this.fogGeo.rotateX(-Math.PI / 2);

    this.fogMesh = new THREE.InstancedMesh(this.fogGeo, this.fogMat, count);
    this.fogMesh.frustumCulled = false; // wisps span the map; skip per-frame re-cull
    this.fogMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    const drift = new Float32Array(count);
    const phase = new Float32Array(count);
    const dummy = new THREE.Object3D();
    const size = this.hf.layout.size;
    for (let i = 0; i < count; i++) {
      const x = this.rng.range(-size / 2 + 30, size / 2 - 30);
      const z = this.rng.range(-size / 2 + 30, size / 2 - 30);
      dummy.position.set(x, this.hf.heightAt(x, z) + this.rng.range(0.4, 1.4), z);
      dummy.rotation.y = this.rng.range(0, Math.PI);
      dummy.updateMatrix();
      this.fogMesh.setMatrixAt(i, dummy.matrix);
      drift[i] = this.rng.range(0.2, 0.7);
      phase[i] = i; // matches the old `+ i` / `+ i*2` phase offsets
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
    const size = this.hf.layout.size;
    for (let i = 0; i < count; i++) {
      const x = this.rng.range(-size / 2 + 20, size / 2 - 20);
      const z = this.rng.range(-size / 2 + 20, size / 2 - 20);
      this.ffBase[i * 3] = x;
      this.ffBase[i * 3 + 1] = this.hf.heightAt(x, z) + this.rng.range(0.5, 2.5);
      this.ffBase[i * 3 + 2] = z;
      this.ffPhase[i] = this.rng.range(0, Math.PI * 2);
    }
    this.ffPos.set(this.ffBase);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.ffPos, 3));
    this.fireflies = new SoftPoints(geo, {
      color: 0xb8d97a,
      worldSize: 0.035,
      pixelRange: [1.0, 3.5],   // <- the blob clamp
      nearFade: [0.8, 3.0],
      farFade: [45, 80],
      opacity: 0.7,
      falloff: 1.4,
      additive: true,
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
    // Fog drift + distance dissolve run entirely on the GPU now; all we do
    // per frame is push two uniforms.
    this.fogMat.uniforms.uTime.value = time;
    this.fogCam.set(camX, camY, camZ);

    // Fireflies wander around fixed base positions, pulsing out of phase.
    if (this.fireflies.points.visible) {
      const p = this.ffPos, b = this.ffBase;
      for (let i = 0, k = 0; i < p.length; i += 3, k++) {
        const ph = this.ffPhase[k];
        p[i] = b[i] + Math.sin(time * 0.6 + ph) * 1.2;
        p[i + 1] = b[i + 1] + Math.sin(time * 0.9 + ph * 1.7) * 0.5;
        p[i + 2] = b[i + 2] + Math.cos(time * 0.5 + ph * 0.9) * 1.2;
      }
      (this.fireflies.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.fireflies.fade = 0.55 + Math.sin(time * 2.3) * 0.3;
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

