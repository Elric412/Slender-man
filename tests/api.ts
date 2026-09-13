/**
 * Shared shape of the in-page debug API (`window.__static`, see
 * `StaticGame.debugApi` in src/main.ts).
 *
 * This lives in one place because `declare global` is additive-but-not-mergeable
 * for a property: two spec files each declaring `Window.__static` with their own
 * local interface is a TS2717 conflict, even when the two interfaces are
 * structurally identical. Every spec imports this instead.
 */

export interface TellSnapshot {
  mode: 'off' | 'subtle' | 'explicit';
  intensity: number;
  bearing: number;
  active: boolean;
  band: 'none' | 'near' | 'close' | 'imminent';
  boost: number;
}

export interface EntityView {
  state: string;
  detection: number;
  x: number; y: number; z: number;
  visibleToPlayer: boolean;
  distToPlayer: number;
  speed: number;
  act: 0 | 1 | 2;
  extensionEligible: boolean;
  extensionRequest: boolean;
}

/** Full audio-engine debug dump (brief §13). */
export interface AudioDebug {
  ctx: string;
  worklet: boolean;
  lowFreq: number;
  act: string;
  tension: number;
  silence: number;
  silenceSeconds: number;
  layers: string[];
  sub: number;
  cluster: number;
  riser: number;
  spends: Record<string, number>;
  peakTension: number;
  voices: number;
  poolSize: number;
  dropped: number;
  duck: number;
  master: { peak: number; rms: number; lufs: number };
  buses: Record<string, { peak: number; rms: number; lufs: number }>;
  ambience: { levels: Record<string, number>; events: Record<string, number> };
  entity: { approach: number; interference: number; presence: number; fired: Record<string, number> };
  heart: number;
  triggers: number;
  cues: string[];
}

export interface StaticApi {
  state(): string;
  tapes(): number;
  stats(): { avg: number; p95: number; worst: number; fps: number };
  gpuStats(): { calls: number; triangles: number; passes: number } | null;
  prof(): Record<string, number>;
  warp(x: number, z: number): void;
  look(yaw: number, pitch: number): void;
  player(): { x: number; y: number; z: number; yaw: number };
  start(): void;
  forceFear(v: number): void;
  forceDetection(v: number): void;
  entity(): EntityView | null;
  visualCapture(name: import('../src/debug/VisualCapture').VisualScene, on?: boolean): Promise<import('../src/debug/VisualCapture').VisualCaptureResult>;
  flashlight(on: boolean): void;
  collectAll(): void;
  positions(): {
    spawn: { x: number; z: number };
    exit: { x: number; z: number };
    zones: { id: string; x: number; z: number }[];
  };
  // ---- audio (brief §13) ----
  audio(): AudioDebug;
  audioMeter(bus?: 'ambience' | 'entity' | 'foley' | 'ui'): { peak: number; rms: number; lufs: number };
  audioDirector(): {
    act: string; tension: number; silence: number; silenceSeconds: number;
    layers: string[]; sub: number; cluster: number; riser: number;
    spends: Record<string, number>; reason: string;
  };
  audioTriggers(): { t: number; event: string; bus: string }[];
  audioCues(): { text: string; kind: string }[];
  audioFire(what: 'sighting' | 'capture' | 'cue' | 'tape' | 'ui' | 'step' | 'extension'): void;
  audioForce(o: { tapes?: number; runTime?: number }): void;
  // Palebark
  palebark(): Record<string, unknown>;
  forceExtension(): void;
  // Proximity tell
  tell(): TellSnapshot;
  setTell(m: 'off' | 'subtle' | 'explicit'): void;
  /**
   * Render every Nth frame while simulation continues at full rate. On a
   * 2-core headless runner SwiftShader saturates both cores and starves
   * Chromium's audio render thread until its output stream wedges and the page
   * is killed. Tests that assert on state rather than pixels can throttle.
   */
  renderThrottle(n: number): void;
  /** Tear down the audio graph so browser teardown is not wedged by ALSA. */
  audioShutdown(): Promise<void>;
}

declare global {
  interface Window { __static: StaticApi }
}
