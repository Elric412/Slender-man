/**
 * GroundProps — the solid clutter on the forest floor.
 *
 * ## Why this file exists
 *
 * Measured on this world before it was written (`npm run census:forest`), the
 * floor carried four families — reed, fern, leafDry, leafBroad — at 0.025
 * items/m², which is one card per forty square metres, and **50.8 % of probe
 * points had nothing at all within 2.2 m**. In the zone covering 62 % of the
 * map (dryUpland) it was 55 %. So one in two flashlight sweeps across the
 * ground was landing on bare terrain.
 *
 * All four existing families are also alpha *cards*: two crossed quads standing
 * off the heightfield. Cards have no thickness, so a beam crossing them
 * produces no occlusion and no self-shadowing — the floor lights up as a
 * uniform sheet and reads as "textured plane with decals on it". That is the
 * defect, and no amount of *more cards* fixes it.
 *
 * What breaks the read is geometry with volume sitting *in* the ground: a log
 * the beam has to climb over, a stump that throws a hard shadow, a boulder with
 * a lit face and a black side, a root arch you can see under. Those are what
 * this file makes.
 *
 * ## Why they share the tree atlas
 *
 * Every prop emits `RawGeo` in exactly the format `TreeFactory` produces,
 * carrying a per-vertex atlas tile index. That is not incidental — it is why
 * this is affordable. `ScatterSystem` merges these into the same per-chunk
 * buffers as the trees, against the same two materials, so adding thirteen
 * families costs **zero** extra draw calls. A chunk of forty trees, ninety
 * logs, three hundred stones and two thousand plants is still two draws.
 *
 * A material per prop type is exactly the mistake the atlas was built to escape
 * (see `ForestAtlas`'s header: five trunk + five foliage materials once forced
 * five-plus instanced meshes *per chunk*, and that is what priced variety out
 * and made the forest look cloned). Repeating it at floor level would have cost
 * more draw calls than the trees do.
 *
 * ## Decay as a continuum, not variants
 *
 * Deadwood is parameterised by one `decay` scalar rather than by discrete
 * "fresh log / rotten log" meshes. Decay drives radius loss, sag, surface
 * irregularity, moss weight, tint *and* which bark tile is used, together — so
 * the population fills the whole range from a just-fallen trunk with bark still
 * on it to a moss-swallowed mound half sunk into the duff. Discrete variants
 * band, and banding is visible: the eye is very good at spotting three repeated
 * states.
 */

import { TILE } from './ForestAtlas';
import type { RawGeo } from './TreeFactory';
import type { SeededRandom } from '../core/SeededRandom';

// ============================================================================
// mesh builder
// ============================================================================

/**
 * Accumulates triangles into the `RawGeo` layout.
 *
 * Grown with plain arrays and typed at the end rather than presized — the
 * opposite of what `MergeTarget` in ScatterSystem does, deliberately. A prop is
 * a few hundred vertices built once and cached in a template table; MergeTarget
 * handles a million-vertex chunk merge every time the player walks. Exact
 * presizing is worth real complexity there and nothing here.
 */
class PropBuilder {
  private pos: number[] = [];
  private nrm: number[] = [];
  private uv: number[] = [];
  private col: number[] = [];
  private tile: number[] = [];
  private idx: number[] = [];

  get vertexCount(): number { return this.pos.length / 3; }

  vertex(
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
    r: number, g: number, b: number,
    tileId: number, repU: number, repV: number,
  ): number {
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(r, g, b);
    this.tile.push(tileId, repU, repV);
    return i;
  }

  tri(a: number, b: number, c: number): void { this.idx.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  /**
   * Append another builder's output at an offset.
   *
   * Moss skirts and fungus caps are built by the same helpers that build
   * standalone props, so composing them into a parent needs a splice. Doing it
   * here — rather than by building a second `RawGeo` and merging — keeps the
   * whole prop in one index space, which matters because `ScatterSystem` treats
   * one `RawGeo` as one atomic template.
   */
  append(g: RawGeo, dx: number, dy: number, dz: number): void {
    const base = this.vertexCount;
    const n = g.position.length / 3;
    for (let i = 0; i < n; i++) {
      this.vertex(
        g.position[i * 3] + dx, g.position[i * 3 + 1] + dy, g.position[i * 3 + 2] + dz,
        g.normal[i * 3], g.normal[i * 3 + 1], g.normal[i * 3 + 2],
        g.uv[i * 2], g.uv[i * 2 + 1],
        g.color[i * 3], g.color[i * 3 + 1], g.color[i * 3 + 2],
        g.tile[i * 3], g.tile[i * 3 + 1], g.tile[i * 3 + 2],
      );
    }
    for (let i = 0; i < g.index.length; i += 3) {
      this.tri(base + g.index[i], base + g.index[i + 1], base + g.index[i + 2]);
    }
  }

  finish(): RawGeo {
    return {
      position: new Float32Array(this.pos),
      normal: new Float32Array(this.nrm),
      uv: new Float32Array(this.uv),
      color: new Float32Array(this.col),
      tile: new Float32Array(this.tile),
      index: new Uint32Array(this.idx),
    };
  }
}

interface SpinePoint { x: number; y: number; z: number; r: number }

/**
 * A closed tube swept along a polyline, with per-ring radius and coherent
 * surface noise.
 *
 * This one primitive does most of the work in this file — logs, branches,
 * roots, stumps and fracture spikes are all swept tubes with different spines
 * and radius curves. Five bespoke generators would have produced five subtly
 * different normal conventions and five places for a winding-order bug to hide.
 *
 * `lumps` is what stops them reading as pipes. A real fallen trunk has knots, a
 * settled flat, bark ridges, and a taper that is not monotonic. The noise is
 * applied radially per vertex but is *coherent along the tube* — a function of
 * ring parameter and angle, not per-vertex jitter — so it produces ridges
 * running the length of the wood rather than sandpaper.
 */
function sweepTube(
  b: PropBuilder,
  spine: SpinePoint[],
  radial: number,
  tileId: number,
  repV: number,
  tint: { r: number; g: number; b: number },
  lumps: number,
  rng: SeededRandom,
  capStart = true,
  capEnd = true,
): void {
  const rings: number[][] = [];
  // Per-tube noise phases, so two tubes built from the same spine still differ.
  const ph1 = rng.next() * 6.283, ph2 = rng.next() * 6.283, ph3 = rng.next() * 6.283;

  for (let s = 0; s < spine.length; s++) {
    const p = spine[s];
    const t = s / Math.max(1, spine.length - 1);
    // Local frame from the spine tangent.
    const prev = spine[Math.max(0, s - 1)];
    const next = spine[Math.min(spine.length - 1, s + 1)];
    let ax = next.x - prev.x, ay = next.y - prev.y, az = next.z - prev.z;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    // Pick the reference axis least parallel to the tangent so the cross product
    // never degenerates. Hardcoding "up" collapses the frame for a vertical
    // tube, and stumps and fracture spikes are vertical.
    let ux = 0, uy = 1, uz = 0;
    if (Math.abs(ay) > 0.9) { ux = 1; uy = 0; uz = 0; }
    let e1x = uy * az - uz * ay, e1y = uz * ax - ux * az, e1z = ux * ay - uy * ax;
    const e1l = Math.hypot(e1x, e1y, e1z) || 1;
    e1x /= e1l; e1y /= e1l; e1z /= e1l;
    const e2x = ay * e1z - az * e1y, e2y = az * e1x - ax * e1z, e2z = ax * e1y - ay * e1x;

    const ring: number[] = [];
    for (let i = 0; i < radial; i++) {
      const a = (i / radial) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const n =
        Math.sin(a * 3 + ph1 + t * 4.1) * 0.55 +
        Math.sin(a * 5 - ph2 + t * 2.3) * 0.28 +
        Math.sin(t * 9.0 + ph3) * 0.34;
      const r = p.r * (1 + n * lumps);
      // Radial direction from the *unnoised* frame: normals stay smooth while
      // the surface is bumpy. Doubling bumpiness in geometry *and* normals makes
      // wood look like coral, and the atlas normal map already supplies the fine
      // surface detail.
      const nx = ca * e1x + sa * e2x;
      const ny = ca * e1y + sa * e2y;
      const nz = ca * e1z + sa * e2z;
      // Bake down the underside. A log's lower flank never receives sky, so
      // pre-darkening it keeps the prop grounded even with the beam off it —
      // the cheapest contact-occlusion cue available, and it costs no shader.
      const k = 1 - Math.max(0, -ny) * 0.42;
      ring.push(b.vertex(
        p.x + nx * r, p.y + ny * r, p.z + nz * r,
        nx, ny, nz,
        i / radial, t * repV,
        tint.r * k, tint.g * k, tint.b * k,
        tileId, 1, 1,
      ));
    }
    rings.push(ring);
  }

  for (let s = 0; s < rings.length - 1; s++) {
    const a = rings[s], c = rings[s + 1];
    for (let i = 0; i < radial; i++) {
      const j = (i + 1) % radial;
      b.quad(a[i], c[i], c[j], a[j]);
    }
  }

  // End caps get the splintered-wood tile, not bark: a break face is one of the
  // few places raw wood shows. An uncapped tube reads as hollow the moment the
  // beam catches the end, and a bark-capped one reads as a sealed pipe.
  const cap = (ring: number[], p: SpinePoint, flip: boolean) => {
    const c = b.vertex(p.x, p.y, p.z, 0, flip ? -1 : 1, 0, 0.5, 0.5,
      tint.r * 1.12, tint.g * 1.06, tint.b * 0.92, TILE.woodSplintered, 1, 1);
    for (let i = 0; i < radial; i++) {
      const j = (i + 1) % radial;
      if (flip) b.tri(c, ring[j], ring[i]); else b.tri(c, ring[i], ring[j]);
    }
  };
  if (capStart) cap(rings[0], spine[0], true);
  if (capEnd) cap(rings[rings.length - 1], spine[spine.length - 1], false);
}

/**
 * An irregular blob with a flattened base, used for rocks and moss mounds.
 *
 * The flattening is the important part and the reason this is not a scaled
 * sphere. A rock resting on soil has a buried base; a spherical one placed on a
 * heightfield either floats or visibly sinks. Clamping the lower hemisphere
 * toward a plane gives a broad contact footprint that beds into terrain at
 * almost any orientation.
 */
function buildBlob(
  b: PropBuilder,
  radius: number,
  flatten: number,
  angularity: number,
  tint: { r: number; g: number; b: number },
  tileId: number,
  tileRep: number,
  rng: SeededRandom,
  segU: number,
  segV: number,
): void {
  const ph = [rng.next() * 6.28, rng.next() * 6.28, rng.next() * 6.28, rng.next() * 6.28];
  // Anisotropic base shape — real rocks are rarely equidimensional.
  const sx = 1 + rng.range(-0.28, 0.34);
  const sy = 0.62 + rng.range(-0.12, 0.26);
  const sz = 1 + rng.range(-0.30, 0.30);

  const grid: number[][] = [];
  for (let v = 0; v <= segV; v++) {
    const row: number[] = [];
    const theta = (v / segV) * Math.PI;
    for (let u = 0; u < segU; u++) {
      const phi = (u / segU) * Math.PI * 2;
      const bx = Math.sin(theta) * Math.cos(phi);
      const by = Math.cos(theta);
      const bz = Math.sin(theta) * Math.sin(phi);
      const n =
        Math.sin(phi * 2 + ph[0]) * Math.sin(theta * 3 + ph[1]) * 0.50 +
        Math.sin(phi * 5 - ph[2]) * Math.sin(theta * 2 + ph[3]) * 0.30 +
        Math.sin(phi * 3 + theta * 5 + ph[0]) * 0.22;
      // `angularity` biases toward flat planes meeting at edges (fractured
      // bedrock) rather than smooth lumps (a tumbled river cobble). Same reason
      // a quarry block and a streambed stone do not look alike.
      const faceted = angularity > 0
        ? Math.sign(n) * Math.pow(Math.abs(n), 1 - angularity * 0.55)
        : n;
      const r = radius * (1 + faceted * 0.30);
      let py = by * r * sy;
      if (py < 0) py *= 1 - flatten;
      row.push(b.vertex(
        bx * r * sx, py, bz * r * sz,
        // Normals from the undisplaced sphere: slightly wrong, and right in the
        // way that matters. Exact per-face normals here would fight the atlas
        // normal map and produce faceted shading noise under a moving beam.
        bx, by, bz,
        (u / segU) * tileRep, (v / segV) * tileRep,
        tint.r, tint.g, tint.b,
        tileId, tileRep, tileRep,
      ));
    }
    grid.push(row);
  }
  for (let v = 0; v < segV; v++) {
    for (let u = 0; u < segU; u++) {
      const u2 = (u + 1) % segU;
      b.quad(grid[v][u], grid[v + 1][u], grid[v + 1][u2], grid[v][u2]);
    }
  }
}

/** A single tilted card, for moss skirts. */
function mossCard(
  w: number, h: number, tilt: number,
  tint: { r: number; g: number; b: number },
  rng: SeededRandom,
): RawGeo {
  const b = new PropBuilder();
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const yaw = rng.next() * Math.PI * 2;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const p = (fx: number, fy: number) => {
    const lx = fx * w, ly = fy * h;
    const rx = lx * c - ly * s, ry = lx * s + ly * c;
    // Darken toward the root so the card does not look like it hovers.
    const shade = 0.55 + 0.45 * fy;
    return b.vertex(
      rx * cy, ry, rx * sy,
      -sy * 0.3, 0.86, cy * 0.3,
      fx + 0.5, fy,
      tint.r * shade, tint.g * shade, tint.b * shade,
      TILE.mossDrape, 1, 1,
    );
  };
  b.quad(p(-0.5, 0), p(0.5, 0), p(0.5, 1), p(-0.5, 1));
  return b.finish();
}

// ============================================================================
// families
// ============================================================================

/**
 * The prop families.
 *
 * Split this finely — rather than as one "debris" bucket — because each carries
 * its own ecology, scale range and placement rule, and the census reports per
 * family so a missing one is *visible*. A single bucket would happily contain
 * forty thousand of the cheapest item and still read as bare ground.
 */
export type PropFamily =
  | 'log'          // fallen trunk, the largest floor object
  | 'logBroken'    // a log snapped into a section, splintered ends
  | 'branch'       // shed limb, ankle-to-knee scale
  | 'twig'         // finger-scale sticks — the micro layer
  | 'stump'        // cut or storm-snapped base, still rooted
  | 'rootFlare'    // buttress roots at a standing trunk's base
  | 'rootArch'     // exposed root bridging a hollow
  | 'boulder'      // knee-to-shoulder rock
  | 'stone'        // fist-to-head rock
  | 'pebble'       // gravel scale, placed in clusters
  | 'mossMound'    // a moss-swallowed lump of something indeterminate
  | 'fungus'       // bracket fungi and small caps
  | 'barkFleck';   // shed bark plates on the duff

export interface PropSpec {
  family: PropFamily;
  geo: RawGeo;
  /** footprint radius — drives spacing and the emptiness census */
  radius: number;
  /** height above the terrain, for the sink offset */
  height: number;
  /** should collision treat this as a step-over obstacle */
  solid: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Wood tint and tile as a function of decay.
 *
 * The tile switch is the significant half: fresh wood still has bark
 * (`barkMatureConifer`), mid-decay wood has lost it and shows silvered
 * weather-checked surface (`barkSnag`), late-decay wood is mostly moss
 * (`barkMossy`). Tinting one tile across the whole range keeps the same surface
 * pattern under three colours, which reads as recolouring rather than rotting.
 */
function woodLook(decay: number, mossBias: number, rng: SeededRandom) {
  const d = clamp01(decay);
  let tileId: number;
  if (d < 0.30) tileId = TILE.barkMatureConifer;
  else if (d < 0.62) tileId = TILE.barkSnag;
  else tileId = TILE.barkMossy;
  // Damp zones push borderline wood over into the mossy tile, so a marsh
  // genuinely has mossier deadwood than a dry ridge does.
  if (d > 0.42 && rng.next() < mossBias * 0.7) tileId = TILE.barkMossy;

  // Fresh wood is warm mid-brown; rotting wood goes dark, desaturated and
  // slightly green as moss and algae take it.
  const warm = 1 - d;
  const j = () => 0.86 + rng.next() * 0.28;
  return {
    tileId,
    tint: {
      r: (0.52 + warm * 0.30) * j(),
      g: (0.44 + warm * 0.22 + d * 0.06) * j(),
      b: (0.33 + warm * 0.12) * j(),
    },
  };
}

/** Scatter moss cards over a prop's upper surface. */
function addMoss(
  b: PropBuilder, count: number, rng: SeededRandom,
  at: (i: number) => { x: number; y: number; z: number; s: number },
): void {
  for (let m = 0; m < count; m++) {
    const p = at(m);
    b.append(mossCard(
      p.s * rng.range(0.7, 1.5), p.s * rng.range(0.5, 1.1),
      rng.range(-0.55, 0.55),
      { r: 0.30 + rng.next() * 0.08, g: 0.44 + rng.next() * 0.08, b: 0.24 + rng.next() * 0.06 },
      rng,
    ), p.x, p.y, p.z);
  }
}

/**
 * A fallen trunk.
 *
 * The spine is an arc with a sag, not a straight line, because a real fallen
 * trunk is supported at two or three points and bends between them. Sag rises
 * with decay — a fresh trunk still bridges hollows, an old one has settled into
 * the duff and follows the ground — and that difference is legible at a glance.
 */
export function makeLog(rng: SeededRandom, opts: {
  length: number; radius: number; decay: number; mossBias: number; broken: boolean;
}): PropSpec {
  const b = new PropBuilder();
  const { length, radius, decay } = opts;
  const look = woodLook(decay, opts.mossBias, rng);

  const segs = Math.max(5, Math.min(14, Math.round(length * 1.1)));
  const spine: SpinePoint[] = [];
  const bendAmp = length * rng.range(0.02, 0.09);
  const bendPh = rng.next() * 3.14;
  const sag = (0.25 + decay * 0.65) * radius * rng.range(1.2, 3.0);
  // Non-linear taper, so the thin end thins faster — matching how a trunk
  // actually runs out toward the crown.
  const taper = rng.range(0.42, 0.72);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    spine.push({
      x: (t - 0.5) * length,
      y: -Math.sin(t * Math.PI) * sag,
      z: Math.sin(t * 3.1 + bendPh) * bendAmp,
      r: radius * (1 - Math.pow(t, 1.4) * taper),
    });
  }
  sweepTube(b, spine, opts.broken ? 7 : 9, look.tileId,
    Math.max(2, Math.round(length * 0.55)), look.tint,
    0.05 + decay * 0.13, rng);

  // Branch stubs. Worth more than their triangle count: they break the log's
  // silhouette, and they are what makes a beam sweeping along it produce moving
  // shadows instead of a smooth gradient.
  const stubs = Math.round(rng.range(2, 6) * (1 - decay * 0.5));
  for (let s = 0; s < stubs; s++) {
    const si = Math.min(spine.length - 1, Math.round(rng.range(0.12, 0.88) * segs));
    const base = spine[si];
    const a = rng.next() * Math.PI * 2;
    const len = base.r * rng.range(1.6, 4.5);
    const up = rng.range(0.10, 0.75);
    const sub: SpinePoint[] = [];
    for (let k = 0; k <= 3; k++) {
      const kt = k / 3;
      sub.push({
        x: base.x + Math.cos(a) * len * kt * 0.35,
        y: base.y + up * len * kt,
        z: base.z + Math.sin(a) * len * kt,
        r: base.r * (0.30 - kt * 0.19),
      });
    }
    sweepTube(b, sub, 5, look.tileId, 1.5, look.tint, 0.16, rng, false, true);
  }

  // Moss on the upper flank of damp, decayed wood. Cards rather than a texture
  // blend: the silhouette of moss standing *off* the wood is what makes the log
  // look soft. A moss texture on a hard cylinder still reads as a hard cylinder.
  if (decay > 0.35 && opts.mossBias > 0.25) {
    const n = Math.round(opts.mossBias * decay * rng.range(6, 16));
    addMoss(b, n, rng, () => {
      const p = spine[Math.min(spine.length - 1, Math.round(rng.next() * segs))];
      return { x: p.x + rng.range(-0.5, 0.5) * p.r, y: p.y + p.r * 0.55, z: p.z, s: p.r };
    });
  }

  return {
    family: opts.broken ? 'logBroken' : 'log',
    geo: b.finish(),
    radius: length * 0.5,
    height: radius * 2,
    solid: radius > 0.16,
  };
}

/**
 * A shed branch or a twig — one generator, because they differ only in scale
 * and fork count.
 *
 * Expressing it once means the twig layer inherits the branch layer's bends and
 * forks for free. A twig layer made of straight sticks is very noticeable at
 * flashlight range, and it is the single cheapest micro-detail available.
 */
export function makeBranch(rng: SeededRandom, opts: {
  length: number; radius: number; decay: number; forks: number;
}): PropSpec {
  const b = new PropBuilder();
  const look = woodLook(opts.decay, 0.2, rng);
  const segs = 5;

  const mkLimb = (
    x0: number, y0: number, z0: number,
    dirA: number, pitch: number, len: number, r0: number, depth: number,
  ): void => {
    const spine: SpinePoint[] = [];
    // Curvature accumulates along the limb (t²), so a branch curves rather than
    // kinking. A polyline with random per-segment angles looks like a lightning
    // bolt, which is a distinctly non-wooden shape.
    const curA = rng.range(-0.5, 0.5), curP = rng.range(-0.3, 0.3);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const a = dirA + curA * t * t;
      const p = pitch + curP * t * t;
      spine.push({
        x: x0 + Math.cos(a) * Math.cos(p) * len * t,
        y: y0 + Math.sin(p) * len * t,
        z: z0 + Math.sin(a) * Math.cos(p) * len * t,
        r: r0 * (1 - t * 0.78),
      });
    }
    sweepTube(b, spine, depth === 0 ? 6 : 4, look.tileId,
      Math.max(1.5, len * 1.2), look.tint, 0.14, rng, depth === 0, true);
    if (depth < opts.forks) {
      const n = rng.next() < 0.6 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const p = spine[Math.round(rng.range(0.35, 0.8) * segs)];
        mkLimb(p.x, p.y, p.z,
          dirA + rng.range(-1.5, 1.5), pitch + rng.range(-0.5, 0.7),
          len * rng.range(0.30, 0.60), p.r * 0.7, depth + 1);
      }
    }
  };

  mkLimb(-opts.length * 0.35, opts.radius, 0,
    rng.next() * 6.28, rng.range(-0.12, 0.12), opts.length, opts.radius, 0);

  return {
    family: opts.radius < 0.035 ? 'twig' : 'branch',
    geo: b.finish(),
    radius: opts.length * 0.4,
    height: opts.radius * 3,
    solid: false,
  };
}

/**
 * A stump: broad, short, heavily rooted.
 *
 * Given a *ragged* top rather than a flat cut in most cases, because this is a
 * storm-damaged backcountry stand and not a logging operation — clean circular
 * saw cuts everywhere would tell the wrong story about the place. The roots are
 * why a stump grounds well: they spread its silhouette across the terrain so
 * the base never reads as a cylinder intersecting a plane.
 */
export function makeStump(rng: SeededRandom, opts: {
  radius: number; height: number; decay: number; mossBias: number; ragged: boolean;
}): PropSpec {
  const b = new PropBuilder();
  const look = woodLook(opts.decay, opts.mossBias, rng);
  const { radius, height } = opts;

  const spine: SpinePoint[] = [];
  const rings = 5;
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    spine.push({
      x: rng.range(-0.02, 0.02) * height,
      y: -radius * 0.6 + t * (height + radius * 0.6),
      z: rng.range(-0.02, 0.02) * height,
      // Strong basal flare — the buttress, and most of what makes the stump
      // look rooted rather than dropped on the ground.
      r: radius * (1 + Math.pow(1 - t, 2.2) * 0.85),
    });
  }
  sweepTube(b, spine, 10, look.tileId, Math.max(2, height * 2.2), look.tint,
    0.08 + opts.decay * 0.14, rng, false, !opts.ragged);

  // A ragged fracture crown: splinters standing up from the break. Cheap, and
  // the most recognisable silhouette cue that a trunk was snapped by wind
  // rather than cut by a saw.
  if (opts.ragged) {
    const top = spine[spine.length - 1];
    const spikes = rng.int(4, 8);
    for (let s = 0; s < spikes; s++) {
      const a = (s / spikes) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const rr = top.r * rng.range(0.35, 0.95);
      const h = height * rng.range(0.08, 0.42) * (1 - opts.decay * 0.5);
      const sub: SpinePoint[] = [];
      for (let k = 0; k <= 2; k++) {
        const kt = k / 2;
        sub.push({
          x: top.x + Math.cos(a) * rr, y: top.y + h * kt,
          z: top.z + Math.sin(a) * rr,
          r: top.r * (0.22 - kt * 0.17),
        });
      }
      sweepTube(b, sub, 4, TILE.woodSplintered, 1.4,
        { r: look.tint.r * 1.15, g: look.tint.g * 1.08, b: look.tint.b * 0.90 },
        0.2, rng, false, true);
    }
  }

  // Surface roots crawling away from the base and dipping back under the soil.
  const roots = rng.int(3, 6);
  for (let r = 0; r < roots; r++) {
    const a = (r / roots) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const len = radius * rng.range(2.0, 4.2);
    const sub: SpinePoint[] = [];
    for (let k = 0; k <= 4; k++) {
      const kt = k / 4;
      sub.push({
        x: Math.cos(a) * len * kt,
        // Arcs up out of the ground then back down into it. The dip is what
        // makes it read as continuing underground rather than just stopping.
        y: -radius * 0.35 + Math.sin(kt * Math.PI) * radius * 0.34 - kt * radius * 0.5,
        z: Math.sin(a) * len * kt,
        r: radius * (0.30 - kt * 0.22),
      });
    }
    sweepTube(b, sub, 5, look.tileId, 2, look.tint, 0.15, rng, false, false);
  }

  if (opts.mossBias > 0.3 && opts.decay > 0.3) {
    addMoss(b, Math.round(opts.mossBias * rng.range(3, 9)), rng, () => {
      const a = rng.next() * 6.28, rr = radius * rng.range(0.2, 1.0);
      return { x: Math.cos(a) * rr, y: rng.range(0, height), z: Math.sin(a) * rr, s: radius * 0.5 };
    });
  }

  return { family: 'stump', geo: b.finish(), radius: radius * 1.6, height, solid: true };
}

/**
 * Buttress roots for the base of a *standing* tree.
 *
 * Placed by the scatter system at a trunk position so a mature tree stops being
 * a cylinder pushed into a flat plane. One of the highest-value details
 * available: tree bases sit at torch level constantly, and a hard
 * cylinder/ground intersection is the most recognisable "procedural demo" tell
 * in a forest scene.
 */
export function makeRootFlare(rng: SeededRandom, opts: {
  trunkRadius: number; count: number; mossBias: number; decay: number;
}): PropSpec {
  const b = new PropBuilder();
  const look = woodLook(opts.decay * 0.5, opts.mossBias, rng);
  const tr = opts.trunkRadius;
  const n = Math.max(3, opts.count);
  // Uneven angular distribution: real buttresses are not radially symmetric,
  // and evenly spaced ones read as a machined collar.
  let a = rng.next() * 6.28;
  for (let i = 0; i < n; i++) {
    a += ((Math.PI * 2) / n) * rng.range(0.55, 1.5);
    const len = tr * rng.range(1.7, 3.6);
    const thick = tr * rng.range(0.22, 0.44);
    const segs = 5;
    const spine: SpinePoint[] = [];
    for (let k = 0; k <= segs; k++) {
      const kt = k / segs;
      // Starts *inside* the trunk radius so the root visually emerges from the
      // bark. A root starting exactly at the trunk surface always shows a seam.
      const rad = tr * 0.55 + (len - tr * 0.55) * kt;
      spine.push({
        x: Math.cos(a) * rad,
        y: tr * (0.85 - kt * 1.5) - kt * kt * tr * 0.5,
        z: Math.sin(a) * rad,
        r: thick * (1 - kt * 0.62),
      });
    }
    sweepTube(b, spine, 6, look.tileId, 2.2, look.tint, 0.13, rng, false, false);
  }
  return { family: 'rootFlare', geo: b.finish(), radius: tr * 3, height: tr, solid: false };
}

/** An exposed root arching over a hollow — you can see under it. */
export function makeRootArch(rng: SeededRandom, opts: {
  span: number; thickness: number; mossBias: number;
}): PropSpec {
  const b = new PropBuilder();
  const look = woodLook(0.45, opts.mossBias, rng);
  const segs = 8;
  const spine: SpinePoint[] = [];
  const skew = rng.range(-0.3, 0.3);
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    spine.push({
      x: (t - 0.5) * opts.span,
      // Both ends dip below zero so the arch plants into the ground instead of
      // resting on top of it.
      y: Math.sin(t * Math.PI) * opts.span * 0.19 - opts.thickness * 0.9,
      z: Math.sin(t * Math.PI) * opts.span * skew,
      r: opts.thickness * (0.72 + Math.sin(t * Math.PI) * 0.4),
    });
  }
  sweepTube(b, spine, 7, look.tileId, Math.max(2, opts.span), look.tint, 0.17, rng, false, false);
  return {
    family: 'rootArch', geo: b.finish(),
    radius: opts.span * 0.5, height: opts.span * 0.2, solid: false,
  };
}

/** A rock. `size` spans gravel to boulder; the family name follows from it. */
export function makeRock(rng: SeededRandom, opts: {
  size: number; mossBias: number; wetness: number;
}): PropSpec {
  const b = new PropBuilder();
  const s = opts.size;
  // Grey with a faint iron/ochre drift, darker when wet. Kept low-contrast on
  // purpose: a bright rock in a night forest reads as a light source.
  const g = 0.30 + rng.next() * 0.16 - opts.wetness * 0.09;
  const tint = {
    r: g * (1 + rng.range(-0.05, 0.10)),
    g: g * (1 + rng.range(-0.04, 0.05)),
    b: g * (1 + rng.range(-0.02, 0.12)),
  };
  const angular = clamp01(0.25 + s * 0.5 + rng.range(-0.15, 0.15));
  // Triangle budget follows apparent size: a pebble at 7x5 is 70 tris, a
  // boulder at 14x9 is 252. Spending boulder detail on gravel would be most of
  // this layer's cost for none of its effect.
  const segU = s > 0.7 ? 14 : s > 0.25 ? 10 : 7;
  const segV = s > 0.7 ? 9 : s > 0.25 ? 7 : 5;
  buildBlob(b, s, rng.range(0.45, 0.75), angular, tint, TILE.barkSnag, 1.6, rng, segU, segV);

  if (s > 0.22 && opts.mossBias > 0.3) {
    addMoss(b, Math.round(opts.mossBias * rng.range(2, 7)), rng, () => {
      const a = rng.next() * 6.28, rr = s * rng.range(0.15, 0.65);
      return { x: Math.cos(a) * rr, y: s * 0.30, z: Math.sin(a) * rr, s: s * 0.7 };
    });
  }

  return {
    family: s > 0.55 ? 'boulder' : s > 0.16 ? 'stone' : 'pebble',
    geo: b.finish(),
    radius: s, height: s * 0.75, solid: s > 0.5,
  };
}

/**
 * A moss mound — an indeterminate lump under a moss blanket.
 *
 * Deliberately ambiguous. In a mature wet forest a great deal of the floor
 * relief is *something* that has been completely overgrown and you cannot tell
 * what. Cheap, reads as soft, and breaks up the ground plane's silhouette,
 * which is the job.
 */
export function makeMossMound(rng: SeededRandom, opts: { size: number }): PropSpec {
  const b = new PropBuilder();
  const s = opts.size;
  buildBlob(b, s, 0.62, 0.05, { r: 0.26, g: 0.36, b: 0.20 }, TILE.mossDrape, 1.2, rng, 9, 6);
  addMoss(b, rng.int(3, 8), rng, () => {
    const a = rng.next() * 6.28, rr = s * rng.range(0.1, 0.7);
    return { x: Math.cos(a) * rr, y: s * 0.25, z: Math.sin(a) * rr, s: s * 0.9 };
  });
  return { family: 'mossMound', geo: b.finish(), radius: s, height: s * 0.6, solid: false };
}

/**
 * Bracket fungi and small caps.
 *
 * Included because fungi are one of the few things in a night forest that are
 * *lighter* than their surroundings, so under a flashlight they punctuate the
 * floor. A small number of pale shapes does a disproportionate amount to make
 * ground look alive.
 */
export function makeFungus(rng: SeededRandom, opts: { size: number; bracket: boolean }): PropSpec {
  const b = new PropBuilder();
  const s = opts.size;
  const caps = opts.bracket ? rng.int(2, 4) : rng.int(1, 3);
  const pale = 0.55 + rng.next() * 0.30;
  const tint = { r: pale, g: pale * rng.range(0.86, 0.97), b: pale * rng.range(0.66, 0.84) };
  for (let c = 0; c < caps; c++) {
    const cx = rng.range(-s, s) * 0.9, cz = rng.range(-s, s) * 0.9;
    const cs = s * rng.range(0.55, 1.15);
    const cy = opts.bracket ? rng.range(0.2, 1.0) * s * 2 : 0;
    const segU = 8;
    const ring: number[] = [];
    for (let i = 0; i < segU; i++) {
      const a = (i / segU) * Math.PI * 2;
      // Wavy rim — a perfectly circular cap looks like a plastic button.
      const rr = cs * (1 + Math.sin(a * 3 + c) * 0.16);
      ring.push(b.vertex(
        cx + Math.cos(a) * rr, cy + cs * 0.16, cz + Math.sin(a) * rr,
        Math.cos(a) * 0.3, 0.9, Math.sin(a) * 0.3,
        0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5,
        tint.r * 0.7, tint.g * 0.7, tint.b * 0.7,
        TILE.leafDry, 1, 1,
      ));
    }
    const apex = b.vertex(cx, cy + cs * 0.5, cz, 0, 1, 0, 0.5, 0.5,
      tint.r, tint.g, tint.b, TILE.leafDry, 1, 1);
    // A dark gill underside. Without it the cap is a bright disc from every
    // angle, and the pale-punctuation effect turns into a glowing dot.
    const under = b.vertex(cx, cy - cs * 0.05, cz, 0, -1, 0, 0.5, 0.5,
      tint.r * 0.35, tint.g * 0.34, tint.b * 0.30, TILE.leafDry, 1, 1);
    for (let i = 0; i < segU; i++) {
      const j = (i + 1) % segU;
      b.tri(apex, ring[i], ring[j]);
      b.tri(under, ring[j], ring[i]);
    }
  }
  return { family: 'fungus', geo: b.finish(), radius: s * 1.3, height: s * 0.6, solid: false };
}

/**
 * A shed bark plate lying on the duff.
 *
 * The cheapest prop here and one of the most useful. Mature conifer bark sheds
 * in curved plates the size of a hand, they collect around the base of every
 * old tree, and because they are *curved* they catch the beam on one edge and
 * shadow on the other — real-looking relief for eight triangles.
 */
export function makeBarkFleck(rng: SeededRandom, opts: { size: number }): PropSpec {
  const b = new PropBuilder();
  const s = opts.size;
  const cols = 3, rows = 2;
  const curve = rng.range(0.15, 0.50);
  const tint = {
    r: 0.34 + rng.next() * 0.16,
    g: 0.27 + rng.next() * 0.12,
    b: 0.20 + rng.next() * 0.09,
  };
  const grid: number[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: number[] = [];
    const fy = r / rows - 0.5;
    for (let c = 0; c <= cols; c++) {
      const fx = c / cols - 0.5;
      // Cupped: lifted at the rim, so it sits on the ground like a curl of bark
      // rather than lying flat like a sticker.
      const lift = (fx * fx + fy * fy * 0.5) * curve * s * 2;
      row.push(b.vertex(
        fx * s, lift, fy * s * rng.range(0.7, 1.0),
        fx * curve, 1, fy * curve,
        fx + 0.5, fy + 0.5,
        tint.r, tint.g, tint.b,
        TILE.barkMatureConifer, 1, 1,
      ));
    }
    grid.push(row);
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      b.quad(grid[r][c], grid[r + 1][c], grid[r + 1][c + 1], grid[r][c + 1]);
    }
  }
  return { family: 'barkFleck', geo: b.finish(), radius: s * 0.6, height: s * 0.2, solid: false };
}
