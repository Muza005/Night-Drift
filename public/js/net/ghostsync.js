/* ---------- other players' cars: prediction, smoothing, network numbers (stage 9) ----------
   Pure logic (no three.js, no DOM): net.js draws every opponent with it, and the Node
   scenario of tests/sync/hits runs the very same code.

   Each update a player sends is stamped with their synced clock (the moment it was true).
   The car is drawn at the present moment: predicted from its last two updates (predict),
   with its turn rate and its change of speed, for as long as the update was travelling.

   A new update moves that prediction a little. The drawn car must not jump there: the
   difference goes into an offset (V.off) that is faded out. It used to fade exponentially
   (−10/s): the moment a correction came in, the drawn car moved a sixth of it in one frame
   (a 1.9 m correction after a hit = a 0.3 m jump). Now the offset fades on a critically
   damped spring (ω = W, V.ov its speed): it starts at rest, so a correction of D shows as
   at most ~0.05·D in a frame at 60 fps, and it is still mostly gone after ~0.2 s. (Carrying
   the two predictions' velocity difference over as well was tried: smoother still, but the
   car then drives on past a wall or into ours after a sudden stop, and the error grew.) */
const angDiff = (a, b) => { const t = Math.PI * 2; return (((b - a + Math.PI) % t) + t) % t - Math.PI; };
const clamp = (v, a) => Math.max(-a, Math.min(a, v));

export const SMOOTH = Object.freeze({
  W: 20,          // 1/s: the spring that fades a correction out (critically damped)
  ACC: 10,        // m/s²: the most change of speed the prediction carries on with
  ACC_T: 0.2,     // s: and for at most this long (a car does not brake or speed up for ever)
  MAX_AGE: 0.5,   // s: no prediction further ahead than this
  RESET: 12,      // m: a correction this big is a reset (back to the track): no smoothing
});

// Where a car is at server time nowS (ms) and how it moves: its last update s1 moved on
// by its velocity for the update's age, turning at the turn rate of s0 → s1, its speed
// changing as it changed from s0 to s1 (for ACC_T s at most, never through a stop).
export function predict(s0, s1, nowS, P = SMOOTH) {
  const age = Math.min(P.MAX_AGE, Math.max(0, (nowS - s1.t) / 1000));
  let w = 0, a = 0;
  if (s0) {
    const span = (s1.t - s0.t) / 1000;
    if (span > .005) {
      w = clamp(angDiff(s0.h, s1.h) / span, 3);
      if (P.ACC) a = clamp((Math.hypot(s1.vx, s1.vz) - Math.hypot(s0.vx, s0.vz)) / span, P.ACC);
    }
  }
  const v = Math.hypot(s1.vx, s1.vz);
  let ta = Math.min(age, P.ACC_T);
  if (a < 0 && v + a * ta < 0) ta = v / -a;          // braking to a stop: no further
  if (v < 0.5) a = 0;
  const turn = w * age, c = Math.cos(-turn / 2), sn = Math.sin(-turn / 2);
  const k = v > 0.5 ? 1 + a * ta * (age - ta / 2) / (v * Math.max(age, 1e-6)) : 1;   // distance with the speed change / without
  const kv = v > 0.5 ? (v + a * ta) / v : 1, cw = Math.cos(-turn), sw = Math.sin(-turn);
  return {
    x: s1.x + (s1.vx * c - s1.vz * sn) * age * k, z: s1.z + (s1.vx * sn + s1.vz * c) * age * k, h: s1.h + turn,
    vx: (s1.vx * cw - s1.vz * sw) * kv, vz: (s1.vx * sw + s1.vz * cw) * kv, w,
  };
}

export const newView = () => ({ off: { x: 0, z: 0, h: 0 }, ov: { x: 0, z: 0, h: 0 } });

// A new update moved the prediction from `from` to `to` (both {x, z, h, vx, vz, w}, at the
// same moment): the drawn car stays where it was; the spring takes the difference.
// Returns the size of the correction (m): how far off the picture was.
export function correct(V, from, to, P = SMOOTH) {
  const dx = from.x - to.x, dz = from.z - to.z;
  V.off.x += dx; V.off.z += dz; V.off.h += angDiff(to.h, from.h);
  if (Math.hypot(V.off.x, V.off.z) > P.RESET) reset(V);
  return Math.hypot(dx, dz);
}
export function reset(V) { V.off.x = V.off.z = V.off.h = 0; V.ov.x = V.ov.z = V.ov.h = 0; }

// The spring over dt s (the exact critically damped solution, steady at any frame rate).
export function settle(V, dt, P = SMOOTH) {
  const W = P.W, e = Math.exp(-W * dt);
  for (const k of ['x', 'z', 'h']) {
    const x = V.off[k], v = V.ov[k], b = v + W * x;
    V.off[k] = (x + b * dt) * e; V.ov[k] = (v - W * b * dt) * e;
  }
}

/* The network numbers of one opponent's updates (the ?debug=net overlay and test:sync):
   - delay: arrival (our server clock) − the update's stamp: the one-way trip plus the two
     clocks' error; jitter: how much it changes from one update to the next (RFC 3550);
   - gap: time between updates as sent (their stamps);
   - err: the size of each correction (how far our picture was off when the update came),
     its median and 95th percentile over the last N updates;
   - age: how old the update the car is drawn from is, at the moment it is drawn. */
export function newStats(N = 300) {
  return { n: 0, delay: 0, jitter: 0, gap: 0, age: 0, lastDelay: null, lastT: null, errs: [], N };
}
export function statArrive(S, stamp, arrival) {
  const d = arrival - stamp;
  if (S.lastDelay !== null) S.jitter += (Math.abs(d - S.lastDelay) - S.jitter) / 16;
  if (S.lastT !== null) S.gap = S.gap ? S.gap * .9 + (stamp - S.lastT) * .1 : stamp - S.lastT;
  S.delay = S.n ? S.delay * .9 + d * .1 : d;
  S.lastDelay = d; S.lastT = stamp; S.n++;
}
export function statErr(S, e) { S.errs.push(e); if (S.errs.length > S.N) S.errs.shift(); }
export function errPct(S, q) {
  if (!S.errs.length) return 0;
  const s = [...S.errs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}
