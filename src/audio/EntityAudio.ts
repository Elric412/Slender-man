/**
 * EntityAudio — the Palebark's voice. Brief §8.
 *
 * Design position: the entity is never *scored*. There is no motif, no combat
 * cue, no "boss theme". What the player hears is a set of physical
 * consequences of the thing being nearby:
 *
 *   1. an APPROACH layer   — granular mass that gains high-frequency detail and
 *                            spatial focus as detection rises. It is anchored to
 *                            the entity's world position through a spatial voice,
 *                            so it occludes and localises like any other object.
 *   2. an INTERFERENCE layer — deliberately NOT spatialised. This is the camcorder
 *                            reacting to being observed; it lives in the player's
 *                            head, not in the forest. Synthesised granular + ring
 *                            mod. Never a sampled static clip (§14).
 *   3. SIGHTING STINGS      — short, non-looping, round-robin'd from five distinct
 *                            recipes with a no-repeat memory, so quality gate 3
 *                            ("no two sightings identical in a run") holds
 *                            structurally rather than by luck.
 *   4. DISTANT CUES         — snap / footfall / shift / call, fired through a full
 *                            spatial voice *with propagation delay*, and with
 *                            deliberate positional error so the player cannot use
 *                            audio as a radar.
 *   5. CAPTURE              — abstracted. Three variants, all resolving to quiet
 *                            or controlled band-collapse. No violent or graphic
 *                            sound design (§8 last line).
 *
 * Everything expensive is rationed through the Director's cliché budget.
 */

import { SeededRandom } from '../core/SeededRandom';
import type { AudioBuses } from './AudioBuses';
import type { DreadToolkit, GranularHandle } from './DreadToolkit';
import type { SpatialAudio, SpatialVoice } from './Spatial';
import type { AudioDirector, EntityPhase } from './Director';

export interface EntityAudioInput {
  state: EntityPhase;
  detection: number;
  x: number; y: number; z: number;
  distToPlayer: number;
  visibleToPlayer: boolean;
  speed: number;
  /** Director silence amount — stings pull back when the mix is intentionally empty. */
  silence: number;
}

export interface EntityFireCounts {
  sighting: number; cue: number; capture: number; corrupt: number;
}

/** Distance past which the approach layer is not worth a voice. */
const APPROACH_RANGE = 55;
/** Sightings can't retrigger faster than this, regardless of budget. */
const SIGHTING_COOLDOWN = 2.5;

export class EntityAudio {
  private rng: SeededRandom;

  private approach: GranularHandle | null = null;
  private approachVoice: SpatialVoice | null = null;
  private interference: GranularHandle | null = null;
  private wrongness: ReturnType<DreadToolkit['wrongnessInsert']> | null = null;

  private approachLevel = 0;
  private interferenceLevel = 0;
  private occTimer = 0;
  private lastOcc = 0;
  private sightingTimer = 0;
  private cueTimer = 0;

  /** No-repeat memories — the actual mechanism behind quality gate 3. */
  private sightHistory: number[] = [];
  private captureHistory: number[] = [];
  private cueHistory: number[] = [];

  /** Set true when a close cue fires, so the HUD can caption it for HoH players (§11). */
  approachCueFired = false;
  /** Debug/telemetry: how many stings of each kind have fired this run. */
  readonly fired: EntityFireCounts = { sighting: 0, cue: 0, capture: 0, corrupt: 0 };

  constructor(
    private buses: AudioBuses,
    private kit: DreadToolkit,
    private spatial: SpatialAudio,
    private director: AudioDirector,
    seed: number,
  ) {
    this.rng = new SeededRandom((seed ^ 0x9A1E8) >>> 0);
  }

  reset(seed: number): void {
    this.rng = new SeededRandom((seed ^ 0x9A1E8) >>> 0);
    this.stopLayers(0.25);
    this.sightHistory.length = 0;
    this.captureHistory.length = 0;
    this.cueHistory.length = 0;
    this.approachLevel = 0;
    this.interferenceLevel = 0;
    this.sightingTimer = 0;
    this.cueTimer = 0;
    this.approachCueFired = false;
    this.fired.sighting = 0; this.fired.cue = 0;
    this.fired.capture = 0; this.fired.corrupt = 0;
  }

  // ───────────────────────────── continuous layers ────────────────────────────

  update(dt: number, input: EntityAudioInput): void {
    if (!this.buses.ready) return;
    this.sightingTimer = Math.max(0, this.sightingTimer - dt);
    this.cueTimer = Math.max(0, this.cueTimer - dt);

    const dormant = input.state === 'dormant';
    const inRange = input.distToPlayer < APPROACH_RANGE;
    const want = !dormant && inRange;

    // Detection drives the entire spectral morph. This is the single most
    // important tuning surface in the entity mix: at low detection the layer is
    // a wide, slow, low mass you cannot point at; at high detection it becomes
    // fast, bright, narrow and *locatable*. The player learns that "I can tell
    // where it is" means "it knows where I am".
    const d = Math.min(1, Math.max(0, input.detection));

    if (want) {
      this.ensureApproach();
      if (this.approach) {
        // Proximity contributes on top of detection so a close dormant-ish
        // entity still has weight.
        const prox = 1 - Math.min(1, input.distToPlayer / APPROACH_RANGE);
        const drive = Math.min(1, d * 0.72 + prox * 0.42);
        this.approach.shape({
          density: 8 + drive * 62,
          grainSize: 0.24 - drive * 0.19,
          centre: 260 + drive * 2100,
          scatter: 2.1 - drive * 1.1,
          resonance: 1.2 + drive * 5.5,
          spread: 0.95 - drive * 0.5,
        });
        this.approachLevel = 0.1 + drive * 0.62;
        this.approach.set(this.approachLevel, 0.5);

        // Position + occlusion. Occlusion is refreshed on a 5Hz cadence rather
        // than per frame — raycasts are the expensive part and the ear cannot
        // resolve faster than this anyway.
        if (this.approachVoice) {
          this.approachVoice.setPosition(input.x, input.y, input.z);
          this.occTimer += dt;
          if (this.occTimer >= 0.2) {
            this.occTimer = 0;
            this.lastOcc = this.spatial.occlusionAt(input.x, input.y, input.z);
          }
          // noDelay: the approach layer is a *presence*, not an event. Adding
          // propagation delay to a continuously-moving drone just smears it.
          this.approachVoice.applyPropagation(input.distToPlayer, this.lastOcc, { noDelay: true });
        }
      }
    } else if (this.approach) {
      this.approachLevel = Math.max(0, this.approachLevel - dt * 0.9);
      this.approach.set(this.approachLevel, 0.4);
      if (this.approachLevel <= 0.002) this.stopApproach(0.6);
    }

    // ── interference ──────────────────────────────────────────────────────────
    // Head-locked on purpose (see file header). Gated hard on detection so that
    // early-run dormant wandering produces genuine silence (§9 / gate 1).
    const iWant = d > 0.12 || (input.visibleToPlayer && input.distToPlayer < 70);
    if (iWant) {
      this.ensureInterference();
      if (this.interference) {
        const drive = Math.min(1, d * 1.15 + (input.visibleToPlayer ? 0.25 : 0));
        this.interference.shape({
          density: 60 + drive * 150,
          grainSize: 0.02 - drive * 0.014,
          centre: 1500 + drive * 3600,
          scatter: 1.4,
          resonance: 0.9 + drive * 1.4,
          spread: 1,
        });
        this.interferenceLevel = Math.max(0, drive - 0.1) * 0.4;
        this.interference.set(this.interferenceLevel, 0.35);
        this.wrongness?.setAmount(Math.min(0.85, drive * 0.9), 0.6);
      }
    } else if (this.interference) {
      this.interferenceLevel = Math.max(0, this.interferenceLevel - dt * 0.7);
      this.interference.set(this.interferenceLevel, 0.4);
      if (this.interferenceLevel <= 0.002) this.stopInterference(0.5);
    }
  }

  private ensureApproach(): void {
    if (this.approach) return;
    const voice = this.spatial.acquire(
      { bus: 'entity', x: 0, y: 1.6, z: 0, maxDistance: APPROACH_RANGE + 12, refDistance: 2.5, reverbSend: 0.3, noDelay: true },
      8, // high priority: this must never be the voice that gets evicted
    );
    const h = this.kit.granularTexture({
      density: 8, grainSize: 0.24, centre: 260, scatter: 2.1, resonance: 1.2, spread: 0.95,
      bus: 'entity', reverbSend: voice ? 0 : 0.24,
    });
    if (!h) return;
    if (voice) { h.connectTo(voice.input); this.approachVoice = voice; }
    this.approach = h;
  }

  private ensureInterference(): void {
    if (this.interference) return;
    const w = this.kit.wrongnessInsert({ modHz: 47, combHz: 190, amount: 0 });
    const h = this.kit.granularTexture({
      density: 60, grainSize: 0.02, centre: 1500, scatter: 1.4, resonance: 0.9, spread: 1,
      bus: 'entity', reverbSend: 0.05,
    });
    if (!h) { w?.dispose(); return; }
    if (w) { h.connectTo(w.input); w.output.connect(this.buses.bus('entity')); this.wrongness = w; }
    this.interference = h;
  }

  private stopApproach(fade = 0.4): void {
    this.approach?.stop(fade);
    this.approach = null;
    if (this.approachVoice) { this.spatial.releaseIn(this.approachVoice, fade + 0.2); this.approachVoice = null; }
  }

  private stopInterference(fade = 0.4): void {
    this.interference?.stop(fade);
    this.interference = null;
    const w = this.wrongness;
    if (w) { this.wrongness = null; setTimeout(() => w.dispose(), (fade + 0.4) * 1000); }
  }

  stopLayers(fade = 0.4): void {
    this.stopApproach(fade);
    this.stopInterference(fade);
  }

  // ─────────────────────────────── sightings ──────────────────────────────────

  /**
   * Fired when the player catches the entity in view. Five recipes, chosen with
   * a 3-deep no-repeat memory. Short and non-looping by construction — each one
   * schedules a finite set of ramps and self-releases.
   */
  sightingSting(dist: number): void {
    if (!this.buses.ready) return;
    if (this.sightingTimer > 0) return;
    if (!this.director.requestSpend('sighting')) return;
    this.sightingTimer = SIGHTING_COOLDOWN;
    this.fired.sighting++;

    const ctx = this.buses.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    const near = 1 - Math.min(1, dist / 60);
    // Loudness scales with proximity but is floored — a distant sighting should
    // still register, just without the body.
    const amp = 0.16 + near * 0.3;
    const pick = this.pickVaried(this.sightHistory, 5, 3);

    const out = this.buses.bus('entity');
    const send = this.buses.reverbInput;

    switch (pick) {
      // 1. Hard-cut inhale swell. Rises fast, then is *cut*, not faded — the
      //    absence is the payload.
      case 0: {
        const n = this.kit.noiseSource(0.35, 0.5);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.Q.value = 2.4;
        bp.frequency.setValueAtTime(320, t);
        bp.frequency.exponentialRampToValueAtTime(1750 + this.rng.range(0, 700), t + 0.28);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp, t + 0.26);
        g.gain.setValueAtTime(amp, t + 0.28);
        g.gain.linearRampToValueAtTime(0.0001, t + 0.31); // the cut
        n.connect(bp); bp.connect(g); g.connect(out); g.connect(send);
        this.stopLater(n, g, t + 0.45);
        break;
      }
      // 2. Inharmonic bell cluster — modal resonator ratios deliberately not
      //    harmonic, so it reads as an object that should not ring.
      case 1: {
        const ratios = [1, 1.427, 2.093, 2.717, 3.611];
        const bus = ctx.createGain();
        bus.gain.value = amp * 0.62;
        bus.connect(out); bus.connect(send);
        const f0 = 210 + this.rng.range(-45, 70);
        for (let i = 0; i < ratios.length; i++) {
          const o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = f0 * ratios[i] * (1 + this.rng.range(-0.008, 0.008));
          const g = ctx.createGain();
          const dec = 1.5 - i * 0.2 + this.rng.range(-0.15, 0.15);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(1 / (i + 1.4), t + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.25, dec));
          o.connect(g); g.connect(bus);
          o.start(t); o.stop(t + dec + 0.1);
        }
        setTimeout(() => bus.disconnect(), 2200);
        break;
      }
      // 3. Comb-filtered downward glissando. Falling pitch + metallic comb =
      //    "structure collapsing", and the comb makes it unplaceable.
      case 2: {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        const hi = 640 + this.rng.range(0, 260);
        o.frequency.setValueAtTime(hi, t);
        o.frequency.exponentialRampToValueAtTime(hi * 0.24, t + 0.55);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.7;
        const w = this.kit.wrongnessInsert({ modHz: 0, combHz: 140 + this.rng.range(0, 120), amount: 0.8 });
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp * 0.5, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.62);
        o.connect(lp);
        if (w) { lp.connect(w.input); w.output.connect(g); } else { lp.connect(g); }
        g.connect(out); g.connect(send);
        o.start(t); o.stop(t + 0.7);
        setTimeout(() => { g.disconnect(); w?.dispose(); }, 1400);
        break;
      }
      // 4. Dry granular burst — no reverb send at all. Sounds like it happened
      //    *inside* the player's ear rather than in the space.
      case 3: {
        const h = this.kit.granularTexture({
          density: 130, grainSize: 0.012, centre: 900 + this.rng.range(0, 1600),
          scatter: 2.6, resonance: 4, spread: 0.3, bus: 'entity', reverbSend: 0,
        });
        if (!h) break;
        h.set(amp * 1.05, 0.02);
        setTimeout(() => h.set(0, 0.09), 130);
        setTimeout(() => h.stop(0.12), 420);
        break;
      }
      // 5. Near-silent sub pressure step. Almost nothing audible — the sting is
      //    a *sensation*. Only eligible when the LF path is enabled and the
      //    Director grants a sub beat, so this can never become the default.
      default: {
        if (this.buses.lowFreqDisabled || !this.director.requestSpend('subBeat')) {
          // Fall back to recipe 1 rather than firing nothing; but do NOT record
          // recipe 1 in history twice, the pickVaried call already recorded 4.
          const n = this.kit.noiseSource(0.8, 0.3);
          const lp = ctx.createBiquadFilter();
          lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 0.9;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(amp * 0.55, t + 0.18);
          g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
          n.connect(lp); lp.connect(g); g.connect(out);
          this.stopLater(n, g, t + 1.1);
          break;
        }
        const sub = this.kit.subBassDrone({ freq: 26 + this.rng.range(0, 8), beat: 0.4, swell: 0, swellDepth: 0 });
        sub.set(0.85, 0.12);
        setTimeout(() => sub.set(0, 0.5), 700);
        setTimeout(() => sub.stop(0.7), 1800);
        // A small mid-band whisper rides along so the beat still reads on phone
        // speakers with no LF reproduction at all (gate 7).
        const n = this.kit.noiseSource(0.6, 0.4);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 1.1;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(amp * 0.2, t + 0.22);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        n.connect(bp); bp.connect(g); g.connect(out);
        this.stopLater(n, g, t + 1.3);
        break;
      }
    }
  }

  // ───────────────────────────── distant cues ─────────────────────────────────

  /**
   * A discrete world event at the entity's rough position. Goes through a full
   * spatial voice *including* propagation delay, so a snap 80m away arrives
   * ~0.24s late — the brain reads that as genuine distance.
   *
   * Positional error is applied on purpose: the player should get a direction,
   * not a fix. Without this, careful listening degenerates into wallhacks.
   */
  distantCue(x: number, y: number, z: number, dist: number, kind?: 'snap' | 'footfall' | 'shift' | 'call'): void {
    if (!this.buses.ready) return;
    if (this.cueTimer > 0) return;
    const ctx = this.buses.ctx;
    if (!ctx) return;
    this.cueTimer = 0.35;
    this.fired.cue++;

    const kinds: ('snap' | 'footfall' | 'shift' | 'call')[] = ['snap', 'footfall', 'shift', 'call'];
    const k = kind ?? kinds[this.pickVaried(this.cueHistory, 4, 2)];

    // Deliberate localisation error, growing with distance.
    const err = Math.min(14, dist * 0.16);
    const ex = x + this.rng.range(-err, err);
    const ez = z + this.rng.range(-err, err);

    const voice = this.spatial.acquire(
      { bus: 'entity', x: ex, y, z: ez, maxDistance: 140, refDistance: 3, reverbSend: 0.3 },
      k === 'call' ? 6 : 4,
    );
    const dest = voice ? voice.input : this.buses.bus('entity');
    const t = ctx.currentTime;
    const near = 1 - Math.min(1, dist / 100);
    const amp = 0.2 + near * 0.32;
    let life = 0.6;

    if (k === 'snap') {
      // Dry wood breaking: filtered noise transient + a short inharmonic ring.
      const n = this.kit.noiseSource(0.15, 0.2);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 1.6;
      bp.frequency.value = 1200 + this.rng.range(0, 1400);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11 + this.rng.range(0, 0.06));
      n.connect(bp); bp.connect(g); g.connect(dest);
      this.stopLater(n, g, t + 0.3);
      life = 0.5;
    } else if (k === 'footfall') {
      // Heavy, damped, low. Slow attack relative to a snap — mass, not a break.
      const n = this.kit.noiseSource(0.75, 0.3);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 1.1;
      lp.frequency.value = 240 + this.rng.range(0, 130);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp * 0.85, t + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22 + this.rng.range(0, 0.1));
      n.connect(lp); lp.connect(g); g.connect(dest);
      this.stopLater(n, g, t + 0.45);
      life = 0.6;
    } else if (k === 'shift') {
      // Foliage displacement — long, soft, no transient, so it's hard to time.
      const h = this.kit.granularTexture({
        density: 46, grainSize: 0.035, centre: 2400 + this.rng.range(0, 1800),
        scatter: 2.4, resonance: 1.6, spread: 0.7, bus: 'entity', reverbSend: 0.2,
      });
      if (h) {
        if (voice) h.connectTo(voice.input);
        h.set(amp * 0.8, 0.08);
        const dur = 0.35 + this.rng.range(0, 0.5);
        setTimeout(() => h.set(0, 0.2), dur * 1000);
        setTimeout(() => h.stop(0.3), (dur + 0.8) * 1000);
        life = dur + 1.2;
      }
    } else {
      // 'call' — not a voice, not an animal. A slow inharmonic swell with
      //  independent detuning, so it never sounds like the same creature twice.
      const bus = ctx.createGain();
      bus.gain.value = amp * 0.5;
      bus.connect(dest);
      const f0 = 130 + this.rng.range(0, 90);
      const dur = 1.1 + this.rng.range(0, 1.0);
      for (const r of [1, 1.53, 2.31]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(f0 * r, t);
        o.frequency.linearRampToValueAtTime(f0 * r * this.rng.range(0.9, 1.06), t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.5, t + dur * 0.45);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(bus);
        o.start(t); o.stop(t + dur + 0.05);
      }
      setTimeout(() => bus.disconnect(), (dur + 0.6) * 1000);
      life = dur + 0.8;
    }

    if (voice) {
      voice.applyPropagation(dist, this.spatial.occlusionAt(ex, y, ez));
      this.spatial.releaseIn(voice, life + dist / 338 + 0.3);
    }

    // Feed the accessibility caption: a close cue is information the player is
    // expected to act on, so a deaf player must receive it visually (§11).
    if (dist < 45) this.approachCueFired = true;
  }

  // ───────────────────────── ambient corruption ──────────────────────────────

  /**
   * Briefly routes a diegetic ambient sound through the wrongness processor.
   * §4: "applied briefly to diegetic sounds" — the point is that a *familiar*
   * sound becomes wrong, which is far more effective than a new scary sound.
   */
  corruptAmbient(play: (dest: AudioNode) => void): boolean {
    if (!this.buses.ready) return false;
    if (!this.director.requestSpend('wrongness')) return false;
    const w = this.kit.wrongnessInsert({
      modHz: 23 + this.rng.range(0, 60),
      combHz: 90 + this.rng.range(0, 200),
      amount: this.rng.range(0.45, 0.9),
    });
    if (!w) return false;
    this.fired.corrupt++;
    w.output.connect(this.buses.bus('ambience'));
    play(w.input);
    setTimeout(() => w.dispose(), 4000);
    return true;
  }

  // ──────────────────────────────── capture ───────────────────────────────────

  /**
   * §8: "capture sequence abstracted — near-silence or brief controlled
   * distortion, then quiet; no violent or graphic sound design."
   *
   * All three variants end in silence rather than a hit. Returns the length in
   * seconds so the visual transition can be matched to it.
   */
  captureSequence(): number {
    if (!this.buses.ready) return 1.2;
    const ctx = this.buses.ctx;
    if (!ctx) return 1.2;
    this.fired.capture++;
    const t = ctx.currentTime;
    const out = this.buses.bus('entity');
    const pick = this.pickVaried(this.captureHistory, 3, 2);

    // Whatever happens, the world layers get pulled out from under it.
    this.stopLayers(0.35);

    if (pick === 0) {
      // (a) Collapse to silence: a wide band closes to a narrow one and stops.
      const n = this.kit.noiseSource(0.5, 0.7);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(2600, t);
      bp.frequency.exponentialRampToValueAtTime(160, t + 1.5);
      bp.Q.setValueAtTime(0.6, t);
      bp.Q.linearRampToValueAtTime(9, t + 1.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.34, t + 0.12);
      g.gain.setValueAtTime(0.34, t + 1.1);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
      n.connect(bp); bp.connect(g); g.connect(out);
      this.stopLater(n, g, t + 2.0);
      return 1.8;
    }

    if (pick === 1) {
      // (b) The recording ends: tape mechanism drags, then one soft clunk.
      //     Mechanical rather than biological — it is the document that dies.
      const n = this.kit.noiseSource(0.6, 0.35);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 2.2;
      bp.frequency.setValueAtTime(1100, t);
      bp.frequency.exponentialRampToValueAtTime(340, t + 1.25);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.26, t + 0.2);
      g.gain.exponentialRampToValueAtTime(0.02, t + 1.3);
      n.connect(bp); bp.connect(g); g.connect(out);
      this.stopLater(n, g, t + 1.7);
      // the clunk
      const ct = t + 1.32;
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.setValueAtTime(150, ct);
      o.frequency.exponentialRampToValueAtTime(64, ct + 0.16);
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, ct);
      cg.gain.exponentialRampToValueAtTime(0.3, ct + 0.006);
      cg.gain.exponentialRampToValueAtTime(0.0001, ct + 0.3);
      o.connect(cg); cg.connect(out);
      o.start(ct); o.stop(ct + 0.35);
      setTimeout(() => cg.disconnect(), 2200);
      return 1.7;
    }

    // (c) Pressure and cut: a swell that is killed mid-rise. The unresolved
    //     shape is the horror; a resolution would be a relief.
    const mid = this.kit.noiseSource(0.55, 0.5);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(300, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 1.05);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 1.0);
    g.gain.linearRampToValueAtTime(0.0001, t + 1.06); // the cut
    mid.connect(bp); bp.connect(g); g.connect(out);
    this.stopLater(mid, g, t + 1.3);
    if (!this.buses.lowFreqDisabled) {
      const sub = this.kit.subBassDrone({ freq: 24, beat: 0.9, swell: 0, swellDepth: 0 });
      sub.set(0.9, 0.35);
      setTimeout(() => sub.set(0, 0.04), 1010);
      setTimeout(() => sub.stop(0.15), 1200);
    }
    return 1.25;
  }

  // ─────────────────────────────── internals ──────────────────────────────────

  /**
   * Choose an index in [0,count) avoiding the last `memory` choices. This is
   * what makes quality gate 3 a structural guarantee rather than a probability:
   * with memory=3 out of 5 recipes, two consecutive sightings can never match,
   * and a run of four cannot contain a repeat.
   */
  private pickVaried(history: number[], count: number, memory: number): number {
    const banned = history.slice(-Math.min(memory, count - 1));
    const pool: number[] = [];
    for (let i = 0; i < count; i++) if (!banned.includes(i)) pool.push(i);
    const chosen = pool.length ? pool[this.rng.int(0, pool.length - 1)] : this.rng.int(0, count - 1);
    history.push(chosen);
    if (history.length > 16) history.shift();
    return chosen;
  }

  /** Tear down a one-shot noise source + gain at a scheduled time. */
  private stopLater(src: AudioNode & { stop?: () => void }, g: GainNode, when: number): void {
    const ctx = this.buses.ctx;
    if (!ctx) return;
    const ms = Math.max(0, (when - ctx.currentTime) * 1000) + 60;
    setTimeout(() => {
      try { src.stop?.(); } catch { /* already stopped */ }
      try { src.disconnect(); } catch { /* ignore */ }
      try { g.disconnect(); } catch { /* ignore */ }
    }, ms);
  }

  snapshot(): { approach: number; interference: number; presence: number; fired: EntityFireCounts } {
    return {
      approach: this.approachLevel,
      interference: this.interferenceLevel,
      presence: Math.max(this.approachLevel, this.interferenceLevel),
      fired: this.fired,
    };
  }

  dispose(): void { this.stopLayers(0.05); }
}
