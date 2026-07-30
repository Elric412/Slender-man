import * as THREE from 'three';
import { GameLoop } from './core/GameLoop';
import { Input } from './core/Input';
import { loadSettings, probeQuality, QUALITY_SPECS, QualitySpec, Settings } from './core/Config';
import { SeededRandom } from './core/SeededRandom';
import { HeightField } from './world/HeightField';
import { MaterialLibrary } from './world/MaterialLibrary';
import { MapGenerator } from './world/MapGenerator';
import { updateWind } from './world/VegetationSystem';
import { CollisionWorld } from './physics/Collision';
import { NavWorld } from './ai/NavWorld';
import { EntityBrain, EntitySnapshot } from './ai/EntityBrain';
import { RenderPipeline, StaticState } from './render/RenderPipeline';
import { Sky } from './render/Sky';
import { Player } from './game/Player';
import { Flashlight } from './game/Flashlight';
import { PalebarkRig } from './game/PalebarkRig';
import { FearSystem } from './game/FearSystem';
import { TapeSystem, TAPE_LOGS } from './game/TapeSystem';
import { Effects } from './game/Effects';
import { SynthEngine } from './audio/SynthEngine';
import { Menu } from './ui/Menu';

const WORLD_SEED = 0x57A71C; // fixed world seed — map is consistent & benchmarkable

type GameState = 'loading' | 'title' | 'playing' | 'paused' | 'ending' | 'end';

const frame = (): Promise<void> => new Promise(r => requestAnimationFrame(() => r()));

class StaticGame {
  private canvas: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private pipeline!: RenderPipeline;
  private loop = new GameLoop();
  private menu: Menu;
  private settings: Settings;
  private spec: QualitySpec;
  private input!: Input;
  private audio = new SynthEngine();

  private hf!: HeightField;
  private mats!: MaterialLibrary;
  private col!: CollisionWorld;
  private map!: MapGenerator;
  private nav!: NavWorld;
  private sky!: Sky;
  private moon!: THREE.DirectionalLight;
  private moonTarget = new THREE.Object3D();
  private hemi!: THREE.HemisphereLight;
  private player!: Player;
  private flashlight!: Flashlight;
  private entity!: EntityBrain;
  private rig!: PalebarkRig;
  private fear = new FearSystem();
  private tapes!: TapeSystem;
  private effects!: Effects;

  state: GameState = 'loading';
  private runSeed = WORLD_SEED;
  private runTime = 0;
  private entitySnap: EntitySnapshot | null = null;
  private staticState: StaticState = { level: 0, glimpse: 0, desat: 0.2, time: 0 };
  private windDir = { x: 0.8, z: 0.6 };
  private rainTriggered = false;
  private flinchCooldown = 0;
  private entityCueTimer = 0;
  private subtitleQueue: string[] = [];
  private subtitleTimer = 0;
  private perfVisible = false;
  private endKind: 'escaped' | 'taken' = 'taken';
  private started = false;

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.settings = loadSettings();
    this.menu = new Menu(this.settings);
    const tier = this.settings.quality === 'auto' ? probeQuality() : this.settings.quality;
    this.spec = QUALITY_SPECS[tier];
  }

  // ================================================================ boot
  async boot(): Promise<void> {
    const p = (f: number, s: string) => { this.menu.setLoadProgress(f, s); };

    p(0.02, 'igniting renderer…');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: false, powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // grading happens in composite
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.autoClear = true;
    this.handleResize();
    await frame();

    p(0.08, 'surveying terrain…');
    this.hf = new HeightField(WORLD_SEED);
    await frame();

    p(0.16, 'growing materials…');
    this.mats = new MaterialLibrary(WORLD_SEED);
    await frame();

    p(0.30, 'planting the forest…');
    this.col = new CollisionWorld(this.hf);
    this.map = new MapGenerator(this.hf, this.mats, this.col, WORLD_SEED);
    await frame();

    p(0.48, 'teaching it to walk…');
    this.nav = new NavWorld(this.hf, this.col);
    await frame();

    p(0.56, 'assembling scene…');
    this.buildScene();
    await frame();

    p(0.66, 'waking the entity…');
    this.entity = new EntityBrain(this.nav, this.col, this.hf, WORLD_SEED);
    this.rig = new PalebarkRig(this.mats);
    this.scene.add(this.rig.group);
    this.wireEntity();
    await frame();

    p(0.74, 'charging flashlight…');
    this.player = new Player(this.col, this.hf, this.mats);
    this.player.baseFov = this.settings.fov;
    this.scene.add(this.player.camera);
    this.flashlight = new Flashlight(this.scene, this.player, Math.min(this.spec.shadowMapSize, 1024), this.hf);
    this.wirePlayer();
    this.tapes = new TapeSystem(this.map, this.mats, this.scene, this.runSeed);
    this.effects = new Effects(this.scene, this.hf, this.spec.fogWisps, this.spec.particleCount);
    await frame();

    p(0.82, 'warming shader pipelines…');
    this.pipeline = new RenderPipeline(this.renderer, this.spec);
    this.pipeline.resize(this.renderer.domElement.width, this.renderer.domElement.height);
    await this.warmup();
    await frame();

    p(0.94, 'wiring input…');
    this.input = new Input(this.canvas);
    this.applySettings(this.settings);
    this.input.onFirstGesture = () => { this.audio.init(); this.audio.resume(); };
    this.wireMenu();
    this.wireLifecycle();
    this.loop.onUpdate((dt, t) => this.update(dt, t));
    this.loop.onRender((dt) => this.render(dt));
    this.loop.start();
    await frame();

    p(1.0, 'tape loaded.');
    this.toTitle();
  }

  private buildScene(): void {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x04070c);
    this.scene.fog = new THREE.FogExp2(0x070b12, 0.0155);

    this.sky = new Sky();
    this.scene.add(this.sky.mesh);

    // moonlight — cool, low, soft-shadowed directional
    this.moon = new THREE.DirectionalLight(0x93a8cc, 0.55);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(this.spec.shadowMapSize, this.spec.shadowMapSize);
    const sc = this.moon.shadow.camera;
    sc.near = 20; sc.far = 260;
    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60;
    this.moon.shadow.bias = -0.0015;
    this.moon.shadow.normalBias = 0.05;
    this.moon.target = this.moonTarget;
    this.scene.add(this.moon, this.moonTarget);

    // faint sky/ground bounce so shadows aren't pure black
    this.hemi = new THREE.HemisphereLight(0x141c2a, 0x05060a, 0.32);
    this.scene.add(this.hemi);

    this.scene.add(this.map.group);
  }

  /** compile every shader permutation up-front: flashlight on, rain, entity — no first-encounter hitch */
  private async warmup(): Promise<void> {
    this.player.reset(this.hf.layout.spawn.x, this.hf.layout.spawn.z);
    this.player.update(0.016, {
      moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, sprint: false, crouch: false,
      vaultQueued: false, interactQueued: false, flashQueued: false, vfHeld: false,
      lean: 0, pauseQueued: false,
    }, 0);
    this.flashlight.on = true;
    this.flashlight.update(0.016, 0);
    this.effects.setRain(true);
    this.tapes.spawnAll(this.runSeed);
    await frame();
    this.renderer.compile(this.scene, this.player.camera);
    await frame();
    // one full pipeline render at tiny scale to compile post passes
    this.pipeline.render(this.scene, this.player.camera, this.staticState, 0.016);
    await frame();
    this.effects.setRain(false);
    this.flashlight.on = false;
    this.flashlight.update(0.016, 0);
  }

  // ================================================================ wiring
  private wireMenu(): void {
    this.menu.onStart = () => this.startRun();
    this.menu.onRestart = () => this.startRun();
    this.menu.onResume = () => this.resume();
    this.menu.onQuit = () => this.toTitle();
    this.menu.onSettingsChanged = (s) => this.applySettings(s);
    this.menu.onUiClick = () => { this.audio.init(); this.audio.resume(); this.audio.uiClick(); };
  }

  private wirePlayer(): void {
    this.player.onFootstep = (surface, intensity) => {
      this.audio.footstep(surface, intensity);
      this.entity.hear({ x: this.player.pos.x, z: this.player.pos.z, loudness: intensity * 0.42 });
    };
    this.player.onVault = () => {
      this.audio.footstep(this.player.surfaceHere(), 0.8);
      this.entity.hear({ x: this.player.pos.x, z: this.player.pos.z, loudness: 0.5 });
    };
    this.flashlight.onToggle = (on) => {
      this.audio.flashlightClick(on);
      this.entity.hear({ x: this.player.pos.x, z: this.player.pos.z, loudness: 0.14 });
    };
    this.flashlight.onBatteryLow = () => this.audio.batteryWarning();
  }

  private wireEntity(): void {
    this.entity.onCaptured = () => { if (this.state === 'playing') this.capture(); };
    this.entity.onGlimpse = () => this.fear.triggerGlimpse();
    this.entity.onFootfall = (x, z, dist) => {
      this.audio.entityCue(dist, dist < 20 ? 'footfall' : undefined);
    };
  }

  private wireLifecycle(): void {
    window.addEventListener('resize', () => { this.handleResize(); this.menu.checkOrientation(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'playing') this.pause();
    });
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.loop.paused = true;
      this.menu.setLoadProgress(1, 'GRAPHICS CONTEXT LOST — RECOVERING…');
      this.menu.show('loading');
    });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.pipeline.invalidateHistory();
      this.loop.paused = false;
      this.menu.show(this.state === 'playing' ? 'none' : 'title');
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') { e.preventDefault(); this.perfVisible = !this.perfVisible; if (!this.perfVisible) this.menu.setPerf(null); }
    });
  }

  private applySettings(s: Settings): void {
    if (this.input) {
      this.input.sensitivity = s.sensitivity;
      this.input.invertY = s.invertY;
      this.input.gyroEnabled = s.gyro;
    }
    if (this.player) this.player.baseFov = s.fov;
    this.audio.setVolume(s.volume);
    const tier = s.quality === 'auto' ? probeQuality() : s.quality;
    const spec = QUALITY_SPECS[tier];
    if (this.pipeline && spec.tier !== this.spec.tier) {
      this.spec = spec;
      this.pipeline.setQuality(spec);
      this.moon.shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);
      if (this.moon.shadow.map) { this.moon.shadow.map.dispose(); this.moon.shadow.map = null as unknown as THREE.WebGLRenderTarget; }
      this.flashlight.setShadowSize(Math.min(spec.shadowMapSize, 1024));
      this.handleResize();
    } else {
      this.spec = spec;
    }
  }

  private handleResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const dprCap = this.spec?.tier === 'low' ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
    this.renderer.setSize(w, h, false);
    if (this.pipeline) this.pipeline.resize(this.renderer.domElement.width, this.renderer.domElement.height);
    if (this.player) {
      this.player.camera.aspect = w / h;
      this.player.camera.updateProjectionMatrix();
    }
  }

  // ================================================================ state transitions
  private toTitle(): void {
    this.state = 'title';
    this.loop.paused = true;
    this.menu.showHud(false);
    this.menu.showTouchUI(false);
    this.menu.show('title');
    this.menu.hideCaptureOverlay();
    this.input?.releasePointerLock();
  }

  private startRun(): void {
    this.audio.init();
    this.audio.resume();
    // fresh per-run seed: tape positions & ambient variation differ per run
    this.runSeed = (WORLD_SEED ^ ((Date.now() & 0xffff) * 2654435761)) >>> 0;
    this.runTime = 0;
    this.rainTriggered = false;
    this.subtitleQueue.length = 0;
    this.subtitleTimer = 0;
    this.fear.reset();
    this.player.reset(this.hf.layout.spawn.x, this.hf.layout.spawn.z);
    this.flashlight.battery = 1;
    if (this.flashlight.on) this.flashlight.toggle();
    this.entity.respawnFar(this.player.pos);
    this.tapes.spawnAll(this.runSeed);
    this.tapes.onPickup = (zoneId, x, z) => this.onTapePickup(zoneId, x, z);
    this.pipeline.invalidateHistory();
    this.state = 'playing';
    this.loop.paused = false;
    this.menu.show('none');
    this.menu.showHud(true);
    this.menu.showTouchUI(this.input.isTouch);
    this.menu.hideCaptureOverlay();
    this.menu.flashTapeCounter(0);
    this.input.requestPointerLock();
    this.menu.checkOrientation();
    if (this.settings.subtitles) {
      this.queueSubtitles([
        'Pinebridge Station perimeter — 02:14 AM.',
        'Find the eight recorders. Reach the fire road east.',
      ]);
    }
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.loop.paused = true;
    this.menu.show('pause');
    this.input.releasePointerLock();
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.loop.paused = false;
    this.menu.show('none');
    this.input.requestPointerLock();
  }

  private async capture(): Promise<void> {
    this.state = 'ending';
    this.endKind = 'taken';
    this.audio.captureSting();
    if (navigator.vibrate && this.input.isTouch) navigator.vibrate(120);
    this.input.releasePointerLock();
    await this.menu.playCaptureTransition();
    this.finishRun();
  }

  private escape(): void {
    if (this.state !== 'playing') return;
    this.state = 'ending';
    this.endKind = 'escaped';
    this.input.releasePointerLock();
    this.finishRun();
  }

  private finishRun(): void {
    this.state = 'end';
    this.loop.paused = true;
    this.menu.showHud(false);
    this.menu.showTouchUI(false);
    this.menu.setViewfinder(false);
    this.menu.setSubtitle(null);
    this.menu.showEnd(this.endKind, this.tapes.collected, this.runTime);
  }

  private onTapePickup(zoneId: string, x: number, z: number): void {
    this.audio.tapePickup();
    this.entity.notifyTapePickup(x, z);
    this.menu.flashTapeCounter(this.tapes.collected);
    const log = TAPE_LOGS[zoneId];
    if (log && this.settings.subtitles) {
      this.audio.tapeVoice(log.lines.length * 4.2);
      this.queueSubtitles([log.title, ...log.lines]);
    }
    // weather turn partway through the run
    if (!this.rainTriggered && this.tapes.collected >= 3) {
      this.rainTriggered = true;
      this.effects.setRain(true);
      this.audio.setRain(true);
    }
  }

  private queueSubtitles(lines: string[]): void {
    this.subtitleQueue.push(...lines);
  }

  private updateSubtitles(dt: number): void {
    if (this.subtitleTimer > 0) {
      this.subtitleTimer -= dt;
      if (this.subtitleTimer <= 0) this.menu.setSubtitle(null);
      else return;
    }
    if (this.subtitleQueue.length > 0) {
      const line = this.subtitleQueue.shift()!;
      this.menu.setSubtitle(line);
      this.subtitleTimer = 4.2;
    }
  }

  // ================================================================ frame update
  private staticInputFrame = {
    moveX: 0, moveZ: 0, lookDX: 0, lookDY: 0, sprint: false, crouch: false,
    vaultQueued: false, interactQueued: false, flashQueued: false, vfHeld: false,
    lean: 0, pauseQueued: false,
  };

  private update(dt: number, time: number): void {
    if (!this.started) { this.started = true; }
    if (this.state !== 'playing') return;
    this.runTime += dt;

    const inp = this.input.poll();
    if (inp.pauseQueued) { this.pause(); return; }

    // ---- player ----
    this.player.update(dt, inp, this.fear.tremor);
    if (inp.flashQueued) this.flashlight.toggle();
    this.flashlight.update(dt, time);

    // ---- tapes / interact ----
    const near = this.tapes.update(time, this.player.pos.x, this.player.eyeY, this.player.pos.z);
    this.menu.setInteractPrompt(!!near);
    if (inp.interactQueued && near) this.tapes.tryCollect();

    // ---- entity ----
    this.entitySnap = this.entity.update(dt, {
      pos: this.player.pos, eyeY: this.player.eyeY, fwd: this.player.forward,
      sprinting: this.player.sprinting, moving: this.player.moving,
      lightOn: this.flashlight.on,
    }, time);
    const snap = this.entitySnap;
    this.rig.update(dt, time, snap.x, snap.y, snap.z, this.entity.yaw, snap.speed);

    // ---- fear / static ----
    this.fear.update(dt, snap.detection, snap.visibleToPlayer, snap.distToPlayer);
    this.audio.setFearLevel(this.fear.value);

    // close-range beam catch → flinch + cue
    this.flinchCooldown = Math.max(0, this.flinchCooldown - dt);
    if (snap.visibleToPlayer && snap.distToPlayer < 16 && this.flashlight.on && this.flinchCooldown <= 0) {
      this.player.flinch();
      this.flinchCooldown = 4;
      this.audio.entityCue(snap.distToPlayer, 'tone');
      if (navigator.vibrate && this.input.isTouch) navigator.vibrate(40);
    }
    // ambient entity proximity cue
    this.entityCueTimer -= dt;
    if (this.entityCueTimer <= 0) {
      this.entityCueTimer = 5 + Math.random() * 7;
      if (snap.distToPlayer < 42) this.audio.entityCue(snap.distToPlayer);
    }

    // ---- environment ----
    const wind = 0.32 + this.fear.value * 0.85 + (this.rainTriggered ? 0.18 : 0);
    const wTime = time * 0.05;
    this.windDir.x = Math.cos(wTime) * 0.8 + 0.2;
    this.windDir.z = Math.sin(wTime * 0.7) * 0.8 + 0.2;
    updateWind({ strength: wind, dirX: this.windDir.x, dirZ: this.windDir.z, time });
    this.map.update(time, wind);
    this.effects.update(dt, time, this.player.pos.x, this.player.eyeY, this.player.pos.z);
    this.sky.update(time);

    // ---- moon follows player (stabilized shadow window w/ texel snapping) ----
    const dim = this.sky.moonDimAt(time);
    this.moon.intensity = 0.55 * dim;
    const texel = (60 * 2) / this.moon.shadow.mapSize.x;
    const sx = Math.round(this.player.pos.x / texel) * texel;
    const sz = Math.round(this.player.pos.z / texel) * texel;
    this.moonTarget.position.set(sx, this.player.pos.y, sz);
    this.moon.position.set(
      sx + this.sky.moonDir.x * 140,
      this.player.pos.y + this.sky.moonDir.y * 140,
      sz + this.sky.moonDir.z * 140);
    this.moonTarget.updateMatrixWorld();

    // ---- audio bed ----
    this.audio.update(dt, {
      windStrength: wind,
      inForest: this.hf.trailDist(this.player.pos.x, this.player.pos.z) > 3,
      fear: this.fear.value,
      sprinting: this.player.sprinting,
      moving: this.player.moving,
      time,
    });

    // ---- exposure goal: eyes adapt to flashlight / rain gloom ----
    this.pipeline.setExposureGoal((this.flashlight.on ? 1.3 : 0.94) - (this.rainTriggered ? 0.06 : 0));

    // ---- HUD ----
    this.menu.update(dt);
    this.updateSubtitles(dt);
    this.menu.setViewfinder(inp.vfHeld, 4);
    if (this.perfVisible) {
      const st = this.loop.stats();
      this.menu.setPerf(
        `FPS ${st.fps.toFixed(0)}  avg ${(st.avg * 1000).toFixed(1)}ms\n` +
        `p95 ${(st.p95 * 1000).toFixed(1)}ms  worst ${(st.worst * 1000).toFixed(1)}ms\n` +
        `scale ${this.pipeline.renderScale.toFixed(2)}  det ${snap.detection.toFixed(2)}\n` +
        `state ${snap.state}  dist ${snap.distToPlayer.toFixed(0)}m`);
    }

    // ---- static overlay state for composite ----
    this.staticState.level = this.fear.staticLevel + (inp.vfHeld ? 0.12 : 0);
    this.staticState.glimpse = this.fear.glimpse;
    this.staticState.desat = this.fear.desat;
    this.staticState.time = time;

    // ---- win check: reach the fire road ----
    const ex = this.hf.layout.exit;
    if (Math.hypot(this.player.pos.x - ex.x, this.player.pos.z - ex.z) < 7) this.escape();
  }

  private render(dt: number): void {
    if (!this.pipeline) return;
    this.pipeline.render(this.scene, this.player.camera, this.staticState, dt);
    this.pipeline.adaptResolution(dt * 1000, performance.now() / 1000);
  }

  // ================================================================ debug/test hooks
  get debugApi() {
    return {
      state: () => this.state,
      tapes: () => this.tapes.collected,
      stats: () => this.loop.stats(),
      warp: (x: number, z: number) => {
        this.player.pos.set(x, this.hf.heightAt(x, z), z);
        this.pipeline.invalidateHistory();
      },
      start: () => this.startRun(),
      forceFear: (v: number) => { this.fear.value = v; },
      forceDetection: (v: number) => { this.entity.detection = v; },
      entity: () => this.entitySnap,
      flashlight: (on: boolean) => { if (this.flashlight.on !== on) this.flashlight.toggle(); },
      collectAll: () => {
        for (const t of this.tapes.tapes) {
          if (!t.collected) { t.collected = true; this.scene.remove(t.mesh); this.tapes.collected++; }
        }
        this.menu.flashTapeCounter(this.tapes.collected);
      },
      positions: () => ({
        spawn: this.hf.layout.spawn, exit: this.hf.layout.exit,
        zones: this.hf.layout.zones.map(z => ({ id: z.id, x: z.x, z: z.z })),
      }),
    };
  }
}

// ================================================================ entry
const game = new StaticGame();
(window as unknown as { __static: unknown }).__static = game.debugApi;
game.boot().catch((err) => {
  console.error('BOOT FAILURE', err);
  const el = document.getElementById('load-status');
  if (el) el.textContent = 'BOOT FAILURE — ' + (err instanceof Error ? err.message : String(err));
});

// offline support — production build caches itself, death/restart never re-fetches
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
