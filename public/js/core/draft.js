// Slipstream ("карман"): driving close behind another player cuts the air in front of
// you, so your car pulls harder. Pure maths, no three.js: the game, the tests and the
// drawing of the white air trails (core/draftfx.js) all use these same numbers.
//
// The pocket trails behind the other car along the path it really drove (its trail, see
// createTrail below), not along a straight line from its nose: follow it through a bend
// and you stay in its air.
//   - only behind a car doing at least 60 km/h;
//   - from 1.5 m behind its rear bumper to 50 m behind it, measured along its path;
//   - 1.4 m to each side of that path right behind it, widening by 3 cm per metre;
//   - you must be going the way it went there (within ~37°).
// Inside, the push builds up over 0.8 s and adds up to DRAFT_ACC (core/physics.js) while
// you are on the throttle; outside it fades over 0.5 s. Its white trails show while you
// are within 50 m behind it, and glow brighter while you are in the pocket.
export const DRAFT = { MIN_SPEED: 60 / 3.6, NEAR: 1.5, SHOW: 50, CHARGE: .8, FADE: .5, REAR: 2.15 };
export const pocketLen = () => 50;
export const pocketHalf = behind => 1.4 + .03 * Math.max(0, behind);

// A car's trail: where its centre was over the last few seconds, one point every 30 ms
// (a ring buffer, newest last). 128 points = 3.8 s: 50 m of path even at 60 km/h.
// Heights and headings are kept for the drawing (the trail sits on the car's road and
// leaves from its rear corners); the odometer gives the air its flowing pattern.
export const TRAIL = { STEP: .03, N: 128, JUMP: 12 };
export function createTrail(n = TRAIL.N) {
  return { n, x: new Float64Array(n), z: new Float64Array(n), y: new Float64Array(n), h: new Float64Array(n),
    t: new Float64Array(n), d: new Float64Array(n), head: 0, count: 0, clock: 0, odo: 0 };
}
export function trailReset(tr) { tr.count = 0; }
// index of the k-th newest point (k = 0: the newest)
export const trailIdx = (tr, k) => (tr.head - 1 - k + 2 * tr.n) % tr.n;
// Call every frame with the car's drawn pose. A jump (respawn, a big correction) starts
// a new trail: no air line across the map.
export function trailPush(tr, x, z, y, h, dt) {
  tr.clock += dt;
  if (tr.count) {
    const i = trailIdx(tr, 0), step = Math.hypot(x - tr.x[i], z - tr.z[i]);
    if (step > TRAIL.JUMP || Math.abs(y - tr.y[i]) > 4) tr.count = 0;
    else if (tr.clock - tr.t[i] < TRAIL.STEP) return;
    else tr.odo += step;
  }
  const j = tr.head;
  tr.x[j] = x; tr.z[j] = z; tr.y[j] = y; tr.h[j] = h; tr.t[j] = tr.clock; tr.d[j] = tr.odo;
  tr.head = (j + 1) % tr.n; tr.count = Math.min(tr.n, tr.count + 1);
}

// me, lead: {x, z, vx, vz}; trail: the lead car's trail (or none: then its path is taken
// as a straight line back along its velocity). Returns null when the lead car is too slow
// to leave a pocket.
//
// The path runs from the lead car's centre back through its trail points; past the oldest
// point it goes on straight. We find the point of the path nearest to us: how far along
// the path it is (minus the car's rear half) is how far behind the car we are, the
// distance to it is how far off the pocket's centre line, and the path's direction there
// is the way the air flows.
export function wake(me, lead, trail) {
  const v = Math.hypot(lead.vx, lead.vz);
  if (v < DRAFT.MIN_SPEED) return null;
  const fx = lead.vx / v, fz = lead.vz / v;
  const len = pocketLen(v);
  const reach = len + DRAFT.REAR + 2;
  // the car's own length and the road ahead of it: a segment from 20 m ahead to its centre
  let px = lead.x + fx * 20, pz = lead.z + fz * 20, s = -20;
  let ux = -fx, uz = -fz;                     // the path's direction, backwards
  let best = Infinity, behind = 0, side = 0, dirX = fx, dirZ = fz;
  const n = trail ? trail.count : 0;
  for (let k = -1; k <= n && s < reach; k++) {
    let qx = 0, qz = 0, L = 0;
    if (k === -1) { qx = lead.x; qz = lead.z; L = 20; }
    else if (k < n) {
      const i = (trail.head - 1 - k + 2 * trail.n) % trail.n;
      qx = trail.x[i]; qz = trail.z[i]; const ddx = qx - px, ddz = qz - pz; L = Math.sqrt(ddx * ddx + ddz * ddz);
      if (L > 1e-6 && (L > .3 || k > 0)) { ux = ddx / L; uz = ddz / L; }   // a tiny first step keeps the car's own direction
    } else { L = 1e6; qx = px + ux * L; qz = pz + uz * L; }
    if (L < 1e-6) continue;
    // (Math.sqrt, not Math.hypot: hypot boxes its numbers here, ~1 KB of garbage a call)
    const dx = me.x - px, dz = me.z - pz;
    const t = Math.min(L, Math.max(0, dx * ux + dz * uz));
    const ex = dx - ux * t, ez = dz - uz * t, d = Math.sqrt(ex * ex + ez * ez);
    if (d < best) {   // side: + to the car's left, as seen going its way
      best = d; behind = s + t - DRAFT.REAR; side = (dz * ux - dx * uz < 0 ? -d : d); dirX = -ux; dirZ = -uz; }
    px = qx; pz = qz; s += L;
  }
  const mv = Math.hypot(me.vx, me.vz);
  const same = mv > 1 && (me.vx * dirX + me.vz * dirZ) / mv > .8;
  const inside = same && behind > DRAFT.NEAR && behind < len && Math.abs(side) < pocketHalf(behind);
  const near = same && behind > -1 && behind < DRAFT.SHOW && Math.abs(side) < 10;
  const show = !near ? 0 : inside ? 1 : .55 * Math.min(1, (DRAFT.SHOW - behind) / 12);
  return { behind, side, len, speed: v, dirX, dirZ, inside, show };
}

// The push level, 0..1: builds while inside a pocket, fades outside.
export function stepDraft(st, inside, dt) {
  st.level = inside ? Math.min(1, st.level + dt / DRAFT.CHARGE) : Math.max(0, st.level - dt / DRAFT.FADE);
  return st.level;
}
