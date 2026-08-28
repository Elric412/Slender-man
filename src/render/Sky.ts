import * as THREE from 'three';

/**
 * Procedural night sky: hash star field (very slowly rotating), moon disc with soft glow,
 * two scrolling high-cloud layers that occasionally cross and dim the moon. No textures.
 */
export class Sky {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  moonDir = new THREE.Vector3(0.35, 0.62, -0.55).normalize();
  private timeU = { value: 0 };
  private moonDimU = { value: 1 };

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTime: this.timeU,
        uMoonDir: { value: this.moonDir },
        uMoonDim: this.moonDimU,
      },
      vertexShader: /* glsl */`
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_Position.z = gl_Position.w; // push to far plane
        }`,
      fragmentShader: /* glsl */`
        varying vec3 vDir;
        uniform float uTime;
        uniform vec3 uMoonDir;
        uniform float uMoonDim;

        float hash13(vec3 p){
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }
        float noise2(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          float a = hash13(vec3(i,1.0)), b = hash13(vec3(i+vec2(1,0),1.0));
          float c = hash13(vec3(i+vec2(0,1),1.0)), d = hash13(vec3(i+vec2(1,1),1.0));
          return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
        }
        float fbm(vec2 p){
          float s=0.0,a=0.5;
          for(int i=0;i<5;i++){ s+=noise2(p)*a; p*=2.03; a*=0.5; }
          return s;
        }

        void main() {
          vec3 d = normalize(vDir);
          // slow celestial rotation
          float rot = uTime * 0.00116;
          mat2 R = mat2(cos(rot), -sin(rot), sin(rot), cos(rot));
          vec3 sd = vec3(R * d.xz, d.y).xzy;

          // base sky gradient
          float horiz = pow(1.0 - clamp(d.y, 0.0, 1.0), 2.5);
          vec3 col = mix(vec3(0.012, 0.018, 0.030), vec3(0.045, 0.06, 0.085), horiz);

          // stars: grid cells on direction
          vec3 sp = sd * 90.0;
          vec3 cell = floor(sp);
          float h = hash13(cell);
          if (h > 0.978 && d.y > -0.05) {
            vec3 f = fract(sp) - 0.5;
            float star = smoothstep(0.28, 0.0, length(f)) * (h - 0.978) * 45.0;
            float tw = 0.75 + 0.25 * sin(uTime * (1.0 + h * 4.0) + h * 40.0);
            col += vec3(0.9, 0.95, 1.0) * star * tw * clamp(d.y * 3.0, 0.0, 1.0);
          }

          // clouds (two layers)
          vec2 cuv = d.xz / max(d.y + 0.24, 0.12);
          float cl1 = fbm(cuv * 0.55 + vec2(uTime * 0.006, uTime * 0.0022));
          float cl2 = fbm(cuv * 1.15 + vec2(-uTime * 0.011, 3.7));
          float clouds = smoothstep(0.48, 0.78, cl1 * 0.65 + cl2 * 0.45) * clamp(d.y * 2.5, 0.0, 1.0);

          // moon
          float mdot = dot(d, normalize(uMoonDir));
          float disc = smoothstep(0.99955, 0.99985, mdot);
          float glow = pow(clamp(mdot, 0.0, 1.0), 220.0) * 0.5 + pow(clamp(mdot, 0.0, 1.0), 24.0) * 0.10;
          // moon surface shading (phase-ish terminator + maria)
          vec3 mU = normalize(cross(uMoonDir, vec3(0.0,1.0,0.0)));
          vec3 mV = cross(mU, uMoonDir);
          vec2 mxy = vec2(dot(d, mU), dot(d, mV)) / max(1.0 - mdot*mdot, 1e-5) * 0.018;
          float maria = fbm(mxy * 8.0 + 5.0) * 0.35;
          vec3 moonCol = vec3(0.95, 0.97, 1.0) * (1.35 - maria);

          float cloudBlock = 1.0 - clouds * 0.85;
          col += moonCol * disc * uMoonDim * cloudBlock;
          col += vec3(0.55, 0.65, 0.85) * glow * uMoonDim * cloudBlock;

          // clouds themselves faintly moonlit
          col += vec3(0.10, 0.12, 0.16) * clouds * (0.35 + 0.65 * pow(clamp(mdot,0.0,1.0), 6.0));

          gl_FragColor = vec4(col, 1.0);
        }`,
    });
    const geo = new THREE.SphereGeometry(760, 32, 16);
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100;
  }

  update(t: number): void { this.timeU.value = t; }

  /** moon dimming when clouds cross it — derived in shader too, this is for scene light sync */
  moonDimAt(time: number): number {
    const d = this.moonDir;
    const cuvX = d.x / Math.max(d.y + 0.24, 0.12), cuvY = d.z / Math.max(d.y + 0.24, 0.12);
    const n = Math.sin(cuvX * 3.1 + time * 0.006 * 5.5) * Math.cos(cuvY * 2.7 + time * 0.0022 * 5.5);
    const m = 1 - Math.max(0, n) * 0.55;
    this.moonDimU.value = m;
    return m;
  }
}
