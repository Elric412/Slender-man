export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface Settings {
  quality: 'auto' | QualityTier;
  volume: number;        // 0..1
  sensitivity: number;   // multiplier
  invertY: boolean;
  subtitles: boolean;
  colorblind: boolean;
  gyro: boolean;
  fov: number;
}

export interface QualitySpec {
  tier: QualityTier;
  shadowMapSize: number;
  drawDistance: number;   // meters for vegetation
  particleCount: number;
  renderScale: number;    // initial dynamic-res scale
  taa: boolean;
  ao: boolean;
  bloom: boolean;
  fogWisps: number;

  // ---- render-graph feature switches (see RenderPipeline) ----
  /** 0 = off, 1 = quarter-res / 10 steps, 2 = half-res / 20 steps + shadowed */
  volumetric: 0 | 1 | 2;
  /** 0 = off, 1 = 3 dirs x 3 steps, 2 = 4 dirs x 4 steps (both half-res + temporal) */
  aoQuality: 0 | 1 | 2;
  /** cheap camcorder depth-of-field reusing the veil-blur chain */
  dof: boolean;
  /** capture a PMREM sky probe for image-based ambient/specular */
  envProbe: boolean;
  /** rotational motion blur */
  motionBlur: boolean;
  /** contrast-adaptive sharpening amount applied after upscale */
  sharpen: number;
  /** flashlight dust mote budget */
  dustCount: number;
  /** texture anisotropy cap */
  anisotropy: number;
  /** procedural texture resolution for the material library */
  textureSize: 256 | 512 | 1024;
}

export const QUALITY_SPECS: Record<QualityTier, QualitySpec> = {
  low: {
    tier: 'low', shadowMapSize: 1024, drawDistance: 120, particleCount: 200,
    renderScale: 0.7, taa: false, ao: false, bloom: true, fogWisps: 6,
    volumetric: 1, aoQuality: 0, dof: false, envProbe: false, motionBlur: false,
    sharpen: 0.5, dustCount: 90, anisotropy: 2, textureSize: 256,
  },
  medium: {
    tier: 'medium', shadowMapSize: 2048, drawDistance: 170, particleCount: 400,
    renderScale: 0.85, taa: true, ao: true, bloom: true, fogWisps: 12,
    volumetric: 1, aoQuality: 1, dof: true, envProbe: true, motionBlur: true,
    sharpen: 0.4, dustCount: 160, anisotropy: 4, textureSize: 512,
  },
  high: {
    tier: 'high', shadowMapSize: 2048, drawDistance: 220, particleCount: 600,
    renderScale: 1.0, taa: true, ao: true, bloom: true, fogWisps: 20,
    volumetric: 2, aoQuality: 2, dof: true, envProbe: true, motionBlur: true,
    sharpen: 0.3, dustCount: 260, anisotropy: 8, textureSize: 512,
  },
  ultra: {
    tier: 'ultra', shadowMapSize: 4096, drawDistance: 260, particleCount: 900,
    renderScale: 1.0, taa: true, ao: true, bloom: true, fogWisps: 30,
    volumetric: 2, aoQuality: 2, dof: true, envProbe: true, motionBlur: true,
    sharpen: 0.25, dustCount: 380, anisotropy: 16, textureSize: 1024,
  },
};

const KEY = 'static.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return defaultSettings();
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function defaultSettings(): Settings {
  return {
    quality: 'auto', volume: 0.8, sensitivity: 1.0, invertY: false,
    subtitles: true, colorblind: false, gyro: false, fov: 75,
  };
}

/** Unmasked GPU string, when the browser is willing to tell us. */
export function probeRenderer(): string {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const s = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return s;
  } catch { return ''; }
}

/**
 * Capability probe. Heuristic, but informed: software rasterisers and known
 * low-power mobile GPUs get pinned down hard, because the render graph will
 * happily ask a Mali-G52 for half-res volumetrics if we let it.
 */
export function probeQuality(): QualityTier {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const isMobile = ('ontouchstart' in window) && matchMedia('(pointer: coarse)').matches;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  const gpu = probeRenderer().toLowerCase();

  // software GL (SwiftShader / llvmpipe / ANGLE-on-CPU) — never above low
  if (/swiftshader|llvmpipe|softwarerasterizer|basic render/.test(gpu)) return 'low';

  if (isMobile) {
    // Apple silicon phones/tablets punch well above the Android median
    if (/apple/.test(gpu) && cores >= 6) return 'high';
    if (/adreno\s*(7|8)\d\d|mali-g(7|8)\d/.test(gpu) && mem >= 6) return 'medium';
    if (mem >= 8 && cores >= 8) return 'medium';
    return 'low';
  }
  if (/intel.*(uhd|hd graphics)/.test(gpu)) return 'medium';
  if (dpr > 2 || mem <= 4) return 'medium';
  if (cores >= 8 && mem >= 16) return 'ultra';
  return 'high';
}
