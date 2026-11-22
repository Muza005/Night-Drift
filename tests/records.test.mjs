// Solo drift records per map (public/js/records.js), on a store of our own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const R = await import('../public/js/records.js');
const store = () => { const m = new Map(); return { m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

test('records: a lap and a score per map, only better ones kept', () => {
  const s = store();
  assert.deepEqual(R.records('parking', s), { lap: 0, score: 0 });
  assert.ok(R.saveLap('parking', 61.5, s));
  assert.ok(!R.saveLap('parking', 62, s), 'a slower lap is no record');
  assert.ok(R.saveLap('parking', 60.25, s));
  assert.ok(R.saveScore('parking', 12000, s) && !R.saveScore('parking', 9000, s) && !R.saveScore('parking', 0, s));
  assert.deepEqual(R.records('parking', s), { lap: 60.25, score: 12000 });
  assert.deepEqual(R.records('neon', s), { lap: 0, score: 0 }, 'another map has its own');
  assert.ok(!R.saveLap('neon', NaN, s) && !R.saveLap('neon', -1, s));
  s.setItem(R.recordKey('serpantin'), '{broken'); assert.deepEqual(R.records('serpantin', s), { lap: 0, score: 0 }, 'a broken entry reads as none');
});

test('records: the old single best lap moves to «Ночной город» once', () => {
  const s = store(); s.setItem(R.OLD_KEY, '30.5');
  R.migrate(s);
  assert.equal(s.getItem(R.OLD_KEY), null);
  assert.deepEqual(R.records('neon', s), { lap: 30.5, score: 0 });
  assert.deepEqual(R.records('parking', s), { lap: 0, score: 0 }, 'not shown on another map');
  // a better one already there stays
  const t = store(); R.saveLap('neon', 29, t); t.setItem(R.OLD_KEY, '30.5'); R.migrate(t);
  assert.equal(R.records('neon', t).lap, 29);
  R.migrate(t); assert.equal(R.records('neon', t).lap, 29, 'nothing to do the second time');
});
