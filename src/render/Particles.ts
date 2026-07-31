import * as THREE from 'three';

/**
 * Soft point-sprite plumbing.
 *
 * ### Why this module exists
 * `THREE.PointsMaterial` draws an axis-aligned **square** of `size * (H / (2·tan(fov/2))) / z`
 * pixels. With `sizeAttenuation` on and particles a fraction of a metre from the
 * eye, that expression explodes: a 2 cm mote at 0.5 m becomes a ~35 px hard-edged
 * white block. Stack additive blending and bloom on top and you get the
 * "why is my flashlight full of dice" artefact.
 *
 * Everything here fixes that at the source:
 *  - `gl_PointSize` is computed properly **and clamped** to a sane pixel range,
 *  - the sprite has a smooth radial falloff (no square silhouette, ever),
 *  - a near-field fade dissolves anything that gets close enough to be a blob,
 *  - alpha is pre-multiplied so additive blending can't produce hard edges.
 */

export interface SoftPointsOptions {
  /** Physical radius of a mote in metres (world units). */
  worldSize?: number;
  /** Minimum / maximum on-screen diameter in *device* pixels. */
  pixelRange?: [number, number];
  color?: THREE.ColorRepresentation;
  opacity?: number;
  /** Fade in over this near-distance window (metres) so nothing looms. */
  nearFade?: [number, number];
  /** Fade out over this far-distance window (metres). */
  farFade?: [number, number];
  /** Additive (glows, embers) or normal-blended (ash, rain mist). */
  additive?: boolean;
  /** Soft core hardness: 1 = gaussian-ish, 3 = tight glint. */
  falloff?: number;
  depthWrite?: boolean;
}

/** Shared GLSL: the sprite mask + a correct, clamped point-size expression. */
export const SOFT_SPRITE_CHUNKS = {
  /** Vertex: `softPointSize(mvPosition.z, worldSize)` → pixels, clamped. */
  vert: /* glsl */`
    uniform vec2 uPixelRange;    // (minPx, maxPx)
    uniform float uProjScale;    // 0.5 * renderHeight / tan(fovY * 0.5)
    float softPointSize(float viewZ, float worldSize){
      float d = max(-viewZ, 0.05);
      return clamp(worldSize * uProjScale / d, uPixelRange.x, uPixelRange.y);
    }`,
  /** Fragment: `softSpriteMask(falloff)` → 0..1 radial mask, zero at the rim. */
  frag: /* glsl */`
    float softSpriteMask(float falloff){
      vec2 c = gl_PointCoord - 0.5;
      float r = dot(c, c) * 4.0;             // squared radius, 1.0 at the rim
      return pow(max(1.0 - r, 0.0), falloff);
    }`,
};

export class SoftPoints {
  readonly points: THREE.Points;
  readonly material: THREE.ShaderMaterial;

  constructor(geometry: THREE.BufferGeometry, opts: SoftPointsOptions = {}) {
    const worldSize = opts.worldSize ?? 0.03;
    const pixelRange = opts.pixelRange ?? [1.0, 4.0];
    const nearFade = opts.nearFade ?? [0.35, 1.4];
    const farFade = opts.farFade ?? [40, 70];

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: opts.depthWrite ?? false,
      blending: opts.additive === false ? THREE.NormalBlending : THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(opts.color ?? 0xffffff) },
        uOpacity: { value: opts.opacity ?? 0.8 },
        uWorldSize: { value: worldSize },
        uPixelRange: { value: new THREE.Vector2(pixelRange[0], pixelRange[1]) },
        uProjScale: { value: 600 },
        uNearFade: { value: new THREE.Vector2(nearFade[0], nearFade[1]) },
        uFarFade: { value: new THREE.Vector2(farFade[0], farFade[1]) },
        uFalloff: { value: opts.falloff ?? 1.6 },
        uFade: { value: 1 },
      },
      vertexShader: /* glsl */`
        ${SOFT_SPRITE_CHUNKS.vert}
        uniform float uWorldSize;
        uniform vec2 uNearFade;
        uniform vec2 uFarFade;
        varying float vFade;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = -mv.z;
          gl_PointSize = softPointSize(mv.z, uWorldSize);
          vFade = smoothstep(uNearFade.x, uNearFade.y, dist)
                * (1.0 - smoothstep(uFarFade.x, uFarFade.y, dist));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        ${SOFT_SPRITE_CHUNKS.frag}
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform float uFalloff;
        uniform float uFade;
        varying float vFade;
        void main(){
          float mask = softSpriteMask(uFalloff);
          float a = mask * uOpacity * vFade * uFade;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * a, a);   // premultiplied
        }`,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
  }

  /** Call on resize / FOV change so point size stays physically correct. */
  setProjection(renderHeightPx: number, fovYRadians: number): void {
    this.material.uniforms.uProjScale.value =
      (0.5 * renderHeightPx) / Math.tan(fovYRadians * 0.5);
  }

  set fade(v: number) { this.material.uniforms.uFade.value = v; }
  get fade(): number { return this.material.uniforms.uFade.value as number; }

  dispose(): void {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Rain as camera-facing **streaks** rather than points: line segments whose
 * length follows fall speed, alpha-faded toward the tail. Costs one draw call
 * and reads as motion instead of confetti.
 */
export class RainStreaks {
  readonly lines: THREE.LineSegments;
  readonly material: THREE.ShaderMaterial;
  private positions: Float32Array;
  private velocity: Float32Array;
  private count: number;

  constructor(count: number, private radius = 16, private height = 14) {
    this.count = count;
    this.positions = new Float32Array(count * 6);
    this.velocity = new Float32Array(count);
    const alpha = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      alpha[i * 2] = 1.0;      // head
      alpha[i * 2 + 1] = 0.0;  // tail
      this.velocity[i] = 11 + Math.random() * 7;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
    this.material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: new THREE.Color(0x9fb8d0) },
        uOpacity: { value: 0.28 },
        uFarFade: { value: new THREE.Vector2(18, 34) },
      },
      vertexShader: /* glsl */`
        attribute float aAlpha;
        uniform vec2 uFarFade;
        varying float vA;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vA = aAlpha * (1.0 - smoothstep(uFarFade.x, uFarFade.y, -mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; uniform float uOpacity;
        varying float vA;
        void main(){
          float a = vA * uOpacity;
          if (a < 0.004) discard;
          gl_FragColor = vec4(uColor * a, a);
        }`,
    });
    this.lines = new THREE.LineSegments(geo, this.material);
    this.lines.frustumCulled = false;
    this.reseed(0, 0, 0);
  }

  private reseed(cx: number, cy: number, cz: number): void {
    for (let i = 0; i < this.count; i++) this.respawn(i, cx, cy, cz, true);
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  private respawn(i: number, cx: number, cy: number, cz: number, anywhere: boolean): void {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * this.radius;
    const x = cx + Math.cos(a) * r;
    const z = cz + Math.sin(a) * r;
    const y = cy + (anywhere ? Math.random() * this.height : this.height * (0.75 + Math.random() * 0.25));
    const len = this.velocity[i] * 0.045;
    const o = i * 6;
    this.positions[o] = x; this.positions[o + 1] = y; this.positions[o + 2] = z;
    this.positions[o + 3] = x + 0.05; this.positions[o + 4] = y + len; this.positions[o + 5] = z;
  }

  update(dt: number, camX: number, camY: number, camZ: number, windX = 0, windZ = 0): void {
    const p = this.positions;
    for (let i = 0; i < this.count; i++) {
      const o = i * 6;
      const fall = this.velocity[i] * dt;
      const dx = windX * dt * 0.6, dz = windZ * dt * 0.6;
      p[o] += dx; p[o + 2] += dz; p[o + 1] -= fall;
      p[o + 3] += dx; p[o + 5] += dz; p[o + 4] -= fall;
      const dxc = p[o] - camX, dzc = p[o + 2] - camZ;
      if (p[o + 1] < camY - 3.0 || dxc * dxc + dzc * dzc > this.radius * this.radius * 1.6) {
        this.respawn(i, camX, camY - 2.0, camZ, false);
      }
    }
    (this.lines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    this.material.dispose();
  }
}
