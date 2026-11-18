// The lobby on the real server: everyone lists the room the same way, "Готово" and the
// host's start, kicking, a new host when the host leaves, the host's settings and names.
// Starts server/src/index.js on its own port (needs `npm install` in server/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as Colyseus from 'colyseus.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 2594;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server;

before(async () => {
  server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch {} await sleep(200); }
  throw new Error('server did not start');
});
after(() => new Promise(r => { server.once('exit', r); server.kill(); }));

const client = () => new Colyseus.Client(`ws://localhost:${PORT}`);
const quiet = room => { for (const t of ['pong', 'event', 'lapTime', 'kicked']) room.onMessage(t, () => {}); return room; };
// leaving a room that is already closed never settles: give each a moment, no more
const leaveAll = rooms => Promise.all(rooms.map(r => Promise.race([r.leave(true).catch(() => {}), sleep(500)])));
// The room's list as a player's screen shows it: the host first, then by order.
const listed = room => {
  const s = room.state;
  return [...s.players.entries()]
    .sort((a, b) => (b[0] === s.hostId) - (a[0] === s.hostId) || a[1].order - b[1].order)
    .map(([, p]) => p.name);
};

test('3.1 every player sees the room in the same order: the host first, then who came in first', { timeout: 20000 }, async () => {
  const A = quiet(await client().create('race', { name: 'Ann' }));
  const B = quiet(await client().joinById(A.roomId, { name: 'Bob' }));
  const C = quiet(await client().joinById(A.roomId, { name: 'Cid' }));
  try {
    await sleep(300);
    const orders = [...A.state.players.values()].map(p => p.order);
    assert.equal(new Set(orders).size, 3, 'every player has their own order');
    for (const r of [A, B, C]) assert.deepEqual(listed(r), ['Ann', 'Bob', 'Cid'], 'the same list on every screen');
  } finally { await leaveAll([A, B, C]); }
});

test('3.2–3.3 "Готово": only guests, only between runs; the host starts only when all are ready', { timeout: 20000 }, async () => {
  const A = quiet(await client().create('race', { name: 'A' }));
  const B = quiet(await client().joinById(A.roomId, { name: 'B' }));
  const C = quiet(await client().joinById(A.roomId, { name: 'C' }));
  try {
    await sleep(300);
    const P = r => A.state.players.get(r.sessionId);
    assert.equal(P(B).ready, false, 'nobody is ready on joining');

    A.send('ready', { value: true }); await sleep(150);
    assert.equal(P(A).ready, false, 'the host has no "Готово"');
    B.send('ready', { value: 'yes' }); await sleep(150);
    assert.equal(P(B).ready, false, 'only true or false');

    B.send('ready', { value: true }); await sleep(150);
    assert.equal(P(B).ready, true);
    A.send('start'); await sleep(200);
    assert.equal(A.state.phase, 'lobby', 'C is not ready: no start');
    B.send('start'); await sleep(200);
    assert.equal(A.state.phase, 'lobby', 'a guest cannot start');

    C.send('ready', { value: true }); await sleep(150);
    C.send('ready', { value: false }); await sleep(150);
    assert.equal(P(C).ready, false, 'pressed again: not ready');
    A.send('start'); await sleep(200);
    assert.equal(A.state.phase, 'lobby');

    C.send('ready', { value: true }); await sleep(150);
    A.send('start'); await sleep(200);
    assert.equal(A.state.phase, 'countdown', 'everyone ready: the race starts');
    assert.ok([...A.state.players.values()].every(p => !p.ready), 'back in the lobby everyone presses "Готово" again');
    B.send('ready', { value: true }); await sleep(150);
    assert.equal(P(B).ready, false, 'no "Готово" during a race');
  } finally { await leaveAll([A, B, C]); }

  // a host alone starts at once
  const S = quiet(await client().create('race', { name: 'Solo' }));
  try { await sleep(200); S.send('start'); await sleep(200); assert.equal(S.state.phase, 'countdown'); }
  finally { await leaveAll([S]); }
});

test('3.4 kick: host only, not themselves; the kicked player is told and can never come back', { timeout: 25000 }, async () => {
  const A = quiet(await client().create('race', { name: 'Host', pid: 'pid-host' }));
  const B = quiet(await client().joinById(A.roomId, { name: 'Best', pid: 'pid-best' }));
  const C = quiet(await client().joinById(A.roomId, { name: 'Cat', pid: 'pid-cat' }));
  let told = false, closed = 0;
  B.onMessage('kicked', () => { told = true; });
  B.onLeave(code => { closed = code; });
  try {
    await sleep(300);
    C.send('kick', { id: B.sessionId }); await sleep(200);
    assert.ok(A.state.players.has(B.sessionId), 'a guest cannot kick');
    A.send('kick', { id: A.sessionId }); await sleep(200);
    assert.ok(A.state.players.has(A.sessionId), 'the host cannot kick themselves');
    A.send('kick', { id: 'nobody' }); await sleep(200);
    assert.equal(A.state.players.size, 3, 'an unknown id changes nothing');

    A.send('kick', { id: B.sessionId }); await sleep(400);
    assert.ok(told, 'the kicked player gets "kicked"');
    assert.equal(closed, 4001, 'and is disconnected');
    assert.ok(!A.state.players.has(B.sessionId), 'and is gone from the room at once');
    assert.ok(!C.state.players.has(B.sessionId), 'for everyone');

    await assert.rejects(client().reconnect(B.reconnectionToken), 'no reconnecting on the old connection');
    await assert.rejects(client().joinById(A.roomId, { name: 'Best again', pid: 'pid-best' }), 'no coming back as the same player');
    const D = quiet(await client().joinById(A.roomId, { name: 'Dan', pid: 'pid-dan' }));
    assert.ok(D.sessionId, 'other players can still join');
    await leaveAll([D]);

    // a player whose connection dropped keeps their seat for 20 s: a kick takes that too
    const E = quiet(await client().joinById(A.roomId, { name: 'Eve', pid: 'pid-eve' }));
    await sleep(200);
    const eToken = E.reconnectionToken, eId = E.sessionId;
    await Promise.race([E.leave(false).catch(() => {}), sleep(500)]);   // not consented: a lost connection
    await sleep(300);
    assert.equal(A.state.players.get(eId)?.connected, false, 'Eve is reconnecting');
    A.send('kick', { id: eId }); await sleep(300);
    assert.ok(!A.state.players.has(eId), 'kicked while reconnecting');
    await assert.rejects(client().reconnect(eToken), 'and the kept seat is gone');

    // a renamed name can't hide control or direction-flipping characters
    C.send('name', { name: 'Ho\u202Est\u200B' }); await sleep(200);
    assert.equal(A.state.players.get(C.sessionId).name, 'Host', 'invisible characters are dropped');

    // not during a race
    C.send('ready', { value: true }); await sleep(150);
    A.send('start'); await sleep(200);
    A.send('kick', { id: C.sessionId }); await sleep(200);
    assert.ok(A.state.players.has(C.sessionId), 'no kicking during a race');
  } finally { await leaveAll([A, B, C]); }
});

test('3.5 the host leaves: the next player by order is the host', { timeout: 20000 }, async () => {
  const A = quiet(await client().create('race', { name: 'A' }));
  const B = quiet(await client().joinById(A.roomId, { name: 'B' }));
  const C = quiet(await client().joinById(A.roomId, { name: 'C' }));
  try {
    await sleep(300);
    B.send('ready', { value: true }); await sleep(150);
    await A.leave(true); await sleep(300);
    assert.equal(C.state.hostId, B.sessionId, 'B came in before C: B is the host');
    assert.equal(C.state.players.get(B.sessionId).ready, false, 'a host is never "ready"');
    assert.deepEqual(listed(C), ['B', 'C']);
    await B.leave(true); await sleep(300);
    assert.equal(C.state.hostId, C.sessionId, 'and then C');
  } finally { await leaveAll([A, B, C]); }
});

test('3.6 settings: host only, between runs, values out of range ignored', { timeout: 20000 }, async () => {
  const A = quiet(await client().create('race', { name: 'A', mode: 'traffic' }));
  const B = quiet(await client().joinById(A.roomId, { name: 'B' }));
  try {
    await sleep(300);
    const s = A.state;
    assert.equal(s.mode, 'traffic', 'the mode comes from the card the room was made from');
    assert.equal(s.laps, 3); assert.equal(s.duration, 180); assert.equal(s.density, 'mid');

    B.send('config', { laps: 5, duration: 300, density: 'high', mode: 'track' }); await sleep(200);
    assert.deepEqual([s.laps, s.duration, s.density, s.mode], [3, 180, 'mid', 'traffic'], 'a guest changes nothing');

    for (const laps of [0, 11, 2.5, '4', -1, null]) A.send('config', { laps });
    for (const duration of [0, 30, 90, 660, 6000, '120', 120.5]) A.send('config', { duration });
    A.send('config', { density: 'extreme' });
    A.send('config', 'laps');
    A.send('config', [1, 2]);
    await sleep(300);
    assert.deepEqual([s.laps, s.duration, s.density], [3, 180, 'mid'], 'nothing out of range gets in');

    A.send('config', { laps: 1 }); await sleep(150); assert.equal(s.laps, 1);
    A.send('config', { laps: 10 }); await sleep(150); assert.equal(s.laps, 10);
    A.send('config', { duration: 60 }); await sleep(150); assert.equal(s.duration, 60);
    A.send('config', { duration: 600 }); await sleep(150); assert.equal(s.duration, 600);
    A.send('config', { density: 'low', laps: 99 }); await sleep(150);
    assert.deepEqual([s.density, s.laps], ['low', 10], 'one bad value does not spoil the rest');
    A.send('config', { mode: 'track' }); await sleep(150);
    assert.equal(B.state.mode, 'track', 'the host can change the mode, everyone sees it');

    B.send('ready', { value: true }); await sleep(150);
    A.send('start'); await sleep(200);
    A.send('config', { laps: 4 }); await sleep(150);
    assert.equal(s.laps, 10, 'no changes once the countdown has started');
  } finally { await leaveAll([A, B]); }
});

test('3.8 names: anyone renames themselves between runs, cleaned like on joining', { timeout: 20000 }, async () => {
  const A = quiet(await client().create('race', { name: 'A' }));
  const B = quiet(await client().joinById(A.roomId, { name: 'B' }));
  try {
    await sleep(300);
    const P = r => A.state.players.get(r.sessionId);
    B.send('name', { name: '  Бест <script>  ' }); await sleep(200);
    assert.equal(P(B).name, 'Бест script', 'no angle brackets, trimmed');
    await sleep(500);
    B.send('name', { name: 'Очень-очень-длинное-имя' }); await sleep(200);
    assert.equal(P(B).name.length, 16, 'at most 16 characters');
    await sleep(500);
    B.send('name', { name: '   ' }); await sleep(200);
    assert.equal(P(B).name, 'Гонщик', 'an empty name is "Гонщик"');
    await sleep(500);
    B.send('name', { name: 42 }); await sleep(200);
    assert.equal(P(B).name, 'Гонщик', 'only text');
    assert.equal(P(A).name, 'A', 'one player renames only themselves');
  } finally { await leaveAll([A, B]); }
});
