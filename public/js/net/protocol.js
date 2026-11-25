// The room's protocol: which messages the game and the server exchange and what they mean.
// The game sends PROTOCOL when it creates or joins a room; the server (server/src/index.js,
// which reads this file) turns away a game with another number, or none (a tab opened
// before an update), with UPDATED: that tab says so instead of playing with rules the
// other players' games do not share (stage 4 changed what a car-to-car hit is).
// Raise it with every change to the messages or to the shared maths behind them
// (net/bump.js, net/statecodec.js, the cars' hitboxes and masses).
//   1  (none sent) up to plan 3 stage 3: two-circle car hits
//   2  plan 3 stage 4: hits between the cars' hitbox polygons, rigid bodies
//   3  plan 3 stage 4b: ghost mode (room state ghostMode, config { ghostMode }): no hits
//      between players while it is on
export const PROTOCOL = 3;
export const UPDATED = 'Игра обновилась — обновите страницу.';
// the close/error code a refused game gets (Colyseus: 4000-4999 are the room's own)
export const UPDATED_CODE = 4400;
