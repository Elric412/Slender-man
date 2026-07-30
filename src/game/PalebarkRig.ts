import * as THREE from 'three';
import { MaterialLibrary } from '../world/MaterialLibrary';

/**
 * Palebark — original design. ~2.7m, wrong-proportioned: overlong forearms, narrow head
 * with a pale, near-featureless face plate, a dark garment that reads as bark at distance.
 * Subtle procedural sway so even its stillness is alive.
 */
export class PalebarkRig {
  readonly group = new THREE.Group();
  private torso!: THREE.Mesh;
  private head!: THREE.Mesh;
  private armL!: THREE.Group;
  private armR!: THREE.Group;
  private legL!: THREE.Group;
  private legR!: THREE.Group;
  private walkPhase = 0;

  constructor(mats: MaterialLibrary) {
    const suit = mats.palebarkSuit;
    const skin = mats.palebarkSkin;
    const barkMat = mats.birchBark;

    // torso — long, narrow
    this.torso = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 1.1, 10), suit);
    this.torso.position.y = 1.75;
    // hips
    const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.3, 10), suit);
    hips.position.y = 1.1;

    // bark-plate garment — ragged vertical slats fused over the torso so its
    // silhouette half-reads as a tree at distance. Original design.
    const plateGeo = new THREE.BoxGeometry(0.05, 0.5, 0.015);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const plate = new THREE.Mesh(plateGeo, barkMat);
      const r = 0.2 + Math.sin(i * 2.7) * 0.02;
      plate.position.set(Math.sin(a) * r, 1.55 + Math.sin(i * 1.3) * 0.28, Math.cos(a) * r);
      plate.rotation.y = a;
      plate.rotation.z = Math.sin(i * 3.1) * 0.14;
      plate.scale.y = 0.7 + Math.abs(Math.sin(i * 1.9)) * 0.7;
      this.group.add(plate);
    }
    // shoulder shards — widen the top of the silhouette wrong
    for (const side of [-1, 1]) {
      const shard = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.34, 0.02), barkMat);
      shard.position.set(side * 0.28, 2.28, 0);
      shard.rotation.z = side * 0.75;
      this.group.add(shard);
    }

    // neck + head — too long a neck, small pale face plate
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 0.28, 8), suit);
    neck.position.y = 2.42;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), skin);
    this.head.scale.set(0.82, 1.35, 0.9);
    this.head.position.y = 2.66;
    // faint vertical seam where features should be
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.2, 0.004),
      new THREE.MeshStandardMaterial({ color: 0x8f887c, roughness: 0.6 }));
    seam.position.set(0, 2.66, 0.125);
    // shallow hollows where eyes should be — two matte dimples, not eyes
    for (const side of [-1, 1]) {
      const hollow = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5),
        new THREE.MeshStandardMaterial({ color: 0x9a938a, roughness: 1 }));
      hollow.position.set(side * 0.045, 2.7, 0.115);
      hollow.scale.set(1, 1.4, 0.4);
      this.group.add(hollow);
    }
    this.group.add(this.torso, hips, neck, this.head, seam);

    // arms — shoulder high, forearms overlong, hang past knees
    for (const side of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(side * 0.24, 2.2, 0);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.62, 6), suit);
      upper.position.y = -0.31;
      const elbow = new THREE.Group();
      elbow.position.y = -0.62;
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.78, 6), suit);
      fore.position.y = -0.39;
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), skin);
      hand.scale.set(0.7, 1.5, 0.7);
      hand.position.y = -0.82;
      // long fingers — five, uneven lengths
      for (let f = 0; f < 5; f++) {
        const len = 0.14 + Math.sin(f * 2.1) * 0.05;
        const finger = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.011, len, 4), skin);
        finger.position.set((f - 2) * 0.02, -0.93 - len * 0.4, 0.01);
        finger.rotation.x = 0.15 + f * 0.04;
        finger.rotation.z = (f - 2) * 0.08;
        elbow.add(finger);
      }
      elbow.add(fore, hand);
      shoulder.add(upper, elbow);
      this.group.add(shoulder);
      if (side < 0) this.armL = shoulder; else this.armR = shoulder;
    }

    // legs — long, thin
    for (const side of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(side * 0.11, 1.05, 0);
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.55, 6), suit);
      thigh.position.y = -0.27;
      const knee = new THREE.Group();
      knee.position.y = -0.55;
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.52, 6), suit);
      shin.position.y = -0.26;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.05, 0.22), suit);
      foot.position.set(0, -0.53, 0.05);
      knee.add(shin, foot);
      hip.add(thigh, knee);
      this.group.add(hip);
      if (side < 0) this.legL = hip; else this.legR = hip;
    }

    this.group.traverse(o => {
      if ((o as THREE.Mesh).isMesh) {
        (o as THREE.Mesh).castShadow = true;
        (o as THREE.Mesh).receiveShadow = false;
      }
    });
  }

  /** x,z, ground y, facing yaw, speed — procedural walk/stillness */
  update(dt: number, time: number, x: number, y: number, z: number, yaw: number, speed: number): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;

    const moving = speed > 0.15;
    if (moving) this.walkPhase += dt * speed * 2.4;

    const stride = moving ? 0.5 : 0;
    this.legL.rotation.x = Math.sin(this.walkPhase) * stride;
    this.legR.rotation.x = Math.sin(this.walkPhase + Math.PI) * stride;
    this.armL.rotation.x = Math.sin(this.walkPhase + Math.PI) * stride * 0.55;
    this.armR.rotation.x = Math.sin(this.walkPhase) * stride * 0.55;

    // the wrongness: when still, it doesn't stop — it settles into a barely-perceptible sway
    if (!moving) {
      const sway = Math.sin(time * 0.7) * 0.02 + Math.sin(time * 1.31) * 0.012;
      this.torso.rotation.z = sway;
      this.head.rotation.z = -sway * 2.2;                     // compensating head tilt — unsettling
      this.head.rotation.x = Math.sin(time * 0.43) * 0.05;
      this.armL.rotation.x = Math.sin(time * 0.9) * 0.03;
      this.armR.rotation.x = Math.sin(time * 0.9 + 1.2) * 0.03;
      this.legL.rotation.x = 0; this.legR.rotation.x = 0;
    } else {
      this.torso.rotation.z = 0;
      this.head.rotation.z = Math.sin(this.walkPhase * 0.5) * 0.04;
      this.head.rotation.x = 0.08; // slight downward regard while walking
    }
  }
}
