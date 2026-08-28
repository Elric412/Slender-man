import * as THREE from 'three';
import { HeightField, Zone } from './HeightField';
import { MaterialLibrary } from './MaterialLibrary';
import { CollisionWorld } from '../physics/Collision';
import { VegetationSystem, mergeGeos, patchWindMaterial } from './VegetationSystem';
import { ScatterSystem } from './ScatterSystem';
import { ForestAtlas } from './ForestAtlas';
import { ZoneSystem } from './ZoneSystem';
import { buildLandmark, LandmarkCtx, signpost, missingPoster } from './Landmarks';
import { Practicals } from './Practicals';
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
  /** the real forest — trees, ground detail, canopy occupancy */
  readonly scatter: ScatterSystem;
  readonly atlas: ForestAtlas;
  /**
   * Warm authored light sources. The single largest visual gap this map had:
   * before this existed the whole 560 m world contained three PointLights, so
   * every frame was one colour temperature and read as "dark WebGL scene"
   * rather than as a photographed place. See `Practicals.ts`.
   */
  readonly practicals: Practicals;
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
    private zones: ZoneSystem,
    seed: number,
    opts: {
      atlasSize?: number; anisotropy?: number; lodBias?: number;
      floorDetail?: number; densityScale?: number; practicalPool?: number;
    } = {},
  ) {
    this.rng = new SeededRandom(seed ^ 0x9A17);

    // Allocated before any builder runs: the pool size is compiled into every
    // material's shader, so it must be fixed for the lifetime of the scene.
    this.practicals = new Practicals(opts.practicalPool ?? 6);
    this.group.add(this.practicals.group);

    // Atlas first: the scatter system's two materials come out of it, and the
    // terrain wants the same tiling family so ground and trunk agree.
    this.atlas = ForestAtlas.build(seed, {
      size: opts.atlasSize ?? 512,
      anisotropy: opts.anisotropy ?? 4,
    });

    this.buildTerrain();
    this.buildWater();

    // The forest. Must precede POIs so `scatter.coverAt` is populated before
    // anything queries canopy cover, and precede dressing so props can sit in
    // clearings the trees actually left.
    this.scatter = new ScatterSystem(hf, zones, this.atlas, seed, {
      lodBias: opts.lodBias,
      floorDetail: opts.floorDetail,
      densityScale: opts.densityScale,
    });
    this.group.add(this.scatter.group);

    // VegetationSystem is retained for its non-tree layer only (rocks, logs,
    // grass tufts, flappable dressing). Its cone/sphere trees are suppressed —
    // ScatterSystem owns trees now.
    this.veg = new VegetationSystem(mats, hf, seed, { trees: false });
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
      // Ground colour comes from the zone field, not from one global constant.
      // The blended tint means a marsh floor is already darker and cooler than
      // dry upland before any lighting is applied, so the transition between
      // them is legible in the albedo rather than depending on fog to sell it.
      const zs = this.zones.sample(x, z);
      c.setRGB(zs.groundTint[0], zs.groundTint[1], zs.groundTint[2]);

      // Two noise scales, because one produces a single recognisable blotch
      // frequency that reads as a texture rather than as ground.
      const macro = this.rng.noise2(x * 0.013 - 12, z * 0.013 + 7);
      const moss = Math.max(0, this.rng.noise2(x * 0.04 + 40, z * 0.04));
      c.multiplyScalar(0.88 + macro * 0.16);

      // Moss follows the zone's own moss density, so it carpets old growth and
      // stays off dry upland instead of appearing uniformly everywhere.
      const mossAmt = Math.min(0.62, Math.max(0, moss - 0.24) * 1.5 * (0.35 + zs.mossDensity * 1.5));
      if (mossAmt > 0) c.lerp(new THREE.Color(0.42, 0.56, 0.38), mossAmt);

      // Wet ground goes darker and desaturates rather than turning blue: water
      // in soil lowers albedo, it does not add a hue.
      if (zs.wetness > 0.01) {
        const w = zs.wetness * 0.45;
        c.lerp(new THREE.Color(0.26, 0.25, 0.23), w);
      }

      // Trail is compacted mud: darker, and it takes moss off entirely.
      if (trailD < 3.6) {
        const t = 1 - trailD / 3.6;
        c.lerp(new THREE.Color(0.33, 0.29, 0.25), 0.72 * t * t);
      }
      if (this.hf.inLake(x, z)) c.setRGB(0.19, 0.185, 0.17);
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
    // §1c: raise the standoff 0.02 → 0.035, skip sloped spots (a flat disc
    // intersects terrain on any gradient → z-fight shimmer while moving),
    // and bias the puddle toward the camera via polygonOffset so it always
    // wins the near-plane depth tie against the ground it rests on.
    const pr = this.rng.fork(31337);
    const puddleGeo = new THREE.CircleGeometry(1, 12);
    puddleGeo.rotateX(-Math.PI / 2);
    this.mats.mudPuddle.polygonOffset = true;
    this.mats.mudPuddle.polygonOffsetFactor = -2;
    this.mats.mudPuddle.polygonOffsetUnits = -2;
    for (let i = 0; i < 40; i++) {
      const x = pr.range(-size / 2 + 20, size / 2 - 20);
      const z = pr.range(-size / 2 + 20, size / 2 - 20);
      const trailD = this.hf.trailDist(x, z);
      if (trailD > 14 || this.hf.inLake(x, z)) continue;
      // slope check: flat discs need near-level ground
      const h0 = this.hf.heightAt(x, z);
      const slope = Math.abs(this.hf.heightAt(x + 1.2, z) - h0) + Math.abs(this.hf.heightAt(x, z + 1.2) - h0);
      if (slope > 0.5) continue;
      const p = new THREE.Mesh(puddleGeo, this.mats.mudPuddle);
      p.position.set(x, h0 + 0.035, z);
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
    // Sourced from ScatterSystem, so what stops the player is exactly what is
    // drawn. The old path read VegetationSystem's cone positions, which no
    // longer correspond to any visible trunk.
    for (const t of this.scatter.colliders()) {
      const y = this.hf.heightAt(t.x, t.z);
      // 'entity-block': stops the player, blocks entity nav, but does NOT hard-block LOS —
      // the entity is allowed to be half-seen between trunks (partial visibility is the design goal)
      this.col.addBox({
        x: t.x, z: t.z, hx: t.r, hz: t.r, yaw: 0,
        y0: y - 1, y1: y + Math.min(8, t.h), kind: 'entity-block',
      });
    }
  }

  // ==================== POI BUILDERS ====================
  private buildPOIs(): void {
    const ctx: LandmarkCtx = {
      hf: this.hf, mats: this.mats, col: this.col, group: this.group,
      rng: this.rng.fork(0x1A4D), practicals: this.practicals,
      tape: (zoneId, x, z, dy) => this.tapeSpot(zoneId, x, z, dy),
      flap: (obj, base, amp, speed) => this.flappables.push({ obj, base, amp, speed }),
      g: (x, z) => this.g(x, z),
    };
    this.landmarkCtx = ctx;

    // Every landmark in the layout gets a structure. Dispatch is on `kind`, so
    // adding a landmark to PinewoodLayout can never again produce a flattened
    // clearing with nothing in it.
    for (const zn of this.hf.layout.zones) buildLandmark(ctx, zn);

    // Verify what the builders actually produced rather than trusting them: the
    // exact class of bug this replaced was silent, and a tape pool that is
    // missing at boot is unrecoverable at run time.
    const need = this.hf.layout.zones.length;
    if (this.tapePools.size < need) {
      const missing = this.hf.layout.zones
        .filter(z => !this.tapePools.has(z.id)).map(z => z.id);
      console.error(`[MapGenerator] ${missing.length} landmark(s) produced no tape pool: ${missing.join(', ')} — those tapes cannot spawn.`);
    }

    this.buildExit();
  }

  private landmarkCtx!: LandmarkCtx;

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

  /**
   * Landmark structures live in `Landmarks.ts`. They used to be eight methods
   * on this class keyed to the OLD zone ids (station/mill/radio/tunnel). When
   * the world moved to the 13 Pinewood landmarks those four ids stopped
   * existing, so their builders became dead code AND nine landmarks shipped as
   * bare flattened clearings — including four that owed a tape, which made the
   * run mathematically impossible to finish. Dispatch is now driven by the
   * landmark `kind` so a new landmark cannot silently ship empty.
   */

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
    // ---- storytelling along the trail ----
    // The references make posted paper the primary narrative device: you learn
    // what happened here by reading things nailed to trees, not from a cutscene.
    // Spaced along the spine so a walk always passes two or three.
    const dr = this.rng.fork(0x51600D);
    for (let i = 0; i < 7; i++) {
      const idx = Math.floor(((i + 0.5) / 7) * (t.length - 1));
      const p = t[idx];
      const p2 = t[Math.min(idx + 1, t.length - 1)];
      const along = Math.atan2(p2.x - p.x, p2.z - p.z);
      // Off to one side of the trail, facing back along it, so the player walks
      // into it rather than past it.
      const side = dr.sign() * dr.range(2.2, 3.6);
      const px = p.x + Math.cos(along) * side;
      const pz = p.z - Math.sin(along) * side;
      if (i % 3 === 0) {
        // a signpost at a third of the stops, lantern on half of those
        signpost(this.landmarkCtx, px, pz, along + Math.PI / 2, [
          { label: 'TRAIL', bearing: along + Math.PI / 2 },
        ], dr.next() < 0.5);
      } else {
        missingPoster(this.landmarkCtx, px, pz, along + Math.PI / 2, this.g(px, pz) + dr.range(1.3, 1.8));
      }
    }

    // scattered shell casings — implied clean-up, near the junction
    const st = this.hf.layout.zones.find(z => z.id === 'hub') ?? this.hf.layout.zones[0];
    for (let i = 0; i < 9; i++) {
      const cs = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.05, 5), this.mats.metalPaint);
      cs.position.set(st.x + this.rng.range(-8, 8), 0, st.z + this.rng.range(-8, 8));
      cs.position.y = this.g(cs.position.x, cs.position.z) + 0.03;
      cs.rotation.set(Math.PI / 2, 0, this.rng.range(0, 6));
      this.group.add(cs);
    }
  }

  // ---------- boundary: dense dark treeline ring ----------
  // Two silhouette layers read as a real forest wall instead of one repeated
  // cone: a tight near hedge (irregular, varied width/height) and a taller,
  // sparser emergent layer behind it. Two InstancedMeshes = two draw calls,
  // same cost class as the single 220-cone ring it replaces.
  private buildBoundary(): void {
    const half = this.hf.layout.size / 2;
    const ring = this.rng.fork(8888);
    const mat = this.mats.foliage.clone();
    mat.color = new THREE.Color(0x202a20);

    const ringPoint = (i: number, count: number, offJitter: number) => {
      const side = i % 4;
      const t = ((i / count) * 4) % 1;
      const off = half - 4 - ring.range(0, offJitter);
      let x = 0, z = 0;
      if (side === 0) { x = -half + t * half * 2; z = -off; }
      else if (side === 1) { x = -half + t * half * 2; z = off; }
      else if (side === 2) { x = -off; z = -half + t * half * 2; }
      else { x = off; z = -half + t * half * 2; }
      return { x, z };
    };

    const dummy = new THREE.Object3D();

    // near hedge — narrow spruce/conifer profile, dense, ragged heights
    const hedgeGeo = new THREE.ConeGeometry(2.4, 13, 6);
    hedgeGeo.translate(0, 6.0, 0);
    const hedge = new THREE.InstancedMesh(hedgeGeo, mat, 240);
    for (let i = 0; i < 240; i++) {
      const { x, z } = ringPoint(i, 240, 9);
      dummy.position.set(x, this.g(x, z) - 0.3, z);
      dummy.rotation.y = ring.range(0, 6.28);
      dummy.scale.set(ring.range(0.9, 1.6), ring.range(0.85, 1.9), ring.range(0.9, 1.6));
      dummy.updateMatrix();
      hedge.setMatrixAt(i, dummy.matrix);
    }
    hedge.instanceMatrix.needsUpdate = true;

    // emergent back layer — broader bare-crown trunks poking above the hedge,
    // offset outward and seeded between hedge trees so the skyline isn't a
    // single flat sawtooth. Wider radius + taller + fewer reads as background.
    const emGeo = new THREE.ConeGeometry(3.4, 17, 5);
    emGeo.translate(0, 8.0, 0);
    const emMat = mat.clone();
    emMat.color = new THREE.Color(0x1a231c); // slightly darker: sits behind, reads farther
    const emergent = new THREE.InstancedMesh(emGeo, emMat, 120);
    for (let i = 0; i < 120; i++) {
      const { x, z } = ringPoint(i + 60, 120, 22); // half-step offset, wider jitter
      dummy.position.set(x, this.g(x, z) - 0.3, z);
      dummy.rotation.y = ring.range(0, 6.28);
      dummy.scale.set(ring.range(1.1, 1.9), ring.range(1.0, 2.3), ring.range(1.1, 1.9));
      dummy.updateMatrix();
      emergent.setMatrixAt(i, dummy.matrix);
    }
    emergent.instanceMatrix.needsUpdate = true;

    this.group.add(hedge, emergent);
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
  }

  /**
   * Practicals need the camera, so they update separately from the wind pass.
   * Split rather than merged because `update()` is called before the camera is
   * resolved for the frame and a one-frame-stale billboard orientation is
   * visible as a shimmer on the glow cards.
   */
  updatePracticals(dt: number, camPos: THREE.Vector3, camQuat: THREE.Quaternion): void {
    this.practicals.update(dt, camPos, camQuat);
  }
}
