// Draws the traffic. Every vehicle type is one geometry per material (a rounded body,
// glass, lights: see core/carShapes.js), and each (type, material) pair is one
// InstancedMesh, so 48 bots cost about 25 draw calls instead of a thousand.
//
// Lights matter at night: headlights with a pool of light on the road ahead, tail
// lights that flare when the bot brakes, and blinkers for 1 s before a lane change.
import { isTouch } from '../../state.js';
import { glowTex, carEnv } from '../../core/render.js';
import { trafficShape } from '../../core/carShapes.js';
import { TYPES, CFG, DENSITY } from './sim.js';
import { group } from './scene.js';

// Room for the densest traffic: 106 bots on one player's stretch of road (48 × 2.2,
// rounded up: there can be 106, and a buffer sized 105.6 holds 105). Online the server
// also sends the bots of a player just ahead or behind, so there is room for twice that;
// drawTraffic() never draws more than fit.
const MAX = 2 * Math.ceil(CFG.maxBots * DENSITY.high);

// The vehicles' shapes come from core/carShapes.js: rounded bodies, one geometry per
// material. Phones get the same shapes with fewer triangles.
const shapes = T => trafficShape(T, isTouch ? 'low' : 'high');

// No reds or pinks: the player's car is the only rose-coloured car on the road.
const PALETTE = {
  sedan: [0x6d7f3a, 0x2d6cdf, 0xe8e8ee, 0x22252f, 0x7a8494, 0xf0b429, 0x3aa776, 0x8e44ad],
  hatch: [0xff9a3c, 0x2d6cdf, 0xe8e8ee, 0x5cc8ff, 0x2f8f9d, 0x3aa776],
  van:   [0xe8e8ee, 0xc9ced8, 0x2d6cdf, 0x22252f],
  truck: [0x2d6cdf, 0x8a5a2b, 0x3aa776, 0xf0b429],
  bus:   [0xf0b429, 0x2d6cdf, 0x3aa776],
};

const mats = {
  paint: new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: .4, roughness: .34, envMap: carEnv, envMapIntensity: .8 }),
  trailer: new THREE.MeshStandardMaterial({ color: 0xd8dde8, metalness: .2, roughness: .6 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x12141c, metalness: .6, roughness: .22, envMap: carEnv, envMapIntensity: 1.2 }),
  heads: new THREE.MeshBasicMaterial({ color: 0xf4f8ff, toneMapped: false }),
  tails: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
};
const TAIL_DIM = new THREE.Color(0.55, 0.02, 0.06), TAIL_BRAKE = new THREE.Color(1.6, 0.08, 0.12);

// one InstancedMesh per (type, material)
const parts = TYPES.map(T => {
  const sh = shapes(T), out = [];
  for (const key of Object.keys(sh)) {
    const m = new THREE.InstancedMesh(sh[key], mats[key], MAX);
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
    if (np >= MAX) break;                                   // never past the end of the buffers
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
