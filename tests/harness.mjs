// Shared driver for the physics golden test.
//
// It drives a car around the drift track for a few minutes with a deterministic
// "autopilot" (steering toward the racing line, handbrake drifts, braking, reversing,
// deliberate wall hits) at an uneven frame rate, exactly the way the game loop does:
// every frame dt is split into two physics substeps of dt/2.
//
// The autopilot reads only the car's own state, so if two physics implementations
// differ by a single bit, their inputs and paths diverge and the hashes differ.
import { createHash } from 'node:crypto';

export const SECONDS = 180;
const FIELDS = ['x', 'z', 'h', 'vx', 'vz', 'vF', 'vR', 'steer', 'idx', 'prog', 'spinV'];

// Deterministic frame times: mostly ~60 fps, some 30 fps frames, rare hitches (the game
// clamps dt to 0.05, so do we).
function* frameTimes() {
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
  for (;;) {
    const r = rnd();
    let dt = r < 0.8 ? 1 / 60 + (rnd() - 0.5) * 0.004 : r < 0.97 ? 1 / 30 : 0.05 + rnd() * 0.1;
    yield Math.min(0.05, dt);
  }
}

const angDiff = (a, b) => { const t = Math.PI * 2; return (((b - a + Math.PI) % t) + t) % t - Math.PI; };

function autopilot(car, t, trk, input) {
  const { P, NM, N, WALL } = trk;
  const ahead = (car.idx + 16) % N;
  let off = Math.sin(t * 0.37) * 3;
  if (t % 47 > 40) off = Math.sign(Math.sin(t)) * (WALL + 4);   // aim at the wall
  const tx = P[ahead].x + NM[ahead].x * off, tz = P[ahead].z + NM[ahead].z * off;
  const want = Math.atan2(tx - car.x, tz - car.z);
  const err = angDiff(car.h, want);
  input.left = err > 0.04 ? 1 : 0;
  input.right = err < -0.04 ? 1 : 0;
  const phase = t % 30;
  input.up = phase < 21 || phase > 26 ? 1 : 0;
  input.down = phase > 21 && phase < 26 ? 1 : 0;            // brake, then reverse
  input.hb = (t % 6) < 0.45 && t > 4 ? 1 : 0;               // handbrake flicks
  if (phase > 24.5 && phase < 26) { input.left = 1; input.right = 0; } // reverse turn
}

// engine: { car, track:{P,NM,N,WALL}, placeGrid(slot), step(dt, input), events[] }
export function run(engine) {
  const input = { up: 0, down: 0, left: 0, right: 0, hb: 0 };
  engine.placeGrid(0);
  const total = createHash('sha256');
  const perSecond = [];
  let sec = createHash('sha256'), t = 0, nextSec = 1, frames = 0;
  const buf = new Float64Array(FIELDS.length + 1);
  const bytes = new Uint8Array(buf.buffer);
  const times = frameTimes();
  while (t < SECONDS) {
    const dt = times.next().value;
    autopilot(engine.car, t, engine.track, input);
    const h = dt / 2;
    for (let k = 0; k < 2; k++) {
      engine.step(h, input);
      FIELDS.forEach((f, i) => { buf[i] = engine.car[f]; });
      buf[FIELDS.length] = engine.car.off ? 1 : 0;
      total.update(bytes); sec.update(bytes);
    }
    t += dt; frames++;
    if (t >= nextSec) { perSecond.push(sec.digest('hex').slice(0, 16)); sec = createHash('sha256'); nextSec++; }
  }
  const c = engine.car;
  return {
    frames,
    hash: total.digest('hex'),
    perSecond,
    events: engine.events,
    final: Object.fromEntries(FIELDS.map(f => [f, c[f]])),
  };
}
