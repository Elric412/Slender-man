type TickFn = (dt: number, time: number) => void;

/** Fixed-ish timestep loop with clamped dt, pause support, and frame-time stats. */
export class GameLoop {
  private raf = 0;
  private last = 0;
  private acc = 0;
  running = false;
  paused = false;
  time = 0;

  private updateFns: TickFn[] = [];
  private renderFn: TickFn | null = null;

  // frame stats
  private samples: number[] = new Array(240).fill(0);
  private sampleIdx = 0;
  private sampleCount = 0;

  onUpdate(fn: TickFn): void { this.updateFns.push(fn); }
  onRender(fn: TickFn): void { this.renderFn = fn; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      let dt = (now - this.last) / 1000;
      this.last = now;
      if (dt > 0.1) dt = 0.1; // clamp long stalls (tab refocus)

      // record frame time
      this.samples[this.sampleIdx] = dt;
      this.sampleIdx = (this.sampleIdx + 1) % this.samples.length;
      if (this.sampleCount < this.samples.length) this.sampleCount++;

      if (!this.paused) {
        this.time += dt;
        for (let i = 0; i < this.updateFns.length; i++) this.updateFns[i](dt, this.time);
      }
      if (this.renderFn) this.renderFn(dt, this.time);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void { this.running = false; cancelAnimationFrame(this.raf); }

  stats(): { avg: number; p95: number; worst: number; fps: number } {
    if (this.sampleCount === 0) return { avg: 0, p95: 0, worst: 0, fps: 0 };
    const arr = this.samples.slice(0, this.sampleCount).sort((a, b) => a - b);
    const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
    const p95 = arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
    const worst = arr[arr.length - 1];
    return { avg, p95, worst, fps: 1 / Math.max(avg, 1e-4) };
  }
}
