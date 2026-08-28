/**
 * ============================================================================
 * Perceptibility — horror design as an optimisation oracle
 * ============================================================================
 *
 * ### The observation
 *
 * STATIC spends most of its GPU budget rendering detail the player provably cannot
 * see, and it does so *because of* its own art direction rather than in spite of it.
 *
 * Three facts about this game, all already true in the shipped code:
 *
 *  1. **The world is lit by a 62 m cone of half-angle 0.46 rad.** Outside that cone,
 *     in a moonless forest under `FogExp2(0x070b12, 0.0155)`, surfaces sit a few
 *     percent above black. `Flashlight.OUTER_ANGLE`/`RANGE` define the only region
 *     with real luminance in it.
 *
 *  2. **Exposure is auto-adapted, in HDR, to whatever the beam is pointed at.**
 *     `RenderPipeline`'s 1x1 log-luminance reduction plus the AgX display transform
 *     mean that when the beam is on near bark, everything outside it is mapped
 *     *below the display's representable range*. Ambient-occlusion detail written
 *     into those pixels is written into a clamp.
 *
 *  3. **The composite pass deliberately destroys detail, and does so more as fear
 *     rises.** Barrel distortion, chromatic aberration, tape wobble, head-switching,
 *     scanlines, static noise, dropout scratches, film grain, vignette and a
 *     `desat`/`level` term all scale with `FearSystem.staticLevel`. High fear means
 *     the frame is *about to be buried in noise by design*.
 *
 * The renderer currently computes HBAO, ray-marched single-scattering volumetrics and
 * full-resolution shadow detail into all of it, at constant effort, then throws the
 * result away in the composite. Nothing in the engine knows that.
 *
 * ### The inversion
 *
 * In most engines "scary post-processing" is overhead the renderer pays for. Here it
 * should be a **licence to do less work** — and the timing is close to perfect:
 *
 * ```
 *   fear rises  ->  entity is near  ->  MORE dynamic CPU/GPU work needed
 *   fear rises  ->  static rises    ->  LESS image detail survives to the eye
 * ```
 *
 * The two curves align. The most expensive moments in the game are also the most
 * forgiving ones. This class computes the scalar that lets the rest of the engine
 * exploit that, and hands it to the renderer, the streamer, the AI and the audio.
 *
 * ### What this is NOT
 *
 * It is not a quality *controller*. `PerfGovernor` decides how much we can afford;
 * this decides *where* it is worth spending. Keeping the two separate is what stops
 * the engine from confusing "the machine is struggling" with "the player cannot see
 * this anyway" — they call for different responses, and conflating them is how you
 * end up degrading a clearing in broad moonlight because the fear meter was high.
 *
 * ### Cost
 *
 * All inputs are already computed elsewhere in the frame. This class does a handful
 * of scalar operations and one 4 m occupancy lookup per call, at scheduler cadence
 * rather than per frame, and allocates nothing. It is effectively free.
 */

/** Everything the field needs, all of it already available in `StaticGame.update()`. */
export interface PerceptInput {
  /** flashlight on, and its current strength 0..1 (battery sag + flicker) */
  beamOn: boolean;
  beamStrength: number;
  /** 0..1 fear/static level driving the composite's noise terms */
  staticLevel: number;
  /** 0..1 desaturation term */
  desat: number;
  /** 0..1 viewfinder weight — extra CA + scanlines + wobble */
  viewfinder: number;
  /** current auto-exposure compensation; >1 means the scene is dark */
  exposure: number;
  /** 0..1 canopy occupancy at the camera, from ScatterSystem's shared 4 m field */
  canopy: number;
  /** 0..1 moon contribution right now (Sky.moonDimAt) */
  moon: number;
  /** metres to the entity — the one thing that must never be degraded */
  entityDistance: number;
  /** is the entity currently on screen and lit */
  entityVisible: boolean;
  /** player speed, m/s — fast motion hides spatial detail (and TAA lags anyway) */
  speed: number;
  /** 0..1 rainfall — rain streaks and wet specular add their own visual noise */
  rain: number;
}

/**
 * The output field. Each term is 0..1 where 1 = "full detail is worth rendering".
 * Consumers multiply their own effort by the term that matches what they produce.
 */
export interface PerceptField {
  /**
   * Master scalar: how much of *any* fine detail survives to the player's eye.
   * Consumers with no more specific term should use this.
   */
  detail: number;
  /**
   * Ambient occlusion. Degrades hardest, because AO is a low-frequency darkening
   * of already-dark regions — the first thing static noise erases and the last
   * thing a player could name as missing.
   */
  ao: number;
  /**
   * Volumetric in-scatter. Degrades *least*: the beam shaft is the single most
   * load-bearing visual in the game, so it holds effort even when everything else
   * gives up. This is the concrete form of "maximum visual impact per unit cost".
   */
  volumetric: number;
  /** Shadow-map resolution and refresh appetite. */
  shadow: number;
  /** Vegetation LOD/near-tier appetite. */
  vegetation: number;
  /** Particle, dust and wisp density. */
  particles: number;
  /**
   * Screen-space sharpness worth preserving: gates TAA/CAS aggressiveness and how
   * far internal resolution may fall before it is noticed.
   */
  sharpness: number;
  /**
   * Simulation fidelity multiplier for secondary motion (cloth, sway detail, foot IK
   * sub-steps). Independent of the visual terms because it is CPU, not GPU.
   */
  sim: number;
}

/** Smoothing: perceptibility must not step, or effort changes become visible flicker. */
const RISE = 0.10;   // toward more detail — quick, so entering a clearing looks right
const FALL = 0.035;  // toward less detail — slow, so we never strobe effort

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v;

export class Perceptibility {
  /** Live field. Mutated in place — no allocation, and consumers may hold the reference. */
  readonly field: PerceptField = {
    detail: 1, ao: 1, volumetric: 1, shadow: 1,
    vegetation: 1, particles: 1, sharpness: 1, sim: 1,
  };

  /** Raw (unsmoothed) targets, kept for diagnostics so tuning is explicable. */
  private target: PerceptField = {
    detail: 1, ao: 1, volumetric: 1, shadow: 1,
    vegetation: 1, particles: 1, sharpness: 1, sim: 1,
  };

  /**
   * Master enable. Off restores constant full effort, which is the control condition
   * for any before/after comparison and the escape hatch if a player reports that a
   * scene "changes when I get scared".
   */
  enabled = true;

  /**
   * Floor on every term. Nothing here may ever reach zero: a system that vanishes is
   * a bug report, whereas a system at 40% effort is invisible. This is the same rule
   * AGENTS.md states as "never fix a complaint by deleting content".
   */
  floor = 0.35;

  private lastNoise = 0;
  private lastLit = 1;

  /**
   * Recompute the field. Call at ~10 Hz from the scheduler, not per frame — the inputs
   * change on human timescales and smoothing handles the rest.
   */
  update(dt: number, i: PerceptInput): void {
    if (!this.enabled) {
      const f = this.field;
      f.detail = f.ao = f.volumetric = f.shadow = 1;
      f.vegetation = f.particles = f.sharpness = f.sim = 1;
      return;
    }

    // ---- 1. how much image-destroying noise is the composite about to add? ----
    //
    // These are the same terms the composite scales its grain/scanline/dropout/CA
    // strength by, combined the same way (saturating rather than additive, because
    // two noise sources do not erase twice as much detail as one).
    const noise = clamp01(
      i.staticLevel * 0.72 +
      i.viewfinder * 0.34 +
      i.desat * 0.18 +
      i.rain * 0.20,
    );
    this.lastNoise = noise;

    // ---- 2. how much of the frame has real luminance in it? ----
    //
    // The beam is the dominant term by an order of magnitude. Moonlight through a
    // closed canopy is the secondary term, and the canopy field we already maintain
    // for lighting/audio/AI tells us how much of it survives.
    const moonThrough = i.moon * (1 - i.canopy * 0.85);
    const beam = i.beamOn ? i.beamStrength : 0;
    // Saturating combination: a lit frame is lit, and adding moonlight to a beam does
    // not double the amount of visible detail.
    const lit = clamp01(beam * 0.80 + moonThrough * 0.55 + 0.06);
    this.lastLit = lit;

    // Exposure feedback. `exposure > 1` means auto-exposure has opened up to find
    // something to look at, i.e. the frame is genuinely dark and AgX is crushing the
    // shadows. That is precisely when fine detail cannot be resolved.
    const exposureDark = clamp01((i.exposure - 1) * 0.55);

    // ---- 3. motion ----
    // Above walking pace, spatial detail is smeared by TAA reprojection and motion
    // blur anyway. This is not a perceptual guess — it is a statement about what the
    // existing temporal passes already do to the image.
    const motion = clamp01((i.speed - 2.4) / 5.0);

    // ---- 4. the entity override ----
    //
    // Non-negotiable. The entity is the game; if it is near or visible, everything
    // that could affect how it reads snaps back to full effort regardless of how
    // noisy or dark the frame is. Degrading the frame at the exact moment the player
    // is trying to resolve a silhouette would be the worst possible trade, and it is
    // the trade a naive "high fear = less detail" rule would make.
    const proximity = clamp01((34 - i.entityDistance) / 26);
    const guard = i.entityVisible ? 1 : proximity;

    // ---- 5. compose per-consumer targets ----
    const t = this.target;

    // Base: detail worth rendering falls with noise and darkness, rises with light.
    const base = clamp01((1 - noise * 0.62) * (0.34 + 0.66 * lit) * (1 - exposureDark * 0.30));

    t.detail = Math.max(base, guard);

    // AO: the most degradable term. Low-frequency darkening in already-dark regions
    // is what static noise erases first.
    t.ao = Math.max(this.floor, clamp01(base * (1 - noise * 0.30) * (1 - motion * 0.25)));

    // Volumetrics: the least degradable. The beam shaft is the signature image of the
    // game, and it is *most* visible exactly when the frame is dark — the opposite
    // dependency to everything else here, so it barely tracks `lit` at all.
    t.volumetric = Math.max(0.55, clamp01(0.62 + 0.38 * beam - noise * 0.22));

    // Shadows: track lit-ness strongly. A shadow in a region with no light in it is
    // not a shadow.
    t.shadow = Math.max(this.floor, clamp01((0.25 + 0.75 * lit) * (1 - noise * 0.28)));
    t.shadow = Math.max(t.shadow, guard * 0.85);

    // Vegetation: this is the silhouette, and silhouette survives darkness better than
    // surface detail does (it is a depth/occlusion cue, not a luminance one). Degrade
    // gently, and hold it up under motion because that is when pop-in is visible.
    t.vegetation = Math.max(0.55, clamp01(0.68 + 0.32 * lit - noise * 0.18 + motion * 0.10));

    // Particles: dust motes are only visible *in* the beam (the dust shader multiplies
    // by cone(angle)/d^2 already), so with the light off they are near-invisible and
    // their budget is nearly free to reclaim.
    t.particles = Math.max(this.floor, clamp01(0.30 + 0.70 * beam - noise * 0.25));

    // Sharpness: how much a resolution drop would be noticed. Noise and motion both
    // hide it; a still, lit, clean frame does not. This is what lets internal
    // resolution fall further during a static burst than during a calm clearing.
    t.sharpness = Math.max(this.floor, clamp01((1 - noise * 0.70) * (1 - motion * 0.35) * (0.45 + 0.55 * lit)));

    // Sim fidelity: CPU-side, so it keys off *attention* rather than luminance. When
    // the entity is far and unseen, secondary motion on it cannot be evaluated by the
    // player at all.
    t.sim = Math.max(this.floor, Math.max(guard, clamp01(0.45 + 0.55 * lit)));

    // ---- 6. asymmetric smoothing ----
    const f = this.field;
    f.detail = this.approach(f.detail, t.detail, dt);
    f.ao = this.approach(f.ao, t.ao, dt);
    f.volumetric = this.approach(f.volumetric, t.volumetric, dt);
    f.shadow = this.approach(f.shadow, t.shadow, dt);
    f.vegetation = this.approach(f.vegetation, t.vegetation, dt);
    f.particles = this.approach(f.particles, t.particles, dt);
    f.sharpness = this.approach(f.sharpness, t.sharpness, dt);
    f.sim = this.approach(f.sim, t.sim, dt);
  }

  /**
   * Exponential approach with a rate that depends on direction.
   *
   * Rising fast matters: walking out of a thicket into moonlight must look right
   * immediately, or the player sees the world "resolving". Falling slowly matters
   * more: any oscillation in effort reads as the renderer malfunctioning, and in a
   * horror game the player cannot tell that from an intentional effect — which makes
   * it worse than a lower frame rate.
   */
  private approach(cur: number, target: number, dt: number): number {
    const rate = target > cur ? RISE : FALL;
    // Frame-rate independent: 1 - exp(-k*dt) rather than a raw lerp, so the smoothing
    // behaves identically at 30 and 144 fps. The old codebase is full of
    // `x += (t-x) * min(1, dt*k)` which is not, and that inconsistency is part of why
    // effects felt different at different frame rates.
    const k = 1 - Math.exp(-dt / Math.max(rate, 1e-4));
    return cur + (target - cur) * k;
  }

  /** Force the field to a value — warp, level start, or a test. */
  snap(): void {
    const f = this.field, t = this.target;
    f.detail = t.detail; f.ao = t.ao; f.volumetric = t.volumetric;
    f.shadow = t.shadow; f.vegetation = t.vegetation; f.particles = t.particles;
    f.sharpness = t.sharpness; f.sim = t.sim;
  }

  /**
   * Estimated GPU work avoided, 0..1, as a *weighted* mean over the terms.
   *
   * Weights approximate each term's share of the per-pixel budget in this pipeline:
   * volumetrics march the most samples, AO is next, shadows are a separate geometry
   * pass, and resolution scales everything. This is an analytical estimate, not a
   * measurement — the authoring environment cannot measure GPU time — so it is
   * labelled as such wherever it is displayed.
   */
  savingEstimate(): number {
    const f = this.field;
    const w = f.volumetric * 0.34 + f.ao * 0.22 + f.shadow * 0.18
      + f.sharpness * 0.16 + f.vegetation * 0.07 + f.particles * 0.03;
    return clamp01(1 - w);
  }

  /** Diagnostics. Allocates; debug API and the F3 overlay only. */
  debug(): Record<string, number | boolean> {
    const f = this.field;
    return {
      enabled: this.enabled,
      noise: +this.lastNoise.toFixed(3),
      lit: +this.lastLit.toFixed(3),
      detail: +f.detail.toFixed(3),
      ao: +f.ao.toFixed(3),
      volumetric: +f.volumetric.toFixed(3),
      shadow: +f.shadow.toFixed(3),
      vegetation: +f.vegetation.toFixed(3),
      particles: +f.particles.toFixed(3),
      sharpness: +f.sharpness.toFixed(3),
      sim: +f.sim.toFixed(3),
      savingEst: +this.savingEstimate().toFixed(3),
    };
  }
}
