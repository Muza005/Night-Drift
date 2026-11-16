// Online traffic snapshot format, shared by the server (encodes) and the game (decodes).
//
// The server sends one snapshot 10 times a second. Every bot is 14 small integers
// (centimetres, cm/s, thousandths), so 48 bots take about 1 KB on the wire:
//   id, type, lane, from, to, progress×1000, knock(cm), z(cm), v(cm/s), a(cm/s²),
//   dir, hazard×10, colour, sideways slide speed after a hit (cm/s)
// x is not sent: it follows from the lanes, the lane-change progress and the knock.
// Plus a header: the server clock (ms) and the simulation clock (ms) of the snapshot.
import { laneCenter } from './geometry.js';
import { slide, HIT } from './sim.js';

const PER_BOT = 14;
const smooth = p => p * p * (3 - 2 * p);
const r = Math.round;

// keep (optional): which bots to put in, e.g. only those near the player it is sent to.
export function encodeSnapshot(sim, serverMs, keep) {
  const out = [r(serverMs), r(sim.time * 1000)];
  for (const b of sim.bots) if (!keep || keep(b)) out.push(b.id, b.t, b.lane, b.from, b.to, r(b.p * 1000), r(b.off * 100),
    r(b.z * 100), r(b.v * 100), r(b.a * 100), b.dir, r(b.hazard * 10), b.color % 840, r((b.sv || 0) * 100));
  return out;
}

export function decodeSnapshot(arr) {
  const snap = { t: arr[0], simTime: arr[1] / 1000, bots: [] };
  for (let i = 2; i + PER_BOT <= arr.length; i += PER_BOT) {
    const [id, t, lane, from, to, p, off, z, v, a, dir, hazard, color, sv] = arr.slice(i, i + PER_BOT);
    snap.bots.push({ id, t, lane, from, to, p: p / 1000, off: off / 100, z: z / 100, v: v / 100, a: a / 100,
      dir, hazard: hazard / 10, color, sv: sv / 100 });
  }
  return snap;
}

// Where a bot from a snapshot is `age` seconds later: it keeps its acceleration (never
// going backwards), carries on with its lane change at the simulation's pace (1.5 s per
// change), slides away from a hit and then eases back to its lane line at 0.8 m/s once
// the hazard lights are off, exactly as the simulation does (sim.js HIT, slide).
export const LANE_CHANGE_S = 1.5;
export function predictBot(b, age) {
  let v = b.v + b.a * age, z;
  if (v < 0) { const tStop = b.v / Math.max(1e-6, -b.a); z = b.z + b.v * tStop / 2; v = 0; }
  else z = b.z + (b.v + v) / 2 * age;
  let p = b.p, lane = b.lane, from = b.from, to = b.to;
  if (p > 0) { p += age / LANE_CHANGE_S; if (p >= 1) { lane = to; from = to; p = 0; } }
  let off;
  if (b.sv) off = slide(b.off, b.sv, age).off;
  else off = Math.sign(b.off) * Math.max(0, Math.abs(b.off) - HIT.RECOVER * Math.max(0, age - (b.hazard || 0)));
  const x = (p > 0 ? laneCenter(from) + (laneCenter(to) - laneCenter(from)) * smooth(p) : laneCenter(lane)) + off;
  return { x, z, v, p, lane, from, to, off, hazard: Math.max(0, b.hazard - age) };
}
