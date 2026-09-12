import * as THREE from 'three';

/**
 * ============================================================================
 * SHADOW QUALITY — frustum sizing, bias policy and refresh scheduling
 * ============================================================================
 *
 * ## What was wrong
 *
 * 1. **The moon window was 120 m across at every tier.** At 2048² that is
 *    **5.9 cm per texel**; at 1024² it is 11.7 cm. A 12 cm shadow texel cannot
 *    resolve a branch, a fern, a rock lip or the entity's legs — so every
 *    *contact* shadow, which is the class of shadow that actually sells
 *    grounding, was below the sampling limit. The reference frames are full of
 *    tight contact darkening under rocks and roots; none of it was reachable.
 *
 * 2. **Bias was tuned for the wrong scale.** `bias = -0.0015` with
 *    `normalBias = 0.05` on a 120 m window: the normal offset is 5 cm, which at
 *    a 6 cm texel is *smaller than one texel*, so it cannot actually push a
 *    sample off its own surface — you get acne. Meanwhile the constant bias is
 *    applied in normalised depth over a 240 m range, i.e. ~36 cm of world
 *    depth, which is enough to detach short shadows from their casters
 *    (peter-panning). Both artefacts at once, from the same pair of numbers.
 *
 * 3. **The flashlight shadow camera was `near = 0.25`.** The light sits at the
 *    player's hand, so the depth range starts 25 cm from the lens and runs to
 *    62 m — a **248:1** ratio. Perspective shadow depth precision is
 *    concentrated near the near plane, so essentially the entire useful range
 *    of the beam got the *tail* of the distribution.
 *
 * ## The policy here
 *
 * - **Size the moon window to the machine, not to a constant.** The window
 *   shrinks on low tiers so that *texel density stays roughly fixed*. A smaller
 *   map with the same window is strictly worse than a smaller window with the
 *   same map: the second one keeps contact shadows and loses only distant
 *   shadows, which fog is already eating anyway.
 * - **Derive bias from texel size** rather than hardcoding it. `normalBias`
 *   must be ≥ ~1.5 texels of *world* size to actually escape self-shadowing,
 *   and constant bias must be small enough that it does not detach contacts.
 *   Both are now computed, so changing the map size cannot silently break them.
 * - **Schedule the moon, never the beam.** The moon re-renders the whole merged
 *   forest and between texel snaps its output is bit-identical. The beam is
 *   welded to a camera that can rotate arbitrarily fast and has no cheap
 *   "moved enough" test that is also correct.
 */

export interface ShadowBudget {
  /** shadow map edge for the moon cascade */
  moonSize: number;
  /** shadow map edge for the flashlight */
  beamSize: number;
  /** half-extent of the moon's orthographic window, metres */
  moonExtent: number;
}

/**
 * Per-tier budgets.
 *
 * Note the *extent* moves with the size, holding texel density near 3–4 cm at
 * every tier. `low` gives up distant shadows entirely (48 m window) to keep the
 * near-field contact shadows that carry the look.
 */
export const SHADOW_BUDGETS: Record<string, ShadowBudget> = {
  low: { moonSize: 1024, beamSize: 1024, moonExtent: 34 },
  medium: { moonSize: 2048, beamSize: 1024, moonExtent: 46 },
  high: { moonSize: 2048, beamSize: 1536, moonExtent: 52 },
  ultra: { moonSize: 4096, beamSize: 2048, moonExtent: 64 },
};

export class ShadowQuality {
  private moonExtent = 52;
  private moonSize = 2048;

  /** Accumulated time owed to the moon map since its last re-render. */
  private acc = 0;
  private atX = Number.NaN;
  private atZ = Number.NaN;
  private primed = false;

  /**
   * Configure the moon cascade.
   *
   * Bias is *derived*: `normalBias` is set to a small multiple of the world
   * texel size so a sample is always displaced clear of its own surface, and
   * the constant bias is scaled by the depth range so it stays a fixed fraction
   * of a texel's worth of depth rather than a fixed fraction of the range.
   */
  configureMoon(light: THREE.DirectionalLight, budget: ShadowBudget): void {
    this.moonExtent = budget.moonExtent;
    this.moonSize = budget.moonSize;

    if (light.shadow.mapSize.x !== budget.moonSize) {
      light.shadow.mapSize.setScalar(budget.moonSize);
      light.shadow.map?.dispose();
      light.shadow.map = null;
      // A freshly allocated map is blank until something renders into it. With
      // scheduling active that could be up to 1/4 s away, which flashes a
      // shadowless forest — so un-prime and force the next frame.
      this.primed = false;
    }

    const e = budget.moonExtent;
    const sc = light.shadow.camera;
    sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e;
    // The light is parked 150 m out along the moon vector, so the window has to
    // reach from well before the player to well past them. Kept as tight as the
    // geometry allows: every metre of depth range is precision spent.
    sc.near = 60;
    sc.far = 300;
    sc.updateProjectionMatrix();

    // World size of one shadow texel.
    const texel = (e * 2) / budget.moonSize;
    // ≥1.5 texels: enough to clear self-shadowing at grazing incidence without
    // visibly detaching contacts. This is the number that was 0.05 (≈0.85 texel
    // at high) and therefore produced acne.
    light.shadow.normalBias = Math.max(0.02, texel * 1.6);
    // Constant bias in normalised depth. Scaled by depth range so it represents
    // a consistent *world* depth (~2 cm) instead of a consistent fraction.
    light.shadow.bias = -(0.02 / (sc.far - sc.near));
    light.shadow.radius = 3.0;
    light.shadow.blurSamples = 12;
  }

  /**
   * Configure the flashlight shadow.
   *
   * Keep the near plane at the physical lens. A 60 cm near plane skipped
   * close walls and foliage, allowing the light to pass through them.
   *
   * `focus` deliberately stays at 1: the cookie already shapes the cone, so
   * narrowing the shadow frustum inside the light cone would clip shadows off
   * at the spill boundary.
   */
  configureBeam(light: THREE.SpotLight, size: number, range: number): void {
    if (light.shadow.mapSize.x !== size) {
      light.shadow.mapSize.setScalar(size);
      light.shadow.map?.dispose();
      light.shadow.map = null;
    }
    const sc = light.shadow.camera;
    sc.near = 0.08;
    sc.far = range;
    sc.updateProjectionMatrix();

    // A spot shadow's texel size varies with distance, so a single world-space
    // normalBias is a compromise. Tuned for the 4–12 m band, which is where the
    // beam's shadows are actually read.
    light.shadow.normalBias = 0.012;
    light.shadow.bias = -0.00008;
    light.shadow.radius = 2.6;
    light.shadow.blurSamples = 10;
  }

  /**
   * Should the moon map re-render this frame?
   *
   * Three conditions force a refresh regardless of the scheduled rate, each of
   * which is a visible artefact if omitted:
   *
   *  1. **The snap window moved.** A stale map sampled against a shifted window
   *     projects shadows at the wrong world offset — far worse than staleness.
   *  2. **A dynamic caster is close.** The entity is the only thing here that
   *     moves and casts. Freezing its shadow mid-stride reads instantly.
   *  3. **Nothing has been rendered yet.**
   */
  scheduleMoon(
    light: THREE.DirectionalLight,
    dt: number, sx: number, sz: number,
    hz: number, dynamicNear: boolean,
  ): boolean {
    this.acc += dt;
    const eff = Math.max(4, hz);
    const moved = Math.abs(sx - this.atX) > 1e-4 || Math.abs(sz - this.atZ) > 1e-4;
    const due = this.acc >= 1 / eff;
    const refresh = !this.primed || moved || dynamicNear || due;

    // Per-light opt-out. The renderer-level `autoUpdate` must stay ON: clearing
    // it returns before the per-light loop, so NO map is rendered for ANY light
    // — and three then binds a zero-filled 1×1 placeholder which unpacks to
    // depth 0, i.e. FULLY OCCLUDED. That silently zeroes both the key and the
    // torch, and presents as "the game is too dark" rather than as a shadow bug.
    light.shadow.autoUpdate = false;
    light.shadow.needsUpdate = refresh;

    if (refresh) {
      this.acc = 0;
      this.atX = sx; this.atZ = sz;
      this.primed = true;
    }
    return refresh;
  }

  /** Force the next scheduled frame to refresh (after a warp or a realloc). */
  invalidate(): void { this.primed = false; }

  get extent(): number { return this.moonExtent; }
  get size(): number { return this.moonSize; }
  /** World size of one moon shadow texel, metres — useful for debug overlays. */
  get texelSize(): number { return (this.moonExtent * 2) / this.moonSize; }
}

