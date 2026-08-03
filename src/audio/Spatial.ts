import { AudioBuses, BusId } from './AudioBuses';

/** Anything that can answer "is the straight line between these two points clear?" */
export interface OcclusionProbe {
  losClear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean;
}

export interface SpatialVoiceOpts {
  bus: BusId;
  /** world position */
  x: number; y: number; z: number;
  /** max audible distance, metres */
  maxDistance?: number;
  /** distance at which attenuation starts */
  refDistance?: number;
  /** 0..1 wet contribution to the environment reverb send */
  reverbSend?: number;
  /** skip the propagation-delay model (for player-attached foley) */
  noDelay?: boolean;
  /** skip occlusion raycasts (already-diffuse ambience layers) */
  noOcclusion?: boolean;
}

/**
 * A pooled positional voice. Callers connect their source into `input` and
 * schedule it; the voice handles HRTF panning, distance filtering, occlusion
 * filtering, propagation delay and the reverb send.
 */
export class SpatialVoice {
  input!: GainNode;
  private panner!: PannerNode;
  private distLP!: BiquadFilterNode;   // distance-dependent air absorption
  private occLP!: BiquadFilterNode;    // occlusion low-pass
  private occGain!: GainNode;          // occlusion attenuation
  private delay!: DelayNode;           // propagation delay
  private send!: GainNode;             // reverb send
  private busOut!: GainNode;

  private ctx: AudioContext;
  private buses: AudioBuses;

  /** pool bookkeeping */
  inUse = false;
  priority = 0;
  startedAt = 0;
  loudness = 0;
  private currentBus: BusId = 'ambience';

  constructor(ctx: AudioContext, buses: AudioBuses) {
    this.ctx = ctx;
    this.buses = buses;
    this.build();
  }

  private build(): void {
    const c = this.ctx;
    this.input = c.createGain();
    this.delay = c.createDelay(1.2);
    this.delay.delayTime.value = 0;

    this.distLP = c.createBiquadFilter();
    this.distLP.type = 'lowpass';
    this.distLP.frequency.value = 20000;
    this.distLP.Q.value = 0.4;

    this.occLP = c.createBiquadFilter();
    this.occLP.type = 'lowpass';
    this.occLP.frequency.value = 20000;
    this.occLP.Q.value = 0.5;

    this.occGain = c.createGain();
    this.occGain.gain.value = 1;

    this.panner = c.createPanner();
    // HRTF is the whole point: "where did that come from" is the core tension
    // mechanic of a stalker horror game, and equalpower panning can't localise
    // front/back or elevation at all.
    this.panner.panningModel = 'HRTF';
    // Inverse rolloff is the physically-correct 1/r law. 'linear' is cheaper to
    // reason about but produces a wall of constant loudness then a cliff, which
    // destroys distance judgement.
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 2;
    this.panner.maxDistance = 90;
    this.panner.rolloffFactor = 1.0;
    this.panner.coneInnerAngle = 360;

    this.send = c.createGain();
    this.send.gain.value = 0;
    this.busOut = c.createGain();
    this.busOut.gain.value = 1;

    this.input
      .connect(this.delay)
      .connect(this.distLP)
      .connect(this.occLP)
      .connect(this.occGain)
      .connect(this.panner);
    this.panner.connect(this.busOut);
    this.panner.connect(this.send);
    this.send.connect(this.buses.reverbInput);
  }

  acquire(opts: SpatialVoiceOpts, priority: number): void {
    this.inUse = true;
    this.priority = priority;
    this.startedAt = this.ctx.currentTime;
    this.panner.refDistance = opts.refDistance ?? 2;
    this.panner.maxDistance = opts.maxDistance ?? 90;
    if (this.currentBus !== opts.bus) {
      try { this.busOut.disconnect(); } catch { /* ignore */ }
      this.busOut.connect(this.buses.bus(opts.bus));
      this.currentBus = opts.bus;
    }
    this.send.gain.value = opts.reverbSend ?? 0.18;
    this.setPosition(opts.x, opts.y, opts.z);
  }

  release(): void {
    this.inUse = false;
    this.priority = 0;
    this.input.gain.value = 1;
    this.delay.delayTime.value = 0;
    this.distLP.frequency.value = 20000;
    this.occLP.frequency.value = 20000;
    this.occGain.gain.value = 1;
  }

  setPosition(x: number, y: number, z: number): void {
    const p = this.panner;
    if (p.positionX) {
      const t = this.ctx.currentTime;
      p.positionX.setValueAtTime(x, t);
      p.positionY.setValueAtTime(y, t);
      p.positionZ.setValueAtTime(z, t);
    } else {
      // deprecated setter path for older Safari
      (p as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
    }
  }

  /**
   * Apply the propagation model for a given source→listener geometry.
   *
   * Three things happen here that a plain PannerNode does not do:
   *
   * 1. Air absorption. Distant sound loses high frequencies — this is why
   *    thunder ten kilometres away is a rumble and thunder overhead is a crack.
   *    Without it, a footstep at 60m is just a quiet footstep at 60m, and the
   *    player can't tell distance from volume alone.
   * 2. Occlusion as a continuous quantity. Real obstruction low-passes and
   *    attenuates; a binary blocked/not-blocked flag makes walls sound like
   *    mute buttons. `obstruction` here comes from multiple offset raycasts.
   * 3. Propagation delay. At 343m/s a sound 60m away arrives 175ms after its
   *    visual cue. It's a small thing but it grounds distant events physically.
   */
  applyPropagation(dist: number, obstruction: number, opts: { noDelay?: boolean } = {}): void {
    const t = this.ctx.currentTime;

    // ---- air absorption ----
    // 18kHz at the listener, falling to ~1.1kHz at 90m. Curve is 1/(1+k·d)
    // shaped, which matches the roughly-exponential HF loss of real air plus
    // foliage scattering better than a linear ramp.
    const airHz = 18000 / (1 + dist * 0.19);
    // ---- occlusion ----
    // Fully obstructed → ~380Hz and -13dB. Partially obstructed interpolates,
    // and the interpolation is in log-frequency because that's how hearing works.
    const occ = clamp01(obstruction);
    const occHz = Math.exp(Math.log(20000) * (1 - occ) + Math.log(380) * occ);
    const targetHz = Math.min(airHz, 20000);

    this.distLP.frequency.setTargetAtTime(Math.max(180, targetHz), t, 0.08);
    this.occLP.frequency.setTargetAtTime(Math.max(180, occHz), t, 0.12);
    this.occGain.gain.setTargetAtTime(1 - occ * 0.78, t, 0.12);

    // ---- reverb send rises with both distance and occlusion ----
    // An occluded, distant source is mostly reflected energy — that's the
    // "murkier tail" the brief asks for, and it's what makes a sound behind a
    // wall read as behind a wall rather than merely quiet.
    const wet = clamp01(0.1 + dist / 120 * 0.5 + occ * 0.35);
    this.send.gain.setTargetAtTime(wet, t, 0.2);

    if (!opts.noDelay) {
      // speed of sound at ~10°C night air
      this.delay.delayTime.setTargetAtTime(Math.min(1.1, dist / 338), t, 0.05);
    }
  }
}

const MAX_VOICES_DESKTOP = 28;
const MAX_VOICES_MOBILE = 14;

/**
 * Spatial audio manager: HRTF listener, pooled positional voices with a
 * priority-based cap, occlusion raycasting against the gameplay collision
 * world, and runtime reverb-character probing.
 */
export class SpatialAudio {
  private buses: AudioBuses;
  private probe: OcclusionProbe | null = null;
  private pool: SpatialVoice[] = [];
  private maxVoices: number;

  /** listener state */
  lx = 0; ly = 0; lz = 0;
  private fx = 0; private fy = 0; private fz = -1;

  /** cached occlusion results — raycasts are not free */
  private occCache = new Map<number, { value: number; time: number }>();
  private occCacheTime = 0;

  /** environment probe result, exposed for the debug overlay */
  space = { openness: 0.8, absorption: 0.7, wallProximity: 0, ceiling: 0 };
  private lastIrKey = '';

  /** voices dropped because the pool was exhausted (perf diagnostics) */
  droppedVoices = 0;

  constructor(buses: AudioBuses, isMobile: boolean) {
    this.buses = buses;
    this.maxVoices = isMobile ? MAX_VOICES_MOBILE : MAX_VOICES_DESKTOP;
  }

  setProbe(p: OcclusionProbe): void { this.probe = p; }

  /** Pre-allocate the whole voice pool at boot — never allocate mid-run. */
  warm(): void {
    const c = this.buses.ctx;
    if (!c) return;
    while (this.pool.length < this.maxVoices) {
      this.pool.push(new SpatialVoice(c, this.buses));
    }
  }

  get activeVoices(): number {
    let n = 0;
    for (const v of this.pool) if (v.inUse) n++;
    return n;
  }
  get poolSize(): number { return this.pool.length; }

  /**
   * Update the AudioListener. Web Audio's listener uses a forward + up vector
   * pair; we feed it the camera basis so HRTF localisation matches what the
   * player sees.
   */
  setListener(x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
    const c = this.buses.ctx;
    if (!c) return;
    this.lx = x; this.ly = y; this.lz = z;
    this.fx = fx; this.fy = fy; this.fz = fz;
    const l = c.listener;
    const t = c.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(x, t, 0.02);
      l.positionY.setTargetAtTime(y, t, 0.02);
      l.positionZ.setTargetAtTime(z, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(fy, t, 0.02);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    } else {
      const legacy = l as unknown as {
        setPosition(x: number, y: number, z: number): void;
        setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      legacy.setPosition(x, y, z);
      legacy.setOrientation(fx, fy, fz, 0, 1, 0);
    }
  }

  /**
   * Acquire a voice, or null if the cap is reached and nothing lower-priority
   * can be evicted.
   *
   * Eviction policy is nearest/loudest/most-recent wins: we steal the voice
   * with the lowest (priority, loudness) score, preferring to kill old quiet
   * distant things. Under load on mobile this degrades *gracefully* and
   * audibly-sensibly rather than glitching, which is the §12 requirement.
   */
  acquire(opts: SpatialVoiceOpts, priority = 1): SpatialVoice | null {
    const c = this.buses.ctx;
    if (!c) return null;
    if (this.pool.length === 0) this.warm();
    let free: SpatialVoice | null = null;
    let victim: SpatialVoice | null = null;
    let victimScore = Infinity;
    const now = c.currentTime;
    for (const v of this.pool) {
      if (!v.inUse) { free = v; break; }
      // older + quieter + lower priority = better victim
      const age = now - v.startedAt;
      const score = v.priority * 100 + v.loudness * 40 - Math.min(age, 6) * 3;
      if (score < victimScore) { victimScore = score; victim = v; }
    }
    if (!free) {
      const myScore = priority * 100 + (opts.reverbSend ?? 0.2) * 10;
      if (victim && victimScore < myScore) {
        victim.release();
        free = victim;
      } else {
        this.droppedVoices++;
        return null;
      }
    }
    free.acquire(opts, priority);
    const dist = Math.hypot(opts.x - this.lx, opts.y - this.ly, opts.z - this.lz);
    const occ = opts.noOcclusion ? 0 : this.occlusionAt(opts.x, opts.y, opts.z);
    free.loudness = 1 / (1 + dist * 0.1);
    free.applyPropagation(dist, occ, { noDelay: opts.noDelay });
    return free;
  }

  /** Return a voice to the pool after its source has finished. */
  releaseIn(v: SpatialVoice, seconds: number): void {
    // A timeout is correct here rather than an `onended` handler: many voices
    // are fed by long-lived nodes (drones, worklets) that never "end", and the
    // caller always knows its own tail length.
    setTimeout(() => v.release(), Math.max(30, seconds * 1000 + 120));
  }

  /**
   * Continuous obstruction estimate, 0 = clear, 1 = fully blocked.
   *
   * Casts five rays: centre, ±1.4m horizontally perpendicular to the path, and
   * ±0.9m vertically. A single centre ray produces a binary result that flips
   * on and off as the player walks, which sounds like a broken mute switch;
   * spreading the rays gives a continuous value that behaves like real partial
   * obstruction around a tree trunk or a doorway.
   *
   * Results are cached on a coarse spatial hash and expire after 120ms, so a
   * dense frame of one-shots doesn't fire 200 raycasts.
   */
  occlusionAt(x: number, y: number, z: number): number {
    const probe = this.probe;
    if (!probe) return 0;
    const key = (Math.round(x * 0.4) & 1023) << 20 | (Math.round(y * 0.5) & 63) << 14 |
      (Math.round(z * 0.4) & 1023) << 4;
    const hit = this.occCache.get(key);
    if (hit && this.occCacheTime - hit.time < 0.12) return hit.value;

    const dx = x - this.lx, dz = z - this.lz;
    const len = Math.hypot(dx, dz) || 1;
    // perpendicular in the horizontal plane
    const px = -dz / len, pz = dx / len;
    const SPREAD = 1.4;
    let blocked = 0;
    const rays: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [px * SPREAD, 0, pz * SPREAD, 0],
      [-px * SPREAD, 0, -pz * SPREAD, 0],
      [0, 0.9, 0, 0.9],
      [0, -0.7, 0, -0.7],
    ];
    for (const [ox, oy, oz, ly] of rays) {
      if (!probe.losClear(this.lx + ox, this.ly + ly, this.lz + oz, x + ox, y + oy, z + oz)) blocked++;
    }
    const value = blocked / rays.length;
    if (this.occCache.size > 512) this.occCache.clear();
    this.occCache.set(key, { value, time: this.occCacheTime });
    return value;
  }

  /** advance the occlusion cache clock (call once per frame) */
  tick(dt: number): void { this.occCacheTime += dt; }

  /**
   * Estimate the acoustic character of the space around the listener.
   *
   * We probe eight horizontal directions at 9m plus one upward ray. The counts
   * of blocked horizontal rays and blocked upward rays map to `wallProximity`
   * and `ceiling`, which in turn produce `openness` (small + enclosed → 0) and
   * `absorption` (a forest is soft, a tunnel is hard — proxied by how *close*
   * the blocking surfaces are, since a tight enclosure that blocks at 2m is
   * almost certainly built, while one that blocks at 8m is almost certainly
   * trees).
   *
   * This runs a handful of raycasts a few times a second, not per frame.
   */
  probeSpace(): void {
    const probe = this.probe;
    if (!probe) return;
    const R_FAR = 9, R_NEAR = 2.6;
    let blockedFar = 0, blockedNear = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const sx = Math.sin(a), sz = Math.cos(a);
      if (!probe.losClear(this.lx, this.ly, this.lz, this.lx + sx * R_FAR, this.ly, this.lz + sz * R_FAR)) {
        blockedFar++;
        if (!probe.losClear(this.lx, this.ly, this.lz, this.lx + sx * R_NEAR, this.ly, this.lz + sz * R_NEAR)) {
          blockedNear++;
        }
      }
    }
    const ceiling = probe.losClear(this.lx, this.ly, this.lz, this.lx, this.ly + 5.5, this.lz) ? 0 : 1;
    const wallProximity = blockedFar / 8;
    // enclosure raises with near walls and a ceiling; openness is its inverse
    const enclosure = clamp01(wallProximity * 0.55 + (blockedNear / 8) * 0.25 + ceiling * 0.4);
    const openness = clamp01(1 - enclosure);
    // hard surfaces (built structures) are the ones that block at close range
    const hardness = clamp01((blockedNear / 8) * 1.4 + ceiling * 0.5);
    const absorption = clamp01(0.82 - hardness * 0.65);

    // smooth, so walking through a doorway is a transition not a jump cut
    this.space.wallProximity += (wallProximity - this.space.wallProximity) * 0.35;
    this.space.ceiling += (ceiling - this.space.ceiling) * 0.25;
    this.space.openness += (openness - this.space.openness) * 0.25;
    this.space.absorption += (absorption - this.space.absorption) * 0.25;
  }

  /**
   * Regenerate/reinstall the convolution IR if the probed space has changed
   * enough to matter. Called on a slow cadence by the audio director.
   */
  syncReverb(makeIr: (openness: number, absorption: number) => AudioBuffer | null): void {
    const key = `${Math.round(this.space.openness * 6)}_${Math.round(this.space.absorption * 6)}`;
    if (key === this.lastIrKey) return;
    const ir = makeIr(this.space.openness, this.space.absorption);
    if (!ir) return;
    this.lastIrKey = key;
    this.buses.setImpulseResponse(ir);
    // Open forest is quiet-and-diffuse; a tunnel is loud-and-close. Mix follows.
    this.buses.setReverbMix(0.35 + this.space.openness * 0.35 + (1 - this.space.absorption) * 0.45);
  }

  get irKey(): string { return this.lastIrKey; }

  reset(): void {
    for (const v of this.pool) v.release();
    this.occCache.clear();
    this.droppedVoices = 0;
    this.lastIrKey = '';
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
