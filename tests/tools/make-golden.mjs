// Records the physics golden file from the ORIGINAL single-file game (commit 06ee674),
// before any refactoring. The original code is cut out of that commit's
// public/index.html by markers and run unchanged, so the golden file is a recording of
// the real pre-refactor physics, not of a copy someone could have edited.
//
// Run once:  node tests/tools/make-golden.mjs
// Writes:    tests/fixtures/physics-golden.json
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { run } from '../harness.mjs';

const BASE = '06ee674';
const require = createRequire(import.meta.url);
const THREE = require('three');

const src = execSync(`git show ${BASE}:public/index.html`, { encoding: 'utf8' });
const cut = (from, to) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error('marker not found: ' + from + ' … ' + to);
  return src.slice(a, b);
};
const code = [
  cut('const RAW=', 'function ribbon('),            // track geometry
  cut('const START=', '{ const g=new THREE.Group()'), // start index
  cut('function placeAt(i){', '\nconst VMAX='),       // placeAt, placeGrid, resetToTrack, nearest
  cut('const VMAX=', 'function crash(power){'),       // physics()
].join('\n');

const events = [];
const factory = new Function('THREE', 'events', `
  const NET={online:false,finished:false};
  const NOINPUT={up:0,down:0,left:0,right:0,hb:0};
  const input={up:0,down:0,left:0,right:0,hb:0};
  const car={x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,pitch:0,spinV:0,lastMark:[null,null]};
  function crash(power){ events.push(['wall', power]); }
  function finishLap(){ events.push(['lap']); }
  ${code}
  return {car, input, physics, placeGrid, track:{P, NM, N, WALL}};
`);
const v1 = factory(THREE, events);
const engine = {
  car: v1.car, track: v1.track, events,
  placeGrid: (slot) => v1.placeGrid(slot),
  step: (dt, input) => { Object.assign(v1.input, input); v1.physics(dt); },
};
const res = run(engine);
const laps = events.filter(e => e[0] === 'lap').length;
const walls = events.filter(e => e[0] === 'wall').length;
mkdirSync(new URL('../fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('../fixtures/physics-golden.json', import.meta.url),
  JSON.stringify({ source: BASE, ...res }, null, 1));
console.log(`frames ${res.frames}, laps ${laps}, wall hits ${walls}, hash ${res.hash.slice(0, 16)}`);
