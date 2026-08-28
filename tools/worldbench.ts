/**
 * tools/worldbench.ts — CPU-side world-build baseline.
 *
 * Runs the real HeightField / ZoneSystem / ScatterSystem / NavWorld build in
 * Node with no GPU, and reports wall-clock per stage plus geometry/memory
 * census. This is the half of the boot cost that has nothing to do with the
 * renderer, and it is the half that a browser harness measures worst (a
 * software rasteriser dominates every number).
 *
 * Run: npm run bench:world
 */
import * as THREE from 'three';
import { HeightField } from '../src/world/HeightField';
import { ZoneSystem } from '../src/world/ZoneSystem';
import { CollisionWorld } from '../src/physics/Collision';
import { NavWorld } from '../src/ai/NavWorld';

const WORLD_SEED = 0x57A71C;

function mark(label: string, fn: () => void): number {
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(22)} ${ms.toFixed(1)} ms`);
  return ms;
}

let hf!: HeightField;
let zones!: ZoneSystem;
let col!: CollisionWorld;
let nav!: NavWorld;

console.log('--- STATIC world-build baseline (node, no GPU) ---');
const total =
  mark('heightfield', () => { hf = new HeightField(WORLD_SEED); }) +
  mark('zones', () => { zones = new ZoneSystem(hf, WORLD_SEED); }) +
  mark('collision', () => { col = new CollisionWorld(hf); }) +
  mark('nav', () => { nav = new NavWorld(hf, col); });

// heightfield query throughput — every system samples this, so it is the
// single hottest function in the codebase.
{
  const N = 200_000;
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < N; i++) acc += hf.heightAt((i % 400) - 200, ((i * 7) % 400) - 200);
  const ms = performance.now() - t0;
  console.log(`heightAt throughput    ${(N / ms / 1000).toFixed(2)} M/s  (${(ms / N * 1e6).toFixed(0)} ns/call)`);
  if (acc === 12345678) console.log('unreachable');
}

// LOS throughput — the AI and the audio occlusion probe both live on this.
{
  const N = 4000;
  const t0 = performance.now();
  let hits = 0;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    if (col.losClear(0, 2, 0, Math.cos(a) * 60, 2.5, Math.sin(a) * 60)) hits++;
  }
  const ms = performance.now() - t0;
  console.log(`losClear throughput    ${(N / ms).toFixed(1)} k/s  (${(ms / N * 1000).toFixed(1)} us/call), clear=${hits}/${N}`);
}

// A* throughput
{
  const cells: number[] = [];
  const N = 200;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    nav.findPath(Math.cos(a) * 120, Math.sin(a) * 120, -Math.cos(a) * 120, -Math.sin(a) * 120, cells);
  }
  const ms = performance.now() - t0;
  console.log(`A* findPath            ${(ms / N).toFixed(2)} ms/query`);
}

const mem = process.memoryUsage();
console.log(`total build            ${total.toFixed(1)} ms`);
console.log(`heap used              ${(mem.heapUsed / 1048576).toFixed(1)} MB`);
console.log(`three objects          ${THREE.REVISION}`);
