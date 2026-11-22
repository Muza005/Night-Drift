// The car models as the game downloads them (public/models/cars/, packed by
// tools/prep-car-model.mjs from models-src/cars/): small, compressed, and with wheels that
// spin true.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { wheelAxles } from '../tools/wheel-axle.mjs';

const { CARS, DEFAULT_CAR } = await import('../public/js/core/cars.js');
const file = c => new URL('../public/' + c.model, import.meta.url);
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const docs = new Map();
for (const c of CARS) docs.set(c.id, await io.read(file(c).pathname));

test('every model is small: under 700 KB each, the garage under 4 MB', () => {
  let total = 0;
  for (const c of CARS) {
    const size = statSync(file(c)).size; total += size;
    assert.ok(size <= 700 * 1024, `${c.id}: ${c.model} is ${Math.round(size / 1024)} KB`);
  }
  assert.ok(total < 4e6, `all eight: ${(total / 1e6).toFixed(2)} MB`);
});

test('geometry meshopt-compressed, textures WebP of at most 1024 px', () => {
  for (const c of CARS) {
    const root = docs.get(c.id).getRoot();
    const used = root.listExtensionsUsed().map(e => e.extensionName);
    assert.ok(used.includes('EXT_meshopt_compression'), `${c.id}: meshopt`);
    for (const t of root.listTextures()) {
      assert.equal(t.getMimeType(), 'image/webp', `${c.id}: texture ${t.getName()}`);
      const [w, h] = t.getSize() || [0, 0];
      assert.ok(w > 0 && w <= 1024 && h <= 1024, `${c.id}: texture ${w}×${h}`);
    }
  }
});

test('palettes stay exact: the flat-colour textures are lossless WebP', () => {
  // (lossy WebP turned the RX-7's black parts olive)
  const lossless = img => { const b = Buffer.from(img); const at = b.indexOf('VP8L', 12); const lossy = b.indexOf('VP8 ', 12); return at > 0 && (lossy < 0 || at < lossy); };
  for (const id of ['rx7', 'rally', 'gtr']) {
    const paletted = docs.get(id).getRoot().listMaterials().map(m => m.getBaseColorTexture()).filter(Boolean);
    assert.ok(paletted.length, `${id}: has its palette`);
    for (const t of paletted) assert.ok(lossless(t.getImage()), `${id}: ${t.getName()} is lossless`);
  }
});

// The car's box in the file's scene space (wheels included).
function carBox(doc){
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const n of doc.getRoot().listNodes()) {
    const mesh = n.getMesh(); if (!mesh) continue;
    const W = n.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      const a = p.getAttribute('POSITION'), e = [];
      for (let i = 0; i < a.getCount(); i++) {
        const [x, y, z] = a.getElement(i, e);
        const q = [0, 1, 2].map(r => W[r] * x + W[4 + r] * y + W[8 + r] * z + W[12 + r]);
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
      }
    }
  }
  return { lo, hi };
}

test('every car has four wheels that spin: one at each corner, separate nodes', () => {
  // (a tyre and its rim are two nodes at one hub: one wheel)
  for (const c of CARS) {
    const doc = docs.get(c.id), { lo, hi } = carBox(doc), len = hi[2] - lo[2];
    const mid = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
    const hubs = [];
    for (const w of wheelAxles(doc)) {
      let h = hubs.find(h => Math.hypot(...h.centre.map((v, k) => v - w.centre[k])) < 0.05 * len);
      if (!h) hubs.push(h = { centre: w.centre, names: [] });
      h.names.push(w.name);
    }
    assert.equal(hubs.length, 4, `${c.id}: ${hubs.length} wheels (${hubs.map(h => h.names.join('+')).join(', ')})`);
    const corners = hubs.map(h => (h.centre[2] > mid[2] ? 'F' : 'R') + (h.centre[0] > mid[0] ? 'L' : 'R')).sort();
    assert.deepEqual(corners, ['FL', 'FR', 'RL', 'RR'], `${c.id}: a wheel at each corner`);
    for (const h of hubs) assert.ok(h.centre[1] < lo[1] + 0.4 * (hi[1] - lo[1]), `${c.id}: ${h.names} low, at the ground`);
  }
});

test('every wheel spins true: its axle along the car\'s X axis within 2°', () => {
  for (const c of CARS) {
    const wheels = wheelAxles(docs.get(c.id));
    assert.ok(wheels.length >= 4, `${c.id}: ${wheels.length} wheel nodes`);
    for (const w of wheels) assert.ok(w.offX < 2, `${c.id}: ${w.name} axle is ${w.offX.toFixed(1)}° off X`);
  }
});

test('the uncompressed sources are kept out of public/, one per model', () => {
  for (const c of CARS) assert.ok(existsSync(new URL('../models-src/cars/' + c.model.split('/').pop(), import.meta.url)), `${c.id}: models-src/cars/`);
});

test('each model URL carries its file\'s content hash; index.html preloads the same URL', async () => {
  const { MODEL_VERSIONS } = await import('../public/js/core/modelVersions.js');
  const { modelUrl } = await import('../public/js/core/carModels.js');
  const { createHash } = await import('node:crypto');
  for (const c of CARS) {
    const f = c.model.split('/').pop();
    const hash = createHash('sha256').update(readFileSync(file(c))).digest('hex').slice(0, 10);
    assert.equal(MODEL_VERSIONS[f], hash, `${c.id}: modelVersions.js has the hash of ${f} (rerun: node tools/prep-car-model.mjs --versions)`);
    assert.ok(modelUrl(c.model).endsWith(c.model + '?v=' + hash), `${c.id}: the game asks for ${modelUrl(c.model)}`);
  }
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const map = /var M = (\{[^}]+\})/.exec(html);
  assert.ok(map, 'the preload script has its map of cars');
  const M = Function('return ' + map[1])();
  assert.deepEqual(Object.keys(M).sort(), CARS.map(c => c.id).sort(), 'every car, and only those');
  for (const c of CARS) {
    const f = c.model.split('/').pop();
    assert.equal('models/cars/' + M[c.id], c.model + '?v=' + MODEL_VERSIONS[f], `${c.id}: the preload is the URL the game loads`);
  }
  assert.equal(/M\[id\] \|\| M\.(\w+)/.exec(html)?.[1], DEFAULT_CAR, 'no pick yet: the default car');
  assert.match(html, /fetchpriority', 'high'/);
});

test('the meshopt decoder is served by the game itself, the same file as three r128\'s', () => {
  const ours = readFileSync(new URL('../public/js/vendor/meshopt_decoder.js', import.meta.url), 'utf8');
  const three = readFileSync(new URL('../node_modules/three/examples/js/libs/meshopt_decoder.js', import.meta.url), 'utf8');
  assert.ok(ours.endsWith(three), 'public/js/vendor/meshopt_decoder.js is three\'s file, a comment added on top');
  for (const [page, src] of [['index.html', 'js/vendor/meshopt_decoder.js'], ['dev/cars.html', '../js/vendor/meshopt_decoder.js'], ['dev/stand.html', '../js/vendor/meshopt_decoder.js']]) {
    const s = readFileSync(new URL('../public/' + page, import.meta.url), 'utf8');
    assert.ok(s.includes(`<script src="${src}"></script>`), `${page}: loads the local decoder`);
    assert.ok(!/cdn[^"]*meshopt_decoder/.test(s), `${page}: not from a CDN`);
  }
});
