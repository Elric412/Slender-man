import * as THREE from 'three';
import { GameLoop } from './core/GameLoop';
import { Input } from './core/Input';
import { loadSettings, probeQuality, probeRenderer, QUALITY_SPECS, QualitySpec, Settings } from './core/Config';
import { HeightField } from './world/HeightField';
import { MaterialLibrary } from './world/MaterialLibrary';
import { MapGenerator } from './world/MapGenerator';
import { updateWind } from './world/VegetationSystem';
import { CollisionWorld } from './physics/Collision';
import { NavWorld } from './ai/NavWorld';
import { EntityBrain, EntitySnapshot } from './ai/EntityBrain';
import { RenderPipeline, StaticState } from './render/RenderPipeline';
import { EnvironmentProbe } from './render/EnvironmentProbe';
import { Sky } from './render/Sky';
import { Player } from './game/Player';
import { Flashlight } from './game/Flashlight';
import { PalebarkRig } from './game/PalebarkRig';
import { FearSystem } from './game/FearSystem';
import { TapeSystem, TAPE_LOGS } from './game/TapeSystem';
import { Effects } from './game/Effects';
import { AudioEngine } from './audio/AudioEngine';
import { ZoneSystem } from './world/ZoneSystem';
import { Menu } from './ui/Menu';

const WORLD_SEED = 0x57A71C; // fixed world seed — map is consistent & benchmarkable

type GameState = 'loading' | 'title' | 'playing' | 'paused' | 'ending' | 'escaped' | 'taken';

const frame = (): Promise<void> => new Promise(r => requestAnimationFrame(() => r()));

/**
 * Weather director state. Rain doesn't just spawn particles — it drives a
 * *coupled* look change: surfaces wet down (albedo darkens, roughness
 * collapses, up-facing planes glaze over), fog thickens and drops, volumetric
 * in-scatter rises, bloom widens on the wet specular, and the exposure goal
 * dips because everything reflects less diffuse light back at you.
 */
interface Weather {
  rain: number;      // 0..1 rainfall intensity (target)
  wetness: number;   // 0..1 accumulated surface wetness (lags rain heavily)
}

class StaticGame {
  private canvas: HTMLCanvasElement;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private pipeline!: RenderPipeline;
  private probe: EnvironmentProbe | null = null;
  private loop = new GameLoop();
  private menu: Menu;
  private settings: Settings;
  private spec: QualitySpec;
  private input!: Input;
  private audio: AudioEngine;

  private hf!: HeightField;
  private zones!: ZoneSystem;
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
  private staticState: StaticState = {
    level: 0, glimpse: 0, desat: 0.2, time: 0, viewfinder: 0, wetness: 0,
  };
  private weather: Weather = { rain: 0, wetness: 0 };
  private windDir = { x: 0.8, z: 0.6 };
  private rainTriggered = false;
  private flinchCooldown = 0;
  private entityCueTimer = 0;
  private subtitleQueue: string[] = [];
  private subtitleTimer = 0;
  private perfVisible = false;
  private endKind: 'escaped' | 'taken' = 'taken';
  private started = false;
  private vfWeight = 0;

  constructor() {
    this.canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    this.settings = loadSettings();
    this.menu = new Menu(this.settings);
    const tier = this.settings.quality === 'auto' ? probeQuality() : this.settings.quality;
    this.spec = QUALITY_SPECS[tier];
    // The audio engine only *allocates* here; no AudioContext is created until
    // init() runs behind a user gesture, so autoplay policy stays satisfied.
    this.audio = new AudioEngine(this.settings.audio, this.spec.tier === 'low');
  }

  // ================================================================ boot
  async boot(): Promise<void> {
    const p = (f: number, s: string) => { this.menu.setLoadProgress(f, s); };

    p(0.02, 'igniting renderer…');
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: false, powerPreference: 'high-performance',
      stencil: false,
    });
    // Everything upstream of the composite stays in scene-referred linear; the
    // AgX display transform and the grade happen once, at the very end.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.autoClear = true;
    this.handleResize();
    if (import.meta.env.DEV) console.info('[STATIC] GPU:', probeRenderer());
    await frame();

    p(0.08, 'surveying terrain…');
    this.hf = new HeightField(WORLD_SEED);
    await frame();

    // Ecology field. Must exist before anything is scattered or dressed: the
    // zone weights decide species, density, ground cover, fog and light. It is
    // also what the audio bed reads to know whether the player is standing in a
    // closed thicket or on an open marsh edge.
    p(0.09, 'reading the ecology…');
    this.zones = new ZoneSystem(this.hf, WORLD_SEED);
    await frame();

    // Procedural PBR synthesis is the single heaviest boot stage. It yields a
    // frame between each surface so the loading bar animates instead of
    // freezing (and mobile Safari doesn't kill the tab for jank).
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.mats = await MaterialLibrary.create(WORLD_SEED, {
      size: this.spec.textureSize,
      anisotropy: Math.min(this.spec.anisotropy, maxAniso),
      onProgress: (f, label) => p(0.10 + f * 0.20, `synthesising ${label}…`),
    });

    p(0.30, 'planting the forest…');
    this.col = new CollisionWorld(this.hf);
    // Occlusion is raycast through the *same* collision data gameplay uses, so
    // a sound is muffled by exactly the geometry that blocks movement and sight.
    // Sharing the structure is the point: a separate audio-only world would
    // drift out of agreement with what the player can see and walk through.
    this.audio.setProbe(this.col);
    this.map = new MapGenerator(this.hf, this.mats, this.col, WORLD_SEED);
    await frame();

    p(0.48, 'teaching it to walk…');
    this.nav = new NavWorld(this.hf, this.col);
    await frame();

    p(0.56, 'assembling scene…');
    this.buildScene();
    await frame();

    p(0.62, 'measuring the sky…');
    this.captureEnvironment();
    await frame();

    p(0.68, 'waking the entity…');
    this.entity = new EntityBrain(this.nav, this.col, this.hf, WORLD_SEED);
    this.rig = new PalebarkRig(this.mats);
    this.scene.add(this.rig.group);
    this.wireEntity();
    await frame();

    p(0.76, 'charging flashlight…');
    this.player = new Player(this.col, this.hf, this.mats);
    this.player.baseFov = this.settings.fov;
    this.scene.add(this.player.camera);
    this.flashlight = new Flashlight(
      this.scene, this.player, Math.min(this.spec.shadowMapSize, 1024), this.hf,
      this.spec.dustCount);
    this.wirePlayer();
    this.tapes = new TapeSystem(this.map, this.mats, this.scene, this.runSeed);
    this.effects = new Effects(this.scene, this.hf, this.spec.fogWisps, this.spec.particleCount);
    await frame();

    p(0.84, 'warming shader pipelines…');
    this.pipeline = new RenderPipeline(this.renderer, this.spec);
    this.pipeline.resize(this.renderer.domElement.width, this.renderer.domElement.height);
    this.pipeline.setMoon(this.moon);
    this.syncProjection();
    this.applyWeatherLook(0, true);
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

    // Faint sky/ground bounce. With an env probe active this drops right down —
    // the IBL already supplies directional ambient, and doubling up flattens
    // everything out.
    this.hemi = new THREE.HemisphereLight(0x141c2a, 0x05060a, 0.32);
    this.scene.add(this.hemi);

    this.scene.add(this.map.group);
  }

  /**
   * Render the procedural sky into a PMREM probe and use it as `scene.environment`.
   *
   * This is what gives wet bark, puddles, the lens and the entity's skin a real
   * specular response instead of a dead flat ambient. Cost is a handful of tiny
   * draws once at boot.
   */
  private captureEnvironment(): void {
    if (!this.spec.envProbe) {
      this.hemi.intensity = 0.32;
      return;
    }
    try {
      this.probe = new EnvironmentProbe(this.renderer, this.spec.tier === 'ultra' ? 256 : 128);
      this.sky.update(0);
      this.scene.environment = this.probe.capture(this.sky.mesh);
      this.scene.environmentIntensity = 0.55;
      // the probe carries the ambient now — back the hemisphere fill way off
      this.hemi.intensity = 0.12;
      this.mats.setEnvIntensity(1);
    } catch (err) {
      console.warn('[STATIC] env probe unavailable, falling back to hemisphere fill', err);
      this.probe = null;
      this.hemi.intensity = 0.32;
    }
  }

  /** Keep point-sprite sizing physically correct after resize / FOV change. */
  private syncProjection(): void {
    if (!this.player || !this.pipeline) return;
    const h = this.renderer.domElement.height * this.pipeline.renderScale;
    const fovY = THREE.MathUtils.degToRad(this.player.camera.fov);
    this.flashlight?.setProjection(h, fovY);
    this.effects?.setProjection?.(h, fovY);
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
    this.pipeline.setBeam(this.flashlight.light, 1);
    this.effects.setRain(true);
    this.tapes.spawnAll(this.runSeed);
    await frame();
    this.renderer.compile(this.scene, this.player.camera);
    await frame();
    // Two full pipeline renders: the first compiles every post program, the
    // second exercises the temporal paths (TAA / AO / volumetric history) so
    // their programs are hot too.
    this.pipeline.render(this.scene, this.player.camera, this.staticState, 0.016);
    await frame();
    this.pipeline.render(this.scene, this.player.camera, this.staticState, 0.016);
    await frame();
    this.effects.setRain(false);
    this.flashlight.on = false;
    this.flashlight.update(0.016, 0);
    this.pipeline.setBeam(null, 0);
    this.pipeline.invalidateHistory();
  }

  // ================================================================ wiring
  private wireMenu(): void {
    // The advisory is a hard gate on the *first* run only (§11 gate 9: "present
    // before first play"). Once acknowledged it never interrupts again, and it
    // remains reachable from Settings.
    this.menu.onStart = () => {
      if (!this.menu.advisoryAcknowledged) { this.menu.show('advisory'); return; }
      this.startRun();
    };
    this.menu.onAdvisoryAck = () => this.startRun();
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
    // A glimpse is the one moment the audio is allowed a transient of its own.
    // The sting is round-robin'd inside EntityAudio, so no two sightings in a
    // run share a recipe (brief §8 / quality gate 3).
    this.entity.onGlimpse = () => {
      this.fear.triggerGlimpse();
      const s = this.entitySnap;
      this.audio.sighting(s ? s.distToPlayer : 30);
    };
    // Footfalls carry true world position so the spatialiser can place them;
    // EntityAudio adds its own distance-scaled positional error on top, so
    // careful listening yields a direction, never a fix.
    this.entity.onFootfall = (x, z, dist) => {
      this.audio.entityCue(dist, dist < 20 ? 'footfall' : 'snap',
        x, this.hf.heightAt(x, z) + 1.2, z);
    };
  }

  private wireLifecycle(): void {
    window.addEventListener('resize', () => { this.handleResize(); this.menu.checkOrientation(); });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (this.state === 'playing') this.pause();
        // Suspend unconditionally, not just while playing: a backgrounded tab
        // sitting on the title screen must not keep an AudioContext running, or
        // mobile browsers will kill it in a state we can't detect (§12).
        this.audio.suspend();
      } else if (this.state === 'playing' || this.state === 'paused') {
        // Resume on return. iOS may have hard-interrupted the context (phone
        // call, screen lock); unlock() re-resumes and re-kicks it, and is a
        // no-op when the context is already running.
        this.audio.resume();
      }
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
    // Per-bus levels, the low-frequency-intensity trim, night mode and the
    // caption toggle all live in s.audio — the legacy single `volume` slider is
    // mirrored into audio.master by loadSettings().
    this.audio.applySettings(s.audio);
    const tier = s.quality === 'auto' ? probeQuality() : s.quality;
    const spec = QUALITY_SPECS[tier];
    if (this.pipeline && spec.tier !== this.spec.tier) {
      this.spec = spec;
      this.pipeline.setQuality(spec);
      this.moon.shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);
      if (this.moon.shadow.map) { this.moon.shadow.map.dispose(); this.moon.shadow.map = null as unknown as THREE.WebGLRenderTarget; }
      this.flashlight.setShadowSize(Math.min(spec.shadowMapSize, 1024));
      this.flashlight.setDustBudget(spec.dustCount);
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
    this.syncProjection();
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
    // Every audio subsystem reseeds off this, so a fixed runSeed reproduces the
    // exact same ambience schedule and sting order — which is what makes the
    // seeded Director test in the suite meaningful.
    this.audio.startRun(this.runSeed);
    this.runTime = 0;
    this.rainTriggered = false;
    this.weather.rain = 0;
    this.weather.wetness = 0;
    this.vfWeight = 0;
    this.applyWeatherLook(0, true);
    this.subtitleQueue.length = 0;
    this.subtitleTimer = 0;
    this.fear.reset();
    this.player.reset(this.hf.layout.spawn.x, this.hf.layout.spawn.z);
    this.flashlight.battery = 1;
    if (this.flashlight.on) this.flashlight.toggle();
    this.flashlight.warp();
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
    this.audio.suspend();
    this.loop.paused = true;
    this.menu.show('pause');
    this.input.releasePointerLock();
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'playing';
    this.audio.resume();
    this.loop.paused = false;
    this.menu.show('none');
    this.input.requestPointerLock();
    this.pipeline.invalidateHistory();
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
    this.state = this.endKind; // 'escaped' | 'taken' — win/lose is part of the state contract
    this.audio.endRun();
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
      this.weather.rain = 1;
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

  // ================================================================ look director
  /**
   * Push the weather/fear state into every renderer knob at once.
   *
   * Wetness is deliberately *slow*: rain starts instantly but surfaces take
   * ~25 s to fully glaze, and dry off over a couple of minutes. That lag is
   * most of what sells rain as a physical event rather than a particle toggle.
   */
  private applyWeatherLook(dt: number, immediate = false): void {
    const w = this.weather;
    if (immediate) {
      w.wetness = w.rain;
    } else {
      const rate = w.rain > w.wetness ? 1 / 25 : 1 / 130;   // wet fast-ish, dry slow
      w.wetness += (w.rain - w.wetness) * Math.min(1, rate * dt * 8);
    }
    const wet = THREE.MathUtils.clamp(w.wetness, 0, 1);

    this.mats?.setWetness(wet);
    this.staticState.wetness = wet;

    // Fog thickens and hugs the ground as the air saturates.
    this.pipeline?.setFog({
      density: 0.020 + wet * 0.016 + this.fear.value * 0.004,
      baseHeight: 1.2 - wet * 0.5,
      falloff: 9 - wet * 2.5,
      turbulence: 0.55 + this.fear.value * 0.35,
    });

    // Grade: rain hazes highlights (more bloom, more in-scatter), fear crushes
    // the vignette in and lifts grain.
    const fear = this.fear.value;
    this.pipeline?.setGrade({
      bloom: 0.55 + wet * 0.28,
      streak: 0.22 + wet * 0.18,
      volumetric: 0.9 + wet * 0.45,
      ao: 0.85 + fear * 0.2,
      grain: 0.035 + fear * 0.09 + this.vfWeight * 0.05,
      vignette: 0.30 + fear * 0.28 + this.vfWeight * 0.12,
      dof: this.spec.dof ? 0.35 + this.vfWeight * 0.4 : 0,
      dofRange: [2.4, 34 - wet * 8],
    });

    // Scene fog colour warms slightly under rain (sodium spill from the road).
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = 0.0155 + wet * 0.004;
    }
    if (this.scene.environmentIntensity !== undefined) {
      this.scene.environmentIntensity = 0.55 - wet * 0.18;
    }
  }

  // ================================================================ frame update
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

    // The brain owns the "extension / reach" beat: a rare late-act moment where
    // the entity asserts presence without moving. It is the only gameplay hook
    // permitted to spend the sub-bass budget, and the Director can still refuse
    // it if the budget is exhausted.
    if (snap.extensionRequest) this.audio.extensionBeat(snap.distToPlayer);

    // close-range beam catch → flinch + cue
    this.flinchCooldown = Math.max(0, this.flinchCooldown - dt);
    if (snap.visibleToPlayer && snap.distToPlayer < 16 && this.flashlight.on && this.flinchCooldown <= 0) {
      this.player.flinch();
      this.flinchCooldown = 4;
      this.audio.entityCue(snap.distToPlayer, 'shift');
      if (navigator.vibrate && this.input.isTouch) navigator.vibrate(40);
    }
    // ambient entity proximity cue
    this.entityCueTimer -= dt;
    if (this.entityCueTimer <= 0) {
      this.entityCueTimer = 5 + Math.random() * 7;
      if (snap.distToPlayer < 42) this.audio.entityCue(snap.distToPlayer);
    }

    // ---- environment ----
    const wind = 0.32 + this.fear.value * 0.85 + this.weather.wetness * 0.18;
    const wTime = time * 0.05;
    this.windDir.x = Math.cos(wTime) * 0.8 + 0.2;
    this.windDir.z = Math.sin(wTime * 0.7) * 0.8 + 0.2;
    updateWind({ strength: wind, dirX: this.windDir.x, dirZ: this.windDir.z, time });
    this.map.update(time, wind);
    this.map.veg.setDrawDistance(this.player.pos.x, this.player.pos.z, this.spec.drawDistance);
    this.effects.update(dt, time, this.player.pos.x, this.player.eyeY, this.player.pos.z);
    this.sky.update(time);

    // ---- moon follows player (stabilized shadow window w/ texel snapping) ----
    const dim = this.sky.moonDimAt(time);
    this.moon.intensity = 0.55 * dim * (1 - this.weather.wetness * 0.45); // cloud cover
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
    // The ambience is not a global loop with a wind knob; it is a *reading of
    // the place the listener is standing in*. Every environmental term below
    // comes from the same zone field the scatter system used, so a marsh sounds
    // like reeds and open water, the ravine sounds like moving water under a
    // closed canopy, and the blight sounds conspicuously dead.
    const px = this.player.pos.x, pz = this.player.pos.z;
    const canopy = this.zones.scalarAt(px, pz, 'canopyClosure');
    const openness = 1 - canopy * 0.82;
    this.audio.update(dt, {
      x: px, y: this.player.eyeY, z: pz,
      fx: this.player.forward.x, fy: this.player.forward.y, fz: this.player.forward.z,
      moving: this.player.moving,
      sprinting: this.player.sprinting,
      crouched: this.player.crouched,
      stamina: this.player.stamina,
      fear: this.fear.value,
      detection: snap.detection,
      entityState: snap.state,
      entityX: snap.x, entityY: snap.y, entityZ: snap.z,
      entityVisible: snap.visibleToPlayer,
      entityDist: snap.distToPlayer,
      entitySpeed: snap.speed,
      tapes: this.tapes.collected,
      runTime: this.runTime,
      wind,
      canopyClosure: canopy,
      wetness: this.weather.wetness,
      reedDensity: this.zones.scalarAt(px, pz, 'reedDensity'),
      deadfallDensity: this.zones.scalarAt(px, pz, 'deadfallDensity'),
      creekDist: this.zones.creekDist(px, pz),
      lakeDist: Math.max(0, Math.hypot(px - this.hf.layout.lake.x, pz - this.hf.layout.lake.z)
        - this.hf.layout.lake.r),
      openness,
      // "enclosed" is a *built* interior (tunnel, mill, station), not a dense
      // thicket — it drives reverb, and trees are terrible reflectors.
      enclosed: this.hf.zoneAt(px, pz) !== null && canopy < 0.35,
      inOpen: openness > 0.62,
    });

    // ---- renderer hand-off: beam, weather, exposure ----
    this.vfWeight += ((inp.vfHeld ? 1 : 0) - this.vfWeight) * Math.min(1, dt * 9);
    this.pipeline.setBeam(
      this.flashlight.beamStrength > 0.002 ? this.flashlight.light : null,
      this.flashlight.beamStrength);
    this.applyWeatherLook(dt);

    // Eyes adapt: a lit beam raises the target, rain gloom lowers it, and the
    // viewfinder's electronic gain pushes it up again.
    this.pipeline.setExposureGoal(
      0.94
      + this.flashlight.beamStrength * 0.36
      - this.weather.wetness * 0.08
      + this.vfWeight * 0.10);

    // ---- HUD ----
    this.menu.update(dt);
    this.updateSubtitles(dt);
    // Audio-cue captions are pushed every frame; the engine owns their lifetime
    // and returns an empty list when the setting is off, so no branch is needed.
    this.menu.setAudioCues(this.audio.cues.map(c => c.text));
    this.menu.setViewfinder(inp.vfHeld, 4);
    if (this.perfVisible) {
      const st = this.loop.stats();
      const g = this.pipeline.gpuStats;
      this.menu.setPerf(
        `FPS ${st.fps.toFixed(0)}  avg ${(st.avg * 1000).toFixed(1)}ms\n` +
        `p95 ${(st.p95 * 1000).toFixed(1)}ms  worst ${(st.worst * 1000).toFixed(1)}ms\n` +
        `upd ${st.updateMs.toFixed(2)}  ren ${st.renderMs.toFixed(2)}  gpu ${g.gpuMs.toFixed(2)}ms\n` +
        `draws ${g.calls}  tris ${(g.triangles / 1000).toFixed(0)}k  passes ${g.passes}\n` +
        `scale ${this.pipeline.renderScale.toFixed(2)}  effort ${this.pipeline.effort.toFixed(2)}\n` +
        `wet ${this.weather.wetness.toFixed(2)}  batt ${this.flashlight.battery.toFixed(2)}\n` +
        `state ${snap.state}  det ${snap.detection.toFixed(2)}  dist ${snap.distToPlayer.toFixed(0)}m\n` +
        this.audioPerfLine());
    }

    // ---- static overlay state for composite ----
    this.staticState.level = this.fear.staticLevel + this.vfWeight * 0.12;
    this.staticState.glimpse = this.fear.glimpse;
    this.staticState.desat = this.fear.desat;
    this.staticState.time = time;
    this.staticState.viewfinder = this.vfWeight;

    // ---- win check: reach the fire road ----
    const ex = this.hf.layout.exit;
    if (Math.hypot(this.player.pos.x - ex.x, this.player.pos.z - ex.z) < 7) this.escape();
  }

  /**
   * Audio block of the F3 overlay. Brief §6 requires the Director's state to be
   * visible for tuning: without seeing `act`, `tension` and which layers are
   * live, escalation can only be guessed at by ear across whole runs.
   */
  private audioPerfLine(): string {
    const d = this.audio.directorState;
    const m = this.audio.meterMaster();
    const a = this.audio.debug() as { voices: number; poolSize: number; dropped: number; duck: number };
    const spends = Object.entries(d.spends).map(([k, v]) => `${k[0]}${v}`).join(' ');
    return (
      `AUD ${this.audio.state}  act ${d.act}  ten ${d.tension.toFixed(2)}  sil ${d.silence.toFixed(2)} (${d.silenceSeconds.toFixed(0)}s)\n` +
      `lyr ${d.layers.join(',') || '—'}  sub ${d.sub.toFixed(2)} cls ${d.cluster.toFixed(2)} ris ${d.riser.toFixed(2)}\n` +
      `lufs ${m.lufs.toFixed(1)}  pk ${m.peak.toFixed(3)}  duck ${a.duck.toFixed(2)}  ` +
      `vox ${a.voices}/${a.poolSize} drop ${a.dropped}\n` +
      `budget ${spends}  why ${d.reason}`
    );
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
      look: (yaw: number, pitch: number) => { this.player.yaw = yaw; this.player.pitch = pitch; },
      dustStats: () => this.flashlight.dustStats(),
      player: () => ({ x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z, yaw: this.player.yaw }),
      stats: () => this.loop.stats(),
      gpuStats: () => this.pipeline ? { ...this.pipeline.gpuStats } : null,
      warp: (x: number, z: number) => {
        this.player.pos.set(x, this.hf.heightAt(x, z), z);
        this.flashlight?.warp();
        this.pipeline.invalidateHistory();
      },
      start: () => this.startRun(),
      forceFear: (v: number) => { this.fear.value = v; },
      forceDetection: (v: number) => { this.entity.detection = v; },
      // Live snapshot: reads brain fields directly so it never goes stale
      // between frames (the cached entitySnap only refreshes once per update
      // tick — under slow renderers QA could read a pre-change state).
      entity: (): EntitySnapshot | null => {
        if (!this.entitySnap) return null;
        return {
          state: this.entity.state,
          detection: this.entity.detection,
          x: this.entity.pos.x, y: this.entity.pos.y, z: this.entity.pos.z,
          visibleToPlayer: this.entitySnap.visibleToPlayer,
          distToPlayer: Math.hypot(
            this.entity.pos.x - this.player.pos.x,
            this.entity.pos.z - this.player.pos.z),
          speed: this.entitySnap.speed,
          act: this.entity.currentAct,
          extensionEligible: this.entity.extensionEligible,
          // A request is a single-frame edge owned by the brain's own tick, so a
          // debug read outside that tick must report false rather than
          // resurrecting a stale edge.
          extensionRequest: false,
        };
      },
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

      // ---- audio (brief §13) -------------------------------------------------
      // One snapshot object carrying Director state, per-bus metering, voice
      // counts and trigger history. The test suite asserts against this rather
      // than trying to listen to the output, which is not observable headlessly.
      audio: () => this.audio.debug(),
      audioMeter: (bus?: 'ambience' | 'entity' | 'foley' | 'ui') =>
        bus ? this.audio.meterBus(bus) : this.audio.meterMaster(),
      audioDirector: () => this.audio.directorState,
      audioTriggers: () => this.audio.triggerLog.slice(),
      audioCues: () => this.audio.cues.map(c => ({ text: c.text, kind: c.kind })),
      // Deterministic trigger hooks so a test can exercise a bus without having
      // to manoeuvre the AI into the right state.
      audioFire: (what: 'sighting' | 'capture' | 'cue' | 'tape' | 'ui' | 'step' | 'extension') => {
        switch (what) {
          case 'sighting': this.audio.sighting(18); break;
          case 'capture': this.audio.captureSting(); break;
          case 'cue': this.audio.entityCue(30, 'snap'); break;
          case 'tape': this.audio.tapePickup(); break;
          case 'ui': this.audio.uiClick(); break;
          case 'step': this.audio.footstep(this.player.surfaceHere(), 0.8); break;
          case 'extension': this.audio.extensionBeat(24); break;
        }
      },
      // Force the Director forward without waiting out a real 7-minute run, so
      // the "early vs late differs measurably" assertion is testable.
      audioForce: (o: { tapes?: number; runTime?: number }) => {
        if (o.tapes !== undefined) {
          for (const t of this.tapes.tapes) {
            if (!t.collected && this.tapes.collected < o.tapes) {
              t.collected = true; this.scene.remove(t.mesh); this.tapes.collected++;
            }
          }
        }
        if (o.runTime !== undefined) this.runTime = o.runTime;
      },
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
