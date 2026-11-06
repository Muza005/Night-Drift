// Multiplayer sync check: run after every change that touches the online game.
//
//   npm run test:sync                 (needs Google Chrome and `npm install` in server/)
//   npm run test:sync -- --runs 3     (repeat to see the spread)
//   npm run test:sync -- --url http://localhost:8001/index.html   (test another build)
//
// What it does:
// 1. Starts the game server and a proxy that adds ~150 ms of ping with jitter
//    (75 ± 25 ms each way), the way a player in Tashkent sees a Frankfurt server.
// 2. Opens two players in Chrome. Player A creates a room, B joins, A starts the race.
// 3. Bump: A drives straight into B. B must be pushed (the hit has to reach B).
// 4. Prediction: A drives a scripted route for 20 s. On every frame we compare where B
//    draws A with where A really was at that moment.
// It fails if the hit does not reach B or if B's picture of A drifts too far.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PORT = 2577, PROXY = 2578, ONE_WAY = 75, JITTER = 25;
const RUNS = Number(opt('runs', 1));
const URL_UNDER_TEST = opt('url', `http://localhost:${PORT}/index.html`);
// Limits. The original game (before stage 0), measured with this script in software
// rendering at ~6 fps and ~380 ms ping, A at ~65 km/h: mean 0.8–1.35 m, p95 1.8–2.4 m.
// After stage 0: mean 0.9–1.4 m, p95 1.9–2.6 m (same code, same spread).
// A real GPU at 60 fps gives smaller errors. MIN_BUMP: B has no input, so any speed
// above zero means the hit reached B; a glancing hit gives ~2 m/s, a square one ~8.
const LIMIT_MEAN = 2.0, LIMIT_P95 = 4.0, MIN_BUMP = 0.5;
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
  await ctx.route(/unpkg\.com\/colyseus\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/colyseus.js/dist/colyseus.js'), contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${tag}: ${e.message}`));
  await p.goto(url);
  await p.waitForFunction(() => window.__nd && window.__nd.car);
  return p;
}

const RECORD = mode => {
  window.__rec = []; const nd = window.__nd;
  const tick = () => {
    requestAnimationFrame(tick); const t = performance.timeOrigin + performance.now();
    if (mode === 'self') window.__rec.push([t, nd.car.x, nd.car.z, Math.hypot(nd.car.vx, nd.car.vz)]);
    else for (const g of nd.NET.ghosts.values()) if (g.p.name === 'A' && g.m.root.visible) window.__rec.push([t, g.x, g.z]);
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
    await A.click('#toOnline'); await A.fill('#nameIn', 'A'); await A.click('#createRoom');
    await A.waitForFunction(() => document.getElementById('roomCode').textContent !== '----');
    const code = (await A.innerText('#roomCode')).trim();
    step = 'B joins'; await B.click('#toOnline'); await B.fill('#nameIn', 'B'); await B.fill('#codeIn', code); await B.click('#joinRoom');
    await A.waitForFunction(() => window.__nd.NET.room.state.players.size === 2);
    await sleep(1500);                                   // clock sync settles
    step = 'race start'; await A.click('#startRace');
    for (const p of [A, B]) await p.waitForFunction(() => window.__nd.NET.room.state.phase === 'race', null, { timeout: 20000 });
    await A.bringToFront(); await A.click('#c'); await sleep(600);

    step = 'bump';
    // Bump: aim A at B and drive into it.
    await A.evaluate(() => { const nd = window.__nd, c = nd.car; for (const g of nd.NET.ghosts.values()) c.h = Math.atan2(g.x - c.x, g.z - c.z); });
    await A.keyboard.down('w');
    let bump = 0;
    for (let i = 0; i < 30; i++) { await sleep(100); bump = Math.max(bump, await speedOf(B)); }
    await A.keyboard.up('w'); await sleep(1000); await A.keyboard.press('r'); await sleep(500);

    step = 'prediction drive';
    // Prediction: A drives, both record every frame.
    await A.evaluate(RECORD, 'self'); await B.evaluate(RECORD, 'ghost');
    await drive(A, 20);
    await sleep(1000);
    const ra = await A.evaluate(() => window.__rec), rb = await B.evaluate(() => window.__rec);
    const rtt = await B.evaluate(() => window.__nd.NET.rtt);
    // A pressing R teleports the car back onto the track; B needs a moment to catch up.
    // That is a reset, not a sync error, so the 1.5 s after each teleport are left out.
    const resets = [];
    for (let i = 1; i < ra.length; i++) if (Math.hypot(ra[i][1] - ra[i - 1][1], ra[i][2] - ra[i - 1][2]) > 8) resets.push(ra[i][0]);
    const afterReset = t => resets.some(r => t >= r && t < r + 1500);
    const errs = []; let j = 0;
    for (const [t, gx, gz] of rb) {
      if (afterReset(t)) continue;
      while (j + 1 < ra.length && ra[j + 1][0] < t) j++;
      if (j + 1 >= ra.length || ra[j][0] > t) continue;
      const a0 = ra[j], a1 = ra[j + 1], u = (t - a0[0]) / Math.max(1e-9, a1[0] - a0[0]);
      errs.push(Math.hypot(gx - (a0[1] + (a1[1] - a0[1]) * u), gz - (a0[2] + (a1[2] - a0[2]) * u)));
    }
    errs.sort((a, b) => a - b);
    const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
    const fps = ra.length / ((ra.at(-1)[0] - ra[0][0]) / 1000);
    return {
      rtt: Math.round(rtt), fps: Math.round(fps),
      speedKmh: Math.round(ra.reduce((s, r) => s + r[3], 0) / ra.length * 3.6),
      mean: +mean.toFixed(2), p95: +errs[Math.floor(errs.length * 0.95)].toFixed(2), bump: +bump.toFixed(2), errors,
    };
  } catch (e) { e.message = `[step: ${step}] ${e.message}`; throw e; }
  finally { await A.context().close(); await B.context().close(); }
}

const server = await startServer();
const proxy = latencyProxy(PROXY, PORT);
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : { channel: 'chrome' }),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failed = false;
try {
  for (let i = 0; i < RUNS; i++) {
    const r = await runOnce(browser);
    const bad = [];
    if (r.bump < MIN_BUMP) bad.push(`hit did not reach player B (B speed ${r.bump} m/s)`);
    if (r.mean > LIMIT_MEAN) bad.push(`mean error ${r.mean} m > ${LIMIT_MEAN} m`);
    if (r.p95 > LIMIT_P95) bad.push(`p95 error ${r.p95} m > ${LIMIT_P95} m`);
    if (r.errors.length) bad.push('page errors: ' + r.errors.join('; '));
    console.log(`run ${i + 1}: ping ${r.rtt} ms, ${r.fps} fps, A at ${r.speedKmh} km/h → B sees A off by ` +
      `mean ${r.mean} m, p95 ${r.p95} m; bump pushed B to ${r.bump} m/s  ${bad.length ? 'FAIL: ' + bad.join(', ') : 'ok'}`);
    if (bad.length) failed = true;
  }
} finally {
  await browser.close(); proxy.close();
  await new Promise(r => { server.once('exit', r); server.kill(); });   // free the port before the next run
}
process.exit(failed ? 1 : 0);
