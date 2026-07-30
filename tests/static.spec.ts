import { test, expect, Page } from '@playwright/test';

/**
 * STATIC — end-to-end visual & performance harness.
 * Drives the game through window.__static (debug API) with SwiftShader WebGL2.
 * Kept deliberately light per-page: software GL in constrained sandboxes
 * is RAM-hungry, so each test takes at most a couple of screenshots.
 */

interface StaticApi {
  state(): string;
  tapes(): number;
  stats(): { avg: number; p95: number; worst: number; fps: number };
  warp(x: number, z: number): void;
  start(): void;
  forceFear(v: number): void;
  forceDetection(v: number): void;
  entity(): { state: string; distToPlayer: number; detection: number };
  flashlight(on: boolean): void;
  collectAll(): void;
  positions(): { spawn: { x: number; z: number }; exit: { x: number; z: number }; zones: { id: string; x: number; z: number }[] };
}

declare global {
  interface Window { __static: StaticApi; }
}

const errors: string[] = [];

function watch(page: Page) {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
}

async function bootToTitle(page: Page) {
  await page.goto('/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__static && window.__static.state() === 'title', undefined, { timeout: 90_000 });
}

async function startRun(page: Page) {
  await page.evaluate(() => window.__static.start());
  await page.waitForFunction(() => window.__static.state() === 'playing', undefined, { timeout: 15_000 });
}

/** Canvas is actually rendering: at least N distinct lit pixels sampled via readback. */
async function canvasNotBlank(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement;
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGL2RenderingContext | null;
    if (!gl) return -1;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const px = new Uint8Array(4);
    const seen = new Set<number>();
    let lit = 0;
    for (let i = 0; i < 64; i++) {
      const x = Math.floor((i % 8 + 0.5) * w / 8), y = Math.floor((Math.floor(i / 8) + 0.5) * h / 8);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const v = (px[0] << 16) | (px[1] << 8) | px[2];
      seen.add(v);
      if (px[0] + px[1] + px[2] > 12) lit++;
    }
    return seen.size > 2 && lit > 8 ? lit : 0;
  });
}

test.beforeEach(async ({ page }) => watch(page));

test('boot reaches title with zero errors and renders the menu', async ({ page }) => {
  await bootToTitle(page);
  expect(errors, errors.join('\n')).toHaveLength(0);
  await expect(page.locator('canvas')).toBeVisible();
  expect(await canvasNotBlank(page)).toBeGreaterThan(0);
  await page.screenshot({ path: 'shots/e2e-title.png' });
});

test('run starts: playing state, HUD visible, world renders', async ({ page }) => {
  await bootToTitle(page);
  await startRun(page);
  await page.evaluate(() => window.__static.flashlight(true));
  await page.waitForTimeout(2500);
  expect(errors, errors.join('\n')).toHaveLength(0);
  await expect(page.locator('#hud')).toBeVisible();
  expect(await canvasNotBlank(page)).toBeGreaterThan(0);
  await page.screenshot({ path: 'shots/e2e-ingame.png' });
});

test('key locations render (station / quarry / tower / foliage)', async ({ page }) => {
  await bootToTitle(page);
  await startRun(page);
  await page.evaluate(() => window.__static.flashlight(true));
  const zones = await page.evaluate(() => window.__static.positions().zones);
  expect(zones.length).toBeGreaterThanOrEqual(4);
  // visit the first three named zones, one screenshot each
  for (const z of zones.slice(0, 3)) {
    await page.evaluate(([x, zz]) => window.__static.warp(x, zz), [z.x, z.z]);
    await page.waitForTimeout(1200);
    expect(errors, errors.join('\n')).toHaveLength(0);
    expect(await canvasNotBlank(page)).toBeGreaterThan(0);
    await page.screenshot({ path: `shots/e2e-zone-${z.id}.png` });
  }
});

test('entity sighting + high static stress frame', async ({ page }) => {
  await bootToTitle(page);
  await startRun(page);
  await page.evaluate(() => {
    window.__static.flashlight(true);
    window.__static.forceFear(0.85);
    window.__static.forceDetection(0.7);
  });
  await page.waitForTimeout(2000);
  const ent = await page.evaluate(() => window.__static.entity());
  expect(['investigating', 'stalking', 'confronting']).toContain(ent.state);
  expect(errors, errors.join('\n')).toHaveLength(0);
  await page.screenshot({ path: 'shots/e2e-static-high.png' });
});

test('escape ending: collect all tapes and reach the fire road', async ({ page }) => {
  await bootToTitle(page);
  await startRun(page);
  await page.evaluate(() => window.__static.collectAll());
  expect(await page.evaluate(() => window.__static.tapes())).toBe(8);
  const exit = await page.evaluate(() => window.__static.positions().exit);
  await page.evaluate(([x, z]) => window.__static.warp(x, z), [exit.x, exit.z]);
  await page.waitForFunction(() => window.__static.state() === 'escaped', undefined, { timeout: 15_000 });
  expect(errors, errors.join('\n')).toHaveLength(0);
  await page.screenshot({ path: 'shots/e2e-ending.png' });
});

test('performance: frame-time budget after warmup', async ({ page }) => {
  test.skip(test.info().project.name === 'mobile', 'perf budget asserted on desktop profile');
  await bootToTitle(page);
  await startRun(page);
  await page.evaluate(() => window.__static.flashlight(true));
  // walk + look around to force streaming work, then let stats settle
  for (let i = 0; i < 6; i++) {
    await page.evaluate(([x, z]) => window.__static.warp(x, z), [i * 20 - 50, i * 15 - 40]);
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(3000);
  const s = await page.evaluate(() => window.__static.stats());
  console.log(`frame stats — avg ${(s.avg * 1000).toFixed(1)}ms p95 ${(s.p95 * 1000).toFixed(1)}ms worst ${(s.worst * 1000).toFixed(1)}ms`);
  expect(errors, errors.join('\n')).toHaveLength(0);
  // SwiftShader software rendering is far slower than any real GPU; the budget here
  // guards against pathological regressions, not hardware targets.
  expect(s.avg).toBeLessThan(0.25);
  expect(s.p95).toBeLessThan(0.5);
});
