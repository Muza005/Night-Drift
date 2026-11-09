// Draws the traffic. Every vehicle type is a handful of boxes merged into one geometry
// per material, and each (type, material) pair is one InstancedMesh, so 48 bots cost
// about 25 draw calls instead of a thousand.
//
// Lights matter at night: headlights with a pool of light on the road ahead, tail
// lights that flare when the bot brakes, and blinkers for 1 s before a lane change.
import { isTouch } from '../../state.js';
import { glowTex } from '../../core/render.js';
import { TYPES, CFG, DENSITY } from './sim.js';
import { group } from './scene.js';

const MAX = CFG.maxBots * DENSITY.high;          // room for the densest traffic

// Merge box parts (non-indexed) into one BufferGeometry.
function boxes(list) {
  const pos = [], nor = [];
  for (const [w, h, d, x, y, z] of list) {
    const g = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
    pos.push(...g.attributes.position.array); nor.push(...g.attributes.normal.array); g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}
const wheels = (W, L, r = .35, wx = .2) => [-1, 1].flatMap(s => [-1, 1].map(f => [wx, 2 * r, 2 * r, s * (W / 2 - wx / 2 + .02), r, f * (L / 2 - .9)]));

// Parts per type. Box: [width, height, length, x, y, z]; the vehicle faces +Z.
function shapes(T) {
  const L = T.len, W = T.wid, F = L / 2, R = -L / 2;
  const heads = [[.42, .12, .05, .6 * W / 1.9, .62, F + .02], [.42, .12, .05, -.6 * W / 1.9, .62, F + .02]];
  const tails = [[.46, .13, .05, .58 * W / 1.9, .68, R - .02], [.46, .13, .05, -.58 * W / 1.9, .68, R - .02]];
  switch (T.name) {
    case 'sedan': return {
      paint: [[W, .55, L, 0, .525, 0], [1.5, .06, 1.9, 0, 1.28, -.25]],
      dark: [[1.62, .46, 2.2, 0, 1.03, -.2], ...wheels(W, L)], heads, tails };
    case 'hatch': return {
      paint: [[W, .55, L, 0, .525, 0], [1.45, .06, 1.8, 0, 1.33, -.45]],
      dark: [[1.56, .5, 2.0, 0, 1.05, -.4], ...wheels(W, L, .33)], heads, tails };
    case 'van': return {
      paint: [[W, 1.55, L, 0, 1.075, 0]],
      dark: [[W + .03, .42, 3.4, 0, 1.52, -.4], [1.84, .55, .05, 0, 1.5, F + .02], ...wheels(W, L, .36)],
      heads: heads.map(h => [h[0], h[1], h[2], h[3], .55, h[5]]), tails: tails.map(t => [t[0], .3, t[2], t[3], 1.0, t[5]]) };
    case 'truck': return {
      paint: [[2.3, 2.2, 2.3, 0, 1.55, F - 1.15]],
      trailer: [[W, 2.9, 7.6, 0, 1.95, R + 3.8]],
      dark: [[2.12, .7, .05, 0, 2.1, F + .02], [1.4, .9, .6, 0, 1.2, F - 2.6], ...wheels(W, L, .5, .3)],
      heads: heads.map(h => [h[0], h[1], h[2], h[3] * 1.15, .7, h[5]]), tails: tails.map(t => [t[0], .3, t[2], t[3] * 1.15, .9, t[5]]) };
    case 'bus': return {
      paint: [[W, 2.6, L, 0, 1.65, 0]],
      dark: [[W + .03, .8, L - 1.6, 0, 2.15, -.3], [2.3, 1.0, .05, 0, 2.05, F + .02], ...wheels(W, L, .5, .3)],
      heads: heads.map(h => [h[0], h[1], h[2], h[3] * 1.2, .7, h[5]]), tails: tails.map(t => [t[0], .3, t[2], t[3] * 1.2, 1.0, t[5]]) };
  }
}

// No reds or pinks: the player's car is the only rose-coloured car on the road.
const PALETTE = {
  sedan: [0x6d7f3a, 0x2d6cdf, 0xe8e8ee, 0x22252f, 0x7a8494, 0xf0b429, 0x3aa776, 0x8e44ad],
  hatch: [0xff9a3c, 0x2d6cdf, 0xe8e8ee, 0x5cc8ff, 0x2f8f9d, 0x3aa776],
  van:   [0xe8e8ee, 0xc9ced8, 0x2d6cdf, 0x22252f],
  truck: [0x2d6cdf, 0x8a5a2b, 0x3aa776, 0xf0b429],
  bus:   [0xf0b429, 0x2d6cdf, 0x3aa776],
};

const mats = {
  paint: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: .35, roughness: .45 }),
  trailer: new THREE.MeshStandardMaterial({ color: 0xd8dde8, metalness: .2, roughness: .6 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x12141c, metalness: .5, roughness: .35 }),
  heads: new THREE.MeshBasicMaterial({ color: 0xf4f8ff, toneMapped: false }),
  tails: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
};
const TAIL_DIM = new THREE.Color(0.55, 0.02, 0.06), TAIL_BRAKE = new THREE.Color(1.6, 0.08, 0.12);

// one InstancedMesh per (type, material)
const parts = TYPES.map(T => {
  const sh = shapes(T), out = [];
  for (const key of Object.keys(sh)) {
    const m = new THREE.InstancedMesh(boxes(sh[key]), mats[key], MAX);
    // setColorAt creates the per-instance colour buffer sized by `count`, so call it
    // while count is still MAX, before zeroing it
    if (key === 'paint' || key === 'tails') m.setColorAt(0, new THREE.Color(1, 1, 1));
    m.count = 0; m.frustumCulled = false;
    if (key === 'paint' || key === 'trailer') { m.castShadow = !isTouch; m.receiveShadow = true; }
    group.add(m); out.push({ key, m });
  }
  return out;
});
// blinkers (all types share one mesh) and the pools of headlight on the road
// Blinkers: a lamp on each corner plus a soft amber glow around it, big enough to read
// from the top-down camera.
const blinkers = new THREE.InstancedMesh(new THREE.BoxGeometry(.5, .2, .4), new THREE.MeshBasicMaterial({ color: 0xffb020, toneMapped: false }), MAX * 4);
blinkers.count = 0; blinkers.frustumCulled = false; group.add(blinkers);
const blinkGlow = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffa020, transparent: true, opacity: .75, blending: THREE.AdditiveBlending, depthWrite: false }), MAX * 4);
blinkGlow.count = 0; blinkGlow.frustumCulled = false; group.add(blinkGlow);
const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(3.6, 8).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ map: glowTex, color: 0xbfd4ff, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false }), MAX);
pools.count = 0; pools.frustumCulled = false; group.add(pools);

const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
const counts = TYPES.map(() => 0);

export function drawTraffic(sim) {
  counts.fill(0);
  let nb = 0, np = 0;
  const a = sim.alpha, blinkOn = Math.floor(sim.time * 2.5) % 2 === 0;
  for (const b of sim.bots) {
    const T = TYPES[b.t], x = b.px + (b.x - b.px) * a, z = b.pz + (b.z - b.pz) * a;
    const dz = b.z - b.pz, yaw = dz > 0.01 ? Math.atan2(b.x - b.px, dz) : 0;
    e.set(0, yaw, 0); q.setFromEuler(e); v.set(x, 0, z); m4.compose(v, q, one);
    const i = counts[b.t]++;
    const pal = PALETTE[T.name];
    for (const { key, m } of parts[b.t]) {
      m.setMatrixAt(i, m4);
      if (key === 'paint') m.setColorAt(i, col.setHex(pal[b.color % pal.length]));
      if (key === 'tails') m.setColorAt(i, b.a < -1 ? TAIL_BRAKE : TAIL_DIM);
    }
    // headlight pool ahead of the bot
    v.set(x + Math.sin(yaw) * (T.len / 2 + 4), .03, z + Math.cos(yaw) * (T.len / 2 + 4)); m4.compose(v, q, one); pools.setMatrixAt(np++, m4);
    // blinkers on the side it is moving to (+1 = toward lane+1 = to the driver's right = -X);
    // after a hit: hazard lights, both sides
    const sides = b.hazard > 0 ? [-1, 1] : b.dir !== 0 ? [b.dir] : [];
    if (blinkOn) for (const d of sides) {
      const side = -d * (T.wid / 2 + .02);
      for (const f of [T.len / 2 - .15, -T.len / 2 + .15]) {
        v.set(x + Math.cos(yaw) * side + Math.sin(yaw) * f, .75, z - Math.sin(yaw) * side + Math.cos(yaw) * f);
        m4.compose(v, q, one); blinkers.setMatrixAt(nb, m4);
        v.y = 1.6; m4.compose(v, q, one); blinkGlow.setMatrixAt(nb++, m4);
      }
    }
  }
  parts.forEach((list, t) => list.forEach(({ m }) => {
    m.count = counts[t]; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }));
  blinkers.count = nb; blinkers.instanceMatrix.needsUpdate = true;
  blinkGlow.count = nb; blinkGlow.instanceMatrix.needsUpdate = true;
  pools.count = np; pools.instanceMatrix.needsUpdate = true;
}
