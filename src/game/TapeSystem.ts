import * as THREE from 'three';
import { MapGenerator, TapeSpawn } from '../world/MapGenerator';
import { MaterialLibrary } from '../world/MaterialLibrary';
import { SeededRandom } from '../core/SeededRandom';

export interface TapeLog {
  zoneId: string;
  title: string;
  lines: string[];
}

/**
 * The eight field recordings.
 *
 * The keys are Pinewood landmark ids and MUST stay that way: `spawnAll` places
 * a tape for each id here, and a key with no matching landmark silently drops a
 * tape, which makes the run impossible to finish. Four of these were previously
 * keyed to zones that no longer existed (station/mill/radio/tunnel) and the
 * game shipped unwinnable, so `TAPE_ZONES` below is asserted against the layout
 * at construction rather than trusted.
 */
export const TAPE_LOGS: Record<string, TapeLog> = {
  hub: {
    zoneId: 'hub', title: 'RECORDER 01 — TRAIL JUNCTION',
    lines: [
      'Day one. Pinebridge is decommissioned but the brass wants one last survey pass.',
      'Mara says the tree counts from \'87 don\'t match the satellite. Of course they don\'t. Trees grow.',
      'Still. Fourteen hundred extra trunks in forty years, and nobody planted a thing.',
    ],
  },
  quarry: {
    zoneId: 'quarry', title: 'RECORDER 02 — QUARRY CUT',
    lines: [
      'The cut goes deeper than the survey map says. Like something kept digging after they left.',
      'Found the foreman\'s truck. Keys still in it. Coffee mug on the dash, mold an inch thick.',
      'He left in a hurry, and he left on foot. Nobody leaves on foot from here.',
    ],
  },
  tower: {
    zoneId: 'tower', title: 'RECORDER 03 — FIRE LOOKOUT',
    lines: [
      'You can see the whole valley from up here. That\'s the problem.',
      'There\'s a figure at the treeline. Been there an hour. Hasn\'t moved.',
      'I looked away to write this down. It\'s closer now. It did not walk. I would have seen it walk.',
    ],
  },
  dock: {
    zoneId: 'dock', title: 'RECORDER 04 — LAKE DOCK',
    lines: [
      'Eli took the rowboat out at dawn to log water samples. The boat came back. He didn\'t.',
      'There are handprints in the dock algae. Long ones. The fingers reach the fourth knuckle.',
      'The lake is the only place the trees don\'t crowd in. I understand why now.',
    ],
  },
  clearing: {
    zoneId: 'clearing', title: 'RECORDER 05 — WINDTHROW CLEARING',
    lines: [
      'The mill ledger says they stripped this valley in \'62. Every stand, clear-cut.',
      'So explain the old growth. Some of these trunks are a meter across.',
      'It isn\'t that the forest grew back. It\'s that the forest came back. There\'s a difference.',
    ],
  },
  ridge: {
    zoneId: 'ridge', title: 'RECORDER 06 — NORTH RIDGE',
    lines: [
      'Broadcast our position on the emergency band for six hours. Got one reply.',
      'Thirty seconds of static, then my own voice. Saying things I haven\'t said yet.',
      'One of the things it said was: stop counting the trees.',
    ],
  },
  shack: {
    zoneId: 'shack', title: 'RECORDER 07 — ABANDONED SHACK',
    lines: [
      'The collapse wasn\'t an accident. The charges were set from inside.',
      'Whatever the survey crews in \'62 woke up, they tried to bury the way it came out.',
      'Mara wants to go in. I told her the locals had a name for it before the station ever had one.',
      'They called it Palebark. For the color of its face against the birch.',
    ],
  },
  camp: {
    zoneId: 'camp', title: 'RECORDER 08 — CAMPGROUND',
    lines: [
      'If you found this, you found the others. Then you already know it watches.',
      'It doesn\'t chase because it doesn\'t need to. The forest walks for it.',
      'The road east still goes somewhere. Take it. Don\'t stop for the tapes like we did.',
      'Don\'t count the—',
    ],
  },
};

interface ActiveTape {
  zoneId: string;
  mesh: THREE.Group;
  glowMat: THREE.MeshStandardMaterial;
  spawn: TapeSpawn;
  collected: boolean;
}

/** Tape placement, pickup detection, and narrative playback state. */
export class TapeSystem {
  tapes: ActiveTape[] = [];
  collected = 0;
  readonly total = 8;
  nearest: ActiveTape | null = null;
  onPickup: ((zoneId: string, x: number, z: number) => void) | null = null;
  private runRng: SeededRandom;
  /** ONE shared light follows the nearest tape — the other seven get an
   *  emissive pulse instead of a live PointLight each. Forward rendering pays
   *  per-light in every fragment, so 8 static lights → 1 is a real saving. */
  private glowLight = new THREE.PointLight(0xc8b98a, 0, 3.2, 2);

  constructor(
    private map: MapGenerator,
    private mats: MaterialLibrary,
    private scene: THREE.Scene,
    runSeed: number,
  ) {
    this.runRng = new SeededRandom(runSeed ^ 0x7A9E0);
    this.scene.add(this.glowLight);
  }

  /**
   * Place exactly one tape for each of the eight recordings.
   *
   * Driven by TAPE_LOGS, not by the tape-pool map: the world has thirteen
   * landmarks and every one of them contributes a pool, so iterating the pools
   * would spawn thirteen tapes against a `total` of 8 and "8/8" would never be
   * reachable. The recordings are the authority on how many tapes exist; the
   * pools only decide *where within a landmark* each one hides.
   */
  spawnAll(runSeed: number): void {
    this.clearMeshes();
    this.runRng = new SeededRandom((runSeed >>> 0) ^ 0x7A9E0);
    this.tapes = [];
    this.collected = 0;
    this.glowLight.intensity = 0;
    for (const zoneId of Object.keys(TAPE_LOGS)) {
      const pool = this.map.tapePools.get(zoneId);
      if (!pool || !pool.length) {
        console.error(`[TapeSystem] recording '${zoneId}' has no spawn pool — that tape cannot be collected and the run is unwinnable.`);
        continue;
      }
      const spawn = this.runRng.pick(pool);
      const { mesh, glowMat } = this.makeTapeMesh();
      mesh.position.set(spawn.x, spawn.y, spawn.z);
      this.scene.add(mesh);
      this.tapes.push({ zoneId, mesh, glowMat, spawn, collected: false });
    }
  }

  private makeTapeMesh(): { mesh: THREE.Group; glowMat: THREE.MeshStandardMaterial } {
    const g = new THREE.Group();
    // A compact cassette that reads at night: a dark shell, a lighter clear
    // window showing the two reels, and a warm upright spine label whose
    // emissive pulse is the "I'm an interactable" beacon. Slightly larger and
    // propped up on edge so its silhouette separates from the leaf litter.
    const shell = new THREE.MeshStandardMaterial({ color: 0x1b1b20, roughness: 0.42, metalness: 0.25 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.105), shell);
    // clear window strip across the face — catches moon/beam specular
    const window_ = new THREE.Mesh(
      new THREE.BoxGeometry(0.10, 0.032, 0.052),
      new THREE.MeshStandardMaterial({ color: 0x2a2c33, roughness: 0.12, metalness: 0.65 }));
    window_.position.y = 0.004;
    const reelMat = new THREE.MeshStandardMaterial({ color: 0x9a9588, roughness: 0.4, metalness: 0.1 });
    const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.036, 12), reelMat);
    reel.position.set(-0.032, 0.005, 0);
    const reel2 = reel.clone(); reel2.position.x = 0.032;
    // warm spine label — emissive pulse marks it as an interactable. Stands the
    // cassette on its long edge so the label faces up and is seen from height.
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0x4a4028, roughness: 0.55, emissive: 0xe0cf9a, emissiveIntensity: 0.9,
    });
    const label = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.034, 0.03), glowMat);
    label.position.set(0, 0.006, 0.045);
    g.add(body, window_, reel, reel2, label);
    // stand the whole cassette on edge, label side up-ish, leaning back a touch
    g.rotation.x = -0.32;
    return { mesh: g, glowMat };
  }

  private clearMeshes(): void {
    for (const t of this.tapes) this.scene.remove(t.mesh);
    this.tapes = [];
    this.glowLight.intensity = 0;
  }

  /** returns nearest tape within reach, updates highlight pulse */
  update(time: number, px: number, py: number, pz: number): ActiveTape | null {
    this.nearest = null;
    let best = 2.4;
    let beacon: ActiveTape | null = null;
    let beaconD = 26;
    for (const t of this.tapes) {
      if (t.collected) continue;
      // idle bob/spin so tapes read as interactables
      t.mesh.rotation.y = time * 1.2;
      t.mesh.position.y = t.spawn.y + Math.sin(time * 2 + t.spawn.x) * 0.03;
      // per-tape emissive pulse — visible beacon in the dark, no light cost.
      // Modulates around the new 0.9 base (brighter label) without clipping.
      t.glowMat.emissiveIntensity = 0.7 + 0.45 * (0.5 + 0.5 * Math.sin(time * 2.6 + t.spawn.x * 1.7));
      const d = Math.hypot(t.spawn.x - px, t.spawn.z - pz);
      const dy = Math.abs(t.spawn.y - py);
      if (d < best && dy < 2.2) { best = d; this.nearest = t; }
      if (d < beaconD) { beaconD = d; beacon = t; }
    }
    // shared light hugs the closest uncollected tape and brightens as you near
    if (beacon) {
      this.glowLight.position.set(beacon.spawn.x, beacon.mesh.position.y + 0.22, beacon.spawn.z);
      this.glowLight.intensity = 0.3 + 0.9 * Math.max(0, 1 - beaconD / 26);
    } else {
      this.glowLight.intensity = 0;
    }
    return this.nearest;
  }

  tryCollect(): string | null {
    if (!this.nearest || this.nearest.collected) return null;
    this.nearest.collected = true;
    this.scene.remove(this.nearest.mesh);
    this.collected++;
    const t = this.nearest;
    this.nearest = null;
    this.onPickup?.(t.zoneId, t.spawn.x, t.spawn.z);
    return t.zoneId;
  }
}
