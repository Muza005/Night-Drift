// Slipstream pocket geometry and build-up (core/draft.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wake, stepDraft, pocketLen, DRAFT } from '../public/js/core/draft.js';

const lead = { x: 0, z: 100, vx: 0, vz: 39 };              // 140 km/h down +z
const me = (dx, behind, v = 39) => ({ x: dx, z: 100 - DRAFT.REAR - behind, vx: 0, vz: v });

test('the pocket: right behind, close enough, same way', () => {
  assert.ok(Math.abs(pocketLen(39) - 31.45) < 1e-9);
  assert.equal(wake(me(0, 10), lead).inside, true);
  assert.equal(wake(me(1.2, 5), lead).inside, true);
  assert.equal(wake(me(2.6, 5), lead).inside, false, 'a lane over: no pocket');
  assert.equal(wake(me(0, 1), lead).inside, false, 'touching its bumper is not drafting');
  assert.equal(wake(me(0, 35), lead).inside, false, 'too far back');
  assert.equal(wake(me(0, 10, -30), lead).inside, false, 'going the other way');
  assert.equal(wake(me(0, 10), { ...lead, vz: 15 }), null, 'a car under 60 km/h leaves no pocket');
  // a car going sideways leaves its pocket sideways
  assert.equal(wake({ x: -12.15, z: 100, vx: 39, vz: 0 }, { x: 0, z: 100, vx: 39, vz: 0 }).inside, true);
});

test('its lines: shown within 45 m behind, brightest inside', () => {
  assert.equal(wake(me(0, 50), lead).show, 0);
  assert.ok(wake(me(0, 40), lead).show > 0 && wake(me(0, 40), lead).show < .55);
  assert.equal(wake(me(0, 10), lead).show, 1);
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
