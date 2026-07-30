import { chromium } from '@playwright/test';

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://localhost:5173', { waitUntil: 'load' });
// wait for title screen (boot complete) or timeout
try {
  await page.waitForFunction(() => window.__static && window.__static.state() === 'title', { timeout: 60000 });
  console.log('BOOT OK — state=title');
} catch {
  const status = await page.textContent('#load-status').catch(() => '?');
  console.log('BOOT TIMEOUT — load-status:', status);
}
console.log('errors:', errors.length ? errors.slice(0, 10) : 'none');
await page.screenshot({ path: 'shots/00-title.png' });

// start a run
await page.evaluate(() => window.__static.start());
await page.waitForTimeout(4000);
console.log('state after start:', await page.evaluate(() => window.__static.state()));
console.log('entity:', JSON.stringify(await page.evaluate(() => window.__static.entity())));
// turn flashlight on
await page.evaluate(() => window.__static.flashlight(true));
await page.waitForTimeout(1500);
await page.screenshot({ path: 'shots/01-ingame.png' });
console.log('errors after start:', errors.length ? errors.slice(0, 10) : 'none');
process.exit(0);
