/**
 * tools/bench.mjs — architecture/performance baseline harness.
 *
 * Boots the production build under SwiftShader, records boot stage timings,
 * frame-time distribution, draw calls, triangle counts and memory, then prints
 * one JSON blob. Used to compare before/after an architecture change.
 *
 * SwiftShader is 20-50x slower than a real GPU, so the ABSOLUTE numbers are
 * meaningless as a hardware target. What IS meaningful:
 *   - draw calls / triangles / pass counts (hardware-independent)
 *   - relative frame-time change between two runs on the same box
 *   - allocation growth and texture/geometry counts over a session
 *
 * Usage: node tools/bench.mjs [--quality=low|medium|high|ultra] [--seconds=12]
 */
import { chromium } from '@playwright/test';

const arg = (k, d) => {
  const m = process.argv.find(a => a.startsWith(`--${k}=`));
  return m ? m.split('=')[1] : d;
};
const QUALITY = arg('quality', 'low');
const SECONDS = Number(arg('seconds', '12'));
const URL = arg('url', 'http://localhost:4173');

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--mute-audio', '--js-flags=--max-old-space-size=380',
  ],
});
const page = await browser.newPage({ viewport: { width: 400, height: 240 } });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.addInitScript((q) => {
  try {
    const s = JSON.parse(localStorage.getItem('static.settings.v2') || '{}');
    s.quality = q;
    s.advisoryAck = true;
    localStorage.setItem('static.settings.v2', JSON.stringify(s));
  } catch { /* ignore */ }
}, QUALITY);

const t0 = Date.now();
await page.goto(URL + '/?silentaudio=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__static && window.__static.state() === 'title', undefined, { timeout: 180000 });
const bootMs = Date.now() - t0;

const boot = await page.evaluate(() => window.__static.bootTimes?.() ?? null);

await page.evaluate(() => window.__static.renderThrottle?.(Number(new URLSearchParams(location.search).get('rt') || 1)));
await page.evaluate(() => window.__static.start());
await page.waitForFunction(() => window.__static.state() === 'playing', undefined, { timeout: 120000 });
const startMs = Date.now() - t0;

// warm: discard the first seconds (streaming + shader hitches)
await page.waitForTimeout(3000);
await page.evaluate(() => window.__static.resetStats?.());
await page.waitForTimeout(SECONDS * 1000);

const stats = await page.evaluate(() => ({
  frame: window.__static.stats(),
  gpu: window.__static.gpuStats?.() ?? null,
  prof: window.__static.prof?.() ?? null,
  scatter: window.__static.scatter?.() ?? null,
  mem: performance.memory ? {
    used: Math.round(performance.memory.usedJSHeapSize / 1048576),
    total: Math.round(performance.memory.totalJSHeapSize / 1048576),
  } : null,
}));

console.log(JSON.stringify({
  quality: QUALITY, bootMs, timeToPlayMs: startMs, boot, ...stats,
  errors: errors.slice(0, 8),
}, null, 2));
await browser.close();
process.exit(0);
