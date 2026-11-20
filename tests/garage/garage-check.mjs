// The garage and the solo run in a real browser (the game itself, not a test page).
//
//   npm run test:garage                (needs `npm install` in server/ and Chrome)
//   npm run test:garage -- --headed    (a real window on the GPU: also judges frame times)
//
// Checks the stage's "done" list: all 8 cars there and back without a freeze (no long
// task over 50 ms once a model is loaded; frame times on a GPU), no wrapping at the ends,
// the palette opens and closes on a click elsewhere, a repaint is immediate, the bars
// compare with the car you came with, keys (← → Esc Enter), and the solo run starting
// with the picked car, its model and the gear settings; drift ends after its laps.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { launchOptions, onGpu } from '../browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEADED = onGpu();             // --headed: no window, real GPU; --show: a visible window
const PORT = 2597;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function startServer() {
  const proc = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return proc; } catch {}
    await sleep(200);
  }
  proc.kill(); throw new Error('server did not start (did you run npm install in server/?)');
}
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? '  (' + info + ')' : ''}`); };

const server = await startServer();
const browser = await chromium.launch(launchOptions(process.argv, []));
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/three\.min\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/GLTFLoader\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js'), contentType: 'text/javascript' }));
  await ctx.route(/unpkg\.com\/colyseus\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/colyseus.js/dist/colyseus.js'), contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch {} });   // a first visit: defaults
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?debug`);
  await page.waitForFunction(() => window.__nd);
  const soft = await page.evaluate(() => { const g = __nd.renderer.getContext(), e = g.getExtension('WEBGL_debug_renderer_info'); return /swiftshader|llvmpipe/i.test(e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : ''); });
  const $ = (sel, fn) => page.$eval(sel, fn);

  // to the garage: Одиночная → Дрифт
  await page.click('#goSolo'); await sleep(450); await page.click('#mTrack');
  await page.waitForFunction(() => !document.getElementById('pGarage').hidden);
  await page.waitForFunction(() => __nd && document.getElementById('garStand').getAttribute('aria-label'), null, { timeout: 30000 });
  check('the garage opens with the first car, factory paint', await $('#garName', e => e.textContent) === 'Aston Martin' && await $('#paintName', e => e.textContent) === 'Заводской');
  check('first car: «‹» is off', await $('#garPrev', e => e.disabled) && !(await $('#garNext', e => e.disabled)));
  check('the title is the mode, the button «Поехали»', await $('#garTitle', e => e.textContent) === 'Дрифт' && await $('#garGo', e => e.textContent) === 'Поехали');

  // load every model once (as a player browsing would), then measure a pass there and back
  for (let i = 0; i < 7; i++) { await page.keyboard.press('ArrowRight'); await sleep(350); }
  for (let i = 0; i < 7; i++) { await page.keyboard.press('ArrowLeft'); await sleep(350); }
  await page.evaluate(() => {
    window.__long = []; new PerformanceObserver(l => { for (const e of l.getEntries()) __long.push(e.duration); }).observe({ type: 'longtask' });
    window.__frames = []; let last = 0; const f = t => { if (last) __frames.push(t - last); last = t; if (window.__frames.length < 100000) requestAnimationFrame(f); }; requestAnimationFrame(f);
  });
  for (let i = 0; i < 7; i++) { await page.click('#garNext'); await sleep(520); }
  check('last car: «›» is off, no wrapping', await $('#garNext', e => e.disabled) && await $('#garName', e => e.textContent) === 'Rally');
  await page.click('#garNext', { force: true }); await sleep(200);
  check('«›» at the end does nothing', await $('#garName', e => e.textContent) === 'Rally');
  for (let i = 0; i < 7; i++) { await page.click('#garPrev'); await sleep(520); }
  const perf = await page.evaluate(() => { const f = __frames.slice().sort((a, b) => a - b); return { long: __long, worst: f[f.length - 1], p99: f[Math.floor(f.length * 0.99)], median: f[f.length >> 1] }; });
  // (a software renderer draws on the CPU: every frame is a long task there, so only a GPU is judged)
  if (soft) check('long tasks and frame times (software renderer: not judged)', true, `median frame ${perf.median.toFixed(1)} ms`);
  else check('8 cars there and back: no task over 50 ms', perf.long.length === 0, perf.long.map(Math.round).join(', '));
  if (!soft) check('8 cars there and back: no frame over 50 ms', perf.worst < 50, `median ${perf.median.toFixed(1)}, p99 ${perf.p99.toFixed(1)}, worst ${perf.worst.toFixed(1)} ms`);

  // the bars: Skyline against the Aston Martin it came from
  await page.click('#garNext'); await sleep(600);
  const bars = await page.$$eval('#garStats .stat', rows => rows.map(r => r.querySelector('.stat-delta').textContent));
  check('the bars compare with the car you came with', bars.join(' ') === '−1 +1,5 +1 +2 +2,5', bars.join(' '));

  // the palette: opens, the car moves aside, a colour is on at once, a click elsewhere closes it
  await page.click('#garPaint'); await sleep(350);
  const open = await page.evaluate(() => ({ open: document.getElementById('garPaintPop').matches(':popover-open'), aside: document.getElementById('pGarage').classList.contains('painting') }));
  check('the palette opens and the car moves aside', open.open && open.aside);
  const t0 = Date.now();
  await page.click('#garSwatches button[aria-label="Красный"]');
  const painted = await page.evaluate(() => { const c = __nd.renderer && document.getElementById('garStand').getAttribute('aria-label'); return c; });
  check('a colour is on at once', /цвет красный/.test(painted) && Date.now() - t0 < 500, painted);
  await page.mouse.click(200, 400); await sleep(350);
  const closed = await page.evaluate(() => ({ open: document.getElementById('garPaintPop').matches(':popover-open'), aside: document.getElementById('pGarage').classList.contains('painting') }));
  check('a click elsewhere closes it, the car comes back', !closed.open && !closed.aside);

  // the gear: laps 1..10, remembered; Esc closes it and stays in the garage
  await page.click('#garSet'); await sleep(250);
  for (let i = 0; i < 12; i++) await page.click('#lapsUp', { force: true });
  const top = await $('#lapsOut', e => e.textContent);
  for (let i = 0; i < 12; i++) await page.click('#lapsDown', { force: true });
  const bottom = await $('#lapsOut', e => e.textContent);
  check('laps stay within 1…10', top === '10' && bottom === '1', `${bottom}…${top}`);
  await page.keyboard.press('Escape'); await sleep(300);
  check('Esc closes the settings, the garage stays', !(await $('#pGarage', e => e.hidden)) && !(await page.evaluate(() => document.getElementById('garSetPop').matches(':popover-open'))));

  // Esc again: back to the modes, nothing saved
  await page.keyboard.press('Escape'); await sleep(500);
  check('Esc: back to the mode cards, the pick dropped', !(await $('#pModes', e => e.hidden)) && await page.evaluate(() => localStorage.getItem('nightdrift.car')) === null);

  // again, pick the Dodge in red and go
  await page.click('#mTrack'); await page.waitForFunction(() => !document.getElementById('pGarage').hidden); await sleep(300);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await sleep(120); }
  await page.click('#garPaint'); await page.click('#garSwatches button[aria-label="Красный"]'); await page.keyboard.press('Escape');
  // (closing a popover gives focus back to its button, where Enter is that button's own)
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('Enter');                              // Enter: the main button
  await page.waitForFunction(() => __nd.G.state === 'count' || __nd.G.state === 'race');
  await page.waitForFunction(() => __nd.car.model && __nd.car.model.carId === 'muscle', null, { timeout: 20000 });
  const run = await page.evaluate(() => ({ car: __nd.car.carId, paint: __nd.car.paintHex, model: __nd.car.model.carId, wheels: __nd.car.wheels.length, lap: document.getElementById('lapn').textContent, saved: [localStorage.getItem('nightdrift.car'), localStorage.getItem('nightdrift.paint')] }));
  check('the run starts with the picked car, its model and paint', run.car === 'muscle' && run.model === 'muscle' && run.paint === 0xd3202a && run.wheels === 4, JSON.stringify(run));
  check('…and the pick is remembered', run.saved[0] === 'muscle' && run.saved[1] === String(0xd3202a));
  check('one lap set: the HUD says 1 / 1', run.lap === '1 / 1');

  // the last lap done: the finish screen; «В гараж» goes back to the garage
  await page.waitForFunction(() => __nd.G.state === 'race', null, { timeout: 10000 });
  await page.evaluate(async () => { const m = await import('/js/game.js'); __nd.G.lapT = 41.2; m.physicsHooks.onLap(); });
  await page.waitForFunction(() => __nd.G.state === 'over', null, { timeout: 5000 });
  check('after the last lap: the finish screen', /Финиш/.test(await $('#overTitle', e => e.textContent)) && /0:41\.20/.test(await $('#overStats', e => e.textContent)));
  await page.click('#overMenu'); await sleep(600);
  check('«В гараж»: back to the garage with that car', !(await $('#pGarage', e => e.hidden)) && await $('#garName', e => e.textContent) === 'Dodge');

  check('no errors in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}
const bad = results.filter(r => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
