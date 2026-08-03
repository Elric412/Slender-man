/**
 * AudioWorklet DSP source, shipped as a string and instantiated from a Blob URL.
 *
 * Why a string and not a separate `.js` file: STATIC is fully offline after
 * first load and has zero external assets. A `new AudioWorkletNode` needs its
 * module fetched over the network; bundling the source into the JS chunk and
 * handing `addModule` a Blob URL keeps the "no downloads at runtime" property
 * intact and means the worklet is available on the very first user gesture with
 * no round-trip.
 *
 * Why worklets at all (rather than `ScriptProcessorNode`, which is deprecated,
 * or a graph of native nodes): granular synthesis needs per-sample grain
 * scheduling with sample-accurate envelopes, and 1/f noise shaping needs a
 * recursive filter over every sample. Doing either on the main thread means
 * every GC pause and every long render frame becomes an audible dropout. These
 * processors run on the audio render thread and allocate nothing per block.
 *
 * Three processors:
 *
 * 1. `granular-texture` — overlapping grains of internally-generated filtered
 *    noise. This is the Palebark's approach texture, the wind-through-branches
 *    layer, and the interference bed. Grain size / density / pitch scatter /
 *    brightness are AudioParams, so the Director can automate them
 *    sample-accurately instead of stepping them once per frame.
 *
 * 2. `shaped-noise` — a single noise generator with a continuously tiltable
 *    spectrum (white ⇄ pink ⇄ brown ⇄ "deep air"). Replaces the old approach of
 *    pre-baking three separate 2-second noise buffers and looping them, which
 *    is audibly cyclic: a 2s loop repeating for a 15-minute run is exactly the
 *    habituation failure §9 of the brief forbids. Generated live, it never
 *    repeats.
 *
 * 3. `dc-safe-sub` — the low-frequency dread oscillator with a hard internal
 *    output ceiling. The cap lives *inside the DSP* rather than only in a
 *    GainNode so no automation bug, settings-migration bug, or malicious
 *    console poke can push the ~20-45Hz layer past the safe limit (§11).
 */

export const DREAD_WORKLET_SOURCE = String.raw`
// ---- shared: fast, allocation-free RNG (xorshift32) -------------------------
// Each processor gets its own stream, seeded from the constructor options, so
// audio randomness stays reproducible for the seeded test runs while still
// varying between concurrent voices.
class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 0x9E3779B9; }
  next() {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    this.s = x;
    return x / 4294967296;
  }
  bi() { return this.next() * 2 - 1; }
}

// ---- 1. granular texture ---------------------------------------------------
// A fixed pool of grain slots is pre-allocated at construction. Grains are
// recycled, never allocated, so the audio thread never triggers GC.
const MAX_GRAINS = 48;

class GranularTexture extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // grains per second
      { name: 'density',    defaultValue: 18,   minValue: 0,    maxValue: 220, automationRate: 'k-rate' },
      // seconds
      { name: 'grainSize',  defaultValue: 0.08, minValue: 0.004, maxValue: 0.8, automationRate: 'k-rate' },
      // centre of the grain band, Hz
      { name: 'centre',     defaultValue: 900,  minValue: 40,   maxValue: 12000, automationRate: 'k-rate' },
      // octaves of random scatter applied to each grain's band
      { name: 'scatter',    defaultValue: 1.0,  minValue: 0,    maxValue: 4,   automationRate: 'k-rate' },
      // resonance of the per-grain band-pass
      { name: 'resonance',  defaultValue: 2.0,  minValue: 0.3,  maxValue: 24,  automationRate: 'k-rate' },
      { name: 'gain',       defaultValue: 0.0,  minValue: 0,    maxValue: 1.4, automationRate: 'a-rate' },
      // 0 = grains centred, 1 = grains scattered hard across the stereo field
      { name: 'spread',     defaultValue: 0.7,  minValue: 0,    maxValue: 1,   automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const seed = (options && options.processorOptions && options.processorOptions.seed) || 12345;
    this.rng = new Rng(seed);
    this.grains = new Array(MAX_GRAINS);
    for (let i = 0; i < MAX_GRAINS; i++) {
      this.grains[i] = {
        active: false, age: 0, len: 1,
        // 2-pole state-variable band-pass state per grain
        b0: 0, b1: 0, f: 0.1, q: 0.3,
        panL: 0.7, panR: 0.7, amp: 0,
      };
    }
    this.spawnAccum = 0;
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }

  spawn(density, grainSize, centre, scatter, resonance, spread) {
    for (let i = 0; i < MAX_GRAINS; i++) {
      const g = this.grains[i];
      if (g.active) continue;
      const r = this.rng;
      // Per-grain pitch scatter in octaves. Scattering in log-frequency (rather
      // than linear Hz) is what makes the texture read as one material rather
      // than a bag of unrelated tones.
      const oct = r.bi() * scatter;
      const hz = Math.min(sampleRate * 0.45, Math.max(20, centre * Math.pow(2, oct)));
      g.f = 2 * Math.sin(Math.PI * hz / sampleRate);
      g.q = 1 / Math.max(0.35, resonance);
      g.len = Math.max(4, Math.floor(grainSize * (0.55 + r.next() * 0.9) * sampleRate));
      g.age = 0;
      g.b0 = 0; g.b1 = 0;
      g.amp = 0.35 + r.next() * 0.65;
      // equal-power pan
      const pan = r.bi() * spread;
      const th = (pan * 0.5 + 0.5) * Math.PI * 0.5;
      g.panL = Math.cos(th); g.panR = Math.sin(th);
      g.active = true;
      return;
    }
    // pool exhausted → drop the grain. Dropping is correct: at >48 concurrent
    // grains the texture is already dense enough that one more is inaudible,
    // and growing the pool would mean allocating on the audio thread.
  }

  process(_inputs, outputs, params) {
    const out = outputs[0];
    const L = out[0], R = out.length > 1 ? out[1] : out[0];
    const n = L.length;
    const density = params.density[0];
    const grainSize = params.grainSize[0];
    const centre = params.centre[0];
    const scatter = params.scatter[0];
    const resonance = params.resonance[0];
    const spread = params.spread[0];
    const gainArr = params.gain;
    const gainConst = gainArr.length === 1;

    // schedule new grains for this block
    if (this.alive && density > 0) {
      this.spawnAccum += (density * n) / sampleRate;
      while (this.spawnAccum >= 1) {
        this.spawnAccum -= 1;
        this.spawn(density, grainSize, centre, scatter, resonance, spread);
      }
    }

    for (let i = 0; i < n; i++) { L[i] = 0; if (R !== L) R[i] = 0; }

    let anyActive = false;
    for (let k = 0; k < MAX_GRAINS; k++) {
      const g = this.grains[k];
      if (!g.active) continue;
      anyActive = true;
      const f = g.f, q = g.q, invLen = 1 / g.len;
      let b0 = g.b0, b1 = g.b1, age = g.age;
      for (let i = 0; i < n; i++) {
        if (age >= g.len) { g.active = false; break; }
        // Hann window — no clicks at grain boundaries, and overlapping Hann
        // grains sum to a smooth bed rather than a pulsing one.
        const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * age * invLen);
        const white = this.rng.bi();
        // state-variable band-pass (Chamberlin): band output is b0
        const hp = white - b1 - q * b0;
        b0 += f * hp;
        b1 += f * b0;
        const s = b0 * w * g.amp * (gainConst ? gainArr[0] : gainArr[i]);
        L[i] += s * g.panL;
        if (R !== L) R[i] += s * g.panR;
        age++;
      }
      g.b0 = b0; g.b1 = b1; g.age = age;
    }
    return this.alive || anyActive;
  }
}
registerProcessor('granular-texture', GranularTexture);

// ---- 2. spectrum-tiltable noise -------------------------------------------
class ShapedNoise extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // 0 = white, 0.5 = pink, 1 = brown, >1 = "deep air" (very heavy tilt)
      { name: 'tilt', defaultValue: 0.5, minValue: 0, maxValue: 1.6, automationRate: 'k-rate' },
      { name: 'gain', defaultValue: 0.0, minValue: 0, maxValue: 2.0, automationRate: 'a-rate' },
      // decorrelation between L and R: 0 = mono, 1 = fully independent
      { name: 'width', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor(options) {
    super();
    const seed = (options && options.processorOptions && options.processorOptions.seed) || 777;
    this.rngL = new Rng(seed);
    this.rngR = new Rng(seed ^ 0x5bf03635);
    // Paul Kellet 3-pole pink filter state, per channel
    this.sL = [0, 0, 0]; this.sR = [0, 0, 0];
    this.brL = 0; this.brR = 0;
    this.alive = true;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }
  shape(white, s, tilt, brownRef, ch) {
    // Blend three spectra continuously instead of switching buffers. A tilt
    // *parameter* means the Director can slide the ambient bed from airy to
    // subterranean over 30 seconds and the player never hears a crossfade seam.
    s[0] = 0.99765 * s[0] + white * 0.0990460;
    s[1] = 0.96300 * s[1] + white * 0.2965164;
    s[2] = 0.57000 * s[2] + white * 1.0526913;
    const pink = (s[0] + s[1] + s[2] + white * 0.1848) * 0.22;
    let brown = ch === 0 ? this.brL : this.brR;
    brown = (brown + 0.02 * white) / 1.02;
    if (ch === 0) this.brL = brown; else this.brR = brown;
    const brownN = brown * 3.2;
    if (tilt <= 0.5) {
      const t = tilt * 2;
      return white * (1 - t) + pink * t;
    }
    const t = Math.min(1, (tilt - 0.5) * 2);
    const base = pink * (1 - t) + brownN * t;
    // above tilt 1.0, keep integrating for the sub-audible "pressure" bed
    return tilt > 1 ? base * (1 + (tilt - 1) * 1.6) : base;
  }
  process(_inputs, outputs, params) {
    const out = outputs[0];
    const L = out[0], R = out.length > 1 ? out[1] : out[0];
    const n = L.length;
    const tilt = params.tilt[0];
    const width = params.width[0];
    const gainArr = params.gain;
    const gc = gainArr.length === 1;
    for (let i = 0; i < n; i++) {
      const g = gc ? gainArr[0] : gainArr[i];
      const wl = this.rngL.bi();
      const l = this.shape(wl, this.sL, tilt, 0, 0);
      L[i] = l * g;
      if (R !== L) {
        const wr = this.rngR.bi();
        const r = this.shape(wr, this.sR, tilt, 0, 1);
        R[i] = (r * width + l * (1 - width)) * g;
      }
    }
    return this.alive;
  }
}
registerProcessor('shaped-noise', ShapedNoise);

// ---- 3. safety-capped sub-bass dread oscillator ----------------------------
// HARD_CEIL is the last line of defence for §11. The ~20-45Hz band is the one
// documented in horror-cinema practice as capable of causing real physical
// discomfort at high SPL; the cap is enforced in the DSP so that no automation
// path, settings migration, or debug hook can exceed it.
const HARD_CEIL = 0.20;

class DcSafeSub extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq',   defaultValue: 30,  minValue: 16, maxValue: 60, automationRate: 'k-rate' },
      // second oscillator offset in Hz — small offsets produce slow beating,
      // which is what makes the drone read as "alive and wrong" rather than
      // "a test tone".
      { name: 'beat',   defaultValue: 0.7, minValue: 0,  maxValue: 6,  automationRate: 'k-rate' },
      { name: 'gain',   defaultValue: 0,   minValue: 0,  maxValue: 1,  automationRate: 'a-rate' },
      // slow amplitude breathing, Hz
      { name: 'swell',  defaultValue: 0.07, minValue: 0, maxValue: 1.5, automationRate: 'k-rate' },
      { name: 'swellDepth', defaultValue: 0.45, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor() {
    super();
    this.p1 = 0; this.p2 = 0; this.ps = Math.random();
    this.alive = true;
    // measured post-cap peak, polled by the debug overlay / tests
    this.peak = 0;
    this.reportAccum = 0;
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false; };
  }
  process(_inputs, outputs, params) {
    const out = outputs[0];
    const L = out[0], R = out.length > 1 ? out[1] : out[0];
    const n = L.length;
    const f = params.freq[0];
    const beat = params.beat[0];
    const swell = params.swell[0];
    const depth = params.swellDepth[0];
    const gArr = params.gain; const gc = gArr.length === 1;
    const inc1 = f / sampleRate;
    const inc2 = (f + beat) / sampleRate;
    const incS = swell / sampleRate;
    let peak = this.peak;
    for (let i = 0; i < n; i++) {
      this.p1 += inc1; if (this.p1 >= 1) this.p1 -= 1;
      this.p2 += inc2; if (this.p2 >= 1) this.p2 -= 1;
      this.ps += incS; if (this.ps >= 1) this.ps -= 1;
      const env = 1 - depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * this.ps));
      // two sines beating against each other, not one — see 'beat' above
      const s = (Math.sin(2 * Math.PI * this.p1) * 0.62 + Math.sin(2 * Math.PI * this.p2) * 0.38);
      let v = s * env * (gc ? gArr[0] : gArr[i]);
      if (v > HARD_CEIL) v = HARD_CEIL; else if (v < -HARD_CEIL) v = -HARD_CEIL;
      L[i] = v; if (R !== L) R[i] = v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    // report peak ~10x/sec for the debug overlay and the safety-cap test
    this.reportAccum += n;
    if (this.reportAccum >= sampleRate * 0.1) {
      this.reportAccum = 0;
      this.port.postMessage(peak);
      peak = 0;
    }
    this.peak = peak;
    return this.alive;
  }
}
registerProcessor('dc-safe-sub', DcSafeSub);
`;

/** Mirror of the worklet's internal hard ceiling, for tests and the debug HUD. */
export const SUB_HARD_CEIL = 0.20;
