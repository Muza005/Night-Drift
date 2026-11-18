// The car stand (public/js/ui/stand.js) in a real browser, on public/dev/stand.html.
//
//   npm run test:stand                  (needs `npm install` in server/ and Chrome)
//   npm run test:stand -- --headed      (a real window on the GPU: also checks 60 FPS
//                                         and that a hidden tab draws nothing)
//
// Checks: it turns by itself (one round in ~28 s); a mouse drag turns it under the
// pointer and holds still while held; a flick keeps it turning and slowing down, then
// the slow turn comes back; letting go of a still finger doesn't fling; a finger (touch)
// turns it too; with reduced motion it doesn't turn by itself; changing the car twice
// quickly leaves one car on the stand, the last one asked for; a hidden tab draws no frame.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const PORT = 2596;
const CHROME = process.env.CHROME_PATH;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TAU = Math.PI * 2, AUTO = TAU / 28;

async function startServer() {
  const proc = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return proc; } catch {}
    await sleep(200);
  }
  proc.kill(); throw new Error('server did not start (did you run npm install in server/?)');
}

async function newContext(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opts });
  // the CDN libraries from node_modules: works offline
  await ctx.route(/three\.min\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/GLTFLoader\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js'), contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}
async function openStand(ctx, errors) {
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/dev/stand.html`);
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  await sleep(300);
  return page;
}
const spin = page => page.evaluate(() => __stand.big.spin);
const box = page => page.evaluate(() => { const r = document.getElementById('big').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
const DRAG_TURN = 1.15 * Math.PI;

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  (' + info + ')' : ''}`); };

const server = await startServer();
const browser = await chromium.launch({
  headless: !HEADED,
  ...(CHROME ? { executablePath: CHROME } : {}),
  args: HEADED ? ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
try {
  const ctx = await newContext(browser);
  const page = await openStand(ctx, errors);
  const gpu = await page.evaluate(() => { const g = __stand.renderer.getContext(), e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; });
  const soft = /swiftshader|llvmpipe/i.test(gpu);
  console.log('GPU:', gpu);

  // 1. by itself, about one round in 28 s
  { const a = await spin(page); await sleep(2000); const b = await spin(page);
    const v = (b.angle - a.angle) / 2;
    check('turns by itself, ~1 round / 28 s', Math.abs(v - AUTO) < AUTO * 0.2, `${(TAU / v).toFixed(1)} s per round`); }

  // 2. frames per second (only meaningful on a GPU)
  // The ceiling is what the same canvas gives with nothing on it (only cleared every
  // frame): on some systems compositing a WebGL canvas alone costs a few frames a second.
  { const rate = p => p.evaluate(() => new Promise(done => {
      // frames per second from the page's own clock, over 3 s
      let n = 0, t0 = 0; const tick = t => { if (!t0) t0 = t; n++; if (t - t0 < 3000) requestAnimationFrame(tick); else done((n - 1) * 1000 / (t - t0)); };
      requestAnimationFrame(tick); }));
    const fps = await rate(page);
    await page.evaluate(() => { __stand.saved = __stand.stands.splice(0); });
    const empty = await rate(page);
    await page.evaluate(() => { __stand.stands.push(...__stand.saved); });
    if (soft) check('frame rate (software renderer: not judged)', true, `${fps.toFixed(0)} FPS`);
    else check('full frame rate with four stands drawn', fps >= empty * 0.97, `${fps.toFixed(1)} FPS, the empty canvas gives ${empty.toFixed(1)}`); }

  // 3. a mouse drag: the stand follows the pointer, and holds still while held
  { const r = await box(page), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await page.mouse.move(cx, cy); await page.mouse.down();
    const a = await spin(page);
    await page.mouse.move(cx + 300, cy, { steps: 20 });
    const b = await spin(page);
    const want = 300 / r.w * DRAG_TURN;
    check('drag turns it with the pointer', Math.abs((b.angle - a.angle) - want) < want * 0.08, `${(b.angle - a.angle).toFixed(3)} rad, want ${want.toFixed(3)}`);
    await sleep(500); const c = await spin(page);
    check('held still: no turning under the pointer', c.held && Math.abs(c.angle - b.angle) < 1e-6 && c.vel === 0);
    // let go of a still pointer: no fling
    await sleep(150); await page.mouse.up(); await sleep(50);
    const d = await spin(page);
    check('let go of a still pointer: no fling', Math.abs(d.vel) < 0.05, `vel ${d.vel.toFixed(3)}`); }

  // 4. a flick: it keeps turning, slows down, then the slow turn comes back
  { await sleep(2600);
    const r = await box(page), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await page.mouse.move(cx - 200, cy); await page.mouse.down();
    await page.mouse.move(cx + 200, cy, { steps: 6 });
    await page.mouse.up();
    const a = await spin(page);
    check('a flick keeps it turning fast', a.vel > 4 * AUTO, `${a.vel.toFixed(2)} rad/s`);
    await sleep(900); const b = await spin(page);
    check('…and it slows down', b.vel < a.vel * 0.4 && b.vel >= 0, `${a.vel.toFixed(2)} → ${b.vel.toFixed(3)} rad/s`);
    await sleep(3200); const c = await spin(page);
    check('…then the slow turn comes back', Math.abs(c.vel - AUTO) < AUTO * 0.1, `${c.vel.toFixed(3)} rad/s`); }

  // 5. a flick the other way turns it the other way
  { const r = await box(page), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    await page.mouse.move(cx + 200, cy); await page.mouse.down();
    await page.mouse.move(cx - 200, cy, { steps: 6 }); await page.mouse.up();
    const a = await spin(page);
    check('a flick to the left turns it backwards', a.vel < -4 * AUTO, `${a.vel.toFixed(2)} rad/s`); }

  // 6. changing the car twice quickly: one car, the last one asked for
  { const n = await page.evaluate(async () => {
      const s = __stand.big; const p1 = s.setCar('gtr', -1), p2 = s.setCar('rx7', -1); await Promise.all([p1, p2]);
      const cars = s.scene.children.find(o => o.type === 'Group').children.filter(o => o.type !== 'Mesh');
      return { id: s.car.carId, cars: cars.length, label: document.getElementById('big').getAttribute('aria-label') };
    });
    check('two quick changes: one car on the stand, the last one', n.id === 'rx7' && n.cars === 1, JSON.stringify(n)); }

  // 7. repaint is immediate
  { const ok = await page.evaluate(() => { const s = __stand.big; s.repaint(0x1fa34a); const c = s.car.paint.color.clone().convertLinearToSRGB(); return c.getHex() === 0x1fa34a && /зелёный/.test(document.getElementById('big').getAttribute('aria-label')); });
    check('repaint: at once, and the label says the colour', ok); }

  // 8. a hidden tab draws nothing
  { await sleep(3000);                                   // the flick above has settled
    const f0 = await page.evaluate(() => __stand.stat.frames);
    {
      // say the page is hidden, as the browser does when the player switches away
      // (a minimised window on Wayland stays "visible" to the page, so it can't be used)
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      await sleep(1200);
      const st = await page.evaluate(() => ({ frames: __stand.stat.frames, running: __stand.loop.running }));
      check('hidden tab: no frames drawn', st.frames - f0 <= 1 && !st.running, `frames +${st.frames - f0}`);
      await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
      await sleep(600);
    }
    const a = await spin(page), f1 = await page.evaluate(() => __stand.stat.frames); await sleep(500);
    const b = await spin(page), f2 = await page.evaluate(() => __stand.stat.frames);
    check('visible again: draws, and no jump', f2 > f1 && Math.abs(b.angle - a.angle) < 0.5, `+${f2 - f1} frames, ${(b.angle - a.angle).toFixed(3)} rad`); }
  await ctx.close();

  // 9. a finger on a phone
  { const tctx = await newContext(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const p = await openStand(tctx, errors);
    const r = await box(p), cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const cdp = await tctx.newCDPSession(p);
    const touch = (type, x) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y: cy, id: 1 }] });
    const a = await spin(p);
    await touch('touchStart', cx - 80);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', cx - 80 + i * 16); await sleep(16); }
    const b = await spin(p);
    await touch('touchEnd');
    const want = 160 / r.w * DRAG_TURN;
    check('a finger turns it', b.held && Math.abs((b.angle - a.angle) - want) < want * 0.25, `${(b.angle - a.angle).toFixed(3)} rad, want ${want.toFixed(3)}`);
    await tctx.close(); }

  // 10. reduced motion: no turning by itself (a hand still turns it)
  { const rctx = await newContext(browser, { reducedMotion: 'reduce' });
    const p = await openStand(rctx, errors);
    const a = await spin(p); await sleep(1000); const b = await spin(p);
    check('reduced motion: does not turn by itself', Math.abs(b.angle - a.angle) < 1e-6);
    await rctx.close(); }

  check('no errors in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}
const bad = results.filter(r => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
