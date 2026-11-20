// The map validator (track engine v2, modes/track/). Every map in maps/index.js must:
//  - have a lap of a sensible length;
//  - keep the centre-line radius at least WALL + 2 m (a car fits round the inside wall);
//  - never cross itself without at least 6 m of height between the two roads;
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
      const a = (car.idx + look) % T.N, far = (car.idx + look * 3) % T.N;
      const toA = Math.atan2(T.P[a].x - car.x, T.P[a].z - car.z), err = ang(car.h, toA);
      const bend = Math.abs(ang(toA, Math.atan2(T.P[far].x - T.P[a].x, T.P[far].z - T.P[a].z)));
      const sp = Math.hypot(car.vx, car.vz), tooFast = sp > f * (20 + 45 * (1 - Math.min(1, bend / 1.2)));
      I.left = err > 0.03 ? 1 : 0; I.right = err < -0.03 ? 1 : 0;
      I.up = !tooFast && Math.abs(err) < 0.6 ? 1 : 0; I.down = tooFast && sp > 18 ? 1 : 0;
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
