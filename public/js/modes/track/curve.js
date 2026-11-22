// A closed centripetal Catmull-Rom curve, sampled at equal arc length.
//
// This is three.js r128's CatmullRomCurve3 (closed, 'centripetal') with Curve's
// getLengths / getUtoTmapping / getPointAt / getTangentAt, ported operation for operation,
// with one change: the centripetal knot spacing (d²)^0.25 is computed correctly rounded
// (qrt below) instead of with Math.pow(d², 0.25).
//
// Why: Math.pow is not required to be correctly rounded, and V8 changed it: Node 20 and
// Node 24/26 give a different last bit for about 13 % of inputs (4 of the 13 knot spacings
// of «Ночной город»). Every track point moved by an ulp or two, and the physics golden
// test (three minutes of driving, bit for bit) failed on Node 24+. Rounding the exact
// fourth root to the nearest double is defined by arithmetic alone, so it gives the same
// bits on every engine. Math.sqrt is correctly rounded by IEEE 754; sqrt(sqrt(x)) is not
// (two roundings), so it is corrected by an exact BigInt check.
//
// Pure: no three.js, no DOM. Points are {x, y, z, w} plain objects: y is the height, w
// (optional) one more value carried along the same curve (the map uses it for the bank).
const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
const bits = v => { f64[0] = v; return u64[0]; };
const fromBits = b => { u64[0] = b; return f64[0]; };
// a positive double as [integer mantissa, binary exponent]
function frac(v) {
  const b = bits(v), e = Number((b >> 52n) & 0x7ffn), m = b & ((1n << 52n) - 1n);
  return e === 0 ? [m, -1074] : [m | (1n << 52n), e - 1075];
}
// (a·2^ea)^4 compared with b·2^eb: -1, 0, 1
function cmp4([a, ea], [b, eb]) {
  let A = a ** 4n, B = b, s = 4 * ea - eb;
  if (s >= 0) A <<= BigInt(s); else B <<= BigInt(-s);
  return A < B ? -1 : A > B ? 1 : 0;
}
// the exact midpoint of two positive doubles, as [mantissa, exponent]
function mid(lo, hi) {
  const [a, ea] = frac(lo), [b, eb] = frac(hi), e = Math.min(ea, eb);
  return [(a << BigInt(ea - e)) + (b << BigInt(eb - e)), e - 1];
}
// x^(1/4) rounded to the nearest double (x ≥ 0, finite)
export function qrt(x) {
  if (!(x > 0)) return Math.sqrt(Math.sqrt(x));
  let r = Math.sqrt(Math.sqrt(x));
  const X = frac(x);
  for (;;) { const up = fromBits(bits(r) + 1n); if (cmp4(mid(r, up), X) < 0) r = up; else break; }
  for (;;) { const dn = fromBits(bits(r) - 1n); if (cmp4(mid(dn, r), X) > 0) r = dn; else break; }
  return r;
}
const d2 = (a, b) => { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; };

function poly(x0, x1, x2, x3, dt0, dt1, dt2) {
  let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
  let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
  t1 *= dt1; t2 *= dt1;
  const c0 = x1, c1 = t1, c2 = -3 * x1 + 3 * x2 - 2 * t1 - t2, c3 = 2 * x1 - 2 * x2 + t1 + t2;
  return [c0, c1, c2, c3];
}
const calc = (c, t) => { const t2 = t * t, t3 = t2 * t; return c[0] + c[1] * t + c[2] * t2 + c[3] * t3; };

export function closedCurve(points) {
  const l = points.length;
  // per segment: polynomials for x, y, z (they depend only on the four control points)
  const seg = [];
  for (let s = 0; s < l; s++) {
    const p0 = points[(s - 1 + l) % l], p1 = points[s], p2 = points[(s + 1) % l], p3 = points[(s + 2) % l];
    let dt0 = qrt(d2(p0, p1)), dt1 = qrt(d2(p1, p2)), dt2 = qrt(d2(p2, p3));
    if (dt1 < 1e-4) dt1 = 1.0;
    if (dt0 < 1e-4) dt0 = dt1;
    if (dt2 < 1e-4) dt2 = dt1;
    seg.push([poly(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2), poly(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2), poly(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2),
      poly(p0.w || 0, p1.w || 0, p2.w || 0, p3.w || 0, dt0, dt1, dt2)]);
  }
  function getPoint(t) {
    const p = l * t;
    let intPoint = Math.floor(p);
    const weight = p - intPoint;
    intPoint += intPoint > 0 ? 0 : (Math.floor(Math.abs(intPoint) / l) + 1) * l;
    const c = seg[intPoint % l];
    return { x: calc(c[0], weight), y: calc(c[1], weight), z: calc(c[2], weight), w: calc(c[3], weight) };
  }
  const DIV = 200, lengths = [0];
  { let last = getPoint(0), sum = 0;
    for (let p = 1; p <= DIV; p++) { const cur = getPoint(p / DIV); sum += Math.sqrt(d2(cur, last)); lengths.push(sum); last = cur; } }
  function uToT(u) {
    const il = lengths.length, target = u * lengths[il - 1];
    let low = 0, high = il - 1, i = 0;
    while (low <= high) {
      i = Math.floor(low + (high - low) / 2);
      const cmp = lengths[i] - target;
      if (cmp < 0) low = i + 1; else if (cmp > 0) high = i - 1; else { high = i; break; }
    }
    i = high;
    if (lengths[i] === target) return i / (il - 1);
    const before = lengths[i], after = lengths[i + 1];
    return (i + (target - before) / (after - before)) / (il - 1);
  }
  function getTangent(t) {
    const delta = 0.0001;
    let t1 = t - delta, t2 = t + delta;
    if (t1 < 0) t1 = 0;
    if (t2 > 1) t2 = 1;
    const a = getPoint(t1), b = getPoint(t2);
    let x = b.x - a.x, y = b.y - a.y, z = b.z - a.z;
    const len = Math.sqrt(x * x + y * y + z * z) || 1, k = 1 / len;
    return { x: x * k, y: y * k, z: z * k };
  }
  return {
    length: lengths[DIV],
    getPoint,
    getPointAt: u => getPoint(uToT(u)),
    getTangentAt: u => getTangent(uToT(u)),
    // where along the curve (0..1 of the parameter t) a given u lies; t*l is the control-point index
    uToT,
  };
}
