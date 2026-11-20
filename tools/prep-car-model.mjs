// Prepare a car model for the game, in two steps.
//
// prep (from an original download, the 3D-Cars branch) → models-src/cars/<name>.glb:
//  - remove the interior (seats, dashboard, engine...): the windows become opaque, so it is never seen
//  - one window material for every car: "Glass", dark and opaque (like the GT-R's)
//  - the body paint in its own material, "Paint", with no texture: the game recolours it by
//    setting one colour. Where the paint was baked into a texture atlas, the triangles whose
//    texels are the body colour are split off into the Paint material.
// pack (models-src/cars/<name>.glb → public/models/cars/<name>.glb, what the game loads):
//  - wheels modelled steered (Rally, Ford) are turned straight: each wheel's axle (its
//    thinnest direction, tools/wheel-axle.mjs) is put along the car's X axis, or the wheel
//    wobbles in a figure eight as it spins
//  - textures to WebP (EXT_texture_webp): colour maps at most 1024 px, the others
//    (normal, roughness, occlusion) at most 512 px
//  - geometry quantised and meshopt-compressed (EXT_meshopt_compression): the game loads
//    three's meshopt_decoder.js for it (index.html)
//
// usage:
//   node tools/prep-car-model.mjs <original.glb> <out.glb> <config name>    prep, then pack
//   node tools/prep-car-model.mjs --pack <in.glb> <out.glb>                 pack only
//   node tools/prep-car-model.mjs --pack-all                                models-src/cars/* → public/models/cars/
//   node tools/prep-car-model.mjs --versions                                only rewrite the ?v= hashes
// Every run ends by rewriting the models' versions (public/js/core/modelVersions.js and
// the preload map in public/index.html): a hash of each file, in its URL.
// pack needs the devDependencies (npm install). prep also needs jpeg-js and pngjs:
//   npm i --no-save jpeg-js pngjs
// The originals are in the 3D-Cars branch. A new car needs an entry in CFG below: which
// materials/nodes are the interior, which are window glass, and where the body paint is.
// Its prepped, uncompressed file goes to models-src/cars/ (kept out of public/), so the
// pack step can be redone or tuned without the originals.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, simplify, weld, join, convertPrimitiveToTriangles, textureCompress, meshopt } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import sharp from 'sharp';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { wheelAxles } from './wheel-axle.mjs';

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

await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready]);
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const kb = f => Math.round(statSync(f).size / 1024) + ' KB';

/* ---------- pack ---------- */
// 4x4 column-major helpers (glTF's layout), affine only
const mul = (a, b) => { const o = new Array(16).fill(0); for(let c = 0; c < 4; c++) for(let r = 0; r < 4; r++) for(let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]; return o; };
function invert(m){
  const [a, b, c, d, e, f, g, h, i] = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];   // rows
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  const r = [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
  const t = [m[12], m[13], m[14]];
  return [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0,
    -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]), -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]), -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]), 1];
}
const translate = ([x, y, z]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
// the smallest rotation that takes unit vector u onto unit vector v (Rodrigues)
function rotation(u, v){
  const k = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const c = u[0] * v[0] + u[1] * v[1] + u[2] * v[2], s = Math.hypot(...k);
  if(s < 1e-9) return translate([0, 0, 0]);
  const [x, y, z] = k.map(q => q / s), t = 1 - c;
  return [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
}
// Wheels modelled steered or tilted: turned about their own centre so the axle lies on X.
// Only the node's transform changes (a mesh shared by two wheels stays shared).
function straightenWheels(doc, log){
  for(const w of wheelAxles(doc)){
    if(w.offX < 0.5) continue;
    const R = mul(translate(w.centre), mul(rotation(w.axle, [1, 0, 0]), translate(w.centre.map(v => -v))));
    const parent = w.node.getParentNode();
    const world = mul(R, w.node.getWorldMatrix());
    w.node.setMatrix(parent ? mul(invert(parent.getWorldMatrix()), world) : world);
    log(`wheel ${w.name} straightened (axle was ${w.offX.toFixed(1)}° off X)`);
  }
}
// Per model. small: materials of small parts (a grille, a tyre, decals, brake discs) whose
// textures need no more than 512 px (the body's atlas keeps 1024).
// (No simplification: tried with meshopt's simplifier at under 2 mm of error, the glossy
// paint showed dents where vertices merged — the normals are not re-solved — so the dense
// models keep every triangle and the savings come from compression alone.)
const PACK = {
  generic_sedan_car: { small: /honeycomb|tire|suspension|car-bottom|Stainless/ },
  generic_sport_coupe_car: { small: /wheel-brake-disc|mechanics|tire|grille/ },
  nexus_rx: { small: /Decals|Tires/ },
};
// Everything but the wheels hangs straight from the scene, at its world place, so join()
// can merge the body's parts by material (the Ford came as 92 meshes, each in a node of
// its own: 140 KB of JSON alone). A wheel's subtree stays as it is and is marked, so it
// is never merged into the body: the game spins those nodes (core/carModels.js WHEEL).
function flattenBody(doc){
  const scene = doc.getRoot().listScenes()[0];
  const wheels = new Set(wheelAxles(doc).map(w => w.node));
  const inWheel = n => { for(let a = n; a; a = a.getParentNode()) if(wheels.has(a)) return true; return false; };
  for(const n of doc.getRoot().listNodes()){
    if(inWheel(n)){ n.setExtras({ ...n.getExtras(), wheel: true }); continue; }
    if(!n.getMesh() || !n.getParentNode()) continue;
    const world = n.getWorldMatrix();
    n.getParentNode().removeChild(n);
    n.setMatrix(world);
    scene.addChild(n);
  }
}
// Texture coordinates a primitive's material never reads (the Paint has no texture: the
// biggest parts of every car carried UVs for nothing). Run after weld(), which gives each
// primitive accessors of its own, so the other primitives keep theirs.
function dropUnusedUVs(doc){
  for(const mesh of doc.getRoot().listMeshes()) for(const p of mesh.listPrimitives()){
    const m = p.getMaterial(), used = new Set();
    if(m) for(const slot of ['BaseColor', 'Normal', 'MetallicRoughness', 'Occlusion', 'Emissive']){
      if(m['get' + slot + 'Texture']()) used.add(m['get' + slot + 'TextureInfo']().getTexCoord());
    }
    for(const sem of p.listSemantics()){
      const k = /^TEXCOORD_(\d+)$/.exec(sem);
      if(k && !used.has(+k[1])) p.setAttribute(sem, null);
    }
  }
  return doc.transform(prune());
}
async function pack(doc, log, name){
  const opt = PACK[name] || {};
  straightenWheels(doc, log);
  // (each pass takes only what is still JPEG or PNG: nothing is encoded twice)
  const webp = (more) => textureCompress({ encoder: sharp, targetFormat: 'webp', formats: /^image\/(jpeg|png)$/, ...more });
  if(opt.small) for(const m of doc.getRoot().listMaterials()) if(opt.small.test(m.getName())){
    for(const slot of ['BaseColor', 'Normal', 'MetallicRoughness', 'Occlusion', 'Emissive']){
      const t = m['get' + slot + 'Texture'](); if(t) t.setName('small:' + m.getName());
    }
  }
  // Palettes and flat-colour atlases (the RX-7's 256 px palette, the Rally's 28 colours,
  // the GT-R's): every texel is a colour a face is painted with, so lossy WebP shifts them
  // (the RX-7's black went olive). Colour maps of at most 256 px, or with at most 256
  // colours, go lossless and keep their size (a resize would blend neighbouring cells).
  // (Runs after the small parts are named, which it leaves to the lossy 512 px pass.)
  for(const m of doc.getRoot().listMaterials()) for(const slot of ['BaseColor', 'Emissive']){
    const t = m['get' + slot + 'Texture']();
    if(!t || /^(flat|small):/.test(t.getName())) continue;     // (a small part's texture: its shift can't be seen)
    const { data, info } = await sharp(Buffer.from(t.getImage())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const colours = new Set();
    for(let i = 0; i < data.length && colours.size <= 256; i += 4) colours.add(data.readUInt32LE(i));
    if(Math.max(info.width, info.height) <= 256 || colours.size <= 256){ t.setName('flat:' + m.getName()); log(`texture of ${m.getName()}: palette, lossless`); }
  }
  await doc.transform(
    dedup(), prune(), flattenBody, join({ keepNamed: false, filter: n => !n.getExtras().wheel }),
    // (the mark goes: GLTFLoader would hand it over as userData.wheel, the game's own field)
    d => { for(const n of d.getRoot().listNodes()){ const { wheel, ...rest } = n.getExtras(); n.setExtras(rest); } },
    webp({ pattern: /^flat:/, lossless: true }),
    webp({ pattern: /^small:/, slots: /^(baseColor|emissive)/, resize: [512, 512], quality: 80 }),
    webp({ pattern: /^small:/, resize: [256, 256], quality: 70 }),
    webp({ slots: /^(baseColor|emissive)/, resize: [1024, 1024], quality: 80 }),
    webp({ slots: /^(normal|metallicRoughness|occlusion)/, resize: [512, 512], quality: 70 }),
    webp({ resize: [1024, 1024], quality: 80 }),   // anything else
    weld(),
    dropUnusedUVs,
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  );
}
async function packFile(IN, OUT){
  const name = path.basename(IN, '.glb'), log = (...a) => console.log(name + ':', ...a);
  const doc = await io.read(IN);
  await pack(doc, log, name);
  await io.write(OUT, doc);
  log(kb(IN), '→', kb(OUT));
}

// The models' versions: a hash of each file's content, put in its URL (?v=), so the
// browser may keep a model for a year (immutable) and still gets a changed one at once.
// Written to public/js/core/modelVersions.js (core/carModels.js reads it) and into the
// early preload in public/index.html; tests/models.test.mjs checks both against the files.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function writeVersions(){
  const dir = path.join(REPO, 'public/models/cars');
  const v = Object.fromEntries(readdirSync(dir).filter(f => f.endsWith('.glb')).sort()
    .map(f => [f, createHash('sha256').update(readFileSync(path.join(dir, f))).digest('hex').slice(0, 10)]));
  writeFileSync(path.join(REPO, 'public/js/core/modelVersions.js'),
    '// Written by tools/prep-car-model.mjs (do not edit): a hash of each car model file, used as\n' +
    '// its URL\'s ?v= so a changed model is never served from a stale cache.\n' +
    'export const MODEL_VERSIONS = ' + JSON.stringify(v, null, 2).replace(/"/g, "'") + ';\n');
  const html = path.join(REPO, 'public/index.html'), page = readFileSync(html, 'utf8');
  const map = /var M = \{([^}]*)\};/.exec(page);
  if(!map) throw new Error('index.html: the preload map (var M = {...}) is gone');
  const body = map[1].replace(/'([\w-]+\.glb)(\?v=\w+)?'/g, (_, f) => { if(!v[f]) throw new Error('index.html: no model ' + f); return `'${f}?v=${v[f]}'`; });
  writeFileSync(html, page.replace(map[0], 'var M = {' + body + '};'));
  console.log('versions:', Object.entries(v).map(([f, h]) => f + ' ' + h).join(', '));
}

const argv = process.argv.slice(2);
if(argv[0] === '--pack-all'){
  const src = path.join(REPO, 'models-src/cars'), dst = path.join(REPO, 'public/models/cars');
  for(const f of readdirSync(src).filter(f => f.endsWith('.glb'))) await packFile(path.join(src, f), path.join(dst, f));
  writeVersions();
  process.exit(0);
}
if(argv[0] === '--pack'){ await packFile(argv[1], argv[2]); writeVersions(); process.exit(0); }
if(argv[0] === '--versions'){ writeVersions(); process.exit(0); }

/* ---------- prep ---------- */
const [IN, OUT, NAME] = argv;
const cfg = CFG[NAME]; if (!cfg) throw new Error('no config ' + NAME);
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

let jpeg, PNG;
function decode(tex) {
  const buf = Buffer.from(tex.getImage());
  if (tex.getMimeType() === 'image/png') { const png = PNG.sync.read(buf); return { w: png.width, h: png.height, d: png.data }; }
  const j = jpeg.decode(buf, { useTArray: true }); return { w: j.width, h: j.height, d: j.data };
}
if (cfg.split) {
  jpeg = (await import('jpeg-js')).default; PNG = (await import('pngjs')).PNG;
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
log('triangles', Math.round(before), '→', Math.round(after));
// the prepped file, uncompressed, next to OUT's name in models-src/cars/; then the packed one
const SRC = path.join(REPO, 'models-src/cars', path.basename(OUT));
await io.write(SRC, doc);
await packFile(SRC, OUT);
writeVersions();
