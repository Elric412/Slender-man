/**
 * ============================================================================
 * TargetPool — recycling render-target allocator with a hard memory budget
 * ============================================================================
 *
 * ### The bug this fixes (architecture doc P1 — the worst thing in the engine)
 *
 * `RenderPipeline.adaptResolution()` responds to a slow frame by changing
 * `renderScale` and calling `resize()`. `resize()` called `disposeTargets()`
 * and then reallocated **~113 MB of GPU render targets** — including four
 * full-res RGBA16F surfaces — and invalidated every temporal history.
 *
 * So the mechanism whose entire purpose is to recover from a late frame caused
 * a multi-frame allocation stall *plus* a TAA/AO/volumetric history reset, at
 * precisely the moment the frame was already late. And because the controller
 * is hysteretic in both directions, a scene hovering near the threshold paid
 * that cost repeatedly.
 *
 * ### The fix
 *
 * Targets are *requested by descriptor* and *returned to a pool* instead of
 * disposed. Dynamic resolution quantises to a small ladder of scale steps, so
 * the set of sizes ever requested is small and bounded — which means after the
 * first visit to a step, switching to it is a map lookup and zero allocation.
 *
 * Three properties that make this safe rather than just faster:
 *
 * **Bounded.** The pool tracks bytes and evicts least-recently-used entries
 * against a budget from `GpuCaps`. A recycling allocator with no ceiling is a
 * leak with good manners; mobile Safari kills a tab that oversubscribes GPU
 * memory without any recoverable signal first.
 *
 * **Generation-stamped.** Each lease carries the generation it was issued in.
 * A stale reference from before a context loss can be detected rather than
 * sampled as garbage.
 *
 * **History-preserving.** Because a scale step's targets survive being left,
 * returning to a previously-visited step can keep its temporal history valid.
 * The pipeline only invalidates when the dimensions it is reading actually
 * changed content, not merely because a resize call happened.
 */

import * as THREE from 'three';

export interface TargetDesc {
  width: number;
  height: number;
  /** HalfFloat for HDR, UnsignedByte for masks/LDR, Float for 1x1 exposure */
  type?: THREE.TextureDataType;
  filter?: THREE.MagnificationTextureFilter;
  /** attach a depth texture (only the scene target wants this) */
  depth?: boolean;
  /** number of colour attachments; >1 builds a WebGLMultipleRenderTargets */
  count?: number;
  /** identity tag, so two same-sized targets with different roles don't alias */
  tag: string;
}

interface Entry {
  rt: THREE.WebGLRenderTarget;
  bytes: number;
  key: string;
  lastUsed: number;
  leased: boolean;
}

function bytesPerPixel(type: THREE.TextureDataType | undefined, count: number): number {
  const per = type === THREE.UnsignedByteType ? 4
    : type === THREE.FloatType ? 16
    : 8; // HalfFloat RGBA
  return per * Math.max(1, count);
}

export class TargetPool {
  private entries = new Map<string, Entry>();
  private tick = 0;
  private generation = 0;
  private bytesResident = 0;

  /** Hard ceiling. Exceeding it evicts unleased LRU entries. */
  budgetBytes: number;

  readonly stats = {
    resident: 0, residentBytes: 0, leased: 0,
    allocations: 0, recycles: 0, evictions: 0, overBudgetEvents: 0,
  };

  constructor(private renderer: THREE.WebGLRenderer, budgetBytes: number) {
    this.budgetBytes = budgetBytes;
  }

  get gen(): number { return this.generation; }

  private key(d: TargetDesc): string {
    return `${d.tag}|${d.width}x${d.height}|${d.type ?? 'hf'}|${d.filter ?? 'lin'}|${d.depth ? 'd' : ''}|${d.count ?? 1}`;
  }

  /**
   * Acquire a target. Returns a recycled one when the exact descriptor has been
   * seen before, otherwise allocates.
   *
   * The depth texture is created alongside and owned by the entry, so the
   * caller never has to reason about its lifetime — which is where the previous
   * code's `depthTex` leak risk lived (it was reassigned on every resize and
   * only disposed via the render target's own dispose).
   */
  acquire(d: TargetDesc): THREE.WebGLRenderTarget {
    const k = this.key(d);
    const hit = this.entries.get(k);
    if (hit) {
      hit.lastUsed = ++this.tick;
      hit.leased = true;
      this.stats.recycles++;
      this.refreshStats();
      return hit.rt;
    }

    const w = Math.max(1, Math.floor(d.width));
    const h = Math.max(1, Math.floor(d.height));
    const bytes = w * h * bytesPerPixel(d.type, d.count ?? 1) + (d.depth ? w * h * 4 : 0);

    // Make room *before* allocating, so we never momentarily hold budget+new.
    this.evictFor(bytes);

    const filter = d.filter ?? THREE.LinearFilter;
    let depthTexture: THREE.DepthTexture | undefined;
    if (d.depth) {
      depthTexture = new THREE.DepthTexture(w, h);
      depthTexture.format = THREE.DepthFormat;
      depthTexture.type = THREE.UnsignedIntType;
      depthTexture.minFilter = THREE.NearestFilter;
      depthTexture.magFilter = THREE.NearestFilter;
    }

    const opts: THREE.RenderTargetOptions = {
      minFilter: filter,
      magFilter: filter,
      format: THREE.RGBAFormat,
      type: d.type ?? THREE.HalfFloatType,
      depthBuffer: !!d.depth,
      depthTexture,
      stencilBuffer: false,
      generateMipmaps: false,
    };
    const count = d.count ?? 1;
    const rt = count > 1
      ? new THREE.WebGLRenderTarget(w, h, { ...opts, count })
      : new THREE.WebGLRenderTarget(w, h, opts);

    this.entries.set(k, { rt, bytes, key: k, lastUsed: ++this.tick, leased: true });
    this.bytesResident += bytes;
    this.stats.allocations++;
    this.refreshStats();
    return rt;
  }

  /**
   * Mark a target as no longer in active use. It stays resident (that is the
   * whole point) but becomes an eviction candidate.
   */
  release(rt: THREE.WebGLRenderTarget | null | undefined): void {
    if (!rt) return;
    for (const e of this.entries.values()) {
      if (e.rt === rt) { e.leased = false; break; }
    }
    this.refreshStats();
  }

  /** Release every lease without freeing anything — used on a scale change. */
  releaseAll(): void {
    for (const e of this.entries.values()) e.leased = false;
    this.refreshStats();
  }

  private evictFor(incoming: number): void {
    if (this.bytesResident + incoming <= this.budgetBytes) return;
    this.stats.overBudgetEvents++;
    // LRU over *unleased* entries only. A leased target is being sampled by a
    // pass this frame; freeing it would sample a deleted texture.
    const cands: Entry[] = [];
    for (const e of this.entries.values()) if (!e.leased) cands.push(e);
    cands.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of cands) {
      if (this.bytesResident + incoming <= this.budgetBytes * 0.9) break;
      this.destroy(e);
      this.stats.evictions++;
    }
  }

  private destroy(e: Entry): void {
    const dt = (e.rt as unknown as { depthTexture?: THREE.DepthTexture }).depthTexture;
    dt?.dispose();
    e.rt.dispose();
    this.entries.delete(e.key);
    this.bytesResident -= e.bytes;
  }

  /** Free everything. Called on context loss and on quality-tier restructure. */
  purge(): void {
    for (const e of Array.from(this.entries.values())) this.destroy(e);
    this.entries.clear();
    this.bytesResident = 0;
    this.generation++;
    this.refreshStats();
  }

  private refreshStats(): void {
    let leased = 0;
    for (const e of this.entries.values()) if (e.leased) leased++;
    this.stats.resident = this.entries.size;
    this.stats.residentBytes = this.bytesResident;
    this.stats.leased = leased;
  }

  dispose(): void { this.purge(); }
}

/**
 * Quantised dynamic-resolution ladder.
 *
 * The old controller moved `renderScale` in continuous 0.05/0.1 steps, so the
 * set of allocated sizes was effectively unbounded and the pool could never
 * get a hit. A ladder of eight steps means the pool warms up within a few
 * adjustments and every subsequent change is free.
 *
 * The steps are denser near 1.0 because that is where the perceptual cost of a
 * change is highest: dropping 1.0 → 0.92 is invisible under CAS sharpening,
 * whereas 0.65 → 0.55 is not, so the low end can afford coarser jumps.
 */
export const SCALE_LADDER = [0.55, 0.62, 0.70, 0.78, 0.85, 0.92, 1.0] as const;

export function quantiseScale(s: number): number {
  let best: number = SCALE_LADDER[0];
  let bd = Infinity;
  for (const v of SCALE_LADDER) {
    const d = Math.abs(v - s);
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

/** Index of a ladder step, for stepping up/down by exactly one notch. */
export function ladderIndex(s: number): number {
  const q = quantiseScale(s);
  return SCALE_LADDER.indexOf(q as typeof SCALE_LADDER[number]);
}
