/**
 * Fear/static — the diegetic danger feedback loop.
 * Driven by Palebark's real detection level; eases in both directions.
 * Produces render-overlay params, tremor level, audio fear level, and glimpse scheduling.
 */
export class FearSystem {
  /** smoothed output 0..1 */
  value = 0;
  glimpse = 0;               // single-frame flash amount (decays fast)
  private glimpseCooldown = 0;

  update(dt: number, detection: number, entityVisible: boolean, distToEntity: number): void {
    // target combines detection with immediacy of a close sighting
    let target = detection;
    if (entityVisible && distToEntity < 40) {
      target = Math.max(target, Math.min(1, 0.5 + (40 - distToEntity) / 40 * 0.5));
    }
    // asymmetric smoothing: fear rises fast, releases slow — but never snaps
    const rate = target > this.value ? 2.2 : 0.35;
    this.value += (target - this.value) * Math.min(1, dt * rate);

    // glimpse decay
    this.glimpse = Math.max(0, this.glimpse - dt * 4);
    this.glimpseCooldown = Math.max(0, this.glimpseCooldown - dt);
  }

  triggerGlimpse(): void {
    if (this.glimpseCooldown <= 0) {
      this.glimpse = 1;
      this.glimpseCooldown = 6;
    }
  }

  /** static overlay amount for the composite shader */
  get staticLevel(): number {
    return Math.min(1, this.value * this.value * 1.15);
  }

  get desat(): number {
    return 0.2 + this.value * 0.45;
  }

  get tremor(): number {
    return this.value * 0.9;
  }

  reset(): void {
    this.value = 0;
    this.glimpse = 0;
  }
}
