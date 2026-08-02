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
  private fogChunks: THREE.Mesh[] = [];
  private fogGeo!: THREE.PlaneGeometry;
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

  private buildFog(count: number): void {
    this.fogMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 } },
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec2 vUv; uniform float uTime;
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
          float a = smoothstep(1.0, 0.15, r) * n * 0.14;
          if (a < 0.002) discard;
          gl_FragColor = vec4(vec3(0.55, 0.62, 0.72) * a, a);   // premultiplied
        }`,
    });
    this.fogGeo = new THREE.PlaneGeometry(26, 26);
    this.fogGeo.rotateX(-Math.PI / 2);
    const size = this.hf.layout.size;
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(this.fogGeo, this.fogMat);
      const x = this.rng.range(-size / 2 + 30, size / 2 - 30);
      const z = this.rng.range(-size / 2 + 30, size / 2 - 30);
      m.position.set(x, this.hf.heightAt(x, z) + this.rng.range(0.4, 1.4), z);
      m.rotation.y = this.rng.range(0, Math.PI);
      (m as unknown as { drift: number }).drift = this.rng.range(0.2, 0.7);
      this.fogChunks.push(m);
      this.scene.add(m);
    }
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
    this.fogMat.uniforms.uTime.value = time;
    for (let i = 0; i < this.fogChunks.length; i++) {
      const m = this.fogChunks[i];
      const d = (m as unknown as { drift: number }).drift;
      m.position.x += Math.sin(time * 0.05 * d + i) * dt * 0.5;
      m.position.z += Math.cos(time * 0.04 * d + i * 2) * dt * 0.4;
      // fade with distance — cheap per-chunk visibility
      const dx = m.position.x - camX, dz = m.position.z - camZ;
      m.visible = (dx * dx + dz * dz) < 130 * 130;
    }

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
    for (const m of this.fogChunks) this.scene.remove(m);
    this.fogChunks.length = 0;
    this.fogGeo.dispose();
    this.fogMat.dispose();
    this.scene.remove(this.fireflies.points);
    this.fireflies.dispose();
    if (this.rain) { this.scene.remove(this.rain.lines); this.rain.dispose(); }
  }
}
