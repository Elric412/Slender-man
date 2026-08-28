/**
 * Offline mesh report — prints triangle/vertex counts, silhouette stats and the
 * featureless-face proof for every LOD. Run:
 *
 *   npm run palebark:report
 */
import { buildPalebark, faceFeatureCount, faceReliefStats, silhouetteStats } from '../src/entity/PalebarkGeometry';
import { LOD_DENSITY, LOD_TRI_BUDGET } from '../src/entity/PalebarkLOD';
import { skeletonStats } from '../src/entity/PalebarkSkeleton';

const relief = faceReliefStats();
console.log(`face relief: +${(relief.maxOut * 1000).toFixed(2)}mm / -${(relief.maxIn * 1000).toFixed(2)}mm`);
const s = skeletonStats();
console.log(`skeleton: ${s.total} bones  (spine-extra ${s.spineExtra}, limb-extra ${s.limbExtra}, finger ${s.finger}, cloth ${s.cloth})`);

let ok = true;
LOD_DENSITY.forEach((d, i) => {
  const r = buildPalebark({ density: d });
  const sil = silhouetteStats(r.geometry);
  const budget = LOD_TRI_BUDGET[i];
  const inBudget = r.triangles >= budget[0] && r.triangles <= budget[1];
  if (!inBudget) ok = false;
  const face = faceFeatureCount(r.geometry);
  if (face !== 0) ok = false;
  console.log(
    `LOD${i} density ${d.toFixed(3)}  tris ${r.triangles}  verts ${r.vertices}  ` +
    `[skin ${r.groupCounts[0]} / coat ${r.groupCounts[1]}]  budget ${budget[0]}–${budget[1]} ${inBudget ? 'OK' : 'FAIL'}  ` +
    `h ${sil.height.toFixed(3)}m w ${sil.width.toFixed(3)}m d ${sil.depth.toFixed(3)}m  slender ${sil.slenderness.toFixed(2)}  faceFeatures ${face}`);
});
console.log(ok ? 'MESH REPORT: PASS' : 'MESH REPORT: FAIL');
process.exit(ok ? 0 : 1);
