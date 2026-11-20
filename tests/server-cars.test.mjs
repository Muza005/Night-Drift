// Car and paint picks on the real server: a player brings their pick when joining and can
// change it between runs; players may share a colour. Starts
// server/src/index.js on its own port (needs `npm install` in server/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as Colyseus from 'colyseus.js';
import { startServer } from './server-start.mjs';
import { PAINTS, CARS, FACTORY } from '../public/js/core/cars.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let PORT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const paint = name => PAINTS.find(p => p.name === name).hex;
const RED = paint('Красный'), BLUE = paint('Синий'), YELLOW = paint('Жёлтый');
let server;

before(async () => {
  server = await startServer({});
  PORT = server.port;
});
after(() => server && server.stop());

test('car and paint picks: kept, changeable in the lobby, colours may be shared', { timeout: 30000 }, async () => {
  const quiet = room => { for (const t of ['pong', 'event', 'lapTime']) room.onMessage(t, () => {}); return room; };
  const c = () => new Colyseus.Client(`ws://localhost:${PORT}`);
  const A = quiet(await c().create('race', { name: 'A', car: 'gtr', paint: RED }));
  const B = quiet(await c().joinById(A.roomId, { name: 'B', car: 'muscle', paint: RED }));     // the same red: fine
  const C = quiet(await c().joinById(A.roomId, { name: 'C', car: 'tank', paint: 123 }));       // unknown: defaults
  const D = quiet(await c().joinById(A.roomId, { name: 'D', paint: FACTORY }));                // "Заводской"
  try {
    await sleep(300);
    const P = id => A.state.players.get(id);
    assert.equal(P(A.sessionId).car, 'gtr');
    assert.equal(P(A.sessionId).color, RED, 'the player gets the colour they asked for');
    assert.equal(P(B.sessionId).car, 'muscle');
    assert.equal(P(B.sessionId).color, RED, 'two players may have the same colour');
    assert.equal(P(C.sessionId).car, CARS[0].id, 'an unknown car is the first car');
    assert.equal(P(C.sessionId).color, FACTORY, 'an unknown paint is the car\'s own colour');
    assert.equal(P(D.sessionId).color, FACTORY, '"Заводской" travels as -1');

    // in the lobby: any paint, any car
    B.send('pick', { car: 'super', paint: BLUE }); await sleep(200);
    assert.equal(P(B.sessionId).car, 'super');
    assert.equal(P(B.sessionId).color, BLUE);
    C.send('pick', { car: 'coupe', paint: BLUE }); await sleep(200);
    assert.equal(P(C.sessionId).color, BLUE, 'a colour another player has is fine');
    A.send('pick', { paint: YELLOW }); await sleep(200);
    assert.equal(P(A.sessionId).color, YELLOW, 'paint alone');
    assert.equal(P(A.sessionId).car, 'gtr', 'and the car stays');
    A.send('pick', { paint: 0xff3b6b }); await sleep(200);
    assert.equal(P(A.sessionId).color, YELLOW, 'a colour not in the palette is refused');
    A.send('pick', { car: 'tank' }); await sleep(200);
    assert.equal(P(A.sessionId).car, 'gtr', 'an unknown car is refused');

    // not during a race
    for (const r of [B, C, D]) r.send('ready', { value: true });
    await sleep(200);
    A.send('start'); await sleep(300);
    assert.equal(A.state.phase, 'countdown');
    B.send('pick', { car: 'rally' }); await sleep(200);
    assert.equal(P(B.sessionId).car, 'super', 'no switching cars once the countdown has started');
  } finally {
    await Promise.all([A, B, C, D].map(r => r.leave(true).catch(() => {})));
  }
});
