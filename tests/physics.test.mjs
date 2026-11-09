// Golden test: the car physics must match its recording bit for bit.
// Physics version 2 (core/physics.js) is recorded in fixtures/physics-golden-v2.json by
// tests/tools/make-golden-v2.mjs. Version 1 — the original single-file game, commit
// 06ee674 — is kept in fixtures/physics-golden.json (tests/tools/make-golden.mjs).
// If the golden test fails, the car no longer drives the same.
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

test('pressed against a rail the car scrapes along it, it does not stop', async () => {
  const { wallKeep } = await import('../public/js/core/physics.js');
  const H = await import('../public/js/modes/traffic/geometry.js');
  assert.ok(wallKeep(.5) >= .99 && wallKeep(5) === .9 && wallKeep(20) === .9, 'a glancing touch costs ~1 %, a hard hit 10 %');
  // 180 km/h in the right-hand lane, steer into the rail (right = towards -x)
  const ride = holdFor => {
    const car = {x:H.laneCenter(3),z:0,h:0,vx:0,vz:50,vF:50,vR:0,steer:0,off:false,spinV:0};
    let hits = 0; const hooks = { onWall: () => hits++ }, dt = 1 / 120, kmh = [];
    for (let t = 0; t < 4; t += dt) {
      stepCar(car, { up: 1, down: 0, left: 0, right: t < holdFor ? 1 : 0, hb: 0 }, dt);
      H.constrainToHighway(car, dt, hooks);
      kmh.push(Math.hypot(car.vx, car.vz) * 3.6);
    }
    return { min: Math.min(...kmh.slice(120)), end: kmh.at(-1), hits, h: car.h };
  };
  const held = ride(3.5);          // holding the steering into the rail the whole time
  assert.ok(held.min > 100, `pressed into the rail the car dropped to ${held.min.toFixed(0)} km/h`);
  assert.ok(held.hits <= 3, `one hit, then scraping: ${held.hits} hits`);
  const touched = ride(.4);        // a touch: it straightens up along the rail and drives on
  assert.ok(touched.end > 175 && Math.abs(touched.h) < .02, `after a touch: ${touched.end.toFixed(0)} km/h, heading ${touched.h.toFixed(3)}`);
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
