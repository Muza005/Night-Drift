// Ghost mode («Призраки», plan 3 stage 4b) on the real server: one setting for the whole
// room, in its state; only the host changes it, only between runs, true or false only, and a
// change takes back everyone's «Готово». While it is on, no hit between players is passed on
// (whatever a game sends); while it is off, hits pass as before. Starts server/src/index.js
// on its own port (needs `npm install` in server/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Colyseus from 'colyseus.js';
import { startServer } from './server-start.mjs';

let PORT, server;
const sleep = ms => new Promise(r => setTimeout(r, ms));
before(async () => { server = await startServer({}); PORT = server.port; });
after(() => server && server.stop());
const quiet = room => { for (const t of ['pong', 'event', 'lapTime', 'st', 'bump']) room.onMessage(t, () => {}); return room; };
const c = () => new Colyseus.Client(`ws://localhost:${PORT}`);
const until = async (f, ms = 2000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await sleep(30); return f(); };

test('ghost mode: off by default, host only, booleans only, takes back «Готово»', { timeout: 30000 }, async () => {
  const A = quiet(await c().create('race', { name: 'A' }));
  const B = quiet(await c().joinById(A.roomId, { name: 'B' }));
  try {
    await sleep(200);
    assert.equal(B.state.ghostMode, false, 'off by default');
    // a guest can't change it
    B.send('config', { ghostMode: true }); await sleep(300);
    assert.equal(A.state.ghostMode, false, 'a guest cannot turn it on');
    // only a real boolean counts
    for (const v of [1, 'true', 'on', null, {}]) A.send('config', { ghostMode: v });
    await sleep(300);
    assert.equal(A.state.ghostMode, false, 'not a boolean: ignored');
    // the host turns it on: everyone sees it, B's «Готово» is taken back
    B.send('ready', { value: true });
    assert.ok(await until(() => A.state.players.get(B.sessionId).ready), 'B ready');
    A.send('config', { ghostMode: true });
    assert.ok(await until(() => B.state.ghostMode === true), 'the guest sees it on');
    assert.ok(await until(() => !A.state.players.get(B.sessionId).ready), 'a change takes back «Готово»');
    // sending the same value again is not a change
    B.send('ready', { value: true });
    assert.ok(await until(() => A.state.players.get(B.sessionId).ready));
    A.send('config', { ghostMode: true, laps: 4 }); await sleep(300);
    assert.equal(A.state.players.get(B.sessionId).ready, true, 'the same value: «Готово» stays');
    assert.equal(A.state.laps, 4, 'the rest of the message still counts');
    // not during a run
    A.send('start');
    assert.ok(await until(() => A.state.phase === 'countdown' || A.state.phase === 'race'));
    A.send('config', { ghostMode: false }); await sleep(300);
    assert.equal(A.state.ghostMode, true, 'cannot be changed once the run started');
  } finally {
    await Promise.all([A, B].map(r => r.leave(true).catch(() => {})));
  }
});

// Two cars side by side in a race; A sends B a plausible hit. With ghost mode on the server
// drops it; turned off for the next run, the same hit reaches B.
async function race(ghostMode) {
  const A = quiet(await c().create('race', { name: 'A', car: 'muscle' }));
  const B = quiet(await c().joinById(A.roomId, { name: 'B', car: 'rx7' }));
  const got = [];
  B.onMessage('bump', m => got.push(m));
  const me = { A: { x: 0, z: 0 }, B: { x: 3, z: 0 } };
  const send = (room, s) => room.send('state', { x: s.x, z: s.z, h: 0, vx: 0, vz: 0, vf: 0, steer: 0, slide: 0, prog: 0, score: 0, t: Date.now() });
  const timer = setInterval(() => { send(A, me.A); send(B, me.B); }, 33);
  try {
    await sleep(300);
    A.send('config', { ghostMode });
    assert.ok(await until(() => B.state.ghostMode === ghostMode));
    B.send('ready', { value: true }); await sleep(200);
    A.send('start');
    assert.ok(await until(() => A.state.phase === 'race', 8000), 'the race starts');
    await sleep(300);
    for (let i = 0; i < 3; i++) { A.send('bump', { to: B.sessionId, jx: 1, jz: 0, w: 0, vy: 0, dx: 0, dz: 0, t: Date.now() }); await sleep(150); }
    await sleep(300);
    return got.length;
  } finally {
    clearInterval(timer);
    await Promise.all([A, B].map(r => r.leave(true).catch(() => {})));
  }
}

test('ghost mode on: no hit between players is passed on', { timeout: 30000 }, async () => {
  assert.equal(await race(true), 0, 'a hit got through in ghost mode');
});

test('ghost mode off: hits pass as before', { timeout: 30000 }, async () => {
  assert.ok(await race(false) >= 1, 'the hit did not reach B with ghost mode off');
});
