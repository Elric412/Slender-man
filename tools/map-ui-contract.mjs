#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';

const artPaths = Array.from({ length: 6 }, (_, i) => `public/ui/pinewood-map/map.${i}.b64`);
const failures = [];

for (let i = 0; i < artPaths.length; i++) {
  try { await access(artPaths[i]); }
  catch { failures.push(`reference survey artwork chunk ${i + 1} missing: ${artPaths[i]}`); }
}

const [survey, css, ...chunks] = await Promise.all([
  readFile('src/ui/SurveyMap.ts', 'utf8'),
  readFile('public/ui/map-reference.css', 'utf8'),
  ...artPaths.map(path => readFile(path, 'utf8')),
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

try {
  const art = Buffer.from(chunks.map(v => v.trim()).join(''), 'base64');
  if (art.length < 10_000) failures.push(`reference artwork unexpectedly small (${art.length} bytes)`);
  if (art.subarray(0, 4).toString('ascii') !== 'RIFF') failures.push('reference artwork is not a RIFF container');
  if (art.subarray(8, 12).toString('ascii') !== 'WEBP') failures.push('reference artwork is not WEBP');
} catch (err) {
  failures.push(`reference artwork base64 could not be decoded: ${String(err)}`);
}

if (failures.length) {
  console.error('Map UI contract failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('Map UI contract passed.');
