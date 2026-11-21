/* ---------- a car's state on the wire (stage 9) ----------
   The server passes each player's state on to everyone else the moment it arrives ('st'),
   instead of waiting for the next schema patch (up to 33 ms more, and two updates in one
   patch then none). Shared by server/src/index.js (encode, from the values it checked)
   and net.js (decode).

   One flat array of integers: msgpack writes small integers in 1-5 bytes, a float in 9.
   Positions and heights in cm, speeds in cm/s, the heading in 1/10000 rad, steering and
   slide in 1/1000; the stamp is the sender's synced clock in ms. */
const R = Math.round;
export function encodeState(id, s) {
  return [id, R(s.t), R(s.x * 100), R(s.z * 100), R(s.h * 1e4), R(s.vx * 100), R(s.vz * 100), R(s.vf * 100),
    R(s.steer * 1000), R(s.slide * 1000), R(s.y * 100), R(s.vy * 100), R(s.idx)];
}
// null for anything that is not a state
export function decodeState(m) {
  if (!Array.isArray(m) || m.length < 13 || typeof m[0] !== 'string') return null;
  m = m.map((v, i) => i && typeof v === 'bigint' ? Number(v) : v);    // (a large integer may come as a BigInt)
  for (let i = 1; i < 13; i++) if (typeof m[i] !== 'number' || !Number.isFinite(m[i])) return null;
  return { id: m[0], t: m[1], x: m[2] / 100, z: m[3] / 100, h: m[4] / 1e4, vx: m[5] / 100, vz: m[6] / 100, vf: m[7] / 100,
    steer: m[8] / 1000, slide: m[9] / 1000, y: m[10] / 100, vy: m[11] / 100, idx: m[12] };
}
