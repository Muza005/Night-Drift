// Traffic scoring: near-miss levels, the speed factor, combos, drift bonus, distance,
// and what does not count (too slow, touched, overtaken by the bot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepCar } from '../public/js/core/physics.js';
import { constrainToHighway, laneCenter } from '../public/js/modes/traffic/geometry.js';
import { createTraffic, TYPES } from '../public/js/modes/traffic/sim.js';
import { collideWithTraffic } from '../public/js/modes/traffic/collide.js';
import { createScoring, REF_SPEED } from '../public/js/modes/traffic/score.js';

const TYPE = Object.fromEntries(TYPES.map((t, i) => [t.name, i]));
const empty = () => { const s = createTraffic(1); s.reset(1, []); return s; };
function bot(sim, type, lane, z, v) {
  const b = { id: sim.nextId++, t: TYPE[type], lane, from: lane, to: lane, p: 0, x: laneCenter(lane), z, px: laneCenter(lane), pz: z,
    v, v0: v, a: 0, dir: 0, blink: 0, wait: 0, hazard: 0, off: 0, cool: 99, think: 99, color: 0 };
  sim.bots.push(b); return b;
}
// A car that drives dead straight at a fixed speed and x (no physics): exact gaps.
// The traffic gets no players, so it only moves the bots the test placed (no new ones).
function glide(sim, S, car, seconds, drifting = false) {
  const out = [];
  for (let t = 0; t < seconds; t += 1 / 60) {
    sim.advance(1 / 60, []);
    car.z += car.vz / 60;
    out.push(...S.update(car, sim, 1 / 60, drifting));
  }
  return out;
}
// x for the car so that its side gap to a sedan in lane 0 is `gap`
const xFor = gap => laneCenter(0) - (1.0 + 1.9 / 2) - gap;
const pass = (gap, speed = 40, opts = {}) => {
  const sim = empty(), S = createScoring(); bot(sim, 'sedan', 0, 20, 20);
  const car = { x: xFor(gap), z: 0, h: 0, vx: 0, vz: speed };
  return glide(sim, S, car, 4, opts.drift);
};

test('near-miss levels by side gap, times the speed factor', () => {
  const k = 40 / REF_SPEED;
  for (const [gap, pts, name] of [[1.0, 100, 'Близко'], [0.5, 250, 'Впритык'], [0.2, 500, 'На волоске']]) {
    const ev = pass(gap);
    assert.equal(ev.length, 1, `gap ${gap}: one near miss`);
    assert.equal(ev[0].level.name, name);
    assert.equal(ev[0].points, Math.round(pts * k));
    assert.equal(ev[0].side, 'left');
  }
  assert.equal(pass(1.5).length, 0, 'a 1.5 m gap is not a near miss');
});

test('below 80 km/h nothing counts', () => {
  assert.equal(pass(0.2, 21).length, 0);
});

test('drifting doubles a near miss', () => {
  assert.equal(pass(0.5, 40, { drift: true })[0].points, 2 * pass(0.5, 40)[0].points);
});

test('combo: each near miss within 2.5 s adds ×0.5; it ends after 2.5 s', () => {
  const sim = empty(), S = createScoring();
  // three bots in lane 0, 30 m apart: at 40 m/s vs 20 m/s they are passed 1.5 s apart
  for (const z of [20, 50, 80]) bot(sim, 'sedan', 0, z, 20);
  const car = { x: xFor(0.5), z: 0, h: 0, vx: 0, vz: 40 };
  const ev = glide(sim, S, car, 9);
  assert.deepEqual(ev.map(e => e.mult), [1, 1.5, 2]);
  assert.equal(S.maxMult, 2);
  assert.equal(S.chain, 0, 'the combo should have run out');
  assert.equal(S.mult, 1);
});

test('the multiplier stops at ×5', () => {
  const sim = empty(), S = createScoring();
  for (let i = 0; i < 12; i++) bot(sim, 'sedan', 0, 20 + i * 25, 20);
  const car = { x: xFor(0.5), z: 0, h: 0, vx: 0, vz: 40 };
  const ev = glide(sim, S, car, 20);
  assert.equal(ev.length, 12);
  assert.equal(Math.max(...ev.map(e => e.mult)), 5);
});

test('no near miss when the car touches the bot, or when the bot overtakes the car', () => {
  // touch: real physics, steering into the bot while overtaking
  const sim = empty(), S = createScoring(); bot(sim, 'sedan', 0, 6, 20);
  const car = { x: xFor(0.4), z: 0, h: 0, vx: 0, vz: 32, vF: 32, vR: 0, steer: 0, off: false, spinV: 0 };
  let touched = 0;
  const hooks = { onWall() {}, onTrafficHit: () => { touched++; S.breakCombo(); } };
  const ev = [];
  for (let t = 0; t < 3; t += 1 / 60) {
    sim.advance(1 / 60, [{ x: car.x, z: car.z, v: car.vz }]);
    const steer = t < 0.25 ? { up: 1, down: 0, left: 1, right: 0, hb: 0 } : { up: 1, down: 0, left: 0, right: 0, hb: 0 };
    for (let k = 0; k < 2; k++) { stepCar(car, steer, 1 / 120); constrainToHighway(car, 1 / 120, hooks); collideWithTraffic(car, sim, hooks); }
    ev.push(...S.update(car, sim, 1 / 60, false));
  }
  assert.ok(touched > 0, 'the test should touch the bot');
  assert.equal(ev.length, 0, 'a pass with contact is not a near miss');
  // overtaken: a slow car alongside a faster bot
  const sim2 = empty(), S2 = createScoring(); bot(sim2, 'sedan', 0, -10, 35);
  assert.equal(glide(sim2, S2, { x: xFor(0.3), z: 0, h: 0, vx: 0, vz: 23 }, 4).length, 0);
});

test('a pass where the bodies overlap is never a near miss', () => {
  assert.equal(pass(-0.5).length, 0);
});

test('distance: 1 point per 10 m above 80 km/h, 2 above 140 km/h', () => {
  const run = v => { const sim = empty(), S = createScoring(); glide(sim, S, { x: laneCenter(1), z: 0, h: 0, vx: 0, vz: v }, 1000 / v); return S.points; };
  assert.ok(Math.abs(run(30) - 100) <= 1, `at 108 km/h: ${run(30)}`);
  assert.ok(Math.abs(run(45) - 200) <= 1, `at 162 km/h: ${run(45)}`);
  assert.equal(run(20), 0);
});
