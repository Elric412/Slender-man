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
  export { Player } from './game/Player';
  export { beamProfile } from './render/ShaderChunks';
  export { NightLighting } from './render/NightLighting';
  export { ForestAtlas } from './world/ForestAtlas';
  export { surfaceUniforms } from './world/MaterialLibrary';
  export { makeFernGeometry } from './world/FernGeometry';
  export { Practicals } from './world/Practicals';
  export { ViewmodelMotion } from './game/ViewmodelMotion';
  export { MapGenerator } from './world/MapGenerator';
  export { ScatterSystem } from './world/ScatterSystem';
  export { MaterialLibrary } from './world/MaterialLibrary';
`, resolveDir: new URL('../src', import.meta.url).pathname, loader: 'ts' }, bundle: true,
  platform: 'node', format: 'esm', outfile: '.tmp/render-flashlight.mjs', external: ['three'] });
const { StaticGame } = await import('../.tmp/render-game.mjs');
const { Flashlight, Player, beamProfile, NightLighting, ForestAtlas, surfaceUniforms } =
  await import('../.tmp/render-flashlight.mjs');

test('terrain construction retains the actual forest-floor shader patches', async () => {
  const { MapGenerator, MaterialLibrary } = await import('../.tmp/render-flashlight.mjs');
  const mats = new MaterialLibrary(42, { size: 32 });
  mats.buildGround();
  const group = new THREE.Group();
  MapGenerator.prototype.buildTerrain.call({
    mats, group, hf: { res: 3, layout: { size: 8 }, heightAt: () => 0,
      trailDist: () => 5, inLake: () => false },
    zones: { sample: () => ({ groundTint: [0.3, 0.3, 0.3], mossDensity: 0.3, wetness: 0.5 }) },
    rng: { noise2: () => 0 }, buildPuddles() {},
  });
  const material = group.children[0].material;
  assert.notEqual(material, mats.ground);
  assert.equal(material.vertexColors, true);
  const shader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader,
    fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader, null);
  for (const feature of ['wetRoughness', 'hexNormalSample', 'uDetailNormal', 'uMacroMask'])
    assert.ok(shader.fragmentShader.includes(feature), `terrain lost ${feature}`);
  group.children[0].geometry.dispose(); material.dispose();
});

test('scatter ferns use bounded radial fronds with finite unit normals', async () => {
  const { ScatterSystem } = await import('../.tmp/render-flashlight.mjs');
  const geo = ScatterSystem.prototype.cardGeo.call({}, 13, 0.9, 0.4, 0.18, true);
  assert.equal(geo.index.length / 3, 90);
  assert.ok([...geo.position, ...geo.normal, ...geo.uv].every(Number.isFinite));
  for (let i = 0; i < geo.position.length; i += 3) {
    assert.ok(geo.position[i + 1] >= 0 && geo.position[i + 1] <= 0.4);
    assert.ok(Math.hypot(geo.position[i], geo.position[i + 2]) < 0.55);
    assert.ok(Math.abs(Math.hypot(...geo.normal.slice(i, i + 3)) - 1) < 1e-6);
  }
  assert.ok(geo.index.every(index => index < geo.position.length / 3));
  assert.equal(ScatterSystem.prototype.cardGeo.call({}, 13, 0.9, 0.4, 0.18).index.length / 3, 36);
});

test('hand response agrees across frame rates, caps spikes and resets animation time', async () => {
  const { ViewmodelMotion } = await import('../.tmp/render-flashlight.mjs');
  const results = [30, 60, 144].map(hz => {
    const motion = new ViewmodelMotion();
    for (let i = 0; i < hz; i++) motion.update(1 / hz, 1.2 / hz, -0.6 / hz, true);
    return motion;
  });
  const referenceX = results[0].x, referenceLower = results[0].lower;
  for (const m of results) {
    assert.ok(Math.abs(m.x - referenceX) < 1e-10);
    assert.ok(Math.abs(m.lower - referenceLower) < 1e-10);
    assert.ok(Math.abs(m.time - 1) < 1e-10);
    m.update(0, 100, 100, true);
    assert.ok(Number.isFinite(m.x));
    m.update(1 / 60, 100, -100, false);
    assert.ok(Math.abs(m.x) <= 0.35 && Math.abs(m.y) <= 0.35);
    m.reset();
    assert.deepEqual([m.x, m.y, m.lower, m.time], [0, 0, 0, 0]);
  }
});

test('moon shadow centre is snapped in light space including terrain height', () => {
  const night = new NightLighting();
  const dir = new THREE.Vector3(0.35, 0.62, -0.55).normalize();
  night.setMoonDirection(dir);
  night.moon.shadow.mapSize.setScalar(2048);
  const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
  const up = new THREE.Vector3().crossVectors(dir, right).normalize();
  const texel = 104 / 2048;
  for (const y of [-12.4, 0, 17.9]) {
    night.followPlayer(12.314, y, -9.217, 52);
    for (const axis of [right, up]) {
      const cell = night.moonTarget.position.dot(axis) / texel;
      assert.ok(Math.abs(cell - Math.round(cell)) < 1e-9);
    }
    assert.ok(Math.abs(night.moon.position.distanceTo(night.moonTarget.position) - 150) < 1e-9);
  }
});

test('fern geometry has finite folded leaves within the shared instance budget', async () => {
  const { makeFernGeometry } = await import('../.tmp/render-flashlight.mjs');
  const geo = makeFernGeometry();
  const p = geo.getAttribute('position'), n = geo.getAttribute('normal');
  assert.equal(p.count / 3, 96);
  assert.ok([...p.array, ...n.array].every(Number.isFinite));
  assert.ok(geo.boundingSphere.radius < 1);
  for (let i = 0; i < n.count; i++) assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 1e-5);
  geo.dispose();
});

test('practical shadow budget refreshes on relocation and releases maps on low quality', async () => {
  const { Practicals } = await import('../.tmp/render-flashlight.mjs');
  const practicals = new Practicals(6);
  const lights = practicals.group.children.filter(o => o.isPointLight);
  assert.equal(lights.filter(l => l.castShadow).length, 1);
  practicals.add({ x: 2, y: 2, z: 0, color: 0xffbb66, intensity: 20, range: 12 });
  practicals.update(1 / 60, new THREE.Vector3(), new THREE.Quaternion());
  assert.equal(lights[0].shadow.needsUpdate, true);
  assert.equal(lights[0].shadow.camera.far, 12);
  let released = false;
  lights[0].shadow.map = { dispose: () => { released = true; } };
  practicals.setShadowQuality('low');
  assert.equal(released, true);
  assert.equal(lights[0].shadow.map, null);
  assert.equal(lights[0].castShadow, false);
  practicals.setShadowQuality('high');
  assert.equal(lights[0].castShadow, true);
  assert.equal(lights[0].shadow.needsUpdate, true);
  practicals.dispose();
});

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
    getFlashlightOrigin(out) {
      camera.updateWorldMatrix(true, false);
      return camera.localToWorld(out.set(0.14, -0.17, -0.56));
    },
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

test('mobile fallback supplies sky fill rather than only ground bounce', () => {
  const night = new NightLighting();
  night.setProbeActive(false);
  night.update(0, { moonDim: 0.5, transmission: 0.3, openness: 0.4, wetness: 0.6, warmth: 0 });
  const sky = night.hemi.color;
  const energy = (sky.r * 0.2126 + sky.g * 0.7152 + sky.b * 0.0722) * night.hemi.intensity;
  assert.ok(energy > 0.12, `fallback sky irradiance ${energy} must reveal surfaces`);
});

function heldTorch(aspect) {
  const player = new Player({ losClear: () => true }, { heightAt: () => 0 });
  player.camera.aspect = aspect;
  player.applyCamera(1 / 60, 0, {});
  const scene = new THREE.Scene();
  scene.add(player.camera);
  const light = new Flashlight(scene, player, 512, undefined, 0);
  light.toggle(); light.update(1 / 60, 0);
  return { player, light };
}

test('portrait torch lens stays inside the viewport', () => {
  const { player } = heldTorch(816 / 1536);
  const lens = player.flashlightMesh.localToWorld(new THREE.Vector3(0, 0, -0.134));
  lens.project(player.camera);
  assert.ok(lens.x > 0 && lens.x < 0.85, `lens NDC x=${lens.x}`);
});

test('torch emitter is at the physical lens rather than behind the hand', () => {
  const { player, light } = heldTorch(16 / 9);
  const lens = player.flashlightMesh.localToWorld(new THREE.Vector3(0, 0, -0.134));
  assert.ok(light.originPosition.distanceTo(lens) < 0.03);
});

test('a blocked lens retracts the emitter and both beam lobes cast near shadows', () => {
  const { player, light } = heldTorch(16 / 9);
  player.col.losClear = () => false;
  light.update(1 / 60, 1);
  assert.ok(light.originPosition.distanceTo(player.camera.position) < 0.001);
  for (const lobe of [light.light, light.spill]) {
    assert.equal(lobe.castShadow, true);
    assert.ok(lobe.shadow.camera.near <= 0.1);
  }
});



test('lit beam tracks current aim on the first frame of a fast turn at every frame rate', () => {
  for (const dt of [0, 1/144, 1/60, 1/30, 0.1]) {
    const { light, camera } = torch();
    light.toggle(); light.update(0.1, 0);
    for (const [yaw,pitch] of [[1.3,.7],[-2.4,-1.2],[.1,1.4]]) {
      camera.rotation.set(pitch,yaw,0,'YXZ');
      camera.position.y += .4;
      light.update(dt, 1);
      const target = camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(12).add(camera.position);
      const expected = target.sub(light.originPosition).normalize();
      assert.ok(light.aimDirection.dot(expected) > 1-1e-10, `lag at dt=${dt}`);
      const actual = light.light.target.getWorldPosition(new THREE.Vector3())
        .sub(light.light.getWorldPosition(new THREE.Vector3())).normalize();
      assert.ok(actual.dot(expected)>1-1e-10, 'shadow and surface beam target match');
    }
  }
});

test('practical warmth changes fallback fill hue without collapsing luminance',()=>{
  const night=new NightLighting(); night.setProbeActive(false);
  const env={moonDim:.6,transmission:.3,openness:.4,wetness:.5,warmth:0};
  night.update(0,env);
  const luminance=c=>c.r*.2126+c.g*.7152+c.b*.0722;
  const cool=luminance(night.hemi.color);
  night.update(0,{...env,warmth:1});
  assert.ok(luminance(night.hemi.color)>cool*.8);
  assert.ok(night.hemi.color.r/night.hemi.color.b>1);
});
