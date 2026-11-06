// Golden test: the car physics must match the original single-file game bit for bit.
// The recording in fixtures/physics-golden.json was made from commit 06ee674 by
// tests/tools/make-golden.mjs. If this test fails, the car no longer drives the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { run } from './harness.mjs';

globalThis.THREE = createRequire(import.meta.url)('three');
const { stepCar } = await import('../public/js/core/physics.js');
const T = await import('../public/js/modes/track/geometry.js');

const golden = JSON.parse(readFileSync(new URL('./fixtures/physics-golden.json', import.meta.url), 'utf8'));

test('track physics matches the original game bit for bit', () => {
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
  assert.equal(firstBad, -1, `physics differs from the original starting at second ${firstBad}`);
  assert.equal(res.frames, golden.frames);
  assert.deepEqual(res.events, golden.events);
  assert.deepEqual(res.final, golden.final);
  assert.equal(res.hash, golden.hash);
});
