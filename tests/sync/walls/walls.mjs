// Plan 3, stage 0: the "before" numbers of hits, in Node, with fixed inputs (no driver:
// the car coasts, except the slow push, which holds the throttle). One substep = 1/120 s,
// as in the game at 60 fps (two physics steps per frame).
//
// Walls: a car comes at a straight wall at 15°, 45° and 90° at 30, 90 and 180 km/h, and
// noses into it at 5 km/h. Both walls: the drift track (a straight bit of «Ночной город»,
// modes/track/geometry.js) and the highway's rail (modes/traffic/geometry.js). From the
// first contact (core/hitlog.js records it), over 0.5 s:
//   in       speed into the wall at the contact (km/h)
//   v 0.1 s / v 0.5 s   speed after (km/h)
//   bounce   how far the car's centre gets from where the wall stops it (m)
//   along    how far it moves along the wall (m, from just before the contact; at 90° and
//            5 km/h: the sideways shift)
//   turn     heading change (°, from just before the contact)
//   contact  substeps in contact with the wall
// Cars (net/bump.js, both cars on one computer, the faster one decides the hit as in the
// game, the other gets its share at once): a coupe at 180 km/h into the back of a stopped
// coupe, one at 60 km/h into the side of a stopped one (at right angles), one pushing a
// stopped one at 20 km/h (throttle held). Over 0.5 s (the push: 1 s) from the first contact:
// speeds, how far the hit car moved along and across the striking car's line, spin, the
// largest push out in one substep, how many substeps changed the velocities (a non-zero
// impulse: once a contact has handed out what its closing speed allows, the rest are zero).
//
// Shortcuts: a scripted driver takes every shortcut of every map, along its centre line and
// along each edge (the car's side on the asphalt edge: centre half - 1 m off the middle) and
// each curb (its side on the outer edge of the 0.5 m curb, 0.15 m inside the wall's limit),
// eased in over the first and out over the last 8 m, at the speed its tightest bend allows.
// Every wall contact is counted: where and how hard.
//   npm run test:walls
import { createRequire } from 'node:module';
const R = new URL('../../../', import.meta.url).href;
globalThis.THREE = createRequire(new URL('package.json', R))('three');
const { stepCar } = await import(R + 'public/js/core/physics.js');
const T = await import(R + 'public/js/modes/track/geometry.js');
const H = await import(R + 'public/js/modes/traffic/geometry.js');
const B = await import(R + 'public/js/net/bump.js');
const { HITLOG } = await import(R + 'public/js/core/hitlog.js');
const { carById } = await import(R + 'public/js/core/cars.js');
const { WALL_ALLOW } = await import(R + 'public/js/core/contact.js');
const { MAPS, MAP_IDS } = await import(R + 'public/js/modes/track/maps/index.js');

const DT = 1 / 120, NONE = { up: 0, down: 0, left: 0, right: 0, hb: 0 }, GAS = { ...NONE, up: 1 };
const hooks = { onWall() {}, onLap() {}, onLand() {}, onTakeoff() {} };
const kmh = v => v * 3.6, deg = r => r * 180 / Math.PI;
const angDiff = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
HITLOG.on = true;

T.setMap('neon');
// a straight piece of track: least heading change over ±60 points (as tests/sync/hits)
let I0 = 0;
{ let best = 1e9;
  for (let i = 0; i < T.N; i += 3) { let turn = 0;
    for (let k = -60; k < 60; k++) { const a = T.TG[(i + k + T.N) % T.N], b = T.TG[(i + k + 1 + T.N) % T.N]; turn += Math.abs(Math.atan2(a.x * b.z - a.z * b.x, a.x * b.x + a.z * b.z)); }
    if (turn < best) { best = turn; I0 = i; } } }

function mkCar(id = 'coupe') {
  return { x: 0, z: 0, h: 0, vx: 0, vz: 0, vF: 0, vR: 0, steer: 0, spinV: 0, off: false, carId: id, spec: carById(id).stats, prog: 0, gate: 0, idx: I0, cut: -1, lastMark: [null, null] };
}
function aim(c, x, z, dx, dz, v) {
  Object.assign(c, { x, z, h: Math.atan2(dx, dz), vx: dx * v, vz: dz * v, vF: v, vR: 0 });
  c.hPrev = c.h;
}

// --- walls ---
// frame: where the wall is. o: origin on the wall's line of travel, t: along it, n: into the
// wall, lim: how far from o (along n) the car's centre is stopped, constrain(car, dt)
const TRACK = (() => {
  const p = T.P[I0], t = T.TG[I0], n = { x: -T.NM[I0].x, z: -T.NM[I0].z };       // the right-hand wall
  return { name: 'track', o: p, t, n, lim: T.WALL - WALL_ALLOW, constrain: (c, dt) => T.constrainToTrack(c, dt, hooks) };
})();
const HIGHWAY = { name: 'highway', o: { x: 0, z: 0 }, t: { x: 0, z: 1 }, n: { x: 1, z: 0 }, lim: H.RAIL - WALL_ALLOW, constrain: (c, dt) => H.constrainToHighway(c, dt, hooks) };

function wallRun(F, angle, speedKmh) {
  const c = mkCar(), v = speedKmh / 3.6, a = angle * Math.PI / 180;
  const dx = F.t.x * Math.cos(a) + F.n.x * Math.sin(a), dz = F.t.z * Math.cos(a) + F.n.z * Math.sin(a);
  const vn = v * Math.sin(a), gap = speedKmh < 10 ? .03 : Math.min(1, vn * .15), back = vn > 0 ? gap / vn * v * Math.cos(a) : 0;
  aim(c, F.o.x + F.n.x * (F.lim - gap) - F.t.x * back, F.o.z + F.n.z * (F.lim - gap) - F.t.z * back, dx, dz, v);
  if (F === TRACK) c.idx = T.nearest(c, true);
  const lat = () => (c.x - F.o.x) * F.n.x + (c.z - F.o.z) * F.n.z, along = () => (c.x - F.o.x) * F.t.x + (c.z - F.o.z) * F.t.z;
  let t0 = -1, vIn = 0, s0 = null, bounce = 0, contacts = 0, v01 = 0, end = null;
  for (let k = 0; k < 240; k++) {
    const seq = HITLOG.seq, h0 = c.h, a0 = along();
    stepCar(c, NONE, DT); F.constrain(c, DT);
    const hit = HITLOG.seq !== seq && HITLOG.last.kind === 'wall';
    if (hit && t0 < 0) { t0 = k; vIn = HITLOG.last.vn; s0 = { along: a0, h: h0 }; }
    if (t0 < 0) continue;
    const dtk = k - t0;
    if (dtk <= 60) { if (hit) contacts++; bounce = Math.max(bounce, F.lim - lat()); }
    if (dtk === 12) v01 = Math.hypot(c.vx, c.vz);
    if (dtk === 60) { end = { v: Math.hypot(c.vx, c.vz), along: along() - s0.along, turn: deg(angDiff(s0.h, c.h)) }; break; }
  }
  if (!end) return { wall: F.name, '°': angle, 'km/h': speedKmh, in: 'no contact' };
  return { wall: F.name, '°': angle, 'km/h': speedKmh, in: kmh(vIn).toFixed(1), 'v 0.1 s': kmh(v01).toFixed(0), 'v 0.5 s': kmh(end.v).toFixed(0),
    'bounce m': bounce.toFixed(2), 'along m': end.along.toFixed(2), 'turn °': end.turn.toFixed(1), contact: contacts };
}

const wallRows = [];
for (const F of [TRACK, HIGHWAY]) {
  for (const angle of [15, 45, 90]) for (const s of [30, 90, 180]) wallRows.push(wallRun(F, angle, s));
  wallRows.push({ ...wallRun(F, 90, 5), '°': '90 nose' });
}
console.log(`Walls (coasting; track: «Ночной город» point ${I0}, right-hand wall; highway: the left rail)`);
console.table(wallRows);

// --- car to car ---
function carRun(kind) {
  const A = mkCar(), Bc = mkCar(), p = T.P[I0], t = T.TG[I0], n = T.NM[I0];
  aim(Bc, p.x, p.z, t.x, t.z, 0);
  const cfg = {
    rear: { kmh: 180, from: [-(4.4 + 50 * .1), 0], dir: t, input: NONE, span: 60 },
    side: { kmh: 60, from: [0, 2.9 + 60 / 3.6 * .1], dir: { x: -n.x, z: -n.z }, input: NONE, span: 60 },
    push: { kmh: 20, from: [-(4.4 + .3), 0], dir: t, input: GAS, span: 120 },
  }[kind];
  const v = cfg.kmh / 3.6;
  aim(A, p.x + t.x * cfg.from[0] + n.x * cfg.from[1], p.z + t.z * cfg.from[0] + n.z * cfg.from[1], cfg.dir.x, cfg.dir.z, v);
  A.idx = T.nearest(A, true); Bc.idx = T.nearest(Bc, true);
  const memA = B.newMem(), mA = B.carMass(A.carId), mB = B.carMass(Bc.carId);
  const d = cfg.dir, side = { x: d.z, z: -d.x };           // A's line of travel and across it
  let t0 = -1, s0 = null, spinA = 0, spinB = 0, push = 0, apps = 0, mid = null, end = null;
  for (let k = 0; k < 400; k++) {
    stepCar(A, cfg.input, DT); T.constrainToTrack(A, DT, hooks);
    stepCar(Bc, NONE, DT); T.constrainToTrack(Bc, DT, hooks);
    const ax = A.x, az = A.z, now = k * DT * 1000;
    const r = B.collideStep(A, Bc, memA, { now, tS: now, mMe: mA, mOther: mB, air: false });
    if (r && r.other) {
      B.applyHit(Bc, r.other, { air: false }); Bc.x += r.push[0]; Bc.z += r.push[1];
      if (Math.hypot(r.other.vx, r.other.vz) > 1e-6 || Math.abs(r.other.w) > 1e-6) apps++;   // (not one scaled to nothing by the contact's cap)
      push = Math.max(push, Math.hypot(r.push[0], r.push[1]));
    }
    if (r) push = Math.max(push, Math.hypot(A.x - ax, A.z - az));
    if (r && r.other && t0 < 0) { t0 = k; s0 = { ax: A.x, az: A.z, bx: Bc.x, bz: Bc.z, bh: Bc.h }; }
    if (t0 < 0) continue;
    spinA = Math.max(spinA, Math.abs(A.spinV)); spinB = Math.max(spinB, Math.abs(Bc.spinV));
    const snap = () => {
      const bdx = Bc.x - s0.bx, bdz = Bc.z - s0.bz, adx = A.x - s0.ax, adz = A.z - s0.az;
      return { vA: kmh(Math.hypot(A.vx, A.vz)), vB: kmh(Math.hypot(Bc.vx, Bc.vz)), bAlong: bdx * d.x + bdz * d.z, bAcross: bdx * side.x + bdz * side.z,
        aAcross: adx * side.x + adz * side.z, turnB: deg(angDiff(s0.bh, Bc.h)), relAcross: (Bc.x - A.x) * side.x + (Bc.z - A.z) * side.z, gap: (Bc.x - A.x) * d.x + (Bc.z - A.z) * d.z };
    };
    if (k - t0 === 60) mid = snap();
    if (k - t0 === cfg.span) { end = snap(); break; }
  }
  if (!end) return { hit: kind, 'km/h': cfg.kmh, at: 'no contact' };
  const row = (label, s) => ({ hit: kind, 'km/h': cfg.kmh, at: label, 'A km/h': s.vA.toFixed(0), 'B km/h': s.vB.toFixed(0), 'B along m': s.bAlong.toFixed(2), 'B across m': s.bAcross.toFixed(2),
    'A across m': s.aAcross.toFixed(2), 'B turn °': s.turnB.toFixed(1), 'spin A/B rad/s': spinA.toFixed(2) + '/' + spinB.toFixed(2), 'push max m': push.toFixed(3), 'non-zero impulses': apps,
    ...(kind === 'push' ? { 'B-A across m': s.relAcross.toFixed(2), 'B-A gap m': s.gap.toFixed(2) } : {}) });
  return cfg.span > 60 ? [row('0.5 s', mid), row('1 s', end)] : [row('0.5 s', end)];
}
console.log('\nCar to car (coupe 1.0 vs coupe 1.0, net/bump.js; A strikes, B stands; across: + to the left of A\'s line)');
console.table(['rear', 'side', 'push'].flatMap(carRun));

// --- shortcuts ---
// The line to drive: the main road's centre for 40 points before the mouth, the shortcut at
// offset off (eased in and out over 8 m), the main road's centre for 25 points after.
function cutPath(sc, off) {
  const { P, N } = T, pts = [];
  for (let k = 40; k >= 1; k--) { const i = (sc.E - k + N) % N; pts.push({ x: P[i].x, z: P[i].z, k: -1 }); }
  for (let k = 0; k < sc.n; k++) { const e = Math.max(0, Math.min(1, sc.d[k] / 8, (sc.len - sc.d[k]) / 8)), o = off * e; pts.push({ x: sc.x[k] + sc.nx[k] * o, z: sc.z[k] + sc.nz[k] * o, k }); }
  for (let k = 1; k <= 25; k++) { const i = (sc.X + k) % N; pts.push({ x: P[i].x, z: P[i].z, k: sc.n }); }
  return pts;
}
// the tightest radius on the shortcut part of the line (three points 4 apart)
function minRadius(pts) {
  let r = 1e9;
  for (let i = 4; i < pts.length - 4; i++) { if (pts[i].k < 0 || pts[i].k >= 1e9) continue;
    const a = pts[i - 4], b = pts[i], c = pts[i + 4], ab = Math.hypot(b.x - a.x, b.z - a.z), bc = Math.hypot(c.x - b.x, c.z - b.z), ca = Math.hypot(a.x - c.x, a.z - c.z);
    const cross = Math.abs((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
    if (cross > 1e-9) r = Math.min(r, ab * bc * ca / (2 * cross)); }
  return r;
}
// The speed a bend of radius R allows: the turn rate stepCar gives at full lock,
// 2.35 / (1 + v/55) rad/s, must reach v / R; 70 % of it, the rest for correcting. Capped at 180 km/h.
const bendSpeed = R => Math.min(50, 27.5 * (-1 + Math.sqrt(1 + 4 * .7 * 2.35 * R / 55)));
const segDist = (p, a, b) => { const ex = b.x - a.x, ez = b.z - a.z, l = ex * ex + ez * ez || 1, f = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / l));
  return Math.hypot(p.x - a.x - ex * f, p.z - a.z - ez * f); };
function cutRun(sc, line, off) {
  const pts = cutPath(sc, off), R = minRadius(pts), v = bendSpeed(R), c = mkCar();
  T.placeAt(c, (sc.E - 40 + T.N) % T.N); c.prog = 0; c.gate = 0;
  c.vx = Math.sin(c.h) * v; c.vz = Math.cos(c.h) * v; c.vF = v;
  const I = { ...NONE }; let j = 0, err = 0, events = [], last = -1e9, t = 0, vMin = v;
  while (j < pts.length - 3 && t < 40) {
    // where on the line: the nearest point a little ahead of the last
    let bj = j, bd = 1e18; for (let q = j; q < Math.min(pts.length, j + 30); q++) { const d = (pts[q].x - c.x) ** 2 + (pts[q].z - c.z) ** 2; if (d < bd) { bd = d; bj = q; } } j = bj;
    const sp = Math.hypot(c.vx, c.vz), tg = pts[Math.min(pts.length - 1, j + Math.max(3, Math.round(sp * .2)))];
    const e = angDiff(c.h, Math.atan2(tg.x - c.x, tg.z - c.z));
    I.left = e > .01 ? 1 : 0; I.right = e < -.01 ? 1 : 0;
    I.up = sp < v - .5 ? 1 : 0; I.down = sp > v + 1.5 ? 1 : 0;
    if (pts[j].k >= 0 && pts[j].k < sc.n) {
      const a = pts[Math.max(0, j - 1)], b = pts[j], d = pts[Math.min(pts.length - 1, j + 1)];
      err = Math.max(err, Math.min(segDist(c, a, b), segDist(c, b, d))); vMin = Math.min(vMin, sp); }
    const seq = HITLOG.seq;
    if (!c.air) stepCar(c, I, DT);
    T.constrainToTrack(c, DT, hooks);
    t += DT;
    if (HITLOG.seq !== seq && HITLOG.last.kind === 'wall') {
      const L = HITLOG.last, k = pts[j].k, where = k < 0 ? 'before' : k >= sc.n ? 'after' : k < sc.n / 2 ? `in, ${k} m` : `out, ${Math.round(sc.len - sc.d[k])} m`;
      if (t - last > .2) events.push({ where, x: L.x, z: L.z, vn: L.vn }); else { const E = events[events.length - 1]; E.vn = Math.max(E.vn, L.vn); }
      last = t;
    }
  }
  const hard = events.reduce((m, E) => Math.max(m, E.vn), 0);
  return { map: T.MAP.id, cut: sc.k, line, 'R min m': R.toFixed(1), 'km/h': kmh(v).toFixed(0), contacts: events.length,
    'hardest km/h': events.length ? kmh(hard).toFixed(1) : '—', where: events.slice(0, 3).map(E => `${E.where} (${E.x.toFixed(0)}, ${E.z.toFixed(0)}) ${kmh(E.vn).toFixed(0)}`).join('; ') || '—',
    'off line m': err.toFixed(2), 'min km/h': kmh(vMin).toFixed(0), 'exit km/h': kmh(Math.hypot(c.vx, c.vz)).toFixed(0), done: j >= pts.length - 3 ? 'yes' : 'no' };
}
const cutRows = [], none = [];
for (const id of MAP_IDS) {
  T.setMap(id);
  if (!T.SHORTCUTS.length) { none.push(MAPS[id].name); continue; }
  for (const sc of T.SHORTCUTS) for (const [line, off] of [['centre', 0], ['left edge', sc.half - 1], ['right edge', -(sc.half - 1)], ['left curb', sc.half - .5], ['right curb', -(sc.half - .5)]]) cutRows.push(cutRun(sc, line, off));
}
console.log(`\nShortcuts (coupe, scripted along the line; contacts: wall touches 0.2 s apart; where: in/out = metres from the shortcut's start/end, x z, km/h into the wall). No shortcuts: ${none.join(', ')}`);
console.table(cutRows);
