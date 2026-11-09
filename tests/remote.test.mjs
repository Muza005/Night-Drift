// Online traffic prediction: how far a player's picture of the bots is from the truth,
// and how far two players' pictures are from each other, with real network delays.
// The server's simulation runs here; its snapshots reach two players after 75±25 ms
// and 150±50 ms. At every frame we compare where each player draws each bot with where
// the bot really is at that moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTraffic, STEP } from '../public/js/modes/traffic/sim.js';
import { encodeSnapshot } from '../public/js/modes/traffic/netcodec.js';
import { createRemoteTraffic } from '../public/js/modes/traffic/remote.js';
import { laneCenter } from '../public/js/modes/traffic/geometry.js';

function run({ seconds = 60, seed = 3, hits = false } = {}) {
  // 1. the server: the simulation, a player driving through traffic, a snapshot every 2 steps
  const sim = createTraffic(seed);
  const pl = { x: laneCenter(1), z: 0, v: 0 };
  sim.reset(seed, [pl]);
  const truth = [], snaps = [];
  for (let k = 1; k <= seconds / STEP; k++) {
    pl.v = Math.min(36, pl.v + 4 * STEP); pl.z += pl.v * STEP;
    sim.stepOnce([pl]);
    // every 2 s a bot near the player is hit: it slides and brakes (sim.js HIT)
    if (hits && k % 40 === 0) { const b = sim.bots.find(o => o.z > pl.z && o.z < pl.z + 60); if (b) sim.hit(b.id, { dv: 2, sv: (k % 80 ? 1 : -1) * 2.5, hard: k % 120 === 0 }); }
    truth.push(new Map(sim.bots.map(b => [b.id, { x: b.x, z: b.z }])));
    if (k % 2 === 0) snaps.push({ t: k * STEP * 1000, data: encodeSnapshot(sim, k * STEP * 1000) });
  }
  const at = tMs => {                                        // true position of every bot at time t
    const f = tMs / 1000 / STEP - 1, i = Math.floor(f), u = f - i;
    if (i < 0 || i + 1 >= truth.length) return null;
    const A = truth[i], B = truth[i + 1], out = new Map();
    for (const [id, a] of A) { const b = B.get(id); if (b) out.set(id, { x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u }); }
    return out;
  };
  // 2. two players with different pings
  let s = 9; const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  const mk = (oneWay, jitter) => {
    let clock = 0, lastArrive = 0;
    const R = createRemoteTraffic({ now: () => clock, send() {}, rtt: () => 2 * oneWay });
    const inbox = snaps.map(p => { const at = Math.max(lastArrive, p.t + oneWay + (rnd() - 0.5) * 2 * jitter); lastArrive = at; return { at, data: p.data }; });
    return { R, inbox, set: c => { clock = c; } };
  };
  const P1 = mk(75, 25), P2 = mk(150, 50);
  const err = [], diff = [];
  for (let t = 1000; t < seconds * 1000 - 200; t += 1000 / 60) {
    const real = at(t); if (!real) continue;
    for (const P of [P1, P2]) {
      P.set(t);
      while (P.inbox.length && P.inbox[0].at <= t) P.R.push(P.inbox.shift().data);
      P.R.advance(1 / 60);
    }
    const m2 = new Map(P2.R.bots.map(b => [b.id, b]));
    for (const b of P1.R.bots) {
      const r = real.get(b.id); if (!r) continue;
      err.push(Math.hypot(b.x - r.x, b.z - r.z));
      const o = m2.get(b.id); if (o) diff.push(Math.hypot(b.x - o.x, b.z - o.z));
    }
  }
  const stats = a => { a.sort((x, y) => x - y); return { mean: a.reduce((q, v) => q + v, 0) / a.length, p95: a[Math.floor(a.length * .95)], max: a.at(-1), n: a.length }; };
  return { err: stats(err), diff: stats(diff) };
}

test('players see every bot within centimetres of the truth and of each other', () => {
  for (const seed of [3, 11]) {
    const { err, diff } = run({ seed });
    console.log(`    seed ${seed}: player vs truth mean ${err.mean.toFixed(3)} m, p95 ${err.p95.toFixed(3)} m, max ${err.max.toFixed(2)} m · ` +
      `player A vs player B mean ${diff.mean.toFixed(3)} m, p95 ${diff.p95.toFixed(3)} m (${err.n} samples)`);
    assert.ok(err.n > 10000, 'too few samples');
    assert.ok(err.mean < 0.15 && err.p95 < 0.5, `prediction error too large: mean ${err.mean}, p95 ${err.p95}`);
    assert.ok(diff.mean < 0.15 && diff.p95 < 0.5, `two players disagree too much: mean ${diff.mean}, p95 ${diff.p95}`);
  }
});

test('bots that were hit (sliding, braking) are predicted just as closely', () => {
  const { err, diff } = run({ seed: 5, hits: true });
  console.log(`    with hits: player vs truth mean ${err.mean.toFixed(3)} m, p95 ${err.p95.toFixed(3)} m · A vs B mean ${diff.mean.toFixed(3)} m`);
  assert.ok(err.mean < 0.15 && err.p95 < 0.5, `prediction error too large: mean ${err.mean}, p95 ${err.p95}`);
  assert.ok(diff.mean < 0.15 && diff.p95 < 0.5, `two players disagree too much: mean ${diff.mean}, p95 ${diff.p95}`);
});
