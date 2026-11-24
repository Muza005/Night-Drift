// The lobby's seat cards show each player's car as a side silhouette in its paint. They are
// drawn from the game's own 3D models (no window: headless Chrome on the GPU): every car seen
// straight from its left side, nose to the right, with an orthographic camera at one scale for
// all (so a long car is long and a tall one tall), the body white and everything else black
// (glass, tyres, lights, trim), on a transparent ground.
// Out: public/media/cars/<id>.webp, one per car. The lobby uses each twice as a CSS mask:
// by its alpha (the whole shape, dark) and by its luminance (the body, in the paint).
//
//   node tests/tools/make-silhouettes.mjs        (ND_PORT picks the server's port, CHROME_PATH the browser)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs'; import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'public/media/cars');
const PORT = +process.env.ND_PORT || 4231;
const W = 360, H = 120;                 // the picture (px): 4.3 m of car takes ~92 % of the width
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(ROOT, 'server'), env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) break; } catch {} await sleep(200); }
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}), args: ['--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
  await ctx.route(/three\.min\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/GLTFLoader\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js'), contentType: 'text/javascript' }));
  await ctx.route(/unpkg\.com\/colyseus\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/colyseus.js/dist/colyseus.js'), contentType: 'text/javascript' }));
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('page error:', e.message));
  await page.goto(`http://localhost:${PORT}/?debug&server=ws://localhost:${PORT}`);
  await page.waitForFunction(() => window.__nd, null, { timeout: 60000 });
  const shots = await page.evaluate(async ({ W, H }) => {
    const { CARS } = await import('/js/core/cars.js');
    const { makeModel } = await import('/js/core/carModels.js');
    const canvas = document.createElement('canvas');
    const r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(1); r.setSize(W * 2, H * 2, false); r.setClearColor(0x000000, 0);
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const black = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
    // one scale for all: 4.6 m across the picture, the ground 6 % above its bottom
    const span = 4.6, tall = span * H / W, ground = tall * 0.06;
    const cam = new THREE.OrthographicCamera(-span / 2, span / 2, tall - ground, -ground, 0.1, 50);
    cam.position.set(-20, 0, 0); cam.up.set(0, 1, 0); cam.lookAt(0, 0, 0);       // from the left side: the nose (+z) to the right
    cam.position.y = 0; cam.updateProjectionMatrix();
    const out = {};
    for (const c of CARS) {
      const inst = await makeModel(c.id, -1, null);
      inst.root.traverse(o => { if (o.isMesh) o.material = o.material === inst.paint ? white : black; });
      const scene = new THREE.Scene(); scene.add(inst.root);
      r.render(scene, cam);
      out[c.id] = canvas.toDataURL('image/png');
      inst.dispose();
    }
    return out;
  }, { W, H });
  fs.mkdirSync(OUT, { recursive: true });
  let total = 0;
  for (const [id, url] of Object.entries(shots)) {
    const file = path.join(OUT, id + '.webp');
    await sharp(Buffer.from(url.split(',')[1], 'base64')).resize(W, H).webp({ lossless: true, alphaQuality: 100 }).toFile(file);
    const n = fs.statSync(file).size; total += n;
    console.log(id, n, 'bytes');
  }
  console.log('total', total, 'bytes');
} finally { await browser.close(); server.kill(); }
