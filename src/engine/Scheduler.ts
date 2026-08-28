/**
 * ============================================================================
 * Scheduler — budgeted, priority-classed task execution
 * ============================================================================
 *
 * ### The problem
 *
 * Every system in STATIC ran at full frame rate. The AI brain, the entity rig
 * (skeleton + cloth + foot IK), the tape proximity scan, the fear system, the
 * particle systems and the HUD all updated once per frame, always. `main.ts`
 * carried an eight-stage EMA profiler — so the *intent* to act on cost existed
 * — but nothing consumed the numbers.
 *
 * Meanwhile the expensive one-off work (chunk geometry merges, texture
 * streaming, shader warm-up) was amortised by hard-coded constants:
 * `BUILDS_PER_FRAME = 2`, `streamBudgetMs: dist > 40 ? 3.5 : 1.0`. Those are
 * reasonable guesses that cannot respond to anything. On a fast machine they
 * leave the streamer idle while there is budget to spare; on a slow one they
 * spend 3.5 ms on a frame that was already 40 ms late.
 *
 * ### The design
 *
 * Tasks declare what they are and how often they need to run. Each frame:
 *
 *  1. `critical` tasks always run (input, player, camera). Never skipped,
 *     never budgeted — skipping input is not a performance strategy.
 *  2. `sim` tasks run when their cadence is due.
 *  3. `background` tasks spend whatever is left of the frame budget, in
 *     priority order, using each task's own measured EMA cost to decide
 *     whether it fits *before* starting it.
 *
 * Two properties that matter more than the budgeting itself:
 *
 * **Starvation guard.** A task starved past `maxStarveMs` is promoted and runs
 * regardless of budget. Without this, a permanently over-budget frame silently
 * stops streaming forever and the player walks into unmerged forest.
 *
 * **Phase offsetting.** Tasks with the same cadence get different phases, so a
 * 4 Hz AI tick, a 4 Hz audio probe and a 4 Hz occlusion refresh do not all land
 * on the same frame. Aligned cadences are how you build a periodic hitch.
 */

export type TaskClass = 'critical' | 'sim' | 'background';

export interface TaskSpec {
  id: string;
  cls: TaskClass;
  /**
   * Run at most this often. 0 = every frame.
   * `sim` tasks use this as a hard cadence; `background` tasks as a *minimum*
   * interval (they may still be deferred by budget).
   */
  hz?: number;
  /** Lower runs first within a class. */
  priority?: number;
  /** Expected cost hint, ms. Seeds the EMA so the first run is not a surprise. */
  estMs?: number;
  /**
   * Escalate to must-run after this long without running.
   * Defaults to 4x the cadence period, or 250 ms for every-frame tasks.
   */
  maxStarveMs?: number;
  /**
   * The work. `dt` is the wall time since this task last ran, so a task at
   * 4 Hz sees ~0.25 and can integrate correctly without knowing its cadence.
   */
  run: (dt: number, now: number) => void;
}

interface Task extends TaskSpec {
  lastRun: number;
  /** EMA of measured cost, ms */
  costMs: number;
  periodMs: number;
  starveMs: number;
  /** frames-based phase offset so equal cadences decorrelate */
  phase: number;
  runs: number;
  skips: number;
  escalations: number;
}

export interface SchedulerStats {
  frameBudgetMs: number;
  usedMs: number;
  backgroundMs: number;
  ranBackground: number;
  deferred: number;
  escalated: number;
  tasks: { id: string; costMs: number; runs: number; skips: number; hz: number }[];
}

export class Scheduler {
  private tasks: Task[] = [];
  private frame = 0;
  private now = 0;

  /**
   * Total CPU budget per frame, ms. Set by the governor from the display
   * refresh rate: a 60 Hz target gets ~10 ms of the 16.6 ms, leaving headroom
   * for the browser's own compositing and for render submission.
   */
  frameBudgetMs = 10;
  /**
   * Of that, the most that may go to `background`. Kept as a fraction rather
   * than an absolute so it scales with the budget.
   */
  backgroundFraction = 0.45;

  readonly stats: SchedulerStats = {
    frameBudgetMs: 10, usedMs: 0, backgroundMs: 0,
    ranBackground: 0, deferred: 0, escalated: 0, tasks: [],
  };

  add(spec: TaskSpec): void {
    const hz = spec.hz ?? 0;
    const periodMs = hz > 0 ? 1000 / hz : 0;
    this.tasks.push({
      ...spec,
      hz,
      priority: spec.priority ?? 100,
      lastRun: -1e9,
      costMs: spec.estMs ?? 0.2,
      periodMs,
      starveMs: spec.maxStarveMs ?? (periodMs > 0 ? periodMs * 4 : 250),
      // Golden-ratio phase spreading: consecutive registrations land on
      // maximally-separated frames rather than clustering.
      phase: (this.tasks.length * 0.6180339887) % 1,
      runs: 0, skips: 0, escalations: 0,
    });
    this.tasks.sort((a, b) => (a.priority! - b.priority!));
  }

  remove(id: string): void {
    const i = this.tasks.findIndex(t => t.id === id);
    if (i >= 0) this.tasks.splice(i, 1);
  }

  has(id: string): boolean { return this.tasks.some(t => t.id === id); }

  /** Change a cadence at runtime — this is how the governor throttles systems. */
  setHz(id: string, hz: number): void {
    const t = this.tasks.find(x => x.id === id);
    if (!t) return;
    t.hz = hz;
    t.periodMs = hz > 0 ? 1000 / hz : 0;
    t.starveMs = t.periodMs > 0 ? t.periodMs * 4 : 250;
  }

  private exec(t: Task, now: number): number {
    const dt = t.lastRun < -1e8 ? (t.periodMs || 16.7) / 1000 : (now - t.lastRun) / 1000;
    const t0 = performance.now();
    t.run(dt, now / 1000);
    const cost = performance.now() - t0;
    t.costMs += (cost - t.costMs) * 0.12;
    t.lastRun = now;
    t.runs++;
    return cost;
  }

  /** Run one frame's worth of scheduled work. */
  tick(now: number): void {
    this.now = now;
    this.frame++;
    const t0 = performance.now();
    let used = 0;
    let bgUsed = 0;
    let ranBg = 0;
    let deferred = 0;
    let escalated = 0;

    // ---- 1. critical: unconditional ----
    for (const t of this.tasks) {
      if (t.cls !== 'critical') continue;
      used += this.exec(t, now);
    }

    // ---- 2. sim: cadence-gated, but not budget-gated ----
    // Simulation correctness is not negotiable against frame time; the governor
    // lowers cadences instead, which is a decision, not a dropped update.
    for (const t of this.tasks) {
      if (t.cls !== 'sim') continue;
      if (t.periodMs > 0) {
        const elapsed = now - t.lastRun;
        // Phase offset applied as a fraction of the period, so two 4 Hz tasks
        // land on different frames.
        if (elapsed < t.periodMs * (0.85 + t.phase * 0.3)) { t.skips++; continue; }
      }
      used += this.exec(t, now);
    }

    // ---- 3. background: budgeted, priority-ordered, starvation-guarded ----
    const bgBudget = Math.max(0.5, this.frameBudgetMs * this.backgroundFraction);
    for (const t of this.tasks) {
      if (t.cls !== 'background') continue;
      const elapsed = now - t.lastRun;
      const starving = elapsed > t.starveMs;

      if (!starving) {
        if (t.periodMs > 0 && elapsed < t.periodMs) { t.skips++; continue; }
        // Predictive admission: only start a task we believe will fit. Starting
        // a 4 ms task with 0.5 ms left is how a budget gets blown by 8x.
        if (bgUsed + t.costMs > bgBudget) { t.skips++; deferred++; continue; }
      } else {
        t.escalations++;
        escalated++;
      }

      const c = this.exec(t, now);
      bgUsed += c;
      used += c;
      ranBg++;
      if (bgUsed >= bgBudget && !starving) break;
    }

    const s = this.stats;
    s.frameBudgetMs = this.frameBudgetMs;
    s.usedMs = performance.now() - t0;
    s.backgroundMs = bgUsed;
    s.ranBackground = ranBg;
    s.deferred = deferred;
    s.escalated = escalated;
  }

  /** Snapshot for the perf overlay / debug API. Allocates — do not call per frame. */
  report(): SchedulerStats {
    return {
      ...this.stats,
      tasks: this.tasks.map(t => ({
        id: t.id, costMs: t.costMs, runs: t.runs, skips: t.skips, hz: t.hz ?? 0,
      })),
    };
  }

  /** Total measured cost of everything registered, ms — the governor's input. */
  totalCostMs(): number {
    let s = 0;
    for (const t of this.tasks) s += t.costMs;
    return s;
  }
}
