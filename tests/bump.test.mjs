// Car-to-car hits (net/bump.js, stage 8): the maths of one hit, who decides it and how the
// other player gets it, and the hitter's picture of the hit car with 150 ms between them.
// (The full two-player scenario, with rear-end, side and corner hits at 60-180 km/h, is in
// the stage 8 report; tests/sync/sync-check.mjs measures a hit in the browser.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepCar } from '../public/js/core/physics.js';
import { CARS, carMass as massOf } from '../public/js/core/cars.js';
import { BUMP, contact, gap, judges, hitImpulse, applyHit, lift, newMem, collideStep, takeOut, receive, catchUp, keepOut,
  kickStart, kickAt, kickUpdate, carMass, spinPerDv, hopDv } from '../public/js/net/bump.js';
import { carRestitution, CAR, WALL } from '../public/js/core/contact.js';
import { hitbox } from '../public/js/core/hitboxes.js';

const car = (x, z, h, v, extra = {}) => ({ x, z, h, vx: Math.sin(h) * v, vz: Math.cos(h) * v, vF: v, vR: 0, steer: 0, spinV: 0, off: false, ...extra });
const ctx = (o = {}) => ({ now: 1000, tS: 1000, meId: 'a', otherId: 'b', mMe: 1, mOther: 1, rtt: 150, air: false, ...o });
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('class masses: 0.9-1.15, sedans and the muscle car heavier, the RX-7 lighter', () => {
  for (const c of CARS) assert.ok(c.mass >= 0.9 && c.mass <= 1.15, `${c.id}: ${c.mass}`);
  assert.equal(carMass('coupe'), 1);
  for (const id of ['sedan', 'nexus', 'muscle']) assert.ok(carMass(id) > 1, id);
  assert.ok(carMass('rx7') < 1);
  assert.equal(carMass('nope'), massOf('coupe'), 'an unknown car weighs as the first car');
});

test('one hit: momentum kept, restitution by how hard (none below 10 km/h, at most 0.05), no impulse when moving apart, hop only from 80 km/h', () => {
  for (const [mA, mB] of [[1, 1], [0.9, 1.15], [1.12, 0.95]]) for (const closing of [5, 15, 30, 50]) {
    // A runs into the back of B (B ahead along +z)
    const A = car(0, 0, 0, 20 + closing), B = car(0, 4.2, 0, 20);
    const C = contact(A, B); assert.ok(C, 'touching');
    const H = hitImpulse(A, B, C, mA, mB);
    near(mA * H.me.vz + mB * H.other.vz, 0, 1e-9, 'momentum along z');
    near(mA * H.me.vx + mB * H.other.vx, 0, 1e-9, 'momentum along x');
    const after = (A.vz + H.me.vz) - (B.vz + H.other.vz);
    assert.equal(C.nz, -1, 'nose to tail: the normal straight along the cars');
    if (closing * (1 + BUMP.E) * Math.min(mA, mB) / (mA + mB) * Math.max(mA, mB) < BUMP.MAX_DV)
      near(after, -carRestitution(closing) * closing * -C.nz, 1e-6, `restitution at ${closing} m/s`);
    near(H.me.vx, 0, 1e-9, 'nothing sideways'); near(H.me.w, 0, 1e-9, 'no spin');
    assert.equal(H.me.vy > 0, closing >= BUMP.HOP, `hop at ${closing} m/s`);
    assert.ok(H.me.vy <= BUMP.HOP_MAX && H.other.vy <= BUMP.HOP_MAX);
  }
  // moving apart: nothing
  assert.equal(hitImpulse(car(0, 0, 0, 10), car(0, 4.2, 0, 20), contact(car(0, 0, 0, 10), car(0, 4.2, 0, 20)), 1, 1), null);
  // the closing speed is capped by what the cars really do
  const A = car(0, 0, 0, 40), B = car(0, 4.2, 0, 0);
  const H = hitImpulse(A, B, contact(A, B), 1, 1, 10);
  near(H.closing, 10, 1e-9, 'capped closing'); near(-H.me.vz, (1 + carRestitution(10)) * 10 / 2, 1e-9, 'impulse from the capped closing');
  assert.equal(carRestitution(10 / 3.6 - 1e-6), 0, 'below 10 km/h: no bounce'); near(carRestitution(200 / 3.6), CAR.E_MAX, 1e-12, 'at most E_MAX');
  assert.equal(BUMP.E, CAR.E_MAX); assert.equal(BUMP.MU, WALL.MU, 'friction: the wall\'s');
});

test('contact between the hitboxes: the real body, not two circles', () => {
  const hb = hitbox('coupe');
  // nose to tail, 0.3 m off the line (the flat of the nose on the flat of the tail): still
  // along the cars (two circles slanted it 8°); the rounded corners only meet further off
  const A = car(0.3, 0, 0, 30), B = car(0, hb.front + hb.rear - 0.05, 0, 0);
  const C = contact(A, B);
  assert.ok(C, 'touching'); near(C.nz, -1, 1e-9, 'normal along the cars'); near(C.nx, 0, 1e-9, 'not sideways');
  near(C.pen, 0.05, 1e-9, 'depth: the overlap');
  assert.ok(C.cx > 0.03 && C.cx < 0.51, `contact point in the overlap (x ${C.cx.toFixed(2)})`);
  const F = contact(car(1, 0, 0, 30), B);
  assert.ok(F.nz < -0.9 && F.nx > 0, `1 m off: corner on corner, slanted a little toward A (n ${F.nx.toFixed(2)}, ${F.nz.toFixed(2)})`);
  // side by side 2 cm apart: no contact (the circles of version 2 touched up to 2.1 m apart)
  const S = car(hb.right + hb.left + 0.02, 0, 0, 0);
  assert.equal(contact(car(0, 0, 0, 0), S), null); near(gap(car(0, 0, 0, 0), S), 0.02, 1e-5, 'gap: 2 cm');
  // side by side overlapping 3 cm: pushed apart sideways
  const T = car(hb.right + hb.left - 0.03, 0, 0, 0), D = contact(car(0, 0, 0, 0), T);
  near(D.nx, -1, 1e-3, 'out of the other car'); near(D.pen, 0.03, 2e-3, 'by the overlap');
  // a different car: its own hitbox
  const R = hitbox('rally');
  assert.ok(contact({ x: 0, z: 0, h: 0, carId: 'rally' }, { x: R.right + hb.left - 0.01, z: 0, h: 0, carId: 'coupe' }), 'the wide rally car touches');
  assert.equal(contact({ x: 0, z: 0, h: 0, carId: 'coupe' }, { x: R.right + hb.left - 0.01, z: 0, h: 0, carId: 'coupe' }), null, 'two coupes do not');
});

test('rear-end at 180 km/h into a stopped car of the same mass: both near the common speed, nothing sideways', () => {
  const hb = hitbox('coupe'), A = car(0, 0, 0, 50), B = car(0, hb.front + hb.rear - 0.1, 0, 0);
  const H = hitImpulse(A, B, contact(A, B), 1, 1);
  const a = (A.vz + H.me.vz) * 3.6, b = (B.vz + H.other.vz) * 3.6;
  assert.ok(a >= 84 && a <= 90 && b >= 90 && b <= 96, `after: ${a.toFixed(1)} and ${b.toFixed(1)} km/h`);
  near(H.me.vx + H.other.vx, 0, 1e-12, 'momentum'); near(H.other.vx, 0, 1e-9, 'not sideways');
});

test('a side swipe rubs: friction up to MU of the normal impulse evens out the sideways speeds; spin within SPIN', () => {
  // A passes B fast, its right side drifting into B's left side
  const A = car(-1.84, 0.3, 0, 50), B = car(0, 0, 0, 20); A.vx = 3;
  const C = contact(A, B); assert.ok(C);
  const H = hitImpulse(A, B, C, 1, 1);
  const tx = -C.nz, tz = C.nx;
  const vt0 = (A.vx - B.vx) * tx + (A.vz - B.vz) * tz, vt1 = (A.vx + H.me.vx - B.vx - H.other.vx) * tx + (A.vz + H.me.vz - B.vz - H.other.vz) * tz;
  assert.ok(Math.abs(vt1) < Math.abs(vt0), 'the sliding speed along the contact drops');
  assert.ok(Math.abs(H.jt) <= BUMP.MU * H.jn + 1e-12, 'friction within MU × normal');
  near(Math.abs(H.jt), BUMP.MU * H.jn, 1e-9, 'a fast swipe slides at the friction limit');
  const vn1 = (A.vx + H.me.vx - B.vx - H.other.vx) * C.nx + (A.vz + H.me.vz - B.vz - H.other.vz) * C.nz;
  // the normal part: they part at the restitution's share of the closing speed (the
  // contact point's: the spins count), not bounce
  const vn1p = vn1 + (H.me.w * (C.cz - A.z) * C.nx - H.me.w * (C.cx - A.x) * C.nz) - (H.other.w * (C.cz - B.z) * C.nx - H.other.w * (C.cx - B.x) * C.nz);
  // (the tyres hold a little of the turn, BUMP.YAW_HOLD: the points may still close a little, the next substep's impulse takes that)
  assert.ok(vn1p >= -0.02 * H.closing && vn1p <= CAR.E_MAX * H.closing + 1e-9, `the points part slowly: ${vn1p}`);
  // spin: within SPIN whatever the lever, also added up over many hits
  const c = car(0, 0, 0, 30);
  for (let i = 0; i < 20; i++) applyHit(c, { vx: 0, vz: 0, w: 1.5 });
  assert.equal(c.spinV, BUMP.SPIN);
  for (const off of [-2, -1, 1, 2]) {
    const a = car(off, -4, 0.6, 50), b = car(0, 0, 0, 0), Cc = contact(a, b);
    if (!Cc) continue;
    const h = hitImpulse(a, b, Cc, 0.9, 1.15);
    if (h) assert.ok(Math.abs(h.me.w) <= BUMP.SPIN && Math.abs(h.other.w) <= BUMP.SPIN);
  }
});

test('positional push: at most PUSH per substep, the rest in the next ones', () => {
  const A = car(0, 0, 0, 30), B = car(0, 2.4, 0, 0);       // 2 m deep
  const mem = newMem(), g = { ...B, rvx: B.vx, rvz: B.vz };
  const x0 = A.x, z0 = A.z;
  const r = collideStep(A, g, mem, ctx());
  assert.ok(r && r.other, 'A decides (faster)');
  assert.ok(Math.hypot(A.x - x0, A.z - z0) <= BUMP.PUSH + 1e-12, 'pushed at most PUSH');
  assert.ok(Math.hypot(...r.push) <= BUMP.PUSH + 1e-12, 'and the other car at most PUSH');
  const out = takeOut(mem, 1000); assert.ok(out);
  assert.ok(Math.hypot(out.dx, out.dz) <= BUMP.PUSH + 1e-12);
  // next substeps: moving apart now, the overlap comes out PUSH at a time
  for (let i = 1; i < 6; i++) { const z = A.z; collideStep(A, g, mem, ctx({ now: 1000 + i * 8 })); assert.ok(z - A.z <= BUMP.PUSH + 1e-12); }
});

test('the faster car decides; within TIE both do, and the earlier hit stands: one impulse per car', () => {
  const A = car(0, 0, 0, 40), B = car(0, 4.2, 0, 20);
  assert.equal(judges(A, B), true); assert.equal(judges(B, A), false);
  assert.equal(judges(car(0, 0, 0, 20), car(0, 4, 0, 21)), true, 'a tie: both');
  assert.equal(judges(car(0, 0, 0, 21), car(0, 4, 0, 20)), true, 'a tie: both');

  // A decides, B waits and gets A's hit, once
  {
    const a = car(0, 0, 0, 40), b = car(0, 4.2, 0, 20), ma = newMem(), mb = newMem();
    const ra = collideStep(a, { ...b }, ma, ctx({ meId: 'a', otherId: 'b' }));
    assert.ok(ra.other);
    const rb = collideStep(b, { ...a, vz: 40 }, mb, ctx({ meId: 'b', otherId: 'a' }));
    assert.ok(rb.wait, 'B waits for A');
    const bv = b.vz, m = takeOut(ma, 1000);
    for (let i = 0; i < 5; i++) collideStep(b, { ...a, vz: 40 }, mb, ctx({ now: 1010 + i * 8, meId: 'b', otherId: 'a' }));
    assert.equal(b.vz, bv, 'B never resolves it itself while waiting');
    receive(b, m, mb, ctx({ now: 1150, tS: 1150, meId: 'b', fromId: 'a' }));
    near(b.vz - bv, ra.other.vz, 1e-9, 'B takes exactly A\'s share');
    for (let i = 0; i < 10; i++) collideStep(b, { ...a, vz: 40 }, mb, ctx({ now: 1170 + i * 8, meId: 'b', otherId: 'a' }));
    near(b.vz - bv, ra.other.vz, 1e-9, 'and B adds nothing of its own afterwards');
  }
  // both decide (a tie): each car ends with exactly the earlier hit
  {
    const a = car(0, 0, 0, 21), b = car(0, 4.2, 0, 20), ma = newMem(), mb = newMem();
    const a0 = { vx: a.vx, vz: a.vz }, b0 = { vx: b.vx, vz: b.vz };
    const ra = collideStep(a, { ...b }, ma, ctx({ now: 1000, tS: 1000, meId: 'a', otherId: 'b' }));       // A first
    const rb = collideStep(b, { ...a0, x: 0, z: 0, h: 0 }, mb, ctx({ now: 1020, tS: 1020, meId: 'b', otherId: 'a' }));
    assert.ok(ra.other && rb.other, 'both decided');
    const fa = takeOut(ma, 1000), fb = takeOut(mb, 1020);
    receive(a, fb, ma, ctx({ now: 1170, tS: 1170, meId: 'a', fromId: 'b' }));      // later than A's own: ignored
    receive(b, fa, mb, ctx({ now: 1150, tS: 1150, meId: 'b', fromId: 'a' }));      // earlier: B takes its own back
    assert.equal(mb.undone, true); assert.equal(!!ma.undone, false);
    near(a.vz - a0.vz, ra.other.vz * -1, 1e-9, 'A: its own hit');
    near(b.vz - b0.vz, ra.other.vz, 1e-9, 'B: A\'s hit, its own taken back');
  }
});

test('received hit: lined up with the judge\'s picture, at most PUSH per substep', () => {
  const b = car(0, 0, 0, 20), mem = newMem();
  receive(b, { jx: 0, jz: 10, w: 0, vy: 0, dx: 0, dz: 0, t: 850 }, mem, ctx({ now: 1000, tS: 1000, meId: 'b', fromId: 'a' }));
  assert.ok(b.catchUp, 'a hit 150 ms old is made up');
  // 10 m/s along the car for 0.15 s, a little less on the throttle at the higher speed
  const want = b.catchUp.z;
  assert.ok(want > 1.35 && want <= 1.5, `made up ${want.toFixed(3)} m`);
  const z0 = b.z; let worst = 0;
  for (let i = 0; i < 40; i++) { const z = b.z; catchUp(b, 1 / 120); worst = Math.max(worst, b.z - z); }
  near(b.z - z0, want, 1e-6, 'all of it'); assert.ok(worst <= BUMP.PUSH);
  assert.equal(b.catchUp, null);
});

test('hop: a strong hit lifts the car a moment (real on maps with heights, drawn elsewhere), a light one does not', () => {
  const c = car(0, 0, 0, 30);
  applyHit(c, { vx: 0, vz: -5, w: 0, vy: 0 }); assert.ok(!c.air && !c.liftV, 'no hop without vy');
  applyHit(c, { vx: 0, vz: -5, w: 0, vy: 1.6 }, { air: true }); assert.equal(c.air, true); assert.ok(c.vy > 1.5);
  const d = car(0, 0, 0, 30); applyHit(d, { vx: 0, vz: -5, w: 0, vy: 1.6 });
  assert.ok(!d.air, 'flat map: never airborne');
  let top = 0, t = 0; while (t < 1) { top = Math.max(top, lift(d, 1 / 60)); t += 1 / 60; }
  near(top, 1.6 * 1.6 / 2 / 9.81, 0.02, 'drawn hop height'); assert.equal(lift(d, 1 / 60), 0, 'and back on the road');
  const A = car(0, 0, 0, 20 + 21), B = car(0, 4.2, 0, 20);
  assert.equal(hitImpulse(A, B, contact(A, B), 1, 1).me.vy, 0, '75 km/h: no hop');
});

test('the hitter\'s picture of the hit car: no jump when its real position arrives', () => {
  // B, the hit car, on its own computer: on the throttle (the real stepCar); A's hit (12 m/s
  // forward, decided by A at t = 0) reaches it 150 ms later and is made up there (receive,
  // catchUp). A draws B: B's newest update (sent every 33 ms, 150 ms on the way) moved on by
  // its velocity, plus A's kick, with net.js's smoothing of each new update.
  const dv = 12, arrive = 150, GAS = { up: 1, down: 0, left: 0, right: 0, hb: 0 };
  const B = car(0, 0, 0, 20, { spec: CARS[0].stats }), mem = newMem(), sent = [];
  let K = kickStart(null, { x: 0, z: 0, h: 0, vx: 0, vz: 20, rvx: 0, rvz: 20, car: 'coupe' }, { vx: 0, vz: dv, w: 0, vy: 0 }, null, 0, 0);
  let prev = null, prev2 = null, worst = 0, off = 0, s1 = null, last = null, got = false;
  for (let k = 0; k < 120 * 0.9; k++) {
    const t = k * 1000 / 120;
    if (!got && t >= arrive) { receive(B, { jx: 0, jz: dv, w: 0, vy: 0, dx: 0, dz: 0, t: 0 }, mem, ctx({ now: t, tS: t, meId: 'b', fromId: 'a' })); got = true; }
    stepCar(B, GAS, 1 / 120); catchUp(B, 1 / 120);
    if (k % 4 === 0) sent.push({ t, vx: B.vx, vz: B.vz, z: B.z });
    if (k % 2) continue;                                           // A draws at 60 fps
    const inn = sent.filter(u => u.t <= t - 150); if (!inn.length) continue;
    const n = inn.at(-1);
    if (n !== s1) { s1 = n; }
    const pred = (s, kk) => s.z + s.vz * (t - s.t) / 1000 + kickAt(kk, t, s.t).z;
    if (last && last !== s1) { const O = pred(last, K); K = kickUpdate(K, last, s1, 150); off += O - pred(s1, K); }
    last = s1; off *= Math.exp(-10 / 60);
    const drawn = pred(s1, K) + off;
    if (prev2 !== null) worst = Math.max(worst, Math.abs(drawn - 2 * prev + prev2));
    prev2 = prev; prev = drawn;
  }
  // the hit itself changes the drawn speed by dv: dv / 60 in one frame; anything else is a jump
  assert.ok(worst < dv / 60 + 0.05, `largest jump ${worst.toFixed(3)} m per frame`);
  assert.equal(K, null, 'the kick is over once the updates have all of the reaction');
  near(prev, B.z, 0.8, 'and A draws B where it really is');
});

test('keepOut: while waiting, the other car is drawn against ours, not inside it; after a round trip it is ours to decide', () => {
  const me = car(0, 0, 0, 10), mem = newMem();
  mem.role = 'wait'; mem.since = 1000; mem.seen = 1000;
  const s = { x: 0, z: 3.5, h: 0 };
  keepOut(s, me, mem, 1050, 150);
  assert.equal(contact(s, me), null, 'no overlap drawn');
  for (let t = 1066; t < 1000 + 150 + BUMP.WAIT + 20; t += 16) { const s2 = { x: 0, z: 3.5, h: 0 }; keepOut(s2, me, mem, t, 150); }
  assert.equal(mem.role, 'judge', 'nothing came a round trip later and they still touch: ours');
});

test('a slow push rams: at 20 km/h the rear car pushes the front one, both move as one, nothing sideways', () => {
  // both cars on one computer (as tests/sync/walls): A decides, B takes its share at once
  const GAS = { up: 1, down: 0, left: 0, right: 0, hb: 0 }, NONE = { up: 0, down: 0, left: 0, right: 0, hb: 0 };
  const hb = hitbox('coupe');
  for (const off of [0, 0.4]) {
    const A = car(off, 0, 0, 20 / 3.6, { spec: CARS[0].stats, carId: 'coupe' }), B = car(0, hb.front + hb.rear + 0.05, 0, 0, { spec: CARS[0].stats, carId: 'coupe' });
    const mem = newMem();
    for (let k = 0; k < 120; k++) {
      stepCar(A, GAS, 1 / 120); stepCar(B, NONE, 1 / 120);
      const r = collideStep(A, B, mem, ctx({ now: k * 1000 / 120, tS: k * 1000 / 120 }));
      if (r && r.other) { applyHit(B, r.other); B.x += r.push[0]; B.z += r.push[1]; }
    }
    const vA = Math.hypot(A.vx, A.vz) * 3.6, vB = Math.hypot(B.vx, B.vz) * 3.6;
    assert.ok(Math.abs(vA - vB) < 1.5, `${off} m off: together (${vA.toFixed(1)} / ${vB.toFixed(1)} km/h)`);
    assert.ok(vB > 30, `the push carries the front car on (${vB.toFixed(1)} km/h)`);
    if (!off) assert.ok(Math.abs(B.x) < 0.01 && Math.abs(A.x) < 0.01 && Math.abs(B.h) < 1e-6, `straight: nothing sideways (B ${B.x.toFixed(3)}, A ${A.x.toFixed(3)} m)`);
    // off the line, the first touch (a 20 km/h bump) turns the front car a little (struck at
    // its tail's right, it turns left; the push after it does not: the tyres hold its small
    // impulses), but nobody slides off: the pusher goes straight on, its nose on the tail
    else assert.ok(Math.abs(B.h) < 0.14 && Math.abs(A.x - off) < 0.05 && B.z - A.z - (hb.front + hb.rear) < 0.1,
      `${off} m off: B turned ${(B.h * 180 / Math.PI).toFixed(1)}°, A ${(A.x - B.x).toFixed(2)} m off B's line`);
    assert.ok(B.z - A.z - (hb.front + hb.rear) > -0.02, 'not inside each other');
  }
});

test('the server\'s limits for spin and hop follow the game\'s hit', () => {
  // any hit's spin is within spinPerDv × the velocity change of the hit car (+ its clamp)
  for (const [ia, ib] of [['coupe', 'coupe'], ['muscle', 'rx7'], ['rally', 'super']]) for (const off of [-1.5, -0.7, 0, 0.7, 1.5]) for (const ang of [0, 0.4, 1.2]) {
    const A = { ...car(off, -4.3, ang, 40), carId: ia }, B = { ...car(0, 0, 0, 5), carId: ib }, C = contact(A, B);
    if (!C) continue;
    const H = hitImpulse(A, B, C, carMass(ia), carMass(ib)); if (!H) continue;
    const dv = Math.hypot(H.other.vx, H.other.vz);
    assert.ok(Math.abs(H.other.w) <= Math.min(BUMP.SPIN, spinPerDv(ib) * dv) + 1e-9, `${ia}->${ib} ${off} ${ang}: spin ${H.other.w.toFixed(2)} for ${dv.toFixed(2)} m/s`);
    if (H.other.vy > 0) assert.ok(dv >= hopDv(carMass(ib), carMass(ia)) && H.closing >= BUMP.HOP, 'a hop only with its hit');
  }
});
