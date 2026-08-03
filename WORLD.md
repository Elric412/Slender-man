# WORLD — environment & forest craft

Companion to `DECISIONS.md`, scoped to the world: what was wrong with the
first forest, what replaced it, and the rules that keep it from regressing.

---

## 0. Diagnosis (measured against the old code, not guessed)

The complaint was "the same tree planted a few feet away". All five root
causes named in the brief were present. Line references are to the code as it
stood before this pass.

### 0.1 Too few source variants — **confirmed**

`VegetationSystem.build()` built exactly **5 trunk geometries and 5 foliage
geometries for the entire map**:

```ts
const archetypes = [
  { geo: this.makePine(false, 0) ... },   // pine A
  { geo: this.makePine(false, 1) ... },   // pine B  ← same function, different seed
  { geo: this.makePine(true,  2) ... },   // dead husk
  { geo: this.makeBroadleaf(3) ... },
  { geo: this.makeBirch(4) ... },
];
```

Archetypes 0 and 1 are the *same generator* with a different fork seed, and
`arch = ... : crng.int(0, 1)` means roughly 70% of all trees on the map were
one of **two** pine silhouettes. Variants per archetype: **zero**. Every
instance of archetype 0 was byte-identical geometry — literally the same tree,
rotated and scaled.

### 0.2 Uniform / jittered-grid scatter — **confirmed**

```ts
for (cj) for (ci) {                       // 70 m cells
  const count = crng.int(36, 58);         // ← same count everywhere
  for (k < count) {
    const x = cx + crng.range(2, chunk - 2);   // ← uniform random in cell
```

That is grid-plus-jitter with a fixed per-cell population: **every 70 m cell on
the map received 36–58 trees regardless of terrain, zone, or ecology.** The
only density modulation was a single binary rejection
(`if (density < -0.25 && trailD > 8) continue`), which punches occasional holes
but never changes the *character* of density.

### 0.3 No clustering — **confirmed**

Every instance was drawn independently from a uniform distribution inside its
cell. Nothing correlated one tree's position with its neighbours', so the
forest had the statistical texture of TV static — the most "procedural"
possible arrangement, and the exact opposite of how stands of trees grow.

### 0.4 No zone variation — **confirmed**

Species selection was a single global rule evaluated identically at every point
on the 420 × 420 m map:

```ts
const isBirch = birchNoise > 0.34;
const dead = !isBirch && crng.next() < 0.16;   // 16% dead, everywhere
```

`HeightField.zoneAt()` existed but returned only **POI clearing circles**, used
for *exclusion*. There was no ecological zoning at all: one density, one
species mix, one ground texture, one fog treatment, map-wide.

### 0.5 No hand authorship — **confirmed**

`buildTrailDressing()` was the entire authored layer: four fallen logs at
fractional trail indices, one footbridge, nine shell casings. No unique
landmarks, no one-off set-pieces, no framed views, nothing deliberately placed
at a tension beat.

### 0.6 Additional defects found while diagnosing

- **Ground plane less varied than the canopy** — 1 rock geometry, 1 fern card,
  1 grass card for the whole map (§12 explicitly forbids this).
- **No vertical layering** — one canopy height band, no interlocking crowns, no
  climbing growth, no hanging moss, no fern/moss floor stratum.
- **No water beyond a flat lake disc** — no creek, no flow, no waterfall, no
  running-water audio, no mud footprint.
- **No incidental structures** — the 8 POIs were the only built history.
- **Draw-call shape** — one `InstancedMesh` pair per (archetype, chunk) with no
  LOD tier: at `high` (220 m draw distance) essentially all 36 chunks stayed
  resident, ~360 tree draws and ~1.6 M triangles of *full-detail* trees, most of
  them fog-obscured.

---

## 1. What replaced it

| Old | New |
| --- | --- |
| 5 tree geometries | **7 archetypes × 5 variants = 35 tree geometries** (+ 5 hero landmark trees) |
| jittered grid, fixed count/cell | **rule-based density field + Poisson-ish cluster seeding** |
| independent placement | **stand/clump placement** with irregular inter-cluster gaps |
| one global species rule | **7 ecological zones** with own mix, density, palette, condition, fog |
| 1 rock / 1 fern / 1 tuft | **rock ×6, fern ×5, moss ×4, log ×5, stump ×4, undergrowth ×6, fungi ×4** |
| flat canopy | **4 vertical strata** — floor, understory, climbing/hanging, closed canopy |
| flat lake disc | **flowing creek + ravine + waterfall + rapids + mud + mist + spatial audio** |
| 8 POIs only | **8 POIs + 6 incidental structures + 7 unique landmarks** |
| 360 tree draws / 1.6 M tris | **2-tier chunk LOD** — see §5 |

---

## 2. Zone identities (`src/world/ZoneSystem.ts`)

Seven zones, each a *character* with its own density, species mix, condition
distribution, ground treatment, canopy closure, climbing growth, moisture and
fog. Baked once at boot into a 160 × 160 field grid (2.6 m cells) so per-instance
lookup during scatter is a single array read, not a polyline walk.

| Zone | Identity | Density | Signature |
| --- | --- | --- | --- |
| `oldGrowth` | ancient, cathedral-like, around the ranger station | low count / huge scale | tallest conifers, interlocking crowns, bare floor, long sightlines |
| `thicket` | young regrowth choking the gaps between POIs | highest | tight spacing, understory saplings, fern walls, no sightlines |
| `stormFall` | blown-down stand around the quarry | low | snapped crowns, root plates, exposed rock, direct moonlight |
| `marsh` | saturated lowland at the lake and dock | medium | water-tolerant alder, reeds, moss carpet, heaviest mist |
| `ravine` | the creek corridor — lushest, dampest | medium-high | closed canopy, vines, hanging moss, fern beds, mud, water audio |
| `blight` | small, deliberately wrong dead patch | medium | bare grey trunks, zero undergrowth, no fog motion, no life |
| `dryUpland` | default ridgeline / high ground | lowest | wind-stunted pines, lichen rock, dry grass, thin canopy |

Zone weight is a *blend*, not a hard cell assignment: each field sample carries
weights for all seven and the dominant one names the place, so transitions are
gradients tens of metres wide rather than visible seams.

---

## 3. Scatter rules (`src/world/ScatterSystem.ts`)

Placement is no longer "pick a random point". Each candidate must survive an
ordered set of real environmental constraints, and candidates are *generated in
clusters*, not independently:

1. **Cluster seeding.** Per chunk, N stand seeds are drawn against the zone's
   `clusterRate`. Each seed grows a clump of 3–24 members with a radius drawn
   from the zone's `clusterRadius`, members distributed with a falloff toward
   the rim (so clumps have dense cores and ragged edges). Gaps between clumps
   are *emergent*, not carved.
2. **Density field.** `zone.density × fbm(0.011) × fbm(0.037)` — a two-octave
   product, so density varies at both stand scale (~90 m) and clump scale
   (~27 m).
3. **Slope.** Rejected above the archetype's `maxSlope`; large conifers refuse
   steeper ground than saplings do.
4. **Moisture / elevation.** Derived from creek distance, lake distance,
   hollowness and absolute height. Alder and hemlock require moisture; upland
   pine is penalised by it.
5. **Canopy proximity.** Understory archetypes get a *bonus* near a canopy tree
   and a *penalty* directly under the densest crowns — resolved by a real
   occupancy grid populated in placement order (canopy strata first).
6. **Exclusion volumes.** Trail corridor, POI clearings, building footprints,
   creek channel, landmark reservations and incidental-structure plots are
   registered as volumes; nothing spawns inside one.
7. **Per-instance jitter** — rotation, non-uniform scale, lean, health tint —
   applied *last*, explicitly as a finishing touch rather than the variety
   mechanism.

---

## 4. Material & texture quality (`src/world/MaterialLibrary.ts`)

Against the §10 defect list:

- **Triplanar world-space detail** (`triplanarDetailPatch`) on every large or
  irregular surface — cliff faces, building walls, the fallen giant, big
  trunks — eliminates stretched/repeating UVs and restores texel density at
  close flashlight range independent of the atlas tile budget.
- **Layered masks** (`layeredGrowthPatch`) — base material, then moss/lichen by
  world up-facing × height × noise, then grime by cavity/curvature — so nothing
  is uniformly aged or uniformly clean. Growth follows geometry, not UVs.
- **Edge wear** (`edgeWearPatch`) — curvature-driven roughness drop and albedo
  lift on hard-surface assets so edges catch light instead of reading as flat
  CG boxes.
- **Roughness variation** — every surface's roughness comes from its ORM map
  with worn/protected and damp/dry variation baked in; no material ships a
  single flat roughness scalar.
- **Texel density tiering** — hero/path-adjacent assets get the 512² atlas tile
  plus triplanar detail; background fill deliberately carries less.

---

## 5. Render budget

Trees are now **two-tier per chunk**:

- **near tier** (chunk within `nearRange`): full-detail `InstancedMesh` per
  (archetype, variant) actually present in that chunk. Trunk and foliage are
  merged into one geometry against a shared atlas material, which halves the
  mesh count versus the old trunk+foliage split.
- **far tier**: one *merged* low-poly stand-in geometry for every tree in the
  chunk — 1 draw call, ~8× fewer triangles per tree.

Floor detail (ferns, moss, fungi, litter cards) is **merged per chunk** into a
single geometry with a baked sway-weight attribute, so an entire chunk of
undergrowth is one draw call instead of three instanced meshes.

Net effect versus the old system at `high`: far fewer tree draws, far fewer
resident triangles, and **35 tree variants instead of 5**.

---

## 6. Non-repetition safeguards (`audit.mjs`)

Two automated checks, run against the production build:

1. **Silhouette uniqueness** — from fixed camera stations along the main path,
   query every vegetation instance inside the view frustum and assert no single
   `(archetype, variant)` geometry appears more than once in the same view.
   A failure is reported as a placement-density or variant-count bug.
2. **Zone-transition perceptibility** — walk the main path in ~20 m steps,
   sample the dominant zone and its field values at each station, and assert no
   two consecutive stations are the same place.
