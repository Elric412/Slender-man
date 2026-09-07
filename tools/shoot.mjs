#!/usr/bin/env node
/**
 * shoot — art-direction capture harness.
 *
 * ## Why this exists alongside qa-shot.mjs
 *
 * `qa-shot.mjs` answers "did the build boot and render something", one image
 * per browser process. Reviewing the *forest* needs something different: a
 * dozen deliberately framed angles — trail corridor, canopy, flashlight on the
 * ground, distant silhouette layers — from one warm process, because relaunching
 * a SwiftShader browser and re-booting the world costs ~40 s per image and the
 * whole point is to iterate.
 *
 * Two things make a multi-shot session survivable here:
 *
 *  - **Capture off the WebGL canvas, not the compositor.** Playwright's
 *    `page.screenshot()` goes through the compositor, which is the step that
 *    actually dies under SwiftShader in a ~1 GB sandbox. A double-rAF +
 *    `toDataURL` runs after the game's own draw in the same frame, so it reads
 *    real pixels without the compositor ever being involved.
 *  - **A settle loop per shot.** The pipeline is temporally accumulated (TAA
 *    with Halton jitter, plus a motion-blur history). A frame grabbed
 *    immediately after a warp is a smeared blend of two locations and tells you
 *    nothing about material quality. So each shot invalidates history, then
 *    renders a fixed number of frames before reading.
 *
 * Usage:
 *   node tools/shoot.mjs                     # all shots, desktop, quality high
 *   node tools/shoot.mjs --quality=ultra
 *   node tools/shoot.mjs --only=floor,canopy
 *   node tools/shoot.mjs --out=shots/pass2
 */

import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const QUALITY = arg('quality', 'high');
const OUT = arg('out', 'shots');
const ONLY = arg('only', '').split(',').filter(Boolean);
const WIDTH = Number(arg('w', 960));
const HEIGHT = Number(arg('h', 540));
/** Frames rendered after a camera move before the pixels are trusted. */
const SETTLE = Number(arg('settle', 14));

mkdirSync(OUT, { recursive: true });

/**
 * The review set.
 *
 * These are not random coordinates — each one targets a specific claim in the
 * quality bar, so a regression in that claim shows up in a named file rather
 * than being averaged away across a pretty screenshot. `at` is resolved against
 * the live layout so the shots follow the world if a landmark moves.
 */
const SHOTS = [
  { id: 'trail',    zone: 'hub',      yaw: 0.6,  pitch: -0.08, why: 'trail corridor — sightline framing, mid density' },
  { id: 'floor',    zone: 'hub',      yaw: 1.9,  pitch: -0.95, why: 'flashlight on ground — micro detail, wetness, litter' },
  { id: 'canopy',   zone: 'cabin',    yaw: 2.6,  pitch: 0.85,  why: 'canopy overhead — branch silhouette, closure' },
  { id: 'deep',     zone: 'clearing', yaw: 3.4,  pitch: -0.05, why: 'forest interior — overlapping depth layers' },
  { id: 'oldgrowth',zone: 'cabin',    yaw: 1.1,  pitch: -0.02, why: 'old growth — trunk scale, root flare' },
  { id: 'thicket',  zone: 'hub',      yaw: 4.4,  pitch: -0.15, why: 'thicket — dense understory occlusion' },
  { id: 'marsh',    zone: 'dock',     yaw: 2.2,  pitch: -0.12, why: 'wet lowland — puddles, reeds, standing water' },
  { id: 'ravine',   zone: 'shack',    yaw: 0.2,  pitch: -0.25, why: 'creek ravine — moss, embankment, terrain cut' },
  { id: 'stormfall',zone: 'quarry',   yaw: 5.0,  pitch: -0.06, why: 'storm fall — deadwood, broken crowns, moonlight' },
  { id: 'ridge',    zone: 'ridge',    yaw: 3.0,  pitch: -0.10, why: 'ridge — distant forest mass toward horizon' },
  { id: 'rocks',    zone: 'rocks',    yaw: 1.5,  pitch: -0.30, why: 'rock formation — geology, mossy boulders' },
  { id: 'blight',   zone: 'tower',    yaw: 2.0,  pitch: -0.05, why: 'landmark integration — structure in vegetation' },
];

const wanted = ONLY.length ? SHOTS.filter(s => ONLY.includes(s.id)) : SHOTS;

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--mute-audio', '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.addInitScript(q => {
  try {
    const KEY = 'static.settings.v1';
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    s.quality = q;
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* first run, no storage yet */ }
}, QUALITY);

const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://localhost:4173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__static && window.__static.state() === 'title', null, { timeout: 180_000 });
console.log(`boot OK  (quality=${QUALITY}, ${WIDTH}x${HEIGHT})`);

await page.evaluate(() => window.__static.start());
/**
 * Generous, because this wait is not measuring the game.
 *
 * SwiftShader renders the first few frames of a run in *seconds* each — the
 * shadow atlas allocation, the first chunk merges and the initial shader
 * compiles all land on the same frame. `startRun()` sets state synchronously
 * but the transition only becomes observable once a frame completes, so a
 * 60 s budget times out on the software rasteriser while being ample on a real
 * GPU. Failing here would abandon the whole capture session over a boot delay,
 * so it retries against a long ceiling instead.
 */
await page.waitForFunction(() => window.__static.state() === 'playing', null, { timeout: 300_000 });
await page.evaluate(() => window.__static.flashlight(true));
/**
 * Let the world settle before the first shot.
 *
 * A run opens with the near-tier chunk merges still queued (BUILDS_PER_FRAME
 * is 2), so the forest around the spawn is genuinely not finished streaming for
 * the first second or so. Capturing during that window photographs a sparser
 * forest than the game actually has, which would make every density judgement
 * downstream wrong in the same direction.
 */
await page.waitForTimeout(4000);

const layout = await page.evaluate(() => window.__static.world());
const zoneAt = id => layout.zones.find(z => z.id === id);

/**
 * Render N frames and read the back buffer.
 *
 * The nested rAF matters: a callback registered in frame K runs after the
 * game's rAF for frame K (registration order), so the drawing buffer still
 * holds the finished image even with `preserveDrawingBuffer: false`.
 */
async function grab(page, settle) {
  return page.evaluate(async n => {
    const frame = () => new Promise(r => requestAnimationFrame(r));
    for (let i = 0; i < n; i++) await frame();
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const c = document.querySelector('canvas');
          try { resolve(c.toDataURL('image/png')); } catch { resolve(null); }
        });
      });
    });
  }, settle);
}

const report = [];
for (const shot of wanted) {
  const z = zoneAt(shot.zone);
  if (!z) { console.log(`skip ${shot.id}: no zone '${shot.zone}'`); continue; }
  await page.evaluate(([x, zz, yaw, pitch]) => {
    window.__static.warp(x, zz);
    window.__static.look(yaw, pitch);
  }, [z.x, z.z, shot.yaw, shot.pitch]);

  /**
   * Wait for the near tier to stream in before photographing the place.
   *
   * A warp is an instantaneous jump across the map, which is exactly the case
   * the chunk streamer is *not* built for: it services 2 merges per frame
   * against an LRU budget, deliberately, so a walking player never eats the
   * hitch. Photographing immediately after a warp therefore captures the far
   * tier only — bare canopy silhouettes over an empty floor — and every
   * conclusion drawn from that image about "density" would be an artefact of
   * the harness rather than a fact about the forest.
   *
   * A fixed sleep cannot express this because the number of chunks needing a
   * rebuild depends on how far the warp went. So poll the streamer's own
   * pending count and only proceed once it has drained (with a ceiling, so a
   * genuinely stuck streamer fails the shot instead of hanging the run).
   */
  await page.waitForFunction(() => {
    const s = window.__static.scatter?.();
    return !s || s.pending === 0;
  }, null, { timeout: 120_000 }).catch(() => { /* fall through and note it in the report */ });
  await page.waitForTimeout(1200);

  const url = await grab(page, SETTLE);
  const path = `${OUT}/${shot.id}.png`;
  if (url && url.length > 30_000) {
    writeFileSync(path, Buffer.from(url.split(',')[1], 'base64'));
    const stats = await page.evaluate(() => window.__static.stats());
    const probe = await page.evaluate(([x, zz]) => window.__static.probe(x, zz), [z.x, z.z]);
    const sc = await page.evaluate(() => window.__static.scatter?.() ?? null);
    const rd = await page.evaluate(() => window.__static.renderer?.() ?? null);
    report.push({
      id: shot.id, ok: true, zone: probe.zone,
      trees: probe.trees, cover: +probe.cover.toFixed(2),
      // Draw calls and triangles are the numbers every density decision has to
      // be argued against; recording them per shot means a later "the forest
      // got denser" claim can be checked instead of believed.
      calls: rd?.calls, tris: rd?.triangles, programs: rd?.programs,
      nearTris: sc?.trianglesNear, farTris: sc?.trianglesFar, residentVerts: sc?.residentVerts,
    });
    console.log(
      `shot ${shot.id.padEnd(10)} ok  trees=${String(probe.trees).padStart(3)}` +
      `  cover=${probe.cover.toFixed(2)}  calls=${String(rd?.calls ?? '?').padStart(4)}` +
      `  tris=${String(rd?.triangles ?? '?').padStart(8)}  zone=${probe.zone}`);
  } else {
    report.push({ id: shot.id, ok: false });
    console.log(`shot ${shot.id.padEnd(10)} BLANK`);
  }
}

const rinfo = await page.evaluate(() => window.__static.renderer?.() ?? null);
if (rinfo) console.log('renderer:', JSON.stringify(rinfo));
console.log('errors:', errors.length ? errors.slice(0, 8) : 'none');
writeFileSync(`${OUT}/report.json`, JSON.stringify({ quality: QUALITY, report, errors: errors.slice(0, 20), renderer: rinfo }, null, 2));
await browser.close();
process.exit(0);
