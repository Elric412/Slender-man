import * as THREE from 'three';

/**
 * ── PRACTICALS ────────────────────────────────────────────────────────────────
 *
 * Warm authored light sources: porch lamps, campfires, lit windows, the tower
 * searchlight, a signpost lantern.
 *
 * WHY THIS EXISTS
 * ---------------
 * The reference frames this game is chasing are not "dark forest + flashlight".
 * Every one of them has *two colour temperatures in the same image*: a warm
 * 2000-2700 K practical against ~6500 K moonlight and the cool-white beam. That
 * contrast is what makes those images read as photographed places rather than
 * as a dark WebGL scene. Fog, grain and bloom cannot manufacture it — you need
 * an actual warm source in the shot.
 *
 * Before this file the entire 560 m map had three PointLights.
 *
 * THE BUDGET PROBLEM
 * ------------------
 * A warm lamp at every landmark is ~16 dynamic lights. Three.js compiles the
 * light count into every material's program, so 16 lights means every one of
 * the forest's shaders does 16 light loops per fragment for a lamp 300 m away
 * and behind a hill. That is the "many unmeasured dynamic lights" failure the
 * render-recipes reference warns about, and on mobile it is fatal.
 *
 * So a practical is split into three parts with very different costs:
 *
 *   1. EMISSIVE SOURCE (always on, ~free). The visible hot surface — lamp
 *      glass, fire core, window pane. This is what you actually *see* and it
 *      costs one small mesh. A lamp with no real light still looks lit.
 *   2. GLOW CARD (always on, ~free). A camera-facing additive disc that fakes
 *      the atmospheric halo around the source. This is what makes a lamp
 *      readable from 200 m through fog, and it is why we do not need a real
 *      light to sell distance.
 *   3. REAL LIGHT (rationed). Actually illuminates nearby geometry and the
 *      player. Only the few nearest practicals get one, from a fixed pool
 *      allocated once at construction, so the shader light count is CONSTANT
 *      regardless of how many practicals the map places.
 *
 * The pool is re-assigned by distance as the player moves, with intensity
 * ramps on hand-off so a lamp never pops on or off.
 */

export type FlickerKind = 'steady' | 'flame' | 'fluor' | 'lantern' | 'beacon';

export interface PracticalDef {
  x: number; y: number; z: number;
  /** light colour — keep these warm; the moon is the only cool source */
  color: number;
  /** real-light intensity when this practical holds a pool slot */
  intensity: number;
  /** real-light falloff distance (m) */
  range: number;
  flicker?: FlickerKind;
  /** radius of the additive glow card; 0 disables it */
  glow?: number;
  /** emissive source geometry radius; 0 disables the visible bulb */
  bulb?: number;
  /** identifies the practical for gameplay queries (e.g. "is the cabin lit") */
  tag?: string;
}

interface Practical extends PracticalDef {
  flickerKind: FlickerKind;
  /** current flicker multiplier, 0..~1.3 */
  fl: number;
  /** pool slot index, or -1 */
  slot: number;
  /** 0..1 ramp used when acquiring/releasing a slot */
  ramp: number;
  /** per-practical phase so identical lamp types never flicker in sync */
  phase: number;
  glowMat: THREE.MeshBasicMaterial | null;
  bulbMat: THREE.MeshStandardMaterial | null;
  dist2: number;
  /** extinguished by the wrongness system; skipped by flicker and pooling */
  doused: boolean;
  /** intensity as authored, so relightAll() can restore it exactly */
  baseIntensity: number;
}

/** Colour temperature helpers, so the art direction is stated in Kelvin. */
export const K2000 = 0xff8b3a;   // open flame / campfire core
export const K2400 = 0xffa055;   // oil lantern, kerosene
export const K2700 = 0xffbe86;   // incandescent porch bulb
export const K3000 = 0xffd2ab;   // clean tungsten, tower searchlight
export const K4200 = 0xf2f0e2;   // failing fluorescent (sickly, not blue)

export class Practicals {
  readonly group = new THREE.Group();
  private items: Practical[] = [];
  private pool: THREE.PointLight[] = [];
  /** shared geometry — every bulb and card reuses these two */
  private bulbGeo = new THREE.SphereGeometry(1, 8, 6);
  private cardGeo = new THREE.PlaneGeometry(2, 2);
  private glowTex: THREE.Texture;
  private t = 0;

  /**
   * @param poolSize how many real lights may be lit at once. This is the only
   *   number that affects shader cost, so it is the quality dial.
   */
  constructor(poolSize: number) {
    this.group.name = 'practicals';
    this.glowTex = makeGlowTexture();
    for (let i = 0; i < poolSize; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.castShadow = false;   // practicals never cast: the moon is the shadow key
      this.group.add(l);
      this.pool.push(l);
    }
  }

  add(def: PracticalDef): void {
    const p: Practical = {
      ...def,
      flickerKind: def.flicker ?? 'steady',
      fl: 1, slot: -1, ramp: 0,
      phase: this.items.length * 2.399963,   // golden-angle: no two in phase
      glowMat: null, bulbMat: null, dist2: Infinity,
      doused: false, baseIntensity: def.intensity,
    };

    // --- visible hot surface -------------------------------------------------
    const bulbR = def.bulb ?? 0.11;
    if (bulbR > 0) {
      const m = new THREE.MeshStandardMaterial({
        color: 0x120c06,                 // near-black when unlit: it is glass
        emissive: new THREE.Color(def.color),
        emissiveIntensity: 2.4,
        roughness: 0.35, metalness: 0,
        toneMapped: true,                // let auto-exposure see it
      });
      const mesh = new THREE.Mesh(this.bulbGeo, m);
      mesh.position.set(def.x, def.y, def.z);
      mesh.scale.setScalar(bulbR);
      mesh.castShadow = false; mesh.receiveShadow = false;
      // Bulbs are small and always in view of *something*; frustum culling them
      // individually costs more than drawing them.
      this.group.add(mesh);
      p.bulbMat = m;
    }

    // --- atmospheric halo ----------------------------------------------------
    const glowR = def.glow ?? bulbR * 9;
    if (glowR > 0) {
      const m = new THREE.MeshBasicMaterial({
        map: this.glowTex,
        color: new THREE.Color(def.color),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // Depth-tested, so a lamp behind a trunk is correctly occluded — an
        // un-tested card reads as a glowing hole in the tree and instantly
        // destroys the illusion.
        depthTest: true,
        toneMapped: true,
      });
      const card = new THREE.Mesh(this.cardGeo, m);
      card.position.set(def.x, def.y, def.z);
      card.scale.setScalar(glowR);
      card.renderOrder = 3;
      // Camera-facing: assigned each frame in update().
      this.group.add(card);
      card.userData.isGlowCard = true;
      p.glowMat = m;
      (p as Practical & { card?: THREE.Mesh }).card = card;
    }

    this.items.push(p);
  }

  /**
   * Extinguish the nearest practical to a point, permanently for this run.
   *
   * The environmental-wrongness system's strongest and cheapest tool. A lamp
   * that was burning when you walked past it and is dark when you come back is
   * the ideal deniable change: it has an obvious mundane explanation (it ran
   * out), it needs no new geometry, and it is only unsettling if the player
   * happens to remember — which is exactly the "was that always like that?"
   * reaction the brief asks for.
   *
   * Implemented as a hard state change rather than a flicker so it cannot be
   * mistaken for the existing `fluor`/`beacon` flicker kinds, which the player
   * has already learned to read as normal.
   *
   * @param minDistance refuse if the nearest candidate is closer than this, so
   *        a light never dies in the player's face — that reads as a scripted
   *        effect, and the whole value of this beat is deniability.
   * @returns the position of the doused light, or null if none qualified.
   */
  douse(x: number, z: number, minDistance = 24): { x: number; y: number; z: number } | null {
    let best: Practical | null = null;
    let bd = Infinity;
    for (const p of this.items) {
      if (p.doused) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d < minDistance) continue;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return null;
    best.doused = true;
    best.intensity = 0;
    // Kill the visible source too. Leaving a lit bulb on a dead light is the
    // kind of half-applied state change that reads as a bug rather than as
    // something having happened.
    if (best.bulbMat) best.bulbMat.emissiveIntensity = 0;
    if (best.glowMat) best.glowMat.opacity = 0;
    return { x: best.x, y: best.y, z: best.z };
  }

  /** How many practicals have been extinguished this run. */
  get dousedCount(): number {
    let n = 0;
    for (const p of this.items) if (p.doused) n++;
    return n;
  }

  /** Relight everything. Called on run start; wrongness is per-run state. */
  relightAll(): void {
    for (const p of this.items) {
      if (!p.doused) continue;
      p.doused = false;
      p.intensity = p.baseIntensity;
    }
  }

  /** Is any practical tagged `tag` currently within `r` metres of (x,z)? */
  litNear(x: number, z: number, r: number, tag?: string): boolean {
    const r2 = r * r;
    for (const p of this.items) {
      if (tag && p.tag !== tag) continue;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  /** Warm-light contribution at a point, 0..1 — for grading and entity logic. */
  warmthAt(x: number, y: number, z: number): number {
    let sum = 0;
    for (const p of this.items) {
      const dx = p.x - x, dy = p.y - y, dz = p.z - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      const r2 = p.range * p.range;
      if (d2 > r2) continue;
      sum += p.intensity * p.fl * (1 - d2 / r2);
    }
    return Math.min(1, sum * 0.08);
  }

  /**
   * @param camPos used for pool assignment and to orient the glow cards
   * @param dt seconds
   */
  update(dt: number, camPos: THREE.Vector3, camQuat: THREE.Quaternion): void {
    this.t += dt;
    const t = this.t;

    // ── flicker ────────────────────────────────────────────────────────────
    // Each kind is a different physical failure mode. Sine-only flicker reads
    // as "shader effect"; these read as fire, gas and dying ballast.
    for (const p of this.items) {
      // A doused light is out. Skipping it here rather than zeroing at the end
      // keeps the emissive and glow surfaces dark too — the flicker block below
      // writes both every frame and would otherwise resurrect them.
      if (p.doused) { p.fl = 0; continue; }
      const ph = p.phase;
      switch (p.flickerKind) {
        case 'flame':
          // Fire: broadband, always moving, occasional big lick.
          p.fl = 0.74
            + Math.sin(t * 8.3 + ph) * 0.13
            + Math.sin(t * 19.7 + ph * 2.1) * 0.08
            + Math.sin(t * 3.1 + ph * 0.7) * 0.16
            + Math.max(0, Math.sin(t * 1.31 + ph)) * 0.14;
          break;
        case 'lantern':
          // Wick in a glass: slow breathing, rare guttering dip.
          p.fl = 0.92 + Math.sin(t * 1.7 + ph) * 0.06 + Math.sin(t * 4.3 + ph * 1.7) * 0.035;
          if (Math.sin(t * 0.37 + ph) > 0.995) p.fl *= 0.55;
          break;
        case 'fluor': {
          // Failing tube: mostly on, then a stutter burst. The long ON periods
          // are what make the stutter frightening rather than decorative.
          const cyc = (t * 0.31 + ph * 0.11) % 1;
          p.fl = cyc > 0.86
            ? (Math.sin(t * 47) > 0 ? 1.15 : 0.06)
            : 0.95 + Math.sin(t * 120 + ph) * 0.05;
          break;
        }
        case 'beacon': {
          // Rotating obstruction light: hard on/off, long dark.
          const cyc = (t * 0.42 + ph * 0.2) % 1;
          p.fl = cyc < 0.12 ? 1.25 : 0;
          break;
        }
        default:
          p.fl = 1;
      }

      if (p.bulbMat) {
        // Emissive tracks flicker so the source itself visibly gutters. Floor
        // at 0.15 for the hard-cut kinds: a fully black bulb pops out of
        // existence, a dim one reads as "it just went out".
        p.bulbMat.emissiveIntensity = 2.4 * Math.max(0.15, p.fl);
      }
      if (p.glowMat) {
        p.glowMat.opacity = 0.55 * Math.max(0, p.fl);
      }
      const card = (p as Practical & { card?: THREE.Mesh }).card;
      if (card) card.quaternion.copy(camQuat);   // billboard
    }

    // ── real-light assignment ──────────────────────────────────────────────
    // Sort by distance and hand the pool to the nearest N. Because the pool is
    // fixed-size and allocated up front, the material light count never
    // changes and nothing recompiles mid-run.
    for (const p of this.items) {
      const dx = p.x - camPos.x, dy = p.y - camPos.y, dz = p.z - camPos.z;
      p.dist2 = dx * dx + dy * dy + dz * dz;
    }
    const ranked = this.items
      .filter(p => !p.doused && p.dist2 < (p.range + 34) * (p.range + 34))
      .sort((a, b) => a.dist2 - b.dist2)
      .slice(0, this.pool.length);
    const chosen = new Set(ranked);

    // Release anything that lost its slot, ramping down rather than cutting.
    for (const p of this.items) {
      if (p.slot >= 0 && !chosen.has(p)) {
        p.ramp -= dt * 2.2;
        if (p.ramp <= 0) { p.ramp = 0; p.slot = -1; }
      }
    }
    // Assign free slots to the ranked list.
    const used = new Set<number>();
    for (const p of this.items) if (p.slot >= 0) used.add(p.slot);
    for (const p of ranked) {
      if (p.slot < 0) {
        for (let i = 0; i < this.pool.length; i++) {
          if (!used.has(i)) { p.slot = i; used.add(i); break; }
        }
      }
      if (p.slot >= 0) p.ramp = Math.min(1, p.ramp + dt * 2.2);
    }

    // Push state to the pool. Slots with no owner go to zero intensity, which
    // costs a light loop but contributes nothing — the price of a constant
    // shader light count, and it is the right trade.
    for (let i = 0; i < this.pool.length; i++) this.pool[i].intensity = 0;
    for (const p of this.items) {
      if (p.slot < 0 || p.ramp <= 0) continue;
      const l = this.pool[p.slot];
      l.position.set(p.x, p.y, p.z);
      l.color.setHex(p.color);
      l.distance = p.range;
      // ramp² so the hand-off is invisible: linear ramps are perceptible as a
      // brightness slide on the wall next to the lamp.
      l.intensity = p.intensity * p.fl * p.ramp * p.ramp;
    }
  }

  get count(): number { return this.items.length; }
  get poolSize(): number { return this.pool.length; }

  dispose(): void {
    this.bulbGeo.dispose();
    this.cardGeo.dispose();
    this.glowTex.dispose();
    for (const p of this.items) { p.glowMat?.dispose(); p.bulbMat?.dispose(); }
    this.items.length = 0;
  }
}

/**
 * Radial falloff for the glow card. Deliberately not a Gaussian: real lamp
 * haze has a small hot core and a very wide, very faint skirt, which a
 * quadratic-in-the-tail curve matches and a Gaussian does not (a Gaussian
 * gives you the "soft blue orb" look of a hundred asset-store fog sprites).
 */
function makeGlowTexture(): THREE.Texture {
  const N = 64;
  const data = new Uint8Array(N * N * 4);
  const c = (N - 1) / 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - c, y - c) / c;
      const a = d >= 1 ? 0
        : Math.pow(Math.max(0, 1 - d), 2.2) * 0.55 + Math.pow(Math.max(0, 1 - d), 12) * 0.45;
      const i = (y * N + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}
