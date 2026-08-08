import type { TellMode } from '../world/ProximityTell';

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

/**
 * Audio settings are deliberately split per-bus rather than hidden behind one
 * master fader. STATIC's audio design leans on genuinely uncomfortable
 * techniques (low-frequency dread drone, granular approach textures, sudden
 * cut-to-silence), and a player who is bothered by exactly one of those layers
 * must be able to turn *that* layer down without losing the rest of the game.
 * See `src/audio/README-AUDIO.md` §safety.
 */
export interface AudioSettings {
  /** post-bus master trim, 0..1 */
  master: number;
  /** environmental bed (wind / insects / water / creaks / rain) */
  ambience: number;
  /** Palebark: approach texture, interference, stings, sub-bass dread */
  entity: number;
  /** player body: breath, heartbeat, footsteps, cloth, gear */
  foley: number;
  /** menus, tape handling, viewfinder */
  ui: number;
  /**
   * Independent scale on *low-frequency-intensity* content (the ~20-45Hz dread
   * layer). 0 disables it entirely. This is NOT the same as turning the entity
   * bus down: the mid/high tension layers stay fully intact.
   */
  lowFreq: number;
  /**
   * Loudness-normalised comfort profile for night listening / phone speakers.
   * Narrows dynamic range and lifts the quiet floor. Off by default — the
   * default experience keeps its full quiet-to-shock contrast.
   */
  nightMode: boolean;
  /** visual captions for hearing-dependent tension cues (deaf/HoH support) */
  audioCues: boolean;
}

export interface Settings {
  quality: 'auto' | QualityTier;
  volume: number;        // 0..1 — legacy master; mirrors audio.master
  audio: AudioSettings;
  sensitivity: number;   // multiplier
  invertY: boolean;
  subtitles: boolean;
  colorblind: boolean;
  gyro: boolean;
  fov: number;
  /**
   * Optional "the entity is nearby" signalling. Defaults to `off` because the
   * ambiguity is the game; the other two positions exist for players for whom
   * that ambiguity reads as unfairness, or who cannot rely on the audio tells.
   * See `src/game/ProximityTell.ts`.
   */
  proximityTell: TellMode;
  /** set once the player has acknowledged the content advisory */
  advisoryAck: boolean;
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

const KEY = 'static.settings.v2';
const LEGACY_KEY = 'static.settings.v1';

export function loadSettings(): Settings {
  const def = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Settings>;
      // audio is a nested object — a shallow spread would drop new keys when
      // migrating a v1 blob or a partially-written v2 blob.
      const merged: Settings = { ...def, ...parsed, audio: { ...def.audio, ...(parsed.audio ?? {}) } };
      // v1 only had a single `volume`; carry it into the master trim.
      if (!parsed.audio && typeof parsed.volume === 'number') merged.audio.master = parsed.volume;
      merged.volume = merged.audio.master;
      // The spread will happily install a garbage string here from a hand-edited
      // or downgraded blob, and an unrecognised mode would silently behave as
      // `off` in some call sites and truthy-on in others. Pin it to the enum.
      if (merged.proximityTell !== 'subtle' && merged.proximityTell !== 'explicit') {
        merged.proximityTell = 'off';
      }
      return merged;
    }
  } catch { /* ignore */ }
  return def;
}

export function saveSettings(s: Settings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export function defaultAudioSettings(): AudioSettings {
  return {
    master: 0.8,
    ambience: 1.0,
    entity: 1.0,
    foley: 1.0,
    ui: 0.9,
    // Default sub-bass intensity is deliberately conservative. §11 of the audio
    // brief: the documented infrasound discomfort effect is real, so the shipped
    // default sits well under it and the player can zero it out.
    lowFreq: 0.55,
    nightMode: false,
    audioCues: false,
  };
}

export function defaultSettings(): Settings {
  return {
    quality: 'auto', volume: 0.8, audio: defaultAudioSettings(),
    sensitivity: 1.0, invertY: false,
    subtitles: true, colorblind: false, gyro: false, fov: 75,
    proximityTell: 'off',
    advisoryAck: false,
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
