// The drift maps. Each map is one module of plain data (see neon.js):
//   id, name, desc             shown on the map card (stage 6)
//   points                     control points [x, z, height m, bank °]; x and z are multiplied by
//                              `scale`. The road is a closed centripetal Catmull-Rom curve through
//                              them (curve.js). Height and bank are carried along the same curve.
//                              Bank > 0 lifts the left edge of the road (the outside of a right-
//                              hander), < 0 the right edge. The road is driven in point order.
//   scale                      x, z multiplier (default 1)
//   samples                    how many track points (default: one every ~1.6 m)
//   width, verge               road width; run-off from the road edge to the wall (m)
//   start                      { sample: i } or { at: k }: k is a control-point coordinate
//                              (point 3 is 3, half way to point 4 is 3.5)
//   bridges                    [{ from, to }] in control-point coordinates: stretches drawn as a
//                              bridge (deck, railings, pillars) instead of on an embankment
//   vergeDrag                  braking off the asphalt, 1/s (default .45; .45·v m/s² at speed v).
//                              Maps with wide verges: 0.3 (108 → ~60 km/h in 1 s coasting); cutting a corner over
//                              the grass costs more than it saves
//   curb                       'redwhite' (default): red and white curbs; 'zebra': concrete curbs
//                              and white zebra hatching on the outside of every apex
//   shortcuts                  [{ from, to, points, width }]: narrow cut-throughs (4-6 m) across
//                              the inside of hairpins, see geometry.js buildShortcut. A lap
//                              through one counts (the lap is checked by checkpoints); in drift
//                              mode a corner taken through one scores nothing
//   decor                      { theme: 'city' | 'forest' | 'port' | 'parking' (ground, run-off
//                              colour and scenery), city: buildings, trees: trees (forest),
//                              containers, cranes (port), lamps: one lamp every this many
//                              track points (not under a ceiling) }
//   levels                     { gap, slab }: stacked levels (a car park): roads may pass over
//                              each other `gap` m apart with a slab or deck `slab` m thick
//                              between them (geometry.js LEVELS, CEIL; tests/maps.test.mjs)
//   building                   { x0, x1, z0, z1, floors, towers }: the car park drawn round
//                              the roads (scene-parking.js): its footprint, the slab tops
//                              (0: the ground) and the round ramp towers ({ x, z, r: centre and
//                              radius of the road, to: the height of the top})
//   hidden                     not offered to players (test maps)
//   exempt                     rules of tests/maps.test.mjs this map may break, and why
import neon from './neon.js';
import estakada from './estakada.js';
import serpantin from './serpantin.js';
import pereval from './pereval.js';
import razvyazka from './razvyazka.js';
import parking from './parking.js';
import testhill from './_testhill.js';

export const MAPS = { neon, estakada, serpantin, parking, pereval, razvyazka, _testhill: testhill };
export const DEFAULT_MAP = 'neon';
// the maps players can pick, in menu order
export const MAP_IDS = Object.keys(MAPS).filter(id => !MAPS[id].hidden);
