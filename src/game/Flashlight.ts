import * as THREE from 'three';
import { Player } from './Player';
import { SeededRandom } from '../core/SeededRandom';
import { SOFT_SPRITE_CHUNKS } from '../render/Particles';

/**
 * STATIC — handheld incandescent flashlight.
 *
 * ### What makes this "advanced"
 *  1. **IES-style photometric cookie.** Real torches don't project a flat cone
 *     with a smooth edge; a parabolic reflector produces a bright *hotspot*, a
 *     dimmer *spill*, faint reflector-facet banding and a slightly ragged rim
 *     where the bulb filament is out of focus. We bake that intensity profile
 *     into a small texture and hand it to `SpotLight.map`, which three projects
 *     through the light frustum. One texture fetch, zero extra draws.
 *  2. **No fake beam mesh.** The old additive `ConeGeometry` is gone — the
 *     render pipeline now ray-marches the light's *actual shadow map*, so shafts
 *     are occluded by trees instead of glowing through them. This class only
 *     publishes `beamStrength` for `RenderPipeline.setBeam()`.
 *  3. **Handheld dynamics.** The beam is not rigidly welded to the camera: the
 *     aim direction is a damped spring that lags fast turns, footstep cadence
 *     adds a sub-degree sway, and the light sits at the player's *hand* —
 *     offset right and below the eye — so shadow parallax reads as "something
 *     is holding this".
 *  4. **Electrical model.** Terminal voltage sag drives three coupled outputs:
 *     luminous intensity (super-linear in filament temperature), colour
 *     temperature (a dying incandescent slides toward a ~1900K ember), and
 *     thermal inertia — flicker can't step instantly, it decays toward its
 *     target so dropouts glow down and back up like a real bulb.
 *  5. **Dust that can't turn into white dice.** Motes live in a persistent
 *     world-space slab around the player and *wrap* toroidally (never respawned
 *     in front of the eye, so nothing streams at your face). They're drawn with
 *     a clamped `gl_PointSize`, a radial falloff and a near fade, and they're
 *     lit in the shader by `cone(angle) · 1/d² · HG(scatter)` so a mote outside
 *     the beam contributes exactly nothing. **This is the fix for the white
 *     square "dots" artefact.**
 */

/** Beam geometry constants, kept in one place so cookie/dust/pipeline agree. */
const OUTER_ANGLE = 0.46;   // radians, half-angle of the spill
const HOTSPOT_FRAC = 0.34;  // hotspot half-angle as a fraction of the outer angle
const RANGE = 62;           // metres

const COOL_SPILL = new THREE.Color(0xbcd2ff);

export class Flashlight {
  readonly light: THREE.SpotLight;
  readonly target = new THREE.Object3D();

  on = false;
  battery = 1;

  onToggle: ((on: boolean) => void) | null = null;
  onBatteryLow: (() => void) | null = null;

  private spill: THREE.SpotLight;      // wide, shadowless spill lobe
  private pool: THREE.PointLight;      // warm near-field ground fill
  private cookie: THREE.DataTexture;

  private dust: THREE.Points;
  private dustMat: THREE.ShaderMaterial;
  private dustGeo: THREE.BufferGeometry;
  private dustPos: Float32Array;
  private dustSeed: Float32Array;      // phase x/y/z + size jitter
  private dustCount: number;
  private dustRng: SeededRandom;

  private hf: import('../world/HeightField').HeightField | null;

  // --- electrical / optical state -------------------------------------------
  private filament = 0;      // 0..1 thermal state, drives visible output
  private flickerTarget = 1;
  private flickerHold = 0;
  private warnedLow = false;
  private strength = 0;      // final output multiplier (post-inertia)

  // --- handheld dynamics ----------------------------------------------------
  private aim = new THREE.Vector3(0, 0, -1);
  private aimVel = new THREE.Vector3();
  private handPos = new THREE.Vector3();
  private swayPhase = 0;

  // scratch
  private dir = new THREE.Vector3();
  private srcPos = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private tmp = new THREE.Vector3(0, 0, -1);

  /** Half-extents of the world-space slab the motes live in (metres). */
  private static readonly SLAB_XZ = 7.0;
  private static readonly SLAB_Y = 3.2;

  constructor(
    private scene: THREE.Scene,
    private player: Player,
    shadowSize: number,
    hf?: import('../world/HeightField').HeightField,
    dustCount = 260,
  ) {
    this.hf = hf ?? null;
    this.dustRng = new SeededRandom(0xD057);

    // ---------------------------------------------------------------- cookie
    this.cookie = makeIesCookie(128, this.dustRng.fork(7));

    // ------------------------------------------------------------- main lobe
    // Penumbra stays low: the *cookie* shapes the edge, so a soft three
    // penumbra on top would only wash the hotspot out.
    this.light = new THREE.SpotLight(0xffd7a3, 0, RANGE, OUTER_ANGLE, 0.22, 1.55);
    this.light.map = this.cookie;
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(shadowSize, shadowSize);
    this.light.shadow.camera.near = 0.25;
    this.light.shadow.camera.far = RANGE;
    this.light.shadow.bias = -0.0016;
    this.light.shadow.normalBias = 0.022;
    this.light.shadow.radius = 2.2;
    this.light.target = this.target;
    scene.add(this.light, this.target);

    // Wide shadowless spill: light escaping the reflector, lifting the
    // immediate surroundings so we don't get "torch in a void".
    this.spill = new THREE.SpotLight(0xffc98c, 0, 22, 1.15, 0.9, 1.3);
    this.spill.castShadow = false;
    this.spill.target = this.target;
    scene.add(this.spill);

    // Near-field bounce off the ground a couple of metres ahead.
    this.pool = new THREE.PointLight(0xffcb90, 0, 7.0, 2);
    scene.add(this.pool);

    // ------------------------------------------------------------------ dust
    this.dustCount = Math.max(24, dustCount | 0);
    this.dustPos = new Float32Array(this.dustCount * 3);
    this.dustSeed = new Float32Array(this.dustCount * 4);
    for (let i = 0; i < this.dustCount; i++) {
      this.dustSeed[i * 4] = this.dustRng.range(0, Math.PI * 2);
      this.dustSeed[i * 4 + 1] = this.dustRng.range(0, Math.PI * 2);
      this.dustSeed[i * 4 + 2] = this.dustRng.range(0, Math.PI * 2);
      this.dustSeed[i * 4 + 3] = this.dustRng.range(0.55, 1.5);
    }
    this.dustGeo = new THREE.BufferGeometry();
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(this.dustPos, 3));
    this.dustGeo.setAttribute('aSeed', new THREE.BufferAttribute(this.dustSeed, 4));
    this.dustMat = makeDustMaterial();
    this.dust = new THREE.Points(this.dustGeo, this.dustMat);
    this.dust.visible = false;
    this.dust.frustumCulled = false;
    this.dust.renderOrder = 6;
    scene.add(this.dust);
    this.reseedSlab();
  }

  // ==========================================================================
  // public API
  // ==========================================================================

  toggle(): void {
    if (!this.on && this.battery <= 0.005) return;   // dead cell: click, nothing
    this.on = !this.on;
    // On switch-off the filament keeps its heat and decays in update(),
    // producing a soft glow-down instead of a hard cut.
    if (!this.on) this.flickerTarget = 0;
    this.onToggle?.(this.on);
  }

  /** 0..~1 output level — feed to `RenderPipeline.setBeam()`. */
  get beamStrength(): number { return this.strength; }

  /** Cone half-angle in radians (the volumetric pass wants this). */
  get outerAngle(): number { return OUTER_ANGLE; }

  /** Keep dust sprite sizing physically correct across resize / FOV changes. */
  setProjection(renderHeightPx: number, fovYRadians: number): void {
    this.dustMat.uniforms.uProjScale.value =
      (0.5 * renderHeightPx) / Math.tan(fovYRadians * 0.5);
  }

  /** Quality hook: trim the mote budget without reallocating buffers. */
  setDustBudget(count: number): void {
    this.dustGeo.setDrawRange(0, THREE.MathUtils.clamp(count | 0, 0, this.dustCount));
  }

  setShadowSize(size: number): void {
    this.light.shadow.mapSize.set(size, size);
    if (this.light.shadow.map) {
      this.light.shadow.map.dispose();
      this.light.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
  }

  /** QA/debug contract (unchanged): raw mote positions + current forward. */
  dustStats(): { positions: Float32Array; forward: THREE.Vector3 } {
    this.player.camera.getWorldDirection(this.dir);
    return { positions: this.dustPos, forward: this.dir.clone() };
  }

  /** Teleport / respawn hook: re-centre the dust slab instantly. */
  warp(): void { this.reseedSlab(); }

  // ==========================================================================
  // per-frame
  // ==========================================================================

  update(dt: number, time: number): void {
    const step = Math.min(dt, 0.05);   // a hitch must not blow up the spring

    // ------------------------------------------------------------- battery
    if (this.on) {
      // Drain scales a little with actual output, so a flickering dying torch
      // limps along instead of dropping off a cliff.
      const load = 0.85 + 0.35 * this.strength;
      this.battery = Math.max(0, this.battery - (dt / 235) * load);
      if (this.battery < 0.22 && !this.warnedLow) { this.warnedLow = true; this.onBatteryLow?.(); }
      if (this.battery >= 0.22) this.warnedLow = false;
      if (this.battery <= 0) this.on = false;
    } else {
      this.battery = Math.min(1, this.battery + dt / 420);
    }
    this.player.setBatteryGauge(this.battery);

    // --------------------------------------------------- voltage / flicker
    // Terminal voltage: flat-ish above 25% charge, then a hard sag.
    const volts = this.battery > 0.25
      ? 0.94 + 0.06 * ((this.battery - 0.25) / 0.75)
      : 0.42 + 0.52 * Math.pow(this.battery / 0.25, 0.65);

    if (this.on) {
      this.flickerHold -= dt;
      if (this.flickerHold <= 0) {
        // Dropout probability climbs steeply as the cell dies; above ~30% the
        // bulb is rock steady.
        const risk = this.battery < 0.3 ? Math.pow(1 - this.battery / 0.3, 1.7) : 0;
        const drop = this.dustRng.next() < risk * 0.55;
        this.flickerTarget = drop ? this.dustRng.range(0.06, 0.4) : 1;
        this.flickerHold = drop ? this.dustRng.range(0.03, 0.16) : this.dustRng.range(0.12, 0.9);
      }
    } else {
      this.flickerTarget = 0;
    }

    // Filament thermal inertia — tungsten heats faster than it cools.
    const goal = this.flickerTarget * volts;
    const rate = goal > this.filament ? 16 : 9;
    this.filament += (goal - this.filament) * Math.min(1, rate * step);
    if (this.filament < 0.0015) this.filament = 0;

    // Luminous output is super-linear in filament temperature: an incandescent
    // at 70% voltage is far dimmer than 70% bright.
    this.strength = Math.pow(this.filament, 1.35);
    const active = this.strength > 0.002;

    // Colour temperature ramps from a sullen ember up to warm white.
    kelvinToColor(1900 + 1450 * THREE.MathUtils.clamp(this.filament, 0, 1), this.light.color);
    this.spill.color.copy(this.light.color).lerp(COOL_SPILL, 0.18);
    this.pool.color.copy(this.light.color);

    this.light.intensity = 330 * this.strength;
    this.spill.intensity = 11 * this.strength;
    this.pool.intensity = 1.35 * this.strength;
    this.player.setLensGlow(active ? 2.5 * this.strength : 0);
    this.light.visible = this.spill.visible = this.pool.visible = active;
    this.dust.visible = active;
    this.dustMat.uniforms.uBeamStrength.value = this.strength;

    if (!active) return;

    // --------------------------------------------------- handheld placement
    const cam = this.player.camera;
    cam.getWorldPosition(this.srcPos);
    cam.getWorldDirection(this.dir);
    this.right.set(this.dir.z, 0, -this.dir.x).normalize();

    // Damped spring aim: stiff enough to stay usable, loose enough that
    // whipping the view visibly drags the beam behind you.
    const stiffness = 150, damping = 2 * Math.sqrt(stiffness) * 0.92;
    this.tmp.copy(this.dir).sub(this.aim).multiplyScalar(stiffness);
    this.aimVel.addScaledVector(this.tmp, step).multiplyScalar(Math.max(0, 1 - damping * step));
    this.aim.addScaledVector(this.aimVel, step).normalize();

    // Sub-degree cadence sway so the beam breathes even standing still.
    this.swayPhase += step;
    const swayX = Math.sin(this.swayPhase * 1.7) * 0.0075 + Math.sin(this.swayPhase * 5.3) * 0.0022;
    const swayY = Math.sin(this.swayPhase * 2.3 + 1.1) * 0.0055;

    // Hand offset: right of and below the eye — this is what swings shadows.
    this.handPos.copy(this.srcPos)
      .addScaledVector(this.right, 0.17)
      .addScaledVector(this.dir, 0.22);
    this.handPos.y -= 0.15;
    this.light.position.copy(this.handPos);
    this.spill.position.copy(this.handPos);

    this.tmp.copy(this.aim)
      .addScaledVector(this.right, swayX)
      .addScaledVector(this.up, swayY)
      .normalize();
    this.target.position.copy(this.handPos).addScaledVector(this.tmp, 24);

    // Ground bounce pool sits on the terrain ahead of the player.
    if (this.hf) {
      const px = this.player.pos.x + this.tmp.x * 1.7;
      const pz = this.player.pos.z + this.tmp.z * 1.7;
      this.pool.position.set(px, this.hf.heightAt(px, pz) + 1.0, pz);
    } else {
      this.pool.position.copy(this.srcPos).addScaledVector(this.tmp, 1.6);
      this.pool.position.y -= 0.85;
    }

    this.updateDust(step, time);
  }

  // ==========================================================================
  // dust field
  // ==========================================================================

  private updateDust(dt: number, time: number): void {
    const p = this.dustPos, s = this.dustSeed;
    const cx = this.player.pos.x, cy = this.player.pos.y + 1.2, cz = this.player.pos.z;
    const hx = Flashlight.SLAB_XZ, hy = Flashlight.SLAB_Y;

    // The slab follows the player, but motes *wrap* toroidally rather than
    // being respawned in front of the camera. Wrapping preserves the illusion
    // of a static cloud you walk through — nothing ever flies at your face
    // (which is exactly how the old code manufactured huge near-plane blobs).
    for (let i = 0; i < this.dustCount; i++) {
      const i3 = i * 3, i4 = i * 4;
      p[i3] += Math.sin(time * 0.31 + s[i4]) * dt * 0.052;
      p[i3 + 1] += Math.sin(time * 0.23 + s[i4 + 1]) * dt * 0.036 - dt * 0.014;
      p[i3 + 2] += Math.sin(time * 0.27 + s[i4 + 2]) * dt * 0.052;

      let d = p[i3] - cx;
      if (d > hx) p[i3] -= hx * 2; else if (d < -hx) p[i3] += hx * 2;
      d = p[i3 + 2] - cz;
      if (d > hx) p[i3 + 2] -= hx * 2; else if (d < -hx) p[i3 + 2] += hx * 2;
      d = p[i3 + 1] - cy;
      if (d > hy) p[i3 + 1] -= hy * 2; else if (d < -hy) p[i3 + 1] += hy * 2;
    }
    (this.dustGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    // Feed the cone so the shader can light motes without a real light lookup.
    const u = this.dustMat.uniforms;
    (u.uBeamOrigin.value as THREE.Vector3).copy(this.handPos);
    (u.uBeamDir.value as THREE.Vector3).copy(this.tmp);
    (u.uBeamColor.value as THREE.Color).copy(this.light.color);
    u.uTime.value = time;
  }

  private reseedSlab(): void {
    const hx = Flashlight.SLAB_XZ, hy = Flashlight.SLAB_Y;
    const cx = this.player.pos.x, cy = this.player.pos.y + 1.2, cz = this.player.pos.z;
    for (let i = 0; i < this.dustCount; i++) {
      this.dustPos[i * 3] = cx + this.dustRng.range(-hx, hx);
      this.dustPos[i * 3 + 1] = cy + this.dustRng.range(-hy, hy);
      this.dustPos[i * 3 + 2] = cz + this.dustRng.range(-hx, hx);
    }
    (this.dustGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.light, this.target, this.spill, this.pool, this.dust);
    this.dustGeo.dispose();
    this.dustMat.dispose();
    this.cookie.dispose();
    this.light.dispose();
    this.spill.dispose();
    this.pool.dispose();
  }
}

// ============================================================================
// helpers
// ============================================================================

/**
 * Planckian locus approximation (Tanner Helland's fit), converted to linear.
 * Accurate enough from ~1000K to ~6500K, which covers a dying tungsten bulb.
 */
function kelvinToColor(kelvin: number, out: THREE.Color): THREE.Color {
  const t = THREE.MathUtils.clamp(kelvin, 1000, 12000) / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  out.setRGB(
    THREE.MathUtils.clamp(r, 0, 255) / 255,
    THREE.MathUtils.clamp(g, 0, 255) / 255,
    THREE.MathUtils.clamp(b, 0, 255) / 255,
  );
  out.convertSRGBToLinear();
  return out;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Bake a photometric "cookie" for `SpotLight.map`.
 *
 * The texture is sampled in the light's projected UV space, so the disc
 * inscribed in the square *is* the cone cross-section. We build:
 *  - a bright, tight **hotspot** (the reflector's focused image of the bulb),
 *  - a broad **spill** shoulder rolling off to zero at the rim,
 *  - faint concentric **facet rings** from the reflector's stamped segments,
 *  - a slightly **ragged rim** (smooth angular noise) so the edge isn't a
 *    perfect circle — this single detail sells it more than anything else,
 *  - a dim off-axis **cross flare** from the bulb's support posts.
 */
function makeIesCookie(size: number, rng: SeededRandom): THREE.DataTexture {
  const data = new Uint8Array(new ArrayBuffer(size * size * 4));

  // per-angle rim noise: smoothly interpolated buckets around the circle
  const RIM = 64;
  const rim = new Float32Array(RIM);
  for (let i = 0; i < RIM; i++) rim[i] = rng.range(-1, 1);
  const rimAt = (a: number) => {
    const f = ((((a / (Math.PI * 2)) % 1) + 1) % 1) * RIM;
    const i0 = Math.floor(f) % RIM, i1 = (i0 + 1) % RIM;
    const t = f - Math.floor(f), s = t * t * (3 - 2 * t);
    return rim[i0] * (1 - s) + rim[i1] * s;
  };

  const inv = 1 / (size - 1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x * inv * 2 - 1, v = y * inv * 2 - 1;
      const r = Math.sqrt(u * u + v * v);
      const ang = Math.atan2(v, u);

      // ragged edge: nudge the effective radius by up to ~4%
      const rr = r * (1 + rimAt(ang) * 0.04);

      const hot = Math.exp(-Math.pow(rr / HOTSPOT_FRAC, 2) * 1.35);
      const spill = Math.pow(Math.max(0, 1 - rr), 1.55) * 0.42;
      const rings = Math.cos(rr * 26.0) * 0.03 * Math.pow(Math.max(0, 1 - rr), 1.5);
      const cross = Math.pow(Math.abs(Math.cos(ang * 2)), 12) * 0.05
        * Math.pow(Math.max(0, 1 - rr), 2.0);

      let i = hot + spill + rings + cross;
      i *= 1 - smoothstep(0.94, 1.0, rr);   // hard vignette: no leak into corners
      i = THREE.MathUtils.clamp(i, 0, 1);

      // A real reflector focuses long wavelengths marginally tighter, so the
      // centre runs slightly warmer than the rim.
      const warm = 1 - rr * 0.5;
      const o = (y * size + x) * 4;
      data[o] = Math.min(255, i * 255 * (0.98 + 0.02 * warm));
      data[o + 1] = Math.min(255, i * 255 * (0.94 + 0.05 * warm));
      data[o + 2] = Math.min(255, i * 255 * (0.88 + 0.07 * warm));
      data[o + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Dust mote material — the "no more white dice" shader.
 *
 * `gl_PointSize` is **clamped** to a small pixel range, the sprite is a smooth
 * radial blob (never a square), motes dissolve as they approach the near plane,
 * and brightness is `cone(angle) · 1/d² · HG(scatter angle)` so anything outside
 * the beam contributes exactly zero energy.
 */
function makeDustMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPixelRange: { value: new THREE.Vector2(1.0, 3.25) },
      uProjScale: { value: 600 },
      uWorldSize: { value: 0.014 },
      uNearFade: { value: new THREE.Vector2(0.55, 1.9) },
      uFarFade: { value: new THREE.Vector2(9.0, 16.0) },
      uBeamOrigin: { value: new THREE.Vector3() },
      uBeamDir: { value: new THREE.Vector3(0, 0, -1) },
      uBeamColor: { value: new THREE.Color(0xffd7a3) },
      uBeamStrength: { value: 0 },
      uCosAngles: {
        value: new THREE.Vector2(Math.cos(OUTER_ANGLE * HOTSPOT_FRAC), Math.cos(OUTER_ANGLE)),
      },
      uTime: { value: 0 },
      uOpacity: { value: 0.85 },
    },
    vertexShader: /* glsl */`
      ${SOFT_SPRITE_CHUNKS.vert}
      attribute vec4 aSeed;
      uniform float uWorldSize;
      uniform vec2 uNearFade;
      uniform vec2 uFarFade;
      uniform vec3 uBeamOrigin;
      uniform vec3 uBeamDir;
      uniform vec2 uCosAngles;
      uniform float uBeamStrength;
      uniform float uTime;
      varying float vLum;

      // Henyey-Greenstein: forward-scattering lobe for airborne dust.
      float hg(float cosT, float g){
        float g2 = g * g;
        return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosT, 1.5);
      }

      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = -mv.z;
        gl_PointSize = softPointSize(mv.z, uWorldSize * aSeed.w);
        gl_Position = projectionMatrix * mv;

        // --- cone illumination, evaluated per mote (no light lookup needed)
        vec3 toMote = position - uBeamOrigin;
        float d = length(toMote);
        vec3 l = toMote / max(d, 1e-4);
        float cone = smoothstep(uCosAngles.y, uCosAngles.x, dot(l, uBeamDir));
        float atten = 1.0 / (1.0 + d * d * 0.24);

        // scatter angle between the beam and the eye ray
        vec3 eyeRay = normalize(position - cameraPosition);
        float phase = hg(dot(eyeRay, uBeamDir), 0.62) * 0.16;

        // twinkle: motes tumble, catching the light irregularly
        float tw = 0.65 + 0.35 * sin(uTime * 2.3 + aSeed.x * 6.28)
                              * sin(uTime * 1.7 + aSeed.y * 6.28);

        float nearF = smoothstep(uNearFade.x, uNearFade.y, dist);
        float farF  = 1.0 - smoothstep(uFarFade.x, uFarFade.y, dist);
        vLum = cone * atten * phase * tw * nearF * farF * uBeamStrength;
      }`,
    fragmentShader: /* glsl */`
      ${SOFT_SPRITE_CHUNKS.frag}
      uniform vec3 uBeamColor;
      uniform float uOpacity;
      varying float vLum;
      void main(){
        float a = softSpriteMask(1.5) * vLum * uOpacity;
        if (a < 0.0025) discard;
        gl_FragColor = vec4(uBeamColor * a, a);   // premultiplied additive
      }`,
  });
}
