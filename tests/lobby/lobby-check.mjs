// The lobby with three players in three real browsers (the game itself).
//
//   npm run test:lobby                (needs `npm install` in server/ and Chrome)
//   npm run test:lobby -- --headed    (three real windows)
//
// The stage's "done" list: everyone sees the same order (the host first, with the crown,
// then by who came in); the host's «Старт» lights only after the two others press
// «Готово»; the host's settings reach everyone, and only the host has the controls; «Авто»
// opens the garage and «Выбрать» brings the pick back; a rename reaches the others; the
// host sends one player out: that player sees the note and cannot come back; in the race
// every car is its player's model and paint, and every player has their seat's colour.
// The map (stage 6): only the host has «Карта» (a guest's message is refused too); the
// plate under the settings shows the map to all; a new map: the guests get a short note
// and every «Готово» goes; a player who comes in later sees the room's map; the race
// starts on it in all three browsers.
// «Призраки» (plan 3 stage 4b): off by default, shown to everyone in both modes, only the
// host can switch it (a guest's message is refused too), a change takes back every «Готово».
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { launchOptions, onGpu } from '../browser.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HEADED = onGpu();             // --headed: no window, real GPU; --show: a visible window
const PORT = +process.env.ND_PORT || 2598;     // ND_PORT: another port when this one is taken
// SHOT_DIR=dir: screenshots of the lobby with «Призраки» on (the host's and a guest's view)
const SHOT_DIR = process.env.SHOT_DIR;
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
async function player(name, x) {
  // (software rendering draws three games on the CPU: smaller windows, more patience)
  const ctx = await browser.newContext({ viewport: HEADED ? { width: 1280, height: 800 } : { width: 900, height: 600 } });
  ctx.setDefaultTimeout(HEADED ? 30000 : 120000);
  await ctx.route(/three\.min\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/build/three.min.js'), contentType: 'text/javascript' }));
  await ctx.route(/GLTFLoader\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/three/examples/js/loaders/GLTFLoader.js'), contentType: 'text/javascript' }));
  await ctx.route(/unpkg\.com\/colyseus\.js/, r => r.fulfill({ path: path.join(ROOT, 'node_modules/colyseus.js/dist/colyseus.js'), contentType: 'text/javascript' }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await ctx.addInitScript(n => { try { if (!sessionStorage.getItem('seeded')) { localStorage.clear(); localStorage.setItem('nightdrift.name', n); sessionStorage.setItem('seeded', '1'); } } catch {} }, name);
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(name + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(name + ': ' + m.text()); });
  await page.goto(`http://localhost:${PORT}/?debug&server=ws://localhost:${PORT}`);   // its own server, not one left on 2567
  try { await page.waitForFunction(() => window.__nd, null, { timeout: 120000 }); }
  catch (e) { throw new Error(name + ': the game did not start: ' + errors.join(' | ')); }
  return page;
}
// what a page shows in its list: [number, name, host?, ready?]
const listOf = p => p.$$eval('#plist .pl:not(.pl-empty)', rows => rows.map(r => [r.querySelector('.pl-num').textContent, r.querySelector('.pl-name').textContent.replace(' (вы)', ''), r.hasAttribute('data-host'), r.hasAttribute('data-ready')]));
const startOff = p => p.$eval('#startRace', b => b.getAttribute('aria-disabled') === 'true');

try {
  const [A, B, C] = [await player('Ann'), await player('Bob'), await player('Cid')];
  const CARS = await A.evaluate(async () => (await import('/js/core/cars.js')).CARS.map(c => [c.id, c.name]));

  // A makes a room from the Дрифт card; B and C come in by its code
  await enterCard(A, '#goOnline'); await sleep(400); await enterCard(A, '#fHost'); await sleep(400); await enterCard(A, '#rTrack');
  await A.waitForFunction(() => !document.getElementById('pLobby').hidden && document.getElementById('roomCode').textContent !== '----');
  const code = (await A.innerText('#roomCode')).trim();
  for (const p of [B, C]) {
    await enterCard(p, '#goOnline'); await sleep(400); await enterCard(p, '#fJoin'); await p.fill('#codeIn', code); await p.click('#joinRoom');
    await p.waitForFunction(() => !document.getElementById('pLobby').hidden);
    await sleep(300);                               // B is in before C: the order is by who came in
  }
  for (const p of [A, B, C]) await p.waitForFunction(() => document.querySelectorAll('#plist .pl:not(.pl-empty)').length === 3);
  const lists = await Promise.all([A, B, C].map(listOf));
  const want = JSON.stringify([['1', 'Ann', true, false], ['2', 'Bob', false, false], ['3', 'Cid', false, false]]);
  check('all three see the same list: host first with the crown, then by order', lists.every(l => JSON.stringify(l) === want), JSON.stringify(lists[1]));
  check('three free seats are left', await A.$$eval('#plist .pl-empty', e => e.length) === 3);
  // the first free seat invites: one press puts the room's link on the clipboard
  await A.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${PORT}` });
  check('only the first free seat invites', await A.$$eval('#plist .pl-empty', e => e.map(x => !x.querySelector('.pl-ask').hidden).join()) === 'true,false,false');
  await A.click('#plist .pl-invite .pl-ask');
  await A.waitForFunction(() => document.querySelector('#plist .pl-invite .pl-ask').hasAttribute('data-copied'), null, { timeout: 3000 }).catch(() => {});
  const link = await A.evaluate(() => navigator.clipboard.readText()).catch(e => 'unread: ' + e.message);
  check('«Позвать» copies the room\'s link (?room=CODE) and says so', new URL(link, 'http://x').searchParams.get('room') === code && /скопирована/.test(await A.innerText('#plist .pl-invite .pl-ask-sub')), link);
  // «Призраки» (stage 4b): the row is there only when the room's state has the setting
  const ghost = await A.evaluate(() => ({ hidden: document.getElementById('cfgGhost').hidden, known: typeof __nd.NET.room.state.ghostMode === 'boolean' }));
  check('«Призраки» shows only with a server that has it', ghost.hidden === !ghost.known, JSON.stringify(ghost));
  check('the host has «Старт», the others «Готово»', await A.innerText('#startRace') === 'Старт' && await B.innerText('#startRace') === 'Готово' && await C.innerText('#startRace') === 'Готово');

  // «Старт» lights only after both others are ready
  check('«Старт» is off while nobody is ready', await startOff(A));
  await B.click('#startRace');
  await A.waitForFunction(() => document.querySelector('#plist .pl:nth-child(2)').hasAttribute('data-ready'));
  check('one ready: the green ring on that player, «Старт» still off', await startOff(A) && (await listOf(C))[1][3] === true);
  await A.click('#startRace', { force: true }); await sleep(300);
  check('a press on the off «Старт» starts nothing, it says why', await A.evaluate(() => __nd.NET.room.state.phase) === 'lobby' && /Готово/.test(await A.innerText('#lobbyStatus')));
  await C.click('#startRace');
  await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'false');
  check('both ready: «Старт» lights, with its one flash', await A.$eval('#startRace', b => b.classList.contains('armed')));
  await C.click('#startRace');                    // C takes it back…
  await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'true');
  // the server's patch reaches A and C at slightly different moments: give C's own up to 2 s
  await C.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-pressed') === 'false', null, { timeout: 2000 }).catch(() => {});
  check('«Готово» pressed again takes it back: «Старт» goes off', await C.$eval('#startRace', b => b.getAttribute('aria-pressed')) === 'false');
  await C.click('#startRace');                    // …and presses it again
  await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'false');

  // the settings: the host's steppers, the others only see the value
  await A.click('#cfgLapsUp'); await A.click('#cfgLapsUp');
  await B.waitForFunction(() => document.getElementById('cfgLaps').textContent === '5');
  check('the host sets 5 laps, the others see 5', await C.innerText('#cfgLaps') === '5');
  check('only the host has the controls', await B.$eval('#cfgLapsUp', b => b.hidden) && await B.$eval('#cfgMode input', i => i.disabled) && !(await A.$eval('#cfgLapsUp', b => b.hidden)));

  // the highway: minutes (sent in seconds) and traffic, then back to the drift track
  await A.click('#cfgMode label:nth-child(2)');
  await B.waitForFunction(() => !document.getElementById('rowMins').hidden);
  await A.click('#cfgMinsUp'); await A.click('#cfgMinsUp'); await A.click('#cfgDens label:nth-child(3)');
  await B.waitForFunction(() => __nd.NET.room.state.duration === 300 && __nd.NET.room.state.density === 'high');
  check('«Трасса»: the host sets 5 minutes and high traffic, the others see them', await B.innerText('#cfgMins') === '5' && await B.$eval('#rowLaps', e => e.hidden) && await B.$eval('#cfgDens input[value="high"]', i => i.checked));
  check('«Трасса»: «Призраки» is there too', await B.$eval('#cfgGhost', e => !e.hidden && e.offsetParent !== null));
  await A.click('#cfgMode label:nth-child(1)');
  await B.waitForFunction(() => __nd.NET.room.state.mode === 'track');

  // «Призраки»: the host's switch, everyone sees it
  const ghostUi = p => p.evaluate(() => ({ shown: document.getElementById('cfgGhost').offsetParent !== null,
    on: document.querySelector('#cfgGhost input[value="on"]').checked, off: document.querySelector('#cfgGhost input[value="off"]').checked,
    locked: [...document.querySelectorAll('#cfgGhost input')].every(i => i.disabled), state: __nd.NET.room.state.ghostMode }));
  for (const p of [A, B, C]) await p.waitForFunction(() => document.querySelector('#cfgGhost input[value="off"]').checked);
  let gs = await Promise.all([A, B, C].map(ghostUi));
  check('«Призраки»: off by default, shown to everyone', gs.every(g => g.shown && g.off && !g.on && g.state === false), JSON.stringify(gs[1]));
  check('…only the host can switch it', !gs[0].locked && gs[1].locked && gs[2].locked);
  await B.evaluate(() => __nd.NET.room.send('config', { ghostMode: true })); await sleep(400);
  check('…a guest\'s message is refused, «Готово» stays', await A.evaluate(() => __nd.NET.room.state.ghostMode) === false && !(await startOff(A)));
  await A.click('#cfgGhost label:nth-child(2)');
  for (const p of [B, C]) await p.waitForFunction(() => document.querySelector('#cfgGhost input[value="on"]').checked);
  gs = await Promise.all([A, B, C].map(ghostUi));
  check('the host turns it on: everyone sees «Вкл»', gs.every(g => g.on && g.state === true));
  await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'true');
  check('…and every «Готово» is taken back', await B.$eval('#startRace', b => b.getAttribute('aria-pressed')) === 'false' && await C.$eval('#startRace', b => b.getAttribute('aria-pressed')) === 'false');
  if (SHOT_DIR) { await sleep(400); await A.screenshot({ path: path.join(SHOT_DIR, 'lobby-ghost-host.png') }); await B.screenshot({ path: path.join(SHOT_DIR, 'lobby-ghost-guest.png') }); }
  await A.click('#cfgGhost label:nth-child(1)');
  for (const p of [B, C]) await p.waitForFunction(() => document.querySelector('#cfgGhost input[value="off"]').checked);
  await B.click('#startRace'); await C.click('#startRace');
  await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'false');

  // the map: the plate for everyone, «Карта» for the host only
  const plate = p => p.evaluate(() => ({ shown: !document.getElementById('lobMap').hidden, name: document.getElementById('lobMapName').textContent, bp: !!document.querySelector('#lobMapThumb svg.dg') }));
  for (const p of [A, B, C]) await p.waitForFunction(() => !document.getElementById('lobMap').hidden);
  await A.waitForFunction(() => !document.getElementById('lobMapBtn').hidden);
  const plates = await Promise.all([A, B, C].map(plate));
  check('the plate in the settings panel: «Ночной город» with its diagram, for everyone', plates.every(x => x.shown && x.bp && x.name === 'Ночной город'), JSON.stringify(plates[1]));
  check('«Карта» for the host only', !(await A.$eval('#lobMapBtn', b => b.hidden)) && await B.$eval('#lobMapBtn', b => b.hidden) && await C.$eval('#lobMapBtn', b => b.hidden));
  await B.evaluate(() => document.getElementById('lobMapBtn').click()); await sleep(250);
  check('a guest cannot open the picker', !(await B.evaluate(() => document.getElementById('mapPop').matches(':popover-open'))));
  await B.evaluate(() => __nd.NET.room.send('config', { map: 'pereval' })); await sleep(400);
  check('…nor change the map (the server refuses it), «Готово» stays', await A.evaluate(() => __nd.NET.room.state.map) === 'neon' && await A.$eval('#startRace', b => b.getAttribute('aria-disabled')) === 'false');
  await A.click('#lobMapBtn');
  await A.waitForFunction(() => document.getElementById('mapPop').matches(':popover-open'));
  check('the host\'s «Карта» opens the picker on the room\'s map', await A.evaluate(() => document.activeElement.dataset.map) === 'neon' && await A.$$eval('#mapGrid .map-card', c => c.length) === 6);
  await A.keyboard.press('Escape'); await sleep(300);
  check('Esc closes the picker, the host stays in the lobby', !(await A.evaluate(() => document.getElementById('mapPop').matches(':popover-open'))) && !(await A.$eval('#pLobby', e => e.hidden)) && await A.evaluate(() => !!__nd.NET.room));
  await A.click('#lobMapBtn'); await A.waitForFunction(() => document.getElementById('mapPop').matches(':popover-open'));
  await A.keyboard.press('ArrowRight'); await A.keyboard.press('ArrowRight'); await A.keyboard.press('Enter');
  for (const p of [A, B, C]) await p.waitForFunction(() => document.getElementById('lobMapName').textContent === 'Серпантин');
  check('the host picks «Серпантин»: everyone\'s plate shows it', await B.evaluate(() => __nd.NET.room.state.map) === 'serpantin');
  const toast = p => p.evaluate(() => ({ open: document.getElementById('noteToast').matches(':popover-open'), info: document.getElementById('noteToast').hasAttribute('data-info'), text: document.getElementById('noteText').textContent }));
  const [tA, tB, tC] = await Promise.all([A, B, C].map(toast));
  check('the guests get a short note, the host none', tB.open && tC.open && tB.info && /Серпантин/.test(tB.text) && !tA.open, JSON.stringify(tB));
  await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'true');
  check('a new map: every «Готово» is taken back, «Старт» goes off', await B.$eval('#startRace', b => b.getAttribute('aria-pressed')) === 'false' && await C.$eval('#startRace', b => b.getAttribute('aria-pressed')) === 'false' && (await listOf(A)).every(r => !r[3]));
  const scene = p => p.evaluate(async () => (await import('/js/modes/track/geometry.js')).MAP.id);
  check('the lobby\'s track follows the room\'s map in every browser', (await Promise.all([A, B, C].map(scene))).every(m => m === 'serpantin'));
  await B.click('#startRace'); await C.click('#startRace');
  await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'false');
  // «Трасса»: no map there
  await A.click('#cfgMode label:nth-child(2)');
  await B.waitForFunction(() => __nd.NET.room.state.mode === 'traffic');
  await A.waitForFunction(() => document.getElementById('lobMapBtn').hidden);
  check('«Трасса»: no plate, no «Карта»', await B.$eval('#lobMap', e => e.hidden) && await A.$eval('#lobMapBtn', b => b.hidden));
  await A.click('#cfgMode label:nth-child(1)');
  await B.waitForFunction(() => __nd.NET.room.state.mode === 'track');
  await A.waitForFunction(() => !document.getElementById('lobMapBtn').hidden);

  // «Авто» → the garage → «Выбрать»: back in the lobby with the pick
  await B.click('#lobCar');
  await B.waitForFunction(() => !document.getElementById('pGarage').hidden);
  check('«Авто» opens the garage: «Гараж», «Выбрать», no race settings, no «Карта»', await B.innerText('#garTitle') === 'Гараж' && await B.innerText('#garGo') === 'Выбрать' && await B.$eval('#garSet', b => b.hidden) && await B.$eval('#garMap', b => b.hidden));
  for (let i = 0; i < 2; i++) { await B.keyboard.press('ArrowRight'); await sleep(150); }
  await B.click('#garPaint'); await B.click('#garSwatches button[aria-label="Красный"]'); await B.keyboard.press('Escape');
  await B.click('#garGo');
  await B.waitForFunction(() => !document.getElementById('pLobby').hidden);
  const bCar = CARS[2];
  await B.waitForFunction(n => document.getElementById('lobCarName').textContent === n, bCar[1]);
  await A.waitForFunction(n => document.querySelector('#plist .pl:nth-child(2) .pl-sub').textContent.includes(n), bCar[1]);
  check('«Выбрать»: back in the lobby with that car, and the others see it', await B.innerText('#lobPaint') === 'Цвет: красный');
  // «←» in the garage changes nothing
  await C.click('#lobCar'); await C.waitForFunction(() => !document.getElementById('pGarage').hidden);
  await C.keyboard.press('ArrowRight'); await sleep(150);
  await C.click('#garPaint'); await C.click('#garSwatches button[aria-label="Синий"]'); await C.keyboard.press('Escape');
  await C.click('#garBack');
  await C.waitForFunction(() => !document.getElementById('pLobby').hidden); await sleep(400);
  const cSeen = await A.evaluate(id => { const p = __nd.NET.room.state.players.get(id); return [p.car, p.color]; }, await C.evaluate(() => __nd.NET.room.sessionId));
  check('«←» in the garage: back with nothing changed, car and paint', await C.innerText('#lobCarName') === CARS[0][1] && cSeen[0] === CARS[0][0] && cSeen[1] === -1, JSON.stringify(cSeen));
  await C.click('#lobCar'); await C.waitForFunction(() => !document.getElementById('pGarage').hidden);
  for (let i = 0; i < 4; i++) { await C.keyboard.press('ArrowRight'); await sleep(150); }
  await C.click('#garGo'); await C.waitForFunction(() => !document.getElementById('pLobby').hidden);
  const cCar = CARS[4];

  // a rename: my own row, Enter
  await C.click('#plist .pl[data-me] .pl-who');
  await C.fill('#plist .pl-input', 'Cat'); await C.keyboard.press('Enter');
  await A.waitForFunction(() => document.querySelector('#plist .pl:nth-child(3) .pl-name').textContent === 'Cat');
  check('a click on my row renames me; the others see it', (await listOf(B))[2][1] === 'Cat' && await C.evaluate(() => localStorage.getItem('nightdrift.name')) === 'Cat');

  // the host sends C out: ✕, «Выгнать Cat?», «Да»
  await A.hover('#plist .pl:nth-child(3)');
  check('the host has a ✕ on the others, none on itself', await A.$$eval('#plist .pl', rows => rows.slice(0, 3).map(r => { const k = r.querySelector('.pl-kick'); return k ? String(!k.hidden) : 'none'; }).join()) === 'none,true,true');
  check('the others have no ✕', await B.$$eval('#plist .pl-kick', ks => ks.every(k => k.hidden)));
  await A.click('#plist .pl:nth-child(3) .pl-kick');
  await A.waitForFunction(() => document.getElementById('kickPop').matches(':popover-open'));
  check('✕ asks first: «Выгнать Cat?»', await A.innerText('#kickQ') === 'Выгнать Cat?');
  await A.keyboard.press('Escape'); await sleep(250);
  check('Esc cancels: nobody leaves, the host stays in the lobby', !(await A.evaluate(() => document.getElementById('kickPop').matches(':popover-open'))) && await A.evaluate(() => __nd.NET.room.state.players.size) === 3 && !(await A.$eval('#pLobby', e => e.hidden)));
  await A.click('#plist .pl:nth-child(3) .pl-kick');
  await A.click('#kickYes');
  await C.waitForFunction(() => !document.getElementById('pHome').hidden && document.getElementById('noteToast').matches(':popover-open'), null, { timeout: 10000 });
  check('the kicked player is back on the online cards, with the note', /исключили/.test(await C.innerText('#noteText')));
  await A.waitForFunction(() => __nd.NET.room.state.players.size === 2);
  check('the host and Bob now see two players', (await listOf(B)).length === 2);
  await enterCard(C, '#fJoin'); await C.fill('#codeIn', code); await C.click('#joinRoom');
  await C.waitForFunction(() => document.getElementById('netStatus').textContent.length > 0 && document.getElementById('pHome').getAttribute('aria-busy') !== 'true', null, { timeout: 10000 });
  await sleep(500);
  check('…and cannot come back, and is told why', !(await C.evaluate(() => __nd.NET.online)) && await A.evaluate(() => __nd.NET.room.state.players.size) === 2 && /исключил/.test(await C.innerText('#netStatus')), await C.innerText('#netStatus'));

  // Dan comes in later: he sees the room's map
  const D = await player('Dan');
  await enterCard(D, '#goOnline'); await sleep(400); await enterCard(D, '#fJoin'); await D.fill('#codeIn', code); await D.click('#joinRoom');
  await D.waitForFunction(() => !document.getElementById('pLobby').hidden && document.getElementById('lobMapName').textContent === 'Серпантин');
  check('a player who comes in later sees the room\'s map on the plate, and no note', (await plate(D)).bp && !(await toast(D)).open && await scene(D) === 'serpantin');
  await D.click('#startRace');

  // the race: every car is its player's model and paint; seat colours on the tags
  await A.waitForFunction(() => document.getElementById('startRace').getAttribute('aria-disabled') === 'false');
  await A.click('#startRace');
  for (const p of [A, B, D]) await p.waitForFunction(() => ['countdown', 'race'].includes(__nd.NET.room.state.phase), null, { timeout: 15000 });
  const raceMaps = await Promise.all([A, B, D].map(scene));
  check('the race starts on «Серпантин» in all three browsers', raceMaps.every(m => m === 'serpantin'), raceMaps.join());
  const bId = await B.evaluate(() => __nd.NET.room.sessionId), aId = await A.evaluate(() => __nd.NET.room.sessionId);
  await A.waitForFunction(id => { const g = __nd.NET.ghosts.get(id); return g && g.m.model; }, bId, { timeout: 30000 });
  await B.waitForFunction(id => { const g = __nd.NET.ghosts.get(id); return g && g.m.model; }, aId, { timeout: 30000 });
  const seenByA = await A.evaluate(id => { const g = __nd.NET.ghosts.get(id); return { car: g.m.model.carId, paint: g.m.model.code, accent: g.accent }; }, bId);
  const seenByB = await B.evaluate(id => { const g = __nd.NET.ghosts.get(id); return { car: g.m.model.carId, accent: g.accent }; }, aId);
  check('in the race the host sees Bob\'s model and paint', seenByA.car === bCar[0] && seenByA.paint === 0xd3202a, JSON.stringify(seenByA));
  check('…and Bob sees the host\'s', seenByB.car === CARS[0][0], JSON.stringify(seenByB));
  check('seat colours: the host cyan, the second rose', seenByB.accent === 0x3ef0ff && seenByA.accent === 0xff3b6b);
  // (the menu dissolves into the run first: --dur-screen, then it is hidden)
  await A.waitForFunction(() => document.getElementById('menu').hidden, null, { timeout: 2000 }).catch(() => {});
  check('the lobby is gone in the race (no menu, no stand drawing)', await A.evaluate(() => document.getElementById('menu').hidden));
  void cCar;

  check('no errors in the pages', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}
const bad = results.filter(r => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} checks failed` : `\nall ${results.length} checks passed`);
process.exit(bad.length ? 1 : 0);
