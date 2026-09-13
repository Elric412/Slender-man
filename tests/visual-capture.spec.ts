import { test, expect } from '@playwright/test';
// @ts-expect-error Browser-focused tsconfig omits Node globals; Playwright runs in Node.
import { Buffer } from 'node:buffer';
import { VISUAL_SCENES } from '../src/debug/VisualCapture';
import './api';

for (const scene of VISUAL_SCENES) {
  test(`fixed visual scene: ${scene}`, async ({ page }, info) => {
    test.setTimeout(300_000);
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    const mobile = info.project.name === 'mobile';
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 });
    await page.addInitScript(quality => {
      localStorage.setItem('static.settings.v1', JSON.stringify({ quality, advisoryAck: true }));
    }, mobile ? 'low' : 'high');
    await page.goto('/?silentaudio=1&visualqa=1');
    await page.waitForFunction(() => window.__static?.state() === 'title');
    await page.evaluate(() => window.__static.start());
    await page.waitForFunction(() => window.__static.state() === 'playing');
    const shot = await page.evaluate(name => window.__static.visualCapture(name), scene);
    const { png, ...metrics } = shot;
    await info.attach(`${scene}.png`, { body: Buffer.from(png.split(',')[1], 'base64'), contentType: 'image/png' });
    await info.attach(`${scene}.json`, { body: JSON.stringify(metrics, null, 2), contentType: 'application/json' });
    expect(shot.pending).toBe(0);
    expect(shot.pixels.deviation).toBeGreaterThan(2);
    expect(shot.pixels.clippedFraction).toBeLessThan(0.15);
    expect(shot.beam.alignment).toBeGreaterThan(0.99);
    if (scene === 'trail') {
      const dark = await page.evaluate(name => window.__static.visualCapture(name, false), scene);
      expect(shot.pixels.centerMean).toBeGreaterThan(dark.pixels.centerMean);
      expect(dark.beam.strength).toBe(0);
    }
    expect(errors).toEqual([]);
  });
}
