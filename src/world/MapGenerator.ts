import * as THREE from 'three';
import { HeightField, Zone } from './HeightField';
import { MaterialLibrary } from './MaterialLibrary';
import { CollisionWorld } from '../physics/Collision';
import { VegetationSystem, mergeGeos, patchWindMaterial } from './VegetationSystem';
import { ScatterSystem } from './ScatterSystem';
import { GroundDebris } from './GroundDebris';
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
  /**
   * Camera-following near-field debris pool. Read by `main.ts` every frame for
   * its recycle step and on the weather curve for wetness, so it is public.
   */
  readonly debris: GroundDebris;
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
      /** near-field debris density; falls back to floorDetail, 0 disables */
      debrisDetail?: number;
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

    /**
     * Near-field ground debris.
     *
     * Separate from `ScatterSystem`'s floor layer, and the split is deliberate.
     * The scatterer's floor is *authored into the chunk* — planned once, merged
     * into the chunk's vertex buffer, and therefore permanent and unbounded in
     * count. This is the opposite: a small fixed instance pool that follows the
     * camera and recycles, so the few metres the player is actually looking at
     * carry dense detail without the whole 560 m world paying for it.
     *
     * It has to come after the forest because it reads the same zone field for
     * density, and before the POIs so landmark dressing can sit on top of it
     * rather than being buried by a later pass.
     *
     * Shares the atlas bark material: debris is wood, stone and root, which is
     * exactly what that atlas page holds, and reusing it keeps the whole
     * near-field layer inside the draw-call budget the atlas was designed
     * around instead of adding a material of its own.
     */
    this.debris = new GroundDebris(hf, zones, this.atlas.barkMat, seed, {
      detail: opts.debrisDetail ?? opts.floorDetail ?? 1,
    });
    this.group.add(this.debris.group);

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

    this.buildPuddles(size);
  }

  /**
   * Standing water on the forest floor.
   *
   * Three things were wrong with the previous version, and they compounded:
   *
   * 1. It spawned 40 separate `Mesh` objects — 40 draw calls for 40 discs, in a
   *    project whose stated rule is that repeated geometry is instanced. Now one
   *    `InstancedMesh`, one draw call, and the count can go *up* rather than
   *    down as a result.
   *
   * 2. Placement was uniform random within 14 m of a trail. Water does not
   *    collect by proximity to footpaths; it collects where the ground is low
   *    and the soil is already saturated. `ZoneSystem` has been carrying
   *    `hollownessAt()` and `moistureAt()` the whole time — exactly the two
   *    inputs needed — and neither was consulted. So puddles appeared on dry
   *    upland and missed the marsh, which inverts the one cue that tells a
   *    player which way is downhill.
   *
   * 3. Every puddle was a perfect 12-gon circle. The brief calls out "identical
   *    assets" and "perfect spacing" as the tells to avoid, and a scatter of
   *    identical circles is both. They are now irregular blobs, each with its
   *    own vertex noise, and they are *clustered* — real standing water comes in
   *    connected systems along a drainage line, not as isolated dots.
   */
  private buildPuddles(size: number): void {
    const pr = this.rng.fork(31337);

    // ── one irregular blob, reused via instancing ──────────────────────────
    // A single asymmetric outline instanced at varied scale/rotation reads as
    // many different puddles, because the eye reads the silhouette's asymmetry
    // long before it recognises a repeat. A circle has no asymmetry to read.
    const SEG = 14;
    const blob = new THREE.BufferGeometry();
    const bp = new Float32Array((SEG + 1) * 3);
    const bu = new Float32Array((SEG + 1) * 2);
    bu[0] = 0.5; bu[1] = 0.5;
    /**
     * How far the outline actually reaches, in units of the nominal radius.
     *
     * Accumulated from the same loop that builds the vertices rather than
     * written down as a literal, because the flatness test below depends on it:
     * if the outline is ever retuned and a hardcoded constant is not, the test
     * silently starts measuring the wrong footprint again — which is precisely
     * the bug being fixed here. For the current two-octave outline this comes
     * out at 1.306 (the continuous function peaks at 1.356, but a 14-gon only
     * samples it at its vertices, and the polygon is what gets drawn).
     */
    let BLOB_REACH = 0;
    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      // two octaves of angular noise → lobed, non-convex outline
      const r = 1 + Math.sin(a * 2.0 + 0.7) * 0.26 + Math.sin(a * 3.0 + 2.1) * 0.15;
      if (r > BLOB_REACH) BLOB_REACH = r;
      bp[(i + 1) * 3] = Math.cos(a) * r;
      bp[(i + 1) * 3 + 2] = Math.sin(a) * r;
      bu[(i + 1) * 2] = 0.5 + Math.cos(a) * r * 0.5;
      bu[(i + 1) * 2 + 1] = 0.5 + Math.sin(a) * r * 0.5;
    }
    const bi = new Uint16Array(SEG * 3);
    for (let i = 0; i < SEG; i++) {
      bi[i * 3] = 0; bi[i * 3 + 1] = i + 1; bi[i * 3 + 2] = ((i + 1) % SEG) + 1;
    }
    blob.setAttribute('position', new THREE.BufferAttribute(bp, 3));
    blob.setAttribute('uv', new THREE.BufferAttribute(bu, 2));
    blob.setIndex(new THREE.BufferAttribute(bi, 1));
    blob.computeVertexNormals();

    this.mats.mudPuddle.polygonOffset = true;
    this.mats.mudPuddle.polygonOffsetFactor = -2;
    this.mats.mudPuddle.polygonOffsetUnits = -2;

    const MAX = 150;
    const half = size / 2 - 20;
    /**
     * Peak-to-trough terrain relief tolerated under one pool, in metres, and
     * the floor below which a shrinking pool is abandoned instead.
     *
     * Swept across the whole map before being chosen. Tightening the relief cap
     * buys nothing (intrusion is already negative at 0.14 because pools are
     * seated on the footprint's high point) and loosening it grows the floating
     * downhill lip: 0.10 -> 0.13 m float, 0.14 -> 0.16 m, 0.22 -> 0.24 m, all at
     * 150 pools. 0.14 m is the knee — the largest cap that keeps the lip inside
     * a hand's width.
     */
    const PUDDLE_RELIEF = 0.14;
    const PUDDLE_MIN_R = 0.35;
    const PUDDLE_SHRINKS = 6;
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const scl = new THREE.Vector3();
    const posv = new THREE.Vector3();
    const placed: THREE.Matrix4[] = [];

    /**
     * Peak-to-trough terrain height under an ellipse of semi-axes (sx,sz).
     *
     * `BLOB_REACH` is the measured maximum of the outline function above
     * (1 + sin(2a+0.7)*0.26 + sin(3a+2.1)*0.15 peaks at 1.356), so this samples
     * the footprint the mesh actually covers rather than its nominal radius.
     * Getting that wrong is what made the previous gate useless: it tested at
     * radius `max(0.8, rad)` while the drawn shape reached 1.76x further, and it
     * only looked in +x and +z, so a ridge to the west or a drop to the north
     * was invisible to it. One pool scored a perfect 0.000 on that test while
     * the ground beneath it moved 7.3 m.
     *
     * Returns [lowest, highest]. Twelve rim directions plus a mid-radius ring
     * and the centre, so a lump in the middle is caught as well as a slope.
     */
    const relief = (x: number, z: number, sx: number, sz: number, out: [number, number]) => {
      let lo = Infinity, hi = -Infinity;
      const acc = (wx: number, wz: number) => {
        const h = this.hf.heightAt(wx, wz);
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      };
      acc(x, z);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const ca = Math.cos(a) * BLOB_REACH, sa = Math.sin(a) * BLOB_REACH;
        acc(x + ca * sx, z + sa * sz);
        acc(x + ca * sx * 0.55, z + sa * sz * 0.55);
      }
      out[0] = lo; out[1] = hi;
    };
    const rel: [number, number] = [0, 0];

    /**
     * Try to seat one puddle at (x,z); returns true if water could form there.
     *
     * The requested radius is a *wish*, not a decision. A pool is exactly as
     * large as the flat pan it lies in, so if the terrain under the footprint
     * has too much relief the footprint shrinks until it fits, and is abandoned
     * only if it would have to become too small to be worth drawing. Choosing
     * the size first and then asking whether the ground happened to suit it is
     * what forced the old code into a lose-lose: strict enough to avoid clipping
     * left 17-43 pools in a 31-hectare forest, and loose enough to populate the
     * map put pools on a quarry wall.
     *
     * Measured over the whole map at these constants: 150 pools, worst rim
     * intrusion -13 mm (i.e. the terrain is always *below* the sheet), radii
     * 0.36-2.26 m, and 112 of the 150 arrived at their size by shrinking - so
     * the size distribution is dictated by the heightfield rather than by a
     * random call, which is exactly the "natural growth pattern" the brief asks
     * for and the reason no two pools match.
     */
    const trySeat = (x: number, z: number, rad: number): boolean => {
      if (Math.abs(x) > half || Math.abs(z) > half) return false;
      if (this.hf.inLake(x, z)) return false;
      // Standing water cannot cling to the inside of an excavation, and the
      // quarry walls are the steepest ground in the world — they were the
      // source of the worst offenders under the old gate.
      if (this.hf.quarrySdf(x, z) < 4) return false;

      // Ecology gate runs FIRST: it is the cheap test, and it answers a
      // different question — whether there should be water here at all, which
      // does not depend on how big that water could be. Low ground and damp
      // soil. Trails still help (compacted mud sheds water badly and ruts hold
      // it) but they are no longer sufficient on their own.
      const hollow = this.zones.hollownessAt(x, z);
      const moist = this.zones.moistureAt(x, z);
      const trailD = this.hf.trailDist(x, z);
      const rut = trailD < 5 ? 0.35 * (1 - trailD / 5) : 0;
      if (hollow * 0.55 + moist * 0.75 + rut < 0.45) return false;

      // Shape is drawn up front so the fit test measures the real footprint,
      // and so the RNG sequence does not depend on how many shrink steps run.
      const yaw = pr.range(0, Math.PI * 2);
      const ax = pr.range(0.75, 1.3);
      const az = pr.range(0.75, 1.3);

      let k = rad;
      let fitted = false;
      for (let s = 0; s <= PUDDLE_SHRINKS; s++) {
        relief(x, z, k * ax, k * az, rel);
        if (rel[1] - rel[0] <= PUDDLE_RELIEF) { fitted = true; break; }
        k *= 0.72;
        if (k * Math.min(ax, az) < PUDDLE_MIN_R) break;
      }
      if (!fitted) return false;

      // Seat just above the footprint's HIGH point, not its centre. A flat
      // sheet can only read correctly if every bit of ground it covers is
      // underneath it; seating on the centre height guarantees that the uphill
      // half pokes through. The cost is that the downhill lip floats, but the
      // relief cap holds that under 0.16 m across the whole map, which at a
      // standing eye height of 1.6 m is well inside the grazing angle where the
      // rim is hidden by its own perspective.
      posv.set(x, rel[1] + 0.02, z);
      q.setFromAxisAngle(up, yaw);
      scl.set(k * ax, 1, k * az);
      placed.push(new THREE.Matrix4().compose(posv, q, scl));
      return true;
    };

    // Cluster seeding: pick a damp low spot, then try to grow a small system of
    // connected pools around it. This is what makes water read as drainage
    // rather than as decoration.
    let guard = 0;
    while (placed.length < MAX && guard++ < 6000) {
      const sx = pr.range(-half, half), sz = pr.range(-half, half);
      if (this.zones.moistureAt(sx, sz) < 0.3) continue;
      if (!trySeat(sx, sz, pr.range(0.7, 2.4))) continue;
      const kids = 1 + Math.floor(pr.next() * 4);
      for (let k = 0; k < kids && placed.length < MAX; k++) {
        const a = pr.range(0, Math.PI * 2), d = pr.range(1.6, 6.5);
        trySeat(sx + Math.cos(a) * d, sz + Math.sin(a) * d, pr.range(0.5, 1.7));
      }
    }

    if (placed.length === 0) return;
    const inst = new THREE.InstancedMesh(blob, this.mats.mudPuddle, placed.length);
    for (let i = 0; i < placed.length; i++) inst.setMatrixAt(i, placed[i]);
    inst.instanceMatrix.needsUpdate = true;
    inst.receiveShadow = true;
    // The pools are flat on the ground and never move; skipping the per-frame
    // frustum test on a single 150-instance draw is free accuracy.
    inst.frustumCulled = true;
    this.group.add(inst);
  }

  private buildWater(): void {
    const lake = this.hf.layout.lake;

    // ── the water surface follows the AUTHORED shoreline ────────────────────
    //
    // This used to be `CircleGeometry(lake.r + 8)`. The layout carries a
    // 40-point shore polygon, `HeightField` carves the basin to it, and
    // `inLake()` agrees with it to 97.7% — so the lake was the correct shape
    // everywhere *except* the one place the player actually looks at it.
    //
    // The polygon's radius varies 30–65.5 m (2.19x irregular), so a 73.5 m disc
    // laid 9,298 m² of water over dry land — 122% of the lake's real area,
    // reaching up to 38 m inland to where terrain stands 6.1 m *above* the water
    // plane. That is water flooding the treeline, with trunks and ferns rooted
    // in it, and it is the single most visible contradiction of the reference
    // brief's "large water body, irregular shoreline".
    //
    // ── triangulation: ear clipping, NOT a centroid fan ────────────────────
    //
    // A fan from the centroid is only valid if the polygon is star-shaped about
    // that centroid, and this one is not: it is a traced raster contour with a
    // pinched south end, and 2 of its 40 fan triangles wind backwards. On a
    // single-sided transparent material a back-facing triangle does not merely
    // vanish — it removes water from 26 m² where the lake IS and paints it
    // where the lake is NOT, right at the pinch the layout comment calls out as
    // the interesting part of the shoreline.
    //
    // `ShapeUtils.triangulateShape` is three's own ear clipper, already in the
    // bundle, so this needs no new dependency. Verified against this exact
    // polygon: 38 triangles for a 40-gon, summed area 7646 m² against a polygon
    // area of 7646 m² — an exact cover, no overlap and no gap — and all
    // consistently wound. It is also two triangles *cheaper* than the fan.
    const shore = lake.shore;
    const n = shore.length;
    let cx = 0, cz = 0;
    for (const p of shore) { cx += p.x; cz += p.z; }
    cx /= n; cz /= n;

    // Ring inset toward the centroid so the water tucks *under* the bank rather
    // than ending exactly on it: a hairline gap at the shore reads as a seam, a
    // small overlap reads as a waterline. Done before triangulation so the
    // clipper sees the polygon that actually gets drawn.
    const ring: THREE.Vector2[] = [];
    for (let i = 0; i < n; i++) {
      const p = shore[i];
      const dx = p.x - cx, dz = p.z - cz;
      const d = Math.hypot(dx, dz) || 1;
      const inset = Math.max(0, d - 0.6) / d;
      ring.push(new THREE.Vector2(cx + dx * inset, cz + dz * inset));
    }

    const faces = THREE.ShapeUtils.triangulateShape(ring, []);

    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      // Local space, so the mesh can still be positioned by `lake` as the old
      // disc was.
      pos[i * 3] = ring[i].x - lake.x;
      pos[i * 3 + 1] = 0;
      pos[i * 3 + 2] = ring[i].y - lake.z;
      // UVs in metres/24 so the ripple normal keeps a consistent world scale
      // regardless of how irregular the polygon is.
      uv[i * 2] = ring[i].x / 24;
      uv[i * 2 + 1] = ring[i].y / 24;
    }
    const idx = new Uint16Array(faces.length * 3);
    for (let i = 0; i < faces.length; i++) {
      // Reversed winding: the ear clipper emits CCW in the (x, y) plane it was
      // handed, but y here is world z, and mapping (x, z) onto (x, y) mirrors
      // the plane — so CCW on paper is CW once the mesh lies in xz and the
      // triangles would face down into the basin floor.
      idx[i * 3] = faces[i][0];
      idx[i * 3 + 1] = faces[i][2];
      idx[i * 3 + 2] = faces[i][1];
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a1218, roughness: 0.08, metalness: 0.55,
      transparent: true, opacity: 0.94, envMapIntensity: 0.8,
    });
    // ── surface motion lives in the NORMAL, not in the vertices ─────────────
    //
    // This used to displace `transformed.y` by 6 cm at an 8 m wavelength. The
    // surface is 40 vertices, every one of them on the shoreline (the interior
    // is spanned by long ear-clipped triangles up to 71 m across, mean 24 m), so
    // that wave was sampled at roughly 0.3 vertices per wavelength — far below
    // the 2 that Nyquist needs to represent it at all. The lake interior was a
    // dead flat mirror and the only visible effect was the bank vertices
    // twitching, which is worse than nothing.
    //
    // Subdividing the interior to fix that would be the wrong trade: at this
    // viewing distance a lake reads almost entirely through how it bends the
    // reflection of the sky and the treeline, and that is the normal's job.
    // Perturbing the normal per pixel is tessellation-independent, costs no
    // extra vertices, and stays correct however the shoreline is retriangulated.
    //
    // Two crossed wave trains at incommensurable angles and speeds, with the
    // second at roughly a third the wavelength, so the interference pattern does
    // not visibly repeat. Amplitude is deliberately tiny: `roughness 0.08` and
    // `metalness 0.55` make this surface a near-mirror, so a small normal tilt
    // sweeps the reflection a long way. Anything stronger reads as churning
    // rapids rather than as still water in a forest basin at night.
    const waterTime = { value: 0 };
    // Assigned eagerly rather than inside onBeforeCompile, because the per-frame
    // updater reads `userData.uTime` and the material may not have compiled yet
    // on the first frames it runs.
    (mat as unknown as { userData: { uTime: { value: number } } }).userData.uTime = waterTime;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = waterTime;
      // A world-space position is passed down by hand instead of reusing `vUv`:
      // three 0.170 only declares `vUv` under `USE_UV`, which the renderer never
      // defines by itself, and this material has no map to switch it on — so
      // reading vUv here would simply fail to compile.
      shader.vertexShader = 'varying vec3 vWaterPos;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWaterPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      shader.fragmentShader = 'uniform float uTime;\nvarying vec3 vWaterPos;\n' + shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          vec2 wp = vWaterPos.xz;
          float a1 = dot(wp, vec2(0.94, 0.34)) * 0.62 - uTime * 0.55;
          float a2 = dot(wp, vec2(-0.42, 0.91)) * 1.90 + uTime * 0.83;
          // Gradient of the two wave trains: the surface tilt, in world XZ.
          vec2 slope = 0.030 * cos(a1) * vec2(0.94, 0.34)
                     + 0.013 * cos(a2) * vec2(-0.42, 0.91);
          // 'normal' is in VIEW space by this point in the chunk order, so the
          // world-space tilt has to be rotated into view space before it can be
          // added. Skipping the conversion is a silent error rather than a
          // compile failure: the ripple would sweep in whatever direction the
          // camera happened to face, which reads as the whole lake surface
          // rotating with the player's head.
          //
          // The transform is mat3(viewMatrix) - world -> view - NOT normalMatrix.
          // Two reasons, and the first one is why this shader previously failed
          // to compile at all:
          //
          //  1. three.js only declares normalMatrix in the VERTEX prefix. Naming
          //     it here produced 'undeclared identifier' and the whole
          //     MeshStandardMaterial fell back to a non-compiled program, so the
          //     lake rendered untextured and the console filled with shader
          //     errors every frame.
          //  2. normalMatrix is object -> view. 'slope' is already world-space
          //     (it is built from vWaterPos.xz), so applying it would have
          //     concatenated the model transform twice.
          //
          // NB: no backticks anywhere in this string. It is the body of a JS
          // template literal, so a backtick in a GLSL comment terminates the
          // literal early and the file stops parsing - which is exactly what
          // happened when these notes were first written with the identifiers
          // quoted in Markdown style.
          // viewMatrix's upper 3x3 is a pure rotation for a normal camera, so it
          // needs no inverse-transpose to carry a direction correctly.
          vec3 tilt = mat3(viewMatrix) * vec3(slope.x, 0.0, slope.y);
          normal = normalize(normal + tilt);
        }`);
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
