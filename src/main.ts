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
import { PalebarkEntity } from './entity/PalebarkEntity';
import type { AnimState } from './entity/PalebarkAnimator';
import { FearSystem } from './game/FearSystem';
import { ProximityTell } from './game/ProximityTell';
import { TapeSystem, TAPE_LOGS } from './game/TapeSystem';
import { Effects } from './game/Effects';
import { AudioEngine } from './audio/AudioEngine';
import { ZoneSystem } from './world/ZoneSystem';
import { SeededRandom } from './core/SeededRandom';
import { Menu } from './ui/Menu';

const WORLD_SEED = 0x57A71C; // fixed world seed — map is consistent & benchmarkable

type GameState = 'loading' | 'title' | 'playing' | 'paused' | 'ending' | 'escaped' | 'taken';

const frame = (): Promise<void> => new Promise(r => requestAnimationFrame(() => r()));

/**
 * Brain state → animation state.
 *
 * The two vocabularies are deliberately separate: the brain reasons about
 * *intent* ("investigating") while the animator reasons about *body* ("transit").
 * Investigating and dormant-while-walking are the same body language, so they
 * collapse to one entry here rather than duplicating a pose table.
 */
const ANIM_STATE: Record<EntitySnapshot['state'], AnimState> = {
  dormant: 'dormant',
  investigating: 'transit',
  stalking: 'stalk',
  confronting: 'confront',
};

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
  private rig!: PalebarkEntity;
  private fear = new FearSystem();
  /**
   * Optional proximity signalling. Off by default; the mode is pushed in from
   * settings rather than read here, so this object never touches localStorage.
   */
  private tell = new ProximityTell();
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
  /** wind strength from the previous frame — the coat reads it before it is recomputed */
  private lastWind = 0.32;
  private entityGaze = new THREE.Vector3();
  private entityWind = new THREE.Vector3();
  /**
   * Terrain sampler handed to the foot IK. Bound once as an arrow property so
   * the animator can call it every frame without allocating a closure, and so
   * `this` cannot be lost.
   */
  private groundAt = (x: number, z: number): number => this.hf.heightAt(x, z);
  /** per-run RNG for the animator's discretionary variation */
  private entityRand: () => number = Math.random;
  /** QA hook: force the reach beat on the next frame (see debugApi) */
  private forceExtension = false;
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

  // boot-stage wall-clock timings, for load-time profiling (F3/debug)
  private bootTimes: Record<string, number> = {};
  private bootT0 = 0;
  private bootMark(stage: string): void {
    const now = performance.now();
    if (this.bootT0 === 0) { this.bootT0 = now; return; }
    this.bootTimes[stage] = Math.round(now - this.bootT0);
    this.bootT0 = now;
  }

  // ================================================================ boot
  async boot(): Promise<void> {
    const p = (f: number, s: string) => { this.menu.setLoadProgress(f, s); };
    this.bootMark('start');

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
    this.bootMark('renderer');

    // Start procedural PBR synthesis NOW — it is the heaviest CPU stage and is
    // fully independent of terrain/ecology/collision/nav, so it runs
    // CONCURRENTLY with the world-gen below instead of serially after it.
    // We only await it at MapGenerator, the first consumer.
    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    const matsPromise = MaterialLibrary.create(WORLD_SEED, {
      size: this.spec.textureSize,
      anisotropy: Math.min(this.spec.anisotropy, maxAniso),
      onProgress: (f, label) => p(0.10 + f * 0.20, `synthesising ${label}…`),
    });

    p(0.08, 'surveying terrain…');
    this.hf = new HeightField(WORLD_SEED);
    await frame();
    this.bootMark('heightfield');

    // Ecology field. Must exist before anything is scattered or dressed: the
    // zone weights decide species, density, ground cover, fog and light. It is
    // also what the audio bed reads to know whether the player is standing in a
    // closed thicket or on an open marsh edge.
    p(0.09, 'reading the ecology…');
    this.zones = new ZoneSystem(this.hf, WORLD_SEED);
    await frame();
    this.bootMark('zones');

    // Materials were synthesising in the background since renderer init;
    // MapGenerator is their first consumer, so await here. (It yields a frame
    // between surfaces internally, so the loading bar kept animating.)
    this.mats = await matsPromise;
    this.bootMark('materials');

    p(0.30, 'planting the forest…');
    this.col = new CollisionWorld(this.hf);
    // Occlusion is raycast through the *same* collision data gameplay uses, so
    // a sound is muffled by exactly the geometry that blocks movement and sight.
    // Sharing the structure is the point: a separate audio-only world would
    // drift out of agreement with what the player can see and walk through.
    this.audio.setProbe(this.col);
    this.map = new MapGenerator(this.hf, this.mats, this.col, WORLD_SEED);
    await frame();
    this.bootMark('map');

    p(0.48, 'teaching it to walk…');
    this.nav = new NavWorld(this.hf, this.col);
    await frame();
    this.bootMark('nav');

    p(0.56, 'assembling scene…');
    this.buildScene();
    await frame();
    this.bootMark('scene');

    p(0.62, 'measuring the sky…');
    this.captureEnvironment();
    await frame();
    this.bootMark('envprobe');

    p(0.68, 'waking the entity…');
    this.entity = new EntityBrain(this.nav, this.col, this.hf, WORLD_SEED);
    // The hero character: three LODs on one skeleton, procedurally sculpted and
    // textured at boot. Its own atlases are synthesised here (yielding frames),
    // then the hero tier streams in during play via streamStep().
    this.rig = await PalebarkEntity.create({
      tier: this.spec.tier,
      anisotropy: Math.min(this.spec.anisotropy, maxAniso),
      seed: WORLD_SEED,
      onProgress: (f, label) => p(0.68 + f * 0.06, `${label}…`),
    });
    this.scene.add(this.rig.group);
    // Match the env-probe decision made in captureEnvironment() above. The
    // entity is built after the probe, so it has to be told separately rather
    // than relying on the shared MaterialLibrary call.
    this.rig.setEnvIntensity(this.probe ? 1 : 0.55);
    this.wireEntity();
    await frame();
    this.bootMark('entity');

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
    this.bootMark('player/fx');

    p(0.84, 'assembling renderer…');
    this.pipeline = new RenderPipeline(this.renderer, this.spec);
    this.pipeline.resize(this.renderer.domElement.width, this.renderer.domElement.height);
    this.pipeline.setMoon(this.moon);
    this.syncProjection();
    this.applyWeatherLook(0, true);
    await frame();
    this.bootMark('pipeline');

    p(0.92, 'wiring input…');
    this.input = new Input(this.canvas);
    this.applySettings(this.settings);
    this.input.onFirstGesture = () => { this.audio.init(); this.audio.resume(); };
    this.wireMenu();
    this.wireLifecycle();
    this.loop.onUpdate((dt, t) => this.update(dt, t));
    this.loop.onRender((dt) => this.render(dt));
    this.loop.start();
    await frame();
    this.bootMark('input');

    // Title FIRST, warm shaders SECOND. Shader program warm-up (multi-second
    // on real GPUs) used to block the title screen; now it runs as a
    // background task while the menu is already interactive. startRun()
    // waits behind the loading screen only if it isn't finished yet.
    p(1.0, 'tape loaded.');
    this.bootMark('title');
    if (import.meta.env.DEV) console.info('[STATIC] boot ms:', this.bootTimes);
    this.toTitle();
    const w0 = performance.now();
    this.warmupPromise = this.warmup()
      .catch(err => console.error('[STATIC] warmup failed', err))
      .finally(() => {
        this.bootTimes['warmup(bg)'] = Math.round(performance.now() - w0);
        this.warmupPromise = null;
      });
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
    // compileAsync uses KHR_parallel_shader_compile when the driver offers it,
    // so program linking overlaps instead of blocking one-by-one (big win on
    // drivers with slow single-threaded compile); falls back to sync compile.
    if (typeof this.renderer.compileAsync === 'function') {
      await this.renderer.compileAsync(this.scene, this.player.camera);
    } else {
      this.renderer.compile(this.scene, this.player.camera);
    }
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
    // Switching away from `explicit` must also clear whatever the dial was last
    // showing; Menu owns that, and the call is idempotent.
    this.tell.mode = s.proximityTell;
    if (s.proximityTell !== 'explicit') this.menu.setProximityTell(null);
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

  private warmupPromise: Promise<void> | null = null;

  private startRun(): void {
    if (this.warmupPromise) {
      // Shader warm-up still running in the background — hold on the loading
      // screen until it resolves, then re-enter startRun().
      this.menu.show('loading');
      this.menu.setLoadProgress(0.97, 'warming shaders…');
      const wp = this.warmupPromise;
      wp.then(() => this.startRun());
      return;
    }
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
    // Carry the mode across but drop the accumulated value, so a fresh run never
    // opens with a warning inherited from the previous one's final moments.
    this.tell.reset();
    this.menu.setProximityTell(null);
    this.player.reset(this.hf.layout.spawn.x, this.hf.layout.spawn.z);
    this.flashlight.battery = 1;
    if (this.flashlight.on) this.flashlight.toggle();
    this.flashlight.warp();
    this.entity.respawnFar(this.player.pos);
    // Re-seed the brain's *discretionary* choices (which POI, which flank, how
    // long to hold). The world seed stays fixed so the map is unchanged; this is
    // the only thing that makes run 2 differ from run 1, which is what quality
    // gate #6 (no two runs place a sighting identically) depends on.
    this.entity.reseed(this.runSeed);
    // The animator's variation draws from the same run seed, so a replay of a
    // given seed is reproducible for testing.
    const animRng = new SeededRandom(this.runSeed ^ 0xA5F1);
    this.entityRand = () => animRng.next();
    // Hard-reset the character: cloth particles, animator layers and LOD fade
    // weights all get re-seated at the new position. Without this the coat would
    // integrate the respawn displacement as one frame of motion and visibly
    // billow before settling.
    this.rig.reset(
      this.entity.pos.x, this.entity.pos.y, this.entity.pos.z, this.entity.yaw,
      Math.hypot(this.entity.pos.x - this.player.pos.x, this.entity.pos.z - this.player.pos.z));
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

  // per-stage update profiling (EMA ms) — stability hunting + perf overlay
  readonly prof: Record<string, number> = {
    player: 0, tapes: 0, entity: 0, rig: 0, fear: 0, env: 0, audio: 0, hud: 0,
  };
  private profMark(stage: string, t0: number): void {
    const d = performance.now() - t0;
    this.prof[stage] += (d - this.prof[stage]) * 0.05;
  }

  // ================================================================ frame update
  private update(dt: number, time: number): void {
    if (!this.started) { this.started = true; }
    if (this.state !== 'playing') return;
    this.runTime += dt;

    const inp = this.input.poll();
    if (inp.pauseQueued) { this.pause(); return; }

    // ---- player ----
    let p0 = performance.now();
    this.player.update(dt, inp, this.fear.tremor);
    if (inp.flashQueued) this.flashlight.toggle();
    this.flashlight.update(dt, time);
    this.profMark('player', p0);

    // ---- tapes / interact ----
    p0 = performance.now();
    const near = this.tapes.update(time, this.player.pos.x, this.player.eyeY, this.player.pos.z);
    this.profMark('tapes', p0);
    this.menu.setInteractPrompt(!!near);
    if (inp.interactQueued && near) this.tapes.tryCollect();

    // ---- entity ----
    p0 = performance.now();
    this.entitySnap = this.entity.update(dt, {
      pos: this.player.pos, eyeY: this.player.eyeY, fwd: this.player.forward,
      sprinting: this.player.sprinting, moving: this.player.moving,
      lightOn: this.flashlight.on,
    }, time);
    this.profMark('entity', p0);
    const snap = this.entitySnap;

    // The character. Detection state is the single source of truth: the same
    // snapshot drives the mesh's pose, the fear/static system and the audio, so
    // they cannot disagree about what the entity is doing.
    this.entityGaze.set(this.player.pos.x, this.player.eyeY, this.player.pos.z);
    this.entityWind.set(
      this.windDir.x * this.lastWind, 0, this.windDir.z * this.lastWind);
    this.rig.update(dt, time, {
      x: snap.x, y: snap.y, z: snap.z,
      yaw: this.entity.yaw,
      speed: snap.speed,
      state: ANIM_STATE[snap.state],
      detection: snap.detection,
      camera: this.player.camera.position,
      // It only tracks the player when it actually perceives them; otherwise it
      // faces its travel direction and the head stays level.
      gaze: snap.detection > 0.08 ? this.entityGaze : null,
      gazeWeight: Math.min(1, snap.detection * 1.6),
      groundAt: this.groundAt,
      wind: this.entityWind,
      wetness: this.weather.wetness,
      tapes: this.tapes.collected,
      tapesTotal: this.tapes.total,
      extensionRequest: snap.extensionRequest || this.forceExtension,
      // QA override: the forced beat has to bypass the milestone gate too, or a
      // test would have to collect six tapes before it could check the animation.
      forceEligible: this.forceExtension,
      rand: this.entityRand,
      // Streaming budget: generous while far (the player cannot see the seam of a
      // texture swap), tight when close so a swap can never cost a visible hitch.
      streamBudgetMs: snap.distToPlayer > 40 ? 3.5 : 1.0,
    });
    this.profMark('rig', p0);
    // One-shot: consumed by exactly one frame so a forced beat cannot latch on.
    this.forceExtension = false;

    // ---- optional proximity tell ----
    // Reads the same authoritative snapshot as everything else, so the warning
    // can never disagree with what the entity is actually doing. Self-gating on
    // mode, so `off` costs one comparison. `explicit` presents a dial; `subtle`
    // stays silent here and instead leaks into the static level below.
    const tellState = this.tell.update(
      dt, snap, this.player.pos.x, this.player.pos.z,
      this.player.forward.x, this.player.forward.z);
    if (this.tell.mode === 'explicit') this.menu.setProximityTell(tellState);

    // ---- fear / static ----
    p0 = performance.now();
    this.fear.update(dt, snap.detection, snap.visibleToPlayer, snap.distToPlayer);
    this.profMark('fear', p0);

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
    this.lastWind = wind;
    const wTime = time * 0.05;
    this.windDir.x = Math.cos(wTime) * 0.8 + 0.2;
    this.windDir.z = Math.sin(wTime * 0.7) * 0.8 + 0.2;
    updateWind({ strength: wind, dirX: this.windDir.x, dirZ: this.windDir.z, time });
    p0 = performance.now();
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
    this.profMark('env', p0);

    // ---- audio bed ----
    // The ambience is not a global loop with a wind knob; it is a *reading of
    // the place the listener is standing in*. Every environmental term below
    // comes from the same zone field the scatter system used, so a marsh sounds
    // like reeds and open water, the ravine sounds like moving water under a
    // closed canopy, and the blight sounds conspicuously dead.
    const px = this.player.pos.x, pz = this.player.pos.z;
    p0 = performance.now();
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
    this.profMark('audio', p0);

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
    p0 = performance.now();
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
        this.entityPerfLine() +
        this.audioPerfLine());
    }
    this.profMark('hud', p0);

    // ---- static overlay state for composite ----
    // `subtle` mode folds its warning in here rather than drawing anything: the
    // tape veil simply starts reacting a little earlier than it otherwise would.
    // Returns 0 in the other two modes, so this stays a single unconditional add.
    this.staticState.level =
      Math.min(1, this.fear.staticLevel + this.vfWeight * 0.12 + this.tell.staticBoost());
    this.staticState.glimpse = this.fear.glimpse;
    this.staticState.desat = this.fear.desat;
    this.staticState.time = time;
    this.staticState.viewfinder = this.vfWeight;

    // ---- win check: reach the fire road ----
    const ex = this.hf.layout.exit;
    if (Math.hypot(this.player.pos.x - ex.x, this.player.pos.z - ex.z) < 7) this.escape();
  }

  /**
   * Character block of the F3 overlay.
   *
   * The two numbers that matter for the quality gates are `foot` (residual foot
   * IK error \u2014 anything above a centimetre or so is a visible floating-foot
   * artefact) and `ext` (extension beat count, which must stay very low across a
   * whole run). `fade` exposes the LOD cross-fade weights so a pop can be caught
   * as a discontinuity rather than hunted by eye.
   */
  private entityPerfLine(): string {
    const d = this.rig.debug() as Record<string, number | string | boolean | number[]>;
    const fade = (d.fade as number[]).map(v => v.toFixed(2)).join('/');
    return `PB lod${d.lod} ${fade}  tris ${((d.tris as number) / 1000).toFixed(1)}k  `
      + `tex ${d.texture}${d.streaming ? '\u2191' : ''}\n`
      + `   foot ${((d.footError as number) * 1000).toFixed(1)}mm  `
      + `swing ${d.swing}  ext ${d.extensionCount}${d.extension ? ' LIVE' : ''}\n`;
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
    // While background warmup runs, skip the loop's renders entirely: the
    // first pipeline.render() is what compiles every post program, and letting
    // it happen inside a normal frame stalls the just-appeared title screen
    // for seconds. Warmup does those compiles itself (direct pipeline calls).
    if (!this.pipeline || this.warmupPromise) return;
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
      // per-stage update cost (EMA ms): player/tapes/entity/rig/fear/env/audio/hud
      prof: () => ({ ...this.prof }),
      // deep subsystem profiler: wraps audio + rig subsystem update()s with
      // EMA timers at runtime (no source changes to those modules). Idempotent.
      subProf: () => {
        const wrap = (obj: any, key: string, store: Record<string, number>, label: string) => {
          if (!obj || typeof obj.update !== 'function') return;
          if (store[label] !== undefined) return;
          const orig = obj.update.bind(obj);
          store[label] = 0;
          obj.update = (...a: unknown[]) => {
            const t0 = performance.now();
            (orig as any)(...a);
            const d = performance.now() - t0;
            store[label] += (d - store[label]) * 0.05;
          };
        };
        const store: Record<string, number> = ((this as any).__subProf ||= {});
        const ae = this.audio as any;
        wrap(ae.director, 'update', store, 'a:director');
        wrap(ae.player, 'update', store, 'a:player');
        wrap(ae.entity, 'update', store, 'a:entity');
        wrap(ae.ambience, 'update', store, 'a:ambience');
        wrap(ae.spatial, 'update', store, 'a:spatial');
        const rig = this.rig as any;
        wrap(rig.animator, 'update', store, 'r:animator');
        wrap(rig.cloth, 'update', store, 'r:cloth');
        wrap(rig.lod, 'update', store, 'r:lod');
        if (rig.materials && typeof rig.materials.streamStep === 'function' && store['r:stream'] === undefined) {
          const orig = rig.materials.streamStep.bind(rig.materials);
          store['r:stream'] = 0;
          rig.materials.streamStep = (b: number) => {
            const t0 = performance.now();
            orig(b);
            const d = performance.now() - t0;
            store['r:stream'] += (d - store['r:stream']) * 0.05;
          };
        }
        return { ...store };
      },
      // scene-graph census: bucket every geometry by owning-object name /
      // constructor so a stability run can diff two snapshots and name the
      // exact object class that is leaking (info.memory only gives a count).
      sceneStats: () => {
        const buckets: Record<string, number> = {};
        this.scene.traverse(o => {
          const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
          if (!g) return;
          const key = o.name || o.type || 'anon';
          buckets[key] = (buckets[key] || 0) + 1;
        });
        return buckets;
      },
      bootTimes: () => ({ ...this.bootTimes }),
      warp: (x: number, z: number) => {
        this.player.pos.set(x, this.hf.heightAt(x, z), z);
        this.flashlight?.warp();
        this.pipeline.invalidateHistory();
      },
      start: () => this.startRun(),
      // Proximity tell: read the live state, and set the mode without going
      // through the settings screen so a test can exercise all three positions.
      tell: () => ({ mode: this.tell.mode, ...this.tell.current, boost: this.tell.staticBoost() }),
      setTell: (m: 'off' | 'subtle' | 'explicit') => {
        this.settings.proximityTell = m;
        this.applySettings(this.settings);
      },
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

      // ---- character (brief §10 gates 2, 3, 8, 9) ----------------------------
      // LOD fade weights, residual foot-IK error, cloth swing and the extension
      // counter. The suite asserts against these because none of them are
      // observable from a screenshot: a 3 mm floating foot and a correct plant
      // look identical at test resolution, and LOD popping is a *discontinuity*
      // in the fade weights rather than anything a single frame can show.
      palebark: () => this.rig.debug(),
      /** force the reach beat next frame, for gate #9 verification */
      forceExtension: () => { this.forceExtension = true; },
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
      /**
       * Tear the audio graph down and close the AudioContext.
       *
       * Needed by the test harness on headless Linux CI: the browser has no
       * sound card, so Chromium's audio service falls back to ALSA, finds
       * nothing that can consume samples, and its render callback then times
       * out indefinitely ("SyncReader::Read timed out"). An output stream left
       * open at that point wedges browser teardown, and the run dies on
       * `browserContext.close: Test ended.` — after the test body has already
       * passed. Closing the context releases the stream so teardown completes.
       *
       * Harmless in production; nothing calls it outside the debug API.
       */
      /**
       * Render only every Nth frame while keeping simulation at full rate.
       *
       * Used by the audio suite on headless CI: SwiftShader saturates both
       * cores of a 2-core runner, starving Chromium's audio render thread until
       * its output stream wedges. Audio tests assert on Director state and
       * AnalyserNode meters, never on pixels, so dropping render frames costs
       * them nothing and keeps the audio thread scheduled.
       */
      renderThrottle: (n: number) => { this.loop.renderSkip = Math.max(1, Math.floor(n)); },
      audioShutdown: async () => {
        // Stop rendering FIRST. On a 2-core CI box SwiftShader saturates both
        // cores, which is what starves the audio render thread in the first
        // place; if the loop keeps running, the audio thread never gets
        // scheduled long enough to finish closing its stream.
        this.loop.paused = true;
        this.audio.dispose();
        // Give the (now unblocked) audio thread time to release the device.
        await new Promise<void>(r => setTimeout(r, 400));
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
