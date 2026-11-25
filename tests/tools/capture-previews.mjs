// The home cards' preview loops, recorded from the game itself (no window: headless Chrome
// on the GPU). For each mode: a solo run is started through the real menu, a simple
// autopilot drives (on the drift map it throws the car sideways into the corners), the
// screen is recorded, and the best 3.5 s is cut out: on «Дрифт» the stretch with the most
// sliding while the car stays on the asphalt, on «Трасса» a stretch at speed in traffic.
// Out: public/media/<mode>.mp4 (H.264), <mode>-av1.mp4 (AV1), <mode>.webp (the poster,
// the loop's first frame), each loop under 400 KB; and friends.webp, join.webp, career.webp: a still
// each for the other home cards: the car in traffic (friends), on «Эстакада» (join) and on
// «Перевал» (career).
//
//   node tests/tools/capture-previews.mjs            (both)
//   node tests/tools/capture-previews.mjs drift      (one)
//   ND_PORT=4230 picks the server's port; CHROME_PATH the browser; needs ffmpeg with libx264
//   and libsvtav1 (or libaom-av1).
import { chromium } from 'playwright-core';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'public/media');
const PORT = +process.env.ND_PORT || 4230;
const W = 640, H = 360, FPS = 30, LOOP = 3.5, MAX = 400 * 1024;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const want = process.argv.slice(2).filter(a => !a.startsWith('-'));
const SHOTS = [
  { name: 'drift', mode: 'track', map: 'neon', seconds: 24 },
  { name: 'traffic', mode: 'traffic', seconds: 16 },
  // the other home cards: one still each, every one a different place, the car on the road:
  // «С друзьями» in the thick of the highway's traffic, «Войти по коду» on «Эстакада»'s
  // bridges, «Карьера» on «Перевал»
  { name: 'friends', mode: 'traffic', still: true },
  { name: 'join', mode: 'track', map: 'estakada', still: true },
  { name: 'career', mode: 'track', map: 'pereval', still: true },
].filter(s => !want.length || want.includes(s.name));

const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch {} await sleep(200); }
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--disable-accelerated-video-decode'] });
try {
  for (const s of SHOTS) await shoot(s);
} finally { await browser.close(); server.kill(); }

async function shoot(s){
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.route(/three\.min\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/GLTFLoader\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js'), contentType: 'text/javascript' }));
  await ctx.route(/unpkg\.com\/colyseus\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/colyseus.js/dist/colyseus.js'), contentType: 'text/javascript' }));
  // a fresh player; on the highway the camera behind the car (the game's «Камера» button),
  // which shows the traffic around it better than the view from above
  await ctx.addInitScript(() => { try { localStorage.clear(); localStorage.setItem('nightdrift.trafficCam', 'chase'); } catch {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error(s.name, 'page error:', e.message));
  await page.goto(`http://localhost:${PORT}/?debug&mode=${s.mode}${s.map ? '&map=' + s.map : ''}&server=ws://localhost:${PORT}`);
  await page.waitForFunction(() => window.__nd && __nd.car.model, null, { timeout: 60000 });
  await sleep(800);
  // through the menu as a player: the card in focus (the mode just set), Enter; on «Дрифт»
  // the map deck, Enter; the garage, «Поехали»
  await page.keyboard.press('Enter'); await sleep(700);
  if (s.mode === 'track') { await page.keyboard.press('Enter'); await sleep(700); }
  await page.waitForFunction(() => !document.getElementById('pGarage').hidden);
  await page.click('#garGo');
  await page.waitForFunction(() => __nd.G.state === 'race', null, { timeout: 15000 });
  await page.addStyleTag({ content: '.hud, #hud, #count, #toast, #drift, #speedo, #minimap, #touch, #hint { visibility: hidden !important; }' });
  await page.evaluate(async mode => {
    const { input } = await import('/js/core/input.js');
    const g = mode === 'track' ? await import('/js/modes/track/geometry.js') : null;
    const car = __nd.car, wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
    window.__stat = { t: 0 };
    (function tick(){
      input.up = 1;
      const sp = Math.hypot(car.vx, car.vz);
      if (g) {
        const N = g.N, i = car.idx, j = (i + 10) % N;
        const err = wrap(Math.atan2(g.P[j].x - car.x, g.P[j].z - car.z) - car.h);
        input.right = err < -0.04 ? 1 : 0; input.left = err > 0.04 ? 1 : 0;
        let rmin = 1e9; for (let k = 4; k < 26; k++) rmin = Math.min(rmin, Math.abs(g.RAD[(i + k) % N]));
        input.hb = rmin < 45 && sp > 17 && Math.abs(err) > 0.12 ? 1 : 0;
        const slip = Math.abs(wrap(Math.atan2(car.vx, car.vz) - car.h)) * 180 / Math.PI;
        const off = Math.abs((car.x - g.P[i].x) * g.NM[i].x + (car.z - g.P[i].z) * g.NM[i].z);
        window.__stat = { slip: sp > 8 ? slip : 0, road: off < g.HALF - 2.5, sp };
      } else {
        // the highway: keep to the lane with the most room ahead, change lanes round the
        // traffic, brake when boxed in
        const T = __nd.traffic, lc = i => 6 - i * 4;
        const xOf = b => b.x !== undefined ? b.x : b.p > 0 ? lc(b.from) + (lc(b.to) - lc(b.from)) * b.p : lc(b.lane);
        const room = [0, 1, 2, 3].map(L => { let r = 120; for (const b of T.bots) { const dz = b.z - car.z; if (dz > -6 && dz < r && Math.abs(xOf(b) - lc(L)) < 3.2) r = dz; } return r; });
        const cur = Math.max(0, Math.min(3, Math.round((6 - car.x) / 4)));
        if (window.__lane === undefined) window.__lane = cur;
        let L = window.__lane;
        if (room[L] < 45) { let best = L; for (const k of [L - 1, L + 1, L - 2, L + 2]) if (k >= 0 && k < 4 && room[k] > room[best] + 10 && Math.abs(k - cur) <= 1) best = k; L = window.__lane = best; }
        const err = wrap(Math.atan2(lc(L) - car.x, 24) - car.h);
        input.right = err < -0.03 ? 1 : 0; input.left = err > 0.03 ? 1 : 0;
        input.down = room[cur] < 14 && sp > 20 ? 1 : 0; input.up = input.down ? 0 : 1;
        window.__stat = { slip: 0, road: __nd.G.state === 'race', sp };
      }
      requestAnimationFrame(tick);
    })();
  }, s.mode);
  await sleep(2500);                                    // up to speed first
  if (s.still) {
    // a frame with the car on the asphalt and sliding (or, failing that, on the road at all)
    let shot = null;
    for (let t = 0; t < 60 && !shot; t++) {
      // (on the highway: other cars close ahead, so the frame has company)
      const st = await page.evaluate(() => ({ ...window.__stat, near: __nd.traffic ? __nd.traffic.bots.filter(b => b.z - __nd.car.z > 6 && b.z - __nd.car.z < 40).length : 0 }));
      if (st.road && (s.mode === 'traffic' ? st.sp > 25 && (st.near >= 2 || t > 50) : st.slip > 12 || t > 40)) shot = await page.screenshot({ type: 'png' });
      else await sleep(300);
    }
    await ctx.close();
    if (!shot) throw new Error(`${s.name}: the car never stayed on the road`);
    await sharp(shot).resize(W, H).webp({ quality: 74 }).toFile(path.join(OUT, `${s.name}.webp`));
    console.log(`${s.name}: poster ${(fs.statSync(path.join(OUT, s.name + '.webp')).size / 1024).toFixed(0)} KB`);
    return;
  }
  const cdp = await ctx.newCDPSession(page), frames = [];
  cdp.on('Page.screencastFrame', async f => {
    frames.push({ t: f.metadata.timestamp, data: f.data, stat: await page.evaluate(() => window.__stat).catch(() => ({})) });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
  await sleep(s.seconds * 1000);
  if (process.env.DEBUG) console.log(s.name, await page.evaluate(() => ({ state: __nd.G.state, stat: window.__stat, cam: localStorage.getItem('nightdrift.trafficCam') })).catch(e => e.message));
  await cdp.send('Page.stopScreencast');
  await ctx.close();
  if (frames.length < 30) throw new Error(`${s.name}: only ${frames.length} frames recorded`);

  // the best stretch: every frame on the road; the most sliding (drift) or the most speed
  let best = null;
  for (let a = 0; a < frames.length; a++) {
    let b = a, score = 0, ok = true;
    while (b < frames.length && frames[b].t - frames[a].t < LOOP) { const st = frames[b].stat || {}; if (!st.road) { ok = false; break; } score += s.mode === 'track' ? Math.min(45, st.slip || 0) : st.sp || 0; b++; }
    if (!ok || b >= frames.length) continue;
    if (!best || score > best.score) best = { a, b, score };
  }
  if (!best) throw new Error(`${s.name}: no ${LOOP} s stretch with the car on the road`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nd-preview-'));
  const list = [];
  for (let k = best.a; k < best.b; k++) {
    const file = path.join(tmp, `f${String(k).padStart(5, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(frames[k].data, 'base64'));
    list.push(`file '${file}'`, `duration ${(frames[k + 1].t - frames[k].t).toFixed(4)}`);
  }
  fs.writeFileSync(path.join(tmp, 'list.txt'), list.join('\n'));
  const vf = `fps=${FPS},scale=${W}:${H}:flags=lanczos,format=yuv420p`;
  const enc = (args, out) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'list.txt'), '-vf', vf, '-an', ...args, '-movflags', '+faststart', out], { env: { ...process.env, SVT_LOG: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const fit = (make, out) => { for (const q of [0, 3, 6, 9, 12]) { make(q, out); if (fs.statSync(out).size <= MAX) return; } throw new Error(out + ' is over 400 KB'); };
  fit((q, out) => enc(['-c:v', 'libx264', '-preset', 'slow', '-crf', String(27 + q), '-profile:v', 'high', '-tag:v', 'avc1'], out), path.join(OUT, `${s.name}.mp4`));
  const av1 = execFileSync('ffmpeg', ['-hide_banner', '-encoders']).toString().includes('libsvtav1')
    ? q => ['-c:v', 'libsvtav1', '-preset', '6', '-crf', String(38 + q)] : q => ['-c:v', 'libaom-av1', '-cpu-used', '4', '-crf', String(36 + q), '-b:v', '0'];
  fit((q, out) => enc(av1(q), out), path.join(OUT, `${s.name}-av1.mp4`));
  await sharp(Buffer.from(frames[best.a].data, 'base64')).resize(W, H).webp({ quality: 74 }).toFile(path.join(OUT, `${s.name}.webp`));
  fs.rmSync(tmp, { recursive: true, force: true });
  const kb = f => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB';
  console.log(`${s.name}: ${best.b - best.a} frames, ${((frames[best.b].t - frames[best.a].t)).toFixed(2)} s; ${s.name}.mp4 ${kb(s.name + '.mp4')}, ${s.name}-av1.mp4 ${kb(s.name + '-av1.mp4')}, poster ${kb(s.name + '.webp')}`);
}
