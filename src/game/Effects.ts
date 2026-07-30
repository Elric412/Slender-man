import * as THREE from 'three';
import { HeightField } from '../world/HeightField';
import { SeededRandom } from '../core/SeededRandom';

/**
 * Atmosphere extras: ground fog wisps (drifting, height-falloff), fireflies,
 * and light rain streaks. All pooled, zero per-frame allocation.
 */
export class Effects {
  private fogMat!: THREE.ShaderMaterial;
  private fogChunks: THREE.Mesh[] = [];
  private fireflies!: THREE.Points;
  private ffPos!: Float32Array;
  private ffBase!: Float32Array;
  private rain: THREE.Points | null = null;
  private rainPos: Float32Array | null = null;
  private rainVel: Float32Array | null = null;
  rainOn = false;
  private rng = new SeededRandom(0xEF6C7);
  private count: number;

  constructor(private scene: THREE.Scene, private hf: HeightField, fogWispCount: number, particleBudget: number) {
    this.count = fogWispCount;
    this.buildFog(fogWispCount);
    this.buildFireflies(Math.min(220, particleBudget));
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
          float n = noise(vUv * 5.0 + uTime * 0.05) * 0.6 + noise(vUv * 11.0 - uTime * 0.03) * 0.4;
          float a = smoothstep(1.0, 0.15, r) * n * 0.14;
          gl_FragColor = vec4(vec3(0.55, 0.62, 0.72), a);
        }`,
    });
    const geo = new THREE.PlaneGeometry(26, 26);
    geo.rotateX(-Math.PI / 2);
    const size = this.hf.layout.size;
    for (let i = 0; i < count; i++) {
      const m = new THREE.Mesh(geo, this.fogMat);
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
    const size = this.hf.layout.size;
    for (let i = 0; i < count; i++) {
      const x = this.rng.range(-size / 2 + 20, size / 2 - 20);
      const z = this.rng.range(-size / 2 + 20, size / 2 - 20);
      this.ffBase[i * 3] = x; this.ffBase[i * 3 + 1] = this.hf.heightAt(x, z) + this.rng.range(0.5, 2.5); this.ffBase[i * 3 + 2] = z;
    }
    this.ffPos.set(this.ffBase);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.ffPos, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xb8d97a, size: 0.05, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false });
    this.fireflies = new THREE.Points(geo, mat);
    this.fireflies.frustumCulled = false;
    this.scene.add(this.fireflies);
  }

  setRain(on: boolean): void {
    if (on === this.rainOn) return;
    this.rainOn = on;
    if (on && !this.rain) {
      const count = 500;
      this.rainPos = new Float32Array(count * 3);
      this.rainVel = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        this.rainPos[i * 3] = (this.rng.next() - 0.5) * 30;
        this.rainPos[i * 3 + 1] = this.rng.next() * 14;
        this.rainPos[i * 3 + 2] = (this.rng.next() - 0.5) * 30;
        this.rainVel[i] = 9 + this.rng.next() * 4;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
      const mat = new THREE.PointsMaterial({
        color: 0x9fb4c8, size: 0.06, transparent: true, opacity: 0.4, depthWrite: false });
      this.rain = new THREE.Points(geo, mat);
      this.rain.frustumCulled = false;
      this.scene.add(this.rain);
    }
    if (this.rain) this.rain.visible = on;
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
    // fireflies wander around base positions
    if (this.fireflies.visible) {
      const p = this.ffPos, b = this.ffBase;
      for (let i = 0; i < p.length; i += 3) {
        p[i] = b[i] + Math.sin(time * 0.6 + i) * 1.2;
        p[i + 1] = b[i + 1] + Math.sin(time * 0.9 + i * 1.7) * 0.5;
        p[i + 2] = b[i + 2] + Math.cos(time * 0.5 + i * 0.9) * 1.2;
      }
      (this.fireflies.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      const fm = this.fireflies.material as THREE.PointsMaterial;
      fm.opacity = 0.45 + Math.sin(time * 2.3) * 0.25;
    }
    // rain follows camera
    if (this.rain && this.rain.visible && this.rainPos && this.rainVel) {
      const p = this.rainPos;
      for (let i = 0; i < this.rainVel.length; i++) {
        p[i * 3 + 1] -= this.rainVel[i] * dt;
        if (p[i * 3 + 1] < 0) {
          p[i * 3] = camX + (this.rng.next() - 0.5) * 30;
          p[i * 3 + 1] = 12 + this.rng.next() * 3;
          p[i * 3 + 2] = camZ + (this.rng.next() - 0.5) * 30;
        }
      }
      (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
  }
}
