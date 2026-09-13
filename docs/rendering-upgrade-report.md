# Horror rendering upgrade — implementation checkpoint

## Third pass: first-person response and explicit acceptance gates

Added `ViewmodelMotion`: bounded angular-velocity-based hand inertia with
exponential smoothing. Equal camera turn rates now produce equal hand response
at 30, 60 and 144 Hz; tests compare the numerical results. Camera aiming itself
remains immediate. Sprinting lowers the model instead of lifting it into view.
Breathing/tremor use accumulated animation time, so pausing does not advance
them, and restart clears sway, bob, lean, sprint/FOV and flinch history.

Gameplay brief: explore Pinewood, collect evidence and escape while managing
visibility and pursuit. The intended feeling is vulnerable control. This pass
improves visual response to looking/sprinting; it does not change movement
physics, resource rules, encounters, landmarks, rewards or failure conditions.
The existing junction/landmark decisions and escalation remain the level plan.
Desktop/mobile input mappings are unchanged. No runtime allocation or dependency
was added by the motion update.

Reference ledger: gameplay-workflows.md, game-feel.md and
checklists/game-feel.md read. The checklist is not certified: numerical response
and time ownership are covered, but perceived readability and input-to-photon
latency require browser execution. Arcade hitstop/pop effects are not added to
this restrained horror presentation.

`GATES.md` records acceptance using the requested unlazy workflow. Rendering
regressions (27), typecheck and production build/shader lint pass. Spatial/core
rule preservation passes source review. Browser execution still fails at missing
Chromium. Reference parity and device frame-time gates remain unmet handoffs.
This is continued implementation, not an AAA-completion certificate.

## Second pass: lighting, then models

Added a single cached 512px point-light cube shadow for the first practical
pool slot on High/Ultra. This enables local prop/wall occlusion for that light,
with immediate refresh on reassignment and a 12 Hz refresh for moving casters.
Other practical slots remain unshadowed. Low/Medium disable this shadow and
release its target. This is bounded direct-light shadowing, not global illumination.
The cube renders six faces when refreshed; real GPU cost is not yet measured.

Moon shadow stabilization now snaps in light space, including terrain elevation,
instead of snapping world X/Z. This removes a source of projected shadow crawl.
The change is covered by a numerical light-space regression test.

Replaced crossed fern cards with four curved fronds and folded geometric
leaflets (96 triangles per instance). Existing chunk culling/instancing remain.
Ground rocks use a higher subdivision level, coherent strata and a flattened
base. These are targeted model improvements, not a complete asset rebuild.
The additional fern geometry costs 92 triangles per visible instance versus
the previous cards; alpha-card overdraw is removed for these ferns.

Latest checks: typecheck, build, shader lint and 26 regression tests pass.
The full Playwright command now starts its preview server using explicit
loopback hosting, but stops at browser launch because Chromium is missing
(one launch failure, 55 tests not run). No new screenshot comparison is available.
Latest app bundle: 569.02 kB, 184.49 kB gzip.

Additional files: `src/world/FernGeometry.ts`, `src/world/VegetationSystem.ts`,
`playwright.config.ts`; updates also touch night lighting, practicals, quality
switching, the capture harness and rendering tests. The supplied map is unchanged.

## Findings and changes

The composite used `#ifdef` for numeric feature flags. A flag defined as zero
still enabled its code, including AO reads without an allocated AO buffer on
low quality and FXAA alongside TAA. The flags now use numeric conditions.
Quality recovery also reallocates newly enabled targets at unchanged resolution.

Volumetric shadow decoding had the wrong RGBA significance for Three r170.
The decoder now matches the installed packing shader. Shadow comparison uses
the actual light bias and rejects points before the shadow camera near plane.
HDR half-float targets and the existing custom AgX pipeline remain intact;
there is no global brightness lift or second tone-mapping stage.

## Flashlight and lighting

Removed the additional aim filter and sway that delayed the beam independently
of the camera. The emitter still follows the physical lens and converges with
camera aim at 12 metres. Pose updates continue when switched off. LED response
is frame-rate independent. Peak output is 420 candela, with a 9-candela spill;
the existing procedural cookie, soft reflector profile, obstruction handling,
and two shadowed lobes are retained. Warm fallback fill now changes hue without
collapsing luminance. Scattering no longer applies electrical strength twice.

## Atmosphere and materials

Ground fog follows local player terrain elevation. This needs hill/interior
visual review. Bloom, vignette, grain and motion blur are restrained; ordinary
gameplay no longer has permanent chromatic aberration, barrel distortion or DOF.
Event/viewfinder distortion remains available.

Fixed fractional raster indices that discarded procedural leaf/pebble stamps.
Preserved macro/detail shader modifiers through stochastic sampling. Rotated
normal samples return to their tangent basis; AO samples follow the same
stochastic coordinates. Triplanar detail preserves perturbation amplitude and
handles transformed instances. Wetness uses spatially stable irregular patches,
restrained albedo darkening and a porous roughness floor.

## Map, environment and horror presentation

The supplied Pinewood survey remains the spatial authority in
`src/world/PinewoodLayout.ts`: quarry northwest, ridge north, cabin northeast,
tower west, rocks east, camp southwest, lake south, shack southeast and dock at
the southern shore. Existing paths, landmark builders, shoreline and eight
evidence anchors are preserved. No claim is made that procedural assets now
match the reference asset fidelity. No monster AI, encounter timing, audio or
core collection rules were changed. Reduced permanent distortion and reliable
aim support readable, restrained threat presentation.

## Validation and performance

Passed: typecheck, production build, map UI contract, render wiring contract,
23 rendering/material/pipeline regression tests, and shader lint (47 templates,
23 GLSL3 templates). Tests include abrupt aim changes at several frame rates,
all four quality flags, same-resolution target recovery, depth packing and
actual procedural texture writes.

The opt-in `?visualqa=1` harness freezes seed, camera, progression, weather,
wind, practical state, monster pose and temporal warmup. Playwright captures
trail, bark, wet rocks, cabin, forest depth and monster on desktop/mobile,
attaching PNGs and real backbuffer luminance metrics. It stops the live loop;
reload after capture to resume. CI runs the capture suite and retains artifacts.

Local Playwright execution is blocked: Chromium installation could not reach
its download host; the managed browser rejected the local URL. Default Vite
preview also encounters restricted network-interface enumeration (explicit
127.0.0.1 hosting works). No before/after screenshots, GPU timings, runtime
shader validation or reference-match score have been obtained. Visual acceptance
is **pending**, not passed.

GitHub visual QA run `34747073014` also failed before exposing any job steps.
The job-log endpoint returned `BlobNotFound`; no diagnostic cause was supplied.
This CI attempt is not a test pass and cannot establish runtime correctness.

No new runtime dependencies, external assets, geometry or render passes were
added. Material fixes add approximately four texture reads to the affected
ground path and four sine evaluations to wet fragments. PMREM replacement now
disposes its owning render target. Production app bundle is 567.17 kB / 183.84 kB
gzip, versus 558.40 / 180.45 baseline. GPU frame-time impact remains unmeasured.

## Changed files

- `src/game/Flashlight.ts`, `src/game/Player.ts`
- `src/main.ts`, `src/debug/VisualCapture.ts`
- `src/render/RenderPipeline.ts`, `src/render/ShaderChunks.ts`
- `src/render/NightLighting.ts`, `src/render/EnvironmentProbe.ts`
- `src/world/MaterialLibrary.ts`, `src/world/Practicals.ts`
- `tests/api.ts`, `tests/visual-capture.spec.ts`
- `tools/test-render-regressions.mjs`, `tools/test-pipeline-regressions.mjs`
- `tools/test-material-regressions.mjs`, `package.json`
- `.github/workflows/visual-qa.yml`, this report

## Next quality gate and art phase

Inspect all six CI scenes and flashlight-off comparisons on real desktop and
mobile hardware before accepting the lighting tuning. Then concentrate the
next art-production phase on close-range bark, fern silhouettes, deadwood,
wet trail relief and the hand/flashlight viewmodel. These are the largest
remaining differences from the supplied gameplay references. The full AAA
definition of done has not yet been met.

## September 13 follow-up: actual terrain and scatter integration

The supplied portrait gameplay screenshot exposed oversized foliage and litter,
flat-looking terrain and excessive touch-control coverage. This pass preserves
the map, landmark locations, lighting hierarchy and core gameplay rules.

- Fixed `MapGenerator` cloning the ground with plain `Material.clone()`, which
  discards `onBeforeCompile`. The actual terrain now retains the material
  library's wetness, stochastic sampling, detail-normal and macro patches.
- Changed the dense scatter fern factory (not just the secondary vegetation
  layer) from upright crossed planes into five radial, arching fronds with
  analytical normals. Fern dimensions are smaller and grounded. These still
  use the local procedural atlas; they are not authored botanical models.
- Reduced conifer needle panel size to 62% and reduced the oversized ground
  litter cards to 18–40 cm wide, 2.5–7 cm tall.
- Reduced portrait touch buttons to 52 CSS pixels with smaller spacing and
  less opaque backgrounds, keeping all actions and the landscape layout.
- Added real terrain-construction and scatter-geometry regression tests.

Technical-art tradeoff: a scatter fern grows from 36 to 90 triangles; batching,
atlas reuse and residency budgets remain unchanged. No new textures, external
assets or draw passes are introduced. Restoring terrain shader patches increases
the actual terrain sampling cost; GPU timing remains unmeasured.

Validation: typecheck, map/render contracts, all 29 renderer/material tests,
shader lint (47 templates, including 23 GLSL3 templates) and production build
pass. Browser validation remains blocked by the missing Chromium executable;
there are no verified after screenshots or measured GPU timings. Do not treat
this pass as AAA acceptance or a completed gameplay redesign.

Skill reference ledger: implementation blueprint, model recipes, render recipes,
technical art, shader cookbook, procedural-model and performance-safe-detail
checklists read. Their geometry-first guidance drove this scoped integration
pass. Support-surface sourcing remains procedural/local; no hero asset is
claimed upgraded by this pass. Next: validate mobile captures, then rebuild
close-range bark/branch junctions and the hand model with production art.
