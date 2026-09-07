#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`patch anchor missing: ${label}`);
  return text.replace(from, to);
}

let main = await readFile('src/main.ts', 'utf8');
let flashlight = await readFile('src/game/Flashlight.ts', 'utf8');

main = mustReplace(
  main,
  "import { Sky } from './render/Sky';",
  "import { Sky } from './render/Sky';\nimport { NightLighting } from './render/NightLighting';\nimport { ShadowQuality, SHADOW_BUDGETS } from './render/ShadowQuality';",
  'render subsystem imports',
);

main = mustReplace(
  main,
  `  /** Accumulated time owed to the moon shadow map since its last re-render. */\n  private moonShadowAcc = 0;\n  /** Texel-snapped shadow-window centre at the last actual re-render. */\n  private moonShadowAtX = Infinity;\n  private moonShadowAtZ = Infinity;\n  /** Whether the moon shadow map has ever been rendered (first frame must not skip). */\n  private moonShadowPrimed = false;\n`,
  '',
  'legacy moon shadow state',
);

main = mustReplace(
  main,
  `  private sky!: Sky;\n  private moon!: THREE.DirectionalLight;\n  private moonTarget = new THREE.Object3D();\n  private hemi!: THREE.HemisphereLight;`,
  `  private sky!: Sky;\n  /** One owner for the night key/fill/bounce budget. */\n  private night!: NightLighting;\n  /** One owner for moon + beam shadow geometry, bias and cadence. */\n  private shadows = new ShadowQuality();\n  /** Aliases retained for the pipeline/debug consumers; NightLighting owns them. */\n  private moon!: THREE.DirectionalLight;\n  private hemi!: THREE.HemisphereLight;`,
  'night/shadow owners',
);

const buildStart = main.indexOf('    // moonlight — cool, low, soft-shadowed directional');
const buildEnd = main.indexOf('    this.scene.add(this.map.group);', buildStart);
if (buildStart < 0 || buildEnd < 0) throw new Error('patch anchor missing: buildScene lighting block');
main = main.slice(0, buildStart) + `    // NightLighting owns the cool directional key and the sky/ground bounce as\n    // one budget, so cloud/canopy/rain attenuation cannot multiply independently.\n    this.night = new NightLighting();\n    this.night.addTo(this.scene);\n    this.night.setMoonDirection(this.sky.moonDir);\n    this.moon = this.night.moon;\n    this.hemi = this.night.hemi;\n    this.applyShadowQuality();\n\n` + main.slice(buildEnd);

const captureStart = main.indexOf('  private captureEnvironment(): void {');
const captureEnd = main.indexOf('  /** Keep point-sprite sizing physically correct after resize / FOV change. */', captureStart);
if (captureStart < 0 || captureEnd < 0) throw new Error('patch anchor missing: captureEnvironment');
const captureReplacement = `  private captureEnvironment(): void {\n    if (!this.spec.envProbe) {\n      this.night.setProbeActive(false);\n      this.scene.environmentIntensity = 0;\n      // Prime the fallback hemisphere path immediately so title/warm-up frames\n      // use the same readable hierarchy as gameplay.\n      this.night.update(0, { moonDim: 1, transmission: 1, openness: 1, wetness: 0, warmth: 0 });\n      return;\n    }\n    try {\n      this.probe = new EnvironmentProbe(this.renderer, this.spec.tier === 'ultra' ? 256 : 128);\n      this.sky.update(0);\n      this.scene.environment = this.probe.capture(this.sky.mesh);\n      this.night.setProbeActive(true);\n      const levels = this.night.update(0, {\n        moonDim: 1, transmission: 1, openness: 1, wetness: 0, warmth: 0,\n      });\n      this.scene.environmentIntensity = levels.fill;\n      this.mats.setEnvIntensity(1);\n    } catch (err) {\n      console.warn('[STATIC] env probe unavailable, falling back to hemisphere fill', err);\n      this.probe = null;\n      this.night.setProbeActive(false);\n      this.scene.environmentIntensity = 0;\n      this.night.update(0, { moonDim: 1, transmission: 1, openness: 1, wetness: 0, warmth: 0 });\n    }\n  }\n\n  /** Resolve a runtime shadow budget without throwing away texel density. When\n   * the governor lowers map size, the moon window shrinks with it instead of\n   * keeping a huge low-resolution frustum. Fog already hides the sacrificed edge. */\n  private resolvedShadowBudget() {\n    const base = SHADOW_BUDGETS[this.spec.tier] ?? SHADOW_BUDGETS.high;\n    const requested = this.knobs?.shadowMapSize ?? base.moonSize;\n    const moonSize = Math.max(512, Math.min(base.moonSize, requested));\n    const ratio = moonSize / base.moonSize;\n    return {\n      moonSize,\n      beamSize: Math.max(512, Math.min(base.beamSize, moonSize)),\n      moonExtent: Math.max(28, Math.min(base.moonExtent, base.moonExtent * ratio)),\n    };\n  }\n\n  private applyShadowQuality(): void {\n    if (!this.moon) return;\n    const budget = this.resolvedShadowBudget();\n    this.shadows.configureMoon(this.moon, budget);\n    if (this.flashlight) {\n      // SpotLight.distance is the flashlight's real RANGE, so shadow far never\n      // drifts from the photometric cone. No duplicated magic 62 m constant.\n      this.shadows.configureBeam(\n        this.flashlight.light, budget.beamSize, this.flashlight.shadowRange,\n      );\n    }\n  }\n\n`;
main = main.slice(0, captureStart) + captureReplacement + main.slice(captureEnd);

main = mustReplace(
  main,
  `    this.flashlight = new Flashlight(\n      this.scene, this.player, Math.min(this.spec.shadowMapSize, 1024), this.hf,\n      this.spec.dustCount);\n    this.wirePlayer();`,
  `    this.flashlight = new Flashlight(\n      this.scene, this.player, Math.min(this.spec.shadowMapSize, 1024), this.hf,\n      this.spec.dustCount);\n    this.applyShadowQuality();\n    this.wirePlayer();`,
  'flashlight shadow policy boot wiring',
);

main = mustReplace(
  main,
  `      this.pipeline.setQuality(spec);\n      this.moon.shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);\n      if (this.moon.shadow.map) { this.moon.shadow.map.dispose(); this.moon.shadow.map = null as unknown as THREE.WebGLRenderTarget; }\n      this.flashlight.setShadowSize(Math.min(spec.shadowMapSize, 1024));\n      this.flashlight.setDustBudget(spec.dustCount);`,
  `      this.pipeline.setQuality(spec);\n      this.applyShadowQuality();\n      this.flashlight.setDustBudget(spec.dustCount);`,
  'settings shadow wiring',
);

main = mustReplace(
  main,
  `    this.flashlight.warp();\n    this.entity.respawnFar(this.player.pos);`,
  `    this.flashlight.warp();\n    this.shadows.invalidate();\n    this.entity.respawnFar(this.player.pos);`,
  'run shadow invalidation',
);

main = mustReplace(
  main,
  `      inp.moveX = 0; inp.moveZ = 0;\n      inp.lookDX = 0; inp.lookDY = 0;\n      inp.sprint = false;\n      inp.vaultQueued = false; inp.interactQueued = false;`,
  `      // The forest stays live and walking remains available while reading.\n      // Only camera look and blind world actions are swallowed; WASD / the touch\n      // stick can still move the live player marker under the paper.\n      inp.lookDX = 0; inp.lookDY = 0;\n      inp.sprint = false;\n      inp.vaultQueued = false; inp.interactQueued = false;`,
  'map movement freeze',
);

main = mustReplace(
  main,
  `    // Redrawing a 768² canvas is pointless when nobody is looking at it, and the\n    // sheet only changes as the player moves, so it is capped at 10 Hz.\n    if (!this.mapOpen) return;\n    this.mapDrawAcc += dt;\n    if (this.mapDrawAcc >= 0.1) { this.drawSurvey(); this.mapDrawAcc = 0; }`,
  `    // The live marker tracks walking at 20 Hz while the sheet is open. Gesture\n    // pan/zoom redraws immediately inside SurveyMap, so this cadence only covers\n    // changing game state and stays cheap on mobile.\n    if (!this.mapOpen) return;\n    this.mapDrawAcc += dt;\n    if (this.mapDrawAcc >= 0.05) { this.drawSurvey(); this.mapDrawAcc = 0; }`,
  'map live redraw cadence',
);

const moonBlockStart = main.indexOf('    // ---- moon follows player (stabilized shadow window w/ texel snapping) ----');
const moonBlockEndMarker = "    this.profMark('env', p0);";
const moonBlockEnd = main.indexOf(moonBlockEndMarker, moonBlockStart);
if (moonBlockStart < 0 || moonBlockEnd < 0) throw new Error('patch anchor missing: frame moon block');
const nightFrame = `    // ---- night hierarchy + moon shadow window ----\n    const dim = this.sky.moonDimAt(time);\n    this.night.setMoonDirection(this.sky.moonDir);\n    const nightLevels = this.night.update(dt, {\n      moonDim: dim,\n      transmission: this.zoneAtmo.moon,\n      openness: this.zoneAtmo.ambient,\n      wetness: this.weather.wetness,\n      warmth: this.zoneAtmo.warmth,\n    });\n    if (this.scene.environment) this.scene.environmentIntensity = nightLevels.fill;\n\n    const shadowAt = this.night.followPlayer(\n      this.player.pos.x, this.player.pos.y, this.player.pos.z, this.shadows.extent,\n    );\n    const shadowHz = this.knobs ? this.knobs.shadowRefreshHz : 30;\n    const effectiveShadowHz = shadowHz * Math.max(0.35, this.percept.field.shadow);\n    this.shadows.scheduleMoon(\n      this.moon, dt, shadowAt.sx, shadowAt.sz, effectiveShadowHz, snap.distToPlayer < 46,\n    );\n    this.profMark('env', p0);`;
main = main.slice(0, moonBlockStart) + nightFrame + main.slice(moonBlockEnd + moonBlockEndMarker.length);

const ambientStart = main.indexOf('    // Zone ambient scales the IBL:');
const profilingMarker = '\n  // per-stage update profiling (EMA ms)';
const ambientEnd = main.indexOf(profilingMarker, ambientStart);
if (ambientStart < 0 || ambientEnd < 0) throw new Error('patch anchor missing: legacy ambient grading');
main = main.slice(0, ambientStart) + `    // NightLighting owns IBL fill and hemisphere bounce. applyWeatherLook owns\n    // fog/material weather only, so no second ambient curve can multiply the key.\n  }\n` + main.slice(ambientEnd);

const oldSchedulerDecl = main.indexOf('  private updateMoonShadowSchedule(');
if (oldSchedulerDecl < 0) throw new Error('patch anchor missing: legacy shadow scheduler declaration');
const oldSchedulerStart = main.lastIndexOf('  /**', oldSchedulerDecl);
const perceptComment = main.indexOf('  /**\n   * Refresh the perceptibility field', oldSchedulerDecl);
if (oldSchedulerStart < 0 || perceptComment < 0) throw new Error('patch anchor missing: legacy shadow scheduler bounds');
main = main.slice(0, oldSchedulerStart) + main.slice(perceptComment);

const knobStart = main.indexOf('    this.flashlight.setShadowSize(Math.min(k.shadowMapSize, 1024));');
const knobEnd = main.indexOf('    this.map.scatter.setLodBias(k.lodBias);', knobStart);
if (knobStart < 0 || knobEnd < 0) throw new Error('patch anchor missing: governor shadow block');
main = main.slice(0, knobStart)
  + `    this.applyShadowQuality();\n    this.flashlight.setDustBudget(Math.round(k.dustCount * this.percept.field.particles));\n`
  + main.slice(knobEnd);

main = mustReplace(
  main,
  `      warp: (x: number, z: number) => {\n        this.player.pos.set(x, this.hf.heightAt(x, z), z);\n        this.flashlight?.warp();\n        this.pipeline.invalidateHistory();\n      },`,
  `      warp: (x: number, z: number) => {\n        this.player.pos.set(x, this.hf.heightAt(x, z), z);\n        this.flashlight?.warp();\n        this.shadows.invalidate();\n        this.pipeline.invalidateHistory();\n      },`,
  'debug warp shadow invalidation',
);

main = mustReplace(
  main,
  `      0.94\n      + this.flashlight.beamStrength * 0.36\n      - this.weather.wetness * 0.08\n      + this.vfWeight * 0.10);`,
  `      0.94\n      + this.flashlight.beamStrength * 0.36\n      - this.weather.wetness * 0.08\n      + this.vfWeight * 0.10\n      + (1 - nightLevels.budget) * 0.14);`,
  'night budget exposure handoff',
);

flashlight = mustReplace(
  flashlight,
  `  /** Cone half-angle in radians (the volumetric pass wants this). */\n  get outerAngle(): number { return OUTER_ANGLE; }`,
  `  /** Cone half-angle in radians (the volumetric pass wants this). */\n  get outerAngle(): number { return OUTER_ANGLE; }\n\n  /** Real photometric/shadow range. ShadowQuality consumes this instead of\n   * duplicating RANGE in another subsystem. */\n  get shadowRange(): number { return RANGE; }`,
  'flashlight shadow range getter',
);

await Promise.all([
  writeFile('src/main.ts', main),
  writeFile('src/game/Flashlight.ts', flashlight),
]);

await mkdir('public/_migration', { recursive: true });
await Promise.all([
  writeFile('public/_migration/main.ts.txt', main),
  writeFile('public/_migration/Flashlight.ts.txt', flashlight),
]);
console.log('Applied live-map / NightLighting / ShadowQuality wiring migration.');
