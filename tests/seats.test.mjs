// Seats in a room (public/js/ui/seats.js): the order every screen lists the players in,
// and the colour that comes with a seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roster, seatOf, seatHex, SEAT_HEX } from '../public/js/ui/seats.js';

const room = (hostId, players) => ({ hostId, players: new Map(Object.entries(players)) });

test('the host comes first even when someone came in before, then by order', () => {
  const s = room('c', { a: { order: 1 }, b: { order: 2 }, c: { order: 3 }, d: { order: 5 } });
  assert.deepEqual(roster(s).map(([id]) => id), ['c', 'a', 'b', 'd']);
  assert.equal(seatOf(s, 'c'), 0);
  assert.equal(seatOf(s, 'b'), 2);
  assert.equal(seatOf(s, 'nobody'), 0, 'an unknown id gets the first seat, not -1');
});

test('six seat colours, all different, none the ready green; a seventh wraps around', () => {
  assert.equal(new Set(SEAT_HEX).size, 6);
  assert.ok(!SEAT_HEX.includes(0x3dff8a));
  assert.equal(seatHex(6), seatHex(0));
});
