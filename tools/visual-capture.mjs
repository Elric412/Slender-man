import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

// Same seed, weather, pose, progression and render-frame count on both revisions.
// Separate browser per scene bounds SwiftShader memory without changing quality.
export const scenes = {
  trail: { x: -6, z: -4.4, yaw: 0, pitch: -0.08 },
  bark: { x: 2, z: -29, yaw: 1.3, pitch: 0 },
  wet: { x: 92, z: -40, yaw: -0.9, pitch: -0.38, wet: 0.8 },
  cabin: { x: 94.4, z: -123, yaw: 0, pitch: 0, wet: 0.35 },
  depth: { x: 8, z: -47, yaw: 0.35, pitch: 0.04, light: false },
  monster: { x: -6, z: -4.4, yaw: 0, pitch: 0.02, light: false, monster: { x: -5, z: -23 } },
};
const label = process.argv[2] ?? 'after';
const selection = process.argv[3];
const tier = process.env.VISUAL_TIER ?? 'low';
const dir = `shots/${label}`;
mkdirSync(dir, { recursive: true });
for (const [name, pose] of Object.entries(scenes)) {
  if (selection && selection !== name) continue;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio'] });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.addInitScript(() => {
      localStorage.setItem('static.settings.v2', JSON.stringify({ quality: 'low', advisoryAck: true }));
    });
    await page.goto(process.env.VISUAL_URL ?? 'http://localhost:5173/?silentaudio=1');
    await page.waitForFunction(() => window.__static?.state() === 'title', null, { timeout: 180000 });
    const result = await page.evaluate(o => window.__static.visualFrame(o), { ...pose, tier, frames: 8 });
    const { image, ...report } = result;
    writeFileSync(`${dir}/${name}.png`, Buffer.from(image.split(',')[1], 'base64'));
    writeFileSync(`${dir}/${name}.json`, JSON.stringify({ ...report, tier, pose, errors }, null, 2));
    console.log(name, JSON.stringify({ ...report, errors }));
    if (errors.length) process.exitCode = 1;
  } finally { await browser.close(); }
}
