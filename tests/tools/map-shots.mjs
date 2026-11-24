// Screenshots of places on the maps (plan 3, stage 2: the shortcuts' mouths, the banks, the
// ground). Starts the server and a browser with no window, starts a solo drift run, holds the
// countdown, switches maps and puts the camera where each shot says.
//
//   node tests/tools/map-shots.mjs [--headed] [--out DIR] [--from DIR] [shot ...]
//   (--headed: no window either, drawn on the real GPU; ND_PORT: the server's port)
// A shot: the map, ?debug=hit or not, and either a camera (cam, look: world x, y, z) or a
// car on track point `car` seen by the race camera.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { launchOptions } from '../browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.ND_PORT) || 2598;
const argv = process.argv.slice(2), oi = argv.indexOf('--out');
const OUT = oi >= 0 ? argv[oi + 1] : path.join(os.tmpdir(), 'nd-shots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const SHOTS = {
  'razvyazka-cut0-mouth': { map: 'razvyazka', debug: true, cam: [622, 46, 100], look: [640, 0, 80] },
  'serpantin-cut0-mouth': { map: 'serpantin', debug: true, cam: [335, 40, -185], look: [353, 0, -201] },
  'pereval-1553-bank': { map: 'pereval', debug: true, car: 1528 },
  'pereval-1553-side': { map: 'pereval', debug: true, cam: [-46, 6, 28], look: [-21, -1.5, 20] },
  'razvyazka-1650': { map: 'razvyazka', debug: true, car: 1625 },
  'razvyazka-cut0-mouth-race': { map: 'razvyazka', debug: false, car: 612 },
  'neon-race': { map: 'neon', debug: false, car: 640 },
  'neon-hairpin': { map: 'neon', debug: false, cam: [-120, 45, 95], look: [-94, 0, 53] },
  'razvyazka-cut0-mouth-plain': { map: 'razvyazka', debug: false, cam: [622, 30, 104], look: [640, 0, 80] },
};
const names = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out' && argv[i - 1] !== '--from');
const todo = names.length ? names : Object.keys(SHOTS);
for (const n of todo) if (!SHOTS[n]) { console.error(`unknown shot ${n} (${Object.keys(SHOTS).join(', ')})`); process.exit(1); }

const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const browser = await chromium.launch(launchOptions(process.argv));
const errors = [];
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch {} await sleep(200); }
  fs.mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route(/three\.min\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/GLTFLoader\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js'), contentType: 'text/javascript' }));
  await ctx.route(/unpkg\.com\/colyseus\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/colyseus.js/dist/colyseus.js'), contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  // --from DIR: the game's scripts from another copy (DIR/public/js: a before picture)
  const fi = argv.indexOf('--from');
  if (fi >= 0) await ctx.route(/\/js\/.*\.js(\?.*)?$/, r => { const f = path.join(argv[fi + 1], 'public', new URL(r.request().url()).pathname);
    return fs.existsSync(f) ? r.fulfill({ path: f, contentType: 'text/javascript' }) : r.continue(); });
  for (const debug of [true, false]) {
    const list = todo.filter(n => !!SHOTS[n].debug === debug); if (!list.length) continue;
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://localhost:${PORT}/?debug${debug ? '=hit' : ''}&server=ws://localhost:${PORT}`);
    await page.waitForFunction(() => window.__nd && __nd.car.model, null, { timeout: 60000 });
    await page.click('#goSolo'); await sleep(600); await page.click('#mTrack');
    await page.waitForFunction(() => !document.getElementById('pGarage').hidden);
    await sleep(800); await page.click('#garGo');
    await page.waitForFunction(() => __nd.G.state === 'count');
    for (const n of list) {
      const s = SHOTS[n];
      await page.evaluate(async s => {
        const T = await import('/js/modes/track/geometry.js'), { G, car, camera } = __nd;
        G.cd = 1e6; G.setSoloMap(s.map);
        const i = s.car !== undefined ? s.car : T.START; T.placeAt(car, i);
        if (!T.FLAT) car.y = T.surface(car).y;
        const own = G.mode.camera; G.mode.__cam = G.mode.__cam || own;
        G.mode.camera = s.cam ? () => { camera.position.set(...s.cam); camera.lookAt(...s.look); camera.fov = 62; camera.updateProjectionMatrix(); } : G.mode.__cam;
      }, s);
      await sleep(s.debug ? 4500 : 2500);           // the overlay measures its lines in idle moments
      const file = path.join(OUT, `s2-${n}${fi >= 0 ? '-before' : ''}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
    await page.close();
  }
} finally {
  await browser.close();
  server.kill();
}
if (errors.length) { console.log('page errors:\n' + errors.join('\n')); process.exitCode = 1; }
