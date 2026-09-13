import * as THREE from 'three';
import { QUALITY_SPECS, type QualityTier } from '../core/Config';
import type { GameLoop } from '../core/GameLoop';
import { SeededRandom } from '../core/SeededRandom';
import type { Player } from '../game/Player';
import type { Flashlight } from '../game/Flashlight';
import type { HeightField } from '../world/HeightField';
import type { MapGenerator } from '../world/MapGenerator';
import { updateWind } from '../world/VegetationSystem';
import type { RenderPipeline, StaticState } from '../render/RenderPipeline';
import type { NightLighting } from '../render/NightLighting';
import type { ShadowQuality } from '../render/ShadowQuality';
import type { Sky } from '../render/Sky';
import type { PalebarkEntity, EntityFrame } from '../entity/PalebarkEntity';

export const VISUAL_SCENES = ['trail', 'bark', 'wet-rocks', 'cabin', 'forest-depth', 'monster'] as const;
export type VisualScene = typeof VISUAL_SCENES[number];
export const visualCaptureEnabled = (): boolean => new URLSearchParams(location.search).get('visualqa') === '1';

interface CaptureOptions {
  player: Player; flashlight: Flashlight; hf: HeightField; map: MapGenerator;
  pipeline: RenderPipeline; night: NightLighting; shadows: ShadowQuality;
  sky: Sky; rig: PalebarkEntity; loop: GameLoop;
  scene: THREE.Scene; renderer: THREE.WebGLRenderer;
  tier: QualityTier; seed: number;
  /** Snap production progression, zone atmosphere, weather and grade; suppress live event effects. */
  prepareLook(wetness: number, time: number): void;
}

export interface PixelMetrics {
  width: number; height: number; mean: number; deviation: number;
  p05: number; p50: number; p95: number; blackFraction: number;
  clippedFraction: number; centerMean: number; borderMean: number;
}

export interface VisualCaptureResult {
  scene: VisualScene; flashlight: boolean; seed: number; tier: QualityTier;
  time: number; wetness: number; camera: number[]; target: number[];
  streamFrames: number; temporalFrames: number; pending: number;
  pixels: PixelMetrics; png: string;
  render: { calls: number; triangles: number; passes: number };
  timing: { cpuSubmitMeanMs: number; gpuLastMs: number };
  beam: { strength: number; alignment: number; distanceFromEye: number };
}

/**
 * Opt-in, destructive-to-the-current-run QA session. Reload to resume play.
 * Stops RAF completely (GameLoop.paused still renders), leaves authored geometry
 * intact, and advances only explicit fixed-step visual state. Captures are
 * comparable within the same browser/GPU/tier; they are not cross-GPU bit exact.
 */
export class VisualCapture {
  private busy = false;
  constructor(private readonly o: CaptureOptions) {
    if (!visualCaptureEnabled()) throw new Error('Visual capture requires ?visualqa=1');
  }

  async capture(name: VisualScene, flashlightOn = true): Promise<VisualCaptureResult> {
    if (!visualCaptureEnabled()) throw new Error('Visual capture requires ?visualqa=1');
    if (!VISUAL_SCENES.includes(name)) throw new Error(`Unknown capture scene: ${name}`);
    if (this.busy) throw new Error('A visual capture is already running');
    this.busy = true;
    try { return await this.run(name, flashlightOn); }
    finally { this.busy = false; }
  }

  private async run(name: VisualScene, flashlightOn: boolean): Promise<VisualCaptureResult> {
    const o = this.o;
    const { player, flashlight, map, hf, pipeline, renderer, night, sky } = o;
    o.loop.stop();
    o.loop.paused = true;
    const time = 24;
    const wetness = name === 'wet-rocks' ? 0.85 : 0.32;
    const spec = { ...QUALITY_SPECS[o.tier] };
    pipeline.setQuality(spec);
    map.practicals.setShadowQuality(o.tier);
    pipeline.setPerceptibility(1, 1, 1);
    flashlight.setShadowSize(spec.shadowMapSize);
    const shot = this.view(name);
    player.reset(shot.eye.x, shot.eye.z);
    player.sprinting = player.moving = false;
    player.speed2D = player.bobAmount = 0;
    player.camera.position.copy(shot.eye);
    player.camera.lookAt(shot.target);
    player.camera.rotation.order = 'YXZ';
    player.yaw = player.camera.rotation.y;
    player.pitch = player.camera.rotation.x;
    player.camera.fov = 75;
    player.camera.updateProjectionMatrix();
    // The resting arm's pose, without wall-clock breathe, recoil or lag.
    player.resetViewmodelForCapture();
    player.camera.updateMatrixWorld(true);
    map.practicals.resetForCapture();
    for (let i = 0; i < 60; i++) map.updatePracticals(1 / 60, shot.eye, player.camera.quaternion);
    o.prepareLook(wetness, time);
    sky.update(time);
    updateWind({ strength: 0.32, dirX: 0.8, dirZ: 0.2, time });
    map.update(time, 0.32);
    night.setMoonDirection(sky.moonDir);
    night.followPlayer(player.pos.x, player.pos.y, player.pos.z, o.shadows.extent);
    night.moon.shadow.needsUpdate = true;
    renderer.shadowMap.needsUpdate = true;
    map.scatter.setVelocity(0, 0);
    map.veg.setDrawDistance(player.pos.x, player.pos.z, spec.drawDistance);
    let streamFrames = 0;
    do {
      map.scatter.setViewer(player.pos.x, player.pos.z, spec.drawDistance);
      streamFrames++;
      if (streamFrames >= 256 && map.scatter.stats.pending > 0) {
        throw new Error(`Forest streamer did not settle: ${map.scatter.stats.pending} chunks after 256 steps`);
      }
      if (streamFrames % 8 === 0) await yieldTask();
    } while (map.scatter.stats.pending > 0);
    map.debris.setWetness(wetness);
    map.debris.update(player.pos.x, player.pos.z);
    flashlight.resetForCapture();
    if (flashlightOn) flashlight.toggle();
    for (let i = 0; i < 60; i++) {
      flashlight.battery = 1;
      flashlight.update(1 / 60, time);
    }
    pipeline.setBeam(flashlight.light, flashlight.beamStrength, flashlight.originPosition, flashlight.aimDirection);
    pipeline.setMoon(night.moon);
    // Use the real rig, fixed seed, fixed pose, and a fixed LOD distance.
    const enemy = shot.enemy ?? new THREE.Vector3(shot.eye.x + 120, 0, shot.eye.z + 120);
    enemy.y = hf.heightAt(enemy.x, enemy.z);
    const enemyYaw = Math.atan2(shot.eye.x - enemy.x, shot.eye.z - enemy.z);
    o.rig.reset(enemy.x, enemy.y, enemy.z, enemyYaw, enemy.distanceTo(shot.eye));
    const rng = new SeededRandom(o.seed ^ 0xA5F1);
    const entityFrame: EntityFrame = {
      x: enemy.x, y: enemy.y, z: enemy.z, yaw: enemyYaw, speed: 0,
      state: 'dormant', detection: 0, camera: shot.eye, gaze: shot.eye,
      gazeWeight: 0.25, groundAt: (x, z) => hf.heightAt(x, z),
      wind: new THREE.Vector3(0.2, 0, 0.1), wetness,
      tapes: 0, tapesTotal: 8, extensionRequest: false,
      rand: () => rng.next(), streamBudgetMs: 0,
    };
    for (let i = 0; i < 60; i++) o.rig.update(1 / 60, time, entityFrame);
    o.rig.group.visible = name === 'monster';
    o.scene.updateMatrixWorld(true);
    pipeline.invalidateHistory();
    const state: StaticState = { time, level: 0, glimpse: 0, desat: 0, viewfinder: 0, wetness };
    const temporalFrames = 32;
    let submitMs = 0;
    for (let i = 0; i < temporalFrames; i++) {
      const start = performance.now();
      pipeline.render(o.scene, player.camera, state, 1 / 60);
      submitMs += performance.now() - start;
      // No yield after final draw: readPixels/toDataURL must precede browser
      // buffer invalidation when preserveDrawingBuffer is false.
      if (i < temporalFrames - 1 && i % 4 === 3) await yieldTask();
    }
    const gl = renderer.getContext();
    const width = gl.drawingBufferWidth, height = gl.drawingBufferHeight;
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error(`WebGL error during capture: 0x${err.toString(16)}`);
    const png = renderer.domElement.toDataURL('image/png');
    const direction = player.camera.getWorldDirection(new THREE.Vector3());
    return {
      scene: name, flashlight: flashlightOn, seed: o.seed, tier: o.tier,
      time, wetness, camera: shot.eye.toArray(), target: shot.target.toArray(),
      streamFrames, temporalFrames, pending: map.scatter.stats.pending,
      pixels: pixelMetrics(rgba, width, height), png,
      render: { ...pipeline.gpuStats },
      timing: { cpuSubmitMeanMs: submitMs / temporalFrames, gpuLastMs: pipeline.gpuMs },
      beam: { strength: flashlight.beamStrength, alignment: direction.dot(flashlight.aimDirection),
        distanceFromEye: flashlight.originPosition.distanceTo(player.camera.position) },
    };
  }

  private view(name: VisualScene): { eye: THREE.Vector3; target: THREE.Vector3; enemy?: THREE.Vector3 } {
    const { hf, map } = this.o;
    const ground = (x: number, z: number, h: number) => new THREE.Vector3(x, hf.heightAt(x, z) + h, z);
    const spawn = hf.layout.spawn;
    const zone = (id: string) => {
      const found = hf.layout.zones.find(z => z.id === id);
      if (!found) throw new Error(`Missing ${id} visual landmark`);
      return found;
    };
    if (name === 'cabin') {
      const cabin = zone('cabin');
      const lamp = map.practicals.captureAnchor('cabin');
      if (!lamp) throw new Error('Cabin has no authored practical');
      const facing = new THREE.Vector3(lamp.x - cabin.x, 0, lamp.z - cabin.z).normalize();
      return { eye: ground(lamp.x + facing.x * 9, lamp.z + facing.z * 9, 1.65),
        target: ground(cabin.x, cabin.z, 1.7) };
    }
    if (name === 'wet-rocks') {
      const rocks = zone('rocks');
      return { eye: ground(rocks.x + 7, rocks.z + 10, 1.65), target: ground(rocks.x + 2, rocks.z + 3, 0.35) };
    }
    if (name === 'bark') {
      const tree = map.scatter.colliders().filter(t => t.h > 5)
        .sort((a, b) => Math.hypot(a.x - spawn.x, a.z - spawn.z) - Math.hypot(b.x - spawn.x, b.z - spawn.z))[0];
      if (!tree) throw new Error('No mature trunk available for bark capture');
      return { eye: ground(tree.x + tree.r + 2.8, tree.z + 1.8, 1.65), target: ground(tree.x, tree.z, 1.45) };
    }
    if (name === 'forest-depth') {
      const hub = zone('hub');
      let x = hub.x + 32, z = hub.z;
      let best = -1;
      for (let a = 0; a < 16; a++) {
        const cx = hub.x + Math.cos(a * Math.PI / 8) * 32;
        const cz = hub.z + Math.sin(a * Math.PI / 8) * 32;
        const cover = map.scatter.coverAt(cx, cz);
        if (cover > best) { x = cx; z = cz; best = cover; }
      }
      return { eye: ground(x, z, 1.65), target: ground(x + 12, z - 22, 1.3) };
    }
    const eye = ground(spawn.x, spawn.z, 1.65);
    const direction = new THREE.Vector3(-spawn.x, 0, -spawn.z).normalize();
    const target = ground(spawn.x + direction.x * 22, spawn.z + direction.z * 22, 1.3);
    return { eye, target, enemy: name === 'monster'
      ? ground(spawn.x + direction.x * 24 - direction.z * 3, spawn.z + direction.z * 24 + direction.x * 3, 0)
      : undefined };
  }
}

const yieldTask = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

/** Real backbuffer luminance, in 8-bit display values; no encoded-PNG heuristics. */
function pixelMetrics(rgba: Uint8Array, width: number, height: number): PixelMetrics {
  const hist = new Uint32Array(256);
  let sum = 0, squares = 0, black = 0, clipped = 0;
  let center = 0, centerN = 0, border = 0, borderN = 0;
  const n = width * height;
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const l = 0.2126 * rgba[i] + 0.7152 * rgba[i + 1] + 0.0722 * rgba[i + 2];
    hist[Math.round(l)]++;
    sum += l; squares += l * l;
    if (l < 3) black++;
    if (rgba[i] >= 253 && rgba[i + 1] >= 253 && rgba[i + 2] >= 253) clipped++;
    const x = (p % width) / width, y = Math.floor(p / width) / height;
    if (Math.abs(x - 0.5) < 0.15 && Math.abs(y - 0.5) < 0.15) { center += l; centerN++; }
    if (x < 0.15 || x > 0.85 || y < 0.15 || y > 0.85) { border += l; borderN++; }
  }
  const percentile = (fraction: number) => {
    let count = 0;
    for (let i = 0; i < 256; i++) { count += hist[i]; if (count >= n * fraction) return i; }
    return 255;
  };
  const mean = sum / n;
  return { width, height, mean, deviation: Math.sqrt(Math.max(0, squares / n - mean * mean)),
    p05: percentile(0.05), p50: percentile(0.5), p95: percentile(0.95),
    blackFraction: black / n, clippedFraction: clipped / n,
    centerMean: center / Math.max(1, centerN), borderMean: border / Math.max(1, borderN) };
}
