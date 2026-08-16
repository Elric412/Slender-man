import { test, expect, Page } from '@playwright/test';

/**
 * STATIC — proximity-tell integration + shader-compile gate.
 *
 * The pure behavioural contract of ProximityTell is asserted offline in
 * `npm run tell:report` (28 checks, no browser needed). This suite covers only
 * the things that genuinely require a real page:
 *
 *   1. the setting round-trips through localStorage and the menu control,
 *   2. the dial element appears/disappears/rotates for the right mode,
 *   3. `subtle` mode reaches the composite without drawing anything,
 *   4. every custom shader patch actually compiles in a live WebGL2 context.
 *
 * (4) is the important one. `tsc` and `vite build` never touch GLSL, so until a
 * page has rendered the entity with its subsurface/grime/dither patches and the
 * forest with its atlas patch, none of that code has been validated at all.
 */

// Shared `window.__static` typing (see ./api for why it is not inline here).
import './api';

const errors: string[] = [];

function watch(page: Page) {
  errors.length = 0;
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
}

async function bootToTitle(page: Page) {
  // ?silentaudio=1 builds the AudioContext on Chromium's silent sink: the graph
  // still renders on the real audio clock, but no output device is opened. On a
  // headless runner with no sound card an opened device wedges the audio thread
  // and takes the page with it. See playwright.config.ts's header note.
  await page.goto('/?silentaudio=1', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__static && window.__static.state() === 'title',
    undefined, { timeout: 90_000 });
}

async function startRun(page: Page) {
  await page.evaluate(() => window.__static.start());
  await page.waitForFunction(() => window.__static.state() === 'playing',
    undefined, { timeout: 20_000 });
  // Every assertion in this suite is about state or DOM, never about pixels, so
  // we can afford to render sparsely. On a 2-core headless runner SwiftShader
  // otherwise saturates both cores and starves Chromium's audio render thread
  // until the page is killed outright ("Target crashed"). The shader-compile
  // test overrides this back down, since it *does* need frames to be drawn.
  await page.evaluate(() => window.__static.renderThrottle(6));
  // `playing` is set before the first update tick completes, and the entity
  // snapshot only exists after that tick. Waiting on the snapshot itself is the
  // honest precondition — polling for a fixed number of ms would be flaky on a
  // software rasteriser, where a frame can take hundreds of milliseconds.
  await page.waitForFunction(() => window.__static.entity() !== null,
    undefined, { timeout: 30_000 });
}

/**
 * Drag the entity into the player's face and pin detection high, so the tell has
 * something real to react to. Returns once the tell has had time to attack.
 */
async function forceContact(page: Page, mode: 'off' | 'subtle' | 'explicit' = 'explicit') {
  const placed = await page.evaluate(() => {
    // Stand the player next to the entity rather than moving the entity: warp()
    // is the supported hook and it keeps collision/nav state consistent.
    const e = window.__static.entity();
    if (!e) return false;
    window.__static.warp(e.x + 6, e.z + 6);
    return true;
  });
  expect(placed, 'entity snapshot unavailable — run not started?').toBe(true);

  // Detection decays every brain tick, and the brain may legitimately refuse to
  // hold a high value (LOS through a trunk, milestone ceiling). So re-assert it
  // each poll and wait on the *outcome* rather than sleeping and hoping.
  // In `off` mode there is nothing to wait for, so just settle a few frames.
  if (mode === 'off') {
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => window.__static.forceDetection(0.95));
      await page.waitForTimeout(150);
    }
    return;
  }
  const deadline = Date.now() + 30_000;
  for (;;) {
    await page.evaluate(() => window.__static.forceDetection(0.95));
    await page.waitForTimeout(150);
    const t = await page.evaluate(() => window.__static.tell());
    if (t.active && t.intensity > 0.1) return;
    if (Date.now() > deadline) {
      throw new Error(`tell never asserted: ${JSON.stringify(t)}`);
    }
  }
}

test.beforeEach(async ({ page }) => watch(page));

/**
 * Same teardown as the main suite (see tests/static.spec.ts for the full
 * rationale): release the audio device, explicitly lose the WebGL context, and
 * drop the page heap. On a small headless runner the SwiftShader render targets
 * from a finished test are otherwise not reclaimed in time and the *next* test
 * dies with "Target crashed" for memory it never allocated.
 *
 * Host-environment workaround, not product behaviour — it runs after all
 * assertions, so it cannot mask a real defect.
 */
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__static?.audioShutdown?.()).catch(() => undefined);
  await page.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null;
    const gl = c?.getContext('webgl2') as WebGL2RenderingContext | null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }).catch(() => undefined);
  await page.goto('about:blank').catch(() => undefined);
});

test('proximity tell defaults to off and stays invisible', async ({ page }) => {
  await bootToTitle(page);
  // Default must be `off`: the ambiguity is the intended experience.
  const sel = page.locator('#set-proximity');
  await expect(sel).toHaveValue('off');
  await startRun(page);
  await forceContact(page, 'off');
  const t = await page.evaluate(() => window.__static.tell());
  expect(t.mode).toBe('off');
  expect(t.active).toBe(false);
  expect(t.intensity).toBe(0);
  expect(t.boost).toBe(0);
  await expect(page.locator('#proximity-tell')).toHaveClass(/hidden/);
  expect(errors, errors.join('\n')).toHaveLength(0);
});

test('explicit mode shows a dial that tracks bearing and band', async ({ page }) => {
  await bootToTitle(page);
  await startRun(page);
  await page.evaluate(() => window.__static.setTell('explicit'));
  await forceContact(page);

  const t = await page.evaluate(() => window.__static.tell());
  expect(t.mode).toBe('explicit');
  expect(t.active).toBe(true);
  expect(t.intensity).toBeGreaterThan(0.1);
  // Explicit must not also nudge the static — that would double-charge the
  // player for a setting they already paid for with a HUD element.
  expect(t.boost).toBe(0);

  const dial = page.locator('#proximity-tell');
  await expect(dial).not.toHaveClass(/hidden/);
  await expect(page.locator('#pt-label')).not.toBeEmpty();

  // The needle must carry a real rotation, and the container a real intensity.
  const styles = await page.evaluate(() => ({
    bearing: document.getElementById('pt-needle')!.style.getPropertyValue('--pt-bearing'),
    pt: document.getElementById('proximity-tell')!.style.getPropertyValue('--pt'),
  }));
  expect(styles.bearing).toMatch(/-?\d+deg/);
  expect(parseFloat(styles.pt)).toBeGreaterThan(0);

  // Turning the setting off must clear the element immediately, not next frame.
  await page.evaluate(() => window.__static.setTell('off'));
  await expect(dial).toHaveClass(/hidden/);
  expect(errors, errors.join('\n')).toHaveLength(0);
  await page.screenshot({ path: 'shots/e2e-tell-explicit.png' });
});

test('subtle mode boosts static without drawing anything', async ({ page }) => {
  await bootToTitle(page);
  await startRun(page);
  await page.evaluate(() => window.__static.setTell('subtle'));
  await forceContact(page, 'subtle');

  const t = await page.evaluate(() => window.__static.tell());
  expect(t.mode).toBe('subtle');
  expect(t.active).toBe(true);
  // The whole point of `subtle`: information arrives, no HUD admits it.
  expect(t.boost).toBeGreaterThan(0);
  expect(t.boost).toBeLessThan(0.2);
  await expect(page.locator('#proximity-tell')).toHaveClass(/hidden/);
  expect(errors, errors.join('\n')).toHaveLength(0);
  await page.screenshot({ path: 'shots/e2e-tell-subtle.png' });
});

test('setting persists across a reload', async ({ page }) => {
  await bootToTitle(page);
  await page.selectOption('#set-proximity', 'explicit');
  // Committed to localStorage by Menu.commit() on change.
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__static && window.__static.state() === 'title',
    undefined, { timeout: 90_000 });
  await expect(page.locator('#set-proximity')).toHaveValue('explicit');
  expect(await page.evaluate(() => window.__static.tell().mode)).toBe('explicit');
  expect(errors, errors.join('\n')).toHaveLength(0);
});

test('a garbage saved mode falls back to off', async ({ page }) => {
  // A downgraded or hand-edited profile must not put the game in a half-state.
  await page.addInitScript(() => {
    localStorage.setItem('static.settings.v2', JSON.stringify({ proximityTell: 'wat' }));
  });
  await bootToTitle(page);
  await expect(page.locator('#set-proximity')).toHaveValue('off');
  expect(await page.evaluate(() => window.__static.tell().mode)).toBe('off');
});

test('all custom shader patches compile in a live WebGL2 context', async ({ page }) => {
  // Gate for the SSS / grime / LOD-dither patches on the entity and the manual
  // atlas sampling on the forest. A GLSL link failure surfaces as a console
  // error from three.js, so `errors` is the actual assertion here.
  await bootToTitle(page);
  await startRun(page);
  await page.evaluate(() => window.__static.flashlight(true));
  await page.waitForTimeout(1500);

  // Walk the LOD bands so every level's dither variant gets compiled: LOD2 far,
  // LOD1 mid, LOD0 close. Each is a distinct program via customProgramCacheKey.
  for (const d of [90, 40, 14]) {
    await page.evaluate((dist) => {
      const e = window.__static.entity();
      if (!e) return;
      window.__static.warp(e.x + dist, e.z);
      window.__static.forceDetection(0.8);
    }, d);
    await page.waitForTimeout(1400);
    expect(errors, `at ~${d}m: ` + errors.join('\n')).toHaveLength(0);
  }

  // And the extension beat, which drives the extra joints and can grow the
  // skinned bounds — the one path most likely to trip a NaN in the shader.
  await page.evaluate(() => window.__static.forceExtension());
  await page.waitForTimeout(1200);

  const pb = await page.evaluate(() => window.__static.palebark());
  expect(pb).toBeTruthy();
  const stats = await page.evaluate(() => window.__static.gpuStats());
  expect(stats!.calls).toBeGreaterThan(0);
  expect(stats!.triangles).toBeGreaterThan(0);

  expect(errors, errors.join('\n')).toHaveLength(0);
  await page.screenshot({ path: 'shots/e2e-shader-compile.png' });
});
