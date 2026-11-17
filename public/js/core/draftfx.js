// The white air lines streaming back from both rear corners of another player's car:
// the outline of its slipstream pocket (see core/draft.js). Each car gets its own set;
// updateWake() shows, sizes and animates them every frame.
import { pocketHalf, DRAFT } from './draft.js';

let dashImg = null;
function dashTexture() {
  if (!dashImg) {
    const c = document.createElement('canvas'); c.width = 8; c.height = 128;
    const g = c.getContext('2d'); g.clearRect(0, 0, 8, 128);
    // two soft dashes per tile: air streaks, not road markings
    for (const [y, h] of [[6, 46], [70, 30]]) {
      const gr = g.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, y, 8, h);
    }
    dashImg = c;
  }
  const t = new THREE.CanvasTexture(dashImg);
  t.wrapS = THREE.ClampToEdgeWrapping; t.wrapT = THREE.RepeatWrapping;
  return t;
}

// A flat strip 1 m long going backwards from z=0 to z=-1, bright at the car, fading out.
function strip(width) {
  const g = new THREE.PlaneGeometry(width, 1, 1, 1).rotateX(-Math.PI / 2).translate(0, 0, -.5);
  const p = g.attributes.position, col = [];
  for (let i = 0; i < p.count; i++) { const k = p.getZ(i) > -.5 ? 1 : 0; col.push(k, k, k); }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

export function createWake() {
  const map = dashTexture();
  const mat = new THREE.MeshBasicMaterial({ map, color: 0xffffff, vertexColors: true, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  const root = new THREE.Group(); root.visible = false;
  const lines = [];
  for (const s of [1, -1]) for (const [dx, y, w] of [[0, .5, .26], [.2, .9, .14], [-.25, .3, .1]]) {
    const m = new THREE.Mesh(strip(w), mat); m.renderOrder = 3;
    m.userData = { s, dx, y }; root.add(m); lines.push(m);
  }
  return { root, mat, map, lines, a: 0 };
}

// w: the result of wake() for this car (or null); x, z: the car; dt: frame time.
export function updateWake(fx, w, x, z, dt) {
  const target = w ? w.show : 0;
  fx.a += (target - fx.a) * Math.min(1, dt * 6);
  fx.root.visible = fx.a > .02;
  if (!fx.root.visible) return;
  if (w) { fx.len = w.len; fx.v = w.speed; fx.inside = w.inside; fx.root.rotation.y = Math.atan2(w.dirX, w.dirZ); }
  const len = fx.len || 20;
  fx.root.position.set(x, 0, z);
  for (const m of fx.lines) {
    const { s, dx, y } = m.userData;
    const x0 = s * (.95 + dx), x1 = s * (pocketHalf(len) + dx);
    m.position.set(x0, y, -DRAFT.REAR);
    m.rotation.y = -Math.atan2(x1 - x0, len);              // the pocket widens towards its end
    m.scale.set(1, 1, Math.hypot(len, x1 - x0));
  }
  fx.map.repeat.set(1, len / 7);
  fx.map.offset.y += (fx.v || 20) * dt / 7 * .35;           // the streaks flow, slower than the car
  fx.mat.opacity = fx.a * (fx.inside ? 1 : .6);
}

export function disposeWake(fx) {
  for (const m of fx.lines) m.geometry.dispose();
  fx.mat.dispose(); fx.map.dispose();
}
