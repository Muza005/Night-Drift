// Player car vs traffic. Pure logic (no three.js), so tests can run it in Node.
//
// Shapes: the player's car is the same two circles used for car-to-car hits online
// (net.js), a bot is a box of its real length and width, turned with its heading.
// Bots are where they are drawn this frame (between two simulation steps).
//
// Response: the same hit as between two players' cars (net/bump.js hitImpulse): along
// the contact normal with restitution 0.1 (cars crumple, they don't bounce; was 0.3), with
// friction along the contact (a scrape rubs), spin at most 2 rad/s (was 4), with the bot's
// mass, so a bus throws the car back harder than a hatchback. The push out of the bot is
// at most 0.3 m per substep, the rest in the next ones. The car's physics is untouched:
// the hit only changes its velocity and spin, exactly like a bump from another player.
//
// How hard: the closing speed at the contact point. Into the back or the front of a bot
// a crash starts at 9 m/s (32 km/h); into its side at 14 m/s (50 km/h), so scraping a
// bot's flank while overtaking stays a soft hit, but ramming it side-on does not. A soft
// hit: the car bounces off and the bot slows down with hazard lights on. A crash counts
// only when the player drove into the bot: a bot running into the back of a player who
// braked is always a soft hit.
import { TYPES, STEP } from './sim.js';
import { BUMP, hitImpulse } from '../../net/bump.js';
import { HITLOG } from '../../core/hitlog.js';

export const HARD_HIT = 9, HARD_SIDE = 14;       // m/s of closing speed: into a bot's back or front / into its side
export const BOT_MASS = { sedan: 1.5, hatch: 1.3, van: 2, truck: 3, bus: 3 };   // the player's car = 1
const CAR_R = BUMP.R, CAR_OFF = BUMP.OFF;
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

// Deepest contact between the car's two circles and a box, or null.
function contact(car, P, hx, hz) {
  const c = Math.cos(P.yaw), s = Math.sin(P.yaw);
  const fx = Math.sin(car.h), fz = Math.cos(car.h);
  let best = null;
  for (const k of [1, -1]) {
    const dx = car.x + fx * CAR_OFF * k - P.x, dz = car.z + fz * CAR_OFF * k - P.z;
    const lx = dx * c - dz * s, lz = dx * s + dz * c;          // circle centre in the bot's frame
    const qx = Math.max(-hx, Math.min(hx, lx)), qz = Math.max(-hz, Math.min(hz, lz));
    let nx, nz, pen;
    if (qx === lx && qz === lz) {                               // centre inside the box: leave by the nearest side
      const px = hx - Math.abs(lx), pz = hz - Math.abs(lz);
      if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; pen = px + CAR_R; } else { nx = 0; nz = Math.sign(lz) || 1; pen = pz + CAR_R; }
    } else {
      const ex = lx - qx, ez = lz - qz, d = Math.hypot(ex, ez);
      if (d >= CAR_R) continue;
      nx = ex / d; nz = ez / d; pen = CAR_R - d;
    }
    if (!best || pen > best.pen) best = {
      pen, nx: nx * c + nz * s, nz: -nx * s + nz * c,             // normal from the bot toward the car (world)
      cx: P.x + qx * c + qz * s, cz: P.z - qx * s + qz * c,       // contact point on the bot's surface (world)
    };
  }
  return best;
}

// Resolves every contact this substep. hooks.onTrafficHit({impact, hard, bot}) is called
// once per contact (not again while the car keeps scraping the same bot for 0.4 s).
export function collideWithTraffic(car, sim, hooks) {
  const hits = [];
  for (const b of sim.bots) {
    const T = TYPES[b.t];
    const P = botPose(b, sim.alpha);
    if (Math.abs(P.z - car.z) > T.len / 2 + 4 || Math.abs(P.x - car.x) > T.wid / 2 + 4) continue;
    const C = contact(car, P, T.wid / 2, T.len / 2);
    if (!C) continue;
    // The bot runs on its lane and is heavier: the car takes the whole push out (at most
    // PUSH per substep: a deep overlap comes out over a few, never as a jump).
    const push = Math.min(C.pen, BUMP.PUSH);
    car.x += C.nx * push; car.z += C.nz * push;
    const vn = (car.vx - P.vx) * C.nx + (car.vz - P.vz) * C.nz;
    if (HITLOG.on) HITLOG.push('bot', C.cx, C.cz, -C.nx, -C.nz, -vn, push);   // (?debug=hit: n into the bot, the push out)
    if (vn >= 0) continue;                                       // already moving apart
    const carInto = -(car.vx * C.nx + car.vz * C.nz), botInto = P.vx * C.nx + P.vz * C.nz;
    const M = BOT_MASS[T.name], H = hitImpulse(car, P, C, 1, M);
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

