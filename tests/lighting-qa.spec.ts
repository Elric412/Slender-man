import { test, expect } from '@playwright/test';
import './api';

test('night readability and held flashlight across screen orientations', async ({ page }, info) => {
  test.setTimeout(240_000);
  const mobile = info.project.name === 'mobile';
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1024, height: 576 });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.addInitScript(quality => {
    localStorage.setItem('static.settings.v1', JSON.stringify({ quality, advisoryAck: true }));
  }, mobile ? 'low' : 'medium');
  try {
    await page.goto('/?silentaudio=1');
    await page.waitForFunction(() => window.__static?.state() === 'title', null, { timeout: 90_000 });
    await page.evaluate(() => window.__static.start());
    await page.waitForFunction(() => window.__static.state() === 'playing', null, { timeout: 90_000 });
    await page.evaluate(() => {
      window.__static.look(window.__static.player().yaw, -0.2);
      window.__static.flashlight(false);
    });
    // Fixed seeded viewpoint; allow streaming and exposure to settle for captures.
    await page.waitForTimeout(4000);
    await page.screenshot({ path: info.outputPath('trail-lamp-off.png') });
    await page.evaluate(() => window.__static.flashlight(true));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: info.outputPath('trail-lamp-on.png') });
    await page.evaluate(() => window.__static.look(window.__static.player().yaw, -0.8));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: info.outputPath('ground-close-up.png') });
    expect(await page.evaluate(() => window.__static.state())).toBe('playing');
    expect(errors, errors.join('\n')).toEqual([]);
  } finally {
    await page.evaluate(() => window.__static?.audioShutdown?.()).catch(() => {});
  }
});
