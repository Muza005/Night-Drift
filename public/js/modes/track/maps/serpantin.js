// «Серпантин»: the layout of the cartoon reference, flat. Seen from above (+x right, +z
// down the screen), driven anticlockwise:
//   - the long start/finish straight along the bottom, east;
//   - up the right edge, then west along the top into
//   - the accordion: seven short legs stacked down the right half, six tight hairpins (two
//     of them can be cut early through the infield: the shortcuts);
//   - the snake: legs up and down the middle that wind (S-bends) and turn round in
//     hairpins of different sizes;
//   - the double road on the left: the track swings inward round a bulge while a narrow
//     bypass runs straight on along the edge (the third shortcut), back to the start.
import { trace, closeLoop, closeBy } from './path.js';

const R = 19;              // the accordion's hairpins (centre line): legs 38 m apart
const LA = 36;             // its legs, between the hairpins' centres
const LEGS = 7;
const acc = [];
for (let k = 1; k < LEGS; k++) acc.push(['R', R, k % 2 ? -180 : 180], ['S', k < LEGS - 1 ? LA : LA + 30]);
const segments = closeBy([
  ['S', 400],                        //  0 start/finish straight, east (closes the lap)
  ['R', 30, -90],                    //  1 up the right edge
  ['S', 200],                        //  2 (closes the lap)
  ['R', 30, -90],                    //  3 west along the top
  ['S', LA + 20],                    //  4 the top road: the accordion's first leg
  ...acc,                            //  5.. the accordion
  // the snake
  ['R', 24, 90],                     // north
  ['S', 15], ['R', 90, -25], ['R', 90, 25], ['S', 10],
  ['R', 24, -180],                   // a wide hairpin
  ['S', 25], ['R', 70, 20], ['R', 70, -20], ['S', 15],
  ['R', 19, 180],                    // a tight one
  ['S', 40], ['R', 110, -15], ['R', 110, 15], ['S', 20],
  ['R', 26, -180],                   // the widest
  ['S', 55],
  ['R', 21, 180],                    // tight again
  ['S', 75],
  // the left side: west along the top, then south
  ['R', 26, -90], ['S', 36], ['R', 26, -90],
  ['S', 10],
  ['R', 30, -60], ['S', 20], ['R', 30, 120], ['S', 20], ['R', 30, -60],   // the bulge (the bypass runs straight past it)
  ['S', 40],
  ['R', 30, -90],                    // east onto the start straight
], 0, 2, 0);
const t = trace({ x: 0, z: 0, heading: 0, segments, step: 4 });
const points = closeLoop(t).map(([x, z]) => [+x.toFixed(2), +z.toFixed(2)]);
const step = t.total / points.length;
const cp = s => s / step;
const at = k => t.at[k];
const pts = closeLoop(t);
const pos = s => { s = ((s % t.total) + t.total) % t.total; const i = Math.min(pts.length - 1, Math.round(s / step)); return pts[i]; };

// A shortcut across hairpin h of the accordion (0: the first): an early hairpin through the
// infield. It leaves one leg `before` m ahead of the hairpin, turns round on a half circle
// as wide as the legs are apart (the same radius as the hairpin: no slower, `2·before` m
// shorter) and joins the next leg `before` m after it. Narrow, with a wall each side.
function uturn(h, before) {
  const k = 5 + 2 * h;                 // the hairpin's segment
  const a = pos(at(k) - before), b = pos(at(k + 1) + before), a2 = pos(at(k) - before + 8);
  const cx = (a[0] + b[0]) / 2, cz = (a[1] + b[1]) / 2, r = Math.hypot(b[0] - a[0], b[1] - a[1]) / 2;
  const tl = Math.hypot(a2[0] - a[0], a2[1] - a[1]), tx = (a2[0] - a[0]) / tl, tz = (a2[1] - a[1]) / tl;
  const p = [];
  for (let d = 20; d < 180; d += 20) { const th = d * Math.PI / 180;
    p.push([+(cx + (a[0] - cx) * Math.cos(th) + tx * r * Math.sin(th)).toFixed(2), +(cz + (a[1] - cz) * Math.cos(th) + tz * r * Math.sin(th)).toFixed(2)]); }
  return { from: cp(at(k) - before), to: cp(at(k + 1) + before), points: p, width: 5 };
}
// the bypass on the left: straight on past the bulge
const BULGE = segments.length - 8;     // the bulge's first segment
const bypass = { from: cp(at(BULGE)), to: cp(at(BULGE + 5)), points: [], width: 5 };

export default {
  id: 'serpantin',
  name: 'Серпантин',
  desc: 'Извилистая змейка, тугая гармошка, длинная прямая и три срезки.',
  points,
  scale: 1,
  width: 12,
  verge: 8,
  vergeDrag: 0.3,
  curb: 'redwhite',
  start: { at: cp(90) },
  bridges: [],
  shortcuts: [uturn(1, 26), uturn(3, 26), bypass],
  decor: { theme: 'forest', trees: 260, lamps: 20 },
};
