# STATIC — Engine Architecture Pass

**Status:** design accepted, implementation staged (see §10 for the ledger)
**Scope:** architecture, not bug-fixing. Renderer, frame scheduling, world streaming,
adaptive quality, and the information flow between them.
**Baseline commit:** `62bce36`
**Codebase at time of read:** ~25.8k lines TypeScript across 50 source files, `three` as the
only runtime dependency.

---

## 0. How this brief was measured

The authoring environment is a 2-core / 985 MB Linux sandbox with no GPU. Running the game
there is not possible — a software rasteriser at 400×240 crashes the page before the title
screen resolves. Any frame-time number produced under SwiftShader would describe the
rasteriser, not this engine, so **no GPU-side timings appear in this document.**

Everything quantified below is *hardware-independent* and therefore actually portable:

| Class of measurement | How obtained | Trustworthy? |
| --- | --- | --- |
| CPU world-build cost | `npm run bench:world` — real `HeightField`/`ZoneSystem`/`NavWorld` in Node, no GPU | yes |
| Query throughput (`heightAt`, `losClear`, A*) | same harness, 200k/4k/200 iterations | yes, modulo CPU |
| Draw-call and pass counts | static read of `RenderPipeline.render()` and the scene graph | exact |
| Render-target bytes | static computation from `makeRT` calls × format × resolution | exact |
| Per-frame allocation sites | static read of hot loops | exact |
| Bundle size / module count | `npm run build` | exact |
| Frame time, GPU ms, thermals | **not measured** | — |

Measured baseline, this sandbox (2 cores, no GPU):

```
heightfield            572.1 ms
zones                  146.1 ms
collision                0.1 ms
nav                     31.5 ms
total build            749.7 ms
heightAt throughput    11.85 M/s   (84 ns/call)
losClear throughput     1550 k/s   (0.6 us/call)
A* findPath              0.50 ms/query
heap after build        10.0 MB
```

Bundle baseline: `index` 439.72 kB (140.92 kB gzip) + `three` 510.93 kB (128.73 kB gzip),
53 modules, 3.93 s cold build.

Two things fall out of this immediately, and they shape the whole proposal:

1. **`heightAt` at 84 ns/call is the hottest function in the engine** and every other system
   is built on it. 572 ms of the 750 ms world build is heightfield construction. This is
   pure ALU on the main thread during boot — a textbook worker candidate, and it is *not*
   a renderer problem at all.
2. **A* at 0.50 ms/query is 3.6% of a 60 Hz frame budget for a single path request.** The
   AI currently repaths on its own schedule with no budget authority above it. One
   unlucky frame with a repath plus a chunk merge plus a shader compile is a visible hitch,
   and nothing in the current architecture can see that collision coming.

---

## 1. Problems and bottlenecks in the current architecture

Ordered by architectural severity, not by how easy they are to fix.

### 1.1 There are four separate, disagreeing performance-state stores

- `GameLoop.samples` — a 240-entry ring of frame `dt`, plus `updateMsEma` / `renderMsEma`.
- `RenderPipeline.gpuStats` + its private `frameCostEma` — draw calls, triangles, GPU ms
  via `EXT_disjoint_timer_query_webgl2`, and the EMA that drives `adaptResolution`.
- `StaticGame.prof` — a per-system EMA map (`player`, `tapes`, `entity`, `rig`, `fear`,
  `env`, `audio`, `hud`).
- `StaticGame.bootTimes` — a boot-stage map, write-only, with no read hook.

No component can see the others. The consequence is not untidiness, it is **wrong
decisions**: `RenderPipeline.adaptResolution()` reduces internal resolution when the *CPU*
frame time crosses 19.5 ms. If the frame is long because A* ran, or because a chunk merge
uploaded 1M vertices, or because the tab just came back from background, resolution drops
anyway — reducing GPU work that was never the problem, and degrading the image for free.
Conversely, a genuinely GPU-bound frame on a machine with a fast CPU is invisible to the
controller until the GPU stalls the CPU at swap.

There is also no P99, no variance measure, and `GameLoop.stats()` does
`this.samples.slice(0, n).sort()` **on every call** — an allocation plus an O(n log n) sort
per frame, because the HUD calls it per frame. The performance-measurement system is itself
a per-frame allocation site in violation of the project's own hot-loop rule.

### 1.2 Quality is four hardcoded presets, and the adaptive layer has two knobs

`QUALITY_SPECS` in `src/core/Config.ts` is `Record<QualityTier, QualitySpec>` — 4 tiers ×
20 fields of hand-tuned constants. `probeQuality()` picks one at boot from GPU string, core
count and `deviceMemory`. After that, the only things that ever move at runtime are:

- `RenderPipeline.renderScale`, between `minScale = 0.55` and `maxScale`;
- an `effort` scalar that degrades AO/volumetric sample counts.

Everything else — shadow map size, vegetation draw distance, particle budget, fog wisps,
dust count, AO directions, volumetric steps, post-pass enables, texture anisotropy — is
frozen at boot for the entire session. A laptop that thermally throttles after eight minutes
gets exactly one response: a blurrier image. A phone that could afford volumetrics while
standing in a clearing but not in dense canopy gets the same setting in both.

The brief asks for continuous adaptive quality. The current design cannot express it,
because quality *is* a struct of discrete constants rather than a function of a budget.

### 1.3 The render pipeline allocates eagerly and executes a hardcoded sequence

`RenderPipeline` owns ~18 named render targets as direct fields: `sceneRT`, `depthTex`,
`aoRT`, `aoHistA/B`, `volRT`, `volHistA/B`, `taaA/B`, `motionRT`, `veilA/B`,
`bloomDown[4]`, `bloomUp[4]`, `streakRT`, `expA/B`. `resize()` allocates every target
belonging to every *enabled* feature, immediately, and `disposeTargets()` frees them all on
any resize.

Two structural problems:

- **Peak memory equals the sum of all features, not the maximum concurrent live set.**
  `aoRT` is dead the instant `aoResolve` has run. `volRT` is dead after `volResolve`.
  `motionRT` is written once and read once. `bloomDown[]` and `veilA/B` never coexist with
  the AO working set. At 1920×1080 with `renderScale` 1.0 these targets are a real
  multi-megabyte figure that could be roughly halved by aliasing alone, and on mobile GPU
  memory is the binding constraint far more often than fill rate.
- **Turning a feature off does not reclaim its memory unless a resize happens**, and
  turning one on mid-session cannot happen at all without a full teardown. That is
  precisely the operation continuous adaptive quality needs to perform constantly.

And `render()` is a 250-line straight-line sequence of `if (enabled.x)` blocks with the
inter-pass wiring written by hand. Adding a pass means editing the middle of that function
and manually re-deriving which target now feeds which sampler. Reordering is effectively
impossible. This is the classic case for a render graph — and notably, a render graph is
*not* `EffectComposer` (which the project rules forbid, correctly: `EffectComposer`
ping-pongs full-res LDR buffers and cannot express the shared-HDR-plus-depth topology this
pipeline depends on).

### 1.4 The frame loop has no scheduler and no fixed timestep

`GameLoop.start()` computes `dt`, clamps at 0.1 s, and calls every registered update
function every frame in registration order. `StaticGame.update()` is then a ~200-line
monolith running, unconditionally and at full rate: input poll, player physics, flashlight,
tapes, entity brain, entity rig, proximity tell, fear, wind, map update, vegetation draw
distance, scatter viewer update, practicals, effects, sky, moon shadow follow, the full
audio parameter push, then HUD and menu.

Consequences:

1. **Variable-dt physics.** `Player.update(dt, inp, tremor)` integrates with whatever dt
   arrived. At 30 fps versus 144 fps the player accelerates, decelerates and slides
   differently; a 100 ms stall (the clamp ceiling) is a single 100 ms integration step,
   which is how you tunnel through a collider. This is a correctness problem before it is
   a performance problem.
2. **No cadence control.** The AI brain, the audio spatial solve and the practicals update
   all run at display rate. On a 144 Hz monitor the engine does 2.4× the AI work of a 60 Hz
   monitor for zero gameplay benefit. There is no mechanism to say "the entity is 90 m away
   and out of sight, think at 10 Hz".
3. **No admission control.** Chunk merges (`BUILDS_PER_FRAME = 2`), entity texture streaming
   (`streamBudgetMs`), A* repaths and shader compiles are each independently rate-limited by
   their own local constant. Nobody arbitrates between them, so they stack on the same frame.

### 1.5 World streaming is purely reactive

`ScatterSystem.setViewer(camX, camZ, drawDistance)` computes per-chunk distance, assigns a
LOD tier with `LOD_HYST = 12` hysteresis, sets visibility, and pushes needed builds into a
distance-sorted queue drained at 2 per frame.

It uses **position only**. Player velocity is available and ignored. `HeightField.layout.paths`
— an explicit graph of the trails the player is overwhelmingly likely to walk — is available
and ignored. So the system reliably discovers it needs a chunk at the moment the player is
already looking at it, then takes ≥1 frame per merge to produce it, under a
`NEAR_VERT_BUDGET` of 1M vertices that it may first have to evict against. The pop is
structural, not a tuning failure.

There is also **no occlusion culling**. In a dense forest — the single defining feature of
this game's world — the near tier is drawn for every chunk inside `NEAR_RANGE = 78` m
regardless of whether 40 m of intervening trunks make it invisible. `ScatterSystem` already
maintains a 4 m occupancy/canopy field consumed by lighting, audio and AI. That field is
exactly an occlusion oracle and is not used as one.

### 1.6 Per-frame CPU work that should be GPU work or cached work

- **`Sky.ts`** runs `fbm()` — 5 octaves — *twice per fragment, every frame*, on a
  760-radius back-side sphere that fills every pixel not covered by geometry. The sky
  changes on the timescale of the moon, i.e. effectively never within a frame. The engine
  already has `EnvironmentProbe` proving the cubemap-capture path works.
- **`Effects.ts` fireflies** loop over every firefly on the CPU each frame, write positions
  into a `BufferAttribute`, and set `needsUpdate = true` — a full re-upload per frame. The
  fog wisps in the *same file* already do their drift on the GPU. One of the two is wrong.
- **The moon shadow map re-renders the entire static forest every frame.** The forest is
  merged, static geometry. The moon moves slowly and the shadow camera is already
  texel-snapped to reduce shimmer. Between snaps the forest's contribution to that map is
  bit-identical to the previous frame.

### 1.7 Collision hot paths are linear where they should be indexed

`CollisionWorld.nearby(x, z, out)` gathers candidate boxes from a `cell = 8` grid hash and
**dedupes with `out.indexOf(idx)`** — O(n²) in candidate count, on a path called by player
resolve, AI steering *and* audio occlusion. `groundAt()` iterates **all** platforms
linearly. `findVault()` iterates **all** vaultables linearly. These are indexed-structure
problems solved with a stamped-generation array in 10 lines.

### 1.8 Boot is 100% main-thread, and 76% of the world build is one function

572 ms of heightfield, 146 ms of zone bake, plus `MaterialLibrary.create()`'s 11 procedural
texture synthesis steps and `ForestAtlas.build()` — all on the main thread, all pure
typed-array math with no DOM or WebGL dependency until the upload. `MaterialLibrary`
already yields frames cooperatively, which keeps the page responsive but does not make it
faster. `tsconfig` already includes the `WebWorker` lib. Nothing structural prevents this
work from moving off-thread; it simply hasn't been.

### 1.9 The practical-light count is compiled into every shader

`Practicals(poolSize)` fixes the light count at construction, and that count becomes part of
every material's compiled program. Raising it recompiles the world; the cap therefore exists
for shader reasons rather than lighting reasons. This is the standard motivation for
clustered/Forward+ lighting.

### 1.10 Nothing exploits the horror design as a performance lever

This is the largest *missed* opportunity in the codebase, and it is unique to this game.

STATIC's composite pass deliberately destroys image detail: barrel distortion, chromatic
aberration, tape wobble, head-switching, scanlines, static noise, dropout scratches, film
grain, vignette, and a `desat`/`level` static state that rises with fear. The world is
"deep natural darkness" lit by a 62 m flashlight cone of `OUTER_ANGLE = 0.46` rad.

So at any instant, a large fraction of the frame is (a) outside the beam, in near-black,
and (b) about to be buried under noise. The engine renders HBAO, ray-marched volumetrics
and full-resolution shadow detail into those regions at full effort, then throws the result
away in the composite. **Nothing in the architecture knows that.** There is no shared notion
of "how perceptible is this pixel/object right now", even though the flashlight cone,
exposure level and static level — the three inputs that define it — are all already computed
and already flowing through `StaticGame.update()`.

---

## 2. What should be retained

Retained deliberately, with reasons — this codebase gets a lot right and the temptation to
rewrite good work must be resisted.

**The custom HDR forward pipeline, and the refusal of `EffectComposer`.** One shared
HalfFloat HDR target plus a shared `DepthTexture` read by AO, volumetrics, TAA, motion blur
and DOF is the correct topology. `EffectComposer` cannot express it. `DECISIONS.md` is
right; the render graph must preserve this topology, not replace it.

**AgX over ACES.** The choice was made for near-black gradation, and near-black gradation is
this game's entire visual identity. ACES crushes shadow detail into hue-shifted mud exactly
where STATIC lives. Keep.

**The single mega-composite pass.** ~15 effects in one full-resolution pass, sharing one
texture fetch set and one tonemap. Splitting it into "clean" passes would multiply bandwidth
for no visual gain. This is already the "combine expensive effects into fewer passes"
principle the brief asks for. Keep, and extend it rather than adding passes beside it.

**Depth-only HBAO with reconstructed normals.** Avoids a normal G-buffer entirely in a
forward renderer. Drobot closest-neighbour reconstruction plus IGN rotation plus temporal
resolve is the right cost/quality point. Keep.

**GPU auto-exposure via 1×1 reduction with no `readPixels`.** Avoids a pipeline stall
outright. Keep — and *reuse* it: the exposure value is a free perceptibility signal (§6).

**The analytic heightfield as single source of truth.** No collider mesh, closed-form
queries, one definition of the ground shared by physics, nav, scatter, audio and rendering.
At 84 ns/call it is fast enough. This is the best structural decision in the codebase.
Keep — and make more systems depend on it, not fewer.

**Quantised vertex attributes.** Int8 normals, Uint8 colour/tile/sway; 60 → 30 B/vertex.
Halves upload bandwidth and VRAM on the largest geometry in the game. Keep.

**The shared 4 m occupancy/canopy field.** Already read by lighting, audio and AI — the
exact "one system's information eliminates work elsewhere" pattern the brief asks for.
Keep, and add rendering as a fourth consumer (§5.4).

**Audio occlusion reusing `CollisionWorld`.** "Correlation beats fidelity" — a shared
approximation that agrees with gameplay beats two disagreeing accurate ones. Keep.

**`customProgramCacheKey` + named composable shader patches.** Prevents program-cache
collisions between patched variants. This is the mechanism that makes a clustered-lighting
patch safe to add later. Keep.

**Capability probing over UA sniffing.** `deviceMemory`, `hardwareConcurrency`,
`WEBGL_debug_renderer_info`, plus a software-rasteriser pin-down. Correct approach. Keep
the probe; change only what it *produces* (a budget, not a preset — §3.2).

**Two-octave density product for clearings, and the 6 m spacing hash across chunk seams.**
Both are subtle correctness work that a rewrite would silently lose. Keep.

**Milestone/act-gated entity vocabulary and the `CLICHE_BUDGET` rationing.** Design systems,
not performance systems, but they are the reason the game works. Do not disturb.

---

## 3. What should be redesigned

### 3.1 Performance measurement → one unified `PerfSystem`

Four stores collapse into one owner of all frame telemetry: CPU frame time, CPU update/render
split, GPU frame time (`GpuTimer` moves here out of `RenderPipeline`), P50/P95/P99, frame-time
variance and a derived *stability* metric, draw calls, triangles, visible objects, render-target
bytes, JS heap, shader-compile events, asset-load events, device capability, and boot stage
timings.

Design constraints, both non-negotiable:

- **Zero per-frame allocation.** Ring buffers are preallocated `Float32Array`. Percentiles
  come from a fixed-bin histogram updated incrementally — O(1) per sample, no sort, no
  `slice`. This replaces `GameLoop.stats()`'s per-call sort with a per-call bin walk over a
  small constant number of bins.
- **CPU and GPU are attributed separately**, because the entire point is that the quality
  controller must know *which* one is the bottleneck before it chooses a knob. Reducing
  resolution when the CPU is the bottleneck is worse than doing nothing: it costs image
  quality and returns nothing.

### 3.2 Quality → a continuous budget vector

`QualitySpec`'s 20 discrete constants become **derived values** from a small set of
continuous scalars in [0,1]. The four presets survive, demoted from *mechanism* to *seed
values* — `probeQuality()` still picks a starting point, but that point is now a position in
a continuous space the controller can move through.

The controller reads `PerfSystem`, identifies the binding constraint (CPU-bound, GPU-bound,
memory-bound, or unstable/high-variance), and moves the appropriate scalar with asymmetric
rates: **degrade fast, recover slowly.** A player must never see quality oscillate; the cost
of being 5% too conservative for two seconds is nil, the cost of a visible pump is total.

Knobs, in the order the controller should reach for them, cheapest-perceptual-cost first:

1. sample-count effort (AO directions/steps, volumetric steps) — nearly invisible
2. vegetation draw distance and density — invisible in canopy, visible in clearings
3. particle/dust/wisp budgets — invisible under high static
4. shadow resolution — noticeable
5. internal resolution — most noticeable, therefore last for GPU-bound frames
6. post-pass disable — a cliff, therefore only at the extreme

...and on the CPU-bound side, an entirely separate set: AI cadence, audio spatial cadence,
practicals cadence, streaming builds per frame. The current architecture cannot touch any of
these, which is why it always ends up at knob 5.

### 3.3 `RenderPipeline.render()` → a declared render graph

Passes declare their reads and writes against *resource handles* rather than holding target
references. A `TransientPool` allocates by `(width, height, format, filter)` key, hands out
targets on first write, and returns them to the pool at the last read — so `aoRT`, `volRT`,
`motionRT` and the bloom chain **alias the same physical memory** at different points in the
frame. The graph also prunes passes whose outputs no pass reads, which makes feature toggling
free rather than a teardown.

The pass *content* — every shader, every algorithm, the shared HDR + depth topology, the mega
composite — is unchanged. This is a resource-lifetime and sequencing redesign, not a rendering
redesign.

### 3.4 `GameLoop` → fixed-timestep simulation + a cadence scheduler

Fixed 60 Hz accumulator for the player controller and physics, with render-time interpolation
of the camera transform, and a max-steps-per-frame cap so a stall degrades into slow-motion
rather than a death spiral. Everything genuinely frame-rate-native (rendering, TAA jitter,
input sampling) stays on the render tick.

Beside it, a scheduler with named cadence buckets. Each system registers a *desired* Hz and an
*importance* function; the scheduler runs them under a frame budget, and when the budget is
tight it stretches the low-importance buckets first. This is where the AI's 0.50 ms A* stops
landing on the same frame as a 1M-vertex chunk merge.

### 3.5 `ScatterSystem.setViewer()` → predictive, occlusion-aware streaming

Same tier/hysteresis logic, three new inputs:

- **velocity**, to bias the request centre ~1.5 s ahead of the player rather than at them;
- **`layout.paths`**, to pre-warm chunks along the trail graph the player is on, because trail
  topology predicts movement far better than instantaneous velocity does;
- **the occupancy/canopy field**, to skip near-tier builds for chunks the field says are
  occluded — cost that is currently paid for invisible geometry.

### 3.6 `Sky` → change-driven cached capture

Render the sky to a small cubemap, refresh only when the moon direction or cloud phase has
moved past a threshold. Amortises 10 octaves of per-fragment `fbm` across many frames.
`EnvironmentProbe` already demonstrates the capture. The PMREM probe becomes a consumer of
the cached cubemap instead of re-rendering the sky itself.

---

## 4. What should be replaced entirely

Deletion requires a technical reason. Four items qualify.

**`GameLoop.stats()`'s sort-based percentiles.** Replaced by the histogram in `PerfSystem`.
Reason: it allocates and sorts per frame, on the frame-measurement path, in a codebase whose
own rule is zero per-frame allocation in hot loops. It is also incapable of P99 at 240
samples with any stability.

**`RenderPipeline.adaptResolution()`'s two-knob CPU-EMA controller.** Replaced by the quality
controller. Reason: it acts on the wrong signal (CPU time) with the wrong instrument
(resolution) and cannot distinguish the four bottleneck classes. It is not tunable into
correctness; the input is wrong.

**The CPU firefly update loop in `Effects.ts`.** Replaced by GPU drift. Reason: it is a
per-frame full buffer re-upload for motion that is a closed-form function of time, and the
correct implementation already exists 40 lines away in the same file for fog wisps.

**`out.indexOf()` dedupe in `CollisionWorld.nearby()`.** Replaced by a stamped-generation
array. Reason: O(n²) on a path shared by physics, AI and audio.

**`tools/bench.mjs`** (the Playwright browser harness) is retained but demoted and documented
as requiring a real GPU host — it cannot run in the authoring environment. `tools/worldbench.ts`
(`npm run bench:world`) is the harness that actually works everywhere and it is the one wired
into the scripts.

---

## 5. New systems worth introducing

### 5.1 `PerfSystem` — the keystone

Every adaptive decision in the engine reads from here. Nothing else is possible until it
exists. Owns histogram percentiles, EMA smoothing, bottleneck classification, GPU timing,
memory accounting, and a named per-system CPU scope API that replaces `StaticGame.prof`.

### 5.2 `QualityController` — continuous, hysteretic, bottleneck-aware

Consumes `PerfSystem`, produces a live `QualitySpec`-shaped object plus the CPU-side cadence
multipliers. Asymmetric rates, per-knob clamps derived from the seed tier so a low-end device
can never be talked into ultra settings by a lucky quiet moment in a clearing.

### 5.3 `RenderGraph` + `TransientPool`

Resource-handle-based pass declaration, lifetime-driven aliasing, dead-pass pruning,
per-frame byte accounting reported into `PerfSystem` (so memory becomes a bottleneck class
the controller can actually respond to).

### 5.4 `VisibilitySystem` — one culling answer, many consumers

Consolidates: frustum culling, the occupancy-field occlusion test, distance/LOD tier
selection, and the perceptibility score of §6.1. Its output is consumed by rendering (draw or
skip), streaming (build or defer), AI (cheap-think or full-think), and audio (spatial detail).
One culling computation, four consumers — instead of each system doing its own distance test,
which is the current situation.

### 5.5 `Scheduler` — cadence buckets with importance budgets

Per §3.4. Also the natural home for admission control over chunk merges, texture streaming
steps, shader warm-up compiles and A* requests, so those four stop colliding.

### 5.6 Worker-backed procedural synthesis

`HeightField` (572 ms), `ZoneSystem` (146 ms), `MaterialLibrary`'s texture steps and
`ForestAtlas` are pure typed-array math. Moving them to a worker pool sized from
`hardwareConcurrency` cuts time-to-title on multi-core machines and — more importantly —
stops boot from blocking the main thread at all, which is what actually makes a loading
screen feel broken. No new dependency; `tsconfig` already has `WebWorker`.

### 5.7 Static-forest shadow caching

Render the merged forest's shadow contribution once per texel-snap position, then only
re-render dynamic casters. The forest is the overwhelming majority of shadow-map geometry
and it does not move.

### 5.8 Clustered practical lighting

Removes the compiled light-count cap, so `Practicals` becomes a data limit rather than a
shader limit.

---

## 6. Novel / experimental concepts worth prototyping

These are specific to STATIC. They are the ideas I would not propose for a generic engine.

### 6.1 **Perceptibility field** — horror design as an optimisation oracle

The single strongest idea in this pass.

Define, per frame, a cheap scalar field `P(region) ∈ [0,1]`: how much of what we render here
will survive to the player's eye. Its inputs are all already computed:

- **Flashlight cone membership.** `OUTER_ANGLE = 0.46` rad, `RANGE = 62` m, `HOTSPOT_FRAC = 0.34`.
  Inside the hotspot, detail is fully visible. Outside the cone in a moonless forest, the
  player is looking at values a few percent above black.
- **Auto-exposure.** Already reduced to a 1×1 GPU target with no readback. When exposure is
  adapted to a bright beam on near bark, everything outside it is *below the display's
  representable range after AgX*. Rendering AO into it is rendering into a clamp.
- **Static / fear level.** `staticState.level`, `glimpse`, `desat` already flow through
  `update()`. High static means the composite is about to add noise, scratches, wobble and
  desaturation over the frame. The noise floor rises; the detail floor can rise with it, for
  free, and the player cannot tell — because *the game is telling them they cannot tell.*

Consumers: AO effort, volumetric step count, shadow LOD, vegetation tier, particle density,
material tier. The horror aesthetic stops being a cost the renderer pays and becomes a budget
the renderer spends.

This inverts the usual relationship. In most engines, "scary post-processing" is overhead. In
STATIC it should be a **licence to do less work**, applied precisely when the game is most
expensive (high fear = entity near = more dynamic work) and most forgiving (high static =
image is degraded by design). The two curves align perfectly and nothing currently exploits it.

### 6.2 Dread-budget coupling — spend GPU where the Director is spending tension

`Director.ts` already runs a 3-act tension arc with a silence budget and `requestSpend()`
rationing for clichés. That is a *narrative* budget. The proposal: let the same authority
inform the *computational* budget. During a Director-scheduled silence the entity is far, the
AI can think at 5 Hz, the volumetrics can coast on temporal history, and the saved frame time
banks headroom for the confrontation beat the Director has already decided is coming. The
engine gets to prefetch performance because the narrative system knows the future.

### 6.3 Canopy-field occlusion as a two-way oracle

`ScatterSystem`'s 4 m occupancy/canopy field is already shared by lighting, audio and AI.
Used for rendering it gives conservative occlusion without a HiZ pass. But it is also
*two-way*: high canopy occupancy means moonlight is blocked, which means exposure adapts down,
which means §6.1's perceptibility drops, which means less effort — and simultaneously means
fewer visible chunks. Dense forest, the most expensive case, becomes the case with the most
available savings. The field is the shared infrastructure the brief asks for; it just needs
its remaining consumers wired in.

### 6.4 Trail-graph predictive streaming

`layout.paths` is a movement prior far stronger than velocity, because a player on a trail in
a dark forest follows the trail. Prefetch along graph edges ahead of the player, weighted by
branch angle. Cheap, and it targets the exact failure mode reactive streaming has.

### 6.5 Temporal effort dithering

Instead of every pixel getting `effort × full_cost` every frame, give a *subset* of pixels
full effort each frame in an IGN-rotated pattern and let the existing temporal resolve (AO and
volumetrics both already have history buffers and bilateral/variance-clipped resolves)
reconstruct the rest. The machinery is built; only the sampling distribution changes. Quality
degrades as temporal lag under motion rather than as spatial noise — and STATIC already
tolerates temporal lag by design (`DECISIONS.md` accepts TAA ghosting on thin distant
geometry).

---

## 7. Which ideas provide the largest real-world benefit

Ranked by (expected benefit × confidence) ÷ risk. "Benefit" here means the metrics that
actually decide whether a browser game feels good: stutter frequency, time-to-play, peak
memory, and worst-case frame time — not average FPS.

| # | Idea | Benefit | Confidence | Risk | Verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | `PerfSystem` | Enables everything else; removes a per-frame sort/alloc from the measurement path | Certain | Very low | **Do first** |
| 2 | Continuous `QualityController` | Directly addresses the brief; converts one blunt knob into ~10 graded ones; fixes acting on the wrong signal | High | Low | **Do** |
| 3 | Scheduler + fixed timestep | Fixes frame-rate-dependent physics (a correctness bug), removes AI over-execution at high refresh, ends knob collisions | High | Medium (touches gameplay feel) | **Do, carefully** |
| 4 | Perceptibility field (§6.1) | Large GPU savings exactly when the frame is most expensive; unique to this game; nearly free to compute | High | Low | **Do — flagship** |
| 5 | Render graph + transient pool | Roughly halves peak RT memory; makes runtime feature toggling free | Medium-high | Medium | **Do** |
| 6 | Collision hot-path indexing | Removes O(n²) from three systems' shared path | Medium | Very low | **Do — trivial** |
| 7 | Cached sky + GPU fireflies | Deletes 10 octaves/fragment/frame and a per-frame buffer upload | Medium | Very low | **Do** |
| 8 | Predictive/occluded streaming | Attacks the structural pop and wasted invisible near-tier builds | Medium | Low | **Do** |
| 9 | Static shadow caching | Large shadow-pass saving; the forest is most of the casters | Medium-high | Medium (correctness of invalidation) | **Do if time** |
| 10 | Worker synthesis | 750 ms+ off the main thread at boot; big *perceived* win | Medium | Medium-high (structural refactor of asset code) | **Stage last** |
| 11 | Clustered lighting | Removes a cap that isn't currently hurting | Low-medium | Medium | **Defer** |
| 12 | WebGPU renderer | Zero benefit today; three's WebGPU backend cannot express this pipeline without a full port; WebGL2 is universal | Low | **Very high** | **Reject — probe only** |

**On WebGPU specifically**, since the brief asks for it explicitly and with evidence: a
WebGPU-first renderer with WebGL2 fallback means maintaining **two complete implementations**
of a 14-pass custom pipeline with hand-written GLSL, and three's WebGPURenderer wants TSL
node materials rather than `ShaderMaterial` + `onBeforeCompile` patches — which is the exact
mechanism this engine's `MaterialLibrary`, `ForestAtlas` and `patchForestWind` are built on.
Safari's WebGPU is recent, Firefox's is newer still, and Android coverage is partial. The
honest assessment: the cost is a near-total renderer rewrite, the benefit for a
14-pass-forward-plus-post pipeline is modest (compute-driven culling and lower draw-call
overhead, neither of which is this engine's binding constraint), and the risk to a working
shipping renderer is severe. **Rejected.** What ships instead is a capability probe that
records WebGPU availability into `PerfSystem`'s device record, so the decision has data
behind it when the landscape changes, and a documented seam. This is a case where the brief's
own instruction — "do not sacrifice robustness for theoretical peak performance" — settles it.

---

## 8. Trade-offs and browser compatibility implications

**Fixed timestep changes game feel.** 60 Hz simulation with interpolation is not identical to
variable-dt integration; the player controller will feel subtly different. This is the right
change (current behaviour is frame-rate-dependent, which is a bug) but it must ship with the
accumulator capped and the interpolation applied to the camera only, so a stall reads as
slow-motion rather than teleportation.

**Temporal techniques trade spatial noise for temporal lag.** Already accepted in
`DECISIONS.md` for TAA. §6.5 spends more of that budget. The mitigation is that the
perceptibility field only permits it where static/darkness is already hiding detail.

**Aliased render targets are a footgun.** If a pass reads a resource after its declared last
use, it reads another pass's data. Mitigated by making the graph the *only* way to obtain a
target, and validating in development builds that reads happen inside declared lifetimes.

**Continuous quality can oscillate.** Prevented structurally by asymmetric rates (fast down,
slow up), dead zones around the target frame time, and a minimum dwell time per knob change.

**`EXT_disjoint_timer_query_webgl2` is not universally available** — notably absent or
restricted on Safari and on some mobile drivers, and subject to disjoint invalidation. The
`PerfSystem` must treat GPU timing as *optional*: when absent, fall back to CPU-time
classification and simply be more conservative. It must never require the extension to
function.

**`performance.memory` is Chromium-only.** Same treatment: optional signal, graceful absence.
Memory-bound classification then relies on the engine's own RT/geometry byte accounting,
which is exact and portable anyway.

**Workers cost transfer.** Moving synthesis off-thread only wins if results come back as
transferable `ArrayBuffer`s rather than structured-cloned objects. Any design that clones
megabytes of texture data will be slower than the status quo. This is why worker offload is
staged last: it needs the data layout to be transfer-shaped first.

**`hardwareConcurrency` lies** — it reports logical cores, is capped on some browsers, and on
mobile the "cores" are heterogeneous big.LITTLE. Worker pool sizing must be conservative
(`min(cores - 1, 3)`) and the engine must work correctly with a pool of zero.

**Mobile GPUs are memory- and bandwidth-bound, not ALU-bound.** This is why the transient
pool matters more on mobile than the sample-count knobs, and why the controller's
memory-bound class must be a first-class citizen rather than an afterthought.

**Tab backgrounding.** Already handled via `visibilitychange`. The scheduler must additionally
not accumulate fixed-timestep steps while hidden, or the first frame back runs the capped
maximum and hitches.

---

## 9. Final target architecture

```
                        ┌─────────────────────────────────────────┐
                        │            PerfSystem                   │
                        │  CPU ms · GPU ms · P50/95/99 · variance │
                        │  draws · tris · RT bytes · heap         │
                        │  shader compiles · device caps          │
                        │  bottleneck: cpu|gpu|memory|unstable    │
                        └───────────────┬─────────────────────────┘
                                        │ reads
                        ┌───────────────▼─────────────────────────┐
                        │         QualityController                │
                        │  continuous budget vector [0..1]^n       │
                        │  degrade fast · recover slow · dead zone  │
                        └───┬──────────────┬──────────────┬────────┘
                            │              │              │
       render knobs ────────┘              │              └──────── cpu cadence knobs
       (res, AO effort, vol steps,         │                        (AI Hz, audio Hz,
        shadow size, veg dist/density,     │                         practicals Hz,
        particles, post enables)           │                         builds/frame)
                                           │
                        ┌──────────────────▼──────────────────────┐
                        │            Scheduler                     │
                        │  fixed 60Hz sim + render interpolation    │
                        │  cadence buckets · importance budgets     │
                        │  admission control: merges, streaming,    │
                        │  shader warmup, A* requests               │
                        └──────────────────┬──────────────────────┘
                                           │
   ┌───────────────────────────────────────▼─────────────────────────────────────┐
   │                          PerceptibilitySystem                                │
   │   flashlight cone · exposure · static/fear level · canopy occupancy          │
   │   →  P(region) ∈ [0,1] : "will work spent here reach the player?"            │
   └──┬────────────┬───────────────┬───────────────┬───────────────┬─────────────┘
      │            │               │               │               │
      ▼            ▼               ▼               ▼               ▼
  Visibility   Streaming      Render effort     AI cadence     Audio detail
  (frustum +   (predictive:   (AO/vol/shadow/   (think rate    (spatial solve
   canopy       velocity +     veg tier /        by threat      rate by
   occlusion)   trail graph)   material tier)    + distance)    perceptibility)
      │            │               │
      └────────────┴───────┬───────┘
                           ▼
              ┌────────────────────────────┐
              │   RenderGraph              │
              │   declared read/write      │
              │   TransientPool + aliasing │
              │   dead-pass pruning        │
              │   byte accounting → Perf   │
              └────────────┬───────────────┘
                           ▼
        depth → HBAO → volumetrics → TAA → motion blur → veil/DOF
              → bloom chain → streak → exposure → MEGA COMPOSITE (AgX)
                    (unchanged pass content; unchanged HDR+depth topology)
```

The information-flow contract, stated as the brief asks:

**World → Streaming → Visibility → LOD/importance → Renderer → Temporal → Post.**
And the cross-system loop: **camera/beam importance ↕ render quality ↕ AI cadence ↕ audio
detail ↕ streaming priority**, all mediated by two shared oracles (`PerfSystem` for *how much
can we afford*, `PerceptibilitySystem` for *where is it worth spending*) rather than by each
system guessing independently.

The load-bearing property: **no system computes a distance test, a visibility test or a
quality decision privately.** Each is computed once and read many times. That is what makes
this an engine rather than a collection of features.

---

## 10. Staged implementation strategy

Each stage is independently shippable, typechecks and builds before the next begins, and
preserves observable behaviour unless the stage's stated purpose is to change it. No stage
requires running the game to validate, because the authoring environment cannot (see §0);
validation is `tsc --noEmit`, `vite build`, `npm run bench:world` for CPU-side changes, and
static reasoning about exact counts (draws, passes, bytes, allocations) for GPU-side ones.

| Stage | Content | Validation | Risk |
| --- | --- | --- | --- |
| **1** | `PerfSystem`: histogram percentiles, CPU/GPU split, bottleneck classification, device record incl. WebGPU probe, named scopes. `GameLoop` and `RenderPipeline` report into it. Delete the sort-based `stats()`. | typecheck, build; allocation-site audit | Low |
| **2** | `QualityController`: continuous budget vector; `QUALITY_SPECS` demoted to seeds; `adaptResolution()` retired; render + cadence knobs driven from the budget. | typecheck, build; verify knob ranges clamp to seed tier | Low |
| **3** | `Scheduler`: fixed-timestep accumulator + camera interpolation; cadence buckets; admission control over merges/streaming/warmup/A*. | typecheck, build; `bench:world` unchanged | Medium |
| **4** | `PerceptibilitySystem`: beam cone + exposure + static + canopy → `P`. Wire into AO/volumetric effort, vegetation tier, particle density, AI cadence, audio detail. | typecheck, build; verify `P` bounds and monotonicity | Low |
| **5** | `RenderGraph` + `TransientPool`: handles, lifetimes, aliasing, pruning, byte accounting. Pass content untouched. | typecheck, build; compute peak-bytes before/after | Medium |
| **6** | `VisibilitySystem`: shared frustum + canopy occlusion + tier selection, consumed by render/stream/AI/audio. | typecheck, build | Medium |
| **7** | Predictive streaming (velocity + `layout.paths`); occlusion-skipped near-tier builds. | typecheck, build, `bench:world` | Low |
| **8** | Cached sky cubemap; GPU fireflies; collision hot-path indexing; static-forest shadow caching. | typecheck, build, `bench:world` for collision | Low |
| **9** | Worker-backed synthesis (heightfield/zones/textures), transfer-shaped. | typecheck, build, `bench:world` | Medium-high |
| **10** | Clustered practicals; documented WebGPU seam. | typecheck, build | Deferred |

Stages 1–8 are the pass. Stage 9 lands only if the data layout can be made transfer-shaped
without contorting the synthesis code — a 750 ms boot win is not worth making
`MaterialLibrary` unreadable. Stage 10 is documented and deliberately not built, per §7.

Every stage that redesigns or deletes something appends its reason to `DECISIONS.md`. Measured
per-system costs go to `PERF.md`, annotated with the honest caveat that they are analytical and
CPU-side, because pretending to GPU numbers the environment cannot produce would be worse than
having none.
