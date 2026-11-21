// «Паркинг»: drift inside a multi-storey car park. Seen from above (+x right, +z down the
// screen), the building is a 144 × 78 m block with a round ramp tower at each end:
//   - the start/finish straight runs west along the street south of the building, turns
//     north and drives in through the south front onto the ground floor (level 0);
//   - the ground floor: two 90° jogs between the column rows, out west to
//   - the west tower: a half turn up (R 12, 10.6 %, banked 3° inward) to level 1, then the
//     same half turn again from every floor to the next: the ramps are stacked 4 m apart,
//     the deck of the one above is the ceiling of the one below;
//   - level 1: a long snake of 90° corners round the columns, back to the tower;
//   - level 2: two chicanes along the north wall, a hairpin, two jogs, back to the tower;
//   - the roof (level 3, 12 m, open to the sky): wide fast corners (R 16) with the city
//     round it, then over a short bridge into
//   - the east tower: a helix down, two full turns of R 12 (8 %, banked 3°, 6 m between
//     the turns), onto the street and round to the start.
// Roads 10 m wide, 3 m of concrete between the asphalt and the barrier (vergeDrag 0.3),
// corners R 12 (16 on the roof). Floors 4 m apart, slabs 0.35 m: 3.65 m clear under
// every ceiling. The building itself (slabs, columns, bays, lights) is drawn by
// scene-parking.js from `building`.
import { trace, closeLoop, profile, reach } from './path.js';

const H = 4, SLAB = 0.35;                      // floor to floor; slab thickness
const RT = 12;                                   // the towers' radius
const CW = { x: -14, z: 26 }, CE = { x: 166, z: 26 };   // the west (up) and east (down) towers
const NORTH = { x: CW.x, z: CW.z - RT, heading: 0 };     // the west tower's top mouth, out east
const SOUTH = { x: CW.x, z: CW.z + RT };                // its bottom mouth, in west
const HELIX = { x: CE.x, z: CE.z - RT, heading: 0 };     // the east tower's mouth (in and out)

// the street and the ground floor: from the east tower's foot round to the west tower
const street = reach(HELIX, [
  ['S', 36],             //  0 out of the east tower, east
  ['R', 14, 90],         //  1 south
  ['S', 70],             //  2 down the east street
  ['R', 14, 90],         //  3 west
  ['S', 60],             //  4 the start/finish straight, west along the south street
  ['R', 12, 90],         //  5 north, into the building
  ['S', 50],             //  6 the ground floor's long aisle
  ['R', 12, -90],        //  7 west
  ['S', 34],             //  8
  ['R', 12, -90],        //  9 south
  ['S', 10],             // 10
  ['R', 12, 90],         // 11 west
  ['S', 26],             // 12
  ['R', 12, 90],         // 13 north
  ['S', 4],              // 14
  ['R', 12, -90],        // 15 west, out to the tower
  ['S', 20],             // 16
], 4, 6, SOUTH);
const ramp = [['R', RT, 180]];                  // a half turn up the west tower
const level1 = reach(NORTH, [
  ['S', 40], ['R', 12, 90], ['S', 8], ['R', 12, -90], ['S', 20], ['R', 12, -90], ['S', 4], ['R', 12, 90], ['S', 14],
  ['R', 12, 90], ['S', 22], ['R', 12, 90], ['S', 74], ['R', 12, 90], ['S', 6], ['R', 12, -90], ['S', 24],
], 0, 10, SOUTH);
const level2 = reach(NORTH, [
  ['S', 30], ['R', 15, 30], ['S', 4], ['R', 15, -30], ['S', 30], ['R', 15, -30], ['S', 4], ['R', 15, 30], ['S', 10],
  ['R', 12, 180], ['S', 20], ['R', 12, -90], ['S', 4], ['R', 12, 90], ['S', 26], ['R', 12, 90], ['S', 4], ['R', 12, -90], ['S', 20],
], 14, 12, SOUTH);
const roof = reach(NORTH, [
  ['S', 20], ['R', 16, 90], ['S', 16], ['R', 16, -90], ['S', 50], ['R', 16, -90], ['S', 16], ['R', 16, 90], ['S', 46],
], 4, 2, HELIX);
const helix = [['R', RT, 720]];                  // two turns down the east tower

const pieces = [street, ramp, level1, ramp, level2, ramp, roof, helix];
const segments = pieces.flat();
const t = trace({ x: HELIX.x, z: HELIX.z, heading: 0, step: 2, segments });
// where each piece starts and ends along the lap
const span = []; { let k = 0; for (const p of pieces) { span.push([t.at[k], t.at[k + p.length]]); k += p.length; } }
const [, R1, , R2, , R3, , HX] = span;
const START_S = t.at[4] + 30;

// Height: level k is k·H. A ramp rises (or falls) between two places at a steady grade,
// easing in and out over `soft` m at each end; it runs 6 m into the floors beyond the
// tower's mouths, so the grade is 10.6 % on the half turns and 8 % in the helix.
function slope(s, a, b, dh, soft = 12) {
  if (s <= a) return 0; if (s >= b) return dh;
  const L = b - a, g = dh / (L - soft), e = soft;
  const I = x => x <= 0 ? 0 : x >= e ? x - e / 2 : (x - e / Math.PI * Math.sin(Math.PI * x / e)) / 2;   // ∫ of the eased grade
  const u = s - a;
  return g * (I(u) - I(u - (L - e)));
}
const ramps = [[R1, H], [R2, H], [R3, H], [HX, -3 * H]];
const height = s => ramps.reduce((h, [[a, b], dh]) => h + slope(s, a - 6, b + 6, dh), 0);
// the half turns and the helix lean 3° into the turn (right-handers: > 0)
const bank = profile(ramps.flatMap(([[a, b]]) => [[a - 4, 0], [a + 8, 3], [b - 8, 3], [b + 4, 0]]), t.total);

const points = closeLoop(t).map(([x, z, s]) => [+x.toFixed(2), +z.toFixed(2), +height(s).toFixed(3), +bank(s).toFixed(2)]);
const step = t.total / points.length;
const cp = s => s / step;

export default {
  id: 'parking',
  name: 'Паркинг',
  desc: 'Многоэтажная парковка: спираль вверх, три этажа между колоннами, крыша над городом и винтовой спуск.',
  points,
  scale: 1,
  width: 10,
  verge: 3,
  vergeDrag: 0.3,
  curb: 'zebra',
  start: { at: cp(START_S) },
  // Stacked levels (geometry.js): roads may pass over each other one floor (4 m) apart
  // where a deck or a floor slab lies between them (tests/maps.test.mjs: at least 3.2 m
  // clear under it).
  levels: { gap: H, slab: SLAB },
  // the building: its footprint (m), the slab tops (level 0 is the ground) and the open roof
  building: { x0: -2, x1: 142, z0: 2, z1: 80, floors: [0, H, 2 * H, 3 * H], towers: [{ ...CW, r: RT, to: 3 * H }, { ...CE, r: RT, to: 3 * H }] },
  decor: { theme: 'parking', city: 170, lamps: 14 },
};
