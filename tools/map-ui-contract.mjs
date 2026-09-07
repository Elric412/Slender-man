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

// Interaction/readability contract. The authored sheet is still a live tool, not
// a screenshot: players must be able to inspect it on mouse, trackpad and touch
// without the exploration veil crushing the underlying geography to black.
expectText(survey, 'UNKNOWN_ALPHA', 'map fog readability cap');
const alpha = survey.match(/UNKNOWN_ALPHA\s*=\s*(\d+)/)?.[1];
if (!alpha) failures.push('map fog readability cap: numeric UNKNOWN_ALPHA missing');
else if (Number(alpha) > 170) failures.push(`map fog too opaque: UNKNOWN_ALPHA=${alpha} (>170)`);
expectText(survey, 'bindInteractions', 'map interaction binding');
expectText(survey, "addEventListener('wheel'", 'map wheel/trackpad zoom');
expectText(survey, "addEventListener('pointerdown'", 'map drag/pinch start');
expectText(survey, 'zoomAt(', 'cursor/pinch anchored zoom');
expectText(survey, 'panBy(', 'map pan');
expectText(survey, 'present(', 'map viewport presentation');
expectText(css, 'touch-action: none', 'touch map gesture ownership');

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
