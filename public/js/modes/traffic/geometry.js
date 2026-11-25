// Highway geometry and the highway's rules for a car. No rendering, no DOM: the tests
// run this file in Node.
//
// The road runs along +Z from z = 0 forever, centred on x = 0. Positions stay in plain
// world metres (no floating origin): JavaScript numbers are 64-bit, so physics is exact
// at any distance, every online player shares the same coordinates, and the renderer
// keeps each road chunk in its own local coordinates (see scene.js), so the picture
// does not shake far from the start either.
import { bodyOf, railContact, resolveWalls } from '../../core/contact.js';
import { worldPoly } from '../../core/hitboxes.js';

export const LANES = 4, LANE_W = 4;
export const HALF = LANES * LANE_W / 2;        // 8 m: edge of the asphalt
export const SHOULDER = 2;                     // 2 m shoulder on each side
export const RAIL = HALF + SHOULDER;           // 10 m: guard rail
export const CHUNK = 200;                      // road is built from 200 m pieces
export const AHEAD = 4, BEHIND = 1;            // pieces kept in front of / behind the car
// Slowest traffic will drive at 16 m/s (58 km/h): the camera must show what the car
// closes in on, not where it would be in 2.5 s at full speed.
export const TRAFFIC_MIN_SPEED = 16;

// Facing down the road (+Z), +X is on the driver's LEFT (three.js is right-handed).
// Lanes are numbered 0..3 from left to right as the driver sees them.
export const laneCenter = i => HALF - LANE_W / 2 - i * LANE_W;
export const nearestLane = x => Math.max(0, Math.min(LANES - 1, Math.round((laneCenter(0) - x) / LANE_W)));

// Which chunk indexes should exist around a car at z.
export function chunkRange(z) {
  const c = Math.floor(z / CHUNK);
  return { from: c - BEHIND, to: c + AHEAD };
}

// Start positions: up to 6 cars, two rows across the four lanes, 8 m between rows.
export function startPose(slot) {
  const row = slot < 4 ? 0 : 1, lane = slot < 4 ? [1, 2, 0, 3][slot] : [1, 2][slot - 4];
  return { x: laneCenter(lane), z: -row * 8 };
}

// Runs right after stepCar() in every substep. The rails are walls like the drift track's
// (core/contact.js): the car's hitbox against their inner faces (x = ±RAIL), pushed out
// along the normal by the depth, an impulse with the car's mass and yaw inertia at the
// contact point (no bounce below 10 km/h into the rail, at most 0.15), friction along the
// rail, the off-centre hit turning the car; hits above 2.5 m/s go to hooks.onWall. Past the
// edge of the lanes (|x| > HALF, the car's centre on the shoulder) the car is off the road,
// as off the drift track: car.off makes stepCar pull at 77.5 % with 70 % grip, and the same
// extra drag as there (exp(-0.45·dt)) holds full throttle to ~83 km/h, so the shoulder is
// no way round the traffic. The rails stop the car before the grass.
const detectRails = (P, nv, c, B, out) => railContact(P, nv, RAIL, out);
export function constrainToHighway(car, dt, hooks) {
  const B = bodyOf(car.carId);
  if (Math.abs(car.x) + B.r > RAIL) resolveWalls(car, B, detectRails, hooks, dt);
  car.off = Math.abs(car.x) > HALF;
  if (car.off) { const k = Math.exp(-.45 * dt); car.vx *= k; car.vz *= k; }
}

// Another player's predicted car must not be drawn through the rails. The prediction
// carries the car on at its last known speed for up to a few tenths of a second; when the
// car hits a rail in that time, the real one stops against it while the prediction would
// sail through (up to 8 m beyond, measured at 200 km/h). So a prediction past a rail is
// moved back across until its hitbox (car id `id`, heading p.h) just touches the rail.
const PK = new Float64Array(64);
export function keepOnRoad(p, id) {
  const B = bodyOf(id);
  if (Math.abs(p.x) + B.r <= RAIL) return p;
  worldPoly(B.id, p.x, p.z, p.h || 0, PK);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 2 * B.nv; i += 2) { const x = PK[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
  if (hi > RAIL) p.x -= hi - RAIL; else if (lo < -RAIL) p.x += -RAIL - lo;
  return p;
}

// Top-down camera. Given the car's speed and the screen's aspect ratio, returns the
// camera pitch (degrees below the horizon), vertical field of view, height above the
// road and how far behind the car its foot point is. Two rules decide the height:
//  1. the road ahead of the car stays visible for at least 3 s of closing in on the
//     slowest traffic (and never less than 55 m);
//  2. on narrow (phone) screens the whole highway, rails included, fits across.
// The car sits about a third of the field of view below the centre of the screen;
// on phones it sits higher, above the touch buttons (carAt is then passed in).
const rad = d => d * Math.PI / 180, cot = a => 1 / Math.tan(a);
export const CAM = { hfov: 68, pitchSlow: 58, pitchFast: 42, carAt: 0.34, minAhead: 55, aheadSeconds: 3, fitWidth: 2 * RAIL + 4 };
export function topDownView(speed, aspect, carAt = CAM.carAt) {
  const fovV = Math.max(38, Math.min(78, 2 * Math.atan(Math.tan(rad(CAM.hfov / 2)) / aspect) * 180 / Math.PI));
  const s = Math.min(1, Math.max(0, speed / 50));
  // tall screens have a tall field of view: keep its top edge at least 12° below the horizon
  const pitch = Math.max(CAM.pitchSlow + (CAM.pitchFast - CAM.pitchSlow) * s, fovV / 2 + 12);
  const ahead = Math.max(CAM.minAhead, CAM.aheadSeconds * (speed - TRAFFIC_MIN_SPEED) + 6);
  const topRay = rad(pitch - fovV / 2), carRay = rad(pitch + fovV * carAt);
  const hAhead = ahead / (cot(topRay) - cot(carRay));
  // width seen at the car's distance must hold the road: 2·dist·tan(hfov/2) ≥ fitWidth
  const hfovReal = 2 * Math.atan(Math.tan(rad(fovV / 2)) * aspect);
  const hFit = CAM.fitWidth / (2 * Math.tan(hfovReal / 2)) * Math.sin(carRay);
  const height = Math.max(hAhead, hFit);
  const back = height * cot(carRay);                        // camera foot point behind the car
  const visibleAhead = height * cot(topRay) - back;          // road seen in front of the car
  return { fovV, pitch, height, back, ahead, visibleAhead };
}
