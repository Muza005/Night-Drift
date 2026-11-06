// Player car vs traffic: soft hits, crashes, who is at fault, and the bot's recovery.
// Runs the real car physics, the highway rails, the traffic simulation and the
// collision code together, the same order as the game loop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepCar } from '../public/js/core/physics.js';
import { constrainToHighway, laneCenter } from '../public/js/modes/traffic/geometry.js';
import { createTraffic, TYPES } from '../public/js/modes/traffic/sim.js';
import { collideWithTraffic, HARD_HIT, HARD_SIDE } from '../public/js/modes/traffic/collide.js';

const TYPE = Object.fromEntries(TYPES.map((t, i) => [t.name, i]));
function bot(sim, type, lane, z, v) {
  const b = { id: sim.nextId++, t: TYPE[type], lane, from: lane, to: lane, p: 0, x: laneCenter(lane), z, px: laneCenter(lane), pz: z,
    v, v0: v, a: 0, dir: 0, blink: 0, wait: 0, hazard: 0, off: 0, cool: 99, think: 99, color: 0 };
  sim.bots.push(b); return b;
}
function car(lane, z, vz, h = 0) {
  return { x: laneCenter(lane), z, h, vx: Math.sin(h) * vz, vz: Math.cos(h) * vz, vF: vz, vR: 0, steer: 0, off: false, spinV: 0 };
}
// Drive for `seconds`: traffic advances per frame, the car in two substeps per frame.
function drive(c, sim, input, seconds, onHit = () => {}) {
  const hits = [], hooks = { onWall() {}, onTrafficHit: h => { hits.push(h); onHit(h); } };
  for (let t = 0; t < seconds; t += 1 / 60) {
    sim.advance(1 / 60, [{ x: c.x, z: c.z, v: c.vz }]);
    for (let k = 0; k < 2; k++) { stepCar(c, input, 1 / 120); constrainToHighway(c, 1 / 120, hooks); collideWithTraffic(c, sim, hooks); }
  }
  return hits;
}
const empty = () => { const s = createTraffic(1); s.reset(1, []); return s; };   // no players → no spawning
const NONE = { up: 0, down: 0, left: 0, right: 0, hb: 0 }, GAS = { ...NONE, up: 1 };

test('rear-ending a sedan at 180 km/h when it does 80 is a crash', () => {
  const sim = empty(), b = bot(sim, 'sedan', 1, 60, 22), c = car(1, 0, 50);
  const hits = drive(c, sim, GAS, 3);
  assert.ok(hits.length >= 1, 'no hit');
  assert.ok(hits[0].hard, `impact ${hits[0].impact.toFixed(1)} m/s should be a crash`);
  assert.ok(hits[0].impact > 20);
  assert.ok(b.hazard > 0);
});

test('catching up with a sedan at ~20 km/h faster is a soft hit: bounce, bot slows down with hazards', () => {
  // 2 m behind it, coasting at 108 km/h: closes in at ~6 m/s
  const sim = empty(), b = bot(sim, 'sedan', 1, (4.4 + 4.3) / 2 + 2, 22), c = car(1, 0, 30);
  const hits = drive(c, sim, NONE, 1.5);
  assert.ok(hits.length >= 1 && !hits[0].hard, 'should be soft');
  assert.ok(hits[0].impact < HARD_HIT && hits[0].impact > 2);
  assert.ok(c.vz < b.v + 0.5, 'the car should drop back behind the bot');
  assert.ok(b.z - c.z > (4.4 + 4.3) / 2 - 0.01, 'the car must not stay inside the bot');
  assert.ok(b.hazard > 0);
  drive(c, sim, { ...NONE, down: 1 }, 2);
  assert.ok(b.v < 22 * 0.75, `bot should slow toward 60 % (now ${(b.v * 3.6).toFixed(0)} km/h)`);
});

test('scraping the side of a bot is soft, and the bot drifts back into its lane by itself', () => {
  const sim = empty(), b = bot(sim, 'van', 0, 4, 25), c = car(1, 0, 25);
  // a quick nudge of the wheel toward lane 0 (left = toward +X), then straight on
  const hits = drive(c, sim, { ...GAS, left: 1 }, 0.15).concat(drive(c, sim, GAS, 1.0));
  assert.ok(hits.length >= 1, 'no contact');
  assert.ok(hits.every(h => !h.hard), 'a side scrape must never be a crash');
  assert.ok(Math.abs(b.off) > 0.01, 'the bot should be knocked sideways a little');
  drive(c, sim, { ...NONE, right: 1 }, 0.4); drive(c, sim, NONE, 4);
  assert.ok(Math.abs(b.x - laneCenter(0)) < 0.05, `bot still ${(b.x - laneCenter(0)).toFixed(2)} m off its lane`);
  assert.equal(b.hazard, 0);
});

test('ramming a bot side-on at full lock is a crash', () => {
  const sim = empty(); bot(sim, 'sedan', 0, 1, 20); const c = car(2, 0, 40, 0.9);   // alongside, heading hard left across the lanes
  const hits = drive(c, sim, GAS, 1);
  assert.ok(hits.length >= 1, 'no contact');
  assert.ok(hits[0].side, 'the test should hit the flank');
  assert.ok(hits[0].impact >= HARD_SIDE && hits[0].hard, `impact ${hits[0].impact.toFixed(1)} side-on should be a crash`);
});

test('a bot running into the back of a player who stopped is never a crash', () => {
  const sim = empty(), c = car(1, 100, 0), b = bot(sim, 'truck', 1, 100 - (10.5 + 4.3) / 2 - 0.3, 20);
  const hits = drive(c, sim, NONE, 1.5);
  assert.ok(hits.length >= 1, 'no contact');
  assert.ok(hits[0].impact >= HARD_HIT, `test needs a big impact, got ${hits[0].impact.toFixed(1)}`);
  assert.ok(!hits[0].hard, 'the bot was at fault: soft');
  assert.ok(c.vz > 0, 'the car should be pushed forward');
});

test('a bus throws the car back harder than a hatchback', () => {
  const kick = type => { const sim = empty(); bot(sim, type, 1, (TYPES[TYPE[type]].len + 4.3) / 2 + 2, 22); const c = car(1, 0, 30);
    let after = null; drive(c, sim, NONE, 1.5, () => { if (after === null) after = c.vz; }); assert.ok(after !== null, 'no hit'); return after; };
  assert.ok(kick('bus') < kick('hatch'), 'after the same hit the car should be slower behind a bus');
});

test('after many hits, soft and hard, the traffic still never overlaps itself', () => {
  const sim = createTraffic(4), c = car(1, 0, 0);
  sim.reset(4, [{ x: c.x, z: c.z, v: 0 }]);
  let hits = 0;
  for (let s = 0; s < 120; s++) {
    // line up 12 m behind the nearest bot ahead, a little faster (soft) or much faster (crash)
    const ahead = sim.bots.filter(b => b.z > c.z + 10 && b.p === 0).sort((a, b) => a.z - b.z)[0];
    if (ahead) { c.x = ahead.x; c.z = ahead.z - 12; c.h = 0; c.vx = 0; c.vz = ahead.v + (s % 3 === 0 ? 20 : 6); c.spinV = 0; c.steer = 0; }
    hits += drive(c, sim, NONE, 0.8).length;
    const B = sim.bots;
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      const a = B[i], o = B[j];
      if (Math.abs(a.z - o.z) < (TYPES[a.t].len + TYPES[o.t].len) / 2 && Math.abs(a.x - o.x) < (TYPES[a.t].wid + TYPES[o.t].wid) / 2)
        assert.fail(`bots ${a.id} and ${o.id} overlap after hits`);
    }
  }
  assert.ok(hits > 30, `only ${hits} hits: the test did not exercise collisions`);
});
