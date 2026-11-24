// ?debug=hit (plan 3, stage 0): what the collision code sees, drawn over the game.
// Loaded by main.js only with the flag (nothing of it exists otherwise).
//
//   pink     each car's and bot's hitbox (core/hitboxes.js): the one shape the collision
//            code uses, against the walls (core/contact.js, stage 3), other players' cars
//            (net/bump.js, stage 4) and the highway's traffic (modes/traffic/collide.js);
//            a short line from its centre shows the nose
//   cyan     the walls as drawn (wall polylines, modes/track/walls.js: what the cars collide with)
//   red      where the centre of a car pointing along the road is stopped (measured with
//            constrainToTrack, modes/track/wall-lines.js; on the highway the rail less the
//            car's half width)
//   orange   how far that car's body (its hitbox) then reaches along the ray: on the cyan
//            line wherever the collision wall is the drawn one
//   magenta  ticks where the stopped body is more than 5 cm from any drawn wall (an
//            invisible wall) or reaches past the drawn wall (a wall the car goes through)
//   green    the last contact: its point, and 2 m along the normal (into what was hit)
// Lines only, drawn over everything. The track's lines are built once per map (the measured
// ones over the next idle moments).
import { scene } from './render.js';
import { HITLOG } from './hitlog.js';
import { MAP, N } from '../modes/track/geometry.js';
import { drawnWalls, wallRays } from '../modes/track/wall-lines.js';
import { bodyOf } from './contact.js';
import { RAIL } from '../modes/traffic/geometry.js';
import { TYPES } from '../modes/traffic/sim.js';
import { botPose } from '../modes/traffic/collide.js';
import { worldPoly, hitbox } from './hitboxes.js';

const COL = { poly: [1, .25, .63], drawn: [.25, .95, 1], limit: [1, .15, .15], body: [1, .55, .1], bad: [1, .2, 1], hit: [.2, 1, .3] };
const LIFT = .12;               // m above the road
const mat = () => new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: .95, toneMapped: false });

// a growing list of line segments: positions and colours
// (each one three times, 4 cm apart in height: thin WebGL lines read better seen from above)
function segs() {
  const p = [], c = [];
  return { p, c, add(ax, ay, az, bx, by, bz, col) { for (let k = 0; k < 3; k++) { p.push(ax, ay + k * .04, az, bx, by + k * .04, bz); c.push(...col, ...col); } } };
}

export function createHitDebug({ car, G, NET, bots }) {
  HITLOG.on = true;
  // static: the track's walls, one set per map. The drawn ones at once; the measured ones
  // (wall-lines.js wallRays: ~35-85 ms a map) a few rays at a time while the browser is idle,
  // so the race loop never waits for them.
  let drawnLines = null, limitLines = null, builtFor = null, job = null, bad = 0;
  const idle = typeof requestIdleCallback === 'function' ? cb => requestIdleCallback(cb, { timeout: 100 }) : cb => setTimeout(() => cb(null), 16);
  const mesh = (S, order) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(S.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(S.c, 3));
    const m = new THREE.LineSegments(g, mat()); m.renderOrder = order; m.frustumCulled = false; scene.add(m); return m;
  };
  const drop = m => { if (m) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } return null; };
  function buildTrack() {
    drawnLines = drop(drawnLines); limitLines = drop(limitLines);
    const S = segs(), D = drawnWalls();
    for (const L of D.lines) for (let k = 0; k < (L.closed ? L.n : L.n - 1); k++) {
      const j = (k + 1) % L.n;
      S.add(L.x[k], L.y[k] + LIFT, L.z[k], L.x[j], L.y[j] + LIFT, L.z[j], COL.drawn);
    }
    drawnLines = mesh(S, 999); builtFor = MAP; bad = -1;
    const J = job = { map: MAP, it: wallRays(D), rays: [] };
    const work = deadline => {
      if (job !== J || MAP !== J.map) return;                        // a new map: that one's job runs instead
      const t0 = performance.now(), budget = Math.max(2, Math.min(8, deadline ? deadline.timeRemaining() : 6));
      while (performance.now() - t0 < budget) { const r = J.it.next(); if (r.done) { limitLines = limits(J.rays); job = null; return; } J.rays.push(r.value); }
      idle(work);
    };
    idle(work);
  }
  // the measured limits: consecutive rays of one line (same road, same side) joined
  function limits(rays) {
    const S = segs(), pt = (r, o) => [r.ox + r.dx * o, r.oy + r.bank * o + LIFT, r.oz + r.dz * o];
    bad = 0;
    for (let k = 0; k < rays.length; k++) {
      const r = rays[k];
      if (r.type === 'invisible' || r.type === 'through') { bad++; const o = Math.min(isFinite(r.body) ? r.body : 1e9, isFinite(r.drawn) ? r.drawn : 1e9), q = pt(r, o); S.add(q[0], q[1], q[2], q[0], q[1] + 1.2, q[2], COL.bad); }
      // the next ray along the same line (rays go side by side: left, right; the main road closes on itself)
      const n = r.kind === 'main' ? rays[((r.ref + 1) % N) * 2 + (r.s > 0 ? 0 : 1)] : rays[k + 2];
      if (!n || n.kind !== r.kind || n.s !== r.s || (r.kind === 'cut' && n.ref[0] !== r.ref[0])) continue;
      if (!isFinite(r.c) || !isFinite(n.c)) continue;
      for (const [o0, o1, col] of [[r.c, n.c, COL.limit], [r.body, n.body, COL.body]]) {
        const a = pt(r, o0), b = pt(n, o1);
        if (Math.hypot(a[0] - b[0], a[2] - b[2]) < 4) S.add(a[0], a[1], a[2], b[0], b[1], b[2], col);
      }
    }
    return mesh(S, 999);
  }

  // dynamic: cars, the highway's rails, the last contact. Written relative to an origin
  // near the car (the mesh sits there): far down the highway, world z in 32-bit floats would
  // shake by centimetres.
  const MAXV = 20000, pos = new Float32Array(MAXV * 3), col = new Float32Array(MAXV * 3);
  const dg = new THREE.BufferGeometry();
  dg.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  dg.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  const dyn = new THREE.LineSegments(dg, mat()); dyn.renderOrder = 1000; dyn.frustumCulled = false; scene.add(dyn);
  let nv = 0, ox = 0, oz = 0;
  const line = (ax, ay, az, bx, by, bz, c) => {
    if (nv + 2 > MAXV) return;
    let i = nv * 3;
    pos[i] = ax - ox; pos[i + 1] = ay; pos[i + 2] = az - oz; pos[i + 3] = bx - ox; pos[i + 4] = by; pos[i + 5] = bz - oz;
    col[i] = col[i + 3] = c[0]; col[i + 1] = col[i + 4] = c[1]; col[i + 2] = col[i + 5] = c[2];
    nv += 2;
  };
  const circle = (x, y, z, r, c, n = 24) => { for (let k = 0; k < n; k++) { const a = k / n * 6.2832, b = (k + 1) / n * 6.2832; line(x + Math.sin(a) * r, y, z + Math.cos(a) * r, x + Math.sin(b) * r, y, z + Math.cos(b) * r, c); } };
  const cross = (x, y, z, r, c) => { line(x - r, y, z, x + r, y, z, c); line(x, y, z - r, x, y, z + r, c); line(x, y - r, z, x, y + r, z, c); };
  const PW = new Float64Array(64);
  function drawPoly(id, x, y, z, h) {
    worldPoly(id, x, z, h, PW); const n = hitbox(id).poly.length;
    for (let i = 0; i < n; i += 2) { const j = (i + 2) % n; line(PW[i], y, PW[i + 1], PW[j], y, PW[j + 1], COL.poly); }
  }
  function drawCar(id, x, y, z, h) {
    y += LIFT;
    drawPoly(id, x, y + .04, z, h);
    cross(x, y, z, .25, COL.poly);
    const fx = Math.sin(h), fz = Math.cos(h);
    line(x, y, z, x + fx * 1.2, y, z + fz * 1.2, COL.poly);                          // the nose
  }
  // the last contact: kept 3 s
  let shown = null, shownAt = 0;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:99;font:12px/1.35 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.6);padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre';
  document.body.append(box);
  let boxT = 0;
  const legend = `\u25a0 pink hitbox (walls, cars, traffic)  \u25a0 cyan drawn wall\n\u25a0 red centre stop (car along the road)  \u25a0 orange its body\n\u25a0 magenta >5 cm off / through  \u25a0 green last contact`;

  return {
    frame(now = performance.now()) {
      const track = G.mode && G.mode.id === 'track';
      if (track && builtFor !== MAP) buildTrack();
      if (drawnLines) drawnLines.visible = track;
      if (limitLines) limitLines.visible = track;
      nv = 0; ox = Math.round(car.x / 64) * 64; oz = Math.round(car.z / 64) * 64; dyn.position.set(ox, 0, oz);
      // the player and the other players
      drawCar(car.carId, car.x, car.root ? car.root.position.y : (car.y || 0), car.z, car.h);
      for (const g of NET.ghosts.values()) if (g.m && g.m.root.visible && g.x !== undefined) drawCar(g.car, g.x, g.m.root.position.y, g.z, g.h);
      if (!track) {
        // the highway: the rails as drawn (inner face at RAIL), the centre's limit, the body's
        const z0 = car.z - 120, z1 = car.z + 320;
        const half = bodyOf(car.carId).half;                       // (the car's half width: where its centre stops, side on to the rail)
        for (const s of [1, -1]) {
          line(s * RAIL, LIFT, z0, s * RAIL, LIFT, z1, COL.drawn);
          line(s * (RAIL - half), LIFT, z0, s * (RAIL - half), LIFT, z1, COL.limit);
          line(s * RAIL, LIFT + .04, z0, s * RAIL, LIFT + .04, z1, COL.body);
        }
        const src = bots && bots();
        if (src) for (const b of src.bots) { const T = TYPES[b.t], p = botPose(b, src.alpha); if (Math.abs(p.z - car.z) < 200) drawPoly('bot:' + T.name, p.x, LIFT + .04, p.z, p.yaw); }
      }
      const L = HITLOG.last;
      if (L && (!shown || L.seq !== shown.seq)) { shown = L; shownAt = now; }
      if (shown && now - shownAt < 3000) {
        const y = (car.root ? car.root.position.y : 0) + LIFT + .05;
        cross(shown.x, y, shown.z, .4, COL.hit); circle(shown.x, y, shown.z, .15, COL.hit, 8);
        line(shown.x, y, shown.z, shown.x + shown.nx * 2, y, shown.z + shown.nz * 2, COL.hit);
      }
      dg.setDrawRange(0, nv);
      dg.attributes.position.needsUpdate = true; dg.attributes.color.needsUpdate = true;
      if (now - boxT > 250) {
        boxT = now;
        const c = shown && now - shownAt < 3000 ? `last ${shown.kind}: ${(shown.vn * 3.6).toFixed(1)} km/h in, pushed ${(shown.pen * 100).toFixed(1)} cm` : 'no contact';
        const walls = bad < 0 ? 'measuring the walls\u2026' : `${bad} rays >5 cm apart`;
        box.textContent = legend + '\n' + (track ? `map ${MAP.id}: ${walls}` : 'highway') + '\n' + c;
      }
    },
  };
}
