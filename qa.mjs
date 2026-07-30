import { chromium } from '@playwright/test';

// Headless QA — logic-focused (boot, run lifecycle, tapes, entity, endings, error watch).
// Screenshots are skipped: SwiftShader + ~1GB sandbox RAM crashes on heavy frames.
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'] });
const page = await browser.newPage({ viewport: { width: 512, height: 288 } });
await page.addInitScript(() => localStorage.setItem('static.settings.v1', JSON.stringify({ quality: 'low' })));
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
let fail = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); if (!ok) fail++; };

await page.goto('http://localhost:4173', { waitUntil: 'load' });
await page.waitForFunction(() => window.__static && window.__static.state() === 'title', undefined, { timeout: 180000 });
check('boot reaches title', true);

// start a run
await page.evaluate(() => window.__static.start());
await page.waitForFunction(() => window.__static.state() === 'playing', undefined, { timeout: 30000 });
check('run starts → playing', true);
check('no errors after start', errors.length === 0, errors.slice(0, 4).join(' | '));

// entity is live and dormant-ish
const ent0 = await page.evaluate(() => window.__static.entity());
check('entity snapshot present', ent0 && typeof ent0.state === 'string', JSON.stringify(ent0));

// flashlight toggle doesn't throw
await page.evaluate(() => window.__static.flashlight(true));
await page.waitForTimeout(1200);
check('flashlight on, still no errors', errors.length === 0, errors.slice(0, 4).join(' | '));

// warp through zones without errors
const zones = await page.evaluate(() => window.__static.positions().zones);
check('zones exposed', zones.length >= 8, `count=${zones.length}`);
for (const z of zones) {
  await page.evaluate(([x, zz]) => window.__static.warp(x, zz), [z.x, z.z]);
  await page.waitForTimeout(250);
}
check('warped through all zones, no errors', errors.length === 0, errors.slice(0, 4).join(' | '));

// fear/detection drive entity state
await page.evaluate(() => { window.__static.forceFear(0.9); window.__static.forceDetection(0.8); });
await page.waitForTimeout(1500);
const ent1 = await page.evaluate(() => window.__static.entity());
check('entity escalates under detection', ['investigating', 'stalking', 'confronting'].includes(ent1.state), ent1.state);

// collect all tapes
await page.evaluate(() => window.__static.collectAll());
const tapes = await page.evaluate(() => window.__static.tapes());
check('collectAll → 8 tapes', tapes === 8, `tapes=${tapes}`);

// escape ending
const exit = await page.evaluate(() => window.__static.positions().exit);
await page.evaluate(([x, z]) => window.__static.warp(x, z), [exit.x, exit.z]);
await page.waitForFunction(() => window.__static.state() === 'escaped', undefined, { timeout: 15000 });
check('reached fire road → escaped', true);

// frame stats sane
const st = await page.evaluate(() => window.__static.stats());
check('frame stats present', st && st.avg > 0 && st.worst >= st.avg, JSON.stringify(st));

check('zero errors across full lifecycle', errors.length === 0, errors.slice(0, 6).join(' | '));
console.log(fail === 0 ? '\nALL CHECKS PASSED' : `\n${fail} CHECK(S) FAILED`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
