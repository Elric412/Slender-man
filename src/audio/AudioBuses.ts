import { AudioSettings } from '../core/Config';
import { DREAD_WORKLET_SOURCE } from './worklets/DreadWorklet';

export type BusId = 'ambience' | 'entity' | 'foley' | 'ui' | 'reverb';

export interface BusMeter {
  /** linear peak since last read */
  peak: number;
  /** linear RMS over the analyser window */
  rms: number;
  /** short-term loudness estimate, dBFS (K-weighted approximation) */
  lufs: number;
}

/**
 * Bus graph, master chain and AudioContext lifecycle.
 *
 * ┌ ambience ┐
 * ├ entity   ┤→ (pre) → master trim → safety limiter → destination
 * ├ foley    ┤          ↑
 * ├ ui       ┘          │
 * └ reverb send → convolver → reverb return ┘
 *
 * Design notes that matter:
 *
 * • The limiter is a *safety* limiter, not a leveller. threshold -1.5dBFS,
 *   ratio 20:1, 3ms attack. It exists to stop layered peaks from clipping the
 *   DAC. It is deliberately NOT set up to squash the mix into a uniform
 *   loudness: STATIC's horror depends on a genuinely quiet ambient floor
 *   sitting far below a confrontation peak (§10 of the audio brief). A
 *   conventional -14 LUFS "streaming loudness" master would delete exactly the
 *   contrast the design is built on.
 *
 * • The entity bus ducks the ambience bus. Entity audio must always *read*
 *   clearly, and the cheap way to achieve that is to make it louder — which
 *   raises the whole mix's floor and burns headroom. Ducking instead means the
 *   entity can stay at a moderate level and still cut through, and the ducking
 *   itself is a tension cue (the world going quiet around the thing).
 *
 * • Every bus has a 2-band trim EQ. This is what lets the "phone speaker"
 *   profile keep tension readable: it tilts energy out of the inaudible sub and
 *   into the 700Hz-4kHz band that a phone driver can actually reproduce.
 */
export class AudioBuses {
  ctx: AudioContext | null = null;

  private masterTrim!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private meterTap!: AnalyserNode;
  private meterBuf = new Float32Array(2048);

  private busGain = new Map<BusId, GainNode>();
  private busUser = new Map<BusId, GainNode>();
  private busEq = new Map<BusId, { low: BiquadFilterNode; high: BiquadFilterNode }>();
  private busMeterNode = new Map<BusId, AnalyserNode>();
  private busMeterBuf = new Map<BusId, Float32Array<ArrayBuffer>>();

  /** entity→ambience ducking */
  private duckGain!: GainNode;
  private duckAmount = 0;

  /** shared convolver for the environmental reverb send */
  private convolver!: ConvolverNode;
  private reverbSend!: GainNode;
  private reverbReturn!: GainNode;

  /** low-frequency-intensity trim — §11 safety, independent of entity volume */
  private lowFreqGain!: GainNode;

  private settings: AudioSettings;
  private workletReady = false;
  private workletFailed = false;
  private unlockPromise: Promise<void> | null = null;
  private nightMode = false;

  /** true once the graph exists (may still be `suspended`) */
  get ready(): boolean { return this.ctx !== null; }
  /** AudioWorklet processors available — callers fall back if false */
  get hasWorklet(): boolean { return this.workletReady; }

  constructor(settings: AudioSettings) {
    this.settings = settings;
  }

  /**
   * Build the graph. Safe to call from a non-gesture context — the context may
   * come up `suspended`, and `unlock()` promotes it later. Never awaits
   * anything on the caller's critical path.
   */
  init(): boolean {
    if (this.ctx) return true;
    const AC: typeof AudioContext | undefined = window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    let c: AudioContext;
    /* Headless/CI escape hatch --------------------------------------------
     * On a machine with no sound card, Chromium opens a real output stream
     * anyway, and its audio render thread then either starves (competing with
     * a software rasteriser for 2 cores) or spins against a null ALSA sink
     * that consumes samples instantly. Either way it logs
     * `SyncReader::Read timed out` until the stream wedges, which takes
     * browser teardown down with it — after the tests have already passed.
     *
     * Chromium's silent sink (`sinkId: { type: 'none' }`) is the supported
     * answer: the graph is still rendered on the real audio clock, so
     * AudioWorklets run and AnalyserNode meters read true values, but no
     * device is ever opened. Opt-in via ?silentaudio=1 so it can only ever
     * affect a deliberate test run, never a player. */
    const silentSink = typeof location !== 'undefined' &&
      /[?&]silentaudio=1\b/.test(location.search);
    try {
      // 'interactive' latencyHint: footsteps and stings must land tight against
      // the visual event. 'playback' would buy CPU headroom at the cost of a
      // perceptible lag on the flashlight click.
      const opts: AudioContextOptions = { latencyHint: 'interactive' };
      if (silentSink) {
        (opts as { sinkId?: unknown }).sinkId = { type: 'none' };
      }
      c = new AC(opts);
    } catch {
      // sinkId is Chromium-only; fall back to a normal context if rejected.
      try { c = new AC({ latencyHint: 'interactive' }); } catch { return false; }
    }
    this.ctx = c;

    // ---- master chain ----
    this.masterTrim = c.createGain();
    this.masterTrim.gain.value = this.settings.master;

    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    this.meterTap = c.createAnalyser();
    this.meterTap.fftSize = 2048;
    this.meterTap.smoothingTimeConstant = 0.1;

    this.masterTrim.connect(this.limiter);
    this.limiter.connect(this.meterTap);
    this.limiter.connect(c.destination);

    // ---- ambience duck node (entity sidechain target) ----
    this.duckGain = c.createGain();
    this.duckGain.gain.value = 1;
    this.duckGain.connect(this.masterTrim);

    // ---- reverb send/return ----
    this.convolver = c.createConvolver();
    this.convolver.normalize = false;   // we control IR energy ourselves
    this.reverbSend = c.createGain();
    this.reverbSend.gain.value = 1;
    this.reverbReturn = c.createGain();
    this.reverbReturn.gain.value = 0.9;
    this.reverbSend.connect(this.convolver);
    this.convolver.connect(this.reverbReturn);
    this.reverbReturn.connect(this.masterTrim);

    // ---- per-bus chains ----
    const defs: { id: BusId; dest: AudioNode; trim: number }[] = [
      // ambience routes through the duck node so entity activity can pull it back
      { id: 'ambience', dest: this.duckGain, trim: 1.0 },
      { id: 'entity', dest: this.masterTrim, trim: 0.95 },
      { id: 'foley', dest: this.masterTrim, trim: 0.9 },
      { id: 'ui', dest: this.masterTrim, trim: 0.85 },
      { id: 'reverb', dest: this.reverbSend, trim: 1.0 },
    ];
    for (const d of defs) {
      const user = c.createGain();          // player-facing volume slider
      const low = c.createBiquadFilter();   // profile/EQ trim, low shelf
      low.type = 'lowshelf'; low.frequency.value = 180; low.gain.value = 0;
      const high = c.createBiquadFilter();
      high.type = 'highshelf'; high.frequency.value = 3200; high.gain.value = 0;
      const stage = c.createGain();         // fixed design trim
      stage.gain.value = d.trim;
      const meter = c.createAnalyser();
      meter.fftSize = 1024;
      meter.smoothingTimeConstant = 0.2;

      user.connect(low).connect(high).connect(stage).connect(d.dest);
      stage.connect(meter);

      this.busUser.set(d.id, user);
      this.busGain.set(d.id, user);   // input node for the bus
      this.busEq.set(d.id, { low, high });
      this.busMeterNode.set(d.id, meter);
      this.busMeterBuf.set(d.id, new Float32Array(1024));
    }

    // ---- low-frequency-intensity trim (feeds entity bus) ----
    this.lowFreqGain = c.createGain();
    this.lowFreqGain.gain.value = this.settings.lowFreq;
    this.lowFreqGain.connect(this.busGain.get('entity')!);

    this.applySettings(this.settings);
    // fire-and-forget: never block the caller on module compilation
    void this.loadWorklet();
    return true;
  }

  /**
   * Compile the DSP module from an inline Blob. Failure is non-fatal — callers
   * check `hasWorklet` and use native-node fallbacks, so an old browser loses
   * the granular texture but keeps the rest of the mix.
   */
  private async loadWorklet(): Promise<void> {
    const c = this.ctx;
    if (!c || this.workletReady || this.workletFailed) return;
    if (!c.audioWorklet) { this.workletFailed = true; return; }
    try {
      const blob = new Blob([DREAD_WORKLET_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      await c.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      this.workletReady = true;
    } catch (err) {
      this.workletFailed = true;
      if (import.meta.env.DEV) console.warn('[audio] AudioWorklet unavailable, using native fallback', err);
    }
  }

  /** Await worklet readiness (tests / boot warmup). Resolves even on failure. */
  async workletSettled(): Promise<boolean> {
    for (let i = 0; i < 60 && !this.workletReady && !this.workletFailed; i++) {
      await new Promise(r => setTimeout(r, 25));
    }
    return this.workletReady;
  }

  /**
   * Promote the context to `running`. Must be called from a user gesture on
   * iOS Safari and on desktop Chrome's autoplay policy.
   *
   * The `resume()` is deliberately not awaited by callers: an iOS resume can
   * take ~100ms and blocking the first click on it makes the whole UI feel
   * broken. Sounds triggered before the resume completes are scheduled against
   * `currentTime` and simply start when the clock starts.
   */
  unlock(): Promise<void> {
    const c = this.ctx;
    if (!c) { this.init(); }
    const cc = this.ctx;
    if (!cc) return Promise.resolve();
    if (cc.state === 'running') return Promise.resolve();
    if (this.unlockPromise) return this.unlockPromise;
    this.unlockPromise = cc.resume()
      .then(() => {
        // iOS quirk: a resumed context can still be silent until *something*
        // has been scheduled on it. A single zero-length silent buffer costs
        // nothing and reliably kicks the render quantum loop awake.
        try {
          const b = cc.createBuffer(1, 1, cc.sampleRate);
          const s = cc.createBufferSource();
          s.buffer = b;
          s.connect(cc.destination);
          s.start(0);
        } catch { /* ignore */ }
      })
      .catch(() => undefined)
      .finally(() => { this.unlockPromise = null; });
    return this.unlockPromise;
  }

  suspend(): void {
    // Only suspend if actually running — calling suspend() on a 'closed' or
    // already-suspended context throws on some Safari builds.
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
  }

  resume(): void {
    if (this.ctx && this.ctx.state !== 'running') void this.unlock();
  }

  get state(): AudioContextState | 'none' { return this.ctx?.state ?? 'none'; }
  get now(): number { return this.ctx?.currentTime ?? 0; }

  bus(id: BusId): GainNode { return this.busGain.get(id)!; }
  /** entity-bus input that is additionally scaled by the low-frequency safety trim */
  get lowFreqInput(): GainNode { return this.lowFreqGain; }
  get reverbInput(): GainNode { return this.reverbSend; }

  /** install a runtime-generated impulse response on the shared convolver */
  setImpulseResponse(ir: AudioBuffer): void {
    if (!this.ctx) return;
    try { this.convolver.buffer = ir; } catch { /* ignore */ }
  }

  setReverbMix(v: number): void {
    if (!this.ctx) return;
    this.reverbReturn.gain.setTargetAtTime(Math.max(0, Math.min(1.6, v)), this.ctx.currentTime, 0.35);
  }

  // ------------------------------------------------------------ settings

  applySettings(s: AudioSettings): void {
    this.settings = s;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    // Perceptual taper: sliders are linear in the UI but a linear gain slider
    // feels wrong (most of the useful range crams into the top quarter).
    // Squaring maps slider travel roughly onto perceived loudness.
    const tap = (v: number) => Math.max(0, Math.min(1, v)) ** 2;
    this.masterTrim.gain.setTargetAtTime(tap(s.master), t, 0.05);
    this.busUser.get('ambience')!.gain.setTargetAtTime(tap(s.ambience), t, 0.05);
    this.busUser.get('entity')!.gain.setTargetAtTime(tap(s.entity), t, 0.05);
    this.busUser.get('foley')!.gain.setTargetAtTime(tap(s.foley), t, 0.05);
    this.busUser.get('ui')!.gain.setTargetAtTime(tap(s.ui), t, 0.05);
    // reverb send follows ambience so a muted ambience bus doesn't leave a
    // disembodied reverb tail behind
    this.busUser.get('reverb')!.gain.setTargetAtTime(tap(Math.max(s.ambience, s.entity)), t, 0.05);
    this.lowFreqGain.gain.setTargetAtTime(Math.max(0, Math.min(1, s.lowFreq)), t, 0.2);
    this.setNightMode(s.nightMode);
  }

  /** true when the player has fully disabled low-frequency-intensity content */
  get lowFreqDisabled(): boolean { return this.settings.lowFreq <= 0.001; }
  get lowFreqScale(): number { return Math.max(0, Math.min(1, this.settings.lowFreq)); }

  /**
   * Comfort profile. Raises the limiter's working point and applies a spectral
   * tilt so the mix survives phone speakers and late-night listening.
   *
   * Crucially this is opt-in. Making it default would flatten the run's
   * dynamic arc for everyone, which quality gate 6 explicitly forbids.
   */
  setNightMode(on: boolean): void {
    if (!this.ctx || this.nightMode === on) { this.nightMode = on; if (!this.ctx) return; }
    this.nightMode = on;
    const t = this.ctx.currentTime;
    if (on) {
      // gentle levelling: earlier threshold, lower ratio, slower release
      this.limiter.threshold.setValueAtTime(-14, t);
      this.limiter.ratio.setValueAtTime(5, t);
      this.limiter.release.setValueAtTime(0.4, t);
      this.limiter.knee.setValueAtTime(12, t);
      // pull the inaudible sub out and lift presence so tension still reads
      for (const id of ['ambience', 'entity', 'foley'] as BusId[]) {
        const eq = this.busEq.get(id)!;
        eq.low.gain.setTargetAtTime(-7, t, 0.3);
        eq.high.gain.setTargetAtTime(3.5, t, 0.3);
      }
    } else {
      this.limiter.threshold.setValueAtTime(-1.5, t);
      this.limiter.ratio.setValueAtTime(20, t);
      this.limiter.release.setValueAtTime(0.18, t);
      this.limiter.knee.setValueAtTime(2, t);
      for (const id of ['ambience', 'entity', 'foley'] as BusId[]) {
        const eq = this.busEq.get(id)!;
        eq.low.gain.setTargetAtTime(0, t, 0.3);
        eq.high.gain.setTargetAtTime(0, t, 0.3);
      }
    }
  }

  // ------------------------------------------------------------ ducking

  /**
   * Duck the ambience bus by `amount` (0..1). Called once per frame with the
   * entity's current activity level; the setTargetAtTime time-constants are
   * asymmetric (fast in, slow out) so the world seems to hold its breath and
   * then only reluctantly come back.
   */
  setDuck(amount: number): void {
    if (!this.ctx) return;
    const a = Math.max(0, Math.min(1, amount));
    if (Math.abs(a - this.duckAmount) < 0.004) return;
    const rising = a > this.duckAmount;
    this.duckAmount = a;
    // up to -9dB of ambience attenuation at full entity presence
    const g = 1 - a * 0.65;
    this.duckGain.gain.setTargetAtTime(g, this.ctx.currentTime, rising ? 0.12 : 0.9);
  }

  get duck(): number { return this.duckAmount; }

  // ------------------------------------------------------------ metering

  /**
   * Master metering. `lufs` is an approximation, not a compliant BS.1770
   * measurement: it's a K-weighting-shaped RMS in dBFS, adequate for asserting
   * that the run's quiet passages and its peaks are genuinely far apart, which
   * is what quality gate 6 actually needs.
   */
  meterMaster(): BusMeter {
    if (!this.ctx) return { peak: 0, rms: 0, lufs: -120 };
    this.meterTap.getFloatTimeDomainData(this.meterBuf);
    return measure(this.meterBuf);
  }

  meterBus(id: BusId): BusMeter {
    const an = this.busMeterNode.get(id);
    const buf = this.busMeterBuf.get(id);
    if (!an || !buf) return { peak: 0, rms: 0, lufs: -120 };
    an.getFloatTimeDomainData(buf);
    return measure(buf);
  }

  /** Tear the whole graph down (run restart / dispose). */
  dispose(): void {
    const c = this.ctx;
    if (!c) return;
    try { this.masterTrim.disconnect(); this.limiter.disconnect(); } catch { /* ignore */ }
    void c.close().catch(() => undefined);
    this.ctx = null;
    this.workletReady = false;
    this.busGain.clear(); this.busUser.clear(); this.busEq.clear();
    this.busMeterNode.clear(); this.busMeterBuf.clear();
  }
}

function measure(buf: Float32Array): BusMeter {
  let peak = 0, sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / buf.length);
  return {
    peak,
    rms,
    // +2.4dB nominal K-weighting offset; floored so silence reports a finite value
    lufs: rms > 1e-7 ? 20 * Math.log10(rms) + 2.4 : -120,
  };
}
