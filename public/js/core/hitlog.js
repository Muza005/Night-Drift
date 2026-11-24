// ?debug=hit (plan 3, stage 0): the last contacts, for the overlay (core/hitdebug.js) and
// the Node scenarios (tests/sync/walls). Pure, no DOM. Off by default: the collision code
// only records while HITLOG.on (one property read per contact), and recording changes
// nothing in the physics.
//
// A contact: kind ('wall' track or highway wall, 'car' another player's car, 'bot' a
// traffic car), the contact point (x, z), the normal (nx, nz: from the contact point into
// the thing hit), how fast the car was going into it (vn, m/s; <= 0: only pushed out) and
// how far it was pushed out (pen, m).
export const HITLOG = {
  on: false,
  seq: 0,
  last: null,
  push(kind, x, z, nx, nz, vn, pen) {
    this.seq++;
    this.last = { kind, x, z, nx, nz, vn, pen, seq: this.seq };
  },
};
