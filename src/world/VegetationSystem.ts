import * as THREE from 'three';
import { SeededRandom } from '../core/SeededRandom';
import { MaterialLibrary, applyShaderPatch, registerShaderPatch, cloneMaterial } from './MaterialLibrary';
import { HeightField } from './HeightField';
import { makeFernGeometry } from './FernGeometry';

/**
 * Procedural forest + undergrowth, instanced in 70 m chunks with distance culling.
 *
 * Second generation:
 *  - Wind has a slow gust envelope travelling across the map, a per-instance
 *    phase taken from the instance origin (neighbours never move in lockstep),
 *    and a high-frequency leaf flutter weighted by height, so ferns and
 *    crowns flutter while trunks only lean.
 *  - Undergrowth is ecologically placed: ferns cluster in damp hollows and
 *    around trunks, grass tufts line trail edges, rocks gather in scree
 *    patches and sink into the soil, fallen logs lie along the slope.
 *    All driven by seeded fBm, so the layout is deterministic.
 *  - Fern tint varies with wetness proxy (low ground = darker, more saturated).
 *  - Tree archetypes gain more trunk rings and root flare.
 *  - `dispose()` releases every geometry/material this class created.
 */

export interface WindState { strength: number; dirX: number; dirZ: number; time: number; }

const windUniforms = {
  uWindTime: { value: 0 },
  uWindStrength: { value: 0.35 },
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
};

/** Shared GLSL: gust envelope + sway + flutter. `amp` is baked per program. */
const WIND_GLSL = /* glsl */`
  uniform float uWindTime;
  uniform float uWindStrength;
  uniform vec2 uWindDir;
  vec3 windOffset(vec3 wp, vec3 origin, float weight, float amp, float flutter){
    float phase = dot(origin.xz, vec2(0.37, 0.53));
    // slow gust front rolling along the wind direction
    float front = dot(wp.xz, uWindDir) * 0.045 - uWindTime * 0.35;
    float gust = 0.55 + 0.45 * sin(front) * sin(front * 0.37 + 1.3);
    float sway = sin(uWindTime * 1.05 + phase + wp.x * 0.13 + wp.z * 0.097)
               + 0.45 * sin(uWindTime * 2.37 + phase * 1.7 + wp.z * 0.21);
    float flick = sin(uWindTime * 7.3 + dot(wp, vec3(1.7, 2.3, 1.9))) * flutter;
    float s = uWindStrength * amp * weight * gust;
    vec3 off = vec3(uWindDir.x, 0.0, uWindDir.y) * sway * s;
    off += vec3(0.3, 1.0, 0.25) * flick * s * 0.35;
    off.y -= abs(sway) * s * 0.12;
    return off;
  }
`;

export function patchWindMaterial(mat: THREE.Material, ampMul: number, flutter = 0): void {
  const amp = ampMul.toFixed(2);
  const fl = flutter.toFixed(2);
  const key = registerShaderPatch(`wind:${amp}:${fl}`, () => (shader) => {
    shader.uniforms.uWindTime = windUniforms.uWindTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.uniforms.uWindDir = windUniforms.uWindDir;
    shader.vertexShader = WIND_GLSL + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec3 wpos = (instanceMatrix * vec4(transformed, 1.0)).xyz;
          vec3 org = instanceMatrix[3].xyz;
        #else
          vec3 wpos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vec3 org = modelMatrix[3].xyz;
        #endif
        float hFactor = clamp(position.y * 0.22, 0.0, 1.4);
        transformed += windOffset(wpos, org, hFactor * hFactor, ${amp}, ${fl});
      }`);
  });
  applyShaderPatch(mat, key);
}

export function patchForestWind(mat: THREE.Material, ampMul: number): void {
  const amp = ampMul.toFixed(2);
  const key = registerShaderPatch(`fwind:${amp}`, () => (shader) => {
    shader.uniforms.uWindTime = windUniforms.uWindTime;
    shader.uniforms.uWindStrength = windUniforms.uWindStrength;
    shader.uniforms.uWindDir = windUniforms.uWindDir;
    shader.vertexShader = 'attribute float aSway;\n' + WIND_GLSL + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec3 wp = (instanceMatrix * vec4(transformed, 1.0)).xyz;
          vec3 org = instanceMatrix[3].xyz;
        #else
          vec3 wp = transformed;
          vec3 org = vec3(floor(transformed.x * 0.25), 0.0, floor(transformed.z * 0.25));
        #endif
        float w = aSway * aSway;
        transformed += windOffset(wp, org, w, ${amp}, aSway * 0.6);
      }`);
  });
  applyShaderPatch(mat, key);
}

export function updateWind(w: WindState): void {
  windUniforms.uWindTime.value = w.time;
  windUniforms.uWindStrength.value = w.strength;
  windUniforms.uWindDir.value.set(w.dirX, w.dirZ).normalize();
}

interface Archetype { geo: THREE.BufferGeometry; mat: THREE.MeshStandardMaterial; foliage: boolean; }
type Placement = { arch: number; x: number; z: number; y: number; s: number; rot: number; tilt: number; tint: number };

const CHUNK = 70;

export class VegetationSystem {
  readonly group = new THREE.Group();
  private rng: SeededRandom;
  private meshes: THREE.InstancedMesh[] = [];
  private meshChunkX: number[] = [];
  private meshChunkZ: number[] = [];
  /** trunk obstacle positions for collision + LOS soft blocking */
  trunkPositions: { x: number; z: number; r: number }[] = [];
  private dummy = new THREE.Object3D();
  private color = new THREE.Color();
  private ownedGeos: THREE.BufferGeometry[] = [];
  private ownedMats: THREE.Material[] = [];

  private registerChunk(m: THREE.InstancedMesh, ck: number, nChunks: number, chunk: number, half: number): void {
    const ci = ck % nChunks, cj = Math.floor(ck / nChunks);
    this.meshChunkX[this.meshes.length] = -half + ci * chunk + chunk / 2;
    this.meshChunkZ[this.meshes.length] = -half + cj * chunk + chunk / 2;
  }

  private ownGeo<T extends THREE.BufferGeometry>(g: T): T { this.ownedGeos.push(g); return g; }
  private ownMat<T extends THREE.Material>(m: T): T { this.ownedMats.push(m); return m; }

  constructor(
    private mats: MaterialLibrary,
    private hf: HeightField,
    seed: number,
    private opts: { trees?: boolean } = {},
  ) {
    this.rng = new SeededRandom(seed ^ 0xF0E57);
    this.build();
  }

  private build(): void {
    if (this.opts.trees === false) { this.buildUndergrowth(); return; }

    const archetypes: Archetype[] = [
      { geo: this.ownGeo(this.makePine(false, 0)), mat: this.mats.bark, foliage: true },
      { geo: this.ownGeo(this.makePine(false, 1)), mat: this.mats.bark, foliage: true },
      { geo: this.ownGeo(this.makePine(true, 2)), mat: this.mats.barkDead, foliage: true },
      { geo: this.ownGeo(this.makeBroadleaf(3)), mat: this.mats.barkDead, foliage: true },
      { geo: this.ownGeo(this.makeBirch(4)), mat: this.mats.birchBark, foliage: true },
    ];
    const foliageGeos = [
      this.ownGeo(this.makePineFoliage(0)), this.ownGeo(this.makePineFoliage(1)),
      this.ownGeo(this.makeDeadTopFoliage(2)), this.ownGeo(this.makeBroadleafFoliage(3)),
      this.ownGeo(this.makeBirchFoliage(4)),
    ];

    const size = this.hf.layout.size, half = size / 2;
    const nChunks = Math.ceil(size / CHUNK);
    const placements: Map<number, Placement[]>[] = [];
    for (let a = 0; a < 5; a++) placements.push(new Map());
    const chunkKey = (x: number, z: number) =>
      Math.floor((x + half) / CHUNK) + Math.floor((z + half) / CHUNK) * nChunks;
    const lake = this.hf.layout.lake;

    for (let cj = 0; cj < nChunks; cj++) {
      for (let ci = 0; ci < nChunks; ci++) {
        const crng = this.rng.fork(cj * 97 + ci * 13 + 5);
        const cx = -half + ci * CHUNK, cz = -half + cj * CHUNK;
        const count = crng.int(36, 58);
        for (let k = 0; k < count; k++) {
          const x = cx + crng.range(2, CHUNK - 2);
          const z = cz + crng.range(2, CHUNK - 2);
          const trailD = this.hf.trailDist(x, z);
          if (trailD < 2.6) continue;
          const zone = this.hf.zoneAt(x, z);
          if (zone && Math.hypot(x - zone.x, z - zone.z) < zone.r * 0.82) continue;
          if (Math.hypot(x - lake.x, z - lake.z) < lake.r + 4) continue;
          const density = crng.fbm2(x * 0.015, z * 0.015, 3);
          if (density < -0.25 && trailD > 8) continue;
          const y = this.hf.heightAt(x, z);
          const slope = Math.abs(this.hf.heightAt(x + 1.5, z) - y) + Math.abs(this.hf.heightAt(x, z + 1.5) - y);
          if (slope > 2.4) continue;
          const isBirch = crng.fbm2(x * 0.02 + 77, z * 0.02, 2) > 0.34;
          const dead = !isBirch && crng.next() < 0.16;
          const arch = isBirch ? 4 : dead ? (crng.next() < 0.6 ? 2 : 3) : crng.int(0, 1);
          const ck = chunkKey(x, z);
          let bucket = placements[arch].get(ck);
          if (!bucket) { bucket = []; placements[arch].set(ck, bucket); }
          bucket.push({
            arch, x, z, y,
            s: crng.range(0.75, 1.45) * (dead ? crng.range(0.8, 1.2) : 1) * (isBirch ? crng.range(0.7, 1.0) : 1),
            rot: crng.range(0, Math.PI * 2),
            tilt: crng.range(0, 0.09) * crng.sign() + (dead ? crng.range(0, 0.14) : 0) + (isBirch ? crng.range(0, 0.06) : 0),
            tint: crng.range(0.8, 1.15),
          });
        }
      }
    }

    for (let a = 0; a < 5; a++) {
      const trunkMat = this.ownMat(cloneMaterial(archetypes[a].mat));
      patchWindMaterial(trunkMat, 0.12);
      const folMat = this.ownMat(cloneMaterial(a >= 2 ? this.mats.foliageDead : this.mats.foliage));
      if (a === 4) folMat.color = new THREE.Color(0x7d8a62);
      patchWindMaterial(folMat, 0.55, 0.5);
      const folGeo = foliageGeos[a];
      for (const [ck, list] of placements[a]) {
        if (list.length === 0) continue;
        const trunk = new THREE.InstancedMesh(archetypes[a].geo, trunkMat, list.length);
        trunk.castShadow = true; trunk.receiveShadow = true;
        const fol = new THREE.InstancedMesh(folGeo, folMat, list.length);
        fol.castShadow = true; fol.receiveShadow = false;
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
        this.finishMesh(trunk, ck, nChunks, half);
        this.finishMesh(fol, ck, nChunks, half);
      }
    }
    this.buildUndergrowth();
  }

  private finishMesh(m: THREE.InstancedMesh, ck: number, nChunks: number, half: number): void {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    this.registerChunk(m, ck, nChunks, CHUNK, half);
    this.group.add(m);
    this.meshes.push(m);
  }

  // ---------------- archetype geometry ----------------

  /** Trunk with root flare: bottom ring pushed out, lobed. */
  private flaredTrunk(rTop: number, rBot: number, h: number, segs: number, rings: number, r: SeededRandom): THREE.BufferGeometry {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, segs, rings);
    g.translate(0, h / 2, 0);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const lobes = r.int(3, 5), ph = r.range(0, Math.PI * 2);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const flare = Math.exp(-y / 0.7) * 0.55;
      const ang = Math.atan2(z, x);
      const lobe = 1 + flare * (0.6 + 0.4 * Math.cos(ang * lobes + ph));
      const wob = 1 + r.noise1(y * 0.9 + ang) * 0.04;
      pos.setXYZ(i, x * lobe * wob, y, z * lobe * wob);
    }
    g.computeVertexNormals();
    return g;
  }

  private makePine(sparse: boolean, variant: number): THREE.BufferGeometry {
    const r = this.rng.fork(100 + variant);
    const geos: THREE.BufferGeometry[] = [];
    const h = r.range(11, 16);
    geos.push(this.flaredTrunk(r.range(0.2, 0.28), r.range(0.4, 0.55), h, 9, 8, r));
    const branches = sparse ? 5 : r.int(7, 11);
    for (let i = 0; i < branches; i++) {
      const by = r.range(2, h * 0.75);
      const len = r.range(0.8, 2.0) * (1 - (by / h) * 0.5);
      const b = new THREE.CylinderGeometry(0.02, 0.07, len, 4);
      b.translate(0, len / 2, 0);
      b.rotateZ(r.range(1.1, 1.6));
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
    const layers = r.int(6, 8);
    for (let i = 0; i < layers; i++) {
      const t = i / layers;
      const y = h * (0.36 + t * 0.64);
      const rad = (1 - t) * r.range(2.3, 3.1) + 0.3;
      const cone = new THREE.ConeGeometry(rad, r.range(1.8, 2.8), 9, 2, true);
      // droop the rim so tiers read as hanging boughs, not lampshades
      const p = cone.getAttribute('position') as THREE.BufferAttribute;
      for (let k = 0; k < p.count; k++) {
        const px = p.getX(k), pz = p.getZ(k);
        const rr = Math.hypot(px, pz) / rad;
        const jag = 1 + r.noise1(Math.atan2(pz, px) * 3 + i) * 0.18;
        p.setXYZ(k, px * jag, p.getY(k) - rr * rr * 0.35, pz * jag);
      }
      cone.computeVertexNormals();
      cone.rotateY(r.range(0, Math.PI * 2));
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
    geos.push(this.flaredTrunk(0.25, 0.45, h, 8, 5, r));
    for (let i = 0; i < 6; i++) {
      const len = r.range(2, 4.5);
      const b = new THREE.CylinderGeometry(0.03, 0.12, len, 5);
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
    for (let i = 0; i < 7; i++) {
      const s = new THREE.IcosahedronGeometry(r.range(0.9, 1.7), 1);
      s.scale(1, r.range(0.7, 1.0), 1);
      s.translate(r.range(-2, 2), r.range(6.5, 9.5), r.range(-2, 2));
      geos.push(s);
    }
    return mergeGeos(geos);
  }

  private makeBirch(variant: number): THREE.BufferGeometry {
    const r = this.rng.fork(600 + variant);
    const geos: THREE.BufferGeometry[] = [];
    const h = r.range(8, 12);
    const lower = new THREE.CylinderGeometry(0.09, 0.14, h * 0.55, 8, 3);
    lower.translate(0, h * 0.275, 0);
    geos.push(lower);
    const upper = new THREE.CylinderGeometry(0.05, 0.09, h * 0.5, 8, 3);
    upper.translate(0, h * 0.25, 0);
    upper.rotateZ(r.range(0.02, 0.1) * r.sign());
    upper.translate(0, h * 0.55, 0);
    geos.push(upper);
    for (let i = 0; i < 5; i++) {
      const len = r.range(0.8, 1.8);
      const b = new THREE.CylinderGeometry(0.012, 0.035, len, 4);
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
    for (let i = 0; i < 6; i++) {
      const s = new THREE.IcosahedronGeometry(r.range(0.5, 1.0), 1);
      s.scale(1, r.range(1.2, 1.8), 1);
      s.translate(r.range(-1.2, 1.2), r.range(6.5, 10), r.range(-1.2, 1.2));
      geos.push(s);
    }
    return mergeGeos(geos);
  }

  // ---------------- undergrowth ----------------

  /** Low ground relative to a 6 m neighbourhood → 0..1 dampness proxy. */
  private hollow(x: number, z: number): number {
    const y = this.hf.heightAt(x, z);
    const avg = (this.hf.heightAt(x + 6, z) + this.hf.heightAt(x - 6, z) +
      this.hf.heightAt(x, z + 6) + this.hf.heightAt(x, z - 6)) * 0.25;
    return THREE.MathUtils.clamp((avg - y) * 1.2 + 0.5, 0, 1);
  }

  private buildUndergrowth(): void {
    const r = this.rng.fork(999);
    const size = this.hf.layout.size, half = size / 2;
    const nChunks = Math.ceil(size / CHUNK);

    const fernGeo = this.ownGeo(makeFernGeometry());
    const fernMat = this.ownMat(cloneMaterial(this.mats.foliage));
    fernMat.map = null; fernMat.alphaMap = null; fernMat.alphaTest = 0;
    fernMat.side = THREE.DoubleSide; fernMat.roughness = 0.72;
    patchWindMaterial(fernMat, 0.4, 0.8);

    const tuftCard = new THREE.PlaneGeometry(0.5, 0.42, 1, 2);
    tuftCard.translate(0, 0.2, 0);
    const tuftGeo = this.ownGeo(mergeGeos([
      tuftCard,
      tuftCard.clone().rotateY(Math.PI / 3),
      tuftCard.clone().rotateY(-Math.PI / 3),
    ]));
    tuftCard.dispose();
    const tuftMat = this.ownMat(cloneMaterial(this.mats.foliageDead));
    tuftMat.color = new THREE.Color(0x6e6242);
    tuftMat.side = THREE.DoubleSide;
    patchWindMaterial(tuftMat, 0.3, 1.0);

    const rockGeo = this.ownGeo(new THREE.IcosahedronGeometry(1, 2));
    {
      const pa = rockGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) {
        const vx = pa.getX(i), vy = pa.getY(i), vz = pa.getZ(i);
        const n = r.noise2(vx * 2 + 9, vz * 2 + vy) * 0.25;
        const strata = Math.sin(vy * 13 + vx * 2.4) * 0.045;
        // flatten the top slightly: weathered boulders sit, they don't balance
        const top = vy > 0.4 ? 1 - (vy - 0.4) * 0.35 : 1;
        pa.setXYZ(i, vx * (1 + n + strata), Math.max(-0.7, vy * (0.8 + n * 0.6) * top), vz * (1 + n - strata));
      }
      rockGeo.computeVertexNormals();
    }

    // fallen logs: bark cylinder with broken ends
    const logGeo = this.ownGeo(new THREE.CylinderGeometry(0.22, 0.28, 1, 8, 3, false));
    {
      const pa = logGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
        const w = 1 + r.noise1(y * 4 + Math.atan2(z, x) * 2) * 0.08;
        pa.setXYZ(i, x * w, y, z * w);
      }
      logGeo.computeVertexNormals();
      logGeo.rotateZ(Math.PI / 2);
    }

    const cells = nChunks * nChunks;
    const fernsPer = Math.ceil(3600 / cells);
    const tuftsPer = Math.ceil(1800 / cells);
    const rocksPer = Math.ceil(260 / cells);
    const logsPer = Math.max(2, Math.ceil(90 / cells));

    for (let cj = 0; cj < nChunks; cj++) {
      for (let ci = 0; ci < nChunks; ci++) {
        const cr = r.fork(cj * 131 + ci * 17 + 3);
        const x0 = -half + ci * CHUNK, z0 = -half + cj * CHUNK;
        const x1 = Math.min(x0 + CHUNK, half), z1 = Math.min(z0 + CHUNK, half);
        const ck = ci + cj * nChunks;
        const lox = Math.max(x0 + 2, -half + 8), loz = Math.max(z0 + 2, -half + 8);

        // ---- ferns: clustered, prefer hollows, avoid dry ridges ----
        const fern = new THREE.InstancedMesh(fernGeo, fernMat, fernsPer);
        fern.receiveShadow = true;
        let placed = 0;
        let clX = cr.range(lox, x1 - 2), clZ = cr.range(loz, z1 - 2);
        for (let i = 0; i < fernsPer * 4 && placed < fernsPer; i++) {
          if (i % 9 === 0) { clX = cr.range(lox, x1 - 2); clZ = cr.range(loz, z1 - 2); }
          const ang = cr.range(0, Math.PI * 2), rad = Math.sqrt(cr.next()) * cr.range(1.5, 6);
          const x = clX + Math.cos(ang) * rad, z = clZ + Math.sin(ang) * rad;
          if (x < lox || z < loz || x >= x1 - 2 || z >= z1 - 2) continue;
          if (this.hf.trailDist(x, z) < 2.0) continue;
          const zn = this.hf.zoneAt(x, z);
          if (zn && Math.hypot(x - zn.x, z - zn.z) < zn.r * 0.7) continue;
          if (this.hf.inLake(x, z)) continue;
          const damp = this.hollow(x, z);
          const eco = cr.fbm2(x * 0.03 + 11, z * 0.03, 3) * 0.5 + 0.5;
          if (eco * 0.6 + damp * 0.6 < cr.range(0.35, 0.8)) continue;
          const y = this.hf.heightAt(x, z);
          this.dummy.position.set(x, y - 0.05, z);
          this.dummy.rotation.set(cr.range(-0.08, 0.08), cr.range(0, Math.PI * 2), cr.range(-0.08, 0.08));
          this.dummy.scale.setScalar(cr.range(0.5, 1.1) * (0.8 + damp * 0.5));
          this.dummy.updateMatrix();
          fern.setMatrixAt(placed, this.dummy.matrix);
          this.color.setHSL(0.22 + cr.range(-0.04, 0.04) - damp * 0.02,
            cr.range(0.18, 0.32) + damp * 0.08, cr.range(0.26, 0.44) - damp * 0.06);
          fern.setColorAt(placed, this.color);
          placed++;
        }
        fern.count = placed;
        this.finishMesh(fern, ck, nChunks, half);

        // ---- tufts: trail margins and open ground ----
        const tufts = new THREE.InstancedMesh(tuftGeo, tuftMat, tuftsPer);
        tufts.receiveShadow = true;
        let tp = 0;
        for (let i = 0; i < tuftsPer * 4 && tp < tuftsPer; i++) {
          const x = cr.range(lox, x1 - 2), z = cr.range(loz, z1 - 2);
          const td = this.hf.trailDist(x, z);
          if (td < 1.1) continue;
          // strong preference for the 1.1–4 m trail edge band
          const edge = td < 4 ? 1 : 0.35;
          if (cr.next() > edge) continue;
          const zn = this.hf.zoneAt(x, z);
          if (zn && Math.hypot(x - zn.x, z - zn.z) < zn.r * 0.6) continue;
          if (this.hf.inLake(x, z)) continue;
          this.dummy.position.set(x, this.hf.heightAt(x, z) - 0.03, z);
          this.dummy.rotation.set(0, cr.range(0, Math.PI * 2), 0);
          this.dummy.scale.set(cr.range(0.6, 1.4), cr.range(0.6, 1.5), cr.range(0.6, 1.4));
          this.dummy.updateMatrix();
          tufts.setMatrixAt(tp, this.dummy.matrix);
          const v = cr.range(0.7, 1.1);
          this.color.setRGB(v, v * cr.range(0.95, 1.05), v * cr.range(0.85, 0.95));
          tufts.setColorAt(tp, this.color);
          tp++;
        }
        tufts.count = tp;
        this.finishMesh(tufts, ck, nChunks, half);

        // ---- rocks: scree patches, sunk into soil ----
        const rocks = new THREE.InstancedMesh(rockGeo, this.mats.rock, rocksPer);
        rocks.castShadow = true; rocks.receiveShadow = true;
        let rp = 0;
        for (let i = 0; i < rocksPer * 4 && rp < rocksPer; i++) {
          const x = cr.range(Math.max(x0 + 2, -half + 6), x1 - 2);
          const z = cr.range(Math.max(z0 + 2, -half + 6), z1 - 2);
          if (this.hf.inLake(x, z)) continue;
          if (cr.fbm2(x * 0.05 + 300, z * 0.05, 2) < -0.05) continue;
          const y = this.hf.heightAt(x, z);
          const sy = cr.range(0.25, 1.0);
          this.dummy.position.set(x, y - sy * 0.35, z);
          this.dummy.rotation.set(cr.range(-0.3, 0.3), cr.range(0, Math.PI * 2), cr.range(-0.3, 0.3));
          this.dummy.scale.set(cr.range(0.3, 1.6), sy, cr.range(0.3, 1.6));
          this.dummy.updateMatrix();
          rocks.setMatrixAt(rp, this.dummy.matrix);
          rp++;
        }
        rocks.count = rp;
        this.finishMesh(rocks, ck, nChunks, half);

        // ---- fallen logs, aligned roughly downhill ----
        const logs = new THREE.InstancedMesh(logGeo, this.mats.barkDead, logsPer);
        logs.castShadow = true; logs.receiveShadow = true;
        let lp = 0;
        for (let i = 0; i < logsPer * 5 && lp < logsPer; i++) {
          const x = cr.range(lox, x1 - 2), z = cr.range(loz, z1 - 2);
          if (this.hf.trailDist(x, z) < 3) continue;
          if (this.hf.inLake(x, z)) continue;
          const zn = this.hf.zoneAt(x, z);
          if (zn && Math.hypot(x - zn.x, z - zn.z) < zn.r * 0.8) continue;
          const y = this.hf.heightAt(x, z);
          const gx = this.hf.heightAt(x + 1, z) - this.hf.heightAt(x - 1, z);
          const gz = this.hf.heightAt(x, z + 1) - this.hf.heightAt(x, z - 1);
          const yaw = Math.atan2(-gz, gx) + cr.range(-0.5, 0.5);
          const len = cr.range(2.5, 6.5), rad = cr.range(0.7, 1.3);
          this.dummy.position.set(x, y + 0.12 * rad, z);
          this.dummy.rotation.set(0, yaw, cr.range(-0.05, 0.05));
          this.dummy.scale.set(len, rad, rad);
          this.dummy.updateMatrix();
          logs.setMatrixAt(lp, this.dummy.matrix);
          lp++;
        }
        logs.count = lp;
        this.finishMesh(logs, ck, nChunks, half);
      }
    }
  }

  /** Chunk-granular distance culling (fog-hidden only). */
  setDrawDistance(camX: number, camZ: number, dist: number): void {
    const lim = dist + 49.5;
    const lim2 = lim * lim;
    for (let i = 0; i < this.meshes.length; i++) {
      const dx = this.meshChunkX[i] - camX, dz = this.meshChunkZ[i] - camZ;
      this.meshes[i].visible = dx * dx + dz * dz < lim2;
    }
  }

  dispose(): void {
    for (const m of this.meshes) { this.group.remove(m); m.dispose(); }
    this.meshes.length = 0;
    for (const g of this.ownedGeos) g.dispose();
    for (const m of this.ownedMats) m.dispose();
    this.ownedGeos.length = 0;
    this.ownedMats.length = 0;
  }
}

/** minimal geometry merge (positions/normals/uvs); disposes the inputs. */
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
    if (gi) { for (let i = 0; i < gi.count; i++) idx[iOff + i] = gi.getX(i) + vOff; iOff += gi.count; }
    else { for (let i = 0; i < p.count; i++) idx[iOff + i] = i + vOff; iOff += p.count; }
    vOff += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
