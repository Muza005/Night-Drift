// The camera's flight to the start grid (plan 3, U4): the run begins with the camera low in
// front of my car, where the menu's street view left it, and swings round to its place
// behind the car (1.1 s, easing out) while the countdown is still dark. The menu dissolving
// over it and the picture it leaves are ui/hud.js's (dismissMenu, holdPicture).
//
//   fly(on)                       a run starts: with the flight (from the garage or the lobby)
//                                 or without (a quick restart, a reconnect mid-race)
//   flyCamera(camera, car, look, dt)   after the mode's own camera, each race frame: moves the
//                                 camera along the flight toward where the mode put it
//                                 (look: the point the mode looks at)
//
// The flight's time runs with the game's frames: a pause holds it. Reduced motion: no flight.
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
export const DUR = 1.1;               // s
const F = { t: 1 };
export function fly(on){ F.t = on && !reduced.matches ? 0 : 1; }
export const flying = () => F.t < 1;

const C = new THREE.Vector3(), L = new THREE.Vector3();
// done: the run is on (live input): the flight ends here, the mode's camera stands
export function flyCamera(camera, car, look, dt, done = false){
  if(done) F.t = 1;
  if(F.t >= 1) return;
  F.t = Math.min(1, F.t + Math.min(dt, 1 / 30) / DUR);
  const e = 1 - Math.pow(1 - F.t, 3);
  C.copy(car.root.position);
  // where the mode put the camera, around the car: angle, distance, height
  const dx = camera.position.x - C.x, dz = camera.position.z - C.z;
  const a1 = Math.atan2(dx, dz), r1 = Math.hypot(dx, dz), h1 = camera.position.y - C.y;
  // the start: in front of the car and to its right, low, close (the street view's angle)
  const a0 = a1 - 2.4, r0 = 6.2, h0 = 1.15;
  const a = a0 + (a1 - a0) * e, r = r0 + (r1 - r0) * e, h = h0 + (h1 - h0) * e;
  camera.position.set(C.x + Math.sin(a) * r, C.y + h, C.z + Math.cos(a) * r);
  L.set(C.x, C.y + 0.75, C.z).lerp(look, e);
  camera.lookAt(L);
  camera.fov = 46 + (camera.fov - 46) * e;
}
