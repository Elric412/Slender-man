import * as THREE from 'three';
import { CollisionWorld } from '../physics/Collision';
import { HeightField } from '../world/HeightField';
import { InputFrame } from '../core/Input';

export type MoveSurface = 'leaf' | 'mud' | 'wood' | 'metal' | 'water' | 'rock';

/**
 * First-person character controller + procedural viewmodel (visible forearm/flashlight).
 * Walk/sprint(stamina)/crouch/vault/lean, head-bob, breathing sway, fear tremor, flinch.
 */
export class Player {
  readonly camera: THREE.PerspectiveCamera;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0; pitch = 0;
  eyeHeight = 1.62;
  private targetEye = 1.62;

  stamina = 1;
  crouched = false;
  grounded = true;
  vaulting = false;
  private vaultT = 0;
  private vaultFrom = new THREE.Vector3();
  private vaultTo = new THREE.Vector3();
  private lean = 0;
  private leanTarget = 0;

  // movement feel
  private bobPhase = 0;
  bobAmount = 0;
  speed2D = 0;
  sprinting = false;
  moving = false;

  // viewmodel
  readonly viewmodel = new THREE.Group();
  private arm!: THREE.Group;
  private flashlightMesh!: THREE.Group;
  private batteryGauge!: THREE.Mesh;
  private vmLag = new THREE.Vector2();
  private tremor = 0;
  private flinchT = 0;
  private vmSprint = 0;

  footstepDistance = 0;
  onFootstep: ((surface: MoveSurface, intensity: number) => void) | null = null;
  onVault: (() => void) | null = null;

  baseFov = 75;
  private fovBoost = 0;

  constructor(private col: CollisionWorld, private hf: HeightField, mats?: import('../world/MaterialLibrary').MaterialLibrary) {
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.08, 900);
    this.buildViewmodel(mats);
  }

  private buildViewmodel(mats?: import('../world/MaterialLibrary').MaterialLibrary): void {
    this.arm = new THREE.Group();
    const sleeveMat = mats?.fabric ?? new THREE.MeshStandardMaterial({ color: 0x2c3134, roughness: 0.85 });
    const gloveMat = new THREE.MeshStandardMaterial({ color: 0x4a4238, roughness: 0.88 });
    const bodyMat = mats?.knurl ?? new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 0.35, metalness: 0.8 });
    const accentMat = new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.5, metalness: 0.6 });

    // ---- right forearm + grip hand (holds the flashlight body) ----
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.06, 0.38, 10), sleeveMat);
    sleeve.rotation.x = Math.PI / 2 - 0.28;
    sleeve.position.set(0.01, -0.035, 0.14);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.012, 6, 12), accentMat);
    cuff.rotation.x = Math.PI / 2 - 0.28;
    cuff.position.set(0.008, -0.018, 0.02);
    // grip hand: palm cupped under the barrel
    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.048, 10, 8), gloveMat);
    palm.scale.set(0.85, 0.72, 1.35);
    palm.position.set(0, 0.028, -0.075);
    // fingers wrapping the barrel (4 stubby capsules on the far side)
    for (let f = 0; f < 4; f++) {
      const finger = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.05, 3, 6), gloveMat);
      finger.rotation.x = Math.PI / 2 + 0.35;
      finger.rotation.z = 0.5;
      finger.position.set(-0.038, 0.032, -0.045 - f * 0.024);
      this.arm.add(finger);
    }
    // thumb on the near side
    const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.045, 3, 6), gloveMat);
    thumb.rotation.x = Math.PI / 2 - 0.4;
    thumb.rotation.z = -0.9;
    thumb.position.set(0.042, 0.045, -0.06);
    this.arm.add(sleeve, cuff, palm, thumb);

    // ---- left wrist (dead watch + sleeve edge, lower-left of frame) ----
    const lwrist = new THREE.Group();
    const lsleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.056, 0.3, 10), sleeveMat);
    lsleeve.rotation.set(Math.PI / 2 - 0.5, 0, 0.5);
    const watchBand = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.011, 6, 14), accentMat);
    watchBand.rotation.set(0.4, 0.5, 0.2);
    const watchFace = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.008, 12), accentMat);
    watchFace.rotation.set(0.4, 0.5, 0.2);
    watchFace.position.y = 0.012;
    // dead face — faint cracked glass glint
    const watchGlass = new THREE.Mesh(new THREE.CircleGeometry(0.017, 12),
      new THREE.MeshStandardMaterial({ color: 0x0c1014, roughness: 0.15, metalness: 0.3 }));
    watchGlass.rotation.set(-Math.PI / 2 + 0.4, 0.5, 0.2);
    watchGlass.position.y = 0.017;
    lwrist.add(lsleeve, watchBand, watchFace, watchGlass);
    lwrist.position.set(-0.29, -0.26, -0.42);
    this.arm.add(lwrist);

    // ---- flashlight ----
    this.flashlightMesh = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.029, 0.17, 32), bodyMat);
    body.rotation.x = Math.PI / 2;
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.029, 0.055, 32), bodyMat);
    head.rotation.x = Math.PI / 2;
    head.position.z = -0.105;
    // reflector ring
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.003, 8, 32),
      new THREE.MeshStandardMaterial({ color: 0x777d85, roughness: 0.2, metalness: 0.9 }));
    ring.position.z = -0.133;
    // tailcap button
    const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.02, 10), accentMat);
    tail.rotation.x = Math.PI / 2;
    tail.position.z = 0.093;
    const lensMat = new THREE.MeshStandardMaterial({
      color: 0xfff2d0, emissive: 0xffdf9e, emissiveIntensity: 0.0, roughness: 0.1 });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.031, 32), lensMat);
    lens.position.z = -0.1335;
    lens.rotation.y = Math.PI;
    this.flashlightMesh.add(body, head, ring, tail, lens);
    // Machined head fins and rubber grip bands catch thin highlights. These
    // are viewmodel-only details; no extra world material or texture atlas.
    const finGeo = new THREE.TorusGeometry(0.033, 0.002, 6, 32);
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.Mesh(finGeo, accentMat);
      fin.position.z = -0.087 - i * 0.012;
      this.flashlightMesh.add(fin);
    }
    const bandGeo = new THREE.TorusGeometry(0.027, 0.0015, 6, 24);
    for (let i = 0; i < 2; i++) {
      const band = new THREE.Mesh(bandGeo, accentMat);
      band.position.z = -0.04 + i * 0.09;
      this.flashlightMesh.add(band);
    }
    const switchButton = new THREE.Mesh(new THREE.SphereGeometry(0.009, 12, 8), accentMat);
    switchButton.scale.set(1, 0.35, 1.3);
    switchButton.position.set(0, 0.028, -0.04);
    this.flashlightMesh.add(switchButton);
    (this.flashlightMesh as unknown as { lensMat: THREE.MeshStandardMaterial }).lensMat = lensMat;
    this.flashlightMesh.position.set(0, 0.055, -0.075);
    this.flashlightMesh.rotation.x = 0.02; // ~matches beam tilt
    this.arm.add(this.flashlightMesh);

    // diegetic battery gauge — tiny emissive sliver on the barrel
    const gaugeMat = new THREE.MeshStandardMaterial({ color: 0x0a0c0a, emissive: 0x3fe07a, emissiveIntensity: 1.4, roughness: 0.5 });
    this.batteryGauge = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.004, 0.07), gaugeMat);
    this.batteryGauge.position.set(0.028, 0.068, -0.02);
    this.arm.add(this.batteryGauge);

    this.viewmodel.add(this.arm);
    this.arm.position.set(0.24, -0.22, -0.35);
    this.viewmodel.traverse(o => { o.frustumCulled = false; if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).castShadow = false; } });
    this.camera.add(this.viewmodel);
  }

  setLensGlow(v: number): void {
    const lm = (this.flashlightMesh as unknown as { lensMat: THREE.MeshStandardMaterial }).lensMat;
    lm.emissiveIntensity = v;
  }

  setBatteryGauge(level: number): void {
    const m = this.batteryGauge.material as THREE.MeshStandardMaterial;
    this.batteryGauge.scale.z = Math.max(0.05, level);
    if (level > 0.5) m.emissive.setHex(0x3fe07a);
    else if (level > 0.22) m.emissive.setHex(0xe0b83f);
    else m.emissive.setHex(0xe04a3f);
  }

  reset(x: number, z: number): void {
    this.pos.set(x, this.hf.heightAt(x, z), z);
    this.vel.set(0, 0, 0);
    this.yaw = Math.atan2(-(0 - x), -(0 - z)); // face map center-ish
    this.pitch = 0;
    this.stamina = 1;
    this.vaulting = false;
    this.crouched = false;
  }

  update(dt: number, inp: InputFrame, fear: number): void {
    // ---- look ----
    this.yaw -= inp.lookDX;
    this.pitch -= inp.lookDY;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));

    // ---- lean ----
    this.leanTarget = inp.lean;
    this.lean += (this.leanTarget - this.lean) * Math.min(1, dt * 8);

    // ---- vault ----
    if (this.vaulting) {
      this.vaultT += dt * 2.2;
      if (this.vaultT >= 1) {
        this.vaulting = false;
        this.pos.copy(this.vaultTo);
      } else {
        const t = this.vaultT;
        this.pos.lerpVectors(this.vaultFrom, this.vaultTo, t);
        this.pos.y = THREE.MathUtils.lerp(this.vaultFrom.y, this.vaultTo.y, t) + Math.sin(t * Math.PI) * 0.55;
      }
      this.applyCamera(dt, fear, inp);
      return;
    }
    if (inp.vaultQueued) {
      const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
      const v = this.col.findVault(this.pos.x, this.pos.z, fx, fz, this.pos.y);
      if (v) {
        this.vaulting = true;
        this.vaultT = 0;
        this.vaultFrom.copy(this.pos);
        // land 1.4m past the obstacle
        this.vaultTo.set(v.x + fx * 1.4, 0, v.z + fz * 1.4);
        this.vaultTo.y = this.col.groundAt(this.vaultTo.x, this.vaultTo.z, this.pos.y + 1);
        // ladder/tall case: vault target is a platform top
        if (v.topY - this.pos.y > 0.9) this.vaultTo.y = Math.max(this.vaultTo.y, v.topY);
        this.onVault?.();
      }
    }

    // ---- crouch ----
    this.crouched = inp.crouch;
    this.targetEye = this.crouched ? 0.95 : 1.62;
    this.eyeHeight += (this.targetEye - this.eyeHeight) * Math.min(1, dt * 10);

    // ---- move ----
    const wantSprint = inp.sprint && inp.moveZ > 0.1 && !this.crouched;
    this.sprinting = wantSprint && this.stamina > 0.02;
    if (this.sprinting) this.stamina = Math.max(0, this.stamina - dt * 0.16);
    else this.stamina = Math.min(1, this.stamina + dt * 0.10);

    const baseSpeed = this.crouched ? 1.6 : this.sprinting ? 6.2 : 3.4;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wx = (inp.moveX * cos - inp.moveZ * sin) * baseSpeed;
    const wz = (-inp.moveX * sin - inp.moveZ * cos) * baseSpeed;
    // accelerate horizontally
    const accel = this.grounded ? 14 : 4;
    this.vel.x += (wx - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wz - this.vel.z) * Math.min(1, accel * dt);

    // integrate
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    const p2 = { x: this.pos.x, z: this.pos.z };
    this.col.resolve(p2, 0.38, this.pos.y, this.eyeHeight + 0.2);
    this.pos.x = p2.x; this.pos.z = p2.z;

    // gravity + ground snap
    const ground = this.col.groundAt(this.pos.x, this.pos.z, this.pos.y);
    this.vel.y -= 18 * dt;
    this.pos.y += this.vel.y * dt;
    if (this.pos.y <= ground) {
      this.pos.y = ground;
      this.vel.y = 0;
      this.grounded = true;
    } else this.grounded = this.pos.y - ground < 0.05;

    // ---- footsteps ----
    this.speed2D = Math.hypot(this.vel.x, this.vel.z);
    this.moving = this.speed2D > 0.4;
    if (this.moving && this.grounded) {
      this.footstepDistance += this.speed2D * dt;
      const stride = this.sprinting ? 2.4 : this.crouched ? 1.4 : 1.9;
      if (this.footstepDistance > stride) {
        this.footstepDistance = 0;
        const surf = this.surfaceHere();
        const intensity = this.sprinting ? 1.0 : this.crouched ? 0.3 : 0.65;
        this.onFootstep?.(surf, intensity);
      }
      this.bobPhase += this.speed2D * dt * (this.sprinting ? 2.6 : 2.2);
      this.bobAmount = Math.min(1, this.bobAmount + dt * 6);
    } else {
      this.bobAmount = Math.max(0, this.bobAmount - dt * 4);
    }

    // fov boost on sprint
    this.fovBoost += ((this.sprinting ? 5 : 0) - this.fovBoost) * Math.min(1, dt * 4);

    // viewmodel lag from look input
    this.vmLag.x += (inp.lookDX * 6 - this.vmLag.x) * Math.min(1, dt * 9);
    this.vmLag.y += (inp.lookDY * 6 - this.vmLag.y) * Math.min(1, dt * 9);
    this.tremor = fear;
    this.flinchT = Math.max(0, this.flinchT - dt * 3);

    this.applyCamera(dt, fear, inp);
  }

  surfaceHere(): MoveSurface {
    const zn = this.hf.zoneAt(this.pos.x, this.pos.z);
    if (this.hf.inLake(this.pos.x, this.pos.z)) return 'water';
    if (zn) {
      // Keyed to the Pinewood landmark ids. The previous list named four zones
      // (station/mill/radio/tunnel) that no longer exist, so those cases were
      // unreachable and the six real landmarks that DO have a hard surface all
      // fell through to leaf litter — the footstep audio disagreed with what
      // the player was visibly standing on.
      switch (zn.id) {
        case 'tower': case 'dock': case 'cabin': case 'shack': case 'camp': return 'wood';
        case 'quarry': case 'rocks': case 'ridge': return 'rock';
        case 'hub': case 'east-trail': case 'west-trail': return 'mud';
      }
    }
    if (this.hf.trailDist(this.pos.x, this.pos.z) < 2.4) return 'mud';
    return 'leaf';
  }

  flinch(): void { this.flinchT = 1; }

  private fwd = new THREE.Vector3();
  private applyCamera(dt: number, fear: number, inp: InputFrame): void {
    const t = performance.now() / 1000;
    // breathing sway
    const breathe = Math.sin(t * (1.4 + fear * 1.6)) * (0.006 + fear * 0.02);
    // head bob
    const bobY = Math.sin(this.bobPhase * 2) * 0.035 * this.bobAmount * (this.crouched ? 0.6 : 1);
    const bobX = Math.cos(this.bobPhase) * 0.02 * this.bobAmount;
    // fear tremor on camera
    const tremX = (Math.sin(t * 13.7) + Math.sin(t * 29.3) * 0.5) * fear * 0.0035;
    const tremY = (Math.cos(t * 17.1) + Math.sin(t * 23.7) * 0.5) * fear * 0.0035;
    // flinch jolt
    const flinch = this.flinchT * this.flinchT;

    // lean offset
    const leanSide = this.lean * 0.42;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);

    this.camera.position.set(
      this.pos.x + bobX * cos + leanSide * cos + tremX,
      this.pos.y + this.eyeHeight + bobY + breathe + tremY - flinch * 0.1,
      this.pos.z - bobX * sin - leanSide * sin);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch + flinch * 0.35 + breathe * 0.4;
    this.camera.rotation.z = this.lean * 0.14 + tremX * 2;
    this.camera.fov = this.baseFov + this.fovBoost - fear * 3;
    this.camera.updateProjectionMatrix();

    // viewmodel: lag + sway + tremor + lower on sprint
    const vm = this.arm;
    const sprintLower = this.sprinting ? 0.06 : 0;
    this.vmSprint += (sprintLower - this.vmSprint) * Math.min(1, dt * 5);
    vm.position.x = 0.24 + this.vmLag.x * 0.05 + Math.cos(this.bobPhase) * 0.008 * this.bobAmount;
    vm.position.y = -0.22 + this.vmSprint + this.vmLag.y * 0.05 + Math.sin(this.bobPhase * 2) * 0.01 * this.bobAmount + breathe * 0.6;
    vm.rotation.z = this.vmLag.x * 0.25 + tremX * 4;
    vm.rotation.x = this.vmLag.y * 0.2 - flinch * 0.5 + this.vmSprint * 1.4;
    // shake scaled by fear
    vm.position.x += Math.sin(t * 31) * fear * 0.006;
    vm.position.y += Math.cos(t * 37) * fear * 0.006;

    this.camera.getWorldDirection(this.fwd);
  }

  get forward(): THREE.Vector3 { return this.fwd; }
  get eyeY(): number { return this.pos.y + this.eyeHeight; }
}
