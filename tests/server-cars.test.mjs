// Car and paint picks on the real server: a player brings their pick when joining, can
// change it between runs, and two players never have the same colour. Starts
// server/src/index.js on its own port (needs `npm install` in server/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as Colyseus from 'colyseus.js';
import { PAINTS } from '../public/js/core/cars.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 2593;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const [ROSE, CYAN, , , , , WHITE, , , RED] = PAINTS.map(p => p.hex);
let server;

before(async () => {
  server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch {} await sleep(200); }
  throw new Error('server did not start');
});
after(() => new Promise(r => { server.once('exit', r); server.kill(); }));

test('car and paint picks: kept, changeable in the lobby, colours never shared', { timeout: 30000 }, async () => {
  const quiet = room => { for (const t of ['pong', 'event', 'lapTime']) room.onMessage(t, () => {}); return room; };
  const c = () => new Colyseus.Client(`ws://localhost:${PORT}`);
  const A = quiet(await c().create('race', { name: 'A', car: 'gtr', paint: RED }));
  const B = quiet(await c().joinById(A.roomId, { name: 'B', car: 'muscle', paint: RED }));   // red is taken
  const C = quiet(await c().joinById(A.roomId, { name: 'C', car: 'tank', paint: 123 }));     // unknown: defaults
  try {
    await sleep(300);
    const P = id => A.state.players.get(id);
    assert.equal(P(A.sessionId).car, 'gtr');
    assert.equal(P(A.sessionId).color, RED, 'the first player gets the colour they asked for');
    assert.equal(P(B.sessionId).car, 'muscle');
    assert.equal(P(B.sessionId).color, CYAN, 'a taken colour gives way to the seat colour');
    assert.equal(P(C.sessionId).car, 'coupe', 'an unknown car is the coupe');
    assert.ok(PAINTS.some(p => p.hex === P(C.sessionId).color), 'an unknown paint is a real paint');

    // in the lobby: a free colour is fine, a taken one is refused, a car can change
    B.send('pick', { car: 'super', paint: WHITE }); await sleep(200);
    assert.equal(P(B.sessionId).car, 'super');
    assert.equal(P(B.sessionId).color, WHITE);
    C.send('pick', { car: 'coupe', paint: WHITE }); await sleep(200);
    assert.notEqual(P(C.sessionId).color, WHITE, 'cannot take a colour another player has');
    A.send('pick', { paint: ROSE }); await sleep(200);
    assert.equal(P(A.sessionId).color, ROSE, 'paint alone');
    assert.equal(P(A.sessionId).car, 'gtr', 'and the car stays');

    const colours = [...A.state.players.values()].map(p => p.color);
    assert.equal(new Set(colours).size, colours.length, 'everyone has their own colour');

    // not during a race
    A.send('start'); await sleep(300);
    B.send('pick', { car: 'rally' }); await sleep(200);
    assert.equal(P(B.sessionId).car, 'super', 'no switching cars once the countdown has started');
  } finally {
    await Promise.all([A, B, C].map(r => r.leave(true).catch(() => {})));
  }
});
