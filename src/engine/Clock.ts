/**
 * ============================================================================
 * Clock — fixed-timestep simulation with interpolated rendering
 * ============================================================================
 *
 * ### The bug this replaces
 *
 * The previous `GameLoop` declared an accumulator (`acc`) and never used it.
 * Variable `dt` — clamped to 100 ms, but otherwise whatever the browser handed
 * us — went straight into the player controller, the AI brain, the cloth solver
 * and the audio Director.
 *
 * Three consequences, all of which were observable:
 *
 *  1. **A 100 ms frame integrated a 100 ms physics step.** That is six frames
 *     of movement resolved in one collision pass — the classic tunnelling
 *     setup. A player sprinting into a trunk during a hitch could end up on the
 *     wrong side of it, and the entity could visibly skip forward.
 *  2. **Non-determinism.** Every seeded test in the suite is weakened by it:
 *     the same seed and the same inputs produce different trajectories on a
 *     machine with different frame pacing. A "reproducible" Playwright capture
 *     was only ever reproducible because the assertions were loose.
 *  3. **Spring constants were tuned against an implicit 16.6 ms.** Every
 *     `x += (target - x) * Math.min(1, dt * k)` in the codebase — and there are
 *     dozens — behaves differently at 30 fps than at 144 fps. The flashlight's
 *     handheld lag, the exposure ramp and the viewfinder weight all drift.
 *
 * ### The design
 *
 * Simulation advances in fixed `STEP` increments. Rendering happens once per
 * animation frame with an `alpha` in [0,1) describing where the display time
 * sits between the last two simulation states, so visuals stay smooth at any
 * refresh rate without the simulation caring what that rate is.
 *
 * Catch-up is capped at `MAX_STEPS`. That cap is not an optimisation — it is
 * the thing that prevents the death spiral where a slow frame requests more
 * steps, which makes the next frame slower, which requests more steps. Beyond
 * the cap we *drop* simulation time and say so, which the governor reads as a
 * signal to degrade.
 */

export type SimFn = (dt: number, simTime: number) => void;
export type RenderFn = (alpha: number, frameDt: number, simTime: number) => void;

/** 60 Hz. Movement feel across the whole game is tuned against this number. */
export const STEP = 1 / 60;
/**
 * Catch-up ceiling. 4 steps = 66 ms of simulation per frame; beyond that we
 * deliberately lose time rather than enter a spiral.
 */
const MAX_STEPS = 4;

export interface FrameStats {
  fps: number;
  /** mean frame interval, ms */
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  /** standard deviation of frame interval, ms — the smoothness signal */
  stddev: number;
  /** CPU ms spent in simulation this frame (EMA) */
  simMs: number;
  /** CPU ms spent in render submission this frame (EMA) */
  renderMs: number;
  /** simulation steps executed last frame */
  steps: number;
  /** frames in which catch-up hit MAX_STEPS and time was discarded */
  droppedFrames: number;
  /** total frames observed */
  frames: number;
}

export class Clock {
  private raf = 0;
  private last = 0;
  private acc = 0;
  running = false;
  paused = false;

  /** authoritative simulation time, seconds — advances only in STEP units */
  simTime = 0;
  /** wall-clock time since start, seconds — for display-rate effects only */
  wallTime = 0;

  /**
   * Render every Nth frame (1 = every frame).
   *
   * Retained verbatim from `GameLoop` because the reason is still live: under
   * SwiftShader on a 2-core CI box a single frame occupies both cores for tens
   * of milliseconds, which starves Chromium's audio render thread until its
   * output stream wedges hard enough to break browser teardown. Throttling
   * *rendering* alone hands enough CPU back to keep the stream healthy without
   * weakening any assertion about game or audio behaviour.
   */
  renderSkip = 1;
  private renderPhase = 0;

  private simFns: SimFn[] = [];
  private renderFn: RenderFn | null = null;
  private frameFns: ((frameDt: number) => void)[] = [];

  // ---- frame-time history ----
  // Ring buffer of intervals in *milliseconds*. 300 samples ~= 5 s at 60 fps,
  // which is the right window for a p99 that responds to a real regression but
  // not to one bad frame.
  private samples = new Float32Array(300);
  private sampleIdx = 0;
  private sampleCount = 0;
  private sorted = new Float32Array(300);

  private simMsEma = 0;
  private renderMsEma = 0;
  private lastSteps = 0;
  private droppedFrames = 0;
  private totalFrames = 0;

  /** set true for one frame after catch-up discarded simulation time */
  timeDiscarded = false;

  onSim(fn: SimFn): void { this.simFns.push(fn); }
  onRender(fn: RenderFn): void { this.renderFn = fn; }
  /** per-*frame* (not per-step) callbacks: scheduler, telemetry, governor */
  onFrame(fn: (frameDt: number) => void): void { this.frameFns.push(fn); }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      this.step(now);
    };
    this.raf = requestAnimationFrame(tick);
  }

  /** Exposed so a headless harness can drive the loop deterministically. */
  step(now: number): void {
    let frameDt = (now - this.last) / 1000;
    this.last = now;
    // Clamp long stalls (tab refocus, a GC pause, a debugger break). Without
    // this a 4-second background pause would try to simulate 240 steps.
    if (frameDt > 0.25) frameDt = 0.25;
    if (frameDt < 0) frameDt = 0;

    this.wallTime += frameDt;
    const ms = frameDt * 1000;
    this.samples[this.sampleIdx] = ms;
    this.sampleIdx = (this.sampleIdx + 1) % this.samples.length;
    if (this.sampleCount < this.samples.length) this.sampleCount++;
    this.totalFrames++;

    this.timeDiscarded = false;

    if (!this.paused) {
      this.acc += frameDt;
      let steps = 0;
      const s0 = performance.now();
      while (this.acc >= STEP && steps < MAX_STEPS) {
        this.simTime += STEP;
        for (let i = 0; i < this.simFns.length; i++) this.simFns[i](STEP, this.simTime);
        this.acc -= STEP;
        steps++;
      }
      if (this.acc >= STEP) {
        // Hit the ceiling. Discard the backlog rather than carrying it into the
        // next frame, which is what turns a hitch into a spiral. The governor
        // reads `timeDiscarded` and degrades.
        this.acc = 0;
        this.timeDiscarded = true;
        this.droppedFrames++;
      }
      this.lastSteps = steps;
      this.simMsEma += ((performance.now() - s0) - this.simMsEma) * 0.08;
    }

    for (let i = 0; i < this.frameFns.length; i++) this.frameFns[i](frameDt);

    if (this.renderFn) {
      this.renderPhase++;
      if (this.renderPhase >= this.renderSkip) {
        this.renderPhase = 0;
        const r0 = performance.now();
        // alpha: where display time sits between the last two sim states.
        this.renderFn(this.acc / STEP, frameDt, this.simTime);
        this.renderMsEma += ((performance.now() - r0) - this.renderMsEma) * 0.08;
      }
    }
  }

  stop(): void { this.running = false; cancelAnimationFrame(this.raf); }

  /**
   * Reset the accumulator and the history.
   *
   * Called on resume from pause and after a warp. Without it, a paused tab's
   * accumulated wall time would be spent as simulation the instant it resumes —
   * i.e. the entity moves while the pause menu is up, one frame later.
   */
  resetTiming(): void {
    this.acc = 0;
    this.last = performance.now();
    this.sampleCount = 0;
    this.sampleIdx = 0;
  }

  /** Clear only the statistics window (benchmark warm-up). */
  resetStats(): void {
    this.sampleCount = 0;
    this.sampleIdx = 0;
    this.droppedFrames = 0;
    this.totalFrames = 0;
  }

  stats(): FrameStats {
    const n = this.sampleCount;
    const base = {
      simMs: this.simMsEma,
      renderMs: this.renderMsEma,
      steps: this.lastSteps,
      droppedFrames: this.droppedFrames,
      frames: this.totalFrames,
    };
    if (n === 0) {
      return { fps: 0, avg: 0, p50: 0, p95: 0, p99: 0, worst: 0, stddev: 0, ...base };
    }
    // Copy into the scratch buffer and sort in place — no allocation on a path
    // the perf overlay calls every frame.
    const s = this.sorted;
    let sum = 0;
    for (let i = 0; i < n; i++) { s[i] = this.samples[i]; sum += this.samples[i]; }
    const view = s.subarray(0, n);
    view.sort();
    const avg = sum / n;
    let varAcc = 0;
    for (let i = 0; i < n; i++) { const d = this.samples[i] - avg; varAcc += d * d; }
    const pick = (q: number) => view[Math.min(n - 1, Math.floor(n * q))];
    return {
      fps: 1000 / Math.max(avg, 0.001),
      avg,
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      worst: view[n - 1],
      stddev: Math.sqrt(varAcc / n),
      ...base,
    };
  }
}
