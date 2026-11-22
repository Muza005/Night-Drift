// «Эстакада»: the layout of the realistic reference, as a night drift track: a compact
// «flower» of four petals round one two-level interchange. Seen from above (+x right,
// +z down the screen):
//   - the small top loop by the start area: the start/finish straight runs west into a
//     right hairpin and back east;
//   - the right upper loop: long, raised on a retaining wall (3.5 m), its round end banked
//     inward; it comes back west climbing onto
//   - the interchange: a wide bridge (7 m) over the road below, turning south, then a
//     gentle crest on the way down (a small jump at speed) into
//   - the left petal: big and round, on an embankment (3.5 m); it comes down to the ground
//     and runs back east under the bridge into
//   - the lower teardrop at ground level: fat, with a tight hairpin at the bottom; its
//     east leg runs north under the bridge again, back into the top loop.
// White road edges, white zebra hatching on the outside of the apexes; city decor.
import { trace, closeLoop, closeBy, profile, bump } from './path.js';

// the whole flower is turned 20° anticlockwise, as the reference lies: the top loop up
// left, the left petal down left, the teardrop down right, the long loop up right
const HEAD = -110;
const segments = closeBy([
  ['S', 100],            //  0 start/finish straight, north (closes the lap)
  ['R', 30, 180],        //  1 the top loop's round end
  ['S', 70],             //  2 back south
  ['R', 30, -90],        //  3 east: the right upper loop
  ['S', 160],            //  4 its upper leg, up onto the retaining wall (closes the lap)
  ['R', 60, 180],        //  5 its round end, banked
  ['S', 300],            //  6 back west, climbing onto the bridge over both underpasses
  ['S', 60],             //  7 off the bridge: the crest
  ['R', 75, 270],        //  8 the left petal (embankment), round to the south
  ['S', 75],             //  9 south, under the bridge
  ['R', 150, 14],        // 10 the teardrop's west leg
  ['S', 80],             // 11
  ['R', 52, -208],       // 12 its round bottom
  ['S', 80],             // 13 its east leg
  ['R', 150, 14],        // 14 north
  ['S', 60],             // 15 under the bridge again, onto the start straight
], 0, 4, HEAD);
const t = trace({ x: 0, z: 0, heading: HEAD, segments });
const at = k => t.at[k];
const H = 7, WALL_H = 3.5;
const height = profile([
  [at(3) + 20, 0], [at(4) + 140, WALL_H],           // up onto the retaining wall
  [at(6) + 20, WALL_H], [at(6) + 150, H],           // the return climbs to the bridge
  [at(7) + 5, H], [at(8) + 120, WALL_H],            // off the bridge, down to the embankment
  [at(8) + 150, WALL_H], [at(9) - 30, 0],           // the left petal comes down
], t.total);
const CREST = at(7) + 24;
// banks: the right upper loop's end 6° inward, the left petal 3°
const bank = profile([
  [at(5) - 30, 0], [at(5) + 20, 6], [at(6) - 20, 6], [at(6) + 30, 0],
  [at(8) + 50, 0], [at(8) + 90, 3], [at(8) + 250, 3], [at(8) + 290, 0],
], t.total);
const points = closeLoop(t).map(([x, z, s]) => [+x.toFixed(2), +z.toFixed(2), +(height(s) + bump(s, CREST, 36, 0.7)).toFixed(3), +bank(s).toFixed(2)]);
const step = t.total / points.length;           // ≈ 8 m: control points per metre of path
const cp = s => s / step;

export default {
  id: 'estakada',
  name: 'Эстакада',
  desc: 'Цветок из петель вокруг развязки: мост над двумя тоннелями, насыпи и вираж.',
  points,
  scale: 1,
  width: 14,
  verge: 8,
  vergeDrag: 0.3,
  curb: 'zebra',
  start: { at: cp(30) },
  bridges: [{ from: cp(at(7) - 125), to: cp(at(7) + 5) }],
  decor: { theme: 'city', city: 110, lamps: 18 },
  // for tests/maps.test.mjs and the screenshots: the crest after the bridge (control-point coordinate)
  crest: { at: cp(CREST), height: 0.7, width: 36 },
};
