#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';

const required = Array.from({ length: 6 }, (_, i) => [
  `public/ui/pinewood-map/map.${i}.b64`,
  `reference survey artwork chunk ${i + 1}`,
]);

const failures = [];
for (const [path, label] of required) {
  try { await access(path); }
  catch { failures.push(`${label} missing: ${path}`); }
}

const [survey, css] = await Promise.all([
  readFile('src/ui/SurveyMap.ts', 'utf8'),
  readFile('public/ui/map-reference.css', 'utf8'),
]);

const expectText = (text, needle, label) => {
  if (!text.includes(needle)) failures.push(`${label}: expected ${JSON.stringify(needle)}`);
};

expectText(survey, 'pinewood-map/map.', 'SurveyMap reference art source');
expectText(survey, 'REFERENCE_W = 1024', 'SurveyMap reference width');
expectText(survey, 'REFERENCE_H = 683', 'SurveyMap reference height');
expectText(survey, 'loadReferenceArt', 'SurveyMap reference loader');
expectText(survey, 'drawReferenceArt', 'SurveyMap live reference rendering');
expectText(survey, 'drawExplorationVeil', 'SurveyMap exploration veil');
expectText(survey, 'enhanceMapChrome', 'responsive map chrome');
expectText(survey, "foot.id = 'map-close'", 'accessible close control');
expectText(survey, "new KeyboardEvent('keydown'", 'close action uses normal map input path');
expectText(css, 'aspect-ratio: 1024 / 683', 'reference map responsive aspect ratio');
expectText(css, '.map-close', 'map close touch/focus styling');

if (failures.length) {
  console.error('Map UI contract failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('Map UI contract passed.');
