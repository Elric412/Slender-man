import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import * as THREE from 'three';

// Exercise the real game methods without creating a WebGL context or starting
// the entry point. Keep the production bootstrap out of this Node-only harness.
await mkdir('.tmp', { recursive: true });
const main = await readFile('src/main.ts', 'utf8');
const entry = main.indexOf('// ================================================================ entry');
assert.ok(entry > 0, 'game bootstrap boundary exists');
await build({
  stdin: { contents: main.slice(0, entry) + '\nexport { StaticGame };',
    resolveDir: new URL('../src', import.meta.url).pathname, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: '.tmp/render-game.mjs',
  external: ['three'], define: { 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'false' },
});
await build({ stdin: { contents: `
  export { Flashlight } from './game/Flashlight';
  export { beamProfile } from './render/ShaderChunks';
  export { NightLighting } from './render/NightLighting';
  export { ForestAtlas } from './world/ForestAtlas';
  export { surfaceUniforms } from './world/MaterialLibrary';
`, resolveDir: new URL('../src', import.meta.url).pathname, loader: 'ts' }, bundle: true,
  platform: 'node', format: 'esm', outfile: '.tmp/render-flashlight.mjs', external: ['three'] });
const { StaticGame } = await import('../.tmp/render-game.mjs');
const { Flashlight, beamProfile, NightLighting, ForestAtlas, surfaceUniforms } =
  await import('../.tmp/render-flashlight.mjs');

test('weather initialization tolerates a map whose detail layer is not ready', () => {
  const received = [];
  const host = {
    weather: { rain: 0.7, wetness: 0 }, mats: { setWetness: w => received.push(w) },
    map: {}, staticState: {}, fear: { value: 0 }, vfWeight: 0,
    zoneAtmo: { wet: 0, fog: 1, ambient: 1, tint: new THREE.Color(1, 1, 1) },
    settings: { filmNoise: 0 }, spec: { dof: false }, scene: new THREE.Scene(),
  };
  assert.doesNotThrow(() => StaticGame.prototype.applyWeatherLook.call(host, 0, true));
  assert.equal(host.staticState.wetness, 0.7);
  host.map.debris = { setWetness: w => received.push(w) };
  StaticGame.prototype.applyWeatherLook.call(host, 0, true);
  assert.deepEqual(received, [0.7, 0.7, 0.7]);
  host.map = undefined;
  assert.doesNotThrow(() => StaticGame.prototype.applyWeatherLook.call(host, 0, true));
});

function torch() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.7, 0);
  scene.add(camera);
  const player = { camera, pos: new THREE.Vector3(), bobAmount: 0,
    setBatteryGauge() {}, setLensGlow() {} };
  return { light: new Flashlight(scene, player, 512, undefined, 0), camera };
}

test('beam emitter stays on the right-hand side of the camera', () => {
  const { light, camera } = torch();
  light.toggle();
  light.update(0.1, 0);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  assert.ok(light.originPosition.clone().sub(camera.position).dot(right) > 0);
});

test('switching the torch on after turning in darkness uses the current aim', () => {
  const { light, camera } = torch();
  camera.rotation.y = Math.PI / 2;
  camera.updateMatrixWorld(true);
  light.toggle();
  light.update(1 / 60, 0);
  const forward = camera.getWorldDirection(new THREE.Vector3());
  assert.ok(light.aimDirection.dot(forward) > 0.99, 'first lit frame points where the player looks');
});

test('reflector profile is normalized, fades monotonically and ends at zero', () => {
  assert.equal(beamProfile(0), 1);
  let previous = 1;
  for (let i = 1; i <= 120; i++) {
    const value = beamProfile(i / 100);
    assert.ok(value >= 0 && value <= previous);
    previous = value;
  }
  assert.equal(beamProfile(1), 0);
  assert.ok(beamProfile(0.999) < 0.00001);
});

test('night colors convert once and fallback fill survives closed wet canopy', () => {
  const night = new NightLighting();
  assert.ok(night.moon.color.equals(new THREE.Color(0x9fb4dc)));
  night.setProbeActive(false);
  const level = night.update(0, {
    moonDim: 0, transmission: 0, openness: 0, wetness: 1, warmth: 0,
  });
  assert.equal(level.fill, 0);
  assert.ok(level.key > 0 && level.bounce > 0);
  assert.ok(night.hemi.color.r > 0.02);
});

test('forest shader variants consume the shared weather uniform', () => {
  const atlas = ForestAtlas.build(123, { size: 64, anisotropy: 1 });
  for (const material of [atlas.barkMat, atlas.foliageMat]) {
    const shader = {
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {},
    };
    material.onBeforeCompile(shader);
    assert.equal(shader.uniforms.uWetness, surfaceUniforms.uWetness);
    surfaceUniforms.uWetness.value = 0.8;
    assert.equal(shader.uniforms.uWetness.value, 0.8);
    assert.ok(shader.fragmentShader.includes('atlasOrm.g'));
    assert.ok(shader.fragmentShader.includes('roughnessFactor = mix'));
  }
  surfaceUniforms.uWetness.value = 0;
});
