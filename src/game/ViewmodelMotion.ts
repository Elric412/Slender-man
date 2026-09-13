/** Cosmetic hand inertia. Input is angular displacement, never delayed aim. */
export class ViewmodelMotion {
  x = 0;
  y = 0;
  lower = 0;
  time = 0;

  reset(): void { this.x = this.y = this.lower = this.time = 0; }

  update(dt: number, lookX: number, lookY: number, sprint: boolean): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    // A resumed background tab must not integrate a seconds-long animation.
    const step = Math.min(dt, 0.1);
    this.time += step;
    const target = (angle: number) => Number.isFinite(angle)
      ? Math.max(-0.35, Math.min(0.35, angle / dt * 0.08)) : 0;
    const follow = -Math.expm1(-9 * step);
    this.x += (target(lookX) - this.x) * follow;
    this.y += (target(lookY) - this.y) * follow;
    this.lower += ((sprint ? 0.06 : 0) - this.lower) * -Math.expm1(-5 * step);
  }
}
