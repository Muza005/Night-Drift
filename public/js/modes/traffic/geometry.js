// Highway geometry and the highway's rules for a car. No rendering, no DOM: the tests
// run this file in Node.
//
// The road runs along +Z from z = 0 forever, centred on x = 0. Positions stay in plain
// world metres (no floating origin): JavaScript numbers are 64-bit, so physics is exact
// at any distance, every online player shares the same coordinates, and the renderer
// keeps each road chunk in its own local coordinates (see scene.js), so the picture
// does not shake far from the start either.

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

// Runs right after stepCar() in every substep. Same wall response as the drift track
// (push back, bounce at 1.45, keep 90 %, report hits above 2.5 m/s); the rail is a
// straight line, so its normal is simply the x axis. No off-road here: the shoulder is
// paved and the rails stop the car before the grass.
export function constrainToHighway(car, dt, hooks) {
  const lat = car.x, lim = RAIL - 1.25;
  if (Math.abs(lat) > lim) {
    const s = Math.sign(lat), push = Math.abs(lat) - lim; car.x -= s * push;
    const vn = car.vx * s;
    if (vn > 0) { car.vx -= s * vn * 1.45; car.vx *= .9; car.vz *= .9; if (vn > 2.5) hooks.onWall(vn); }
  }
  car.off = false;
}

// Top-down camera. Given the car's speed and the screen's aspect ratio, returns the
// camera pitch (degrees below the horizon), vertical field of view, height above the
// road and how far behind the car its foot point is. Two rules decide the height:
//  1. the road ahead of the car stays visible for at least 2.5 s of closing in on the
//     slowest traffic (and never less than 32 m);
//  2. on narrow (phone) screens the whole highway, rails included, fits across.
// The car sits about 30 % of the field of view below the centre of the screen.
const rad = d => d * Math.PI / 180, cot = a => 1 / Math.tan(a);
export const CAM = { hfov: 68, pitchSlow: 66, pitchFast: 44, carAt: 0.30, minAhead: 32, aheadSeconds: 2.5, fitWidth: 2 * RAIL + 4 };
export function topDownView(speed, aspect) {
  const fovV = Math.max(38, Math.min(78, 2 * Math.atan(Math.tan(rad(CAM.hfov / 2)) / aspect) * 180 / Math.PI));
  const s = Math.min(1, Math.max(0, speed / 50));
  // tall screens have a tall field of view: keep its top edge at least 12° below the horizon
  const pitch = Math.max(CAM.pitchSlow + (CAM.pitchFast - CAM.pitchSlow) * s, fovV / 2 + 12);
  const ahead = Math.max(CAM.minAhead, CAM.aheadSeconds * (speed - TRAFFIC_MIN_SPEED) + 6);
  const topRay = rad(pitch - fovV / 2), carRay = rad(pitch + fovV * CAM.carAt);
  const hAhead = ahead / (cot(topRay) - cot(carRay));
  // width seen at the car's distance must hold the road: 2·dist·tan(hfov/2) ≥ fitWidth
  const hfovReal = 2 * Math.atan(Math.tan(rad(fovV / 2)) * aspect);
  const hFit = CAM.fitWidth / (2 * Math.tan(hfovReal / 2)) * Math.sin(carRay);
  const height = Math.max(hAhead, hFit);
  const back = height * cot(carRay);                        // camera foot point behind the car
  const visibleAhead = height * cot(topRay) - back;          // road seen in front of the car
  return { fovV, pitch, height, back, ahead, visibleAhead };
}
