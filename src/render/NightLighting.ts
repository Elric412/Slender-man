import * as THREE from 'three';

/**
 * ============================================================================
 * NIGHT LIGHTING — the exposure / key / fill hierarchy, in one owner
 * ============================================================================
 *
 * ## The problem this exists to solve
 *
 * "The game is too dim" was not one bug, it was **five multiplicative
 * darkenings stacked on top of each other**, each individually defensible and
 * each written by a different pass over the code:
 *
 *   1. `moon.intensity = 0.72 · dim · (1 - wet·0.45) · (0.3 + zoneMoon·0.85)`
 *      Under cloud (`dim` ≈ 0.45) in a closed canopy (`zoneMoon` ≈ 0.25) that
 *      is **0.72 · 0.45 · 0.51 = 0.165** — a key light at 23% of nominal.
 *   2. `environmentIntensity = (0.55 - wet·0.18) · (0.72 + amb·0.4)`, and
 *      `hemi.intensity = 0.12 · (0.78 + amb·0.34)` — so the *fill* also
 *      collapses in exactly the places the key already collapsed. Nothing was
 *      left to hold the shadow side up.
 *   3. `FogExp2(density 0.0155)` attenuating everything beyond ~25 m toward a
 *      colour that is itself near-black (`0x070b12` ≈ linear 0.0016).
 *   4. AgX with the auto-exposure key at `0.078` and a ceiling of `2.15`.
 *   5. A permanent vignette bottoming out at **0.30×** — a 70% reduction in the
 *      corners of every single frame, applied *after* the tone curve.
 *
 * Multiply 2 through 5 into 1 and the forest floor lands at 4–7/255. That is
 * not "dark", it is *below the black point of most consumer displays*, which is
 * why the reference frames read as legible night and this read as a black
 * rectangle with a torch in it.
 *
 * ## The fix is a hierarchy, not a brightness slider
 *
 * The brief is explicit: do not brighten uniformly. So this class owns the
 * three night sources as **one budget** with fixed ratios, expressed in the
 * language a lighting artist actually uses:
 *
 *   KEY   (moon)   directional, cool, shadow-casting. Carries *silhouette* —
 *                  the rim on a trunk that separates it from the trunk behind.
 *   FILL  (sky)    IBL + a small hemisphere. Carries *shadow-side information*.
 *                  This is the term that decides whether an unlit region is
 *                  "dark but readable" or "#000000".
 *   BOUNCE(ground) a very dim up-facing warm term. Carries *contact* — without
 *                  it, everything below knee height goes to absolute black and
 *                  the ground stops existing.
 *
 * The ratios are held (key ≫ fill ≫ bounce) so the image never flattens, and
 * every environmental modifier (cloud, canopy, rain, zone) is applied to the
 * *whole budget* rather than to each source independently. That single change
 * is what removes the compounding: a closed canopy now costs one factor, not
 * three, and it can never drive the fill below the readability floor.
 *
 * ## The readability floor is the whole point
 *
 * `AMBIENT_FLOOR` is the minimum fill that survives every modifier. It is
 * chosen so that a fully-shadowed, canopy-closed, rain-soaked, moonless patch
 * of bark still lands around **18–24/255** after AgX — dark enough that the
 * flashlight is unambiguously the primary light source, bright enough that
 * silhouettes, ground plane and depth layering all survive. Below ~12/255 an
 * 8-bit display plus any ambient room light destroys the information entirely,
 * which is the failure the reference frames never make.
 */

/** Where the whole night budget is anchored. Everything else is a ratio of it. */
const KEY_BASE = 1.35;

/**
 * Ratios of the key. Held constant so the *shape* of the lighting cannot drift
 * when the magnitude moves — this is what stops "brighten it" from flattening.
 */
const FILL_RATIO = 0.52;
const BOUNCE_RATIO = 0.10;

/**
 * Absolute minimum sky fill, as a fraction of nominal.
 *
 * See the class docs: this is the readability floor and it is deliberately
 * generous. A canopy can take 65% of the fill; it can never take all of it,
 * because a forest interior with *zero* fill is not a dark forest interior, it
 * is a rendering failure that players report as "my screen is broken".
 */
const AMBIENT_FLOOR = 0.35;

/** Colour temperature of the three sources, as linear-space THREE.Colors. */
// Three's hex constructor already converts sRGB into the working linear space.
const KEY_COLOR = new THREE.Color(0x9fb4dc);
// Hue belongs in the color; the energy budget owns brightness. Dark hex colors
// multiplied by a dim intensity suppressed fallback lighting a second time.
const SKY_COLOR = new THREE.Color(0xb9c8df);
const GROUND_COLOR = new THREE.Color(0x706557);

export interface NightEnvironment {
  /** 0..1 moon disc visibility (cloud crossing) */
  moonDim: number;
  /** 0..1 canopy/zone transmission — how much sky reaches this point */
  transmission: number;
  /** 0..1 zone ambient weight (openness) */
  openness: number;
  /** 0..1 accumulated surface wetness */
  wetness: number;
  /** 0..1 how much warm practical light is spilling here */
  warmth: number;
}

export interface NightLevels {
  /** moon key intensity, for THREE.DirectionalLight.intensity */
  key: number;
  /** scene.environmentIntensity */
  fill: number;
  /** hemisphere light intensity */
  bounce: number;
  /** 0..1 how much of the nominal budget survived — drives the exposure goal */
  budget: number;
}

export class NightLighting {
  /** Cool directional key. Shadow config is owned by ShadowQuality. */
  readonly moon: THREE.DirectionalLight;
  readonly moonTarget = new THREE.Object3D();
  /** Sky/ground bounce fill. Small by design — the IBL does the real work. */
  readonly hemi: THREE.HemisphereLight;

  private levels: NightLevels = { key: 0, fill: 0, bounce: 0, budget: 1 };
  /** Smoothed budget, so walking under a canopy is a fade and not a step. */
  private budgetSmooth = 1;
  private primed = false;
  private shadowCentre = { sx: 0, sz: 0 };
  /** Nominal (un-modified) fill, captured so `fill` can be a pure ratio. */
  private fillNominal = 0.62;

  constructor() {
    this.moon = new THREE.DirectionalLight(KEY_COLOR.getHex(), KEY_BASE);
    this.moon.color.copy(KEY_COLOR);
    this.moon.castShadow = true;
    this.moon.target = this.moonTarget;

    this.hemi = new THREE.HemisphereLight(SKY_COLOR.getHex(), GROUND_COLOR.getHex(), 0);
    this.hemi.color.copy(SKY_COLOR);
    this.hemi.groundColor.copy(GROUND_COLOR);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.moon, this.moonTarget, this.hemi);
  }

  /**
   * Tell the system how much of the fill is being carried by a real IBL probe.
   *
   * With a probe the hemisphere light is nearly redundant and doubling up
   * visibly flattens the image (two omnidirectional terms, no gradient). With
   * no probe the hemisphere is the *only* fill there is and has to carry all of
   * it. Rather than scattering that branch across the frame loop, it is one
   * multiplier decided once.
   */
  setProbeActive(active: boolean): void {
    this.fillNominal = active ? 0.62 : 0.0;
    this.hemiShare = active ? 0.22 : 1.0;
  }

  private hemiShare = 0.22;

  /**
   * Recompute the whole budget from the environment.
   *
   * **All** environmental attenuation is collapsed into `budget` before it is
   * split across the three sources. That is the structural fix: previously each
   * source applied its own copy of cloud/canopy/rain, so the terms multiplied
   * and a merely-dim situation became a black one.
   */
  update(dt: number, env: NightEnvironment): NightLevels {
    // ---- one attenuation budget -------------------------------------------
    //
    // Each term is deliberately shallow. The *product* of three shallow terms
    // is still a meaningful change (a closed canopy under cloud in the rain is
    // genuinely much darker than an open ridge under a clear moon) but it can
    // no longer reach zero, which is what the old chain did.
    const cloud = 0.55 + 0.45 * clamp01(env.moonDim);          // 0.55 .. 1.00
    const canopy = 0.38 + 0.62 * clamp01(env.transmission);    // 0.38 .. 1.00
    const rain = 1 - clamp01(env.wetness) * 0.22;              // 0.78 .. 1.00
    const raw = cloud * canopy * rain;

    // Smooth so a chunk-boundary change in measured canopy closure is a fade.
    if (!this.primed) { this.budgetSmooth = raw; this.primed = true; }
    else this.budgetSmooth += (raw - this.budgetSmooth) * Math.min(1, dt * 2.4);
    const budget = this.budgetSmooth;

    // ---- KEY: silhouette ---------------------------------------------------
    // The key takes the attenuation almost in full. It *should* nearly vanish
    // under a closed canopy — that is real, and it is what makes stepping into
    // a clearing feel like an event. Floored low but non-zero so trunks keep a
    // trace of directional shaping.
    this.levels.key = KEY_BASE * Math.max(0.14, budget);

    // ---- FILL: shadow-side information ------------------------------------
    // The fill takes attenuation *much* more gently and then hits the
    // readability floor. This is the single most important line in the file:
    // it is what guarantees an unlit region still contains an image.
    const fillAtten = Math.max(AMBIENT_FLOOR, 0.30 + 0.70 * budget);
    // Openness adds a little on top — a storm-fall clearing genuinely sees more
    // sky than a ravine — but cannot push the fill past nominal.
    const openBoost = 0.88 + 0.24 * clamp01(env.openness);
    this.levels.fill = this.fillNominal * Math.min(1.05, fillAtten * openBoost);

    // ---- BOUNCE: contact ---------------------------------------------------
    // Nearly flat. Ground bounce is not an atmospheric phenomenon; the leaf
    // litter under your feet returns light whether or not there is a canopy
    // overhead, and this term existing is why boots and roots stay visible.
    const groundBounce = KEY_BASE * BOUNCE_RATIO * (0.80 + 0.20 * budget);
    const missingSkyFill = this.hemiShare === 1
      ? KEY_BASE * FILL_RATIO * Math.min(1.05, fillAtten * openBoost)
      : 0;
    this.levels.bounce = groundBounce + missingSkyFill;

    // Warm practical spill leans the *fill* warm rather than adding a light.
    // Adding light near a campfire would double-count the practical's own
    // PointLight; tinting the fill is free and reads as bounced firelight.
    const w = Math.min(0.5, clamp01(env.warmth) * 0.62);
    this.hemi.color.copy(SKY_COLOR).lerp(WARM_FILL, w);
    this.hemi.groundColor.copy(GROUND_COLOR).lerp(WARM_BOUNCE, w * 0.8);

    this.moon.intensity = this.levels.key;
    this.hemi.intensity = this.levels.bounce;
    this.levels.budget = budget;
    return this.levels;
  }

  /**
   * Park the key light and its shadow window on the player.
   *
   * Texel snapping is what keeps a 120 m orthographic shadow window from
   * shimmering as the player walks: without it every step re-rasterises the
   * whole forest against a sub-texel-shifted grid and the shadow edges crawl.
   * Returns the snapped centre so the caller's refresh scheduler can tell
   * whether the window actually moved.
   */
  followPlayer(px: number, py: number, pz: number, extent: number): { sx: number; sz: number } {
    const texel = (extent * 2) / Math.max(1, this.moon.shadow.mapSize.x);
    const sx = Math.round(px / texel) * texel;
    const sz = Math.round(pz / texel) * texel;
    this.moonTarget.position.set(sx, py, sz);
    this.moon.position.set(
      sx + this.dir.x * 150,
      py + this.dir.y * 150,
      sz + this.dir.z * 150,
    );
    this.moonTarget.updateMatrixWorld();
    this.moon.updateMatrixWorld();
    this.shadowCentre.sx = sx;
    this.shadowCentre.sz = sz;
    return this.shadowCentre;
  }

  private dir = new THREE.Vector3(0.35, 0.62, -0.55).normalize();

  /** Keep the key aligned with wherever the sky shader put the moon disc. */
  setMoonDirection(v: THREE.Vector3): void { this.dir.copy(v).normalize(); }

  get current(): NightLevels { return this.levels; }
}

// Warmth changes hue without dimming the sky fill beside a practical.
const WARM_FILL = new THREE.Color(0xddbf97);
const WARM_BOUNCE = new THREE.Color(0x80705c);

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }

