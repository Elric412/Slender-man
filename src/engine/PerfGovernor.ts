/**
 * ============================================================================
 * PerfGovernor — continuous, attributing, thermally-aware quality control
 * ============================================================================
 *
 * ### What it replaces
 *
 * Two disconnected mechanisms:
 *
 *  1. `Config.probeQuality()` chose one of four presets from a GPU-string
 *     heuristic **once, at boot, and never revised it**. A laptop that
 *     thermally throttles after eight minutes stayed on the preset it booted
 *     with; a phone that booted while another app held the GPU was pinned low
 *     for the whole session.
 *  2. `RenderPipeline.adaptResolution()` moved two knobs (`renderScale`,
 *     `effortBias`) against a **mean** frame-time EMA.
 *
 * Mean frame time is the wrong signal. 60 fps with a 40 ms spike every second
 * feels considerably worse than a stable 45 fps, and a mean-driven controller
 * cannot distinguish them — both read ~18 ms. This controller drives on **p95
 * and frame-time variance**, which is what "smooth" actually means.
 *
 * ### Behaviours that are deliberate, not incidental
 *
 * **Asymmetric response.** Degrade within ~2 frames of trouble; recover only
 * after 3 seconds of clean frames. Oscillating quality is more noticeable than
 * being one notch too low — a resolution that breathes in and out reads as a
 * broken game, whereas a slightly soft image reads as a look.
 *
 * **Attribution over uniform scaling.** The governor is told *what* was
 * expensive (sim, render submission, GPU, background work). A CPU-bound frame
 * should lower simulation cadences and streaming, not internal resolution;
 * a GPU-bound frame should do the opposite. Uniform scaling wastes half of
 * every correction.
 *
 * **Thermal drift detection.** A slow monotonic rise in p95 over minutes with
 * no change in scene complexity is a throttling laptop, not a hard scene.
 * Hunting is the wrong response — the correct response is to lower the
 * *ceiling* so the controller stops trying to climb back into the wall.
 *
 * **Per-device persistence.** The settled scalar is stored keyed by a coarse
 * device fingerprint, so session two opens at the operating point session one
 * converged on instead of re-deriving it through visible oscillation.
 */

import { gpuCaps, type GpuCapsReport } from './GpuCaps';

export type Bottleneck = 'none' | 'cpu-sim' | 'cpu-render' | 'gpu' | 'stall';

export interface GovernorInput {
  /** ms, from Clock.stats() */
  p95: number;
  p50: number;
  stddev: number;
  /** ms of CPU in fixed-step simulation */
  simMs: number;
  /** ms of CPU in render submission */
  renderMs: number;
  /** ms of GPU time if a timer query is available, else 0 */
  gpuMs: number;
  /** ms spent on background scheduler work */
  backgroundMs: number;
  /** Clock discarded simulation time this frame (catch-up ceiling hit) */
  timeDiscarded: boolean;
}

/**
 * The knob set. Every consumer reads from here rather than from a preset row,
 * so there is exactly one place that decides what quality 0.43 means.
 */
export interface QualityKnobs {
  /** internal render scale (quantised by the target pool's ladder) */
  renderScale: number;
  /** 0 = off, 1 = 3x3, 2 = 4x4 */
  aoQuality: 0 | 1 | 2;
  /** volumetric quality: 0 off, 1 quarter-res, 2 half-res + shadowed */
  volumetric: 0 | 1 | 2;
  /** volumetric march steps */
  volSteps: number;
  taa: boolean;
  motionBlur: boolean;
  bloom: boolean;
  dof: boolean;
  streak: boolean;
  /** contrast-adaptive sharpening amount */
  sharpen: number;
  /** metres of vegetation draw distance */
  drawDistance: number;
  /** near-tier LOD radius bias: >0 shrinks it */
  lodBias: number;
  /** particle / dust budgets */
  particleCount: number;
  dustCount: number;
  fogWisps: number;
  /** shadow map edge, and how often it may refresh */
  shadowMapSize: number;
  shadowRefreshHz: number;
  /** simulation cadences, Hz (0 = every frame) */
  aiHz: number;
  rigHz: number;
  audioProbeHz: number;
  /**
   * How often the practical-light set is re-selected.
   *
   * Practicals are picked by distance from a pool, and the selection only
   * changes when the player has moved metres — re-running it every frame is
   * pure waste. Separate from `aiHz` because the acceptable staleness is
   * completely different: a stale light choice is invisible, a stale AI
   * decision is felt.
   */
  practicalHz: number;
  /** chunk merges permitted per frame */
  mergesPerFrame: number;
  /** ms of frame budget the texture streamer may spend */
  streamBudgetMs: number;
}

const LS_KEY = 'static.governor.v1';

/** Linear interpolation between two knob values across the quality scalar. */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const step = (t: number, at: number) => t >= at;

/**
 * Map the scalar to knobs.
 *
 * The curve is not linear in cost. Cheap, high-impact things (draw distance,
 * particle counts, sharpening) come up early; expensive per-pixel things
 * (half-res volumetrics with shadow marching, 4x4 AO, TAA) come up late. That
 * ordering is the whole value of a continuous scalar over presets: a device
 * that can afford 60 % gets the 60 % that buys the most look.
 */
export function knobsFor(q: number, caps: GpuCapsReport = gpuCaps()): QualityKnobs {
  const t = Math.max(0, Math.min(1, q));
  // Software rasterisers are fill-bound to a degree no knob curve models well,
  // so they get pinned to the floor of every per-pixel term regardless of `t`.
  const soft = caps.software;

  return {
    renderScale: soft ? 0.55 : lerp(0.62, 1.0, t),
    aoQuality: !step(t, 0.22) ? 0 : step(t, 0.62) ? 2 : 1,
    volumetric: soft ? 1 : !step(t, 0.10) ? 1 : step(t, 0.58) ? 2 : 1,
    volSteps: soft ? 8 : Math.round(lerp(8, 18, t)),
    taa: step(t, 0.18),
    motionBlur: !soft && step(t, 0.30),
    bloom: true,               // the horror grade depends on it; never cut
    dof: step(t, 0.28),
    streak: step(t, 0.66),
    // Sharpening *rises* as quality falls: it is what makes a low internal
    // resolution readable, so it is inversely coupled on purpose.
    sharpen: lerp(0.55, 0.24, t),
    drawDistance: Math.round(lerp(110, 260, t)),
    lodBias: t < 0.35 ? 1 : t < 0.7 ? 0.5 : 0,
    particleCount: Math.round(lerp(180, 900, t)),
    dustCount: Math.round(lerp(80, 380, t)),
    fogWisps: Math.round(lerp(6, 30, t)),
    shadowMapSize: !step(t, 0.30) ? 1024 : !step(t, 0.80) ? 2048 : 4096,
    // Scheduled shadows: the moon's cascade over a static forest with a
    // texel-snapped window does not need 60 Hz. This is the largest single GPU
    // saving available at the top tiers.
    shadowRefreshHz: lerp(8, 30, t),
    aiHz: lerp(8, 30, t),
    rigHz: lerp(20, 60, t),
    audioProbeHz: lerp(3, 8, t),
    practicalHz: lerp(4, 12, t),
    mergesPerFrame: t < 0.35 ? 1 : t < 0.75 ? 2 : 3,
    streamBudgetMs: lerp(0.8, 3.5, t),
  };
}

/** Coarse device key for persistence — must not be fingerprinting-grade. */
function deviceKey(caps: GpuCapsReport): string {
  return `${caps.deviceClass}|${caps.cores}|${Math.round(caps.devicePixelRatio * 10)}|${caps.mobile ? 'm' : 'd'}`;
}

export class PerfGovernor {
  private caps: GpuCapsReport;
  /** the one scalar */
  quality: number;
  /** ceiling, lowered by thermal drift detection */
  private ceiling = 1;
  private knobs: QualityKnobs;

  /** target frame time, ms — derived from the observed display cadence */
  targetMs = 16.7;

  private cleanSeconds = 0;
  private sinceChange = 0;
  private p95Ema = 16.7;
  private p95Slow = 16.7;      // very slow EMA, for drift detection
  private sceneLoadEma = 0;    // proxy for "is the scene genuinely harder"
  private frames = 0;

  bottleneck: Bottleneck = 'none';
  /** true once thermal drift has been detected this session */
  thermalDetected = false;
  /** locked by the player choosing an explicit preset in Settings */
  locked = false;

  readonly history: { t: number; q: number; reason: string }[] = [];
  reason = 'init';

  constructor(caps: GpuCapsReport = gpuCaps(), startQuality?: number) {
    this.caps = caps;
    const restored = this.restore();
    this.quality = startQuality ?? restored ?? caps.suggestedQuality;
    this.knobs = knobsFor(this.quality, caps);
  }

  get current(): QualityKnobs { return this.knobs; }

  /** Explicit user override from Settings — stops adaptation entirely. */
  lock(q: number): void {
    this.locked = true;
    this.quality = Math.max(0, Math.min(1, q));
    this.knobs = knobsFor(this.quality, this.caps);
    this.reason = 'user-locked';
  }

  unlock(): void { this.locked = false; this.reason = 'auto'; }

  private restore(): number | null {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw) as { key?: string; q?: number };
      if (o.key !== deviceKey(this.caps) || typeof o.q !== 'number') return null;
      return Math.max(0, Math.min(1, o.q));
    } catch { return null; }
  }

  private persist(): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ key: deviceKey(this.caps), q: this.quality }));
    } catch { /* storage may be disabled or full; the default is fine */ }
  }

  /**
   * Attribute the frame cost.
   *
   * Order matters: a discarded-time frame is a stall regardless of what else is
   * true, and GPU is only trustworthy when a timer query exists — otherwise a
   * frame that is long but has little CPU in it is *inferred* to be GPU-bound,
   * which is the correct inference in a fill-bound renderer.
   */
  private attribute(i: GovernorInput): Bottleneck {
    if (i.timeDiscarded) return 'stall';
    const cpu = i.simMs + i.renderMs;
    if (i.gpuMs > 0.05) {
      if (i.gpuMs > cpu * 1.3) return 'gpu';
      return i.simMs > i.renderMs ? 'cpu-sim' : 'cpu-render';
    }
    if (cpu > this.targetMs * 0.7) return i.simMs > i.renderMs ? 'cpu-sim' : 'cpu-render';
    return 'gpu';
  }

  /**
   * One frame of control. Call from `Clock.onFrame`.
   *
   * Returns true when the knobs changed, so the caller knows to push them.
   */
  update(dt: number, i: GovernorInput): boolean {
    this.frames++;
    this.sinceChange += dt;
    this.p95Ema += (i.p95 - this.p95Ema) * 0.10;
    this.p95Slow += (i.p95 - this.p95Slow) * 0.004;
    // Scene load proxy: CPU cost is a decent stand-in for "how much is
    // actually going on", which lets us tell a thermal ramp (cost flat, time
    // rising) from a genuinely harder view (both rising).
    this.sceneLoadEma += ((i.simMs + i.renderMs) - this.sceneLoadEma) * 0.02;
    this.bottleneck = this.attribute(i);

    if (this.locked) return false;

    const over = this.targetMs * 1.22;
    const clearly = this.targetMs * 1.55;
    const under = this.targetMs * 0.74;
    // Variance gate: a frame budget met on average but missed erratically is
    // still a bad experience, so high stddev counts as being over.
    const jittery = i.stddev > this.targetMs * 0.42;

    let changed = false;

    // ---- thermal drift: slow p95 rise with flat scene load -----------------
    if (this.frames > 1800 && this.p95Slow > this.targetMs * 1.15 && this.sceneLoadEma < this.targetMs * 0.5) {
      if (!this.thermalDetected) {
        this.thermalDetected = true;
        this.ceiling = Math.max(0.25, this.quality - 0.08);
        this.reason = 'thermal-ceiling';
        this.history.push({ t: this.frames, q: this.quality, reason: this.reason });
        changed = true;
      }
    }

    // ---- degrade: fast ------------------------------------------------------
    if (i.timeDiscarded || this.p95Ema > clearly || (this.p95Ema > over && jittery)) {
      if (this.sinceChange > 0.25 && this.quality > 0) {
        // Attribution-weighted magnitude. A stall is an emergency; a mildly
        // jittery GPU-bound frame wants a nudge, not a cliff.
        const mag = this.bottleneck === 'stall' ? 0.14
          : this.p95Ema > clearly ? 0.08 : 0.04;
        this.quality = Math.max(0, this.quality - mag);
        this.reason = `degrade:${this.bottleneck}`;
        this.sinceChange = 0;
        this.cleanSeconds = 0;
        changed = true;
      }
    } else if (this.p95Ema < under && !jittery) {
      // ---- recover: slow ---------------------------------------------------
      this.cleanSeconds += dt;
      if (this.cleanSeconds > 3 && this.quality < this.ceiling) {
        this.quality = Math.min(this.ceiling, this.quality + 0.03);
        this.reason = 'recover';
        this.cleanSeconds = 0;
        this.sinceChange = 0;
        changed = true;
        this.persist();
      }
    } else {
      this.cleanSeconds = 0;
    }

    if (changed) {
      this.knobs = knobsFor(this.quality, this.caps);
      if (this.history.length > 64) this.history.shift();
      this.history.push({ t: this.frames, q: this.quality, reason: this.reason });
    }
    return changed;
  }

  /** Observe the display cadence so the budget matches a 120 Hz panel. */
  observeRefresh(p50Ms: number): void {
    if (p50Ms < 3 || p50Ms > 40) return;
    // Snap to the nearest common panel cadence rather than tracking noise.
    const candidates = [8.33, 11.1, 16.7, 20.8, 33.3];
    let best = 16.7, bd = Infinity;
    for (const c of candidates) {
      const d = Math.abs(c - p50Ms);
      if (d < bd) { bd = d; best = c; }
    }
    // Never target above 60 Hz: this game is fill-bound and atmosphere-led, and
    // a stable 60 with full effects beats an unstable 120 with none.
    this.targetMs = Math.max(16.7, best);
  }

  debug() {
    return {
      quality: this.quality,
      ceiling: this.ceiling,
      targetMs: this.targetMs,
      p95Ema: this.p95Ema,
      p95Slow: this.p95Slow,
      sceneLoad: this.sceneLoadEma,
      bottleneck: this.bottleneck,
      thermal: this.thermalDetected,
      locked: this.locked,
      reason: this.reason,
      knobs: this.knobs,
    };
  }
}
