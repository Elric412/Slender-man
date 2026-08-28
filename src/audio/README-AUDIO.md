# STATIC — Audio System

Everything you hear is generated at runtime by the Web Audio API. There are no
samples, no downloaded clips, no licensed material of any length. This document
explains the architecture, the psychoacoustic reasoning behind each layer, and
the safety/accessibility guarantees.

---

## 1. Design philosophy

Horror audio fails when it is loud. It works when it is *wrong*. Every technique
here is chosen because of a specific mechanism, not because it sounds spooky:

| Technique | Mechanism |
| --- | --- |
| **Silence** | The absence of expected sound is itself a threat signal. A forest that stops has been interrupted by something. Silence is budgeted, not incidental. |
| **Sub-bass (20–45 Hz)** | Below reliable pitch perception, so it is *felt* as unease before it is identified as sound. Used sparingly (cf. the ~27–28 Hz bed in *Irréversible*). |
| **Dissonance / beating** | Two tones inside one critical band produce roughness the auditory system flags as "wrong" far faster than a volume increase registers as "loud". |
| **Shepard / Risset glissando** | Continuously rising pitch with no octave resolution: dread that never releases, because the expected arrival never comes. |
| **Seeded variation** | Habituation is the enemy. Any sound that can repeat is resynthesised with fresh parameters, so the ear never learns it. |
| **State-driven body sounds** | Breathing and heartbeat are functions of real exertion and real fear, never loops. A loop teaches the player the sound is decorative. |

---

## 2. Module map

```
AudioEngine.ts      façade; owns everything, exposes one update(frame) call
├── AudioBuses.ts   bus graph, safety limiter, metering, LF trim, night mode
├── DreadToolkit.ts sub drone, dissonant cluster, Shepard riser, granular, wrongness, IRs
├── Spatial.ts      HRTF panning, air absorption, occlusion, propagation delay, voice pool
├── Director.ts     adaptive tension model: acts, silence budget, cliché budget
├── PlayerAudio.ts  breath, heartbeat, footsteps, cloth, flashlight
├── EntityAudio.ts  Palebark approach/interference layers, stings, capture, reach beat
├── Ambience.ts     wind/insect/water/rain beds + sparse world events
└── worklets/
    └── DreadWorklet.ts  AudioWorklet DSP (granular, shaped noise, DC-safe sub)
```

`SynthEngine.ts` is the superseded first-generation engine, retained only for
reference; `main.ts` drives `AudioEngine`.

---

## 3. Bus architecture

```
              ┌──────────┐
 ambience ───►│ duckGain │──┐
              └──────────┘  │        ┌───────────┐   ┌──────────┐   ┌─────────────┐
 entity ─────────────────────┼──────►│ masterTrim│──►│ limiter  │──►│ destination │
 foley  ─────────────────────┤       └───────────┘   └──────────┘   └─────────────┘
 ui     ─────────────────────┤                             │
 reverb send ──► convolver ──┘                             └──► analyser (metering)
```

- Each bus has its own gain and a light Biquad EQ, and its own user-facing volume.
- **Entity ducks ambience** via `duckGain` — the forest recoils from the thing in it.
  The duck is a function of what the entity layer actually produced this frame,
  which is why it is computed *last* in the update order.
- The master `DynamicsCompressorNode` is a **safety limiter only**
  (`threshold -1.5 dB, ratio 20, attack 3 ms`). It exists to catch a pathological
  sum, not to glue or loudness-maximise the mix. Typical content sits well below
  it and never triggers it.

**Update order in `AudioEngine.update()` is load-bearing:**

```
listener → space probe → Director → ambience → entity → player → duck
```

---

## 4. Psychoacoustic toolkit (`DreadToolkit.ts`)

- **Sub-bass dread drone** — 20–45 Hz, slow amplitude modulation, two slightly
  detuned oscillators so they beat. Hard-capped in the DSP itself
  (`SUB_HARD_CEIL` inside the worklet), so no bug in the mix logic can
  ever produce a dangerous level.
- **Dissonant cluster** — 3–5 oscillators at deliberately non-octave,
  non-fifth ratios, each with an independent LFO. It is constructed so that it
  cannot resolve; there is no consonant target for the ear to settle on.
- **Shepard/Risset riser** — partials spaced an octave apart, amplitudes weighted
  by a Gaussian window over log-frequency. Partials fade in at the bottom and out
  at the top, so pitch appears to rise forever.
- **Granular texture** — Hann-windowed grains drawn from a fixed, recycled grain
  pool (zero allocation while running). Density, grain size, spectral centre,
  scatter and resonance are all modulated by entity state.
- **Wrongness processor** — comb filtering and ring modulation applied *briefly*
  to otherwise ordinary diegetic sounds. A footstep that is 8% wrong is much more
  unsettling than a new scary sound, because the player already knows the
  reference version.
- **Procedural convolution reverb** — impulse responses generated at runtime
  (predelay, discrete early reflections, dual-band exponential decay, energy
  normalisation) and varied by the space actually probed around the player.

---

## 5. Spatialisation and propagation

- `PannerNode` with **HRTF** for real directional localisation.
- **Distance-dependent spectral filtering**, not just attenuation: air absorbs
  high frequencies, so distant sounds get darker as well as quieter. This is what
  makes distance legible rather than merely quiet.
- **Propagation delay** — far sounds arrive late, scheduled sample-accurately
  against `AudioContext.currentTime`.
- **Continuous occlusion** — 5 rays per voice against `CollisionWorld`, i.e. the
  *same* geometry gameplay uses, so what you hear agrees with what blocks you.
  Results are cached with time expiry and refreshed at ~5 Hz.
- **Voice pool with priority eviction** (28 desktop / 14 mobile). Nearest, loudest
  and most recent win; drops are counted and surfaced in the debug overlay rather
  than failing silently.

---

## 6. The Director (`Director.ts`)

There is **no looping ambient music track**. Tension is modelled and the layers
follow it.

**Inputs:** detection state, tapes collected, elapsed run time, recent player
behaviour (movement, sprinting, hiding, looking at the entity).

**Outputs:** which drone layers are active, overall intensity, remaining silence
budget, and whether an escalation should resolve as a **riser** or as a
**cut-to-quiet**.

**Three-act arc:**

| Act | Enters when | Character |
| --- | --- | --- |
| `opening` | run start | Mostly real silence. Sparse ambience, no sub-bass, no cluster. The forest is just a forest. |
| `middle` | ≥2 tapes or >150 s | Layers begin to accumulate. Cluster appears at low level; risers become available. |
| `late` | ≥5 tapes or >420 s | Sub-bass permitted, cluster prominent, silence used as a weapon (cut-to-quiet) rather than as rest. |

Phase weights map AI state onto tension:
`dormant 0 · investigating 0.28 · stalking 0.55 · confronting 0.9`.

**Escalation tuning.** Two things were deliberately traded off:

1. *Rise must be earnable, not automatic.* Tension climbs from detection and
   progression, but decays whenever the player is genuinely safe, so an escape
   actually feels like relief. Without decay the run becomes monotonic within
   ~90 s.
2. *Peaks must be rationed.* A `CLICHE_BUDGET`
   (`riser 4 · cutToQuiet 6 · sighting 12 · wrongness 5 · subBeat 7`) caps how
   many times each dramatic device can fire in a single run. Every fire goes
   through `requestSpend()`, which can refuse. This is what stops the late act
   from becoming continuous noise — the classic failure mode of reactive horror
   audio.

Deliberately **no combat-music cliché**: escalation never becomes a rhythmic
"chase track". It resolves as either an unresolved riser or an abrupt silence.

---

## 7. Player audio (`PlayerAudio.ts`)

- **Breathing** — resynthesised per breath from real movement load and fear, with
  distinct in/out/hold/catch/release phases and a no-repeat formant memory. It is
  never a loop, so it cannot become wallpaper.
- **Heartbeat** — only audible above a detection threshold, tempo tied to fear,
  centre-panned, and it *ducks other player-bus content* so it dominates exactly
  when the body would.
- **Footsteps** — synthesised per surface (leaf, mud, wood, metal, water, stone)
  from filtered-noise transients plus modal resonance. Never a stepped sample
  loop; every step differs in the seeded micro-detail.
- **Cloth/gear, flashlight click, interactions** — all seeded micro-variation.

---

## 8. Entity audio (`EntityAudio.ts`)

- **Approach layer** — granular texture, spatialised, that intensifies *and shifts
  spectrally* with detection (density 8→70, grain 0.24→0.05 s, centre 260→2360 Hz).
  Brightening reads as *nearing* far more strongly than loudening does.
- **Interference layer** — synthesised static/RF corruption, deliberately
  **head-locked** rather than world-positioned: it is the recorder reacting, not
  an object in the forest.
- **Sighting stings** — 5 recipes, short and non-looping, drawn round-robin through
  `pickVaried()` with a no-repeat memory, so **no two sightings in one run are
  identical**. This is structural, not a probability roll.
- **Distant cues** — 4 kinds, with deliberate positional uncertainty
  (`err = min(14, dist × 0.16)`): far events should be hard to localise precisely.
- **Reach / extension beat** — reserved for late-run milestones. Ducks the approach
  layer and sweeps a filter 180→760→240 Hz over ~3 s.
- **Capture** — abstracted: near-silence or a brief controlled distortion, then
  quiet. Nothing violent or graphic by design.

---

## 9. Ambience (`Ambience.ts`)

Six beds (`wind`, `windLow`, `insects`, `water`, `rain`, `air`) plus eight sparse
event families (`creak`, `groan`, `bird`, `settle`, `drip`, `leaf`, `reed`, `stone`).

- **Three independent RNG streams** (bed / event / placement) so families cannot
  phase-lock into a recognisable cycle.
- **Zone-driven physics** — closed canopy darkens and widens the wind and yields
  more creaks; wetness lowers the insect band (marsh chorus sits lower); birds
  leave as tension rises; rain under canopy is duller and heavier.
- **Silence is a duck, not a mute** (`0.06 + open × 0.94`) — even the quietest
  moment keeps a floor of air, which is what makes it read as *held breath*
  rather than as a bug or a dropout.
- Eligibility **scales the intervals** rather than gating a probability roll,
  which avoids the clumping that naive gating produces.
- A rolling 60 s window caps creak/groan events, so structural noise cannot
  saturate.

---

## 10. Mix philosophy

Real dynamic range is preserved. Quiet passages are genuinely quiet, and the loud
moments are loud because everything around them is not. Nothing is brickwalled.

An optional **night mode** applies loudness normalisation for late-night or phone
-speaker listening. It is a comfort setting and is **off by default**, because
enabling it by default would destroy the very dynamic range the design depends on.

The mix is built so tension still reads with **no audible sub-bass at all** —
phone speakers get the spectral and rhythmic cues, not just the missing bottom end.

---

## 11. Safety and accessibility

These are **not optional** and ship enabled:

- Sub-bass is capped **in the DSP itself**, well below discomfort, by default.
- A **Reduce low frequencies** toggle attenuates/removes LF content
  **independently of the volume slider** — turning the game down is not the same
  request as removing the pressure you feel in your chest.
- A brief, honest **content advisory** is shown before the first run and must be
  acknowledged. It also carries the LF and audio-cue toggles, so the accessibility
  controls are reachable *before* first exposure rather than buried in a menu.
- **Audio cues are captioned** (`#audio-cue`) for critical audio information
  ("something is approaching"), kept visually distinct from dialogue subtitles.
- **Separate volumes** for Master / Ambience / Entity / Foley / UI.

---

## 12. Performance and mobile

- Voice count is capped with priority eviction; drops are counted, never silent.
- Zero allocation in per-frame tick paths; grain and voice pools are pre-allocated.
- Coarse evaluation cadences instead of per-frame work: Director 4 Hz, occlusion
  5 Hz, space probe 2 Hz, IR sync 0.5 Hz.
- Graceful `suspend`/`resume` across tab backgrounding, screen lock and phone-call
  interruption. Backgrounding suspends **unconditionally** — a backgrounded title
  screen must not hold a live context, or mobile will kill it undetectably.
- Unlock happens on the first real gesture with no perceptible delay; if
  `AudioWorklet` is unavailable, native-node fallbacks keep every layer working.

---

## 13. Testing

`tests/static.spec.ts` contains nine audio tests driven through the
`window.__static` debug API:

1. Context reaches `running`, worklets load, voice pool pre-allocates
2. Every bus produces output at its expected trigger
3. Director escalation differs measurably early vs late
4. Opening act is genuinely near-silent
5. No two sightings in a run are identical
6. LF toggle works independently of master volume
7. Audio survives backgrounding and resume
8. No leaked voices across a run/restart cycle
9. Master output stays below the safety ceiling

### Running audio tests headlessly

CI machines have no sound card. Chromium will still open a real output stream,
fall back to ALSA, find nothing that consumes samples, and its audio render
thread then logs `SyncReader::Read timed out` until the output stream wedges hard
enough to break browser teardown — so tests pass every assertion and the *run*
still fails with `browserContext.close: Test ended.`

The fix is Chromium's **silent sink**. Audio tests boot with `?silentaudio=1`,
which builds the `AudioContext` with `sinkId: { type: 'none' }`: the graph is
still rendered on the real audio clock (worklets execute, `AnalyserNode` meters
read true values) but no device is ever opened. Supporting measures:

- `renderThrottle(12)` — render every 12th frame while simulation continues at
  full rate, so SwiftShader cannot starve the audio thread on a 2-core runner.
- `audioShutdown()` in `afterEach` — pauses rendering and closes the context so
  the device is released before teardown.
- `trace: 'off'` by default — serialising a trace zip on a 985 MB runner can
  itself hang teardown.

`?silentaudio=1` is opt-in and can only ever affect a deliberate test run.

---

## 14. Known limitations

- **Occlusion is 5 rays per voice**, not a full acoustic solve. Diffraction around
  corners is approximated by attenuation and low-passing; sound does not bend
  around geometry the way it physically would.
- **Reverb IRs are regenerated on space change**, not continuously interpolated,
  so a fast transition between very different spaces steps rather than glides.
- **Approximate LUFS.** Metering is a K-weighted-*offset* RMS, adequate for
  regression assertions but not a substitute for a compliant loudness meter.
- **HRTF is the browser's generic set** — no per-listener personalisation, so
  elevation cues are weaker than azimuth cues.
- **Headless metering cannot judge aesthetics.** The tests prove buses fire,
  levels stay in range and the arc escalates; they cannot confirm it is
  *frightening*. That still needs ears.
