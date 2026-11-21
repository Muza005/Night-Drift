// Multiplayer sync check: run after every change that touches the online game.
//
//   npm run test:sync                 (needs Google Chrome and `npm install` in server/)
//   npm run test:sync -- --runs 3     (repeat to see the spread)
//   npm run test:sync -- --url http://localhost:8001/index.html   (test another build)
//   npm run test:sync -- --mode traffic   (the highway: also checks that both players
//                                           see the server's bots in the same places)
//   npm run test:sync -- --headed         (two real windows on the GPU instead of software
//                                           rendering at a few frames a second)
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
// It fails if the hit does not reach B or if B's picture of A drifts too far.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { launchOptions, onGpu } from '../browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PORT = 2577, PROXY = 2578;
const RUNS = Number(opt('runs', 1));
const ONE_WAY = Number(opt('ping', 75)), JITTER = Number(opt('jitter', 25));   // ms each way
const MODE = opt('mode', 'track');
const CARD = MODE === 'traffic' ? '#mTraffic' : '#mTrack';
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
      const at = Math.max(lastAt, Date.now() + ONE_WAY + (rnd() - 0.5) * 2 * JITTER); lastAt = at;
      setTimeout(() => { if (!to.destroyed) to.write(buf); }, at - Date.now());
    });
    from.on('close', () => setTimeout(() => to.destroy(), ONE_WAY + JITTER));
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
    await A.evaluate(() => localStorage.setItem('nightdrift.name', 'A')); await A.click('#goOnline'); await A.click(CARD);   // the mode card makes the room
    await A.waitForFunction(() => document.getElementById('roomCode').textContent !== '----');
    const code = (await A.innerText('#roomCode')).trim();
    step = 'B joins'; await B.evaluate(() => localStorage.setItem('nightdrift.name', 'B')); await B.click('#goOnline'); await B.fill('#codeIn', code); await B.click('#joinRoom');
    await A.waitForFunction(() => window.__nd.NET.room.state.players.size === 2);
    await sleep(1500);                                   // clock sync settles
    step = 'race start'; await B.click('#startRace'); await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'false'); await A.click('#startRace');   // B: «Готово», then A: «Старт»
    for (const p of [A, B]) await p.waitForFunction(() => window.__nd.NET.room.state.phase === 'race', null, { timeout: 20000 });
    await A.bringToFront(); await A.click('#c'); await sleep(600);

    step = 'bump';
    // Bump: aim A at B and drive into it. A records its own velocity and its picture of B
    // every frame, with the frame's time.
    await A.evaluate(() => { const nd = window.__nd, c = nd.car; for (const g of nd.NET.ghosts.values()) c.h = Math.atan2(g.x - c.x, g.z - c.z);
      window.__hit = []; const tick = ts => { if (!window.__hit) return; requestAnimationFrame(tick);
        for (const g of nd.NET.ghosts.values()) if (g.p.name === 'B') window.__hit.push([ts, g.x, g.z, nd.car.vx, nd.car.vz, g.off ? g.off.x : 0, g.off ? g.off.z : 0, g.last ? g.last.t : 0, g.kick ? (g.kick.run ? 2 : 1) : 0, g.last ? g.last.vx : 0, g.last ? g.last.vz : 0]); };
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
    for (let i = 0; i < 120; i++) { await sleep(100); bump = Math.max(bump, await speedOf(B)); if (bump > MIN_BUMP) break; }
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
      jump: jump === null ? null : +jump.toFixed(2), jumpB: jumpB === null ? null : +jumpB.toFixed(2),
      p50: +errs[Math.floor(errs.length * 0.5)].toFixed(2),
      fast: errsFast.length ? { n: errsFast.length, p95: +errsFast[Math.floor(errsFast.length * 0.95)].toFixed(2) } : null,
      net: net && { hz: Math.round(net.hz), delay: Math.round(net.delay), jitter: +net.jitter.toFixed(1), age: Math.round(net.age), p50: +net.p50.toFixed(2), p95: +net.p95.toFixed(2) },
      bots: botErr.length ? { n: botErr.length, mean: +(botErr.reduce((s, e) => s + e, 0) / botErr.length).toFixed(3), p95: +botErr[Math.floor(botErr.length * 0.95)].toFixed(3),
        raw: +(botRaw.reduce((s, e) => s + e, 0) / botRaw.length).toFixed(3) } : null,
    };
  } catch (e) { e.message = `[step: ${step}] ${e.message}`; throw e; }
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
    if (r.bump < MIN_BUMP) bad.push(`hit did not reach player B (B speed ${r.bump} m/s)`);
    if (HEADED && r.jump === null) bad.push('A never felt its hit on B');
    if (HEADED && r.jump > LIMIT_JUMP) bad.push(`A's picture of B jumped ${r.jump} m in a frame after the hit > ${LIMIT_JUMP} m`);
    if (HEADED && r.jumpB > LIMIT_JUMP) bad.push(`B's picture of A jumped ${r.jumpB} m in a frame after the hit > ${LIMIT_JUMP} m`);
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
      `the picture of the other car jumped at most ${r.jump} m (A's of B) / ${r.jumpB} m (B's of A) in a frame after it` +
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
