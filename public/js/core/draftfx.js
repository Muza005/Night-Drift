// The white air trailing behind another player's car: its slipstream (see core/draft.js).
// Soft ribbons of air leave the car's rear corners (and, fainter, the edges of its roof)
// and lie along the path the car really drove, like a ghost of it: when the car turns,
// the new part of the ribbon follows the new heading and the old part stays where the
// car was. Bright and dense at the car, thinning, widening and fading over ~1.2 s.
//
// One mesh per car, all its ribbons in one geometry; every frame the vertices are
// rewritten in place from the car's trail (no new objects per frame).
import { DRAFT, trailIdx } from './draft.js';

const AGE = 1.2;                 // seconds of trail drawn
const PTS = 44;                  // points per ribbon: the car itself + 1.2 s at one per 30 ms (+ slack)
// the ribbons: [metres to the side of the centre, height, width, brightness]
const STREAKS = [[.92, .55, .34, 1], [-.92, .55, .34, 1], [.56, 1.12, .16, .5], [-.56, 1.12, .16, .5]];
const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

const VERT = `
attribute vec3 aData;            // x: -1..1 across the ribbon, y: brightness, z: odometer (m)
uniform float uFog;
varying vec3 vData;
varying float vFog;
void main(){
  vData = aData;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = length(mv.xyz);
  // the scene's FogExp2; and the air thins out as it reaches the camera (it passes under
  // our own car and would fill the screen)
  vFog = exp(-uFog * uFog * d * d) * smoothstep(7.0, 17.0, d);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform float uTime, uShim, uA;
varying vec3 vData;
varying float vFog;
void main(){
  float u = vData.x;
  float soft = exp(-3.2 * u * u) - 0.04;            // a soft edge across the ribbon, no hard line
  float s = vData.z;
  // the air flows: two slow waves along the ribbon, never dark gaps (not dashes)
  float shim = 1.0 + uShim * (0.16 * sin(s * 0.55 - uTime * 7.0) + 0.1 * sin(s * 1.7 + u * 2.0 - uTime * 11.0));
  float a = uA * vData.y * max(soft, 0.0) * shim * vFog;
  gl_FragColor = vec4(vec3(0.93, 0.96, 1.0), a);
}`;

export function createWake() {
  const nV = STREAKS.length * PTS * 2;
  const g = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(nV * 3), 3);
  const data = new THREE.BufferAttribute(new Float32Array(nV * 3), 3);
  pos.setUsage(THREE.DynamicDrawUsage); data.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', pos); g.setAttribute('aData', data);
  const idx = [];
  for (let r = 0; r < STREAKS.length; r++) for (let i = 0; i < PTS - 1; i++) {
    const a = (r * PTS + i) * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uShim: { value: 1 }, uA: { value: 0 }, uFog: { value: .0058 } } });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; mesh.renderOrder = 3;      // world-space vertices: the bounds would be stale
  const root = new THREE.Group(); root.visible = false; root.add(mesh);
  // scratch: the centre line of one ribbon (x, y, z, age 0..1, odometer) per point
  return { root, mesh, geo: g, mat, pos, data, line: new Float64Array(PTS * 5), a: 0, bright: .6, wide: 1, inside: false, time: 0 };
}

// w: the result of wake() for this car (or null); lead: the car's drawn pose {x, z, y, h}
// (null while it is not drawn: the ribbons stay where they are and fade); trail: its trail
// (core/draft.js); cam: the camera's position (the ribbons turn their face to it);
// fog: the scene's FogExp2 density.
export function updateWake(fx, w, lead, trail, dt, cam, fog) {
  const target = w ? w.show : 0;
  // in quickly, out over 0.5 s once there is no pocket to show
  fx.a = target > fx.a ? fx.a + (target - fx.a) * Math.min(1, dt * 8) : Math.max(target, fx.a - dt / .5);
  if (w) fx.inside = w.inside;
  const k = Math.min(1, dt * 5);
  fx.bright += ((fx.inside ? 1 : .6) - fx.bright) * k;
  fx.wide += ((fx.inside ? 1.25 : 1) - fx.wide) * k;
  fx.root.visible = fx.a > .01;
  if (!fx.root.visible) return;
  fx.time += dt;
  const u = fx.mat.uniforms;
  u.uA.value = fx.a * fx.bright; u.uTime.value = fx.time % 1000;
  u.uShim.value = reducedMotion.matches ? 0 : 1;
  if (fog != null) u.uFog.value = fog;
  if (lead && trail) build(fx, lead, trail, cam);
}

function build(fx, lead, tr, cam) {
  const P = fx.pos.array, D = fx.data.array, L = fx.line;
  // the points: the car now, then its trail back to 1.2 s ago
  let n = 0;
  const cnt = Math.min(tr.count, PTS - 1);
  const odo0 = tr.count ? tr.odo + Math.hypot(lead.x - tr.x[trailIdx(tr, 0)], lead.z - tr.z[trailIdx(tr, 0)]) : 0;
  for (let r = 0; r < STREAKS.length; r++) {
    const S = STREAKS[r], lx = S[0], ly = S[1], lw = S[2], lb = S[3];
    n = 0;
    for (let k = -1; k < cnt; k++) {
      let x, z, y, h, age, odo;
      if (k < 0) { x = lead.x; z = lead.z; y = lead.y || 0; h = lead.h; age = 0; odo = odo0; }
      else {
        const i = trailIdx(tr, k);
        age = (tr.clock - tr.t[i]) / AGE;
        if (age > 1) break;
        x = tr.x[i]; z = tr.z[i]; y = tr.y[i]; h = tr.h[i]; odo = tr.d[i];
        if (k === 0 && Math.abs(x - lead.x) + Math.abs(z - lead.z) < .05) continue;   // same spot as the car now
      }
      const sn = Math.sin(h), cs = Math.cos(h), spread = 1 + .35 * age;   // the air spreads out a little
      const o = n * 5;
      L[o] = x + cs * lx * spread - sn * DRAFT.REAR;
      L[o + 1] = y + ly;
      L[o + 2] = z - sn * lx * spread - cs * DRAFT.REAR;
      L[o + 3] = age; L[o + 4] = odo;
      n++;
    }
    const base = r * PTS * 2;
    for (let i = 0; i < PTS; i++) {
      const v = (base + i * 2) * 3;
      if (i >= n || n < 2) {            // unused: folded onto the last point, invisible
        const j = Math.max(0, n - 1) * 5;
        P[v] = P[v + 3] = L[j]; P[v + 1] = P[v + 4] = L[j + 1]; P[v + 2] = P[v + 5] = L[j + 2];
        D[v + 1] = D[v + 4] = 0; D[v] = -1; D[v + 3] = 1; D[v + 2] = D[v + 5] = 0;
        continue;
      }
      const o = i * 5, a = Math.max(0, i - 1) * 5, b = Math.min(n - 1, i + 1) * 5;
      let tx = L[b] - L[a], ty = L[b + 1] - L[a + 1], tz = L[b + 2] - L[a + 2];
      const cx = cam.x - L[o], cy = cam.y - L[o + 1], cz = cam.z - L[o + 2];
      // across the ribbon: square to its direction and to the line of sight
      let sx = ty * cz - tz * cy, sy = tz * cx - tx * cz, sz = tx * cy - ty * cx;
      let sl = Math.sqrt(sx * sx + sy * sy + sz * sz);   // (not Math.hypot: it allocates)
      if (sl < 1e-6) { sx = tz; sy = 0; sz = -tx; sl = Math.sqrt(sx * sx + sz * sz) || 1; }
      const age = L[o + 3];
      const half = lw * .5 * fx.wide * (1 + age) / sl;
      // bright at the car (a short fade-in off the bumper), thinning to nothing at the tail
      const alpha = lb * Math.min(1, i / 2.5) * Math.pow(1 - age, 1.6) / (1 + .6 * age);
      P[v] = L[o] - sx * half; P[v + 1] = L[o + 1] - sy * half; P[v + 2] = L[o + 2] - sz * half;
      P[v + 3] = L[o] + sx * half; P[v + 4] = L[o + 1] + sy * half; P[v + 5] = L[o + 2] + sz * half;
      D[v] = -1; D[v + 3] = 1; D[v + 1] = D[v + 4] = alpha; D[v + 2] = D[v + 5] = L[o + 4];
    }
  }
  fx.pos.needsUpdate = true; fx.data.needsUpdate = true;
}

export function disposeWake(fx) { fx.geo.dispose(); fx.mat.dispose(); }
