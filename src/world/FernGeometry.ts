import * as THREE from 'three';

/** Four curved fronds with folded leaflets: 96 triangles, shared by instances. */
export function makeFernGeometry(): THREE.BufferGeometry {
  const positions: number[] = [], uvs: number[] = [];
  const point = (a: number, r: number, y: number, side: number) => [
    Math.cos(a) * r - Math.sin(a) * side, y,
    Math.sin(a) * r + Math.cos(a) * side,
  ];
  const tri = (a: number[], b: number[], c: number[]) => {
    positions.push(...a, ...b, ...c);
    uvs.push(0, 0, 0.5, 1, 1, 0);
  };
  for (let f = 0; f < 4; f++) {
    const angle = f * 2.39996, length = 0.58 + f * 0.045;
    for (let j = 0; j < 6; j++) {
      const t = (j + 1) / 7;
      const radius = length * t;
      const height = 0.07 + Math.sin(t * 2.1) * (0.43 + f * 0.02);
      const width = 0.17 * Math.sin(t * Math.PI) * (1 - t * 0.35);
      for (const side of [-1, 1]) {
        const base = point(angle, radius - 0.03, height, 0);
        const tip = point(angle, radius + 0.065, height - width * 0.30, side * width);
        const back = point(angle, radius + 0.036, height + 0.015, side * 0.02);
        const ridge = point(angle, radius + 0.015, height + 0.022, side * width * 0.45);
        tri(base, ridge, tip);
        tri(ridge, back, tip);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
