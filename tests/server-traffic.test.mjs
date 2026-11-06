// Online traffic on the real server: two players in one room get the same traffic,
// hits on bots and crashes are checked and passed on, the run ends on time and is
// ranked by score. Starts server/src/index.js on its own port (needs `npm install` in
// server/).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as Colyseus from 'colyseus.js';
import { decodeSnapshot } from '../public/js/modes/traffic/netcodec.js';
import { startPose } from '../public/js/modes/traffic/geometry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 2591, RUN_S = 20;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let server;

before(async () => {
  server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT), EXTRA_DURATION: String(RUN_S) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return; } catch {} await sleep(200); }
  throw new Error('server did not start');
});
after(() => new Promise(r => { server.once('exit', r); server.kill(); }));

function player(room, slot) {
  // report a car standing on its start spot, then wherever the test puts it
  const me = { x: startPose(slot).x, z: startPose(slot).z, vz: 0 };
  const send = () => room.send('state', { x: me.x, z: me.z, h: 0, vx: 0, vz: me.vz, vf: me.vz, steer: 0, slide: 0, prog: 0, score: me.score || 0, misses: me.misses || 0, t: Date.now() });
  // the car moves at me.vz like a real one (the server refuses teleports)
  const timer = setInterval(() => { me.z += me.vz * 0.033; send(); }, 33);
  const snaps = [];
  room.onMessage('tr', m => snaps.push(m));
  room.onMessage('bump', m => (me.bumps = (me.bumps || 0) + 1));
  for (const t of ['pong', 'event', 'lapTime']) room.onMessage(t, () => {});
  return { me, snaps, stop: () => clearInterval(timer) };
}

test('online traffic: same bots for everyone, hits, crashes, timed run ranked by score', { timeout: 90000 }, async () => {
  const cA = new Colyseus.Client(`ws://localhost:${PORT}`), cB = new Colyseus.Client(`ws://localhost:${PORT}`);
  const A = await cA.create('race', { name: 'A', mode: 'traffic' });
  const B = await cB.joinById(A.roomId, { name: 'B' });
  const pa = player(A, 0), pb = player(B, 1);
  let resultsAt = 0;
  A.state.listen('phase', ph => { if (ph === 'results') resultsAt = Date.now(); });
  try {
  await sleep(300);
  assert.equal(A.state.mode, 'traffic', 'the room takes the mode from the creator');

  // only the host may change the run length
  B.send('config', { duration: 300 }); await sleep(200);
  assert.equal(A.state.duration, 180);
  A.send('config', { duration: RUN_S }); await sleep(200);
  assert.equal(A.state.duration, RUN_S);

  A.send('start');
  await sleep(1500);
  assert.equal(A.state.phase, 'countdown');
  assert.ok(A.state.seed > 0);

  // 1. both players receive exactly the same snapshots
  await sleep(1000);
  const common = pa.snaps.filter(s => pb.snaps.some(o => o[0] === s[0]));
  assert.ok(common.length >= 5, `only ${common.length} snapshots in common`);
  for (const s of common) assert.deepEqual(s, pb.snaps.find(o => o[0] === s[0]), 'A and B got different traffic');
  const rate = pa.snaps.length / ((pa.snaps.at(-1)[0] - pa.snaps[0][0]) / 1000);
  assert.ok(rate > 7 && rate < 13, `${rate.toFixed(1)} snapshots a second`);
  const first = decodeSnapshot(pa.snaps[0]);
  assert.ok(first.bots.length > 4 && first.bots.every(b => b.z >= 200), 'traffic starts beyond the clear zone');
  const bytes = JSON.stringify(pa.snaps.at(-1)).length;
  assert.ok(bytes < 2000, `a snapshot is ${bytes} characters`);

  // wait for the green light
  while (A.state.phase !== 'race') await sleep(100);

  // 2. a hit far from the bot is refused; a hit next to it slows it down for everyone
  let snap = decodeSnapshot(pa.snaps.at(-1));
  const bot = snap.bots.sort((a, b) => a.z - b.z)[0];
  A.send('hitBot', { id: bot.id, dv: -5, dx: 0.5 }); await sleep(400);
  assert.equal(decodeSnapshot(pb.snaps.at(-1)).bots.find(b => b.id === bot.id).hazard, 0, 'a hit from 200 m away must be refused');
  // drive up behind it at 216 km/h, then sit 5 m behind it at its speed
  let near = null;
  pa.me.vz = 60;
  for (let i = 0; i < 100; i++) {
    near = decodeSnapshot(pa.snaps.at(-1)).bots.find(b => b.id === bot.id);
    if (near.z - pa.me.z < 12) break;
    await sleep(100);
  }
  pa.me.x = [6, 2, -2, -6][near.lane]; pa.me.vz = near.v;
  await sleep(200);
  A.send('hitBot', { id: bot.id, dv: -5, dx: 0.5 }); await sleep(400);
  const after = decodeSnapshot(pb.snaps.at(-1)).bots.find(b => b.id === bot.id);
  assert.ok(after.hazard > 0, 'player B must see the hazard lights of the bot A hit');
  assert.ok(after.v < near.v - 3, `bot should have slowed (from ${near.v} to ${after.v})`);

  // 3. a crash: blinking for 3 s, ghosted for 4.5 s, counted; no bumps while ghosted
  A.send('wreck'); await sleep(300);
  const meA = A.state.players.get(A.sessionId);
  assert.ok(meA.wreckUntil > Date.now() + 2000 && meA.ghostUntil > meA.wreckUntil, 'crash times not set');
  assert.equal(meA.wrecks, 1);
  A.send('wreck'); await sleep(200);
  assert.equal(A.state.players.get(A.sessionId).wrecks, 1, 'a second crash while ghosted must not count');
  pb.me.x = pa.me.x; pb.me.z = pa.me.z + 1; await sleep(150);
  A.send('bump', { to: B.sessionId, jx: 3, jz: 0, w: 0, dx: 0, dz: 0 }); await sleep(300);
  assert.equal(pb.me.bumps || 0, 0, 'a ghosted car must not push anyone');

  // 4. scores: impossible jumps are capped; the run ends on time, ranked by score
  pa.me.score = 5_000_000; await sleep(300);
  assert.ok(A.state.players.get(A.sessionId).score < 100000, 'a score cannot jump by millions');
  const capped = A.state.players.get(A.sessionId).score;
  pa.me.score = capped; pb.me.score = capped + 3000;      // B pulls ahead (honestly: within the rate limit)
  await sleep(1000);
  while (A.state.phase === 'race') await sleep(200);
  assert.equal(A.state.phase, 'results');
  const elapsed = (resultsAt - A.state.startAt) / 1000;
  assert.ok(Math.abs(elapsed - RUN_S) < 1.5, `the run lasted ${elapsed.toFixed(1)} s`);
  assert.equal(A.state.players.get(B.sessionId).place, 1);
  assert.equal(A.state.players.get(A.sessionId).place, 2);
  const n = pa.snaps.length; await sleep(500);
  assert.equal(pa.snaps.length, n, 'no traffic after the run');

  } finally { pa.stop(); pb.stop(); await A.leave(); await B.leave(); }
});

test('a track room still works the old way: laps, no traffic', { timeout: 30000 }, async () => {
  const c = new Colyseus.Client(`ws://localhost:${PORT}`);
  const R = await c.create('race', { name: 'T' });
  const p = player(R, 0);
  try {
  await sleep(200);
  assert.equal(R.state.mode, 'track');
  R.send('start'); await sleep(1500);
  assert.equal(R.state.endAt, 0);
  assert.equal(p.snaps.length, 0, 'no traffic in a track room');
  } finally { p.stop(); await R.leave(); }
});
