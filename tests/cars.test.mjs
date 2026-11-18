// The car picker's cars (public/js/core/cars.js): the base car drives exactly like the
// game always did, and no car is simply the best.
//
// Balance is checked the way a good driver would find it: an autopilot drives two laps
// of the drift track with many different styles (how hard it takes the corners, how far
// ahead it looks), and each car's best clean lap (no wall touched) counts. The cars'
// best laps must stay within 2 % of each other. On the highway the top speeds, pull,
// brakes and a lane change are measured, and every car must pay for what it is good at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { run } from './harness.mjs';

globalThis.THREE = createRequire(import.meta.url)('three');
const { stepCar } = await import('../public/js/core/physics.js');
const T = await import('../public/js/modes/track/geometry.js');
const { CARS, CAR_IDS, CLASSES, BASE, DEFAULT_CAR, PAINTS, PAINT_CODES, DEFAULT_PAINT, FACTORY, paintHex, statBars } = await import('../public/js/core/cars.js');

const golden = JSON.parse(readFileSync(new URL('./fixtures/physics-golden-v2.json', import.meta.url), 'utf8'));
const STATS = Object.keys(BASE);

test('the catalogue is well formed', () => {
  assert.equal(new Set(CAR_IDS).size, CARS.length, 'car ids are unique');
  assert.ok(CAR_IDS.includes(DEFAULT_CAR));
  for (const k of CLASSES) assert.ok(CARS.some(c => c.cls === k.id), `class ${k.id} has a car`);
  for (const c of CARS) {
    assert.deepEqual(Object.keys(c.stats).sort(), [...STATS].sort(), `${c.id}: every stat is set`);
    for (const k of STATS) {
      const lim = k === 'dirt' ? [1, 1.25] : [0.92, 1.08];      // off-road pull: only ever a bonus, for the rally car
      assert.ok(c.stats[k] >= lim[0] && c.stats[k] <= lim[1], `${c.id}.${k} = ${c.stats[k]}: within ${lim}`);
    }
    assert.ok(CLASSES.some(k => k.id === c.cls), `${c.id}: its class ${c.cls} exists`);
    assert.match(c.model, /^models\/cars\/[\w-]+\.glb$/, `${c.id}: model file`);
    assert.ok(existsSync(new URL('../public/' + c.model, import.meta.url)), `${c.id}: ${c.model} is in public/`);
    // the glTF's JSON chunk: a "Paint" material without a texture, so the paint is one colour
    const glb = readFileSync(new URL('../public/' + c.model, import.meta.url));
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    const paint = (json.materials || []).find(m => m.name === 'Paint');
    assert.ok(paint, `${c.id}: has a Paint material`);
    assert.ok(!paint.pbrMetallicRoughness?.baseColorTexture, `${c.id}: Paint has no texture`);
    const toSrgb = v => Math.round(255 * Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
    const [r, g, bl] = (paint.pbrMetallicRoughness?.baseColorFactor || [1, 1, 1]).map(toSrgb);
    assert.equal(c.factory, (r << 16) | (g << 8) | bl, `${c.id}: factory is the model's own Paint colour`);
    const glass = (json.materials || []).find(m => m.name === 'Glass');
    if (glass) assert.notEqual(glass.alphaMode, 'BLEND', `${c.id}: the windows are opaque`);
    for (const [, v] of statBars(c.stats)) assert.ok(v >= 1 && v <= 10);
  }
});

test('the paints: "Заводской" first, then ten strong colours, no pink', () => {
  assert.equal(PAINTS.length, 11);
  assert.equal(PAINTS[0].hex, null, 'the first paint is the car\'s own colour');
  assert.equal(PAINT_CODES[0], FACTORY);
  assert.equal(DEFAULT_PAINT, FACTORY, 'a new player drives the car as it came');
  assert.equal(new Set(PAINT_CODES).size, PAINTS.length, 'paints are unique');
  assert.equal(new Set(PAINTS.map(p => p.name)).size, PAINTS.length, 'and so are their names');
  for (const p of PAINTS.slice(1)) {
    assert.ok(Number.isInteger(p.hex) && p.hex >= 0 && p.hex <= 0xffffff, `${p.name}: a colour`);
    const [r, g, b] = [p.hex >> 16, (p.hex >> 8) & 255, p.hex & 255].map(v => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) h = mx === r ? 60 * (((g - b) / d) % 6) : mx === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
    h = (h + 360) % 360;
    if (d > 0.1) {                                    // white, black and silver are neutral: no hue to judge
      // a pastel is light and washed out (the old lavender: l 0.74, the mint: l 0.65)
      assert.ok(s >= 0.5 && l <= 0.62, `${p.name}: strong, not pastel (s=${s.toFixed(2)}, l=${l.toFixed(2)})`);
      assert.ok(!(h >= 290 && h <= 350), `${p.name}: not pink (hue ${h.toFixed(0)}°)`);
      assert.ok(!(h > 350 || h < 10) || l < 0.55, `${p.name}: a red is red, not a rose (l=${l.toFixed(2)})`);
    }
  }
  for (const c of CARS) {
    assert.equal(paintHex(FACTORY, c.id), c.factory, `${c.id}: "Заводской" is its own colour`);
    assert.equal(paintHex(0xd3202a, c.id), 0xd3202a, 'any other paint is itself');
  }
  assert.equal(paintHex(12345, 'coupe'), CARS[0].factory, 'an unknown code falls back to the factory colour');
});

test('the base car with its spec set drives the version 2 recording bit for bit', () => {
  const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,pitch:0,spinV:0,lastMark:[null,null],
    spec: CARS.find(c => c.id === DEFAULT_CAR).stats};
  const events = [], hooks = { onWall: p => events.push(['wall', p]), onLap: () => events.push(['lap']) };
  const res = run({
    car, events,
    track: { P: T.P, NM: T.NM, N: T.N, WALL: T.WALL },
    placeGrid: slot => T.placeGrid(car, slot),
    step: (dt, input) => { stepCar(car, input, dt); T.constrainToTrack(car, dt, hooks); },
  });
  assert.equal(res.hash, golden.hash);
});

test('every car pays for what it is good at', () => {
  for (const c of CARS) {
    if (c.id === DEFAULT_CAR) continue;
    const v = STATS.map(k => c.stats[k]);
    assert.ok(v.some(x => x > 1) && v.some(x => x < 1), `${c.id} has a strength and a weakness`);
  }
});

const ang = (a, b) => { const t = Math.PI * 2; return (((b - a + Math.PI) % t) + t) % t - Math.PI; };

// Two laps after a flying start. f: how fast it dares to take corners, look: how far ahead
// (track points) it aims. Returns the average of laps 2 and 3, and the wall touches.
function laps(stats, f, look) {
  const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,pitch:0,spinV:0,lastMark:[null,null],spec:stats};
  T.placeGrid(car, 0);
  const times = []; let t = 0, walls = 0; const dt = 1 / 120;
  const hooks = { onWall: () => walls++, onLap: () => times.push(t) };
  const I = { up: 0, down: 0, left: 0, right: 0, hb: 0 };
  while (times.length < 3 && t < 200) {
    const a = (car.idx + look) % T.N, far = (car.idx + look * 3) % T.N;
    const toA = Math.atan2(T.P[a].x - car.x, T.P[a].z - car.z), err = ang(car.h, toA);
    const bend = Math.abs(ang(toA, Math.atan2(T.P[far].x - T.P[a].x, T.P[far].z - T.P[a].z)));
    const sp = Math.hypot(car.vx, car.vz), tooFast = sp > f * (20 + 45 * (1 - Math.min(1, bend / 1.2)));
    I.left = err > 0.03 ? 1 : 0; I.right = err < -0.03 ? 1 : 0;
    I.up = !tooFast && Math.abs(err) < 0.6 ? 1 : 0; I.down = tooFast && sp > 18 ? 1 : 0;
    stepCar(car, I, dt); T.constrainToTrack(car, dt, hooks); t += dt;
  }
  return times.length < 3 ? null : { lap: (times[2] - times[0]) / 2, walls };
}
function bestLap(stats) {
  let best = Infinity;
  for (let f = 1.8; f <= 3.0; f += 0.025) for (const look of [20, 23, 26, 29, 32]) {
    const r = laps(stats, f, look);
    if (r && r.walls === 0) best = Math.min(best, r.lap);
  }
  return best;
}

test('drift track: the best clean laps of all cars are within 2 % of each other', () => {
  const best = Object.fromEntries(CARS.map(c => [c.id, bestLap(c.stats)]));
  const v = Object.values(best), lo = Math.min(...v), hi = Math.max(...v);
  assert.ok(Number.isFinite(hi), `every car manages a clean lap: ${JSON.stringify(best)}`);
  assert.ok(hi / lo < 1.02, `best laps ${Object.entries(best).map(([k, s]) => k + ' ' + s.toFixed(2) + ' s').join(', ')}`);
});

function highway(stats) {
  const dt = 1 / 120, mk = () => ({x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,off:false,spinV:0,spec:stats});
  let c = mk(), t100 = 0, t150 = 0, top = 0;
  for (let t = 0; t < 60; t += dt) {
    stepCar(c, { up: 1, down: 0, left: 0, right: 0, hb: 0 }, dt);
    if (!t100 && c.vF * 3.6 >= 100) t100 = t;
    if (!t150 && c.vF * 3.6 >= 150) t150 = t; top = Math.max(top, c.vF * 3.6);
  }
  c = mk(); c.vz = c.vF = 200 / 3.6;                         // braking distance from 200 km/h
  while (c.vF > 0.5) stepCar(c, { up: 0, down: 1, left: 0, right: 0, hb: 0 }, dt);
  const brake = c.z;
  c = mk(); c.vz = c.vF = 150 / 3.6; let lane = 0;           // one lane over (3.6 m) at 150 km/h, straight again
  for (let t = 0; t < 5; t += dt) {
    stepCar(c, { up: 1, down: 0, left: c.x < 1.8 && c.h < 0.2 ? 1 : 0, right: c.x >= 1.8 && c.h > 0.005 ? 1 : 0, hb: 0 }, dt);
    if (c.x >= 3.5 && Math.abs(c.h) < 0.05) { lane = t; break; }
  }
  return { top, t100, t150, brake, lane };
}

test('highway: small differences, and the fastest car is not the best at everything', () => {
  const m = Object.fromEntries(CARS.map(c => [c.id, highway(c.stats)]));
  const base = m[DEFAULT_CAR];
  for (const [id, r] of Object.entries(m)) {
    assert.ok(Math.abs(r.top / base.top - 1) < 0.04, `${id}: top speed ${r.top.toFixed(1)} km/h vs ${base.top.toFixed(1)}`);
    assert.ok(Math.abs(r.t150 / base.t150 - 1) < 0.1, `${id}: 0-150 km/h in ${r.t150.toFixed(2)} s vs ${base.t150.toFixed(2)}`);
    assert.ok(Math.abs(r.brake / base.brake - 1) < 0.15, `${id}: stops from 200 km/h in ${r.brake.toFixed(1)} m vs ${base.brake.toFixed(1)}`);
    assert.ok(r.lane > 0, `${id} changes lanes`);
  }
  const fastest = Object.keys(m).reduce((a, b) => m[a].top >= m[b].top ? a : b);
  const others = Object.keys(m).filter(k => k !== fastest);
  assert.ok(others.some(k => m[k].brake < m[fastest].brake || m[k].lane < m[fastest].lane),
    `someone brakes or changes lanes better than the fastest car (${fastest})`);
});

test('off the asphalt the rally car keeps more of its pull, and only it', () => {
  const pull = stats => {
    const c = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,off:true,spinV:0,spec:stats};
    for (let t = 0; t < 3; t += 1 / 120) { c.off = true; stepCar(c, { up: 1, down: 0, left: 0, right: 0, hb: 0 }, 1 / 120); }
    return c.vF;
  };
  const base = pull(BASE);
  for (const c of CARS) {
    const v = pull({ ...c.stats, acc: 1, vmax: 1 });        // same engine for everyone: only the verge matters
    if (c.stats.dirt > 1) assert.ok(v > base * 1.08, `${c.id} gets going on the verge (${v.toFixed(1)} vs ${base.toFixed(1)} m/s)`);
    else assert.equal(v, base, `${c.id} loses on the verge like the base car`);
  }
});

// A standard drift: 90 km/h, a flick with the handbrake and full steer, then the slide
// held on the throttle; once with the wheel held over (3 s), once let go after 0.6 s.
// Points by the game's own formula (game.js scoring()).
function driftPoints(stats) {
  const run = release => {
    const c = {x:0,z:0,h:0,vx:0,vz:25,vF:25,vR:0,steer:0,off:false,spinV:0,spec:stats}, dt = 1 / 120;
    let pts = 0, time = 0;
    const score = () => {
      const sp = Math.hypot(c.vF, c.vR), ang = Math.atan2(Math.abs(c.vR), Math.max(.01, Math.abs(c.vF))) * 180 / Math.PI;
      if (sp > 9 && c.vF > 3 && ang > 10) { time += dt; pts += (Math.min(ang, 65) - 6) * sp * .22 * dt; }
    };
    for (let t = 0; t < 0.45; t += dt) { stepCar(c, { up: 0, down: 0, left: 1, right: 0, hb: 1 }, dt); score(); }
    for (let t = 0; t < 3; t += dt) { stepCar(c, { up: 1, down: 0, left: t < release ? 1 : 0, right: 0, hb: 0 }, dt); score(); }
    return pts * Math.min(5, 1 + Math.floor(time / 1.8));
  };
  return run(99) + 4 * run(0.6);
}

test('each car is what it says it is', () => {
  const by = f => Object.fromEntries(CARS.map(c => [c.id, f(c.stats)]));
  const hw = by(highway), dr = by(driftPoints);
  const top = id => Object.keys(hw).every(k => k === id || hw[k].top < hw[id].top);
  const best = (m, id, lower) => Object.keys(m).every(k => k === id || (lower ? m[k] > m[id] : m[k] < m[id]));
  assert.ok(top('super'), 'Lamborghini has the highest top speed');
  assert.ok(Object.keys(hw).every(k => k === 'super' || k === 'muscle' || hw[k].top < hw.muscle.top), 'Dodge is second on top speed');
  assert.ok(best(Object.fromEntries(Object.entries(hw).map(([k, v]) => [k, v.t100])), 'nexus', true), 'Nexus RX (electric) is quickest to 100 km/h');
  assert.ok(best(dr, 'rx7'), `Mazda RX-7 scores the most in a drift (${JSON.stringify(dr)})`);
  for (const id of ['gtr', 'muscle', 'rally']) assert.ok(dr[id] > dr.coupe, `${id} drifts better than the GT`);
  for (const id of ['super', 'sedan', 'nexus']) assert.ok(dr[id] < dr.coupe, `${id} drifts worse than the GT`);
  assert.ok(best(Object.fromEntries(Object.entries(hw).map(([k, v]) => [k, v.brake])), 'sedan', true), 'Ford stops shortest');
  assert.ok(best(Object.fromEntries(CARS.map(c => [c.id, c.stats.dirt])), 'rally'), 'Rally is the best off the asphalt');
});
