/**
 * ============================================================================
 * GpuCaps — one capability probe, read by everything
 * ============================================================================
 *
 * ### Why this exists
 *
 * Before this file, capability knowledge was scattered: `Config.probeQuality()`
 * created a throwaway WebGL2 context to read a renderer string, `RenderPipeline`
 * separately probed `EXT_disjoint_timer_query_webgl2`, and `main.ts` asked
 * `renderer.capabilities.getMaxAnisotropy()`. Three probes, three opinions, and
 * no single place to answer "can this device do MRT".
 *
 * Everything downstream now reads *this*. That matters for a specific class of
 * bug: a feature guarded by a probe in one file and a UA test in another will
 * eventually disagree with itself on some device nobody owns.
 *
 * ### On WebGPU
 *
 * We detect it and report it. We do **not** silently switch renderers.
 * See `docs/design/engine-architecture-2026.md` §N1 for the full argument, but
 * in short: this game's look lives in ~1,500 lines of hand-written GLSL3 post
 * passes and a dozen `onBeforeCompile` patches against three's WebGL standard
 * material. Porting that to TSL/WGSL is a rewrite of the entire visual
 * identity, and the failure mode is "it looks different and nobody can say
 * why". The seam is here, honestly labelled, so a future pass can take it.
 *
 * What we *do* claim are the WebGL2 features the engine had not yet used:
 * MRT, float colour attachments, parallel shader compile, timer queries.
 */

export type GpuVendor = 'apple' | 'nvidia' | 'amd' | 'intel' | 'adreno' | 'mali' | 'powervr' | 'software' | 'unknown';

/** Coarse performance class, used to seed the governor's starting quality. */
export type DeviceClass = 'software' | 'weak-mobile' | 'mobile' | 'strong-mobile' | 'laptop' | 'desktop' | 'workstation';

export interface GpuCapsReport {
  // ---- backend ----
  /** WebGPU adapter was obtainable. Reported, not used as a renderer switch. */
  webgpu: boolean;
  webgl2: boolean;

  // ---- WebGL2 feature detail ----
  /** simultaneous colour attachments — MRT G-buffer needs >= 3 */
  maxColorAttachments: number;
  /** renderable float colour attachments (EXT_color_buffer_float) */
  floatRenderTargets: boolean;
  /** linear filtering of half-float targets (needed by the froxel volume) */
  halfFloatLinear: boolean;
  /** KHR_parallel_shader_compile — overlapping program links */
  parallelShaderCompile: boolean;
  /** EXT_disjoint_timer_query_webgl2 — diagnostics only, never a control input */
  timerQuery: boolean;
  maxTextureSize: number;
  max3DTextureSize: number;
  maxAnisotropy: number;
  maxVertexTextures: number;

  // ---- device identity ----
  vendor: GpuVendor;
  renderer: string;
  deviceClass: DeviceClass;
  /** true for SwiftShader / llvmpipe / ANGLE-on-CPU */
  software: boolean;
  mobile: boolean;
  cores: number;
  /** GB, from navigator.deviceMemory where offered, else a conservative guess */
  memoryGb: number;
  devicePixelRatio: number;

  // ---- derived budgets ----
  /**
   * Bytes the frame graph may hold in render targets.
   *
   * Mobile Safari kills a tab that oversubscribes GPU memory and gives no
   * recoverable signal first — no context-lost event, no allocation failure,
   * just a dead page. A budget is the only defence, so it is derived here
   * rather than left to each allocation site to guess.
   */
  renderTargetBudgetBytes: number;
  /** suggested starting quality scalar for PerfGovernor, 0..1 */
  suggestedQuality: number;
  /** hard cap on device pixel ratio */
  dprCap: number;
  /** worker support (module workers) */
  workers: boolean;
}

let cached: GpuCapsReport | null = null;

function detectVendor(renderer: string): GpuVendor {
  const r = renderer.toLowerCase();
  if (/swiftshader|llvmpipe|softwarerasterizer|basic render|software/.test(r)) return 'software';
  if (/apple/.test(r)) return 'apple';
  if (/nvidia|geforce|quadro|rtx|gtx/.test(r)) return 'nvidia';
  if (/amd|radeon|rx \d|vega/.test(r)) return 'amd';
  if (/adreno/.test(r)) return 'adreno';
  if (/mali/.test(r)) return 'mali';
  if (/powervr|apple gpu/.test(r)) return 'powervr';
  if (/intel/.test(r)) return 'intel';
  return 'unknown';
}

/**
 * Device class from vendor + renderer string + core count + memory.
 *
 * Heuristic, and deliberately pessimistic at the boundaries: the cost of
 * starting one class too low is a few seconds of slightly soft image before the
 * governor climbs. The cost of starting one class too high is a stuttering
 * first impression, which is the impression that sticks.
 */
function classify(vendor: GpuVendor, renderer: string, mobile: boolean, cores: number, memGb: number): DeviceClass {
  if (vendor === 'software') return 'software';
  const r = renderer.toLowerCase();

  if (mobile) {
    // Apple silicon phones/tablets genuinely outrun the Android median by a
    // wide margin, and they under-report through the UA, so the GPU string is
    // the honest signal.
    if (vendor === 'apple' && cores >= 6) return 'strong-mobile';
    if (/adreno\s*(7|8)\d\d/.test(r)) return 'strong-mobile';
    if (/adreno\s*6\d\d|mali-g(7|8)\d/.test(r) && memGb >= 6) return 'mobile';
    if (memGb >= 8 && cores >= 8) return 'mobile';
    return 'weak-mobile';
  }

  // Integrated desktop/laptop graphics: capable of the look, not of the
  // resolution. Named separately from 'laptop' because the governor wants to
  // pull *pixels* on these and *effects* on weak mobile.
  if (/(uhd|hd) graphics|iris(?! xe)/.test(r)) return 'laptop';
  if (vendor === 'nvidia' && /rtx\s*(30|40|50)\d\d/.test(r) && cores >= 12) return 'workstation';
  if (vendor === 'apple' && cores >= 10) return 'workstation';
  if (cores >= 8 && memGb >= 16) return 'desktop';
  if (cores >= 4) return 'laptop';
  return 'laptop';
}

const QUALITY_BY_CLASS: Record<DeviceClass, number> = {
  software: 0.0,
  'weak-mobile': 0.12,
  mobile: 0.32,
  'strong-mobile': 0.5,
  laptop: 0.52,
  desktop: 0.78,
  workstation: 0.95,
};

/** MB of render-target budget by class. Deliberately well under any real cap. */
const RT_BUDGET_MB: Record<DeviceClass, number> = {
  software: 48,
  'weak-mobile': 64,
  mobile: 110,
  'strong-mobile': 170,
  laptop: 220,
  desktop: 380,
  workstation: 620,
};

/**
 * Probe once, cache forever.
 *
 * Uses a *throwaway* context and drops it via `WEBGL_lose_context`, exactly as
 * `Config.probeRenderer()` did — the real renderer must not be created before
 * the game decides how to create it.
 */
export function gpuCaps(): GpuCapsReport {
  if (cached) return cached;

  const nav = navigator as unknown as {
    deviceMemory?: number; gpu?: unknown; hardwareConcurrency?: number;
  };
  const cores = Math.max(1, nav.hardwareConcurrency ?? 4);
  const memoryGb = nav.deviceMemory ?? 8;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const mobile = ('ontouchstart' in window) && matchMedia('(pointer: coarse)').matches;

  let renderer = '';
  let maxColorAttachments = 1;
  let floatRenderTargets = false;
  let halfFloatLinear = false;
  let parallelShaderCompile = false;
  let timerQuery = false;
  let maxTextureSize = 2048;
  let max3DTextureSize = 256;
  let maxAnisotropy = 1;
  let maxVertexTextures = 0;
  let webgl2 = false;

  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2', { failIfMajorPerformanceCaveat: false }) as WebGL2RenderingContext | null;
    if (gl) {
      webgl2 = true;
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
      maxColorAttachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) as number;
      maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      max3DTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
      maxVertexTextures = gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) as number;
      floatRenderTargets = !!gl.getExtension('EXT_color_buffer_float');
      // `EXT_float_blend` is the honest signal for *blending* into float
      // targets; linear *filtering* of half-float is core in WebGL2, but some
      // mobile drivers are slow enough at it that we treat the extension's
      // presence as a proxy for "this path is a good idea here".
      halfFloatLinear = floatRenderTargets;
      parallelShaderCompile = !!gl.getExtension('KHR_parallel_shader_compile');
      timerQuery = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      maxAnisotropy = aniso ? (gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) : 1;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* every field already has a conservative default */ }

  const vendor = detectVendor(renderer);
  const software = vendor === 'software';
  const deviceClass = classify(vendor, renderer, mobile, cores, memoryGb);

  let workers = false;
  try { workers = typeof Worker === 'function'; } catch { workers = false; }

  cached = {
    webgpu: !!nav.gpu,
    webgl2,
    maxColorAttachments,
    floatRenderTargets,
    halfFloatLinear,
    parallelShaderCompile,
    timerQuery,
    maxTextureSize,
    max3DTextureSize,
    maxAnisotropy,
    maxVertexTextures,
    vendor,
    renderer,
    deviceClass,
    software,
    mobile,
    cores,
    memoryGb,
    devicePixelRatio: dpr,
    renderTargetBudgetBytes: RT_BUDGET_MB[deviceClass] * 1024 * 1024,
    suggestedQuality: QUALITY_BY_CLASS[deviceClass],
    // A software rasteriser is fill-rate-bound above all else, and a phone at
    // dpr 3 is asking for 9x the pixels of dpr 1 for a difference nobody can
    // see through this much grain and vignette.
    dprCap: software ? 1 : mobile ? 2 : 2,
    workers,
  };
  return cached;
}

/** Test seam: force a report (used by the harness to exercise low paths). */
export function overrideGpuCaps(partial: Partial<GpuCapsReport>): void {
  cached = { ...gpuCaps(), ...partial };
}

/** MRT G-buffer is only worth attempting with 3 attachments and float targets. */
export function supportsGBuffer(c: GpuCapsReport = gpuCaps()): boolean {
  return c.webgl2 && c.maxColorAttachments >= 3 && c.floatRenderTargets;
}
