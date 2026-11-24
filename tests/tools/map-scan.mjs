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
//  3. shortcut mouths: where a shortcut's drawn wall meets the main road's, the arc that
//     rounds the corner (its radius, the angle it turns through), and the sharpest joint
//     between two segments of wall round the mouth (none sharper than the arc's own steps);
//     every wall polyline closed (no wall ends, no holes between them).
//  (stage 2) 4. one source: the drawn walls are the collision polylines (geometry.js WALLS,
//     the wallsNear() query finds every drawn point on a wall); holes: points of the
//     drivable space (rays out to the walls) that no strip covers (the ground would show);
//     and the walls stage 3 will collide with: the same rays with a car whose centre keeps
//     WALL_ALLOW from the polylines (today's one-point check, on the new walls): invisible
//     and see-through rays there (should be none). Section 2 is then exactly what stage 3
//     fixes: today's collision against these polylines.
//   npm run scan:maps [-- map ...]
import { createRequire } from 'node:module';
const R = new URL('../../', import.meta.url).href;
globalThis.THREE = createRequire(new URL('package.json', R))('three');
const T = await import(R + 'public/js/modes/track/geometry.js');
const W = await import(R + 'public/js/modes/track/wall-lines.js');
const { MAPS, MAP_IDS } = await import(R + 'public/js/modes/track/maps/index.js');
const { STRIP_Y: SY } = W;
const { wallsNear: near0 } = await import(R + 'public/js/modes/track/walls.js');
const { WALL_ALLOW } = await import(R + 'public/js/core/contact.js');

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
  const { N, P, NM, Y, HALF, CURB, WALL, SHORTCUTS } = T, flat = Y.every(y => y === 0), gy = W.groundLevel(), D = W.drawnWalls();
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
    const cs = [['cut run-off', -sc.wall, sc.wall, SY.cutRunoff, k => onMain(k, HALF + CURB)], ['cut road', -sc.half, sc.half, SY.cutRoad, k => dm[k] < HALF - .3 && dm[k + 1] < HALF - .3],
      ['cut curb', sc.half, sc.half + .5, SY.cutCurb, k => onMain(k, HALF + CURB)], ['cut curb', -sc.half - .5, -sc.half, SY.cutCurb, k => onMain(k, HALF + CURB)]];
    const fl = new Array(sc.n).fill(null);
    for (const [name, , , yOff, skip] of cs) for (let k = 0; k < sc.n - 1; k++) { if (skip(k)) continue;
      for (const q of [k, k + 1]) { const c = sc.y[q] + yOff - gy;
        if (c < minClear) { minClear = c; minClearAt = { name, i: `cut ${sc.k}:${q}`, x: sc.x[q], z: sc.z[q] }; }
        if (c < 0 && (!fl[k] || -c > fl[k].v)) fl[k] = { v: -c, name, x: sc.x[q], z: sc.z[q] }; } }
    for (const r of runs(fl, sc.n, false)) puddles.push({ where: `cut ${sc.k} ${r.from}-${r.to}`, points: r.count, depth: r.worst.v, surface: r.worst.name, x: r.worst.x, z: r.worst.z });
  }
  // the mouths' fills (scene.js filletFill: the corner out to its arc)
  D.fillets.forEach((f, q) => { let v = null; for (const p of [f, ...f.fill]) { const c = p.y + SY.cutRunoff - gy;
      if (c < minClear) { minClear = c; minClearAt = { name: 'mouth fill', i: `fillet ${q}`, x: p.x, z: p.z }; }
      if (c < 0 && (!v || -c > v.v)) v = { v: -c, x: p.x, z: p.z }; }
    if (v) puddles.push({ where: `fillet ${q}`, points: 1, depth: v.v, surface: 'mouth fill', x: v.x, z: v.z }); });
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

  // 3. shortcut mouths: the arcs, the joints round them, the chains closed
  const turnAt = (L, k) => { const n = L.n, a = (k - 1 + n) % n, b = (k + 1) % n;
    const ux = L.x[k] - L.x[a], uz = L.z[k] - L.z[a], vx = L.x[b] - L.x[k], vz = L.z[b] - L.z[k], lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
    const t = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uz * vz) / (lu * lv)))); return { t, r: t > 1e-9 ? (lu + lv) / 2 / t : Infinity }; };
  const mouths = [];
  for (const [q, f] of D.fillets.entries()) {
    // the joints of the arc: its points and the two tangent points, found in their chain
    // (min r: the arc's own points; sharpest joint: also where it meets the straight walls)
    let sharp = 0, rmin = Infinity;
    for (const [qi, p] of f.arc.entries()) for (const L of D.lines) for (let k = 0; k < L.n; k++) {
      if (Math.abs(L.x[k] - p.x) > 1e-9 || Math.abs(L.z[k] - p.z) > 1e-9 || (!L.closed && (k === 0 || k === L.n - 1))) continue;
      const j = turnAt(L, k); sharp = Math.max(sharp, j.t); if (qi > 0 && qi < f.arc.length - 1) rmin = Math.min(rmin, j.r); }
    const sweep = Math.PI - f.theta, step = (sweep / (f.arc.length - 1)) * 180 / Math.PI;
    mouths.push({ shortcut: f.cut, 'walls °': (f.theta * 180 / Math.PI).toFixed(0), 'arc r m': f.r.toFixed(2), 'trim m': f.d.toFixed(1), 'arc step °': step.toFixed(1),
      'sharpest joint °': (sharp * 180 / Math.PI).toFixed(1), 'min r m': rmin.toFixed(2), x: f0(f.x), z: f0(f.z), ok: f.r >= 4 - 1e-6 && f.r <= 6 + 1e-6 && sharp * 180 / Math.PI <= step + 3 });
  }
  const open = D.lines.filter(L => !L.closed).length;
  if (mouths.length) { console.log(`shortcut mouths: the arc that rounds each corner where a shortcut's wall meets the main road's (walls °: the angle between them away from the corner, small = a blade), the sharpest joint between wall segments round it; ${open} open wall lines`); console.table(mouths); }
  if (D.problems.length) console.log('wall build problems:', D.problems);
  const blades = mouths.filter(m => !m.ok);

  // 4. one source; holes; the walls stage 3 collides with
  let srcMiss = 0, srcPts = 0; const NB = [];
  for (const L of D.lines) for (let k = 0; k < L.n; k++) { srcPts++;
    const c = near0(T.WALLS, L.x[k], L.z[k], L.y[k], .01, NB); if (!(c && NB[0].d < 1e-9)) srcMiss++; }
  if (D !== T.WALLS) srcMiss = srcPts;
  // holes: along the rays (main and shortcuts) out to the drawn wall, points no strip covers
  const OL = { 1: T.safeOffsets(WALL), '-1': T.safeOffsets(-WALL) };
  const cutsCover = SHORTCUTS.map(sc => { const dm = Float64Array.from({ length: sc.n }, (_, k) => W.mainDist(sc.x[k], sc.z[k])); return k => !(dm[k] < HALF + CURB && dm[k + 1] < HALF + CURB); });
  const inTri = (px, pz, a, b, c) => { const d = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x); if (Math.abs(d) < 1e-12) return false;
    const u = ((b.x - px) * (c.z - pz) - (b.z - pz) * (c.x - px)) / d, v = ((c.x - px) * (a.z - pz) - (c.z - pz) * (a.x - px)) / d; return u >= -1e-6 && v >= -1e-6 && 1 - u - v >= -1e-6; };
  const covered = (x, z, i0) => {
    let bj = i0, bd = 1e18; for (let q = -40; q <= 40; q++) { const j = (i0 + q + N) % N, dx = P[j].x - x, dz = P[j].z - z, d = dx * dx + dz * dz; if (d < bd) { bd = d; bj = j; } }
    const lat = (x - P[bj].x) * NM[bj].x + (z - P[bj].z) * NM[bj].z, s = lat >= 0 ? 1 : -1;
    if (Math.abs(lat) <= Math.abs(OL[s][bj]) + .03) return true;
    for (const [c, sc] of SHORTCUTS.entries()) { const b = sc.box; if (x < b[0] || x > b[1] || z < b[2] || z > b[3]) continue;
      let k = 0, kd = 1e18; for (let q = 0; q < sc.n; q++) { const dx = x - sc.x[q], dz = z - sc.z[q], d = dx * dx + dz * dz; if (d < kd) { kd = d; k = q; } }
      const rx = x - sc.x[k], rz = z - sc.z[k], al = rx * sc.tx[k] + rz * sc.tz[k];
      if ((k === 0 && al < 0) || (k === sc.n - 1 && al > 0)) continue;
      const kk = al >= 0 ? Math.min(k, sc.n - 2) : Math.max(k - 1, 0);
      if (Math.abs(rx * sc.nx[k] + rz * sc.nz[k]) <= sc.wall + .03 && (cutsCover[c](kk) || cutsCover[c](Math.max(0, kk - 1)) || cutsCover[c](Math.min(sc.n - 2, kk + 1)))) return true; }
    for (const f of D.fillets) for (let q = 0; q < f.fill.length - 1; q++) if (inTri(x, z, f, f.fill[q], f.fill[q + 1])) return true;
    return false; };
  const holes = [];
  const scanRay = (ox, oz, dx, dz, upto, i0, where) => { for (let o = .25; o < upto - .1; o += .25) { const x = ox + dx * o, z = oz + dz * o; if (!covered(x, z, i0)) { holes.push({ where, x, z }); return; } } };
  // the stage-3 wall: the first point along a ray where the centre comes within WALL_ALLOW of
  // a polyline (wallsNear), and the point of wall it touches there
  const polyLimit = (ox, oz, oy, bank, dx, dz, max) => {
    const dist = o => { const n = near0(T.WALLS, ox + dx * o, oz + dz * o, oy + bank * o, WALL_ALLOW + .6, NB); return n ? NB[0] : null; };
    let prev = 0;
    for (let o = .25; o <= max + 1e-9; o += .25) { const e = dist(o);
      if (e && e.d < WALL_ALLOW) { let a = prev, b = o; for (let k = 0; k < 12; k++) { const m = (a + b) / 2, q = dist(m); if (q && q.d < WALL_ALLOW) b = m; else a = m; }
        const q = dist(b), cx = ox + dx * b - q.px, cz = oz + dz * b - q.pz, l = Math.hypot(cx, cz) || 1; return { c: b, cos: Math.abs(cx * dx + cz * dz) / l, px: q.px, pz: q.pz, y: q.y }; }
      prev = o; }
    return { c: NaN, cos: 1 }; };
  // the drawn walls' segments, searched one by one (not through the grid wallsNear uses)
  const drawnSegs = []; for (const L of D.lines) for (let k = 0; k < (L.closed ? L.n : L.n - 1); k++) { const j = (k + 1) % L.n; drawnSegs.push([L.x[k], L.z[k], L.x[j], L.z[j], (L.y[k] + L.y[j]) / 2]); }
  const toDrawn = (x, z, y) => { let best = Infinity; for (const [ax, az, bx, bz, sy] of drawnSegs) { if (Math.abs(sy - y) > T.SAME_LEVEL) continue;
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez, t = L2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2)) : 0, d = Math.hypot(x - ax - ex * t, z - az - ez * t); if (d < best) best = d; } return best; };
  // invisible: the body stops against a point that is on no drawn wall; through: the centre
  // passes a drawn wall before it is stopped; beside: the body touches a drawn wall beside the
  // ray, not where the ray meets one (corners, arcs, the narrow shortcuts): fine, counted only
  const s3 = { invisible: 0, through: 0, beside: 0, worst: 0, at: null };
  const judge3 = r => { const L = polyLimit(r.ox, r.oz, r.oy, r.bank, r.dx, r.dz, r.max);
    const where = () => r.kind === 'main' ? `main ${r.ref} ${r.s > 0 ? 'L' : 'R'}` : `cut ${r.ref[0]}:${r.ref[1]} ${r.s > 0 ? 'L' : 'R'}`;
    const bad = (type, miss, x, z) => { s3[type]++; if (miss > s3.worst) { s3.worst = miss; s3.at = { type, x, z, where: where() }; } };
    if (isFinite(r.drawn) && (!isFinite(L.c) || r.drawn < L.c - W.TOL)) { bad('through', isFinite(L.c) ? L.c - r.drawn : r.max - r.drawn, r.ox + r.dx * r.drawn, r.oz + r.dz * r.drawn); return; }
    if (!isFinite(L.c)) return;
    const off = toDrawn(L.px, L.pz, L.y); if (off > W.TOL) { bad('invisible', off, L.px, L.pz); return; }
    const body = L.c + WALL_ALLOW / Math.max(L.cos, .2), d = isFinite(r.drawn) ? r.drawn : r.max + WALL_ALLOW / Math.max(L.cos, .2);
    if (Math.abs(body - d) > W.TOL) s3.beside++; };
  for (const r of rays) {
    const i0 = r.kind === 'main' ? r.ref : (SHORTCUTS[r.ref[0]].E + Math.round(SHORTCUTS[r.ref[0]].span * r.ref[1] / (SHORTCUTS[r.ref[0]].n - 1))) % N;
    if (isFinite(r.drawn)) scanRay(r.ox, r.oz, r.dx, r.dz, r.drawn, i0, r.kind === 'main' ? `main ${r.ref}` : `cut ${r.ref[0]}:${r.ref[1]}`);
    judge3(r);
  }
  console.log(`one source: ${srcPts} drawn wall points, ${srcMiss} not on a collision polyline; holes (drivable space no strip covers): ${holes.length}${holes.length ? ': ' + holes.slice(0, 8).map(h => `${h.where} (x ${h.x.toFixed(1)} z ${h.z.toFixed(1)})`).join(', ') : ''}`);
  console.log(`stage 3 walls (the polylines, centre point + ${WALL_ALLOW} m): invisible ${s3.invisible}, through ${s3.through}${s3.at ? ` (worst ${s3.at.type} ${s3.worst.toFixed(2)} m, ${s3.at.where}, x ${f0(s3.at.x)} z ${f0(s3.at.z)})` : ''}; ${s3.beside} rays where the body touches a drawn wall beside the ray`);

  summary.push({ map: id, name: T.MAP.name, 'ground y': gy, puddles: puddles.length, 'deepest m': puddles.length ? puddles[0].depth.toFixed(2) : '0', 'min clear m': minClear.toFixed(3), holes: holes.length,
    'invisible rays': bad.invisible.length, grazing, 'through rays': bad.through.length, 'wall places': places.length, 'worst both m': Math.max(worst('invisible'), worst('through')).toFixed(2),
    'not one source': srcMiss, 'open lines': open, 'mouths (arcs)': mouths.length, 'not rounded': blades.length,
    'arc r m': mouths.length ? `${Math.min(...mouths.map(m => +m['arc r m'])).toFixed(1)}–${Math.max(...mouths.map(m => +m['arc r m'])).toFixed(1)}` : '—',
    'stage 3: invisible': s3.invisible, 'stage 3: through': s3.through, 'stage 3: beside': s3.beside });
}
console.log('\n=== summary');
console.table(summary);
