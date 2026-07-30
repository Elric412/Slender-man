/** Deterministic seeded RNG (mulberry32) — all gameplay-critical randomness flows through this. */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  /** float in [0,1) */
  next(): number {
    this.state |= 0; this.state = (this.state + 0x6D2B79F5) | 0;
    let t = Math.imul(this.state ^ (this.state >>> 15), 1 | this.state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number { return min + this.next() * (max - min); }
  int(min: number, max: number): number { return Math.floor(this.range(min, max + 1)); }
  pick<T>(arr: readonly T[]): T { return arr[Math.min(arr.length - 1, Math.floor(this.next() * arr.length))]; }
  sign(): number { return this.next() < 0.5 ? -1 : 1; }

  /** 1D smooth value noise at t, interpolated from seeded lattice values */
  noise1(t: number): number {
    const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
    return this.hashN(i) * (1 - u) + this.hashN(i + 1) * u;
  }

  /** 2D value noise in [-1,1] */
  noise2(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = this.hash2(ix, iy), b = this.hash2(ix + 1, iy);
    const c = this.hash2(ix, iy + 1), d = this.hash2(ix + 1, iy + 1);
    return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
  }

  /** fractal noise, ~[-1,1] */
  fbm2(x: number, y: number, octaves = 4, lac = 2.0, gain = 0.5): number {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise2(x * freq, y * freq) * amp;
      norm += amp; amp *= gain; freq *= lac;
    }
    return sum / norm;
  }

  private hashN(i: number): number {
    let h = (i * 374761393 + this.state * 668265263) | 0;
    h = (h ^ (h >>> 13)) | 0; h = Math.imul(h, 1274126177);
    return (((h ^ (h >>> 16)) >>> 0) / 2147483648) - 1;
  }

  private hash2(x: number, y: number): number {
    let h = (x * 374761393 + y * 2246822519 + this.state * 668265263) | 0;
    h = (h ^ (h >>> 13)) | 0; h = Math.imul(h, 1274126177);
    return (((h ^ (h >>> 16)) >>> 0) / 2147483648) - 1;
  }

  fork(salt: number): SeededRandom {
    return new SeededRandom(((this.state ^ (salt * 2654435761)) >>> 0) || 1);
  }
}
