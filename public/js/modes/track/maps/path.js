// Helpers for drawing a map as a path of straights and arcs, the way a track is planned,
// instead of placing control points by hand (used by «Эстакада» and «Серпантин»).
//
//   const t = trace({ x, z, heading, segments: [['S', 120], ['R', 40, 90], ['S', 60], ['R', 25, -180]] });
//
// x, z: where the path starts (map units, the map's `scale` applies later); heading in
// degrees: 0 is +x, 90 is +z. Seen from above with +z down the screen (+x to the right),
// that is how the map looks; a positive angle turns right (clockwise), a negative one left.
//   ['S', length]            a straight
//   ['R', radius, degrees]   an arc: degrees > 0 to the right, < 0 to the left
// t.pts: [x, z, s] every `step` m (s: the distance along the path), t.at[k]: the distance
// at the start of segment k (t.at[segments.length] = t.total), t.end: where it ends.
// A lap must end where it began: closeLoop() spreads a small gap (a few metres) over the
// whole path so the curve closes exactly.
//
//   profile([[s0, h0], [s1, h1], ...], total)   a height (or bank) along the path: eases
//     from each key to the next with a half cosine (repeat a value to hold it) (the steepest slope of an ease of Δh
//     over a distance L is π·Δh / 2L). Periodic: past the last key it eases back to the first.
//   bump(s, at, width, height)   a smooth crest (1 + cos) of that width and height
export function trace({ x, z, heading = 0, step = 8, segments }) {
  // the step is rounded so the path has a whole number of points (a closed lap then has
  // the same spacing across its start)
  const whole = segments.reduce((a, [k, r, d]) => a + (k === 'S' ? r : Math.abs(r * d * Math.PI / 180)), 0);
  step = whole / Math.max(4, Math.round(whole / step));
  let th = heading * Math.PI / 180, s = 0;
  const pts = [], at = [];
  let carry = 0;               // distance into the current segment of the next point
  for (const seg of segments) {
    at.push(s);
    const [kind, a, b] = seg;
    const len = kind === 'S' ? a : Math.abs(a * b * Math.PI / 180);
    const x0 = x, z0 = z, th0 = th;
    const pos = d => {
      if (kind === 'S') return [x0 + Math.cos(th0) * d, z0 + Math.sin(th0) * d, th0];
      const sg = Math.sign(b), r = a, cx = x0 - Math.sin(th0) * r * sg, cz = z0 + Math.cos(th0) * r * sg, t = th0 + sg * d / r;
      return [cx + Math.sin(t) * r * sg, cz - Math.cos(t) * r * sg, t];
    };
    let d = carry;
    for (; d < len - 1e-6; d += step) { const [px, pz] = pos(d); pts.push([px, pz, s + d]); }
    carry = d - len;
    [x, z, th] = pos(len);
    s += len;
  }
  at.push(s);
  return { pts, at, total: s, end: { x, z, heading: th * 180 / Math.PI } };
}
// spread the gap between the path's end and its start over the path (by distance)
export function closeLoop(t) {
  const [x0, z0] = t.pts[0], gx = t.end.x - x0, gz = t.end.z - z0;
  return t.pts.map(([x, z, s]) => [x - gx * s / t.total, z - gz * s / t.total, s]);
}
const ease = f => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, f)))) / 2;
export function profile(keys, total) {
  return s => {
    const n = keys.length;
    for (let k = 0; k < n; k++) {
      const [s0, h0] = keys[k], [s1, h1] = k + 1 < n ? keys[k + 1] : [keys[0][0] + total, keys[0][1]];
      let q = s; if (q < keys[0][0]) q += total;
      if (q >= s0 && q < s1) return h0 + (h1 - h0) * ease((q - s0) / (s1 - s0));
    }
    return keys[0][1];
  };
}
export const bump = (s, at, width, height) => Math.abs(s - at) < width / 2 ? height * (1 + Math.cos(2 * Math.PI * (s - at) / width)) / 2 : 0;
// Close a lap drawn with trace(): straights ia and ib (not parallel) take whatever length
// brings the path back to its start. Returns the corrected segments.
export function closeBy(segments, ia, ib, heading = 0) {
  const e = trace({ x: 0, z: 0, heading, segments, step: 1 }).end;
  const h = k => { let th = heading; for (let j = 0; j < k; j++) if (segments[j][0] === 'R') th += segments[j][2]; return th * Math.PI / 180; };
  const ua = [Math.cos(h(ia)), Math.sin(h(ia))], ub = [Math.cos(h(ib)), Math.sin(h(ib))];
  const det = ua[0] * ub[1] - ua[1] * ub[0], gx = -e.x, gz = -e.z;
  const a = (gx * ub[1] - gz * ub[0]) / det, b = (ua[0] * gz - ua[1] * gx) / det;
  const out = segments.map(s => [...s]); out[ia][1] += a; out[ib][1] += b;
  return out;
}
