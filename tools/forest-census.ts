/**
 * tools/forest-census.ts — what is actually in the forest, per square metre.
 *
 * ## Why this exists rather than a screenshot
 *
 * "Density" is the central requirement of the forest work, and a screenshot is
 * a bad instrument for it. The sandbox this project is developed in has ~1 GB
 * of RAM and two cores, so in-game captures go through SwiftShader and either
 * crash or take minutes per frame; and even when one succeeds, a dark night
 * scene photographed at 960x540 cannot tell you whether the floor carries 4
 * scatter items per square metre or 14. Judging density from those images is
 * how a forest ends up "looking fine" in the two angles that were checked and
 * empty everywhere else.
 *
 * So this tool runs the *real* HeightField / ZoneSystem / ScatterSystem in Node
 * with no GPU and counts things. It reports, per ecological zone:
 *
 *   - trees per hectare, split by archetype and by height band
 *   - ground-scatter items per square metre, by family
 *   - the fraction of sample points that are visually empty
 *
 * The last one is the number the whole task turns on. The requirement is that
 * "empty, flat, visually dead ground should be extremely rare", which is a
 * measurable claim: take a point, look at what is within a couple of metres of
 * it, and ask whether anything would be visible there under a flashlight. This
 * prints that as a percentage, per zone, so a change can be shown to have
 * improved it instead of asserted to have.
 *
 * Run: npm run census:forest
 */
import * as THREE from 'three';
import { HeightField } from '../src/world/HeightField';
import { ZoneSystem, ZONE_IDS, type ZoneId } from '../src/world/ZoneSystem';
import { ScatterSystem } from '../src/world/ScatterSystem';
import { ForestAtlas } from '../src/world/ForestAtlas';
import { MaterialLibrary } from '../src/world/MaterialLibrary';

const WORLD_SEED = 0x57A71C;

/** Height bands, in metres — the scale-diversity requirement made countable. */
const BANDS: { name: string; min: number; max: number }[] = [
  { name: 'sapling <3m', min: 0, max: 3 },
  { name: 'young 3-8m', min: 3, max: 8 },
  { name: 'mid 8-16m', min: 8, max: 16 },
  { name: 'mature 16-26m', min: 16, max: 26 },
  { name: 'giant >26m', min: 26, max: 1e9 },
];

function pad(s: string | number, n: number): string {
  return String(s).padStart(n);
}
function padr(s: string | number, n: number): string {
  return String(s).padEnd(n);
}

console.log('--- STATIC forest census (node, no GPU) ---\n');

const t0 = performance.now();
const hf = new HeightField(WORLD_SEED);
const zones = new ZoneSystem(hf, WORLD_SEED);
/**
 * The atlas and material library are constructed because ScatterSystem needs
 * them, not because anything here samples a texture. They are the expensive
 * part of this tool's startup, which is worth stating: if this census ever
 * needs to run in a tight loop, hoisting these is the first move.
 */
const mats = new MaterialLibrary(WORLD_SEED);
const atlas = new ForestAtlas(WORLD_SEED);
const scatter = new ScatterSystem(hf, zones, atlas, mats, WORLD_SEED);
const buildMs = performance.now() - t0;

console.log(`world + scatter build   ${buildMs.toFixed(0)} ms`);
console.log(`world size              ${hf.layout.size} m  (${((hf.layout.size ** 2) / 10_000).toFixed(1)} ha)\n`);

// ============================================================================
// trees
// ============================================================================

const worldHa = (hf.layout.size ** 2) / 10_000;

/** zone -> archetype -> count, and zone -> band -> count */
const byZone = new Map<ZoneId, Map<string, number>>();
const bandByZone = new Map<ZoneId, number[]>();
const zoneArea = new Map<ZoneId, number>();
const archetypeTotals = new Map<string, number>();
let totalTrees = 0;
let minH = 1e9, maxH = 0, sumH = 0;

for (const id of ZONE_IDS) {
  byZone.set(id, new Map());
  bandByZone.set(id, new Array(BANDS.length).fill(0));
  zoneArea.set(id, 0);
}

/**
 * Zone area is estimated by sampling rather than integrated analytically,
 * because the zone field is a *blend* — every point carries seven weights and
 * only the dominant one names the place. There is no polygon whose area could
 * be computed. A 2 m grid over a 420 m world is 44 k samples, which is instant
 * and well below the field's own 160^2 resolution, so the estimate is limited by
 * the field, not by the sampling.
 */
const AREA_STEP = 2;
for (let x = -hf.layout.size / 2; x < hf.layout.size / 2; x += AREA_STEP) {
  for (let z = -hf.layout.size / 2; z < hf.layout.size / 2; z += AREA_STEP) {
    const dom = zones.dominantAt(x, z) as ZoneId;
    zoneArea.set(dom, (zoneArea.get(dom) ?? 0) + AREA_STEP * AREA_STEP);
  }
}

for (const t of scatter.trees) {
  totalTrees++;
  const dom = zones.dominantAt(t.x, t.z) as ZoneId;
  const m = byZone.get(dom);
  if (m) m.set(t.archetype, (m.get(t.archetype) ?? 0) + 1);
  archetypeTotals.set(t.archetype, (archetypeTotals.get(t.archetype) ?? 0) + 1);

  const h = t.height ?? 0;
  minH = Math.min(minH, h); maxH = Math.max(maxH, h); sumH += h;
  const bands = bandByZone.get(dom);
  if (bands) {
    for (let i = 0; i < BANDS.length; i++) {
      if (h >= BANDS[i].min && h < BANDS[i].max) { bands[i]++; break; }
    }
  }
}

console.log('=== TREES ===');
console.log(`total ${totalTrees}   overall ${(totalTrees / worldHa).toFixed(0)}/ha` +
  `   height ${minH.toFixed(1)}..${maxH.toFixed(1)} m (mean ${(sumH / Math.max(1, totalTrees)).toFixed(1)})\n`);

console.log(`${padr('zone', 12)} ${pad('area ha', 8)} ${pad('trees', 7)} ${pad('/ha', 6)}   archetype mix`);
for (const id of ZONE_IDS) {
  const ha = (zoneArea.get(id) ?? 0) / 10_000;
  const m = byZone.get(id)!;
  let n = 0;
  for (const v of m.values()) n += v;
  const mix = [...m.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${((v / Math.max(1, n)) * 100).toFixed(0)}%`).join('  ');
  console.log(`${padr(id, 12)} ${pad(ha.toFixed(2), 8)} ${pad(n, 7)} ${pad(ha > 0.01 ? (n / ha).toFixed(0) : '-', 6)}   ${mix}`);
}

console.log(`\n${padr('zone', 12)} height bands (share of that zone's trees)`);
for (const id of ZONE_IDS) {
  const bands = bandByZone.get(id)!;
  const n = bands.reduce((a, b) => a + b, 0);
  if (!n) { console.log(`${padr(id, 12)} (none)`); continue; }
  const s = BANDS.map((b, i) => `${b.name} ${pad(((bands[i] / n) * 100).toFixed(0) + '%', 4)}`).join('  ');
  console.log(`${padr(id, 12)} ${s}`);
}

// ============================================================================
// ground scatter + emptiness
// ============================================================================

/**
 * The emptiness probe.
 *
 * For a grid of sample points, ask the scatter system what it actually placed
 * nearby. A point counts as *empty* when nothing at all — no tree trunk, no
 * ground card, no deadfall, no rock — falls within `NEAR_R` metres of it. That
 * radius is deliberately small: 2.2 m is roughly what a flashlight cone covers
 * on the ground at walking distance, so an "empty" verdict here corresponds to
 * a real frame in which the player sweeps the light across nothing.
 *
 * Points inside the lake, inside the quarry pit, and inside a landmark
 * exclusion volume are excluded rather than counted as empty, because those are
 * *authored* voids — water and a quarry floor are supposed to be bare, and
 * counting them would make the metric unable to distinguish a design decision
 * from a hole in the forest.
 */
const NEAR_R = 2.2;
const PROBE_STEP = 3;

const detail = scatter.detailCensus ? scatter.detailCensus() : null;

let probed = 0, empty = 0, excluded = 0;
const emptyByZone = new Map<ZoneId, { probed: number; empty: number }>();
for (const id of ZONE_IDS) emptyByZone.set(id, { probed: 0, empty: 0 });

for (let x = -hf.layout.size / 2 + 4; x < hf.layout.size / 2 - 4; x += PROBE_STEP) {
  for (let z = -hf.layout.size / 2 + 4; z < hf.layout.size / 2 - 4; z += PROBE_STEP) {
    if (hf.inLake(x, z) || hf.inQuarry(x, z)) { excluded++; continue; }
    let blocked = false;
    for (const ex of zones.exclusions) {
      if (Math.hypot(ex.x - x, ex.z - z) < ex.r) { blocked = true; break; }
    }
    if (blocked) { excluded++; continue; }

    probed++;
    const dom = zones.dominantAt(x, z) as ZoneId;
    const rec = emptyByZone.get(dom)!;
    rec.probed++;

    const n = scatter.countNear ? scatter.countNear(x, z, NEAR_R) : 0;
    if (n === 0) { empty++; rec.empty++; }
  }
}

console.log('\n=== EMPTINESS ===');
console.log(`probe radius ${NEAR_R} m, grid ${PROBE_STEP} m`);
console.log(`${probed} points probed, ${excluded} excluded (lake / quarry / landmark)\n`);
console.log(`${padr('zone', 12)} ${pad('probed', 8)} ${pad('empty', 8)} ${pad('empty %', 9)}`);
for (const id of ZONE_IDS) {
  const r = emptyByZone.get(id)!;
  if (!r.probed) { console.log(`${padr(id, 12)} ${pad(0, 8)}`); continue; }
  console.log(`${padr(id, 12)} ${pad(r.probed, 8)} ${pad(r.empty, 8)} ${pad(((r.empty / r.probed) * 100).toFixed(1) + '%', 9)}`);
}
console.log(`${padr('ALL', 12)} ${pad(probed, 8)} ${pad(empty, 8)} ${pad(((empty / Math.max(1, probed)) * 100).toFixed(1) + '%', 9)}`);

if (detail) {
  console.log('\n=== GROUND SCATTER ===');
  let tot = 0;
  for (const v of Object.values(detail)) tot += v as number;
  const areaM2 = hf.layout.size ** 2;
  console.log(`${padr('family', 16)} ${pad('count', 10)} ${pad('per m2', 9)}`);
  for (const [k, v] of Object.entries(detail).sort((a, b) => (b[1] as number) - (a[1] as number))) {
    console.log(`${padr(k, 16)} ${pad(v as number, 10)} ${pad(((v as number) / areaM2).toFixed(3), 9)}`);
  }
  console.log(`${padr('TOTAL', 16)} ${pad(tot, 10)} ${pad((tot / areaM2).toFixed(3), 9)}`);
}

// ============================================================================
// geometry cost
// ============================================================================

console.log('\n=== GEOMETRY ===');
const s = scatter.stats;
console.log(`templates              ${s.templates}  (${(s.templateBytes / 1048576).toFixed(1)} MB)`);
console.log(`chunks                 ${s.chunks}`);
console.log(`heap used              ${(process.memoryUsage().heapUsed / 1048576).toFixed(1)} MB`);
console.log(`three                  r${THREE.REVISION}`);
