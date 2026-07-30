# STATIC

**A browser-native first-person stalker-horror game.** You are a field
archivist dropped into the Pinebridge Station backcountry at night. Recover
**8 survey tapes** scattered through the forest and reach the **fire road**
before the thing in the trees — the **Palebark** — finishes its study of you.

- Runs entirely in the browser (WebGL2, Three.js 0.170)
- **Desktop + mobile/touch from one codebase**
- **Fully offline after first load** (service worker caches the whole build)
- **Zero external assets** — every texture, model, and sound is generated
  procedurally at boot (see `ASSETS.md`)

## Quick start

```bash
npm install
npm run dev        # dev server at http://localhost:5173
```

Production build + preview:

```bash
npm run build      # outputs dist/
npm run preview    # serves dist at http://localhost:4173
```

Tests (headless, SwiftShader WebGL2, desktop + mobile viewports):

```bash
npm test           # build + playwright test
npx playwright test --project=desktop
npx playwright test --project=mobile
```

## Controls

### Desktop

| Input              | Action                              |
| ------------------ | ----------------------------------- |
| **W A S D**        | Move                                |
| **Mouse**          | Look (pointer lock)                 |
| **Shift**          | Sprint (drains stamina, louder)     |
| **C / Ctrl**       | Crouch (slower, quieter)            |
| **E**              | Interact / recover tape             |
| **F**              | Flashlight toggle                   |
| **V**              | Viewfinder (video playback overlay) |
| **Esc / P**        | Pause                               |

### Mobile / touch

- **Left virtual stick** — move
- **Drag right half of screen** — look
- **On-screen buttons** — flashlight, interact, crouch, sprint, viewfinder, pause
- Optional **gyro** look (enable in Settings on supported devices)
- Rotate to landscape for the intended framing (the game prompts in portrait)

### Gamepad

Left stick move, right stick look, A interact, X flashlight, LB sprint,
B crouch, Start pause.

## The rules of the woods

- The Palebark **hears** you — sprinting, flashlight clicks, tape pickups —
  and **sees** you when you have line of sight. Crouch in the undergrowth.
- **Looking at it** raises fear (static, tremor, audio corruption); prolonged
  close contact ends the tape.
- Tapes are in fixed zones; the forest layout is seeded per run, so routes
  differ every attempt.
- After the 8th tape, the fire-road exit opens. Follow the road.

## Architecture

| Area          | Highlights |
| ------------- | --------------------------------------------------------------------- |
| Rendering     | Custom pipeline (no EffectComposer): HDR scene RT → normals prepass → SAO-lite AO → TAA (Halton jitter) → motion blur → bloom → ACES composite w/ chromatic aberration, scanlines, grain, vignette |
| World         | Analytic heightfield (single source of truth), chunk-streamed instanced vegetation (5 archetypes + grass/ferns), procedural sky, rain |
| Physics       | Yaw-box grid-hash colliders, terrain marching, vault, LOS slab tests |
| AI            | Palebark brain: FOV + LOS + hearing perception, detection accumulation, dormant/investigating/stalking/confronting states, A* nav grid |
| Audio         | 100% synthesized Web Audio: noise buffers, ADSR envelopes, modal resonators, positional fear mix — no samples |
| Input         | Unified InputFrame across pointer lock, touch (stick/drag/buttons), gamepad |
| Offline       | Service worker (network-first navigation, cache-first assets) + PWA manifest |

See `DECISIONS.md` for the engineering rationale and `ASSETS.md` for the
procedural asset inventory.

## Debug API

`window.__static` is exposed for tooling/tests:

```js
__static.state()          // 'loading' | 'title' | 'playing' | 'paused' | ...
__static.start()          // begin a run
__static.warp(x, z)       // teleport
__static.forceFear(0.8)   // drive fear directly
__static.forceDetection(1)
__static.collectAll()     // collect all 8 tapes
__static.flashlight(true)
__static.entity()         // { state, distToPlayer, detection }
__static.stats()          // { fps, avg, p95, worst }
__static.positions()      // spawn / exit / zones
```
