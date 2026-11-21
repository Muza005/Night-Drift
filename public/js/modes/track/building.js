// The car park of a map with a `building` («Паркинг»), as plain numbers: where its columns,
// parapets, painted bays, parked cars and ceiling lights go, worked out from the active
// map's roads (geometry.js). No rendering here: scene-parking.js draws it, and
// tests/maps.test.mjs checks that the race camera never meets a column.
//
// A storey is the space between two floors of the building (floors[k] to floors[k+1]); a
// road belongs to the storey whose floor it is driven on (within half a floor). Every thing
// keeps clear of the roads of its own storey: a column stands at least WALL + 0.6 m from
// the centre line of every road there (outside the barrier), a bay line WALL + 0.15 m.
import { P, NM, TG, Y, RAD, DIST, N, WALL, CEIL, MAP, LEVELS } from './geometry.js';

export const COL = .7;                 // column section (m, square)
const BAY_W = 2.6, BAY_D = 5.2;        // a parking bay: width along the aisle, depth

// a cheap seeded random, so the layout (and the screenshots) are the same every time
function rnd(seed){ let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

export function layout(){
  const b = MAP.building, gap = LEVELS.gap, slab = LEVELS.slab, F = b.floors;
  const inside = (x, z, m = 0) => x >= b.x0 + m && x <= b.x1 - m && z >= b.z0 + m && z <= b.z1 - m;
  // the road samples of each level (every one: the clearance tests need them all)
  const level = i => Math.round(Y[i] / gap);
  const byLevel = F.map(() => []);
  for (let i = 0; i < N; i++) { const k = level(i); if (k >= 0 && k < F.length && Math.abs(Y[i] - F[k]) < gap / 2) byLevel[k].push(i); }
  // how far (x, z) is from the nearest road centre on level k
  const dist = (k, x, z) => { let bd = 1e18; for (const i of byLevel[k]) { const dx = P[i].x - x, dz = P[i].z - z, d = dx * dx + dz * dz; if (d < bd) bd = d; } return Math.sqrt(bd); };
  // and from any road at all between heights y0 and y1 (the towers, the decks)
  const distAny = (x, z, y0, y1) => { let bd = 1e18; for (let i = 0; i < N; i++) { if (Y[i] < y0 || Y[i] > y1) continue; const dx = P[i].x - x, dz = P[i].z - z, d = dx * dx + dz * dz; if (d < bd) bd = d; } return Math.sqrt(bd); };

  const columns = [];                  // [x, z, y0, y1]
  const near = (x, z, y0, r) => columns.some(c => c[2] === y0 && Math.abs(c[0] - x) < r && Math.abs(c[1] - z) < r);
  const colClear = WALL + COL / 2 + .25;
  for (let k = 0; k + 1 < F.length; k++) {
    const y0 = F[k], y1 = F[k + 1] - slab;
    // a row along every barrier of the storey, one every 7.8 m (three bays)
    for (const i of byLevel[k]) {
      if (Math.round(DIST[i] / 1.6) % 5) continue;
      for (const s of [1, -1]) {
        const o = s * (WALL + COL / 2 + .3), x = P[i].x + NM[i].x * o, z = P[i].z + NM[i].z * o;
        if (!inside(x, z, .4) || dist(k, x, z) < colClear || near(x, z, y0, 6.5)) continue;
        columns.push([x, z, y0, y1]);
      }
    }
    // and a grid (8 m) wherever the floor is clear of the storey's roads, the facade included
    for (let x = b.x0 + .4; x <= b.x1; x += 8) for (let z = b.z0 + .4; z <= b.z1; z += 8) {
      const cx = Math.min(x, b.x1 - .4), cz = Math.min(z, b.z1 - .4);
      if (dist(k, cx, cz) < colClear || near(cx, cz, y0, 4)) continue;
      columns.push([cx, cz, y0, y1]);
    }
  }
  // the round towers: a core in the middle and posts round the outside, from the ground to
  // above the top, wherever no road passes
  const towerParts = [];
  for (const t of b.towers) {
    towerParts.push({ x: t.x, z: t.z, core: t.r - WALL - .35, y1: t.to + 1.2 });
    for (let a = 0; a < 360; a += 20) {
      const r = t.r + WALL + .6, x = t.x + Math.cos(a * Math.PI / 180) * r, z = t.z + Math.sin(a * Math.PI / 180) * r;
      if (distAny(x, z, -1, 99) < WALL + .5 || inside(x, z, -1)) continue;
      columns.push([x, z, 0, t.to + 1.2]);
    }
  }
  // parapets: 1 m walls round the edge of every slab (and the roof), open where a road
  // drives through the edge; pieces 2 m long: [x, z, y, angle]
  const parapets = [];
  for (let k = 1; k < F.length; k++) {
    const edge = (x, z, ang) => { if (dist(k, x, z) < WALL + 1) return; parapets.push([x, z, F[k], ang]); };
    for (let x = b.x0 + 1; x < b.x1; x += 2) { edge(x, b.z0 + .15, 0); edge(x, b.z1 - .15, 0); }
    for (let z = b.z0 + 1; z < b.z1; z += 2) { edge(b.x0 + .15, z, Math.PI / 2); edge(b.x1 - .15, z, Math.PI / 2); }
  }
  // Bays along the straight stretches of every road inside the building, both sides: a
  // line every 2.6 m across a strip 5.2 m deep behind the barrier; [x, z, y, angle] of
  // the line's middle (angle: the aisle's direction). Some bays have a parked car:
  // [x, z, y, angle, colour index].
  const lines = [], cars = [], R = rnd(4207);
  const seen = new Set();
  for (let k = 0; k < F.length; k++) for (const i of byLevel[k]) {
    let straight = true; for (let q = -4; q <= 4 && straight; q++) if (Math.abs(RAD[(i + q + N) % N]) < 80) straight = false;
    if (!straight) continue;
    const step = Math.round(DIST[i] / BAY_W), d = DIST[i] - step * BAY_W;
    if (Math.abs(d) > .81 || seen.has(step)) continue;     // one line per 2.6 m
    seen.add(step);
    const ang = Math.atan2(TG[i].x, TG[i].z);
    for (const s of [1, -1]) {
      const pts = [WALL + .3, WALL + .3 + BAY_D / 2, WALL + .3 + BAY_D].map(o => [P[i].x + NM[i].x * s * o, P[i].z + NM[i].z * s * o]);
      if (!pts.every(([x, z]) => inside(x, z, .3) && dist(k, x, z) >= WALL + .15)) continue;
      const [mx, mz] = pts[1];
      if (columns.some(c => c[2] === F[k] && Math.hypot(c[0] - mx, c[1] - mz) < BAY_D / 2 + .2 && Math.abs((c[0] - mx) * TG[i].x + (c[1] - mz) * TG[i].z) < .5)) continue;
      lines.push([mx, mz, F[k], ang, s, step, i]);
      // a car in the bay ahead of this line (its far side checked the same way)
      const ax = mx + TG[i].x * BAY_W / 2, az = mz + TG[i].z * BAY_W / 2, fx = mx + TG[i].x * BAY_W, fz = mz + TG[i].z * BAY_W;
      if (R() < .38 && inside(fx, fz, .3) && dist(k, fx, fz) >= WALL + .15 && dist(k, ax, az) >= WALL + 1.5
        && !columns.some(c => c[2] === F[k] && Math.hypot(c[0] - ax, c[1] - az) < 2.4)) cars.push([ax, az, F[k], ang, Math.floor(R() * 6)]);
    }
  }
  // Ceiling lights: over every covered road, a pair of strips along it every 6 m, just
  // under the ceiling ([x, y, z, angle]); over the bays one strip every 7.8 m.
  const lights = [], pools = [];
  for (let i = 0; i < N; i++) {
    if (!(CEIL[i] < 8) || Math.round(DIST[i] / 1.6) % 4) continue;
    const ang = Math.atan2(TG[i].x, TG[i].z), y = Y[i] + CEIL[i] - .06;
    for (const o of [-2.6, 2.6]) lights.push([P[i].x + NM[i].x * o, y, P[i].z + NM[i].z * o, ang]);
    if (Math.round(DIST[i] / 1.6) % 8 === 0) pools.push([P[i].x, Y[i], P[i].z]);
  }
  for (const l of lines) if (l[5] % 3 === 0) {
    const k = Math.round(l[2] / gap); if (k + 1 >= F.length) continue;      // (not on the roof)
    lights.push([l[0], F[k + 1] - slab - .06, l[1], l[3] + Math.PI / 2]);
  }
  return { columns, towers: towerParts, parapets, lines, cars, lights, pools };
}
