// «Ночной город»: the original drift track. Its control points must never move: the
// physics golden test (tests/physics.test.mjs) drives three minutes on this exact curve.
export default {
  id: 'neon',
  name: 'Ночной город',
  desc: 'Неоновый круг между небоскрёбами: длинные дуги и две тугие шпильки.',
  // [x, z, height m, bank °] before `scale` (x and z only are scaled)
  points: [[0,0,0,0],[80,-20,0,0],[150,10,0,0],[170,80,0,0],[120,130,0,0],[60,110,0,0],[20,160,0,0],
    [-60,170,0,0],[-130,120,0,0],[-120,50,0,0],[-60,40,0,0],[-90,-30,0,0],[-50,-80,0,0]],
  scale: 1.45,
  samples: 900,          // fixed: the physics golden test counts in these points
  width: 16,
  verge: 6,              // run-off from the road edge to the wall
  start: { sample: 12 },
  bridges: [],
  decor: { city: 150, lamps: 16 },
  // This map was drawn before the rules of tests/maps.test.mjs. Its two hairpins have a
  // centre-line radius of ~10 m (points 680 and 813), less than WALL + 2 = 16 m, and its
  // points cannot move (the golden test). The physics walls there were always drawn only
  // where they fit; since engine v2 the curbs, run-off and walls are clamped so they no
  // longer fold. Every new map must pass the radius rule.
  // Its start line (point 12) sits in a 48 m bend for the same reason.
  exempt: { radius: 'original track, points frozen by the physics golden test', start: 'the same' },
};
