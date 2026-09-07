#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

function mustReplace(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`patch anchor missing: ${label}`);
  return text.replace(from, to);
}

let main = await readFile('src/main.ts', 'utf8');

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
  `  private sky!: Sky;\n  /** Single owner for night key/fill/bounce energy. */\n  private night!: NightLighting;\n  /** Single owner for moon/beam shadow geometry, bias and refresh cadence. */\n  private shadows = new ShadowQuality();\n  /** Aliases retained for existing pipeline/debug consumers; NightLighting owns them. */\n  private moon!: THREE.DirectionalLight;\n  private hemi!: THREE.HemisphereLight;`,
  'night and shadow owner fields',
);

const oldBuildLighting = `    // moonlight — cool, low, soft-shadowed directional\n    this.moon = new THREE.DirectionalLight(0x93a8cc, 0.55);\n    this.moon.castShadow = true;\n    this.moon.shadow.mapSize.set(this.spec.shadowMapSize, this.spec.shadowMapSize);\n    const sc = this.moon.shadow.camera;\n    sc.near = 20; sc.far = 260;\n    sc.left = -60; sc.right = 60; sc.top = 60; sc.bottom = -60;\n    this.moon.shadow.bias = -0.0015;\n    this.moon.shadow.normalBias = 0.05;\n    this.moon.target = this.moonTarget;\n    this.scene.add(this.moon, this.moonTarget);\n\n    // Faint sky/ground bounce. With an env probe active this drops right down —\n    // the IBL already supplies directional ambient, and doubling up flattens\n    // everything out.\n    this.hemi = new THREE.HemisphereLight(0x141c2a, 0x05060a, 0.32);\n    this.scene.add(this.hemi);\n`;
const newBuildLighting = `    // One photometric owner. Cloud/canopy/rain are collapsed into one budget\n    // before it is split into moon key, sky fill and ground bounce.\n    this.night = new NightLighting();\n    this.night.addTo(this.scene);\n    this.night.setMoonDirection(this.sky.moonDir);\n    this.moon = this.night.moon;\n    this.hemi = this.night.hemi;\n    this.applyShadowQuality();\n`;
main = mustReplace(main, oldBuildLighting, newBuildLighting, 'buildScene lighting block');

const captureStart = main.indexOf('  private captureEnvironment(): void {');
const captureEnd = main.indexOf('  /** Keep point-sprite sizing physically correct after resize / FOV change. */', captureStart);
if (captureStart < 0 || captureEnd < 0) throw new Error('patch anchor missing: captureEnvironment');
const captureReplacement = `  private captureEnvironment(): void {\n    if (!this.spec.envProbe) {\n      this.night.setProbeActive(false);\n      this.scene.environmentIntensity = 0;\n      this.night.update(0, { moonDim: 1, transmission: 1, openness: 1, wetness: 0, warmth: 0 });\n      return;\n    }\n    try {\n      this.probe = new EnvironmentProbe(this.renderer, this.spec.tier === 'ultra' ? 256 : 128);\n      this.sky.update(0);\n      this.scene.environment = this.probe.capture(this.sky.mesh);\n      this.night.setProbeActive(true);\n      const nightLevels = this.night.update(0, {\n        moonDim: 1, transmission: 1, openness: 1, wetness: 0, warmth: 0,\n      });\n      this.scene.environmentIntensity = nightLevels.fill;\n      this.mats.setEnvIntensity(1);\n    } catch (err) {\n      console.warn('[STATIC] env probe unavailable, falling back to hemisphere fill', err);\n      this.probe = null;\n      this.night.setProbeActive(false);\n      this.scene.environmentIntensity = 0;\n      this.night.update(0, { moonDim: 1, transmission: 1, openness: 1, wetness: 0, warmth: 0 });\n    }\n  }\n\n  /** Resolve a runtime shadow budget without trading away near-field texel density. */\n  private resolvedShadowBudget() {\n    const base = SHADOW_BUDGETS[this.spec.tier] ?? SHADOW_BUDGETS.high;\n    const requested = this.knobs?.shadowMapSize ?? base.moonSize;\n    const moonSize = Math.max(512, Math.min(base.moonSize, requested));\n    const ratio = moonSize / base.moonSize;\n    return {\n      moonSize,\n      beamSize: Math.max(512, Math.min(base.beamSize, moonSize)),\n      moonExtent: Math.max(28, base.moonExtent * ratio),\n    };\n  }\n\n  private applyShadowQuality(): void {\n    if (!this.moon) return;\n    const budget = this.resolvedShadowBudget();\n    this.shadows.configureMoon(this.moon, budget);\n    if (this.flashlight) {\n      this.shadows.configureBeam(\n        this.flashlight.light, budget.beamSize, this.flashlight.light.distance,\n      );\n    }\n  }\n\n`;
main = main.slice(0, captureStart) + captureReplacement + main.slice(captureEnd);

main = mustReplace(
  main,
  `    this.flashlight = new Flashlight(\n      this.scene, this.player, Math.min(this.spec.shadowMapSize, 1024), this.hf,\n      this.spec.dustCount);\n    this.wirePlayer();`,
  `    this.flashlight = new Flashlight(\n      this.scene, this.player, Math.min(this.spec.shadowMapSize, 1024), this.hf,\n      this.spec.dustCount);\n    this.applyShadowQuality();\n    this.wirePlayer();`,
  'flashlight shadow policy boot wiring',
);

main = mustReplace(
  main,
  `      this.spec = spec;\n      this.pipeline.setQuality(spec);\n      this.moon.shadow.mapSize.set(spec.shadowMapSize, spec.shadowMapSize);\n      if (this.moon.shadow.map) { this.moon.shadow.map.dispose(); this.moon.shadow.map = null as unknown as THREE.WebGLRenderTarget; }\n      this.flashlight.setShadowSize(Math.min(spec.shadowMapSize, 1024));\n      this.flashlight.setDustBudget(spec.dustCount);`,
  `      this.spec = spec;\n      this.pipeline.setQuality(spec);\n      this.applyShadowQuality();\n      this.flashlight.setDustBudget(spec.dustCount);`,
  'settings shadow wiring',
);

main = mustReplace(
  main,
  `    this.flashlight.warp();\n    this.entity.respawnFar(this.player.pos);`,
  `    this.flashlight.warp();\n    this.shadows.invalidate();\n    this.entity.respawnFar(this.player.pos);`,
  'run shadow invalidation',
);

const ambientStart = main.indexOf('    // Zone ambient scales the IBL:');
const ambientEnd = main.indexOf('\n  // per-stage update profiling (EMA ms)', ambientStart);
if (ambientStart < 0 || ambientEnd < 0) throw new Error('patch anchor missing: legacy ambient grading');
main = main.slice(0, ambientStart)
  + `    // NightLighting owns IBL fill and hemisphere bounce. Weather look owns\n    // fog/material grading only, so no second ambient curve can multiply the key.\n  }\n`
  + main.slice(ambientEnd);

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

const moonBlockStart = main.indexOf('    // ---- moon follows player (stabilized shadow window w/ texel snapping) ----');
const moonBlockEndMarker = "    this.profMark('env', p0);";
const moonBlockEnd = main.indexOf(moonBlockEndMarker, moonBlockStart);
if (moonBlockStart < 0 || moonBlockEnd < 0) throw new Error('patch anchor missing: frame moon block');
const nightFrame = `    // ---- unified night hierarchy + moon shadow window ----\n    const dim = this.sky.moonDimAt(time);\n    this.night.setMoonDirection(this.sky.moonDir);\n    const nightLevels = this.night.update(dt, {\n      moonDim: dim,\n      transmission: this.zoneAtmo.moon,\n      openness: this.zoneAtmo.ambient,\n      wetness: this.weather.wetness,\n      warmth: this.zoneAtmo.warmth,\n    });\n    if (this.scene.environment) this.scene.environmentIntensity = nightLevels.fill;\n\n    const shadowAt = this.night.followPlayer(\n      this.player.pos.x, this.player.pos.y, this.player.pos.z, this.shadows.extent,\n    );\n    const shadowHz = this.knobs ? this.knobs.shadowRefreshHz : 30;\n    const effectiveShadowHz = shadowHz * Math.max(0.35, this.percept.field.shadow);\n    this.shadows.scheduleMoon(\n      this.moon, dt, shadowAt.sx, shadowAt.sz, effectiveShadowHz, snap.distToPlayer < 46,\n    );\n    this.profMark('env', p0);`;
main = main.slice(0, moonBlockStart) + nightFrame + main.slice(moonBlockEnd + moonBlockEndMarker.length);

main = mustReplace(
  main,
  `      0.94\n      + this.flashlight.beamStrength * 0.36\n      - this.weather.wetness * 0.08\n      + this.vfWeight * 0.10);`,
  `      0.94\n      + this.flashlight.beamStrength * 0.36\n      - this.weather.wetness * 0.08\n      + this.vfWeight * 0.10\n      + (1 - nightLevels.budget) * 0.14);`,
  'night budget exposure handoff',
);

await writeFile('src/main.ts', main);
console.log('Applied NightLighting / ShadowQuality wiring to src/main.ts.');
