// Traffic simulation for the highway. Pure logic: no three.js, no DOM, no Math.random.
//
// Why it is built this way: in online play (stage 6) the server runs this same file
// and every player draws the same bots. So the simulation
//  - advances in fixed steps of 1/20 s, whatever the frame rate;
//  - takes its randomness from a seeded generator, so the same seed and the same
//    players give the same traffic, step for step;
//  - uses only + − × ÷ and square roots, which give the same result in every browser
//    and in Node.
// The renderer draws the bots between two steps (see `alpha`), so motion stays smooth.
//
// Driving model: each bot keeps a desired speed and follows the car ahead in its lane
// with the Intelligent Driver Model (IDM): it eases off as the gap shrinks and brakes
// hard only when it must, so bots never run into each other. Players count as cars
// ahead too. Lane changes: a bot that is stuck behind a slower car (or, now and then,
// just because) looks for a safe gap, signals for 1 s, then moves over in 1.5 s.
import { LANES, LANE_W, laneCenter } from './geometry.js';

export const STEP = 1 / 20;

// Vehicle types. Lengths and widths in metres, speeds in m/s (16 m/s = 58 km/h).
// `lc` scales how often the type changes lanes; heavy vehicles keep to the right lanes.
export const TYPES = [
  { name: 'sedan', len: 4.4,  wid: 1.9, vMin: 21, vMax: 29, weight: 40, lc: 1.0,  right: false },
  { name: 'hatch', len: 3.9,  wid: 1.8, vMin: 19, vMax: 27, weight: 25, lc: 1.0,  right: false },
  { name: 'van',   len: 5.0,  wid: 2.0, vMin: 18, vMax: 24, weight: 15, lc: 0.6,  right: false },
  { name: 'truck', len: 10.5, wid: 2.4, vMin: 16, vMax: 21, weight: 12, lc: 0.25, right: true },
  { name: 'bus',   len: 11.0, wid: 2.5, vMin: 16, vMax: 20, weight: 8,  lc: 0.2,  right: true },
];
const WEIGHT_SUM = TYPES.reduce((s, t) => s + t.weight, 0);
// lane speed bias: the left lane is the fast one
const LANE_BIAS = [2, 1, 0, -1];

export const CFG = {
  gapStart: 64, gapEnd: 44, rampDist: 3000,   // average distance between bots in one lane, start → after 3 km
  startClear: 200,                            // nothing on the first 200 m of road
  spawnFrom: 380, spawnTo: 460,               // new bots appear this far ahead of the leading player
  despawnBehind: 60, despawnAhead: 700,
  maxBots: 48,
  idm: { a: 1.4, b: 3.0, T: 1.1, s0: 4, maxBrake: 9 },
  blink: 1.0, change: 1.5, cooldown: 4, blinkWait: 2,
  playerGuard: 15,                            // no lane change into a lane where a player is closer than this
  player: { len: 4.3, wid: 2.0 },
};

// Small, fast, seeded generator (32-bit LCG). Same seed → same sequence everywhere.
function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
}
const smooth = p => p * p * (3 - 2 * p);

export function createTraffic(seed = 1) {
  const sim = { bots: [], time: 0, alpha: 0, seed, nextId: 1, players: [] };
  let rnd = makeRng(seed), acc = 0;

  /* ---------- helpers ---------- */
  const lanesOf = b => (b.p > 0 ? [b.from, b.to] : [b.lane]);
  const inLane = (b, L) => b.p > 0 ? (b.from === L || b.to === L) : b.lane === L;
  const playerInLane = (p, L) => Math.abs(p.x - laneCenter(L)) < LANE_W / 2 + CFG.player.wid / 2;
  const lenOf = b => TYPES[b.t].len;
  const laneAllowed = (b, L) => L >= 0 && L < LANES && (!TYPES[b.t].right || L >= 2);

  // Everything in lane L as {z, len, v, bot|null}, from the step-start positions.
  function laneObjects(L, players) {
    const out = [];
    for (const b of sim.bots) if (inLane(b, L)) out.push({ z: b.z, len: lenOf(b), v: b.v, a: b.a, bot: b });
    for (const p of players) if (!p.ghost && playerInLane(p, L)) out.push({ z: p.z, len: CFG.player.len, v: p.v, a: p.a, bot: null });
    return out;
  }
  // Nearest thing ahead of bot b in lane L: {gap, v, bot} or null.
  function leaderIn(b, L, objs) {
    let best = null;
    for (const o of objs) {
      if (o.bot === b || o.z <= b.z) continue;
      const gap = o.z - b.z - (o.len + lenOf(b)) / 2;
      if (!best || gap < best.gap) best = { gap, v: o.v, a: o.a, bot: o.bot };
    }
    return best;
  }
  function followerIn(b, L, objs) {
    let best = null;
    for (const o of objs) {
      if (o.bot === b || o.z > b.z) continue;
      const gap = b.z - o.z - (o.len + lenOf(b)) / 2;
      if (!best || gap < best.gap) best = { gap, v: o.v, bot: o.bot };
    }
    return best;
  }
  // How many lanes are blocked around z (within a car length + 6 m), counting the
  // lanes in `extra` (one lane or a list) as taken too.
  function lanesBlocked(z, len, extra, skip) {
    const blocked = new Array(LANES).fill(false);
    for (const L of [].concat(extra)) if (L >= 0) blocked[L] = true;
    for (const o of sim.bots) {
      if (o === skip) continue;
      if (Math.abs(o.z - z) < (lenOf(o) + len) / 2 + 6) for (const L of lanesOf(o)) blocked[L] = true;
    }
    return blocked.filter(Boolean).length;
  }

  function idmAccel(b, leader) {
    const { a, b: bb, T, s0, maxBrake } = CFG.idm;
    const r = b.v / b.v0, free = 1 - r * r * r * r;
    let acc = a * free;
    if (leader) {
      const dv = b.v - leader.v;
      const sStar = s0 + Math.max(0, b.v * T + b.v * dv / (2 * Math.sqrt(a * bb)));
      const s = Math.max(0.1, leader.gap), q = sStar / s;
      acc = a * (free - q * q);
    }
    // Emergency: if the car ahead is braking hard, IDM's gentle response can be too late.
    // Brake at least as hard as needed not to reach it: its own braking plus what it takes
    // to cancel our closing speed within the gap (keeping 1 m).
    if (leader && b.v > leader.v) {
      const dv = b.v - leader.v, room = Math.max(0.3, leader.gap - 1);
      const need = Math.max(0, -(leader.a || 0)) + dv * dv / (2 * room);
      if (dv / Math.max(0.1, leader.gap) > 1 / 3) acc = Math.min(acc, -need);
    }
    return Math.max(-maxBrake, Math.min(a, acc));
  }

  // Is it safe for bot b to move into lane L right now?
  function safeToEnter(b, L, players, lanesCache) {
    if (!laneAllowed(b, L)) return false;
    const objs = lanesCache[L];
    const ahead = leaderIn(b, L, objs), behind = followerIn(b, L, objs);
    if (ahead && ahead.gap < Math.max(8, 0.6 * b.v + 2 * (b.v - ahead.v))) return false;
    if (behind && behind.gap < Math.max(8, 0.8 * behind.v + 2 * (behind.v - b.v))) return false;
    for (const p of players) {
      if (p.ghost || !playerInLane(p, L)) continue;
      if (Math.abs(p.z - b.z) < CFG.playerGuard + lenOf(b) / 2) return false;
      if (p.z < b.z && p.v > b.v + 5 && b.z - p.z < 45) return false;     // a player closing in fast from behind
    }
    // never close the last free lane: while moving over, the bot takes both lanes
    if (lanesBlocked(b.z, lenOf(b), [b.lane, L], b) >= LANES) return false;
    return true;
  }

  /* ---------- spawning ---------- */
  function pickType(lane) {
    for (let tries = 0; tries < 4; tries++) {
      let r = rnd() * WEIGHT_SUM, t = 0;
      while (r >= TYPES[t].weight) { r -= TYPES[t].weight; t++; }
      if (!TYPES[t].right || lane >= 2) return t;
    }
    return 0;
  }
  function spawn(lane, z) {
    const t = pickType(lane), T = TYPES[t];
    const v0 = T.vMin + (T.vMax - T.vMin) * rnd() + LANE_BIAS[lane];
    const bot = { id: sim.nextId++, t, lane, from: lane, to: lane, p: 0, x: laneCenter(lane), z, px: laneCenter(lane), pz: z,
      v: v0 * (0.9 + 0.1 * rnd()), v0, a: 0, dir: 0, blink: 0, wait: 0, hazard: 0, off: 0, cool: 2 * rnd(), think: 0.5 + 1.5 * rnd(), color: (rnd() * 1e6) | 0 };
    sim.bots.push(bot);
    return bot;
  }
  function meanGap(front) {
    const k = Math.min(1, Math.max(0, front) / CFG.rampDist);
    return CFG.gapStart + (CFG.gapEnd - CFG.gapStart) * k;
  }
  // Fill each lane up to `to` ahead of the leading player; never inside `from`.
  function fill(players, from, to) {
    if (!players.length) return;
    const front = Math.max(...players.map(p => p.z));
    const gap = meanGap(front);
    for (let L = 0; L < LANES; L++) {
      for (let guard = 0; guard < 20 && sim.bots.length < CFG.maxBots; guard++) {
        let far = -Infinity;
        for (const b of sim.bots) if (inLane(b, L) && b.z > far) far = b.z;
        // the first bot of a lane starts somewhere within one gap, so lanes don't start level
        let z = (far === -Infinity ? Math.max(front + from, CFG.startClear) + gap * rnd() : far + gap * (0.6 + 0.8 * rnd()));
        z = Math.max(z, front + from, CFG.startClear);
        if (z > front + to) break;
        for (let k = 0; k < 4 && lanesBlocked(z, 11, L, null) >= LANES; k++) z += 15;   // keep a way through
        if (z > front + to) break;
        spawn(L, z);
      }
    }
  }

  /* ---------- one fixed step ---------- */
  let prevPlayerV = [];
  function step(players) {
    const dt = STEP;
    sim.time += dt;
    // players' acceleration from their speed one step ago (players are given in the same order every step)
    players = players.map((p, i) => ({ ...p, a: prevPlayerV[i] === undefined ? 0 : (p.v - prevPlayerV[i]) / dt }));
    prevPlayerV = players.map(p => p.v);
    const lanes = []; for (let L = 0; L < LANES; L++) lanes.push(laneObjects(L, players));

    // 1. keep a way through. For every bot: which lanes are taken by the cars level
    //    with it (its "row", as a 4-bit mask). A bot never comes alongside a row ahead
    //    if together they would close all four lanes: it stays behind as if that row
    //    were the car in front. And if a full row forms anyway, its slowest car eases
    //    off for a moment so the row breaks up.
    const B = sim.bots, ALL = (1 << LANES) - 1;
    for (const b of B) { b.row = 0; b.px = b.x; b.pz = b.z; }
    for (const b of B) for (const o of B) {
      if (Math.abs(o.z - b.z) < (lenOf(o) + lenOf(b)) / 2 + 2) for (const L of lanesOf(o)) b.row |= 1 << L;
    }
    for (const b of B) {
      if (b.row !== ALL) continue;
      let slow = b;
      for (const o of B) if (Math.abs(o.z - b.z) < (lenOf(o) + lenOf(b)) / 2 + 2 && o.v < slow.v) slow = o;
      slow.ease = 2;
    }

    // 2. accelerations from the start-of-step picture (order of bots does not matter)
    for (const b of B) {
      let lead = null;
      for (const L of lanesOf(b)) { const l = leaderIn(b, L, lanes[L]); if (l && (!lead || l.gap < lead.gap)) lead = l; }
      for (const o of B) {
        if (o === b || o.z <= b.z || o.z - b.z > 70 || o.v >= b.v || (b.row | o.row) !== ALL) continue;
        if (lanesOf(o).some(L => lanesOf(b).includes(L))) continue;      // same lane: already the real leader
        const gap = o.z - b.z - (lenOf(o) + lenOf(b)) / 2 - 4;
        if (gap > 0 && (!lead || gap < lead.gap)) lead = { gap, v: o.v, a: o.a, bot: null };
      }
      b.ease = Math.max(0, (b.ease || 0) - dt);
      const v0 = b.v0;
      if (b.ease > 0) b.v0 = v0 * 0.85;
      if (b.hazard > 0) b.v0 = v0 * 0.6;               // just hit: hazard lights on, slows to 60 %
      b.a = idmAccel(b, lead); b.lead = lead;
      b.v0 = v0;
    }
    // 3. move
    for (const b of sim.bots) {
      b.v = Math.max(0, b.v + b.a * dt);
      b.z += b.v * dt;
    }
    // 4. never overlap another bot (a last guard; IDM keeps gaps well before this)
    for (const b of sim.bots) {
      const l = b.lead; if (!l || !l.bot) continue;
      const rear = l.bot.z - lenOf(l.bot) / 2, limit = rear - 0.5 - lenOf(b) / 2;
      if (b.z > limit) { b.z = limit; b.v = Math.min(b.v, l.bot.v); }
    }
    // 5. lane changes
    for (const b of sim.bots) {
      b.cool = Math.max(0, b.cool - dt);
      b.hazard = Math.max(0, b.hazard - dt);
      if (b.p > 0) {                                     // moving over
        b.p += dt / CFG.change;
        if (b.p >= 1) { b.lane = b.to; b.from = b.to; b.p = 0; b.dir = 0; b.cool = CFG.cooldown; }
      } else if (b.dir !== 0) {                          // signalling
        b.blink -= dt;
        if (b.blink <= 0) {
          const L = b.lane + b.dir;
          if (safeToEnter(b, L, players, lanes)) { b.from = b.lane; b.to = L; b.p = dt / CFG.change; }
          else if ((b.wait += dt) > CFG.blinkWait) { b.dir = 0; b.wait = 0; b.cool = 2; }
        }
      } else if (b.hazard > 0) {                         // just hit: no lane changes until it recovers
      } else if ((b.think -= dt) <= 0) {                 // deciding
        b.think = 0.8 + 1.6 * rnd();
        if (b.cool > 0) continue;
        const T = TYPES[b.t], lead = b.lead;
        const stuck = lead && lead.gap < 45 && lead.v < b.v0 - 1.5;
        const whim = rnd() < 0.08 * T.lc;
        if (!stuck && !whim) continue;
        const order = stuck ? [b.lane - 1, b.lane + 1] : (rnd() < 0.5 ? [b.lane - 1, b.lane + 1] : [b.lane + 1, b.lane - 1]);
        for (const L of order) {
          if (!laneAllowed(b, L) || !safeToEnter(b, L, players, lanes)) continue;
          if (stuck) { const there = leaderIn(b, L, lanes[L]); if (there && there.gap < lead.gap + 15) continue; }
          b.dir = L - b.lane; b.blink = CFG.blink; b.wait = 0;
          break;
        }
      }
    }
    // 6. lateral position
    for (const b of sim.bots) {
      // a knock from a hit fades back toward the lane centre at 0.8 m/s
      b.off = b.off > 0 ? Math.max(0, b.off - 0.8 * dt) : Math.min(0, b.off + 0.8 * dt);
      b.x = (b.p > 0 ? laneCenter(b.from) + (laneCenter(b.to) - laneCenter(b.from)) * smooth(Math.min(1, b.p)) : laneCenter(b.lane)) + b.off;
    }
    // 7. remove bots far behind every player or far ahead of all of them, then refill
    if (players.length) {
      const back = Math.min(...players.map(p => p.z)) - CFG.despawnBehind;
      const front = Math.max(...players.map(p => p.z)) + CFG.despawnAhead;
      sim.bots = sim.bots.filter(b => b.z >= back && b.z <= front);
      fill(players, CFG.spawnFrom, CFG.spawnTo);
    }
  }

  /* ---------- public ---------- */
  // players: [{x, z, v, ghost?}] where v is the speed along the road (m/s). A ghost
  // player (online, just crashed and blinking) still keeps traffic around itself but
  // is not an obstacle: bots drive through it.
  sim.reset = (newSeed = seed, players = []) => {
    rnd = makeRng(newSeed); sim.seed = newSeed; sim.bots = []; prevPlayerV = []; sim.time = 0; sim.nextId = 1; acc = 0; sim.alpha = 0;
    fill(players, 0, CFG.spawnTo);      // first fill also covers the road in view (beyond the clear start zone)
  };
  sim.advance = (dt, players) => {
    acc += Math.min(dt, 0.25);
    while (acc >= STEP) { step(players); acc -= STEP; }
    sim.alpha = acc / STEP;
  };
  sim.stepOnce = players => step(players);
  // A player hit bot `id`. dv: change of its speed along the road (m/s), dx: sideways
  // knock (m). The bot turns its hazard lights on for 3 s, slows to 60 % and drops any
  // lane change it was signalling; the knock fades back into its lane. Deterministic,
  // so online the server can apply the same event and every player sees the same bot.
  sim.hit = (id, { dv = 0, dx = 0 } = {}) => {
    const b = sim.bots.find(o => o.id === id); if (!b) return null;
    b.v = Math.max(0, b.v + dv);
    b.off = Math.max(-1.2, Math.min(1.2, b.off + dx));
    b.hazard = 3;
    if (b.p === 0) { b.dir = 0; b.blink = 0; b.wait = 0; }
    return b;
  };
  // Plain copy of everything that defines the traffic (for tests and, later, the network).
  sim.snapshot = () => sim.bots.map(b => [b.id, b.t, b.lane, b.from, b.to, b.p, b.x, b.z, b.v, b.v0, b.dir, b.blink, b.hazard, b.off]);
  return sim;
}
