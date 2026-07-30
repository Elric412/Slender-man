import * as THREE from 'three';
import { Player } from './Player';

/**
 * Battery flashlight: spotlight with real shadows + volumetric-looking beam cone
 * (additive shader cone, noise-modulated) + dust motes + lens glow on the viewmodel.
 */
export class Flashlight {
  readonly light: THREE.SpotLight;
  readonly target = new THREE.Object3D();
  private beam: THREE.Mesh;
  private beamMat: THREE.ShaderMaterial;
  private dust: THREE.Points;
  private dustGeo: THREE.BufferGeometry;
  on = false;
  battery = 1;
  private flicker = 0;
  private warnedLow = false;
  private dustPos: Float32Array;
  private pool: THREE.PointLight;   // warm ground bounce around the player
  private hf: import('../world/HeightField').HeightField | null = null;

  onToggle: ((on: boolean) => void) | null = null;
  onBatteryLow: (() => void) | null = null;

  constructor(private scene: THREE.Scene, private player: Player, shadowSize: number,
              hf?: import('../world/HeightField').HeightField) {
    this.hf = hf ?? null;
    this.light = new THREE.SpotLight(0xffd9a0, 0, 60, 0.40, 0.5, 1.6);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(shadowSize, shadowSize);
    this.light.shadow.camera.near = 0.3;
    this.light.shadow.camera.far = 60;
    this.light.shadow.bias = -0.002;
    this.light.shadow.normalBias = 0.02;
    this.light.target = this.target;
    scene.add(this.light, this.target);

    // soft near-field fill so the ground right in front isn't a black hole
    this.pool = new THREE.PointLight(0xffcf96, 0, 6.5, 2);
    scene.add(this.pool);

    // volumetric beam cone — apex at origin, widening toward -Z (view direction)
    const beamGeo = new THREE.ConeGeometry(3.0, 15, 16, 8, true);
    beamGeo.rotateX(-Math.PI / 2);        // axis now +Z, apex +Z end
    beamGeo.translate(0, 0, -7.5);        // apex at origin, opening toward -Z
    this.beamMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0 } },
      vertexShader: `
        varying vec2 vUv; varying vec3 vPos;
        void main(){ vUv = uv; vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        varying vec2 vUv; varying vec3 vPos;
        uniform float uTime; uniform float uIntensity;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        void main(){
          float axial = 1.0 - vUv.y;                    // 1 at source, 0 at far end
          float fade = pow(axial, 1.8);
          float edge = smoothstep(0.0, 0.35, vUv.x) * smoothstep(1.0, 0.65, vUv.x);
          float dustN = hash(floor(vec2(vUv.y * 30.0 - uTime * 3.0, vUv.x * 20.0)));
          float sparkle = smoothstep(0.93, 1.0, dustN) * 0.6;
          float a = fade * (0.10 + sparkle) * uIntensity;
          gl_FragColor = vec4(vec3(1.0, 0.86, 0.62) * a, a);
        }`,
    });
    this.beam = new THREE.Mesh(beamGeo, this.beamMat);
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    scene.add(this.beam);

    // dust motes floating in the beam
    const count = 90;
    this.dustPos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.dustPos[i * 3] = (Math.random() - 0.5) * 2;
      this.dustPos[i * 3 + 1] = (Math.random() - 0.5) * 2;
      this.dustPos[i * 3 + 2] = -Math.random() * 12;
    }
    this.dustGeo = new THREE.BufferGeometry();
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    const dustMat = new THREE.PointsMaterial({
      color: 0xffe6b8, size: 0.02, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    this.dust = new THREE.Points(this.dustGeo, dustMat);
    this.dust.visible = false;
    this.dust.frustumCulled = false;
    scene.add(this.dust);
  }

  toggle(): void {
    if (!this.on && this.battery <= 0.005) return; // dead
    this.on = !this.on;
    if (!this.on) { this.light.intensity = 0; this.beam.visible = false; this.dust.visible = false; this.player.setLensGlow(0); }
    this.onToggle?.(this.on);
  }

  private dir = new THREE.Vector3();
  private srcPos = new THREE.Vector3();
  update(dt: number, time: number): void {
    // battery drain while on; slow recovery when off (dynamo-style, limited)
    if (this.on) {
      this.battery = Math.max(0, this.battery - dt / 210); // ~3.5 min per run segment
      if (this.battery < 0.22 && !this.warnedLow) { this.warnedLow = true; this.onBatteryLow?.(); }
      if (this.battery >= 0.22) this.warnedLow = false;
      if (this.battery <= 0) { this.on = false; }
    } else {
      this.battery = Math.min(1, this.battery + dt / 420);
    }
    this.player.setBatteryGauge(this.battery);

    // flicker when low
    let mul = 1;
    if (this.battery < 0.22) {
      this.flicker = Math.sin(time * 47) * Math.sin(time * 31 + 2) > 0.55 ? 0.35 : 1;
      mul = 0.55 + 0.45 * this.flicker * (this.battery / 0.22);
    }

    const active = this.on && this.battery > 0;
    this.light.intensity = active ? 300 * mul : 0;
    this.pool.intensity = active ? 1.5 * mul : 0;
    this.beamMat.uniforms.uIntensity.value = active ? 0.85 * mul : 0;
    this.beamMat.uniforms.uTime.value = time;
    this.beam.visible = active;
    this.dust.visible = active;
    this.player.setLensGlow(active ? 2.4 * mul : 0);

    if (active) {
      // attach to camera
      const cam = this.player.camera;
      cam.getWorldPosition(this.srcPos);
      cam.getWorldDirection(this.dir);
      this.light.position.copy(this.srcPos).addScaledVector(this.dir, 0.2);
      this.light.position.y -= 0.12;
      this.target.position.copy(this.srcPos).addScaledVector(this.dir, 20);
      // near-field bounce pool follows the player's feet
      if (this.hf) {
        this.pool.position.set(
          this.player.pos.x + this.dir.x * 1.5,
          this.hf.heightAt(this.player.pos.x, this.player.pos.z) + 1.1,
          this.player.pos.z + this.dir.z * 1.5);
      } else {
        this.pool.position.copy(this.srcPos).addScaledVector(this.dir, 1.2);
        this.pool.position.y -= 0.8;
      }
      // beam cone aligned with camera (cone opens toward -Z after bake)
      this.beam.position.copy(this.srcPos).addScaledVector(this.dir, 0.3);
      this.beam.quaternion.copy(cam.quaternion);
      // dust drift
      this.dust.position.copy(this.srcPos);
      this.dust.quaternion.copy(cam.quaternion);
      const p = this.dustPos;
      for (let i = 0; i < p.length; i += 3) {
        p[i] += Math.sin(time * 0.7 + i) * dt * 0.05;
        p[i + 1] -= dt * 0.06;
        if (p[i + 1] < -1) p[i + 1] = 1;
      }
      this.dustGeo.getAttribute('position').needsUpdate = true;
    }
  }

  setShadowSize(size: number): void {
    this.light.shadow.mapSize.set(size, size);
    if (this.light.shadow.map) { this.light.shadow.map.dispose(); this.light.shadow.map = null as unknown as THREE.WebGLRenderTarget; }
  }

  dispose(): void {
    this.scene.remove(this.light, this.target, this.pool, this.beam, this.dust);
    this.beam.geometry.dispose();
    this.beamMat.dispose();
    this.dustGeo.dispose();
    (this.dust.material as THREE.Material).dispose();
    this.light.dispose();
  }
}
