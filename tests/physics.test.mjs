// Golden test: the car physics must match its recording bit for bit.
// Physics version 2 (core/physics.js) is recorded in fixtures/physics-golden-v2.json by
// tests/tools/make-golden-v2.mjs. Version 1 — the original single-file game, commit
// 06ee674 — is kept in fixtures/physics-golden.json (tests/tools/make-golden.mjs).
// If the golden test fails, the car no longer drives the same.
// Re-recorded once in track engine v2 (stage 4), physics unchanged: the old recording had
// been made with Node 20, whose Math.pow gave 4 of the track's 13 centripetal knot
// spacings one ulp off; Node 24+ round them differently, so every track point moved by
// ~1e-15 m and the test failed from second 0. The track curve now computes (d²)^0.25
// correctly rounded (modes/track/curve.js), the same bits on any engine. Proof that the
// car drives the same: the Node 20 track points fed to today's code reproduce the old
// recording exactly on Node 20, 24 and 26; the new recording ends 5e-12 m from the old
// one after 3 minutes, with the same laps and wall hits.
// Re-recorded once more in plan 3 stage 3 (24.11), stepCar unchanged: the walls became the
// car's hitbox against the drawn walls with an impulse (core/contact.js). Driving the old
// recording's run with the old code and applying the new code's step to the same state at
// every substep, the two differ on 821 of 17574 substeps, every one of them a wall contact
// (470 by the old centre check, 754 by the new hitbox; 0 differences without a contact; the
// first at 32.7 s). The new recording: the same 8787 frames and 3 laps, 33 wall hits (17
// before: the body touches where the centre point did not). Table: docs/baseline-3.md.
// The tests after it check what version 2 changed on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { run } from './harness.mjs';

globalThis.THREE = createRequire(import.meta.url)('three');
const { stepCar, DRAFT_ACC } = await import('../public/js/core/physics.js');
const T = await import('../public/js/modes/track/geometry.js');

const golden = JSON.parse(readFileSync(new URL('./fixtures/physics-golden-v2.json', import.meta.url), 'utf8'));

test('track physics matches the version 2 recording bit for bit', () => {
  const events = [];
  const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,pitch:0,spinV:0,lastMark:[null,null]};
  const hooks = { onWall: p => events.push(['wall', p]), onLap: () => events.push(['lap']) };
  const res = run({
    car, events,
    track: { P: T.P, NM: T.NM, N: T.N, WALL: T.WALL },
    placeGrid: slot => T.placeGrid(car, slot),
    step: (dt, input) => { stepCar(car, input, dt); T.constrainToTrack(car, dt, hooks); },
  });
  const firstBad = res.perSecond.findIndex((h, i) => h !== golden.perSecond[i]);
  assert.equal(firstBad, -1, `physics differs from the recording starting at second ${firstBad}`);
  assert.equal(res.frames, golden.frames);
  assert.deepEqual(res.events, golden.events);
  assert.deepEqual(res.final, golden.final);
  assert.equal(res.hash, golden.hash);
});

// Drive for `seconds` with full throttle; steer(t) gives -1, 0 or 1. Returns the average
// speed in km/h over the last 20 s, and the highest.
function drive({ seconds = 60, steer = () => 0, draft = 0, off = false } = {}) {
  const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,off,spinV:0};
  const dt = 1 / 120; let sum = 0, n = 0, top = 0;
  for (let t = 0; t < seconds; t += dt) {
    const s = steer(t);
    stepCar(car, { up: 1, down: 0, left: s < 0 ? 1 : 0, right: s > 0 ? 1 : 0, hb: 0, draft }, dt);
    const kmh = Math.hypot(car.vx, car.vz) * 3.6; top = Math.max(top, kmh);
    if (t > seconds - 20) { sum += kmh; n++; }
  }
  return { avg: sum / n, top };
}
const weave = period => t => Math.sin(2 * Math.PI * t / period) > 0 ? 1 : -1;

test('driving straight is the fastest: weaving never builds speed', () => {
  const straight = drive().avg;
  assert.ok(straight > 195 && straight < 201, `top speed on a straight ${straight.toFixed(1)} km/h`);
  for (const period of [0.4, 0.6, 1.2, 2.5]) {
    const w = drive({ steer: weave(period) });
    assert.ok(w.top < straight + 0.5, `weaving every ${period} s reached ${w.top.toFixed(1)} km/h`);
    assert.ok(w.avg < straight - 5, `weaving every ${period} s holds ${w.avg.toFixed(1)} km/h vs ${straight.toFixed(1)} straight`);
  }
});

test('a turn at top speed never speeds the car up', () => {
  const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,off:false,spinV:0};
  const dt = 1 / 120;
  for (let t = 0; t < 60; t += dt) stepCar(car, { up: 1, down: 0, left: 0, right: 0, hb: 0 }, dt);
  let last = Math.hypot(car.vx, car.vz);
  for (let t = 0; t < 1.5; t += dt) {                    // flick: right, then left
    stepCar(car, { up: 1, down: 0, left: t > .75 ? 1 : 0, right: t <= .75 ? 1 : 0, hb: 0 }, dt);
    const v = Math.hypot(car.vx, car.vz);
    assert.ok(v <= last + 1e-9, `speed rose in a turn at ${t.toFixed(3)} s`); last = v;
  }
});

// The wall response (plan 3 stage 3, core/contact.js): the car's hitbox against the wall, an
// impulse with its mass and yaw inertia at the contact point. The car coasts into the
// highway's left rail (x = RAIL; the same code answers the drift track's walls), its body 3 cm
// from it; measured from the first contact.
async function railHit(angle, kmh, carId) {
  const H = await import('../public/js/modes/traffic/geometry.js');
  const C = await import('../public/js/core/contact.js');
  const { worldPoly } = await import('../public/js/core/hitboxes.js');
  const v = kmh / 3.6, h = angle * Math.PI / 180, B = C.bodyOf(carId), P = new Float64Array(64), dt = 1 / 120;
  const car = {x:0,z:0,h,vx:v*Math.sin(h),vz:v*Math.cos(h),vF:v,vR:0,steer:0,off:false,spinV:0,carId};
  const right = () => { worldPoly(B.id, car.x, car.z, car.h, P); let m = -Infinity; for (let i = 0; i < 2 * B.nv; i += 2) m = Math.max(m, P[i]); return m; };
  car.x = H.RAIL - right() - .03;
  let t0 = -1, v01 = 0, gap = 0, pen = 0, first = null;
  for (let k = 0; k < 400; k++) {
    const seq = C.LAST.seq, h0 = car.h, x0 = car.z;
    stepCar(car, { up: 0, down: 0, left: 0, right: 0, hb: 0 }, dt); H.constrainToHighway(car, dt, { onWall() {} });
    if (C.LAST.seq !== seq && t0 < 0) { t0 = k; first = { vin: C.LAST.vin, h: h0, z: x0 }; }
    if (t0 < 0) continue;
    const d = k - t0, g = H.RAIL - right(); gap = Math.max(gap, g); pen = Math.max(pen, -g);
    if (d === 12) v01 = Math.hypot(car.vx, car.vz) * 3.6;
    if (d === 60) return { vin: first.vin * 3.6, v01, bounce: gap, pen, turn: (car.h - first.h) * 180 / Math.PI, along: car.z - first.z };
  }
  throw new Error('no contact');
}
// the same car coasting on the shoulder without a wall (the rail stands beyond the shoulder,
// whose drag is part of every rail hit): its speed after 0.1 s
function verge(kmh) {
  const car = {x:0,z:0,h:0,vx:0,vz:kmh/3.6,vF:kmh/3.6,vR:0,steer:0,off:true,spinV:0};
  for (let k = 0; k < 12; k++) { stepCar(car, { up: 0, down: 0, left: 0, right: 0, hb: 0 }, 1 / 120); const f = Math.exp(-.45 / 120); car.vx *= f; car.vz *= f; }
  return Math.hypot(car.vx, car.vz) * 3.6;
}

test('wall: restitution by how hard, mass and yaw inertia from the hitbox', async () => {
  const C = await import('../public/js/core/contact.js');
  const { hitbox } = await import('../public/js/core/hitboxes.js');
  const { carMass } = await import('../public/js/core/cars.js');
  assert.equal(C.restitution(5 / 3.6), 0, 'no bounce at 5 km/h into the wall');
  assert.equal(C.restitution(9.9 / 3.6), 0, 'none below 10 km/h');
  assert.ok(C.restitution(60 / 3.6) > 0 && C.restitution(60 / 3.6) < C.WALL.E_MAX, 'some in between');
  assert.equal(C.restitution(300 / 3.6), .15, 'at most 0.15');
  assert.ok(C.WALL.MU >= .1 && C.WALL.MU <= .3, `wall friction ${C.WALL.MU}`);
  for (const id of ['coupe', 'muscle', 'super']) {
    const B = C.bodyOf(id), hb = hitbox(id);
    assert.equal(B.m, C.WALL.KG * carMass(id));
    assert.ok(Math.abs(B.I - B.m * (hb.len ** 2 + hb.wid ** 2) / 12) < 1e-9, `${id}: I = m (L² + W²) / 12`);
    assert.ok(B.m >= 1200 && B.m <= 1700, `${id}: ${B.m} kg`);
  }
});

test('wall: a straight hit stops the car at the wall, a nose touch does not turn it', async () => {
  const hard = await railHit(90, 90);
  assert.ok(hard.bounce < 1, `90° at 90 km/h: bounced ${hard.bounce.toFixed(2)} m off the rail`);
  assert.ok(Math.abs(hard.turn) < .5 && Math.abs(hard.along) < .05, `90° at 90 km/h: turned ${hard.turn.toFixed(2)}°, moved ${hard.along.toFixed(2)} m along`);
  const nose = await railHit(90, 5);
  assert.ok(nose.bounce < .01, `nose at 5 km/h: ${(nose.bounce * 100).toFixed(1)} cm off the rail`);
  assert.ok(Math.abs(nose.turn) < .1 && Math.abs(nose.along) < .01, `nose at 5 km/h turned the car ${nose.turn.toFixed(2)}° (was 22.5° with wallAlign's atan2(0, 0))`);
  for (const r of [hard, nose]) assert.ok(r.pen < .01, `inside the rail ${(r.pen * 100).toFixed(1)} cm`);
});

test('wall: friction along it, by the angle of the hit', async () => {
  const at45 = await railHit(45, 180), at15 = await railHit(15, 180), ref = verge(180);
  assert.ok(at45.v01 >= 90 && at45.v01 <= 120, `45° at 180 km/h: ${at45.v01.toFixed(0)} km/h after 0.1 s`);
  const loss = 1 - at15.v01 / ref;
  assert.ok(loss >= .03 && loss <= .10, `15° at 180 km/h: ${at15.v01.toFixed(0)} km/h after 0.1 s, ${(loss * 100).toFixed(1)} % less than on the shoulder without the rail (${ref.toFixed(0)})`);
  assert.ok(at15.turn < -10, `a glancing hit turns the nose along the rail (${at15.turn.toFixed(1)}°)`);
});

test('pressed against a rail the car scrapes along it, it does not stop', async () => {
  const H = await import('../public/js/modes/traffic/geometry.js');
  // 180 km/h in the right-hand lane, steer into the rail (right = towards -x). The rail
  // stands at the outer edge of the shoulder, and the shoulder brakes (car.off), so the
  // ride is measured against a car rolling straight down the shoulder without touching it.
  const ride = (holdFor, x = H.laneCenter(3)) => {
    const car = {x,z:0,h:0,vx:0,vz:50,vF:50,vR:0,steer:0,off:false,spinV:0};
    let hits = 0; const hooks = { onWall: () => hits++ }, dt = 1 / 120, kmh = [];
    for (let t = 0; t < 4; t += dt) {
      stepCar(car, { up: 1, down: 0, left: 0, right: t < holdFor ? 1 : 0, hb: 0 }, dt);
      H.constrainToHighway(car, dt, hooks);
      kmh.push(Math.hypot(car.vx, car.vz) * 3.6);
    }
    return { kmh, end: kmh.at(-1), hits, h: car.h };
  };
  const ref = ride(0, -(H.HALF + .4));   // on the shoulder, clear of the rail
  const worst = r => Math.min(...r.kmh.slice(120).map((v, i) => v / ref.kmh[i + 120]));
  const held = ride(3.5);          // holding the steering into the rail the whole time
  assert.ok(worst(held) > .7, `pressed into the rail the car fell to ${(worst(held) * 100).toFixed(0)} % of the shoulder speed`);
  assert.ok(held.hits <= 3, `one hit, then scraping: ${held.hits} hits`);
  // a touch: it straightens up along the rail and drives on (plan 3 stage 3: within 6°, the
  // hit's own turn, where version 2's wallAlign set it exactly parallel)
  const touched = ride(.4);
  assert.ok(touched.end > ref.end * .95 && Math.abs(touched.h) < .1, `after a touch: ${touched.end.toFixed(0)} km/h (shoulder ${ref.end.toFixed(0)}), heading ${touched.h.toFixed(3)}`);
});

test('off the asphalt the throttle keeps 77.5% of its pull', () => {
  const pull = off => { const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,off,spinV:0};
    stepCar(car, { up: 1, down: 0, left: 0, right: 0, hb: 0 }, 1 / 120);   // one step from a standstill
    return car.vz; };
  const r = pull(true) / pull(false);
  assert.ok(Math.abs(r - .775) < .01, `off-road pull ratio ${r.toFixed(3)}`);
});

test('slipstream pushes the car on, and only on the throttle', () => {
  const base = drive().avg, full = drive({ draft: 1 }).avg, half = drive({ draft: .5 }).avg;
  assert.ok(full > 240 && full < 251 && base < 201, `top speed ${base.toFixed(1)} km/h, in a full slipstream ${full.toFixed(1)}`);
  assert.ok(half > base && half < full, 'half the push gives a speed in between');
  const car = {x:0,z:0,h:0,vx:0,vz:20,vF:20,vR:0,steer:0,off:false,spinV:0};
  const ref = {...car};
  stepCar(car, { up: 0, down: 0, left: 0, right: 0, hb: 0, draft: 1 }, .1);
  stepCar(ref, { up: 0, down: 0, left: 0, right: 0, hb: 0 }, .1);
  assert.equal(car.vz, ref.vz, 'coasting gets no push');
  assert.ok(DRAFT_ACC > 0);
});
