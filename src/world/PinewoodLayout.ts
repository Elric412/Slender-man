import { SeededRandom } from '../core/SeededRandom';

/**
 * ── PINEWOOD FOREST — the spatial source of truth ─────────────────────────────
 *
 * Every number in this file is traced from the survey map (1024x683 px). The
 * terrain, the collision, the nav grid, the scatter exclusion, the landmark
 * geometry, the page placement AND the in-game map UI all read from here, so
 * the world the player walks and the map they hold can never disagree.
 *
 * Pixel -> world convention (compass N is up on the map):
 *     map +x  ->  world +x   (east)
 *     map +y  ->  world +z   (south)
 *     map (400, 340) -> world origin
 *
 * The map's readable content spans px x in [60,760], y in [70,600]. At
 * PX_TO_M = 0.8 that lands inside a 560 m world with a forest margin all round,
 * which puts a landmark-to-landmark walk at roughly 40-90 s — long enough to
 * lose your bearings, short enough that a wrong turn is not a punishment.
 */

export interface Vec2 { x: number; z: number; }

export const WORLD_SIZE = 560;
export const PX_TO_M = 0.8;
const ORIGIN_PX = { x: 400, y: 340 };

export function pxToWorld(px: number, py: number): Vec2 {
  return { x: (px - ORIGIN_PX.x) * PX_TO_M, z: (py - ORIGIN_PX.y) * PX_TO_M };
}
export function worldToPx(x: number, z: number): { px: number; py: number } {
  return { px: x / PX_TO_M + ORIGIN_PX.x, py: z / PX_TO_M + ORIGIN_PX.y };
}

/* ── landmarks ──────────────────────────────────────────────────────────────
 * `kind` drives which authored builder runs in MapGenerator; `r` is the
 * clearing radius the heightfield relaxes and the scatter respects; `reveal`
 * is how close the player must get for the map UI to mark it discovered.
 * `beacon` marks the landmarks that must stay readable from far away — they
 * get vertical silhouette and are exempted from canopy occlusion. */
export type LandmarkKind =
  | 'ridge' | 'quarry' | 'cabin' | 'clearing' | 'rocks'
  | 'tower' | 'camp' | 'lake' | 'dock' | 'shack' | 'trailhead' | 'hub';

export interface PinewoodLandmark {
  id: string;
  name: string;
  px: [number, number];
  x: number; z: number;
  r: number;
  kind: LandmarkKind;
  reveal: number;
  beacon: boolean;
  /** survey-note line surfaced on the map UI once discovered */
  note: string;
}

function lm(
  id: string, name: string, px: [number, number], r: number,
  kind: LandmarkKind, reveal: number, beacon: boolean, note: string,
): PinewoodLandmark {
  const w = pxToWorld(px[0], px[1]);
  return { id, name, px, x: w.x, z: w.z, r, kind, reveal, beacon, note };
}

/**
 * Anchors read straight off the map's icons (not its text labels — the labels
 * are offset from what they name, which is exactly the kind of drift that
 * makes a map feel hand-drawn and a game world feel wrong).
 */
export const LANDMARKS: PinewoodLandmark[] = [
  lm('ridge', 'North Ridge', [378, 95], 30, 'ridge', 46, true,
    'Highest ground on the survey. Sightlines south over the whole basin.'),
  lm('quarry', 'Old Quarry', [205, 168], 46, 'quarry', 52, true,
    'Disused excavation. Benched walls, standing water, plant left where it died.'),
  lm('cabin', 'Cabin', [518, 157], 22, 'cabin', 34, false,
    'Single-room structure, north-east stand. Porch lamp still drawing current.'),
  lm('clearing', 'Clearing', [420, 238], 30, 'clearing', 38, false,
    'Windthrow gap. Open sky, no cover — the crossroads of the north trails.'),
  lm('rocks', 'Rock Formation', [530, 278], 34, 'rocks', 44, true,
    'Granite outcrop breaking the canopy. Climbable shelves, deep clefts.'),
  lm('tower', 'Watchtower', [307, 314], 20, 'tower', 60, true,
    'Fire lookout. Ladder intact to the cab. Visible from most of the basin.'),
  lm('camp', 'Campground', [259, 444], 30, 'camp', 40, false,
    'Abandoned mid-season. Tents still pitched, fire ring cold.'),
  lm('lake', 'Pine Lake', [399, 480], 54, 'lake', 62, true,
    'Standing water filling the basin floor. Reed shallows on the west arm.'),
  lm('dock', 'South Dock', [388, 552], 18, 'dock', 30, false,
    'Timber pier running out over the south shallows. Boards rotted through.'),
  lm('shack', 'Abandoned Shack', [592, 488], 16, 'shack', 28, false,
    'Collapsing outbuilding east of the lake. Door barred from the inside.'),
  lm('hub', 'Trail Junction', [388, 340], 16, 'hub', 26, false,
    'Five-way junction at the centre of the survey. Signpost, notice board.'),
  lm('east-trail', 'East Trail', [706, 336], 18, 'trailhead', 40, false,
    'Marked route out of the survey area, eastbound.'),
  lm('west-trail', 'West Trail', [126, 470], 18, 'trailhead', 40, false,
    'Marked route out of the survey area, westbound.'),
];

export function landmark(id: string): PinewoodLandmark {
  const l = LANDMARKS.find(v => v.id === id);
  if (!l) throw new Error(`PinewoodLayout: unknown landmark '${id}'`);
  return l;
}

/** Player marker on the supplied map: just south of the central junction. */
export const SPAWN_PX: [number, number] = [392.5, 334.5];
/** Both trailheads are valid escapes; East is the primary objective. */
export const EXIT_ID = 'east-trail';
export const ALT_EXIT_ID = 'west-trail';

/* ── Pine Lake shoreline ────────────────────────────────────────────────────
 * Traced from the map raster (skimage find_contours over a closed+filled
 * water mask). Deliberately kept as a polygon rather than a circle: the
 * irregular west arm and the pinched south end are what make the lake read as
 * a real basin, and they give the shore trail its awkward, interesting turns. */
const LAKE_PX: [number, number][] = [
  [367.0, 537.5], [357.5, 533.0], [349.5, 527.0], [341.0, 521.5], [333.0, 515.5],
  [325.5, 508.0], [323.5, 496.0], [323.5, 482.0], [331.5, 476.0], [337.5, 468.0],
  [342.0, 457.5], [346.0, 447.5], [352.0, 439.5], [362.0, 435.5], [370.0, 441.5],
  [383.0, 443.5], [393.5, 440.0], [403.5, 436.0], [411.5, 430.0], [413.5, 418.0],
  [422.0, 411.5], [436.0, 411.5], [447.5, 414.0], [453.5, 422.0], [453.5, 432.0],
  [455.5, 445.0], [453.5, 457.0], [455.5, 469.0], [458.0, 480.5], [459.5, 493.0],
  [459.5, 508.0], [459.5, 522.0], [453.0, 529.5], [441.0, 531.5], [429.0, 529.5],
  [417.0, 526.5], [406.0, 523.5], [394.0, 521.5], [382.0, 523.5], [372.0, 527.5],
];

export const LAKE_SHORE: Vec2[] = LAKE_PX.map(p => pxToWorld(p[0], p[1]));
/** Water plane elevation. The basin floor is cut below this in HeightField. */
export const LAKE_Y = -4.2;

/* ── Old Quarry rim ─────────────────────────────────────────────────────────
 * The map shows an irregular crater roughly px x 140-265, y 115-215. Authored
 * as a noisy polygon so the excavation has lobes and a spoil-side breach
 * rather than reading as a drilled hole. */
export function buildQuarryRim(rng: SeededRandom): Vec2[] {
  const c = landmark('quarry');
  const pts: Vec2[] = [];
  const N = 26;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    // lobed radius: two-lobe base + fbm wander, widest to the north-west
    const lobe = 1 + 0.17 * Math.cos(a * 2 + 0.7) + 0.09 * Math.cos(a * 3 - 1.4);
    const n = rng.noise1(i * 0.61) * 0.14;
    const r = 42 * lobe * (1 + n);
    pts.push({ x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r * 0.86 });
  }
  return pts;
}
/** The haul ramp: the one place the quarry floor is reachable on foot. */
export const QUARRY_RAMP_PX: [number, number][] = [
  [243, 196], [230, 186], [219, 178], [211, 172],
];
export const QUARRY_FLOOR_DEPTH = 15.5;

/* ── path network ───────────────────────────────────────────────────────────
 * Authored as pixel control polylines straight off the traced path mask, then
 * Catmull-Rom resampled with perpendicular noise. `main` = graded survey road
 * (wide, walkable, cleared), `trail` = boot-worn path, `faint` = the dashed
 * routes on the map and the shortcuts the survey never recorded.
 *
 * The topology is a genuine graph, not a corridor: two loops (lake ring, and
 * clearing/cabin/rocks), a spur to the quarry, a spur to the shack, two
 * trailhead exits and three shortcuts. That means a wrong turn puts you
 * somewhere else you recognise instead of into a wall. */
export type PathClass = 'main' | 'trail' | 'faint';

interface PathSpec {
  id: string;
  cls: PathClass;
  /** pixel control points */
  ctl: [number, number][];
  /** metres of cleared half-width */
  width: number;
  /** perpendicular wander amplitude (m); 0 for the graded road sections */
  wander?: number;
}

const PATH_SPECS: PathSpec[] = [
  /* ── the north spine: junction -> clearing -> ridge ── */
  { id: 'hub-clearing', cls: 'main', width: 2.6, wander: 3.4,
    ctl: [[388, 340], [390, 320], [387, 300], [392, 278], [404, 258], [418, 242]] },
  { id: 'clearing-ridge', cls: 'trail', width: 2.0, wander: 4.2,
    ctl: [[418, 236], [408, 210], [396, 180], [388, 148], [382, 118], [378, 98]] },

  /* ── quarry approach: west off the clearing, along the crater's south lip ── */
  { id: 'clearing-quarry', cls: 'main', width: 2.5, wander: 4.6,
    ctl: [[412, 240], [372, 224], [330, 212], [296, 206], [266, 206], [243, 198]] },
  { id: 'quarry-ramp', cls: 'trail', width: 1.9, wander: 1.6, ctl: QUARRY_RAMP_PX },
  /* the spoil track skirting the crater's north rim — a real alternate route
   * back to the ridge trail, and the only way to see the quarry from above */
  { id: 'quarry-rim', cls: 'faint', width: 1.5, wander: 5.0,
    ctl: [[250, 190], [222, 158], [204, 128], [230, 112], [278, 116], [330, 140], [368, 158], [384, 164]] },

  /* ── the north-east loop: clearing -> cabin -> rocks -> back south ── */
  { id: 'clearing-cabin', cls: 'main', width: 2.4, wander: 3.8,
    ctl: [[424, 232], [454, 208], [482, 190], [508, 178], [520, 166]] },
  { id: 'cabin-rocks', cls: 'trail', width: 2.0, wander: 4.4,
    ctl: [[522, 172], [532, 198], [548, 224], [560, 250], [552, 272]] },
  { id: 'rocks-junction', cls: 'trail', width: 2.0, wander: 3.6,
    ctl: [[548, 284], [568, 302], [598, 316], [622, 322]] },
  /* the shortcut that skips the cabin — steeper, tighter, no landmarks */
  { id: 'clearing-rocks-cut', cls: 'faint', width: 1.4, wander: 5.5,
    ctl: [[430, 246], [458, 262], [486, 276], [512, 282]] },

  /* ── east trailhead (dashed on the map) ── */
  { id: 'east-trail', cls: 'faint', width: 1.8, wander: 3.0,
    ctl: [[624, 324], [652, 330], [680, 334], [706, 336]] },
  /* junction back down to the hub, closing the eastern loop */
  { id: 'rocks-hub', cls: 'trail', width: 2.1, wander: 4.8,
    ctl: [[540, 300], [508, 322], [472, 340], [436, 344], [402, 342]] },

  /* ── watchtower: the dashed west spur off the junction ── */
  { id: 'hub-tower', cls: 'faint', width: 1.7, wander: 3.4,
    ctl: [[380, 340], [356, 332], [332, 326], [312, 318]] },
  /* the tower also sits on the campground trail — that is what makes it
   * useful for navigation instead of a dead end */
  { id: 'tower-camp', cls: 'trail', width: 1.9, wander: 5.2,
    ctl: [[304, 324], [292, 352], [280, 384], [268, 414], [260, 438]] },

  /* ── campground -> west trailhead + down to the lake's west arm ── */
  { id: 'camp-west-trail', cls: 'faint', width: 1.7, wander: 3.2,
    ctl: [[244, 442], [212, 448], [176, 458], [148, 464], [126, 470]] },
  { id: 'camp-lake-west', cls: 'trail', width: 1.9, wander: 4.6,
    ctl: [[258, 456], [252, 486], [248, 512], [262, 534], [288, 548]] },

  /* ── Pine Lake ring: the loop that teaches the basin ── */
  { id: 'lake-north', cls: 'trail', width: 2.0, wander: 4.0,
    ctl: [[398, 342], [396, 366], [392, 388], [382, 404], [366, 420], [352, 432]] },
  { id: 'lake-west', cls: 'trail', width: 1.8, wander: 4.4,
    ctl: [[350, 434], [332, 452], [318, 478], [312, 502], [320, 524], [340, 542]] },
  { id: 'lake-south', cls: 'trail', width: 2.0, wander: 3.8,
    ctl: [[340, 546], [366, 556], [392, 560], [420, 556], [446, 546], [466, 530]] },
  { id: 'lake-east', cls: 'trail', width: 1.8, wander: 4.2,
    ctl: [[468, 528], [478, 500], [478, 470], [470, 440], [458, 418], [446, 406]] },
  { id: 'lake-northeast', cls: 'faint', width: 1.4, wander: 4.0,
    ctl: [[446, 402], [432, 384], [416, 362], [404, 346]] },

  /* ── south dock: the pier walk ── */
  { id: 'dock-approach', cls: 'trail', width: 2.2, wander: 1.4,
    ctl: [[390, 558], [389, 546], [388, 532], [388, 518]] },

  /* ── the shack spur, hanging off the lake's east shore ── */
  { id: 'shack-spur', cls: 'faint', width: 1.4, wander: 5.0,
    ctl: [[478, 486], [512, 480], [548, 482], [578, 486], [592, 490]] },
  /* and the overgrown line north from the shack that rejoins the east loop —
   * marked on the map, barely there on the ground */
  { id: 'shack-north', cls: 'faint', width: 1.2, wander: 6.0,
    ctl: [[594, 480], [604, 448], [608, 412], [604, 372], [598, 336]] },
];

export interface PathEdge {
  id: string;
  cls: PathClass;
  width: number;
  pts: Vec2[];
}

/**
 * Resample a control polyline into a smooth, wandering world-space path.
 * The perpendicular noise is what stops the network reading as level-design
 * corridors: no segment runs dead straight, and the wander is coherent along
 * the path rather than per-point jitter.
 */
function resample(spec: PathSpec, rng: SeededRandom): Vec2[] {
  const c = spec.ctl.map(p => pxToWorld(p[0], p[1]));
  if (c.length < 2) return c;
  const out: Vec2[] = [];
  const amp = spec.wander ?? 0;
  for (let i = 0; i < c.length - 1; i++) {
    const a = c[i], b = c[i + 1];
    const p0 = c[Math.max(0, i - 1)];
    const p3 = c[Math.min(c.length - 1, i + 2)];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(2, Math.round(seg / 6));
    for (let s = 0; s < steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      const cx = 0.5 * ((2 * a.x) + (-p0.x + b.x) * t
        + (2 * p0.x - 5 * a.x + 4 * b.x - p3.x) * t2
        + (-p0.x + 3 * a.x - 3 * b.x + p3.x) * t3);
      const cz = 0.5 * ((2 * a.z) + (-p0.z + b.z) * t
        + (2 * p0.z - 5 * a.z + 4 * b.z - p3.z) * t2
        + (-p0.z + 3 * a.z - 3 * b.z + p3.z) * t3);
      const dx = b.x - a.x, dz = b.z - a.z;
      const pl = Math.hypot(dx, dz) || 1;
      // two octaves of coherent wander so the curve has both sweep and kink
      const w = amp * (rng.noise1(i * 3.1 + t * 1.7) * 0.75
        + rng.noise1(i * 9.7 + t * 5.3) * 0.25);
      out.push({ x: cx - (dz / pl) * w, z: cz + (dx / pl) * w });
    }
  }
  out.push(c[c.length - 1]);
  return out;
}

export function buildPathNetwork(rng: SeededRandom): PathEdge[] {
  return PATH_SPECS.map(s => ({
    id: s.id, cls: s.cls, width: s.width, pts: resample(s, rng.fork(hash(s.id))),
  }));
}

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h >>> 0;
}

/* ── the creek ─────────────────────────────────────────────────────────────
 * Watershed logic, not decoration: the north is high and the lake basin is
 * low, so water runs north-to-south. The creek springs on the quarry's east
 * flank, drops over the ridge break, threads the valley west of the junction
 * and feeds Pine Lake's west arm. Crossing it is a navigation cue — if the
 * water is on your right you are walking south. */
export const CREEK_CTL_PX: [number, number][] = [
  [352, 150], [344, 186], [338, 222], [344, 258], [352, 292],
  [346, 326], [336, 360], [330, 394], [332, 424], [338, 452], [344, 468],
];

/* ── page / evidence anchors ────────────────────────────────────────────────
 * Five are marked on the supplied map; three more are authored at the places
 * the map implies but does not draw (the quarry floor, the tower cab, the
 * dock head). `hint` is the diegetic line the map UI shows for an uncollected
 * page once its region is explored — navigation help without a quest arrow. */
export interface PageAnchor {
  id: string;
  px: [number, number];
  x: number; z: number;
  near: string;
  /** height offset above ground — for pages pinned to structures */
  dy: number;
  hint: string;
}

function page(id: string, px: [number, number], near: string, dy: number, hint: string): PageAnchor {
  const w = pxToWorld(px[0], px[1]);
  return { id, px, x: w.x, z: w.z, near, dy, hint };
}

export const PAGE_ANCHORS: PageAnchor[] = [
  page('p1', [382, 184], 'ridge', 1.15, 'Pinned to a trail marker on the ridge approach.'),
  page('p2', [446, 158], 'cabin', 1.05, 'Caught in the deadfall west of the cabin.'),
  page('p3', [351, 281], 'hub', 1.10, 'Nailed to the notice board north of the junction.'),
  page('p4', [205, 399], 'camp', 1.00, 'In the trees between the tower trail and the camp.'),
  page('p5', [518, 438], 'shack', 1.05, 'Weighted under a stone on the shack spur.'),
  page('p6', [214, 172], 'quarry', 0.95, 'Down on the quarry floor, by the dead plant.'),
  page('p7', [307, 312], 'tower', 9.60, 'Up in the lookout cab.'),
  page('p8', [388, 552], 'dock', 1.05, 'At the end of the dock, past the broken boards.'),
];

/* ── geometry helpers shared by terrain, collision, nav and the map UI ───── */

/** signed distance to a closed polygon: negative inside, positive outside */
export function polySdf(poly: Vec2[], x: number, z: number): number {
  let d = Infinity;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    const ex = b.x - a.x, ez = b.z - a.z;
    const wx = x - a.x, wz = z - a.z;
    const len2 = ex * ex + ez * ez || 1;
    let u = (wx * ex + wz * ez) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const cx = wx - ex * u, cz = wz - ez * u;
    const dd = cx * cx + cz * cz;
    if (dd < d) d = dd;
    if ((a.z > z) !== (b.z > z) && x < a.x + ((z - a.z) / (b.z - a.z)) * (b.x - a.x)) {
      inside = !inside;
    }
  }
  return (inside ? -1 : 1) * Math.sqrt(d);
}

export function polyCentroid(poly: Vec2[]): Vec2 {
  let x = 0, z = 0;
  for (const p of poly) { x += p.x; z += p.z; }
  return { x: x / poly.length, z: z / poly.length };
}
