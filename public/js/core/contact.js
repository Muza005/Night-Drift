// Wall contact (plan 3, stage 3): the car's hitbox polygon (core/hitboxes.js) against the
// walls, and what a hit does to the car. Both modes use it: the drift track's wall polylines
// (modes/track/walls.js, through geometry.js constrainToTrack and keepInWalls) and the
// highway's rails (modes/traffic/geometry.js). Pure maths, no allocation per call.
//
// Contact. Every vertex of the polygon is tested against the wall segments near the car: its
// nearest point on them, and on which side (a segment's normal; at a segment's end the
// average of the two normals there, so a corner of wall is judged right from either side).
// Behind the wall: a contact, depth = the distance, normal = from the vertex to that point.
// Corners of wall that stick into the road (the rounded mouths, every outside bend) can
// poke into the car between two vertices: each such wall point inside the polygon is a
// contact too, pushed out through the nearest edge. Of all contacts the deepest decides
// the normal and the depth; the point is the depth-weighted middle of the contacts facing
// the same way (a car pressed flat against a wall touches along its whole side: the
// middle, no turn from it).
//
// Response, the car a rigid body (mass m, yaw inertia I = m (L² + W²) / 12 from its
// hitbox) against an immovable wall, at the contact point:
//  - position: pushed out along the normal by the depth, nothing sideways;
//  - normal impulse from the speed of the contact point into the wall (the car's velocity
//    plus its spin, car.spinV, at that point), restitution E by how hard: none up to
//    E_FROM (the car just stops against the wall), rising to E_MAX at E_TO;
//  - friction along the wall, Coulomb: at most MU × the normal impulse (a glancing touch
//    loses little, a hit at a big angle a lot of its speed along the wall);
//  - the impulses' lever arm turns the car (car.spinV, the spin stepCar already applies
//    and damps: the same as a hit by another car, net/bump.js). The tyres hold most of a
//    car's yaw: the wall sees YAW_K of the body's turn (its inertia / YAW_K), at most SPIN.
//  - a car sliding along the wall nose-in turns along its motion (wallAlign, below).
// Nothing here touches stepCar (core/physics.js): the response runs after it, in the
// modes' constrain step.
import { hitbox, worldPoly } from './hitboxes.js';
import { carMass } from './cars.js';
import { HITLOG } from './hitlog.js';

// Road switching only (which road a car is on near a shortcut's mouth, geometry.js): a
// car's centre this far (m) inside a road's wall line still counts as on that road. The
// walls themselves are the polygon's business.
export const WALL_ALLOW = 1.25;

export const WALL = {
  E_MAX: .15,                 // restitution at most (a hard hit)
  E_FROM: 10 / 3.6,           // m/s into the wall: below this no bounce at all
  E_TO: 150 / 3.6,            // m/s into the wall: from this on E_MAX
  MU: .2,                     // friction along the wall (plan 3 stage 6 tunes it in .1–.3)
  YAW_K: .5,                  // part of the body's turn the car really takes (the tyres hold the rest)
  SPIN: 2.5,                  // rad/s at most from a wall
  KG: 1400,                   // kg of a car of mass 1 (core/cars.js: the classes' ratios)
  DEPTH: 1.2,                 // m: the least depth a vertex is searched behind a wall; track/geometry.js deepens it to the substep's travel + .3 m
  SOUND: 2.5,                 // m/s into the wall from which the modes' onWall(power) hook is called
  PASSES: 3,                  // contacts resolved per substep at most (a corner of two walls: two)
  ALIGN: 10,                  // 1/s: how fast a car sliding along a wall nose-in turns along its motion
  ALIGN_V: 3,                 // m/s along the wall from which it does (a nose touch, a car stopped against it: no turn)
};

// A car's body for the wall: hitbox, mass (kg), yaw inertia (kg m²). Cached per car id.
const BODIES = new Map();
export function bodyOf(id){
  let b = BODIES.get(id);
  if(!b){ const hb = hitbox(id), m = WALL.KG * carMass(id);
    b = { id, hb, nv: hb.poly.length >> 1, r: hb.r, half: Math.max(hb.left, hb.right), m, I: m * (hb.len * hb.len + hb.wid * hb.wid) / 12 };
    BODIES.set(id, b); }
  return b;
}

// Restitution for a speed into the wall (m/s)
export const restitution = vin => WALL.E_MAX * Math.min(1, Math.max(0, (vin - WALL.E_FROM) / (WALL.E_TO - WALL.E_FROM)));

// --- contacts ---
// Candidates: x, z (the contact point), nx, nz (the push, out of the wall), depth
const MAXC = 96, CT = new Float64Array(MAXC * 5);
let nc = 0;
const add = (x, z, nx, nz, d) => { if(nc >= MAXC) return; const o = nc * 5; CT[o] = x; CT[o + 1] = z; CT[o + 2] = nx; CT[o + 3] = nz; CT[o + 4] = d; nc++; };
// The contact out of the candidates: { n (how many touch), px, pz, nx, nz, depth }; false if none
function gather(out){
  if(!nc) { out.n = 0; return false; }
  let b = 0; for(let i = 1; i < nc; i++) if(CT[i * 5 + 4] > CT[b * 5 + 4]) b = i;
  const nx = CT[b * 5 + 2], nz = CT[b * 5 + 3];
  let w = 0, x = 0, z = 0, n = 0;
  for(let i = 0; i < nc; i++){ const o = i * 5; if(CT[o + 2] * nx + CT[o + 3] * nz < .9) continue;
    const d = CT[o + 4] + 1e-6; x += CT[o] * d; z += CT[o + 1] * d; w += d; n++; }
  out.n = n; out.px = x / w; out.pz = z / w; out.nx = nx; out.nz = nz; out.depth = CT[b * 5 + 4];
  return true;
}

// Polygon P (nv vertices, world [x0, z0, ...], counter-clockwise; centre cx, cz, bounding
// radius r) against the wall segments near[0..cnt-1] (walls.js wallsNear entries) of walls
// W (walls.js buildWalls). maxD: the deepest a vertex is looked for. Fills out; true on contact.
export function wallContact(W, near, cnt, P, nv, cx, cz, r, maxD, out){
  nc = 0;
  const S = W.SEG, md2 = maxD * maxD;
  // 1. the polygon's vertices behind a wall
  for(let v = 0; v < nv; v++){
    const vx = P[2 * v], vz = P[2 * v + 1];
    let best = md2, bs = -1, bt = 0, bqx = 0, bqz = 0;
    for(let e = 0; e < cnt; e++){ const o = near[e].seg * 9, ax = S[o], az = S[o + 1], ex = S[o + 2] - ax, ez = S[o + 3] - az, L2 = ex * ex + ez * ez;
      let t = L2 > 0 ? ((vx - ax) * ex + (vz - az) * ez) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + ex * t, qz = az + ez * t, dx = vx - qx, dz = vz - qz, d2 = dx * dx + dz * dz;
      if(d2 < best){ best = d2; bs = near[e].seg; bt = t; bqx = qx; bqz = qz; } }
    if(bs < 0 || best < 1e-18) continue;
    let nx, nz;
    if(bt > 0 && bt < 1){ nx = S[bs * 9 + 6]; nz = S[bs * 9 + 7]; }
    else { const L = W.lines[W.segLine[bs]], k = (W.segAt[bs] + (bt >= 1 ? 1 : 0)) % L.n; nx = L.px[k]; nz = L.pz[k]; }
    if((vx - bqx) * nx + (vz - bqz) * nz >= 0) continue;              // on the road's side
    const d = Math.sqrt(best);
    if(bt > 0 && bt < 1) add(vx, vz, nx, nz, d);
    else add(vx, vz, (bqx - vx) / d, (bqz - vz) / d, d);
  }
  // 2. corners of wall sticking into the road, inside the polygon
  for(let e = 0; e < cnt; e++){ const s = near[e].seg, L = W.lines[W.segLine[s]], k0 = W.segAt[s];
    for(let end = 0; end < 2; end++){
      const k = end ? (k0 + 1) % L.n : k0;
      if(end && segListed(near, cnt, s + 1, W) ) continue;                 // (the next segment's start: counted there)
      const wx = L.x[k], wz = L.z[k];
      if((wx - cx) * (wx - cx) + (wz - cz) * (wz - cz) > r * r) continue;
      if(!convexAt(L, k)) continue;
      let dmin = 1e9, mx = 0, mz = 0, inside = true;
      for(let i = 0; i < nv; i++){ const j = (i + 1) % nv, ax = P[2 * i], az = P[2 * i + 1], ex = P[2 * j] - ax, ez = P[2 * j + 1] - az;
        const l = Math.sqrt(ex * ex + ez * ez); if(l < 1e-9) continue;
        const dd = (ex * (wz - az) - ez * (wx - ax)) / l;                  // > 0: inside (left of the edge)
        if(dd <= 0){ inside = false; break; }
        if(dd < dmin){ dmin = dd; mx = -ez / l; mz = ex / l; } }          // the push: inwards across that edge
      if(inside) add(wx, wz, mx, mz, dmin);
    } }
  return gather(out);
}
// whether segment id s (the one after a listed one) is listed too, on the same line
function segListed(near, cnt, s, W){
  if(s >= W.nseg || W.segLine[s] !== W.segLine[s - 1]){ const L = W.lines[W.segLine[s - 1]]; if(!L.closed) return false;
    s -= L.n; }                                                             // (a closed line's last segment: its next is its first)
  for(let e = 0; e < cnt; e++) if(near[e].seg === s) return true;
  return false;
}
// a wall point that sticks into the road: the wall turns away from the road there (an open
// line's ends always do)
function convexAt(L, k){
  const n = L.n; if(!L.closed && (k === 0 || k === n - 1)) return true;
  const a = (k - 1 + n) % n, b = (k + 1) % n;
  const d1x = L.x[k] - L.x[a], d1z = L.z[k] - L.z[a], d2x = L.x[b] - L.x[k], d2z = L.z[b] - L.z[k];
  return d1x * d2z - d1z * d2x < -1e-9 * Math.sqrt((d1x * d1x + d1z * d1z) * (d2x * d2x + d2z * d2z));
}

// Polygon P against the highway's two rails (inner faces at x = ±rail, the road between).
export function railContact(P, nv, rail, out){
  nc = 0;
  for(let v = 0; v < nv; v++){ const x = P[2 * v], z = P[2 * v + 1];
    if(x > rail) add(x, z, -1, 0, x - rail); else if(x < -rail) add(x, z, 1, 0, -rail - x); }
  return gather(out);
}

// --- response ---
// The car against a wall contact C (wallContact / railContact), the car's body B. Returns
// the speed of the contact point into the wall (m/s; <= 0: it was only pushed out).
export function wallResponse(car, B, C){
  const nx = C.nx, nz = C.nz, rx = C.px - car.x, rz = C.pz - car.z;
  car.x += nx * C.depth; car.z += nz * C.depth;
  // the contact point's velocity per rad/s of yaw (car.h grows: forward (sin h, cos h) turns towards +x)
  const kx = rz, kz = -rx, m = B.m, I = B.I / WALL.YAW_K;
  let w = car.spinV || 0;
  const vn = (car.vx + w * kx) * nx + (car.vz + w * kz) * nz, vin = -vn;
  if(vin <= 0) return vin;
  const kn = kx * nx + kz * nz, Jn = (1 + restitution(vin)) * vin / (1 / m + kn * kn / I);
  car.vx += Jn * nx / m; car.vz += Jn * nz / m; w += Jn * kn / I;
  // friction: stop the contact point sliding along the wall, at most MU × Jn
  const tx = -nz, tz = nx, kt = kx * tx + kz * tz, vt = (car.vx + w * kx) * tx + (car.vz + w * kz) * tz;
  let Jt = -vt / (1 / m + kt * kt / I); const cap = WALL.MU * Jn; Jt = Jt > cap ? cap : Jt < -cap ? -cap : Jt;
  car.vx += Jt * tx / m; car.vz += Jt * tz / m; w += Jt * kt / I;
  car.spinV = w > WALL.SPIN ? WALL.SPIN : w < -WALL.SPIN ? -WALL.SPIN : w;
  return vin;
}

// The whole wall step for a car: up to PASSES contacts (each pushed out and answered),
// found by detect(P, nv, B, out) (true on contact) with the car's polygon P; then, sliding
// along it, wallAlign. Returns the hardest speed into a wall (m/s), or -1 with no contact;
// LAST holds that contact.
const PW = new Float64Array(64), CON = { n: 0, px: 0, pz: 0, nx: 0, nz: 0, depth: 0 };
export const LAST = { x: 0, z: 0, nx: 0, nz: 0, depth: 0, vin: 0, seq: 0 };     // the last contact (map scan, tests)
export function resolveWalls(car, B, detect, hooks, dt){
  let hard = -1, hit = false;
  for(let pass = 0; pass < WALL.PASSES; pass++){
    worldPoly(B.id, car.x, car.z, car.h, PW);
    if(!detect(PW, B.nv, car, B, CON)) break;
    const vin = wallResponse(car, B, CON);
    if(!hit || vin > hard){ hit = true; hard = vin; LAST.x = CON.px; LAST.z = CON.pz; LAST.nx = CON.nx; LAST.nz = CON.nz; LAST.depth = CON.depth; LAST.vin = vin; }
  }
  if(!hit) return -1;
  // (one contact per substep for ?debug=hit and the tests: the hardest of its passes)
  LAST.seq++;
  if(HITLOG.on) HITLOG.push('wall', LAST.x, LAST.z, -LAST.nx, -LAST.nz, LAST.vin, LAST.depth);
  if(dt) wallAlign(car, -LAST.nx, -LAST.nz, dt);
  if(hard > WALL.SOUND && hooks && hooks.onWall) hooks.onWall(hard);
  return hard;
}

// A car sliding along a wall with its nose in it (nx, nz: into the wall) turns along its
// motion. Its tyres do that to a real car (the rear's side force swings it straight behind
// the motion); stepCar only ever turns the motion toward the nose, so without this a car
// pressed into a wall at an angle drove back into it every substep, and the tyres scrubbed
// it to a stop within 2 s (180 km/h, steering held into the rail). Version 2's wallAlign
// did this toward "along the wall, the way the nose points": for a nose straight at the
// wall that is atan2(0, 0) = world angle 0, and a 5 km/h nose touch turned the car 22-26°.
// Now the target is the car's own motion along the wall, and below ALIGN_V of it (a nose
// touch, a car stopped against the wall) nothing turns.
export function wallAlign(car, nx, nz, dt){
  const fx = Math.sin(car.h), fz = Math.cos(car.h), into = fx * nx + fz * nz;
  if(into <= 0 || car.vx * fx + car.vz * fz <= 0) return;           // nose already away, or reversing
  const vn = car.vx * nx + car.vz * nz, tx = car.vx - vn * nx, tz = car.vz - vn * nz, vt = Math.hypot(tx, tz);
  if(vt < WALL.ALIGN_V) return;
  let d = Math.atan2(tx, tz) - car.h; d = Math.atan2(Math.sin(d), Math.cos(d));
  if(Math.abs(d) > Math.PI / 2) return;                              // (moving backwards along it)
  car.h += d * Math.min(1, WALL.ALIGN * dt);
}
// Position only (another player's predicted car: drawn outside the walls, its velocity is
// not ours to change). p: { x, z, h }. Returns how far it was moved (m).
export function pushOut(p, B, detect){
  let moved = 0;
  for(let pass = 0; pass < 4; pass++){
    worldPoly(B.id, p.x, p.z, p.h || 0, PW);
    if(!detect(PW, B.nv, p, B, CON)) break;
    p.x += CON.nx * CON.depth; p.z += CON.nz * CON.depth; moved += CON.depth;
  }
  return moved;
}

// --- car against car (plan 3, stage 4) ---
// Two cars' hitbox polygons (world, counter-clockwise; worldPoly). Separating axes: every
// edge normal of both polygons; the axis with the least overlap is the contact normal (out
// of B, toward A), that overlap the depth. A rear-end hit is judged by the flat nose and
// tail (the normal straight along the cars), a corner by its rounded pieces (a slanted
// normal): what the bodies really touch with, not two circles' centre line.
// The contact point: the middle of the overlap (A's vertices inside B, B's inside A, and
// where their edges cross); the lever arm of the hit is from it.
// out: { px, pz, nx, nz, depth } on contact (true); separated, out.gap is the largest
// separation along an axis (m, > 0: a lower bound of the distance between the bodies).
export const CAR = {
  E_MAX: .05,                 // restitution at most: cars crumple. The wall's curve (none below E_FROM, rising to E_TO), lower: a rear-end hit leaves both cars near the common speed (plan 3 stage 4: 90-100 km/h after 180 into a stopped car)
  MU: WALL.MU,                // body to body friction: the wall's
};
export const carRestitution = vin => CAR.E_MAX * Math.min(1, Math.max(0, (vin - WALL.E_FROM) / (WALL.E_TO - WALL.E_FROM)));

const inside = (P, n, x, z) => {           // (x, z) inside convex P (on an edge: inside)
  for(let i = 0; i < n; i++){ const j = i + 1 < n ? i + 1 : 0, ax = P[2 * i], az = P[2 * i + 1];
    if((P[2 * j] - ax) * (z - az) - (P[2 * j + 1] - az) * (x - ax) < 0) return false; }
  return true;
};
export function polyContact(PA, na, PB, nb, out){
  let best = -Infinity, bnx = 0, bnz = 0;
  for(let pass = 0; pass < 2; pass++){
    const P = pass ? PB : PA, n = pass ? nb : na, Q = pass ? PA : PB, m = pass ? na : nb;
    for(let i = 0; i < n; i++){
      const j = i + 1 < n ? i + 1 : 0, ax = P[2 * i], az = P[2 * i + 1], ex = P[2 * j] - ax, ez = P[2 * j + 1] - az, l = Math.sqrt(ex * ex + ez * ez);
      if(l < 1e-9) continue;
      const ox = ez / l, oz = -ex / l;                                   // the edge's outward normal
      let s = Infinity;
      for(let k = 0; k < m; k++){ const d = (Q[2 * k] - ax) * ox + (Q[2 * k + 1] - az) * oz; if(d < s) s = d; }
      if(s > best){ best = s; if(pass){ bnx = ox; bnz = oz; } else { bnx = -ox; bnz = -oz; } }
    }
  }
  if(best >= 0){ out.gap = best; return false; }
  // the overlap's middle
  let sx = 0, sz = 0, c = 0;
  for(let k = 0; k < na; k++) if(inside(PB, nb, PA[2 * k], PA[2 * k + 1])){ sx += PA[2 * k]; sz += PA[2 * k + 1]; c++; }
  for(let k = 0; k < nb; k++) if(inside(PA, na, PB[2 * k], PB[2 * k + 1])){ sx += PB[2 * k]; sz += PB[2 * k + 1]; c++; }
  for(let i = 0; i < na; i++){ const i2 = i + 1 < na ? i + 1 : 0, ax = PA[2 * i], az = PA[2 * i + 1], ex = PA[2 * i2] - ax, ez = PA[2 * i2 + 1] - az;
    for(let k = 0; k < nb; k++){ const k2 = k + 1 < nb ? k + 1 : 0, bx = PB[2 * k], bz = PB[2 * k + 1], fx = PB[2 * k2] - bx, fz = PB[2 * k2 + 1] - bz;
      const den = ex * fz - ez * fx; if(Math.abs(den) < 1e-12) continue;
      const wx = bx - ax, wz = bz - az, t = (wx * fz - wz * fx) / den, u = (wx * ez - wz * ex) / den;
      if(t >= 0 && t <= 1 && u >= 0 && u <= 1){ sx += ax + ex * t; sz += az + ez * t; c++; } } }
  if(!c){ // (cannot happen for two overlapping convex polygons; numerically: B's deepest vertex)
    let d = Infinity; for(let k = 0; k < nb; k++){ const v = PB[2 * k] * bnx + PB[2 * k + 1] * bnz; if(v < d){ d = v; sx = PB[2 * k]; sz = PB[2 * k + 1]; } } c = 1; }
  out.px = sx / c; out.pz = sz / c; out.nx = bnx; out.nz = bnz; out.depth = -best; out.gap = best;
  return true;
}

// The impulse between two cars at contact C (polyContact: n out of B toward A, point
// px, pz) as two rigid bodies, the wall's model with the other car movable: masses mA, mB
// (kg), yaw inertias IA, IB (the bodies' I: bodyOf; the tyres take part of the turn,
// WALL.YAW_K, as at the wall), the cars' velocities (vax, vaz), (vbx, vbz) and spins wa, wb
// (rad/s, a hit's: car.spinV). Normal impulse from the contact point's closing speed (at
// most `cap`, what the cars' centres really do, plus what their spins add),
// restitution by how hard (carRestitution), friction along the contact up to CAR.MU × the
// normal impulse. Into out: jx, jz (the impulse on A, N s; B gets minus it), closing (m/s),
// jn, jt (its normal and tangential parts), kA, kB (lever: the yaw change per N s of
// impulse along the impulse's direction is (k × J) / I, see below); false if moving apart.
export function carImpulse(ax, az, vax, vaz, wa, mA, IA, bx, bz, vbx, vbz, wb, mB, IB, C, cap, out){
  const nx = C.nx, nz = C.nz, tx = -nz, tz = nx;
  // the contact point's velocity per rad/s of yaw (car.h grows: forward (sin h, cos h) turns towards +x): (rz, -rx)
  const kax = C.pz - az, kaz = -(C.px - ax), kbx = C.pz - bz, kbz = -(C.px - bx);
  const iA = WALL.YAW_K / IA, iB = WALL.YAW_K / IB;
  // the contact point's relative velocity, the cars' spins (car.spinV) in it: once a hit
  // has turned them, the points part even if the centres still close in (no second impulse)
  const rvx = vax + wa * kax - vbx - wb * kbx, rvz = vaz + wa * kaz - vbz - wb * kbz, vn = rvx * nx + rvz * nz;
  if(vn >= 0) return false;
  const closing = Math.min(-vn, cap + Math.abs(wa) * Math.hypot(kax, kaz) + Math.abs(wb) * Math.hypot(kbx, kbz));
  const kna = kax * nx + kaz * nz, knb = kbx * nx + kbz * nz, kta = kax * tx + kaz * tz, ktb = kbx * tx + kbz * tz;
  const Kn = 1 / mA + 1 / mB + kna * kna * iA + knb * knb * iB;
  const jn = (1 + carRestitution(closing)) * closing / Kn;
  // friction: the contact's sliding speed after the normal impulse (its turn included), evened out up to MU × jn
  const vt = rvx * tx + rvz * tz + jn * (kta * kna * iA + ktb * knb * iB);
  const Kt = 1 / mA + 1 / mB + kta * kta * iA + ktb * ktb * iB;
  let jt = -vt / Kt; const lim = CAR.MU * jn; jt = jt > lim ? lim : jt < -lim ? -lim : jt;
  out.jx = nx * jn + tx * jt; out.jz = nz * jn + tz * jt; out.jn = jn; out.jt = jt; out.closing = closing;
  out.kax = kax; out.kaz = kaz; out.kbx = kbx; out.kbz = kbz; out.iA = iA; out.iB = iB;
  return true;
}
