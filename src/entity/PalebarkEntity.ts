import * as THREE from 'three';
import { buildSkeleton, type PalebarkRigBones } from './PalebarkSkeleton';
import { buildPalebark } from './PalebarkGeometry';
import { LOD_DENSITY, PalebarkLodController } from './PalebarkLOD';
import { PalebarkMaterials } from './PalebarkMaterial';
import { PalebarkAnimator, type AnimState } from './PalebarkAnimator';
import { PalebarkCloth } from './PalebarkCloth';
import type { QualityTier } from '../core/Config';

/**
 * ============================================================================
 * PALEBARK — the assembled entity
 * ============================================================================
 *
 * This is the single object the game holds. It owns:
 *
 *   - three `SkinnedMesh` LODs, **all bound to one skeleton**;
 *   - the LOD cross-fade controller;
 *   - the layered procedural animator;
 *   - the Verlet coat cloth;
 *   - the material set (and its hero-texture streaming).
 *
 * ## Why one skeleton for three meshes
 *
 * The obvious build is one skeleton per LOD. That is wrong here for two
 * reasons. First, animation cost would triple for no visual gain — the pose is
 * identical, only the tessellation differs. Second, and worse: during a
 * cross-fade *both* levels are on screen simultaneously, and two separately
 * integrated skeletons would drift by a frame, so the dissolve would show a
 * double-image ghost at silhouette edges. Sharing the skeleton makes the two
 * levels pixel-coincident by construction, which is what lets the dither
 * dissolve read as a single object rather than a swap.
 *
 * ## Why the meshes never get frustum-culled by three
 *
 * `frustumCulled = false`, and the group is positioned by us. A skinned mesh's
 * bounding volume is its *bind pose* volume; ours legitimately grows when the
 * extension beat plays, and a 2.6 m figure at 50 m sitting right on the frustum
 * edge is exactly when a false cull is most visible. We cull by distance
 * ourselves (`LodController.cullDistance`), which is cheaper and honest.
 *
 * ## Order of operations per frame (this matters)
 *
 *   1. animator writes bone rotations + solves foot IK      (pose is now final)
 *   2. cloth reads the *posed* bones and writes cloth bones (hem follows pose)
 *   3. LOD weights update, fade uniforms are pushed
 *
 * Running the cloth before the animator would make the coat lag the body by a
 * frame — which sounds like the "beat of lag" the brief asks for, but is not:
 * that lag is a *physical* property of heavy wool and must come from the
 * solver's damping, not from a scheduling accident that also breaks when the
 * frame rate changes.
 */

/** What the game tells Palebark each frame. */
export interface EntityFrame {
  /** world position of the entity's feet */
  x: number; y: number; z: number;
  /** facing, radians */
  yaw: number;
  /** planar speed, m/s */
  speed: number;
  /** AI state, mapped from the brain's vocabulary */
  state: AnimState;
  /** 0..1 accumulated detection — single source of truth */
  detection: number;
  /** camera position, for LOD distance and gaze */
  camera: THREE.Vector3;
  /** where to look — normally the player's head. null = look along yaw */
  gaze: THREE.Vector3 | null;
  /** 0..1 how strongly it regards the player */
  gazeWeight: number;
  /** terrain sampler; feet are planted against this */
  groundAt(x: number, z: number): number;
  /** ambient wind vector (m/s), for the coat */
  wind: THREE.Vector3;
  /** 0..1 global wetness — darkens and stiffens the coat */
  wetness: number;
  /** tapes collected: drives grime *and* extension eligibility in lockstep */
  tapes: number;
  /** total tapes in the run */
  tapesTotal: number;
  /** the AI is asking for the extension beat right now */
  extensionRequest: boolean;
  /** deterministic per-run variation */
  rand: () => number;
  /** ms of frame budget the texture streamer may spend */
  streamBudgetMs: number;
}

export interface EntityBuildOptions {
  tier: QualityTier;
  anisotropy: number;
  seed: number;
  onProgress?: (f: number, label: string) => void;
}

/**
 * Late-game gate for the extension beat.
 *
 * The brief ties this to the tape milestone, and deliberately to the *same*
 * value the grime mask reads, so the character's escalation is visible in two
 * independent channels that can never disagree.
 */
export const EXTENSION_MILESTONE = 6;

export class PalebarkEntity {
  /** add this to the scene */
  readonly group = new THREE.Group();

  readonly rig: PalebarkRigBones;
  readonly materials: PalebarkMaterials;
  readonly animator: PalebarkAnimator;
  readonly cloth: PalebarkCloth;
  readonly lod = new PalebarkLodController();

  /** per-level meshes; [0] is the hero */
  private meshes: THREE.SkinnedMesh[] = [];
  /** triangle counts, for the perf overlay */
  readonly triangles: number[] = [];

  private lastPos = new THREE.Vector3();
  private velocity = new THREE.Vector3();
  private bodyCentre = new THREE.Vector3();
  private gazeTarget = new THREE.Vector3();
  private visible = true;
  private started = false;

  /** QA counters */
  get extensionCount(): number { return this.animator.extensionCount; }
  get footError(): number { return this.animator.footError; }
  get activeLevel(): number { return this.lodActive; }
  private lodActive = 0;
  private lodWeights: [number, number, number] = [1, 0, 0];

  private constructor(mats: PalebarkMaterials) {
    this.materials = mats;
    this.rig = buildSkeleton();
    this.animator = new PalebarkAnimator(this.rig);
    this.cloth = new PalebarkCloth(this.rig);

    // The bone hierarchy lives under the group, exactly once. Every LOD binds
    // to it; none of them owns it.
    this.group.add(this.rig.root);

    for (let level = 0; level < LOD_DENSITY.length; level++) {
      const built = buildPalebark({ density: LOD_DENSITY[level] });
      const [skinMat, coatMat] = mats.forLevel(level);
      const mesh = new THREE.SkinnedMesh(built.geometry, [skinMat, coatMat]);
      // Bind with an identity matrix: the geometry was authored in the same
      // space as the bind pose, so no offset is needed. Passing the skeleton's
      // own matrix here is the classic source of a collapsed mesh.
      mesh.bind(this.rig.skeleton, new THREE.Matrix4());
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = false;   // self-shadowing a matte figure buys nothing
      mesh.visible = level === 0;
      mesh.name = `palebark_lod${level}`;
      // Render after the forest so the dither dissolve composites over settled
      // depth rather than fighting foliage alpha-test for the same pixels.
      mesh.renderOrder = 2;
      this.meshes.push(mesh);
      this.triangles.push(built.triangles);
      this.group.add(mesh);
    }

    this.group.updateMatrixWorld(true);
  }

  static async create(opts: EntityBuildOptions): Promise<PalebarkEntity> {
    const mats = await PalebarkMaterials.create({
      tier: opts.tier,
      anisotropy: opts.anisotropy,
      seed: opts.seed,
      onProgress: opts.onProgress,
    });
    return new PalebarkEntity(mats);
  }

  /**
   * Hard reset — call on run start and after any warp/relocation.
   *
   * Without this the cloth would integrate a 200 m displacement as a single
   * frame of motion and the coat would explode outward before settling, which
   * is both wrong and a dead giveaway that the entity teleported.
   */
  reset(x: number, y: number, z: number, yaw: number, cameraDist = 60): void {
    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;
    this.group.updateMatrixWorld(true);
    this.lastPos.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.animator.reset();
    this.cloth.reset();
    this.lod.reset(cameraDist);
    this.started = false;
  }

  /** Tape milestone → grime + extension eligibility, read from one value. */
  private applyMilestone(tapes: number, tapesTotal: number, wetness: number): void {
    const t = tapesTotal > 0 ? tapes / tapesTotal : 0;
    // Grime does not start at zero: it has been out here a long time before the
    // player arrived. It accelerates slightly toward the end of the run.
    this.materials.setGrime(Math.min(1, 0.22 + t * t * 0.62 + t * 0.24));
    this.materials.setWetness(wetness);
  }

  extensionEligible(tapes: number): boolean {
    return tapes >= EXTENSION_MILESTONE;
  }

  update(dt: number, time: number, f: EntityFrame): void {
    // ---------------------------------------------------------------- transform
    this.group.position.set(f.x, f.y, f.z);
    this.group.rotation.y = f.yaw;

    // Velocity is measured, not taken from the AI: what the coat should react to
    // is how the figure *actually* moved this frame, including any correction
    // the navigation applied. Skipped on the first frame after a reset so a
    // warp cannot register as a velocity spike.
    if (this.started && dt > 1e-5) {
      this.velocity.set(
        (f.x - this.lastPos.x) / dt,
        (f.y - this.lastPos.y) / dt,
        (f.z - this.lastPos.z) / dt,
      );
      // Clamp: a relocation is not a sprint.
      if (this.velocity.lengthSq() > 400) this.velocity.setLength(20);
    } else {
      this.velocity.set(0, 0, 0);
    }
    this.lastPos.set(f.x, f.y, f.z);
    this.started = true;

    // -------------------------------------------------------------- LOD + cull
    const dist = Math.hypot(f.camera.x - f.x, f.camera.z - f.z);
    if (dist > this.lod.cullDistance) {
      if (this.visible) {
        this.group.visible = false;
        this.visible = false;
      }
      // Still advance the texture streamer: the point of streaming is to be
      // ready *before* the player is close enough to notice.
      this.materials.streamStep(f.streamBudgetMs);
      return;
    }
    if (!this.visible) {
      this.group.visible = true;
      this.visible = true;
      // Re-seat the fade weights at the current distance so re-entry does not
      // dissolve in from the wrong level.
      this.lod.reset(dist);
    }

    const w = this.lod.update(dist, dt);
    this.lodWeights = w.w;
    this.lodActive = w.active;
    for (let i = 0; i < this.meshes.length; i++) {
      const on = w.w[i] > 0.002;
      this.meshes[i].visible = on;
      if (on) this.materials.setFade(i, w.w[i]);
    }

    // ------------------------------------------------------------- 1. animation
    const eligible = this.extensionEligible(f.tapes);
    if (f.gaze) this.gazeTarget.copy(f.gaze);
    this.animator.update(dt, time, {
      state: f.state,
      speed: f.speed,
      yaw: f.yaw,
      gaze: f.gaze ? this.gazeTarget : null,
      gazeWeight: f.gazeWeight,
      groundAt: f.groundAt,
      detection: f.detection,
      extensionEligible: eligible,
      extensionRequest: f.extensionRequest,
      rand: f.rand,
    }, this.group.position);

    // ----------------------------------------------------------------- 2. cloth
    // The capsule the hem may not enter is centred on the *torso*, not the
    // origin, or the coat clips through the shins on a slope.
    this.bodyCentre.set(f.x, f.y + 1.35, f.z);
    this.cloth.update(dt, f.wind, f.y, this.bodyCentre, this.velocity);

    // ------------------------------------------------------------ 3. appearance
    this.applyMilestone(f.tapes, f.tapesTotal, f.wetness);
    this.materials.streamStep(f.streamBudgetMs);
  }

  /** Env reflection scale, driven by the weather/exposure director. */
  setEnvIntensity(scale: number): void { this.materials.setEnvIntensity(scale); }

  /** World position of the head — used by the audio layer as the emitter. */
  headWorld(out: THREE.Vector3): THREE.Vector3 {
    const head = this.rig.byName.get('head');
    if (!head) return out.copy(this.group.position);
    return head.getWorldPosition(out);
  }

  debug(): Record<string, unknown> {
    return {
      lod: this.lodActive,
      fade: this.lodWeights.map(v => +v.toFixed(3)),
      tris: this.triangles[this.lodActive],
      texture: this.materials.currentSize,
      streaming: this.materials.upgrading,
      swing: +this.cloth.swing.toFixed(4),
      ...this.animator.debug(),
    };
  }

  dispose(): void {
    for (const m of this.meshes) m.geometry.dispose();
    this.meshes.length = 0;
    this.materials.dispose();
    this.group.clear();
  }
}
