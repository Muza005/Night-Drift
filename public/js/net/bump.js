/* ---------- car-to-car hits: the maths and who decides ----------
   Pure logic (no three.js, no DOM): net.js runs it in the game, tests/bump.test.mjs and
   the two-player scenario in Node.

   Shapes (plan 3, stage 4): each car is its hitbox, the convex polygon of its body from
   its model (core/hitboxes.js), the same one the walls see; the contact point and normal
   come from the real bodies (core/contact.js polyContact). Was: two 1.05 m circles, whose
   centre line slid a rear-end hit or a slow push off to the side.

   One judge per hit. Each player sees the other car where it was a ping ago, moved
   forward by its speed (a prediction), so both players would see the same contact a
   little differently, and both used to resolve it, each against their own picture, and
   both pushed. Now only one of them decides a hit: the faster car (judges); on a tie
   the earlier hit, then the lower sessionId. The judge changes its own car's velocity and sends the other car's
   share through the server; the other player applies only that. A player who is not the
   judge never resolves the contact itself: it draws the other car out of its own (net.js,
   so it never shows that car driving through) and waits. If no hit arrives within a round
   trip and the contact goes on, it takes the hit itself (the other side may never have
   seen it), and a hit that then still arrives is ignored: one impulse per car per hit.

   The hit: the wall's model (core/contact.js) with the other car movable. Two rigid
   bodies, masses in kg (core/cars.js class mass × WALL.KG) and yaw inertia from the
   hitbox, at the contact point (contact.js carImpulse):
   - along the normal, restitution by how hard (contact.js carRestitution): none below
     10 km/h of closing speed (a slow touch rams: the cars meet and move on together), at
     most CAR.E_MAX: two cars crumple, they don't bounce;
   - along the contact, friction up to CAR.MU × the normal impulse (a side swipe rubs);
   - the impulse's lever arm turns the cars: the tyres hold the first YAW_HOLD of its
     moment (a slow push's small impulses never turn the pushed car), of the rest they take
     part (WALL.YAW_K, as at the wall), at most SPIN rad/s;
   - the closing speed it works from is capped by what the cars really do (their reported
     speeds: the prediction may add to it);
   - a contact goes on as long as the cars touch: each substep that they still close in
     takes its own impulse (a push: the rear car hands its pull on to the front one, both
     move as one); none once they move apart;
   - push out of the overlap only along the normal and only by the depth, shared by mass,
     at most PUSH m per substep, the rest in the next;
   - from HOP closing speed the cars are lifted a little (a short hop, no flips): on the
     track maps with heights a real one (car.air, the flight of modes/track/geometry.js),
     elsewhere drawn only (lift()). */
import { carMass, carById } from '../core/cars.js';
import { stepCar } from '../core/physics.js';
import { HITLOG } from '../core/hitlog.js';
import { worldPoly, hitbox } from '../core/hitboxes.js';
import { WALL, CAR, bodyOf, polyContact, carImpulse } from '../core/contact.js';

export const BUMP = Object.freeze({
  E: CAR.E_MAX,           // restitution car to car, at most (contact.js carRestitution)
  MU: CAR.MU,             // body-to-body friction
  YAW_HOLD: 0.1,          // N m s per kg: the yaw impulse a car's tyres take in one substep before it turns (their grip, μ g × half the wheelbase, over 1/120 s). A push's small impulses go straight on; a hard hit's barely notice it
  SPIN: 1.2,              // rad/s, at most (was 2: with the real lever of an off-centre hit, a 180 km/h rear-end 1 m off the line spun the hit car 33° in 0.5 s, 3 m across)
  PUSH: 0.3,              // m per substep, at most
  TIE: 3,                 // m/s: speeds closer than this are a tie (both decide, the earlier hit stands)
  HOP: 80 / 3.6,          // m/s of closing speed from which a hit lifts the cars
  HOP_VY: 1.0, HOP_K: 0.04, HOP_MAX: 2.0,   // upward speed: 1 m/s at HOP, +0.04 per m/s more, at most 2 (≈ 20 cm)
  HOP_DV: 0.4,            // ... and only for a car whose velocity changes by at least HOP_DV × HOP × its share (an off-centre hit's lever takes some: the server checks the same)
  WAIT: 120,              // ms past the round trip a non-judge waits before taking a hit itself
  QUIET: 300,             // ms: one contact. A hit from the other side this soon after we judged is ours already
  SEND_GAP: 100,          // ms between hits sent to one player (a scrape adds its impulses up)
  MAX_DV: 40,             // m/s: no single hit changes a car's velocity by more (a head-on at 2 × 200 km/h)
});

export { carMass };
const clamp = (v, a) => Math.max(-a, Math.min(a, v));
// a car's id: our own car's carId, the other car's car (net.js ghosts), or (a pose) none: the first car
const idOf = o => o.carId ?? o.car;

// The most spin (rad/s) a velocity change of dv (m/s) can give car id: its farthest point
// from the centre (hitbox r) as the lever, the yaw inertia of carImpulse (the server's limit).
export function spinPerDv(id) { const hb = hitbox(id); return hb.r * WALL.YAW_K * 12 / (hb.len * hb.len + hb.wid * hb.wid); }
// The least velocity change (m/s) that comes with a hop for a car of mass m hit by one of mass mOther.
export const hopDv = (m, mOther) => BUMP.HOP_DV * BUMP.HOP * mOther / (m + mOther);

// The overlap of car a and car b ({x, z, h}; ids: their cars, default from a.carId / a.car),
// or null. n points from b to a; (cx, cz): the contact point (the middle of the overlap);
// pen: the overlap's depth along n.
const PA = new Float64Array(64), PB = new Float64Array(64), CO = { px: 0, pz: 0, nx: 0, nz: 0, depth: 0, gap: 0 };
export function contact(a, b, ia = idOf(a), ib = idOf(b)) {
  const A = bodyOf(ia), B = bodyOf(ib), dx = a.x - b.x, dz = a.z - b.z, r = A.r + B.r;
  if (dx * dx + dz * dz >= r * r) return null;
  worldPoly(A.id, a.x, a.z, a.h || 0, PA); worldPoly(B.id, b.x, b.z, b.h || 0, PB);
  if (!polyContact(PA, A.nv, PB, B.nv, CO)) return null;
  return { nx: CO.nx, nz: CO.nz, pen: CO.depth, cx: CO.px, cz: CO.pz };
}
// The gap between the two bodies (m; <= 0: they overlap): a lower bound of their distance
// (the server's check that a hit was possible).
export function gap(a, b, ia = idOf(a), ib = idOf(b)) {
  const A = bodyOf(ia), B = bodyOf(ib);
  worldPoly(A.id, a.x, a.z, a.h || 0, PA); worldPoly(B.id, b.x, b.z, b.h || 0, PB);
  polyContact(PA, A.nv, PB, B.nv, CO);
  return CO.gap;
}

// Who decides this contact: the faster car, the one doing the catching up or the cutting
// in (its speed, not its speed toward the other car: for a glancing hit that swings with a
// few centimetres of position, and each player sees the other car a few centimetres, or a
// metre, elsewhere; a speed is the same in both pictures, the other's as it reported it).
// Within TIE of each other both decide, and the earlier hit stands, the lower sessionId at
// the same moment (receive): still exactly one hit per car. So nobody is left waiting for a
// hit that never comes unless the two pictures differ by more than 2 × TIE (then the one who
// waited a round trip and still touches decides, keepOut).
export function judges(me, other) {
  const mine = Math.hypot(me.vx, me.vz), theirs = Math.hypot(other.rvx ?? other.vx, other.rvz ?? other.vz);
  return mine > theirs - BUMP.TIE;
}

// The hit between car `me` and car `other` at contact C (n from other to me), or null if
// they are already moving apart. mMe, mOther: class masses (core/cars.js); `real`: the most
// closing speed the two cars can really have (their reported speeds; the prediction may
// add to it); ids: their hitboxes (inertia). Returns each car's change: { vx, vz, w (spin),
// vy (upward, 0 below HOP) }, the closing speed and the impulse's normal and tangential
// parts (jn, jt; per unit class mass: the velocity change of a car of mass 1).
const IMP = { jx: 0, jz: 0, jn: 0, jt: 0, closing: 0, kax: 0, kaz: 0, kbx: 0, kbz: 0, iA: 0, iB: 0 };
export function hitImpulse(me, other, C, mMe, mOther, real = Infinity, idMe = idOf(me), idOther = idOf(other)) {
  const bm = bodyOf(idMe), bo = bodyOf(idOther), ma = WALL.KG * mMe, mb = WALL.KG * mOther;
  // (the bodies' inertia is per kg: a car's class mass may differ from its hitbox's body)
  const IA = bm.I / bm.m * ma, IB = bo.I / bo.m * mb;
  if (!carImpulse(me.x, me.z, me.vx, me.vz, me.spinV || 0, ma, IA, other.x, other.z, other.vx, other.vz, other.spinV || 0, mb, IB,
    { px: C.cx, pz: C.cz, nx: C.nx, nz: C.nz }, real, IMP)) return null;
  let Jx = IMP.jx, Jz = IMP.jz;
  // no single hit beyond MAX_DV for the lighter car
  const big = Math.hypot(Jx, Jz) / Math.min(ma, mb);
  if (big > BUMP.MAX_DV) { Jx *= BUMP.MAX_DV / big; Jz *= BUMP.MAX_DV / big; }
  const closing = IMP.closing, kg = WALL.KG;
  const hop = (dv, m, mo) => closing < BUMP.HOP || dv < hopDv(m, mo) ? 0
    : Math.min(BUMP.HOP_MAX, (BUMP.HOP_VY + (closing - BUMP.HOP) * BUMP.HOP_K) * 2 / (1 + m / ((mMe + mOther) / 2)));
  const dA = Math.hypot(Jx, Jz) / ma, dB = Math.hypot(Jx, Jz) / mb;
  // the turn: the impulse's moment (N m s), less what the tyres hold, through the inertia
  const turn = (L, m, i) => { const a = Math.abs(L) - BUMP.YAW_HOLD * m; return a > 0 ? clamp(Math.sign(L) * a * i, BUMP.SPIN) : 0; };
  return {
    closing, jn: IMP.jn / kg, jt: IMP.jt / kg,
    me: { vx: Jx / ma, vz: Jz / ma, w: turn(IMP.kax * Jx + IMP.kaz * Jz, ma, IMP.iA), vy: hop(dA, mMe, mOther) },
    other: { vx: -Jx / mb, vz: -Jz / mb, w: turn(-(IMP.kbx * Jx + IMP.kbz * Jz), mb, IMP.iB), vy: hop(dB, mOther, mMe) },
  };
}

// A car takes a velocity change d (from hitImpulse or a received bump). Spin stays within
// SPIN. The hop: with opts.air (a track map with heights) the car really leaves the road;
// otherwise it is only drawn lifted (lift()).
export function applyHit(car, d, opts = {}) {
  car.vx += d.vx; car.vz += d.vz;
  // stepCar reads vF/vR from vx/vz each step; keep them in step for anything that reads them first
  const fx = Math.sin(car.h), fz = Math.cos(car.h);
  car.vF = car.vx * fx + car.vz * fz; car.vR = car.vx * fz - car.vz * fx;
  car.spinV = clamp((car.spinV || 0) + (d.w || 0), BUMP.SPIN);
  const vy = Math.max(0, Math.min(BUMP.HOP_MAX, d.vy || 0));
  if (vy > 0) {
    if (opts.air && !car.air) { car.air = true; car.vy = Math.max(car.vy || 0, 0) + vy; car.yawRate = (car.yawRate || 0) + (d.w || 0); }
    else if (!opts.air) car.liftV = Math.max(car.liftV || 0, vy);
  }
}

// The drawn-only hop (flat maps, the highway): height above the road, ballistic.
export function lift(car, dt) {
  if (!car.lift && !car.liftV) return 0;
  car.lift = (car.lift || 0) + (car.liftV || 0) * dt - 4.905 * dt * dt; car.liftV = (car.liftV || 0) - 9.81 * dt;
  if (car.lift <= 0) { car.lift = 0; car.liftV = 0; }
  return car.lift;
}

/* The protocol, per opponent: mem holds what this player knows about its contacts with
   one other car. Times in ms (performance clock; tS: the synced server clock, stamped on
   a sent hit so the receiver can line its reaction up with the judge's picture). */
// A contact goes on while the cars touch again within GAP ms; its judge is decided once,
// at its first closing touch (a scrape's normal swings about, and the rule must not flip).
export const GAP = 100;
export const newMem = () => ({ role: null, since: 0, seen: -1e9, judgedAt: -1e9, gotAt: -1e9, sentAt: -1e9, out: null, mine: null });

// One physics substep of contact between my car and the other car g ({x, z, h, vx, vz,
// car: its id; rvx/rvz: its reported velocity, without our local guess of its reaction;
// spinV: the spin of our guess, net.js).
// ctx: { now, tS, mMe, mOther, air }.
// Returns null (no contact), { wait: true } (theirs to decide) or
// { impact, other: the other car's change, push: [dx, dz] the other car's share of the push }.
export function collideStep(car, g, mem, ctx) {
  const C = contact(car, g);
  if (!C) return null;
  if (ctx.now - mem.seen > GAP) { mem.role = null; mem.since = ctx.now; }   // a new contact
  mem.seen = ctx.now;
  const recent = mem.role === 'judge';
  const mine = ctx.mOther / (ctx.mMe + ctx.mOther);
  const rv = { vx: g.rvx ?? g.vx, vz: g.rvz ?? g.vz };
  const real = Math.hypot(car.vx - rv.vx, car.vz - rv.vz);
  const vn = (car.vx - g.vx) * C.nx + (car.vz - g.vz) * C.nz;
  // (?debug=hit: the contact, n into the other car, and how far our car was pushed out)
  const log = p => { if (HITLOG.on) HITLOG.push('car', C.cx, C.cz, -C.nx, -C.nz, -vn, p); };
  if (vn >= 0) {
    // moving apart: only the push out, and only by the side that decided the hit
    if (!recent) { log(0); return { wait: true }; }
    const p = Math.min(BUMP.PUSH, C.pen * mine);
    car.x += C.nx * p; car.z += C.nz * p;
    log(p);
    return { impact: 0, other: null };
  }
  // the other side decided a hit a moment ago: that was this contact
  if (ctx.now - mem.gotAt < BUMP.QUIET) { mem.role = 'wait'; log(0); return { wait: true }; }
  if (!mem.role) { mem.role = judges(car, g) ? 'judge' : 'wait'; mem.since = ctx.now; }
  if (mem.role === 'wait') { log(0); return { wait: true }; }
  const H = hitImpulse(car, g, C, ctx.mMe, ctx.mOther, real);
  if (!H) {
    // the centres still close in, but the hit's spin already parts the contact points: only the push out
    const p = Math.min(BUMP.PUSH, C.pen * mine);
    car.x += C.nx * p; car.z += C.nz * p;
    log(p);
    return { impact: 0, other: null };
  }
  // (no cap per contact any more: each substep's impulse only evens out the closing speed
  // left, so a push hands on the rear car's pull and nothing more. Version 2 capped what
  // one contact gave at its first closing speed: a push ran out after 0.44 s and the cars
  // then moved together on the push out alone, the speedometers 63 and 12 km/h.)
  applyHit(car, H.me, { air: ctx.air });
  // what this contact gave our car, in case the other side decided it first (receive)
  const mn = mem.mine && ctx.now - mem.judgedAt < BUMP.QUIET ? mem.mine : (mem.mine = { t: ctx.tS, vx: 0, vz: 0, w: 0 });
  mn.vx += H.me.vx; mn.vz += H.me.vz; mn.w += H.me.w;
  const p = Math.min(BUMP.PUSH, C.pen * mine);
  car.x += C.nx * p; car.z += C.nz * p;
  log(p);
  const q = Math.min(BUMP.PUSH, C.pen - p);
  mem.judgedAt = ctx.now;
  // the other car's share goes out (added up while the cars scrape, sent every SEND_GAP)
  const o = mem.out || (mem.out = { jx: 0, jz: 0, w: 0, vy: 0, dx: 0, dz: 0, t: ctx.tS });
  o.jx += H.other.vx; o.jz += H.other.vz; o.w = clamp(o.w + H.other.w, BUMP.SPIN); o.vy = Math.max(o.vy, H.other.vy);
  o.dx += -C.nx * q; o.dz += -C.nz * q;
  const pl = Math.hypot(o.dx, o.dz); if (pl > BUMP.PUSH) { o.dx *= BUMP.PUSH / pl; o.dz *= BUMP.PUSH / pl; }
  return { impact: H.closing, other: H.other, push: [-C.nx * q, -C.nz * q] };
}

// While a contact is theirs to decide, the other car is drawn out of ours (net.js passes
// its drawn pose s): the prediction does not know about the hit yet and would drive it on
// into ours. If nothing has come a round trip later and they still touch, the other player
// never saw it: ours to decide (collideStep resolves it in the next substep).
// sid: the other car's id (its hitbox; s is only a pose).
export function keepOut(s, car, mem, now, rtt, sid = s.car) {
  if (mem.role !== 'wait' || now - mem.seen > GAP) return;
  const C = contact(s, car, sid, car.carId); if (!C) return;
  mem.seen = now;
  if (now - mem.since > (rtt || 250) + BUMP.WAIT && now - mem.gotAt > BUMP.QUIET) { mem.role = 'judge'; return; }
  s.x += C.nx * C.pen; s.z += C.nz * C.pen;
}

// The hit to send to the other player now, if any (at most one per SEND_GAP).
export function takeOut(mem, now) {
  if (!mem.out || now - mem.sentAt < BUMP.SEND_GAP) return null;
  const m = mem.out; mem.out = null; mem.sentAt = now;
  return m;
}

// A hit the other player decided arrives. Returns the impact (m/s), 0 if ignored.
// ctx: { now, tS, mMe, mOther, meId, fromId, rtt, air }.
// Both players decided this contact (their pictures differed): the earlier hit stands, the
// lower id on the same moment. Both sides compare the same two stamps, so exactly one hit
// is kept: if it is theirs, ours is taken back off our car (and mem.undone tells net.js to
// stop drawing their car reacting to ours); if it is ours, theirs is ignored here and they
// take theirs back when ours reaches them.
// The reaction is lined up with the judge's picture:
// the judge drew our car reacting from the moment of the hit, a one-way trip ago, so our car
// makes up that distance (car.catchUp), spread over the next CATCH s, never more than PUSH
// per substep.
export const CATCH = 0.15;
export function receive(car, m, mem, ctx) {
  mem.undone = false;
  // their hit left them a one-way trip after ours at the latest: the window takes the round trip
  if (ctx.now - mem.judgedAt < BUMP.QUIET + (ctx.rtt || 0) && mem.mine) {
    const theirsFirst = m.t < mem.mine.t || (m.t === mem.mine.t && String(ctx.fromId) < String(ctx.meId));
    if (!theirsFirst) return 0;                              // ours stands
    car.vx -= mem.mine.vx; car.vz -= mem.mine.vz;
    car.spinV = clamp((car.spinV || 0) - mem.mine.w, BUMP.SPIN);
    mem.mine = null; mem.out = null; mem.undone = true;
  }
  mem.gotAt = ctx.now; mem.role = 'wait'; mem.judgedAt = -1e9;
  const d = { vx: m.jx, vz: m.jz, w: m.w, vy: m.vy };
  applyHit(car, d, { air: ctx.air });
  car.x += m.dx || 0; car.z += m.dz || 0;
  const age = Math.max(0, Math.min(0.25, (ctx.tS - (m.t || ctx.tS)) / 1000));
  if (age > 0) {
    // how far that velocity change would have moved the car by now (its sideways part
    // fades as the tyres grip, see reactionShift)
    const s = reactionShift(car, d, age);              // (the change is already in car's velocity)
    const c = car.catchUp || (car.catchUp = { x: 0, z: 0, h: 0, left: 0 });
    c.x += s.x; c.z += s.z; c.h += s.h; c.left = CATCH;
  }
  const mean = (ctx.mMe + ctx.mOther) / 2;
  return Math.hypot(m.jx, m.jz) * ctx.mMe / mean * 2 / (1 + BUMP.E);
}
// Per substep: the made-up distance of a received hit.
export function catchUp(car, dt) {
  const c = car.catchUp; if (!c || c.left <= 0) return;
  const k = Math.min(1, dt / c.left);
  let x = c.x * k, z = c.z * k; const l = Math.hypot(x, z), h = c.h * k;
  if (l > BUMP.PUSH) { x *= BUMP.PUSH / l; z *= BUMP.PUSH / l; }
  car.x += x; car.z += z; car.h += h; c.x -= x; c.z -= z; c.h -= h; c.left -= dt;
  if (c.left <= 0) car.catchUp = null;          // (a rest over PUSH per substep is dropped, not jumped)
}

// How a velocity change d (and spin d.w) moves a car in `age` s compared with not getting
// it: two copies of the car driven on by the real stepCar, one with the change, one
// without, on the throttle (as a racing player mostly is). The tyres take the sideways
// part, some of it carries on forward, the spin turns it: as their own physics will.
const GAS = { up: 1, down: 0, left: 0, right: 0, hb: 0 }, SUB = 1000 / 120;
function twin(c, spec, vx, vz, w) { return { x: 0, z: 0, h: c.h, vx, vz, vF: 0, vR: 0, steer: 0, spinV: w, off: false, spec }; }
function pair(c, spec, vx0, vz0, d, t) {
  return { a: twin(c, spec, vx0 + d.vx, vz0 + d.vz, d.w || 0), b: twin(c, spec, vx0, vz0, 0), simT: t };
}
function advance(P, t) { while (P.simT + SUB <= t) { stepCar(P.a, GAS, SUB / 1000); stepCar(P.b, GAS, SUB / 1000); P.simT += SUB; } }
function apart(P, t) {
  advance(P, t);
  const e = (t - P.simT) / 1000, a = P.a, b = P.b;
  return { x: a.x - b.x + (a.vx - b.vx) * e, z: a.z - b.z + (a.vz - b.vz) * e, h: a.h - b.h, vx: a.vx - b.vx, vz: a.vz - b.vz, w: a.spinV - b.spinV };
}
export function reactionShift(car, d, age) {
  return apart(pair(car, car.spec, car.vx - d.vx, car.vz - d.vz, d, 0), age * 1000);
}

/* Our picture of the other car reacting to a hit we decided (the kick), drawn until its own
   updates show the reaction: the same model as reactionShift (the sideways part fades as
   its tyres grip), its spin fading as stepCar's does (2.5/s), its hop drawn.

   Their reaction starts a one-way trip after ours, and their car then makes up that
   distance over CATCH s (receive, catchUp). So once their updates show the hit (kickSeen),
   the kick turns into the part of that make-up their latest update does not have yet (the
   rest), and ends when it is all in. A kick is { run, rest, vy, hy }:
   - run: the reaction we draw ourselves, from hit time t0 (a scrape's later impulses add to
     it: the sum of their velocity changes dvx/dvz and of the pushes px/pz stay with it, so
     their updates are still recognised and lined up as one reaction);
   - rest: { D, ta }, what is still to come in their updates after the one stamped ta.
   The drawn picture only changes when an update arrives (net.js takes any difference into
   its smoothing there) or by a hit's own velocity change: nothing jumps on the way. */
// g: the other car as we draw it ({ x, z, h, vx, vz: with our running kick, rvx, rvz: as
// reported, car: its id}), d its velocity change, push its share of the push.
export function kickStart(K, g, d, push, tS) {
  const R = K && K.run, P = R ? runAt(R, tS) : { x: 0, z: 0, h: 0, vx: 0, vz: 0, w: 0 };
  const px = push ? push[0] : 0, pz = push ? push[1] : 0, spec = carById(g.car).stats;
  const rvx = g.rvx ?? g.vx - P.vx, rvz = g.rvz ?? g.vz - P.vz;
  // two copies from here: theirs as reported, and with every kick of this contact so far plus this one
  const tw = pair(g, spec, rvx, rvz, { vx: P.vx + d.vx, vz: P.vz + d.vz, w: clamp(P.w + (d.w || 0), BUMP.SPIN) }, tS);
  const run = { t0: R ? R.t0 : tS, tw, tw0: { a: { ...tw.a }, b: { ...tw.b }, simT: tw.simT }, bx: P.x + px, bz: P.z + pz, bh: P.h,
    px: (R ? R.px : 0) + px, pz: (R ? R.pz : 0) + pz,              // the pushes: theirs at once, not a reaction
    dvx: (R ? R.dvx : 0) + d.vx, dvz: (R ? R.dvz : 0) + d.vz };
  const up = K && K.vy > (d.vy || 0) && hopLeft(K, tS);
  return { run, rest: K ? K.rest : null, vy: up ? K.vy : (d.vy || 0), hy: up ? K.hy : tS };
}
// (the twins only run forward: a moment before the latest asked for, from a fresh copy)
function runAt(R, tS) {
  let tw = R.tw;
  if (tS < tw.simT) tw = { a: { ...R.tw0.a }, b: { ...R.tw0.b }, simT: R.tw0.simT };
  const q = apart(tw, Math.max(tS, tw.simT));
  return { x: R.bx + q.x, z: R.bz + q.z, h: R.bh + q.h, vx: q.vx, vz: q.vz, w: q.w };
}
// what of the make-up their update stamped s1t has not got yet (it is coming: drawn as done)
const restLeft = (r, s1t) => 1 - Math.min(1, Math.max(0, (s1t - r.ta) / (CATCH * 1000)));
const hopLeft = (K, tS) => K.vy > 0 && tS - K.hy < 2000 * K.vy / 9.81;
// The kick at server time tS, for a prediction made from their update stamped s1t:
// displacement (x, z, h), velocity (vx, vz, w) and the drawn hop (y).
export function kickAt(K, tS, s1t) {
  const o = { x: 0, z: 0, h: 0, vx: 0, vz: 0, w: 0, y: 0 };
  if (!K) return o;
  if (K.run) Object.assign(o, runAt(K.run, tS));
  if (K.rest) { const u = restLeft(K.rest, s1t ?? tS); o.x += K.rest.D.x * u; o.z += K.rest.D.z * u; o.h += K.rest.D.h * u; }
  const ay = Math.max(0, (tS - K.hy) / 1000); o.y = K.vy ? Math.max(0, K.vy * ay - 4.905 * ay * ay) : 0;
  return o;
}
// Has their update s1 got the reaction to the running kick in it? Its velocity jumped from
// the update before (s0: the one we drew from last, not the one before it in the buffer:
// two updates may come in one patch, both after the hit) by about the hit's change (a car's
// own driving changes it by ~1 m/s per update at most).
export function kickSeen(K, s0, s1) {
  const R = K && K.run;
  if (!R || !s0 || s1.t <= R.t0) return false;
  const dd = R.dvx * R.dvx + R.dvz * R.dvz; if (dd < 4) return false;
  return (s1.vx - s0.vx) * R.dvx + (s1.vz - s0.vz) * R.dvz >= 0.5 * dd;
}
// A new update s1 (after s0) arrived: the kick from now on (null: over).
export function kickUpdate(K, s0, s1, rtt) {
  if (!K) return null;
  let { run, rest } = K;
  if (rest && restLeft(rest, s1.t) <= 0) rest = null;
  if (run && kickSeen(K, s0, s1)) {
    // the run up to this update, less the pushes (they applied those at once), is what
    // their car makes up from here; an older rest still to come goes with it
    const k = runAt(run, s1.t), D = { x: k.x - run.px, z: k.z - run.pz, h: k.h };
    if (rest) { const u = restLeft(rest, s1.t); D.x += rest.D.x * u; D.z += rest.D.z * u; D.h += rest.D.h * u; }
    rest = { D, ta: s1.t }; run = null;
  } else if (run && s1.t > run.t0 + (rtt || 250) + 150) run = null;   // a small one that never showed
  if (!run && !rest && !hopLeft(K, s1.t)) return null;
  return { run, rest, vy: K.vy, hy: K.hy };
}
