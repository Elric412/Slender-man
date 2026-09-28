import * as THREE from 'three';

/**
 * ============================================================================
 * NIGHT LIGHTING — key / fill / bounce as one budget
 * ============================================================================
 *
 * Previous revision's structural fix is kept intact: all environmental
 * attenuation collapses into one `budget` before being split, with fixed
 * ratios and a readability floor on the fill. Everything below is layered on
 * top of that without reintroducing compounding darkening.
 *
 * Additions:
 *  - Hue-only colour shifts. Every tint (cloud desaturation, low-moon warmth,
 *    scotopic shift, campfire warmth) is luminance-normalised, so colour can
 *    never secretly change brightness — the budget remains the only dial.
 *  - Moon altitude. Low moons pass through more atmosphere: dimmer, warmer
 *    key. A setting moon hands a little of its job to the sky fill instead of
 *    lighting the forest from below the horizon.
 *  - Purkinje / scotopic shift. As the budget drops, the fill leans blue-cyan
 *    (rod vision peaks ~507 nm) — the tell of real night photography. Warm
 *    practical light suppresses it, as cone vision would. Reported as
 *    `levels.scotopic` so a grade pass can also desaturate if it wants to.
 *  - Asymmetric, frame-rate-independent adaptation. Brightening resolves
 *    faster than darkening (stepping into a clearing is an event; walking into
 *    the canopy is a slow closing-in). Large dt (tab switch, load) snaps.
 *  - Shadow window: basis degeneracy bug fixed (the old check ran after
 *    normalize, so it could never fire), texel size taken from the real
 *    shadow camera when available, and an optional quantised look-ahead that
 *    spends shadow resolution where the player is looking.
 */

const KEY_BASE = 1.35;
const FILL_RATIO = 0.52;
const BOUNCE_RATIO = 0.10;
/** minimum surviving sky fill — the readability floor */
const AMBIENT_FLOOR = 0.35;

/** adaptation rates (1/s) — brightening resolves faster than darkening */
const RATE_BRIGHTEN = 3.0;
const RATE_DARKEN = 1.5;
const RATE_WARMTH = 4.0;
/** dt above this is a hitch/teleport/tab-switch: snap, don't fade */
const SNAP_DT = 0.5;
const MAX_STEP = 0.25;

// Three's hex constructor converts sRGB -> linear working space.
const KEY_COLOR = new THREE.Color(0x9fb4dc);
const KEY_OVERCAST = new THREE.Color(0xa9afba);   // cloud-diffused: desaturated
const KEY_LOW = new THREE.Color(0xc6b8a2);        // long atmospheric path: warmer
const SKY_COLOR = new THREE.Color(0xb9c8df);
const SKY_SCOTOPIC = new THREE.Color(0xa2c2e8);   // rod-vision blue-cyan lean
const GROUND_COLOR = new THREE.Color(0x706557);
const WARM_FILL = new THREE.Color(0xddbf97);
const WARM_BOUNCE = new THREE.Color(0x80705c);

const LUM_KEY = luminance(KEY_COLOR);
const LUM_SKY = luminance(SKY_COLOR);
const LUM_GROUND = luminance(GROUND_COLOR);

export interface NightEnvironment {
  /** 0..1 moon disc visibility (cloud crossing) */
  moonDim: number;
  /** 0..1 canopy/zone transmission */
  transmission: number;
  /** 0..1 zone openness */
  openness: number;
  /** 0..1 accumulated surface wetness */
  wetness: number;
  /** 0..1 warm practical spill */
  warmth: number;
}

export interface NightLevels {
  /** moon key intensity */
  key: number;
  /** scene.environmentIntensity */
  fill: number;
  /** hemisphere light intensity */
  bounce: number;
  /** 0..1 surviving fraction of the nominal budget — drives the exposure goal */
  budget: number;
  /** 0..1 scotopic (rod-vision) weight — optional grade hint for desaturation */
  scotopic?: number;
  /** 0..1 moon above-horizon × atmospheric extinction */
  moonVisibility?: number;
}

export class NightLighting {
  readonly moon: THREE.DirectionalLight;
  readonly moonTarget = new THREE.Object3D();
  readonly hemi: THREE.HemisphereLight;

  private levels: NightLevels = { key: 0, fill: 0, bounce: 0, budget: 1, scotopic: 0, moonVisibility: 1 };
  private budgetSmooth = 1;
  private warmSmooth = 0;
  private primed = false;
  private shadowCentre = { sx: 0, sz: 0 };
  private fillNominal = 0.62;
  private hemiShare = 0.22;

  private readonly dir = new THREE.Vector3(0.35, 0.62, -0.55).normalize();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly shadowRight = new THREE.Vector3();
  private readonly shadowUp = new THREE.Vector3();
  private readonly shadowPoint = new THREE.Vector3();
  private leadX = 0;
  private leadZ = 0;

  constructor() {
    this.moon = new THREE.DirectionalLight(KEY_COLOR.getHex(), KEY_BASE);
    this.moon.color.copy(KEY_COLOR);
    this.moon.castShadow = true;
    this.moon.target = this.moonTarget;

    this.hemi = new THREE.HemisphereLight(SKY_COLOR.getHex(), GROUND_COLOR.getHex(), 0);
    this.hemi.color.copy(SKY_COLOR);
    this.hemi.groundColor.copy(GROUND_COLOR);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.moon, this.moonTarget, this.hemi);
  }

  /** With an IBL probe the hemi is a minor term; without one it carries all fill. */
  setProbeActive(active: boolean): void {
    this.fillNominal = active ? 0.62 : 0.0;
    this.hemiShare = active ? 0.22 : 1.0;
  }

  /** Re-prime adaptation (respawn, teleport, cutscene cut) so the next update snaps. */
  reset(): void {
    this.primed = false;
  }

  update(dt: number, env: NightEnvironment): NightLevels {
    const step = Math.min(MAX_STEP, Math.max(0, dt));

    // ---- one attenuation budget ------------------------------------------
    const cloudVis = clamp01(env.moonDim);
    const cloud = 0.55 + 0.45 * cloudVis;
    const canopy = 0.38 + 0.62 * clamp01(env.transmission);
    const rain = 1 - clamp01(env.wetness) * 0.22;
    const raw = cloud * canopy * rain;
    const warmRaw = Math.min(0.5, clamp01(env.warmth) * 0.62);

    if (!this.primed || dt > SNAP_DT) {
      this.budgetSmooth = raw;
      this.warmSmooth = warmRaw;
      this.primed = true;
    } else {
      const rate = raw > this.budgetSmooth ? RATE_BRIGHTEN : RATE_DARKEN;
      this.budgetSmooth += (raw - this.budgetSmooth) * (1 - Math.exp(-step * rate));
      this.warmSmooth += (warmRaw - this.warmSmooth) * (1 - Math.exp(-step * RATE_WARMTH));
    }
    const budget = this.budgetSmooth;
    const w = this.warmSmooth;

    // ---- moon altitude ----------------------------------------------------
    const elev = this.dir.y;
    const horizon = smooth01((elev - 0.02) / 0.16);
    const airmass = 1 / Math.max(0.06, elev + 0.12);
    const extinction = Math.min(1, Math.exp(-0.11 * (airmass - 1.2)));
    const lowMoon = 1 - smooth01((elev - 0.08) / 0.30);
    const moonVis = horizon * extinction;

    // ---- KEY: silhouette ----------------------------------------------------
    this.levels.key = KEY_BASE * Math.max(0.14, budget) * moonVis;

    // ---- FILL: shadow-side information (floored) ---------------------------
    const fillAtten = Math.max(AMBIENT_FLOOR, 0.30 + 0.70 * budget);
    const openBoost = 0.88 + 0.24 * clamp01(env.openness);
    const setBoost = 1 + (1 - horizon) * 0.12;
    const fillShape = Math.min(1.05, fillAtten * openBoost * setBoost);
    this.levels.fill = this.fillNominal * fillShape;

    // ---- BOUNCE: contact ----------------------------------------------------
    const groundBounce = KEY_BASE * BOUNCE_RATIO * (0.80 + 0.20 * budget) * (0.85 + 0.15 * moonVis);
    const missingSkyFill = this.hemiShare === 1 ? KEY_BASE * FILL_RATIO * fillShape : 0;
    this.levels.bounce = groundBounce + missingSkyFill;

    // ---- colour: hue only, luminance-locked --------------------------------
    const scot = clamp01((1 - smooth01((budget - 0.22) / 0.5)) * (1 - w * 1.6));

    this.moon.color.copy(KEY_COLOR)
      .lerp(KEY_OVERCAST, (1 - cloudVis) * 0.55)
      .lerp(KEY_LOW, lowMoon * 0.6);
    matchLuminance(this.moon.color, LUM_KEY);

    this.hemi.color.copy(SKY_COLOR)
      .lerp(SKY_SCOTOPIC, scot * 0.55)
      .lerp(WARM_FILL, w);
    matchLuminance(this.hemi.color, LUM_SKY);

    this.hemi.groundColor.copy(GROUND_COLOR).lerp(WARM_BOUNCE, w * 0.8);
    matchLuminance(this.hemi.groundColor, LUM_GROUND);

    this.moon.intensity = this.levels.key;
    this.hemi.intensity = this.levels.bounce;
    this.levels.budget = budget;
    this.levels.scotopic = scot;
    this.levels.moonVisibility = moonVis;
    return this.levels;
  }

  /**
   * Park the key and its shadow window on the player, texel-snapped in the
   * light's image plane so edges don't crawl.
   *
   * Optional `viewX/viewZ` (camera forward, any length) shifts the window up
   * to 30% of `extent` toward where the player is looking. The lead is
   * quantised to 10% steps so small head turns don't trigger shadow refreshes.
   * Omit them for the previous centred behaviour.
   */
  followPlayer(
    px: number, py: number, pz: number, extent: number,
    viewX = 0, viewZ = 0,
  ): { sx: number; sz: number } {
    const cam = this.moon.shadow.camera as THREE.OrthographicCamera;
    const camW = cam && (cam as THREE.OrthographicCamera).isOrthographicCamera ? cam.right - cam.left : 0;
    const width = camW > 0 && Number.isFinite(camW) ? camW : extent * 2;
    const texel = width / Math.max(1, this.moon.shadow.mapSize.x);

    const vl = Math.hypot(viewX, viewZ);
    if (vl > 1e-4) {
      const lead = extent * 0.3, q = extent * 0.1;
      this.leadX = Math.round(((viewX / vl) * lead) / q) * q;
      this.leadZ = Math.round(((viewZ / vl) * lead) / q) * q;
    } else {
      this.leadX = 0; this.leadZ = 0;
    }

    this.shadowRight.crossVectors(this.up, this.dir);
    if (this.shadowRight.lengthSq() < 1e-6) this.shadowRight.set(1, 0, 0);
    else this.shadowRight.normalize();
    this.shadowUp.crossVectors(this.dir, this.shadowRight).normalize();

    this.shadowPoint.set(px + this.leadX, py, pz + this.leadZ);
    const u = this.shadowPoint.dot(this.shadowRight);
    const v = this.shadowPoint.dot(this.shadowUp);
    this.shadowPoint.addScaledVector(this.shadowRight, Math.round(u / texel) * texel - u);
    this.shadowPoint.addScaledVector(this.shadowUp, Math.round(v / texel) * texel - v);

    const { x: sx, y: sy, z: sz } = this.shadowPoint;
    this.moonTarget.position.copy(this.shadowPoint);
    this.moon.position.set(sx + this.dir.x * 150, sy + this.dir.y * 150, sz + this.dir.z * 150);
    this.moonTarget.updateMatrixWorld();
    this.moon.updateMatrixWorld();

    this.shadowCentre.sx = sx;
    this.shadowCentre.sz = sz;
    return this.shadowCentre;
  }

  /** Keep the key aligned with the sky shader's moon disc. */
  setMoonDirection(v: THREE.Vector3): void {
    if (v.lengthSq() < 1e-8) return;
    this.dir.copy(v).normalize();
  }

  get current(): NightLevels {
    return this.levels;
  }
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function smooth01(t: number): number {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
function luminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}
/** rescale a linear colour to a target luminance — tints change hue, never energy */
function matchLuminance(c: THREE.Color, target: number): void {
  const l = luminance(c);
  if (l > 1e-6) c.multiplyScalar(target / l);
}