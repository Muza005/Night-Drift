// What the game server needs to know about the drift maps, without three.js: the id, the
// name, the lap length (m, of the centre line, as modes/track/geometry.js measures it),
// the shortest legal lap (min: through every shortcut, geometry.js LAP_MIN; = len on a map
// without shortcuts) and whether the map is hidden (test maps). tests/maps.test.mjs checks
// that this list matches maps/index.js and the built geometry; update it with every map.
export const MAP_META = {
  neon: { name: 'Ночной город', len: 1433.4, min: 1433.4, hidden: false },
  estakada: { name: 'Эстакада', len: 1972.2, min: 1972.2, hidden: false },
  serpantin: { name: 'Серпантин', len: 2473.6, min: 2332.5, hidden: false },
  parking: { name: 'Паркинг', len: 1646.2, min: 1646.2, hidden: false },
  pereval: { name: 'Перевал', len: 2514.8, min: 2514.8, hidden: false },
  razvyazka: { name: 'Развязка', len: 2803.3, min: 2388.4, hidden: false },
  _testhill: { name: 'Тестовый холм', len: 923.6, min: 923.6, hidden: true },
};
export const DEFAULT_MAP = 'neon';
// a map id this server may put a room on (hidden maps only when allowed: test servers)
export const mapAllowed = (id, allowHidden = false) =>
  typeof id === 'string' && Object.hasOwn(MAP_META, id) && (!MAP_META[id].hidden || allowHidden);
// The fastest lap the server believes on a map: the shortest legal lap (through every
// shortcut) at 80 m/s (288 km/h, over the 250 km/h a car reaches in a slipstream), never under 5 s.
export const minLapMs = id => Math.max(5000, Math.floor((Object.hasOwn(MAP_META, id) ? MAP_META[id].min : 0) / 80 * 1000));
