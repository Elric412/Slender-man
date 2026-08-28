# AGENTS.md

> Edit this file aggressively. Every rule below should trace to a real past failure or a hard external constraint — not an aspiration ("write clean code" doesn't belong here; the agent already knows that). If this file grows much past ~120 lines, push detail into `docs/design/` and shrink this back to a table of contents.

## Project shape

STATIC is a browser-native, first-person, AAA-fidelity stalker-horror game — Three.js on WebGL2 with an optional feature-detected WebGPU path, TypeScript, Vite, and Playwright for automated visual/performance checks. Single-player, no backend, must run fully offline after first load, playable on both desktop and mobile browsers. `three` is the only required runtime dependency — no game engine, no external physics library.

## Where things live

- `src/main.ts` — entry point; the `StaticGame` class orchestrates boot, the state machine, and the per-frame loop.
- `src/render/` — custom HDR pipeline: normals prepass, SAO-lite AO, TAA (Halton jitter), motion blur, bloom, ACES composite. No `EffectComposer`.
- `src/world/` — terrain (analytic heightfield), vegetation instancing, procedural sky, rain, map generation.
-  — core entities and systems: Player controller, Palebark AI brain, TapeSystem, Flashlight, EntityPerception, FearSystem. Palebark's AI and the player's physical movement both live here — there is **no separate top-level `physics/` or `ai/` folder**; extend these, don't fork new ones. *(Note: the design docs in `docs/design/` describe "physics" and "AI" as conceptual systems, not literal directories — that's a naming mismatch to be aware of, not a structural gap to fill.)*
- `src/audio/` — `SynthEngine`: 100% procedural Web Audio — noise buffers, modal resonators, ADSR envelopes, seeded variation.
- `src/input/` — unified `InputFrame`: keyboard/mouse (pointer lock), touch (virtual stick + drag-look + buttons), gamepad.
- `src/ui/` — menu state machine (loading, title, settings, pause, end screens), HUD overlays.
- `src/core/` — `SeededRandom`, heightfield utilities.
- `src/ai/`
- `src/style.css` — UI styling (dark theme, accessibility).
- `index.html` — DOM shell: canvas + screen overlays (loading, title, settings, pause, end, HUD, touch UI).
- `vite.config.ts` — build config; three.js is split into a manual chunk — preserve this when touching build config.
- `playwright.config.ts` — E2E tests run against SwiftShader software WebGL2, at both desktop and mobile viewports.
- `public/` — PWA manifest and generated icons; icons are produced procedurally at build/asset-prep time via PIL — a build-time tool, not a runtime dependency, so it doesn't conflict with the offline/no-network rule.
- `docs/design/` — the system of record; read the relevant file before working in that area:
  - `static-game-prompt.md` — whole-game scope, rendering pipeline, quality gates
  - `static-improvement-and-fixes-prompt.md` — active polish/bug backlog
  - `palebark-entity-creation-brief.md` — the entity: model, rig, AI, animation, SFX
  - `static-audio-engineering-brief.md` — audio architecture and psychoacoustic design
  - `static-world-environment-craft-brief.md` — world/environment craft standards
  - `static-engine-innovation-brief.md` — rendering/asset-pipeline/engine architecture research and upgrade plan
- `ASSETS.md`, `DECISIONS.md`, `PERF.md` — living logs, append-only (see Conventions)

## Workflow

1. Read the relevant `docs/design/` file for the area you're touching before writing code.
2. Make the smallest change that satisfies the task — one system per commit where possible.
3. Run the narrowest Playwright spec that validates the change; run the full suite (`npm run test`) before declaring anything done.
4. If you touched rendering, compare fresh captures against the harness's reference points (trailhead, ranger station, quarry, fire tower interior, a flashlight/foliage close-up, a Palebark sighting, high-fear state, end screen). Playwright renders through **SwiftShader (software WebGL2)** — treat its captures as a correctness/regression check, not as a real-GPU performance or visual-fidelity benchmark; don't tune quality settings against what SwiftShader can or can't handle.
5. If you touched performance, report real before/after frame-time numbers (avg + 1% low) — don't assume a change helped. Log measured per-system costs in `PERF.md`.

*(Commands assume `npm install`, `npm run dev`, `npm run build`, `npm run test` as scaffolded in the main brief — correct this section once real `package.json` script names exist, if they differ.)*

## Conventions

- Central seeded RNG for anything gameplay- or test-relevant. *(Lesson: reproducible bugs and reproducible Playwright captures both depend on this — uncontrolled `Math.random()` in a gameplay system breaks both.)*
- Zero per-frame allocation in render/physics/AI hot loops — pre-allocate and reuse scratch objects.
- Every repeatable asset (tree, prop, sound cue, sighting behavior) needs real seeded variation, not just rotation/scale jitter on one source. *(Lesson: the forest shipped with essentially one tree mesh nudged around and visibly read as generated — the fix was requiring real archetype and variant counts, not more jitter.)*
- CLI/build commands must run non-interactively — flags or config, not prompts — so an agent can run them unattended.
- Prefer procedural generation over adding a new asset dependency; if a third-party (e.g. CC0) asset is added anyway, record it and its license in `ASSETS.md`.

## Never

- Never add a game engine, an external physics library, or reintroduce Three.js `EffectComposer` — the render graph and physics are owned and custom by design.
- Never use sampled or licensed audio. Everything is synthesized via the Web Audio API, no exceptions.
- Never add a runtime network call, CDN dependency, or telemetry — the build must work fully offline after first load.
- Never depict gore, dismemberment, or a completed on-screen kill. Palebark's presence and capture stay psychological, not graphic.
- Never name or model the entity as the literal "Slender Man" character, or copy any specific existing game/film's design for it. *(Lesson: the character is actively copyrighted and its rights holder has pursued cease-and-desist action against unauthorized commercial use — Palebark is a deliberately original design for exactly this reason.)*
- Never spawn or respawn particles at/relative to the camera's exact eye position without transforming to a stable world-space volume first. *(Lesson: this is what caused the flashlight dust to visibly stream toward the player instead of drifting naturally.)*
- Never raise the sub-bass/dread-drone audio layer above the intensity cap defined in the audio brief, and never remove its accessibility toggle. *(Lesson: that frequency range is capable of real physical discomfort, not just a mixing choice — the cap is a safety feature, not a suggestion.)*
- Never "fix" a repetition or performance complaint by deleting/hiding content or quietly lowering a quality setting — find the underlying placement, variety, or engineering issue instead. *(Lesson: this project's owner has explicitly asked for headroom, not trade-offs, more than once.)*
- Never rewrite a `docs/design/` brief to match code that drifted from it — flag the mismatch and ask which one is actually wrong.

## Escalate

- Requirement is ambiguous, or two `docs/design/` files conflict → ask one structured question rather than guessing big.
- A test that isn't yours is failing on the current branch before your change → ask; don't delete or weaken it to reach green.
- Verification is flaky (passes and fails on an unchanged run) → ask; don't paper over it with a retry loop.

## Lessons log

<!-- Format: - YYYY-MM-DD: <one-line rule>. Lesson: <what actually happened>. Promote recurring entries into Conventions/Never above. -->
- _(empty — add an entry here the first time an agent gets something wrong in a way future sessions should avoid)_
