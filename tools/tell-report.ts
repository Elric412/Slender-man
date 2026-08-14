/**
 * Offline proximity-tell report — exercises ProximityTell against synthetic
 * entity snapshots and asserts the behavioural contract. Run:
 *
 *   npm run tell:report
 *
 * This is a headless logic gate, not a rendering test: ProximityTell is pure
 * (no DOM, no THREE), so it can be driven far faster and far more precisely
 * here than through Playwright. The browser harness still owns the questions
 * this cannot answer — that the dial actually appears, and that the `subtle`
 * boost reaches the composite.
 */
import { ProximityTell } from '../src/game/ProximityTell';
import type { EntitySnapshot } from '../src/ai/EntityBrain';

const DT = 1 / 60;

function snap(over: Partial<EntitySnapshot> = {}): EntitySnapshot {
  return {
    state: 'dormant', detection: 0,
    x: 0, y: 0, z: 0,
    visibleToPlayer: false, distToPlayer: 0, speed: 0,
    act: 0, extensionEligible: false, extensionRequest: false,
    ...over,
  };
}

/** Run `seconds` of frames with a fixed snapshot; return the final state. */
function soak(t: ProximityTell, s: EntitySnapshot, seconds: number,
              px = 0, pz = 0, fx = 0, fz = -1) {
  const n = Math.max(1, Math.round(seconds / DT));
  let last = t.update(DT, s, px, pz, fx, fz);
  for (let i = 1; i < n; i++) last = t.update(DT, s, px, pz, fx, fz);
  return { intensity: last.intensity, bearing: last.bearing, active: last.active, band: last.band };
}

let ok = true;
const fails: string[] = [];
function check(name: string, cond: boolean, detail = '') {
  if (!cond) { ok = false; fails.push(`${name}${detail ? ' — ' + detail : ''}`); }
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

// ---------------------------------------------------------------- off mode
{
  const t = new ProximityTell();
  t.mode = 'off';
  // A maximally alarming snapshot must still produce nothing at all.
  const r = soak(t, snap({ state: 'confronting', detection: 1, distToPlayer: 4, z: -4 }), 3);
  check('off: never activates', !r.active && r.intensity === 0, `i=${r.intensity}`);
  check('off: no static boost', t.staticBoost() === 0);
}

// ------------------------------------------------- detection, not distance
// The core design claim: proximity alone must not raise the tell. A dormant,
// undetecting entity standing very close is safe, and the tell must say so.
{
  const t = new ProximityTell();
  t.mode = 'explicit';
  const close = soak(t, snap({ state: 'dormant', detection: 0, distToPlayer: 6, z: -6 }), 4);
  check('dormant+undetected at 6m stays silent', !close.active, `i=${close.intensity.toFixed(3)}`);

  const t2 = new ProximityTell();
  t2.mode = 'explicit';
  // ...while a genuinely dangerous contact much further away does register.
  const far = soak(t2, snap({ state: 'confronting', detection: 0.9, distToPlayer: 30, z: -30 }), 4);
  check('confronting at 30m registers', far.active && far.intensity > 0.25,
    `i=${far.intensity.toFixed(3)}`);
  check('...and outranks the near-dormant case', far.intensity > close.intensity);
}

// --------------------------------------------------------- distance falloff
{
  const mk = (dist: number) => {
    const t = new ProximityTell();
    t.mode = 'explicit';
    return soak(t, snap({ state: 'stalking', detection: 0.8, distToPlayer: dist, z: -dist }), 4).intensity;
  };
  const d10 = mk(10), d40 = mk(40), d80 = mk(80), d200 = mk(200);
  check('intensity falls off with distance', d10 > d40 && d40 > d80,
    `10m=${d10.toFixed(2)} 40m=${d40.toFixed(2)} 80m=${d80.toFixed(2)}`);
  check('beyond MAX_RANGE reads zero', d200 === 0, `200m=${d200}`);
}

// ------------------------------------------------------------ state floors
{
  const t = new ProximityTell();
  t.mode = 'explicit';
  // Detection dipping to zero behind a trunk must not silence an active chase.
  const r = soak(t, snap({ state: 'confronting', detection: 0, distToPlayer: 12, z: -12 }), 3);
  check('confronting floors above zero even at det=0', r.active && r.intensity > 0.3,
    `i=${r.intensity.toFixed(3)}`);
}

// -------------------------------------------------------------- hysteresis
{
  const t = new ProximityTell();
  t.mode = 'explicit';
  const hot = snap({ state: 'stalking', detection: 0.9, distToPlayer: 14, z: -14 });
  const cold = snap({ state: 'dormant', detection: 0, distToPlayer: 14, z: -14 });

  // Attack: must arrive quickly — a late warning is useless.
  const quarter = soak(t, hot, 0.25);
  check('attack reaches most of target in ~0.25s', quarter.intensity > 0.3,
    `i=${quarter.intensity.toFixed(3)}`);

  const peak = soak(t, hot, 2).intensity;
  // Release: one frame of lost LOS must barely move it.
  const afterBlip = soak(t, cold, 0.1).intensity;
  check('single-frame LOS loss does not collapse the tell', afterBlip > peak * 0.9,
    `peak=${peak.toFixed(3)} after=${afterBlip.toFixed(3)}`);
  // ...and the minimum hold keeps it up for a beat.
  const during = soak(t, cold, 1.0).intensity;
  check('minimum hold keeps it asserted ~1s', during > peak * 0.85,
    `i=${during.toFixed(3)}`);
  // ...then it decays slowly rather than snapping off.
  const later = soak(t, cold, 4).intensity;
  check('eventually decays', later < during * 0.9, `i=${later.toFixed(3)}`);
  check('release is slower than attack',
    (during - later) < (quarter.intensity / 0.25) * 4);
}

// ------------------------------------------------------------------ bearing
// fwd = (0,-1) is "north"; screen-right is +x. Verified against the CSS needle,
// which rotates clockwise for positive degrees.
{
  const t = new ProximityTell();
  t.mode = 'explicit';
  const at = (ex: number, ez: number) => {
    const s = snap({ state: 'confronting', detection: 1, x: ex, z: ez,
      distToPlayer: Math.hypot(ex, ez) });
    return soak(t, s, 0.6, 0, 0, 0, -1).bearing;
  };
  const ahead = at(0, -20);
  const right = at(20, 0);
  const left = at(-20, 0);
  const behind = at(0, 20);
  const deg = (r: number) => (r * 180 / Math.PI).toFixed(1);
  check('bearing ahead ~0', Math.abs(ahead) < 0.02, `${deg(ahead)}deg`);
  check('bearing right ~+90', Math.abs(right - Math.PI / 2) < 0.02, `${deg(right)}deg`);
  check('bearing left ~-90', Math.abs(left + Math.PI / 2) < 0.02, `${deg(left)}deg`);
  check('bearing behind ~180', Math.abs(Math.abs(behind) - Math.PI) < 0.02, `${deg(behind)}deg`);
}

// -------------------------------------------------------------------- bands
{
  const t = new ProximityTell();
  t.mode = 'explicit';
  const bandAt = (det: number, dist: number, state: EntitySnapshot['state']) => {
    const u = new ProximityTell();
    u.mode = 'explicit';
    return soak(u, snap({ state, detection: det, distToPlayer: dist, z: -dist }), 4).band;
  };
  check('quiet reads none', bandAt(0, 70, 'dormant') === 'none');
  check('imminent at point blank + confront',
    bandAt(1, 5, 'confronting') === 'imminent', bandAt(1, 5, 'confronting'));
  // Bands must be monotone in intensity — a non-monotone mapping would let the
  // label disagree with the glow.
  const seq = [70, 55, 40, 25, 12, 4].map(d => {
    const u = new ProximityTell(); u.mode = 'explicit';
    return soak(u, snap({ state: 'stalking', detection: 0.85, distToPlayer: d, z: -d }), 4);
  });
  const rank = { none: 0, near: 1, close: 2, imminent: 3 };
  let mono = true;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i].intensity < seq[i - 1].intensity) mono = false;
    if (rank[seq[i].band] < rank[seq[i - 1].band]) mono = false;
  }
  check('bands monotone as distance closes', mono,
    seq.map(s => `${s.band}:${s.intensity.toFixed(2)}`).join(' '));
  void t;
}

// ------------------------------------------------------------ subtle vs explicit
{
  const hot = snap({ state: 'confronting', detection: 1, distToPlayer: 10, z: -10 });
  const sub = new ProximityTell(); sub.mode = 'subtle';
  soak(sub, hot, 3);
  const exp = new ProximityTell(); exp.mode = 'explicit';
  soak(exp, hot, 3);
  check('subtle produces a static boost', sub.staticBoost() > 0.02,
    sub.staticBoost().toFixed(3));
  check('explicit produces no static boost', exp.staticBoost() === 0);
  // The boost must stay small: it is meant to read as the tape reacting sooner,
  // not as a second effect layered on top.
  check('subtle boost stays subtle (<0.2)', sub.staticBoost() < 0.2,
    sub.staticBoost().toFixed(3));
}

// ---------------------------------------------------------------------- reset
{
  const t = new ProximityTell();
  t.mode = 'explicit';
  soak(t, snap({ state: 'confronting', detection: 1, distToPlayer: 8, z: -8 }), 3);
  check('asserted before reset', t.current.active);
  t.reset();
  check('reset clears intensity', t.current.intensity === 0 && !t.current.active);
  check('reset clears band', t.current.band === 'none');
  // A run must not open with an inherited warning: after reset, the very first
  // frame of a calm snapshot must still be silent.
  const first = t.update(DT, snap({ state: 'dormant', detection: 0, distToPlayer: 60, z: -60 }), 0, 0, 0, -1);
  check('first frame after reset is silent', !first.active, `i=${first.intensity.toFixed(3)}`);
}

// ------------------------------------------------------- frame-rate independence
// The same wall-clock exposure at 30fps and 144fps must land in the same place,
// or the warning would arrive sooner on faster machines.
{
  const hot = snap({ state: 'stalking', detection: 0.85, distToPlayer: 18, z: -18 });
  const run = (dt: number) => {
    const t = new ProximityTell();
    t.mode = 'explicit';
    const n = Math.round(1.0 / dt);
    let v = 0;
    for (let i = 0; i < n; i++) v = t.update(dt, hot, 0, 0, 0, -1).intensity;
    return v;
  };
  const a = run(1 / 30), b = run(1 / 144);
  check('frame-rate independent within 8%', Math.abs(a - b) / Math.max(a, b) < 0.08,
    `30fps=${a.toFixed(3)} 144fps=${b.toFixed(3)}`);
}

console.log('');
console.log(`TELL REPORT: ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) { for (const f of fails) console.log(`  - ${f}`); process.exit(1); }
