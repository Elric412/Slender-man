import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio', '--js-flags=--max-old-space-size=256'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
await page.addInitScript(() => {
  try {
    const KEY = 'static.settings.v1';
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    s.quality = 'low';
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* ignore */ }
});
await page.goto('http://localhost:4173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__static && window.__static.state() === 'title', { timeout: 90000 });
console.log('BOOT OK');
await page.evaluate(() => window.__static.start());
// capture on the very first rendered gameplay frame — minimal streaming so far
await page.waitForFunction(() => window.__static.state() === 'playing', { timeout: 15000 });
// let the pipeline actually render several frames (SwiftShader is slow) and
// stream in the spawn chunk before capturing
await page.waitForTimeout(12000);
console.log('stats:', JSON.stringify(await page.evaluate(() => window.__static.stats())));
const dataUrl = await page.evaluate(() => new Promise((res) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    try { res(document.querySelector('canvas').toDataURL('image/png')); } catch { res(null); }
  }));
}));
if (dataUrl && dataUrl.length > 30000) {
  writeFileSync('shots/qa-desktop-ingame.png', Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('INGAME SHOT OK, bytes:', dataUrl.length);
} else {
  console.log('capture blank');
}
console.log('errors:', errors.length ? errors.slice(0, 5) : 'none');
process.exit(0);
