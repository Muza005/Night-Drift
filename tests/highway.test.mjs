// Highway (traffic mode) rules: rails, long drives, road chunks, the top-down camera.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepCar } from '../public/js/core/physics.js';
import * as H from '../public/js/modes/traffic/geometry.js';

const newCar = () => ({x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,pitch:0,spinV:0});
const LIM = H.RAIL - 1.25;

test('rails stop the car and report hard hits', () => {
  const car = newCar(), hits = [];
  const hooks = { onWall: p => hits.push(p), onLap: () => assert.fail('no laps on the highway') };
  const input = { up: 1, down: 0, left: 0, right: 1, hb: 0 };   // full throttle, steering into the right rail
  let maxX = 0;
  for (let i = 0; i < 60 * 8; i++) { stepCar(car, input, 1 / 120); H.constrainToHighway(car, 1 / 120, hooks); maxX = Math.max(maxX, Math.abs(car.x)); }
  assert.ok(maxX <= LIM + 1e-9, `car went through the rail: |x| = ${maxX}`);
  assert.ok(hits.length > 0, 'hitting the rail at speed must count as a wall hit');
  assert.equal(car.off, false);
});

test('25 km at full speed: the car stays on the road and the numbers stay sane', () => {
  const car = newCar(), hooks = { onWall() {}, onLap() {} };
  const input = { up: 1, down: 0, left: 0, right: 0, hb: 0 };
  let t = 0;
  while (car.z < 25000 && t < 1200) {
    // change lanes every 3 s (0 → 3 → 1 → 2 …) with a simple lane-keeping autopilot
    const lane = [0, 3, 1, 2][Math.floor(t / 3) % 4];
    const want = Math.atan2(H.laneCenter(lane) - car.x, 30), err = want - car.h;
    input.left = err > 0.02 ? 1 : 0; input.right = err < -0.02 ? 1 : 0;
    stepCar(car, input, 1 / 120); H.constrainToHighway(car, 1 / 120, hooks); t += 1 / 120;
    for (const k of ['x', 'z', 'h', 'vx', 'vz']) assert.ok(Number.isFinite(car[k]), `${k} became ${car[k]}`);
    assert.ok(Math.abs(car.x) <= LIM + 1e-9);
  }
  assert.ok(car.z >= 25000, `only reached ${car.z.toFixed(0)} m`);
});

test('road chunks: always the car\'s chunk, 1 behind and 4 ahead, at any distance and in reverse', () => {
  for (const z of [-350, -1, 0, 0.5, 199.99, 200, 12345.6, 25000, 99999.9]) {
    const { from, to } = H.chunkRange(z), c = Math.floor(z / H.CHUNK);
    assert.equal(from, c - H.BEHIND); assert.equal(to, c + H.AHEAD);
    assert.ok(from * H.CHUNK <= z - 0 && (to + 1) * H.CHUNK >= z + H.AHEAD * H.CHUNK - H.CHUNK);
    // road ahead of the car never ends before the camera's far edge (~100 m)
    assert.ok((to + 1) * H.CHUNK - z >= 600);
  }
});

test('start grid: six cars, in lanes, never overlapping', () => {
  const P = [0, 1, 2, 3, 4, 5].map(H.startPose);
  for (const p of P) assert.ok(Math.abs(p.x) <= H.HALF - 1);
  for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++)
    assert.ok(Math.abs(P[i].x - P[j].x) >= 4 || Math.abs(P[i].z - P[j].z) >= 6, `slots ${i} and ${j} overlap`);
});

test('top-down camera shows at least 3 s of closing in on traffic (55 m minimum), on every screen shape', () => {
  for (const aspect of [21 / 9, 16 / 9, 4 / 3, 1, 3 / 4, 9 / 16, 9 / 20]) {
    for (let v = 0; v <= 50; v += 2.5) {
      const V = H.topDownView(v, aspect);
      const need = Math.max(H.CAM.minAhead, H.CAM.aheadSeconds * (v - H.TRAFFIC_MIN_SPEED));
      assert.ok(V.visibleAhead >= need - 1e-6, `aspect ${aspect.toFixed(2)}, ${v} m/s: sees ${V.visibleAhead.toFixed(1)} m, needs ${need.toFixed(1)} m`);
      assert.ok(V.pitch - V.fovV / 2 > 5, 'the top of the screen must stay below the horizon');
      // the whole highway fits across the screen at the car's distance
      const carRay = (V.pitch + V.fovV * H.CAM.carAt) * Math.PI / 180, dist = V.height / Math.sin(carRay);
      const hfov = 2 * Math.atan(Math.tan(V.fovV * Math.PI / 360) * aspect);
      assert.ok(2 * dist * Math.tan(hfov / 2) >= 2 * H.RAIL - 1e-6, `aspect ${aspect.toFixed(2)}: rails off screen`);
    }
  }
});

test('lanes: 0 is the leftmost as the driver sees it (+X is to the left facing +Z)', () => {
  assert.equal(H.laneCenter(0), 6); assert.equal(H.laneCenter(3), -6);
  for (let i = 0; i < H.LANES; i++) assert.equal(H.nearestLane(H.laneCenter(i) + 0.9), i);
  assert.equal(H.nearestLane(50), 0); assert.equal(H.nearestLane(-50), 3);
  // pressing right (D) turns the car toward -X
  const car = {x:0,z:0,h:0,vx:0,vz:20,vF:0,vR:0,steer:0,off:false,spinV:0};
  for (let i = 0; i < 60; i++) stepCar(car, {up:1,down:0,left:0,right:1,hb:0}, 1/60);
  assert.ok(car.x < 0);
});
