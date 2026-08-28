import { SeededRandom } from '../core/SeededRandom';

export type Surface = 'leaf' | 'mud' | 'wood' | 'metal' | 'water' | 'rock';

/**
 * 100% procedural Web Audio engine — zero samples.
 * Buses: ambience / foley / entity / ui / master (with soft limiter).
 * Seeded variation: repeated events (footsteps, entity tones) never repeat identically.
 */
export class SynthEngine {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private buses = new Map<string, GainNode>();
  private rng = new SeededRandom(0xA0D10);
  private started = false;

  // ambient nodes
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private wind2Gain!: GainNode;
  private rainGain: GainNode | null = null;
  private noiseBuf!: AudioBuffer;
  private pinkBuf!: AudioBuffer;
  private brownBuf!: AudioBuffer;

  // fear layer
  private tinnitusOsc: OscillatorNode | null = null;
  private tinnitusGain: GainNode | null = null;
  private staticGain: GainNode | null = null;

  // breathing
  private breathTimer = 0;
  private breathPhase: 'in' | 'out' = 'in';

  // timers
  private owlTimer = 8;
  private creakTimer = 14;
  private insectTimer = 2;
  private gustPhase = 0;

  // listener world position (set by SpatialAudio)
  listenerX = 0; listenerY = 0; listenerZ = 0;

  volume = 0.8;

  /** must be called from a user gesture */
  init(): void {
    if (this.started) return;
    this.started = true;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    const c = this.ctx;

    this.master = c.createGain();
    this.master.gain.value = this.volume;
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 4;
    this.limiter.ratio.value = 14;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.24;
    this.master.connect(this.limiter);
    this.limiter.connect(c.destination);

    for (const name of ['ambience', 'foley', 'entity', 'ui']) {
      const g = c.createGain();
      g.connect(this.master);
      this.buses.set(name, g);
    }
    this.buses.get('entity')!.gain.value = 0.9;
    this.buses.get('foley')!.gain.value = 0.9;

    this.makeNoiseBuffers();
    this.startAmbience();
    this.startFearLayer();
  }

  resume(): void { this.ctx?.resume().catch(() => undefined); }
  suspend(): void { this.ctx?.suspend().catch(() => undefined); }

  setVolume(v: number): void {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  // ---------------- noise buffers ----------------
  private makeNoiseBuffers(): void {
    const c = this.ctx!;
    const len = c.sampleRate * 2;
    const mk = () => c.createBuffer(1, len, c.sampleRate);
    this.noiseBuf = mk();
    this.pinkBuf = mk();
    this.brownBuf = mk();
    const w = this.noiseBuf.getChannelData(0);
    const p = this.pinkBuf.getChannelData(0);
    const b = this.brownBuf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, brown = 0;
    const r = this.rng;
    for (let i = 0; i < len; i++) {
      const white = r.next() * 2 - 1;
      w[i] = white;
      b0 = 0.997 * b0 + 0.029591 * white;
      b1 = 0.985 * b1 + 0.032534 * white;
      b2 = 0.950 * b2 + 0.048056 * white;
      p[i] = (b0 + b1 + b2 + white * 0.05) * 0.6;
      brown = (brown + 0.02 * white) / 1.02;
      b[i] = brown * 3.5;
    }
  }

  private noiseSource(buf: AudioBuffer, loop = true): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    return s;
  }

  private adsr(g: GainNode, t0: number, a: number, d: number, peak: number, sustain = 0, rel = 0.05): void {
    const p = g.gain;
    p.cancelScheduledValues(t0);
    p.setValueAtTime(0.0001, t0);
    p.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + a);
    p.exponentialRampToValueAtTime(Math.max(sustain, 0.0001), t0 + a + d);
    if (sustain <= 0.0002) return;
    p.exponentialRampToValueAtTime(0.0001, t0 + a + d + rel);
  }

  // ---------------- ambience ----------------
  private startAmbience(): void {
    const c = this.ctx!;
    const bus = this.buses.get('ambience')!;
    // canopy wind: pink noise → wandering bandpass
    const src = this.noiseSource(this.pinkBuf);
    this.windFilter = c.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 420;
    this.windFilter.Q.value = 0.6;
    this.windGain = c.createGain();
    this.windGain.gain.value = 0.12;
    src.connect(this.windFilter).connect(this.windGain).connect(bus);
    src.start();
    // deep air: brown noise low level
    const src2 = this.noiseSource(this.brownBuf);
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 160;
    this.wind2Gain = c.createGain(); this.wind2Gain.gain.value = 0.1;
    src2.connect(lp).connect(this.wind2Gain).connect(bus);
    src2.start();
  }

  /** start light rain layer */
  setRain(on: boolean): void {
    if (!this.ctx) return;
    const c = this.ctx;
    if (on && !this.rainGain) {
      const src = this.noiseSource(this.noiseBuf);
      const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1400;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 8000;
      this.rainGain = c.createGain();
      this.rainGain.gain.value = 0;
      this.rainGain.gain.linearRampToValueAtTime(0.05, c.currentTime + 4);
      src.connect(hp).connect(lp).connect(this.rainGain).connect(this.buses.get('ambience')!);
      src.start();
    } else if (!on && this.rainGain) {
      const g = this.rainGain;
      g.gain.linearRampToValueAtTime(0, c.currentTime + 3);
      setTimeout(() => g.disconnect(), 3600);
      this.rainGain = null;
    }
  }

  private startFearLayer(): void {
    const c = this.ctx!;
    const bus = this.buses.get('entity')!;
    // tinnitus sine
    this.tinnitusOsc = c.createOscillator();
    this.tinnitusOsc.frequency.value = 3900;
    this.tinnitusGain = c.createGain();
    this.tinnitusGain.gain.value = 0;
    this.tinnitusOsc.connect(this.tinnitusGain).connect(bus);
    this.tinnitusOsc.start();
    // static hiss
    const src = this.noiseSource(this.noiseBuf);
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2600; bp.Q.value = 0.4;
    this.staticGain = c.createGain(); this.staticGain.gain.value = 0;
    src.connect(bp).connect(this.staticGain).connect(bus);
    src.start();
  }

  /** fear 0..1 — drives tinnitus + static + breathing rate */
  setFearLevel(f: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.tinnitusGain?.gain.setTargetAtTime(f * f * 0.028, t, 0.4);
    this.staticGain?.gain.setTargetAtTime(f * 0.05, t, 0.3);
    if (this.tinnitusOsc) this.tinnitusOsc.frequency.setTargetAtTime(3400 + f * 1400, t, 0.5);
  }

  // ---------------- per-frame ambient update ----------------
  update(dt: number, opts: { windStrength: number; inForest: boolean; fear: number; sprinting: boolean; moving: boolean; time: number }): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // wind gusts wander
    this.gustPhase += dt * 0.13;
    const gust = 0.5 + 0.5 * Math.sin(this.gustPhase) * Math.sin(this.gustPhase * 0.37 + 1.7);
    const wind = opts.windStrength * (0.5 + gust * 0.7);
    this.windGain.gain.setTargetAtTime(0.05 + wind * 0.16, t, 0.6);
    this.windFilter.frequency.setTargetAtTime(300 + wind * 700 + gust * 200, t, 0.8);

    // owl — sparse
    this.owlTimer -= dt;
    if (this.owlTimer <= 0) {
      this.owlTimer = this.rng.range(14, 42);
      this.owl();
    }
    // insects in warm spots (subtle)
    this.insectTimer -= dt;
    if (this.insectTimer <= 0) {
      this.insectTimer = this.rng.range(1.5, 5);
      if (this.rng.next() < 0.5) this.insect();
    }
    // structural creaks
    this.creakTimer -= dt;
    if (this.creakTimer <= 0) {
      this.creakTimer = this.rng.range(9, 26);
      this.creak();
    }
    // breathing
    this.updateBreathing(dt, opts);
  }

  private updateBreathing(dt: number, opts: { fear: number; sprinting: boolean; moving: boolean }): void {
    const rate = 0.28 + opts.fear * 0.55 + (opts.sprinting ? 0.5 : 0) + (opts.moving ? 0.12 : 0);
    this.breathTimer += dt * rate;
    const cycle = this.breathTimer % 1;
    const depth = 0.014 + opts.fear * 0.05 + (opts.sprinting ? 0.04 : 0);
    if (this.breathPhase === 'in' && cycle > 0.42) {
      this.breathPhase = 'out';
      this.breath(false, depth);
    } else if (this.breathPhase === 'out' && cycle < 0.42 && cycle > 0.02) {
      this.breathPhase = 'in';
      this.breath(true, depth * 0.8);
    }
  }

  private breath(inhale: boolean, depth: number): void {
    const c = this.ctx!;
    const t = c.currentTime;
    const src = this.noiseSource(this.pinkBuf, false);
    src.playbackRate.value = inhale ? 0.9 : 0.7;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = inhale ? 900 : 620;
    f.Q.value = 1.4;
    const g = c.createGain();
    this.adsr(g, t, 0.25, inhale ? 0.5 : 0.75, depth);
    src.connect(f).connect(g).connect(this.buses.get('foley')!);
    src.start(t, this.rng.range(0, 1));
    src.stop(t + 1.4);
  }

  // ---------------- one-shots ----------------

  footstep(surface: Surface, intensity: number, pan = 0): void {
    if (!this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const v = 0.16 * intensity * this.rng.range(0.85, 1.15);
    const g = c.createGain();
    const out = this.panNode(g, pan, 'foley');
    switch (surface) {
      case 'leaf': {
        // crunch: short noise burst through resonant bandpasses
        const src = this.noiseSource(this.noiseBuf, false);
        const f = c.createBiquadFilter(); f.type = 'bandpass';
        f.frequency.value = this.rng.range(900, 1600); f.Q.value = this.rng.range(0.8, 2.2);
        this.adsr(g, t, 0.004, this.rng.range(0.05, 0.1), v);
        src.connect(f).connect(g);
        src.start(t, this.rng.range(0, 1)); src.stop(t + 0.2);
        // second rustle layer
        const g2 = c.createGain();
        const f2 = c.createBiquadFilter(); f2.type = 'highpass'; f2.frequency.value = 2400;
        this.adsr(g2, t + 0.01, 0.01, 0.12, v * 0.4);
        const src2 = this.noiseSource(this.pinkBuf, false);
        src2.connect(f2).connect(g2).connect(out);
        src2.start(t + 0.01, this.rng.range(0, 1)); src2.stop(t + 0.3);
        break;
      }
      case 'mud': {
        const src = this.noiseSource(this.brownBuf, false);
        const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = this.rng.range(260, 420);
        this.adsr(g, t, 0.012, 0.12, v * 1.3);
        src.connect(f).connect(g);
        src.start(t, this.rng.range(0, 1)); src.stop(t + 0.25);
        break;
      }
      case 'wood': {
        // modal knock + thud
        this.modal(t, this.rng.range(180, 260), 0.16, v * 0.9, g);
        const src = this.noiseSource(this.brownBuf, false);
        const g2 = c.createGain();
        this.adsr(g2, t, 0.003, 0.06, v * 0.6);
        src.connect(g2).connect(out);
        src.start(t, this.rng.range(0, 1)); src.stop(t + 0.12);
        break;
      }
      case 'metal': {
        this.modal(t, this.rng.range(420, 640), 0.22, v * 0.5, g);
        this.modal(t, this.rng.range(1100, 1500), 0.1, v * 0.2, g);
        break;
      }
      case 'water': {
        const src = this.noiseSource(this.pinkBuf, false);
        const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = this.rng.range(700, 1100); f.Q.value = 1.8;
        this.adsr(g, t, 0.008, 0.18, v * 1.2);
        src.connect(f).connect(g);
        src.start(t, this.rng.range(0, 1)); src.stop(t + 0.3);
        break;
      }
      default: {
        const src = this.noiseSource(this.noiseBuf, false);
        const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
        this.adsr(g, t, 0.005, 0.08, v);
        src.connect(f).connect(g);
        src.start(t, this.rng.range(0, 1)); src.stop(t + 0.15);
      }
    }
    if (g.numberOfOutputs === 0) g.connect(out);
  }

  /** short modal resonator — wood/metal knocks */
  private modal(t: number, freq: number, decay: number, vol: number, out: GainNode): void {
    const c = this.ctx!;
    const osc = c.createOscillator();
    osc.frequency.value = freq * this.rng.range(0.94, 1.06);
    const g = c.createGain();
    this.adsr(g, t, 0.002, decay, vol);
    osc.connect(g).connect(out);
    osc.start(t); osc.stop(t + decay + 0.1);
  }

  private panNode(input: GainNode, pan: number, bus: string): GainNode | AudioNode {
    const c = this.ctx!;
    if (Math.abs(pan) < 0.05 || !c.createStereoPanner) {
      input.connect(this.buses.get(bus)!);
      return this.buses.get(bus)!;
    }
    const p = c.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    input.connect(p);
    p.connect(this.buses.get(bus)!);
    return p;
  }

  owl(): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const hoot = (t0: number, f: number, dur: number) => {
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * 0.9, t0);
      o.frequency.exponentialRampToValueAtTime(f, t0 + 0.06);
      o.frequency.exponentialRampToValueAtTime(f * 0.86, t0 + dur);
      const g = c.createGain();
      this.adsr(g, t0, 0.05, dur, 0.022);
      const pan = c.createStereoPanner ? c.createStereoPanner() : null;
      if (pan) { pan.pan.value = this.rng.range(-0.9, 0.9); o.connect(g).connect(pan).connect(this.buses.get('ambience')!); }
      else o.connect(g).connect(this.buses.get('ambience')!);
      o.start(t0); o.stop(t0 + dur + 0.1);
    };
    const base = this.rng.range(330, 400);
    hoot(t, base, 0.28);
    hoot(t + 0.4, base * 0.96, 0.5);
    if (this.rng.next() < 0.5) hoot(t + 1.1, base, 0.35);
  }

  private insect(): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'triangle';
    const f0 = this.rng.range(4200, 5800);
    o.frequency.value = f0;
    const am = c.createOscillator();
    am.frequency.value = this.rng.range(24, 40);
    const amg = c.createGain(); amg.gain.value = 0.5;
    const g = c.createGain(); g.gain.value = 0;
    am.connect(amg).connect(g.gain);
    g.gain.setValueAtTime(0.004, t);
    g.gain.setTargetAtTime(0, t + this.rng.range(0.3, 1.2), 0.2);
    const pan = c.createStereoPanner ? c.createStereoPanner() : null;
    if (pan) { pan.pan.value = this.rng.range(-1, 1); o.connect(g).connect(pan).connect(this.buses.get('ambience')!); }
    else o.connect(g).connect(this.buses.get('ambience')!);
    o.start(t); am.start(t);
    o.stop(t + 2); am.stop(t + 2);
  }

  creak(pan = 0): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    const f0 = this.rng.range(90, 220);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * this.rng.range(0.6, 1.4), t + 0.4);
    const flt = c.createBiquadFilter(); flt.type = 'bandpass'; flt.frequency.value = f0 * 2; flt.Q.value = 6;
    const g = c.createGain();
    this.adsr(g, t, 0.09, 0.5, 0.012);
    o.connect(flt).connect(g);
    this.panNode(g, pan === 0 ? this.rng.range(-0.8, 0.8) : pan, 'ambience');
    o.start(t); o.stop(t + 0.8);
  }

  /** Palebark: ambiguous distant cue — snapped branch / footfall / sub-rumble. Never identical twice. */
  entityCue(dist: number, kind?: 'snap' | 'footfall' | 'rumble' | 'tone'): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const k = kind ?? (dist > 34 ? this.rng.pick(['snap', 'footfall', 'rumble'] as const) : 'tone');
    const prox = Math.max(0, 1 - dist / 60);
    switch (k) {
      case 'snap': {
        const g = c.createGain();
        this.adsr(g, t, 0.001, 0.03, 0.14 * prox);
        const src = this.noiseSource(this.noiseBuf, false);
        const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = this.rng.range(1500, 3200); f.Q.value = 3;
        src.connect(f).connect(g);
        this.panNode(g, this.rng.range(-1, 1), 'entity');
        src.start(t, this.rng.range(0, 1)); src.stop(t + 0.1);
        break;
      }
      case 'footfall': {
        const g = c.createGain();
        this.adsr(g, t, 0.004, 0.09, 0.12 * prox);
        const src = this.noiseSource(this.brownBuf, false);
        const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = this.rng.range(180, 320);
        src.connect(f).connect(g);
        this.panNode(g, this.rng.range(-1, 1), 'entity');
        src.start(t, this.rng.range(0, 1)); src.stop(t + 0.2);
        break;
      }
      case 'rumble': {
        const o = c.createOscillator();
        o.type = 'sine';
        o.frequency.value = this.rng.range(34, 52);
        const g = c.createGain();
        this.adsr(g, t, 0.3, 1.6, 0.10 * prox + 0.01);
        o.connect(g).connect(this.buses.get('entity')!);
        o.start(t); o.stop(t + 2.2);
        break;
      }
      case 'tone': {
        // the unnatural close-proximity tone — detuned cluster, unique each time
        const base = this.rng.range(55, 75);
        for (let i = 0; i < 3; i++) {
          const o = c.createOscillator();
          o.type = i === 0 ? 'sine' : 'triangle';
          o.frequency.value = base * (1 + i * this.rng.range(0.008, 0.03));
          const g = c.createGain();
          this.adsr(g, t, 0.12, 0.9 + i * 0.2, (0.055 - i * 0.014) * (0.4 + prox));
          const sh = c.createWaveShaper();
          if (i === 2) sh.curve = this.distCurve(14);
          o.connect(sh).connect(g).connect(this.buses.get('entity')!);
          o.start(t); o.stop(t + 1.6 + i * 0.2);
        }
        break;
      }
    }
  }

  private distCurve(amount: number): Float32Array<ArrayBuffer> {
    const n = 256, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  // ---------------- UI / system ----------------

  uiClick(): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(); o.type = 'square'; o.frequency.value = 1400;
    const g = c.createGain();
    this.adsr(g, t, 0.001, 0.03, 0.03);
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2400;
    o.connect(f).connect(g).connect(this.buses.get('ui')!);
    o.start(t); o.stop(t + 0.08);
  }

  flashlightClick(on: boolean): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const gm = c.createGain();
    gm.connect(this.buses.get('ui')!);
    this.modal(t, on ? 2200 : 1700, 0.05, 0.08, gm);
    const g = c.createGain();
    this.adsr(g, t, 0.001, 0.02, 0.06);
    const src = this.noiseSource(this.noiseBuf, false);
    const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 3000;
    src.connect(f).connect(g).connect(this.buses.get('ui')!);
    src.start(t, this.rng.range(0, 1)); src.stop(t + 0.06);
  }

  batteryWarning(): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    for (let i = 0; i < 2; i++) {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = 880 - i * 140;
      const g = c.createGain();
      this.adsr(g, t + i * 0.16, 0.005, 0.09, 0.035);
      o.connect(g).connect(this.buses.get('ui')!);
      o.start(t + i * 0.16); o.stop(t + i * 0.16 + 0.14);
    }
  }

  tapePickup(): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    // plastic clack + tape-whirr shimmer
    const gm = c.createGain();
    gm.connect(this.buses.get('ui')!);
    this.modal(t, 900, 0.06, 0.09, gm);
    const src = this.noiseSource(this.pinkBuf, false);
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 3000; f.Q.value = 4;
    const g = c.createGain();
    this.adsr(g, t + 0.05, 0.05, 0.5, 0.02);
    src.connect(f).connect(g).connect(this.buses.get('ui')!);
    src.start(t + 0.05, this.rng.range(0, 1)); src.stop(t + 0.8);
    // confirm chime — small detuned fifth
    for (const [fq, dt2] of [[523, 0.12], [784, 0.22]] as const) {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = fq;
      const g2 = c.createGain();
      this.adsr(g2, t + dt2, 0.01, 0.5, 0.03);
      o.connect(g2).connect(this.buses.get('ui')!);
      o.start(t + dt2); o.stop(t + dt2 + 0.7);
    }
  }

  /** tape audio-log playback voice: filtered bandlimited murmur under the subtitles */
  tapeVoice(duration: number): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const src = this.noiseSource(this.pinkBuf, false);
    const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1100; f.Q.value = 2.5;
    const g = c.createGain(); g.gain.value = 0;
    // syllable-like AM
    const lfo = c.createOscillator(); lfo.frequency.value = 7.3;
    const lfoG = c.createGain(); lfoG.gain.value = 0.012;
    lfo.connect(lfoG).connect(g.gain);
    g.gain.setValueAtTime(0.016, t);
    g.gain.setValueAtTime(0.016, t + duration - 0.3);
    g.gain.linearRampToValueAtTime(0, t + duration);
    src.connect(f).connect(g).connect(this.buses.get('ui')!);
    src.start(t, this.rng.range(0, 1)); src.stop(t + duration);
    lfo.start(t); lfo.stop(t + duration);
  }

  /** capture: the tape tears — full-spectrum blast then cut */
  captureSting(): void {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const src = this.noiseSource(this.noiseBuf, false);
    const g = c.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    const sh = c.createWaveShaper();
    sh.curve = this.distCurve(60);
    src.connect(sh).connect(g).connect(this.buses.get('entity')!);
    src.start(t); src.stop(t + 1.5);
    const o = c.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(60, t);
    o.frequency.exponentialRampToValueAtTime(28, t + 1.2);
    const g2 = c.createGain();
    g2.gain.setValueAtTime(0.22, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 1.3);
    o.connect(g2).connect(this.buses.get('entity')!);
    o.start(t); o.stop(t + 1.4);
  }
}
