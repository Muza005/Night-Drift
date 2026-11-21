// Other players' cars (stage 9, public/js/net/ghostsync.js): the prediction, the spring that
// fades a correction out, the network numbers; and the state on the wire (statecodec.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { predict, newView, correct, settle, SMOOTH, newStats, statArrive, statErr, errPct } from '../public/js/net/ghostsync.js';
import { encodeState, decodeState } from '../public/js/net/statecodec.js';

const near = (a, b, e, msg) => assert.ok(Math.abs(a - b) <= e, `${msg}: ${a} vs ${b}`);

test('predict: straight on at a steady speed, exactly', () => {
  const s0 = { t: 1000, x: 0, z: 0, h: 0, vx: 0, vz: 20 }, s1 = { t: 1033, x: 0, z: 0.66, h: 0, vx: 0, vz: 20 };
  const p = predict(s0, s1, 1133);
  near(p.x, 0, 1e-9, 'x'); near(p.z, 0.66 + 2, 1e-9, 'z'); near(p.vz, 20, 1e-9, 'vz');
  // never more than MAX_AGE ahead
  near(predict(s0, s1, 1033 + 5000).z, 0.66 + 20 * SMOOTH.MAX_AGE, 1e-9, 'capped');
});

test('predict: carries a change of speed on, for ACC_T at most, never through a stop', () => {
  // braking at 10 m/s² (0.33 m/s per 33 ms)
  const s0 = { t: 0, x: 0, z: 0, h: 0, vx: 0, vz: 20.33 }, s1 = { t: 33, x: 0, z: 0.67, h: 0, vx: 0, vz: 20 };
  const p = predict(s0, s1, 133);           // 0.1 s on: 20·0.1 − 10·0.1²/2
  near(p.z - 0.67, 2 - 0.05, 1e-6, 'braking distance'); near(p.vz, 19, 1e-6, 'speed after braking');
  const far = predict(s0, s1, 33 + 400);    // the change only for ACC_T s
  near(far.vz, 20 - 10 * SMOOTH.ACC_T, 1e-6, 'speed change stops after ACC_T');
  // a car rolling at 1 m/s and braking hard stops, it does not reverse
  const r0 = { t: 0, x: 0, z: 0, h: 0, vx: 0, vz: 1.33 }, r1 = { t: 33, x: 0, z: 0, h: 0, vx: 0, vz: 1 };
  const q = predict(r0, r1, 33 + 300);
  assert.ok(q.vz >= -1e-9, `reversed: ${q.vz}`); near(q.z, 0.05, 1e-6, 'stopped after 5 cm');
  // a hit (a velocity jump) is not taken for a lasting acceleration beyond ACC
  const h0 = { t: 0, x: 0, z: 0, h: 0, vx: 0, vz: 10 }, h1 = { t: 33, x: 0, z: 0.33, h: 0, vx: 0, vz: 18 };
  assert.ok(predict(h0, h1, 33 + 200).vz <= 18 + SMOOTH.ACC * SMOOTH.ACC_T + 1e-9);
});

test('predict: turns at the last turn rate', () => {
  const w = 1, s0 = { t: 0, x: 0, z: 0, h: 0, vx: 0, vz: 10 }, s1 = { t: 100, x: 0, z: 1, h: w * 0.1, vx: 10 * Math.sin(0.1), vz: 10 * Math.cos(0.1) };
  const p = predict(s0, s1, 200);
  near(p.h, 0.2, 1e-9, 'heading'); near(Math.atan2(p.vx, p.vz), 0.2, 1e-9, 'velocity turned with it');
});

test('a correction: no jump, the drawn car keeps its place, and it fades out', () => {
  const V = newView(), dt = 1 / 60;
  // the new prediction is 1 m further on than the old one, at the same speed
  const from = { x: 0, z: 10, h: 0, vx: 0, vz: 20, w: 0 }, to = { x: 0, z: 11, h: 0, vx: 0, vz: 20, w: 0 };
  assert.equal(correct(V, from, to), 1);
  near(to.z + V.off.z, from.z, 1e-12, 'drawn where it was');
  // drawn = prediction (steady 20 m/s) + offset: the change of its per-frame motion
  let z = [], tz = to.z;
  for (let i = 0; i < 60; i++) { settle(V, dt); tz += 20 * dt; z.push(tz + V.off.z); }
  let most = 0;
  for (let i = 2; i < z.length; i++) most = Math.max(most, Math.abs(z[i] - 2 * z[i - 1] + z[i - 2]));
  const was = from.z + 20 * dt;               // the first frame: the drawn car's own speed carries on
  assert.ok(Math.abs(z[0] - was) < SMOOTH.W * SMOOTH.W * dt * dt * 1.01, `first frame moved ${z[0] - was} m off its own course`);
  assert.ok(most < SMOOTH.W * SMOOTH.W * dt * dt * 1.01, `jump ${most} m per frame for a 1 m correction`);
  assert.ok(Math.abs(V.off.z) < 0.01, `still ${V.off.z} m of it after a second`);
  // the old exponential fade (−10/s) moved the car a sixth of the correction in one frame
  assert.ok(most < 0.5 * (1 - Math.exp(-10 * dt)));
});

test('a correction: steady at any frame rate', () => {
  const run = dt => { const V = newView(); correct(V, { x: 1, z: 0, h: 0, vx: 0, vz: 0 }, { x: 0, z: 0, h: 0, vx: 0, vz: 0 }); for (let t = 0; t < 0.3 - 1e-9; t += dt) settle(V, dt); return V.off.x; };
  near(run(1 / 120), run(1 / 10), 1e-9, '120 fps and 10 fps fade the same');
  assert.ok(run(1 / 60) < 0.25 && run(1 / 60) > 0, 'mostly gone in 0.3 s, never overshooting');
});

test('a correction past RESET (back to the track) is not smoothed', () => {
  const V = newView();
  correct(V, { x: 0, z: 0, h: 0, vx: 0, vz: 0 }, { x: 0, z: SMOOTH.RESET + 1, h: 0, vx: 0, vz: 0 });
  assert.deepEqual([V.off.x, V.off.z, V.ov.z], [0, 0, 0]);
});

test('network numbers: delay, jitter, update rate, correction percentiles', () => {
  const S = newStats(100);
  for (let i = 0; i < 50; i++) statArrive(S, i * 25, i * 25 + 75 + (i % 2 ? 10 : -10));
  near(S.delay, 75, 10, 'delay'); near(S.jitter, 20, 2, 'jitter'); near(1000 / S.gap, 40, 0.5, 'updates a second');
  for (let i = 1; i <= 100; i++) statErr(S, i / 100);
  near(errPct(S, 0.5), 0.51, 1e-9, 'p50'); near(errPct(S, 0.95), 0.96, 1e-9, 'p95');
});

test('a state on the wire: centimetres, back as it was', () => {
  const s = { t: 1763700000123, x: -1234.5678, z: 9876543.21, h: -2.71828, vx: -71.234, vz: 0.004, vf: 72.3, steer: -0.75, slide: 0.333, y: 12.5, vy: -3.3, idx: 4321 };
  const d = decodeState(encodeState('abc', s));
  assert.equal(d.id, 'abc'); assert.equal(d.t, s.t); assert.equal(d.idx, 4321);
  for (const k of ['x', 'z', 'vx', 'vz', 'vf', 'y', 'vy']) near(d[k], s[k], 0.005, k);
  near(d.h, s.h, 5e-5, 'h'); near(d.steer, s.steer, 5e-4, 'steer'); near(d.slide, s.slide, 5e-4, 'slide');
  assert.ok(encodeState('abc', s).slice(1).every(Number.isInteger), 'integers only');
  for (const bad of [null, 'x', [1, 2], ['a', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 'x'], ['a', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, NaN]]) assert.equal(decodeState(bad), null);
});
