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
// The map (stage 6): «Карта» in solo «Дрифт» only; the picker's cards (blueprint, length,
// difficulty, badges, my records), keys (arrows, Enter, Esc), the pick remembered over a
// reload, and the run starting on that map.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { launchOptions, onGpu } from '../browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEADED = onGpu();             // --headed: no window, real GPU; --show: a visible window
const PORT = +process.env.ND_PORT || 2597;     // ND_PORT: another port when this one is taken
// a home card: the first click brings it to the middle, a click on the card in the middle goes in
const enterCard = async (p, sel) => { await p.click(sel); await sleep(400); if (await p.$eval(sel, e => !e.closest('[hidden], [inert]') && e.getAttribute('aria-selected') === 'true').catch(() => false)) await p.click(sel); };
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
  // a first visit: defaults (once: a reload later keeps what was picked)
  await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('seeded')) { localStorage.clear(); sessionStorage.setItem('seeded', '1'); } } catch {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?debug`);
  await page.waitForFunction(() => window.__nd);
  const soft = await page.evaluate(() => { const g = __nd.renderer.getContext(), e = g.getExtension('WEBGL_debug_renderer_info'); return /swiftshader|llvmpipe/i.test(e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : ''); });
  const $ = (sel, fn) => page.$eval(sel, fn);

  // to the garage: home «Дрифт» → the map deck (on the solo map) → in
  await enterCard(page, '#dTrack');
  await page.waitForFunction(() => document.querySelector('#homeDeck [role=listbox]:not([inert])')?.getAttribute('aria-label') === 'Карта');
  check('the map deck opens on the solo map, «Ночной город»', await page.$eval('#homeDeck [role=listbox]:not([inert]) [aria-selected=true]', e => e.id) === 'map-neon');
  await enterCard(page, '#map-neon');
  await page.waitForFunction(() => !document.getElementById('pGarage').hidden);
  await page.waitForFunction(() => __nd && /, цвет /.test(document.getElementById('garStand').getAttribute('aria-label')), null, { timeout: 30000 });
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

  // the map: «Карта» with the map's name, the picker, keys
  check('«Карта» in solo «Дрифт», with the map\'s name', !(await $('#garMap', e => e.hidden)) && await $('#garMapName', e => e.textContent) === 'Ночной город');
  await page.click('#garMap'); await sleep(350);
  const cards = await page.evaluate(() => [...document.querySelectorAll('#mapGrid .map-card')].map(c => ({ id: c.dataset.map, sel: c.getAttribute('aria-selected'), svg: !!c.querySelector('svg.bp .bp-road'), start: !!c.querySelector('.bp-arrow'), bridge: c.querySelectorAll('.bp-shadow').length, cut: c.querySelectorAll('.bp-cut').length, name: c.querySelector('.map-name').textContent, tags: [...c.querySelectorAll('.map-tag')].map(t => t.textContent).join(','), rec: [...c.querySelectorAll('.map-rec .num')].map(n => n.textContent).join(' ') })));
  const focus0 = await page.evaluate(() => document.activeElement.dataset.map);
  check('the picker opens: six maps, «Ночной город» picked and focused', await page.evaluate(() => document.getElementById('mapPop').matches(':popover-open')) && cards.length === 6 && cards[0].sel === 'true' && focus0 === 'neon' && await $('#garMap', e => e.getAttribute('aria-expanded')) === 'true', JSON.stringify(cards.map(c => c.id)));
  check('every card: a blueprint with the start arrow, a name, no record yet', cards.every(c => c.svg && c.start && c.name && c.rec === '— —'));
  const by = Object.fromEntries(cards.map(c => [c.id, c]));
  check('bridges drawn over (a shadow), shortcuts dashed, the badges', by.estakada.bridge > 0 && by.neon.bridge === 0 && by.serpantin.cut === 3 && by.razvyazka.cut === 4 && by.serpantin.tags === 'срезка' && by.parking.tags === 'этажи' && by.razvyazka.tags === 'мост,уклоны,срезка' && by.neon.tags === '', JSON.stringify(cards.map(c => c.id + ':' + c.tags)));
  check('aria: a listbox of options, one selected', await page.evaluate(() => document.getElementById('mapGrid').getAttribute('role') === 'listbox' && document.querySelectorAll('#mapGrid [role=option][aria-selected=true]').length === 1));
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  const f2 = await page.evaluate(() => document.activeElement.dataset.map);
  await page.keyboard.press('ArrowDown');
  const f3 = await page.evaluate(() => document.activeElement.dataset.map);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  const f4 = await page.evaluate(() => document.activeElement.dataset.map);
  check('arrows move between the cards (→ → ↓, ← stops at the edge)', f2 === 'serpantin' && f3 === 'razvyazka' && f4 === 'parking', [f2, f3, f4].join(' '));
  await page.keyboard.press('Escape'); await sleep(300);
  check('Esc closes the picker: no change, the garage stays, focus back on «Карта»', !(await page.evaluate(() => document.getElementById('mapPop').matches(':popover-open'))) && !(await $('#pGarage', e => e.hidden)) && await page.evaluate(() => __nd.G.soloMap) === 'neon' && await page.evaluate(() => document.activeElement.id) === 'garMap');
  await page.click('#garMap'); await sleep(300);
  const t1 = await page.evaluate(() => performance.now());
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('garMapName').textContent === 'Паркинг');
  const switched = await page.evaluate(async t => { const g = await import('/js/modes/track/geometry.js'); return { map: g.MAP.id, ms: performance.now() - t, saved: localStorage.getItem('nightdrift.map'), open: document.getElementById('mapPop').matches(':popover-open'), focus: document.activeElement.id }; }, t1);
  check('Enter picks «Паркинг»: the button says it, the track is switched, it is remembered', switched.map === 'parking' && switched.saved === 'parking' && !switched.open && switched.focus === 'garMap', JSON.stringify(switched));

  // Esc again: back to the modes, nothing saved
  await page.keyboard.press('Escape'); await sleep(500);
  check('Esc: back to the map deck, the pick dropped', !(await $('#pHome', e => e.hidden)) && await page.evaluate(() => localStorage.getItem('nightdrift.car')) === null);
  check('the map deck has the picked map, «Паркинг», in the middle', await page.$eval('#homeDeck [role=listbox]:not([inert]) [aria-selected=true]', e => e.id) === 'map-parking');
  // «Трасса» has no map
  await page.keyboard.press('Escape'); await sleep(500);
  await enterCard(page, '#dTraffic'); await page.waitForFunction(() => !document.getElementById('pGarage').hidden); await sleep(300);
  check('«Трасса»: no «Карта» in its garage', await $('#garMap', e => e.hidden));
  await page.keyboard.press('Escape'); await sleep(500);
  // a reload keeps the map
  await page.reload(); await page.waitForFunction(() => window.__nd);
  await sleep(600);

  // again, pick the Dodge in red and go (the deck opens on the remembered map)
  await enterCard(page, '#dTrack'); await sleep(400);
  await enterCard(page, '#map-parking'); await page.waitForFunction(() => !document.getElementById('pGarage').hidden); await sleep(300);
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
  const onMap = await page.evaluate(async () => { const g = await import('/js/modes/track/geometry.js'); return [g.MAP.id, __nd.G.soloMap]; });
  check('after a reload the run starts on the picked map, «Паркинг»', onMap.join() === 'parking,parking', onMap.join());

  // the last lap done: the finish screen; «В гараж» goes back to the garage
  await page.waitForFunction(() => __nd.G.state === 'race', null, { timeout: 10000 });
  await page.evaluate(async () => { const m = await import('/js/game.js'); __nd.G.lapT = 41.2; m.physicsHooks.onLap(); });
  await page.waitForFunction(() => __nd.G.state === 'over', null, { timeout: 5000 });
  check('after the last lap: the finish screen', /Финиш/.test(await $('#overTitle', e => e.textContent)) && /0:41\.20/.test(await $('#overStats', e => e.textContent)));
  await page.click('#overMenu'); await sleep(600);
  check('«В гараж»: back to the garage with that car', !(await $('#pGarage', e => e.hidden)) && await $('#garName', e => e.textContent) === 'Dodge');
  // the run's records are «Паркинг»'s, and its card says so
  await page.click('#garMap'); await sleep(300);
  const recs = await page.$$eval('#mapGrid .map-card', cs => Object.fromEntries(cs.map(c => [c.dataset.map, [...c.querySelectorAll('.map-rec .num')].map(n => n.textContent).join(' ')])));
  check('the card shows the new record on «Паркинг», the others none', /^0:41\.20 /.test(recs.parking) && recs.neon === '— —', JSON.stringify(recs));
  await page.keyboard.press('Escape'); await sleep(200);

  check('no errors in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
} finally {
  await browser.close();
  server.kill();
}
const bad = results.filter(r => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
