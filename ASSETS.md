# ASSETS

**STATIC ships zero third-party assets.** No texture files, no model files,
no audio samples, no fonts — everything below is generated procedurally at
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

## Audio (100% synthesized — `src/audio/SynthEngine.ts`)

| Sound              | Synthesis method |
| ------------------ | -------------------------------------------------------- |
| Wind bed           | Filtered noise buffer + slow LFO movement                |
| Rain               | High-passed noise, droplet transients                    |
| Footsteps          | ADSR transient → modal resonator bank, tuned per surface |
| Flashlight click   | Modal resonator (fixed: gain must connect to `ui` bus)   |
| Tape pickup/handling | Plastic modal bank + mechanical tick                   |
| Palebark drone     | Detuned sub oscillators, amplitude-modulated             |
| Static / fear      | Noise layer whose level tracks `FearSystem.value`        |
| UI clicks          | Short modal ticks                                        |

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
