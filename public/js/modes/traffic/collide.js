// Player car vs traffic. Pure logic (no three.js), so tests can run it in Node.
//
// Shapes (plan 3, stage 4): the player's car and each bot are their hitboxes (core/
// hitboxes.js: the car's from its model, a bot's 'bot:<type>' from its drawn shape), the
// same polygons and the same contact as between two players' cars (net/bump.js contact).
// Was: the car's two circles against the bot's box. Bots are where they are drawn this
// frame (between two simulation steps).
//
// Response: the same hit as between two players' cars (net/bump.js hitImpulse: two rigid
// bodies at the contact point, restitution by how hard, at most 0.05: cars crumple, they
// don't bounce; was 0.3), with friction along the contact (a scrape rubs), spin at most
// BUMP.SPIN, with the bot's mass, so a bus throws the car back harder than a hatchback.
// The push out of the bot is at most 0.3 m per substep, the rest in the next ones. The car's physics is untouched:
// the hit only changes its velocity and spin, exactly like a bump from another player.
//
// How hard: the closing speed at the contact point. Into the back or the front of a bot
// a crash starts at 9 m/s (32 km/h); into its side at 14 m/s (50 km/h), so scraping a
// bot's flank while overtaking stays a soft hit, but ramming it side-on does not. A soft
// hit: the car bounces off and the bot slows down with hazard lights on. A crash counts
// only when the player drove into the bot: a bot running into the back of a player who
// braked is always a soft hit.
import { TYPES, STEP } from './sim.js';
import { BUMP, hitImpulse, contact } from '../../net/bump.js';
import { HITLOG } from '../../core/hitlog.js';

export const HARD_HIT = 9, HARD_SIDE = 14;       // m/s of closing speed: into a bot's back or front / into its side
export const BOT_MASS = { sedan: 1.5, hatch: 1.3, van: 2, truck: 3, bus: 3 };   // the player's car = 1
const clamp = (v, a) => Math.max(-a, Math.min(a, v));

// Where bot b is drawn now, and how it moves.
export function botPose(b, alpha) {
  const dz = b.z - b.pz;
  return {
    x: b.px + (b.x - b.px) * alpha, z: b.pz + dz * alpha,
    yaw: dz > 0.01 ? Math.atan2(b.x - b.px, dz) : 0,
    vx: (b.x - b.px) / STEP, vz: b.v,
  };
}

// Resolves every contact this substep. hooks.onTrafficHit({impact, hard, bot}) is called
// once per contact (not again while the car keeps scraping the same bot for 0.4 s).
export function collideWithTraffic(car, sim, hooks) {
  const hits = [];
  for (const b of sim.bots) {
    const T = TYPES[b.t];
    const P = botPose(b, sim.alpha);
    if (Math.abs(P.z - car.z) > T.len / 2 + 4 || Math.abs(P.x - car.x) > T.wid / 2 + 4) continue;
    const id = 'bot:' + T.name, C = contact(car, { x: P.x, z: P.z, h: P.yaw }, car.carId, id);   // (n from the bot toward the car)
    if (!C) continue;
    // The bot runs on its lane and is heavier: the car takes the whole push out (at most
    // PUSH per substep: a deep overlap comes out over a few, never as a jump).
    const push = Math.min(C.pen, BUMP.PUSH);
    car.x += C.nx * push; car.z += C.nz * push;
    const vn = (car.vx - P.vx) * C.nx + (car.vz - P.vz) * C.nz;   // (centres; the impulse works from the contact point's)
    if (HITLOG.on) HITLOG.push('bot', C.cx, C.cz, -C.nx, -C.nz, -vn, push);   // (?debug=hit: n into the bot, the push out)
    if (vn >= 0) continue;                                       // already moving apart
    const H = hitImpulse(car, P, C, 1, BOT_MASS[T.name], Infinity, car.carId, id);
    if (!H) continue;                                           // the contact points part (the car's spin)
    const carInto = -(car.vx * C.nx + car.vz * C.nz), botInto = P.vx * C.nx + P.vz * C.nz;
    car.vx += H.me.vx; car.vz += H.me.vz;
    car.spinV = clamp(car.spinV + H.me.w, BUMP.SPIN);
    const endOn = Math.abs(C.nx * Math.sin(P.yaw) + C.nz * Math.cos(P.yaw)) > 0.7;   // hit its back or front
    const impact = -vn, hard = impact >= (endOn ? HARD_HIT : HARD_SIDE) && carInto >= botInto;
    const fresh = sim.time - (b.lastHit ?? -1) > 0.4;
    b.lastHit = sim.time;
    if (!fresh) continue;
    // the bot slides away from the blow: the sideways part of the impulse, plus, for an
    // off-centre blow into its back or front, a turn away from the side that was struck
    let sv = H.other.vx;
    if (endOn && Math.abs(P.x - car.x) > 0.35) sv += Math.sign(P.x - car.x) * Math.min(2.5, impact * 0.12);
    sim.hit(b.id, { dv: H.other.vz, sv, hard });
    const hit = { impact, hard, side: !endOn, bot: b };
    hits.push(hit);
    if (hooks && hooks.onTrafficHit) hooks.onTrafficHit(hit);
  }
  return hits;
}

