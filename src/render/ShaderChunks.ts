/**
 * Shared GLSL building blocks for STATIC's render graph.
 *
 * Everything here targets **GLSL ES 3.00** (`THREE.GLSL3`) because the whole
 * post chain is WebGL2-only: we want `textureLod`, `texelFetch`, explicit
 * derivatives and integer math for the hashes. Keeping the snippets in one
 * module means every pass shares the exact same depth linearisation, the exact
 * same blue-noise-substitute dither and the exact same tonemap — which is what
 * makes a multi-pass graph look coherent instead of "a stack of filters".
 */

/** Hashes + interleaved gradient noise (Jimenez) — our blue-noise substitute. */
export const GLSL_HASH = /* glsl */`
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
/** Interleaved gradient noise: cheap, temporally stable, very "blue" in screen space. */
float ign(vec2 px){
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}
/** Animated IGN — golden-ratio frame offset keeps the pattern decorrelated over time. */
float ignT(vec2 px, float frame){
  return fract(ign(px) + frame * 0.6180339887);
}
`;

/** Depth utilities. All passes receive `uClip = vec2(near, far)`. */
export const GLSL_DEPTH = /* glsl */`
float linearizeDepth(float d, vec2 clip){
  float z = d * 2.0 - 1.0;
  return (2.0 * clip.x * clip.y) / (clip.y + clip.x - z * (clip.y - clip.x));
}
/** View-space position from a depth sample + inverse projection. */
vec3 viewPosFromDepth(vec2 uv, float d, mat4 invProj){
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = invProj * clip;
  return v.xyz / v.w;
}
`;

/** Colour space helpers: YCoCg (for TAA clipping) + sRGB transfer.
 *  No custom luminance helper here — three r170 unconditionally injects
 *  `float luminance( const in vec3 )` (identical Rec.709 coefficients)
 *  into every ShaderMaterial fragment prologue (WebGLProgram.js), so pass
 *  bodies can just call `luminance(...)`. (A previous `float lum(vec3)`
 *  helper both duplicated that and had backticks in its GLSL comment,
 *  which terminated the template literal and broke the esbuild parse.)
 */
export const GLSL_COLOR = /* glsl */`
vec3 rgbToYCoCg(vec3 c){
  float y = 0.25 * c.r + 0.5 * c.g + 0.25 * c.b;
  float co = 0.5 * c.r - 0.5 * c.b;
  float cg = -0.25 * c.r + 0.5 * c.g - 0.25 * c.b;
  return vec3(y, co, cg);
}
vec3 yCoCgToRgb(vec3 c){
  float t = c.x - c.z;
  return vec3(t + c.y, c.x + c.z, t - c.y);
}
vec3 linearToSRGB(vec3 c){
  return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;

/**
 * AgX-style display transform (Troy Sobotka's curve, fitted).
 *
 * Chosen over ACES because STATIC lives at the bottom of the exposure range:
 * AgX keeps near-black gradation and desaturates highlights instead of clipping
 * them to white — a flashlight hotspot on wet bark stays *bark coloured*.
 */
export const GLSL_TONEMAP = /* glsl */`
const mat3 AGX_IN = mat3(
  0.842479062253094,  0.0423282422610123, 0.0423756549057051,
  0.0784335999999992, 0.878468636469772,  0.0784336,
  0.0792237451477643, 0.0791661274605434, 0.879142973793104);
const mat3 AGX_OUT = mat3(
   1.19687900512017,  -0.0528968517574562, -0.0529716355144438,
  -0.0980208811401368, 1.15190312990417,   -0.0980434501171241,
  -0.0990297440797205,-0.0989611768448433,  1.15107367264116);

vec3 agxDefaultContrast(vec3 x){
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return  15.5 * x4 * x2
        - 40.14 * x4 * x
        + 31.96 * x4
        - 6.868 * x2 * x
        + 0.4298 * x2
        + 0.1191 * x
        - 0.00232;
}
vec3 agx(vec3 col, float saturation, float slope){
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  col = AGX_IN * max(col, 0.0);
  col = clamp((log2(col + 1e-10) - minEv) / (maxEv - minEv), 0.0, 1.0);
  col = agxDefaultContrast(col);
  col = AGX_OUT * col;
  col = max(col, 0.0);
  // "look": per-channel slope then luminance-preserving saturation
  col = pow(col, vec3(slope));
  float l = luminance(col); // three-injected helper (identical Rec.709)
  col = mix(vec3(l), col, saturation);
  return clamp(col, 0.0, 1.0);
}
`;

/** Henyey–Greenstein phase function — forward scattering for the beam + fog. */
export const GLSL_PHASE = /* glsl */`
float henyeyGreenstein(float cosT, float g){
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * cosT;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(d, 1e-4), 1.5));
}
`;

/** three.js packs shadow depth into RGBA8 — this is its inverse, verbatim. */
export const GLSL_UNPACK_DEPTH = /* glsl */`
const vec4 UNPACK_FACTORS = vec4(1.0 / (256.0 * 256.0 * 256.0), 1.0 / (256.0 * 256.0), 1.0 / 256.0, 1.0);
float unpackRGBAToDepth(vec4 v){ return dot(v, UNPACK_FACTORS); }
`;

/** Catmull–Rom (9-tap Sigma variant) history fetch — kills TAA resample blur. */
export const GLSL_CATMULL_ROM = /* glsl */`
vec3 sampleCatmullRom(sampler2D tex, vec2 uv, vec2 texSize){
  vec2 samplePos = uv * texSize;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));
  vec2 texPos0 = (texPos1 - 1.0) / texSize;
  vec2 texPos3 = (texPos1 + 2.0) / texSize;
  vec2 texPos12 = (texPos1 + offset12) / texSize;
  vec3 result = vec3(0.0);
  result += texture(tex, vec2(texPos0.x,  texPos0.y)).rgb  * w0.x  * w0.y;
  result += texture(tex, vec2(texPos12.x, texPos0.y)).rgb  * w12.x * w0.y;
  result += texture(tex, vec2(texPos3.x,  texPos0.y)).rgb  * w3.x  * w0.y;
  result += texture(tex, vec2(texPos0.x,  texPos12.y)).rgb * w0.x  * w12.y;
  result += texture(tex, vec2(texPos12.x, texPos12.y)).rgb * w12.x * w12.y;
  result += texture(tex, vec2(texPos3.x,  texPos12.y)).rgb * w3.x  * w12.y;
  result += texture(tex, vec2(texPos0.x,  texPos3.y)).rgb  * w0.x  * w3.y;
  result += texture(tex, vec2(texPos12.x, texPos3.y)).rgb  * w12.x * w3.y;
  result += texture(tex, vec2(texPos3.x,  texPos3.y)).rgb  * w3.x  * w3.y;
  return max(result, vec3(0.0));
}
`;

// ============================================================================
// flashlight beam profile
// ============================================================================

/**
 * Analytic beam profile coefficients — the ONE definition in the codebase.
 *
 * Least-squares fit against the target curve
 * [1.00, 0.92, 0.70, 0.50, 0.36, 0.20, 0.06, 0.00] sampled at
 * r = [0, .15, .30, .45, .60, .80, .95, 1.0]. Total residual < 0.002.
 *
 * These live here, rather than in `Flashlight.ts` where they were first
 * written, because *four* separate consumers have to agree on the beam's shape
 * and they do not all live in the same module:
 *
 *   1. the baked photometric cookie on `SpotLight.map`  (surface lighting)
 *   2. the dust-mote vertex shader                      (particles in the beam)
 *   3. the volumetric in-scatter pass                   (the visible shaft)
 *   4. the shadow-quality focus calculation             (where detail is spent)
 *
 * If any one of them disagrees, the shaft of light and the surfaces it lands on
 * describe differently-shaped cones, and the beam separates from the world —
 * the motes light up outside the lit ellipse, or the shaft has a hard rim the
 * floor does not. Exporting the numbers from a shared chunk is what makes
 * "one definition" enforceable rather than aspirational.
 */
export const BEAM_A = 2.15;    // core width
export const BEAM_P = 1.9;     // core shape (super-Gaussian exponent)
export const BEAM_S = 0.6;     // skirt exponent
export const BEAM_K = 0.66;    // skirt weight
export const BEAM_NORM = 1 / (1 + BEAM_K);   // makes profile(0) == 1

/** The fitted radial intensity profile. `rr` is 0 on axis, 1 at the rim. */
export function beamProfile(rr: number): number {
  const core = Math.exp(-Math.pow(rr * BEAM_A, BEAM_P));
  const skirt = Math.pow(Math.max(0, 1 - rr), BEAM_S) * BEAM_K;
  return (core + skirt) * BEAM_NORM;
}

/**
 * GLSL form of the same profile, plus a cosine-domain entry point.
 *
 * The volumetric pass has a `cos(angle)` in hand rather than the angle, because
 * that is what a dot product against the beam axis gives it, and `acos` per
 * raymarch step per pixel is not free — this shader takes up to 24 steps.
 *
 * `beamProfileFromCos` therefore converts through `acos` only once per step and
 * normalises by the cone's own half-angle, so it indexes the curve exactly as
 * the cookie's texel radius does. Reconstructing the profile directly in the
 * cosine domain would be cheaper still, but it changes shape with the cone
 * angle — and the cone angle is a runtime uniform here, so the curve would
 * drift against the baked cookie whenever the beam widened.
 */
export const GLSL_BEAM_PROFILE = /* glsl */`
float beamProfile(float rr){
  float core = exp(-pow(rr * ${BEAM_A.toFixed(4)}, ${BEAM_P.toFixed(4)}));
  float skirt = pow(max(0.0, 1.0 - rr), ${BEAM_S.toFixed(4)}) * ${BEAM_K.toFixed(4)};
  return (core + skirt) * ${BEAM_NORM.toFixed(8)};
}

float beamProfileFromCos(float cosA, float outerAngle){
  float ang = acos(clamp(cosA, -1.0, 1.0));
  float rr = ang / max(outerAngle, 1e-4);
  // Past 1.35 the fitted skirt has fallen below the dither floor, so the branch
  // saves the pow() calls rather than changing the result.
  return rr < 1.35 ? beamProfile(rr) : 0.0;
}
`;

/** Fullscreen-triangle style vertex shader (GLSL3) used by every post pass. */
export const POST_VERT = /* glsl */`
out vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Convenience: assemble a fragment shader with the chunks it asks for. */
export function buildFrag(body: string, chunks: string[] = []): string {
  return `precision highp float;\nprecision highp sampler2D;\nin vec2 vUv;\nout vec4 fragColor;\n${chunks.join('\n')}\n${body}`;
}
