// Node scenario: two players' cars, each simulated on "its own computer" (stepCar +
// constrainToTrack + the collision code), states and bumps travelling with ~150 ms of
// ping (75 ± 25 ms each way via the server, schema patches every 33 ms).
//   npm run test:hits -- [old|new] [map]   (old: the code at 6a4c289, for the before numbers)
import { createRequire } from 'node:module';
const R = new URL('../../../', import.meta.url).href;
globalThis.THREE = createRequire(new URL('package.json', R))('three');
const { stepCar } = await import(R + 'public/js/core/physics.js');
const T = await import(R + 'public/js/modes/track/geometry.js');
const { carById } = await import(R + 'public/js/core/cars.js');
const which = process.argv[2] || 'new';
const MAP = process.argv[3] || 'neon';
const algo = which === 'old' ? (await import('./old.mjs')).oldAlgo : (await import('./new.mjs')).newAlgo;
T.setMap(MAP);

// a straight piece of track: least heading change over ±60 points
let bestI = 0, bestTurn = 1e9;
for (let i = 0; i < T.N; i += 3) {
  let turn = 0;
  for (let k = -60; k < 60; k++) { const a = T.TG[(i + k + T.N) % T.N], b = T.TG[(i + k + 1 + T.N) % T.N]; turn += Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z)); }
  if (turn < bestTurn) { bestTurn = turn; bestI = i; }
}
const NONE = { up: 0, down: 0, left: 0, right: 0, hb: 0 }, GAS = { ...NONE, up: 1 };
const ONE_WAY = 75, JITTER = 25, RTT = 150;
let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const lag = () => ONE_WAY + (rnd() - 0.5) * 2 * JITTER;

function mkCar(carId) {
  const c = { x: 0, z: 0, h: 0, vx: 0, vz: 0, vF: 0, vR: 0, steer: 0, spinV: 0, off: false, carId, spec: carById(carId).stats };
  T.placeAt(c, bestI); return c;
}
function mkClient(id, carId, input) {
  const cl = {
    id, car: mkCar(carId), input, now: 0, air: !T.FLAT, rtt: RTT, inbox: [], sendT: 0, hops: 0,
    ghost: { buf: [], x: 0, z: 0, h: 0, walls: {}, id: null, car: null },
    stat: { maxPush: 0, pushes: [], apps: [], ignored: 0, push(m) { this.maxPush = Math.max(this.maxPush, m); this.pushes.push([cl.now, m]); }, apply(kind, mag) { this.apps.push([cl.now, kind, mag]); } },
    nowMs() { return cl.now; },
  };
  return cl;
}
const hooks = { onWall() {}, onLap() {}, onLand() {} };

// one scenario: B drives along the straight at vB; A comes at relative speed `closing`
// along direction `ang` (0 = straight from behind, rotated toward B's left side)
function run(kind, closingKmh, { collide = true, carA = 'coupe', carB = 'coupe', vBkmh = 40 } = {}) {
  seed = 7;
  const A = mkClient('a', carA, GAS), B = mkClient('b', carB, GAS);
  A.ghost.id = 'b'; B.ghost.id = 'a'; A.ghost.car = carB; B.ghost.car = carA;
  const t = T.TG[bestI], fx = t.x, fz = t.z, nx = -fz, nz = fx;   // forward, and to the side (n)
  const vB = vBkmh / 3.6, cl = closingKmh / 3.6;
  const ang = { rear: 0, side: 12, corner: 45 }[kind] * Math.PI / 180;
  // A's velocity = B's + closing along a direction rotated from forward toward -n (A comes from B's +n side)
  const dX = fx * Math.cos(ang) - nx * Math.sin(ang), dZ = fz * Math.cos(ang) - nz * Math.sin(ang);
  const vAx = fx * vB + dX * cl, vAz = fz * vB + dZ * cl;
  // where A is at contact, in B's frame: rear 4.6 behind, side 2.3 beside, corner at the front corner
  const off = { rear: [-4.5, 0], side: [0, 1.4], corner: [1.0, 1.4] }[kind];
  const lead = 0.25;
  const B0 = { x: B.car.x, z: B.car.z };
  const cx = B0.x + fx * vB * lead + fx * off[0] + nx * off[1], cz = B0.z + fz * vB * lead + fz * off[0] + nz * off[1];
  Object.assign(B.car, { vx: fx * vB, vz: fz * vB, vF: vB });
  const hA = Math.atan2(vAx, vAz);
  Object.assign(A.car, { x: cx - vAx * lead, z: cz - vAz * lead, h: hA, vx: vAx, vz: vAz, vF: Math.hypot(vAx, vAz), hPrev: hA });
  A.car.idx = T.nearest(A.car, true);
  const cls = [A, B], other = c => c === A ? B : A;
  const wire = [];          // {at, to, kind, m}
  for (const c of cls) c.send = m => wire.push({ at: time + lag() + lag(), to: other(c), kind: 'bump', m: { ...m, from: c.id } });
  const rec = { A: [], B: [], gA: [] };
  let patchT = 0, time = 0;
  const dt = 1 / 60;
  // prime the ghost buffers with a state 2 frames old so collisions can start at once
  const stateOf = c => ({ t: c.now, x: c.car.x, z: c.car.z, h: c.car.h, vx: c.car.vx, vz: c.car.vz, vf: c.car.vF, steer: c.car.steer, slide: 0, y: 0, vy: 0, idx: c.car.idx });
  for (const c of cls) { const s = stateOf(c); other(c).ghost.buf.push({ ...s, x: s.x - s.vx * .033, z: s.z - s.vz * .033, t: -33 }, s); }
  const serverQ = [];        // states at the server waiting for the next patch
  for (let f = 0; f < 90; f++) {
    time = f * dt * 1000;
    for (const c of cls) c.now = time;
    // deliveries
    for (let i = wire.length - 1; i >= 0; i--) { const w = wire[i]; if (w.at <= time) { wire.splice(i, 1); deliver(w); } }
    // patches at the server every 33 ms
    while (patchT <= time) { for (const q of serverQ.splice(0)) wire.push({ at: patchT + lag(), to: q.to, kind: 'state', m: q.m }); patchT += 33; }
    for (const c of cls) {
      const g = c.ghost;
      algo.ghost(c, g, time, dt, (s, gg) => T.keepInWalls(s, gg.walls), c.car);
      const h = dt / 2;
      for (let k = 0; k < 2; k++) {
        if (!c.car.air) stepCar(c.car, c.input, h);
        T.constrainToTrack(c.car, h, hooks);
        if (collide) algo.collide(c);
      }
      if (algo.B) c.car.liftMax = Math.max(c.car.liftMax || 0, algo.B.lift(c.car, dt));
      c.sendT += dt;
      if (c.sendT >= .033) { c.sendT = which === 'old' ? 0 : c.sendT - .033; serverQ.push({ to: other(c), m: stateOf(c), at: time + lag() }); }
    }
    rec.A.push([time, A.car.x, A.car.z, A.car.vx, A.car.vz, A.car.spinV, A.car.h, A.car.y || 0, A.car.air ? 1 : 0]);
    rec.B.push([time, B.car.x, B.car.z, B.car.vx, B.car.vz, B.car.spinV, B.car.h, B.car.y || 0, B.car.air ? 1 : 0]);
    rec.gA.push([time, A.ghost.x, A.ghost.z]);   // how A draws B
  }
  function deliver(w) {
    if (w.kind === 'state') { const b = w.to.ghost.buf, l = b[b.length - 1]; if (l && w.m.t <= l.t) return; b.push(w.m); if (b.length > 2) b.shift(); }
    else algo.onBump(w.to, w.m);
  }
  // hand the algorithms a send()
  return { A, B, rec };
}
// algorithms call cl.send(m): route it with two one-way lags
// (patched in per run below)


const km = v => (v * 3.6).toFixed(0);
function metrics(kind, kmh, o = {}) {
  const hit = run(kind, kmh, o), free = run(kind, kmh, { ...o, collide: false });
  const r = hit.rec, f = free.rec;
  const fr = t => Math.round(t / (1000 / 60));
  const first = c => c.stat.apps.length ? fr(c.stat.apps[0][0]) : -1;
  const iA = first(hit.A), iB = first(hit.B);
  if (iA < 0 && iB < 0) return { kind, kmh, miss: true };
  const i0 = Math.min(...[iA, iB].filter(i => i >= 0));
  const at = (arr, i) => arr[Math.min(arr.length - 1, i)];
  const sp = (row) => Math.hypot(row[3], row[4]);
  const disp = (h, frr, i) => i < 0 ? 0 : Math.hypot(at(h, i + 12)[1] - at(frr, i + 12)[1], at(h, i + 12)[2] - at(frr, i + 12)[2]);
  const spin = arr => Math.max(...arr.slice(Math.max(0, i0 - 1), i0 + 40).map(x => Math.abs(x[5])));
  const sum = c => c.stat.apps.reduce((a, x) => a + x[2], 0);
  // the ghost of B on A's screen: the biggest change of its per-frame motion (a jump). The
  // frame A's own hit starts the kick (the hit itself: Δv × frame) apart from the rest.
  let jumpHit = 0, jump = 0, err = 0;
  for (let i = Math.max(2, i0 - 2); i < Math.min(r.gA.length, i0 + 36); i++) {
    const g = r.gA, ax = g[i][1] - 2 * g[i - 1][1] + g[i - 2][1], az = g[i][2] - 2 * g[i - 1][2] + g[i - 2][2], J = Math.hypot(ax, az);
    if (iA >= 0 && Math.abs(i - iA) <= 1) jumpHit = Math.max(jumpHit, J); else jump = Math.max(jump, J);
    err = Math.max(err, Math.hypot(g[i][1] - r.B[i][1], g[i][2] - r.B[i][2]));
  }
  const errEnd = Math.hypot(at(r.gA, i0 + 40)[1] - at(r.B, i0 + 40)[1], at(r.gA, i0 + 40)[2] - at(r.B, i0 + 40)[2]);
  const airT = arr => arr.slice(i0, i0 + 60).filter(x => x[8]).length / 60, freeAir = arr => arr.slice(i0, i0 + 60).filter(x => x[8]).length / 60;
  const hy = T.FLAT ? 'lift ' + Math.max(hit.A.car.liftMax || 0, hit.B.car.liftMax || 0).toFixed(2) + 'm' : 'air ' + (airT(r.A) - freeAir(f.A)).toFixed(2) + '/' + (airT(r.B) - freeAir(f.B)).toFixed(2) + 's';
  return {
    kind, kmh,
    A: km(sp(at(r.A, i0 - 1))) + '→' + km(sp(at(r.A, i0 + 30))), B: km(sp(at(r.B, i0 - 1))) + '→' + km(sp(at(r.B, i0 + 30))),
    dvA: km(sum(hit.A)), dvB: km(sum(hit.B)),
    dispA: disp(r.A, f.A, iA).toFixed(2), dispB: disp(r.B, f.B, iB).toFixed(2),
    spinA: spin(r.A).toFixed(1), spinB: spin(r.B).toFixed(1),
    push: Math.max(hit.A.stat.maxPush, hit.B.stat.maxPush).toFixed(2),
    apps: hit.A.stat.apps.length + '/' + hit.B.stat.apps.length, ign: hit.A.stat.ignored + hit.B.stat.ignored,
    hop: hy,
    jHit: jumpHit.toFixed(2), jump: jump.toFixed(2), gErr: err.toFixed(1), gErr07: errEnd.toFixed(2),
  };
}
const rows = [];
if (!process.env.NORUN) for (const kind of ["rear", "side", "corner"]) for (const kmh of [60, 120, 180]) rows.push(metrics(kind, kmh));
console.log(`${algo.name} on ${MAP} (km/h, m, rad/s); apps = velocity changes applied to each car (own impulses + received bumps)`);
console.table(rows);
export { run, metrics };
