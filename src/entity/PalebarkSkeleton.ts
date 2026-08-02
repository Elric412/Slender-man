/**
 * PALEBARK — skeleton definition.
 *
 * Pure data + a Three.js builder. The specs are engine-agnostic (plain numbers)
 * so the same hierarchy can be emitted by the offline GLB exporter
 * (`tools/build-palebark.mjs`) and instantiated at runtime without drift.
 *
 * Hierarchy = standard humanoid, plus the two additions the design brief
 * requires for the unnatural-extension beat:
 *
 *   • two EXTRA spine joints  (`spine_x1`, `spine_x2`)  — inert during locomotion
 *   • one EXTRA joint per limb segment                  — inert during locomotion
 *       upperarm_x / forearm_x / thigh_x / shin_x   (per side)
 *
 * "Inert" is enforced by the animator: nothing writes to a `*_x` joint unless
 * the extension layer's weight is above zero, and the extension layer is gated
 * by the AI's milestone ceiling. See PalebarkAnimator.ts §extension.
 *
 * Plus a non-humanoid addition: eight 3-link coat strands (`coat_*`) driven by
 * the Verlet cloth solver, and two sleeve strands per arm. These carry the hem
 * and cuffs so the coat can hang and swing without a physics library.
 */

import * as THREE from 'three';

export type BoneTag = 'core' | 'spine-extra' | 'limb-extra' | 'finger' | 'cloth';

export interface BoneSpec {
  name: string;
  parent: string | null;
  /** LOCAL offset from parent, metres. */
  pos: [number, number, number];
  tag: BoneTag;
}

/** Standing height of the bind pose, metres. Inside the 2.4–2.7 m design band. */
export const PALEBARK_HEIGHT = 2.62;

/** Number of coat strands around the hem. Must match the cloth solver. */
export const COAT_STRANDS = 8;
export const COAT_LINKS = 4;

const SHOULDER_X = 0.185;   // half shoulder width — deliberately narrow for 2.62 m
const HIP_X = 0.098;

/* ------------------------------------------------------------------ specs */

function armChain(side: 1 | -1, out: BoneSpec[]): void {
  const s = side > 0 ? 'r' : 'l';
  const sx = side * SHOULDER_X;
  out.push({ name: `clavicle_${s}`, parent: 'chest', pos: [side * 0.055, 0.075, 0.012], tag: 'core' });
  out.push({ name: `upperarm_${s}`, parent: `clavicle_${s}`, pos: [sx - side * 0.055, -0.02, 0], tag: 'core' });
  // mid-humerus insert — visually inert, only translated by the extension layer
  out.push({ name: `upperarm_x_${s}`, parent: `upperarm_${s}`, pos: [0, -0.250, 0], tag: 'limb-extra' });
  out.push({ name: `forearm_${s}`, parent: `upperarm_x_${s}`, pos: [0, -0.250, 0], tag: 'core' });
  out.push({ name: `forearm_x_${s}`, parent: `forearm_${s}`, pos: [0, -0.265, 0], tag: 'limb-extra' });
  out.push({ name: `hand_${s}`, parent: `forearm_x_${s}`, pos: [0, -0.265, 0], tag: 'core' });
  // five long fingers, two joints each (proximal + distal); knuckle count reads
  // as "too many" because the distal link is subdivided by the mesh, not the rig
  const spread = [-0.052, -0.026, 0, 0.026, 0.05];
  const drop = [-0.075, -0.086, -0.09, -0.084, -0.07];
  const len = [0.105, 0.125, 0.134, 0.121, 0.098];
  for (let f = 0; f < 5; f++) {
    out.push({
      name: `finger${f}_a_${s}`, parent: `hand_${s}`,
      pos: [side * spread[f], drop[f], 0.006], tag: 'finger',
    });
    out.push({
      name: `finger${f}_b_${s}`, parent: `finger${f}_a_${s}`,
      pos: [0, -len[f], 0], tag: 'finger',
    });
  }
  // sleeve cloth strand — hangs from the cuff
  out.push({ name: `sleeve_a_${s}`, parent: `forearm_${s}`, pos: [0, -0.33, 0], tag: 'cloth' });
  out.push({ name: `sleeve_b_${s}`, parent: `sleeve_a_${s}`, pos: [0, -0.16, 0], tag: 'cloth' });
}

function legChain(side: 1 | -1, out: BoneSpec[]): void {
  const s = side > 0 ? 'r' : 'l';
  out.push({ name: `thigh_${s}`, parent: 'pelvis', pos: [side * HIP_X, -0.045, 0], tag: 'core' });
  out.push({ name: `thigh_x_${s}`, parent: `thigh_${s}`, pos: [0, -0.3175, 0], tag: 'limb-extra' });
  out.push({ name: `shin_${s}`, parent: `thigh_x_${s}`, pos: [0, -0.3175, 0], tag: 'core' });
  out.push({ name: `shin_x_${s}`, parent: `shin_${s}`, pos: [0, -0.2775, 0], tag: 'limb-extra' });
  out.push({ name: `foot_${s}`, parent: `shin_x_${s}`, pos: [0, -0.2775, 0], tag: 'core' });
  out.push({ name: `toe_${s}`, parent: `foot_${s}`, pos: [0, -0.055, 0.13], tag: 'core' });
}

export function boneSpecs(): BoneSpec[] {
  const b: BoneSpec[] = [];
  b.push({ name: 'root', parent: null, pos: [0, 0, 0], tag: 'core' });
  b.push({ name: 'pelvis', parent: 'root', pos: [0, 1.310, 0], tag: 'core' });
  b.push({ name: 'spine_1', parent: 'pelvis', pos: [0, 0.145, 0.006], tag: 'core' });
  b.push({ name: 'spine_x1', parent: 'spine_1', pos: [0, 0.145, 0.004], tag: 'spine-extra' });
  b.push({ name: 'spine_2', parent: 'spine_x1', pos: [0, 0.145, 0], tag: 'core' });
  b.push({ name: 'spine_x2', parent: 'spine_2', pos: [0, 0.145, -0.004], tag: 'spine-extra' });
  b.push({ name: 'chest', parent: 'spine_x2', pos: [0, 0.145, -0.006], tag: 'core' });
  b.push({ name: 'neck_1', parent: 'chest', pos: [0, 0.135, -0.004], tag: 'core' });
  b.push({ name: 'neck_2', parent: 'neck_1', pos: [0, 0.10, 0.002], tag: 'core' });
  b.push({ name: 'head', parent: 'neck_2', pos: [0, 0.085, 0.004], tag: 'core' });
  b.push({ name: 'head_top', parent: 'head', pos: [0, 0.26, 0], tag: 'core' });
  armChain(-1, b);
  armChain(1, b);
  legChain(-1, b);
  legChain(1, b);
  // coat strands: eight around the body, three links each, rooted at the pelvis
  for (let i = 0; i < COAT_STRANDS; i++) {
    const a = (i / COAT_STRANDS) * Math.PI * 2;
    const r = 0.175;
    b.push({ name: `coat${i}_0`, parent: 'pelvis', pos: [Math.sin(a) * r, -0.02, Math.cos(a) * r], tag: 'cloth' });
    for (let k = 1; k < COAT_LINKS; k++) {
      b.push({ name: `coat${i}_${k}`, parent: `coat${i}_${k - 1}`, pos: [0, -0.225, 0], tag: 'cloth' });
    }
  }
  return b;
}

/* ------------------------------------------------------- derived bind data */

export interface BindData {
  specs: BoneSpec[];
  index: Map<string, number>;
  /** bind-pose WORLD position per bone */
  world: Float32Array;   // 3 per bone
}

export function bindData(): BindData {
  const specs = boneSpecs();
  const index = new Map<string, number>();
  specs.forEach((s, i) => index.set(s.name, i));
  const world = new Float32Array(specs.length * 3);
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i];
    const p = s.parent === null ? -1 : index.get(s.parent)!;
    const px = p < 0 ? 0 : world[p * 3];
    const py = p < 0 ? 0 : world[p * 3 + 1];
    const pz = p < 0 ? 0 : world[p * 3 + 2];
    world[i * 3] = px + s.pos[0];
    world[i * 3 + 1] = py + s.pos[1];
    world[i * 3 + 2] = pz + s.pos[2];
  }
  return { specs, index, world };
}

/** Convenience: bind-pose world position lookup by bone name. */
export function bindPoint(bd: BindData, name: string): THREE.Vector3 {
  const i = bd.index.get(name);
  if (i === undefined) throw new Error(`[palebark] unknown bone ${name}`);
  return new THREE.Vector3(bd.world[i * 3], bd.world[i * 3 + 1], bd.world[i * 3 + 2]);
}

/* --------------------------------------------------------- runtime builder */

export interface PalebarkRigBones {
  root: THREE.Bone;
  bones: THREE.Bone[];
  byName: Map<string, THREE.Bone>;
  index: Map<string, number>;
  skeleton: THREE.Skeleton;
  bind: BindData;
}

/** Instantiate the hierarchy as Three.js bones + a Skeleton (bind pose = specs). */
export function buildSkeleton(): PalebarkRigBones {
  const bind = bindData();
  const bones: THREE.Bone[] = [];
  const byName = new Map<string, THREE.Bone>();
  for (const spec of bind.specs) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    bone.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);
    bone.userData.tag = spec.tag;
    bones.push(bone);
    byName.set(spec.name, bone);
    if (spec.parent) byName.get(spec.parent)!.add(bone);
  }
  const root = bones[0];
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  return { root, bones, byName, index: bind.index, skeleton, bind };
}

/** Bone-count report used by the QA gates. */
export function skeletonStats(): {
  total: number; spineExtra: number; limbExtra: number; cloth: number; finger: number;
} {
  const specs = boneSpecs();
  const count = (t: BoneTag) => specs.filter(s => s.tag === t).length;
  return {
    total: specs.length,
    spineExtra: count('spine-extra'),
    limbExtra: count('limb-extra'),
    cloth: count('cloth'),
    finger: count('finger'),
  };
}
