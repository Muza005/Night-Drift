// Slipstream pocket geometry and build-up (core/draft.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wake, stepDraft, pocketLen, DRAFT, createTrail, trailPush, trailIdx } from '../public/js/core/draft.js';

const lead = { x: 0, z: 100, vx: 0, vz: 39 };              // 140 km/h down +z
const me = (dx, behind, v = 39) => ({ x: dx, z: 100 - DRAFT.REAR - behind, vx: 0, vz: v });

test('the pocket: right behind, within 50 m, same way', () => {
  assert.equal(pocketLen(39), 50);
  assert.equal(wake(me(0, 10), lead).inside, true);
  assert.equal(wake(me(0, 49), lead).inside, true, '50 m back still draws the pocket');
  assert.equal(wake(me(1.2, 5), lead).inside, true);
  assert.equal(wake(me(2.6, 5), lead).inside, false, 'a lane over: no pocket');
  assert.equal(wake(me(0, 1), lead).inside, false, 'touching its bumper is not drafting');
  assert.equal(wake(me(0, 55), lead).inside, false, 'too far back');
  assert.equal(wake(me(0, 10, -30), lead).inside, false, 'going the other way');
  assert.equal(wake(me(0, 10), { ...lead, vz: 15 }), null, 'a car under 60 km/h leaves no pocket');
  // a car going sideways leaves its pocket sideways
  assert.equal(wake({ x: -12.15, z: 100, vx: 39, vz: 0 }, { x: 0, z: 100, vx: 39, vz: 0 }).inside, true);
});

test('its lines: shown within 50 m behind, brightest inside', () => {
  assert.equal(wake(me(0, 55), lead).show, 0);
  assert.equal(wake(me(0, 45), lead).show, 1);
  const aside = wake(me(6, 40), lead).show;
  assert.ok(aside > 0 && aside < .55, 'beside the pocket: dim lines');
  assert.equal(wake(me(0, -20), lead).show, 0, 'ahead of it: nothing to see');
});

test('the push builds over 0.8 s and fades over 0.5 s', () => {
  const st = { level: 0 };
  for (let i = 0; i < 40; i++) stepDraft(st, true, .01);
  assert.ok(Math.abs(st.level - .5) < 1e-9);
  for (let i = 0; i < 50; i++) stepDraft(st, true, .01);
  assert.equal(st.level, 1);
  for (let i = 0; i < 25; i++) stepDraft(st, false, .01);
  assert.ok(Math.abs(st.level - .5) < 1e-9);
  for (let i = 0; i < 40; i++) stepDraft(st, false, .01);
  assert.equal(st.level, 0);
});

// The pocket follows the lead car's real path (its trail), not a straight line from its nose.
const drive = (pose, seconds, dt = 1 / 60) => {   // pose(t) -> {x, z, h}: the lead's path
  const tr = createTrail();
  for (let t = 0; t <= seconds + 1e-9; t += dt) { const p = pose(t); trailPush(tr, p.x, p.z, 0, p.h, dt); }
  return tr;
};

test('a straight trail gives the same pocket as no trail', () => {
  const tr = drive(t => ({ x: 0, z: 100 - 39 * (3 - t), h: 0 }), 3);   // reaches z=100 at t=3
  for (const [dx, b, v] of [[0, 10, 39], [0, 49, 39], [1.2, 5, 39], [2.6, 5, 39], [0, 1, 39], [0, 55, 39], [0, 10, -30], [6, 40, 39], [0, -20, 39], [0, 45, 39]]) {
    const a = wake(me(dx, b, v), lead), c = wake(me(dx, b, v), lead, tr);
    assert.equal(c.inside, a.inside, `${dx} m aside, ${b} m back`);
    assert.equal(c.show, a.show);
    if (b < 50) assert.ok(Math.abs(c.behind - a.behind) < 1e-6 && Math.abs(c.side - a.side) < 1e-6 && Math.abs(c.show - a.show) < 1e-6);
  }
});

test('through a bend: in the pocket on its trail, not on the straight line from its nose', () => {
  // the lead goes round a left-hand bend of radius 60 m at 140 km/h for 3 s
  const R = 60, v = 39, w = v / R, T = 3;
  const at = t => { const a = w * t; return { x: R - R * Math.cos(a), z: R * Math.sin(a), h: a }; };
  const vel = t => ({ vx: v * Math.sin(w * t), vz: v * Math.cos(w * t) });
  const tr = drive(at, T);
  const L = { ...at(T), ...vel(T) };
  // a follower 20 m behind the bumper, on the lead's path, going the way the lead went there
  const tb = T - (20 + DRAFT.REAR) / v;
  const onTrail = { ...at(tb), ...vel(tb) };
  const r1 = wake(onTrail, L, tr);
  assert.equal(r1.inside, true, 'on its trail through the bend');
  assert.ok(Math.abs(r1.behind - 20) < .2 && Math.abs(r1.side) < .1, `behind ${r1.behind}, side ${r1.side}`);
  assert.equal(wake(onTrail, L).inside, false, 'the old straight cone would have missed it');
  // the straight line back from its nose: off the trail, no pocket
  const f = { x: L.vx / v, z: L.vz / v };
  const straight = { x: L.x - f.x * (20 + DRAFT.REAR), z: L.z - f.z * (20 + DRAFT.REAR), vx: L.vx, vz: L.vz };
  assert.equal(wake(straight, L).inside, true, 'the old cone: inside');
  assert.equal(wake(straight, L, tr).inside, false, 'the real path: outside');
  // further back along the bend, still the trail
  const tc = T - (40 + DRAFT.REAR) / v;
  assert.equal(wake({ ...at(tc), ...vel(tc) }, L, tr).inside, true, '40 m back along the bend');
});

test('the trail: a point every 30 ms, a ring of 128, a jump starts it again', () => {
  const tr = createTrail();
  for (let i = 0; i < 600; i++) trailPush(tr, 0, i * .5, 0, 0, 1 / 60);   // 10 s
  assert.equal(tr.count, 128);
  const k0 = trailIdx(tr, 0), k1 = trailIdx(tr, 1);
  assert.ok(Math.abs(tr.t[k0] - tr.t[k1] - 1 / 30) < 1e-9, 'every other 60 fps frame');
  assert.ok(tr.z[k0] > tr.z[k1]);
  trailPush(tr, 0, 600 * .5 + 30, 0, 0, 1 / 60);                         // 30 m in one frame: a respawn
  assert.equal(tr.count, 1);
});
