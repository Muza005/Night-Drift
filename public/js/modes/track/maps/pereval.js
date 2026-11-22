// «Перевал»: a mountain pass in a forest. Seen from above (+x right, +z down the screen),
// driven clockwise:
//   - the start/finish straight runs east along the top, at the foot of the hills;
//   - down the right side through the hills: rolling crests and dips, banked bends, and
//     a hairpin on the ridge (crest A is a soft hump on the start straight: a jump from ~130 km/h);
//   - the valley in the bottom right corner (down to 2 m), then the long climb
//     west along the bottom up to the pass (15 m);
//   - over the pass, a left-hand spiral loop (banked) that winds down under its own
//     road: the bridge, 8.5 m over the road below;
//   - the long fast downhill north up the left side, over crest B (a jump from ~130 km/h),
//     into the banked right-hand sweeper (8°) onto the start straight.
// Width 13.5 m, wide braking verges (vergeDrag 0.3), forest decor.
import { trace, closeLoop, profile, bump } from './path.js';

// The lap closes by two straights (the start straight, east, and the downhill, north):
// their lengths take up whatever gap the turns leave.
function closed(segments, ia, ib) {
  const end = segs => trace({ x: 0, z: 0, heading: 0, segments: segs, step: 1 }).end;
  const e = end(segments), h = k => { let th = 0; for (let j = 0; j < k; j++) if (segments[j][0] === 'R') th += segments[j][2]; return th * Math.PI / 180; };
  const ua = [Math.cos(h(ia)), Math.sin(h(ia))], ub = [Math.cos(h(ib)), Math.sin(h(ib))];
  // ua·a + ub·b = -gap
  const det = ua[0] * ub[1] - ua[1] * ub[0], gx = -e.x, gz = -e.z;
  const a = (gx * ub[1] - gz * ub[0]) / det, b = (ua[0] * gz - ua[1] * gx) / det;
  const out = segments.map(s => [...s]); out[ia][1] += a; out[ib][1] += b;
  return out;
}

const LOOP = 50;                   // the spiral loop's radius
const segments = closed([
  ['S', 230],            //  0 start/finish straight, east
  ['R', 62, 90],         //  1 right, down into the hills (banked)
  ['S', 30],             //  2 south, up the first hill
  ['R', 55, -55],        //  3 left
  ['S', 40],             //  4
  ['R', 50, 145],        //  5 right round the hilltop, west (banked)
  ['S', 110],            //  6 west along the ridge: crest A
  ['R', 60, -40],        //  7 a left kink
  ['S', 50],             //  8
  ['R', 60, 40],         //  9 and a right one, west again
  ['S', 40],             // 10
  ['R', 40, -180],       // 11 the left hairpin (banked), back east and down
  ['S', 150],            // 12 east, down into the valley
  ['R', 52, 180],        // 13 right round the valley floor, west (banked)
  ['S', 360],            // 14 the long climb west to the pass; the bridge at its end
  ['R', LOOP, -270],     // 15 the spiral loop: left, down and round under the bridge
  ['S', 330],            // 16 the long fast downhill north (crest B)
  ['R', 75, 90],         // 17 the banked right-hand sweeper onto the start straight
], 0, 16);
const t = trace({ x: 0, z: 0, heading: 0, segments });
const at = k => t.at[k];
// The crossing: the climb (segment 14) passes over the downhill (16) one loop radius
// before the loop begins, and the downhill passes under it one radius after the loop ends.
const XU = at(15) - LOOP, XL = at(16) + LOOP;
const START = 60, CREST_A = START + 100, CREST_B = XL + 150;
const H = 15, LOW = 6.5;
const height = profile([
  [0, 0], [at(1) + 10, 0],                        // the start straight: level (crest A on it)
  [at(3), 4.5], [at(4) + 20, 3],                 // the first hill, a dip
  [at(5) + 80, 7], [at(6) + 55, 8.5],             // up onto the ridge, crest A
  [at(8) + 20, 6], [at(11) + 30, 6],              // along the ridge, round the hairpin
  [at(13) + 60, 2],                               // down into the valley
  [XU - 40, H],                 // the long climb to the pass
  [XU + 38, H], [XL - 38, LOW],                   // over the bridge, down round the loop
  [XL + 38, LOW], [CREST_B, LOW - 2.5],           // under the bridge, the long downhill, crest B
  [at(17) - 20, 0],
], t.total);
const crests = [{ s: CREST_A, w: 34, h: 0.62 }, { s: CREST_B, w: 34, h: 0.66 }];
// banks: right-handers lifted on the left (> 0), left-handers on the right (< 0); a
// bank eases in and out over the straights either side of its turn
const turns = [[1, 6], [3, -3], [5, 6], [7, -2], [9, 2], [11, -6], [13, 5], [15, -6], [17, 8]];
const bank = profile(turns.flatMap(([k, b]) => {
  const ease = Math.min(25, (at(k + 1) - at(k)) / 3);
  return [[at(k) - 12, 0], [at(k) + ease, b], [at(k + 1) - ease, b], [at(k + 1) + 12, 0]];
}), t.total);
const points = closeLoop(t).map(([x, z, s]) => [+x.toFixed(2), +z.toFixed(2),
  +(height(s) + crests.reduce((a, c) => a + bump(s, c.s, c.w, c.h), 0)).toFixed(3), +bank(s).toFixed(2)]);
const step = t.total / points.length;
const cp = s => s / step;

export default {
  id: 'pereval',
  name: 'Перевал',
  desc: 'Горный перевал в лесу: холмы, виражи, два трамплина и спираль под собственным мостом.',
  points,
  scale: 1,
  width: 13.5,
  verge: 9,
  vergeDrag: 0.3,
  curb: 'redwhite',
  start: { at: cp(START) },
  bridges: [{ from: cp(XU - 45), to: cp(XU + 45) }],
  decor: { theme: 'forest', trees: 320, lamps: 18 },
  // for tests/maps.test.mjs and the screenshots: the two crests (control-point coordinates)
  crests: crests.map(c => ({ at: cp(c.s), height: c.h, width: c.w })),
};
