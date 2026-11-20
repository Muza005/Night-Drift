// «Тестовый холм»: not shown to players (open it with ?map=_testhill). It exists to prove
// track engine v2: a figure of eight whose second pass goes over the first on a bridge,
// a 6.5 % ramp up to the bridge and down again, a crest on the first straight that
// throws the car into the air at speed, and a banked right-hander.
//
// The points are generated from the shape below (two circles joined by two straights
// that cross in the middle), one every D metres of path, so heights can be given as a
// function of the distance along the lap.
const D = 8;
const alpha = Math.asin(0.4);                          // both circles: r / c = 0.4
const R1 = 68, C1 = 170, L1 = Math.sqrt(C1 * C1 - R1 * R1);   // right lobe (a left-hander)
const R2 = 40, C2 = 100, L2 = Math.sqrt(C2 * C2 - R2 * R2);   // left lobe (a right-hander, banked)
const SW = Math.PI + 2 * alpha;                        // how far round each circle the road goes
const A1 = R1 * SW, A2 = R2 * SW;
const S_X = L1 + A1 + L1;                              // the second pass over the crossing (the bridge)
const TOTAL = S_X + L2 + A2 + L2;
const H_BRIDGE = 7.5, TOP = 45, RAMP = 181;            // flat top ±45 m, cosine ramps: max grade π·7.5/(2·181) = 6.5 %
const BUMP_AT = 95, BUMP_W = 50, BUMP_H = 1.6;         // crest radius ≈ 79 m: airborne above ≈ 100 km/h

// where the path is at distance s from the crossing (heading out north-east): x, z, heading
function at(s) {
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  if (s < L1) return [s * ca, s * sa];
  s -= L1;
  if (s < A1) { const th = Math.PI / 2 + alpha - s / R1; return [C1 + R1 * Math.cos(th), R1 * Math.sin(th)]; }
  s -= A1;
  if (s < L1 + L2) { const k = L1 - s; return [k * ca, -k * sa]; }   // through the crossing and on to the left lobe
  s -= L1 + L2;
  if (s < A2) { const th = Math.PI / 2 - alpha + s / R2; return [-C2 + R2 * Math.cos(th), R2 * Math.sin(th)]; }
  s -= A2;
  const k = L2 - s; return [-k * ca, -k * sa];
}
const ramp = x => x <= 0 ? 0 : x >= 1 ? 1 : (1 - Math.cos(Math.PI * x)) / 2;
function height(s) {
  const d = Math.abs(s - S_X);
  let h = H_BRIDGE * (1 - ramp((d - TOP) / RAMP));
  const b = Math.abs(s - BUMP_AT);
  if (b < BUMP_W / 2) h += BUMP_H * (1 + Math.cos(2 * Math.PI * b / BUMP_W)) / 2;
  return h;
}
// banked 7° through the second half of the left lobe (the right-hander), in and out over 40 m
function bankAt(s) {
  const a = S_X + L2 + A2 * 0.35, b = S_X + L2 + A2;
  if (s < a - 40 || s > b + 40) return 0;
  return 7 * Math.min(ramp((s - (a - 40)) / 40), 1 - ramp((s - b) / 40));
}
const points = [];
const n = Math.round(TOTAL / D), step = TOTAL / n;
for (let k = 0; k < n; k++) { const s = k * step, [x, z] = at(s); points.push([+x.toFixed(3), +z.toFixed(3), +height(s).toFixed(3), +bankAt(s).toFixed(2)]); }

export default {
  id: '_testhill',
  name: 'Тестовый холм',
  desc: 'Проверка движка: мост, подъём, трамплин, вираж.',
  hidden: true,
  points,
  scale: 1,
  width: 16,
  verge: 6,
  start: { at: (TOTAL - 60) / step },                 // on the last straight, 60 m before the crossing
  bridges: [{ from: (S_X - TOP) / step, to: (S_X + TOP) / step }],
  decor: { city: 60, lamps: 16 },
  // for tests/maps.test.mjs: the crest, in control-point coordinates (the jump test drives it)
  crest: { at: BUMP_AT / step, height: BUMP_H, width: BUMP_W },
};
