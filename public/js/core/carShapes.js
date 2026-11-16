// Car bodies with rounded, flowing shapes instead of boxes.
//
// A body is "lofted": a rounded cross-section (a squircle: a rectangle with soft corners)
// is swept from the tail to the nose, changing its width and height on the way, the way a
// clay model is shaped. A cabin is the same idea with only the top half of the section,
// so it has leaning side windows and a raked windscreen. Everything is described by a few
// numbers per vehicle (lengths, heights, where the cabin starts), so every car in the
// game (the player's coupe and the five kinds of traffic) is built by the same code.
//
// Drawing only: the cars' sizes for collisions (core/physics.js, modes/traffic) are not
// read from here and do not change.

const TAU = Math.PI * 2, DEG = Math.PI / 180;
const spow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

// keys: [[t, value], ...] in rising t. The value at t, straight lines between keys with
// the corners rounded off a little (so two slices at the same t always agree).
function lin(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) {
    const [t0, v0] = keys[i - 1], [t1, v1] = keys[i];
    return v0 + (v1 - v0) * (t - t0) / (t1 - t0 || 1);
  }
  return keys[keys.length - 1][1];
}
const soft = (keys, t, d = 0.014) => (lin(keys, t - d) + 2 * lin(keys, t) + lin(keys, t + d)) / 4;

// One cross-section at z: points from angle a0 to a1 (0° = the right side, 90° = the top)
// on a squircle of half-width w between heights y0 and y1. n: 2 = an ellipse, 4-6 = a box
// with round corners. taper: how much narrower the top is than the middle. off: pushed
// outwards by this much (for trim that lies on the surface).
function section(z, w, y0, y1, n, taper, a0, a1, K, off = 0) {
  const pts = [], ym = (y0 + y1) / 2, hh = (y1 - y0) / 2, e = 2 / n;
  const closed = a1 - a0 >= TAU - 1e-6, cnt = closed ? K : K + 1;
  for (let k = 0; k < cnt; k++) {
    const a = a0 + (a1 - a0) * k / K, s = spow(Math.sin(a), e);
    const x = (w + off) * spow(Math.cos(a), e) * (1 - taper * Math.max(0, s));
    pts.push(x, ym + (hh + off) * s, z);
  }
  return pts;
}

// Sections joined into a skin. closed: each section is a full ring; caps: close the ends.
function loft(rings, closed, capA = true, capB = true) {
  const cnt = rings[0].length / 3, pos = [], idx = [];
  for (const r of rings) pos.push(...r);
  const last = closed ? cnt : cnt - 1;
  for (let i = 0; i + 1 < rings.length; i++) for (let k = 0; k < last; k++) {
    const a = i * cnt + k, b = i * cnt + (k + 1) % cnt, c = a + cnt, d = b + cnt;
    idx.push(a, b, c, b, d, c);
  }
  // An end face has its own copy of the edge points, so it is lit as the flat face it is
  // (sharing them with the sides shaded an upright bus front as if it bulged).
  const cap = (i, flip) => {
    const r = rings[i], base = pos.length / 3, centre = base + cnt;
    pos.push(...r);
    let x = 0, y = 0; for (let k = 0; k < cnt; k++) { x += r[k * 3]; y += r[k * 3 + 1]; }
    pos.push(x / cnt, y / cnt, r[2]);
    for (let k = 0; k < (closed ? cnt : cnt - 1); k++) {
      const a = base + k, b = base + (k + 1) % cnt;
      if (flip) idx.push(centre, b, a); else idx.push(centre, a, b);
    }
  };
  if (capA) cap(0, true);
  if (capB) cap(rings.length - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// Slice positions between t0 and t1, closer together near both ends (where shapes curve).
function spread(t0, t1, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(t0 + (t1 - t0) * (0.5 - 0.5 * Math.cos(Math.PI * i / (count - 1))));
  return out;
}

// Several geometries as one, with positions and normals only (what the instanced traffic
// and the player's car both use).
export function merge(list) {
  const pos = [], nor = [];
  for (const g0 of list) {
    const g = g0.index ? g0.toNonIndexed() : g0;
    if (!g.attributes.normal) g.computeVertexNormals();
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array);
    if (g !== g0) g.dispose(); g0.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/* ---------- the pieces a vehicle is made of ---------- */

// The lower body. S: {L, W, n, taper, w, y0, y1} with w (share of the half-width), y0
// (underside) and y1 (top) as keys over t = 0 (tail) … 1 (nose).
function hull(S, D, a0 = 0, a1 = TAU, off = 0, t0 = 0, t1 = 1) {
  const rings = spread(t0, t1, a1 - a0 >= TAU - 1e-6 ? D.M : Math.max(6, D.M >> 1)).map(t =>
    section(-S.L / 2 + t * S.L, S.W / 2 * soft(S.w, t), soft(S.y0, t), soft(S.y1, t), S.n || 4, S.taper ?? 0.06, a0, a1, D.K, off));
  const full = a1 - a0 >= TAU - 1e-6;
  return loft(rings, full, full, full);
}
// The top surface's height above the road at (t, x): for trim that lies on the body.
function hullTop(S, t, x) {
  const w = S.W / 2 * soft(S.w, t), y0 = soft(S.y0, t), y1 = soft(S.y1, t), n = S.n || 4;
  const u = Math.min(0.999, Math.abs(x) / w);
  return (y0 + y1) / 2 + (y1 - y0) / 2 * Math.pow(1 - Math.pow(u, n), 1 / n);
}

// The same for a cabin: the height of its skin at (t, x).
function archTop(C, t, x) {
  const w = C.W / 2 * soft(C.w, t), h = Math.max(.004, soft(C.h, t)), e = 2 / (C.n || 3.2), tp = C.taper ?? 0.16;
  let lo = 0, hi = Math.PI / 2;                              // x falls as the angle rises: bisect
  for (let i = 0; i < 24; i++) { const a = (lo + hi) / 2, s = Math.pow(Math.sin(a), e);
    if (w * Math.pow(Math.cos(a), e) * (1 - tp * s) > Math.abs(x)) lo = a; else hi = a; }
  return C.base + h * Math.pow(Math.sin((lo + hi) / 2), e);
}

// A cabin (or any upper body): the top half of a section, rising from `base`.
// C: {L, W, base, n, taper, h, w} with h (height above base) and w as keys over t.
function arch(C, D, t0, t1, a0 = 0, a1 = 180, off = 0, count = 0, caps = true) {
  const K = Math.max(3, Math.round(D.K / 2 * (a1 - a0) / 180));
  const rings = spread(t0, t1, count || Math.max(5, Math.round(D.M * 0.6))).map(t => {
    const h = Math.max(0.004, soft(C.h, t));
    return section(-C.L / 2 + t * C.L, C.W / 2 * soft(C.w, t), C.base - h, C.base + h, C.n || 3.2, C.taper ?? 0.16, a0 * DEG, a1 * DEG, K, off);
  });
  return loft(rings, false, caps, caps);
}

function box(w, h, d, x, y, z) { return new THREE.BoxGeometry(w, h, d).translate(x, y, z); }
// A wheel lying on its side turned upright: axis along x.
function wheel(r, wid, x, z, seg) { return new THREE.CylinderGeometry(r, r, wid, seg).rotateZ(Math.PI / 2).translate(x, r, z); }
// The arch of bodywork over a wheel.
function flare(r, x, z, seg) { return new THREE.TorusGeometry(r, 0.055, 5, seg, Math.PI).rotateY(Math.PI / 2).translate(x, r * 0.92, z); }

// Detail: K points round a section, M sections along a body, wheel segments.
export const DETAIL = { high: { K: 24, M: 30, wheel: 20 }, low: { K: 12, M: 16, wheel: 10 } };

/* ---------- traffic ---------- */

// A passenger car. o: sizes in metres; cabin: [rear glass foot, roof start, roof end,
// windscreen foot] as shares of the length from the tail.
function passenger(o, D) {
  const { L, W, g, hood, belt, deck, roof, cabin: [c0, c1, c2, c3] } = o, F = L / 2, R = -L / 2;
  const S = { L, W, n: 4, taper: 0.07,
    w: [[0, .62], [.02, .82], [.06, .94], [.16, .99], [.5, 1], [.84, .99], [.94, .94], [.98, .82], [1, .62]],
    y0: [[0, g + .16], [.05, g + .02], [.12, g], [.88, g], [.95, g + .02], [1, g + .14]],
    y1: [[0, deck - .12], [.035, deck], [Math.max(c0, .05), belt], [c3, belt], [.92, hood], [.98, hood - .07], [1, hood - .2]] };
  const H = roof - belt + .09;
  const C = { L, W, base: belt - .09, n: 3.2, taper: 0.17,
    h: [[c0, 0], [c1, H], [(c1 + c2) / 2, H + .015], [c2, H], [c3, 0]],
    w: [[c0, .88], [c1, .84], [c2, .84], [c3, .9]] };
  const mid = (c1 + c2) / 2 + .02, wr = o.wheelR || .34, wx = W / 2 - .1, wz = [F - L * .19, R + L * .19];
  const paint = [hull(S, D), arch(C, D, c1 - .015, c2 + .015, 36, 144, .014, 6, false), arch(C, D, mid - .014, mid + .014, 5, 175, .014, 3, false)];
  const dark = [arch(C, D, c0, c3), hull(S, D, 205 * DEG, 335 * DEG, .012, .05, .95), box(W * .46, .1, .05, 0, g + .2, F - .005)];
  for (const z of wz) for (const s of [1, -1]) dark.push(wheel(wr, .24, s * wx, z, D.wheel), flare(wr + .05, s * (W / 2 - .045), z, D.wheel >> 1));
  // lights lie on the body: strips over both corners of the nose and of the tail
  return { paint, dark,
    heads: [[14, 50], [130, 166]].map(([a, b]) => hull(S, D, a * DEG, b * DEG, .016, .955, .992)),
    tails: [[16, 58], [122, 164]].map(([a, b]) => hull(S, D, a * DEG, b * DEG, .016, .008, .05)) };
}

// A van, a bus, a truck's cab: a low hull with a tall painted upper body, glass laid on it.
// o.slope: how much of the length the windscreen takes; o.side: [from, to] of the side windows.
function tall(o, D) {
  const { L, W, g, belt, roof, slope, side, flat } = o, F = L / 2, R = -L / 2;
  // flat: an upright front (a bus, a lorry's cab); otherwise a short sloping nose (a van)
  const S = { L, W, n: 5, taper: 0.03,
    w: flat ? [[0, .9], [.012, .97], [.04, 1], [1 - .25 / L, 1], [1 - .08 / L, .97], [1, .92]]
            : [[0, .9], [.012, .97], [.04, 1], [1 - .04 - slope * .3, 1], [1 - .012, .96], [1, .86]],
    y0: [[0, g + .08], [.03, g], [.97, g], [1, g + .08]],
    y1: flat ? [[0, belt - .06], [.02, belt], [1, belt]] : [[0, belt - .06], [.02, belt], [1 - slope * .5, belt], [1, belt - .18]] };
  const H = roof - belt + .1, nose = 1 - slope;
  const C = { L, W, base: belt - .1, n: 4.6, taper: 0.06,
    h: flat ? [[0, 0], [.1 / L, H * .96], [.5, H], [1 - .3 / L, H], [1, H * .9]] : [[0, 0], [.1 / L, H * .96], [.5, H], [nose, H * .98], [1 - .012, 0]],
    w: flat ? [[0, .93], [.03, .98], [1 - .25 / L, .98], [1, .92]] : [[0, .93], [.03, .98], [nose, .97], [1, .88]] };
  const paint = [hull(S, D), arch(C, D, 0, flat ? 1 : 1 - .012)];
  const dark = [
    flat ? box(W * .8, (roof - belt) * .5, .07, 0, belt + (roof - belt) * .56, F)                // windscreen
         : arch(C, D, nose + slope * .12, 1 - .012 - slope * .16, 24, 156, .016, 5, false),
    arch(C, D, side[0], side[1], 7, 38, .016, 6, false), arch(C, D, side[0], side[1], 142, 173, .016, 6, false),   // side windows
    hull(S, D, 205 * DEG, 335 * DEG, .012, .03, .97),
    box(W * .7, (roof - belt) * .34, .05, 0, belt + (roof - belt) * .56, R + .015),                // rear window
  ];
  const wr = o.wheelR, wx = W / 2 - .13;
  for (const z of o.axles) for (const s of [1, -1]) dark.push(wheel(wr, .28, s * wx, z, D.wheel), flare(wr + .05, s * (W / 2 - .04), z, D.wheel >> 1));
  return { paint, dark,
    heads: [1, -1].map(s => box(.42, .12, .1, s * W * .31, o.headY, F - .02)),
    tails: [1, -1].map(s => box(.34, .3, .1, s * W * .36, o.tailY, R + .02)) };
}

function truck(T, D) {
  const { len: L, wid: W } = T, F = L / 2, R = -L / 2, cabL = 2.5;
  // the cab is a short tall vehicle of its own, moved to the front
  const cab = tall({ L: cabL, W: 2.36, g: .5, belt: 1.5, roof: 2.75, flat: true, slope: 0, side: [.3, .78], wheelR: .5, axles: [], headY: .78, tailY: 1 }, D);
  const move = g => g.translate(0, 0, F - cabL / 2);
  const paint = cab.paint.map(move), dark = cab.dark.map(move), heads = cab.heads.map(move);
  // the trailer: a long box with soft edges
  const tl = L - cabL - .25;
  const Tr = { L: tl, W, n: 7, taper: 0, w: [[0, .95], [.012, 1], [.988, 1], [1, .95]], y0: [[0, 1.02], [.012, .95], [.988, .95], [1, 1.02]], y1: [[0, 3.33], [.012, 3.4], [.988, 3.4], [1, 3.33]] };
  const trailer = [hull(Tr, { K: D.K, M: Math.max(8, D.M >> 1) }).translate(0, 0, R + tl / 2)];
  dark.push(box(1.1, .3, L - 1.2, 0, .78, -.3), box(W * .9, .12, .1, 0, .62, R + .06));          // frame, rear bar
  for (const z of [F - 1.25, R + 1.3, R + 2.65]) for (const s of [1, -1]) dark.push(wheel(.5, .34, s * (W / 2 - .16), z, D.wheel));
  return { paint, trailer, dark, heads, tails: [1, -1].map(s => box(.34, .26, .1, s * W * .36, .95, R + .02)) };
}

// name: a vehicle type from modes/traffic/sim.js. Returns one geometry per material:
// paint, dark (glass, tyres, trim), heads, tails and, for the truck, trailer.
export function trafficShape(T, detail = 'high') {
  const D = DETAIL[detail], { len: L, wid: W } = T;
  let parts;
  switch (T.name) {
    case 'sedan': parts = passenger({ L, W, g: .2, hood: .78, belt: .9, deck: .88, roof: 1.36, cabin: [.17, .32, .57, .72] }, D); break;
    case 'hatch': parts = passenger({ L, W, g: .2, hood: .8, belt: .92, deck: .98, roof: 1.42, cabin: [.05, .17, .56, .73], wheelR: .32 }, D); break;
    case 'van': parts = tall({ L, W, g: .28, belt: 1.02, roof: 1.92, slope: .2, side: [.5, .76], wheelR: .36, axles: [L / 2 - 1.0, -L / 2 + 1.0], headY: .7, tailY: 1.0 }, D); break;
    case 'bus': parts = tall({ L, W, g: .34, belt: 1.25, roof: 3.0, flat: true, slope: 0, side: [.04, .95], wheelR: .5, axles: [L / 2 - 2.0, -L / 2 + 2.3], headY: .72, tailY: 1.0 }, D); break;
    case 'truck': parts = truck(T, D); break;
  }
  const out = {};
  for (const k of Object.keys(parts)) out[k] = merge(parts[k]);
  return out;
}

/* ---------- the player's car ---------- */

// A low coupe, 4.3 m long and 2 m wide (the size the physics and the collisions use).
// Returns separate geometries so the game can paint, light and animate them:
// paint, glass, dark, stripes (two bands over the bonnet, roof and tail), heads, tails.
export function coupeShape(detail = 'high') {
  const D = DETAIL[detail], L = 4.3, W = 1.98, F = L / 2, R = -L / 2, g = .17;
  const c0 = .1, c1 = .31, c2 = .5, c3 = .67, belt = .8, roof = 1.2;
  const S = { L, W, n: 4, taper: 0.08,
    w: [[0, .64], [.02, .84], [.06, .95], [.16, 1], [.5, 1], [.8, .99], [.92, .94], [.975, .82], [1, .6]],
    y0: [[0, g + .2], [.05, g + .03], [.12, g], [.88, g], [.95, g + .02], [1, g + .12]],
    y1: [[0, .74], [.035, .86], [c0, belt + .02], [c3, belt], [.86, .7], [.96, .62], [1, .44]] };
  const H = roof - belt + .09;
  const C = { L, W, base: belt - .09, n: 3, taper: 0.2,
    h: [[c0, 0], [c1, H * .97], [(c1 + c2) / 2, H], [c2, H * .98], [c3, 0]],
    w: [[c0, .84], [c1, .8], [c2, .8], [c3, .88]] };
  // two bands lying on the body: over the bonnet, the roof and the tail (not the glass)
  const band = (s, t0, t1, top, count) => {
    const pos = [], ts = spread(t0, t1, count), xa = s * .2, xb = s * .5;
    for (let i = 0; i + 1 < ts.length; i++) {
      const z0 = R + ts[i] * L, z1 = R + ts[i + 1] * L;
      const P = [[xa, top(ts[i], xa), z0], [xb, top(ts[i], xb), z0], [xa, top(ts[i + 1], xa), z1], [xb, top(ts[i + 1], xb), z1]];
      for (const k of s > 0 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 1, 3, 2]) pos.push(...P[k]);
    }
    const b = new THREE.BufferGeometry(); b.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); b.computeVertexNormals(); return b;
  };
  const onHull = (t, x) => hullTop(S, t, x) + .012, onRoof = (t, x) => archTop(C, t, x) + .024;
  const stripes = [1, -1].flatMap(s => [band(s, .04, c0 + .012, onHull, 6), band(s, c1 + .005, c2 - .002, onRoof, 6), band(s, c3 - .004, .972, onHull, 12)]);
  // a small wing on the tail: a flat blade with round edges on two feet
  const blade = { L: 1.84, W: .36, n: 2.4, taper: 0, w: [[0, .5], [.06, 1], [.94, 1], [1, .5]], y0: [[0, -.03], [1, -.03]], y1: [[0, .03], [1, .03]] };
  const wing = hull(blade, { K: 10, M: 10 }).rotateY(Math.PI / 2).translate(0, 1.06, R + .28);
  const dark = [hull(S, D, 205 * DEG, 335 * DEG, .012, .05, .95), wing, box(W * .5, .1, .05, 0, g + .2, F - .005), box(W * .56, .12, .05, 0, g + .22, R + .01)];
  for (const s of [1, -1]) dark.push(box(.07, .2, .18, s * .62, .95, R + .3));
  return {
    paint: merge([hull(S, D), arch(C, D, c1 - .01, c2 + .012, 38, 142, .014, 6, false)]),
    glass: merge([arch(C, D, c0, c3)]),
    dark: merge(dark),
    stripes: merge(stripes),
    // lights lie on the body: a strip over each corner of the nose, one bar across the tail
    heads: merge([[16, 48], [132, 164]].map(([a, b]) => hull(S, D, a * DEG, b * DEG, .016, .945, .99))),
    tails: merge([box(1.16, .055, .06, 0, .63, R), ...[[10, 34], [146, 170]].map(([a, b]) => hull(S, D, a * DEG, b * DEG, .016, .006, .05))]),
    flares: [F - .82, R + .8].flatMap(z => [1, -1].map(s => flare(.43, s * (W / 2 - .05), z, 12))),
    wheelZ: [F - .82, R + .8], wheelX: W / 2 - .1,
  };
}

// A wheel for the player's car: a tyre with round shoulders, a rim, five spokes.
export function wheelShape() {
  const r = .38, w = .15;
  const tyre = new THREE.LatheGeometry([[.23, -w], [.33, -w], [r, -w + .05], [r, w - .05], [.33, w], [.23, w]].map(p => new THREE.Vector2(p[0], p[1])), 24).rotateZ(Math.PI / 2);
  const rim = [new THREE.CylinderGeometry(.245, .245, .2, 20, 1, true).rotateZ(Math.PI / 2), new THREE.CylinderGeometry(.07, .07, .3, 10).rotateZ(Math.PI / 2)];
  for (let i = 0; i < 5; i++) rim.push(new THREE.BoxGeometry(.2, .045, .24).translate(0, 0, .12).rotateX(i * TAU / 5));
  return { tyre: merge([tyre]), rim: merge(rim) };
}
