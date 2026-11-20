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
//   decor                      { city: buildings, lamps: one lamp every this many track points }
//   hidden                     not offered to players (test maps)
//   exempt                     rules of tests/maps.test.mjs this map may break, and why
import neon from './neon.js';
import testhill from './_testhill.js';

export const MAPS = { neon, _testhill: testhill };
export const DEFAULT_MAP = 'neon';
// the maps players can pick, in menu order
export const MAP_IDS = Object.keys(MAPS).filter(id => !MAPS[id].hidden);
