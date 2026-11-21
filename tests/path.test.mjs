// Map drawing helpers (public/js/modes/track/maps/path.js): reach() fits a piece of track
// to end at a given place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { trace, reach } = await import('../public/js/modes/track/maps/path.js');

test('reach: two straights take the lengths that bring the piece to its end', () => {
  const from = { x: 10, z: -5, heading: 0 }, to = { x: 70, z: 40 };
  const segs = reach(from, [['S', 10], ['R', 12, 90], ['S', 5], ['R', 12, -90], ['S', 3]], 0, 2, to);
  const e = trace({ ...from, segments: segs, step: 1 }).end;
  assert.ok(Math.hypot(e.x - to.x, e.z - to.z) < 1e-6, `ends at ${e.x.toFixed(3)}, ${e.z.toFixed(3)}`);
  assert.ok(Math.abs(e.heading) < 1e-9, 'the heading its turns give');
  assert.equal(segs[1][1], 12, 'turns untouched'); assert.equal(segs[4][1], 3, 'other straights untouched');
  assert.throws(() => reach(from, [['S', 10], ['R', 12, 90], ['S', 5]], 0, 1, to), /straights/);
  assert.throws(() => reach(from, [['S', 10], ['R', 12, 90], ['S', 5]], 0, 2, { x: -100, z: 40 }), /would be/);
});
