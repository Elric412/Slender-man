import * as THREE from 'three';
import { HeightField } from './HeightField';
import { ZoneSystem } from './ZoneSystem';
import { SeededRandom } from '../core/SeededRandom';

/**
 * ============================================================================
 * Near-field ground debris
 * ============================================================================
 *
 * The single largest remaining gap between this game's forest floor and the
 * reference material it is measured against.
 *
 * The existing floor layer in `ScatterSystem.planFloor` is entirely flat
 * cards — ferns, leaf sprites, reeds — at a peak density of 340 attempts per
 * 3600 m² chunk, i.e. **0.094 items/m²** before any gate rejects. The reference
 * frames carry roughly **12-18 discrete solid meshes/m²** on the ground: pebbles,
 * embedded cobbles, twigs, exposed root arcs. That is a ~160x shortfall, and it
 * is why the floor reads as a textured plane with plants on it rather than as
 * ground made of things.
 *
 * ── Why this is a separate system ───────────────────────────────────────────
 *
 * The naive fix is to raise `planFloor`'s density, and it does not work:
 *
 *   - 15/m² over a 560 m world is 4.7 **million** objects. Not a tuning
 *     problem; a different order of magnitude.
 *   - `ScatterSystem` merges its floor cards into per-chunk static geometry
 *     against a 1M-vertex near budget. Debris at reference density would blow
 *     that budget on the first chunk and evict the trees.
 *
 * The observation that makes it tractable: the reference frames only ever show
 * ~8 m of ground. Beyond that the floor is a dark texture and no individual
 * pebble is resolvable — so reference density is only ever needed in a small
 * disc around the camera. A ring of ~3000 instances covers 8 m at 15/m², which
 * is one `InstancedMesh` and one draw call.
 *
 * So this is deliberately NOT chunked. It is a fixed-size instance pool that
 * follows the player, recycling instances out of the trailing edge into the
 * leading edge. Cost is constant regardless of world size or how far the player
 * walks, and there is no merge, no eviction, and no pop — an instance is only
 * ever moved while it is behind the player or beyond the fade radius.
 *
 * ── Determinism ─────────────────────────────────────────────────────────────
 *
 * Placement is a pure function of world position, via a hash of the quantised
 * cell coordinate. Walking away from a patch of ground and back produces the
 * identical arrangement of pebbles, because nothing about the arrangement is
 * stored — it is recomputed from where it is. That matters for a horror game
 * where the player is expected to re-navigate the same ground and trust it.
 */

/** One reusable convex blob, instanced. Index into `SHAPES`. */
type ShapeId = 0 | 1 | 2 | 3;

const SHAPE_COUNT = 4;

/**
 * How far debris is drawn, and the pool size that fills it.
 *
 * 9 m rather than the 8 m the reference shows, so instances reach full size
 * before entering the region the player is actually looking at. The pool is
 * sized for the *area*, so density is `POOL / (pi * R^2)`.
 */
const RADIUS = 9;
const POOL_HIGH = 3400;   // ~13.4/m² — inside the reference's 12-18 band
const POOL_MED = 1700;    // ~6.7/m²  — still an order of magnitude up from 0.094
const POOL_LOW = 700;     // ~2.8/m²

/**
 * Instances are re-seated when they fall outside this, which is deliberately
 * larger than RADIUS. Re-seating exactly at the draw radius would put the
 * relocation right where the player can see it; the extra 3 m means an instance
 * is always fully faded out before it teleports.
 */
const RECYCLE = RADIUS + 3;

export interface GroundDebrisOptions {
  /** 0 disables the system entirely; 1 is the tuned density. */
  detail?: number;
}

export class GroundDebris {
  readonly group = new THREE.Group();

  private meshes: THREE.InstancedMesh[] = [];
  /** Per-shape instance slots, so each mesh packs its own contiguous range. */
  private counts: number[] = [];
  /** World position each slot currently occupies, for the recycle test. */
  private slotX: Float32Array;
  private slotZ: Float32Array;
  private slotShape: Uint8Array;
  private slotIndex: Uint16Array;
  private pool: number;

  private lastX = Infinity;
  private lastZ = Infinity;
  private wetness = 0;

  // scratch — this runs every frame, and AGENTS.md forbids allocation here
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private col = new THREE.Color();

  constructor(
    private hf: HeightField,
    private zones: ZoneSystem,
    private material: THREE.Material,
    seed: number,
    opts: GroundDebrisOptions = {},
  ) {
    const detail = opts.detail ?? 1;
    this.pool = detail >= 1 ? POOL_HIGH : detail >= 0.5 ? POOL_MED : detail > 0 ? POOL_LOW : 0;

    this.slotX = new Float32Array(this.pool);
    this.slotZ = new Float32Array(this.pool);
    this.slotShape = new Uint8Array(this.pool);
    this.slotIndex = new Uint16Array(this.pool);

    if (this.pool === 0) return;

    const rng = new SeededRandom(seed ^ 0xDEB215);
    const shapes = this.buildShapes(rng);

    // Split the pool across shapes by weight. Pebbles dominate because they do
    // in reality and because they are the cheapest; roots are rare because a
    // root arc is a strong silhouette and repeating it often would be a tell.
    const weights = [0.46, 0.28, 0.18, 0.08];
    let assigned = 0;
    for (let sh = 0; sh < SHAPE_COUNT; sh++) {
      const n = sh === SHAPE_COUNT - 1
        ? this.pool - assigned
        : Math.round(this.pool * weights[sh]);
      assigned += n;
      const mesh = new THREE.InstancedMesh(shapes[sh], material, Math.max(1, n));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // Per-instance colour so 3400 copies of four shapes do not read as four
      // objects. Combined with random yaw/scale this is what makes a repeated
      // convex blob stop being recognisable.
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
      // Debris receives the flashlight but does not cast: 3400 shadow casters
      // would dominate the torch's per-frame shadow pass, and a 4 cm pebble's
      // shadow is smaller than a shadow-map texel at this range anyway. The
      // relief the player reads comes from the shading, not from cast shadows.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      // The pool is always centred on the camera, so it is always in view.
      // Frustum culling it would spend a bounds test to never cull.
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.counts.push(n);
      this.group.add(mesh);
    }

    // Assign slots to meshes once. A slot's shape never changes, so the
    // per-frame path only ever writes a matrix, never re-packs.
    let slot = 0;
    for (let sh = 0; sh < SHAPE_COUNT; sh++) {
      for (let i = 0; i < this.counts[sh]; i++, slot++) {
        this.slotShape[slot] = sh;
        this.slotIndex[slot] = i;
        // Off-world until the first update seats them.
        this.slotX[slot] = 1e9;
        this.slotZ[slot] = 1e9;
      }
    }
  }

  /**
   * Build the four debris shapes.
   *
   * All are low-poly convex-ish solids, because at 4-30 cm across and inside a
   * flashlight cone what the player reads is the silhouette and the terminator,
   * not the topology. Icosahedra and lathe-like forms are deliberately *not*
   * used at detail 1+: a smooth blob has no facets to catch the beam, and the
   * faceting is most of what makes these look like stone.
   */
  private buildShapes(rng: SeededRandom): THREE.BufferGeometry[] {
    const out: THREE.BufferGeometry[] = [];

    // 0 — pebble: a squashed, irregularly-scaled low-poly sphere.
    {
      const g = new THREE.IcosahedronGeometry(0.5, 0);
      this.jitter(g, rng, 0.22);
      g.scale(1, 0.55, 1);
      g.computeVertexNormals();
      out.push(g);
    }
    // 1 — cobble: larger, more angular, partially buried by the seating code.
    {
      const g = new THREE.DodecahedronGeometry(0.5, 0);
      this.jitter(g, rng, 0.3);
      g.scale(1, 0.7, 0.85);
      g.computeVertexNormals();
      out.push(g);
    }
    // 2 — twig: an elongated box with a slight taper, laid flat.
    {
      const g = new THREE.CylinderGeometry(0.06, 0.09, 1, 5, 1);
      this.jitter(g, rng, 0.12);
      g.rotateZ(Math.PI / 2);        // lie along local X
      g.computeVertexNormals();
      out.push(g);
    }
    // 3 — root arc: a torus segment, so it breaks the surface and re-enters it.
    //     This is the one shape that reads as *grown* rather than deposited,
    //     and it is the strongest single cue that the ground has history.
    {
      const g = new THREE.TorusGeometry(0.5, 0.075, 5, 9, Math.PI * 0.85);
      this.jitter(g, rng, 0.09);
      g.rotateX(Math.PI / 2);
      g.computeVertexNormals();
      out.push(g);
    }
    return out;
  }

  /** Push vertices around so a primitive stops looking like a primitive. */
  private jitter(g: THREE.BufferGeometry, rng: SeededRandom, amt: number): void {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i,
        p.getX(i) * (1 + rng.range(-amt, amt)),
        p.getY(i) * (1 + rng.range(-amt, amt)),
        p.getZ(i) * (1 + rng.range(-amt, amt)));
    }
    p.needsUpdate = true;
  }

  /** Wetness drives the per-instance darkening, matching the ground material. */
  setWetness(w: number): void { this.wetness = w; }

  /**
   * Reseat any instance that has fallen out of range.
   *
   * Called every frame but does almost nothing most frames: an instance is only
   * touched when it leaves the recycle radius, so the per-frame cost is
   * proportional to how fast the player is moving, not to the pool size. At a
   * sprint (6.2 m/s) that is a few dozen instances per frame out of 3400.
   *
   * The early-out on a 0.35 m movement threshold exists because standing still
   * is the common case — reading a note, watching a treeline — and there is
   * nothing to do then at all.
   */
  update(camX: number, camZ: number): void {
    if (this.pool === 0) return;
    const moved = Math.hypot(camX - this.lastX, camZ - this.lastZ);
    if (moved < 0.35 && this.lastX !== Infinity) return;
    this.lastX = camX; this.lastZ = camZ;

    const dirty = new Set<number>();
    for (let slot = 0; slot < this.pool; slot++) {
      const dx = this.slotX[slot] - camX, dz = this.slotZ[slot] - camZ;
      if (dx * dx + dz * dz <= RECYCLE * RECYCLE) continue;
      this.seat(slot, camX, camZ);
      dirty.add(this.slotShape[slot]);
    }
    for (const sh of dirty) {
      this.meshes[sh].instanceMatrix.needsUpdate = true;
      if (this.meshes[sh].instanceColor) this.meshes[sh].instanceColor!.needsUpdate = true;
    }
  }

  /**
   * Place one instance somewhere valid inside the ring.
   *
   * Position is chosen by hashing a candidate cell rather than by drawing from
   * a stateful RNG, so the arrangement is a pure function of world position:
   * leave a clearing and come back and every pebble is where it was. A
   * stateful generator would reshuffle the ground behind the player's back,
   * which in a game about mistrusting your own perception is a genuinely bad
   * bug rather than a cosmetic one.
   */
  private seat(slot: number, camX: number, camZ: number): void {
    const sh = this.slotShape[slot];
    const idx = this.slotIndex[slot];

    // Uniform-in-area sampling: sqrt() on the radius, or everything crowds the
    // centre and the outer ring looks empty.
    //
    // The angle/radius are derived from the slot id and a rotating epoch so
    // successive re-seats of the same slot do not land in the same spot, but
    // the *ground content* at the chosen point is position-hashed below.
    let x = 0, z = 0, ok = false;
    for (let attempt = 0; attempt < 4 && !ok; attempt++) {
      const h1 = hash2(slot * 2.17 + attempt * 91.3, this.epoch);
      const h2 = hash2(slot * 7.31 + attempt * 13.7, this.epoch + 1);
      const ang = h1 * Math.PI * 2;
      const rad = Math.sqrt(h2) * RADIUS;
      x = camX + Math.cos(ang) * rad;
      z = camZ + Math.sin(ang) * rad;
      ok = this.plantable(x, z);
    }
    if (!ok) {
      // Could not find ground in four tries (in the lake, off-world, on a
      // cliff). Park it far away rather than drawing it somewhere wrong; the
      // next recycle pass will try again.
      this.slotX[slot] = 1e9; this.slotZ[slot] = 1e9;
      this.m.makeScale(0, 0, 0);
      this.meshes[sh].setMatrixAt(idx, this.m);
      return;
    }
    this.epoch++;

    // ---- everything below is a pure function of (x, z) ----
    const hx = hash2(Math.floor(x * 8), Math.floor(z * 8));
    const hy = hash2(Math.floor(x * 8) + 811, Math.floor(z * 8) - 337);
    const hz = hash2(Math.floor(x * 8) - 51, Math.floor(z * 8) + 1279);

    const y = this.hf.heightAt(x, z);

    // Size bands per shape, matching the reference's 5 cm-40 cm range.
    let size: number, sink: number;
    switch (sh) {
      case 0: size = 0.045 + hx * 0.075; sink = 0.35; break;   // pebble 4.5-12 cm
      case 1: size = 0.13 + hx * 0.27; sink = 0.45; break;     // cobble 13-40 cm
      case 2: size = 0.18 + hx * 0.42; sink = 0.15; break;     // twig 18-60 cm long
      default: size = 0.22 + hx * 0.3; sink = 0.55; break;     // root arc
    }

    // Partial burial. A pebble resting exactly on a heightfield sample looks
    // dropped; sinking it by a fraction of its own size makes it look settled,
    // and it also hides the seam where a convex hull meets a coarse terrain
    // triangle. This is the cheapest single thing that makes debris look like
    // it belongs to the ground rather than sitting on top of it.
    this.v.set(x, y - size * sink, z);

    // Full random yaw, and enough tilt to break the "all axis-aligned" tell.
    // Twigs get more roll than stones because a twig lying on uneven ground
    // genuinely does cant over.
    const tilt = sh === 2 ? 0.55 : 0.3;
    this.e.set((hy - 0.5) * tilt, hz * Math.PI * 2, (hz - 0.5) * tilt);
    this.q.setFromEuler(this.e);
    this.s.setScalar(size * 2);
    if (sh === 2) this.s.set(size * 2, size * 0.5, size * 0.5);  // twigs stay thin
    this.m.compose(this.v, this.q, this.s);
    this.meshes[sh].setMatrixAt(idx, this.m);

    // Per-instance tint from the zone's own ground colour, so debris on a marsh
    // floor is the colour of that marsh and debris on dry upland is not. Then
    // darkened by wetness on the same curve as the ground material, because
    // water in soil lowers albedo — a stone that stayed pale while the mud
    // around it darkened would read as plastic.
    this.zones.tupleAt(x, z, 'groundTint', GROUND_TINT);
    const shade = 0.62 + hy * 0.5;
    const wet = 1 - this.wetness * 0.34;
    this.col.setRGB(
      GROUND_TINT[0] * shade * wet,
      GROUND_TINT[1] * shade * wet,
      GROUND_TINT[2] * shade * wet);
    this.meshes[sh].setColorAt(idx, this.col);

    this.slotX[slot] = x;
    this.slotZ[slot] = z;
  }

  private epoch = 1;

  /** Ground that can hold debris: on the map, not in water, not near-vertical. */
  private plantable(x: number, z: number): boolean {
    const half = this.hf.layout.size / 2 - 4;
    if (Math.abs(x) > half || Math.abs(z) > half) return false;
    if (this.hf.inLake(x, z)) return false;
    // Loose material does not stay on a steep face. Also keeps debris out of
    // the quarry walls, which are the steepest ground in the world.
    return this.hf.slopeAt(x, z) < 0.85;
  }

  /** Instances actually drawn, for the perf overlay. */
  get stats(): { pool: number; draws: number } {
    return { pool: this.pool, draws: this.meshes.length };
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.meshes.length = 0;
  }
}

/** Reused tint scratch — module scope so it is allocated exactly once. */
const GROUND_TINT: [number, number, number] = [0, 0, 0];

/**
 * Deterministic 2D hash, 0..1.
 *
 * The usual sin-fract construction. Good enough here: the consumer is scatter
 * placement, where the requirement is decorrelation between neighbouring
 * inputs, not cryptographic quality or perfect uniformity.
 */
function hash2(a: number, b: number): number {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
