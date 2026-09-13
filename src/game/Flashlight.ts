import * as THREE from 'three';
import { Player } from './Player';
import { SeededRandom } from '../core/SeededRandom';
import { SOFT_SPRITE_CHUNKS } from '../render/Particles';
import {
  GLSL_BEAM_PROFILE, beamProfile,
} from '../render/ShaderChunks';

/**
 * Handheld torch: shadowed hotspot, soft reflector shoulder and wide dim spill.
 * The cookie, fog and dust share one projected radial profile. Aim follows the
 * current camera transform without aim filtering; hand motion stays in the viewmodel.
 */

/** Cone half-angle of the spill lobe, radians. ~28°, a typical reflector. */
const OUTER_ANGLE = 0.49;

// The beam profile coefficients and the `beamProfile()` curve now live in
// `render/ShaderChunks.ts`, imported above. They moved because the volumetric
// in-scatter pass needs the identical curve and cannot import from a gameplay
// module without a dependency cycle — and a second copy of these five numbers
// is exactly how the lit cone and the visible shaft drift apart.

/** Throw distance, metres. Past this the profile is dark anyway. */
const RANGE = 58;

/** Peak intensity in candela; inverse-square falloff preserves depth cues. */
const PEAK_INTENSITY = 420;

/** Softening radius for the dust scattering term near the emitter. */
const APERTURE = 0.85;
const APERTURE2 = APERTURE * APERTURE;

const COOL_SPILL = new THREE.Color(0xb4c8f0);

export class Flashlight {
  readonly light: THREE.SpotLight;
  readonly target = new THREE.Object3D();

  on = false;
  battery = 1;

  onToggle: ((on: boolean) => void) | null = null;
  onBatteryLow: (() => void) | null = null;

  private spill: THREE.SpotLight;      // wide, shadowed spill lobe
  private cookie: THREE.DataTexture;

  private dust: THREE.Points;
  private dustMat: THREE.ShaderMaterial;
  private dustGeo: THREE.BufferGeometry;
  private dustPos: Float32Array;
  private dustSeed: Float32Array;
  private dustCount: number;
  private dustRng: SeededRandom;


  // --- electrical / optical state -------------------------------------------
  private drive = 0;         // 0..1 driver output state
  private flickerTarget = 1;
  private flickerHold = 0;
  private warnedLow = false;
  private strength = 0;

  // --- handheld dynamics ----------------------------------------------------
  private handPos = new THREE.Vector3();

  // scratch — this class allocates nothing per frame
  private dir = new THREE.Vector3();
  private srcPos = new THREE.Vector3();
  private aimOut = new THREE.Vector3(0, 0, -1);

  private static readonly SLAB_XZ = 7.0;
  private static readonly SLAB_Y = 3.2;

  constructor(
    private scene: THREE.Scene,
    private player: Player,
    shadowSize: number,
    hf?: import('../world/HeightField').HeightField,
    dustCount = 260,
  ) {
    this.dustRng = new SeededRandom(0xD057);

    // ---------------------------------------------------------------- cookie
    this.cookie = makeBeamCookie(256, this.dustRng.fork(7));

    // ------------------------------------------------------------- main lobe
    //
    // `penumbra = 0.06` is deliberately tiny. three's own
    // smoothstep runs *before* the cookie is applied, so a large penumbra here
    // would stack a second rolloff on the fitted profile and wash the hotspot
    // out. At 0.06 it is only the ~1.5° anti-alias band the projected texture
    // cannot supply for itself.
    this.light = new THREE.SpotLight(0xffe2c0, 0, RANGE, OUTER_ANGLE, 0.06, 2);
    this.light.map = this.cookie;
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(shadowSize, shadowSize);
    // Near walls and foliage must still occlude the beam at the lens.
    this.light.shadow.camera.near = 0.08;
    this.light.shadow.camera.far = RANGE;
    this.light.shadow.bias = -0.00008;
    this.light.shadow.normalBias = 0.012;
    this.light.shadow.radius = 2.6;
    this.light.target = this.target;
    scene.add(this.light, this.target);

    // Broad low-energy reflector spill. It casts shadows too: an unshadowed
    // second light would illuminate the other side of walls and tree trunks.
    this.spill = new THREE.SpotLight(0xffd2a0, 0, 12, 0.9, 0.85, 2);
    this.spill.castShadow = true;
    this.spill.shadow.mapSize.set(512, 512);
    this.spill.shadow.camera.near = 0.08;
    this.spill.shadow.camera.far = 12;
    this.spill.shadow.bias = -0.00008;
    this.spill.shadow.normalBias = 0.012;
    this.spill.target = this.target;
    scene.add(this.spill);


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
    if (this.on) {
      this.flickerTarget = 1;
      this.flickerHold = 0;
    }
    if (!this.on) this.flickerTarget = 0;
    this.onToggle?.(this.on);
  }

  /** 0..~1 output level — feed to `RenderPipeline.setBeam()`. */
  get beamStrength(): number { return this.strength; }

  /** Cone half-angle in radians (the volumetric pass wants this). */
  get outerAngle(): number { return OUTER_ANGLE; }

  /**
   * The beam's *current* world-space direction and origin.
   *
   * Exposed so the volumetric pass can use the exact vectors the surface
   * lighting used, instead of re-deriving them from `target.matrixWorld` and
   * picking up a frame of lag when called outside `renderer.render()`.
   */
  get aimDirection(): THREE.Vector3 { return this.aimOut; }
  get originPosition(): THREE.Vector3 { return this.handPos; }

  setProjection(renderHeightPx: number, fovYRadians: number): void {
    this.dustMat.uniforms.uProjScale.value =
      (0.5 * renderHeightPx) / Math.tan(fovYRadians * 0.5);
  }

  setDustBudget(count: number): void {
    this.dustGeo.setDrawRange(0, THREE.MathUtils.clamp(count | 0, 0, this.dustCount));
  }

  setShadowSize(size: number): void {
    if (this.light.shadow.mapSize.x === size) return;
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

  /** Teleport / respawn hook. */
  resetForCapture(): void {
    this.dustRng = new SeededRandom(0xD057);
    this.drive = this.strength = this.flickerHold = 0;
    this.flickerTarget = 1;
    this.warnedLow = false;
    this.on = false;
    this.battery = 1;
    this.warp();
    this.update(0, 0);
  }

  warp(): void {
    this.reseedSlab();
    this.updatePose();
  }

  // ==========================================================================
  // per-frame
  // ==========================================================================

  update(dt: number, time: number): void {
    // Bound particle integration during a background-tab stall.
    const step = Math.min(dt, 0.1);

    // ------------------------------------------------------------- battery
    if (this.on) {
      const load = 0.85 + 0.35 * this.strength;
      this.battery = Math.max(0, this.battery - (dt / 235) * load);
      if (this.battery < 0.22 && !this.warnedLow) { this.warnedLow = true; this.onBatteryLow?.(); }
      if (this.battery >= 0.22) this.warnedLow = false;
      if (this.battery <= 0) this.on = false;
    } else {
      this.battery = Math.min(1, this.battery + dt / 420);
    }
    this.player.setBatteryGauge(this.battery);

    // --------------------------------------------------- driver / flicker
    //
    // An LED driver holds regulated output nearly flat across most of the
    // cell's discharge curve and then falls off a cliff — quite unlike the
    // gradual sag of the incandescent this used to model. That difference is
    // gameplay, not pedantry: the torch stays *fully useful* until it is nearly
    // dead, so the tension lives in the gauge rather than in a slow degradation
    // the player unconsciously adapts to.
    const volts = this.battery > 0.18
      ? 0.97 + 0.03 * ((this.battery - 0.18) / 0.82)
      : 0.30 + 0.67 * Math.pow(this.battery / 0.18, 0.7);

    if (this.on) {
      this.flickerHold -= dt;
      if (this.flickerHold <= 0) {
        const risk = this.battery < 0.25 ? Math.pow(1 - this.battery / 0.25, 1.8) : 0;
        const drop = this.dustRng.next() < risk * 0.5;
        this.flickerTarget = drop ? this.dustRng.range(0.05, 0.35) : 1;
        this.flickerHold = drop ? this.dustRng.range(0.03, 0.14) : this.dustRng.range(0.15, 1.1);
      }
    } else {
      this.flickerTarget = 0;
    }

    // Driver slew. An LED has no thermal mass worth modelling, but the driver's
    // output capacitor does ramp: fast enough to read as electronic, slow enough
    // that a dropout glows down rather than strobing a single black frame.
    const goal = this.flickerTarget * volts;
    const rate = goal > this.drive ? 26 : 18;
    this.drive += (goal - this.drive) * (1 - Math.exp(-rate * step));
    if (this.drive < 0.0015) this.drive = 0;

    // Near-linear, unlike tungsten: an LED at 70% drive really is ~70% bright.
    this.strength = Math.pow(this.drive, 1.08);
    const active = this.strength > 0.002;

    // Cool-neutral LED that warms slightly as the driver browns out.
    kelvinToColor(3900 + 1500 * THREE.MathUtils.clamp(this.drive, 0, 1), this.light.color);
    this.spill.color.copy(this.light.color).lerp(COOL_SPILL, 0.22);

    this.light.intensity = PEAK_INTENSITY * this.strength;
    this.spill.intensity = 9.0 * this.strength;
    this.player.setLensGlow(active ? 0.12 * this.strength : 0);
    this.light.visible = this.spill.visible = active;

    // No shadow scheduling here on purpose. The beam is rigidly attached to a
    // camera that can rotate arbitrarily fast, so there is no cheap "did it
    // move enough" test that is also correct — skipping a frame reads instantly
    // as the torch's shadows lagging the view. three's default per-light
    // `autoUpdate` refreshes every frame, and `visible = false` skips it for
    // free while the torch is off. Only the moon opts out (see ShadowQuality).
    this.dust.visible = active;
    this.dustMat.uniforms.uBeamStrength.value = this.strength;

    // Keep the pose current even when switched off; debug captures, warps and
    // volumetric consumers must never inherit an old emitter transform.
    this.updatePose();
    if (active) this.updateDust(step, time);
  }

  private updatePose(): void {
    const cam = this.player.camera;
    cam.updateWorldMatrix(true, false);
    cam.getWorldPosition(this.srcPos);
    cam.getWorldDirection(this.dir);
    this.player.getFlashlightOrigin(this.handPos);

    // Aim at the current centre of view. The lens still follows the physical
    // hand (including crouch, sprint and wall retraction), but a second aim lag
    // would double the viewmodel inertia and miss during fast mouse/touch turns.
    // A fixed convergence distance keeps near-field parallax physically honest.
    this.aimOut.copy(this.srcPos).addScaledVector(this.dir, 12)
      .sub(this.handPos).normalize();

    this.light.position.copy(this.handPos);
    this.spill.position.copy(this.handPos);
    this.target.position.copy(this.handPos).addScaledVector(this.aimOut, 30);

    // **Explicitly** flush both matrices. Relying on the
    // scene-graph walk inside `renderer.render()` leaves every consumer that
    // runs earlier (notably the volumetric pass) one frame stale, which reads
    // as the beam's fog cone trailing its own lit geometry.
    this.light.updateMatrixWorld(true);
    this.target.updateMatrixWorld(true);
    this.spill.updateMatrixWorld(true);

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
    // of a static cloud you walk through — nothing ever flies at your face.
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

    const u = this.dustMat.uniforms;
    (u.uBeamOrigin.value as THREE.Vector3).copy(this.handPos);
    (u.uBeamDir.value as THREE.Vector3).copy(this.aimOut);
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
    this.scene.remove(this.light, this.target, this.spill, this.dust);
    this.dustGeo.dispose();
    this.dustMat.dispose();
    this.cookie.dispose();
    this.light.dispose();
    this.spill.dispose();
  }
}

// ============================================================================
// helpers
// ============================================================================

/**
 * Planckian locus approximation (Tanner Helland's fit), converted to linear.
 * Accurate enough from ~1000K to ~6500K.
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

/** The fitted radial intensity profile. `rr` is 0 on axis, 1 at the rim. */
// `beamProfile()` is imported from render/ShaderChunks — see the note by the
// imports. The cookie bake below calls it, so the baked texture and the
// volumetric shader are guaranteed to describe the same cone.

/**
 * Bake the photometric cookie for `SpotLight.map`.
 *
 * ## The projected-square subtlety
 *
 * three samples this at `spotLightCoord.xy`, which is the light's *projection*
 * — so the cone's circular cross-section is the disc **inscribed** in the
 * square, and the four corners are directions outside the cone entirely. The
 * old baker wrote a hard vignette at `rr > 0.94` to "stop leaking into the
 * corners"; `inSpotLightMap` already rejects those directions, so all the
 * vignette did was carve a visible hard ring just inside the rim.
 *
 * The shared profile rolls smoothly to zero at the inscribed radius, so the
 * outer shadow-frustum boundary never cuts off a visibly bright shoulder.
 *
 * ## The detail that sells it
 *
 * Three optical imperfections, all baked once, all effectively free:
 *
 *  - **Reflector facet rings.** A stamped aluminium reflector carries visible
 *    concentric tool marks — a ~1.5% ripple, fading out toward the axis because
 *    it is an edge artefact rather than a focus artefact.
 *  - **A ragged rim.** Real beam edges are not circles. Smooth angular noise
 *    perturbs the effective radius by up to 3.5%, weighted toward the rim. This
 *    one detail does more than everything else combined.
 *  - **Chromatic focus error.** A reflector focuses long wavelengths marginally
 *    tighter, so the core runs warmer than the skirt. Subtle, but it is why the
 *    hotspot reads as *light* and not as a white decal.
 */
function makeBeamCookie(size: number, rng: SeededRandom): THREE.DataTexture {
  const data = new Uint8Array(new ArrayBuffer(size * size * 4));

  // Smoothly-interpolated per-angle rim noise.
  const RIM = 96;
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

      // Ragged edge, weighted toward the rim so the hotspot stays clean.
      const rr = r * (1 + rimAt(ang) * 0.035 * Math.min(1, r * 1.4));

      let i = beamProfile(rr);
      i *= 1 + Math.cos(rr * 34.0) * 0.015 * Math.min(1, rr * 2.2);
      // Faint bulb-post cross flare, skirt only.
      i += Math.pow(Math.abs(Math.cos(ang * 2)), 14) * 0.035
        * Math.pow(Math.max(0, 1 - Math.min(1, rr)), 2.2);

      i = THREE.MathUtils.clamp(i, 0, 1);

      // Chromatic focus error: core warmer than skirt.
      const warm = Math.max(0, 1 - rr * 0.62);
      const o = (y * size + x) * 4;
      data[o] = Math.min(255, i * 255 * (0.97 + 0.03 * warm));
      data[o + 1] = Math.min(255, i * 255 * (0.955 + 0.04 * warm));
      data[o + 2] = Math.min(255, i * 255 * (0.93 + 0.045 * warm));
      data[o + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  // **Linear, not sRGB.** This is a photometric curve, not an image. Tagging it
  // sRGB (as the previous version did) makes three linearise it on sample, so
  // 0.5 linear intensity becomes 0.21 — crushing the entire mid shoulder. That
  // single flag was most of why the beam read as a small core with a hard edge.
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.anisotropy = 2;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Dust mote material — the "no more white dice" shader.
 *
 * Brightness is `profile(coneAngle) · 1/(d²+r₀²) · HG(scatter)`, so a mote
 * outside the beam contributes exactly zero, and the *same* fitted profile the
 * cookie uses shapes the cone — so motes and lit geometry agree about where the
 * beam is, which they previously did not (the shader used a raw `smoothstep`
 * between the hotspot and outer cosines, a completely different curve).
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
      uFarFade: { value: new THREE.Vector2(10.0, 18.0) },
      uBeamOrigin: { value: new THREE.Vector3() },
      uBeamDir: { value: new THREE.Vector3(0, 0, -1) },
      uBeamColor: { value: new THREE.Color(0xffe2c0) },
      uBeamStrength: { value: 0 },
      uOuterAngle: { value: OUTER_ANGLE },
      uTime: { value: 0 },
      uOpacity: { value: 0.8 },
    },
    vertexShader: /* glsl */`
      ${SOFT_SPRITE_CHUNKS.vert}
      attribute vec4 aSeed;
      uniform float uWorldSize;
      uniform vec2 uNearFade;
      uniform vec2 uFarFade;
      uniform vec3 uBeamOrigin;
      uniform vec3 uBeamDir;
      uniform float uOuterAngle;
      uniform float uBeamStrength;
      uniform float uTime;
      varying float vLum;

      // Henyey-Greenstein: forward-scattering lobe for airborne dust.
      float hg(float cosT, float g){
        float g2 = g * g;
        return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * cosT, 1.5);
      }

      // The SAME fitted profile the cookie bakes. One definition is what makes
      // the motes and the lit surfaces agree about the beam's shape.
      ${GLSL_BEAM_PROFILE}

      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float dist = -mv.z;
        gl_PointSize = softPointSize(mv.z, uWorldSize * aSeed.w);
        gl_Position = projectionMatrix * mv;

        // --- cone illumination, evaluated per mote (no light lookup needed)
        vec3 toMote = position - uBeamOrigin;
        float d = length(toMote);
        vec3 l = toMote / max(d, 1e-4);

        // Angle from the beam axis, normalised against the cone half-angle so
        // it indexes the profile exactly as the cookie's radius does.
        float cone = beamProfileFromCos(dot(l, uBeamDir), uOuterAngle);

        // Finite-aperture softening for airborne scattering near the emitter.
        float atten = 1.0 / (d * d + ${APERTURE2.toFixed(6)});

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
