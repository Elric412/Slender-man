/**
 * PALEBARK — LOD chain + cross-fade controller.
 *
 * Three tessellations of the *same* sculpt share one skeleton, so switching
 * level never changes the silhouette — only the triangle count. Transitions run
 * through a dithered cross-fade band (see PalebarkMaterial's `uFade`), so there
 * is no pop at any distance: for a few metres both levels render, one dissolving
 * in while the other dissolves out, and the ordered-dither pattern is
 * complementary between them so coverage stays ~100 %.
 *
 * Budgets are the brief's: 30–45k / 12–18k / 3–5k triangles.
 */

export const LOD_TRI_BUDGET: [number, number][] = [
  [30000, 45000],
  [12000, 18000],
  [3000, 5000],
];

/** Tessellation multipliers tuned against LOD_TRI_BUDGET (see tools/mesh-report.ts). */
export const LOD_DENSITY = [1.23, 0.79, 0.41];

/** Switch distances (metres) and the width of the cross-fade band around each. */
const SWITCH = [22, 55];
const BAND = 6;

export interface LodWeights {
  /** per-level opacity 0..1 — more than one may be non-zero inside a band */
  w: [number, number, number];
  active: number;
}

export class PalebarkLodController {
  private smooth: [number, number, number] = [1, 0, 0];
  /** distance at which the mesh is culled entirely (fog eats it anyway) */
  cullDistance = 260;

  /**
   * @param dist   distance from camera to the entity
   * @param dt     frame delta (the weights are eased so a fast pass-by can't strobe)
   */
  update(dist: number, dt: number, qualityBias = 1): LodWeights {
    const s0 = SWITCH[0] * qualityBias;
    const s1 = SWITCH[1] * qualityBias;
    const target: [number, number, number] = [0, 0, 0];
    if (dist <= s0 - BAND * 0.5) {
      target[0] = 1;
    } else if (dist < s0 + BAND * 0.5) {
      const t = (dist - (s0 - BAND * 0.5)) / BAND;
      target[0] = 1 - t; target[1] = t;
    } else if (dist <= s1 - BAND * 0.5) {
      target[1] = 1;
    } else if (dist < s1 + BAND * 0.5) {
      const t = (dist - (s1 - BAND * 0.5)) / BAND;
      target[1] = 1 - t; target[2] = t;
    } else {
      target[2] = 1;
    }
    const k = Math.min(1, dt * 12);
    for (let i = 0; i < 3; i++) this.smooth[i] += (target[i] - this.smooth[i]) * k;
    let active = 0;
    for (let i = 0; i < 3; i++) if (this.smooth[i] > this.smooth[active]) active = i;
    return { w: [this.smooth[0], this.smooth[1], this.smooth[2]], active };
  }

  reset(dist: number): void {
    const w = this.update(dist, 1);
    this.smooth = [w.w[0], w.w[1], w.w[2]];
  }
}
