// Car hitboxes from the 3D models (plan 3, stage 1): writes public/js/core/hitboxes.js.
//
//   node tests/tools/hitboxes.mjs              regenerate public/js/core/hitboxes.js
//   node tests/tools/hitboxes.mjs --check      exit 1 if the file is out of date with the models
//   node tests/tools/hitboxes.mjs --png <out>  also draw every outline and its polygon (plan view)
//
// Run it again whenever a model in public/models/cars/, CAR_LEN (core/carModels.js) or a
// traffic shape (core/carShapes.js, modes/traffic/sim.js TYPES) changes;
// tests/hitboxes.test.mjs fails until then.
//
// How a hitbox is made:
// 1. The model is placed exactly as the game places it (core/carModels.js normalise): the
//    scene's box as three r128's Box3.setFromObject computes it (each mesh's own box, turned
//    by its world matrix), scaled to CAR_LEN along z, centred on x and z. That box's centre
//    is the car's physics centre (main.js puts the model's root at car.x, car.z). The
//    traffic's shapes (core/carShapes.js trafficShape) are built in metres around their
//    centre already.
// 2. The top view: every triangle edge, sampled every BIN / 2, into four profiles: the
//    outermost x on each side per BIN of z, the outermost z at the nose and the tail per BIN
//    of x. (Only edges count: within a strip, a triangle's outermost point lies on an edge.)
// 3. Thin things that stick out are not body: each profile is "opened" with a PROTRUDE-long
//    segment (the most of it that is sustained over PROTRUDE), which cuts every bump
//    shorter than PROTRUDE along the edge it sticks out from: mirrors (10-25 cm along the
//    side), antennas. Wheels (60-70 cm along the side) stay, whatever they stick out by: a
//    wall or another car hits them. Only the sides are opened: the nose's and the tail's
//    profiles are curves across the car (an opening would shave their tips, 1-3 cm), and
//    what sits on them (plates, spoilers, bumpers) is body; there only the points within
//    the opened sides count (a mirror seen from the front is a low shelf beside the body).
// 4. The polygon: the box of that outline (its outermost x on each side, z at nose and
//    tail), each corner rounded by SEGS straight pieces on a circle (vertices on the
//    circle). The front and the rear radius are fitted separately: the radius whose
//    polygon is closest to the outline over that half of the car (the smallest largest
//    distance, both ways: outline to polygon and polygon to outline). The vertices go on
//    the hull along each corner's rays (roundedBox), so the polygon's length is the hull's
//    along those rays: 1.5-3.5 cm short of the body's tip on a round nose (CAR_LEN 4.3 m).
//    After rounding to mm, a vertex that would make the polygon concave (by a fraction of
//    a mm) is dropped.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

export const BIN = 0.01;          // m: profile resolution
export const PROTRUDE = 0.30;     // m: bumps shorter than this along the edge are not body
export const SEGS = 4;            // straight pieces per rounded corner: 4 × (SEGS + 1) = 20 vertices
const ROOT = new URL('../../', import.meta.url);
export const OUT = fileURLToPath(new URL('public/js/core/hitboxes.js', ROOT));

/* ---------- 1. the triangles, placed as the game places them ---------- */

const apply = (m, x, y, z) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];

// The triangles of a model file in the car's frame (m), as a flat [x, z] list of 3 points per
// triangle, and the size it gets.
async function modelTriangles(io, path, carLen) {
  const doc = await io.read(fileURLToPath(new URL('public/' + path, ROOT)));
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const meshes = [];
  scene.traverse(n => { if (n.getMesh()) meshes.push(n); });
  // core/carModels.js normalise: Box3.setFromObject (r128): each geometry's box, its 8
  // corners through the world matrix
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const prims = [];
  for (const n of meshes) {
    const W = n.getWorldMatrix();
    for (const p of n.getMesh().listPrimitives()) {
      if (p.getMode() !== 4) throw new Error(`${path}: ${n.getName()}: primitive mode ${p.getMode()}, only triangles are read`);
      const a = p.getAttribute('POSITION'), e = [], cnt = a.getCount(), loc = new Float64Array(cnt * 3);
      const bl = [Infinity, Infinity, Infinity], bh = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < cnt; i++) {
        a.getElement(i, e);
        for (let k = 0; k < 3; k++) { loc[i * 3 + k] = e[k]; bl[k] = Math.min(bl[k], e[k]); bh[k] = Math.max(bh[k], e[k]); }
      }
      for (let c = 0; c < 8; c++) {
        const q = apply(W, c & 1 ? bh[0] : bl[0], c & 2 ? bh[1] : bl[1], c & 4 ? bh[2] : bl[2]);
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
      }
      const idx = p.getIndices();
      prims.push({ W, loc, idx: idx ? idx.getArray() : null, cnt });
    }
  }
  const k = carLen / (hi[2] - lo[2]);
  const ox = -(lo[0] + hi[0]) / 2, oz = -(lo[2] + hi[2]) / 2;
  const out = [];
  for (const { W, loc, idx, cnt } of prims) {
    const xz = new Float64Array(cnt * 2);
    for (let i = 0; i < cnt; i++) { const q = apply(W, loc[i * 3], loc[i * 3 + 1], loc[i * 3 + 2]); xz[i * 2] = (q[0] + ox) * k; xz[i * 2 + 1] = (q[2] + oz) * k; }
    const n = idx ? idx.length : cnt;
    for (let t = 0; t + 2 < n; t += 3) for (let v = 0; v < 3; v++) { const i = idx ? idx[t + v] : t + v; out.push(xz[i * 2], xz[i * 2 + 1]); }
  }
  return { tris: Float64Array.from(out), size: [(hi[0] - lo[0]) * k, (hi[1] - lo[1]) * k, carLen] };
}

// A traffic type's triangles (core/carShapes.js trafficShape: what modes/traffic/view.js
// draws, centred on the bot's position).
async function trafficTriangles(T) {
  const { trafficShape } = await import('../../public/js/core/carShapes.js');
  const sh = trafficShape(T, 'high'), out = [];
  for (const g of Object.values(sh)) {
    const P = g.attributes.position.array, idx = g.index ? g.index.array : null, n = idx ? idx.length : P.length / 3;
    for (let t = 0; t < n; t++) { const i = idx ? idx[t] : t; out.push(P[i * 3], P[i * 3 + 2]); }
    g.dispose();
  }
  return { tris: Float64Array.from(out), size: [T.wid, 0, T.len] };
}

/* ---------- 2. the top view: four profiles ---------- */

// right/left: outermost x per z bin (max, min); front/rear: outermost z per x bin.
export function profiles(tris, bin = BIN) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < tris.length; i += 2) { x0 = Math.min(x0, tris[i]); x1 = Math.max(x1, tris[i]); z0 = Math.min(z0, tris[i + 1]); z1 = Math.max(z1, tris[i + 1]); }
  x0 -= bin; z0 -= bin;
  const nx = Math.ceil((x1 - x0) / bin) + 2, nz = Math.ceil((z1 - z0) / bin) + 2;
  const P = { bin, x0, z0, nx, nz,
    right: new Float64Array(nz).fill(-Infinity), left: new Float64Array(nz).fill(Infinity),
    front: new Float64Array(nx).fill(-Infinity), rear: new Float64Array(nx).fill(Infinity) };
  const put = (x, z) => {
    const zi = Math.floor((z - z0) / bin), xi = Math.floor((x - x0) / bin);
    if (x > P.right[zi]) P.right[zi] = x; if (x < P.left[zi]) P.left[zi] = x;
    if (z > P.front[xi]) P.front[xi] = z; if (z < P.rear[xi]) P.rear[xi] = z;
  };
  const step = bin / 2;
  for (let t = 0; t < tris.length; t += 6) for (let e = 0; e < 3; e++) {
    const a = t + e * 2, b = t + ((e + 1) % 3) * 2;
    const ax = tris[a], az = tris[a + 1], dx = tris[b] - ax, dz = tris[b + 1] - az;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step));
    for (let s = 0; s < n; s++) put(ax + dx * s / n, az + dz * s / n);
  }
  return P;
}

// 1-D opening with a flat segment of n bins: at each bin, the most of the profile that holds
// over some n bins in a row around it. sign 1 for a max-profile (outermost = largest), -1
// for a min-profile. Empty bins (±Infinity) end a run.
export function open(prof, n, sign = 1) {
  const L = prof.length, v = Float64Array.from(prof, p => sign * p);
  const ero = new Float64Array(L).fill(-Infinity);
  for (let i = 0; i + n <= L; i++) { let m = Infinity; for (let j = i; j < i + n; j++) m = Math.min(m, v[j]); ero[i] = m; }
  const out = new Float64Array(L);
  for (let j = 0; j < L; j++) { let m = -Infinity; for (let i = Math.max(0, j - n + 1); i <= j; i++) m = Math.max(m, ero[i]); out[j] = sign * m; }
  return out;
}

// The body's outline from the profiles: points [x, z, ...], thin bumps cut (or not, raw).
// A point of the nose's or the tail's profile counts only where the sides (cut) reach: a
// mirror is a short bump on a side, but seen from the front it is a low shelf beside the
// body, which no cut along x removes.
export function outline(P, raw = false) {
  const n = Math.max(1, Math.round(PROTRUDE / P.bin));
  const f = raw ? (p => p) : (p, s) => open(p, n, s);
  const right = f(P.right, 1), left = f(P.left, -1), front = P.front, rear = P.rear;   // (nose and tail: not opened, see the header)
  const pts = [];
  for (let i = 0; i < P.nz; i++) {
    const z = P.z0 + (i + .5) * P.bin;
    if (isFinite(right[i])) pts.push(right[i], z);
    if (isFinite(left[i])) pts.push(left[i], z);
  }
  const within = (x, z) => { const i = Math.floor((z - P.z0) / P.bin); return x >= left[i] - P.bin && x <= right[i] + P.bin; };
  for (let i = 0; i < P.nx; i++) {
    const x = P.x0 + (i + .5) * P.bin;
    if (isFinite(front[i]) && within(x, front[i])) pts.push(x, front[i]);
    if (isFinite(rear[i]) && within(x, rear[i])) pts.push(x, rear[i]);
  }
  let R = -Infinity, Lf = Infinity, F = -Infinity, B = Infinity;
  for (let i = 0; i < pts.length; i += 2) { R = Math.max(R, pts[i]); Lf = Math.min(Lf, pts[i]); F = Math.max(F, pts[i + 1]); B = Math.min(B, pts[i + 1]); }
  const o = { pts: Float64Array.from(pts), right: R, left: -Lf, front: F, rear: -B };
  o.hull = hull(o.pts);
  return o;
}

// Convex hull of points [x, z, ...], counter-clockwise (monotone chain).
export function hull(pts) {
  const P = [];
  for (let i = 0; i < pts.length; i += 2) P.push([pts[i], pts[i + 1]]);
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const p of P) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
  return Float64Array.from([...lo.slice(0, -1), ...hi.slice(0, -1)].flat());
}

/* ---------- 3. the polygon ---------- */

// Box (right, left, front, rear: distances from the centre) with rounded corners, radius
// rf at the nose and rr at the tail. Counter-clockwise seen with x to the right and z up
// (the nose), from the tail's right corner. Flat [x, z, ...], 4 × (SEGS + 1) vertices.
// Each corner's vertices lie on the rays from its circle's centre at 0°, 90° / SEGS, … 90°:
// on the circle itself, or, given the body's hull H, where those rays meet the hull (so a
// chamfered or flatter corner is followed as the body has it; on a round corner of radius
// r that is the circle again).
export function roundedBox({ right, left, front, rear }, rf, rr, H = null, segs = SEGS) {
  const out = [];
  const corner = (cx, cz, r, a0) => {
    for (let s = 0; s <= segs; s++) {
      const a = a0 + Math.PI / 2 * s / segs, dx = Math.cos(a), dz = Math.sin(a);
      const t = H ? rayExit(H, cx, cz, dx, dz) : r;
      out.push(cx + t * dx, cz + t * dz);
    }
  };
  corner(right - rr, -rear + rr, rr, -Math.PI / 2);
  corner(right - rf, front - rf, rf, 0);
  corner(-left + rf, front - rf, rf, Math.PI / 2);
  corner(-left + rr, -rear + rr, rr, Math.PI);
  return out;
}
// How far from (cx, cz), inside convex polygon H, the ray along (dx, dz) leaves it.
function rayExit(H, cx, cz, dx, dz) {
  let best = Infinity;
  for (let i = 0, n = H.length; i < n; i += 2) {
    const ax = H[i], az = H[i + 1], ex = H[(i + 2) % n] - ax, ez = H[(i + 3) % n] - az;
    const den = dx * ez - dz * ex; if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - cx) * ez - (az - cz) * ex) / den, u = ((ax - cx) * dz - (az - cz) * dx) / den;
    if (t > 0 && u >= -1e-9 && u <= 1 + 1e-9) best = Math.min(best, t);
  }
  if (!isFinite(best)) throw new Error('corner centre outside the hull');
  return best;
}

// distance from (px, pz) to a closed polygon's boundary
export function edgeDist(poly, px, pz) {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i += 2) {
    const ax = poly[i], az = poly[i + 1], bx = poly[(i + 2) % n], bz = poly[(i + 3) % n];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
    best = Math.min(best, Math.hypot(px - ax - t * dx, pz - az - t * dz));
  }
  return best;
}
// Is (px, pz) inside a convex counter-clockwise polygon?
export function inside(poly, px, pz) {
  for (let i = 0, n = poly.length; i < n; i += 2) {
    const ax = poly[i], az = poly[i + 1], bx = poly[(i + 2) % n], bz = poly[(i + 3) % n];
    if ((bx - ax) * (pz - az) - (bz - az) * (px - ax) < -1e-12) return false;
  }
  return true;
}
// points along a closed polygon's edges, every `step` m: [x, z, ...]
function samples(poly, step) {
  const out = [];
  for (let i = 0, n = poly.length; i < n; i += 2) {
    const ax = poly[i], az = poly[i + 1], bx = poly[(i + 2) % n], bz = poly[(i + 3) % n];
    const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let s = 0; s < m; s++) out.push(ax + (bx - ax) * s / m, az + (bz - az) * s / m);
  }
  return out;
}

// How far polygon `poly` and the body are apart, over the part of the car where sel(z)
// holds. The body here is its outline's convex hull: a convex polygon can follow nothing
// else, and a wall (or another car's corner, give or take a few cm) touches only the hull.
//   max    the larger of the two one-way distances between the boundaries (Hausdorff)
//   out    how far the body sticks out of the polygon
//   air    how far the polygon reaches beyond the body
export function deviation(poly, H, sel = () => true, step = 0.01) {
  let out = 0, hp = 0, air = 0;
  const hs = samples(H, step), ps = samples(poly, step);
  for (let k = 0; k < hs.length; k += 2) {
    const x = hs[k], z = hs[k + 1]; if (!sel(z)) continue;
    const d = edgeDist(poly, x, z); hp = Math.max(hp, d);
    if (!inside(poly, x, z)) out = Math.max(out, d);
  }
  let ph = 0;
  for (let k = 0; k < ps.length; k += 2) {
    const x = ps[k], z = ps[k + 1]; if (!sel(z)) continue;
    const d = edgeDist(H, x, z); ph = Math.max(ph, d);
    if (!inside(H, x, z)) air = Math.max(air, d);
  }
  return { max: Math.max(hp, ph), out, air };
}
// How deep the outline goes inside its hull (a waist, wheel arches, the gap behind a
// lorry's cab): what no convex polygon follows.
export function concavity(O) {
  let w = 0;
  for (let k = 0; k < O.pts.length; k += 2) w = Math.max(w, edgeDist(O.hull, O.pts[k], O.pts[k + 1]));
  return w;
}

// Radii (front and rear, 1 cm steps) for the box of outline O.
export function fit(O) {
  const cap = Math.min(O.right, O.left, O.front, O.rear) - 0.02;
  const best = (front, other) => {
    let r = 0.05, d = Infinity;
    for (let c = 0.05; c <= cap + 1e-9; c += 0.01) {
      let poly;
      try { poly = front ? roundedBox(O, c, other, O.hull) : roundedBox(O, other, c, O.hull); } catch { continue; }   // (the centre off the body)
      const m = deviation(poly, O.hull, front ? z => z >= 0 : z => z < 0, 0.02).max;
      if (m < d - 1e-9) { d = m; r = c; }
    }
    return Math.round(r * 100) / 100;
  };
  let rf = 0.5, rr = 0.5;
  for (let it = 0; it < 2; it++) { rf = best(true, rr); rr = best(false, rf); }
  return { rf, rr };
}

// drop the vertices where a closed polygon [x, z, ...] turns clockwise (keeps straight runs)
export function convexOnly(p) {
  for (let again = true; again;) {
    again = false;
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const a = ((i + n - 1) % n) * 2, b = i * 2, c = ((i + 1) % n) * 2;
      if ((p[b] - p[a]) * (p[c + 1] - p[b + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[b]) < -1e-12) { p.splice(b, 2); again = true; break; }
    }
  }
  return p;
}

/* ---------- 4. all cars, the data module ---------- */

const r3 = v => Math.round(v * 1000) / 1000;

// Every car of core/cars.js and every traffic type: { id, name, src, tris, size }.
export async function sources() {
  const { CARS } = await import('../../public/js/core/cars.js');
  // carModels.js and carShapes.js want the global THREE (r128) of the page
  if (!globalThis.THREE) globalThis.THREE = await import('three');
  const { CAR_LEN } = await import('../../public/js/core/carModels.js');
  const { TYPES } = await import('../../public/js/modes/traffic/sim.js');
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const items = [];
  for (const c of CARS) items.push({ id: c.id, name: c.name, src: c.model, ...(await modelTriangles(io, c.model, CAR_LEN)) });
  for (const T of TYPES) items.push({ id: 'bot:' + T.name, name: 'traffic ' + T.name, src: 'carShapes.js trafficShape', ...(await trafficTriangles(T)) });
  return items;
}

// Their measured outline and hitbox (adds P, raw, O, box, rf, rr, poly, dev, waist).
export async function build(items) {
  if (!items) items = await sources();
  for (const it of items) {
    it.P = profiles(it.tris);
    it.raw = outline(it.P, true);
    it.O = outline(it.P);
    const { rf, rr } = fit(it.O);
    const box = { right: r3(it.O.right), left: r3(it.O.left), front: r3(it.O.front), rear: r3(it.O.rear) };
    it.box = box; it.rf = rf; it.rr = rr;
    it.poly = convexOnly(roundedBox(box, rf, rr, it.O.hull).map(r3));
    // the sizes stored: the polygon's own (its vertices lie on the body's hull, within a mm or two of the box)
    const xs = it.poly.filter((_, i) => i % 2 === 0), zs = it.poly.filter((_, i) => i % 2 === 1);
    it.box = { right: Math.max(...xs), left: -Math.min(...xs), front: Math.max(...zs), rear: -Math.min(...zs) };
    it.dev = deviation(it.poly, it.O.hull);
    it.waist = concavity(it.O);
  }
  return items;
}

export function moduleText(items) {
  const L = [];
  L.push(`// GENERATED by tests/tools/hitboxes.mjs from the car models: do not edit by hand.`);
  L.push(`// Regenerate after a model, CAR_LEN or a traffic shape changes:`);
  L.push(`//   node tests/tools/hitboxes.mjs`);
  L.push(`// tests/hitboxes.test.mjs fails while this file is out of date.`);
  L.push(`//`);
  L.push(`// Each car's hitbox (plan 3, stage 1): its body's outline seen from above, as a convex`);
  L.push(`// polygon: a box by the body's length and width with each corner rounded by ${SEGS} straight`);
  L.push(`// pieces (radius fitted to the model, front and rear apart), ${4 * (SEGS + 1)} vertices (one fewer where`);
  L.push(`// one would make it concave). Mirrors, antennas and other bumps on the sides shorter than`);
  L.push(`// ${PROTRUDE * 100} cm along the car are left out; wheels, bumpers and spoilers are in. How it is`);
  L.push(`// measured: the header of tests/tools/hitboxes.mjs.`);
  L.push(`//`);
  L.push(`// Metres, in the car's frame, origin at its physics centre (car.x, car.z: the middle of`);
  L.push(`// the model's box). z: forward, (sin h, cos h) in the world. x: across, (cos h, -sin h) in`);
  L.push(`// the world: the axis core/physics.js calls r (the model's +x; carModels.js names that`);
  L.push(`// side "left", the polygons are symmetric enough that it does not matter). Vertices`);
  L.push(`// counter-clockwise with x drawn to the right and z up. Traffic: 'bot:<type>' (the`);
  L.push(`// shapes of core/carShapes.js; frame: the bot's pose, modes/traffic/collide.js botPose).`);
  L.push(`//`);
  L.push(`// Plain data and maths (no three.js, no DOM): the game and the server read the same numbers.`);
  L.push(`//`);
  L.push(`//   len, wid       body length and width (m)       front, rear, right, left   from the centre`);
  L.push(`//   rFront, rRear  corner radii (m)                r   bounding radius (farthest vertex)`);
  L.push(`//   dev            largest distance between the polygon and the hull of the body's outline (m)`);
  L.push(`//   waist          how deep the outline goes inside that hull (m): no convex polygon follows it`);
  L.push(`//   poly           Float64Array [x0, z0, x1, z1, ...]`);
  L.push(``);
  L.push(`const H = {`);
  for (const it of items) {
    const b = it.box, poly = it.poly;
    let r = 0; for (let i = 0; i < poly.length; i += 2) r = Math.max(r, Math.hypot(poly[i], poly[i + 1]));
    L.push(`  ${JSON.stringify(it.id)}: { // ${it.name}: ${it.src}`);
    L.push(`    len: ${r3(b.front + b.rear)}, wid: ${r3(b.right + b.left)}, front: ${b.front}, rear: ${b.rear}, right: ${b.right}, left: ${b.left},`);
    L.push(`    rFront: ${it.rf}, rRear: ${it.rr}, r: ${r3(r + 0.0005)}, dev: ${r3(it.dev.max)}, waist: ${r3(it.waist)},`);
    const pairs = []; for (let i = 0; i < poly.length; i += 2) pairs.push(`${poly[i]}, ${poly[i + 1]}`);
    L.push(`    poly: [${pairs.join(',  ')}] },`);
  }
  L.push(`};`);
  L.push(`for (const k in H) { H[k].id = k; H[k].poly = Float64Array.from(H[k].poly); Object.freeze(H[k]); }`);
  L.push(`export const HITBOXES = Object.freeze(H);`);
  L.push(`export const HITBOX_IDS = Object.keys(H);`);
  L.push(``);
  L.push(`// The hitbox of car id (core/cars.js) or 'bot:<type>'; an unknown car id gets the first car's.`);
  L.push(`export const hitbox = id => H[id] || H[HITBOX_IDS[0]];`);
  L.push(`// Its bounding radius: no point of the polygon is farther from the centre.`);
  L.push(`export const hitRadius = id => hitbox(id).r;`);
  L.push(``);
  L.push(`// The polygon of car id at (x, z) with heading h, in world coordinates: [x0, z0, x1, z1, ...]`);
  L.push(`// into out (any array of at least poly.length numbers; no allocation then), else a new`);
  L.push(`// Float64Array. Returns it.`);
  L.push(`export function worldPoly(id, x, z, h, out) {`);
  L.push(`  const p = hitbox(id).poly, n = p.length, c = Math.cos(h), s = Math.sin(h);`);
  L.push(`  if (!out) out = new Float64Array(n);`);
  L.push(`  for (let i = 0; i < n; i += 2) { const lx = p[i], lz = p[i + 1]; out[i] = x + lx * c + lz * s; out[i + 1] = z - lx * s + lz * c; }`);
  L.push(`  return out;`);
  L.push(`}`);
  return L.join('\n') + '\n';
}

/* ---------- the picture ---------- */

export async function picture(items, file) {
  const { BUMP } = await import('../../public/js/net/bump.js');
  const { WALL_ALLOW } = await import('../../public/js/core/contact.js');
  const S = 80, pad = 14, head = 54;                 // px per m
  const cars = items.filter(i => !i.id.startsWith('bot:')), bots = items.filter(i => i.id.startsWith('bot:'));
  const cellW = it => Math.max(2.9, it.raw.right + it.raw.left + 0.6) * S;
  const cellH = it => (it.raw.front + it.raw.rear + 0.5) * S + head;
  const rows = [cars, bots];
  const width = Math.max(...rows.map(r => r.reduce((s, it) => s + cellW(it) + pad, pad)));
  const rowH = rows.map(r => Math.max(...r.map(cellH)) + pad);
  const height = rowH.reduce((a, b) => a + b, 0) + pad + 40;
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" font-family="DejaVu Sans, sans-serif">`,
    `<rect width="100%" height="100%" fill="#0f1117"/>`,
    `<text x="${pad}" y="26" fill="#e6e8ee" font-size="16">Plan view, nose up, ${S} px/m. grey: model top view (all of it)  white: body outline (bumps &lt; ${PROTRUDE * 100} cm cut)  pink: hitbox polygon  dashed: today's 2 × ${BUMP.R} m circles  yellow: wall allowance ${WALL_ALLOW} m</text>`];
  let y = 40;
  rows.forEach((row, ri) => {
    let x = pad;
    for (const it of row) {
      const w = cellW(it), cx = x + w / 2, cz = y + head + (it.raw.front + 0.25) * S;
      const X = v => (cx + v * S).toFixed(1), Z = v => (cz - v * S).toFixed(1);
      svg.push(`<rect x="${x}" y="${y}" width="${w.toFixed(0)}" height="${(rowH[ri] - pad).toFixed(0)}" fill="#171a23" rx="6"/>`);
      svg.push(`<text x="${x + 8}" y="${y + 18}" fill="#fff" font-size="14" font-weight="bold">${it.id}</text>`);
      svg.push(`<text x="${x + 8}" y="${y + 34}" fill="#b9bfcc" font-size="11">${it.box.front + it.box.rear > 0 ? (it.box.front + it.box.rear).toFixed(2) : ''} × ${(it.box.right + it.box.left).toFixed(2)} m  r ${it.rf} / ${it.rr}</text>`);
      svg.push(`<text x="${x + 8}" y="${y + 48}" fill="#b9bfcc" font-size="11">dev ${(it.dev.max * 100).toFixed(1)} cm</text>`);
      // raw top view: the profile points before cutting bumps
      const dots = []; for (let k = 0; k < it.raw.pts.length; k += 2) dots.push(`M${X(it.raw.pts[k])} ${Z(it.raw.pts[k + 1])}h0.01`);
      svg.push(`<path d="${dots.join('')}" stroke="#6b7280" stroke-width="3" stroke-linecap="round"/>`);
      const od = []; for (let k = 0; k < it.O.pts.length; k += 2) od.push(`M${X(it.O.pts[k])} ${Z(it.O.pts[k + 1])}h0.01`);
      svg.push(`<path d="${od.join('')}" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>`);
      if (!it.id.startsWith('bot:')) {
        for (const k of [1, -1]) svg.push(`<circle cx="${X(0)}" cy="${Z(k * BUMP.OFF)}" r="${BUMP.R * S}" fill="none" stroke="#9aa4b8" stroke-width="1.2" stroke-dasharray="5 4"/>`);
        svg.push(`<circle cx="${X(0)}" cy="${Z(0)}" r="${WALL_ALLOW * S}" fill="none" stroke="#f5c400" stroke-width="1.2" stroke-dasharray="2 3"/>`);
      } else {
        // the box modes/traffic/collide.js uses today
        const T = it.size; svg.push(`<rect x="${X(-T[0] / 2)}" y="${Z(T[2] / 2)}" width="${T[0] * S}" height="${T[2] * S}" fill="none" stroke="#9aa4b8" stroke-width="1.2" stroke-dasharray="5 4"/>`);
      }
      const pp = []; for (let k = 0; k < it.poly.length; k += 2) pp.push(`${X(it.poly[k])},${Z(it.poly[k + 1])}`);
      svg.push(`<polygon points="${pp.join(' ')}" fill="rgba(255,64,160,0.10)" stroke="#ff40a0" stroke-width="1.8"/>`);
      for (let k = 0; k < it.poly.length; k += 2) svg.push(`<circle cx="${X(it.poly[k])}" cy="${Z(it.poly[k + 1])}" r="2.2" fill="#ff40a0"/>`);
      svg.push(`<circle cx="${X(0)}" cy="${Z(0)}" r="2.5" fill="#f5c400"/>`);
      x += w + pad;
    }
    y += rowH[ri];
  });
  svg.push(`</svg>`);
  const sharp = (await import('sharp')).default;
  await sharp(Buffer.from(svg.join('\n'))).png().toFile(file);
}

/* ---------- command line ---------- */

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const items = await build();
  const text = moduleText(items);
  for (const it of items) {
    console.log(`${it.id.padEnd(10)} ${(it.box.front + it.box.rear).toFixed(3)} × ${(it.box.right + it.box.left).toFixed(3)} m` +
      `  (front ${it.box.front} rear ${it.box.rear} right ${it.box.right} left ${it.box.left})  r ${it.rf}/${it.rr}` +
      `  dev ${(it.dev.max * 100).toFixed(1)} cm (out ${(it.dev.out * 100).toFixed(1)} air ${(it.dev.air * 100).toFixed(1)}) waist ${(it.waist * 100).toFixed(1)}` +
      `  raw ${(it.raw.front + it.raw.rear).toFixed(3)} × ${(it.raw.right + it.raw.left).toFixed(3)}`);
  }
  const png = args.indexOf('--png');
  if (png >= 0) { await picture(items, args[png + 1]); console.log('drew', args[png + 1]); }
  if (args.includes('--check')) {
    let cur = ''; try { cur = readFileSync(OUT, 'utf8'); } catch {}
    if (cur !== text) { console.error(`${OUT} is out of date: run node tests/tools/hitboxes.mjs`); process.exit(1); }
    console.log('up to date');
  } else {
    writeFileSync(OUT, text);
    console.log('wrote', OUT);
  }
}
