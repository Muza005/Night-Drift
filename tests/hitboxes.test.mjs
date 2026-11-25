// Car hitboxes (plan 3, stage 1): public/js/core/hitboxes.js, generated from the car models by
// tests/tools/hitboxes.mjs. Every car and every traffic type has a convex polygon of 16-20
// vertices that stays within 5 cm of its body seen from above, and the file is up to date
// with the models.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sources, build, moduleText, profiles, outline, deviation, OUT } from './tools/hitboxes.mjs';
import { HITBOXES, HITBOX_IDS, hitbox, hitRadius, worldPoly } from '../public/js/core/hitboxes.js';
import { CARS } from '../public/js/core/cars.js';
import { TYPES } from '../public/js/modes/traffic/sim.js';

const src = await sources();                       // the models' triangles, placed as the game places them
const built = await build(src.map(s => ({ ...s })));

test('every car and every traffic type has a hitbox', () => {
  assert.deepEqual([...HITBOX_IDS].sort(), [...CARS.map(c => c.id), ...TYPES.map(T => 'bot:' + T.name)].sort());
  for (const c of CARS) assert.equal(hitbox(c.id).id, c.id);
  assert.equal(hitbox('no-such-car').id, CARS[0].id, 'an unknown car gets the first car');
});

test('each is a convex counter-clockwise polygon of 16-20 vertices', () => {
  for (const id of HITBOX_IDS) {
    const H = HITBOXES[id], p = H.poly, n = p.length / 2;
    assert.ok(p instanceof Float64Array, id);
    assert.ok(n >= 16 && n <= 20, `${id}: ${n} vertices`);
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = ((i + 1) % n) * 2, c = ((i + 2) % n) * 2;
      assert.ok(Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1]) > 1e-3, `${id}: vertices ${i} and ${i + 1} coincide`);
      const cross = (p[b] - p[a]) * (p[c + 1] - p[b + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[b]);
      assert.ok(cross >= -1e-9, `${id}: turns the wrong way at vertex ${(i + 1) % n}`);
    }
    // its sizes agree with its vertices
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, r = 0;
    for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); z0 = Math.min(z0, p[i + 1]); z1 = Math.max(z1, p[i + 1]); r = Math.max(r, Math.hypot(p[i], p[i + 1])); }
    assert.ok(Math.abs(x1 - H.right) < 2e-3 && Math.abs(-x0 - H.left) < 2e-3 && Math.abs(z1 - H.front) < 2e-3 && Math.abs(-z0 - H.rear) < 2e-3, `${id}: box`);
    assert.ok(Math.abs(H.len - (H.front + H.rear)) < 2e-3 && Math.abs(H.wid - (H.right + H.left)) < 2e-3, `${id}: len, wid`);
    assert.ok(hitRadius(id) >= r && hitRadius(id) < r + 2e-3, `${id}: bounding radius ${hitRadius(id)} for ${r.toFixed(4)}`);
    // the origin (the physics centre) is inside, roughly in the middle
    assert.ok(Math.abs(H.front - H.rear) < 0.1 && Math.abs(H.right - H.left) < 0.05, `${id}: off centre`);
  }
});

test('the players\' cars: 4.3 m long (CAR_LEN, within 5 cm), 1.6-2.1 m wide, corner radii 0.2-1 m', () => {
  for (const c of CARS) {
    const H = hitbox(c.id);
    assert.ok(H.len <= 4.3 + 0.01 && H.len > 4.3 - 0.05, `${c.id}: ${H.len} m long`);
    assert.ok(H.wid > 1.6 && H.wid < 2.1, `${c.id}: ${H.wid} m wide`);
    for (const r of [H.rFront, H.rRear]) assert.ok(r >= 0.2 && r <= 1, `${c.id}: radius ${r}`);
  }
  for (const T of TYPES) {
    const H = hitbox('bot:' + T.name);
    assert.ok(Math.abs(H.len - T.len) < 0.1 && Math.abs(H.wid - T.wid) < 0.06, `bot:${T.name}: ${H.len} × ${H.wid} for ${T.len} × ${T.wid}`);
  }
});

test('each polygon is within 5 cm of its model seen from above (outline measured again, at 2 cm)', () => {
  for (const s of src) {
    const O = outline(profiles(s.tris, 0.02));
    const H = hitbox(s.id), d = deviation(H.poly, O.hull);
    assert.ok(d.max <= 0.05, `${s.id}: ${(d.max * 100).toFixed(1)} cm apart (body out by ${(d.out * 100).toFixed(1)}, air ${(d.air * 100).toFixed(1)})`);
    // and the measured box agrees with the stored one
    for (const k of ['right', 'left', 'front', 'rear']) assert.ok(Math.abs(O[k] - H[k]) <= 0.05, `${s.id}: ${k} ${O[k].toFixed(3)} measured, ${H[k]} stored`);
  }
});

test('mirrors are not body: every car\'s raw top view is wider than its hitbox only by short bumps', () => {
  // (the raw width includes the mirrors; the hitbox must not)
  for (const it of built.filter(b => !b.id.startsWith('bot:'))) {
    const rawW = it.raw.right + it.raw.left;
    assert.ok(rawW >= it.box.right + it.box.left - 1e-6, it.id);
  }
  const coupe = built.find(b => b.id === 'coupe');
  assert.ok(coupe.raw.right + coupe.raw.left - hitbox('coupe').wid > 0.15, 'the coupe\'s mirrors (≈ 2.07 m) are left out');
});

test('public/js/core/hitboxes.js is up to date with the models (regenerated here)', () => {
  assert.equal(readFileSync(OUT, 'utf8'), moduleText(built), 'run: node tests/tools/hitboxes.mjs');
});

test('worldPoly: the car\'s frame turned by its heading, into a given array without allocating', () => {
  const H = hitbox('coupe'), p = H.poly;
  // heading 0: the nose to +z
  const a = worldPoly('coupe', 10, -5, 0);
  for (let i = 0; i < p.length; i += 2) { assert.ok(Math.abs(a[i] - (10 + p[i])) < 1e-12); assert.ok(Math.abs(a[i + 1] - (-5 + p[i + 1])) < 1e-12); }
  // heading h: forward is (sin h, cos h) and x is (cos h, -sin h), as in core/physics.js
  const h = 0.7, out = new Float64Array(p.length), b = worldPoly('coupe', 3, 4, h, out);
  assert.equal(b, out);
  for (let i = 0; i < p.length; i += 2) {
    const wx = 3 + p[i] * Math.cos(h) + p[i + 1] * Math.sin(h), wz = 4 - p[i] * Math.sin(h) + p[i + 1] * Math.cos(h);
    assert.ok(Math.abs(b[i] - wx) < 1e-12 && Math.abs(b[i + 1] - wz) < 1e-12);
  }
  // the nose's middle lies along the heading
  const nose = [0, 0]; let best = -Infinity;
  for (let i = 0; i < p.length; i += 2) if (p[i + 1] > best) best = p[i + 1];
  const w = worldPoly('coupe', 0, 0, h);
  for (let i = 0; i < p.length; i += 2) if (p[i + 1] === best) { nose[0] += w[i] / 2; nose[1] += w[i + 1] / 2; }
  assert.ok(Math.abs(Math.atan2(nose[0], nose[1]) - h) < 0.02, 'nose along the heading');
  // a plain array works too
  const arr = new Array(p.length).fill(0);
  assert.equal(worldPoly('rx7', 0, 0, 1, arr), arr);
});

test('the server can import it: plain data, no three.js, no DOM, no imports', () => {
  const text = readFileSync(OUT, 'utf8');
  assert.ok(!/\bTHREE\b|\bdocument\b|\bwindow\b/.test(text.replace(/^\/\/.*$/gm, '')), 'no THREE or DOM');
  assert.ok(!/^\s*import\b/m.test(text), 'no imports');
});
