# ASSETS

**STATIC ships zero third-party assets.** No texture files, no model files,
no audio samples of any length, no fonts — everything below is generated procedurally at
boot time from seeded randomness. The entire game is code.

This file inventories what is generated and where, so contributors know where
to extend the art without adding downloads.

## Textures (canvas-generated PBR sets — `src/world/MaterialLibrary.ts`)

All albedo maps are painted to offscreen canvases at 512×512; normal maps are
derived from painted height fields via a Sobel `heightToNormal` pass;
roughness maps are generated for surfaces that need breakup.

| Material        | Generation notes |
| --------------- | --------------------------------------------------------------- |
| `spruceBark`    | Vertical fissure strata + moss creep gradient + roughness map   |
| `birchBark`     | Pale trunk, horizontal lenticel bands, dark scarring patches    |
| `ground`        | Needle strokes, twigs, pebbles, fbm mottling; repeat ×90; roughness map |
| `rock`          | Strata banding + lichen colonies + crack network                |
| `wood`          | Plank grain with water staining and nail heads                  |
| `tarpFabric`    | Woven thread cross-hatch + fold shading + edge wear             |
| `fabric`        | Fine weave for the viewmodel sleeve/cuff                        |
| `knurl`         | Diamond-knurl normal map for the flashlight body                |
| `foliage`       | Needle clusters + needle strokes, alpha-tested                  |

## Models (procedural geometry — `src/world/VegetationSystem.ts`, `src/game/*`)

| Model             | Construction |
| ----------------- | ------------------------------------------------------------ |
| Spruce / pine / hemlock | Parameterized cone-stacked canopies over tapered trunks, seeded bend |
| Deadwood          | Bare trunk + branch stubs, heavier bark mat                   |
| Birch (archetype 4) | Slender pale trunk, drooping sage foliage shells            |
| Ferns / grass tufts | Cross-quad star cards, per-instance color                   |
| Tents / tarps / camp props | Box/prism assemblies sharing the wind shader (non-instanced path) |
| Palebark rig (`PalebarkRig.ts`) | Tall emaciated humanoid: bark-plate garment slats (birchBark), shoulder shards, matte eye hollows, 5 uneven fingers per hand |
| Viewmodel (`Player.ts`) | Right grip hand (4 finger + thumb capsules, cuff, fabric sleeve), left wrist with dead watch, knurled flashlight with reflector ring + tailcap |
| Station structures (`MapGenerator.ts`) | Cabins, quarry machinery, fire tower, fire road — assembled primitives with the wood/rock/tarp materials |
| Tapes (`TapeSystem.ts`) | VHS-cassette primitive with emissive label strip |

## Sky & atmosphere (`src/render/Sky.ts`, `src/game/Effects.ts`)

- **Sky**: full-shader procedural night — star field, moon disc with limb
  darkening, drifting cloud bands; rendered on a 760 m sphere inside the
  camera far plane.
- **Rain**: seeded particle field respawned from the same RNG (no
  `Math.random`), camera-following.
- **Fog**: `FogExp2` tuned to the flashlight falloff so the beam reads as a
  volume.

## Audio (100% synthesized — `src/audio/`)

Every sound is generated at runtime by the Web Audio API. There are **no samples,
no downloaded clips and no licensed audio of any length**, however short. Full
architecture and rationale: [`src/audio/README-AUDIO.md`](src/audio/README-AUDIO.md).

### Ambience (`Ambience.ts`)

| Layer | Synthesis method |
| ----- | ---------------- |
| Wind bed / low wind | Pink + brown noise through state-variable bandpasses, slow independent LFO movement; canopy closure darkens and widens it |
| Insects | Narrow resonant band chorus; centre frequency drops with ground wetness (marsh chorus sits lower) |
| Water / creek | Filtered noise + stochastic droplet transients, distance-filtered |
| Rain | High-passed noise bed + droplet transients; duller and heavier under canopy |
| Air floor | Very low-level broadband bed — the floor that makes silence read as held breath rather than as a dropout |
| Events (`creak`, `groan`, `bird`, `settle`, `drip`, `leaf`, `reed`, `stone`) | Modal resonator banks and shaped noise transients, spatialised, scheduled from three independent seeded RNG streams so families cannot phase-lock |

### Player foley (`PlayerAudio.ts`)

| Sound | Synthesis method |
| ----- | ---------------- |
| Breathing | Resynthesised per breath from movement load + fear; distinct in/out/hold/catch/release phases, no-repeat formant memory (never a loop) |
| Heartbeat | Low sine thump + body resonance, tempo tied to fear, centre-panned, ducks other player-bus content |
| Footsteps | Filtered-noise transient → modal resonator bank per surface (leaf, mud, wood, metal, water, stone), seeded micro-variation every step |
| Cloth / gear | Short filtered-noise swells with seeded variation |
| Flashlight click | Modal resonator (fixed: gain must connect to the `ui` bus) |
| Tape pickup/handling | Plastic modal bank + mechanical tick |
| Vault / exhausted | Impact transient + breath overlay |

### Entity — the Palebark (`EntityAudio.ts`)

| Layer | Synthesis method |
| ----- | ---------------- |
| Approach | Granular texture (AudioWorklet); density, grain size, spectral centre, scatter and resonance all morph with detection — brightening reads as *nearing* |
| Interference | Synthesised static/RF corruption, deliberately head-locked (the recorder reacting, not an object in the forest) |
| Sighting stings | 5 recipes, short and non-looping, drawn through a no-repeat memory so no two sightings in a run are identical |
| Distant cues | 4 kinds, with deliberate positional uncertainty so far events are hard to localise |
| Reach / extension beat | Ducked approach layer + filter sweep 180→760→240 Hz |
| Capture | Abstracted: near-silence or brief controlled distortion, then quiet — nothing violent or graphic |

### Psychoacoustic toolkit (`DreadToolkit.ts`, `worklets/DreadWorklet.ts`)

| Tool | Synthesis method |
| ---- | ---------------- |
| Sub-bass dread drone | 20–45 Hz detuned oscillator pair (beating) + slow AM; hard-capped inside the worklet DSP |
| Dissonant cluster | 3–5 oscillators at non-octave / non-fifth ratios with independent LFOs; constructed so it cannot resolve |
| Shepard/Risset riser | Octave-spaced partials under a Gaussian log-frequency window — endless rise, no release |
| Granular texture | Hann-windowed grains from a fixed recycled grain pool (zero allocation while running) |
| Wrongness processor | Comb filter + ring modulation applied briefly to ordinary diegetic sounds |
| Reverb | Procedural impulse responses: predelay, discrete early reflections, dual-band exponential decay, energy normalisation — regenerated per probed space |

### UI

| Sound | Synthesis method |
| ----- | ---------------- |
| UI clicks | Short modal ticks |
| Audio cues | Captioned visually (`#audio-cue`) as well as sounded, for accessibility |

## Icons & PWA (`public/`)

`icon-192.png` / `icon-512.png` are generated (PIL script, kept out of the
repo): scanline noise over the Palebark silhouette. `manifest.webmanifest`
declares fullscreen landscape display. The favicon is an inline SVG data URI
in `index.html`.

## License position

Because every asset is synthesized from code in this repository, there are no
third-party asset licenses to track. The codebase itself is the only artifact.
"The Slender Man" is a third-party character; STATIC uses an original entity
(the Palebark), original setting (Pinebridge Station), and original text —
the lineage is genre, not content.
