// The real axle of each wheel in a car model, from its geometry.
//
// A wheel is a flat disc: its thinnest direction (the eigenvector of the smallest
// eigenvalue of its vertices' covariance) is the axle. Used by tools/prep-car-model.mjs to
// straighten wheels that were modelled steered, and by tests/models.test.mjs to check that
// every axle lies along the car's X axis.
//
// Works on a @gltf-transform/core Document. Wheel nodes are found with the game's own
// pattern (core/carModels.js WHEEL), on the names GLTFLoader gives them.
import { WHEEL } from '../public/js/core/carModels.js';

// three's PropertyBinding.sanitizeNodeName: what GLTFLoader turns a node's name into
export const sanitize = name => name.replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '');

const apply = (m, p) => [
  m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
  m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
  m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
];

// eigen-decomposition of a symmetric 3x3 (Jacobi), ascending: [{ val, vec }]
function eigen(A){
  const a = A.map(r => r.slice()), v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for(let sweep = 0; sweep < 50; sweep++){
    for(let p = 0; p < 2; p++) for(let q = p + 1; q < 3; q++){
      if(Math.abs(a[p][q]) < 1e-18) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for(let k = 0; k < 3; k++){ const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
      for(let k = 0; k < 3; k++){ const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
      for(let k = 0; k < 3; k++){ const x = v[k][p], y = v[k][q]; v[k][p] = c * x - s * y; v[k][q] = s * x + c * y; }
    }
  }
  return [0, 1, 2].map(i => ({ val: a[i][i], vec: [v[0][i], v[1][i], v[2][i]] })).sort((x, y) => x.val - y.val);
}

// Every wheel node's vertices in world space (the file's scene space).
function points(node){
  const pts = [];
  node.traverse(n => {
    const mesh = n.getMesh(); if(!mesh) return;
    const W = n.getWorldMatrix();
    for(const p of mesh.listPrimitives()){
      const a = p.getAttribute('POSITION'), e = [];
      for(let i = 0; i < a.getCount(); i++) pts.push(apply(W, a.getElement(i, e)));
    }
  });
  return pts;
}

// [{ node, name, axle: [x,y,z] (x >= 0), centre: [x,y,z], offX: degrees off the X axis }]
// centre: the middle of the wheel's extent along its own three axes (not the vertex mean,
// which a spoked rim pulls aside).
export function wheelAxles(doc){
  const out = [];
  for(const node of doc.getRoot().listNodes()){
    if(!WHEEL.test(sanitize(node.getName()))) continue;
    const pts = points(node);
    if(pts.length < 8) continue;
    const mean = [0, 1, 2].map(k => pts.reduce((s, p) => s + p[k], 0) / pts.length);
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for(const p of pts) for(let i = 0; i < 3; i++) for(let j = 0; j < 3; j++) C[i][j] += (p[i] - mean[i]) * (p[j] - mean[j]);
    const E = eigen(C);
    const centre = mean.slice();
    for(const { vec } of E){
      let lo = Infinity, hi = -Infinity;
      for(const p of pts){ const d = (p[0] - mean[0]) * vec[0] + (p[1] - mean[1]) * vec[1] + (p[2] - mean[2]) * vec[2]; lo = Math.min(lo, d); hi = Math.max(hi, d); }
      for(let k = 0; k < 3; k++) centre[k] += vec[k] * (lo + hi) / 2;
    }
    const axle = E[0].vec[0] < 0 ? E[0].vec.map(v => -v) : E[0].vec;
    out.push({ node, name: sanitize(node.getName()), axle, centre, offX: Math.acos(Math.min(1, axle[0])) * 180 / Math.PI });
  }
  return out;
}
