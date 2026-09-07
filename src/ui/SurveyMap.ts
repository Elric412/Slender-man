/**
 * Pinewood's live in-game survey sheet.
 *
 * The supplied Pinewood Forest artwork is the visual base because the game world
 * itself was authored from that same survey. It is not treated as a screenshot:
 * baked progress, collectible marks and the original player arrow are scrubbed,
 * then live Cartography state is drawn over it. The geographic field can be
 * panned/zoomed while the legend rail stays pinned, so the sheet behaves like a
 * real inspection surface instead of a frozen image.
 */

import { Cartography } from '../world/Cartography';
import {
  LANDMARKS, PathEdge, PinewoodLandmark, SPAWN_PX, WORLD_SIZE, worldToPx,
} from '../world/PinewoodLayout';
import { HeightField } from '../world/HeightField';

export const REFERENCE_W = 1024;
export const REFERENCE_H = 683;

const FIELD_W = 800;
const MIN_ZOOM = 1;
const MAX_ZOOM = 3.2;
/** Maximum unknown-area veil alpha. The source art is already dark, so this is
 * deliberately translucent: unexplored ground reads as uncertain, not black. */
const UNKNOWN_ALPHA = 118;
const INK = '218, 214, 200';
const DIM = '154, 158, 151';
const MARK = '214, 178, 82';
const PAPER = '#080b09';
const ART_PARTS = Array.from({ length: 6 }, (_, i) => `./ui/pinewood-map/map.${i}.b64`);
const MAP_STYLE = './ui/map-reference.css';

type Point = { x: number; y: number };

export class SurveyMap {
  private ctx: CanvasRenderingContext2D;
  private layer: HTMLCanvasElement;
  private layerCtx: CanvasRenderingContext2D;
  private referenceArt: HTMLImageElement | null = null;
  private referenceLoading = false;
  private fogCanvas: HTMLCanvasElement | null = null;
  private fogCtx: CanvasRenderingContext2D | null = null;
  private fogImage: ImageData | null = null;

  private viewScale = 1;
  private panX = 0;
  private panY = 0;
  private pointers = new Map<number, Point>();
  private pinchDistance = 0;
  private pinchScale = 1;
  private lastPlayerX = 0;
  private lastPlayerZ = 0;
  private lastPlayerYaw = 0;

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

    this.layer = document.createElement('canvas');
    this.layer.width = REFERENCE_W;
    this.layer.height = REFERENCE_H;
    const lc = this.layer.getContext('2d');
    if (!lc) throw new Error('SurveyMap: offscreen 2D context unavailable');
    this.layerCtx = lc;

    this.enhanceMapChrome();
    this.bindInteractions();
    void this.loadReferenceArt();
  }

  setCartography(carto: Cartography): void {
    this.carto = carto;
    this.fogCanvas = null;
    this.fogCtx = null;
    this.fogImage = null;
    this.resetView();
  }

  /** Upgrade the existing map DOM without changing Menu/Main interfaces. */
  private enhanceMapChrome(): void {
    if (!document.getElementById('map-reference-css')) {
      const link = document.createElement('link');
      link.id = 'map-reference-css';
      link.rel = 'stylesheet';
      link.href = MAP_STYLE;
      document.head.appendChild(link);
    }

    const sheet = this.canvas.closest('.map-sheet') as HTMLElement | null;
    const overlay = this.canvas.closest('.map-overlay') as HTMLElement | null;
    sheet?.classList.add('map-sheet-reference');
    this.canvas.classList.add('map-interactive');
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Interactive Pinewood Forest survey map. Drag to pan, wheel or pinch to zoom, double click to center on your position.');
    if (overlay) {
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Pinewood Forest survey map');
    }

    const foot = sheet?.querySelector('.map-foot') as HTMLElement | null;
    if (!foot || foot.id === 'map-close') return;
    foot.id = 'map-close';
    foot.classList.add('map-close');
    foot.setAttribute('role', 'button');
    foot.setAttribute('tabindex', '0');
    foot.setAttribute('aria-label', 'Close survey map');
    foot.innerHTML = '<span class="map-close-key" aria-hidden="true">M</span><span>CLOSE MAP</span>';

    const close = () => this.queueMapToggle();
    foot.addEventListener('click', close);
    foot.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      close();
    });
  }

  /** Pan/zoom inspection. Pointer events unify mouse, pen and touch; two active
   * pointers become a pinch gesture, while a single pointer drags the field. */
  private bindInteractions(): void {
    this.canvas.style.touchAction = 'none';
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.canvas.addEventListener('wheel', (e) => {
      const p = this.canvasPoint(e.clientX, e.clientY);
      if (p.x > FIELD_W) return;
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0016);
      this.zoomAt(p.x, p.y, this.viewScale * factor);
    }, { passive: false });

    this.canvas.addEventListener('pointerdown', (e) => {
      const p = this.canvasPoint(e.clientX, e.clientY);
      if (p.x > FIELD_W) return;
      e.preventDefault();
      this.canvas.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size >= 2) this.beginPinch();
    });

    this.canvas.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const next = this.canvasPoint(e.clientX, e.clientY);
      this.pointers.set(e.pointerId, next);
      if (this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
        const midX = (a.x + b.x) * 0.5;
        const midY = (a.y + b.y) * 0.5;
        if (this.pinchDistance <= 0) this.beginPinch();
        this.zoomAt(midX, midY, this.pinchScale * dist / Math.max(1, this.pinchDistance));
      } else {
        this.panBy(next.x - prev.x, next.y - prev.y);
      }
    });

    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDistance = 0;
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    this.canvas.addEventListener('dblclick', (e) => {
      const p = this.canvasPoint(e.clientX, e.clientY);
      if (p.x <= FIELD_W) this.focusPlayer();
    });

    this.canvas.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') {
        e.preventDefault(); this.zoomAt(FIELD_W / 2, REFERENCE_H / 2, this.viewScale * 1.2);
      } else if (e.key === '-') {
        e.preventDefault(); this.zoomAt(FIELD_W / 2, REFERENCE_H / 2, this.viewScale / 1.2);
      } else if (e.key === '0') {
        e.preventDefault(); this.resetView();
      } else if (e.key === 'Home') {
        e.preventDefault(); this.focusPlayer();
      }
    });
  }

  private beginPinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    this.pinchDistance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    this.pinchScale = this.viewScale;
  }

  private canvasPoint(clientX: number, clientY: number): Point {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) * REFERENCE_W / Math.max(1, r.width),
      y: (clientY - r.top) * REFERENCE_H / Math.max(1, r.height),
    };
  }

  /** Zoom around the pointer so the location under the cursor/fingers stays put. */
  private zoomAt(x: number, y: number, requested: number): void {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, requested));
    if (Math.abs(next - this.viewScale) < 1e-4) return;
    const cx = FIELD_W * 0.5, cy = REFERENCE_H * 0.5;
    const old = this.viewScale;
    this.panX = x - cx - next * (x - cx - this.panX) / old;
    this.panY = y - cy - next * (y - cy - this.panY) / old;
    this.viewScale = next;
    this.clampPan();
    this.present();
  }

  private panBy(dx: number, dy: number): void {
    if (this.viewScale <= MIN_ZOOM + 1e-4) return;
    this.panX += dx;
    this.panY += dy;
    this.clampPan();
    this.present();
  }

  private clampPan(): void {
    const maxX = (this.viewScale - 1) * FIELD_W * 0.5;
    const maxY = (this.viewScale - 1) * REFERENCE_H * 0.5;
    this.panX = Math.max(-maxX, Math.min(maxX, this.panX));
    this.panY = Math.max(-maxY, Math.min(maxY, this.panY));
  }

  private resetView(): void {
    this.viewScale = 1;
    this.panX = 0;
    this.panY = 0;
    this.present();
  }

  private focusPlayer(): void {
    this.viewScale = Math.max(1.65, this.viewScale);
    const x = this.X(this.lastPlayerX), y = this.Y(this.lastPlayerZ);
    this.panX = this.viewScale * (FIELD_W * 0.5 - x);
    this.panY = this.viewScale * (REFERENCE_H * 0.5 - y);
    this.clampPan();
    this.present();
  }

  /** Send the map toggle through Input rather than mutating UI state directly. */
  private queueMapToggle(): void {
    const init: KeyboardEventInit = { code: 'KeyM', key: 'm', bubbles: true };
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keyup', init));
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
      this.redrawLayer();
    } catch (err) {
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
    this.lastPlayerX = px;
    this.lastPlayerZ = pz;
    this.lastPlayerYaw = yaw;
    this.redrawLayer();
  }

  private redrawLayer(): void {
    const g = this.layerCtx;
    g.clearRect(0, 0, REFERENCE_W, REFERENCE_H);

    if (this.referenceArt) {
      this.drawReferenceArt(g);
      this.drawExplorationVeil(g);
      this.drawReferenceReadouts(g);
    } else {
      this.drawFallback(g);
    }

    this.drawPages(g);
    this.drawPlayer(g, this.lastPlayerX, this.lastPlayerZ, this.lastPlayerYaw);
    this.present();
  }

  /** Draw the authored survey a little brighter than the source file. The source
   * was painted for full-screen viewing; without this lift, display black-levels
   * plus the fog veil crush it into an unreadable rectangle on phones. */
  private drawReferenceArt(g: CanvasRenderingContext2D): void {
    g.save();
    g.filter = 'brightness(1.32) contrast(1.04) saturate(0.90)';
    g.drawImage(this.referenceArt!, 0, 0, REFERENCE_W, REFERENCE_H);
    g.restore();

    this.patch(g, 17, 82, 162, 31, 0.84);
    this.patch(g, 807, 284, 205, 88, 0.88);
    this.patch(g, 861, 151, 145, 23, 0.84);
    this.patch(g, SPAWN_PX[0] - 10, SPAWN_PX[1] - 13, 21, 25, 0.78);

    for (const p of this.carto.pages) {
      const x = this.X(p.x), y = this.Y(p.z);
      this.patch(g, x - 7, y - 8, 14, 17, 0.76);
    }
  }

  private patch(
    g: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number, alpha: number,
  ): void {
    const grd = g.createLinearGradient(x, y, x + w, y + h);
    grd.addColorStop(0, `rgba(8,11,9,${alpha})`);
    grd.addColorStop(1, `rgba(13,16,12,${Math.max(0, alpha - 0.07)})`);
    g.fillStyle = grd;
    g.fillRect(x, y, w, h);
  }

  /** Fog-of-war dims unknown terrain without deleting it. The rail remains fully
   * readable, and the low alpha leaves enough topology visible to orient without
   * handing the player exact live objective information. */
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
        const v = Math.min(1, this.carto.at(i, j) * 1.12);
        const a = Math.round(UNKNOWN_ALPHA * (1 - v));
        const o = (j * res + i) * 4;
        d[o] = 8; d[o + 1] = 11; d[o + 2] = 9; d[o + 3] = a;
      }
    }
    this.fogCtx.putImageData(this.fogImage, 0, 0);

    const left = this.X(-WORLD_SIZE / 2);
    const top = this.Y(-WORLD_SIZE / 2);
    const right = this.X(WORLD_SIZE / 2);
    const bottom = this.Y(WORLD_SIZE / 2);

    g.save();
    g.imageSmoothingEnabled = true;
    g.filter = 'blur(4px)';
    g.drawImage(this.fogCanvas, left, top, right - left, bottom - top);
    g.restore();

    g.save();
    g.globalAlpha = 0.025;
    g.fillStyle = '#000';
    const washLeft = Math.max(0, left);
    const washRight = Math.min(FIELD_W, right);
    if (washRight > washLeft) g.fillRect(washLeft, 0, washRight - washLeft, REFERENCE_H);
    g.restore();
  }

  private drawReferenceReadouts(g: CanvasRenderingContext2D): void {
    const explored = Math.round(this.carto.exploredFraction * 100);
    const collected = this.carto.collectedCount;
    const total = this.carto.pages.length;

    g.textBaseline = 'middle';
    g.textAlign = 'left';
    g.font = '16px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillStyle = `rgba(${INK},0.90)`;
    g.fillText(`EXPLORED: ${explored}%`, 25, 98);

    g.font = '15px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillStyle = `rgba(${INK},0.90)`;
    g.fillText('OBJECTIVE', 820, 302);
    g.strokeStyle = `rgba(${INK},0.40)`;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(820, 316); g.lineTo(998, 316); g.stroke();
    g.fillStyle = `rgba(${DIM},0.94)`;
    g.fillText(`RECOVER ALL ${total} RECORDINGS`, 820, 337);
    g.fillStyle = `rgba(${MARK},0.96)`;
    g.fillText(`RECOVERED: ${collected}/${total}`, 820, 359);

    g.fillStyle = `rgba(${DIM},0.92)`;
    g.font = '13px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.fillText('RECORDING SITE', 869, 163);
  }

  /** Geometry-only fallback used if the authored artwork fails to load. */
  private drawFallback(g: CanvasRenderingContext2D): void {
    g.fillStyle = PAPER;
    g.fillRect(0, 0, REFERENCE_W, REFERENCE_H);

    const grad = g.createRadialGradient(420, 330, 40, 420, 330, 560);
    grad.addColorStop(0, 'rgba(48,54,43,0.66)');
    grad.addColorStop(1, 'rgba(4,6,5,0.72)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 780, REFERENCE_H);

    g.strokeStyle = `rgba(${INK},0.14)`;
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

    g.fillStyle = `rgba(${INK},0.88)`;
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
        g.strokeStyle = `rgba(${MARK},0.98)`;
        g.beginPath();
        g.moveTo(x - 4, y); g.lineTo(x - 1, y + 3.5); g.lineTo(x + 5, y - 4);
        g.stroke();
      } else {
        g.fillStyle = 'rgba(7,9,8,0.78)';
        g.strokeStyle = `rgba(${MARK},0.94)`;
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
    g.fillStyle = `rgba(${MARK},1)`;
    g.strokeStyle = 'rgba(18,14,5,0.96)';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(0, -10); g.lineTo(5.8, 6.5); g.lineTo(0, 3.4); g.lineTo(-5.8, 6.5);
    g.closePath();
    g.fill(); g.stroke();
    g.restore();

    g.strokeStyle = `rgba(${MARK},0.48)`;
    g.lineWidth = 1;
    g.beginPath(); g.arc(x, y, 14, 0, Math.PI * 2); g.stroke();
  }

  /** Present the geographic field through the inspection transform while the
   * legend/objective rail remains fixed and always readable. */
  private present(): void {
    const g = this.ctx;
    g.clearRect(0, 0, REFERENCE_W, REFERENCE_H);

    g.save();
    g.beginPath();
    g.rect(0, 0, FIELD_W, REFERENCE_H);
    g.clip();
    g.translate(FIELD_W * 0.5 + this.panX, REFERENCE_H * 0.5 + this.panY);
    g.scale(this.viewScale, this.viewScale);
    g.translate(-FIELD_W * 0.5, -REFERENCE_H * 0.5);
    g.drawImage(this.layer, 0, 0, FIELD_W, REFERENCE_H, 0, 0, FIELD_W, REFERENCE_H);
    g.restore();

    g.drawImage(
      this.layer,
      FIELD_W, 0, REFERENCE_W - FIELD_W, REFERENCE_H,
      FIELD_W, 0, REFERENCE_W - FIELD_W, REFERENCE_H,
    );

    if (this.viewScale > 1.01) {
      g.save();
      g.fillStyle = 'rgba(5,8,7,0.72)';
      g.fillRect(FIELD_W - 108, 12, 94, 24);
      g.fillStyle = `rgba(${INK},0.78)`;
      g.font = '12px ui-monospace, monospace';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(`${this.viewScale.toFixed(1)}×`, FIELD_W - 61, 24);
      g.restore();
    }
  }

  status(): string {
    const pct = (this.carto.exploredFraction * 100).toFixed(0);
    return `SURVEYED ${pct}%   ·   LANDMARKS ${this.carto.discoveredCount}/${LANDMARKS.length}`
      + `   ·   RECORDINGS ${this.carto.collectedCount}/${this.carto.pages.length}`;
  }

  debugPx(x: number, z: number): { px: number; py: number } { return worldToPx(x, z); }
}
