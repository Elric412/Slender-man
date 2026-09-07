/**
 * Pinewood's in-game survey sheet.
 *
 * The supplied Pinewood Forest artwork is the visual base because the game world
 * itself was authored from that same survey. It is not treated as a screenshot:
 * baked progress, collectible marks and the original player arrow are scrubbed,
 * then live Cartography state is drawn over it. The result keeps the authored
 * map's texture and hierarchy without leaking information the player has not
 * actually discovered.
 */

import { Cartography } from '../world/Cartography';
import {
  LANDMARKS, PathEdge, PinewoodLandmark, SPAWN_PX, WORLD_SIZE, worldToPx,
} from '../world/PinewoodLayout';
import { HeightField } from '../world/HeightField';

export const REFERENCE_W = 1024;
export const REFERENCE_H = 683;

const INK = '218, 214, 200';
const DIM = '154, 158, 151';
const MARK = '214, 178, 82';
const PAPER = '#080b09';
const ART_PARTS = Array.from({ length: 6 }, (_, i) => `./ui/pinewood-map/map.${i}.b64`);

export class SurveyMap {
  private ctx: CanvasRenderingContext2D;
  private referenceArt: HTMLImageElement | null = null;
  private referenceLoading = false;
  private fogCanvas: HTMLCanvasElement | null = null;
  private fogCtx: CanvasRenderingContext2D | null = null;
  private fogImage: ImageData | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private carto: Cartography,
    private hf: HeightField,
  ) {
    canvas.width = REFERENCE_W;
    canvas.height = REFERENCE_H;
    const c = canvas.getContext('2d');
    if (!c) throw new Error('SurveyMap: 2D context unavailable');
    this.ctx = c;
    void this.loadReferenceArt();
  }

  setCartography(carto: Cartography): void {
    this.carto = carto;
    this.fogCanvas = null;
    this.fogCtx = null;
    this.fogImage = null;
  }

  /** Assemble the compressed artwork from small static text chunks once. */
  private async loadReferenceArt(): Promise<void> {
    if (this.referenceArt || this.referenceLoading) return;
    this.referenceLoading = true;
    try {
      const parts = await Promise.all(ART_PARTS.map(async path => {
        const r = await fetch(path, { cache: 'force-cache' });
        if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
        return (await r.text()).trim();
      }));
      const img = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('reference survey artwork could not be decoded'));
      });
      img.src = `data:image/webp;base64,${parts.join('')}`;
      await loaded;
      this.referenceArt = img;
    } catch (err) {
      // Navigation still works if the art cannot load. The fallback below is
      // derived from the same world geometry and therefore never lies.
      console.warn('[STATIC] reference survey artwork unavailable:', err);
    } finally {
      this.referenceLoading = false;
    }
  }

  private X(x: number): number { return worldToPx(x, 0).px; }
  private Y(z: number): number { return worldToPx(0, z).py; }

  private known(x: number, z: number): boolean {
    const i = Math.floor((x + WORLD_SIZE / 2) / this.carto.cell);
    const j = Math.floor((z + WORLD_SIZE / 2) / this.carto.cell);
    return this.carto.at(i, j) > 0.35;
  }

  draw(px: number, pz: number, yaw: number): void {
    const g = this.ctx;
    g.clearRect(0, 0, REFERENCE_W, REFERENCE_H);

    if (this.referenceArt) {
      this.drawReferenceArt(g);
      this.drawExplorationVeil(g);
      this.drawReferenceReadouts(g);
    } else {
      this.drawFallback(g);
    }

    this.drawPages(g);
    this.drawPlayer(g, px, pz, yaw);
  }

  /**
   * Draw the supplied survey artwork and remove information that must be live.
   * The image is deliberately only a base plate; gameplay state always wins.
   */
  private drawReferenceArt(g: CanvasRenderingContext2D): void {
    g.drawImage(this.referenceArt!, 0, 0, REFERENCE_W, REFERENCE_H);

    // Remove the baked 42% readout. A live value is painted after fog-of-war.
    this.patch(g, 17, 82, 162, 31, 0.95);

    // Remove the baked objective/progress block ("3/8 pages").
    this.patch(g, 807, 284, 205, 88, 0.96);

    // The game calls them recordings/tapes rather than pages. Replace the one
    // legend label while keeping the artwork's icon language and spacing.
    this.patch(g, 861, 151, 145, 23, 0.93);

    // The artwork includes its original spawn arrow. It must never remain behind
    // after the player walks away, so erase only that tiny mark and redraw the
    // actual player later.
    this.patch(g, SPAWN_PX[0] - 10, SPAWN_PX[1] - 13, 21, 25, 0.90);

    // The source painting shows all recording sites. Hide every baked site here;
    // only hinted/collected locations are reintroduced from Cartography below.
    for (const p of this.carto.pages) {
      const x = this.X(p.x), y = this.Y(p.z);
      this.patch(g, x - 7, y - 8, 14, 17, 0.91);
    }
  }

  private patch(
    g: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, alpha: number,
  ): void {
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, `rgba(5,8,7,${alpha})`);
    grd.addColorStop(1, `rgba(9,12,10,${Math.max(0, alpha - 0.07)})`);
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
  }

  /**
   * Fog-of-war over only the geographic field, never the legend/status rail.
   * A 96² alpha mask is cheap to rebuild and scales softly over the artwork.
   */
  private drawExplorationVeil(g: CanvasRenderingContext2D): void {
    const res = this.carto.res;
    if (!this.fogCanvas || this.fogCanvas.width !== res) {
      this.fogCanvas = document.createElement('canvas');
      this.fogCanvas.width = res;
      this.fogCanvas.height = res;
      this.fogCtx = this.fogCanvas.getContext('2d');
      this.fogImage = this.fogCtx?.createImageData(res, res) ?? null;
    }
    if (!this.fogCanvas || !this.fogCtx || !this.fogImage) return;

    const d = this.fogImage.data;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const v = Math.min(1, this.carto.at(i, j) * 1.18);
        const a = Math.round(238 * (1 - v));
        const o = (j * res + i) * 4;
        d[o] = 1; d[o + 1] = 3; d[o + 2] = 2; d[o + 3] = a;
      }
    }
    this.fogCtx.putImageData(this.fogImage, 0, 0);

    const left = this.X(-WORLD_SIZE / 2);
    const top = this.Y(-WORLD_SIZE / 2);
    const right = this.X(WORLD_SIZE / 2);
    const bottom = this.Y(WORLD_SIZE / 2);

    g.save();
    g.imageSmoothingEnabled = true;
    g.filter = 'blur(5px)';
    g.drawImage(this.fogCanvas, left, top, right - left, bottom - top);
    g.restore();

    // A faint uniform wash makes the revealed/unknown boundary feel like pencil
    // graphite rather than a videogame minimap mask.
    g.save();
    g.globalAlpha = 0.08;
    g.fillStyle = '#000';
    g.fillRect(Math.max(0, left), Math.max(0, top), Math.min(760, right) - Math.max(0, left), REFERENCE_H);
    g.restore();
  }

  private drawReferenceReadouts(g: CanvasRenderingContext2D): void {
    const explored = Math.round(this.carto.exploredFraction * 100);
    const collected = this.carto.collectedCount;
    const total = this.carto.pages.length;

    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillStyle = `rgba(${INK},0.78)`;
    g.fillText(`EXPLORED: ${explored}%`, 25, 98);

    g.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillStyle = `rgba(${INK},0.82)`;
    g.fillText('OBJECTIVE', 820, 302);
    g.strokeStyle = `rgba(${INK},0.34)`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(820, 316); g.lineTo(998, 316); g.stroke();
    g.fillStyle = `rgba(${DIM},0.88)`;
    g.fillText(`RECOVER ALL ${total} RECORDINGS`, 820, 337);
    g.fillStyle = `rgba(${MARK},0.88)`;
    g.fillText(`RECOVERED: ${collected}/${total}`, 820, 359);

    g.fillStyle = `rgba(${DIM},0.88)`;
    g.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillText('RECORDING SITE', 869, 163);
  }

  /** Geometry-only fallback used if the authored artwork fails to load. */
  private drawFallback(g: CanvasRenderingContext2D): void {
    g.fillStyle = PAPER;
    g.fillRect(0, 0, REFERENCE_W, REFERENCE_H);

    const grad = g.createRadialGradient(420, 330, 40, 420, 330, 560);
    grad.addColorStop(0, 'rgba(38,43,35,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0.65)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 780, REFERENCE_H);

    g.strokeStyle = `rgba(${INK},0.10)`;
    g.lineWidth = 1;
    for (let m = -WORLD_SIZE / 2; m <= WORLD_SIZE / 2; m += 40) {
      g.beginPath();
      g.moveTo(this.X(m), this.Y(-WORLD_SIZE / 2));
      g.lineTo(this.X(m), this.Y(WORLD_SIZE / 2));
      g.moveTo(this.X(-WORLD_SIZE / 2), this.Y(m));
      g.lineTo(this.X(WORLD_SIZE / 2), this.Y(m));
      g.stroke();
    }

    for (const edge of this.hf.layout.paths as PathEdge[]) {
      g.strokeStyle = `rgba(${INK},${edge.cls === 'main' ? 0.8 : edge.cls === 'trail' ? 0.58 : 0.40})`;
      g.lineWidth = edge.cls === 'main' ? 2.2 : 1.3;
      g.setLineDash(edge.cls === 'faint' ? [6, 5] : []);
      this.strokeKnown(g, edge.pts);
    }
    g.setLineDash([]);

    for (const k of this.carto.landmarks) {
      if (k.discovered) this.fallbackLandmark(g, k.lm, k.seenAtDistance);
    }

    g.fillStyle = `rgba(${INK},0.82)`;
    g.font = '25px ui-monospace, monospace';
    g.fillText('PINEWOOD FOREST', 25, 38);
    this.drawReferenceReadouts(g);
  }

  private strokeKnown(g: CanvasRenderingContext2D, pts: readonly { x: number; z: number }[]): void {
    let drawing = false;
    g.beginPath();
    for (const p of pts) {
      if (!this.known(p.x, p.z)) { drawing = false; continue; }
      if (!drawing) { g.moveTo(this.X(p.x), this.Y(p.z)); drawing = true; }
      else g.lineTo(this.X(p.x), this.Y(p.z));
    }
    g.stroke();
  }

  private fallbackLandmark(g: CanvasRenderingContext2D, lm: PinewoodLandmark, distant: boolean): void {
    const x = this.X(lm.x), y = this.Y(lm.z);
    g.strokeStyle = `rgba(${INK},${distant ? 0.45 : 0.82})`;
    g.fillStyle = `rgba(${INK},${distant ? 0.45 : 0.82})`;
    g.lineWidth = 1.4;
    g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.stroke();
    if (!distant && lm.kind !== 'hub') {
      g.font = '10px ui-monospace, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'top';
      g.fillText(lm.name.toUpperCase(), x, y + 7);
    }
  }

  private drawPages(g: CanvasRenderingContext2D): void {
    for (const p of this.carto.pages) {
      if (!p.hinted) continue;
      const x = this.X(p.x), y = this.Y(p.z);
      g.lineWidth = 1.5;
      if (p.collected) {
        g.strokeStyle = `rgba(${MARK},0.95)`;
        g.beginPath();
        g.moveTo(x - 4, y); g.lineTo(x - 1, y + 3.5); g.lineTo(x + 5, y - 4);
        g.stroke();
      } else {
        g.fillStyle = 'rgba(7,9,8,0.82)';
        g.strokeStyle = `rgba(${MARK},0.86)`;
        g.fillRect(x - 5, y - 6, 10, 12);
        g.strokeRect(x - 5, y - 6, 10, 12);
        g.beginPath(); g.moveTo(x - 2, y - 2); g.lineTo(x + 2, y - 2); g.stroke();
        g.beginPath(); g.moveTo(x - 2, y + 1); g.lineTo(x + 2, y + 1); g.stroke();
      }
    }
  }

  private drawPlayer(g: CanvasRenderingContext2D, px: number, pz: number, yaw: number): void {
    const x = this.X(px), y = this.Y(pz);
    g.save();
    g.translate(x, y);
    g.rotate(-yaw);
    g.fillStyle = `rgba(${MARK},0.98)`;
    g.strokeStyle = 'rgba(18,14,5,0.92)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(0, -9); g.lineTo(5.4, 6); g.lineTo(0, 3.2); g.lineTo(-5.4, 6);
    g.closePath();
    g.fill(); g.stroke();
    g.restore();

    g.strokeStyle = `rgba(${MARK},0.34)`;
    g.lineWidth = 1;
    g.beginPath(); g.arc(x, y, 13, 0, Math.PI * 2); g.stroke();
  }

  status(): string {
    const pct = (this.carto.exploredFraction * 100).toFixed(0);
    return `SURVEYED ${pct}%   ·   LANDMARKS ${this.carto.discoveredCount}/${LANDMARKS.length}`
      + `   ·   RECORDINGS ${this.carto.collectedCount}/${this.carto.pages.length}`;
  }

  debugPx(x: number, z: number): { px: number; py: number } { return worldToPx(x, z); }
}
