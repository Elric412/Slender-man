#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [survey, main, flashlight, css] = await Promise.all([
  readFile('src/ui/SurveyMap.ts', 'utf8'),
  readFile('src/main.ts', 'utf8'),
  readFile('src/game/Flashlight.ts', 'utf8'),
  readFile('public/ui/map-reference.css', 'utf8'),
]);

const failures = [];
const expectText = (text, needle, label) => {
  if (!text.includes(needle)) failures.push(`${label}: expected ${JSON.stringify(needle)}`);
};
const rejectText = (text, needle, label) => {
  if (text.includes(needle)) failures.push(`${label}: legacy ownership still present: ${JSON.stringify(needle)}`);
};

// Live map: authored art must stay readable, and the map surface must actually
// accept inspection gestures instead of being a frozen, nearly-black sheet.
expectText(survey, 'UNKNOWN_ALPHA', 'map fog readability cap');
const alpha = survey.match(/UNKNOWN_ALPHA\s*=\s*(\d+)/)?.[1];
if (!alpha) failures.push('map fog readability cap: numeric UNKNOWN_ALPHA missing');
else if (Number(alpha) > 170) failures.push(`map fog too opaque: UNKNOWN_ALPHA=${alpha} (>170)`);
expectText(survey, 'bindInteractions', 'map interaction binding');
expectText(survey, "addEventListener('wheel'", 'map wheel zoom');
expectText(survey, "addEventListener('pointerdown'", 'map drag/pinch start');
expectText(survey, 'zoomAt(', 'map anchored zoom');
expectText(survey, 'panBy(', 'map pan');
expectText(survey, 'present(', 'map viewport presentation');
expectText(css, 'touch-action: none', 'touch map gesture ownership');
rejectText(main, 'inp.moveX = 0; inp.moveZ = 0;', 'map must not freeze player movement');

// Lighting: NightLighting owns moon/hemi levels. Main may keep aliases to those
// lights for existing pipeline/debug consumers, but it must not construct or
// independently grade them anymore.
expectText(main, "from './render/NightLighting'", 'NightLighting import');
expectText(main, 'new NightLighting()', 'NightLighting owner');
expectText(main, 'this.night.update(', 'NightLighting frame update');
expectText(main, 'this.night.followPlayer(', 'NightLighting moon follow');
expectText(main, 'this.night.setProbeActive(', 'NightLighting probe handoff');
expectText(main, 'this.scene.environmentIntensity = nightLevels.fill', 'NightLighting IBL fill ownership');
rejectText(main, 'new THREE.DirectionalLight(0x93a8cc', 'legacy moon construction');
rejectText(main, 'this.moon.intensity = 0.72 * dim', 'legacy moon intensity formula');
rejectText(main, 'base * (0.78 + atmo.ambient * 0.34)', 'legacy hemisphere formula');

// Shadows: one policy owns frustum, bias, map size and scheduling for both moon
// and flashlight. The old main.ts accumulator/snap scheduler must disappear.
expectText(main, "from './render/ShadowQuality'", 'ShadowQuality import');
expectText(main, 'new ShadowQuality()', 'ShadowQuality owner');
expectText(main, 'SHADOW_BUDGETS', 'tier shadow budgets');
expectText(main, 'this.shadows.configureMoon(', 'moon shadow configuration');
expectText(main, 'this.shadows.configureBeam(', 'flashlight shadow configuration');
expectText(main, 'this.shadows.scheduleMoon(', 'moon shadow scheduling');
expectText(flashlight, 'get shadowRange()', 'flashlight publishes real shadow range');
rejectText(main, 'private moonShadowAcc = 0', 'legacy moon shadow accumulator');
rejectText(main, 'private moonShadowAtX = Infinity', 'legacy moon shadow snap state');
rejectText(main, 'private updateMoonShadowSchedule(', 'legacy moon shadow scheduler');

if (failures.length) {
  console.error('Live map / render wiring contract failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('Live map / render wiring contract passed.');
