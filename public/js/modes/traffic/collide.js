// Player car vs traffic. Pure logic (no three.js), so tests can run it in Node.
//
// Shapes: the player's car is the same two circles used for car-to-car hits online
// (net.js), a bot is a box of its real length and width, turned with its heading.
// Bots are where they are drawn this frame (between two simulation steps).
//
// Response: an impulse along the contact normal, bounce 0.3, with the bot's mass, so a
// bus throws the car back harder than a hatchback. The car's physics is untouched: the
// hit only changes its velocity and spin, exactly like a bump from another player.
//
// How hard: the closing speed at the contact point. Into the back or the front of a bot
// a crash starts at 9 m/s (32 km/h); into its side at 14 m/s (50 km/h), so scraping a
// bot's flank while overtaking stays a soft hit, but ramming it side-on does not. A soft
// hit: the car bounces off and the bot slows down with hazard lights on. A crash counts
// only when the player drove into the bot: a bot running into the back of a player who
// braked is always a soft hit.
import { TYPES, STEP } from './sim.js';

export const HARD_HIT = 9, HARD_SIDE = 14;       // m/s of closing speed: into a bot's back or front / into its side
export const BOT_MASS = { sedan: 1.5, hatch: 1.3, van: 2, truck: 3, bus: 3 };   // the player's car = 1
const CAR_R = 1.05, CAR_OFF = 1.15, CAR_I = 1.87, BOUNCE = 0.3;
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
    // The bot runs on its lane and is heavier: the car takes the whole push out.
    car.x += C.nx * C.pen; car.z += C.nz * C.pen;
    const vn = (car.vx - P.vx) * C.nx + (car.vz - P.vz) * C.nz;
    if (vn >= 0) continue;                                       // already moving apart
    const carInto = -(car.vx * C.nx + car.vz * C.nz), botInto = P.vx * C.nx + P.vz * C.nz;
    const M = BOT_MASS[T.name], j = -(1 + BOUNCE) * vn / (1 + 1 / M), Jx = C.nx * j, Jz = C.nz * j;
    car.vx += Jx; car.vz += Jz;
    car.spinV = clamp(car.spinV + ((C.cz - car.z) * Jx - (C.cx - car.x) * Jz) / CAR_I * 0.6, 4);
    const endOn = Math.abs(C.nx * Math.sin(P.yaw) + C.nz * Math.cos(P.yaw)) > 0.7;   // hit its back or front
    const impact = -vn, hard = impact >= (endOn ? HARD_HIT : HARD_SIDE) && carInto >= botInto;
    const fresh = sim.time - (b.lastHit ?? -1) > 0.4;
    b.lastHit = sim.time;
    if (!fresh) continue;
    // the bot slides away from the blow: the sideways part of the impulse, plus, for an
    // off-centre blow into its back or front, a turn away from the side that was struck
    let sv = -Jx / M;
    if (endOn && Math.abs(P.x - car.x) > 0.35) sv += Math.sign(P.x - car.x) * Math.min(2.5, impact * 0.12);
    sim.hit(b.id, { dv: -Jz / M, sv, hard });
    const hit = { impact, hard, side: !endOn, bot: b };
    hits.push(hit);
    if (hooks && hooks.onTrafficHit) hooks.onTrafficHit(hit);
  }
  return hits;
}

