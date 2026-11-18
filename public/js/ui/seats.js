// A room's seats: everyone lists the players the same way (the host first, then by the
// order they came in), and a player's number and colour come from their place in that
// list. The colour is the interface's, not the car's: two players may drive the same
// paint, so the list, the standings, the name tags and the minimap use this one.
// The values match --seat-1 … --seat-6 in css/tokens.css.
export const SEAT_HEX = [0x3ef0ff, 0xff3b6b, 0xffc23d, 0xa77bff, 0x5b8cff, 0xff8a3d];
export const SEATS = 6;

// [[sessionId, player], …] in seat order
export function roster(state){
  const host = state.hostId;
  return [...state.players.entries()].sort(([a, pa], [b, pb]) =>
    (a === host ? -1 : b === host ? 1 : pa.order - pb.order));
}
// 0-based seat of one player (0 if not found)
export function seatOf(state, id){ return Math.max(0, roster(state).findIndex(([k]) => k === id)); }
export const seatHex = i => SEAT_HEX[i % SEAT_HEX.length];
