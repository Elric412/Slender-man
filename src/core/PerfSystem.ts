/**
 * PerfSystem — the engine's single owner of frame telemetry.
 *
 * Before this existed there were four disagreeing performance-state stores:
 * `GameLoop.samples` (frame dt ring + update/render EMAs), `RenderPipeline.gpuStats`
 * plus its private `frameCostEma`, `StaticGame.prof` (per-system EMAs) and
 * `StaticGame.bootTimes`. None of them could see the others, so the one component
 * that actually acted on the data — `RenderPipeline.adaptResolution()` — reduced
 * *internal resolution* whenever *CPU* frame time crossed a threshold. A frame made
 * long by an A* repath, a 1M-vertex chunk merge or a tab refocus therefore cost image
 * quality and returned nothing.
 *
 * The fix is not a better threshold, it is attribution. This class separates CPU from
 * GPU, tracks distribution rather than just a mean, and classifies *which* resource is
 * binding. Everything adaptive in the engine reads its verdict from here.
 *
 * Design constraints, both non-negotiable:
 *
 * - **Zero steady-state allocation.** Rings are preallocated Float32Array. Percentiles
 *   come from a fixed-bin histogram walked in O(bins), never from `slice().sort()` — the
 *   old `GameLoop.stats()` allocated an array and sorted it on *every call*, and the HUD
 *   called it every frame. The measurement system must not be a hot-loop offender.
 * - **Every external signal is optional.** `EXT_disjoint_timer_query_webgl2` is absent or
 *   restricted on Safari and several mobile drivers; `performance.memory` is Chromium-only.
 *   When a signal is missing the system degrades to conservative CPU-side classification
 *   rather than failing. It must never *require* an extension to function.
 */

/** Which resource is currently limiting the frame. Drives which knob the controller reaches for. */
export type Bottleneck = 'none' | 'cpu' | 'gpu' | 'memory' | 'unstable';

/** One-time device capability record. Probed once; read by the quality seed and by diagnostics. */
export interface DeviceRecord {
  /** unmasked GPU string when the browser will tell us, else '' */
  gpu: string;
  /** logical cores. Lies on mobile (big.LITTLE) and is capped by some browsers. */
  cores: number;
  /** navigator.deviceMemory in GB, when present */
  memoryGB: number;
  dpr: number;
  mobile: boolean;
  /** software rasteriser (SwiftShader / llvmpipe / ANGLE-on-CPU) */
  software: boolean;
  /** `navigator.gpu` present. Recorded for evidence, NOT acted on — see the brief §7. */
  webgpu: boolean;
  /** GPU timer queries available. When false, GPU ms is unknown and stays 0. */
  gpuTimers: boolean;
  /** performance.memory available (Chromium) */
  heapProbe: boolean;
  maxTextureSize: number;
  maxAnisotropy: number;
}

/** Distribution summary over the sample window. All milliseconds. */
export interface FrameStats {
  /** smoothed mean frame time */
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  worst: number;
  /** mean absolute deviation from p50 — a stutter measure, not a spread measure */
  jitter: number;
  fps: number;
  /** 0..1, 1 = perfectly even pacing. Derived from jitter relative to p50. */
  stability: number;
}

/** Renderer-side counters, pushed once per rendered frame. */
export interface RenderCounters {
  calls: number;
  triangles: number;
  passes: number;
  programs: number;
  geometries: number;
  textures: number;
  /** bytes currently held by render targets (exact, computed by the graph/pipeline) */
  targetBytes: number;
  /** objects that survived culling this frame */
  visible: number;
}

const RING = 256;
/** Histogram bins over 0..~85 ms at 0.333 ms resolution. Beyond that everything is "terrible". */
const BINS = 256;
const BIN_MS = 1 / 3;

/**
 * Incremental fixed-bin histogram. O(1) insert, O(BINS) quantile, zero allocation.
 * Replaces the per-frame `slice().sort()` it was measured against.
 */
class Histogram {
  private bins = new Int32Array(BINS);
  private total = 0;
  private overflow = 0;
  private maxSeen = 0;

  add(ms: number): void {
    if (ms > this.maxSeen) this.maxSeen = ms;
    const b = (ms / BIN_MS) | 0;
    if (b >= BINS) { this.overflow++; } else { this.bins[b < 0 ? 0 : b]++; }
    this.total++;
  }

  /** Remove a sample previously added — lets the ring evict without a full rebuild. */
  remove(ms: number): void {
    if (this.total === 0) return;
    const b = (ms / BIN_MS) | 0;
    if (b >= BINS) { if (this.overflow > 0) this.overflow--; }
    else { const i = b < 0 ? 0 : b; if (this.bins[i] > 0) this.bins[i]--; }
    this.total--;
  }

  get count(): number { return this.total; }
  get max(): number { return this.maxSeen; }

  /** Upper edge of the bin containing the q-th quantile. Conservative by design. */
  quantile(q: number): number {
    if (this.total === 0) return 0;
    const want = q * this.total;
    let acc = 0;
    for (let i = 0; i < BINS; i++) {
      acc += this.bins[i];
      if (acc >= want) return (i + 1) * BIN_MS;
    }
    return this.maxSeen;
  }

  reset(): void {
    this.bins.fill(0);
    this.total = 0;
    this.overflow = 0;
    this.maxSeen = 0;
  }
}

/** Named CPU scope timing, replacing `StaticGame.prof`'s ad-hoc EMA map. */
class ScopeTable {
  private names: string[] = [];
  private ema = new Float32Array(32);
  private open = new Float32Array(32);
  private index = new Map<string, number>();

  id(name: string): number {
    const existing = this.index.get(name);
    if (existing !== undefined) return existing;
    const i = this.names.length;
    if (i >= this.ema.length) {
      const e = new Float32Array(this.ema.length * 2); e.set(this.ema); this.ema = e;
      const o = new Float32Array(this.open.length * 2); o.set(this.open); this.open = o;
    }
    this.names.push(name);
    this.index.set(name, i);
    return i;
  }

  begin(id: number): void { this.open[id] = performance.now(); }

  end(id: number): void {
    const ms = performance.now() - this.open[id];
    this.ema[id] += (ms - this.ema[id]) * 0.08;
  }

  /** Direct EMA push, for callers that already measured. */
  push(id: number, ms: number): void { this.ema[id] += (ms - this.ema[id]) * 0.08; }

  get(id: number): number { return this.ema[id]; }

  /** Allocates — diagnostics only, never call per frame from the hot path. */
  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let i = 0; i < this.names.length; i++) out[this.names[i]] = this.ema[i];
    return out;
  }

  /** Sum of all scopes — the accounted portion of CPU time. */
  total(): number {
    let s = 0;
    for (let i = 0; i < this.names.length; i++) s += this.ema[i];
    return s;
  }

  reset(): void { this.ema.fill(0); }
}

export class PerfSystem {
  /** Target frame time. 16.67 ms at 60 Hz; raised on refresh-rate detection below 60. */
  targetMs = 1000 / 60;
  /**
   * Dead zone around the target. Inside it the quality controller does nothing at all.
   * Without this, continuous quality oscillates and the player sees a pump — which is
   * worse than being permanently 5% conservative.
   */
  deadZoneMs = 1.6;

  readonly device: DeviceRecord;

  // ---- frame-time ring + histogram (CPU wall time between rAF callbacks) ----
  private frameRing = new Float32Array(RING);
  private frameIdx = 0;
  private frameFilled = 0;
  private frameHist = new Histogram();
  private frameEma = 0;

  // ---- CPU sub-splits (EMA, ms) ----
  private updateEma = 0;
  private renderEma = 0;

  // ---- GPU (EMA, ms). Stays 0 when timer queries are unavailable. ----
  private gpuEma = 0;
  private gpuLast = 0;
  private gpuHist = new Histogram();
  private gpuSamples = 0;

  // ---- renderer counters ----
  readonly counters: RenderCounters = {
    calls: 0, triangles: 0, passes: 0, programs: 0,
    geometries: 0, textures: 0, targetBytes: 0, visible: 0,
  };

  // ---- memory ----
  private heapMB = 0;
  private heapLimitMB = 0;
  /** engine-accounted bytes: render targets + geometry + textures we allocated ourselves */
  private ownedBytes = 0;

  // ---- events ----
  private shaderCompiles = 0;
  private shaderCompileMs = 0;
  private assetLoads = 0;
  private assetLoadMs = 0;
  /** frames whose time exceeded 2x target — the metric players actually feel */
  private hitches = 0;
  private framesSeen = 0;

  private scopes = new ScopeTable();
  private bootStages = new Map<string, number>();

  private bottleneckCache: Bottleneck = 'none';
  private bottleneckAt = -1e9;

  private statsOut: FrameStats = {
    avg: 0, p50: 0, p95: 0, p99: 0, worst: 0, jitter: 0, fps: 0, stability: 1,
  };

  constructor(device?: Partial<DeviceRecord>) {
    this.device = {
      gpu: '', cores: 4, memoryGB: 8, dpr: 1, mobile: false, software: false,
      webgpu: false, gpuTimers: false, heapProbe: false,
      maxTextureSize: 4096, maxAnisotropy: 1,
      ...device,
    };
  }

  // ------------------------------------------------------------------ frame

  /**
   * Called once per rAF with the wall time since the previous callback.
   *
   * The ring keeps raw samples purely so eviction can decrement the histogram; the
   * histogram is what answers quantile queries. Together they are O(1) per frame with
   * no allocation, which is the whole point.
   */
  frame(ms: number): void {
    // Clamp absurd values (tab refocus, breakpoint) so one 4-second stall does not
    // poison p99 for the next 256 frames. Real hitches up to 85ms still register.
    const v = ms > 250 ? 250 : ms;
    if (this.frameFilled === RING) this.frameHist.remove(this.frameRing[this.frameIdx]);
    this.frameRing[this.frameIdx] = v;
    this.frameHist.add(v);
    this.frameIdx = (this.frameIdx + 1) % RING;
    if (this.frameFilled < RING) this.frameFilled++;

    this.frameEma += (v - this.frameEma) * 0.05;
    this.framesSeen++;
    if (v > this.targetMs * 2) this.hitches++;
  }

  /** CPU split, pushed by the loop. */
  cpuSplit(updateMs: number, renderMs: number): void {
    this.updateEma += (updateMs - this.updateEma) * 0.06;
    this.renderEma += (renderMs - this.renderEma) * 0.06;
  }

  /** GPU frame time from a resolved timer query. Only called when timers exist. */
  gpu(ms: number): void {
    if (!(ms > 0) || ms > 500) return;
    this.gpuLast = ms;
    this.gpuEma += (ms - this.gpuEma) * 0.05;
    this.gpuHist.add(ms);
    this.gpuSamples++;
    // Bound the GPU histogram's memory of the distant past — it has no ring to evict
    // against, so periodically decay it instead.
    if (this.gpuSamples >= RING * 4) { this.gpuHist.reset(); this.gpuSamples = 0; }
  }

  /** Renderer counters for the frame just submitted. */
  render(c: Partial<RenderCounters>): void {
    const t = this.counters;
    if (c.calls !== undefined) t.calls = c.calls;
    if (c.triangles !== undefined) t.triangles = c.triangles;
    if (c.passes !== undefined) t.passes = c.passes;
    if (c.programs !== undefined) t.programs = c.programs;
    if (c.geometries !== undefined) t.geometries = c.geometries;
    if (c.textures !== undefined) t.textures = c.textures;
    if (c.targetBytes !== undefined) t.targetBytes = c.targetBytes;
    if (c.visible !== undefined) t.visible = c.visible;
  }

  /** Sample the JS heap when the browser exposes it. Cheap, but not free — call at ~1Hz. */
  sampleMemory(): void {
    const pm = (performance as unknown as {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    if (!pm) return;
    this.heapMB = pm.usedJSHeapSize / 1048576;
    this.heapLimitMB = pm.jsHeapSizeLimit / 1048576;
  }

  /** Engine-owned GPU bytes (render targets, merged geometry, procedural textures). */
  setOwnedBytes(bytes: number): void { this.ownedBytes = bytes; }

  noteShaderCompile(ms: number): void { this.shaderCompiles++; this.shaderCompileMs += ms; }
  noteAssetLoad(ms: number): void { this.assetLoads++; this.assetLoadMs += ms; }
  noteBootStage(name: string, ms: number): void { this.bootStages.set(name, ms); }

  // ------------------------------------------------------------------ scopes

  scopeId(name: string): number { return this.scopes.id(name); }
  begin(id: number): void { this.scopes.begin(id); }
  end(id: number): void { this.scopes.end(id); }
  pushScope(id: number, ms: number): void { this.scopes.push(id, ms); }
  scope(id: number): number { return this.scopes.get(id); }

  // ------------------------------------------------------------------ readout

  /**
   * Distribution summary. Writes into a preallocated object — the returned reference is
   * reused, so callers must not retain it across frames.
   */
  stats(): FrameStats {
    const o = this.statsOut;
    if (this.frameFilled === 0) {
      o.avg = o.p50 = o.p95 = o.p99 = o.worst = o.jitter = o.fps = 0;
      o.stability = 1;
      return o;
    }
    const p50 = this.frameHist.quantile(0.5);
    // Mean absolute deviation from the median. Deliberately not variance: variance is
    // dominated by the single worst frame, whereas perceived stutter tracks how *often*
    // frames miss, which MAD reflects.
    let mad = 0;
    const n = this.frameFilled;
    for (let i = 0; i < n; i++) mad += Math.abs(this.frameRing[i] - p50);
    mad /= n;

    o.avg = this.frameEma;
    o.p50 = p50;
    o.p95 = this.frameHist.quantile(0.95);
    o.p99 = this.frameHist.quantile(0.99);
    o.worst = this.frameHist.max;
    o.jitter = mad;
    o.fps = 1000 / Math.max(this.frameEma, 0.05);
    o.stability = 1 / (1 + mad / Math.max(p50, 1) * 4);
    return o;
  }

  get cpuMs(): number { return this.updateEma + this.renderEma; }
  get updateMs(): number { return this.updateEma; }
  get renderMs(): number { return this.renderEma; }
  get frameMs(): number { return this.frameEma; }
  /** 0 when GPU timers are unavailable. Callers must treat 0 as "unknown", not "fast". */
  get gpuMs(): number { return this.gpuEma; }
  get gpuMsLast(): number { return this.gpuLast; }
  get gpuKnown(): boolean { return this.device.gpuTimers && this.gpuEma > 0; }
  get heapUsedMB(): number { return this.heapMB; }
  get heapLimitMB2(): number { return this.heapLimitMB; }
  get ownedMB(): number { return this.ownedBytes / 1048576; }
  get hitchRate(): number { return this.framesSeen ? this.hitches / this.framesSeen : 0; }
  get accountedCpuMs(): number { return this.scopes.total(); }

  /**
   * Memory pressure in 0..1. Blends the Chromium heap ratio (when available) with our own
   * exact byte accounting against a device-derived budget. On mobile the second term is
   * the one that matters, because GPU memory — not the JS heap — is what gets the tab
   * killed, and no browser exposes it.
   */
  get memoryPressure(): number {
    let p = 0;
    if (this.heapLimitMB > 0) p = Math.max(p, this.heapMB / this.heapLimitMB);
    const budgetMB = this.device.mobile
      ? Math.min(320, this.device.memoryGB * 48)
      : Math.min(1400, this.device.memoryGB * 110);
    p = Math.max(p, this.ownedMB / budgetMB);
    return p > 1 ? 1 : p;
  }

  /**
   * Which resource is binding, or 'none' inside the dead zone.
   *
   * Ordering is deliberate. `memory` outranks everything because running out is fatal
   * rather than slow. `unstable` outranks cpu/gpu because a 60 fps average with a 40 ms
   * p99 feels worse than a smooth 50 fps, and the correct response is different (reduce
   * *spikes* — streaming, merges, repaths — not steady-state cost).
   *
   * Recomputed at most every 250 ms and cached: classification is stateful, and letting
   * it flip per frame would defeat the hysteresis it exists to provide.
   */
  bottleneck(now: number): Bottleneck {
    if (now - this.bottleneckAt < 250) return this.bottleneckCache;
    this.bottleneckAt = now;

    if (this.memoryPressure > 0.88) { this.bottleneckCache = 'memory'; return 'memory'; }

    const s = this.stats();
    const over = s.p95 - this.targetMs;

    // High p99 with an acceptable p50 is a pacing problem, not a throughput problem.
    if (s.p50 < this.targetMs + this.deadZoneMs && s.p99 > this.targetMs * 2.2 && this.hitchRate > 0.02) {
      this.bottleneckCache = 'unstable';
      return 'unstable';
    }
    if (over < this.deadZoneMs) { this.bottleneckCache = 'none'; return 'none'; }

    if (this.gpuKnown) {
      // GPU timing available: attribute directly. The CPU figure is the work we can see;
      // if GPU exceeds it, the CPU is waiting at swap.
      this.bottleneckCache = this.gpuEma > this.cpuMs * 1.15 ? 'gpu' : 'cpu';
      return this.bottleneckCache;
    }
    // No GPU timers (Safari, various mobile drivers). Infer: if our own measured CPU work
    // accounts for most of the frame, believe it; otherwise the missing time is GPU wait.
    // Biased toward 'gpu' because that is the reversible mistake — GPU knobs (resolution,
    // sample counts) are cheap to walk back, whereas dropping AI cadence is felt.
    const accounted = this.cpuMs / Math.max(this.frameEma, 0.05);
    this.bottleneckCache = accounted > 0.82 ? 'cpu' : 'gpu';
    return this.bottleneckCache;
  }

  /**
   * Signed headroom in 0..1 relative to the target, using p95 rather than the mean.
   * Positive = we can afford more, negative = we must shed work. p95 is the right basis
   * because quality decided on the mean guarantees the 95th percentile misses.
   */
  headroom(): number {
    const s = this.stats();
    if (s.p95 <= 0) return 0;
    return (this.targetMs - s.p95) / this.targetMs;
  }

  /** Adopt the display's actual refresh rate so a 50Hz panel is not treated as failing. */
  observeRefresh(intervalMs: number): void {
    if (intervalMs < 6 || intervalMs > 40) return;
    // Snap to the nearest common refresh rate; raw rAF deltas are noisy.
    const hz = 1000 / intervalMs;
    const known = [30, 48, 50, 60, 72, 75, 90, 120, 144, 165, 240];
    let best = 60, bestD = 1e9;
    for (const k of known) { const d = Math.abs(k - hz); if (d < bestD) { bestD = d; best = k; } }
    // Never target above 60: STATIC is GPU-heavy and chasing 144Hz would spend the whole
    // quality budget on frame rate the horror pacing does not benefit from.
    this.targetMs = 1000 / Math.min(best, 60);
  }

  resetWindow(): void {
    this.frameHist.reset();
    this.gpuHist.reset();
    this.frameRing.fill(0);
    this.frameIdx = 0;
    this.frameFilled = 0;
    this.gpuSamples = 0;
    this.hitches = 0;
    this.framesSeen = 0;
    this.shaderCompiles = 0;
    this.shaderCompileMs = 0;
    this.assetLoads = 0;
    this.assetLoadMs = 0;
    this.scopes.reset();
  }

  /** Diagnostics blob. Allocates; for `window.__static` and the perf overlay only. */
  report(): Record<string, unknown> {
    const s = this.stats();
    return {
      frame: {
        avg: +s.avg.toFixed(2), p50: +s.p50.toFixed(2), p95: +s.p95.toFixed(2),
        p99: +s.p99.toFixed(2), worst: +s.worst.toFixed(2), jitter: +s.jitter.toFixed(2),
        fps: +s.fps.toFixed(1), stability: +s.stability.toFixed(3),
      },
      cpu: {
        total: +this.cpuMs.toFixed(2),
        update: +this.updateEma.toFixed(2),
        render: +this.renderEma.toFixed(2),
        accounted: +this.accountedCpuMs.toFixed(2),
      },
      gpu: { ms: +this.gpuEma.toFixed(2), known: this.gpuKnown },
      counters: { ...this.counters },
      memory: {
        heapMB: +this.heapMB.toFixed(1),
        heapLimitMB: +this.heapLimitMB.toFixed(0),
        ownedMB: +this.ownedMB.toFixed(1),
        pressure: +this.memoryPressure.toFixed(3),
      },
      events: {
        shaderCompiles: this.shaderCompiles,
        shaderCompileMs: +this.shaderCompileMs.toFixed(1),
        assetLoads: this.assetLoads,
        assetLoadMs: +this.assetLoadMs.toFixed(1),
        hitchRate: +this.hitchRate.toFixed(4),
      },
      scopes: this.scopes.snapshot(),
      boot: Object.fromEntries(this.bootStages),
      bottleneck: this.bottleneck(performance.now()),
      headroom: +this.headroom().toFixed(3),
      targetMs: +this.targetMs.toFixed(2),
      device: { ...this.device },
    };
  }
}

/**
 * Probe device capability once. Deliberately capability-based, never UA-based — see
 * DECISIONS.md. Creates and immediately discards a throwaway WebGL2 context, so this must
 * be called before the real renderer exists (contexts are a limited resource).
 */
export function probeDevice(): DeviceRecord {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const mobile = ('ontouchstart' in window) && matchMedia('(pointer: coarse)').matches;
  const memoryGB = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  const webgpu = typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined';

  let gpu = '';
  let gpuTimers = false;
  let maxTextureSize = 4096;
  let maxAnisotropy = 1;
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL));
      gpuTimers = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) maxAnisotropy = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* headless / blocked context — defaults stand */ }

  const software = /swiftshader|llvmpipe|softwarerasterizer|basic render|mesa offscreen/i.test(gpu);
  const heapProbe = typeof (performance as unknown as { memory?: unknown }).memory !== 'undefined';

  return {
    gpu, cores, memoryGB, dpr, mobile, software, webgpu,
    gpuTimers, heapProbe, maxTextureSize, maxAnisotropy,
  };
}
