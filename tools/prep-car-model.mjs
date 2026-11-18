// Prepare a car model for the game:
//  - remove the interior (seats, dashboard, engine...): the windows become opaque, so it is never seen
//  - one window material for every car: "Glass", dark and opaque (like the GT-R's)
//  - the body paint in its own material, "Paint", with no texture: the game recolours it by
//    setting one colour. Where the paint was baked into a texture atlas, the triangles whose
//    texels are the body colour are split off into the Paint material.
// usage: node tools/prep-car-model.mjs <in.glb> <out.glb> <config name>
// needs (not part of the game's dependencies; install once in a scratch folder or with -g):
//   npm i @gltf-transform/core@4 @gltf-transform/extensions@4 @gltf-transform/functions@4 meshoptimizer jpeg-js pngjs
// The originals are in the 3D-Cars branch. A new car needs an entry in CFG below: which
// materials/nodes are the interior, which are window glass, and where the body paint is.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, simplify, weld, convertPrimitiveToTriangles } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const CFG = {
  muscle_car: {
    removeMats: ['interior', 'screens'], removeNodes: /stearingwheel/i,
    glassMats: ['glass'], paintMats: ['body'],
  },
  generic_sedan_car: {
    removeMats: ['interior', 'engine'],
    glassMats: ['Glass_ext-tinted', 'Glass_ext'], split: { mats: ['Car_Paint_-_All_Colors'], color: [101, 103, 112] },
  },
  generic_sport_coupe_car: {
    removeMats: ['interior', 'media'],
    glassMats: ['Glass_ext-tinted', 'Glass_ext'],
    split: { mats: ['car-body'], nodes: /^(?!headlight)/, color: [136, 20, 19] },      // the headlight parts share the atlas: never paint
  },
  nexus_rx: {
    removeMats: ['Inside'], removeNodes: /DashBoard|Steering|Seat|Wine|Divider|^Inside/i,
    glassNodes: /^Windows/i, solidMats: ['Tires_And_Windows'], split: { mats: ['Outside'], nodes: /Body|Door/i, color: [79, 84, 113], thr: 28 },
    simplify: 0.5,
  },
  nissan_gtr_r32: { split: { mats: ['CarPaint_Atlas'], nodes: /^(Body|Spoiler)/, color: [47, 47, 47], thr: 7 } },
  sports_car: { split: { mats: ['cordenadas'], color: [226, 39, 39] } },
  everest: { split: { mats: ['Texture'], nodes: /^Body/, color: [31, 92, 255], thr: 45 } },
  lowpoly_stylized_rx_7_free: { split: { mats: ['Material.001', 'Material.002', 'Material.003'], color: [252, 109, 0], thr: 40 } },
};

const [, , IN, OUT, NAME] = process.argv;
const cfg = CFG[NAME]; if (!cfg) throw new Error('no config ' + NAME);
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(IN);
const root = doc.getRoot();
const log = (...a) => console.log(NAME + ':', ...a);
const nodeOf = new Map();
for (const n of root.listNodes()) { const m = n.getMesh(); if (m) for (const p of m.listPrimitives()) nodeOf.set(p, n); }
const prims = () => root.listMeshes().flatMap(m => m.listPrimitives().map(p => [m, p]));
const matName = p => (p.getMaterial() ? p.getMaterial().getName() : '');
const tri = p => p.getIndices() ? p.getIndices().getCount() / 3 : p.getAttribute('POSITION').getCount() / 3;
// strips and fans (some low-poly exports) become plain triangle lists first
for (const [, p] of prims()) if (p.getMode() === 5 || p.getMode() === 6) convertPrimitiveToTriangles(p);
const before = prims().reduce((s, [, p]) => s + tri(p), 0);

// --- 1. the interior ---
let removed = 0;
for (const [, p] of prims()) {
  const n = nodeOf.get(p);
  if ((cfg.removeMats || []).includes(matName(p)) || (cfg.removeNodes && n && cfg.removeNodes.test(n.getName()))) { removed += tri(p); p.dispose(); }
}
log('interior removed', Math.round(removed), 'triangles');

// --- 2. glass ---
const glass = doc.createMaterial('Glass').setBaseColorFactor([0.022, 0.025, 0.03, 1])
  .setMetallicFactor(0.2).setRoughnessFactor(0.22).setAlphaMode('OPAQUE').setDoubleSided(true);
let glassed = 0;
for (const [, p] of prims()) {
  const n = nodeOf.get(p);
  if ((cfg.glassMats || []).includes(matName(p)) || (cfg.glassNodes && n && cfg.glassNodes.test(n.getName()))) { p.setMaterial(glass); glassed += tri(p); }
}
log('glass', Math.round(glassed), 'triangles');

// --- 3. paint ---
const toLin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const paint = doc.createMaterial('Paint').setMetallicFactor(0.1).setRoughnessFactor(0.35).setAlphaMode('OPAQUE');
let painted = 0;
for (const [, p] of prims()) if ((cfg.paintMats || []).includes(matName(p))) {
  if (!painted) paint.setBaseColorFactor(p.getMaterial().getBaseColorFactor());
  p.setMaterial(paint); painted += tri(p);
}

function decode(tex) {
  const buf = Buffer.from(tex.getImage());
  if (tex.getMimeType() === 'image/png') { const png = PNG.sync.read(buf); return { w: png.width, h: png.height, d: png.data }; }
  const j = jpeg.decode(buf, { useTArray: true }); return { w: j.width, h: j.height, d: j.data };
}
if (cfg.split) {
  const cand = prims().filter(([, p]) => cfg.split.mats.includes(matName(p)) && (!cfg.split.nodes || cfg.split.nodes.test(nodeOf.get(p)?.getName() || '')));
  const imgs = new Map();
  const img = m => { if (!imgs.has(m)) imgs.set(m, decode(m.getBaseColorTexture())); return imgs.get(m); };
  const sample = (im, u, v) => {
    const x = Math.min(im.w - 1, Math.floor((((u % 1) + 1) % 1) * im.w)), y = Math.min(im.h - 1, Math.floor((((v % 1) + 1) % 1) * im.h));
    const i = (y * im.w + x) * 4; return [im.d[i], im.d[i + 1], im.d[i + 2]];
  };
  // per face: 4 samples (corners and centre) and the face area
  const faces = [];
  for (const [mesh, p] of cand) {
    const im = img(p.getMaterial()); const uv = p.getAttribute('TEXCOORD_0'), pos = p.getAttribute('POSITION');
    const idx = p.getIndices() ? Array.from(p.getIndices().getArray()) : [...Array(pos.getCount()).keys()];
    const U = [], P = [];
    for (let f = 0; f < idx.length / 3; f++) {
      const t = [0, 1, 2].map(k => uv.getElement(idx[f * 3 + k], []));
      const q = [0, 1, 2].map(k => pos.getElement(idx[f * 3 + k], []));
      const c = [(t[0][0] + t[1][0] + t[2][0]) / 3, (t[0][1] + t[1][1] + t[2][1]) / 3];
      const s = [...t, c].map(([u, v]) => sample(im, u, v));
      const e1 = q[1].map((v, i) => v - q[0][i]), e2 = q[2].map((v, i) => v - q[0][i]);
      const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      faces.push({ p, mesh, f, s, a: Math.hypot(...cr) / 2 });
    }
  }
  // the body colour: the colour covering the largest area (or the one given)
  let body = cfg.split.color;
  if (!body) {
    const hist = new Map();
    for (const F of faces) { const c = F.s[3]; const k = c.map(v => v >> 4).join(','); const h = hist.get(k) || { a: 0, sum: [0, 0, 0] }; h.a += F.a; h.sum = h.sum.map((v, i) => v + c[i] * F.a); hist.set(k, h); }
    const top = [...hist.values()].sort((a, b) => b.a - a.a);
    if (process.env.TOP) top.slice(0, 8).forEach(h => log('  colour', h.sum.map(v => Math.round(v / h.a)).join(','), 'area', h.a.toPrecision(3)));
    const best = top[0];
    body = best.sum.map(v => v / best.a);
  }
  const thr = cfg.split.thr || 42;
  const near = c => Math.hypot(c[0] - body[0], c[1] - body[1], c[2] - body[2]) < thr;
  const byPrim = new Map();
  // the centre decides (low-poly palettes put a face's corners on the edge of a colour cell);
  // three corners out of four also do
  for (const F of faces) { const isPaint = near(F.s[3]) || F.s.slice(0, 3).filter(near).length >= 3; const b = byPrim.get(F.p) || { mesh: F.mesh, keep: [], paint: [] }; (isPaint ? b.paint : b.keep).push(F.f); byPrim.set(F.p, b); }
  for (const [p, b] of byPrim) {
    if (!b.paint.length) continue;
    const pos = p.getAttribute('POSITION');
    const idx = p.getIndices() ? Array.from(p.getIndices().getArray()) : [...Array(pos.getCount()).keys()];
    const Arr = pos.getCount() > 65535 ? Uint32Array : Uint16Array;
    const pick = list => new Arr(list.flatMap(f => [idx[f * 3], idx[f * 3 + 1], idx[f * 3 + 2]]));
    const np = doc.createPrimitive().setMaterial(paint).setMode(p.getMode())
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(pick(b.paint)).setBuffer(root.listBuffers()[0]));
    for (const sem of p.listSemantics()) np.setAttribute(sem, p.getAttribute(sem));
    b.mesh.addPrimitive(np);
    if (b.keep.length) p.setIndices(doc.createAccessor().setType('SCALAR').setArray(pick(b.keep)).setBuffer(root.listBuffers()[0]));
    else p.dispose();
    painted += b.paint.length;
  }
  paint.setBaseColorFactor([...body.map(v => toLin(v / 255)), 1]);
  log('body colour', body.map(Math.round).join(','), '→ paint');
}
log('paint', Math.round(painted), 'triangles');
if (!painted) throw new Error('nothing painted');

// tyres that shared a see-through material with the windows: solid now
for (const m of root.listMaterials()) if ((cfg.solidMats || []).includes(m.getName())) m.setAlphaMode('MASK').setAlphaCutoff(0.5);

// --- 4. tidy ---
await doc.transform(prune(), dedup());
if (cfg.simplify) await doc.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ratio: cfg.simplify, error: 0.0005 }));
await doc.transform(prune());
const after = prims().reduce((s, [, p]) => s + tri(p), 0);
await io.write(OUT, doc);
log('triangles', Math.round(before), '→', Math.round(after));
