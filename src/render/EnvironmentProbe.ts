import * as THREE from 'three';

/**
 * Image-based ambient lighting from the procedural sky.
 *
 * Even a moonless forest has *directional* ambient: the sky dome is brighter
 * overhead and near the moon, and wet bark / puddles / the flashlight lens all
 * want a real specular environment to reflect. A flat `HemisphereLight` can't do
 * that — it gives you two constant colours and dead metal.
 *
 * So we render the existing sky shader into a small cube map once, run it
 * through `PMREMGenerator` (GGX-prefiltered roughness mips) and hand the result
 * to `scene.environment`. Cost: a handful of tiny draws at boot, then zero per
 * frame. Refreshing it is cheap enough to do on weather changes.
 */
export class EnvironmentProbe {
  private pmrem: THREE.PMREMGenerator;
  private cubeRT: THREE.WebGLCubeRenderTarget;
  private cubeCam: THREE.CubeCamera;
  private probeScene = new THREE.Scene();
  private skyClone: THREE.Mesh | null = null;
  texture: THREE.Texture | null = null;

  constructor(private renderer: THREE.WebGLRenderer, resolution = 128) {
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();
    this.cubeRT = new THREE.WebGLCubeRenderTarget(resolution, {
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.HalfFloatType,
    });
    this.cubeCam = new THREE.CubeCamera(0.5, 2000, this.cubeRT);
  }

  /**
   * Capture the sky. `skyMesh` is rendered into an isolated scene so terrain,
   * fog and the player's flashlight can never leak into the ambient term.
   */
  capture(skyMesh: THREE.Mesh): THREE.Texture {
    if (!this.skyClone) {
      // share the material (so time/moon uniforms stay live) but not the graph
      this.skyClone = new THREE.Mesh(skyMesh.geometry, skyMesh.material);
      this.skyClone.frustumCulled = false;
      this.probeScene.add(this.skyClone);
    }
    const prevTarget = this.renderer.getRenderTarget();
    this.cubeCam.update(this.renderer, this.probeScene);
    const prev = this.texture;
    this.texture = this.pmrem.fromCubemap(this.cubeRT).texture;
    prev?.dispose();
    this.renderer.setRenderTarget(prevTarget);
    return this.texture;
  }

  dispose(): void {
    this.texture?.dispose();
    this.cubeRT.dispose();
    this.pmrem.dispose();
    this.skyClone = null;
  }
}
