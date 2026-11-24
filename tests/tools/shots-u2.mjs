// Screenshots of the home deck for review (no window: headless Chrome on the GPU).
//   ND_PORT=4210 OUT=dir node tests/tools/shots-u2.mjs [mock]
import { chromium } from 'playwright-core';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = +process.env.ND_PORT || 4210, OUT = process.env.OUT || '/tmp';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--disable-accelerated-video-decode'] });
const mock = process.argv.includes('mock');
const sizes = [[1440, 900, 'd'], [390, 844, 'p'], [844, 390, 'l'], [1000, 640, 'm']];
try {
  for (const [w, h, tag] of sizes) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, hasTouch: tag !== 'd', reducedMotion: process.env.RM ? 'reduce' : 'no-preference' });
    await ctx.route(/three\.min\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
    await ctx.route(/GLTFLoader\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js'), contentType: 'text/javascript' }));
    await ctx.route(/unpkg\.com\/colyseus\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/colyseus.js/dist/colyseus.js'), contentType: 'text/javascript' }));
    const p = await ctx.newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
    if (mock) { await p.goto(`http://localhost:${PORT}/dev/menu-d.html`); await sleep(2500); await p.screenshot({ path: `${OUT}/mock-${w}.png` }); await ctx.close(); continue; }
    await p.goto(`http://localhost:${PORT}/?debug&server=ws://localhost:${PORT}`);
    await p.waitForFunction(() => window.__nd, null, { timeout: 30000 }); await sleep(3500);
    await p.screenshot({ path: `${OUT}/home-${w}.png` });
    await p.keyboard.press('ArrowRight'); await sleep(900);
    await p.screenshot({ path: `${OUT}/home-traffic-${w}.png` });
    await p.keyboard.press('ArrowLeft'); await sleep(500); await p.keyboard.press('Enter'); await sleep(1200);
    await p.screenshot({ path: `${OUT}/maps-${w}.png` });
    await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); await sleep(900);
    await p.screenshot({ path: `${OUT}/maps-serp-${w}.png` });
    await p.keyboard.press('Escape'); await sleep(700);
    await p.keyboard.press('End'); await p.keyboard.press('ArrowLeft'); await sleep(500); await p.keyboard.press('Enter'); await sleep(1000);
    await p.screenshot({ path: `${OUT}/friends-${w}.png` });
    await p.keyboard.press('ArrowRight'); await sleep(800);
    await p.screenshot({ path: `${OUT}/friends-join-${w}.png` });
    await p.keyboard.press('ArrowLeft'); await sleep(300); await p.keyboard.press('Enter'); await sleep(1000);
    await p.screenshot({ path: `${OUT}/room-${w}.png` });
    // the mouse: a click on a card not in focus brings it to the middle
    if (tag === 'd') { await p.keyboard.press('Escape'); await sleep(600); await p.keyboard.press('Escape'); await sleep(600);
      await p.click('#dTraffic'); await sleep(500);
      console.log('click focuses, stays:', await p.evaluate(() => [document.querySelector('#homeDeck [aria-selected=true]').id, document.querySelector('#homeDeck [role=listbox]:not([inert])').getAttribute('aria-label')].join(' ')));
      await p.screenshot({ path: `${OUT}/home-click-${w}.png` }); }
    const sw = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    console.log(w, 'hscroll', sw, 'errors', errs.slice(0, 5).join(' | ') || 'none');
    await ctx.close();
  }
} finally { await browser.close(); }
