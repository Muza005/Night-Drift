// Multiplayer sync check: run after every change that touches the online game.
//
//   npm run test:sync                 (needs Google Chrome and `npm install` in server/)
//   npm run test:sync -- --runs 3     (repeat to see the spread)
//   npm run test:sync -- --url http://localhost:8001/index.html   (test another build)
//   npm run test:sync -- --mode traffic   (the highway: also checks that both players
//                                           see the server's bots in the same places)
//   npm run test:sync -- --headed         (two real windows on the GPU instead of software
//                                           rendering at a few frames a second)
//   ND_PORT=4110 npm run test:sync        (the server on 4110, the proxy on 4111)
//   npm run test:sync -- --ghost          (ghost mode, plan 3 stage 4b: the host turns
//                                           «Призраки» on in the lobby; A drives through B
//                                           and must not push it, feel a hit or see B jump)
//   npm run test:sync -- --start-only     (plan 3 stage 5: only the start window, below)
//   npm run test:sync -- --ping 100 --jitter 40 --loss 1   (200 ms of ping, ±40 ms each way,
//                                           1 % of the chunks resent after 200 ms)
//
// What it does:
// 1. Starts the game server and a proxy that adds ~150 ms of ping with jitter
//    (75 ± 25 ms each way), the way a player in Tashkent sees a Frankfurt server.
// 2. Opens two players in Chrome. Player A creates a room, B joins, A starts the race.
// 3. Bump: A drives straight into B. B must be pushed (the hit has to reach B), and A's
//    picture of B must not jump: from the frame of the hit on, how much B's drawn speed
//    changes from one frame to the next (in metres per 60 fps frame), apart from the
//    frames of the hit itself (stage 8: one judge per hit, A's picture lined up with B's).
//    The same for B's picture of A from B's own hit on (stage 9).
// 4. Prediction: A drives a scripted route for 20 s. On every frame we compare where B
//    draws A with where A really was at that moment; also where A's speed changes fast
//    (stage 9), and the game's own numbers (net.js NET.report: update rate, delay, jitter,
//    update age, the size of its corrections).
// 0. The start window (plan 3 stage 5, before all of the above): from the countdown to 2 s
//    after the green light both hold the throttle; each player's frame times, clock steps and
//    picture of the other car (its jump in a frame, its error). Then both go back to the grid.
// It fails if the hit does not reach B or if B's picture of A drifts too far (on the GPU also
// if the start freezes or the other car jumps at the start).
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { launchOptions, onGpu } from '../browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PORT = +process.env.ND_PORT || 2577, PROXY = PORT + 1;   // ND_PORT: another port pair when these are taken
const RUNS = Number(opt('runs', 1));
const ONE_WAY = Number(opt('ping', 75)), JITTER = Number(opt('jitter', 25));   // ms each way
// --loss P: a share P (%) of the chunks is lost once and sent again after TCP's shortest
// retransmission wait (~200 ms); the chunks behind it wait for it (the stream keeps its order)
const LOSS = Number(opt('loss', 0)) / 100, RTO = 200;
// --start-only: only the start window (countdown → first seconds of the race), see START_REC
const START_ONLY = args.includes('--start-only');
const MODE = opt('mode', 'track');
const GHOST = args.includes('--ghost');
const CARD = MODE === 'traffic' ? '#rTraffic' : '#rTrack';   // the room's mode, on the home deck
// a home card: a click brings it to the middle, a click on the card in the middle goes in
const tap2 = async (p, sel) => { await p.click(sel); await new Promise(r => setTimeout(r, 400)); if (await p.$eval(sel, e => !e.closest('[inert]') && e.getAttribute('aria-selected') === 'true').catch(() => false)) await p.click(sel); await new Promise(r => setTimeout(r, 400)); };
// highway: two players' pictures of the same bot at the same server moment (each
// player's clock error taken out, see below), and how far each clock may be off
const LIMIT_BOT_MEAN = 0.3, LIMIT_BOT_P95 = 1.0, LIMIT_CLOCK = 40;
const URL_UNDER_TEST = opt('url', `http://localhost:${PORT}/index.html`);
// Limits. The original game (before stage 0), measured with this script in software
// rendering at ~6 fps and ~380 ms ping, A at ~65 km/h: mean 0.8–1.35 m, p95 1.8–2.4 m.
// After stage 0: mean 0.9–1.4 m, p95 1.9–2.6 m (same code, same spread).
// Since every opponent is drawn with its own car model (UI stage 6), software rendering
// runs at 4-5 fps and the highway's p95 lands anywhere from 2 to 4.8 m: near this limit,
// so a run there can fail on the frame rate alone. With --headed (GPU, ~55 fps) the same
// checks give p95 1.1-1.3 m on both modes.
// A real GPU at 60 fps gives smaller errors. MIN_BUMP: B has no input, so any speed
// above zero means the hit reached B; a glancing hit gives ~2 m/s, a square one ~8.
const LIMIT_MEAN = 2.0, LIMIT_P95 = 4.0, MIN_BUMP = 0.5;
// The jump of A's picture of B around the hit: judged on the GPU only (--headed: 60 fps;
// at the 4-5 fps of software rendering one frame is a fifth of a second of motion).
const LIMIT_JUMP = 0.5;
const CHROME = opt('chrome', process.env.CHROME_PATH);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function latencyProxy(listen, target) {
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const pipe = (from, to) => {
    let lastAt = 0;   // a chunk never overtakes the previous one
    from.on('data', buf => {
      const lost = LOSS && rnd() < LOSS ? RTO : 0;
      const at = Math.max(lastAt, Date.now() + ONE_WAY + (rnd() - 0.5) * 2 * JITTER + lost); lastAt = at;
      // (the other side is gone: this one is reset, as a real connection would be, so a
      // browser that sent a request on a closing keep-alive connection tries again)
      setTimeout(() => { if (!to.destroyed && to.writable) to.write(buf); else from.destroy(); }, at - Date.now());
    });
    // closed: after the last chunk on its way (it used to be cut ONE_WAY + JITTER after the
    // close, which a late chunk could miss: a server's reply lost, "ServerError" on joining)
    from.on('close', () => setTimeout(() => { to.end(); setTimeout(() => to.destroy(), 100); }, Math.max(0, lastAt - Date.now()) + 1));
    from.on('error', () => {});
  };
  return net.createServer(c => { const s = net.connect(target, '127.0.0.1'); pipe(c, s); pipe(s, c); }).listen(listen);
}

async function startServer() {
  try { await fetch(`http://localhost:${PORT}/health`); throw new Error(`port ${PORT} is busy: stop the other server first`); }
  catch (e) { if (/busy/.test(e.message)) throw e; }
  const proc = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://localhost:${PORT}/health`); if (r.ok) return proc; } catch {}
    await sleep(200);
  }
  proc.kill(); throw new Error('server did not start (did you run npm install in server/?)');
}

async function openPlayer(browser, url, errors, tag) {
  const ctx = await browser.newContext({ viewport: { width: 360, height: 240 } });
  // Serve the CDN libraries from node_modules so the check works offline.
  await ctx.route(/three\.min\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/GLTFLoader\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js'), contentType: 'text/javascript' }));
  await ctx.route(/unpkg\.com\/colyseus\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/colyseus.js/dist/colyseus.js'), contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${tag}: ${e.message}`));
  await p.goto(url);
  await p.waitForFunction(() => window.__nd && window.__nd.car);
  return p;
}

const RECORD = mode => {
  window.__rec = []; window.__bots = []; const nd = window.__nd;
  const tick = () => {
    requestAnimationFrame(tick); const t = performance.timeOrigin + performance.now();
    if (mode === 'self') window.__rec.push([t, nd.car.x, nd.car.z, Math.hypot(nd.car.vx, nd.car.vz), nd.G.mode.isGhost && nd.G.mode.isGhost() ? 1 : 0]);
    else for (const g of nd.NET.ghosts.values()) if (g.p.name === 'A' && g.m.root.visible) window.__rec.push([t, g.x, g.z]);
    // highway: every bot as this player draws it, stamped with the server time the game
    // computed it for (not the time of this callback, which runs after the frame is drawn)
    const R = nd.remote;
    if (R && nd.G.mode.id === 'traffic' && R.time && R.time * 1000 !== window.__lastBotT) {
      window.__lastBotT = R.time * 1000; const row = [R.time * 1000]; for (const b of R.bots) row.push(b.id, b.x, b.z); window.__bots.push(row); }
  };
  tick();
};
const speedOf = p => p.evaluate(() => Math.hypot(window.__nd.car.vx, window.__nd.car.vz));

// The start window (plan 3 stage 5: friends saw the other cars stutter at the start): from the
// countdown to START_MS after the green light both players hold the throttle, and every frame
// each records its frame time, its game state, its clock offset, its own car and its picture
// of the other car (with whether it is drawn).
const START_MS = 2000;   // (straight on, both cars reach the first bend of «Ночной город» at ~2.2 s)
const START_REC = () => {
  window.__start = []; const nd = window.__nd;
  const tick = ts => { if (!window.__start) return; requestAnimationFrame(tick);
    let gx = NaN, gz = NaN, vis = 0, lt = 0, off = 0; for (const g of nd.NET.ghosts.values()) { gx = g.x; gz = g.z; vis = g.m.root.visible ? 1 : 0; lt = g.last ? g.last.t : 0; off = Math.hypot(g.view.off.x, g.view.off.z); }
    window.__start.push([performance.timeOrigin + ts, nd.G.state, nd.NET.offset, nd.car.x, nd.car.z, gx, gz, vis, lt, off]); };
  requestAnimationFrame(tick);
};
// One player's numbers in the start window: its frames (the longest, how many over 50 ms),
// its clock's steps, and its picture of the other car: the jump in a frame (how far the drawn
// car is from where its motion of the last two frames carries it on: a smooth car ≈ 0) and
// the error against where the other car really was then (`truth`: the other player's rows).
// (a frame of 50-70 ms is left at the very start of the countdown in a cold browser: GPU
// process work for the two pages of this test sharing it; it is reported, START_FREEZE judged)
const LONG_FRAME = 50, START_JUMP = 0.3, START_FREEZE = 150;
function startNumbers(rec, truth) {
  const c0 = rec.findIndex(r => r[1] === 'count'), go = rec.findIndex(r => r[1] === 'race');
  if (c0 < 0 || go < 0) return null;
  const end = rec[go][0] + START_MS, w = rec.filter((r, i) => i >= c0 && r[0] <= end);
  let longest = 0, long = 0, steps = 0, step = 0, most = 0, big = 0, firstSeen = null;
  for (let i = 1; i < w.length; i++) {
    const d = w[i][0] - w[i - 1][0]; longest = Math.max(longest, d); if (d > LONG_FRAME) long++;
    const o = Math.abs(w[i][2] - w[i - 1][2]); if (o > 0.5) { steps++; step = Math.max(step, o); }
    if (w[i][7] && firstSeen === null) firstSeen = w[i][0] - w[0][0];
    if (i < 2 || !w[i][7] || !w[i - 1][7] || !w[i - 2][7]) continue;
    const d1 = w[i][0] - w[i - 1][0], d0 = Math.max(4, w[i - 1][0] - w[i - 2][0]), k = d1 / d0;
    const j = Math.hypot(w[i][5] - w[i - 1][5] - (w[i - 1][5] - w[i - 2][5]) * k, w[i][6] - w[i - 1][6] - (w[i - 1][6] - w[i - 2][6]) * k);
    most = Math.max(most, j); if (j > START_JUMP) big++;
  }
  const errs = []; let q = 0;
  for (const r of w) {
    if (!r[7]) continue;
    while (q + 1 < truth.length && truth[q + 1][0] < r[0]) q++;
    if (q + 1 >= truth.length || truth[q][0] > r[0]) continue;
    const a0 = truth[q], a1 = truth[q + 1], u = (r[0] - a0[0]) / Math.max(1e-9, a1[0] - a0[0]);
    errs.push(Math.hypot(r[5] - (a0[3] + (a1[3] - a0[3]) * u), r[6] - (a0[4] + (a1[4] - a0[4]) * u)));
  }
  errs.sort((a, b) => a - b);
  const pct = f => errs.length ? +errs[Math.min(errs.length - 1, Math.floor(errs.length * f))].toFixed(2) : null;
  return { frames: w.length, longest: Math.round(longest), long, clockSteps: steps, clockStep: Math.round(step),
    jump: +most.toFixed(2), jumps: big, p50: pct(.5), p95: pct(.95), max: pct(1), firstSeen: firstSeen === null ? null : Math.round(firstSeen) };
}

async function drive(p, seconds) {
  await p.keyboard.down('w');
  let slow = 0;
  for (let t = 0; t < seconds; t += 0.5) {
    const phase = Math.floor(t * 2) % 8;
    const key = phase === 1 || phase === 2 ? 'a' : phase === 5 || phase === 6 ? 'd' : null;
    if (key) await p.keyboard.down(key);
    if (phase === 2 && Math.floor(t) % 4 === 0) await p.keyboard.down(' ');
    await sleep(500);
    for (const k of ['a', 'd', ' ']) await p.keyboard.up(k);
    slow = (await speedOf(p)) < 4 ? slow + 1 : 0;
    if (slow >= 2) { await p.keyboard.press('r'); slow = 0; }   // stuck on a wall: back to the track
  }
  await p.keyboard.up('w');
}

async function runOnce(browser) {
  const errors = [];
  const url = `${URL_UNDER_TEST}${URL_UNDER_TEST.includes('?') ? '&' : '?'}debug&server=ws://localhost:${PROXY}`;
  const A = await openPlayer(browser, url, errors, 'A'), B = await openPlayer(browser, url, errors, 'B');
  let step = 'create room';
  try {
    await A.evaluate(() => localStorage.setItem('nightdrift.name', 'A')); await tap2(A, '#goOnline'); await tap2(A, '#fHost'); await tap2(A, CARD);   // the mode card makes the room
    await A.waitForFunction(() => document.getElementById('roomCode').textContent !== '----');
    const code = (await A.innerText('#roomCode')).trim();
    step = 'B joins'; await B.evaluate(() => localStorage.setItem('nightdrift.name', 'B')); await tap2(B, '#goOnline'); await tap2(B, '#fJoin'); await B.fill('#codeIn', code); await B.click('#joinRoom');
    await A.waitForFunction(() => window.__nd.NET.room.state.players.size === 2);
    if (GHOST) {                                         // the host turns ghost mode on in the lobby; B sees it
      step = 'ghost mode'; await A.check('#cfgGhost input[value=on]');
      await B.waitForFunction(() => window.__nd.NET.room.state.ghostMode === true && document.querySelector('#cfgGhost input[value=on]').checked);
      if (!(await B.evaluate(() => document.querySelector('#cfgGhost input[value=on]').disabled))) throw new Error('a guest can change ghost mode');
    }
    await sleep(1500);                                   // clock sync settles
    step = 'race start'; await B.click('#startRace'); await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'false');
    for (const p of [A, B]) await p.evaluate(START_REC);
    await A.click('#startRace');   // B: «Готово», then A: «Старт»
    // the start window: both hold the throttle from the countdown on, for START_MS after the green light
    for (const p of [A, B]) await p.waitForFunction(() => window.__nd.G.state === 'count', null, { timeout: 20000 });
    // (the canvas has the focus from the game itself; a click there may wait for the menu's fade)
    for (const p of [A, B]) { await p.evaluate(() => document.getElementById('c').focus()); await p.keyboard.down('w'); }
    for (const p of [A, B]) await p.waitForFunction(() => window.__nd.G.state === 'race', null, { timeout: 20000 });
    await sleep(START_MS + 300);
    for (const p of [A, B]) await p.keyboard.up('w');
    const sa = await A.evaluate(() => { const r = window.__start; window.__start = null; return r; });
    const sb = await B.evaluate(() => { const r = window.__start; window.__start = null; return r; });
    if (process.env.SYNC_START_DUMP) { const fs = await import('node:fs'); fs.writeFileSync(process.env.SYNC_START_DUMP, JSON.stringify({ A: sa, B: sb })); }
    const start = { A: startNumbers(sa, sb), B: startNumbers(sb, sa) };   // A's picture of B, B's of A
    if (START_ONLY) return { start, errors };
    // both back on their start spots, standing (the bump below drives A into B from there)
    for (const p of [A, B]) await p.evaluate(([x, z]) => { const nd = window.__nd, c = nd.car;
      if (nd.G.mode.id === 'track') nd.G.mode.enter(c, { slot: nd.NET.me ? nd.NET.me.slot : 0 });
      else { c.x = x; c.z = z; c.h = 0; c.hPrev = 0; c.vx = c.vz = c.vF = c.vR = 0; c.spinV = 0; c.steer = 0; }
    }, (p === A ? sa : sb).find(r => r[1] === 'count').slice(3, 5));
    for (const p of [A, B]) await p.waitForFunction(() => Math.hypot(window.__nd.car.vx, window.__nd.car.vz) < 0.2);
    await sleep(1500);                                   // the reset reaches the other player
    await A.bringToFront(); await A.click('#c'); await sleep(600);

    step = 'bump';
    // Bump: aim A at B and drive into it. A records its own velocity and its picture of B
    // every frame, with the frame's time.
    await A.evaluate(() => { const nd = window.__nd, c = nd.car; for (const g of nd.NET.ghosts.values()) c.h = Math.atan2(g.x - c.x, g.z - c.z);
      window.__hit = []; const tick = ts => { if (!window.__hit) return; requestAnimationFrame(tick);
        for (const g of nd.NET.ghosts.values()) if (g.p.name === 'B') window.__hit.push([ts, g.x, g.z, nd.car.vx, nd.car.vz, g.off ? g.off.x : 0, g.off ? g.off.z : 0, g.last ? g.last.t : 0, g.kick ? (g.kick.run ? 2 : 1) : 0, g.last ? g.last.vx : 0, g.last ? g.last.vz : 0, Math.hypot(g.x - nd.car.x, g.z - nd.car.z), g.alpha === undefined ? 1 : g.alpha]); };
      requestAnimationFrame(tick); });
    // and B its own velocity and its picture of A (A's hit reaches B in A's updates)
    await B.evaluate(() => { const nd = window.__nd;
      window.__hit = []; const tick = ts => { if (!window.__hit) return; requestAnimationFrame(tick);
        for (const g of nd.NET.ghosts.values()) if (g.p.name === 'A') window.__hit.push([ts, g.x, g.z, nd.car.vx, nd.car.vz, g.off ? g.off.x : 0, g.off ? g.off.z : 0, g.last ? g.last.t : 0, g.mem ? g.mem.role : '', nd.car.x, nd.car.z]); };
      requestAnimationFrame(tick); });
    await A.keyboard.down('w');
    let bump = 0;
    // Software rendering runs a few frames a second, and below 20 fps the game runs in slow
    // motion: A may need many seconds to cover the few metres. Drive until the hit lands
    // (or 12 s have passed), then a moment more for it to reach B.
    // Ghost mode: drive on until A has gone through B and out the other side (or 12 s).
    let near = Infinity;
    for (let i = 0; i < 120; i++) { await sleep(100); bump = Math.max(bump, await speedOf(B));
      if (!GHOST) { if (bump > MIN_BUMP) break; continue; }
      const d = await A.evaluate(() => { for (const g of window.__nd.NET.ghosts.values()) return Math.hypot(g.x - window.__nd.car.x, g.z - window.__nd.car.z); return Infinity; });
      near = Math.min(near, d); if (near < 1.5 && d > 5) { await sleep(300); break; } }
    await A.keyboard.up('w'); await sleep(1000);
    const hitRec = await A.evaluate(() => { const r = window.__hit; window.__hit = null; return r; });
    const hitRecB = await B.evaluate(() => { const r = window.__hit; window.__hit = null; return r; });
    if (process.env.SYNC_HIT_DUMP) { const fs = await import('node:fs'); fs.writeFileSync(process.env.SYNC_HIT_DUMP, JSON.stringify(hitRec)); fs.writeFileSync(process.env.SYNC_HIT_DUMP + '.B.json', JSON.stringify(hitRecB)); }
    await A.keyboard.press('r'); await sleep(500);
    // A's own hit: a jump of its velocity (driving changes it by < 0.5 m/s per frame); then
    // B's drawn speed change per frame from there on, the hit's own frames apart
    const jumpOf = rec => {
      let at = -1, most = null;
      for (let i = 1; i < rec.length && at < 0; i++) if (Math.hypot(rec[i][3] - rec[i - 1][3], rec[i][4] - rec[i - 1][4]) > 1.5) at = i;
      if (at > 0) { most = 0; for (let i = at + 2; i < rec.length; i++) {
        const d1 = Math.max(4, rec[i][0] - rec[i - 1][0]), d0 = Math.max(4, rec[i - 1][0] - rec[i - 2][0]);
        most = Math.max(most, Math.hypot((rec[i][1] - rec[i - 1][1]) / d1 - (rec[i - 1][1] - rec[i - 2][1]) / d0,
          (rec[i][2] - rec[i - 1][2]) / d1 - (rec[i - 1][2] - rec[i - 2][2]) / d0) * 1000 / 60);
      } }
      return most;
    };
    const jump = jumpOf(hitRec);
    // B's picture of A from B's own hit on (B feels the hit when A's updates with A's own
    // reaction come in too): also judged on the GPU only
    const jumpB = jumpOf(hitRecB);
    // Ghost mode: how close A came to B's centre, how see-through A drew B, and the most B's
    // drawn speed changed from one frame to the next while A drove through it (no hit: all frames)
    let ghost = null;
    if (GHOST) {
      let most = 0, closest = Infinity, alpha = 1;
      for (let i = 2; i < hitRec.length; i++) {
        const d1 = Math.max(4, hitRec[i][0] - hitRec[i - 1][0]), d0 = Math.max(4, hitRec[i - 1][0] - hitRec[i - 2][0]);
        most = Math.max(most, Math.hypot((hitRec[i][1] - hitRec[i - 1][1]) / d1 - (hitRec[i - 1][1] - hitRec[i - 2][1]) / d0,
          (hitRec[i][2] - hitRec[i - 1][2]) / d1 - (hitRec[i - 1][2] - hitRec[i - 2][2]) / d0) * 1000 / 60);
        closest = Math.min(closest, hitRec[i][11]); alpha = Math.min(alpha, hitRec[i][12]);
      }
      // a hit on B would change A's velocity by more than 1.5 m/s in one frame while the
      // cars' bodies can touch (centres within 5 m, both hitboxes' half-lengths), up to where A
      // has gone through B and out the other side: right after, A meets the rail or wall the
      // grid faces (on the highway ~6 m past B), which is no hit
      let felt = false, through = false;
      for (let i = 1; i < hitRec.length && !(through && hitRec[i][11] > 5); i++) {
        if (hitRec[i][11] < 1.5) through = true;
        if (hitRec[i][11] < 5 && Math.hypot(hitRec[i][3] - hitRec[i - 1][3], hitRec[i][4] - hitRec[i - 1][4]) > 1.5) felt = true;
      }
      ghost = { jump: +most.toFixed(2), closest: +closest.toFixed(2), alpha: +alpha.toFixed(2), felt };
    }

    step = 'prediction drive';
    // Prediction: A drives, both record every frame.
    await A.evaluate(RECORD, 'self'); await B.evaluate(RECORD, 'ghost');
    await drive(A, 20);
    await sleep(1000);
    const ra = await A.evaluate(() => window.__rec), rb = await B.evaluate(() => window.__rec);
    const ba = await A.evaluate(() => window.__bots), bb = await B.evaluate(() => window.__bots);
    // Browsers and server share this machine's clock, so each player's true offset is 0
    // and NET.offset is its clock error. Bot rows carry the server time each player
    // computed them for: comparing equal stamps compares the two pictures of the same
    // server moment (the prediction itself). A row's real moment is its stamp minus that
    // player's clock error; comparing equal real moments adds the clock error on top.
    const clock = [await A.evaluate(() => window.__nd.NET.offset), await B.evaluate(() => window.__nd.NET.offset)].map(Math.round);
    const rtt = await B.evaluate(() => window.__nd.NET.rtt);
    // the game's own numbers (net.js NET.report, ?debug=net): B's updates of A
    const net = await B.evaluate(() => window.__nd.NET.report ? window.__nd.NET.report().ghosts.find(g => g.name === "A") : null);

    // A pressing R teleports the car back onto the track; B needs a moment to catch up.
    // That is a reset, not a sync error, so the 1.5 s after each teleport are left out.
    const resets = [];
    for (let i = 1; i < ra.length; i++) if (Math.hypot(ra[i][1] - ra[i - 1][1], ra[i][2] - ra[i - 1][2]) > 8) resets.push(ra[i][0]);
    // on the highway a crashed car is put back on a free lane: also a reset
    for (let i = 1; i < ra.length; i++) if (ra[i][4] && !ra[i - 1][4]) resets.push(ra[i][0] + 3000);
    const afterReset = t => resets.some(r => t >= r && t < r + 1500);
    const errs = []; let j = 0;
    for (const [t, gx, gz] of rb) {
      if (afterReset(t)) continue;
      while (j + 1 < ra.length && ra[j + 1][0] < t) j++;
      if (j + 1 >= ra.length || ra[j][0] > t) continue;
      const a0 = ra[j], a1 = ra[j + 1], u = (t - a0[0]) / Math.max(1e-9, a1[0] - a0[0]);
      errs.push(Math.hypot(gx - (a0[1] + (a1[1] - a0[1]) * u), gz - (a0[2] + (a1[2] - a0[2]) * u)));
      if (process.env.SYNC_DEBUG && errs.at(-1) > 6) console.log('BIG', (t - ra[0][0]).toFixed(0), 'err', errs.at(-1).toFixed(1), 'ghost', gx.toFixed(1), gz.toFixed(1), 'A', a0[1].toFixed(1), a0[2].toFixed(1), 'v', (a0[3]*3.6).toFixed(0), 'ghostflag', a0[4], 'dtA', (a1[0]-a0[0]).toFixed(0));
    }
    // the frames where A's speed changes fast (the handbrake, a wall, a hit): more than 3 m/s
    // within 0.25 s, and the half second after (the error there is the prediction's hard case)
    const fast = [];
    for (let i = 0, k = 0; i < ra.length; i++) {
      while (k < ra.length && ra[k][0] < ra[i][0] + 250) k++;
      if (k < ra.length && Math.abs(ra[k][3] - ra[i][3]) > 3) fast.push(ra[i][0]);
    }
    const errsFast = []; { let q = 0, k = 0;
      for (const [t, gx, gz] of rb) {
        if (afterReset(t)) continue;
        while (q < fast.length && fast[q] < t - 750) q++;
        if (q >= fast.length || fast[q] > t) continue;
        while (k + 1 < ra.length && ra[k + 1][0] < t) k++;
        if (k + 1 >= ra.length || ra[k][0] > t) continue;
        const a0 = ra[k], a1 = ra[k + 1], u = (t - a0[0]) / Math.max(1e-9, a1[0] - a0[0]);
        errsFast.push(Math.hypot(gx - (a0[1] + (a1[1] - a0[1]) * u), gz - (a0[2] + (a1[2] - a0[2]) * u)));
      } }
    errsFast.sort((a, b) => a - b);
    errs.sort((a, b) => a - b);
    const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
    const fps = ra.length / ((ra.at(-1)[0] - ra[0][0]) / 1000);
    // highway: for every frame B drew, where A drew the same bot at that moment
    const compare = shift => {
      const out = []; let k = 0;
      for (const row of bb) {
        const t = row[0] + shift;
        while (k + 1 < ba.length && ba[k + 1][0] < t) k++;
        if (k + 1 >= ba.length || ba[k][0] > t) continue;
        const a0 = ba[k], a1 = ba[k + 1], u = (t - a0[0]) / Math.max(1e-9, a1[0] - a0[0]);
        const pos = r => { const m = new Map(); for (let i = 1; i < r.length; i += 3) m.set(r[i], [r[i + 1], r[i + 2]]); return m; };
        const P0 = pos(a0), P1 = pos(a1);
        for (let i = 1; i < row.length; i += 3) {
          const p0 = P0.get(row[i]), p1 = P1.get(row[i]); if (!p0 || !p1) continue;
          out.push(Math.hypot(row[i + 1] - (p0[0] + (p1[0] - p0[0]) * u), row[i + 2] - (p0[1] + (p1[1] - p0[1]) * u)));
        }
      }
      return out.sort((a, b) => a - b);
    };
    const botErr = compare(0), botRaw = compare(clock[0] - clock[1]);
    return {
      rtt: Math.round(rtt), fps: Math.round(fps), clock,
      speedKmh: Math.round(ra.reduce((s, r) => s + r[3], 0) / ra.length * 3.6),
      mean: +mean.toFixed(2), p95: +errs[Math.floor(errs.length * 0.95)].toFixed(2), bump: +bump.toFixed(2), errors,
      jump: jump === null ? null : +jump.toFixed(2), jumpB: jumpB === null ? null : +jumpB.toFixed(2), ghost,
      p50: +errs[Math.floor(errs.length * 0.5)].toFixed(2),
      fast: errsFast.length ? { n: errsFast.length, p95: +errsFast[Math.floor(errsFast.length * 0.95)].toFixed(2) } : null,
      start,
      net: net && { hz: Math.round(net.hz), delay: Math.round(net.delay), jitter: +net.jitter.toFixed(1), age: Math.round(net.age), p50: +net.p50.toFixed(2), p95: +net.p95.toFixed(2) },
      bots: botErr.length ? { n: botErr.length, mean: +(botErr.reduce((s, e) => s + e, 0) / botErr.length).toFixed(3), p95: +botErr[Math.floor(botErr.length * 0.95)].toFixed(3),
        raw: +(botRaw.reduce((s, e) => s + e, 0) / botRaw.length).toFixed(3) } : null,
    };
  } catch (e) {
    if (process.env.SYNC_SHOT) for (const [n, p] of [['A', A], ['B', B]]) { await p.screenshot({ path: `${process.env.SYNC_SHOT}-${n}.png` }).catch(() => {});
      console.log(n, await p.evaluate(() => ({ state: window.__nd.G.state, phase: window.__nd.NET.room && window.__nd.NET.room.state.phase, lobby: !document.getElementById('pLobby').hidden, menu: !document.getElementById('menu').hidden })).catch(e => e.message)); }
    e.message = `[step: ${step}] ${e.message}`; throw e; }
  finally { await A.context().close(); await B.context().close(); }
}

const server = await startServer();
const proxy = latencyProxy(PROXY, PORT);
// --headed: two real windows on the GPU (60 fps, as players have it); by default software
// rendering, a few frames a second, which is the harder case for the prediction
const HEADED = onGpu();             // --headed: no window, real GPU; --show: a visible window
const browser = await chromium.launch({ ...launchOptions(process.argv, []), ...(CHROME ? { executablePath: CHROME } : { channel: 'chrome' }) });
let failed = false;
try {
  for (let i = 0; i < RUNS; i++) {
    const r = await runOnce(browser);
    const bad = [];
    const st = r.start, line = (n, x) => x ? `${n}: frames ≤ ${x.longest} ms (${x.long} over ${LONG_FRAME}), clock steps ${x.clockSteps} (most ${x.clockStep} ms), ` +
      `picture of the other car: jump ≤ ${x.jump} m (${x.jumps} over ${START_JUMP}), off p50 ${x.p50} m p95 ${x.p95} m max ${x.max} m, drawn after ${x.firstSeen} ms` : `${n}: no countdown recorded`;
    console.log(`run ${i + 1} start window (countdown → ${START_MS / 1000} s of the race): ${line('A', st.A)}; ${line('B', st.B)}`);
    if (!st.A || !st.B) bad.push('the start window was not recorded');
    // on the GPU (60 fps): no freeze at the countdown (it was ~0.7 s of shader compiling, a cold
    // browser) and the other car drawn without a jump (clock steps moved it up to ~1 m a frame)
    else if (HEADED) for (const [n, x] of [['A', st.A], ['B', st.B]]) {
      if (x.longest > START_FREEZE) bad.push(`start window: ${n} froze for ${x.longest} ms > ${START_FREEZE} ms`);
      if (x.jumps) bad.push(`start window: ${n}'s picture of the other car jumped ${x.jumps} times by more than ${START_JUMP} m in a frame (most ${x.jump} m)`);
    }
    if (START_ONLY) { if (r.errors.length) bad.push('page errors: ' + r.errors.join('; ')); console.log(`  ${bad.length ? 'FAIL: ' + bad.join(', ') : 'ok'}`); if (bad.length) failed = true; continue; }
    if (GHOST) {
      // ghost mode: A drives through B (their centres within 1.5 m), B is not pushed, A feels
      // no hit, B is drawn see-through, and A's picture of B does not jump
      const g = r.ghost;
      if (r.bump >= MIN_BUMP) bad.push(`ghost mode: B was pushed to ${r.bump} m/s`);
      if (g.felt) bad.push('ghost mode: A felt a hit on B');
      if (!(g.closest < 1.5)) bad.push(`ghost mode: A did not drive through B (closest ${g.closest} m)`);
      if (g.alpha > 0.55) bad.push(`ghost mode: B was not drawn see-through near A (alpha ${g.alpha})`);
      if (HEADED && g.jump > LIMIT_JUMP) bad.push(`ghost mode: A's picture of B jumped ${g.jump} m in a frame > ${LIMIT_JUMP} m`);
    } else {
      if (r.bump < MIN_BUMP) bad.push(`hit did not reach player B (B speed ${r.bump} m/s)`);
      if (HEADED && r.jump === null) bad.push('A never felt its hit on B');
      if (HEADED && r.jump > LIMIT_JUMP) bad.push(`A's picture of B jumped ${r.jump} m in a frame after the hit > ${LIMIT_JUMP} m`);
      if (HEADED && r.jumpB > LIMIT_JUMP) bad.push(`B's picture of A jumped ${r.jumpB} m in a frame after the hit > ${LIMIT_JUMP} m`);
    }
    if (r.fast && r.fast.p95 > LIMIT_P95) bad.push(`p95 error ${r.fast.p95} m > ${LIMIT_P95} m where A's speed changes fast`);
    if (r.mean > LIMIT_MEAN) bad.push(`mean error ${r.mean} m > ${LIMIT_MEAN} m`);
    if (r.p95 > LIMIT_P95) bad.push(`p95 error ${r.p95} m > ${LIMIT_P95} m`);
    if (r.errors.length) bad.push('page errors: ' + r.errors.join('; '));
    if (MODE === 'traffic') {
      if (Math.abs(r.clock[0]) > LIMIT_CLOCK || Math.abs(r.clock[1]) > LIMIT_CLOCK) bad.push(`clock off by ${r.clock.join(' / ')} ms`);
      if (!r.bots || r.bots.n < 500) bad.push('too few bot samples');
      else if (r.bots.mean > LIMIT_BOT_MEAN || r.bots.p95 > LIMIT_BOT_P95) bad.push(`players disagree on bots: mean ${r.bots.mean} m, p95 ${r.bots.p95} m`);
    }
    console.log(`run ${i + 1}: ping ${r.rtt} ms, ${r.fps} fps, clock error A ${r.clock[0]} ms B ${r.clock[1]} ms, A at ${r.speedKmh} km/h → B sees A off by ` +
      `mean ${r.mean} m, p50 ${r.p50} m, p95 ${r.p95} m (p95 ${r.fast ? r.fast.p95 : '-'} m where A's speed changes fast); bump pushed B to ${r.bump} m/s, ` +
      (r.ghost ? `ghost mode: A came within ${r.ghost.closest} m of B's centre, drew B at alpha ${r.ghost.alpha}, A's picture of B jumped at most ${r.ghost.jump} m in a frame, A felt a hit: ${r.ghost.felt}` :
        `the picture of the other car jumped at most ${r.jump} m (A's of B) / ${r.jumpB} m (B's of A) in a frame after it`) +
      (r.net ? `; B's game: A's updates ${r.net.hz}/s, delay ${r.net.delay} ms, jitter ${r.net.jitter} ms, age ${r.net.age} ms, corrections p50 ${r.net.p50} m p95 ${r.net.p95} m` : '') +
      (r.bots ? `; bots: A and B differ by mean ${r.bots.mean} m, p95 ${r.bots.p95} m at the same server moment, ${r.bots.raw} m with the clock error (${r.bots.n} samples)` : '') +
      `  ${bad.length ? 'FAIL: ' + bad.join(', ') : 'ok'}`);
    if (bad.length) failed = true;
  }
} finally {
  await browser.close(); proxy.close();
  await new Promise(r => { server.once('exit', r); server.kill(); });   // free the port before the next run
}
process.exit(failed ? 1 : 0);
