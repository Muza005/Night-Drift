// Records the physics golden file for physics version 2 (see core/physics.js) from the
// current code: the same three-minute autopilot run as version 1's recording
// (make-golden.mjs, cut from the original game), driven through stepCar() and the
// track's constrainToTrack().
//
// Run only when the physics is changed ON PURPOSE (and say so in core/physics.js):
//   node tests/tools/make-golden-v2.mjs
// Writes: tests/fixtures/physics-golden-v2.json
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { run } from '../harness.mjs';

globalThis.THREE = createRequire(import.meta.url)('three');
const { stepCar } = await import('../../public/js/core/physics.js');
const T = await import('../../public/js/modes/track/geometry.js');

const events = [];
const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,pitch:0,spinV:0,lastMark:[null,null]};
const hooks = { onWall: p => events.push(['wall', p]), onLap: () => events.push(['lap']) };
const res = run({
  car, events,
  track: { P: T.P, NM: T.NM, N: T.N, WALL: T.WALL },
  placeGrid: slot => T.placeGrid(car, slot),
  step: (dt, input) => { stepCar(car, input, dt); T.constrainToTrack(car, dt, hooks); },
});
const laps = events.filter(e => e[0] === 'lap').length, walls = events.filter(e => e[0] === 'wall').length;
writeFileSync(new URL('../fixtures/physics-golden-v2.json', import.meta.url), JSON.stringify({ source: 'physics v2', ...res }, null, 1));
console.log(`frames ${res.frames}, laps ${laps}, wall hits ${walls}, hash ${res.hash.slice(0, 16)}`);
