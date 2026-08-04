/**
 * Ambience — the forest itself. Brief §9.
 *
 * The hard rule this file exists to satisfy: **there is no ambient loop.**
 * A single looping bed is the fastest way to make a 15-minute run feel like a
 * 30-second asset, because the ear locks onto the loop point and then stops
 * listening entirely. Once the player stops listening, no amount of entity
 * design can scare them.
 *
 * So ambience here is built from independently-seeded, independently-scheduled
 * emitters:
 *
 *   BEDS   — continuous, slowly-evolving, non-cyclic layers (wind in canopy,
 *            insect field, water). Each is driven by free-running modulators or
 *            granular worklets, so no two moments are identical by construction.
 *   EVENTS — discrete, spatialised one-shots (branch creak, trunk groan, distant
 *            bird, twig settle, water plink, leaf fall). Each is scheduled off
 *            `AudioContext.currentTime` with a seeded interval, and each carries
 *            seeded variation in pitch, filter, envelope and world position.
 *
 * Zone awareness: the user's ZoneSystem gives us canopyClosure, wetness,
 * reedDensity, deadfallDensity and creek distance. These are exactly the
 * physical properties that determine what a place sounds like, so the ambience
 * reads them rather than guessing:
 *
 *   closed canopy   → wind is filtered, diffuse, high-passed less, and quieter
 *                     at ground level; more branch creak (there are branches).
 *   open / stormFall→ wind is brighter and stronger; fewer creaks, more air.
 *   high wetness    → water bed comes up, insect field thins, drips appear.
 *   near creek      → dedicated spatialised water emitter at the creek line.
 *   blight          → insects drop to near nothing. The absence is the tell.
 *
 * SILENCE BUDGET: the Director owns the tension arc, and this module *obeys*
 * its silence signal by pulling beds down and suspending event scheduling.
 * Genuine near-silence (quality gate 1) is produced here, not faked with a
 * quiet loop.
 */

import { SeededRandom } from '../core/SeededRandom';
import type { AudioBuses } from './AudioBuses';
import type { DreadToolkit, DroneHandle, GranularHandle } from './DreadToolkit';
import type { SpatialAudio } from './Spatial';

/** What the ambience needs to know about where the player is standing. */
export interface AmbienceEnv {
  x: number; y: number; z: number;
  /** 0..1 overhead canopy occlusion */
  canopyClosure: number;
  /** 0..1 ground moisture */
  wetness: number;
  /** 0..1 reed/marsh vegetation */
  reedDensity: number;
  /** 0..1 deadfall — drives creak likelihood */
  deadfallDensity: number;
  /** metres to the nearest flowing water centreline, Infinity if none */
  creekDist: number;
  /** metres to the lake edge, Infinity if none */
  lakeDist: number;
  /** 0..1 global wind strength from the weather sim */
  wind: number;
  /** true once rain has started */
  rain: boolean;
  /** 0..1 Director silence request — 1 means "get out of the way" */
  silence: number;
  /** 0..1 Director tension, used to bias event character, not volume */
  tension: number;
  /** true when indoors/tunnel — beds duck and reverb takes over */
  enclosed: boolean;
}

export interface AmbienceLevels {
  wind: number; insects: number; water: number; rain: number; air: number;
}

/** One scheduled discrete sound type. */
interface EventSlot {
  kind: 'creak' | 'groan' | 'bird' | 'settle' | 'drip' | 'leaf' | 'reed' | 'stone';
  /** seconds until next fire */
  next: number;
  /** [min,max] seconds between fires at full eligibility */
  interval: [number, number];
  /** priority handed to the voice pool */
  priority: number;
}

const BASE_SLOTS: Omit<EventSlot, 'next'>[] = [
  { kind: 'creak',  interval: [7, 26],  priority: 3 },
  { kind: 'groan',  interval: [22, 70], priority: 3 },
  { kind: 'bird',   interval: [30, 110], priority: 2 },
  { kind: 'settle', interval: [9, 34],  priority: 2 },
  { kind: 'drip',   interval: [4, 15],  priority: 2 },
  { kind: 'leaf',   interval: [6, 22],  priority: 1 },
  { kind: 'reed',   interval: [10, 30], priority: 2 },
  { kind: 'stone',  interval: [26, 90], priority: 2 },
];

export class Ambience {
  private rng: SeededRandom;
  /** Each emitter family gets its own stream so they cannot phase-lock. */
  private rngEvent: SeededRandom;
  private rngPlace: SeededRandom;

  private windBed: GranularHandle | null = null;
  private windLow: DroneHandle | null = null;
  private insectBed: GranularHandle | null = null;
  private waterBed: GranularHandle | null = null;
  private rainBed: GranularHandle | null = null;
  private airBed: GranularHandle | null = null;

  private slots: EventSlot[] = [];
  private started = false;
  private rainOn = false;

  /** Rolling levels, exposed for the debug overlay + tests. */
  readonly levels: AmbienceLevels = { wind: 0, insects: 0, water: 0, rain: 0, air: 0 };
  /** How many discrete events have fired this run, by kind. */
  readonly fired = new Map<string, number>();

  /**
   * Cliché guard for ambience: creaks/groans are the classic horror tell, and
   * firing them constantly makes them meaningless. This caps how many can land
   * in any 60s window regardless of the schedule.
   */
  private windowFires = 0;
  private windowTimer = 0;

  constructor(
    private buses: AudioBuses,
    private kit: DreadToolkit,
    private spatial: SpatialAudio,
    seed: number,
  ) {
    this.rng = new SeededRandom((seed ^ 0xA43B1) >>> 0);
    this.rngEvent = new SeededRandom((seed ^ 0x1D77C) >>> 0);
    this.rngPlace = new SeededRandom((seed ^ 0x5E2A9) >>> 0);
  }

  // ──────────────────────────────── lifecycle ─────────────────────────────────

  begin(seed: number): void {
    this.reseed(seed);
    if (!this.buses.ready) return;
    this.stop(0.2);

    // The only bed that starts immediately is a very quiet wide "air" — the
    // sound of a large cold outdoor space with nothing happening in it. This is
    // deliberately close to silence; the opening act should feel empty.
    this.airBed = this.kit.granularTexture({
      density: 6, grainSize: 0.42, centre: 190, scatter: 1.5,
      resonance: 0.7, spread: 1, bus: 'ambience', reverbSend: 0.3,
    });
    this.airBed?.set(0.1, 3.0);

    // Wind and insects exist from the start but at near-zero, so they can fade
    // *in* over minutes rather than switching on.
    this.windBed = this.kit.granularTexture({
      density: 22, grainSize: 0.2, centre: 620, scatter: 2.2,
      resonance: 1.1, spread: 0.95, bus: 'ambience', reverbSend: 0.22,
    });
    this.windBed?.set(0.03, 4.0);
    this.windLow = this.kit.dissonantCluster({ base: 58, voices: 3, bus: 'ambience', brightness: 0.15 });
    this.windLow?.set(0, 5.0);

    this.insectBed = this.kit.granularTexture({
      density: 34, grainSize: 0.014, centre: 4300, scatter: 1.1,
      resonance: 7, spread: 0.85, bus: 'ambience', reverbSend: 0.1,
    });
    this.insectBed?.set(0.0, 4.0);

    this.slots = BASE_SLOTS.map(s => ({
      ...s,
      // Stagger the first fire across a wide range so the opening seconds are
      // not a burst of everything at once.
      next: this.rngEvent.range(s.interval[0] * 0.7, s.interval[1] * 1.6),
    }));
    this.fired.clear();
    this.windowFires = 0;
    this.windowTimer = 0;
    this.started = true;
  }

  private reseed(seed: number): void {
    this.rng = new SeededRandom((seed ^ 0xA43B1) >>> 0);
    this.rngEvent = new SeededRandom((seed ^ 0x1D77C) >>> 0);
    this.rngPlace = new SeededRandom((seed ^ 0x5E2A9) >>> 0);
  }

  stop(fade = 1.2): void {
    this.windBed?.stop(fade); this.windBed = null;
    this.windLow?.stop(fade); this.windLow = null;
    this.insectBed?.stop(fade); this.insectBed = null;
    this.waterBed?.stop(fade); this.waterBed = null;
    this.rainBed?.stop(fade); this.rainBed = null;
    this.airBed?.stop(fade); this.airBed = null;
    this.started = false;
    this.rainOn = false;
    this.levels.wind = 0; this.levels.insects = 0; this.levels.water = 0;
    this.levels.rain = 0; this.levels.air = 0;
  }

  setRain(on: boolean): void {
    if (on === this.rainOn) return;
    this.rainOn = on;
    if (on && this.buses.ready && !this.rainBed) {
      this.rainBed = this.kit.granularTexture({
        density: 150, grainSize: 0.01, centre: 3200, scatter: 1.8,
        resonance: 2.2, spread: 1, bus: 'ambience', reverbSend: 0.16,
      });
      this.rainBed?.set(0.02, 6.0);
    }
  }

  // ────────────────────────────────── update ──────────────────────────────────

  update(dt: number, env: AmbienceEnv): void {
    if (!this.started || !this.buses.ready) return;

    // The silence signal is a *duck*, not a mute: even at full silence a faint
    // air bed remains so the mix never sounds like the audio has crashed. The
    // curve is steep so silence actually reads as silence.
    const open = 1 - Math.min(1, env.silence);
    const duck = 0.06 + open * 0.94;

    // ── wind ────────────────────────────────────────────────────────────────
    // Physical model: a closed canopy is a low-pass filter and a diffuser. Wind
    // in dense canopy is a broad hiss with no localisable direction; wind in a
    // storm-fall clearing is brighter, gustier and directional.
    const closure = Math.min(1, Math.max(0, env.canopyClosure));
    const gust = 0.5 + 0.5 * Math.sin(this.buses.now * 0.077) * Math.sin(this.buses.now * 0.031 + 1.7);
    const windDrive = Math.min(1, env.wind * (0.55 + gust * 0.6));
    if (this.windBed) {
      // Closure darkens the centre and widens the image; openness brightens it.
      this.windBed.shape({
        centre: 380 + (1 - closure) * 1500 + windDrive * 700,
        density: 14 + windDrive * 40,
        grainSize: 0.26 - windDrive * 0.14,
        resonance: 0.9 + (1 - closure) * 1.4,
        spread: 0.6 + closure * 0.4,
      });
      const target = (0.05 + windDrive * 0.4) * (env.enclosed ? 0.25 : 1) * duck;
      this.levels.wind = target;
      this.windBed.set(target, 1.6);
    }
    // A low cluster under the wind gives big weather a body without using the
    // sub-bass path — this is what makes storms read on laptop speakers.
    this.windLow?.set(windDrive * 0.22 * (env.enclosed ? 0.4 : 1) * duck, 3.0);

    // ── insects ─────────────────────────────────────────────────────────────
    // Insects are the single best "everything is normal" signal, which makes
    // their *removal* the single best warning. They thin with wetness (marsh
    // insects are a different, lower band), collapse in blight (low ambient +
    // high deadfall), and are suppressed by rain and by tension.
    if (this.insectBed) {
      const wet = Math.min(1, env.wetness);
      const band = 4300 - wet * 1900;         // marsh chorus sits lower
      const alive = (1 - env.tension * 0.55) * (this.rainOn ? 0.25 : 1);
      const target = Math.max(0, 0.16 * alive - wet * 0.05) * (env.enclosed ? 0.15 : 1) * duck;
      this.insectBed.shape({
        centre: band, density: 20 + (1 - wet) * 30,
        resonance: 5 + (1 - wet) * 4, spread: 0.9,
      });
      this.levels.insects = target;
      this.insectBed.set(target, 2.4);
    }

    // ── water ───────────────────────────────────────────────────────────────
    // Flowing water is a *navigation landmark*, so it must be honest: audible
    // from a distance, and it must get brighter and more granular as you close,
    // because near water you hear individual splashes, not a wash.
    const wDist = Math.min(env.creekDist, env.lakeDist);
    if (wDist < 70) {
      if (!this.waterBed) {
        this.waterBed = this.kit.granularTexture({
          density: 90, grainSize: 0.02, centre: 1800, scatter: 2,
          resonance: 2.4, spread: 0.8, bus: 'ambience', reverbSend: 0.18,
        });
        this.waterBed?.set(0, 2.0);
      }
      const near = 1 - wDist / 70;
      const flowing = env.creekDist < env.lakeDist;
      this.waterBed?.shape({
        // A creek is brighter and denser than a still lake edge.
        centre: flowing ? 1400 + near * 2100 : 700 + near * 600,
        density: flowing ? 60 + near * 110 : 24 + near * 40,
        grainSize: flowing ? 0.024 - near * 0.014 : 0.05 - near * 0.02,
        resonance: 1.8 + near * 2.2,
        spread: 0.95 - near * 0.5,
      });
      const target = near * near * (flowing ? 0.34 : 0.2) * duck;
      this.levels.water = target;
      this.waterBed?.set(target, 1.2);
    } else if (this.waterBed) {
      this.levels.water = 0;
      this.waterBed.set(0, 1.5);
      if (this.waterBed.level <= 0.001) { this.waterBed.stop(1.5); this.waterBed = null; }
    }

    // ── rain ────────────────────────────────────────────────────────────────
    if (this.rainBed) {
      // Under canopy, rain is heavier and duller (big drops off leaves); in the
      // open it is a fine bright hiss. This difference is very legible and
      // makes the canopy feel real.
      this.rainBed.shape({
        centre: 4200 - closure * 2200,
        density: 90 + (1 - closure) * 110,
        grainSize: 0.008 + closure * 0.02,
        resonance: 1.6 + closure * 2,
      });
      const target = (0.2 + closure * 0.06) * (env.enclosed ? 0.5 : 1) * duck;
      this.levels.rain = target;
      this.rainBed.set(target, 3.0);
    }

    // ── air ─────────────────────────────────────────────────────────────────
    // Never fully ducked: this is the floor of the mix.
    if (this.airBed) {
      const target = 0.05 + open * 0.06 + (env.enclosed ? 0.05 : 0);
      this.levels.air = target;
      this.airBed.set(target, 3.0);
      this.airBed.shape({ centre: env.enclosed ? 130 : 190 + closure * 90 });
    }

    // ── discrete events ─────────────────────────────────────────────────────
    this.windowTimer += dt;
    if (this.windowTimer >= 60) { this.windowTimer = 0; this.windowFires = 0; }
    this.tickEvents(dt, env, open);
  }

  /**
   * Advance every event slot. Note that intervals are *scaled* by eligibility
   * rather than gated by a probability roll — that keeps the average density
   * stable and avoids the clumping you get from per-frame random checks.
   */
  private tickEvents(dt: number, env: AmbienceEnv, open: number): void {
    const closure = Math.min(1, Math.max(0, env.canopyClosure));
    const wet = Math.min(1, env.wetness);

    for (const slot of this.slots) {
      // Per-kind eligibility: 0 means "this sound does not belong here", and
      // the slot simply does not advance.
      let elig = 1;
      switch (slot.kind) {
        case 'creak':  elig = 0.25 + closure * 0.75 + env.wind * 0.4; break;
        case 'groan':  elig = (0.3 + env.deadfallDensity) * (0.4 + env.wind); break;
        // Birds are a "normal world" signal — they leave as tension rises. By
        // late run there should be no birds at all, and the player will not be
        // able to say when they stopped.
        case 'bird':   elig = Math.max(0, 1 - env.tension * 1.6) * (this.rainOn ? 0.3 : 1); break;
        case 'settle': elig = 0.5 + env.deadfallDensity * 0.8; break;
        case 'drip':   elig = this.rainOn ? 1.4 : wet * 1.2; break;
        case 'leaf':   elig = (0.4 + env.wind * 0.9) * (1 - wet * 0.4); break;
        case 'reed':   elig = env.reedDensity * (0.4 + env.wind); break;
        case 'stone':  elig = env.creekDist < 40 ? 0.9 : 0.15; break;
      }
      elig *= open;                       // silence budget suppresses events
      if (env.enclosed && (slot.kind === 'bird' || slot.kind === 'leaf' || slot.kind === 'reed')) elig *= 0.1;
      if (elig <= 0.02) continue;

      slot.next -= dt * elig;
      if (slot.next > 0) continue;

      // Reschedule first, so an early return still advances the clock.
      slot.next = this.rngEvent.range(slot.interval[0], slot.interval[1]);

      // Creaks and groans are rationed hard — the horror-cliché guard.
      const clicheKind = slot.kind === 'creak' || slot.kind === 'groan';
      if (clicheKind) {
        if (this.windowFires >= 5) continue;
        this.windowFires++;
      }
      this.fireEvent(slot.kind, env);
    }
  }

  /**
   * Place and synthesise one discrete ambient event. Position is seeded and
   * always *off-centre* — an ambient event that originates exactly at the
   * listener destroys the illusion of an outside world.
   */
  private fireEvent(kind: EventSlot['kind'], env: AmbienceEnv): void {
    const ctx = this.buses.ctx;
    if (!ctx) return;
    const r = this.rngPlace;

    // Where. Distance bands differ by kind: a twig settle is close, a bird call
    // is far, a trunk groan is mid.
    let dist: number;
    switch (kind) {
      case 'bird': dist = r.range(28, 95); break;
      case 'groan': dist = r.range(12, 45); break;
      case 'stone': dist = r.range(6, 30); break;
      case 'drip': dist = r.range(1.5, 9); break;
      default: dist = r.range(3, 22); break;
    }
    const ang = r.range(0, Math.PI * 2);
    const ex = env.x + Math.cos(ang) * dist;
    const ez = env.z + Math.sin(ang) * dist;
    // Height matters: creaks and drips come from above, settles from the floor.
    const above = kind === 'creak' || kind === 'drip' || kind === 'leaf' || kind === 'bird';
    const ey = env.y + (above ? r.range(3, 11) : r.range(-0.4, 0.4));

    const voice = this.spatial.acquire(
      { bus: 'ambience', x: ex, y: ey, z: ez, maxDistance: 120, refDistance: 2.5, reverbSend: 0.28 },
      BASE_SLOTS.find(s => s.kind === kind)?.priority ?? 1,
    );
    const dest: AudioNode = voice ? voice.input : this.buses.bus('ambience');
    const t = ctx.currentTime;
    // Distance-compensated amplitude: the panner handles attenuation, this only
    // reflects that far sources are also *physically quieter at source* less often.
    const amp = 0.22 + r.range(0, 0.22);
    let life = 0.8;

    this.fired.set(kind, (this.fired.get(kind) ?? 0) + 1);

    switch (kind) {
      // Branch creak — a pitched, slightly unstable resonance. The wobble is
      // what makes it sound like wood under load rather than a synth tone.
      case 'creak': {
        const f0 = r.range(180, 520);
        const dur = r.range(0.5, 1.5);
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(f0, t);
        o.frequency.linearRampToValueAtTime(f0 * r.range(0.82, 1.22), t + dur);
        const lfo = ctx.createOscillator();
        lfo.frequency.value = r.range(4, 13);
        const lfoAmt = ctx.createGain(); lfoAmt.gain.value = f0 * 0.05;
        lfo.connect(lfoAmt).connect(o.frequency);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = f0 * r.range(1.4, 2.6); bp.Q.value = r.range(3, 9);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp * 0.5, t + r.range(0.04, 0.16));
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(bp); bp.connect(g); g.connect(dest);
        o.start(t); o.stop(t + dur + 0.05);
        lfo.start(t); lfo.stop(t + dur + 0.05);
        this.cleanup([g, lfoAmt, bp], dur + 0.4);
        life = dur + 0.3;
        break;
      }
      // Trunk groan — very low, very slow, no transient. Reads as mass moving.
      case 'groan': {
        const f0 = r.range(48, 96);
        const dur = r.range(1.6, 4.2);
        const bus = ctx.createGain(); bus.gain.value = amp * 0.42;
        bus.connect(dest);
        for (const mult of [1, r.range(1.9, 2.4), r.range(3.1, 4.3)]) {
          const o = ctx.createOscillator();
          o.type = 'triangle';
          o.frequency.setValueAtTime(f0 * mult, t);
          o.frequency.linearRampToValueAtTime(f0 * mult * r.range(0.9, 1.1), t + dur);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(r.range(0.3, 0.8), t + dur * 0.4);
          g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
          o.connect(g); g.connect(bus);
          o.start(t); o.stop(t + dur + 0.05);
        }
        this.cleanup([bus], dur + 0.4);
        life = dur + 0.3;
        break;
      }
      // Distant bird — two or three inharmonic chirps with seeded spacing. Never
      // a recognisable species; it just has to read as "living thing, far away".
      case 'bird': {
        const n = 2 + r.int(0, 2);
        const bus = ctx.createGain(); bus.gain.value = amp * 0.34;
        bus.connect(dest);
        let ct = t;
        const base = r.range(1400, 3400);
        for (let i = 0; i < n; i++) {
          const o = ctx.createOscillator();
          o.type = 'sine';
          const f = base * r.range(0.85, 1.2);
          const cd = r.range(0.05, 0.13);
          o.frequency.setValueAtTime(f, ct);
          o.frequency.exponentialRampToValueAtTime(f * r.range(0.6, 1.5), ct + cd);
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, ct);
          g.gain.exponentialRampToValueAtTime(0.7, ct + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, ct + cd);
          o.connect(g); g.connect(bus);
          o.start(ct); o.stop(ct + cd + 0.02);
          ct += cd + r.range(0.04, 0.18);
        }
        const total = ct - t;
        this.cleanup([bus], total + 0.4);
        life = total + 0.3;
        break;
      }
      // Twig settle / leaf fall / reed rustle — all filtered-noise transients
      // that differ in band, envelope and duration. Sharing one code path keeps
      // them consistent; the parameter spread keeps them distinct.
      case 'settle': case 'leaf': case 'reed': {
        const cfg = kind === 'settle'
          ? { f: r.range(700, 2200), q: r.range(1.2, 3), atk: 0.004, dur: r.range(0.06, 0.2), tilt: 0.2, amp: 0.5 }
          : kind === 'leaf'
            ? { f: r.range(1800, 5200), q: r.range(0.8, 2), atk: 0.02, dur: r.range(0.15, 0.5), tilt: 0.1, amp: 0.3 }
            : { f: r.range(1200, 3600), q: r.range(1.5, 4), atk: 0.05, dur: r.range(0.3, 0.9), tilt: 0.25, amp: 0.34 };
        const src = this.kit.noiseSource(cfg.tilt, 0.4);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = cfg.f; bp.Q.value = cfg.q;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp * cfg.amp, t + cfg.atk);
        g.gain.exponentialRampToValueAtTime(0.0001, t + cfg.dur);
        src.connect(bp); bp.connect(g); g.connect(dest);
        this.stopSource(src, [bp, g], cfg.dur + 0.3);
        life = cfg.dur + 0.25;
        break;
      }
      // Water drip — a resonant pitched ping with a fast upward glide, which is
      // what makes a drip sound like it landed *in* something.
      case 'drip': {
        const f0 = r.range(700, 2100);
        const dur = r.range(0.1, 0.3);
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f0 * r.range(1.2, 2.0), t + dur * 0.7);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp * 0.36, t + 0.003);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(dest);
        o.start(t); o.stop(t + dur + 0.02);
        this.cleanup([g], dur + 0.3);
        life = dur + 0.2;
        break;
      }
      // Stone shift in the creek bed — a dull knock plus a short gravel scatter.
      case 'stone': {
        const o = ctx.createOscillator();
        o.type = 'sine';
        const f0 = r.range(120, 260);
        o.frequency.setValueAtTime(f0, t);
        o.frequency.exponentialRampToValueAtTime(f0 * 0.6, t + 0.1);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp * 0.4, t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
        o.connect(g); g.connect(dest);
        o.start(t); o.stop(t + 0.2);
        const src = this.kit.noiseSource(0.25, 0.3);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = r.range(1600, 3800); bp.Q.value = 1.4;
        const g2 = ctx.createGain();
        g2.gain.setValueAtTime(0.0001, t + 0.02);
        g2.gain.exponentialRampToValueAtTime(amp * 0.2, t + 0.05);
        g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
        src.connect(bp); bp.connect(g2); g2.connect(dest);
        this.cleanup([g], 0.5);
        this.stopSource(src, [bp, g2], 0.5);
        life = 0.5;
        break;
      }
    }

    if (voice) {
      voice.applyPropagation(dist, this.spatial.occlusionAt(ex, ey, ez));
      this.spatial.releaseIn(voice, life + dist / 338 + 0.25);
    }
  }

  // ─────────────────────────────── teardown helpers ───────────────────────────

  private cleanup(nodes: AudioNode[], afterSeconds: number): void {
    setTimeout(() => {
      for (const n of nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    }, afterSeconds * 1000 + 80);
  }

  private stopSource(src: AudioNode & { stop?: () => void }, nodes: AudioNode[], afterSeconds: number): void {
    setTimeout(() => {
      try { src.stop?.(); } catch { /* ignore */ }
      try { src.disconnect(); } catch { /* ignore */ }
      for (const n of nodes) { try { n.disconnect(); } catch { /* ignore */ } }
    }, afterSeconds * 1000 + 80);
  }

  /** Total continuous ambience energy — used by the Director's silence detector. */
  get bedEnergy(): number {
    return this.levels.wind + this.levels.insects + this.levels.water + this.levels.rain;
  }

  snapshot(): { levels: AmbienceLevels; events: Record<string, number> } {
    const events: Record<string, number> = {};
    for (const [k, v] of this.fired) events[k] = v;
    return { levels: this.levels, events };
  }
}
