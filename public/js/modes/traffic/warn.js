// The crash warning: red chevrons painted on the road right behind the bot you are
// about to hit hard (collide.js threat()), with a red glow on its tail. They pulse
// faster the closer the hit, and fade out the moment the danger is gone. A soft hit
// (slower than a crash) never shows them, so they teach where the crash line is.
import { threat, WARN_TTC } from './collide.js';
import { group } from './scene.js';

function chevronTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff'; g.lineWidth = 15; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const y of [44, 92]) { g.beginPath(); g.moveTo(16, y + 22); g.lineTo(64, y - 18); g.lineTo(112, y + 22); g.stroke(); }
  const t = new THREE.CanvasTexture(c); return t;
}
const mat = new THREE.MeshBasicMaterial({ map: chevronTexture(), color: 0xff3355, transparent: true, opacity: 0,
  depthWrite: false, toneMapped: false });
// flat on the road; the texture's top (the chevrons' tips) points down the road
const marker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).rotateY(Math.PI), mat);
marker.renderOrder = 4; marker.visible = false; group.add(marker);
const glowMat = new THREE.MeshBasicMaterial({ color: 0xff2a4d, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
  depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
const glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), glowMat);   // upright, across the bot's tail
glow.renderOrder = 4; glow.visible = false; group.add(glow);

let a = 0, phase = 0, last = null;
// on: false hides it (menu, crash, ghost). Returns the threat, for tests and the HUD.
export function updateWarning(car, sim, dt, on) {
  const T = on ? threat(car, sim) : null;
  if (T) last = T;
  a += ((T ? 1 : 0) - a) * Math.min(1, dt * (T ? 14 : 6));
  marker.visible = glow.visible = a > .02 && !!last;
  if (!marker.visible) return T;
  const urgency = T ? 1 - T.ttc / WARN_TTC : 0;             // 0 far … 1 about to hit
  phase += dt * (4 + 8 * urgency);
  const pulse = .7 + .3 * Math.sin(phase * Math.PI * 2);
  marker.scale.set(last.wid + 1, 1, 4.6);
  marker.position.set(last.x, .07, last.rear - 3);
  glow.scale.set(last.wid + .4, 1.4, 1);
  glow.position.set(last.x, .9, last.rear - .05);
  mat.opacity = a * pulse; glowMat.opacity = a * pulse * .8;
  return T;
}
