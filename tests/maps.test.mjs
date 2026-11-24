// The map validator (track engine v2, modes/track/). Every map in maps/index.js must:
//  - have a lap of a sensible length;
//  - keep the centre-line radius at least WALL + 2 m (a car fits round the inside wall);
//  - never cross itself without at least 6 m of height between the two roads (on a map with
//    stacked levels, a car park: 3.2 m clear under the slab or deck between them);
//  - keep grades within 12 %, and the ramps up to a bridge within 8 %;
//  - lean its banks into the turn;
//  - start on a straight;
//  - be driven round by a simple bot without getting stuck.
// A map may be exempt from a rule only with a reason in its `exempt` field («Ночной город»:
// its points are frozen by the physics golden test, and its two hairpins are ~10 m).
// Then the engine itself: offset lines that never fold, jumps, slopes, bridges.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.THREE = createRequire(import.meta.url)('three');
const { stepCar } = await import('../public/js/core/physics.js');
const T = await import('../public/js/modes/track/geometry.js');
const { MAPS, MAP_IDS, DEFAULT_MAP } = await import('../public/js/modes/track/maps/index.js');
const IDS = Object.keys(MAPS);

const ang = (a, b) => { const t = Math.PI * 2; return (((b - a + Math.PI) % t) + t) % t - Math.PI; };
// The bots' way out when stopped facing a wall (plan 3 stage 3: a wall no longer turns a car
// pressed into it parallel to itself; a car stopped nose-first against it stays so, as a real
// one would): reverse, steering the other way, as a driver would.
// For a second, then it tries again. (Slow facing away from where it aims, or pressing on
// the throttle and getting nowhere for half a second.)
let backUntil = -1, stuckSince = -1;
function unstick(I, sp, err, t) {
  if (t < 3) { backUntil = stuckSince = -1; return; }
  if (sp >= 1) stuckSince = -1; else if (stuckSince < 0) stuckSince = t;
  const pinned = stuckSince >= 0 && t - stuckSince > .5;
  if (t >= backUntil && !pinned && (sp >= 4 || Math.abs(err) < .6)) return;
  if (t >= backUntil) { backUntil = t + 1; stuckSince = -1; }
  I.up = 0; I.down = 1; const l = I.left; I.left = I.right; I.right = l;
}
const around = (i, metres, fn) => {           // fn(j) for the track points within ±metres of i
  for (const dir of [1, -1]) { let j = i, d = 0; while (d <= metres) { fn(j); const k = (j + dir + T.N) % T.N; d += T.HL[dir > 0 ? j : k]; j = k; } }
};

test('maps/meta.js (what the server knows) matches the maps and their geometry', async () => {
  const { MAP_META, mapAllowed, DEFAULT_MAP: SERVER_DEFAULT } = await import('../public/js/modes/track/maps/meta.js');
  assert.deepEqual(Object.keys(MAP_META).sort(), [...IDS].sort(), 'the same map ids');
  assert.equal(SERVER_DEFAULT, DEFAULT_MAP);
  for (const id of IDS) {
    T.setMap(id);
    assert.equal(MAP_META[id].name, MAPS[id].name, `${id}: name`);
    assert.equal(!!MAP_META[id].hidden, !!MAPS[id].hidden, `${id}: hidden`);
    assert.ok(Math.abs(MAP_META[id].len - T.TRACK_LEN) < 1, `${id}: lap ${MAP_META[id].len} m in meta.js, ${T.TRACK_LEN.toFixed(1)} m built`);
    assert.ok(Math.abs(MAP_META[id].min - T.LAP_MIN) < 1, `${id}: shortest legal lap ${MAP_META[id].min} m in meta.js, ${T.LAP_MIN.toFixed(1)} m built`);
    assert.ok(T.LAP_MIN <= T.TRACK_LEN && (T.SHORTCUTS.length || T.LAP_MIN === T.TRACK_LEN));
  }
  for (const bad of ['__proto__', 'toString', 'constructor', 'nope', '', null]) {
    assert.ok(!mapAllowed(bad, true), `${bad} is no map`);
    assert.equal(T.setMap(bad).id, DEFAULT_MAP, `setMap(${bad}) falls back to «Ночной город»`);
  }
  assert.ok(!mapAllowed('_testhill') && mapAllowed('_testhill', true) && mapAllowed('neon'));
});

test('the maps list', () => {
  assert.ok(MAPS[DEFAULT_MAP] && MAP_IDS[0] === 'neon', '«Ночной город» first');
  assert.ok(!MAP_IDS.includes('_testhill'), 'the test map is not offered to players');
  for (const id of IDS) {
    const m = MAPS[id];
    assert.equal(m.id, id);
    assert.ok(m.name && m.desc && m.points.length >= 4, `${id}: name, description, points`);
    for (const p of m.points) assert.ok(p.length >= 2 && p.length <= 4 && p.every(Number.isFinite), `${id}: point ${p}`);
  }
});

for (const id of IDS) {
  const ex = MAPS[id].exempt || {};
  test(`map ${id}: lap length, radius, crossings, grades, banks, start`, () => {
    T.setMap(id);
    assert.ok(T.TRACK_LEN > 600 && T.TRACK_LEN < 5000, `lap ${T.TRACK_LEN.toFixed(0)} m`);
    // radius
    let rmin = Infinity, at = 0; T.RAD.forEach((r, i) => { if (Math.abs(r) < rmin) { rmin = Math.abs(r); at = i; } });
    if (!ex.radius) assert.ok(rmin >= T.WALL + 2, `${id}: radius ${rmin.toFixed(1)} m at point ${at}, needs ${T.WALL + 2}`);
    else assert.ok(rmin > T.HALF, `${id} (exempt from the radius rule) still keeps the road itself from folding: ${rmin.toFixed(1)} m`);
    // crossings: any two pieces of road whose walls overlap must be 6 m apart in height
    const gap = Math.ceil(4 * T.WALL / (T.TRACK_LEN / T.N));
    let crossings = 0;
    for (let i = 0; i < T.N; i += 2) for (let j = i + gap; j < T.N; j += 2) {
      if (T.N - (j - i) < gap) continue;
      const d = Math.hypot(T.P[i].x - T.P[j].x, T.P[i].z - T.P[j].z);
      if (d >= 2 * T.WALL) continue;
      const dy = Math.abs(T.Y[i] - T.Y[j]);
      if (MAPS[id].levels && dy < 6) { crossings++; continue; }     // stacked levels: checked below, by the slab between them
      if (!ex.crossing) assert.ok(dy >= 6, `${id}: points ${i} and ${j} are ${d.toFixed(1)} m apart with only ${dy.toFixed(1)} m of height between them`);
      crossings++;
    }
    // grades: 12 % anywhere, 8 % on a raised stretch that carries a bridge (its ramps)
    const ramp = new Uint8Array(T.N);
    for (let i = 0; i < T.N; i++) if (T.BRIDGE[i]) {
      for (const dir of [1, -1]) { let j = i; while (T.Y[j] > .3 && !ramp[j]) { ramp[j] = 1; j = (j + dir + T.N) % T.N; } }
    }
    let gmax = 0, rmax = 0;
    for (let i = 0; i < T.N; i++) { const g = Math.abs(T.GR[i]); gmax = Math.max(gmax, g); if (ramp[i]) rmax = Math.max(rmax, g); }
    assert.ok(gmax <= .12, `${id}: grade ${(gmax * 100).toFixed(1)} %`);
    assert.ok(rmax <= .08, `${id}: a bridge ramp at ${(rmax * 100).toFixed(1)} %`);
    // a bridge is high enough over what it crosses (checked above) and only where it is raised
    for (let i = 0; i < T.N; i++) if (T.BRIDGE[i]) assert.ok(T.Y[i] > 1.5, `${id}: bridge point ${i} at ${T.Y[i].toFixed(1)} m`);
    // banks lean into the turn: > 0 lifts the left edge, which is the outside of a right-hander (RAD > 0)
    for (let i = 0; i < T.N; i++) if (Math.abs(T.BANK[i]) > 1 * Math.PI / 180 && Math.abs(T.RAD[i]) < 200)
      assert.ok(Math.sign(T.BANK[i]) === Math.sign(T.RAD[i]), `${id}: point ${i} is banked the wrong way`);
    // start on a straight: no radius under 50 m within 25 m of the line
    if (!ex.start) around(T.START, 25, j => assert.ok(Math.abs(T.RAD[j]) >= 50, `${id}: the start is in a turn (radius ${T.RAD[j].toFixed(0)} m at point ${j})`));
    assert.ok(Math.abs(T.Y[T.START]) < 5 && Math.abs(T.GR[T.START]) < .03, `${id}: the start is level`);
    console.log(`${id}: lap ${T.TRACK_LEN.toFixed(0)} m, ${T.N} points, min radius ${rmin.toFixed(1)} m, max grade ${(gmax * 100).toFixed(1)} % (ramps ${(rmax * 100).toFixed(1)} %), height ${Math.min(...T.Y).toFixed(1)}..${Math.max(...T.Y).toFixed(1)} m, ${crossings ? 'a crossing' : 'no crossings'}`);
  });

  test(`map ${id}: a simple bot drives two laps without getting stuck`, () => {
    T.setMap(id);
    const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,spinV:0};
    T.placeGrid(car, 0);
    const laps = []; let t = 0, slow = 0, worst = 0, jumps = 0; const dt = 1 / 120, look = 26, f = 2.2;
    const hooks = { onWall() {}, onLap: () => laps.push(t), onLand() { jumps++; } };
    const I = { up: 0, down: 0, left: 0, right: 0, hb: 0 };
    while (laps.length < 2 && t < 240) {
      // it aims 26 points ahead, but never further round than 115° of turn (in a 12 m helix
      // 42 m ahead lies behind the core)
      let n = 0, turn = 0;
      while (n < look) { const j = (car.idx + n) % T.N, k = (j + 1) % T.N; turn += Math.abs(ang(Math.atan2(T.TG[j].x, T.TG[j].z), Math.atan2(T.TG[k].x, T.TG[k].z))); if (turn > 2) break; n++; }
      const a = (car.idx + Math.max(6, n)) % T.N, far = (car.idx + look * 3) % T.N;
      const toA = Math.atan2(T.P[a].x - car.x, T.P[a].z - car.z), err = ang(car.h, toA);
      const bend = Math.abs(ang(toA, Math.atan2(T.P[far].x - T.P[a].x, T.P[far].z - T.P[a].z)));
      const sp = Math.hypot(car.vx, car.vz), tooFast = sp > f * (20 + 45 * (1 - Math.min(1, bend / 1.2)));
      I.left = err > 0.03 ? 1 : 0; I.right = err < -0.03 ? 1 : 0;
      I.up = !tooFast && Math.abs(err) < 0.6 ? 1 : 0; I.down = tooFast && sp > 18 ? 1 : 0;
      unstick(I, sp, err, t);
      if (!car.air) stepCar(car, I, dt);
      T.constrainToTrack(car, dt, hooks); t += dt;
      slow = sp < 2 && t > 3 ? slow + dt : 0; worst = Math.max(worst, slow);
      assert.ok(Number.isFinite(car.x) && Number.isFinite(car.y ?? 0), 'the car stays finite');
    }
    assert.equal(laps.length, 2, `${id}: the bot did ${laps.length} laps in ${t.toFixed(0)} s`);
    assert.ok(worst < 2, `${id}: stuck for ${worst.toFixed(1)} s`);
    console.log(`${id}: bot lap ${(laps[1] - laps[0]).toFixed(1)} s, ${jumps} landings`);
  });
}

// A route through the lap from the start line: the main road, or through the given
// shortcuts. One point per ~1 m: x, z, and the radius there (from the turn over ±4 m).
// grass: shortcuts not taken but cut "over the grass" instead: past each of them the
// route runs on the verge on the shortcut's side, as far in as the walls allow.
function route(useCuts, grass = []) {
  const xs = [], zs = [], push = (x, z) => { const n = xs.length; if (!n || Math.hypot(x - xs[n - 1], z - zs[n - 1]) > .2) { xs.push(x); zs.push(z); } };
  const cuts = T.SHORTCUTS.filter(s => useCuts.includes(s.k));
  const off = new Float64Array(T.N);
  for (const s of T.SHORTCUTS.filter(s => grass.includes(s.k))) {
    const m = s.x.length >> 1, j = T.nearest({ x: s.x[m], z: s.z[m], idx: 0 }, true);
    const side = Math.sign((s.x[m] - T.P[j].x) * T.NM[j].x + (s.z[m] - T.P[j].z) * T.NM[j].z) || 1;
    const lim = T.safeOffsets(side * (T.WALL - 2.5));
    for (let k = 0; k <= s.span; k++) { const i = (s.E + k) % T.N, ramp = Math.min(1, k / 15, (s.span - k) / 15);
      off[i] = Math.sign(lim[i]) * Math.min(Math.abs(lim[i]), T.HALF + T.CURB + 4) * ramp; }
  }
  for (let k = 0, i = T.START; k < T.N; k++, i = (i + 1) % T.N) {
    const s = cuts.find(c => c.E === i);
    if (s) { for (let q = 0; q < s.n; q++) push(s.x[q], s.z[q]); k += s.span - 1; i = (s.X - 1 + T.N) % T.N; continue; }
    push(T.P[i].x + T.NM[i].x * off[i], T.P[i].z + T.NM[i].z * off[i]);
  }
  const n = xs.length, r = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 4 + n) % n, b = (i + 4) % n, c = i;
    const h1 = Math.atan2(zs[c] - zs[a], xs[c] - xs[a]), h2 = Math.atan2(zs[b] - zs[c], xs[b] - xs[c]);
    const turn = Math.abs(ang(h1, h2)), len = Math.hypot(xs[b] - xs[a], zs[b] - zs[a]);
    r[i] = turn < 1e-6 ? 1e6 : len / turn;
  }
  return { xs, zs, r, n };
}
// A bot that follows a route: steers at a point 7 m ahead, and keeps every corner ahead
// within 7 m/s² of side grip (braking at 6 m/s²). Returns the lap times and what it met.
function followRoute(R, laps = 2, maxT = 300) {
  const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,spinV:0};
  T.placeGrid(car, 0); car.x = T.P[T.START].x; car.z = T.P[T.START].z;
  const out = { laps: [], cuts: new Set(), walls: 0, worst: 0, t: 0 };
  const hooks = { onWall() { out.walls++; }, onLap: () => out.laps.push(out.t), onLand() {} };
  const I = { up: 0, down: 0, left: 0, right: 0, hb: 0 }, dt = 1 / 120;
  let ri = 0, slow = 0;
  // start a little behind the line, on the route
  while (out.laps.length < laps && out.t < maxT) {
    let bi = ri, bd = 1e18;
    for (let k = -5; k <= 30; k++) { const j = (ri + k + R.n) % R.n, d = (R.xs[j] - car.x) ** 2 + (R.zs[j] - car.z) ** 2; if (d < bd) { bd = d; bi = j; } }
    ri = bi;
    const sp = Math.hypot(car.vx, car.vz), look = Math.max(5, Math.min(12, sp * .3));
    let a = ri, d = 0; while (d < look) { const b = (a + 1) % R.n; d += Math.hypot(R.xs[b] - R.xs[a], R.zs[b] - R.zs[a]); a = b; }
    const err = ang(car.h, Math.atan2(R.xs[a] - car.x, R.zs[a] - car.z));
    let allow = 1e9; d = 0;
    for (let k = 0, j = ri; k < 160; k++) { const b = (j + 1) % R.n; d += Math.hypot(R.xs[b] - R.xs[j], R.zs[b] - R.zs[j]); j = b;
      allow = Math.min(allow, Math.sqrt(7 * R.r[j] + 2 * 6 * d)); }
    I.left = err > .02 ? 1 : 0; I.right = err < -.02 ? 1 : 0;
    I.up = sp < allow - 1 && Math.abs(err) < .7 ? 1 : 0; I.down = sp > allow + 1 ? 1 : 0;
    if (!car.air) stepCar(car, I, dt);
    T.constrainToTrack(car, dt, hooks); out.t += dt;
    if (car.cut >= 0) out.cuts.add(car.cut);
    slow = sp < 2 && out.t > 3 ? slow + dt : 0; out.worst = Math.max(out.worst, slow);
  }
  return out;
}

for (const id of IDS.filter(id => (MAPS[id].shortcuts || []).length)) test(`map ${id}: shortcuts are narrow cut-throughs, and a lap through them counts`, () => {
  T.setMap(id);
  for (const s of T.SHORTCUTS) {
    assert.ok(s.half * 2 >= 4 && s.half * 2 <= 6, `${id}: shortcut ${s.k} is ${2 * s.half} m wide`);
    assert.ok(s.saves > 20, `${id}: shortcut ${s.k} saves ${s.saves.toFixed(0)} m`);
    // it leaves the main road's walls once and comes back once: inside them only at its two ends
    let runs = 0, prev = true;
    for (let k = 0; k < s.n; k++) {
      const j = T.nearest({ x: s.x[k], z: s.z[k], idx: 0 }, true), d = Math.hypot(s.x[k] - T.P[j].x, s.z[k] - T.P[j].z);
      const inside = d < T.WALL; if (inside && !prev) runs++; prev = inside;
    }
    assert.equal(runs, 1, `${id}: shortcut ${s.k} crosses the main road's walls only at its ends`);
    for (const g of T.GATES) assert.ok(((g - s.E + T.N) % T.N) > s.span, `${id}: checkpoint ${g} lies on the stretch shortcut ${s.k} skips`);
  }
  const main = followRoute(route([])), cut = followRoute(route(T.SHORTCUTS.map(s => s.k)));
  for (const r of [main, cut]) { assert.equal(r.laps.length, 2, `${id}: ${r.laps.length} laps in ${r.t.toFixed(0)} s`); assert.ok(r.worst < 2, `${id}: stuck ${r.worst.toFixed(1)} s`); }
  assert.equal(main.cuts.size, 0);
  assert.equal(cut.cuts.size, T.SHORTCUTS.length, `${id}: the bot went through every shortcut`);
  const lap = r => r.laps[1] - r.laps[0], lm = lap(main), lc = lap(cut);
  // each shortcut on its own: worth taking; cutting the same corner over the grass is not
  const each = T.SHORTCUTS.map(s => { const r = followRoute(route([s.k])), g = followRoute(route([], [s.k]));
    assert.equal(g.laps.length, 2, `${id}: the grass route laps`);
    return { k: s.k, saves: lm - lap(r), grass: lm - lap(g) }; });
  for (const e of each) {
    // («Серпантин»'s: each worth 1 s or more to a careful driver)
    if (id === 'serpantin') assert.ok(e.saves > 1, `${id}: shortcut ${e.k} saves only ${e.saves.toFixed(2)} s`);
    assert.ok(e.grass < e.saves, `${id}: over the grass beside shortcut ${e.k}: ${e.grass.toFixed(2)} s against ${e.saves.toFixed(2)} s through it`);
  }
  assert.ok(lc < lm, `${id}: ${lc.toFixed(1)} s through the shortcuts, ${lm.toFixed(1)} s round`);
  console.log(`${id}: route bot lap ${lm.toFixed(1)} s on the main road (${main.walls} wall hits), ${lc.toFixed(1)} s through ${T.SHORTCUTS.length} shortcuts (${cut.walls} wall hits); each saves ${each.map(e => e.saves.toFixed(1) + ' s (over the grass ' + e.grass.toFixed(1) + ' s)').join(', ')}; shortest legal lap ${T.LAP_MIN.toFixed(0)} m of ${T.TRACK_LEN.toFixed(0)}`);
});

test('another player\'s car predicted just past a shortcut\'s wall is put back against that wall', async () => {
  const C = await import('../public/js/core/contact.js'), { worldPoly } = await import('../public/js/core/hitboxes.js'), NB = [], CON = {};
  T.setMap('serpantin');
  for (const sc of T.SHORTCUTS) {
    // the middle of the shortcut, outside the main road's walls
    let k = sc.n >> 1;
    const j = T.nearest({ x: sc.x[k], z: sc.z[k], idx: 0 }, true);
    assert.ok(Math.hypot(sc.x[k] - T.P[j].x, sc.z[k] - T.P[j].z) > T.WALL, 'the middle is off the main road');
    // (plan 3 stage 3: its hitbox, heading along the shortcut, ends up against the drawn wall, not
    // in it; beside the main road the drawn wall can stand further out than the shortcut's own)
    const h = Math.atan2(sc.tx[k], sc.tz[k]);
    for (const extra of [.05, .5, 1.5]) for (const side of [1, -1]) {
      const lat = side * (sc.lim + extra), p = { x: sc.x[k] + sc.nx[k] * lat, z: sc.z[k] + sc.nz[k] * lat, h, idx: j };
      T.keepInWalls(p, {});
      const back = (p.x - sc.x[k]) * sc.nx[k] + (p.z - sc.z[k]) * sc.nz[k], moved = Math.hypot(p.x - (sc.x[k] + sc.nx[k] * lat), p.z - (sc.z[k] + sc.nz[k] * lat));
      const B = C.bodyOf(undefined), P = worldPoly(B.id, p.x, p.z, h), nn = T.wallsNear(p.x, p.z, NaN, B.r + 2, NB), d = C.wallContact(T.WALLS, NB, nn, P, B.nv, p.x, p.z, B.r, 3, CON) ? CON.depth : 0;
      assert.ok(d < 1e-6 && moved <= extra + .01, `shortcut ${sc.k}: ${extra} m past its wall the car moved ${moved.toFixed(2)} m (now ${back.toFixed(2)} m off its centre, ${(d * 100).toFixed(1)} cm in the wall)`);
    }
  }
  T.setMap('neon');
});

test('a lap that skips a section of track does not count; one that drives it does', () => {
  T.setMap('serpantin');
  const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,spinV:0};
  let laps = 0; const hooks = { onWall() {}, onLap() { laps++; }, onLand() {} };
  // glide along the centre line point by point from behind the start line round the lap
  const glide = (from, to) => { for (let i = from; i !== to; i = (i + 1) % T.N) { car.x = T.P[i].x; car.z = T.P[i].z; T.constrainToTrack(car, 1 / 120, hooks); } };
  T.placeGrid(car, 0);
  glide(car.idx, T.START); glide(T.START, (T.START - 5 + T.N) % T.N); glide((T.START - 5 + T.N) % T.N, (T.START + 5) % T.N);
  assert.equal(laps, 1, 'a whole lap driven counts');
  // now jump over a third of the lap (teleport: the track point moves 120 points at once
  // while car.prog is pushed on as far), then drive on over the line
  const g = T.GATES[Math.floor(T.GATES.length / 2)];
  glide((T.START + 5) % T.N, (g - 70 + T.N) % T.N);
  car.x = T.P[(g + 70) % T.N].x; car.z = T.P[(g + 70) % T.N].z; car.idx = (g + 70) % T.N; car.prog += 140;
  glide((g + 70) % T.N, (T.START + 5) % T.N);
  assert.equal(laps, 1, 'the lap that skipped a checkpoint does not count');
  assert.ok(car.prog < T.N && car.gate === 0, 'and the next lap starts at the line as usual');
  // the next two honest laps each end exactly at the start line
  const at = []; hooks.onLap = () => { laps++; at.push(car.idx); };
  glide((T.START + 5) % T.N, T.START); glide(T.START, (T.START + 5) % T.N);
  glide((T.START + 5) % T.N, T.START); glide(T.START, (T.START + 5) % T.N);
  assert.equal(laps, 3);
  for (const i of at) assert.ok(Math.abs(i - T.START) <= 1, `a lap ended at point ${i}, the line is at ${T.START}`);
  T.setMap('neon');
});

test('wide verges: clearly slow but driveable (108 → 55-65 km/h in 1 s coasting)', () => {
  for (const id of IDS.filter(id => MAPS[id].vergeDrag)) {
    T.setMap(id);
    let i = 0, best = 0, bi = 0;     // the straightest stretch
    for (i = 0; i < T.N; i++) { let m = Infinity; for (let k = 0; k < 30; k++) m = Math.min(m, Math.abs(T.RAD[(i + k) % T.N])); if (m > best && Math.abs(T.GR[i]) < .01) { best = m; bi = i; } }
    const coast = lat => {
      const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,spinV:0};
      T.placeAt(car, bi); car.x += T.NM[bi].x * lat; car.z += T.NM[bi].z * lat;
      const v = 30; car.vx = T.TG[bi].x * v; car.vz = T.TG[bi].z * v; car.vF = v;
      for (let t = 0; t < 1; t += 1 / 120) { stepCar(car, { up: 0, down: 0, left: 0, right: 0, hb: 0 }, 1 / 120); T.constrainToTrack(car, 1 / 120, { onWall() {}, onLap() {} }); }
      return Math.hypot(car.vx, car.vz) * 3.6;
    };
    const road = coast(0), grass = coast(T.HALF + T.CURB + 2);
    assert.ok(grass >= 55 && grass <= 65 && grass < road - 10, `${id}: after 1 s coasting from 108 km/h: ${road.toFixed(0)} km/h on the road, ${grass.toFixed(0)} on the verge`);
    console.log(`${id} verge: after 1 s coasting from 108 km/h: ${road.toFixed(0)} km/h on the road, ${grass.toFixed(0)} km/h on the verge (drag ${T.VDRAG}/s)`);
  }
  T.setMap('neon');
});

test('curbs, run-off and walls never fold, even round «Ночной город»\'s 10 m hairpins', () => {
  for (const id of IDS) {
    T.setMap(id);
    for (const base of [T.HALF, T.HALF + T.CURB, T.WALL, T.WALL + 1.3]) for (const s of [1, -1]) {
      const O = T.safeOffsets(s * base);
      for (let i = 0; i < T.N; i++) {
        const j = (i + 1) % T.N, r = T.RAD[i];
        if (O[i] * r < 0) assert.ok(Math.abs(O[i]) <= .9 * Math.abs(r) + 1e-9, `${id}: offset ${O[i].toFixed(2)} at radius ${r.toFixed(1)}`);
        const ax = T.P[i].x + T.NM[i].x * O[i], az = T.P[i].z + T.NM[i].z * O[i];
        const bx = T.P[j].x + T.NM[j].x * O[j], bz = T.P[j].z + T.NM[j].z * O[j];
        assert.ok((bx - ax) * T.TG[i].x + (bz - az) * T.TG[i].z > 0, `${id}: the line at ${(s * base).toFixed(1)} m steps backwards at point ${i}`);
      }
      // the road itself and the outside are never narrowed
      if (base === T.HALF) for (let i = 0; i < T.N; i++) if (O[i] * T.RAD[i] >= 0 || Math.abs(T.RAD[i]) > 60) assert.equal(O[i], s * base);
    }
  }
  T.setMap('neon');
  const O = T.safeOffsets(-Math.sign(T.RAD[680]) * T.WALL), r = Math.abs(T.RAD[680]);   // the inside of that hairpin
  assert.ok(Math.abs(O[680]) < r, `the inside wall at the tightest hairpin is pulled in to ${Math.abs(O[680]).toFixed(1)} m (radius ${r.toFixed(1)} m)`);
});

// The test map's crest («Тестовый холм», maps/_testhill.js): drive at a held speed along
// the centre of the first straight, over the crest.
function overCrest(kmh) {
  T.setMap('_testhill');
  const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,spinV:0};
  const i0 = T.sampleAt(1); T.placeAt(car, i0);
  const v = kmh / 3.6; car.vx = T.TG[i0].x * v; car.vz = T.TG[i0].z * v; car.vF = v;
  let take = null, land = null, peak = 0, t = 0; const dt = 1 / 240;
  const hooks = { onWall() {}, onLap() {}, onTakeoff() { take = { x: car.x, z: car.z, y: car.y, vy: car.vy, vh: Math.hypot(car.vx, car.vz), t, idx: car.idx }; },
    onLand(p) { land = { x: car.x, z: car.z, p, t, vh: Math.hypot(car.vx, car.vz) }; } };
  const end = T.sampleAt(MAPS._testhill.crest.at) + 60;
  while (!land && car.idx < end && t < 5) {
    if (!car.air) stepCar(car, { up: Math.hypot(car.vx, car.vz) < v ? 1 : 0, down: 0, left: 0, right: 0, hb: 0 }, dt);
    T.constrainToTrack(car, dt, hooks); t += dt;
    if (car.air) peak = Math.max(peak, car.y - T.surface(car).y);
  }
  return { take, land, peak };
}
test('a jump: over the crest at 150 km/h the car flies as far as ballistics says, at 60 km/h it stays down', () => {
  assert.equal(overCrest(60).take, null, 'at 60 km/h the wheels stay on the road');
  const { take, land, peak } = overCrest(150);
  assert.ok(take && land, 'at 150 km/h the car takes off and lands');
  const flown = Math.hypot(land.x - take.x, land.z - take.z);
  // ballistics from the take-off state: y(t) = y0 + vy·t - g t²/2 until it meets the road,
  // straight ahead at the horizontal take-off speed
  const dir = T.TG[take.idx], probe = { x: 0, z: 0, idx: take.idx };
  let tt = 0; const h = 1e-4;
  for (;;) { tt += h; probe.x = take.x + dir.x * take.vh * tt; probe.z = take.z + dir.z * take.vh * tt; probe.idx = T.nearest(probe, false);
    if (take.y + take.vy * tt - T.GRAV / 2 * tt * tt <= T.surface(probe).y) break; }
  const want = take.vh * tt;
  assert.ok(Math.abs(flown - want) < .02 * want, `flew ${flown.toFixed(2)} m, ballistics ${want.toFixed(2)} m`);
  assert.ok(Math.abs((land.t - take.t) - tt) < .01, `in the air ${(land.t - take.t).toFixed(3)} s, ballistics ${tt.toFixed(3)} s`);
  assert.ok(flown > 20 && peak > .4, `a real jump: ${flown.toFixed(1)} m long, ${peak.toFixed(2)} m above the road`);
  assert.ok(land.p > T.AIR.HARD && land.vh < 150 / 3.6, `a hard landing (${land.p.toFixed(1)} m/s) costs speed: ${(land.vh * 3.6).toFixed(1)} km/h`);
  console.log(`jump at 150 km/h: ${flown.toFixed(2)} m (ballistics ${want.toFixed(2)}), ${(land.t - take.t).toFixed(2)} s, ${peak.toFixed(2)} m high, lands at ${land.p.toFixed(1)} m/s and ${(land.vh * 3.6).toFixed(1)} km/h`);
});

test('«Эстакада»: the crest on the way down from the bridge gives a small jump at speed, none at 100 km/h', () => {
  T.setMap('estakada');
  const fly = kmh => {
    const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,spinV:0};
    const c = T.sampleAt(MAPS.estakada.crest.at), i0 = c - 25; T.placeAt(car, i0);
    const v = kmh / 3.6; car.vx = T.TG[i0].x * v; car.vz = T.TG[i0].z * v; car.vF = v;
    let take = null, land = null, t = 0;
    const hooks = { onWall() {}, onLap() {}, onTakeoff() { take = { x: car.x, z: car.z, t }; }, onLand(p) { land = { x: car.x, z: car.z, t, p }; } };
    while (!land && car.idx < c + 60 && t < 5) {
      if (!car.air) stepCar(car, { up: Math.hypot(car.vx, car.vz) < v ? 1 : 0, down: 0, left: 0, right: 0, hb: 0 }, 1 / 240);
      T.constrainToTrack(car, 1 / 240, hooks); t += 1 / 240; }
    return take && land ? Math.hypot(land.x - take.x, land.z - take.z) : 0;
  };
  const slow = fly(100), fast = fly(150);
  assert.equal(slow, 0, 'at 100 km/h the wheels stay down');
  assert.ok(fast > 8 && fast < 40, `at 150 km/h a small jump: ${fast.toFixed(1)} m`);
  console.log(`«Эстакада» crest: no jump at 100 km/h, ${fast.toFixed(1)} m at 150 km/h`);
  T.setMap('neon');
});

test('slopes: uphill slower, downhill faster; a flat map adds nothing', () => {
  T.setMap('_testhill');
  // 1 s flat out from 100 km/h straight ahead (about 30 m): the speed gained, and
  // the average grade on the way
  // (dir -1: against the lap direction)
  const run = (from, dir = 1) => {
    const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,spinV:0};
    T.placeAt(car, from); const v = 100 / 3.6 * dir; car.vx = T.TG[from].x * v; car.vz = T.TG[from].z * v; car.vF = Math.abs(v);
    if (dir < 0) { car.h += Math.PI; car.hPrev = car.h; }
    let g = 0, n = 0;
    for (let t = 0; t < 1; t += 1 / 120) {
      if (!car.air) stepCar(car, { up: 1, down: 0, left: 0, right: 0, hb: 0 }, 1 / 120);    // straight pieces: no steering
      T.constrainToTrack(car, 1 / 120, { onWall() {}, onLap() {} });
      assert.ok(!car.air); g += T.surface(car).grade * dir; n++; }
    return { kmh: Math.hypot(car.vx, car.vz) * 3.6, grade: g / n };
  };
  // up the long ramp to the bridge, down the same ramp the other way, and on the flat
  const first = ok => { for (let i = 0; i < T.N; i++) if (ok(i)) return i; return -1; };
  const climb = run(first(i => T.GR[i] > .03 && T.Y[i] > 2 && T.Y[i] < 2.5));
  const descend = run(first(i => T.GR[i] > .03 && T.Y[i] > 5.5 && T.Y[i] < 6), -1);
  const flat = run(T.sampleAt(MAPS._testhill.points.length - 8));
  const msg = `after 1 s flat out from 100 km/h: uphill (${(climb.grade * 100).toFixed(1)} %) ${climb.kmh.toFixed(2)}, flat ${flat.kmh.toFixed(2)}, downhill (${(descend.grade * 100).toFixed(1)} %) ${descend.kmh.toFixed(2)} km/h`;
  // what g·sin(slope) adds over 1 s, in km/h
  for (const r of [climb, descend]) {
    const want = -T.GRAV * Math.sin(Math.atan(r.grade)) * 3.6, got = r.kmh - flat.kmh;
    assert.ok(Math.abs(got - want) < .25 * Math.abs(want), `${msg}: the slope gave ${got.toFixed(2)} km/h, g·sin(slope) ${want.toFixed(2)}`);
  }
  console.log(msg);
  T.setMap('neon');
  assert.ok(T.FLAT, '«Ночной город» is flat: constrainToTrack skips heights (the golden test checks the bits)');
});

test('bridges: a car is found on its own road, by height, at the crossing', () => {
  T.setMap('_testhill');
  // where the bridge passes over the road below: the closest pair of a bridge point and a low one
  let top = -1, low = -1, bd = Infinity;
  for (let i = 0; i < T.N; i++) if (T.BRIDGE[i]) for (let j = 0; j < T.N; j++) if (T.Y[j] < 1) {
    const d = Math.hypot(T.P[i].x - T.P[j].x, T.P[i].z - T.P[j].z); if (d < bd) { bd = d; top = i; low = j; } }
  assert.ok(bd < 3 && T.Y[top] - T.Y[low] >= 6, `the bridge passes ${(T.Y[top] - T.Y[low]).toFixed(1)} m over the road`);
  const at = { x: T.P[top].x, z: T.P[top].z };
  assert.equal(T.nearest({ ...at, idx: 0, y: T.Y[top] }, true), top, 'a car at the bridge\'s height is on the bridge');
  const under = T.nearest({ ...at, idx: 0, y: T.Y[low] }, true);
  assert.ok(Math.abs(T.Y[under] - T.Y[low]) < .5, 'a car at the ground\'s height is on the road below');
  // the local search, step by step along the lower road, never jumps onto the bridge
  const car = { x: 0, z: 0, idx: (low - 30 + T.N) % T.N, y: 0 };
  for (let k = -30; k <= 30; k++) { const j = (low + k + T.N) % T.N; car.x = T.P[j].x; car.z = T.P[j].z; car.y = T.Y[j]; car.idx = T.nearest(car, false); assert.ok(Math.abs(car.idx - j) <= 1, `driving under the bridge: point ${car.idx} instead of ${j}`); }
  // another player's car, reported at the bridge with their own track point: drawn on the bridge
  const memo = {};
  const p = T.keepInWalls({ x: at.x, z: at.z, y: T.Y[top], idx: top }, memo);
  assert.equal(memo.idx, top); assert.ok(Math.abs(p.y - T.Y[top]) < .05);
  const q = T.keepInWalls({ x: at.x, z: at.z, y: 0, idx: low }, {});
  assert.ok(q.y < 1, 'and under it, under it');
  T.setMap('neon');
});

// «Перевал» (stage 5): two soft crests on fast straights. Held speed over each from 25
// points before it; the take-off speed is found by bisection.
test('«Перевал»: both crests throw the car from 120-140 km/h, never at 110, and land it on the straight', () => {
  T.setMap('pereval');
  const fly = (c, kmh) => {
    const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,spinV:0};
    const i0 = (c - 25 + T.N) % T.N; T.placeAt(car, i0);
    const v = kmh / 3.6; car.vx = T.TG[i0].x * v; car.vz = T.TG[i0].z * v; car.vF = v;
    let take = null, land = null, t = 0, walls = 0;
    const hooks = { onWall() { walls++; }, onLap() {}, onTakeoff() { take = { x: car.x, z: car.z }; }, onLand(p) { land = { x: car.x, z: car.z, p, idx: car.idx }; } };
    while (!land && t < 3) {
      if (!car.air) stepCar(car, { up: Math.hypot(car.vx, car.vz) < v ? 1 : 0, down: 0, left: 0, right: 0, hb: 0 }, 1 / 240);
      T.constrainToTrack(car, 1 / 240, hooks); t += 1 / 240; }
    return take && land ? { len: Math.hypot(land.x - take.x, land.z - take.z), idx: land.idx, walls } : null;
  };
  assert.equal(MAPS.pereval.crests.length, 2);
  for (const cr of MAPS.pereval.crests) {
    const c = T.sampleAt(cr.at);
    let lo = 80, hi = 220; for (let k = 0; k < 16; k++) { const m = (lo + hi) / 2; if (fly(c, m)) hi = m; else lo = m; }
    assert.ok(hi > 120 && hi < 140, `crest at point ${c}: take-off from ${hi.toFixed(0)} km/h`);
    assert.equal(fly(c, 110), null, 'at 110 km/h the wheels stay down');
    for (const kmh of [150, 200]) {
      const j = fly(c, kmh);
      assert.ok(j && j.len > 8 && j.len < 45 && !j.walls, `crest at point ${c}, ${kmh} km/h: ${j && j.len.toFixed(1)} m`);
      // a straight under the whole flight and 60 m past the landing: no turn to land in
      const end = (j.idx - c + T.N) % T.N; let d = 0;
      for (let k = 0, i = c; k <= end || d < 60; k++, i = (i + 1) % T.N) {
        assert.ok(Math.abs(T.RAD[i]) > 300, `crest at point ${c}: radius ${T.RAD[i].toFixed(0)} m at point ${i}, under the jump at ${kmh} km/h or just past it`);
        if (k > end) d += T.HL[i]; }
    }
    console.log(`«Перевал» crest at point ${c}: take-off from ${hi.toFixed(0)} km/h, ${fly(c, 150).len.toFixed(1)} m at 150, ${fly(c, 200).len.toFixed(1)} m at 200`);
  }
  T.setMap('neon');
});

// «Перевал» and «Развязка»: the loops under their own bridges keep 6 m and more under the deck
test('«Перевал» and «Развязка»: every bridge passes over the road below it with room to spare', () => {
  for (const [id, want] of [['pereval', 1], ['razvyazka', 2]]) {
    T.setMap(id);
    let spans = 0;
    for (let i = 0; i < T.N; i++) if (T.BRIDGE[i] && !T.BRIDGE[(i - 1 + T.N) % T.N]) spans++;
    assert.equal(spans, want, `${id}: ${spans} bridges`);
    let clear = Infinity;
    for (let i = 0; i < T.N; i++) if (T.BRIDGE[i]) for (let j = 0; j < T.N; j++) if (Math.abs(T.DIST[i] - T.DIST[j]) > 100 && T.TRACK_LEN - Math.abs(T.DIST[i] - T.DIST[j]) > 100 && Math.hypot(T.P[i].x - T.P[j].x, T.P[i].z - T.P[j].z) < T.HALF)
      clear = Math.min(clear, T.Y[i] - T.Y[j]);
    assert.ok(clear >= 6 && clear < 20, `${id}: ${clear.toFixed(1)} m under the bridge`);
    console.log(`${id}: ${spans} bridge${spans > 1 ? 's' : ''}, ${clear.toFixed(1)} m clear under the deck`);
  }
  T.setMap('neon');
});

// Stacked levels (stage 5, «Паркинг»): a car park whose floors and ramps pass over each
// other one floor apart, with a slab or a deck between them.
const { chase, CAM_ROOF } = await import('../public/js/modes/track/chase.js');
const { layout, COL } = await import('../public/js/modes/track/building.js');
for (const id of IDS.filter(id => MAPS[id].levels)) {
  // the road surface of the piece of road that passes over or under (x, z), other than the
  // stretch round track point i: [height, track point] for each
  const roadsAt = (x, z, i) => {
    const out = [];
    for (let j = 0; j < T.N; j++) {
      let dd = Math.abs(T.DIST[j] - T.DIST[i]); dd = Math.min(dd, T.TRACK_LEN - dd); if (dd < 4 * T.WALL) continue;
      const rx = x - T.P[j].x, rz = z - T.P[j].z; if (rx * rx + rz * rz > (T.WALL + 1) ** 2) continue;
      const along = rx * T.TG[j].x + rz * T.TG[j].z; if (along < -T.HL[(j - 1 + T.N) % T.N] / 2 - .01 || along > T.HL[j] / 2 + .01) continue;
      const lat = rx * T.NM[j].x + rz * T.NM[j].z; if (Math.abs(lat) > T.WALL) continue;
      out.push([T.Y[j] + lat * T.TB[j] + along * T.GR[j], j]);
    }
    return out;
  };
  test(`map ${id}: stacked levels: 3.2 m clear under every slab and deck`, () => {
    T.setMap(id);
    const { gap, slab } = MAPS[id].levels, b = MAPS[id].building;
    let clear = Infinity, pairs = 0;
    // across the whole width between the walls, wherever two roads lie over each other
    for (let i = 0; i < T.N; i++) for (const o of [-T.WALL, -T.WALL / 2, 0, T.WALL / 2, T.WALL]) {
      const x = T.P[i].x + T.NM[i].x * o, z = T.P[i].z + T.NM[i].z * o, y = T.Y[i] + o * T.TB[i];
      for (const [yj, j] of roadsAt(x, z, i)) {
        const dy = Math.abs(yj - y); pairs++;
        assert.ok(dy - slab >= 3.2, `${id}: points ${i} and ${j} (${o.toFixed(1)} m off the centre): ${(dy - slab).toFixed(2)} m clear between the roads`);
        clear = Math.min(clear, dy - slab);
        // (a road right over another's centre line is that one's ceiling there: geometry.js CEIL)
        if (o === 0 && yj > y) assert.ok(Math.abs(T.CEIL[i] - (dy - slab)) < .3 || T.CEIL[i] < dy - slab, `${id}: point ${i} has a road ${dy.toFixed(2)} m over it, its ceiling is ${T.CEIL[i].toFixed(2)} m`);
      }
    }
    // the ceilings themselves: none lower than that; inside the building every road lies on a floor
    let cmin = Infinity, inside = 0;
    for (let i = 0; i < T.N; i++) {
      cmin = Math.min(cmin, T.CEIL[i]);
      if (T.P[i].x > b.x0 && T.P[i].x < b.x1 && T.P[i].z > b.z0 && T.P[i].z < b.z1) { inside++;
        assert.ok(b.floors.some(f => Math.abs(T.Y[i] - f) < .02), `${id}: point ${i} at ${T.Y[i].toFixed(2)} m inside the building is between floors`); }
    }
    assert.ok(cmin >= 3.2, `${id}: a ceiling ${cmin.toFixed(2)} m over the road`);
    assert.ok(T.SAME_LEVEL <= gap / 2 && T.SAME_LEVEL > 1, `${id}: cars ${T.SAME_LEVEL} m apart in height are on different floors`);
    console.log(`${id}: ${pairs} places where roads lie over each other, at least ${clear.toFixed(2)} m clear; ceilings ${cmin.toFixed(2)} m and higher; ${inside} of ${T.N} points inside the building`);
  });

  test(`map ${id}: respawn and other players' cars land on their own floor`, () => {
    T.setMap(id);
    let n = 0, ghosts = 0;
    for (let i = 0; i < T.N; i += 3) {
      // only where another road passes over or under
      const others = roadsAt(T.P[i].x, T.P[i].z, i); if (!others.length) continue;
      for (const lat of [-(T.WALL - 1.3), 0, T.WALL - 1.3]) {
        const x = T.P[i].x + T.NM[i].x * lat, z = T.P[i].z + T.NM[i].z * lat;
        const car = { x, z, idx: others[0][1], y: T.Y[i] + lat * T.TB[i] };
        const j = T.nearest(car, true); n++;
        assert.ok(Math.abs(T.Y[j] - T.Y[i]) < .6 && Math.hypot(T.P[j].x - T.P[i].x, T.P[j].z - T.P[i].z) < 4, `${id}: a car at point ${i} (${lat.toFixed(1)} m off the centre, ${car.y.toFixed(1)} m up) respawns at point ${j} (${T.Y[j].toFixed(1)} m up)`);
        // another player's car whose last known track point is the road over or under it
        const memo = { idx: others[0][1] }, p = T.keepInWalls({ x, z, y: car.y }, memo); ghosts++;
        assert.ok(Math.abs(T.Y[memo.idx] - T.Y[i]) < .6 && Math.abs(p.y - car.y) < .3, `${id}: another car at point ${i} is drawn at point ${memo.idx}, ${p.y.toFixed(2)} m up instead of ${car.y.toFixed(2)}`);
      }
    }
    assert.ok(n > 100, `${id}: ${n} places tried`);
    console.log(`${id}: ${n} respawns and ${ghosts} other players' cars over or under another road, every one on its own floor`);
  });

  test(`map ${id}: the race camera stays under the ceilings and clear of the columns`, () => {
    T.setMap(id);
    const { slab } = MAPS[id].levels, b = MAPS[id].building, L = layout();
    assert.ok(L.columns.length > 100 && L.lines.length > 100 && L.lights.length > 100, `${id}: ${L.columns.length} columns, ${L.lines.length} bay lines, ${L.lights.length} lights`);
    // no column on a road or in its run-off: every one stands outside the walls of the roads of its floor
    for (const [x, z, y0, y1] of L.columns) for (let i = 0; i < T.N; i++) {
      if (T.Y[i] < y0 - .5 || T.Y[i] > y1 - 1) continue;
      assert.ok(Math.hypot(T.P[i].x - x, T.P[i].z - z) >= T.WALL + COL / 2 + .2, `${id}: a column at ${x.toFixed(1)}, ${z.toFixed(1)} stands ${Math.hypot(T.P[i].x - x, T.P[i].z - z).toFixed(1)} m from point ${i}`);
    }
    // the lowest ceiling over (x, z) above height y: a slab of the building, or a road's deck
    const ceilingAt = (x, z, y) => {
      let c = Infinity;
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) for (const f of b.floors) if (f > y + 1) c = Math.min(c, f - slab);
      for (let j = 0; j < T.N; j++) { const rx = x - T.P[j].x, rz = z - T.P[j].z; if (rx * rx + rz * rz > (T.WALL + 1.3) ** 2) continue;
        // (the deck of the piece of road whose cross-section, out to the deck's edge, passes over (x, z))
        const along = rx * T.TG[j].x + rz * T.TG[j].z; if (along < -T.HL[(j - 1 + T.N) % T.N] / 2 - .01 || along > T.HL[j] / 2 + .01) continue;
        const lat = rx * T.NM[j].x + rz * T.NM[j].z; if (Math.abs(lat) > T.WALL + .3) continue;
        // (a deck over the car stands 3.2 m + the slab above its road; the road just behind a
        // car coming down the helix is up to ~2 m above it, under the camera, and is no ceiling)
        const yj = T.Y[j] + lat * T.TB[j] + along * T.GR[j]; if (yj > y + 3) c = Math.min(c, yj - slab); }
      return c;
    };
    // the validator's bot drives a lap; the camera follows it at 60 Hz
    const car = {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,spinV:0};
    T.placeGrid(car, 0);
    const rig = { pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false };
    const hooks = { onWall() {}, onLap() { laps++; }, onLand() {} }, I = { up: 0, down: 0, left: 0, right: 0, hb: 0 };
    let laps = 0, t = 0, frames = 0, under = 0, worst = Infinity, nearCol = Infinity;
    const dt = 1 / 120;
    while (laps < 1 && t < 200) {
      let n = 0, turn = 0;
      while (n < 26) { const j = (car.idx + n) % T.N, k = (j + 1) % T.N; turn += Math.abs(ang(Math.atan2(T.TG[j].x, T.TG[j].z), Math.atan2(T.TG[k].x, T.TG[k].z))); if (turn > 2) break; n++; }
      const a = (car.idx + Math.max(6, n)) % T.N, err = ang(car.h, Math.atan2(T.P[a].x - car.x, T.P[a].z - car.z));
      const sp = Math.hypot(car.vx, car.vz);
      I.left = err > .03 ? 1 : 0; I.right = err < -.03 ? 1 : 0; I.up = Math.abs(err) < .6 && sp < 24 ? 1 : 0; I.down = 0;
      unstick(I, sp, err, t);
      stepCar(car, I, dt); T.constrainToTrack(car, dt, hooks); t += dt;
      if (Math.round(t * 120) % 2) continue;
      chase(car, 1 / 60, rig); frames++;
      const c = rig.pos, top = ceilingAt(c.x, c.z, car.y);
      if (top < Infinity) { under++; worst = Math.min(worst, top - c.y);
        assert.ok(c.y <= top - .3, `${id}: at ${t.toFixed(1)} s (point ${car.idx}) the camera is ${(c.y - top).toFixed(2)} m from the ceiling`); }
      for (const [x, z, y0, y1] of L.columns) if (c.y > y0 && c.y < y1) {
        const d = Math.max(Math.abs(c.x - x), Math.abs(c.z - z)) - COL / 2; nearCol = Math.min(nearCol, d);
        assert.ok(d > .3, `${id}: at ${t.toFixed(1)} s the camera is ${d.toFixed(2)} m from a column`); }
    }
    assert.equal(laps, 1, `${id}: the bot lapped`);
    assert.ok(under > frames / 3, `${id}: ${under} of ${frames} frames under a ceiling`);
    console.log(`${id}: the camera followed a ${t.toFixed(0)} s lap; ${under} of ${frames} frames under a ceiling, at least ${worst.toFixed(2)} m below it (keeps ${CAM_ROOF} m), at least ${nearCol.toFixed(2)} m from a column`);
  });

  test(`map ${id}: a careful driver laps it`, () => {
    T.setMap(id);
    const r = followRoute(route([]));
    assert.equal(r.laps.length, 2, `${id}: ${r.laps.length} laps in ${r.t.toFixed(0)} s`);
    assert.ok(r.worst < 2, `${id}: stuck ${r.worst.toFixed(1)} s`);
    console.log(`${id}: route bot lap ${(r.laps[1] - r.laps[0]).toFixed(1)} s, ${r.walls} wall hits in two laps`);
  });
}
