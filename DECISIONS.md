# DECISIONS

Engineering rationale for STATIC — what was chosen, what was deliberately
rejected, and why.

## Rendering

### Custom pipeline instead of postprocessing/EffectComposer
The game needs exact control over the frame: a normals prepass feeding
SAO-lite AO, TAA with Halton sub-pixel jitter and 3×3 neighborhood clamping,
reprojection-based motion blur, quarter-res separable bloom, and a horror
composite (ACES, chromatic aberration, scanlines, static noise, film grain,
vignette). EffectComposer chains generic full-screen passes and fights you on
render-target formats and depth reuse; a hand-rolled pipeline shares one
HDR HalfFloat scene target (+ DepthTexture) across every pass. Cost: more
code. Win: one less copy per pass, AO/TAA/motion-blur all read the same
depth, and the "found footage" composite is a single shader.

### TAA + motion blur despite the horror aesthetic
Night scenes with a single flashlight produce brutal specular aliasing on wet
bark and foliage. TAA kills the shimmer; turn-rate-driven motion blur
(sourced from the camera's angular velocity, applied via VP reprojection)
sells panic when the player whips around. Both are disabled on `low` quality
and their history is invalidated on warps/cuts (`invalidateHistory`).

### Analytic heightfield as single source of truth
Terrain height is a closed-form function (layered value noise + ridged
features + zone flattening), not a mesh baked from data. Everything samples
the same function: the visible mesh, the player controller, the nav grid,
rain respawn, entity grounding, and the flashlight's ground-fill light. No
raycasts against a collider mesh, no desync between "looks like" and "is".

## World & AI

### Chunked instancing for vegetation
Five archetypes (spruce, pine, hemlock, deadwood, birch) plus ferns and
grass tufts are rendered as `InstancedMesh` pools per chunk with per-instance
color variation and a shared wind vertex-shader patch. Draw calls stay in the
low hundreds while the forest carries tens of thousands of instances. The
wind patch is guarded by `#ifdef USE_INSTANCING` so non-instanced materials
(tarps, tents) can share it without failing to compile.

### Perception-based entity, not scripted scares
The Palebark runs a real perception model: FOV cone + LOS slab tests against
the collision world + terrain marching, hearing events with loudness falloff,
and detection accumulation with decay. Relocation is *guarded* — it may only
teleport to spots the player cannot currently see (the "don't blink" rule
enforced by the same LOS code the entity uses against the player). This
produces emergent stalking instead of canned jump-scare timings.

### Trunk colliders are `entity-block`
Tree trunks stop movement and navigation but only *partially* block sight —
the entity (and its perception of the player) can be glimpsed between trunks.
Hard-blocking LOS through every trunk made the forest feel like paper walls.

## Audio

### 100% synthesized Web Audio
No samples anywhere. Wind and rain are filtered noise buffers with slow LFO
movement; footsteps, flashlight clicks and tape handling are ADSR-shaped
transients through modal resonators (short parallel bandpass banks tuned per
material); the Palebark's presence is a detuned sub drone + amplitude-modulated
static tied to the fear value. Benefits: zero download weight, infinite
variation (seeded), and every sound can be *parameterized by game state* —
static rises with fear, footsteps know the surface they land on.

Found bug worth recording: `flashlightClick` and `tapePickup` originally
created a gain node and passed it to `modal()` without connecting it to the
UI bus — the nodes rendered into nothing and the clicks were silent.

## Input

### One InputFrame, three devices
Keyboard/mouse (pointer lock), touch (virtual stick + drag-look + buttons)
and gamepad all write into the same per-frame `InputFrame` struct. Game logic
never asks "which device". Sensitivity, invert-Y and gyro live in the input
layer, so settings apply uniformly.

## Offline & platform

### Service worker split: network-first navigation, cache-first assets
Hashed Vite bundles are immutable, so they are cached forever on first fetch.
Navigations go network-first with cache fallback so a redeploy actually
reaches players instead of pinning them to a stale shell. `CACHE_NAME` bumps
when the shell contract changes.

### Quality probing, not user-agent sniffing
Quality tiers (low/medium/high/ultra) are chosen by probing (device memory,
cores, GPU renderer string where available, screen size) and can be
overridden in Settings. Mobile Safari lies in its UA but tells the truth in
`navigator.deviceMemory`.

## Testing

### Playwright + SwiftShader against the production build
Tests run `vite preview` (the real bundle, service worker included) with
`--use-angle=swiftshader`, on 1920×1080 and 390×844 projects. They drive the
game through `window.__static` (boot, run start, zone warps, entity stress,
full escape ending, frame-time budget) and assert zero console/page errors.
A canvas readback check (`canvasNotBlank`) catches the classic "title screen
renders, WebGL context is actually dead" failure that DOM assertions miss.
SwiftShader frame times are ~20–50× a real GPU, so the perf budget guards
against pathological regressions, not hardware targets.

## Known trade-offs

- **TAA ghosting on thin geometry at distance** — mitigated with the 3×3
  clamp; accepted because the alternative (MSAA on HalfFloat at 2× pixel
  ratio) costs more on mobile GPUs.
- **SAO-lite is approximate** — normals-prepass AO at half res; fine in fog
  and darkness, and far cheaper than HBAO.
- **Fixed tape zones, seeded forest** — tape *placement* within zones varies
  per seed, but zone identities are authored so the difficulty curve (road →
  quarry → tower) stays intentional.
