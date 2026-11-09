// Traffic simulation: no bot ever runs into another, bots do not rear-end a player who
// stays in a lane, lane changes are signalled, a way through always stays open, and
// the same seed always gives the same traffic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTraffic, TYPES, STEP, CFG, DENSITY } from '../public/js/modes/traffic/sim.js';
import { LANES, LANE_W, laneCenter } from '../public/js/modes/traffic/geometry.js';

// A scripted player (not the real physics: we only need a moving obstacle). It speeds
// up, changes lanes, slows down, and sometimes stops dead in a lane for a while.
function scriptedPlayer(seconds) {
  const p = { x: laneCenter(1), z: 0, v: 0, lane: 1, laneSince: 0 };
  return t => {
    const phase = t % 60;
    const want = phase < 20 ? 45 : phase < 30 ? 25 : phase < 38 ? 8 : phase < 46 ? 0 : 38;
    p.v += Math.max(-9, Math.min(5, (want - p.v))) * STEP;
    p.z += p.v * STEP;
    const lane = [1, 0, 2, 3, 1, 2][Math.floor(t / 7) % 6];
    if (lane !== p.lane) { p.lane = lane; p.laneSince = t; }
    const tx = laneCenter(p.lane), dx = tx - p.x;
    p.x += Math.sign(dx) * Math.min(Math.abs(dx), 4 * STEP);
    return p;
  };
}

const lanesOf = b => (b.p > 0 ? [b.from, b.to] : [b.lane]);

for (const [SEED, DENS] of [[42, 'mid'], [7, 'mid'], [42, 'high'], [7, 'low']]) test(`10 minutes of ${DENS} traffic (seed ${SEED}): no bot hits a bot or rear-ends a player, a way through stays open`, () => {
  const sim = createTraffic(SEED), move = scriptedPlayer(600);
  let p = move(0);
  sim.reset(SEED, [p], DENS);
  let maxBots = 0, laneChanges = 0, earlyChange = 0, guardBreak = 0, walls = 0, steps = 0;
  const blinkSince = new Map(), prevP = new Map(), touchedBefore = new Set();
  for (let t = 0; t < 600; t += STEP, steps++) {
    p = move(t);
    sim.stepOnce([{ x: p.x, z: p.z, v: p.v }]);
    const B = sim.bots; maxBots = Math.max(maxBots, B.length);
    // bots never overlap each other
    for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
      const a = B[i], b = B[j];
      const dz = Math.abs(a.z - b.z), dx = Math.abs(a.x - b.x);
      if (dz < (TYPES[a.t].len + TYPES[b.t].len) / 2 && dx < (TYPES[a.t].wid + TYPES[b.t].wid) / 2)
        assert.fail(`t=${t.toFixed(2)}: bots ${a.id} and ${b.id} overlap (dz ${dz.toFixed(2)}, dx ${dx.toFixed(2)})`);
    }
    // a bot never drives into a player who holds his lane. Contact counts against the bot
    // only if it STARTS after the player has been settled in the lane for 3 s (a player who
    // cuts in right in front of a bus is at fault) and the bot is the one closing in.
    const settled = t - p.laneSince > 3 && Math.abs(p.x - laneCenter(p.lane)) < 0.05;
    for (const b of B) {
      const touching = b.z < p.z && lanesOf(b).includes(p.lane) && p.z - b.z < (TYPES[b.t].len + CFG.player.len) / 2;
      const began = touching && !touchedBefore.has(b.id);
      if (touching) touchedBefore.add(b.id); else touchedBefore.delete(b.id);
      if (began && settled && b.v > p.v)
        assert.fail(`t=${t.toFixed(2)}: bot ${b.id} ran into the player from behind (bot z ${b.z.toFixed(2)} v ${b.v.toFixed(1)} lanes ${lanesOf(b)}, player z ${p.z.toFixed(2)} v ${p.v.toFixed(1)} x ${p.x.toFixed(2)})`);
    }
    // lane changes: signalled for at least 1 s, never toward a player closer than 15 m
    for (const b of B) {
      if (b.dir !== 0 && b.p === 0 && !blinkSince.has(b.id)) blinkSince.set(b.id, t);
      if (b.p > 0 && (prevP.get(b.id) || 0) === 0) {
        laneChanges++;
        if (t - (blinkSince.get(b.id) ?? t) < CFG.blink - 1e-9) earlyChange++;
        const near = Math.abs(p.z - b.z) < CFG.playerGuard + TYPES[b.t].len / 2 && Math.abs(p.x - laneCenter(b.to)) < LANE_W / 2 + 1;
        if (near) guardBreak++;
      }
      if (b.dir === 0) blinkSince.delete(b.id);
      prevP.set(b.id, b.p);
    }
    // a way through: in front of the player, all four lanes blocked side by side at most for a blink
    let wallNow = false;
    for (const b of B) {
      if (b.z < p.z + 30 || b.z > p.z + 300) continue;
      const blocked = new Set();
      for (const o of B) if (Math.abs(o.z - b.z) < (TYPES[o.t].len + TYPES[b.t].len) / 2) for (const L of lanesOf(o)) blocked.add(L);
      if (blocked.size >= LANES) wallNow = true;
    }
    if (wallNow) walls++;
  }
  assert.ok(maxBots <= CFG.maxBots * DENSITY[DENS], `${maxBots} bots at once`);
  assert.ok(laneChanges > 50, `only ${laneChanges} lane changes in 10 minutes`);
  assert.equal(earlyChange, 0, 'a bot moved over without signalling for 1 s');
  assert.equal(guardBreak, 0, 'a bot changed lanes toward a player closer than 15 m');
  // the densest traffic fills the road: a short wall now and then is allowed there
  assert.ok(walls * STEP <= (DENS === 'high' ? 6 : 1), `all four lanes blocked ahead for ${(walls * STEP).toFixed(2)} s in total`);
  console.log(`    ${DENS}, seed ${SEED}: up to ${maxBots} bots, ${laneChanges} lane changes, all lanes blocked ${(walls * STEP).toFixed(2)} s, player at ${(p.z / 1000).toFixed(1)} km`);
});

test('same seed and same players give exactly the same traffic', () => {
  const run = seed => {
    const sim = createTraffic(seed), move = scriptedPlayer(120); let p = move(0);
    sim.reset(seed, [p]);
    for (let t = 0; t < 120; t += STEP) { p = move(t); sim.stepOnce([{ x: p.x, z: p.z, v: p.v }]); }
    return JSON.stringify(sim.snapshot());
  };
  assert.equal(run(7), run(7));
  assert.notEqual(run(7), run(8));
});

test('frame rate does not change the traffic: advance(dt) equals fixed steps', () => {
  const players = [{ x: laneCenter(1), z: 0, v: 0 }];
  const a = createTraffic(3), b = createTraffic(3);
  a.reset(3, players); b.reset(3, players);
  let t = 0, i = 0;
  while (t < 30) { const dt = [1 / 60, 1 / 144, 1 / 30, 0.037][i++ % 4]; a.advance(dt, players); t += dt; }
  const n = Math.round((t - (a.alpha * STEP)) / STEP);
  for (let k = 0; k < n; k++) b.stepOnce(players);
  assert.equal(JSON.stringify(a.snapshot()), JSON.stringify(b.snapshot()));
});

test('start: first 200 m clear, traffic gets denser after 3 km', () => {
  const sim = createTraffic(5);
  sim.reset(5, [{ x: laneCenter(1), z: 0, v: 0 }]);
  assert.ok(sim.bots.length > 4);
  assert.ok(sim.bots.every(b => b.z >= CFG.startClear));
  const count = z0 => { const s = createTraffic(9); const p = { x: laneCenter(1), z: z0, v: 30 }; s.reset(9, [p]);
    for (let k = 0; k < 400; k++) { p.z += 30 * STEP; s.stepOnce([p]); } return s.bots.length; };
  assert.ok(count(4000) > count(0), 'traffic should be denser far down the road');
});

test('density: on high a player meets ~1.7 times the cars of mid, on low half', () => {
  // bots overtaken per km at 130 km/h, three seeds
  const perKm = dens => {
    let passed = 0, km = 0;
    for (const seed of [5, 6, 7]) {
      const sim = createTraffic(seed), p = { x: laneCenter(1), z: 0, v: 36 }, seen = new Set();
      sim.reset(seed, [p], dens);
      for (let t = 0; t < 200; t += STEP) {
        p.z += p.v * STEP; sim.stepOnce([p]);
        if (t > 20) for (const b of sim.bots) if (b.z < p.z && !seen.has(b.id)) { seen.add(b.id); passed++; }
      }
      km += 180 * 36 / 1000;
    }
    return passed / km;
  };
  const low = perKm('low'), mid = perKm('mid'), high = perKm('high');
  console.log(`    bots passed per km: low ${low.toFixed(1)}, mid ${mid.toFixed(1)}, high ${high.toFixed(1)}`);
  assert.ok(high / mid > 1.55 && high / mid < 2.1, `high/mid = ${(high / mid).toFixed(2)}`);
  assert.ok(low / mid > 0.38 && low / mid < 0.62, `low/mid = ${(low / mid).toFixed(2)}`);
  const sim = createTraffic(1); sim.reset(1, [{ x: 0, z: 0, v: 0 }], 'high'); sim.reset(2, [{ x: 0, z: 0, v: 0 }]);
  assert.equal(sim.density, DENSITY.high, 'a reset without a density keeps the last one');
});
