// Wall contact (plan 3). Stage 3 moves the wall response here (wallKeep, wallAlign and the
// bounce of both modes' walls); until then it holds the one number both modes share.
//
// WALL_ALLOW: today a wall is checked at one point, the car's centre, which may come this
// close to it (m), whatever the car and however it is turned (track: WALL - WALL_ALLOW from the
// centre line, a shortcut's wall - WALL_ALLOW; highway: RAIL - WALL_ALLOW).
export const WALL_ALLOW = 1.25;
