/**
 * AudioEngine — the single façade the game talks to.
 *
 * Everything below this line is subsystem detail; `main.ts` should never need to
 * know that a Director or a voice pool exists. This class:
 *
 *   • owns the bus graph, toolkit, spatial field, Director, and the player /
 *     entity / ambience layers, and keeps their lifetimes in step;
 *   • presents a superset of the old SynthEngine API so the call sites in
 *     main.ts keep working while gaining the new behaviour;
 *   • translates *game state* into *audio state* once per frame in `update()`,
 *     which is the only place that mapping is allowed to live;
 *   • exposes a `debug()` snapshot for the F3/F4 overlay and the Playwright
 *     assertions in §13, and `cue` captions for §11 accessibility.
 *
 * Ordering inside update() is deliberate and load-bearing:
 *   listener → space probe → Director → ambience → entity → player → duck
 * The Director must run before the layers so they all see the same tension and
 * silence values in the same frame; the duck is computed last because it is a
 * function of what the entity layer actually ended up doing.
 */

import { SeededRandom } from '../core/SeededRandom';
import type { AudioSettings } from '../core/Config';
import { AudioBuses, type BusId, type BusMeter } from './AudioBuses';
import { DreadToolkit } from './DreadToolkit';
import { SpatialAudio, type OcclusionProbe } from './Spatial';
import { AudioDirector, type DirectorState, type EntityPhase } from './Director';
import { PlayerAudio, type Surface } from './PlayerAudio';
import { EntityAudio } from './EntityAudio';
import { Ambience, type AmbienceEnv } from './Ambience';

export type { Surface } from './PlayerAudio';

/** Everything the engine needs from the game, once per frame. */
export interface AudioFrame {
  /** listener */
  x: number; y: number; z: number;
  fx: number; fy: number; fz: number;
  /** player body state */
  moving: boolean; sprinting: boolean; crouched: boolean; stamina: number;
  /** psychological + AI state */
  fear: number; detection: number;
  entityState: EntityPhase;
  entityX: number; entityY: number; entityZ: number;
  entityVisible: boolean; entityDist: number; entitySpeed: number;
  /** progression */
  tapes: number; runTime: number;
  /** environment (from ZoneSystem / weather / HeightField) */
  wind: number; canopyClosure: number; wetness: number; reedDensity: number;
  deadfallDensity: number; creekDist: number; lakeDist: number;
  openness: number; enclosed: boolean; inOpen: boolean;
}

/** A caption the HUD should show for players who can't rely on audio (§11). */
export interface AudioCue {
  text: string;
  /** seconds remaining */
  ttl: number;
  kind: 'approach' | 'sighting' | 'ambient' | 'escalation';
}

export class AudioEngine {
  private buses: AudioBuses;
  private kit: DreadToolkit;
  private spatial: SpatialAudio;
  private director: AudioDirector;
  private player: PlayerAudio;
  private entity: EntityAudio;
  private ambience: Ambience;
  private rng: SeededRandom;

  private settings: AudioSettings;
  private seed = 0x5747;
  private running = false;
  private initialised = false;
  private isMobile: boolean;

  private spaceTimer = 0;
  private irTimer = 0;
  private cueList: AudioCue[] = [];
  private lastPhase: EntityPhase = 'dormant';

  /** Trigger log — §13 asserts against this to prove buses fired. */
  readonly triggerLog: { t: number; event: string; bus: BusId }[] = [];

  constructor(settings: AudioSettings, isMobile = false) {
    this.settings = settings;
    this.isMobile = isMobile;
    this.buses = new AudioBuses(settings);
    this.kit = new DreadToolkit(this.buses, this.seed);
    this.spatial = new SpatialAudio(this.buses, isMobile);
    this.director = new AudioDirector(this.buses, this.kit, this.seed);
    this.player = new PlayerAudio(this.buses, this.kit, this.seed);
    this.entity = new EntityAudio(this.buses, this.kit, this.spatial, this.director, this.seed);
    this.ambience = new Ambience(this.buses, this.kit, this.spatial, this.seed);
    this.rng = new SeededRandom(this.seed ^ 0x7A1D);

    // Escalation and cut-to-quiet are the two moments a hearing player gets a
    // strong signal, so they are also the two that need captions.
    this.director.onEscalation = (kind) => {
      this.pushCue(kind === 'riser' ? 'The air is rising' : 'A low pressure builds', 'escalation', 3.2);
    };
  }

  // ─────────────────────────────── lifecycle ──────────────────────────────────

  /** Safe to call repeatedly and outside a user gesture. */
  init(): void {
    if (this.initialised) return;
    if (!this.buses.init()) return;
    this.initialised = true;
    this.spatial.warm();                       // pre-allocate the voice pool now, not mid-run
    this.buses.applySettings(this.settings);
    this.buses.setNightMode(this.settings.nightMode);
    // Give the world a plausible default reverb before the first probe lands.
    const ir = this.kit.makeImpulseResponse({ seconds: 2.2, openness: 0.5, absorption: 0.5 });
    if (ir) this.buses.setImpulseResponse(ir);
  }

  /** Called on the first real gesture. Never awaited by the caller (§2). */
  resume(): void {
    this.init();
    void this.buses.unlock();
  }

  suspend(): void { this.buses.suspend(); }

  setProbe(p: OcclusionProbe): void { this.spatial.setProbe(p); }

  /** Begin a run. Reseeds every subsystem so a seeded run is reproducible. */
  startRun(seed: number): void {
    this.init();
    this.seed = seed >>> 0;
    this.kit.reseed(this.seed);
    this.kit.clearIrCache();
    this.rng = new SeededRandom((this.seed ^ 0x7A1D) >>> 0);
    this.spatial.reset();
    this.player.reset(this.seed);
    this.entity.reset(this.seed);
    this.director.begin(this.seed);
    this.ambience.begin(this.seed);
    this.player.init();
    this.triggerLog.length = 0;
    this.cueList.length = 0;
    this.lastPhase = 'dormant';
    this.running = true;
  }

  endRun(): void {
    this.running = false;
    this.director.stopAll(1.2);
    this.ambience.stop(1.2);
    this.entity.stopLayers(0.8);
  }

  applySettings(s: AudioSettings): void {
    this.settings = s;
    if (!this.initialised) return;
    this.buses.applySettings(s);
    this.buses.setNightMode(s.nightMode);
  }

  /** Legacy shim: the old single master slider. */
  setVolume(v: number): void {
    this.settings = { ...this.settings, master: v };
    if (this.initialised) this.buses.applySettings(this.settings);
  }

  // ──────────────────────────────── per frame ─────────────────────────────────

  update(dt: number, f: AudioFrame): void {
    if (!this.running || !this.buses.ready) return;
    this.spatial.tick(dt);

    // 1. Listener. Must come first — every voice's pan/attenuation this frame
    //    is computed against it.
    this.spatial.setListener(f.x, f.y, f.z, f.fx, f.fy, f.fz);

    // 2. Space probing, on a slow cadence. Raycasting the surroundings every
    //    frame would be wasteful and the reverb cannot change that fast anyway.
    this.spaceTimer += dt;
    if (this.spaceTimer >= 0.5) {
      this.spaceTimer = 0;
      this.spatial.probeSpace();
    }
    this.irTimer += dt;
    if (this.irTimer >= 2.0) {
      this.irTimer = 0;
      this.spatial.syncReverb((openness, absorption) =>
        this.kit.makeImpulseResponse({ seconds: 1.2 + openness * 2.4, openness, absorption }));
    }

    // 3. Director. Everything downstream reads its output, so it runs before
    //    any layer is touched.
    this.director.update(dt, {
      entityState: f.entityState,
      detection: f.detection,
      fear: f.fear,
      distToEntity: f.entityDist,
      entityVisible: f.entityVisible,
      tapes: f.tapes,
      runTime: f.runTime,
      sprinting: f.sprinting,
      inOpen: f.inOpen,
      openness: f.openness,
    });
    const silence = this.director.silenceAmount;
    const tension = this.director.tensionAmount;

    // 4. Ambience.
    const env: AmbienceEnv = {
      x: f.x, y: f.y, z: f.z,
      canopyClosure: f.canopyClosure,
      wetness: f.wetness,
      reedDensity: f.reedDensity,
      deadfallDensity: f.deadfallDensity,
      creekDist: f.creekDist,
      lakeDist: f.lakeDist,
      wind: f.wind,
      rain: false,                            // owned by setRain()
      silence, tension,
      enclosed: f.enclosed,
    };
    this.ambience.update(dt, env);

    // 5. Entity.
    this.entity.update(dt, {
      state: f.entityState,
      detection: f.detection,
      x: f.entityX, y: f.entityY, z: f.entityZ,
      distToPlayer: f.entityDist,
      visibleToPlayer: f.entityVisible,
      speed: f.entitySpeed,
      silence,
    });

    // A state escalation is information the player must not miss.
    if (f.entityState !== this.lastPhase) {
      if (f.entityState === 'stalking') this.pushCue('Something is following', 'approach', 4);
      else if (f.entityState === 'confronting') this.pushCue('It is here', 'approach', 4);
      this.lastPhase = f.entityState;
    }
    // Close-range cue captioning, set by EntityAudio.distantCue.
    if (this.entity.approachCueFired) {
      this.entity.approachCueFired = false;
      this.pushCue('Something is approaching', 'approach', 3);
    }

    // 6. Player body.
    this.player.update(dt, {
      moving: f.moving, sprinting: f.sprinting, crouched: f.crouched,
      stamina: f.stamina, fear: f.fear, detection: f.detection, silence,
    });

    // 7. Duck. Computed from what the entity layer actually produced, so the
    //    ambience only gets out of the way when there is genuinely something to
    //    make room for.
    const presence = this.entity.snapshot().presence;
    this.buses.setDuck(Math.min(1, presence * 1.3 + tension * 0.35));

    // Age captions.
    for (let i = this.cueList.length - 1; i >= 0; i--) {
      this.cueList[i].ttl -= dt;
      if (this.cueList[i].ttl <= 0) this.cueList.splice(i, 1);
    }
  }

  // ──────────────────────────── discrete game events ──────────────────────────

  footstep(surface: Surface, intensity: number): void {
    this.player.footstep(surface, intensity, false, this.director.silenceAmount);
    this.log('footstep', 'foley');
  }

  vault(): void { this.player.vault(); this.log('vault', 'foley'); }
  flashlightClick(on: boolean): void { this.player.flashlightClick(on); this.log('flashlight', 'foley'); }
  exhausted(): void { this.player.exhausted(); }

  /**
   * The entity made a noise somewhere. `dist` is the true distance; EntityAudio
   * applies its own positional error so this cannot be used as a locator.
   */
  entityCue(dist: number, kind?: 'snap' | 'footfall' | 'shift' | 'call', x?: number, y?: number, z?: number): void {
    // If the caller doesn't know where, place it on a ring at the right radius —
    // still better than centring it on the listener.
    const ang = this.rng.range(0, Math.PI * 2);
    const ex = x ?? Math.cos(ang) * dist;
    const ez = z ?? Math.sin(ang) * dist;
    this.entity.distantCue(ex, y ?? 1.4, ez, dist, kind);
    this.log('entityCue', 'entity');
  }

  sighting(dist: number): void {
    this.entity.sightingSting(dist);
    this.pushCue('You saw it', 'sighting', 2.4);
    this.log('sighting', 'entity');
  }

  /** Returns the sequence length in seconds so the visual can be matched to it. */
  captureSting(): number {
    const len = this.entity.captureSequence();
    this.ambience.stop(0.5);
    this.log('capture', 'entity');
    return len;
  }

  uiClick(): void {
    const ctx = this.buses.ctx;
    if (!ctx) return;
    // Short, dry, non-musical: a UI click that has a pitch becomes a melody as
    // the player navigates menus, which is a distraction.
    const t = ctx.currentTime;
    const src = this.kit.noiseSource(0.15, 0.2);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900 + this.rng.range(-260, 260);
    bp.Q.value = 2.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    src.connect(bp); bp.connect(g); g.connect(this.buses.bus('ui'));
    setTimeout(() => {
      try { src.stop?.(); } catch { /* ignore */ }
      src.disconnect(); bp.disconnect(); g.disconnect();
    }, 260);
    this.log('uiClick', 'ui');
  }

  batteryWarning(): void {
    const ctx = this.buses.ctx;
    if (!ctx) return;
    // Two soft blips on the UI bus. Not alarming — it is a torch, not a bomb.
    const t = ctx.currentTime;
    for (let i = 0; i < 2; i++) {
      const at = t + i * 0.17;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = 1180 - i * 90;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.075, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.1);
      o.connect(g); g.connect(this.buses.bus('ui'));
      o.start(at); o.stop(at + 0.13);
      setTimeout(() => g.disconnect(), 700);
    }
    this.pushCue('Battery low', 'ambient', 2.6);
    this.log('batteryWarning', 'ui');
  }

  tapePickup(): void {
    const ctx = this.buses.ctx;
    if (!ctx) return;
    // Mechanical: a plastic shell handled, plus the cassette's internal rattle.
    const t = ctx.currentTime;
    const src = this.kit.noiseSource(0.3, 0.35);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 1.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    src.connect(bp); bp.connect(g); g.connect(this.buses.bus('foley'));
    setTimeout(() => {
      try { src.stop?.(); } catch { /* ignore */ }
      src.disconnect(); bp.disconnect(); g.disconnect();
    }, 700);
    for (let i = 0; i < 3; i++) {
      const at = t + 0.02 + this.rng.range(0, 0.11);
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = this.rng.range(320, 760);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, at);
      cg.gain.exponentialRampToValueAtTime(0.045, at + 0.002);
      cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
      o.connect(cg); cg.connect(this.buses.bus('foley'));
      o.start(at); o.stop(at + 0.05);
      setTimeout(() => cg.disconnect(), 700);
    }
    this.log('tapePickup', 'foley');
  }

  /**
   * A tape log is playing. This is *not* a music cue — it is a degraded
   * recording, so it gets its own thin band-limited noise floor and nothing else.
   * The actual words are subtitles; the audio only has to feel like tape.
   */
  tapeVoice(duration: number): void {
    const ctx = this.buses.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const src = this.kit.noiseSource(0.55, 0.25);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 260;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3400; lp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.4);
    g.gain.setValueAtTime(0.07, t + Math.max(0.6, duration - 0.6));
    g.gain.linearRampToValueAtTime(0.0001, t + duration);
    // Slow wow/flutter on the noise floor's brightness sells the mechanism.
    const wow = ctx.createOscillator();
    wow.frequency.value = 0.6;
    const wowAmt = ctx.createGain(); wowAmt.gain.value = 500;
    wow.connect(wowAmt).connect(lp.frequency);
    wow.start(t); wow.stop(t + duration + 0.2);
    src.connect(hp); hp.connect(lp); lp.connect(g); g.connect(this.buses.bus('ui'));
    setTimeout(() => {
      try { src.stop?.(); } catch { /* ignore */ }
      src.disconnect(); hp.disconnect(); lp.disconnect(); g.disconnect(); wowAmt.disconnect();
    }, (duration + 0.6) * 1000);
    this.log('tapeVoice', 'ui');
  }

  setRain(on: boolean): void { this.ambience.setRain(on); }

  /** Legacy shim retained for call-site compatibility. */
  setFearLevel(_f: number): void { /* fear now flows through update() */ }
  owl(): void { this.entityCue(this.rng.range(40, 90), 'call'); }
  creak(): void { /* creaks are scheduled by Ambience; kept for API parity */ }

  // ────────────────────────────── introspection ───────────────────────────────

  /** Captions the HUD should currently render (§11 quality gate 9). */
  get cues(): readonly AudioCue[] { return this.cueList; }

  private pushCue(text: string, kind: AudioCue['kind'], ttl: number): void {
    if (!this.settings.audioCues) return;
    // Don't stack duplicates — a caption that flickers is worse than none.
    const existing = this.cueList.find(c => c.text === text);
    if (existing) { existing.ttl = Math.max(existing.ttl, ttl); return; }
    this.cueList.push({ text, kind, ttl });
    if (this.cueList.length > 3) this.cueList.shift();
  }

  private log(event: string, bus: BusId): void {
    this.triggerLog.push({ t: this.buses.now, event, bus });
    if (this.triggerLog.length > 400) this.triggerLog.shift();
  }

  get state(): string { return this.buses.state; }
  get directorState(): DirectorState { return this.director.snapshot(); }
  meterMaster(): BusMeter { return this.buses.meterMaster(); }
  meterBus(id: BusId): BusMeter { return this.buses.meterBus(id); }

  /** One object with everything a debug overlay or a test could want. */
  debug(): Record<string, unknown> {
    const d = this.director.snapshot();
    return {
      ctx: this.buses.state,
      worklet: this.buses.hasWorklet,
      lowFreq: this.buses.lowFreqScale,
      nightMode: this.settings.nightMode,
      act: d.act,
      tension: +d.tension.toFixed(3),
      silence: +d.silence.toFixed(3),
      silenceSeconds: +d.silenceSeconds.toFixed(1),
      layers: d.layers,
      sub: +d.sub.toFixed(3),
      cluster: +d.cluster.toFixed(3),
      riser: +d.riser.toFixed(3),
      spends: d.spends,
      reason: d.reason,
      peakTension: +this.director.peakTension.toFixed(3),
      actTrace: this.director.actTrace,
      voices: this.spatial.activeVoices,
      poolSize: this.spatial.poolSize,
      dropped: this.spatial.droppedVoices,
      duck: +this.buses.duck.toFixed(3),
      master: this.buses.meterMaster(),
      buses: {
        ambience: this.buses.meterBus('ambience'),
        entity: this.buses.meterBus('entity'),
        foley: this.buses.meterBus('foley'),
        ui: this.buses.meterBus('ui'),
      },
      ambience: this.ambience.snapshot(),
      entity: this.entity.snapshot(),
      heart: +this.player.heartLevel.toFixed(3),
      space: this.spatial.space,
      irKey: this.spatial.irKey,
      triggers: this.triggerLog.length,
      cues: this.cueList.map(c => c.text),
    };
  }

  dispose(): void {
    this.endRun();
    this.entity.dispose();
    this.buses.dispose();
    this.initialised = false;
  }
}
