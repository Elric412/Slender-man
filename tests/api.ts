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
  flashlight(on: boolean): void;
  collectAll(): void;
  positions(): {
    spawn: { x: number; z: number };
    exit: { x: number; z: number };
    zones: { id: string; x: number; z: number }[];
  };
  // Palebark
  palebark(): Record<string, unknown>;
  forceExtension(): void;
  // Proximity tell
  tell(): TellSnapshot;
  setTell(m: 'off' | 'subtle' | 'explicit'): void;
}

declare global {
  interface Window { __static: StaticApi }
}
