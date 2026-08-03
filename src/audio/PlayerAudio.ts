import { SeededRandom } from '../core/SeededRandom';
import { AudioBuses } from './AudioBuses';
import { DreadToolkit } from './DreadToolkit';

export type Surface = 'leaf' | 'mud' | 'wood' | 'metal' | 'water' | 'rock';

export interface PlayerAudioInput {
  moving: boolean;
  sprinting: boolean;
  crouched: boolean;
  /** 0..1 stamina remaining */
  stamina: number;
  /** 0..1 smoothed fear */
  fear: number;
  /** 0..1 entity detection */
  detection: number;
  /** how much the director wants everything to shut up */
  silence: number;
}

/**
 * Diegetic player-body audio: breathing, heartbeat, footsteps, cloth and gear.
 *
 * The design principle here is that the player's own physiology is an
 * instrument. Breath and heartbeat that track real detection state recruit the
 * player's body into the horror — they hear themselves getting frightened, and
 * because the rate is *causally* linked to what's happening rather than looping
 * on a timer, it reads as their own reaction rather than as a sound effect.
 *
 * Everything is resynthesised per event. There is no breath loop and no
 * footstep sample bank: identical repeats are the fastest route to habituation,
 * and a breath cycle is one of the most exposed, most-repeated sounds in the
 * whole mix.
 */
export class PlayerAudio {
  private buses: AudioBuses;
  private kit: DreadToolkit;
  private rng: SeededRandom;

  // ---- breathing ----
  private breathPhase = 0;
  private breathState: 'in' | 'out' | 'hold' = 'in';
  /** rolling history so we never pick the same formant twice in a row */
  private lastBreathFormant = 0;

  // ---- heartbeat ----
  private heartPhase = 0;
  private heartAudible = 0;      // smoothed 0..1 gate
  private heartGain!: GainNode;
  private heartDuck!: GainNode;  // ducks the rest of the foley bus when thumping

  // ---- footsteps ----
  private lastFootstepAt = -1;
  private stepParity = 0;        // L/R alternation for subtle pan + timbre offset
  /** ring buffer of recent step variation seeds, so no two consecutive steps match */
  private stepHistory: number[] = [];

  // ---- gear ----
  private clothTimer = 0;

  private foleyIn!: GainNode;

  constructor(buses: AudioBuses, kit: DreadToolkit, seed: number) {
    this.buses = buses;
    this.kit = kit;
    this.rng = new SeededRandom(seed ^ 0xB0D1);
  }

  init(): void {
    const c = this.buses.ctx;
    if (!c) return;
    // Sub-bus so the heartbeat can duck breath/cloth without touching the
    // player's foley volume setting.
    this.heartDuck = c.createGain();
    this.heartDuck.gain.value = 1;
    this.heartDuck.connect(this.buses.bus('foley'));
    this.foleyIn = c.createGain();
    this.foleyIn.gain.value = 1;
    this.foleyIn.connect(this.heartDuck);

    this.heartGain = c.createGain();
    this.heartGain.gain.value = 0;
    this.heartGain.connect(this.buses.bus('foley'));
  }

  reset(seed: number): void {
    this.rng = new SeededRandom(seed ^ 0xB0D1);
    this.breathPhase = 0;
    this.breathState = 'in';
    this.heartPhase = 0;
    this.heartAudible = 0;
    this.lastFootstepAt = -1;
    this.stepHistory.length = 0;
    this.clothTimer = 0;
  }

  // ---------------------------------------------------------------- per-frame

  update(dt: number, input: PlayerAudioInput): void {
    if (!this.buses.ctx) return;
    this.updateBreath(dt, input);
    this.updateHeart(dt, input);
    this.updateCloth(dt, input);
  }

  /**
   * Breathing.
   *
   * Rate comes from exertion (sprinting, low stamina) *and* fear. Depth and
   * spectral character come from both too: frightened breathing is not just
   * faster, it's shallower, higher in the throat, and more voiced. That's why
   * the band-pass centre climbs with fear rather than staying fixed.
   *
   * The 'hold' state matters more than it looks: a held breath at high fear
   * with the entity close is the single most recognisable "I am hiding" sound in
   * the genre, and it costs one extra state.
   */
  private updateBreath(dt: number, input: PlayerAudioInput): void {
    const exert = (input.sprinting ? 1 : 0) * 0.9 + (1 - input.stamina) * 0.5 + (input.moving ? 0.15 : 0);
    const rate = 0.26 + exert * 0.75 + input.fear * 0.55;
    this.breathPhase += dt * rate;

    // Held breath: high fear, entity aware, player still. Physiological freeze.
    const wantHold = input.fear > 0.62 && input.detection > 0.5 && !input.moving;

    if (this.breathPhase >= 1) {
      this.breathPhase -= 1;
      if (wantHold && this.breathState !== 'hold' && this.rng.next() < 0.45) {
        this.breathState = 'hold';
        // a held breath is a *short* audible catch, then nothing
        this.breathEvent('catch', input);
        return;
      }
      this.breathState = this.breathState === 'in' ? 'out' : 'in';
      this.breathEvent(this.breathState === 'in' ? 'in' : 'out', input);
    } else if (this.breathState === 'hold' && this.breathPhase > 0.55 && !wantHold) {
      // release — a slightly shaky exhale
      this.breathState = 'out';
      this.breathEvent('release', input);
    } else if (this.breathState === 'in' && this.breathPhase > 0.44) {
      this.breathState = 'out';
      this.breathEvent('out', input);
    }
  }

  /**
   * One synthesised breath. Two noise bands (a wide airflow band plus a
   * narrower "throat" resonance) through a per-event envelope, all values
   * jittered from the seeded RNG.
   */
  private breathEvent(kind: 'in' | 'out' | 'catch' | 'release', input: PlayerAudioInput): void {
    const c = this.buses.ctx;
    if (!c) return;
    const t = c.currentTime;
    const fear = input.fear;
    const exert = (input.sprinting ? 1 : 0) + (1 - input.stamina) * 0.6;

    // Formant selection avoids repeating the previous value — repeated identical
    // formants are what make scripted breathing loops so obvious.
    let formant = this.rng.range(520, 1150) + fear * 380;
    if (Math.abs(formant - this.lastBreathFormant) < 90) formant += this.rng.sign() * 160;
    this.lastBreathFormant = formant;

    const depth = (0.014 + exert * 0.035 + fear * 0.03) * (1 - input.silence * 0.4);
    let attack: number, decay: number, gain: number, rate: number;
    switch (kind) {
      case 'in':     attack = 0.09; decay = 0.34; gain = depth * 0.85; rate = 1.0; break;
      case 'out':    attack = 0.05; decay = 0.55; gain = depth;        rate = 0.78; break;
      case 'catch':  attack = 0.012; decay = 0.11; gain = depth * 1.5; rate = 1.35; break;
      case 'release': attack = 0.03; decay = 0.9; gain = depth * 1.15; rate = 0.68; break;
    }

    const src = this.kit.noiseSource(0.35, 0.35);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = formant * rate;
    bp.Q.value = this.rng.range(0.9, 2.1);
    // a second, higher band gives the breath its "sibilant edge" — without it
    // breath reads as wind, not as a person
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 240;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);

    // slight formant sweep across the breath — vocal tracts move
    bp.frequency.linearRampToValueAtTime(formant * rate * this.rng.range(0.82, 1.2), t + attack + decay);

    src.connect(hp).connect(bp).connect(g).connect(this.foleyIn);
    const life = attack + decay + 0.1;
    setTimeout(() => {
      try { src.stop?.(); g.disconnect(); bp.disconnect(); hp.disconnect(); } catch { /* ignore */ }
    }, life * 1000 + 80);

    // Frightened breathing gets an occasional voiced shudder — a very quiet
    // low-formant tone under the airflow.
    if ((kind === 'out' || kind === 'release') && fear > 0.5 && this.rng.next() < fear * 0.5) {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = this.rng.range(96, 172);
      const og = c.createGain();
      og.gain.setValueAtTime(0.0001, t + 0.02);
      og.gain.exponentialRampToValueAtTime(gain * 0.35, t + 0.09);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09 + decay * 0.7);
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 620;
      o.connect(lp).connect(og).connect(this.foleyIn);
      o.start(t + 0.02); o.stop(t + 0.2 + decay);
    }
  }

  /**
   * Heartbeat.
   *
   * Deliberately gated: it only becomes audible above a detection threshold.
   * A heartbeat that's always there is wallpaper; a heartbeat that *arrives*
   * tells the player their body noticed something before their conscious mind
   * did — which is exactly the effect being borrowed from real interoception.
   *
   * Synthesised as a thump-pair (S1/S2, the "lub-dub"), tempo tied to fear,
   * centre-panned, and it ducks the rest of the foley bus while thumping so it
   * reads as internal rather than as another sound in the room.
   */
  private updateHeart(dt: number, input: PlayerAudioInput): void {
    const c = this.buses.ctx;
    if (!c) return;
    // gate: needs real detection OR high fear
    const drive = Math.max(input.detection * 1.05, input.fear);
    const wantAudible = clamp01((drive - 0.34) / 0.5);
    this.heartAudible += (wantAudible - this.heartAudible) * Math.min(1, dt * (wantAudible > this.heartAudible ? 1.6 : 0.5));
    if (this.heartAudible < 0.01) { this.heartPhase = 0; return; }

    // 62bpm resting → ~148bpm at full fear. Real, not cinematic-fast.
    const bpm = 62 + drive * 86 + (input.sprinting ? 14 : 0);
    this.heartPhase += dt * (bpm / 60);
    if (this.heartPhase >= 1) {
      this.heartPhase -= 1;
      this.heartBeat(this.heartAudible * (1 - input.silence * 0.25), drive);
    }
  }

  private heartBeat(amount: number, drive: number): void {
    const c = this.buses.ctx;
    if (!c) return;
    const t = c.currentTime;
    const vol = amount * 0.14;
    // S1 (louder, lower) then S2 ~0.14-0.2s later (shorter, slightly higher)
    const gap = 0.135 + (1 - drive) * 0.07;
    const thump = (t0: number, f: number, v: number, dur: number) => {
      const o = c.createOscillator();
      o.type = 'sine';
      // a falling pitch makes the thump read as a soft body impact rather than
      // a tuned note
      o.frequency.setValueAtTime(f * 1.7, t0);
      o.frequency.exponentialRampToValueAtTime(f, t0 + dur * 0.7);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, v), t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 190;
      o.connect(lp).connect(g).connect(this.heartGain);
      o.start(t0); o.stop(t0 + dur + 0.05);
      // a tiny noise transient gives it the "valve" texture
      const n = this.kit.noiseSource(0.9, 0.1);
      const ng = c.createGain();
      ng.gain.setValueAtTime(v * 0.35, t0);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
      const nlp = c.createBiquadFilter(); nlp.type = 'lowpass'; nlp.frequency.value = 320;
      n.connect(nlp).connect(ng).connect(this.heartGain);
      setTimeout(() => { try { n.stop?.(); ng.disconnect(); } catch { /* ignore */ } }, 260);
    };
    this.heartGain.gain.setValueAtTime(1, t);
    thump(t, this.rng.range(44, 52), vol, 0.2);
    thump(t + gap, this.rng.range(54, 64), vol * 0.62, 0.15);

    // duck the rest of the foley bus briefly — internal sounds mask external ones
    const d = this.heartDuck.gain;
    d.cancelScheduledValues(t);
    d.setValueAtTime(1 - amount * 0.28, t);
    d.linearRampToValueAtTime(1, t + gap + 0.28);
  }

  /**
   * Footstep.
   *
   * Called by the Player's stride timer with a real surface and intensity.
   * Every surface is a different synthesis recipe, and every step draws fresh
   * jitter from the seeded RNG with an explicit no-repeat guard, because
   * footsteps are the highest-frequency sound in the game and the single most
   * likely to become audibly looped.
   */
  footstep(surface: Surface, intensity: number, crouched: boolean, silence: number): void {
    const c = this.buses.ctx;
    if (!c) return;
    const t = c.currentTime;
    // debounce: the stride timer can double-fire on a frame spike
    if (this.lastFootstepAt > 0 && t - this.lastFootstepAt < 0.09) return;
    this.lastFootstepAt = t;

    // ---- variation with a no-repeat guard ----
    let v = this.rng.next();
    for (let tries = 0; tries < 4; tries++) {
      if (!this.stepHistory.some(h => Math.abs(h - v) < 0.09)) break;
      v = this.rng.next();
    }
    this.stepHistory.push(v);
    if (this.stepHistory.length > 3) this.stepHistory.shift();

    this.stepParity ^= 1;
    // Small L/R offset. Real footsteps aren't centred, and the alternation is a
    // subliminal cue that reinforces the sense of embodiment.
    const pan = (this.stepParity ? 1 : -1) * 0.16;
    const vol = 0.145 * intensity * (crouched ? 0.42 : 1) * (0.82 + v * 0.36) * (1 - silence * 0.3);

    const panner = c.createStereoPanner ? c.createStereoPanner() : null;
    const out = c.createGain();
    out.gain.value = 1;
    if (panner) { panner.pan.value = pan; out.connect(panner).connect(this.foleyIn); }
    else out.connect(this.foleyIn);

    const noise = (tilt: number) => this.kit.noiseSource(tilt, 0.4);
    const env = (g: GainNode, t0: number, a: number, d: number, peak: number) => {
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
    };
    const kill = (nodes: (AudioNode & { stop?: () => void })[], after: number) => {
      setTimeout(() => { for (const n of nodes) { try { n.stop?.(); n.disconnect(); } catch { /* ignore */ } } }, after * 1000 + 120);
    };

    switch (surface) {
      case 'leaf': {
        // Two-part crunch: a broadband compression transient, then a decaying
        // scatter of individual leaf snaps. The scatter count varies per step,
        // which is most of why this never sounds looped.
        const src = noise(0.15);
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 850 + v * 900;
        bp.Q.value = 0.7 + v * 1.6;
        const g = c.createGain();
        env(g, t, 0.004, 0.05 + v * 0.07, vol);
        src.connect(bp).connect(g).connect(out);
        const snaps = 2 + Math.floor(v * 4);
        for (let i = 0; i < snaps; i++) {
          const st = t + this.rng.range(0.01, 0.13);
          const s2 = noise(0.05);
          const b2 = c.createBiquadFilter();
          b2.type = 'bandpass';
          b2.frequency.value = this.rng.range(2200, 6200);
          b2.Q.value = this.rng.range(3, 9);
          const g2 = c.createGain();
          env(g2, st, 0.001, this.rng.range(0.012, 0.04), vol * this.rng.range(0.12, 0.4));
          s2.connect(b2).connect(g2).connect(out);
          kill([s2, g2, b2], 0.3);
        }
        kill([src, g, bp], 0.4);
        break;
      }
      case 'mud': {
        // Wet, low, with a suction tail on the lift-off — the tail is what makes
        // mud read as mud and not just "quiet dirt".
        const src = noise(1.0);
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 240 + v * 220;
        const g = c.createGain();
        env(g, t, 0.014, 0.14, vol * 1.25);
        src.connect(lp).connect(g).connect(out);
        const suck = noise(0.5);
        const sbp = c.createBiquadFilter();
        sbp.type = 'bandpass'; sbp.frequency.value = 420 + v * 500; sbp.Q.value = 3.5;
        const sg = c.createGain();
        env(sg, t + 0.05 + v * 0.05, 0.03, 0.12, vol * 0.4);
        suck.connect(sbp).connect(sg).connect(out);
        kill([src, g, lp, suck, sg, sbp], 0.5);
        break;
      }
      case 'wood': {
        // Modal plate: two or three resonant modes whose ratios are NOT harmonic
        // (real planks aren't), plus a body thud.
        const f0 = 150 + v * 130;
        for (const [mul, amp, dec] of [[1, 1, 0.2], [2.37, 0.42, 0.13], [3.81, 0.2, 0.08]] as const) {
          const o = c.createOscillator();
          o.type = 'sine';
          o.frequency.value = f0 * mul * this.rng.range(0.98, 1.02);
          const g = c.createGain();
          env(g, t, 0.002, dec, vol * amp * 0.7);
          o.connect(g).connect(out);
          o.start(t); o.stop(t + dec + 0.1);
        }
        const src = noise(1.0);
        const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
        const g = c.createGain();
        env(g, t, 0.003, 0.06, vol * 0.55);
        src.connect(lp).connect(g).connect(out);
        kill([src, g, lp], 0.3);
        break;
      }
      case 'metal': {
        // Long, high, inharmonic modes with a slow beat between them — grating
        // and identifiable, and the reason metal walkways feel dangerous to run on.
        const f0 = 380 + v * 300;
        for (const [mul, amp, dec] of [[1, 0.55, 0.42], [1.59, 0.34, 0.3], [2.71, 0.22, 0.22], [4.13, 0.1, 0.16]] as const) {
          const o = c.createOscillator();
          o.type = 'sine';
          o.frequency.value = f0 * mul * this.rng.range(0.995, 1.005);
          const g = c.createGain();
          env(g, t, 0.001, dec, vol * amp * 0.5);
          o.connect(g).connect(out);
          o.start(t); o.stop(t + dec + 0.1);
        }
        const src = noise(0.0);
        const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2400;
        const g = c.createGain();
        env(g, t, 0.001, 0.03, vol * 0.3);
        src.connect(hp).connect(g).connect(out);
        kill([src, g, hp], 0.25);
        break;
      }
      case 'water': {
        // Splash = a burst plus several individual droplet resonances at
        // randomised delays. Droplets are pitched sine blips with fast upward
        // sweeps — the classic Helmholtz bubble signature.
        const src = noise(0.3);
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 700 + v * 700; bp.Q.value = 1.1;
        const g = c.createGain();
        env(g, t, 0.008, 0.2, vol * 1.15);
        src.connect(bp).connect(g).connect(out);
        const drops = 2 + Math.floor(v * 4);
        for (let i = 0; i < drops; i++) {
          const dt2 = this.rng.range(0.04, 0.34);
          const o = c.createOscillator();
          o.type = 'sine';
          const df = this.rng.range(700, 2600);
          o.frequency.setValueAtTime(df * 0.72, t + dt2);
          o.frequency.exponentialRampToValueAtTime(df, t + dt2 + 0.035);
          const dg = c.createGain();
          env(dg, t + dt2, 0.002, this.rng.range(0.03, 0.09), vol * this.rng.range(0.1, 0.3));
          o.connect(dg).connect(out);
          o.start(t + dt2); o.stop(t + dt2 + 0.2);
        }
        kill([src, g, bp], 0.6);
        break;
      }
      default: { // rock
        const src = noise(0.4);
        const bp = c.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = 1100 + v * 1400; bp.Q.value = 1.4;
        const g = c.createGain();
        env(g, t, 0.002, 0.05, vol);
        src.connect(bp).connect(g).connect(out);
        // grit scatter
        for (let i = 0; i < 3; i++) {
          const st = t + this.rng.range(0.005, 0.09);
          const s2 = noise(0.0);
          const h = c.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = 3800;
          const g2 = c.createGain();
          env(g2, st, 0.001, 0.02, vol * this.rng.range(0.08, 0.22));
          s2.connect(h).connect(g2).connect(out);
          kill([s2, g2, h], 0.2);
        }
        kill([src, g, bp], 0.3);
        break;
      }
    }
    // gear rattle rides on louder steps
    if (intensity > 0.55 && this.rng.next() < 0.45) this.gearRattle(vol * 0.5, t + this.rng.range(0.01, 0.05));
    setTimeout(() => { try { out.disconnect(); panner?.disconnect(); } catch { /* ignore */ } }, 900);
  }

  /**
   * Cloth movement. Fires on a randomised timer while moving, plus on sprint
   * transitions. Deliberately quiet and slightly different every time — this is
   * the layer that makes the player feel like they have a body without ever
   * drawing attention to itself.
   */
  private updateCloth(dt: number, input: PlayerAudioInput): void {
    if (!input.moving) { this.clothTimer = 0; return; }
    this.clothTimer -= dt;
    if (this.clothTimer > 0) return;
    this.clothTimer = this.rng.range(0.35, 0.9) / (input.sprinting ? 1.9 : 1);
    this.cloth((input.sprinting ? 0.55 : input.crouched ? 0.22 : 0.34) * (1 - input.silence * 0.35));
  }

  cloth(amount: number): void {
    const c = this.buses.ctx;
    if (!c) return;
    const t = c.currentTime;
    const src = this.kit.noiseSource(0.2, 0.6);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = this.rng.range(1600, 4200);
    bp.Q.value = this.rng.range(0.5, 1.4);
    const g = c.createGain();
    const dur = this.rng.range(0.09, 0.26);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amount * 0.028), t + dur * 0.35);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // brightness sweep — fabric sliding, not a static hiss
    bp.frequency.linearRampToValueAtTime(bp.frequency.value * this.rng.range(0.6, 1.5), t + dur);
    src.connect(bp).connect(g).connect(this.foleyIn);
    setTimeout(() => { try { src.stop?.(); g.disconnect(); bp.disconnect(); } catch { /* ignore */ } }, dur * 1000 + 150);
  }

  private gearRattle(amount: number, at: number): void {
    const c = this.buses.ctx;
    if (!c) return;
    // two or three tiny metallic ticks — the recorder's strap hardware
    const n = 2 + Math.floor(this.rng.next() * 2);
    for (let i = 0; i < n; i++) {
      const o = c.createOscillator();
      o.type = 'square';
      o.frequency.value = this.rng.range(2400, 5600);
      const g = c.createGain();
      const t0 = at + this.rng.range(0, 0.05);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, amount * 0.05), t0 + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.02);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = o.frequency.value; bp.Q.value = 8;
      o.connect(bp).connect(g).connect(this.foleyIn);
      o.start(t0); o.stop(t0 + 0.05);
    }
  }

  /**
   * Flashlight switch. A real toggle switch is: spring pre-travel, an
   * over-centre snap, and a housing resonance. On/off differ because the spring
   * loads and releases in different directions.
   */
  flashlightClick(on: boolean): void {
    const c = this.buses.ctx;
    if (!c) return;
    const t = c.currentTime;
    const bus = this.buses.bus('ui');
    // snap transient
    const src = this.kit.noiseSource(0.0, 0.2);
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = on ? 2600 : 2100;
    const g = c.createGain();
    g.gain.setValueAtTime(0.055 * this.rng.range(0.85, 1.15), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.016);
    src.connect(hp).connect(g).connect(bus);
    setTimeout(() => { try { src.stop?.(); g.disconnect(); hp.disconnect(); } catch { /* ignore */ } }, 200);
    // housing resonance — two modes, slightly different up vs down
    const f0 = (on ? 2150 : 1680) * this.rng.range(0.96, 1.04);
    for (const [mul, amp, dec] of [[1, 0.07, 0.045], [2.14, 0.03, 0.028]] as const) {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = f0 * mul;
      const og = c.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(amp, t + 0.001);
      og.gain.exponentialRampToValueAtTime(0.0001, t + dec);
      o.connect(og).connect(bus);
      o.start(t); o.stop(t + dec + 0.05);
    }
    // a filament/electronics tick only on switch-on
    if (on) {
      const o = c.createOscillator();
      o.type = 'triangle';
      o.frequency.value = this.rng.range(5200, 7400);
      const og = c.createGain();
      og.gain.setValueAtTime(0.0001, t + 0.006);
      og.gain.exponentialRampToValueAtTime(0.012, t + 0.008);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
      o.connect(og).connect(bus);
      o.start(t + 0.006); o.stop(t + 0.06);
    }
  }

  /** Vault grunt + scrape — one short exertion event. */
  vault(): void {
    const c = this.buses.ctx;
    if (!c) return;
    const t = c.currentTime;
    // voiced exertion: a low formant pair with a fast decay
    const f0 = this.rng.range(110, 165);
    for (const [mul, amp] of [[1, 0.05], [2.6, 0.02]] as const) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0 * mul * 1.1, t);
      o.frequency.exponentialRampToValueAtTime(f0 * mul * 0.82, t + 0.28);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f0 * mul * 3.4; bp.Q.value = 2.6;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(amp, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      o.connect(bp).connect(g).connect(this.foleyIn);
      o.start(t); o.stop(t + 0.4);
    }
    this.cloth(0.9);
  }

  /** stamina-exhaustion gasp — fires once when stamina bottoms out */
  exhausted(): void {
    this.breathEvent('catch', {
      moving: true, sprinting: true, crouched: false, stamina: 0,
      fear: 0.4, detection: 0, silence: 0,
    });
  }

  get heartLevel(): number { return this.heartAudible; }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
