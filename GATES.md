# Gates: forest surface and silhouette refinement

OWNS: src/world/TreeFactory.ts, src/world/ForestAtlas.ts, tools/test-render-regressions.mjs, docs/rendering-upgrade-report.md, GATES.md

Scope: Improve close forest surfaces and tree forms toward the supplied references while preserving Pinewood geography and offline WebGL2 support.

- [x] G1: Tree geometry and material regressions pass
  CHECK: npm run test:render
  EXPECT: ℹ fail 0
  EVIDENCE: automatic-evidence=v1; definition-sha256=5ff53676b9f3a7f9feabf6477f282594b216ee1cbedc53ab7177b819923c7cdc; exit=0; EXPECT=matched; output-sha256=6af9e2d5985357c73fc6b631305890ffaa9ce2606582b4ff1050dc503c0701ca; output-bytes=3361; shell=/bin/sh; cwd=/workspace/scratch/262881a1a201/Slender-man; path=f3978debc47a/13 entries

- [x] G2: TypeScript integration and production shaders compile
  CHECK: npm run typecheck && npm run build
  EXPECT: built in
  EVIDENCE: automatic-evidence=v1; definition-sha256=8bb83d89912ee6c6583ac8436260f3dc891b39c551dc4d66b495ebebe5bdff90; exit=0; EXPECT=matched; output-sha256=4655f324a7e5c04cb16c2c7a06680fec0eaf61d4c9a1ee3580e01911b3971db3; output-bytes=4511; shell=/bin/sh; cwd=/workspace/scratch/262881a1a201/Slender-man; path=f3978debc47a/13 entries

- [ ] G3: Browser scene captures and gameplay tests pass
  CHECK: npm test -- --max-failures=1
  EXPECT: 56 passed
  EVIDENCE: pending

- [ ] G4: Six rendered scenes reach the supplied reference quality
  EVIDENCE: pending; must inspect real game captures, not generated illustrations

- [ ] G5: Desktop and mobile GPU measurements demonstrate practical frame times
  EVIDENCE: pending

- [ ] G6: Changes are committed in an open PR without losing prior work
  EVIDENCE: pending

ABANDON: G3 Full Playwright run fails at browser launch. Official Chromium installation timed out and then failed its lock update. Requires a working browser executable.
ABANDON: G4 No rendered game scene is available. The deployed game also reports WebGL context creation failure in the cloud browser. Six-scene reference comparison remains required.
ABANDON: G5 No supported hardware GPU environment is available. Geometry counts are measured but are not frame-time evidence.
