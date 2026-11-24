// Plan 3, stage 2: the walls as polylines (modes/track/walls.js, geometry.js WALLS): one
// source for the drawn walls and (stage 3) the collisions. On every map:
//  - every wall line is closed (no wall ends, no holes between the main road's walls and the
//    shortcuts'), its normals point into the drivable space;
//  - no wall crosses a road: the centre line of the main road and of each shortcut is clear
//    of every wall by at least half its asphalt;
//  - a map without shortcuts keeps exactly the walls it was drawn with before (safeOffsets);
//  - the shortcuts' mouths are rounded: arcs of 4-6 m, no sharper joint than the arc's own;
//  - wallsNear (the grid query) finds exactly what a search of every segment finds, and on a
//    map with storeys only the walls of the car's own storey;
//  - the ground is under every drivable surface (no "puddles").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

globalThis.THREE = createRequire(import.meta.url)('three');
const T = await import('../public/js/modes/track/geometry.js');
const WL = await import('../public/js/modes/track/wall-lines.js');
const { FILLET } = await import('../public/js/modes/track/walls.js');
const { MAPS } = await import('../public/js/modes/track/maps/index.js');
const IDS = Object.keys(MAPS);

const segsOf = W => { const out = []; for (const L of W.lines) for (let k = 0; k < (L.closed ? L.n : L.n - 1); k++) { const j = (k + 1) % L.n; out.push({ ax: L.x[k], az: L.z[k], bx: L.x[j], bz: L.z[j], ay: L.y[k], by: L.y[j] }); } return out; };
const near = (x, z, y, r) => { const out = []; const n = T.wallsNear(x, z, y, r, out); return out.slice(0, n); };

for (const id of IDS) test(`map ${id}: wall lines closed, normals inward, roads clear of walls`, () => {
  T.setMap(id);
  const W = T.WALLS;
  assert.deepEqual(W.problems, [], `${id}: ${W.problems.join('; ')}`);
  assert.ok(W.lines.length >= 2);
  for (const L of W.lines) {
    assert.ok(L.closed, `${id}: an open wall line (${L.n} points)`);
    for (let k = 0; k < L.nx.length; k++) assert.ok(Math.abs(Math.hypot(L.nx[k], L.nz[k]) - 1) < 1e-9);
  }
  // the main road's centre line: the nearest wall is on its drivable side, at least half the road away
  for (let i = 0; i < T.N; i++) {
    const e = near(T.P[i].x, T.P[i].z, T.Y[i], T.WALL + 3);
    assert.ok(e.length, `${id}: no wall near point ${i}`);
    assert.ok(e[0].side > 0, `${id}: point ${i} is behind a wall`);
    assert.ok(e[0].d >= T.HALF - 1e-6, `${id}: a wall ${e[0].d.toFixed(2)} m from the centre line at point ${i}`);
  }
  for (const sc of T.SHORTCUTS) for (let k = 0; k < sc.n; k++) {
    const e = near(sc.x[k], sc.z[k], sc.y[k], 8);
    if (!e.length) continue;
    assert.ok(e[0].side > 0 && e[0].d >= sc.half - 1e-6, `${id}: shortcut ${sc.k} sample ${k}: a wall ${e[0].d.toFixed(2)} m from its centre line`);
  }
});

test('a map without shortcuts keeps its walls: the offset lines at ±WALL, pulled in on hairpins', () => {
  for (const id of IDS) {
    T.setMap(id); if (T.SHORTCUTS.length) continue;
    const W = T.WALLS; assert.equal(W.lines.length, 2);
    for (const s of [1, -1]) {
      const O = WL.offsetLine(s * T.WALL, 0), pts = new Set();
      for (let i = 0; i < T.N; i++) pts.add(O.x[i].toFixed(9) + ',' + O.z[i].toFixed(9));
      const L = W.lines.find(L => L.s[0] === s);
      for (let k = 0; k < L.n; k++) assert.ok(pts.has(L.x[k].toFixed(9) + ',' + L.z[k].toFixed(9)), `${id}: wall point ${k} is not on the offset line`);
      // the right wall runs backwards (the drivable space on its right)
      const k0 = 0, i0 = L.i[k0], i1 = L.i[1]; assert.equal((i1 - i0 + T.N) % T.N, s > 0 ? 1 : T.N - 1);
    }
  }
});

test('shortcut mouths: rounded by 4-6 m arcs, the joints no sharper than the arc', () => {
  for (const id of IDS) {
    T.setMap(id); const W = T.WALLS;
    if (!T.SHORTCUTS.length) { assert.equal(W.fillets.length, 0); continue; }
    assert.equal(W.fillets.length, T.SHORTCUTS.length * 4, `${id}: one arc per corner (4 per shortcut)`);
    for (const f of W.fillets) {
      assert.ok(f.r >= FILLET.RMIN - 1e-6 && f.r <= 6, `${id}: arc radius ${f.r.toFixed(2)} m at x ${f.x.toFixed(0)} z ${f.z.toFixed(0)}`);
      const step = (Math.PI - f.theta) / (f.arc.length - 1);
      for (const p of f.arc) for (const L of W.lines) for (let k = 0; k < L.n; k++) {
        if (L.x[k] !== p.x || L.z[k] !== p.z) continue;
        const a = (k - 1 + L.n) % L.n, b = (k + 1) % L.n, ux = L.x[k] - L.x[a], uz = L.z[k] - L.z[a], vx = L.x[b] - L.x[k], vz = L.z[b] - L.z[k];
        const t = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / (Math.hypot(ux, uz) * Math.hypot(vx, vz)))));
        assert.ok(t <= step + 3 * Math.PI / 180, `${id}: a joint of ${(t * 180 / Math.PI).toFixed(1)}° at the arc at x ${f.x.toFixed(0)} z ${f.z.toFixed(0)}`);
      }
    }
  }
});

test('wallsNear: the grid finds what a search of every segment finds', () => {
  let rnd = 12345; const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (const id of ['neon', 'razvyazka', 'parking']) {
    T.setMap(id); const S = segsOf(T.WALLS);
    for (let q = 0; q < 300; q++) {
      const i = Math.floor(rand() * T.N), x = T.P[i].x + (rand() - .5) * 40, z = T.P[i].z + (rand() - .5) * 40, y = T.Y[i], r = 1 + rand() * 12;
      const got = near(x, z, y, r).map(e => e.seg).sort((a, b) => a - b), want = [];
      S.forEach((s, k) => { const ex = s.bx - s.ax, ez = s.bz - s.az, L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - s.ax) * ex + (z - s.az) * ez) / L2)) : 0;
        const d = Math.hypot(x - s.ax - ex * t, z - s.az - ez * t), wy = s.ay + (s.by - s.ay) * t;
        if (d <= r && Math.abs(wy - y) <= T.SAME_LEVEL) want.push(k); });
      assert.deepEqual(got, want, `${id}: query ${q}`);
    }
  }
});

test('«Паркинг»: a car finds the walls of its own storey only', () => {
  T.setMap('parking');
  let stacked = 0;
  for (let i = 0; i < T.N; i += 3) {
    const own = near(T.P[i].x, T.P[i].z, T.Y[i], T.WALL + 2), any = near(T.P[i].x, T.P[i].z, NaN, T.WALL + 2);
    for (const e of own) assert.ok(Math.abs(e.y - T.Y[i]) <= T.SAME_LEVEL);
    if (any.length > own.length) stacked++;
  }
  assert.ok(stacked > 20, `walls of other storeys left out at ${stacked} points`);
});

test('the ground lies under every drivable surface; 0.5 m under the lowest where the road dips', () => {
  for (const id of IDS) {
    T.setMap(id); const g = WL.groundLevel();
    let lo = Infinity;
    for (const s of [1, -1]) { const L = WL.offsetLine(s * T.WALL, 0); for (let i = 0; i < T.N; i++) lo = Math.min(lo, L.y[i]); }
    for (const sc of T.SHORTCUTS) for (let k = 0; k < sc.n; k++) lo = Math.min(lo, sc.y[k]);
    for (const L of T.WALLS.lines) for (let k = 0; k < L.n; k++) lo = Math.min(lo, L.y[k]);
    assert.ok(lo >= g, `${id}: a surface at ${lo.toFixed(2)} m under the ground at ${g}`);
    if (g < WL.GROUND_Y) assert.ok(lo - g >= WL.GROUND_DROP - .01, `${id}: ground only ${(lo - g).toFixed(2)} m under the lowest surface`);
  }
  T.setMap('neon'); assert.equal(WL.groundLevel(), 0);
  T.setMap('pereval'); assert.ok(WL.groundLevel() < -2.7);
});
