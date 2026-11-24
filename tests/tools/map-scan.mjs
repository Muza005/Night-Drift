// Plan 3, stage 0: map scan. For every map players can pick:
//  1. puddles: where the ground plane (wall-lines.js GROUND_Y on maps with heights, 0 on a
//     flat map; the strips' heights are wall-lines.js STRIP_Y, the ones scene.js draws) is above the asphalt, the curbs or the run-off (and the shortcuts' strips).
//     The strips are flat triangles between the offset lines of two neighbouring track
//     points (with the bank), so a triangle's lowest point is one of its corners: the
//     corners are checked, which is exact for every point of the strip.
//  2. walls: the drawn wall against the collision wall, along a ray out from every track
//     point and every shortcut sample to both sides (modes/track/wall-lines.js measures the
//     collision wall with constrainToTrack itself). More than 5 cm apart: an invisible wall
//     (the car's body stops short of any drawn wall) or a wall the car goes through.
//  3. shortcut mouths: where a shortcut's drawn wall meets the main road's, the angle
//     between the two walls (away from the corner) and the hole between their ends.
//   npm run scan:maps [-- map ...]
import { createRequire } from 'node:module';
const R = new URL('../../', import.meta.url).href;
globalThis.THREE = createRequire(new URL('package.json', R))('three');
const T = await import(R + 'public/js/modes/track/geometry.js');
const W = await import(R + 'public/js/modes/track/wall-lines.js');
const { MAPS, MAP_IDS } = await import(R + 'public/js/modes/track/maps/index.js');
const { STRIP_Y: SY, GROUND_Y } = W;

const ids = process.argv.slice(2).filter(a => !a.startsWith('-'));
const unknown = ids.filter(id => !Object.hasOwn(MAPS, id));
if (unknown.length) { console.error(`unknown map: ${unknown.join(', ')} (maps: ${Object.keys(MAPS).join(', ')})`); process.exit(1); }
const maps = ids.length ? ids : MAP_IDS;
const f2 = v => isFinite(v) ? v.toFixed(2) : '—', f0 = v => v.toFixed(0);

// contiguous runs of flagged indices (a ring of n when ring), each with its worst entry
function runs(flags, n, ring) {
  const out = []; let cur = null;
  for (let i = 0; i < n; i++) {
    const f = flags[i];
    if (f) { if (cur) { cur.to = i; cur.count++; if (f.v > cur.worst.v) cur.worst = f; } else cur = { from: i, to: i, count: 1, worst: f }; }
    else if (cur) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  if (ring && out.length > 1 && out[0].from === 0 && out[out.length - 1].to === n - 1) {
    const a = out.shift(), b = out[out.length - 1]; b.to = a.to; b.count += a.count; if (a.worst.v > b.worst.v) b.worst = a.worst;
  }
  return out;
}

const summary = [];
for (const id of maps) {
  T.setMap(id);
  const { N, P, NM, Y, HALF, CURB, WALL, SHORTCUTS } = T, flat = Y.every(y => y === 0), gy = flat ? 0 : GROUND_Y;
  console.log(`\n=== ${id} «${T.MAP.name}»: ${N} points, road ${T.ROAD} m, wall ${WALL} m, ${SHORTCUTS.length} shortcuts, ground y = ${gy}`);

  // 1. puddles
  const strips = [
    ['road', -HALF, HALF, SY.road], ['curb', HALF, HALF + CURB, SY.curb], ['curb', -HALF - CURB, -HALF, SY.curb],
    ['run-off', HALF + CURB, WALL, SY.runoff], ['run-off', -HALF - CURB, -WALL, SY.runoff],
  ];
  const mainFlag = new Array(N).fill(null);
  let minClear = Infinity, minClearAt = null;
  for (const [name, o0, o1, yOff] of strips) {
    const A = W.offsetLine(o0, yOff), B = W.offsetLine(o1, yOff);
    for (let i = 0; i < N; i++) { const j = (i + 1) % N;
      for (const [L, k, side] of [[A, i, o0], [B, i, o1], [A, j, o0], [B, j, o1]]) {
        const c = L.y[k] - gy;
        if (c < minClear) { minClear = c; minClearAt = { name, i: k, x: L.x[k], z: L.z[k] }; }
        if (c < 0) { const v = -c; if (!mainFlag[i] || v > mainFlag[i].v) mainFlag[i] = { v, name: name + (side > 0 ? ' L' : ' R'), x: L.x[k], z: L.z[k], i: k }; }
      } }
  }
  const puddles = runs(mainFlag, N, true).map(r => ({ where: `main ${r.from}-${r.to}`, points: r.count, depth: r.worst.v, surface: r.worst.name, x: r.worst.x, z: r.worst.z }));
  for (const sc of SHORTCUTS) {
    const dm = Float64Array.from({ length: sc.n }, (_, k) => W.mainDist(sc.x[k], sc.z[k]));
    const onMain = (k, r) => dm[k] < r || dm[k + 1] < r;
    const cs = [['cut run-off', -sc.wall, sc.wall, SY.cutRunoff, k => onMain(k, WALL - .5)], ['cut road', -sc.half, sc.half, SY.cutRoad, k => dm[k] < HALF - .3 && dm[k + 1] < HALF - .3],
      ['cut curb', sc.half, sc.half + .5, SY.cutCurb, k => onMain(k, HALF + CURB)], ['cut curb', -sc.half - .5, -sc.half, SY.cutCurb, k => onMain(k, HALF + CURB)]];
    const fl = new Array(sc.n).fill(null);
    for (const [name, , , yOff, skip] of cs) for (let k = 0; k < sc.n - 1; k++) { if (skip(k)) continue;
      for (const q of [k, k + 1]) { const c = sc.y[q] + yOff - gy;
        if (c < minClear) { minClear = c; minClearAt = { name, i: `cut ${sc.k}:${q}`, x: sc.x[q], z: sc.z[q] }; }
        if (c < 0 && (!fl[k] || -c > fl[k].v)) fl[k] = { v: -c, name, x: sc.x[q], z: sc.z[q] }; } }
    for (const r of runs(fl, sc.n, false)) puddles.push({ where: `cut ${sc.k} ${r.from}-${r.to}`, points: r.count, depth: r.worst.v, surface: r.worst.name, x: r.worst.x, z: r.worst.z });
  }
  puddles.sort((a, b) => b.depth - a.depth);
  console.log(`puddles (ground above the surface): ${puddles.length} places; lowest clearance ${minClear.toFixed(3)} m (${minClearAt.name}, ${minClearAt.i}, x ${f0(minClearAt.x)} z ${f0(minClearAt.z)})`);
  if (puddles.length) console.table(puddles.slice(0, 10).map(p => ({ ...p, depth: p.depth.toFixed(2), x: f0(p.x), z: f0(p.z) })));

  // 2. walls
  const rays = W.measureWalls();
  const bad = { invisible: [], through: [] }, grazing = rays.filter(r => r.type === 'grazing').length;
  for (const r of rays) if (bad[r.type]) bad[r.type].push(r);
  // places: runs of bad rays along one line (same road, same side)
  const places = [];
  for (const type of ['invisible', 'through']) {
    const lines = new Map();
    for (const r of bad[type]) { const key = r.kind === 'main' ? `main ${r.s > 0 ? 'L' : 'R'}` : `cut ${r.ref[0]} ${r.s > 0 ? 'L' : 'R'}`; if (!lines.has(key)) lines.set(key, []); lines.get(key).push(r); }
    for (const [key, list] of lines) {
      const n = key.startsWith('main') ? N : SHORTCUTS[list[0].ref[0]].n, flags = new Array(n).fill(null);
      for (const r of list) { const i = r.kind === 'main' ? r.ref : r.ref[1]; flags[i] = { v: r.miss, r }; }
      for (const g of runs(flags, n, key.startsWith('main'))) {
        const r = g.worst.r, o = Math.min(isFinite(r.body) ? r.body : 1e9, isFinite(r.drawn) ? r.drawn : 1e9);
        places.push({ type, where: `${key} ${g.from}-${g.to}`, rays: g.count, miss: g.worst.v, open: !isFinite(r.c) || !isFinite(r.drawn),
          centre: r.c, body: r.body, drawn: r.drawn, x: r.ox + r.dx * o, z: r.oz + r.dz * o });
      }
    }
  }
  places.sort((a, b) => b.miss - a.miss);
  const worst = t => { const l = bad[t].filter(r => isFinite(r.body) && isFinite(r.drawn)); return l.length ? Math.max(...l.map(r => r.miss)) : 0; };
  console.log(`walls: ${rays.length} rays (${grazing} meet the wall too obliquely to judge); invisible ${bad.invisible.length} (worst with both walls ${worst('invisible').toFixed(2)} m), through ${bad.through.length} (worst ${worst('through').toFixed(2)} m), ${places.length} places`);
  if (places.length) console.table(places.slice(0, 12).map(p => ({ type: p.type, where: p.where, rays: p.rays, 'miss m': (p.open ? '≥' : '') + p.miss.toFixed(2), 'centre m': f2(p.centre), 'body m': f2(p.body), 'drawn m': f2(p.drawn), x: f0(p.x), z: f0(p.z) })));

  // 3. shortcut mouths
  const D = W.drawnWalls(), mouths = [];
  const ends = [];
  for (const M of D.main) for (let i = 0; i < N; i++) { const a = M.on[(i - 1 + N) % N], b = M.on[i];
    if (a && !b) ends.push({ x: M.x[i], z: M.z[i], ax: M.x[(i - 3 + N) % N] - M.x[i], az: M.z[(i - 3 + N) % N] - M.z[i], i, s: M.s });
    if (!a && b) ends.push({ x: M.x[i], z: M.z[i], ax: M.x[(i + 3) % N] - M.x[i], az: M.z[(i + 3) % N] - M.z[i], i, s: M.s }); }
  for (const C of D.cuts) {
    const on = [...C.on.slice(0, C.x.length - 1)], k0 = on.indexOf(1), k1 = on.lastIndexOf(1);
    if (k0 < 0) continue;
    for (const [end, k, to] of [['in', k0, Math.min(k0 + 3, C.x.length - 1)], ['out', k1 + 1, Math.max(k1 - 2, 0)]]) {
      const cx = C.x[k], cz = C.z[k], ax = C.x[to] - cx, az = C.z[to] - cz;
      let best = null; for (const e of ends) { const d = Math.hypot(e.x - cx, e.z - cz); if (!best || d < best.d) best = { d, e }; }
      if (!best || best.d > 20) { mouths.push({ shortcut: C.sc.k, end, side: C.s > 0 ? 'L' : 'R', 'angle °': '—', 'hole m': '—', x: f0(cx), z: f0(cz) }); continue; }
      const e = best.e, cos = (ax * e.ax + az * e.az) / (Math.hypot(ax, az) * Math.hypot(e.ax, e.az));
      mouths.push({ shortcut: C.sc.k, end, side: C.s > 0 ? 'L' : 'R', 'angle °': (Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI).toFixed(0), 'hole m': best.d.toFixed(2), main: `${e.s > 0 ? 'L' : 'R'} ${e.i}`, x: f0(cx), z: f0(cz) });
    }
  }
  if (mouths.length) { console.log('shortcut mouths: the angle between the shortcut\'s wall and the main wall it meets (both away from the corner; small = a blade), the hole between their ends'); console.table(mouths); }
  const blades = mouths.filter(m => m['angle °'] !== '—' && +m['angle °'] < 60);
  summary.push({ map: id, name: T.MAP.name, puddles: puddles.length, 'deepest m': puddles.length ? puddles[0].depth.toFixed(2) : '0', 'min clear m': minClear.toFixed(3),
    'invisible rays': bad.invisible.length, grazing, 'through rays': bad.through.length, 'wall places': places.length, 'worst both m': Math.max(worst('invisible'), worst('through')).toFixed(2),
    mouths: mouths.length, 'blades <60°': blades.length, 'sharpest °': mouths.some(m => m['angle °'] !== '—') ? Math.min(...mouths.filter(m => m['angle °'] !== '—').map(m => +m['angle °'])).toFixed(0) : '—' });
}
console.log('\n=== summary');
console.table(summary);
