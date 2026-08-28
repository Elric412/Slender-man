import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

/* One-shot QA capture: node qa-shot.mjs <desktop|mobile> <title|ingame>
 * One screenshot per browser process — SwiftShader + sandbox RAM makes
 * multi-shot sessions crash-prone. */

const [profile, mode] = process.argv.slice(2);
/* SwiftShader + sandbox RAM: screenshot capture is the fragile step, not the
 * game. Title captures work at 1280×720; in-game captures (flashlight shadows
 * add VRAM pressure) need 960×540 here. Full-res 1920×1080 assertions live in
 * tests/static.spec.ts for real-GPU environments. */
const vp =
  profile === 'mobile'
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
    : mode === 'ingame'
      ? { viewport: { width: 960, height: 540 } }
      : { viewport: { width: 1280, height: 720 } };

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio'],
});
const page = await browser.newPage(vp);
/* In-game captures force low quality (no TAA/motion blur/AO/bloom, 0.5×
 * render scale): the game logic under test is identical, but SwiftShader's
 * memory footprint drops enough for screenshots to survive. Title captures
 * keep the probed quality so the menu shows the real pipeline. */
if (mode === 'ingame') {
  await page.addInitScript(() => {
    try {
      const KEY = 'static.settings.v1';
      const s = JSON.parse(localStorage.getItem(KEY) || '{}');
      s.quality = 'low';
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch { /* ignore */ }
  });
}
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://localhost:4173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__static && window.__static.state() === 'title', { timeout: 90000 });
console.log(`[${profile}] BOOT OK`);

/* SwiftShader renders seconds per frame with the full post pipeline — the
 * compositor needs a generous timeout to catch a complete frame. */
const SHOT_OPTS = { timeout: 180_000 };

/* In-game screenshots crash the SwiftShader target through the compositor
 * path. Capture the WebGL canvas from inside the page instead: a rAF callback
 * registered now runs AFTER the game's render in the same frame, before the
 * drawing buffer is cleared, so toDataURL returns real pixels even with
 * preserveDrawingBuffer:false. Returns null if the buffer is blank. */
async function canvasShot(page, path) {
  const dataUrl = await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const c = document.querySelector('canvas');
            try {
              resolve(c.toDataURL('image/png'));
            } catch {
              resolve(null);
            }
          });
        });
      }),
  );
  if (!dataUrl || dataUrl.length < 30000) return false; // blank/broken buffer
  writeFileSync(path, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return true;
}

if (mode === 'title') {
  await page.screenshot({ path: `shots/qa-${profile}-title.png`, ...SHOT_OPTS });
} else {
  await page.evaluate(() => window.__static.start());
  await page.waitForTimeout(2500);
  await page.evaluate(() => window.__static.flashlight(true));
  await page.waitForTimeout(2000);
  console.log(`[${profile}] state:`, await page.evaluate(() => window.__static.state()));
  console.log(`[${profile}] stats:`, JSON.stringify(await page.evaluate(() => window.__static.stats())));
  console.log(`[${profile}] entity:`, JSON.stringify(await page.evaluate(() => window.__static.entity())));
  const path = `shots/qa-${profile}-ingame.png`;
  if (!(await canvasShot(page, path))) {
    console.log(`[${profile}] canvas capture blank — falling back to compositor screenshot`);
    await page.screenshot({ path, ...SHOT_OPTS });
  }
}
console.log(`[${profile}] errors:`, errors.length ? errors.slice(0, 8) : 'none');
process.exit(0);
