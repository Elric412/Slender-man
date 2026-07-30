import * as THREE from 'three';
import { SeededRandom } from '../core/SeededRandom';
import { MaterialLibrary } from './MaterialLibrary';
import { HeightField } from './HeightField';

/**
 * Procedural forest: modular trunk/branch/foliage assemblies — several genuinely different
 * archetypes (healthy pine, leaning pine, dead husk, broadleaf skeleton), instanced in
 * chunks with per-instance scale/rotation/tilt/tint variation. Wind sway is done in a
 * vertex-shader patch so thousands of trees animate at zero CPU cost.
 */

export interface WindState { strength: number; dirX: number; dirZ: number; time: number; }

const windUniforms = {
  uWindTime: { value: 0 },
  uWindStrength: { value: 0.35 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
};

export function patchWindMaterial(mat: THREE.Material, ampMul: number): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windUniforms.uWindTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.uniforms.uWindDir = windUniforms.uWindDir;
    shader.vertexShader = `
      uniform float uWindTime; uniform float uWindStrength; uniform vec2 uWindDir;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec4 wpos = instanceMatrix * vec4(transformed, 1.0);
        #else
          vec4 wpos = modelMatrix * vec4(transformed, 1.0);
        #endif
        float sway = sin(uWindTime * 1.1 + wpos.x * 0.15 + wpos.z * 0.11)
                   + 0.5 * sin(uWindTime * 2.3 + wpos.z * 0.23);
        float hFactor = clamp(position.y * 0.22, 0.0, 1.4);
        transformed.xz += uWindDir * sway * uWindStrength * ${ampMul.toFixed(2)} * hFactor;
      }`);
  };
}

export function updateWind(w: WindState): void {
  windUniforms.uWindTime.value = w.time;
  windUniforms.uWindStrength.value = w.strength;
  windUniforms.uWindDir.value.set(w.dirX, w.dirZ).normalize();
}

interface Archetype {
  geo: THREE.BufferGeometry;
  mat: THREE.MeshStandardMaterial;
  foliage: boolean;
}

export class VegetationSystem {
  readonly group = new THREE.Group();
  private rng: SeededRandom;
  private meshes: THREE.InstancedMesh[] = [];
  /** trunk obstacle positions for collision + LOS soft blocking */
  trunkPositions: { x: number; z: number; r: number }[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();

  constructor(private mats: MaterialLibrary, private hf: HeightField, seed: number) {
    this.rng = new SeededRandom(seed ^ 0xF0E57);
    this.build();
  }

  private build(): void {
    const archetypes: Archetype[] = [
      { geo: this.makePine(false, 0), mat: this.mats.bark, foliage: true },
      { geo: this.makePine(false, 1), mat: this.mats.bark, foliage: true },
      { geo: this.makePine(true, 2), mat: this.mats.barkDead, foliage: true },   // dead husk w/ sparse foliage
      { geo: this.makeBroadleaf(3), mat: this.mats.barkDead, foliage: true },
      { geo: this.makeBirch(4), mat: this.mats.birchBark, foliage: true },        // pale birch — Palebark's camouflage
    ];
    // shared foliage material is baked into merged geometry groups — pine uses two-material merge
    // Instead of geometry groups we build trunk+foliage as a single mesh with vertex colors? Simpler:
    // each archetype geo already merged with its own material index via groups is complex for InstancedMesh.
    // → we separate: archetype geo here is TRUNK only; foliage handled by matched foliage instanced mesh.
    const foliageGeos = [
      this.makePineFoliage(0), this.makePineFoliage(1),
      this.makeDeadTopFoliage(2), this.makeBroadleafFoliage(3),
      this.makeBirchFoliage(4),
    ];

    const size = this.hf.layout.size;
    const half = size / 2;
    const chunk = 70; // meters per chunk
    const nChunks = Math.ceil(size / chunk);

    const placements: { arch: number; x: number; z: number; y: number; s: number; rot: number; tilt: number; tint: number }[][] = [];
    for (let a = 0; a < 5; a++) placements.push([]);

    const lake = this.hf.layout.lake;
    for (let cj = 0; cj < nChunks; cj++) {
      for (let ci = 0; ci < nChunks; ci++) {
        const crng = this.rng.fork(cj * 97 + ci * 13 + 5);
        const cx = -half + ci * chunk, cz = -half + cj * chunk;
        const count = crng.int(36, 58);
        for (let k = 0; k < count; k++) {
          const x = cx + crng.range(2, chunk - 2);
          const z = cz + crng.range(2, chunk - 2);
          // density rules
          const trailD = this.hf.trailDist(x, z);
          if (trailD < 2.6) continue;                       // keep trail walkable
          const zone = this.hf.zoneAt(x, z);
          if (zone && Math.hypot(x - zone.x, z - zone.z) < zone.r * 0.82) continue; // clearings
          if (Math.hypot(x - lake.x, z - lake.z) < lake.r + 4) continue;
          const density = crng.fbm2(x * 0.015, z * 0.015, 3);
          if (density < -0.25 && trailD > 8) continue;      // organic thin patches
          const y = this.hf.heightAt(x, z);
          const slope = Math.abs(this.hf.heightAt(x + 1.5, z) - y) + Math.abs(this.hf.heightAt(x, z + 1.5) - y);
          if (slope > 2.4) continue;                        // cliffs
          // birch clusters — pale stands that break up the pine monoculture
          const birchNoise = crng.fbm2(x * 0.02 + 77, z * 0.02, 2);
          const isBirch = birchNoise > 0.34;
          const dead = !isBirch && crng.next() < 0.16;
          const arch = isBirch ? 4 : dead ? (crng.next() < 0.6 ? 2 : 3) : crng.int(0, 1);
          placements[arch].push({
            arch, x, z, y,
            s: crng.range(0.75, 1.45) * (dead ? crng.range(0.8, 1.2) : 1) * (isBirch ? crng.range(0.7, 1.0) : 1),
            rot: crng.range(0, Math.PI * 2),
            tilt: crng.range(0, 0.09) * crng.sign() + (dead ? crng.range(0, 0.14) : 0) + (isBirch ? crng.range(0, 0.06) : 0),
            tint: crng.range(0.8, 1.15),
          });
        }
      }
    }

    // build instanced meshes
    for (let a = 0; a < 5; a++) {
      const list = placements[a];
      if (list.length === 0) continue;
      const trunkMat = archetypes[a].mat.clone();
      patchWindMaterial(trunkMat, 0.12);
      const trunk = new THREE.InstancedMesh(archetypes[a].geo, trunkMat, list.length);
      trunk.castShadow = true;
      trunk.receiveShadow = true;

      const folGeo = foliageGeos[a];
      const folMat = (a === 2 || a === 3 ? this.mats.foliageDead : a === 4 ? this.mats.foliageDead.clone() : this.mats.foliage).clone();
      if (a === 4) folMat.color = new THREE.Color(0x7d8a62); // pale sage birch leaves
      patchWindMaterial(folMat, 0.55);
      const fol = new THREE.InstancedMesh(folGeo, folMat, list.length);
      fol.castShadow = true;
      fol.receiveShadow = false;

      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        this.dummy.position.set(p.x, p.y - 0.15, p.z);
        this.dummy.rotation.set(p.tilt, p.rot, p.tilt * 0.6);
        this.dummy.scale.setScalar(p.s);
        this.dummy.updateMatrix();
        trunk.setMatrixAt(i, this.dummy.matrix);
        fol.setMatrixAt(i, this.dummy.matrix);
        this.color.setScalar(p.tint);
        trunk.setColorAt(i, this.color);
        fol.setColorAt(i, this.color);
        this.trunkPositions.push({ x: p.x, z: p.z, r: 0.42 * p.s });
      }
      trunk.instanceMatrix.needsUpdate = true;
      fol.instanceMatrix.needsUpdate = true;
      if (trunk.instanceColor) trunk.instanceColor.needsUpdate = true;
      if (fol.instanceColor) fol.instanceColor.needsUpdate = true;
      this.group.add(trunk, fol);
      this.meshes.push(trunk, fol);
    }

    // undergrowth: ferns/brush billboards — merged static geometry in chunks for cheap culling
    this.buildUndergrowth();
  }

  // ---------------- archetype geometry ----------------

  private makePine(sparse: boolean, variant: number): THREE.BufferGeometry {
    const r = this.rng.fork(100 + variant);
    const geos: THREE.BufferGeometry[] = [];
    const h = r.range(11, 16);
    const trunk = new THREE.CylinderGeometry(r.range(0.22, 0.3), r.range(0.4, 0.55), h, 7, 3);
    trunk.translate(0, h / 2, 0);
    geos.push(trunk);
    // bare lower branches
    const branches = sparse ? 4 : r.int(6, 9);
    for (let i = 0; i < branches; i++) {
      const by = r.range(2, h * 0.75);
      const len = r.range(0.8, 2.0) * (1 - by / h * 0.5);
      const b = new THREE.CylinderGeometry(0.03, 0.07, len, 4);
      b.translate(0, len / 2, 0);
      b.rotateZ(r.range(1.1, 1.5));
      b.rotateY(r.range(0, Math.PI * 2));
      b.translate(0, by, 0);
      geos.push(b);
    }
    return mergeGeos(geos);
  }

  private makePineFoliage(variant: number): THREE.BufferGeometry {
    const r = this.rng.fork(200 + variant);
    const geos: THREE.BufferGeometry[] = [];
    const h = variant === 0 ? 13.5 : 12;
    const layers = r.int(4, 6);
    for (let i = 0; i < layers; i++) {
      const t = i / layers;
      const y = h * (0.38 + t * 0.62);
      const rad = (1 - t) * r.range(2.4, 3.1) + 0.3;
      const cone = new THREE.ConeGeometry(rad, r.range(2.2, 3.2), 7, 1, true);
      cone.translate(r.range(-0.2, 0.2), y, r.range(-0.2, 0.2));
      geos.push(cone);
    }
    return mergeGeos(geos);
  }

  private makeDeadTopFoliage(variant: number): THREE.BufferGeometry {
    const r = this.rng.fork(300 + variant);
    const geos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.ConeGeometry(r.range(0.7, 1.3), r.range(1.4, 2.2), 5, 1, true);
      cone.translate(r.range(-0.4, 0.4), r.range(9, 13), r.range(-0.4, 0.4));
      geos.push(cone);
    }
    return mergeGeos(geos);
  }

  private makeBroadleaf(variant: number): THREE.BufferGeometry {
    const r = this.rng.fork(400 + variant);
    const geos: THREE.BufferGeometry[] = [];
    const h = r.range(7, 10);
    const trunk = new THREE.CylinderGeometry(0.25, 0.45, h, 7, 2);
    trunk.translate(0, h / 2, 0);
    geos.push(trunk);
    for (let i = 0; i < 5; i++) {
      const len = r.range(2, 4.5);
      const b = new THREE.CylinderGeometry(0.04, 0.12, len, 5);
      b.translate(0, len / 2, 0);
      b.rotateZ(r.range(0.5, 1.2) * r.sign());
      b.rotateY(r.range(0, Math.PI * 2));
      b.translate(0, h * r.range(0.55, 0.9), 0);
      geos.push(b);
    }
    return mergeGeos(geos);
  }

  private makeBroadleafFoliage(variant: number): THREE.BufferGeometry {
    const r = this.rng.fork(500 + variant);
    const geos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const s = new THREE.SphereGeometry(r.range(0.9, 1.7), 6, 4);
      s.translate(r.range(-2, 2), r.range(6.5, 9.5), r.range(-2, 2));
      geos.push(s);
    }
    return mergeGeos(geos);
  }

  private makeBirch(variant: number): THREE.BufferGeometry {
    const r = this.rng.fork(600 + variant);
    const geos: THREE.BufferGeometry[] = [];
    const h = r.range(8, 12);
    // birch trunks are slim, often slightly curved — two segments with a kink
    const lower = new THREE.CylinderGeometry(0.09, 0.14, h * 0.55, 7, 2);
    lower.translate(0, h * 0.275, 0);
    geos.push(lower);
    const kink = r.range(0.02, 0.1) * r.sign();
    const upper = new THREE.CylinderGeometry(0.05, 0.09, h * 0.5, 7, 2);
    upper.translate(0, h * 0.25, 0);
    upper.rotateZ(kink);
    upper.translate(0, h * 0.55, 0);
    geos.push(upper);
    // sparse thin branches high up
    for (let i = 0; i < 4; i++) {
      const len = r.range(0.8, 1.8);
      const b = new THREE.CylinderGeometry(0.015, 0.035, len, 4);
      b.translate(0, len / 2, 0);
      b.rotateZ(r.range(0.9, 1.4) * r.sign());
      b.rotateY(r.range(0, Math.PI * 2));
      b.translate(0, h * r.range(0.6, 0.9), 0);
      geos.push(b);
    }
    return mergeGeos(geos);
  }

  private makeBirchFoliage(variant: number): THREE.BufferGeometry {
    const r = this.rng.fork(700 + variant);
    const geos: THREE.BufferGeometry[] = [];
    // drooping sparse clusters high on the trunk
    for (let i = 0; i < 5; i++) {
      const s = new THREE.SphereGeometry(r.range(0.5, 1.0), 5, 4);
      s.scale(1, r.range(1.2, 1.8), 1);
      s.translate(r.range(-1.2, 1.2), r.range(6.5, 10), r.range(-1.2, 1.2));
      geos.push(s);
    }
    return mergeGeos(geos);
  }

  private buildUndergrowth(): void {
    const r = this.rng.fork(999);
    const size = this.hf.layout.size, half = size / 2;
    // crossed-quad fern card
    const card = new THREE.PlaneGeometry(1.4, 1.0);
    card.translate(0, 0.45, 0);
    const card2 = card.clone().rotateY(Math.PI / 2);
    const fernGeo = mergeGeos([card, card2]);
    const count = 3200;
    const mat = this.mats.foliageDead.clone();
    patchWindMaterial(mat, 0.4);
    const mesh = new THREE.InstancedMesh(fernGeo, mat, count);
    mesh.receiveShadow = true;
    let placed = 0;
    for (let i = 0; i < count * 3 && placed < count; i++) {
      const x = r.range(-half + 8, half - 8);
      const z = r.range(-half + 8, half - 8);
      if (this.hf.trailDist(x, z) < 2.0) continue;
      const zn = this.hf.zoneAt(x, z);
      if (zn && Math.hypot(x - zn.x, z - zn.z) < zn.r * 0.7) continue;
      if (this.hf.inLake(x, z)) continue;
      const y = this.hf.heightAt(x, z);
      this.dummy.position.set(x, y - 0.05, z);
      this.dummy.rotation.set(0, r.range(0, Math.PI * 2), 0);
      this.dummy.scale.setScalar(r.range(0.5, 1.3));
      this.dummy.updateMatrix();
      mesh.setMatrixAt(placed, this.dummy.matrix);
      this.color.setHSL(0.22 + r.range(-0.05, 0.05), r.range(0.15, 0.35), r.range(0.25, 0.5));
      mesh.setColorAt(placed, this.color);
      placed++;
    }
    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
    this.meshes.push(mesh);

    // dead grass tufts — thin vertical quads for ground texture at close range
    const tuftCard = new THREE.PlaneGeometry(0.5, 0.42);
    tuftCard.translate(0, 0.2, 0);
    const tuftGeo = mergeGeos([tuftCard, tuftCard.clone().rotateY(Math.PI / 2)]);
    const tuftMat = this.mats.foliageDead.clone();
    tuftMat.color = new THREE.Color(0x6e6242);
    patchWindMaterial(tuftMat, 0.3);
    const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, 1400);
    let tp2 = 0;
    for (let i = 0; i < 4200 && tp2 < 1400; i++) {
      const x = r.range(-half + 8, half - 8), z = r.range(-half + 8, half - 8);
      if (this.hf.trailDist(x, z) < 1.4) continue;
      const zn2 = this.hf.zoneAt(x, z);
      if (zn2 && Math.hypot(x - zn2.x, z - zn2.z) < zn2.r * 0.6) continue;
      if (this.hf.inLake(x, z)) continue;
      this.dummy.position.set(x, this.hf.heightAt(x, z) - 0.03, z);
      this.dummy.rotation.set(0, r.range(0, Math.PI * 2), 0);
      this.dummy.scale.setScalar(r.range(0.6, 1.4));
      this.dummy.updateMatrix();
      tufts.setMatrixAt(tp2, this.dummy.matrix);
      this.color.setScalar(r.range(0.7, 1.1));
      tufts.setColorAt(tp2, this.color);
      tp2++;
    }
    tufts.count = tp2;
    tufts.instanceMatrix.needsUpdate = true;
    this.group.add(tufts);
    this.meshes.push(tufts);

    // rocks — instanced icosahedra with noise displacement baked per-arch
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    const posAttr = rockGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < posAttr.count; i++) {
      const vx = posAttr.getX(i), vy = posAttr.getY(i), vz = posAttr.getZ(i);
      const n = r.noise2(vx * 2 + 9, vz * 2 + vy) * 0.25;
      posAttr.setXYZ(i, vx * (1 + n), vy * (1 + n * 0.6), vz * (1 + n));
    }
    rockGeo.computeVertexNormals();
    const rockMat = this.mats.rock;
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 240);
    rocks.castShadow = true; rocks.receiveShadow = true;
    let rp = 0;
    for (let i = 0; i < 900 && rp < 240; i++) {
      const x = r.range(-half + 6, half - 6), z = r.range(-half + 6, half - 6);
      if (this.hf.inLake(x, z)) continue;
      const y = this.hf.heightAt(x, z);
      this.dummy.position.set(x, y - 0.2, z);
      this.dummy.rotation.set(r.range(0, 3), r.range(0, 3), r.range(0, 3));
      this.dummy.scale.set(r.range(0.3, 1.6), r.range(0.25, 1.0), r.range(0.3, 1.6));
      this.dummy.updateMatrix();
      rocks.setMatrixAt(rp, this.dummy.matrix);
      rp++;
    }
    rocks.count = rp;
    rocks.instanceMatrix.needsUpdate = true;
    this.group.add(rocks);
    this.meshes.push(rocks);
  }

  setDrawDistance(camX: number, camZ: number, dist: number): void {
    // cheap per-mesh toggle by distance of bounding sphere center
    for (const m of this.meshes) {
      if (!m.boundingSphere && m.geometry) m.geometry.computeBoundingSphere();
      // instanced meshes span whole map — keep all visible; LOD handled by fog + far plane
      m.visible = true;
    }
  }
}

/** minimal geometry merge (positions/normals/uvs) */
export function mergeGeos(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vTotal = 0, iTotal = 0;
  for (const g of geos) {
    vTotal += g.getAttribute('position').count;
    iTotal += g.getIndex() ? g.getIndex()!.count : g.getAttribute('position').count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = new Uint32Array(iTotal);
  let vOff = 0, iOff = 0;
  for (const g of geos) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    const u = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
    pos.set(p.array as Float32Array, vOff * 3);
    if (n) nrm.set(n.array as Float32Array, vOff * 3);
    if (u) uv.set(u.array as Float32Array, vOff * 2);
    const gi = g.getIndex();
    if (gi) {
      for (let i = 0; i < gi.count; i++) idx[iOff + i] = gi.getX(i) + vOff;
      iOff += gi.count;
    } else {
      for (let i = 0; i < p.count; i++) idx[iOff + i] = i + vOff;
      iOff += p.count;
    }
    vOff += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
