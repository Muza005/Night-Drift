// What the game server needs to know about the drift maps, without three.js: the id, the
// name, the lap length (m, of the centre line, as modes/track/geometry.js measures it)
// and whether the map is hidden (test maps). tests/maps.test.mjs checks that this list
// matches maps/index.js and the built geometry; update it with every map.
export const MAP_META = {
  neon: { name: 'Ночной город', len: 1433.4, hidden: false },
  _testhill: { name: 'Тестовый холм', len: 923.6, hidden: true },
};
export const DEFAULT_MAP = 'neon';
// a map id this server may put a room on (hidden maps only when allowed: test servers)
export const mapAllowed = (id, allowHidden = false) =>
  typeof id === 'string' && Object.hasOwn(MAP_META, id) && (!MAP_META[id].hidden || allowHidden);
// The fastest lap the server believes on a map: the whole lap at 80 m/s (288 km/h, over
// the 250 km/h a car reaches in a slipstream), never under 5 s.
export const minLapMs = id => Math.max(5000, Math.floor((Object.hasOwn(MAP_META, id) ? MAP_META[id].len : 0) / 80 * 1000));
