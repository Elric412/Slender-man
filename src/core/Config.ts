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
}

export const QUALITY_SPECS: Record<QualityTier, QualitySpec> = {
  low:    { tier: 'low',    shadowMapSize: 1024, drawDistance: 120, particleCount: 200, renderScale: 0.7, taa: false, ao: false, bloom: true,  fogWisps: 6 },
  medium: { tier: 'medium', shadowMapSize: 2048, drawDistance: 170, particleCount: 400, renderScale: 0.85, taa: true, ao: false, bloom: true,  fogWisps: 12 },
  high:   { tier: 'high',   shadowMapSize: 2048, drawDistance: 220, particleCount: 600, renderScale: 1.0, taa: true, ao: true,  bloom: true,  fogWisps: 20 },
  ultra:  { tier: 'ultra',  shadowMapSize: 4096, drawDistance: 260, particleCount: 900, renderScale: 1.0, taa: true, ao: true,  bloom: true,  fogWisps: 30 },
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

/** Capability probe: quick heuristic tier selection. */
export function probeQuality(): QualityTier {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const isMobile = ('ontouchstart' in window) && matchMedia('(pointer: coarse)').matches;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 4;
  if (isMobile) {
    if (mem >= 8 && cores >= 8) return 'medium';
    return 'low';
  }
  if (dpr > 2 || mem <= 4) return 'medium';
  if (cores >= 8 && mem >= 16) return 'ultra';
  return 'high';
}
