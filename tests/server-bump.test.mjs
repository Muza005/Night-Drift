// Car-to-car hits on the real server (stage 8): the server passes a hit on only within
// what a hit between those two cars can give (net/bump.js), between cars whose hitboxes can
// touch (plan 3 stage 4), and only so often; and a game of another version is turned away. Starts
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
  const quiet = room => { for (const t of ['pong', 'event', 'lapTime', 'st']) room.onMessage(t, () => {}); return room; };
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

// Stage 9: the speed a hit is checked with is the one the server saw the cars move at (their
// positions over the last ~0.15-0.7 s), not the speed they claim: a modified client claiming
// 70 m/s while standing still gets no bigger hit than a standing car.
test('bump: a claimed speed the car does not drive is not believed', { timeout: 40000 }, async () => {
  const quiet = room => { for (const t of ['pong', 'event', 'lapTime', 'st']) room.onMessage(t, () => {}); return room; };
  const c = () => new Colyseus.Client(`ws://localhost:${PORT}`);
  const A = quiet(await c().create('race', { name: 'A', car: 'muscle' }));
  const B = quiet(await c().joinById(A.roomId, { name: 'B', car: 'rx7' }));
  const got = [];
  B.onMessage('bump', m => got.push(m));
  // A claims 70 m/s but stays where it is; B stands still
  const me = { A: { x: 0, z: 0, vz: 70, move: 0 }, B: { x: 3, z: 0, vz: 0, move: 0 } };
  const send = (room, s) => room.send('state', { x: s.x, z: s.z, h: 0, vx: 0, vz: s.vz, vf: s.vz, steer: 0, slide: 0, prog: 0, score: 0, t: Date.now() });
  let attack = false;
  const timer = setInterval(() => { for (const k of ['A', 'B']) { if (k === 'A' && attack) continue; me[k].z += me[k].move * 0.033; send(k === 'A' ? A : B, me[k]); } }, 33);
  const mf = carMass('muscle'), mt = carMass('rx7'), share = v => (1 + BUMP.E) * Math.hypot(1, BUMP.MU) * v * mf / (mf + mt);
  try {
    await sleep(300);
    B.send('ready', { value: true }); await sleep(200);
    A.send('start');
    while (A.state.phase !== 'race') await sleep(100);
    await sleep(800);
    A.send('bump', { to: B.sessionId, jx: 0, jz: 40, w: 0, vy: 2, dx: 0, dz: 0, t: Date.now() });
    await sleep(300);
    assert.equal(got.length, 1, 'the hit reaches B');
    // seen standing: at most what 3 m/s of closing (+3 m/s of slack for A) gives
    assert.ok(Math.hypot(got[0].jx, got[0].jz) <= share(6) + 1e-9, `|j| ${Math.hypot(got[0].jx, got[0].jz).toFixed(2)} m/s from a car that does not move`);
    assert.equal(got[0].vy, 0, 'no hop from a claimed speed');
    // nor from hopping the reported position 20 m on and back (a reset is not driving): the
    // hop lands A beside B again, so the hit passes the body distance (stage 4) and is no bigger
    me.A.z = 20; await sleep(250); me.A.z = 0; await sleep(120); got.length = 0;
    A.send('bump', { to: B.sessionId, jx: 0, jz: 40, w: 0, vy: 2, dx: 0, dz: 0, t: Date.now() });
    await sleep(300);
    assert.equal(got.length, 1, 'the hit after the hop reaches B');
    assert.ok(Math.hypot(got[0].jx, got[0].jz) <= share(6) + 1e-9, `|j| ${Math.hypot(got[0].jx, got[0].jz).toFixed(2)} m/s after a hop`);
    // nor from many small hops: 60 states a second, 6 m back and forth each, claiming 80 m/s
    // (every step is faster than any car, so no window of the speed check spans one)
    attack = true; me.A.z = 0;
    for (let i = 0; i < 24; i++) { send(A, { x: 0, z: i % 2 ? 6 : 0, vz: 80 }); await sleep(16); }
    got.length = 0;
    A.send('bump', { to: B.sessionId, jx: 0, jz: 40, w: 0, vy: 2, dx: 0, dz: 0, t: Date.now() });
    await sleep(300);
    assert.equal(got.length, 1);
    assert.ok(Math.hypot(got[0].jx, got[0].jz) <= share(6) + 1e-9, `|j| ${Math.hypot(got[0].jx, got[0].jz).toFixed(2)} m/s after small hops`);
    attack = false;
    // now A really drives at 30 m/s (from 25 m behind B, so it is beside B when it hits): a
    // hit from 30 m/s of closing passes as it is
    me.A.z = -25; me.A.vz = 30; me.A.move = 30; await sleep(800); got.length = 0;
    A.send('bump', { to: B.sessionId, jx: 0, jz: 0.9 * share(30), w: 0, vy: 0, dx: 0, dz: 0, t: Date.now() });
    await sleep(300);
    assert.equal(got.length, 1);
    assert.ok(Math.abs(got[0].jz - 0.9 * share(30)) < 1e-6, `a real 30 m/s hit is kept (jz ${got[0].jz})`);
  } finally {
    clearInterval(timer);
    await Promise.all([A, B].map(r => r.leave(true).catch(() => {})));
  }
});

// Plan 3 stage 4: the server checks a hit against the cars' hitboxes: two cars whose bodies
// (at their last reported poses) are farther apart than their speeds can close get no hit.
test('bump: only between cars whose bodies can touch', { timeout: 40000 }, async () => {
  const quiet = room => { for (const t of ['pong', 'event', 'lapTime', 'st']) room.onMessage(t, () => {}); return room; };
  const c = () => new Colyseus.Client(`ws://localhost:${PORT}`);
  const A = quiet(await c().create('race', { name: 'A', car: 'coupe' }));
  const B = quiet(await c().joinById(A.roomId, { name: 'B', car: 'coupe' }));
  const got = [];
  B.onMessage('bump', m => got.push(m));
  // both stand; B 9 m beside A (the bodies 7.1 m apart: more than 3 m and no speed to close it)
  const me = { A: { x: 0, z: 0 }, B: { x: 9, z: 0 } };
  const send = (room, s) => room.send('state', { x: s.x, z: s.z, h: 0, vx: 0, vz: 0, vf: 0, steer: 0, slide: 0, prog: 0, score: 0, t: Date.now() });
  const timer = setInterval(() => { send(A, me.A); send(B, me.B); }, 33);
  try {
    await sleep(300);
    B.send('ready', { value: true }); await sleep(200);
    A.send('start');
    while (A.state.phase !== 'race') await sleep(100);
    await sleep(300);
    A.send('bump', { to: B.sessionId, jx: 1, jz: 0, w: 0, vy: 0, dx: 0, dz: 0, t: Date.now() });
    await sleep(300);
    assert.equal(got.length, 0, '7 m apart, standing: no hit');
    me.B.x = 4; await sleep(300);              // 2.1 m apart: within reach
    A.send('bump', { to: B.sessionId, jx: 1, jz: 0, w: 0, vy: 0, dx: 0, dz: 0, t: Date.now() });
    await sleep(300);
    assert.equal(got.length, 1, 'close by: the hit passes');
  } finally {
    clearInterval(timer);
    await Promise.all([A, B].map(r => r.leave(true).catch(() => {})));
  }
});

// Plan 3 stage 4: a game of another protocol version (net/protocol.js; a tab from before
// the update sends none) is turned away with the message to reload, and no room is made.
test('protocol: a game of another version cannot create or join a room', { timeout: 20000 }, async () => {
  const { PROTOCOL, UPDATED, UPDATED_CODE } = await import('../public/js/net/protocol.js');
  const c = () => new Colyseus.Client(`ws://localhost:${PORT}`);
  for (const proto of [undefined, PROTOCOL - 1, PROTOCOL + 1, 'x']) {
    await assert.rejects(c().create('race', { name: 'old', proto }), e => e.code === UPDATED_CODE && e.message === UPDATED, `create with ${proto}`);
  }
  assert.equal((await c().getAvailableRooms('race')).length, 0, 'the refused games made no room');
  const A = await c().create('race', { name: 'A' });
  try {
    await assert.rejects(c().joinById(A.roomId, { name: 'old', proto: undefined }), e => e.code === UPDATED_CODE && e.message === UPDATED, 'join without');
    const B = await c().joinById(A.roomId, { name: 'B' });
    await sleep(200);
    assert.equal(A.state.players.size, 2, 'the right version comes in, the old one did not');
    await B.leave(true).catch(() => {});
  } finally { await A.leave(true).catch(() => {}); }
});

// Stage 9: a car's state goes to the other players at once ('st'), never back to its sender,
// and no faster than ~60 a second per player (a flood is cut off).
test('state: passed on at once to the others, rate limited', { timeout: 40000 }, async () => {
  const { decodeState } = await import('../public/js/net/statecodec.js');
  const quiet = room => { for (const t of ['pong', 'event', 'lapTime', 'bump']) room.onMessage(t, () => {}); return room; };
  const c = () => new Colyseus.Client(`ws://localhost:${PORT}`);
  const A = quiet(await c().create('race', { name: 'A' }));
  const B = quiet(await c().joinById(A.roomId, { name: 'B' }));
  const got = { A: [], B: [] };
  A.onMessage('st', m => got.A.push(decodeState(m))); B.onMessage('st', m => got.B.push(decodeState(m)));
  try {
    B.send('ready', { value: true }); await sleep(200);
    A.send('start');
    while (A.state.phase === 'lobby') await sleep(50);
    const t = Date.now();
    A.send('state', { x: 1.234, z: -5.678, h: 0.5, y: 0.25, vy: 0, idx: 17, vx: 3.21, vz: -4.5, vf: 5, steer: -0.3, slide: 0.4, prog: 0, score: 0, t });
    await sleep(300);
    assert.equal(got.A.length, 0, 'not back to the sender');
    assert.equal(got.B.length, 1);
    const s = got.B[0];
    assert.equal(s.id, A.sessionId);
    assert.equal(s.t, t);
    for (const [k, v] of Object.entries({ x: 1.234, z: -5.678, h: 0.5, y: 0.25, vx: 3.21, vz: -4.5, vf: 5, steer: -0.3, slide: 0.4, idx: 17 }))
      assert.ok(Math.abs(s[k] - v) <= 0.006, `${k}: ${s[k]} for ${v}`);
    // junk is not passed on
    A.send('state', null); A.send('state', [1, 2, 3]); A.send('state', 'x');
    await sleep(300);
    assert.equal(got.B.length, 1, 'junk is not passed on');
    // a flood of 100 at once: about a burst's worth gets through
    await sleep(400); got.B.length = 0;
    for (let i = 0; i < 100; i++) A.send('state', { x: 1, z: i * 0.01, h: 0, vx: 0, vz: 0, vf: 0, steer: 0, slide: 0, prog: 0, score: 0, t: Date.now() + i * 0.001 });
    await sleep(400);
    assert.ok(got.B.length >= 5 && got.B.length <= 14, `${got.B.length} of 100 states sent at once passed on`);
  } finally {
    await Promise.all([A, B].map(r => r.leave(true).catch(() => {})));
  }
});
