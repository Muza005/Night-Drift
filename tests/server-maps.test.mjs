// The room's drift map on the real server: the host picks it in the lobby (the guest can
// not), only known public maps unless the server allows hidden ones, and the fastest lap
// the server believes follows the map's length (public/js/modes/track/maps/meta.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Colyseus from 'colyseus.js';
import { startServer } from './server-start.mjs';
import { MAP_META, minLapMs } from '../public/js/modes/track/maps/meta.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let plain, open;      // a normal server, and one started with ALLOW_HIDDEN_MAPS=1
before(async () => { [plain, open] = await Promise.all([startServer(), startServer({ ALLOW_HIDDEN_MAPS: '1' })]); });
after(() => Promise.all([plain && plain.stop(), open && open.stop()]));

const quiet = room => { for (const t of ['pong', 'event', 'lapTime', 'kicked']) room.onMessage(t, () => {}); return room; };
const leaveAll = rooms => Promise.all(rooms.map(r => Promise.race([r.leave(true).catch(() => {}), sleep(500)])));
const join = async (srv, opts = {}) => quiet(await new Colyseus.Client(`ws://localhost:${srv.port}`).create('race', { name: 'A', ...opts }));

test('the host picks the map in the lobby; the guest cannot; unknown and hidden ids are refused', async () => {
  const A = await join(plain);
  const B = quiet(await new Colyseus.Client(`ws://localhost:${plain.port}`).joinById(A.roomId, { name: 'B' }));
  try {
    await sleep(200);
    assert.equal(A.state.map, 'neon', 'a new room is on «Ночной город»');
    for (const map of ['nope', '__proto__', 'toString', 'constructor', '_testhill', 7, null, ['neon']]) A.send('config', { map });
    await sleep(300);
    assert.equal(A.state.map, 'neon', 'unknown, prototype and hidden ids are ignored');
    const open1 = await join(open, { map: '_testhill' });
    await sleep(200);
    assert.equal(open1.state.map, '_testhill', 'a server with ALLOW_HIDDEN_MAPS=1 takes the test map');
    const B2 = quiet(await new Colyseus.Client(`ws://localhost:${open.port}`).joinById(open1.roomId, { name: 'B' }));
    await sleep(200);
    B2.send('config', { map: 'neon' }); await sleep(300);
    assert.equal(open1.state.map, '_testhill', 'the guest cannot change it');
    open1.send('config', { map: 'neon' }); await sleep(300);
    assert.equal(B2.state.map, 'neon', 'the host can, and the guest sees it');
    const hidden = await join(plain, { map: '_testhill' }); await sleep(200);
    assert.equal(hidden.state.map, 'neon', 'a normal server does not open a room on a hidden map');
    await leaveAll([open1, B2, hidden]);
  } finally { await leaveAll([A, B]); }
});

test('a new map takes back every «Готово»; the same map, a refused one or other settings do not; a late joiner gets the map', async () => {
  const A = await join(plain);
  const cl = () => new Colyseus.Client(`ws://localhost:${plain.port}`);
  const B = quiet(await cl().joinById(A.roomId, { name: 'B' })), C = quiet(await cl().joinById(A.roomId, { name: 'C' }));
  const ready = () => [...A.state.players.values()].filter(p => p.ready).length;
  try {
    await sleep(200);
    B.send('ready', { value: true }); C.send('ready', { value: true }); await sleep(200);
    assert.equal(ready(), 2, 'both guests are ready');
    A.send('config', { map: 'neon' }); A.send('config', { map: 'nope' }); A.send('config', { laps: 4 }); await sleep(250);
    assert.equal(ready(), 2, 'the same map, an unknown one and the laps keep «Готово»');
    B.send('config', { map: 'serpantin' }); await sleep(250);
    assert.equal(ready(), 2, 'a guest cannot change the map (nor reset anything)');
    A.send('config', { map: 'serpantin' }); await sleep(250);
    assert.equal(A.state.map, 'serpantin');
    assert.equal(ready(), 0, 'a new map: nobody is ready any more');
    assert.equal(B.state.map, 'serpantin', 'the guests see the new map');
    const D = quiet(await cl().joinById(A.roomId, { name: 'D' })); await sleep(200);
    assert.equal(D.state.map, 'serpantin', 'a player who comes later gets the room\'s map');
    await leaveAll([D]);
  } finally { await leaveAll([A, B, C]); }
});

test('the shortest lap the server believes follows the map', { timeout: 40000 }, async () => {
  assert.ok(minLapMs('_testhill') < 12500 && minLapMs('neon') > 12500, `${minLapMs('_testhill')} / ${minLapMs('neon')} ms`);
  assert.equal(minLapMs('__proto__'), 5000);
  const rooms = await Promise.all([join(open, { map: '_testhill' }), join(open, { map: 'neon' })]);
  try {
    await sleep(200);
    for (const r of rooms) r.send('start');
    await sleep(300);
    const startAt = rooms[0].state.startAt;
    assert.ok(startAt > 0 && rooms.every(r => r.state.phase === 'countdown'));
    // 12.5 s after the green light: a lap on the 924 m test map (the bot needs ~19 s), but
    // impossible on «Ночной город»'s 1433 m
    while (Date.now() < Math.max(rooms[0].state.startAt, rooms[1].state.startAt) + 12500) await sleep(100);
    for (const r of rooms) r.send('lap');
    await sleep(500);
    const lap = r => r.state.players.get(r.sessionId).lap;
    assert.equal(lap(rooms[0]), 1, 'the test map counts the lap');
    assert.equal(lap(rooms[1]), 0, '«Ночной город» does not');
  } finally { await leaveAll(rooms); }
});

test('maps/meta.js ids cover the maps', () => {
  assert.ok(MAP_META.neon && !MAP_META.neon.hidden && MAP_META._testhill.hidden);
});
