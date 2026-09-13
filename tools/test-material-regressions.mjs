import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import * as THREE from 'three';

await mkdir('.tmp', { recursive: true });
await build({ entryPoints: ['src/world/MaterialLibrary.ts'], bundle: true,
  platform: 'node', format: 'esm', outfile: '.tmp/material-regressions.mjs', external: ['three'] });
const { MaterialLibrary, applyShaderPatch, stochasticTilePatch, detailNormalPatch,
  macroVariationPatch, triplanarDetailPatch, layeredGrowthPatch, wetnessPatch } =
  await import('../.tmp/material-regressions.mjs');

function shaderFor(patches) {
  const material = new THREE.MeshStandardMaterial();
  for (const patch of patches) applyShaderPatch(material, patch);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader, null);
  material.dispose();
  return shader;
}

test('real forest-floor generation writes leaf and pebble stamps into integer pixels', () => {
  // TypeScript private members remain callable in the Node-only harness.
  const a = new MaterialLibrary(42, { size: 64 });
  const b = new MaterialLibrary(42, { size: 64 });
  a.buildGround(); b.buildGround();
  const orm = a.ground.roughnessMap.image.data;
  const roughness = Array.from(orm).filter((_, i) => i % 4 === 1);
  // Unstamped soil is >= .9 roughness; pebbles write .7, leaves write .95.
  assert.ok(roughness.filter(v => v === Math.floor(0.7 * 255)).length > 30,
    'pebbles must actually write roughness pixels');
  assert.ok(roughness.filter(v => v === Math.floor(0.95 * 255)).length > 30,
    'leaves must actually write roughness pixels');
  assert.deepEqual(a.ground.map.image.data, b.ground.map.image.data, 'seed remains deterministic');
  assert.equal(a.ground.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(a.ground.normalMap.colorSpace, THREE.NoColorSpace);
  assert.equal(a.ground.roughnessMap.colorSpace, THREE.NoColorSpace);
});

test('stochastic material retains detail and macro modifiers in either registration order', () => {
  const stoch = stochasticTilePatch(0.5);
  const modifiers = [detailNormalPatch(4, 0.35), macroVariationPatch(1 / 30, 0.55), wetnessPatch(1)];
  const first = shaderFor([stoch, ...modifiers]).fragmentShader;
  const last = shaderFor([...modifiers, stoch]).fragmentShader;
  assert.equal(first, last);
  assert.match(first, /vec3 dn = texture2D\(uDetailNormal/);
  assert.match(first, /vec3 m = texture2D\(uMacroMask/);
  assert.ok(first.indexOf('diffuseColor *= hexSample') < first.indexOf('vec3 m ='));
  assert.ok(first.indexOf('vec3 mapN = hexNormalSample') < first.indexOf('vec3 dn ='));
  assert.match(first, /n\.xy = transpose\(rot\) \* n\.xy/);
});

test('triplanar perturbations preserve amplitude and world normals use the transformed instance normal', () => {
  const shader = shaderFor([triplanarDetailPatch(1, 0.3), layeredGrowthPatch(0.3, 0.2, 4)]);
  assert.match(shader.vertexShader, /vTriWNrm = inverseTransformDirection\(transformedNormal, viewMatrix\)/);
  assert.match(shader.vertexShader, /vGrowWNrm = inverseTransformDirection\(transformedNormal, viewMatrix\)/);
  assert.doesNotMatch(shader.fragmentShader, /vec3 dv = normalize/);
  assert.match(shader.fragmentShader, /d -= wn \* dot\(wn, d\)/);
  // Three's actual normal chunk handles instance rotation and nonuniform scale.
  assert.match(THREE.ShaderChunk.defaultnormal_vertex, /transformedNormal = im \* transformedNormal/);
});

test('wetness keeps porous roughness, is spatially anchored, and preserves dry surfaces', () => {
  const fragment = shaderFor([wetnessPatch(1)]).fragmentShader;
  assert.match(fragment, /wetP = .*viewMatrix\)\.xyz \+ cameraPosition/);
  assert.match(fragment, /wetRoughness = 0\.20 \+ pore \* 0\.25/);
  assert.match(fragment, /mix\(1\.0, 0\.76, wet\)/);
  assert.match(fragment, /min\(roughnessFactor, wetRoughness\)/);
  // Verify the view->world expression used by the shader under arbitrary camera rotation.
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(12, 3, -9); camera.rotation.set(0.4, 1.2, -0.1); camera.updateMatrixWorld(true);
  const world = new THREE.Vector3(2, 1, -4);
  const view = world.clone().applyMatrix4(camera.matrixWorldInverse);
  const recovered = view.applyMatrix3(new THREE.Matrix3().setFromMatrix4(camera.matrixWorldInverse).transpose()).add(camera.position);
  assert.ok(recovered.distanceTo(world) < 1e-10);
});


test('stochastic AO follows the same feature coordinates while retaining Three occlusion behavior', () => {
  const fragment = shaderFor([stochasticTilePatch(0.5)]).fragmentShader;
  assert.match(fragment, /hexSample\(roughnessMap, vRoughnessMapUv, 0\.5000\)/);
  assert.match(fragment, /hexSample\(aoMap, vAoMapUv, 0\.5000\)/);
  assert.doesNotMatch(fragment, /texture2D\( aoMap, vAoMapUv \)/);
  assert.match(fragment, /reflectedLight\.indirectDiffuse \*= ambientOcclusion/);
  assert.match(fragment, /computeSpecularOcclusion\( dotNV, ambientOcclusion, material\.roughness \)/);
  const library = new MaterialLibrary(42, { size: 32 });
  library.buildGround();
  assert.equal(library.ground.aoMap, library.ground.roughnessMap,
    'shared packed ORM uses identical AO and roughness texture transforms');
});
