#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const [main, night, shadow] = await Promise.all([
  readFile('src/main.ts', 'utf8'),
  readFile('src/render/NightLighting.ts', 'utf8'),
  readFile('src/render/ShadowQuality.ts', 'utf8'),
]);

const failures = [];
const expectText = (text, needle, label) => {
  if (!text.includes(needle)) failures.push(`${label}: expected ${JSON.stringify(needle)}`);
};
const rejectText = (text, needle, label) => {
  if (text.includes(needle)) failures.push(`${label}: legacy ownership still present: ${JSON.stringify(needle)}`);
};

// NightLighting is the only owner of the night key/fill/bounce budget.
expectText(main, "from './render/NightLighting'", 'NightLighting import');
expectText(main, 'new NightLighting()', 'NightLighting owner');
expectText(main, 'this.night.update(', 'NightLighting frame update');
expectText(main, 'this.night.followPlayer(', 'NightLighting moon follow');
expectText(main, 'this.night.setProbeActive(', 'NightLighting probe handoff');
expectText(main, 'this.scene.environmentIntensity = nightLevels.fill', 'NightLighting IBL ownership');
rejectText(main, 'new THREE.DirectionalLight(0x93a8cc', 'legacy moon construction');
rejectText(main, 'this.moon.intensity = 0.72 * dim', 'legacy moon grading');
rejectText(main, 'base * (0.78 + atmo.ambient * 0.34)', 'legacy hemisphere grading');

// ShadowQuality is the only owner of moon/beam shadow policy and moon cadence.
expectText(main, "from './render/ShadowQuality'", 'ShadowQuality import');
expectText(main, 'new ShadowQuality()', 'ShadowQuality owner');
expectText(main, 'SHADOW_BUDGETS', 'tier shadow budgets');
expectText(main, 'this.shadows.configureMoon(', 'moon shadow policy');
expectText(main, 'this.shadows.configureBeam(', 'beam shadow policy');
expectText(main, 'this.shadows.scheduleMoon(', 'moon shadow scheduling');
rejectText(main, 'private moonShadowAcc = 0', 'legacy moon shadow accumulator');
rejectText(main, 'private moonShadowAtX = Infinity', 'legacy moon shadow snap state');
rejectText(main, 'private updateMoonShadowSchedule(', 'legacy moon shadow scheduler');

// The dedicated modules must keep the structural guarantees main.ts now relies on.
expectText(night, 'const AMBIENT_FLOOR', 'night readability floor');
expectText(night, 'setProbeActive(active: boolean)', 'probe-aware fill split');
expectText(night, 'followPlayer(', 'texel-snapped moon follow');
expectText(shadow, 'export const SHADOW_BUDGETS', 'shadow tier budgets');
expectText(shadow, 'configureMoon(', 'derived moon bias/frustum');
expectText(shadow, 'configureBeam(', 'beam shadow configuration');
expectText(shadow, 'scheduleMoon(', 'per-light shadow scheduler');

if (failures.length) {
  console.error('Render wiring contract failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('Render wiring contract passed.');
