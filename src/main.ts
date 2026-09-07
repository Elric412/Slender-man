import * as THREE from 'three';
import { GameLoop } from './core/GameLoop';
import { Input, InputFrame } from './core/Input';
import { loadSettings, probeQuality, probeRenderer, QUALITY_SPECS, QualitySpec, Settings } from './core/Config';
import { HeightField } from './world/HeightField';
import { MaterialLibrary } from './world/MaterialLibrary';
import { MapGenerator } from './world/MapGenerator';
import { practicalPoolFor } from './world/Landmarks';
import { updateWind } from './world/VegetationSystem';
import { CollisionWorld } from './physics/Collision';
import { NavWorld } from './ai/NavWorld';
import { EntityBrain, EntitySnapshot } from './ai/EntityBrain';
import { RenderPipeline, StaticState } from './render/RenderPipeline';
import { EnvironmentProbe } from './render/EnvironmentProbe';
import { Sky } from './render/Sky';
import { NightLighting } from './render/NightLighting';
import { ShadowQuality, SHADOW_BUDGETS } from './render/ShadowQuality';
import { Player } from './game/Player';
import { Flashlight } from './game/Flashlight';
import { PalebarkEntity } from './entity/PalebarkEntity';
import type { AnimState } from './entity/PalebarkAnimator';
import { ProximityTell } from './world/ProximityTell';
import { HorrorProgression } from './horror/HorrorProgression';
import { ThreatModel, type ThreatInput } from './horror/ThreatModel';
import { PlayerBehaviorModel, type BehaviorSample } from './horror/PlayerBehaviorModel';
import { HorrorDirector, type DirectorInput } from './horror/HorrorDirector';
import {
  EncounterDirector, type CueRequest, type SightingRequest,
  type WorldProbe, type PlayerProbe,
} from './horror/EncounterDirector';
import { TapeSystem, TAPE_LOGS } from './game/TapeSystem';
import { Effects } from './game/Effects';
import { AudioEngine } from './audio/AudioEngine';
import { ZoneSystem } from './world/ZoneSystem';
import { Cartography } from './world/Cartography';
import { SurveyMap } from './ui/SurveyMap';
import { SeededRandom } from './core/SeededRandom';
import { Menu } from './ui/Menu';
import { gpuCaps } from './engine/GpuCaps';
import { PerfGovernor, type QualityKnobs } from './engine/PerfGovernor';
import { Scheduler } from './engine/Scheduler';
import { Perceptibility, type PerceptInput } from './engine/Perceptibility';

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

  // ---- engine layer ---------------------------------------------------------
  /**
   * Frame-cost telemetry and the continuous quality scalar.
   *
   * This replaces the previous arrangement, in which four separate stores held
   * performance state that none of them could see: `GameLoop.samples`,
   * `RenderPipeline.gpuStats` plus its private `frameCostEma`, this class's `prof`
   * map, and `bootTimes`. The one component that acted on any of it —
   * `RenderPipeline.adaptResolution()` — watched *CPU* frame time and responded by
   * reducing *internal resolution*, so a frame made long by an A* repath (0.50 ms
   * per query, measured) or a 1M-vertex chunk merge cost image quality and returned
   * nothing. The governor attributes cost before it chooses a knob.
   */
  private gov = new PerfGovernor();
  /**
   * Cadence scheduling and admission control.
   *
   * Everything used to run every frame in registration order, so a 144 Hz display did
   * 2.4x the AI and audio work of a 60 Hz one for no gameplay benefit, and nothing
   * arbitrated between a repath, a chunk merge and a texture-streaming step landing on
   * the same frame.
   */
  private sched = new Scheduler();
  /**
   * The perceptibility field — see `src/engine/Perceptibility.ts`.
   *
   * STATIC's own art direction (a 62 m cone in near-total darkness, plus a composite
   * that deliberately destroys detail harder as fear rises) means a large fraction of
   * every frame is rendered at full effort and then discarded. This turns that into a
   * budget instead of a cost.
   */
  private percept = new Perceptibility();
  /** Last knobs pushed, so we only touch subsystems when something actually changed. */
  private knobs: QualityKnobs | null = null;
  /** Accumulated time owed to the AI brain since its last tick. */
  private aiAcc = 0;
  /** Accumulated time owed to the practicals update since its last tick. */
  private practicalAcc = 0;
  /** Reused perceptibility input — this is a per-frame path, so it must not allocate. */
  private perceptIn: PerceptInput = {
    beamOn: false, beamStrength: 0, staticLevel: 0, desat: 0.2, viewfinder: 0,
    exposure: 1, canopy: 0, moon: 1, entityDistance: 999, entityVisible: false,
    speed: 0, rain: 0,
  };

  private hf!: HeightField;
  private zones!: ZoneSystem;
  private mats!: MaterialLibrary;
  private col!: CollisionWorld;
  private map!: MapGenerator;
  private nav!: NavWorld;
  private sky!: Sky;
  /** Single owner for night key/fill/bounce energy. */
  private night!: NightLighting;
  /** Single owner for moon/beam shadow geometry, bias and refresh cadence. */
  private shadows = new ShadowQuality();
  /** Aliases retained for existing pipeline/debug consumers; NightLighting owns them. */
  private moon!: THREE.DirectionalLight;
  private hemi!: THREE.HemisphereLight;
  private player!: Player;
  private flashlight!: Flashlight;
  private entity!: EntityBrain;
  private rig!: PalebarkEntity;
  /**
   * The horror stack, in dependency order.
   *
   * These modules existed but were entirely unreachable: `EncounterDirector` is
   * the root of the graph and nothing imported it, so `HorrorDirector`,
   * `ThreatModel`, `EncounterMemory` and `PlayerBehaviorModel` were all dead
   * code. Worse, `EntityBrain` had already been rewritten to *consume* them, and
   * with nobody calling `setProgression`/`setDirective`/`setBehaviour`/
   * `setPredictionTargets` it ran on its constructor defaults: a frozen
   * `pressure: 0.3`, a fabricated average player, and an empty landmark list, so
   * `prog` stayed the snapshot taken at construction. The entity was locked in
   * act 0 with `confrontationUnlocked` false for the whole run — the escalation
   * arc could never fire, and route prediction had nothing to snap to.
   *
   *   progression  owns the act arc (tapes + elapsed time). One authority.
   *   behaviour    rolling model of how this player actually plays.
   *   threat       splits "how dangerous is this" from "how afraid am I".
   *   director     tension phases; publishes the brain's directive.
   *   encounters   decides when a beat may fire, and refuses most of them.
   */
  private progression = new HorrorProgression(Object.keys(TAPE_LOGS).length);
  private behaviour = new PlayerBehaviorModel();
  /**
   * Replaces `FearSystem`.
   *
   * Deliberately API-compatible with it — `value`, `staticLevel`, `desat`,
   * `tremor`, `glimpse` all carry the same meaning and range — so the wind, fog,
   * exposure grade, camera tremor and static overlay keep reading a scalar and
   * did not have to be rewritten. The difference is upstream: dread is now
   * derived from a threat model that separates real danger from felt danger,
   * which is the whole point of a horror game where the entity is usually
   * absent.
   */
  private fear = new ThreatModel();
  /**
   * Reused `ThreatInput`. Pre-allocated because it is filled every frame, and
   * AGENTS.md forbids per-frame allocation in the hot loop; `progression` is a
   * reference to the progression system's own snapshot, not a copy.
   */
  private threatIn: ThreatInput = {
    entityDistance: 999, detection: 0, entityHasLos: false, entityVisible: false,
    intentDanger: 0, intercepting: false, knowledgeConfidence: 0, contactAge: 999,
    darkness: 0.5, exposure: 0.5, silence: 0, sprinting: false, lightOn: false,
    battery: 1,
    progression: new HorrorProgression(Object.keys(TAPE_LOGS).length).snapshot,
  };
  private director = new HorrorDirector(WORLD_SEED);
  private encounters = new EncounterDirector(WORLD_SEED);
  /**
   * Reusable input structs for the director/behaviour/encounter ticks.
   *
   * Same reason as `threatIn` above: these are written every frame in the AI
   * hot path, and AGENTS.md forbids per-frame allocation there. Declared as
   * fields and mutated in place rather than rebuilt as object literals.
   */
  private dirIn: DirectorInput = {
    progression: new HorrorProgression(Object.keys(TAPE_LOGS).length).snapshot,
    threat: new ThreatModel().current,
    quietSeconds: 0, sinceSighting: 999, intentDanger: 0,
    entityVisible: false, knowledgeConfidence: 0, entityDistance: 999, exposure: 0.5,
  };
  private behSample: BehaviorSample = {
    x: 0, z: 0, yaw: 0, sprinting: false, moving: false, lightOn: false, trailDistance: 0,
  };
  /**
   * Uncollected objective positions, handed to the encounter director so a
   * `blocked` beat can aim at somewhere the player actually wants to go, and to
   * the brain so route prediction has real destinations to snap to.
   *
   * Rebuilt only when the tape count changes, not every frame — the set is
   * static between pickups.
   */
  private objectivePoints: { x: number; z: number }[] = [];
  /** Same set, in the shape `EntityBrain.setPredictionTargets` wants. */
  private predictionTargets: { x: number; z: number; id: string }[] = [];
  private objectivesForTapes = -1;
  /**
   * Read-only view of the world for the encounter director.
   *
   * A thin adapter rather than a copy: every method forwards straight to the
   * system that owns the answer, so the director cannot form a belief about the
   * terrain, cover or line of sight that disagrees with what the player is
   * standing in. Built lazily on first use because `hf`/`map`/`col` are all
   * created in `buildScene`, after field initialisers run.
   */
  private worldProbeCache: WorldProbe | null = null;
  private get worldProbe(): WorldProbe {
    if (!this.worldProbeCache) {
      this.worldProbeCache = {
        heightAt: (x, z) => this.hf.heightAt(x, z),
        losClear: (x0, y0, z0, x1, y1, z1) => this.col.losClear(x0, y0, z0, x1, y1, z1),
        coverAt: (x, z) => this.map.scatter.coverAt(x, z),
        trailDist: (x, z) => this.hf.trailDist(x, z),
        inLake: (x, z) => this.hf.inLake(x, z),
        worldHalf: this.hf.layout.size / 2,
      };
    }
    return this.worldProbeCache;
  }
  /** Reused so the per-frame encounter tick allocates nothing. */
  private playerProbeState: PlayerProbe = {
    x: 0, z: 0, eyeY: 1.62, fwdX: 0, fwdZ: 1, yaw: 0, moving: false, lightOn: false,
  };
  private playerProbe(): PlayerProbe {
    const p = this.playerProbeState;
    p.x = this.player.pos.x; p.z = this.player.pos.z;
    p.eyeY = this.player.eyeY;
    p.fwdX = this.player.forward.x; p.fwdZ = this.player.forward.z;
    p.yaw = this.player.yaw;
    p.moving = this.player.moving;
    p.lightOn = this.flashlight.on;
    return p;
  }
  /**
   * Optional proximity signalling. Off by default; the mode is pushed in from
   * settings rather than read here, so this object never touches localStorage.
   */
  private tell = new ProximityTell();
  private tapes!: TapeSystem;
  private effects!: Effects;
  /**
   * The player's knowledge of the forest, and the sheet that draws it.
   *
   * `carto` is the only mutable state the world and the map UI share, and the
   * renderer is handed nothing else — so the map cannot assert a landmark, trail
   * or discovery the world does not contain (brief: "avoid hardcoding UI
   * information that does not correspond to the world state").
   *
   * `survey` is optional because the canvas element may legitimately be absent
   * (a stripped host page, or a browser that refuses a 2D context); the game
   * must still be playable without a map, so every use site is guarded.
   */
  private carto!: Cartography;
  private survey: SurveyMap | null = null;
  /** true while the sheet is being read — gates redraw work to when it is visible */
  private mapOpen = false;
  /** survey accumulator: the reveal disc is stamped on a cadence, not per frame */
  private surveyAcc = 0;
  /** redraw accumulator: the 768² sheet is repainted at 10 Hz while open */
  private mapDrawAcc = 0;

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
  /** reused per-frame so the HUD audio-cue push allocates nothing (GC spikes
   *  show up as frame hitches; the caption list is at most 3 long) */
  private cueTexts: string[] = [];
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
    // Shadow refresh is scheduled PER LIGHT: the moon re-renders the whole merged
    // forest and only needs to when its texel-snapped window moves or a dynamic
    // caster is near (brief §1.6, §5.7), whereas the flashlight is camera-rigid and
    // must refresh every frame.
    //
    // `WebGLShadowMap.render()` has TWO independent gates:
    //
    //   1. global   `if (autoUpdate === false && needsUpdate === false) return;`
    //   2. per light `if (shadow.autoUpdate === false && shadow.needsUpdate === false) continue;`
    //
    // Only (2) can express selective scheduling. Clearing the GLOBAL flag returns
    // before the per-light loop is ever entered, so *no* map is rendered for *any*
    // light — and an unrendered map is not "no shadow". three binds its zero-filled
    // 1x1 placeholder, which unpacks to depth 0 and therefore reads as FULLY
    // OCCLUDED, silently zeroing both the moon key and the torch. That failure
    // presents as "the game is too dark", not as "shadows are broken", which is
    // exactly why it is worth this much comment: the global flag must stay ON and
    // scheduling belongs on each `light.shadow`.
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
    this.map = new MapGenerator(this.hf, this.mats, this.col, this.zones, WORLD_SEED, {
      atlasSize: this.spec.textureSize,
      anisotropy: this.spec.anisotropy,
      // Low tiers pull the LOD0 radius in and thin the ground-card layer rather
      // than reducing tree count: silhouette density is what carries the look,
      // so it is the last thing to cut.
      lodBias: this.spec.taa ? 0 : 1,
      floorDetail: this.spec.particleCount > 0 ? 1 : 0.4,
      densityScale: this.spec.drawDistance >= 200 ? 1 : 0.75,
      // How many warm practicals may be REAL lights at once. This is the only
      // practical-related number that costs shader time (the light count is
      // compiled into every material), so it is the quality dial. The visible
      // bulbs and glow cards are unaffected and stay on at every tier, which
      // is why a low-tier frame still has warm sources in it.
      practicalPool: practicalPoolFor(this.spec.tier),
    });
    await frame();
    this.bootMark('map');

    p(0.48, 'teaching it to walk…');
    this.nav = new NavWorld(this.hf, this.col);
    await frame();
    this.bootMark('nav');

    // The survey sheet. Built from the same layout the terrain, collision and nav
    // grid came from, so it is a projection of the world rather than a drawing of
    // it. The contour trace in SurveyMap is the expensive part and is cached on
    // first open, not here — boot is already the longest wait in the game.
    p(0.53, 'folding the survey sheet…');
    this.carto = new Cartography(this.hf);
    const mapCanvas = this.menu.mapCanvas;
    if (mapCanvas) {
      try {
        this.survey = new SurveyMap(mapCanvas, this.carto, this.hf);
      } catch (err) {
        // A missing 2D context is not fatal — the forest is navigable by its
        // landmarks, which is the primary navigation the brief asks for. Losing
        // the map is a degradation, not a failure.
        console.warn('[STATIC] survey map unavailable:', err);
        this.survey = null;
      }
    }
    await frame();
    this.bootMark('cartography');

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
    this.applyShadowQuality();
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

    // One photometric owner. Cloud/canopy/rain are collapsed into one budget
    // before it is split into moon key, sky fill and ground bounce.
    this.night = new NightLighting();
    this.night.addTo(this.scene);
    this.night.setMoonDirection(this.sky.moonDir);
    this.moon = this.night.moon;
    this.hemi = this.night.hemi;
    this.applyShadowQuality();

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
      this.night.setProbeActive(false);
      this.scene.environmentIntensity = 0;
      this.night.update(0, { moonDim: 1, transmission: 1, openness: 1, wetness: 0, warmth: 0 });
      return;
    }
    try {
      this.probe = new EnvironmentProbe(this.renderer, this.spec.tier === 'ultra' ? 256 : 128);
      this.sky.update(0);
      this.scene.environment = this.probe.capture(this.sky.mesh);
      this.night.setProbeActive(true);
      const nightLevels = this.night.update(0, {
        moonDim: 1, transmission: 1, openness: 1, wetness: 0, warmth: 0,
      });
      this.scene.environmentIntensity = nightLevels.fill;
      this.mats.setEnvIntensity(1);
    } catch (err) {
      console.warn('[STATIC] env probe unavailable, falling back to hemisphere fill', err);
      this.probe = null;
      this.night.setProbeActive(false);
      this.scene.environmentIntensity = 0;
      this.night.update(0, { moonDim: 1, transmission: 1, openness: 1, wetness: 0, warmth: 0 });
    }
  }

  /** Resolve a runtime shadow budget without trading away near-field texel density. */
  private resolvedShadowBudget() {
    const base = SHADOW_BUDGETS[this.spec.tier] ?? SHADOW_BUDGETS.high;
    const requested = this.knobs?.shadowMapSize ?? base.moonSize;
    const moonSize = Math.max(512, Math.min(base.moonSize, requested));
    const ratio = moonSize / base.moonSize;
    return {
      moonSize,
      beamSize: Math.max(512, Math.min(base.beamSize, moonSize)),
      moonExtent: Math.max(28, base.moonExtent * ratio),
    };
  }

  private applyShadowQuality(): void {
    if (!this.moon) return;
    const budget = this.resolvedShadowBudget();
    this.shadows.configureMoon(this.moon, budget);
    if (this.flashlight) {
      // SpotLight.distance is the flashlight's real photometric range. Keeping
      // the shadow camera tied to it prevents a duplicated magic distance.
      this.shadows.configureBeam(
        this.flashlight.light, budget.beamSize, this.flashlight.light.distance,
      );
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
      lean: 0, pauseQueued: false, mapQueued: false,
    }, 0);
    this.flashlight.on = true;
    this.flashlight.update(0.016, 0);
    this.pipeline.setBeam(this.flashlight.light, 1);
    this.effects.setRain(true);
    this.tapes.spawnAll(this.runSeed);
    await frame();
    // compileAsync uses KHR_parallel_shader_compile when the driver offers it,
    // so program linking overlaps instead of blocking one-by-one (big win on d