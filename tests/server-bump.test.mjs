// Car-to-car hits on the real server (stage 8): the server passes a hit on only within
// what a hit between those two cars can give (net/bump.js), and only so often. Starts
// server/src/index.js on its own port (needs `npm install` in server/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as Colyseus from 'colyseus.js';
import { startServer } from './server-start.mjs';
import { BUMP, carMass } from '../public/js/net/bump.js';

let PORT, server;
const sleep = ms => new Promise(r => setTimeout(r, ms));
before(async () => { server = await startServer({}); PORT = server.port; });
after(() => server && server.stop());

test('bump: clamped to a plausible hit, rate limited, never to yourself', { timeout: 40000 }, async () => {
  const quiet = room => { for (const t of ['pong', 'event', 'lapTime']) room.onMessage(t, () => {}); return room; };
  const c = () => new Colyseus.Client(`ws://localhost:${PORT}`);
  const A = quiet(await c().create('race', { name: 'A', car: 'muscle' }));
  const B = quiet(await c().joinById(A.roomId, { name: 'B', car: 'rx7' }));
  const got = { A: [], B: [] };
  A.onMessage('bump', m => got.A.push(m)); B.onMessage('bump', m => got.B.push(m));
  // both cars report standing (or rolling) side by side
  const me = { A: { x: 0, z: 0, vz: 0 }, B: { x: 3, z: 0, vz: 0 } };
  const send = (room, s) => room.send('state', { x: s.x, z: s.z, h: 0, vx: 0, vz: s.vz, vf: s.vz, steer: 0, slide: 0, prog: 0, score: 0, t: Date.now() });
  const timer = setInterval(() => { for (const k of ['A', 'B']) { me[k].z += me[k].vz * 0.033; send(k === 'A' ? A : B, me[k]); } }, 33);
  try {
    await sleep(300);
    B.send('ready', { value: true }); await sleep(200);
    A.send('start');
    while (A.state.phase !== 'race') await sleep(100);
    await sleep(200);

    // both standing still: a "hit" can give at most what 3 m/s of closing gives
    A.send('bump', { to: B.sessionId, jx: 1000, jz: -1000, w: 99, vy: 50, dx: 5, dz: -5, t: 'soon' });
    await sleep(300);
    assert.equal(got.B.length, 1, 'the hit reaches B');
    const m = got.B[0], mf = carMass('muscle'), mt = carMass('rx7');
    const most = (1 + BUMP.E) * Math.hypot(1, BUMP.MU) * 3 * mf / (mf + mt);
    assert.ok(Math.hypot(m.jx, m.jz) <= most + 1e-9, `|j| ${Math.hypot(m.jx, m.jz).toFixed(2)} m/s > ${most.toFixed(2)}`);
    assert.ok(Math.abs(m.w) <= BUMP.SPIN && m.vy === 0, `standing cars: no hop (vy ${m.vy})`);

    // spin and hop with no velocity change: a modified client trying to toss a standing car
    await sleep(400); got.B.length = 0;
    A.send('bump', { to: B.sessionId, jx: 0, jz: 0, w: 2, vy: 2, dx: 0, dz: 0, t: Date.now() });
    await sleep(300);
    assert.equal(got.B.length, 1);
    assert.equal(got.B[0].vy, 0, 'no hop without a hit');
    assert.ok(Math.abs(got.B[0].w) <= 0.1 + 1e-9, `spin ${got.B[0].w} without a hit`);
    assert.ok(Math.hypot(m.dx, m.dz) <= BUMP.PUSH + 1e-9, 'push within PUSH');
    assert.ok(Math.abs(m.t - Date.now()) < 1500, 'a bad time stamp becomes the server time');
    assert.equal(m.from, A.sessionId);

    // rolling at 30 m/s: a real hit's share passes on as it is
    me.A.vz = me.B.vz = 30; await sleep(500);
    got.B.length = 0;
    // (a hop comes from 80 km/h of closing: B's share is then at least ~14 m/s)
    A.send('bump', { to: B.sessionId, jx: 8, jz: 12, w: 1.2, vy: 1.1, dx: 0.1, dz: 0, t: Date.now() - 20 });
    await sleep(300);
    assert.equal(got.B.length, 1);
    assert.deepEqual([got.B[0].jx, got.B[0].jz, got.B[0].w, got.B[0].vy, got.B[0].dx], [8, 12, 1.2, 1.1, 0.1], 'a plausible hit is not changed');
    // a light touch at speed: passed on, but without a hop
    await sleep(400); got.B.length = 0;
    A.send('bump', { to: B.sessionId, jx: 2, jz: 1, w: 0.5, vy: 1.1, dx: 0, dz: 0, t: Date.now() });
    await sleep(300);
    assert.equal(got.B.length, 1);
    assert.equal(got.B[0].vy, 0, 'a light touch does not lift');

    // a flood: a burst of 3, then about one per 100 ms
    await sleep(400); got.B.length = 0;
    for (let i = 0; i < 20; i++) A.send('bump', { to: B.sessionId, jx: 1, jz: 0, w: 0, dx: 0, dz: 0, t: Date.now() });
    await sleep(300);
    assert.ok(got.B.length <= 4, `${got.B.length} of 20 hits sent at once got through`);
    assert.ok(got.B.length >= 1);

    // never to yourself, nor to nobody
    got.A.length = 0; await sleep(400);
    A.send('bump', { to: A.sessionId, jx: 3, jz: 0 }); A.send('bump', { to: 42, jx: 3 }); A.send('bump', null);
    await sleep(300);
    assert.equal(got.A.length, 0, 'a player cannot bump themselves');
  } finally {
    clearInterval(timer);
    await Promise.all([A, B].map(r => r.leave(true).catch(() => {})));
  }
});
