import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import * as THREE from 'three';
await mkdir('.tmp', { recursive: true });
await build({stdin: {contents: `export { RenderPipeline } from './render/RenderPipeline';
export { QUALITY_SPECS } from './core/Config';
export { GLSL_UNPACK_DEPTH } from './render/ShaderChunks';`,
resolveDir: new URL('../src', import.meta.url).pathname, loader: 'ts'},
bundle:true, platform:'node', format:'esm', outfile:'.tmp/pipeline-regression.mjs', external:['three']});
const { RenderPipeline, QUALITY_SPECS, GLSL_UNPACK_DEPTH } = await import('../.tmp/pipeline-regression.mjs');
function pipeline(tier) { return new RenderPipeline({ getContext: () => null }, {...QUALITY_SPECS[tier]}); }
// Use the platform preprocessor to test the actual emitted shader variants,
// rather than treating '#define EFFECT 0' as if it meant undefined.
function preprocess(material) {
  const defines = Object.entries(material.defines).map(([k,v])=>`#define ${k} ${v}`).join('\n');
  const result = spawnSync('cpp', ['-P','-x','c','-'], {input:defines+'\n'+material.fragmentShader, encoding:'utf8'});
  if(result.error) throw new Error('Shader variant tests need cpp (GCC/Clang preprocessor): '+result.error.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
for(const tier of ['low','medium','high','ultra']) test(`${tier}: composite reads only enabled effect buffers`,()=>{
  const p=pipeline(tier); const code=preprocess(p.compositePass.material);
  for(const [flag, sampler] of [['ao','tAO'],['volumetric','tVol'],['bloom','tBloom']]) {
    assert.equal(new RegExp(`texture\\(\\s*${sampler}\\s*,`).test(code),p.enabled[flag],sampler);
  }
  assert.equal(code.includes('float amt ='), !QUALITY_SPECS[tier].taa, 'FXAA must not blur TAA output');
  assert.equal(code.includes('float coc ='), QUALITY_SPECS[tier].dof);
});
test('quality recovery allocates newly enabled targets at unchanged resolution',()=>{
  const p=pipeline('low'); p.resize(640,360);
  const initialWidth=p.sceneRT.width;
  p.applyKnobs({renderScale:.7,aoQuality:2,volumetric:2,volSteps:16,taa:true,motionBlur:false,bloom:true,dof:false,streak:false,sharpen:.3});
  assert.equal(p.sceneRT.width,initialWidth);
  assert.ok(p.aoRT && p.taaA && p.volRT);
  assert.equal(p.volRT.width, Math.floor(initialWidth/2));
  p.dispose();
});
test('volumetric depth decoder agrees with r170 packed shadow values',()=>{
  const expr=GLSL_UNPACK_DEPTH.match(/UNPACK_FACTORS = vec4\(([^;]+)\);/)[1];
  const weights=expr.split(',').map(x=>Function(`return (${x})`)());
  // Independent implementation of three r170 packDepthToRGBA, including carry.
  function pack(v) {
    if(v<=0)return [0,0,0,0]; if(v>=1)return [1,1,1,1];
    let n=v*16777216, a=n-Math.floor(n); n=Math.floor(n)/256;
    const b=n-Math.floor(n); n=Math.floor(n)/256;
    const g=n-Math.floor(n); n=Math.floor(n);
    return [n/255,g*256/255,b*256/255,a];
  }
  for(const v of [0,.0001,.08,.25,.501234,.937,.999,1]) {
    const decoded=pack(v).reduce((sum,x,i)=>sum+x*weights[i],0);
    assert.ok(Math.abs(decoded-v)<1e-7, `${v} decoded as ${decoded}`);
  }
  assert.ok(THREE.ShaderChunk.packing.includes('UnpackFactors4'));
});
