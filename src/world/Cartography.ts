/**
 * Cartography — the player's *knowledge* of Pinewood Forest.
 *
 * This is deliberately a separate system from both the world and the map UI, and
 * it holds the only mutable state either of them shares. The reason is a rule in
 * the brief: the map must never assert anything the world does not contain, and
 * must never hardcode UI information that does not correspond to world state.
 * The safest way to guarantee that is to make it structurally impossible — the
 * renderer is handed this object and has nothing else to draw from, so it cannot
 * invent a landmark, a trail, or a discovery.
 *
 * Everything geometric comes from `PinewoodLayout` (landmarks, path polylines,
 * page anchors, the lake shore, the quarry rim) and everything *epistemic* lives
 * here: which cells you have walked, which landmarks you have laid eyes on,
 * which pages you have recovered. So the survey map is a projection of the same
 * spatial source of truth the terrain, collision and nav grid are built from,
 * with a fog-of-war mask over the top.
 *
 * Contains no `three` import and no DOM access, so it can be exercised by
 * `tools/verify-world.ts` in plain Node like the rest of the spatial core.
 */

import { HeightField } from './HeightField';
import {
  LANDMARKS, PAGE_ANCHORS, PinewoodLandmark, worldToPx,
} from './PinewoodLayout';

/** Exploration grid resolution. 96² over 560 m ≈ 5.8 m cells. */
const EXPLORE_RES = 96;

/**
 * How far you are considered to have "seen" the ground around you.
 *
 * Not a view cone: you are turning constantly and this is a survey map being
 * annotated in retrospect, not a real-time sensor sweep. A radius reads as
 * "ground I walked past and could account for", which is what a surveyor's
 * pencil hatching actually means.
 */
const WALK_REVEAL = 17;

export interface LandmarkKnowledge {
  /** the layout record — geometry, never copied or re-derived */
  lm: PinewoodLandmark;
  /** the player has been inside `reveal` range, or seen it from distance */
  discovered: boolean;
  /** true when discovered from far away rather than by arriving */
  seenAtDistance: boolean;
  /** run-time seconds at first discovery, for the field-notes ordering */
  atTime: number;
}

export interface PageKnowledge {
  id: string;
  x: number; z: number;
  near: string;
  collected: boolean;
  /** we know a page is *somewhere here* once its landmark is discovered */
  hinted: boolean;
}

export class Cartography {
  readonly res = EXPLORE_RES;
  readonly cell: number;
  /** 0 = unvisited, else 1..255 recency/confidence of the survey hatching */
  readonly explored: Uint8Array;
  readonly landmarks: LandmarkKnowledge[];
  readonly pages: PageKnowledge[];

  private half: number;
  private exploredCount = 0;
  /** cells that are actually reachable land — the denominator for "explored %" */
  private reachable = 0;
  private reachableMask: Uint8Array;

  constructor(private hf: HeightField) {
    const size = hf.layout.size;
    this.half = size / 2;
    this.cell = size / EXPLORE_RES;
    this.explored = new Uint8Array(EXPLORE_RES * EXPLORE_RES);
    this.reachableMask = new Uint8Array(EXPLORE_RES * EXPLORE_RES);

    this.landmarks = LANDMARKS.map(lm => ({
      lm, discovered: false, seenAtDistance: false, atTime: -1,
    }));
    this.pages = PAGE_ANCHORS.map(p => ({
      id: p.id, x: p.x, z: p.z, near: p.near, collected: false, hinted: false,
    }));

    // Precompute the reachable denominator once.
    //
    // "Explored 100%" has to be achievable, and it is not if the denominator
    // includes the lake surface, the inside of the quarry walls and the strip
    // outside the playable boundary — the counter would stall in the high
    // eighties forever and read as a bug. So the percentage is over walkable
    // land only, which is also the honest question: how much of the forest
    // *you could have walked* have you actually walked.
    const playable = this.half - 8;
    for (let j = 0; j < EXPLORE_RES; j++) {
      for (let i = 0; i < EXPLORE_RES; i++) {
        const x = -this.half + (i + 0.5) * this.cell;
        const z = -this.half + (j + 0.5) * this.cell;
        if (Math.abs(x) > playable || Math.abs(z) > playable) continue;
        if (hf.inLake(x, z)) continue;
        if (hf.slopeAt(x, z) > 0.85) continue;
        this.reachableMask[j * EXPLORE_RES + i] = 1;
        this.reachable++;
      }
    }
  }

  /** fraction 0..1 of reachable land the player has surveyed */
  get exploredFraction(): number {
    return this.reachable > 0 ? this.exploredCount / this.reachable : 0;
  }

  get discoveredCount(): number {
    let n = 0;
    for (const k of this.landmarks) if (k.discovered) n++;
    return n;
  }

  get collectedCount(): number {
    let n = 0;
    for (const p of this.pages) if (p.collected) n++;
    return n;
  }

  /** exploration state of a cell, 0..1 */
  at(i: number, j: number): number {
    if (i < 0 || j < 0 || i >= EXPLORE_RES || j >= EXPLORE_RES) return 0;
    return this.explored[j * EXPLORE_RES + i] / 255;
  }

  isReachable(i: number, j: number): boolean {
    if (i < 0 || j < 0 || i >= EXPLORE_RES || j >= EXPLORE_RES) return false;
    return this.reachableMask[j * EXPLORE_RES + i] === 1;
  }

  /** world → map-pixel, for drawing against the survey sheet's own coordinates */
  toPx(x: number, z: number): { px: number; py: number } {
    return worldToPx(x, z);
  }

  /**
   * Fold the player's current position into the survey.
   *
   * Called every frame; deliberately cheap and allocation-free. The reveal disc
   * is stamped at full confidence, and terrain does the interesting work: a cell
   * you can see *across* (downhill, or from the ridge) is revealed further than
   * one you are standing in a hollow next to.
   */
  observe(px: number, pz: number, timeSec: number): void {
    const eyeY = this.hf.heightAt(px, pz) + 1.65;
    // From a high vantage the survey reaches further, which is why climbing the
    // watchtower or the ridge is worth the detour.
    const relief = Math.max(0, eyeY - 14) * 0.9;
    const reach = WALK_REVEAL + Math.min(46, relief);

    const i0 = Math.max(0, Math.floor((px - reach + this.half) / this.cell));
    const i1 = Math.min(EXPLORE_RES - 1, Math.ceil((px + reach + this.half) / this.cell));
    const j0 = Math.max(0, Math.floor((pz - reach + this.half) / this.cell));
    const j1 = Math.min(EXPLORE_RES - 1, Math.ceil((pz + reach + this.half) / this.cell));

    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * EXPLORE_RES + i;
        if (this.explored[idx] === 255) continue;
        const x = -this.half + (i + 0.5) * this.cell;
        const z = -this.half + (j + 0.5) * this.cell;
        const d = Math.hypot(x - px, z - pz);
        if (d > reach) continue;
        // Beyond walking distance the ground has to actually be visible — no
        // seeing through the ridge from the valley floor.
        if (d > WALK_REVEAL && !this.terrainVisible(px, pz, eyeY, x, z)) continue;
        const wasZero = this.explored[idx] === 0;
        this.explored[idx] = 255;
        if (wasZero && this.reachableMask[idx]) this.exploredCount++;
      }
    }

    // Landmark discovery.
    for (const k of this.landmarks) {
      if (k.discovered) continue;
      const d = Math.hypot(k.lm.x - px, k.lm.z - pz);
      const arrive = Math.max(k.lm.reveal, k.lm.r * 0.9);
      if (d <= arrive) {
        k.discovered = true; k.seenAtDistance = false; k.atTime = timeSec;
      } else if (k.lm.beacon && d < 240
        && this.terrainVisible(px, pz, eyeY, k.lm.x, k.lm.z, 10)) {
        // Beacons announce themselves across the valley — that is their whole
        // purpose as navigation. Marked as a distant sighting so the map can
        // draw them differently from places you have actually stood.
        k.discovered = true; k.seenAtDistance = true; k.atTime = timeSec;
      }
    }

    // A page is *hinted* once you know the place it is near, which turns the map
    // into a to-do list of locations rather than a set of coordinates.
    for (const p of this.pages) {
      if (p.hinted || p.collected) continue;
      const host = this.landmarks.find(k => k.lm.id === p.near);
      if (host?.discovered) p.hinted = true;
    }
  }

  /** called by TapeSystem when a recording is recovered */
  markCollected(nearId: string): void {
    const p = this.pages.find(q => q.near === nearId && !q.collected);
    if (p) { p.collected = true; p.hinted = true; }
  }

  /**
   * Terrain-only line of sight between two ground points.
   *
   * Canopy is intentionally ignored here — unlike the beacon-visibility metric
   * in the verifier, this is asking "could the surveyor account for that
   * ground", and a forested slope you can see the shape of still gets hatched.
   */
  private terrainVisible(
    x0: number, z0: number, eyeY: number, x1: number, z1: number, targetUp = 1.2,
  ): boolean {
    const d = Math.hypot(x1 - x0, z1 - z0);
    if (d < 1) return true;
    const topY = this.hf.heightAt(x1, z1) + targetUp;
    const steps = Math.min(24, Math.max(4, Math.ceil(d / 9)));
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const sx = x0 + (x1 - x0) * t, sz = z0 + (z1 - z0) * t;
      const ray = eyeY + (topY - eyeY) * t;
      if (this.hf.heightAt(sx, sz) > ray + 1.0) return false;
    }
    return true;
  }
}
