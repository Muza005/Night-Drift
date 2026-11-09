// Online traffic as the game sees it. The server runs the simulation and sends a
// snapshot 10 times a second; this module turns those snapshots into bots predicted to
// the present moment of the shared server clock, so every player draws every bot in
// the same place at the same moment.
//
// It looks exactly like the local simulation from outside (bots, alpha, time, hit), so
// the drawing, the collisions and the scoring use it unchanged.
//
// Smoothing works like for other players' cars (net.js): when a fresh snapshot moves a
// bot's prediction, the drawn bot stays where it was and that small correction fades
// out over ~0.1 s, so corrections never look like jumps.
//
// A hit: the player's game resolves it for its own car at once and also shows the bot
// reacting at once; the server applies the same hit and its next snapshots carry it.
// Snapshots sent before the server could have seen the hit are not applied to that bot.
import { decodeSnapshot, predictBot } from './netcodec.js';
import { STEP } from './sim.js';

export function createRemoteTraffic({ now, send, rtt }) {
  const R = { bots: [], alpha: 1, time: 0, online: true };
  const base = new Map();      // id -> {b: bot as in the snapshot, t: server ms of that snapshot}
  const disp = new Map();      // id -> the bot object handed to drawing/collisions (kept between frames)
  const hold = new Map();      // id -> server ms: ignore snapshots older than this (a local hit is in flight)
  let lastT = 0;

  const pose = (b, ageS) => predictBot(b, Math.min(1, Math.max(0, ageS)));

  R.reset = () => { base.clear(); disp.clear(); hold.clear(); lastT = 0; R.bots = []; };

  R.push = arr => {
    const s = decodeSnapshot(arr);
    if (s.t <= lastT) return;                       // out of date
    lastT = s.t;
    const t = now(), seen = new Set();
    for (const b of s.bots) {
      seen.add(b.id);
      if (s.t < (hold.get(b.id) || 0)) continue;
      const was = base.get(b.id), d = disp.get(b.id);
      if (was && d) {
        const o = pose(was.b, (t - was.t) / 1000), n = pose(b, (t - s.t) / 1000);
        d.ox += o.x - n.x; d.oz += o.z - n.z;
      }
      base.set(b.id, { b, t: s.t });
    }
    for (const id of [...base.keys()]) if (!seen.has(id)) { base.delete(id); disp.delete(id); hold.delete(id); }
  };

  // Every frame: every bot where it is now.
  R.advance = dt => {
    const t = now(); R.time = t / 1000;
    const k = Math.exp(-10 * Math.min(dt, 0.1)), list = [];
    for (const [id, { b, t: bt }] of base) {
      const age = (t - bt) / 1000, P = pose(b, age), Q = pose(b, age - 0.02);
      let d = disp.get(id);
      if (!d) { d = { id, t: b.t, color: b.color, ox: 0, oz: 0 }; disp.set(id, d); }
      if (Math.hypot(d.ox, d.oz) > 8) d.ox = d.oz = 0;   // a big disagreement: just snap
      d.ox *= k; d.oz *= k;
      d.x = P.x + d.ox; d.z = P.z + d.oz; d.v = P.v; d.a = b.a;
      // one simulation step back along the current motion (the drawing and the
      // collisions read the bot's velocity from these, as with the local simulation)
      const vx = (P.x - Q.x) / 0.02;
      d.px = d.x - vx * STEP; d.pz = d.z - P.v * STEP;
      d.lane = P.lane; d.from = P.from; d.to = P.to; d.p = P.p; d.off = P.off;
      d.dir = P.p > 0 ? 0 : b.dir; d.hazard = P.hazard;
      list.push(d);
    }
    R.bots = list;
  };

  // The local player hit bot `id`: show its reaction now, tell the server.
  R.hit = (id, { dv = 0, dx = 0 } = {}) => {
    const e = base.get(id); if (!e) return null;
    const t = now(), P = pose(e.b, (t - e.t) / 1000);
    base.set(id, { t, b: { ...e.b, lane: P.lane, from: P.from, to: P.to, p: P.p, z: P.z,
      v: Math.max(0, P.v + dv), a: 0, off: Math.max(-1.2, Math.min(1.2, P.off + dx)), hazard: 3, dir: 0 } });
    hold.set(id, t + (rtt() || 200) / 2 + 120);
    send('hitBot', { id, dv, dx });
    return disp.get(id) || null;
  };
  return R;
}
