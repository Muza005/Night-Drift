// ?debug=hit (plan 3, stage 0): what the collision code sees, drawn over the game.
// Loaded by main.js only with the flag (nothing of it exists otherwise).
//
//   yellow   each car's wall shape today: its centre and the allowance circle (1.25 m)
//   white    each car's car-to-car shape (net/bump.js: two circles); traffic bots: their box
//   cyan     the walls as drawn (scene.js: safeOffsets, the gaps at the shortcuts)
//   red      where the car's centre is really stopped (measured with constrainToTrack,
//            modes/track/wall-lines.js; on the highway RAIL - WALL_ALLOW)
//   orange   red + the allowance (along the wall's normal): where the yellow circle
//            touches, the collision wall as the body feels it
//   magenta  ticks where orange and cyan differ by more than 5 cm (invisible walls, walls
//            the car goes through)
//   green    the last contact: its point, and 2 m along the normal (into what was hit)
// Lines only, drawn over everything. The track's lines are built once per map (the measured
// ones over the next idle moments).
import { scene } from './render.js';
import { HITLOG } from './hitlog.js';
import { BUMP } from '../net/bump.js';
import { MAP, N } from '../modes/track/geometry.js';
import { drawnWalls, wallRays, ALLOW } from '../modes/track/wall-lines.js';
import { RAIL } from '../modes/traffic/geometry.js';
import { TYPES } from '../modes/traffic/sim.js';
import { botPose } from '../modes/traffic/collide.js';

const COL = { car: [1, .85, .1], bump: [1, 1, 1], drawn: [.25, .95, 1], limit: [1, .15, .15], body: [1, .55, .1], bad: [1, .2, 1], hit: [.2, 1, .3] };
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
    for (const W of [...D.main, ...D.cuts]) for (let i = 0; i < W.x.length; i++) {
      if (!W.on[i]) continue; const j = (i + 1) % W.x.length; if (j === 0 && W.sc) continue;
      S.add(W.x[i], W.y[i] + LIFT, W.z[i], W.x[j], W.y[j] + LIFT, W.z[j], COL.drawn);
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
  function drawCar(x, y, z, h) {
    y += LIFT;
    circle(x, y, z, ALLOW, COL.car); cross(x, y, z, .25, COL.car);
    const fx = Math.sin(h), fz = Math.cos(h);
    circle(x + fx * BUMP.OFF, y + .02, z + fz * BUMP.OFF, BUMP.R, COL.bump, 20);
    circle(x - fx * BUMP.OFF, y + .02, z - fz * BUMP.OFF, BUMP.R, COL.bump, 20);
    line(x, y, z, x + fx * 2.6, y, z + fz * 2.6, COL.bump);                          // the nose
  }
  const corner = (x, z, s, k, a, b, i) => { BOX[i] = x + a * k + b * s; BOX[i + 1] = z - a * s + b * k; };
  const BOX = new Float64Array(8);
  function drawBox(x, y, z, yaw, hw, hl, c) {
    const s = Math.sin(yaw), k = Math.cos(yaw);
    corner(x, z, s, k, -hw, -hl, 0); corner(x, z, s, k, hw, -hl, 2); corner(x, z, s, k, hw, hl, 4); corner(x, z, s, k, -hw, hl, 6);
    for (let i = 0; i < 8; i += 2) { const j = (i + 2) % 8; line(BOX[i], y, BOX[i + 1], BOX[j], y, BOX[j + 1], c); }
  }
  // the last contact: kept 3 s
  let shown = null, shownAt = 0;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:99;font:12px/1.35 ui-monospace,monospace;color:#fff;background:rgba(0,0,0,.6);padding:6px 8px;border-radius:6px;pointer-events:none;white-space:pre';
  document.body.append(box);
  let boxT = 0;
  const legend = `\u25a0 yellow wall circle ${ALLOW} m  \u25a0 white car-to-car circles\n\u25a0 cyan drawn wall  \u25a0 red centre limit  \u25a0 orange body limit\n\u25a0 magenta >5 cm apart  \u25a0 green last contact`;

  return {
    frame(now = performance.now()) {
      const track = G.mode && G.mode.id === 'track';
      if (track && builtFor !== MAP) buildTrack();
      if (drawnLines) drawnLines.visible = track;
      if (limitLines) limitLines.visible = track;
      nv = 0; ox = Math.round(car.x / 64) * 64; oz = Math.round(car.z / 64) * 64; dyn.position.set(ox, 0, oz);
      // the player and the other players
      drawCar(car.x, car.root ? car.root.position.y : (car.y || 0), car.z, car.h);
      for (const g of NET.ghosts.values()) if (g.m && g.m.root.visible && g.x !== undefined) drawCar(g.x, g.m.root.position.y, g.z, g.h);
      if (!track) {
        // the highway: the rails as drawn (inner face at RAIL), the centre's limit, the body's
        const z0 = car.z - 120, z1 = car.z + 320;
        for (const s of [1, -1]) {
          line(s * RAIL, LIFT, z0, s * RAIL, LIFT, z1, COL.drawn);
          line(s * (RAIL - ALLOW), LIFT, z0, s * (RAIL - ALLOW), LIFT, z1, COL.limit);
          line(s * RAIL, LIFT + .04, z0, s * RAIL, LIFT + .04, z1, COL.body);
        }
        const src = bots && bots();
        if (src) for (const b of src.bots) { const T = TYPES[b.t], p = botPose(b, src.alpha); if (Math.abs(p.z - car.z) < 200) drawBox(p.x, LIFT, p.z, p.yaw, T.wid / 2, T.len / 2, COL.bump); }
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
