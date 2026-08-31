/**
 * The survey map overlay.
 *
 * Drawn to a 2D canvas rather than composed from DOM nodes, for one decisive
 * reason: the map's content is a projection of world geometry — 25 path
 * polylines, a 40-point lake shore, a lobed quarry rim, a 96² fog mask — and
 * expressing that as elements would mean thousands of nodes and a layout pass
 * per frame. A canvas also lets the sheet be *drawn* rather than styled, which
 * is what makes it read as a paper artefact instead of a game menu.
 *
 * The renderer receives `Cartography` and reads `PinewoodLayout` directly. It is
 * given no other data source, so every mark on the sheet traces to real world
 * geometry or real player knowledge. Undiscovered places are not drawn dimly —
 * they are not drawn at all, because a surveyor cannot annotate what they have
 * not surveyed.
 *
 * Style contract (applied to every mark on the sheet, per the UI-set principle
 * that consistency matters more than any single element): a single ink colour at
 * varying alpha, one hairline weight for graticule, one medium for paths, one
 * heavy for landmark glyphs; every glyph fits a 9 px box so it survives the
 * mobile scale; no filled shapes except water and the player mark.
 */

import { Cartography } from '../world/Cartography';
import {
  LANDMARKS, PathEdge, PinewoodLandmark, WORLD_SIZE, worldToPx,
} from '../world/PinewoodLayout';
import { HeightField } from '../world/HeightField';

/** The sheet is drawn at this resolution and CSS-scaled to fit. */
const SHEET = 768;

/* Ink palette — one hue, many alphas. Aged blueprint, not neon HUD. */
const INK = '212, 205, 184';
const WATER = '92, 118, 126';
const MARK = '214, 178, 106';      // the player's own pencil: warmer than the print

export class SurveyMap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** world→sheet scale: the sheet covers the whole world with a margin */
  private s: number;
  private ox: number; private oy: number;
  /** static layer (graticule, contours, shoreline, paths) rendered once */
  private base: HTMLCanvasElement | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    private carto: Cartography,
    private hf: HeightField,
  ) {
    this.canvas = canvas;
    canvas.width = SHEET; canvas.height = SHEET;
    const c = canvas.getContext('2d');
    if (!c) throw new Error('SurveyMap: 2D context unavailable');
    this.ctx = c;

    // The map's px space is the reference survey's own (0..700-ish); we fit the
    // world extent instead, so the sheet stays correct if the world resizes.
    const margin = 34;
    this.s = (SHEET - margin * 2) / WORLD_SIZE;
    this.ox = margin + (WORLD_SIZE / 2) * this.s;
    this.oy = margin + (WORLD_SIZE / 2) * this.s;
  }

  /**
   * Point the sheet at a new knowledge set, for a fresh run.
   *
   * Only the epistemic half is swapped. The cached base layer is a function of
   * the terrain alone — contours, shoreline, quarry rim — and the terrain is
   * seeded and identical across runs, so re-tracing it would be pure waste.
   */
  setCartography(carto: Cartography): void {
    this.carto = carto;
  }

  /** world → sheet coordinates */
  private X(x: number): number { return this.ox + x * this.s; }
  private Y(z: number): number { return this.oy + z * this.s; }

  /**
   * Render the static print: everything that is a property of the terrain
   * rather than of the player. Cached, because contour tracing is far too
   * expensive to redo per frame and none of it ever changes.
   */
  private buildBase(): HTMLCanvasElement {
    const cv = document.createElement('canvas');
    cv.width = SHEET; cv.height = SHEET;
    const g = cv.getContext('2d')!;

    // ── paper. A flat fill reads as a UI panel; a faint vignette plus grain
    // reads as a sheet that has been in a glovebox for thirty years.
    g.fillStyle = '#12140f';
    g.fillRect(0, 0, SHEET, SHEET);
    const vig = g.createRadialGradient(SHEET / 2, SHEET / 2, SHEET * 0.1, SHEET / 2, SHEET / 2, SHEET * 0.72);
    vig.addColorStop(0, 'rgba(38,40,32,0.85)');
    vig.addColorStop(1, 'rgba(12,14,11,0.9)');
    g.fillStyle = vig;
    g.fillRect(0, 0, SHEET, SHEET);

    // ── contour lines, traced from the real heightfield by marching squares.
    // These are the single most important element: they are why the map teaches
    // the watershed. Reading it, you can see that everything drains south into
    // the lake and that the ridge is the high ground, which is the same fact the
    // terrain teaches by walking it.
    const CR = 150;                       // contour sampling grid
    const step = WORLD_SIZE / (CR - 1);
    const hs = new Float32Array(CR * CR);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < CR; j++) {
      for (let i = 0; i < CR; i++) {
        const x = -WORLD_SIZE / 2 + i * step;
        const z = -WORLD_SIZE / 2 + j * step;
        const v = this.hf.heightAt(x, z);
        hs[j * CR + i] = v;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
    }
    const INTERVAL = 6;                   // metres between contours
    const start = Math.ceil(lo / INTERVAL) * INTERVAL;
    for (let level = start; level < hi; level += INTERVAL) {
      // index contours (every 30 m) are heavier, as on a real survey sheet
      const index = Math.abs(level % 30) < 0.001;
      g.strokeStyle = `rgba(${INK},${index ? 0.3 : 0.15})`;
      g.lineWidth = index ? 1.15 : 0.6;
      g.beginPath();
      for (let j = 0; j < CR - 1; j++) {
        for (let i = 0; i < CR - 1; i++) {
          const a = hs[j * CR + i], b = hs[j * CR + i + 1];
          const c = hs[(j + 1) * CR + i + 1], d = hs[(j + 1) * CR + i];
          const x0 = -WORLD_SIZE / 2 + i * step, z0 = -WORLD_SIZE / 2 + j * step;
          const x1 = x0 + step, z1 = z0 + step;
          // linear interpolation along each crossed cell edge
          const seg: number[] = [];
          const edge = (va: number, vb: number, ax: number, az: number, bx: number, bz: number) => {
            if ((va - level) * (vb - level) >= 0) return;
            const t = (level - va) / (vb - va);
            seg.push(ax + (bx - ax) * t, az + (bz - az) * t);
          };
          edge(a, b, x0, z0, x1, z0);
          edge(b, c, x1, z0, x1, z1);
          edge(c, d, x1, z1, x0, z1);
          edge(d, a, x0, z1, x0, z0);
          for (let k = 0; k + 3 < seg.length; k += 4) {
            g.moveTo(this.X(seg[k]), this.Y(seg[k + 1]));
            g.lineTo(this.X(seg[k + 2]), this.Y(seg[k + 3]));
          }
        }
      }
      g.stroke();
    }

    // ── graticule. Drawn after contours so the grid sits on top like print.
    g.strokeStyle = `rgba(${INK},0.075)`;
    g.lineWidth = 0.5;
    g.beginPath();
    for (let m = -WORLD_SIZE / 2; m <= WORLD_SIZE / 2; m += 40) {
      g.moveTo(this.X(m), this.Y(-WORLD_SIZE / 2)); g.lineTo(this.X(m), this.Y(WORLD_SIZE / 2));
      g.moveTo(this.X(-WORLD_SIZE / 2), this.Y(m)); g.lineTo(this.X(WORLD_SIZE / 2), this.Y(m));
    }
    g.stroke();

    return cv;
  }

  /** trace a closed world-space polygon onto a context */
  private polyPath(g: CanvasRenderingContext2D, pts: readonly { x: number; z: number }[]): void {
    g.beginPath();
    g.moveTo(this.X(pts[0].x), this.Y(pts[0].z));
    for (let i = 1; i < pts.length; i++) g.lineTo(this.X(pts[i].x), this.Y(pts[i].z));
    g.closePath();
  }

  /**
   * Is this world point surveyed enough to draw?
   *
   * Sampled from the exploration grid rather than tested against landmark
   * discovery, so a path only appears along the stretches you have actually
   * walked. Watching a route extend itself across the sheet as you explore is
   * the whole reward of the map.
   */
  private known(x: number, z: number): boolean {
    const i = Math.floor((x + WORLD_SIZE / 2) / this.carto.cell);
    const j = Math.floor((z + WORLD_SIZE / 2) / this.carto.cell);
    return this.carto.at(i, j) > 0.35;
  }

  /**
   * Draw the map.
   *
   * @param px,pz  player world position
   * @param yaw    player heading, for the position arrow
   * @param timeSec run time, drives the "surveyed" annotations
   */
  draw(px: number, pz: number, yaw: number): void {
    const g = this.ctx;
    if (!this.base) this.base = this.buildBase();

    g.clearRect(0, 0, SHEET, SHEET);
    g.drawImage(this.base, 0, 0);

    // ── fog of war. Everything unsurveyed is *masked out*, not dimmed: the
    // sheet is only filled in where the surveyor has been.
    const cell = this.carto.cell * this.s;
    g.save();
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = 'rgba(0,0,0,1)';
    for (let j = 0; j < this.carto.res; j++) {
      for (let i = 0; i < this.carto.res; i++) {
        const v = this.carto.at(i, j);
        if (v <= 0) continue;
        const x = -WORLD_SIZE / 2 + i * this.carto.cell;
        const z = -WORLD_SIZE / 2 + j * this.carto.cell;
        g.globalAlpha = Math.min(1, v * 1.15);
        // slight overdraw so neighbouring cells merge into a soft surveyed
        // region rather than a visible grid of squares
        g.fillRect(this.X(x) - cell * 0.15, this.Y(z) - cell * 0.15, cell * 1.3, cell * 1.3);
      }
    }
    g.restore();
    g.globalAlpha = 1;

    // ── Pine Lake. Water is the one filled shape on the sheet, because on a
    // real survey it is the one thing rendered as an area rather than a line.
    const shore = this.hf.layout.lake.shore;
    if (shore.some(p => this.known(p.x, p.z))) {
      this.polyPath(g, shore);
      g.fillStyle = `rgba(${WATER},0.3)`;
      g.fill();
      g.strokeStyle = `rgba(${WATER},0.85)`;
      g.lineWidth = 1.5;
      g.stroke();
    }

    // ── the quarry rim, hatched on the inside edge like a cut face
    const rim = this.hf.layout.quarryRim;
    if (rim.some(p => this.known(p.x, p.z))) {
      this.polyPath(g, rim);
      g.strokeStyle = `rgba(${INK},0.75)`;
      g.lineWidth = 1.4;
      g.setLineDash([5, 3]);
      g.stroke();
      g.setLineDash([]);
    }

    // ── the creek
    const creek = this.hf.layout.creek.path;
    g.strokeStyle = `rgba(${WATER},0.7)`;
    g.lineWidth = 1.1;
    this.strokeKnown(g, creek);

    // ── the path network, weighted by class so the map teaches the same
    // hierarchy the ground does: a graded road reads differently from a
    // game-trail you can lose.
    for (const edge of this.hf.layout.paths as PathEdge[]) {
      if (edge.cls === 'main') { g.lineWidth = 2.3; g.strokeStyle = `rgba(${INK},0.82)`; g.setLineDash([]); }
      else if (edge.cls === 'trail') { g.lineWidth = 1.5; g.strokeStyle = `rgba(${INK},0.62)`; g.setLineDash([]); }
      else { g.lineWidth = 1.1; g.strokeStyle = `rgba(${INK},0.42)`; g.setLineDash([6, 4]); }
      this.strokeKnown(g, edge.pts);
    }
    g.setLineDash([]);

    // ── landmarks
    for (const k of this.carto.landmarks) {
      if (!k.discovered) continue;
      this.glyph(g, k.lm, k.seenAtDistance);
    }

    // ── pages: hinted as a query, collected as a tick
    for (const p of this.carto.pages) {
      if (!p.hinted) continue;
      const X = this.X(p.x), Y = this.Y(p.z);
      g.lineWidth = 1.4;
      if (p.collected) {
        g.strokeStyle = `rgba(${MARK},0.9)`;
        g.beginPath();
        g.moveTo(X - 3.5, Y); g.lineTo(X - 1, Y + 3); g.lineTo(X + 4, Y - 3.5);
        g.stroke();
      } else {
        g.strokeStyle = `rgba(${MARK},0.55)`;
        g.beginPath();
        g.arc(X, Y, 4.5, 0, Math.PI * 2);
        g.stroke();
        g.fillStyle = `rgba(${MARK},0.75)`;
        g.font = 'bold 8px ui-monospace, monospace';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('?', X, Y + 0.5);
      }
    }

    // ── the player. Drawn last, in pencil-warm ink so it never competes with
    // the print, and as a heading arrow rather than a dot because knowing which
    // way you face is the entire reason to open a map.
    const X = this.X(px), Y = this.Y(pz);
    g.save();
    g.translate(X, Y);
    // world +z is map +y (south), and yaw 0 faces -z, so the arrow's screen
    // rotation is yaw about the sheet normal directly.
    g.rotate(-yaw);
    g.fillStyle = `rgba(${MARK},0.95)`;
    g.beginPath();
    g.moveTo(0, -7.5); g.lineTo(4.6, 5); g.lineTo(0, 2.6); g.lineTo(-4.6, 5);
    g.closePath();
    g.fill();
    g.restore();
    // a halo so the mark is findable on a busy sheet
    g.strokeStyle = `rgba(${MARK},0.28)`;
    g.lineWidth = 1;
    g.beginPath(); g.arc(X, Y, 12, 0, Math.PI * 2); g.stroke();
  }

  /** stroke only the surveyed spans of a polyline */
  private strokeKnown(g: CanvasRenderingContext2D, pts: readonly { x: number; z: number }[]): void {
    let drawing = false;
    g.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (this.known(p.x, p.z)) {
        if (!drawing) { g.moveTo(this.X(p.x), this.Y(p.z)); drawing = true; }
        else g.lineTo(this.X(p.x), this.Y(p.z));
      } else {
        drawing = false;
      }
    }
    g.stroke();
  }

  /**
   * A landmark glyph.
   *
   * Each kind gets a distinct mark rather than a shared pin, so the sheet is
   * readable at a glance and at mobile scale — the icon-set rule that the set
   * matters more than any one piece. All glyphs share one stroke weight, one
   * ink, and a 9 px envelope; only the geometry differs.
   */
  private glyph(g: CanvasRenderingContext2D, lm: PinewoodLandmark, distant: boolean): void {
    const X = this.X(lm.x), Y = this.Y(lm.z);
    const a = distant ? 0.5 : 0.92;
    g.strokeStyle = `rgba(${INK},${a})`;
    g.fillStyle = `rgba(${INK},${a})`;
    g.lineWidth = 1.5;
    g.beginPath();

    switch (lm.kind) {
      case 'cabin':
      case 'shack': {
        // a gabled hut in plan — the shack is drawn broken-roofed
        g.moveTo(X - 4.5, Y + 4); g.lineTo(X - 4.5, Y - 1); g.lineTo(X, Y - 5);
        g.lineTo(X + 4.5, Y - 1); g.lineTo(X + 4.5, Y + 4);
        if (lm.kind === 'cabin') g.closePath();
        g.stroke();
        break;
      }
      case 'tower': {
        // splayed legs + a deck: the fire-lookout silhouette
        g.moveTo(X - 4.5, Y + 5); g.lineTo(X - 1.6, Y - 2);
        g.moveTo(X + 4.5, Y + 5); g.lineTo(X + 1.6, Y - 2);
        g.moveTo(X - 3.4, Y + 1.5); g.lineTo(X + 3.4, Y + 1.5);
        g.stroke();
        g.beginPath();
        g.rect(X - 2.6, Y - 5.4, 5.2, 3.4);
        g.stroke();
        break;
      }
      case 'quarry': {
        // an open cut: three benched steps
        g.moveTo(X - 5, Y + 4); g.lineTo(X - 5, Y + 1); g.lineTo(X - 1.6, Y + 1);
        g.lineTo(X - 1.6, Y - 2); g.lineTo(X + 2, Y - 2); g.lineTo(X + 2, Y - 5);
        g.lineTo(X + 5, Y - 5);
        g.stroke();
        break;
      }
      case 'ridge': {
        // a summit chevron with a spot height tick
        g.moveTo(X - 5.5, Y + 3.5); g.lineTo(X - 1.5, Y - 4); g.lineTo(X + 2, Y + 1);
        g.lineTo(X + 5.5, Y - 3);
        g.stroke();
        break;
      }
      case 'rocks': {
        // clustered boulders
        g.moveTo(X - 5, Y + 3.5); g.lineTo(X - 2, Y - 2); g.lineTo(X + 1, Y + 3.5);
        g.closePath(); g.stroke();
        g.beginPath();
        g.moveTo(X, Y + 3.5); g.lineTo(X + 3, Y - 0.5); g.lineTo(X + 5.5, Y + 3.5);
        g.closePath(); g.stroke();
        break;
      }
      case 'camp': {
        // two tents
        g.moveTo(X - 5.5, Y + 3.5); g.lineTo(X - 2.5, Y - 2.5); g.lineTo(X + 0.5, Y + 3.5);
        g.closePath(); g.stroke();
        g.beginPath();
        g.moveTo(X + 0.5, Y + 3.5); g.lineTo(X + 3, Y - 0.5); g.lineTo(X + 5.5, Y + 3.5);
        g.closePath(); g.stroke();
        break;
      }
      case 'dock': {
        // a jetty with piles
        g.moveTo(X - 5, Y - 1.5); g.lineTo(X + 5, Y - 1.5);
        g.moveTo(X - 3, Y - 1.5); g.lineTo(X - 3, Y + 3);
        g.moveTo(X, Y - 1.5); g.lineTo(X, Y + 3);
        g.moveTo(X + 3, Y - 1.5); g.lineTo(X + 3, Y + 3);
        g.stroke();
        break;
      }
      case 'clearing': {
        // an open ring — an absence of trees, drawn as absence
        g.arc(X, Y, 4.6, 0, Math.PI * 2);
        g.setLineDash([3, 2.5]); g.stroke(); g.setLineDash([]);
        break;
      }
      case 'lake': {
        // no glyph: the water body is already the mark
        break;
      }
      case 'trailhead': {
        // a way-out arrow
        g.moveTo(X - 4.5, Y); g.lineTo(X + 3, Y);
        g.moveTo(X + 0.5, Y - 3.2); g.lineTo(X + 4.2, Y); g.lineTo(X + 0.5, Y + 3.2);
        g.stroke();
        break;
      }
      default: {
        // junction: a crossroads tick
        g.moveTo(X - 4, Y); g.lineTo(X + 4, Y);
        g.moveTo(X, Y - 4); g.lineTo(X, Y + 4);
        g.stroke();
        break;
      }
    }

    // Label. Only for places actually visited: a distant sighting tells you
    // *that* something is there, not what it is called.
    if (!distant && lm.kind !== 'hub') {
      g.font = '9px ui-monospace, monospace';
      g.textAlign = 'center'; g.textBaseline = 'top';
      g.fillStyle = `rgba(${INK},0.62)`;
      g.fillText(lm.name.toUpperCase(), X, Y + 7);
    }
  }

  /** legend / status line, rendered by the caller into DOM (crisper text) */
  status(): string {
    const pct = (this.carto.exploredFraction * 100).toFixed(0);
    return `SURVEYED ${pct}%   ·   LANDMARKS ${this.carto.discoveredCount}/${LANDMARKS.length}`
      + `   ·   RECORDINGS ${this.carto.collectedCount}/${this.carto.pages.length}`;
  }

  /** map px of a world point, exposed for tests */
  debugPx(x: number, z: number): { px: number; py: number } { return worldToPx(x, z); }
}
