import { SeededRandom } from '../core/SeededRandom';
import { AudioBuses, BusId } from './AudioBuses';
import { SUB_HARD_CEIL } from './worklets/DreadWorklet';

/**
 * The psychoacoustic dread toolkit — the synthesis primitives every other
 * audio system in STATIC is assembled from.
 *
 * Each primitive is here because of a specific documented mechanism, not
 * because it "sounds scary":
 *
 * • SubBassDrone (~20-45Hz). Content in this band is felt as bodily pressure
 *   before it is consciously identified as sound. Horror cinema uses this
 *   deliberately — Gaspar Noé's *Irréversible* runs a ~27-28Hz tone under its
 *   opening to the documented point of audience nausea, and Ennio Morricone's
 *   *The Thing* score uses a far more moderate low drone as a continuous "bed
 *   of dread". Because the effect is genuinely physiological, this primitive is
 *   the one that gets a hard DSP-level output ceiling and its own settings
 *   toggle (see §11 handling in AudioBuses + DreadWorklet).
 *
 * • DissonantCluster. Unresolved intervals and slow beating between
 *   near-unison partials read as "wrong" much faster than volume does. Roughness
 *   peaks when two partials are separated by less than a critical band, so the
 *   cluster deliberately packs its oscillators into narrow, non-octave,
 *   non-fifth spacings and keeps them drifting so the ear never resolves them
 *   into a chord it can name.
 *
 * • ShepardRiser. Octave-spaced tones sweeping upward under a fixed spectral
 *   window produce apparently endless ascent (Shepard/Risset). Tension with no
 *   release valve — perfect for "detection is climbing and will not stop",
 *   because unlike a volume ramp it has no ceiling the player can anticipate.
 *
 * • GranularTexture. Overlapping short grains of filtered noise. Its value
 *   here is anti-habituation: parameterised grain size / density / pitch
 *   scatter means the approach texture is *never* the same twice, so the
 *   player's fear response can't decay through familiarity.
 *
 * • Wrongness (ring modulation + comb filtering). Applied briefly to an
 *   otherwise diegetic sound, these make something almost-familiar read as
 *   incorrect. Ring modulation destroys the harmonic ratios that identify a
 *   sound source; a short comb delay adds a pitched resonance that shouldn't
 *   be there. Used sparingly — constant application just sounds like an effect.
 *
 * • ProceduralIR. Runtime-synthesised impulse responses (noise burst shaped by
 *   an exponential decay envelope plus discrete early reflections), so
 *   interiors, open forest and the rail tunnel each get a distinct and
 *   *correct* reverb without shipping a single recorded IR.
 */

// ============================================================ shared handles

export interface DroneHandle {
  /** set target intensity 0..1 */
  set(level: number, timeConstant?: number): void;
  /** current commanded intensity */
  readonly level: number;
  stop(fade?: number): void;
  readonly alive: boolean;
}

const NULL_DRONE: DroneHandle = {
  set: () => undefined, level: 0, stop: () => undefined, alive: false,
};

// ============================================================ toolkit

export class DreadToolkit {
  private buses: AudioBuses;
  private rng: SeededRandom;

  /** cached IR buffers keyed by space signature, so we synthesise each once */
  private irCache = new Map<string, AudioBuffer>();

  constructor(buses: AudioBuses, seed: number) {
    this.buses = buses;
    this.rng = new SeededRandom(seed ^ 0xD8EAD);
  }

  private get ctx(): AudioContext | null { return this.buses.ctx; }

  reseed(seed: number): void { this.rng = new SeededRandom(seed ^ 0xD8EAD); }
  get random(): SeededRandom { return this.rng; }

  // ---------------------------------------------------------------- sub-bass

  /**
   * Sustained low-frequency dread drone.
   *
   * Routed through `buses.lowFreqInput`, which carries the player's
   * low-frequency-intensity setting — so a player who zeroes that setting gets
   * literal silence from this primitive while the rest of the entity mix is
   * untouched.
   *
   * `intensityCap` is applied on top of the worklet's HARD_CEIL. Two layers of
   * cap is intentional: the settings-facing one can be tuned, the DSP one
   * cannot be bypassed.
   */
  subBassDrone(opts: { freq?: number; beat?: number; swell?: number; swellDepth?: number } = {}): DroneHandle {
    const c = this.ctx;
    if (!c) return NULL_DRONE;
    const freq = opts.freq ?? this.rng.range(24, 38);
    const beat = opts.beat ?? this.rng.range(0.35, 1.6);
    const swell = opts.swell ?? this.rng.range(0.04, 0.11);
    const swellDepth = opts.swellDepth ?? this.rng.range(0.3, 0.6);

    if (this.buses.hasWorklet) {
      let node: AudioWorkletNode;
      try {
        node = new AudioWorkletNode(c, 'dc-safe-sub', { outputChannelCount: [2] });
      } catch { return this.subBassFallback(freq, beat, swell, swellDepth); }
      node.parameters.get('freq')!.value = freq;
      node.parameters.get('beat')!.value = beat;
      node.parameters.get('swell')!.value = swell;
      node.parameters.get('swellDepth')!.value = swellDepth;
      const gp = node.parameters.get('gain')!;
      gp.value = 0;
      // A steep low-pass after the oscillator, even though it's already a sine
      // pair: the hard clip inside the worklet's ceiling generates harmonics,
      // and un-filtered clipped sub reads as a buzz instead of pressure.
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 90; lp.Q.value = 0.7;
      node.connect(lp).connect(this.buses.lowFreqInput);

      let level = 0;
      let alive = true;
      let peak = 0;
      node.port.onmessage = (e) => { peak = e.data as number; };
      const h: DroneHandle & { peak: () => number } = {
        get level() { return level; },
        get alive() { return alive; },
        peak: () => peak,
        set: (v, tc = 3.0) => {
          if (!alive || !this.ctx) return;
          level = Math.max(0, Math.min(1, v));
          // SUB_CMD_MAX keeps the *commanded* value under the DSP ceiling so
          // the drone never actually reaches the clip point in normal play.
          gp.setTargetAtTime(level * SUB_CMD_MAX, this.ctx.currentTime, tc);
        },
        stop: (fade = 2.5) => {
          if (!alive || !this.ctx) return;
          alive = false;
          level = 0;
          gp.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
          const nodeRef = node;
          setTimeout(() => {
            try { nodeRef.port.postMessage('stop'); nodeRef.disconnect(); lp.disconnect(); } catch { /* ignore */ }
          }, fade * 1000 + 400);
        },
      };
      return h;
    }
    return this.subBassFallback(freq, beat, swell, swellDepth);
  }

  /** Native-node sub drone for browsers without AudioWorklet. Same ceiling. */
  private subBassFallback(freq: number, beat: number, swell: number, swellDepth: number): DroneHandle {
    const c = this.ctx;
    if (!c) return NULL_DRONE;
    const o1 = c.createOscillator(); o1.type = 'sine'; o1.frequency.value = freq;
    const o2 = c.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq + beat;
    const mix = c.createGain(); mix.gain.value = 0.5;
    const swellOsc = c.createOscillator(); swellOsc.type = 'sine'; swellOsc.frequency.value = swell;
    const swellAmt = c.createGain(); swellAmt.gain.value = swellDepth * 0.5;
    const out = c.createGain(); out.gain.value = 0;
    const cap = c.createGain(); cap.gain.value = SUB_HARD_CEIL / 0.5; // matches DSP ceiling
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 90;
    o1.connect(mix); o2.connect(mix);
    swellOsc.connect(swellAmt).connect(out.gain);
    mix.connect(out).connect(lp).connect(cap).connect(this.buses.lowFreqInput);
    o1.start(); o2.start(); swellOsc.start();
    let level = 0, alive = true;
    return {
      get level() { return level; },
      get alive() { return alive; },
      set: (v, tc = 3.0) => {
        if (!alive || !this.ctx) return;
        level = Math.max(0, Math.min(1, v));
        out.gain.setTargetAtTime(level * SUB_CMD_MAX * (1 - swellDepth * 0.5), this.ctx.currentTime, tc);
      },
      stop: (fade = 2.5) => {
        if (!alive || !this.ctx) return;
        alive = false; level = 0;
        out.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
        setTimeout(() => {
          try { o1.stop(); o2.stop(); swellOsc.stop(); out.disconnect(); lp.disconnect(); cap.disconnect(); } catch { /* ignore */ }
        }, fade * 1000 + 400);
      },
    };
  }

  // ------------------------------------------------------- dissonant cluster

  /**
   * 3-5 oscillator cluster at deliberately unresolved spacings.
   *
   * Interval choice is the whole point. Octaves and fifths lock the ear into a
   * stable pitch percept and stop being unsettling within seconds. These ratios
   * (minor 2nd, tritone-ish, minor 9th, and a couple of micro-detunes) sit in
   * or near the roughness region and never imply a root.
   */
  dissonantCluster(opts: {
    base?: number; voices?: number; bus?: BusId; brightness?: number;
  } = {}): DroneHandle {
    const c = this.ctx;
    if (!c) return NULL_DRONE;
    const base = opts.base ?? this.rng.range(58, 96);
    const voices = opts.voices ?? this.rng.int(3, 5);
    const bus = opts.bus ?? 'entity';
    const brightness = opts.brightness ?? 0.5;

    // ratios avoiding 2:1 and 3:2 — semitone, tritone, minor 9th, +micro-detunes
    const RATIOS = [1.0, 1.0595, 1.4142, 2.1189, 1.1892, 2.8284];
    const out = c.createGain();
    out.gain.value = 0;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 380 + brightness * 2600;
    lp.Q.value = 0.5;
    out.connect(lp);
    lp.connect(this.buses.bus(bus));
    // a slice also feeds the reverb send — an unresolved cluster with a real
    // tail sounds like it belongs to the space rather than being pasted on
    const send = c.createGain(); send.gain.value = 0.35;
    lp.connect(send).connect(this.buses.reverbInput);

    const oscs: OscillatorNode[] = [];
    const lfos: OscillatorNode[] = [];
    for (let i = 0; i < voices; i++) {
      const o = c.createOscillator();
      o.type = i === 0 ? 'sine' : this.rng.next() < 0.5 ? 'triangle' : 'sine';
      const ratio = RATIOS[i % RATIOS.length];
      const f = base * ratio * this.rng.range(0.994, 1.006);
      o.frequency.value = f;
      const vg = c.createGain();
      vg.gain.value = (1 / voices) * this.rng.range(0.55, 1.0);

      // Independent slow LFOs on pitch AND amplitude, at incommensurate rates.
      // If they shared a rate the cluster would pulse in sync and become a
      // rhythm — predictable, therefore not frightening.
      const pLfo = c.createOscillator();
      pLfo.frequency.value = this.rng.range(0.031, 0.17);
      const pAmt = c.createGain();
      pAmt.gain.value = f * this.rng.range(0.0015, 0.006);
      pLfo.connect(pAmt).connect(o.frequency);

      const aLfo = c.createOscillator();
      aLfo.frequency.value = this.rng.range(0.043, 0.23);
      const aAmt = c.createGain();
      aAmt.gain.value = vg.gain.value * this.rng.range(0.25, 0.6);
      aLfo.connect(aAmt).connect(vg.gain);

      o.connect(vg).connect(out);
      o.start(); pLfo.start(); aLfo.start();
      oscs.push(o); lfos.push(pLfo, aLfo);
    }

    let level = 0, alive = true;
    return {
      get level() { return level; },
      get alive() { return alive; },
      set: (v, tc = 2.2) => {
        if (!alive || !this.ctx) return;
        level = Math.max(0, Math.min(1, v));
        out.gain.setTargetAtTime(level * 0.13, this.ctx.currentTime, tc);
      },
      stop: (fade = 3) => {
        if (!alive || !this.ctx) return;
        alive = false; level = 0;
        out.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
        setTimeout(() => {
          for (const o of oscs) { try { o.stop(); } catch { /* ignore */ } }
          for (const l of lfos) { try { l.stop(); } catch { /* ignore */ } }
          try { out.disconnect(); lp.disconnect(); send.disconnect(); } catch { /* ignore */ }
        }, fade * 1000 + 400);
      },
    };
  }

  // ------------------------------------------------------- Shepard/Risset riser

  /**
   * Endless-rising tension bank.
   *
   * `octaves` tones, each an octave apart, all sweeping upward at the same rate
   * in log-frequency. Each tone's amplitude is windowed by a fixed Gaussian in
   * log-frequency space, so a tone fades in at the bottom of the window and out
   * at the top while its octave-neighbour takes over. The result is perceived
   * continuous ascent with no actual rise in overall spectral centroid — dread
   * with no ceiling and no release.
   *
   * Amplitudes are recomputed on a coarse timer (not per audio sample) via
   * scheduled ramps, which is accurate enough for a 12+ second sweep and costs
   * essentially nothing.
   */
  shepardRiser(opts: {
    octaves?: number; lowHz?: number; sweepSeconds?: number; bus?: BusId;
  } = {}): DroneHandle {
    const c = this.ctx;
    if (!c) return NULL_DRONE;
    const octaves = opts.octaves ?? 6;
    const lowHz = opts.lowHz ?? 48;
    const sweepSeconds = opts.sweepSeconds ?? 11;
    const bus = opts.bus ?? 'entity';

    const out = c.createGain(); out.gain.value = 0;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.35;
    out.connect(bp).connect(this.buses.bus(bus));
    const send = c.createGain(); send.gain.value = 0.3;
    bp.connect(send).connect(this.buses.reverbInput);

    interface Tone { osc: OscillatorNode; gain: GainNode; phase: number; }
    const tones: Tone[] = [];
    for (let i = 0; i < octaves; i++) {
      const o = c.createOscillator();
      o.type = 'sine';
      const g = c.createGain();
      g.gain.value = 0;
      o.connect(g).connect(out);
      o.start();
      // stagger the starting phases evenly across the window
      tones.push({ osc: o, gain: g, phase: i / octaves });
    }

    let level = 0, alive = true;
    let elapsed = 0;
    // Schedule ahead in 0.25s slices. Automating from a timer means one
    // setTimeout instead of per-frame work, and the ramps themselves are
    // sample-accurate against ctx.currentTime.
    const SLICE = 0.25;
    let nextTime = c.currentTime;
    const tick = () => {
      if (!alive || !this.ctx) return;
      const cc = this.ctx;
      // keep ~0.6s of automation queued
      while (nextTime < cc.currentTime + 0.6) {
        const t = nextTime;
        for (const tn of tones) {
          // phase runs 0..1 across the whole window and wraps
          tn.phase += SLICE / sweepSeconds;
          if (tn.phase >= 1) tn.phase -= 1;
          const hz = lowHz * Math.pow(2, tn.phase * octaves);
          // Gaussian window centred at the middle of the octave span
          const x = (tn.phase - 0.5) * 2;
          const amp = Math.exp(-(x * x) * 3.2) / octaves;
          tn.osc.frequency.linearRampToValueAtTime(hz, t + SLICE);
          tn.gain.gain.linearRampToValueAtTime(amp, t + SLICE);
        }
        nextTime += SLICE;
        elapsed += SLICE;
      }
      timer = setTimeout(tick, 200) as unknown as number;
    };
    let timer = setTimeout(tick, 0) as unknown as number;

    return {
      get level() { return level; },
      get alive() { return alive; },
      set: (v, tc = 1.4) => {
        if (!alive || !this.ctx) return;
        level = Math.max(0, Math.min(1, v));
        out.gain.setTargetAtTime(level * 0.075, this.ctx.currentTime, tc);
      },
      stop: (fade = 2.5) => {
        if (!alive || !this.ctx) return;
        alive = false; level = 0;
        clearTimeout(timer);
        out.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
        setTimeout(() => {
          for (const tn of tones) { try { tn.osc.stop(); tn.gain.disconnect(); } catch { /* ignore */ } }
          try { out.disconnect(); bp.disconnect(); send.disconnect(); } catch { /* ignore */ }
        }, fade * 1000 + 400);
      },
    };
  }

  // --------------------------------------------------------- granular texture

  /**
   * Granular texture generator. Worklet-backed when available; falls back to a
   * band-passed noise bed (less alive, but never silent) otherwise.
   *
   * Returned handle exposes `shape()` so a caller (the entity approach layer)
   * can slide grain density/size/centre continuously as detection rises — the
   * texture gets denser, shorter-grained and brighter as the thing closes,
   * which reads as *approach* rather than just *louder*.
   */
  granularTexture(opts: {
    density?: number; grainSize?: number; centre?: number; scatter?: number;
    resonance?: number; spread?: number; bus?: BusId; reverbSend?: number;
  } = {}): GranularHandle {
    const c = this.ctx;
    if (!c) return NULL_GRANULAR;
    const bus = opts.bus ?? 'entity';
    const out = c.createGain(); out.gain.value = 1;
    const busNode = this.buses.bus(bus);
    out.connect(busNode);
    if (opts.reverbSend && opts.reverbSend > 0) {
      const s = c.createGain(); s.gain.value = opts.reverbSend;
      out.connect(s).connect(this.buses.reverbInput);
    }
    // Shared by both the worklet path and the fallback below: swap the bus
    // connection for a caller-supplied destination (a spatial voice input).
    let routed: AudioNode = busNode;
    const connectTo = (dest: AudioNode): void => {
      try { out.disconnect(routed); } catch { /* not connected */ }
      out.connect(dest);
      routed = dest;
    };

    if (this.buses.hasWorklet) {
      let node: AudioWorkletNode | null = null;
      try {
        node = new AudioWorkletNode(c, 'granular-texture', {
          outputChannelCount: [2],
          processorOptions: { seed: (this.rng.next() * 0xffffffff) >>> 0 },
        });
      } catch { node = null; }
      if (node) {
        const p = node.parameters;
        p.get('density')!.value = opts.density ?? 18;
        p.get('grainSize')!.value = opts.grainSize ?? 0.08;
        p.get('centre')!.value = opts.centre ?? 900;
        p.get('scatter')!.value = opts.scatter ?? 1.0;
        p.get('resonance')!.value = opts.resonance ?? 2.0;
        p.get('spread')!.value = opts.spread ?? 0.7;
        const gp = p.get('gain')!;
        gp.value = 0;
        node.connect(out);
        let level = 0, alive = true;
        const nodeRef = node;
        return {
          get level() { return level; },
          get alive() { return alive; },
          set: (v, tc = 1.2) => {
            if (!alive || !this.ctx) return;
            level = Math.max(0, Math.min(1, v));
            gp.setTargetAtTime(level, this.ctx.currentTime, tc);
          },
          connectTo,
          shape: (s) => {
            if (!alive || !this.ctx) return;
            const t = this.ctx.currentTime;
            if (s.density !== undefined) p.get('density')!.setTargetAtTime(s.density, t, 0.5);
            if (s.grainSize !== undefined) p.get('grainSize')!.setTargetAtTime(s.grainSize, t, 0.5);
            if (s.centre !== undefined) p.get('centre')!.setTargetAtTime(s.centre, t, 0.6);
            if (s.scatter !== undefined) p.get('scatter')!.setTargetAtTime(s.scatter, t, 0.6);
            if (s.resonance !== undefined) p.get('resonance')!.setTargetAtTime(s.resonance, t, 0.6);
            if (s.spread !== undefined) p.get('spread')!.setTargetAtTime(s.spread, t, 0.6);
          },
          stop: (fade = 1.5) => {
            if (!alive || !this.ctx) return;
            alive = false; level = 0;
            gp.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
            setTimeout(() => {
              try { nodeRef.port.postMessage('stop'); nodeRef.disconnect(); out.disconnect(); } catch { /* ignore */ }
            }, fade * 1000 + 300);
          },
        };
      }
    }
    return this.granularFallback(out, opts, connectTo);
  }

  /**
   * Fallback texture: a live shaped-noise (or buffer noise) source through a
   * wandering band-pass with a tremolo. Not granular, but it occupies the same
   * spectral role and stays non-repeating because the modulators are free-running.
   */
  private granularFallback(out: GainNode, opts: {
    density?: number; centre?: number; resonance?: number;
  }, connectTo: (dest: AudioNode) => void): GranularHandle {
    const c = this.ctx!;
    const src = this.noiseSource();
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = opts.centre ?? 900;
    bp.Q.value = opts.resonance ?? 2;
    const trem = c.createOscillator();
    trem.frequency.value = Math.max(0.5, (opts.density ?? 18) / 6);
    const tremAmt = c.createGain(); tremAmt.gain.value = 0.5;
    const g = c.createGain(); g.gain.value = 0;
    const wander = c.createOscillator();
    wander.frequency.value = 0.07;
    const wanderAmt = c.createGain(); wanderAmt.gain.value = (opts.centre ?? 900) * 0.35;
    wander.connect(wanderAmt).connect(bp.frequency);
    trem.connect(tremAmt).connect(g.gain);
    src.connect(bp).connect(g).connect(out);
    trem.start(); wander.start();
    let level = 0, alive = true;
    return {
      get level() { return level; },
      get alive() { return alive; },
      set: (v, tc = 1.2) => {
        if (!alive || !this.ctx) return;
        level = Math.max(0, Math.min(1, v));
        g.gain.setTargetAtTime(level * 0.5, this.ctx.currentTime, tc);
      },
      connectTo,
      shape: (s) => {
        if (!alive || !this.ctx) return;
        const t = this.ctx.currentTime;
        if (s.centre !== undefined) bp.frequency.setTargetAtTime(s.centre, t, 0.6);
        if (s.resonance !== undefined) bp.Q.setTargetAtTime(s.resonance, t, 0.6);
        if (s.density !== undefined) trem.frequency.setTargetAtTime(Math.max(0.5, s.density / 6), t, 0.6);
      },
      stop: (fade = 1.5) => {
        if (!alive || !this.ctx) return;
        alive = false; level = 0;
        g.gain.setTargetAtTime(0, this.ctx.currentTime, fade / 3);
        setTimeout(() => {
          try { trem.stop(); wander.stop(); src.stop?.(); g.disconnect(); out.disconnect(); } catch { /* ignore */ }
        }, fade * 1000 + 300);
      },
    };
  }

  // ------------------------------------------------------------- noise source

  /**
   * A live noise generator. Prefers the worklet (`shaped-noise`) because a
   * looped buffer is audibly cyclic over a 15-minute run — the exact
   * habituation failure the brief forbids. Falls back to a long buffer with a
   * randomised playback rate and start offset when worklets are unavailable.
   */
  noiseSource(tilt = 0.5, width = 0.6): AudioNode & { stop?: () => void } {
    const c = this.ctx!;
    if (this.buses.hasWorklet) {
      try {
        const n = new AudioWorkletNode(c, 'shaped-noise', {
          outputChannelCount: [2],
          processorOptions: { seed: (this.rng.next() * 0xffffffff) >>> 0 },
        });
        n.parameters.get('tilt')!.value = tilt;
        n.parameters.get('width')!.value = width;
        n.parameters.get('gain')!.value = 1;
        const wrapper = n as AudioWorkletNode & { stop?: () => void };
        wrapper.stop = () => { try { n.port.postMessage('stop'); } catch { /* ignore */ } };
        return wrapper;
      } catch { /* fall through */ }
    }
    const buf = this.getFallbackNoise(tilt);
    const s = c.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    // random rate + offset so two concurrent fallback sources don't phase-lock
    s.playbackRate.value = this.rng.range(0.92, 1.08);
    s.start(0, this.rng.range(0, buf.duration));
    return s;
  }

  private fallbackNoise = new Map<number, AudioBuffer>();
  private getFallbackNoise(tilt: number): AudioBuffer {
    const key = Math.round(tilt * 4);
    const cached = this.fallbackNoise.get(key);
    if (cached) return cached;
    const c = this.ctx!;
    // 8 seconds, stereo-decorrelated — long enough that the loop point is hard
    // to identify, short enough not to cost real memory
    const len = Math.floor(c.sampleRate * 8);
    const buf = c.createBuffer(2, len, c.sampleRate);
    const t = key / 4;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, brown = 0;
      for (let i = 0; i < len; i++) {
        const w = this.rng.next() * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        const pink = (b0 + b1 + b2 + w * 0.1848) * 0.22;
        brown = (brown + 0.02 * w) / 1.02;
        d[i] = t <= 0.5 ? w * (1 - t * 2) + pink * t * 2
          : pink * (1 - (t - 0.5) * 2) + brown * 3.2 * ((t - 0.5) * 2);
      }
    }
    this.fallbackNoise.set(key, buf);
    return buf;
  }

  // -------------------------------------------------------------- "wrongness"

  /**
   * Ring-modulation + comb-filter "wrongness" processor.
   *
   * Returns an insert node pair. Feed a diegetic sound in; what comes out is
   * still recognisably that sound, but its harmonic identity has been broken.
   * `amount` crossfades dry→wet so this can be applied *briefly* — the whole
   * effect depends on the player having just heard the correct version.
   */
  wrongnessInsert(opts: { modHz?: number; combHz?: number; amount?: number } = {}): {
    input: GainNode; output: GainNode; setAmount(a: number, tc?: number): void; dispose(): void;
  } {
    const c = this.ctx!;
    const input = c.createGain();
    const output = c.createGain();
    const dry = c.createGain(); dry.gain.value = 1;
    const wet = c.createGain(); wet.gain.value = 0;

    // ring modulator: multiply the signal by a sine. Implemented as a
    // GainNode whose gain is driven by an oscillator — the canonical Web Audio
    // ring-mod, and free.
    const ring = c.createGain();
    ring.gain.value = 0;
    const mod = c.createOscillator();
    mod.type = 'sine';
    mod.frequency.value = opts.modHz ?? this.rng.range(31, 97);
    mod.connect(ring.gain);
    mod.start();

    // comb: a short feedback delay. The delay time sets a pitched resonance
    // that has no business existing in the source material.
    const combHz = opts.combHz ?? this.rng.range(70, 260);
    const delay = c.createDelay(0.05);
    delay.delayTime.value = 1 / combHz;
    const fb = c.createGain(); fb.gain.value = 0.62;
    const combOut = c.createGain(); combOut.gain.value = 0.7;

    input.connect(dry).connect(output);
    input.connect(ring);
    ring.connect(wet);
    ring.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(combOut).connect(wet);
    wet.connect(output);

    return {
      input, output,
      setAmount: (a, tc = 0.15) => {
        const t = c.currentTime;
        const v = Math.max(0, Math.min(1, a));
        wet.gain.setTargetAtTime(v, t, tc);
        dry.gain.setTargetAtTime(1 - v * 0.7, t, tc);
      },
      dispose: () => {
        try { mod.stop(); input.disconnect(); output.disconnect(); delay.disconnect(); fb.disconnect(); } catch { /* ignore */ }
      },
    };
  }

  // ------------------------------------------------------- procedural reverb

  /**
   * Synthesise an impulse response at runtime.
   *
   * Structure: a set of discrete early reflections (which is what actually
   * communicates room *size* and whether you're near a wall) followed by an
   * exponentially-decaying noise tail with a frequency-dependent decay rate
   * (high frequencies die faster in any real space, more so in a soft forest
   * than in a concrete tunnel).
   *
   * `openness` 0 = tight interior, 1 = open field. `absorption` 0 = hard
   * reflective (tunnel/concrete), 1 = very soft (dense forest, snow).
   */
  makeImpulseResponse(opts: {
    seconds?: number; openness: number; absorption: number; predelay?: number;
  }): AudioBuffer | null {
    const c = this.ctx;
    if (!c) return null;
    const openness = clamp01(opts.openness);
    const absorption = clamp01(opts.absorption);
    // Quantise the cache key: nobody can hear the difference between an
    // absorption of 0.61 and 0.63, and this keeps us from synthesising a new
    // IR every time the player takes a step.
    const key = `${Math.round(openness * 6)}_${Math.round(absorption * 6)}`;
    const cached = this.irCache.get(key);
    if (cached) return cached;

    // Open forest has a long, diffuse, quiet tail; a tunnel has a shorter but
    // much denser and brighter one; a cabin interior is short and dead.
    const seconds = opts.seconds ?? (0.45 + openness * 2.6) * (1.35 - absorption * 0.6);
    const len = Math.max(256, Math.floor(c.sampleRate * seconds));
    const buf = c.createBuffer(2, len, c.sampleRate);
    const rng = this.rng.fork(0x1234 + Math.round(openness * 100) * 7 + Math.round(absorption * 100));

    const predelay = Math.floor((opts.predelay ?? (0.004 + openness * 0.026)) * c.sampleRate);
    // decay constants: high band always decays faster than low
    const lowDecay = 2.6 / seconds;
    const highDecay = lowDecay * (1.8 + absorption * 4.5);

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      // one-pole split so we can decay the two bands at different rates
      let lpState = 0;
      for (let i = predelay; i < len; i++) {
        const t = (i - predelay) / c.sampleRate;
        const w = rng.next() * 2 - 1;
        lpState += (w - lpState) * 0.16;     // ~low band
        const high = w - lpState;            // ~high band
        const eLow = Math.exp(-lowDecay * t);
        const eHigh = Math.exp(-highDecay * t);
        d[i] = (lpState * 2.4 * eLow + high * eHigh * (1 - absorption * 0.55)) * 0.5;
      }
      // ---- early reflections ----
      // Count and spacing carry the room impression: few, widely-spaced,
      // strong reflections = large hard space; many close weak ones = clutter.
      const refl = Math.round(4 + openness * 9);
      for (let r = 0; r < refl; r++) {
        const tt = (0.006 + rng.next() * (0.02 + openness * 0.14));
        const idx = predelay + Math.floor(tt * c.sampleRate);
        if (idx >= len) continue;
        const amp = (0.55 - r * 0.035) * (1 - absorption * 0.6) * rng.range(0.5, 1);
        d[idx] += amp * (rng.next() < 0.5 ? -1 : 1);
        // a smeared shoulder, so the reflection isn't a naked click
        for (let k = 1; k < 40 && idx + k < len; k++) {
          d[idx + k] += amp * (rng.next() * 2 - 1) * (1 - k / 40) * 0.35;
        }
      }
      // Direct-path spike only for tight spaces — an open field has no
      // meaningful single first reflection, which is exactly why open
      // environments feel "dry and exposed".
      if (openness < 0.5) d[predelay] += (0.6 - openness) * 0.8;
    }

    // Energy-normalise so switching IRs doesn't jump the reverb level; scale by
    // openness so bigger spaces are genuinely wetter.
    let energy = 0;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) energy += d[i] * d[i];
    }
    const norm = energy > 0 ? (0.55 + openness * 0.5) / Math.sqrt(energy / (len * 2)) / 40 : 1;
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] *= norm;
    }

    this.irCache.set(key, buf);
    return buf;
  }

  clearIrCache(): void { this.irCache.clear(); }
}

/** commanded sub-bass maximum; sits under the worklet's HARD_CEIL by design */
const SUB_CMD_MAX = 0.13;

export interface GranularShape {
  density?: number; grainSize?: number; centre?: number;
  scatter?: number; resonance?: number; spread?: number;
}

export interface GranularHandle extends DroneHandle {
  shape(s: GranularShape): void;
  /**
   * Reroute this texture's output away from its bus and into a custom
   * destination — in practice a SpatialVoice input, so a granular layer can be
   * localised in the world instead of playing flat on the bus. Idempotent-ish:
   * calling it again moves the output again.
   */
  connectTo(dest: AudioNode): void;
}

const NULL_GRANULAR: GranularHandle = {
  set: () => undefined, level: 0, stop: () => undefined, alive: false,
  shape: () => undefined, connectTo: () => undefined,
};

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
