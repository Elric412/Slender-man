# Gates: horror presentation and reference acceptance

OWNS: src/game/Player.ts, src/game/ViewmodelMotion.ts, tools/test-render-regressions.mjs, docs/rendering-upgrade-report.md, GATES.md

Scope: Improve first-person response while preserving Pinewood geography and core survival rules; retain full visual acceptance as an explicit requirement.

- [x] G1: Camera response, geometry, lighting and material regression assertions pass
  CHECK: npm run test:render
  EXPECT: ℹ fail 0
  EVIDENCE: automatic-evidence=v1; definition-sha256=5ff53676b9f3a7f9feabf6477f282594b216ee1cbedc53ab7177b819923c7cdc; exit=0; EXPECT=matched; output-sha256=ce33cf8b730bf1b5da35d06cdadc3fc73c08094470154d6edc13f698349f3718; output-bytes=3017; shell=/bin/sh; cwd=/workspace/scratch/262881a1a201/Slender-man; path=6a7d95d776c2/13 entries

- [x] G2: TypeScript integration passes
  CHECK: npm run typecheck
  EXPECT: tsc --noEmit
  EVIDENCE: automatic-evidence=v1; definition-sha256=f3a9f72cca7186327f0d2cf2bb0c6765c563f0877f0c6b6c7f2096788006be4d; exit=0; EXPECT=matched; output-sha256=e38e1597009f8f5617d2eb73a9cbafdd9c8abceb885cd8fbc06f04bfd795925f; output-bytes=142; shell=/bin/sh; cwd=/workspace/scratch/262881a1a201/Slender-man; path=6a7d95d776c2/13 entries

- [x] G3: Production build and shader lint pass
  CHECK: npm run build
  EXPECT: built in
  EVIDENCE: automatic-evidence=v1; definition-sha256=46d72eccd628b28a4b0e974e69890ad856bb5d28a16876531804fc540a571513; exit=0; EXPECT=matched; output-sha256=e3a9781484d6d6107f92c0b222483bd2d1d5fa3c2c763725e548a4adcbdd396e; output-bytes=4028; shell=/bin/sh; cwd=/workspace/scratch/262881a1a201/Slender-man; path=6a7d95d776c2/13 entries

- [ ] G4: Browser gameplay, console and capture tests pass
  CHECK: npm test -- --max-failures=1
  EXPECT: 56 passed
  EVIDENCE: pending

- [ ] G5: Six before/after scenes meet supplied reference quality and remain dark but readable
  EVIDENCE: pending; no rendered evidence available yet

- [ ] G6: Desktop and mobile GPU frame times remain practical
  EVIDENCE: pending; requires actual device measurements

- [x] G7: Pinewood landmark geography and core collection/escape rules are preserved
  EVIDENCE: This pass changes Player cosmetic motion, ViewmodelMotion and its tests; PinewoodLayout, landmark builders, collection and escape rules are untouched.

ABANDON: G4 Chromium executable is unavailable; the full test command stops at browser launch. Restore a runnable browser environment and rerun the unchanged gate.
ABANDON: G5 No rendered before/after captures can be obtained in the current browser environment. Visual acceptance remains required and is not passed.
ABANDON: G6 No desktop/mobile hardware GPU measurements are available. Device profiling remains required and is not passed.
