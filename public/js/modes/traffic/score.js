// Traffic mode scoring. Pure logic (no three.js, no DOM), so tests can run it in Node.
//
// Near miss: overtake a bot with little room to spare. Counted once per bot, when the
// car has fully passed its body without touching it, by the smallest side gap seen
// while alongside:
//   under 1.2 m "Близко" 100 · under 0.6 m "Впритык" 250 · under 0.3 m "На волоске" 500
// Only above 80 km/h, going forward. Points × speed (×1 at 100 km/h, ×1.8 at 180)
// × combo, and ×2 if the car is drifting.
// Combo: every near miss within 2.5 s of the previous one adds 0.5 to the multiplier
// (the first is ×1), up to ×5. A timeout, touching a bot or touching a rail ends it.
// Distance: 1 point per 10 m above 80 km/h, 2 points per 10 m above 140 km/h.
import { TYPES } from './sim.js';
import { botPose } from './collide.js';

export const LEVELS = [
  { gap: 0.3, pts: 500, name: 'На волоске', tier: 3 },
  { gap: 0.6, pts: 250, name: 'Впритык', tier: 2 },
  { gap: 1.2, pts: 100, name: 'Близко', tier: 1 },
];
export const MIN_SPEED = 80 / 3.6, FAST_SPEED = 140 / 3.6, REF_SPEED = 100 / 3.6;
export const COMBO_WINDOW = 2.5, COMBO_STEP = 0.5, COMBO_MAX = 5;
const CAR_HALF_W = 1.0, CAR_HALF_L = 2.15;

export function createScoring() {
  const S = {
    points: 0,          // near misses + distance (drift points are banked by game.js)
    chain: 0, mult: 1, comboLeft: 0, maxMult: 1,
    misses: 0, best: null,   // best = the best single near miss of the run
    distBank: 0,        // metres driven fast that have not been turned into points yet
    passes: new Map(),  // bot id → {gap, touched}
  };

  S.reset = () => { S.points = 0; S.chain = 0; S.mult = 1; S.comboLeft = 0; S.maxMult = 1; S.misses = 0; S.best = null; S.distBank = 0; S.passes.clear(); };
  S.breakCombo = () => { S.chain = 0; S.mult = 1; S.comboLeft = 0; };

  // The car's half-size across the road, turned with its heading (drifting cars are wider).
  const halfAcross = h => Math.abs(Math.cos(h)) * CAR_HALF_W + Math.abs(Math.sin(h)) * CAR_HALF_L;
  const halfAlong = h => Math.abs(Math.sin(h)) * CAR_HALF_W + Math.abs(Math.cos(h)) * CAR_HALF_L;

  // One frame. sim: the traffic; drifting: is the car in a drift right now.
  // Returns the near misses scored this frame: [{level, points, side, mult, drift}].
  S.update = (car, sim, dt, drifting) => {
    const events = [];
    const speed = Math.hypot(car.vx, car.vz), forward = car.vz > 0;
    // combo timer
    if (S.chain > 0) { S.comboLeft -= dt; if (S.comboLeft <= 0) S.breakCombo(); }
    // distance
    if (forward && speed > MIN_SPEED) {
      S.distBank += car.vz * dt;
      const per = speed > FAST_SPEED ? 2 : 1;
      while (S.distBank >= 10) { S.distBank -= 10; S.points += per; }
    }
    // near misses
    const across = halfAcross(car.h), along = halfAlong(car.h);
    const seen = new Set();
    for (const b of sim.bots) {
      const T = TYPES[b.t], P = botPose(b, sim.alpha);
      const dz = car.z - P.z, reach = along + T.len / 2;
      const gap = Math.abs(car.x - P.x) - across - T.wid / 2;
      let pass = S.passes.get(b.id);
      if (Math.abs(dz) < reach && gap < 3) {                 // alongside
        seen.add(b.id);
        if (!pass) { pass = { gap, start: sim.time, from: dz < 0 ? 'behind' : 'ahead' }; S.passes.set(b.id, pass); }
        pass.gap = Math.min(pass.gap, gap);
        continue;
      }
      if (!pass) continue;
      // no longer alongside: did the car get past it, from behind, going fast?
      S.passes.delete(b.id);
      const touched = b.lastHit !== undefined && b.lastHit >= pass.start;   // any contact during the pass
      // overlapping bodies (gap below zero) are a hit, never a near miss
      if (pass.from !== 'behind' || dz <= 0 || touched || pass.gap < -0.2 || !forward || speed < MIN_SPEED) continue;
      const level = LEVELS.find(L => pass.gap < L.gap);
      if (!level) continue;
      S.chain = S.comboLeft > 0 ? S.chain + 1 : 1;
      S.mult = Math.min(COMBO_MAX, 1 + COMBO_STEP * (S.chain - 1));
      S.maxMult = Math.max(S.maxMult, S.mult);
      S.comboLeft = COMBO_WINDOW;
      const pts = Math.round(level.pts * (speed / REF_SPEED) * S.mult * (drifting ? 2 : 1));
      S.points += pts; S.misses++;
      // side of the screen the bot was on (facing +Z, +X is to the left)
      const ev = { level, points: pts, side: P.x < car.x ? 'right' : 'left', mult: S.mult, drift: drifting, gap: pass.gap };
      if (!S.best || pts > S.best.points) S.best = ev;
      events.push(ev);
    }
    // forget bots that disappeared while alongside
    for (const id of S.passes.keys()) if (!seen.has(id) && !sim.bots.some(b => b.id === id)) S.passes.delete(id);
    return events;
  };
  return S;
}
