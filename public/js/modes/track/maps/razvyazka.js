// «Развязка»: a highway interchange in a port. Seen from above (+x right, +z down the
// screen), driven anticlockwise overall:
//   - the start/finish straight runs east along the top and climbs onto
//   - the first cloverleaf loop (top right): a left-hand 270° loop that comes down and
//     runs south under its own bridge;
//   - down the right side into an acute right turn-back (140°: shortcut 1 across it),
//     back up to the north-west and west along the middle;
//   - the accordion: four legs down and up, joined by three hairpins (shortcuts 2-4);
//   - west, climbing onto the second cloverleaf loop (bottom left): left round 270° and
//     north under its own bridge, up the left side and right onto the start straight.
// Width 14 m, wide braking verges (vergeDrag 0.3): cutting over the grass beside a
// shortcut costs more than it saves. Concrete curbs and zebra hatching, port decor.
import { trace, closeLoop, profile } from './path.js';

// The lap closes by two straights (the start straight, east, and the left side, north):
// their lengths take up whatever gap the turns leave.
function closed(segments, ia, ib) {
  const e = trace({ x: 0, z: 0, heading: 0, segments, step: 1 }).end;
  const h = k => { let th = 0; for (let j = 0; j < k; j++) if (segments[j][0] === 'R') th += segments[j][2]; return th * Math.PI / 180; };
  const ua = [Math.cos(h(ia)), Math.sin(h(ia))], ub = [Math.cos(h(ib)), Math.sin(h(ib))];
  const det = ua[0] * ub[1] - ua[1] * ub[0], gx = -e.x, gz = -e.z;
  const a = (gx * ub[1] - gz * ub[0]) / det, b = (ua[0] * gz - ua[1] * gx) / det;
  const out = segments.map(s => [...s]); out[ia][1] += a; out[ib][1] += b;
  return out;
}

const LOOP = 46;           // the cloverleaf loops' radius
const HP = 25;             // the accordion's hairpins: legs 50 m apart
const LEG = 95;            // the accordion's legs
const segments = closed([
  ['S', 400],            //  0 start/finish straight, east, climbing to the first bridge
  ['R', LOOP, -270],     //  1 cloverleaf loop 1: left, down and round under the bridge
  ['S', 200],            //  2 south down the right side
  ['R', 28, 140],        //  3 the acute right turn-back (shortcut 1)
  ['S', 120],            //  4 back up to the north-west
  ['R', 50, -50],        //  5 left, west
  ['S', 90],             //  6 west along the middle
  ['R', 35, -90],        //  7 left, down: the accordion
  ['S', LEG],            //  8 leg 1, south
  ['R', HP, 180],        //  9 hairpin (shortcut 2)
  ['S', LEG],            // 10 leg 2, north
  ['R', HP, -180],       // 11 hairpin (shortcut 3)
  ['S', LEG],            // 12 leg 3, south
  ['R', HP, 180],        // 13 hairpin (shortcut 4)
  ['S', LEG],            // 14 leg 4, north
  ['R', 35, -90],        // 15 left, west
  ['S', 280],            // 16 west, climbing to the second bridge
  ['R', LOOP, -270],     // 17 cloverleaf loop 2: left, down and round under the bridge
  ['S', 200],            // 18 north up the left side
  ['R', 50, 90],         // 19 right onto the start straight
], 0, 18);
const t = trace({ x: 0, z: 0, heading: 0, segments });
const at = k => t.at[k];
// The crossings: each loop's approach passes over its exit one radius before the loop
// begins; the exit passes under one radius after the loop ends.
const X1 = at(1) - LOOP, X1L = at(2) + LOOP, X2 = at(17) - LOOP, X2L = at(18) + LOOP;
const H = 7.5;
const height = profile([
  [0, 0], [X1 - 200, 0], [X1 - 36, H],              // the start straight climbs to bridge 1
  [X1 + 36, H], [X1L - 36, 0],                      // down round loop 1, under it
  [at(16) + 20, 0], [X2 - 36, H],                   // west, up to bridge 2
  [X2 + 36, H], [X2L - 36, 0],                      // down round loop 2, under it
], t.total);
// the loops lean inward a little (left-handers: < 0)
const bank = profile([
  [at(1) - 10, 0], [at(1) + 30, -4], [at(2) - 30, -4], [at(2) + 10, 0],
  [at(17) - 10, 0], [at(17) + 30, -4], [at(18) - 30, -4], [at(18) + 10, 0],
], t.total);
const points = closeLoop(t).map(([x, z, s]) => [+x.toFixed(2), +z.toFixed(2), +height(s).toFixed(3), +bank(s).toFixed(2)]);
const step = t.total / points.length;
const cp = s => s / step;
// where the (closed) path is at distance s along it
const pts = closeLoop(t);
const pos = s => { s = ((s % t.total) + t.total) % t.total; const i = Math.min(pts.length - 1, Math.round(s / step)); return [pts[i][0], pts[i][1]]; };
// A shortcut across turn k: it leaves one leg `before` m ahead of the turn, bends off
// gently (a point `bend` of the way across, `lead` m on), crosses, and bends back onto
// the other leg `after` m past the turn. Easy angles in and out: a fast line, not a crawl.
function across(k, before, after = before, lead = 18, bend = .2) {
  const a = pos(at(k) - before + lead), b = pos(at(k + 1) + after - lead);
  const p1 = [a[0] + (b[0] - a[0]) * bend, a[1] + (b[1] - a[1]) * bend], p2 = [b[0] + (a[0] - b[0]) * bend, b[1] + (a[1] - b[1]) * bend];
  return { from: cp(at(k) - before), to: cp(at(k + 1) + after), points: [p1, p2].map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]), width: 5 };
}

export default {
  id: 'razvyazka',
  name: 'Развязка',
  desc: 'Портовая развязка: две петли под своими мостами, шпильки гармошкой и четыре срезки.',
  points,
  scale: 1,
  width: 14,
  verge: 9,
  vergeDrag: 0.3,
  curb: 'zebra',
  start: { at: cp(60) },
  bridges: [{ from: cp(X1 - 42), to: cp(X1 + 42) }, { from: cp(X2 - 42), to: cp(X2 + 42) }],
  shortcuts: [across(3, 60), across(9, 40), across(11, 40), across(13, 40)],
  decor: { theme: 'port', containers: 240, cranes: 5, lamps: 16 },
};
