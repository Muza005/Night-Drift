// The garage screen (#pGarage): the car on the stand, ‹ › through the cars (no wrapping),
// its five bars compared with the car you came with, the paint palette and, solo, the
// run's settings (the gear), the map («Дрифт» only) and "Поехали". From the lobby it is
// "Гараж" with "Выбрать".
//
//   openGarage({ kind: 'solo' | 'lobby', mode, car, paint, dir, onGo(car, paint), onBack(), onMap(id) })
//   garage.open        is it on screen
//   garage.frame(now)  the main loop calls this instead of drawing the track while it is open
//
// The car and paint are not saved here: onGo gets the pick and the caller keeps it; onBack
// drops it. The gear settings (laps, density) are saved as soon as they change.
import { $, G } from '../state.js';
import { CARS, PAINTS, carById, classById, garageBars, paintCode, paintHex, paintByCode } from '../core/cars.js';
import { renderer, drawBackdrop, menuPixels, backdropState } from '../core/render.js';
import { createStand } from './stand.js';
import { showPanel, hex, el, fmtT, holdPicture } from './hud.js';
import { openMapPicker, mapPicker, diagram, km, DIFF_NAME } from './mapPicker.js';
import { records } from '../records.js';
import { MAPS } from '../modes/track/maps/index.js';

const LS = {
  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} },
};
export const MIN_LAPS = 1, MAX_LAPS = 10, DEFAULT_LAPS = 3;
// Solo drift: how many laps a run has (the gear settings), remembered.
{ const n = parseInt(LS.get('nightdrift.laps'), 10); G.soloLaps = n >= MIN_LAPS && n <= MAX_LAPS ? n : DEFAULT_LAPS; }

const stand = createStand({ renderer, el: $('garStand'), studio: true });
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const S = { opened: 0, open: false, kind: 'solo', mode: 'track', idx: 0, paint: -1, ref: null, onGo: null, onBack: null, onMap: null };
const NAMES = garageBars(CARS[0].stats).map(b => b[0]);

/* ---------- the bars ---------- */
const rows = NAMES.map(name => {
  const row = el('div', 'stat');
  const bar = el('span', 'stat-bar'); bar.setAttribute('aria-hidden', 'true');
  const diff = el('i', 'stat-diff'), fill = el('i', 'stat-fill'); bar.append(diff, fill);
  const delta = el('span', 'stat-delta'); delta.setAttribute('aria-hidden', 'true');
  const said = el('span', 'vh');
  row.append(el('span', 'stat-name', name), delta, bar, said);
  $('garStats').append(row);
  return { diff, fill, delta, said };
});
const num = v => String(v).replace('.', ',');
function drawBars(){
  const now = garageBars(carById(CARS[S.idx].id).stats), was = garageBars(carById(S.ref).stats);
  now.forEach(([, v], i) => {
    const r = rows[i], w = was[i][1], d = v - w;
    // over: the shorter of the two; under: the longer, coloured by which way it went
    r.fill.style.scale = `${Math.min(v, w) / 10} 1`;
    r.diff.style.scale = `${Math.max(v, w) / 10} 1`;
    r.diff.className = 'stat-diff' + (d > 0 ? ' up' : d < 0 ? ' down' : '');
    r.delta.className = 'stat-delta' + (d > 0 ? ' up' : d < 0 ? ' down' : '');
    r.delta.textContent = d > 0 ? '+' + num(d) : d < 0 ? '−' + num(-d) : '';
    r.said.textContent = `${num(v)} из 10` + (d ? `, ${d > 0 ? 'на ' + num(d) + ' больше' : 'на ' + num(-d) + ' меньше'}, чем у прежней` : '');
  });
}

/* ---------- the car, its name, the arrows ---------- */
function drawCar(){
  const c = CARS[S.idx];
  $('garName').textContent = c.name;
  $('garClass').textContent = classById(c.cls).name;
  $('garTag').textContent = c.tag;
  $('garPrev').disabled = S.idx === 0;
  $('garNext').disabled = S.idx === CARS.length - 1;
  drawBars(); drawPaint();
}
function flip(dir){
  const to = S.idx + dir;
  if(to < 0 || to >= CARS.length) return;
  S.idx = to;
  stand.setCar(CARS[to].id, S.paint, dir);
  drawCar();
  $('garLive').textContent = `${CARS[to].name}, ${to + 1} из ${CARS.length}`;
  // an arrow that just went out keeps no focus: the other one takes it
  const gone = $(dir < 0 ? 'garPrev' : 'garNext');
  if(gone.disabled && document.activeElement === gone) $(dir < 0 ? 'garNext' : 'garPrev').focus();
}
$('garPrev').addEventListener('click', () => flip(-1));
$('garNext').addEventListener('click', () => flip(+1));

/* ---------- paint ---------- */
const swatches = PAINTS.map(p => {
  const code = paintCode(p), b = el('button', 'swatch-btn'); b.type = 'button';
  b.setAttribute('aria-label', p.name); b.title = p.name;
  b.addEventListener('click', () => { S.paint = code; stand.repaint(code, { flow: true }); drawPaint(); });
  $('garSwatches').append(b);
  return { b, code };
});
function drawPaint(){
  const car = CARS[S.idx].id;
  for(const { b, code } of swatches){
    b.style.setProperty('--swatch', hex(paintHex(code, car)));     // "Заводской" is this car's own colour
    b.setAttribute('aria-pressed', String(code === S.paint));
  }
  $('paintName').textContent = paintByCode(S.paint).name;
  $('garSwatch').style.setProperty('--swatch', hex(paintHex(S.paint, car)));
}
// The palette open: the car moves aside to make room; closed (a click elsewhere, Esc),
// it comes back. The pick stays: there is nothing to confirm.
for(const [pop, btn] of [['garPaintPop', 'garPaint'], ['garSetPop', 'garSet']]){
  $(pop).addEventListener('toggle', e => {
    const on = e.newState === 'open';
    $(btn).setAttribute('aria-expanded', String(on));
    if(pop === 'garPaintPop') $('pGarage').classList.toggle('painting', on);
  });
  $(btn).setAttribute('aria-expanded', 'false');
}

/* ---------- the map (solo «Дрифт») ----------
   The header carries the map: its diagram (the one on its card, flown here by the screen
   change), its name, the lap's length, the difficulty bars and my best lap. A click opens the
   picker; a pick is the next run's map at once (onMap: the caller switches the track and
   keeps it), and the diagram changes with a short cross-fade. */
const CUP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v4a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let shownMap = null;
function drawMap(fade){
  const id = MAPS[G.soloMap] ? G.soloMap : 'neon', d = diagram(id), r = records(id);
  const lap = r.lap ? fmtT(r.lap) : '';
  $('garMapName').textContent = d.name;
  $('garMapFigs').innerHTML = `<span class="num">${km(d.len)}</span><span class="diff d${d.diff}"><i></i><i></i><i></i></span>` + (lap ? `<span class="gar-map-rec num">${CUP}${lap}</span>` : '');
  $('garMap').setAttribute('aria-label', `Карта: ${d.name}, ${km(d.len)}, сложность ${DIFF_NAME[d.diff]}` + (lap ? `, лучший круг ${lap}` : '') + '. Сменить карту');
  if(shownMap === id) return;
  shownMap = id;
  const box = $('garMapDg');
  box.innerHTML = d.svg;
  if(fade && !reduced.matches) box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'cubic-bezier(0.23, 1, 0.32, 1)' });
}
$('garMap').addEventListener('click', () => {
  if(!S.open || $('garMap').hidden) return;
  openMapPicker({ current: G.soloMap, source: $('garMap'),
    onPick(id){ if(S.onMap) S.onMap(id); drawMap(true); $('garLive').textContent = 'Карта: ' + MAPS[id].name; } });
});

/* ---------- the run's settings (the gear, solo) ---------- */
function drawSettings(){
  $('setLaps').hidden = S.mode !== 'track';
  $('setDens').hidden = S.mode !== 'traffic';
  $('lapsOut').textContent = G.soloLaps;
  $('lapsDown').disabled = G.soloLaps <= MIN_LAPS;
  $('lapsUp').disabled = G.soloLaps >= MAX_LAPS;
  for(const r of document.querySelectorAll('#setDens input')) r.checked = r.value === G.density;
}
function laps(d){
  const n = Math.max(MIN_LAPS, Math.min(MAX_LAPS, G.soloLaps + d));
  if(n === G.soloLaps) return;
  G.soloLaps = n; LS.set('nightdrift.laps', String(n)); drawSettings();
  const b = $(d < 0 ? 'lapsDown' : 'lapsUp');                      // at the end of the range: focus to the other
  if(b.disabled && document.activeElement === b) $(d < 0 ? 'lapsUp' : 'lapsDown').focus();
}
$('lapsDown').addEventListener('click', () => laps(-1));
$('lapsUp').addEventListener('click', () => laps(+1));
for(const r of document.querySelectorAll('#setDens input')) r.addEventListener('change', () => {
  if(r.checked){ G.density = r.value; LS.set('nightdrift.density', r.value); }
});

/* ---------- open, leave ---------- */
function leave(){
  S.open = false;
  for(const p of ['garPaintPop', 'garSetPop']) if($(p).matches(':popover-open')) $(p).hidePopover();
  mapPicker.close();
  menuPixels(false);
}
$('garGo').addEventListener('click', () => {
  if(!S.open) return;
  const pick = [CARS[S.idx].id, S.paint], go = S.onGo;
  if(S.kind === 'solo') holdPicture(frame);            // a run starts: the car on its stand stays a moment (hud.js)
  leave(); go && go(...pick);
});
$('garBack').addEventListener('click', back);
function back(){
  if(!S.open) return;
  const b = S.onBack;
  leave(); b && b();
}

export function openGarage({ kind = 'solo', mode = 'track', car, paint, dir = 'forward', onGo, onBack, onMap }){
  Object.assign(S, { kind, mode, onGo, onBack, onMap, paint, ref: carById(car).id, open: true });
  S.idx = Math.max(0, CARS.findIndex(c => c.id === S.ref));
  const solo = kind === 'solo';
  $('garTitle').textContent = solo ? (mode === 'traffic' ? 'Трасса' : 'Дрифт') : 'Гараж';
  $('garSet').hidden = !solo;
  $('garMap').hidden = !(solo && mode === 'track');        // «Трасса» has one endless road
  drawMap();
  $('garGo').textContent = solo ? 'Поехали' : 'Выбрать';
  $('garBack').setAttribute('aria-label', solo ? 'Назад к выбору режима' : 'Назад в лобби без изменений');
  $('pGarage').classList.remove('painting');
  drawSettings(); drawCar();
  street.shift = backdropState().shift; street.last = 0;
  // the car on the stand; once it is there, the lamp's light runs over it once
  const token = ++S.opened, carId = S.ref;
  stand.setCar(S.ref, paint, 0).then(() => { if(S.open && S.opened === token && CARS[S.idx].id === carId && stand.car && stand.car.carId === carId && !stand.sliding) stand.sweep(1); });
  menuPixels(true);
  return showPanel('pGarage', dir);
}

// Keys: ← → through the cars, Esc back (after closing an open popover first), Enter the
// main button. Keys typed into a field or meant for a focused control are left alone.
addEventListener('keydown', e => {
  if(!S.open || $('pGarage').hidden || e.repeat && e.key === 'Escape') return;
  const t = e.target, field = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  const popOpen = document.querySelector('#pGarage .pop:popover-open');
  if(e.key === 'Escape'){ if(!popOpen){ e.preventDefault(); back(); } return; }   // the browser closes the popover itself
  if(popOpen || field) return;
  if(e.key === 'ArrowLeft' || e.key === 'ArrowRight'){ e.preventDefault(); flip(e.key === 'ArrowLeft' ? -1 : 1); }
  else if(e.key === 'Enter' && (t === document.body || t === $('garStand') || !t.closest || !t.closest('button, a, input, select, summary'))){ e.preventDefault(); $('garGo').click(); }
});

// A swipe on a phone flips the cars too, anywhere but on the stand itself (there a finger
// turns the car) and not on a button.
{ let start = null;
  $('pGarage').addEventListener('pointerdown', e => {
    if(e.pointerType !== 'touch' || e.target.closest('.gar-stand, button, .pop, input, label')) return;
    start = { x: e.clientX, y: e.clientY, t: e.timeStamp, id: e.pointerId };
  });
  $('pGarage').addEventListener('pointerup', e => {
    if(!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y, dt = e.timeStamp - start.t; start = null;
    if(Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 700) flip(dx < 0 ? +1 : -1);
  });
  $('pGarage').addEventListener('pointercancel', () => { start = null; });
}

/* ---------- the street behind ----------
   The same street as the home screen, its kerb lamps a little lower, and a lamp straight
   over the stand (render.js, studio); the street's sideways shift, where the home deck left
   it, eases back to the middle. */
const street = { shift: 0, last: 0, glow: new THREE.Color(0xffe2c4) };
function frame(now){
  const dt = street.last && now - street.last < 250 ? (now - street.last) / 1000 : 1 / 60; street.last = now;
  street.shift *= reduced.matches ? 0 : Math.exp(-dt / 0.12);
  const a = stand.measure();
  drawBackdrop(a && { x: a.x, y: a.y, sway: a.sway, lamps: 0.6, studio: 1, glow: street.glow, shift: street.shift });
  stand.frame(now);
}

export const garage = {
  get open(){ return S.open && !$('pGarage').hidden; },
  frame,
  close(){ if(S.open) leave(); },          // (S.open, not .open: also while its screen is still on its way in)          // a run starts (online) or the room is gone: no callback
  stand,
  get pick(){ return { car: CARS[S.idx].id, paint: S.paint }; },
};
