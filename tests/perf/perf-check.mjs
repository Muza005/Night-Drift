// Performance and memory of the menu screens (the game itself, in a real browser).
//
//   npm run test:perf -- --headed     (a real window on the GPU: the numbers that count)
//   npm run test:perf                 (software rendering: only the draw counts are judged)
//
// 1. Home and the mode cards, 10 s each: the race scene is not drawn under them (once
//    when the screen comes up, then never), and no task takes over 50 ms.
// 2. The garage: only the stand and the blurred still are drawn, never the race scene.
// 3. 50 flips through the cars (every model loaded once first): no task over 50 ms, and
//    nothing piles up: three.js geometries, textures and shader programs are back to the
//    same count, and the JS heap after garbage collection grows by under 3 MB.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { launchOptions, onGpu } from '../browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEADED = onGpu();             // --headed: no window, real GPU; --show: a visible window
const PORT = +process.env.ND_PORT || 2599;     // ND_PORT: another port when this one is taken
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
const browser = await chromium.launch(launchOptions(process.argv, ['--js-flags=--expose-gc']));
const errors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/three\.min\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/GLTFLoader\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js'), contentType: 'text/javascript' }));
  await ctx.route(/unpkg\.com\/colyseus\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/colyseus.js/dist/colyseus.js'), contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(() => { try { localStorage.clear(); } catch {} });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://localhost:${PORT}/?debug&server=ws://localhost:${PORT}`);
  await page.waitForFunction(() => window.__nd && __nd.car.model, null, { timeout: 60000 });
  const soft = await page.evaluate(() => { const g = __nd.renderer.getContext(), e = g.getExtension('WEBGL_debug_renderer_info'); return /swiftshader|llvmpipe/i.test(e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : ''); });
  // count what is drawn: the race scene, anything else; and long tasks
  await page.evaluate(() => {
    const r = __nd.renderer, draw = r.render.bind(r);
    // (core/warm.js draws the race scene once from under the garage, with its own camera, so
    // the first run does not start with shader compiling: counted apart, at most once a screen)
    window.__draws = { race: 0, other: 0, warm: 0 };
    r.render = (sc, cam) => { (sc === __nd.scene ? (cam && cam.name === 'warm' ? __draws.warm++ : __draws.race++) : __draws.other++); return draw(sc, cam); };
    window.__long = []; new PerformanceObserver(l => { for (const e of l.getEntries()) __long.push(Math.round(e.duration)); }).observe({ type: 'longtask' });
  });
  const reset = () => page.evaluate(() => { __draws.race = __draws.other = __draws.warm = 0; __long.length = 0; });
  const read = () => page.evaluate(() => ({ ...__draws, long: __long.slice() }));
  const longOk = l => soft || l.length === 0;            // software rendering: every frame is a long task

  // 1. home, 10 s (after a moment to settle: the first picture is taken on arrival)
  await sleep(1500); await reset(); await sleep(10000);
  let r = await read();
  check('home, 10 s: the race scene is not drawn under it', r.race === 0 && r.warm === 0, `race ${r.race}, warm-up ${r.warm}, other ${r.other}`);
  check('home, 10 s: no task over 50 ms', longOk(r.long), soft ? 'software renderer: not judged' : r.long.join(', '));
  await enterCard(page, '#dTrack'); await sleep(1500); await reset(); await sleep(10000);
  r = await read();
  check('map deck, 10 s: the race scene is not drawn, no task over 50 ms', r.race === 0 && r.warm === 0 && longOk(r.long), `race ${r.race}, warm-up ${r.warm}, long ${r.long.join(', ') || 'none'}`);

  // 2. the garage: the stand and the still only
  await enterCard(page, '#homeDeck [role=listbox]:not([inert]) [aria-selected=true]');
  await page.waitForFunction(() => !document.getElementById('pGarage').hidden && /, цвет /.test(document.getElementById('garStand').getAttribute('aria-label')));
  // every model once, as a player browsing would (loading is not what is measured)
  for (let i = 0; i < 7; i++) { await page.keyboard.press('ArrowRight'); await sleep(450); }
  for (let i = 0; i < 7; i++) { await page.keyboard.press('ArrowLeft'); await sleep(450); }
  await sleep(1500); await reset(); await sleep(3000);
  r = await read();
  check('garage: the stand is drawn, the race scene is not', r.race === 0 && r.warm <= 1 && r.other > 30, `race ${r.race}, warm-up ${r.warm}, other ${r.other}`);

  // 3. 50 flips, then the same counts
  const mem = async () => {
    await page.evaluate(() => window.gc && gc()); await sleep(300); await page.evaluate(() => window.gc && gc());
    return page.evaluate(() => ({ geo: __nd.renderer.info.memory.geometries, tex: __nd.renderer.info.memory.textures, prog: __nd.renderer.info.programs.length, heap: performance.memory ? performance.memory.usedJSHeapSize : 0 }));
  };
  const before = await mem();
  await reset();
  for (let i = 0; i < 50; i++) { await page.keyboard.press(Math.floor(i / 7) % 2 ? 'ArrowLeft' : 'ArrowRight'); await sleep(260); }
  // back to the first car, as before
  for (let i = 0; i < 8; i++) { await page.keyboard.press('ArrowLeft'); await sleep(200); }
  await sleep(1500);
  r = await read();
  const after = await mem();
  check('50 flips: no task over 50 ms', longOk(r.long), soft ? 'software renderer: not judged' : (r.long.join(', ') || 'none'));
  check('50 flips: geometries, textures and programs back to the same count', after.geo <= before.geo && after.tex <= before.tex && after.prog <= before.prog, `geo ${before.geo}→${after.geo}, tex ${before.tex}→${after.tex}, prog ${before.prog}→${after.prog}`);
  const grow = (after.heap - before.heap) / 1048576;
  check('50 flips: the JS heap after GC grows under 3 MB', grow < 3, `${(before.heap / 1048576).toFixed(1)} → ${(after.heap / 1048576).toFixed(1)} MB`);

  check('no errors in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}
const bad = results.filter(r => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
