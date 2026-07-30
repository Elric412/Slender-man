import * as THREE from 'three';
import { HeightField, Zone } from './HeightField';
import { MaterialLibrary } from './MaterialLibrary';
import { CollisionWorld } from '../physics/Collision';
import { VegetationSystem, mergeGeos, patchWindMaterial } from './VegetationSystem';
import { SeededRandom } from '../core/SeededRandom';

export interface TapeSpawn { x: number; y: number; z: number; zoneId: string; }
export interface InteractPoint { x: number; y: number; z: number; zoneId: string; label: string; }

/**
 * Builds the entire hand-authored-feeling map from the fixed world seed:
 * terrain mesh with splat-blended ground, water, eight distinct POI structures,
 * props with seeded variation, trail dressing, colliders, tape spawn pools.
 */
export class MapGenerator {
  readonly group = new THREE.Group();
  readonly veg: VegetationSystem;
  tapePools: Map<string, TapeSpawn[]> = new Map();
  interactables: THREE.Object3D[] = [];
  tapeMeshes: THREE.Object3D[] = [];
  exitGate!: THREE.Object3D;
  private rng: SeededRandom;
  private flappables: { obj: THREE.Object3D; base: number; amp: number; speed: number }[] = [];

  constructor(
    private hf: HeightField,
    private mats: MaterialLibrary,
    private col: CollisionWorld,
    seed: number,
  ) {
    this.rng = new SeededRandom(seed ^ 0x9A17);
    this.buildTerrain();
    this.buildWater();
    this.veg = new VegetationSystem(mats, hf, seed);
    this.group.add(this.veg.group);
    this.registerTrunkColliders();
    this.buildPOIs();
    this.buildTrailDressing();
    this.buildBoundary();
  }

  // ==================== TERRAIN ====================
  private buildTerrain(): void {
    const res = this.hf['res'] as number;
    const size = this.hf.layout.size;
    const geo = new THREE.PlaneGeometry(size, size, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const h = this.hf.heightAt(x, z);
      pos.setY(i, h);
      // color: leaf litter base, mud near trail/lake, moss tint on noise
      const trailD = this.hf.trailDist(x, z);
      const moss = Math.max(0, this.rng.noise2(x * 0.04 + 40, z * 0.04));
      c.setRGB(0.75, 0.72, 0.68);
      if (trailD < 3.2) c.lerp(new THREE.Color(0.55, 0.48, 0.4), 0.6 * (1 - trailD / 3.2));
      if (moss > 0.3) c.lerp(new THREE.Color(0.5, 0.62, 0.45), Math.min(0.5, (moss - 0.3) * 1.4));
      if (this.hf.inLake(x, z)) c.setRGB(0.4, 0.38, 0.34);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    const mat = this.mats.ground.clone();
    mat.vertexColors = true;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);

    // puddles — low-roughness dark discs that catch moon/flashlight
    const pr = this.rng.fork(31337);
    const puddleGeo = new THREE.CircleGeometry(1, 12);
    puddleGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 40; i++) {
      const x = pr.range(-size / 2 + 20, size / 2 - 20);
      const z = pr.range(-size / 2 + 20, size / 2 - 20);
      const trailD = this.hf.trailDist(x, z);
      if (trailD > 14 || this.hf.inLake(x, z)) continue;
      const p = new THREE.Mesh(puddleGeo, this.mats.mudPuddle);
      p.position.set(x, this.hf.heightAt(x, z) + 0.02, z);
      p.scale.set(pr.range(0.6, 2.2), 1, pr.range(0.6, 2.2));
      p.receiveShadow = true;
      this.group.add(p);
    }
  }

  private buildWater(): void {
    const lake = this.hf.layout.lake;
    const geo = new THREE.CircleGeometry(lake.r + 8, 40);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a1218, roughness: 0.08, metalness: 0.55,
      transparent: true, opacity: 0.94, envMapIntensity: 0.8,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      (mat as unknown as { userData: { uTime: { value: number } } }).userData.uTime = shader.uniforms.uTime;
      shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed.y += sin(uTime * 1.2 + position.x * 0.8) * 0.03 + cos(uTime * 0.9 + position.z * 0.6) * 0.03;`);
    };
    const mesh = new THREE.Mesh(geo, mat);
    // waterline sits between the basin floor and the shoreline
    mesh.position.set(lake.x, lake.y + 1.55, lake.z);
    this.group.add(mesh);
    this.flappables.push({ obj: mesh, base: 0, amp: 0, speed: 0 }); // keeps time updated via userData below
    this.waterMat = mat;
  }
  private waterMat: THREE.MeshStandardMaterial | null = null;

  private registerTrunkColliders(): void {
    for (const t of this.veg.trunkPositions) {
      const y = this.hf.heightAt(t.x, t.z);
      // 'entity-block': stops the player, blocks entity nav, but does NOT hard-block LOS —
      // the entity is allowed to be half-seen between trunks (partial visibility is the design goal)
      this.col.addBox({ x: t.x, z: t.z, hx: t.r, hz: t.r, yaw: 0, y0: y - 1, y1: y + 8, kind: 'entity-block' });
    }
  }

  // ==================== POI BUILDERS ====================
  private buildPOIs(): void {
    for (const zn of this.hf.layout.zones) {
      switch (zn.id) {
        case 'station': this.buildStation(zn); break;
        case 'quarry': this.buildQuarry(zn); break;
        case 'tower': this.buildFireTower(zn); break;
        case 'dock': this.buildDock(zn); break;
        case 'mill': this.buildMill(zn); break;
        case 'radio': this.buildRadioTower(zn); break;
        case 'tunnel': this.buildTunnel(zn); break;
        case 'camp': this.buildCampground(zn); break;
      }
    }
    this.buildExit();
  }

  private addBoxMesh(
    w: number, h: number, d: number, mat: THREE.Material,
    x: number, y: number, z: number, yaw = 0, collide: 'wall' | 'obstacle' | 'prop' | null = 'wall',
  ): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.y = yaw;
    m.castShadow = true; m.receiveShadow = true;
    this.group.add(m);
    if (collide) {
      this.col.addBox({ x, z, hx: w / 2, hz: d / 2, yaw, y0: y - h / 2, y1: y + h / 2, kind: collide });
    }
    return m;
  }

  private g(x: number, z: number): number { return this.hf.heightAt(x, z); }

  private tapeSpot(zoneId: string, x: number, z: number, dy = 0.55): void {
    const arr = this.tapePools.get(zoneId) ?? [];
    arr.push({ x, y: this.g(x, z) + dy, z, zoneId });
    this.tapePools.set(zoneId, arr);
  }

  // ---------- 1. Ranger station ----------
  private buildStation(zn: Zone): void {
    const gy = this.g(zn.x, zn.z);
    const yaw = 0.35;
    const cx = zn.x, cz = zn.z;
    const L = (lx: number, lz: number) => ({
      x: cx + lx * Math.cos(yaw) - lz * Math.sin(yaw),
      z: cz + lx * Math.sin(yaw) + lz * Math.cos(yaw),
    });
    // floor platform
    const f = this.addBoxMesh(9, 0.3, 7, this.mats.woodPlank, cx, gy + 0.25, cz, yaw, null);
    this.col.addPlatform({ x: cx, z: cz, hx: 4.5, hz: 3.5, yaw, y: gy + 0.4, step: 0 });
    // walls (with door gap on south)
    const wallH = 2.9;
    const mk = (lx: number, lz: number, w: number, d: number) => {
      const p = L(lx, lz);
      this.addBoxMesh(w, wallH, d, this.mats.woodPlank, p.x, gy + 0.4 + wallH / 2, p.z, yaw, 'wall');
    };
    mk(0, 3.5, 9, 0.25);            // north
    mk(-4.5, 0, 0.25, 7);           // west
    mk(4.5, 0, 0.25, 7);            // east
    mk(-2.8, -3.5, 3.4, 0.25);      // south-left
    mk(2.8, -3.5, 3.4, 0.25);       // south-right (door gap center)
    // roof
    const roof = new THREE.Mesh(new THREE.ConeGeometry(7.4, 2.2, 4), this.mats.metalRust);
    roof.position.set(cx, gy + 0.4 + wallH + 1.1, cz);
    roof.rotation.y = yaw + Math.PI / 4;
    roof.castShadow = true;
    this.group.add(roof);
    // windows (glass + frames) on west/east
    for (const s of [-1, 1]) {
      const p = L(s * 4.45, 0.6);
      const win = this.addBoxMesh(0.1, 1.1, 1.5, this.mats.glass, p.x, gy + 1.9, p.z, yaw, null);
      win.castShadow = false;
    }
    // interior: table, overturned chair, papers, dead flashlight prop, shelf
    const tp = L(1.2, 1.4);
    this.addBoxMesh(1.8, 0.08, 0.9, this.mats.woodPlank, tp.x, gy + 1.15, tp.z, yaw + 0.2, 'prop');
    for (const [dx, dz] of [[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]]) {
      const lp = L(1.2 + dx, 1.4 + dz);
      this.addBoxMesh(0.08, 0.75, 0.08, this.mats.woodRot, lp.x, gy + 0.75, lp.z, yaw, null);
    }
    const ch = L(-1.5, 0.8);
    const chair = this.addBoxMesh(0.5, 0.5, 0.5, this.mats.woodRot, ch.x, gy + 0.65, ch.z, yaw + 1.2, 'prop');
    chair.rotation.z = Math.PI / 2.2; // overturned
    // scattered papers
    for (let i = 0; i < 7; i++) {
      const pp = L(this.rng.range(-3, 3), this.rng.range(-2.4, 2.4));
      const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.36), this.mats.paperMat);
      paper.position.set(pp.x, gy + 0.42 + i * 0.003, pp.z);
      paper.rotation.set(-Math.PI / 2, 0, this.rng.range(0, 6.28));
      this.group.add(paper);
    }
    // porch + steps
    const pp2 = L(0, -4.6);
    this.addBoxMesh(5, 0.25, 2.2, this.mats.woodRot, pp2.x, gy + 0.15, pp2.z, yaw, null);
    // sign
    const sp = L(3.8, -5.2);
    this.addBoxMesh(0.15, 2.2, 0.15, this.mats.woodRot, sp.x, gy + 1.1, sp.z, yaw, 'prop');
    const sign = this.addBoxMesh(1.6, 0.5, 0.06, this.mats.woodPlank, sp.x, gy + 2.1, sp.z, yaw + 0.3, null);
    sign.castShadow = false;
    // tape spawn pool
    const ts1 = L(1.2, 1.4); this.tapeSpot(zn.id, ts1.x, ts1.z, 1.25);       // on table
    const ts2 = L(-3.5, 2.6); this.tapeSpot(zn.id, ts2.x, ts2.z, 0.5);      // corner floor
    const ts3 = L(0, -4.6); this.tapeSpot(zn.id, ts3.x, ts3.z, 0.45);       // porch
    const ts4 = L(3.2, -2.0); this.tapeSpot(zn.id, ts4.x, ts4.z, 0.55);     // outside east
    // ember light inside (dying lantern)
    const lamp = new THREE.PointLight(0xff9a4d, 3.5, 9, 2);
    const lp2 = L(1.2, 1.4);
    lamp.position.set(lp2.x, gy + 1.6, lp2.z);
    this.group.add(lamp);
  }

  // ---------- 2. Quarry ----------
  private buildQuarry(zn: Zone): void {
    const gy = this.g(zn.x, zn.z);
    // rock walls (big displaced blocks forming the cut)
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const rx = zn.x + 16 + Math.sin(ang) * 14, rz = zn.z + Math.cos(ang) * 10;
      const ry = this.g(rx, rz);
      const w = this.rng.range(6, 10), h = this.rng.range(4, 8);
      const rock = new THREE.Mesh(new THREE.BoxGeometry(w, h, 4, 2, 2, 1), this.mats.rock);
      const pa = rock.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let v = 0; v < pa.count; v++) {
        pa.setXYZ(v,
          pa.getX(v) + this.rng.noise2(v * 1.3, i) * 0.6,
          pa.getY(v) + this.rng.noise2(v * 0.9, i + 9) * 0.5,
          pa.getZ(v) + this.rng.noise2(v * 1.1, i + 4) * 0.5);
      }
      rock.geometry.computeVertexNormals();
      rock.position.set(rx, ry + h * 0.2, rz);
      rock.rotation.y = ang;
      rock.castShadow = true; rock.receiveShadow = true;
      this.group.add(rock);
      this.col.addBox({ x: rx, z: rz, hx: w / 2, hz: 2, yaw: ang, y0: ry - 2, y1: ry + h, kind: 'wall' });
    }
    // rusted truck cab
    const tx = zn.x - 6, tz = zn.z + 4, ty = this.g(tx, tz);
    this.addBoxMesh(2.2, 1.6, 1.8, this.mats.metalRust, tx, ty + 1.0, tz, 0.6, 'obstacle');
    this.addBoxMesh(2.0, 0.9, 3.2, this.mats.metalRust, tx - 1.9, ty + 0.7, tz - 1.1, 0.6, 'obstacle');
    const ws = this.addBoxMesh(1.8, 0.7, 0.08, this.mats.glass, tx + 0.4, ty + 1.3, tz + 0.85, 0.6, null);
    ws.castShadow = false;
    for (const [wx, wz] of [[-1, 0.9], [1, 0.9], [-2.6, -0.2], [-1.4, -1.9]]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.3, 10), this.mats.metalRust);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(tx + wx, ty + 0.45, tz + wz);
      this.group.add(wheel);
    }
    // scattered tools & crates
    for (let i = 0; i < 5; i++) {
      const px = zn.x + this.rng.range(-10, 10), pz = zn.z + this.rng.range(-8, 8);
      this.addBoxMesh(this.rng.range(0.5, 1), this.rng.range(0.4, 0.8), this.rng.range(0.5, 1),
        this.rng.next() < 0.5 ? this.mats.woodRot : this.mats.metalRust,
        px, this.g(px, pz) + 0.3, pz, this.rng.range(0, 3), 'prop');
    }
    this.tapeSpot(zn.id, zn.x - 5, zn.z + 5.6, 1.0);
    this.tapeSpot(zn.id, zn.x + 10, zn.z - 4, 0.55);
    this.tapeSpot(zn.id, zn.x - 2, zn.z - 7, 0.55);
    this.tapeSpot(zn.id, zn.x + 15, zn.z + 2, 0.6);
  }

  // ---------- 3. Fire lookout tower ----------
  private buildFireTower(zn: Zone): void {
    const gy = this.g(zn.x, zn.z);
    const legH = 14;
    const mat = this.mats.metalRust;
    // 4 legs, slanted inward
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, legH, 6), mat);
      leg.position.set(zn.x + sx * 1.9, gy + legH / 2, zn.z + sz * 1.9);
      leg.rotation.z = -sx * 0.07; leg.rotation.x = sz * 0.07;
      leg.castShadow = true;
      this.group.add(leg);
      this.col.addBox({ x: zn.x + sx * 1.9, z: zn.z + sz * 1.9, hx: 0.25, hz: 0.25, yaw: 0, y0: gy, y1: gy + legH, kind: 'obstacle' });
    }
    // cross braces
    for (let lvl = 1; lvl <= 3; lvl++) {
      const y = gy + lvl * 3.6;
      const s = 1.9 - lvl * 0.12;
      for (const rot of [0, Math.PI / 2]) {
        const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, s * 2.6, 5), mat);
        brace.position.set(zn.x, y, zn.z);
        brace.rotation.z = Math.PI / 2;
        brace.rotation.y = rot;
        this.group.add(brace);
      }
    }
    // cab
    const cabY = gy + legH;
    this.addBoxMesh(4.4, 0.25, 4.4, this.mats.woodPlank, zn.x, cabY + 0.12, zn.z, 0, null);
    this.col.addPlatform({ x: zn.x, z: zn.z, hx: 2.2, hz: 2.2, yaw: 0, y: cabY + 0.25, step: 0 });
    for (const [lx, lz, w, d] of [[0, 2.1, 4.4, 0.15], [0, -2.1, 4.4, 0.15], [2.1, 0, 0.15, 4.4], [-2.1, 0, 0.15, 4.4]] as const) {
      this.addBoxMesh(w, 1.0, d, this.mats.woodRot, zn.x + lx, cabY + 0.75, zn.z + lz, 0, null);
    }
    // windows band + roof
    this.addBoxMesh(4.4, 0.9, 4.4, this.mats.glass, zn.x, cabY + 1.7, zn.z, 0, null).castShadow = false;
    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.6, 1.4, 4), mat);
    roof.position.set(zn.x, cabY + 2.8, zn.z);
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    this.group.add(roof);
    // ladder (visual rungs + climb platform logic)
    const ladderX = zn.x + 2.35;
    for (let i = 0; i < 16; i++) {
      this.addBoxMesh(0.5, 0.05, 0.05, mat, ladderX, gy + 0.6 + i * 0.85, zn.z, 0, null).castShadow = false;
    }
    this.col.addVaultable({ x: ladderX, z: zn.z, hx: 0.4, hz: 0.4, yaw: 0, topY: cabY + 0.25 });
    // hanging cable
    const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 5, 4), mat);
    cable.position.set(zn.x - 1.8, cabY - 2.5, zn.z + 1.6);
    this.group.add(cable);
    this.flappables.push({ obj: cable, base: 0, amp: 0.12, speed: 1.7 });
    // tape spots: base + cab top
    this.tapeSpot(zn.id, zn.x + 2.3, zn.z + 2.6, 0.55);
    this.tapeSpot(zn.id, zn.x - 2.5, zn.z - 2.4, 0.55);
    this.tapeSpot(zn.id, zn.x, zn.z, legH + 0.4);   // up in the cab — climb to get it
    this.tapeSpot(zn.id, zn.x - 3.2, zn.z + 3.0, 0.55);
  }

  // ---------- 4. Lake dock ----------
  private buildDock(zn: Zone): void {
    const lake = this.hf.layout.lake;
    const gy = this.g(zn.x, zn.z);
    // dock walkway toward lake center
    const dirX = lake.x - zn.x, dirZ = lake.z - zn.z;
    const dl = Math.hypot(dirX, dirZ);
    const nx = dirX / dl, nz = dirZ / dl;
    const yaw = Math.atan2(nx, nz);
    for (let i = 0; i < 7; i++) {
      const px = zn.x + nx * (i * 2 + 1), pz = zn.z + nz * (i * 2 + 1);
      const plank = this.addBoxMesh(1.6, 0.12, 2.1, this.mats.woodRot, px, gy + 0.9 - i * 0.02, pz, yaw, null);
      plank.receiveShadow = true;
    }
    this.col.addPlatform({ x: zn.x + nx * 7, z: zn.z + nz * 7, hx: 1.0, hz: 7.5, yaw, y: gy + 0.96, step: 0 });
    // posts
    for (let i = 0; i < 4; i++) {
      const px = zn.x + nx * (i * 3.5 + 2) + nz * 0.8, pz = zn.z + nz * (i * 3.5 + 2) - nx * 0.8;
      this.addBoxMesh(0.14, 1.6, 0.14, this.mats.woodRot, px, gy + 0.6, pz, yaw, null);
    }
    // half-sunk rowboat
    const bx = zn.x + nx * 12 + nz * 3, bz = zn.z + nz * 12 - nx * 3;
    const boat = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.4, 2.8, 8, 1, false, 0, Math.PI), this.mats.woodRot);
    hull.rotation.z = Math.PI / 2;
    hull.scale.set(1, 1, 0.5);
    boat.add(hull);
    boat.position.set(bx, lake.y + 0.15, bz);
    boat.rotation.set(0.25, yaw + 0.5, 0.12);
    boat.traverse(o => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true; });
    this.group.add(boat);
    this.col.addBox({ x: bx, z: bz, hx: 1.4, hz: 0.8, yaw: yaw + 0.5, y0: lake.y - 0.5, y1: lake.y + 1, kind: 'obstacle' });
    // snapped rope + life vest
    const vest = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.1, 6, 12), this.mats.tentFabric);
    vest.position.set(zn.x + nx * 5 + 0.6, gy + 1.0, zn.z + nz * 5 - 0.4);
    vest.rotation.x = Math.PI / 2;
    this.group.add(vest);
    this.tapeSpot(zn.id, zn.x + nx * 6, zn.z + nz * 6, 1.1);   // on the dock
    this.tapeSpot(zn.id, bx, bz, 0.8);                          // in the boat
    this.tapeSpot(zn.id, zn.x - 3, zn.z + 4, 0.55);
    this.tapeSpot(zn.id, zn.x + 4, zn.z - 3, 0.55);
  }

  // ---------- 5. Logging mill ----------
  private buildMill(zn: Zone): void {
    const gy = this.g(zn.x, zn.z);
    const yaw = -0.5;
    // big open-sided shed
    const W = 14, D = 9, H = 4.5;
    const px = zn.x, pz = zn.z;
    // posts
    for (const [lx, lz] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2], [0, -D / 2], [0, D / 2]] as const) {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const wx = px + lx * c - lz * s, wz = pz + lx * s + lz * c;
      this.addBoxMesh(0.35, H, 0.35, this.mats.woodRot, wx, gy + H / 2, wz, yaw, 'obstacle');
    }
    // back wall + side half-walls
    const bw = { x: px + (D / 2) * Math.sin(yaw), z: pz + (D / 2) * Math.cos(yaw) };
    this.addBoxMesh(W, H - 1, 0.3, this.mats.metalRust, bw.x, gy + H / 2, bw.z, yaw, 'wall');
    // roof — sagging double plane
    const roof = this.addBoxMesh(W + 2, 0.15, D + 2.5, this.mats.metalRust, px, gy + H + 0.3, pz, yaw, null);
    roof.rotation.x = 0.06;
    // saw table + blade
    this.addBoxMesh(4, 0.9, 1.4, this.mats.woodPlank, px, gy + 0.45, pz, yaw, 'obstacle');
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, 0.06, 20), this.mats.metalPaint);
    blade.position.set(px, gy + 1.3, pz);
    blade.rotation.x = Math.PI / 2;
    this.group.add(blade);
    // log stacks
    for (let i = 0; i < 8; i++) {
      const lx = px + this.rng.range(-12, 12), lz = pz + this.rng.range(-10, -6);
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, this.rng.range(3, 6), 8), this.mats.bark);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = this.rng.range(0, 0.6);
      log.position.set(lx, this.g(lx, lz) + 0.4 + (i % 3) * 0.7, lz);
      log.castShadow = true;
      this.group.add(log);
    }
    // crates & tarp (flapping)
    for (let i = 0; i < 6; i++) {
      const cx = px + this.rng.range(-9, 9), cz = pz + this.rng.range(5, 10);
      this.addBoxMesh(this.rng.range(0.6, 1.3), this.rng.range(0.5, 1), this.rng.range(0.6, 1.3),
        this.mats.woodRot, cx, this.g(cx, cz) + 0.35, cz, this.rng.range(0, 3), 'prop');
    }
    const tarpGeo = new THREE.PlaneGeometry(3, 2.4, 6, 5);
    const tarpMat = this.mats.tentFabric.clone();
    patchWindMaterial(tarpMat, 0.5);
    const tarp = new THREE.Mesh(tarpGeo, tarpMat);
    tarp.position.set(px - 5, gy + 2.2, pz + 4);
    tarp.rotation.set(-0.4, yaw, 0);
    tarp.castShadow = true;
    this.group.add(tarp);
    this.flappables.push({ obj: tarp, base: tarp.rotation.x, amp: 0.08, speed: 2.3 });
    this.tapeSpot(zn.id, px, pz, 1.35);                    // on saw table
    this.tapeSpot(zn.id, px + 8, pz + 8, 0.55);
    this.tapeSpot(zn.id, px - 9, pz - 7, 0.55);
    this.tapeSpot(zn.id, px + 3, pz - 8, 0.7);
  }

  // ---------- 6. Radio relay tower ----------
  private buildRadioTower(zn: Zone): void {
    const gy = this.g(zn.x, zn.z);
    const H = 22;
    const mat = this.mats.metalRust;
    // lattice mast
    for (let lvl = 0; lvl < 6; lvl++) {
      const s = 1.6 - lvl * 0.2;
      const y0 = gy + lvl * (H / 6);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, H / 6 + 0.3, 5), mat);
        leg.position.set(zn.x + sx * s, y0 + H / 12, zn.z + sz * s);
        this.group.add(leg);
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(s * 1.35, 0.03, 4, 4), mat);
      ring.rotation.x = Math.PI / 2;
      ring.rotation.z = Math.PI / 4;
      ring.position.set(zn.x, y0, zn.z);
      this.group.add(ring);
    }
    this.col.addBox({ x: zn.x, z: zn.z, hx: 1.8, hz: 1.8, yaw: 0, y0: gy, y1: gy + 2.5, kind: 'obstacle' });
    // dish
    const dish = new THREE.Mesh(new THREE.SphereGeometry(1.2, 12, 8, 0, Math.PI * 2, 0, 0.9), this.mats.metalPaint);
    dish.position.set(zn.x + 1.2, gy + H * 0.6, zn.z);
    dish.rotation.z = -1.2;
    this.group.add(dish);
    // guy wires (visual)
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + 0.4;
      const ax = zn.x + Math.sin(ang) * 9, az = zn.z + Math.cos(ang) * 9;
      const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, Math.hypot(9, H * 0.8), 4), mat);
      wire.position.set((zn.x + ax) / 2, gy + H * 0.4, (zn.z + az) / 2);
      wire.lookAt(ax, gy, az);
      wire.rotateX(Math.PI / 2);
      this.group.add(wire);
      this.col.addBox({ x: ax, z: az, hx: 0.2, hz: 0.2, yaw: 0, y0: gy, y1: gy + 1, kind: 'prop' });
    }
    // equipment shed
    this.addBoxMesh(2.6, 2.2, 2, this.mats.metalPaint, zn.x + 4, gy + 1.1, zn.z + 2, 0.3, 'wall');
    // blinking beacon
    const beacon = new THREE.PointLight(0xff3524, 0, 30, 2);
    beacon.position.set(zn.x, gy + H + 0.5, zn.z);
    this.group.add(beacon);
    this.beacon = beacon;
    this.tapeSpot(zn.id, zn.x + 3.4, zn.z + 4.2, 0.55);
    this.tapeSpot(zn.id, zn.x - 3, zn.z - 3, 0.55);
    this.tapeSpot(zn.id, zn.x + 4, zn.z + 2, 2.5);   // shed roof?? make ground instead
    this.tapePools.get(zn.id)!.pop();
    this.tapeSpot(zn.id, zn.x - 1.5, zn.z + 3.5, 0.55);
    this.tapeSpot(zn.id, zn.x + 6, zn.z - 2, 0.55);
  }
  private beacon: THREE.PointLight | null = null;

  // ---------- 7. Collapsed rail tunnel ----------
  private buildTunnel(zn: Zone): void {
    const gy = this.g(zn.x, zn.z);
    const yaw = 1.2;
    // concrete portal
    this.addBoxMesh(8, 1, 1.4, this.mats.concrete, zn.x, gy + 4.5, zn.z, yaw, 'wall');
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (const side of [-1, 1]) {
      const wx = zn.x + side * 3.5 * c, wz = zn.z + side * 3.5 * s;
      this.addBoxMesh(1.4, 5, 1.4, this.mats.concrete, wx, gy + 2.5, wz, yaw, 'wall');
    }
    // arch
    const arch = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 1.6, 16, 1, false, 0, Math.PI), this.mats.concrete);
    arch.rotation.z = Math.PI / 2;
    arch.rotation.y = yaw + Math.PI / 2;
    arch.position.set(zn.x, gy + 3.2, zn.z);
    arch.castShadow = true;
    this.group.add(arch);
    // collapsed interior: rubble blocking passage
    for (let i = 0; i < 7; i++) {
      const rx = zn.x - s * (i * 0.8 + 1) + this.rng.range(-1.5, 1.5);
      const rz = zn.z + c * (i * 0.8 + 1) + this.rng.range(-1.5, 1.5);
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(this.rng.range(0.5, 1.4), 0), this.mats.rock);
      rock.position.set(rx, gy + this.rng.range(0.2, 1.6), rz);
      rock.castShadow = true;
      this.group.add(rock);
    }
    this.col.addBox({ x: zn.x - s * 3, z: zn.z + c * 3, hx: 2.5, hz: 2.5, yaw, y0: gy, y1: gy + 4, kind: 'wall' });
    // rails leading in
    for (const side of [-0.75, 0.75]) {
      const rail = this.addBoxMesh(0.12, 0.1, 22, this.mats.metalRust,
        zn.x + c * side + s * 8, gy + 0.15, zn.z + s * side - c * 8, yaw, null);
      rail.castShadow = false;
    }
    // old cart
    this.addBoxMesh(1.6, 1, 1, this.mats.metalRust, zn.x + s * 6, gy + 0.7, zn.z - c * 6, yaw + 0.4, 'obstacle');
    this.tapeSpot(zn.id, zn.x - s * 1.5, zn.z + c * 1.5, 0.55);   // just inside the mouth
    this.tapeSpot(zn.id, zn.x + s * 6.8, zn.z - c * 6.8, 1.35);   // on the cart
    this.tapeSpot(zn.id, zn.x + c * 5, zn.z + s * 5, 0.55);
    this.tapeSpot(zn.id, zn.x - c * 5, zn.z - s * 5, 0.55);
  }

  // ---------- 8. Campground ----------
  private buildCampground(zn: Zone): void {
    const gy = this.g(zn.x, zn.z);
    // three tents, one still zipped, one collapsed
    const tentGeo = new THREE.CylinderGeometry(1.3, 1.3, 2.4, 3, 1);
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2 + 0.7;
      const tx = zn.x + Math.sin(ang) * 6, tz = zn.z + Math.cos(ang) * 6;
      const ty = this.g(tx, tz);
      const tentMat = this.mats.tentFabric.clone();
      tentMat.color = new THREE.Color([0x6d6a4e, 0x4e5d6d, 0x6d4e4e][i]);
      patchWindMaterial(tentMat, 0.25);
      const tent = new THREE.Mesh(tentGeo, tentMat);
      tent.rotation.y = this.rng.range(0, 6.28);
      if (i === 2) { tent.rotation.z = Math.PI / 2.3; tent.position.set(tx, ty + 0.5, tz); } // collapsed
      else tent.position.set(tx, ty + 0.9, tz);
      tent.castShadow = true;
      this.group.add(tent);
      this.col.addBox({ x: tx, z: tz, hx: 1.2, hz: 1.2, yaw: 0, y0: ty, y1: ty + 1.6, kind: 'obstacle' });
      this.flappables.push({ obj: tent, base: tent.rotation.x, amp: 0.02, speed: 3.1 + i });
    }
    // cold firepit
    const fx = zn.x, fz = zn.z;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const st = new THREE.Mesh(new THREE.IcosahedronGeometry(0.22, 0), this.mats.rock);
      st.position.set(fx + Math.sin(a) * 0.8, gy + 0.12, fz + Math.cos(a) * 0.8);
      this.group.add(st);
    }
    this.col.addBox({ x: fx, z: fz, hx: 0.8, hz: 0.8, yaw: 0, y0: gy, y1: gy + 0.4, kind: 'prop' });
    // fallen lantern with faint ember
    const ember = new THREE.PointLight(0xff5a22, 1.6, 5, 2);
    ember.position.set(fx + 0.3, gy + 0.3, fz);
    this.group.add(ember);
    this.ember = ember;
    // backpacks & gear
    for (let i = 0; i < 5; i++) {
      const px = zn.x + this.rng.range(-7, 7), pz = zn.z + this.rng.range(-7, 7);
      this.addBoxMesh(0.45, 0.55, 0.3, this.mats.tentFabric, px, this.g(px, pz) + 0.25, pz, this.rng.range(0, 6), 'prop');
    }
    // animal bones (storytelling)
    for (let i = 0; i < 4; i++) {
      const px = zn.x + this.rng.range(-10, 10), pz = zn.z + this.rng.range(-10, 10);
      const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.045, this.rng.range(0.3, 0.6), 5), this.mats.bone);
      bone.rotation.set(Math.PI / 2, 0, this.rng.range(0, 6.28));
      bone.position.set(px, this.g(px, pz) + 0.06, pz);
      this.group.add(bone);
    }
    this.tapeSpot(zn.id, zn.x + 1.2, zn.z + 0.5, 0.5);
    this.tapeSpot(zn.id, zn.x + Math.sin(0.7) * 6, zn.z + Math.cos(0.7) * 6, 0.6); // near tent 1
    this.tapeSpot(zn.id, zn.x - 5, zn.z + 6, 0.55);
    this.tapeSpot(zn.id, zn.x + 6, zn.z - 5, 0.55);
  }
  private ember: THREE.PointLight | null = null;

  // ---------- exit: fire road gate ----------
  private buildExit(): void {
    const e = this.hf.layout.exit;
    const gy = this.g(e.x, e.z);
    // dirt road strip out of the map
    const road = new THREE.Mesh(new THREE.PlaneGeometry(6, 40), this.mats.ground);
    road.rotation.x = -Math.PI / 2;
    road.rotation.z = Math.PI / 2;
    road.position.set(e.x + 10, gy + 0.05, e.z);
    this.group.add(road);
    // gate posts + bar
    this.addBoxMesh(0.25, 1.4, 0.25, this.mats.metalPaint, e.x, gy + 0.7, e.z - 3, 0, 'prop');
    this.addBoxMesh(0.25, 1.4, 0.25, this.mats.metalPaint, e.x, gy + 0.7, e.z + 3, 0, 'prop');
    const bar = this.addBoxMesh(0.12, 0.12, 6, this.mats.metalPaint, e.x, gy + 1.15, e.z, 0, null);
    this.exitGate = bar;
    const sign = this.addBoxMesh(1.4, 0.8, 0.06, this.mats.woodPlank, e.x - 0.4, gy + 1.6, e.z - 3, 0.2, null);
    sign.castShadow = false;
  }

  // ---------- trail dressing ----------
  private buildTrailDressing(): void {
    const t = this.hf.layout.trail;
    // fallen logs as vault obstacles at deliberate chokepoints
    const chokeIdx = [Math.floor(t.length * 0.18), Math.floor(t.length * 0.42), Math.floor(t.length * 0.63), Math.floor(t.length * 0.85)];
    for (const ci of chokeIdx) {
      const p = t[ci];
      const p2 = t[Math.min(ci + 1, t.length - 1)];
      const yaw = Math.atan2(p2.x - p.x, p2.z - p.z) + Math.PI / 2;
      const gy = this.g(p.x, p.z);
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 7, 8), this.mats.bark);
      log.rotation.z = Math.PI / 2;
      log.rotation.y = yaw;
      log.position.set(p.x, gy + 0.35, p.z);
      log.castShadow = true; log.receiveShadow = true;
      this.group.add(log);
      this.col.addVaultable({ x: p.x, z: p.z, hx: 3.5, hz: 0.45, yaw, topY: gy + 0.75 });
      // nav-blocking stub (entity walks around)
      this.col.addBox({ x: p.x, z: p.z, hx: 3.5, hz: 0.45, yaw, y0: gy - 0.5, y1: gy + 0.75, kind: 'obstacle' });
    }
    // footbridge across a gully near lake path
    const bx = -108, bz = 88;
    const gy = this.g(bx, bz);
    const byaw = 0.8;
    for (let i = -3; i <= 3; i++) {
      const c = Math.cos(byaw), s = Math.sin(byaw);
      this.addBoxMesh(2, 0.1, 0.9, this.mats.woodRot, bx + s * i * 0.95, gy + 0.55, bz + c * i * 0.95, byaw, null);
    }
    this.col.addPlatform({ x: bx, z: bz, hx: 1.0, hz: 3.4, yaw: byaw, y: gy + 0.62, step: 0 });
    // scattered shell casings near station (implied "clean-up")
    const st = this.hf.layout.zones[0];
    for (let i = 0; i < 9; i++) {
      const cs = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 5), this.mats.metalPaint);
      cs.position.set(st.x + this.rng.range(-8, 8), 0, st.z + this.rng.range(-8, 8));
      cs.position.y = this.g(cs.position.x, cs.position.z) + 0.03;
      cs.rotation.set(Math.PI / 2, 0, this.rng.range(0, 6));
      this.group.add(cs);
    }
  }

  // ---------- boundary: dense dark treeline ring ----------
  private buildBoundary(): void {
    const half = this.hf.layout.size / 2;
    const ring = this.rng.fork(8888);
    const geo = new THREE.ConeGeometry(2.6, 12, 6);
    geo.translate(0, 5.5, 0);
    const mat = this.mats.foliage.clone();
    mat.color = new THREE.Color(0x202a20);
    const count = 220;
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < count; i++) {
      const side = i % 4;
      const t = (i / count) * 4 % 1;
      let x = 0, z = 0;
      const off = half - 4 - ring.range(0, 10);
      if (side === 0) { x = -half + t * half * 2; z = -off; }
      else if (side === 1) { x = -half + t * half * 2; z = off; }
      else if (side === 2) { x = -off; z = -half + t * half * 2; }
      else { x = off; z = -half + t * half * 2; }
      dummy.position.set(x, this.g(x, z) - 0.3, z);
      dummy.rotation.y = ring.range(0, 6.28);
      dummy.scale.setScalar(ring.range(1.2, 2.2));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  /** ambient animation — tarps, tents, cables, water, beacons */
  update(time: number, windStrength: number): void {
    for (const f of this.flappables) {
      if (f.amp === 0) continue;
      f.obj.rotation.x = f.base + Math.sin(time * f.speed) * f.amp * (0.5 + windStrength);
    }
    if (this.waterMat) {
      const u = (this.waterMat as unknown as { userData: { uTime?: { value: number } } }).userData.uTime;
      if (u) u.value = time;
    }
    if (this.beacon) this.beacon.intensity = (Math.sin(time * 2.2) > 0.92) ? 6 : 0;
    if (this.ember) this.ember.intensity = 1.1 + Math.sin(time * 7.3) * 0.35 + Math.sin(time * 13.7) * 0.2;
  }
}
