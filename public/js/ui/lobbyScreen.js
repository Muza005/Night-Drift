// The lobby screen (#pLobby): what the room looks like between runs.
//
//   the players    the host first (the crown), then by the order they came in: the same
//                  list, numbers and colours on every screen (ui/seats.js). A green ring:
//                  that player pressed «Готово». The host can send a player out (✕, then
//                  «Да»); my own row renames me.
//   my car         on its stand; «Авто» opens the garage, «Выбрать» there sends the pick.
//   the code       to give to friends, with a copy button.
//   the settings   laps (drift) or minutes and traffic (highway): the host changes them,
//                  everyone sees them. Under them, «Дрифт» only: the room's map (its
//                  blueprint and name); the host picks it with «Карта» next to «Авто». A
//                  new map: the guests get a short note, and the server takes back
//                  everyone's «Готово».
//   the button     «Старт» for the host, lit once every other player is ready (the server
//                  checks it too); «Готово» for the others, pressed again to take it back.
//
// net/net.js owns the room and calls renderLobby() whenever it changes; this file only
// draws it and sends what the player does. Nothing of the race is drawn behind it: the
// drawn night city (core/render.js drawBackdrop), and the stand.
import { $, G, NET, isTouch } from '../state.js';
import { carById, classById, paintByCode } from '../core/cars.js';
import { renderer, drawBackdrop, menuPixels } from '../core/render.js';
import { createStand } from './stand.js';
import { showPanel, el, hex, netStatus, note } from './hud.js';
import { openMapPicker, mapPicker, blueprintSvg } from './mapPicker.js';
import { MAPS } from '../modes/track/maps/index.js';
import { openGarage, garage, MIN_LAPS, MAX_LAPS } from './garageScreen.js';
import { savePick } from './garage.js';
import { roster, seatHex, SEATS } from './seats.js';

const MIN_MINS = 1, MAX_MINS = 10;
const stand = createStand({ renderer, el: $('lobStand') });
const S = { open: false, room: null, car: null, paint: null, armed: null, kickFor: null, editing: false, map: null, mapRoom: null };
const rows = new Map();                 // sessionId → its row's elements

const state = () => NET.room && NET.room.state;
const meId = () => NET.room && NET.room.sessionId;
const isHost = () => { const s = state(); return !!s && s.hostId === meId(); };
const between = () => { const s = state(); return !!s && (s.phase === 'lobby' || s.phase === 'results'); };
const plural = (n, one, few, many) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? one : m >= 2 && m <= 4 && (h < 12 || h > 14) ? few : many; };

/* ---------- the players ---------- */
const CROWN = '<svg class="pl-crown" viewBox="0 0 24 16" aria-hidden="true"><path d="M2 14h20l-1.6-10-5.4 4.6L12 1.5 9 8.6 3.6 4z" fill="currentColor" stroke="rgba(0,0,0,.45)" stroke-width="1.2" stroke-linejoin="round"/></svg>';
const PEN = '<svg class="pl-pen" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const CROSS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

function makeRow(id){
  const mine = id === meId();
  const li = el('li', 'pl');
  const ava = el('span', 'pl-ava'); ava.setAttribute('aria-hidden', 'true');
  const num = el('b', 'pl-num'); ava.append(num); ava.insertAdjacentHTML('beforeend', CROWN);
  // my own row is a button: a click renames me
  const who = el(mine ? 'button' : 'span', 'pl-who');
  if(mine){ who.type = 'button'; who.addEventListener('click', startRename); }
  const name = el('span', 'pl-name'), sub = el('span', 'pl-sub');
  const said = el('span', 'vh');                     // what the picture says: number, host, ready
  who.append(said, name, sub);
  if(mine) who.insertAdjacentHTML('beforeend', PEN);
  li.append(ava, who);
  let kick = null;
  if(!mine){
    kick = el('button', 'pl-kick'); kick.type = 'button'; kick.innerHTML = CROSS;
    kick.addEventListener('click', () => askKick(id, kick));
    li.append(kick);
  }
  return { li, num, who, name, sub, said, kick, mine };
}
function fillRow(r, id, p, i, s){
  const host = id === s.hostId, ready = !host && p.ready, off = !p.connected;
  r.li.style.setProperty('--seat', hex(seatHex(i)));
  r.li.toggleAttribute('data-host', host);
  r.li.toggleAttribute('data-ready', ready);
  r.li.toggleAttribute('data-me', r.mine);
  r.li.toggleAttribute('data-off', off);
  r.num.textContent = String(i + 1);
  r.name.textContent = p.name + (r.mine ? ' (вы)' : '');
  r.sub.textContent = off ? 'нет связи' : (ready ? 'Готов · ' : '') + carById(p.car).name;
  r.said.textContent = `${i + 1}${host ? ', хост' : ''}${ready ? ', готов' : ''}: `;
  if(r.mine) r.who.setAttribute('aria-label', `${i + 1}${host ? ', хост' : ''}${ready ? ', готов' : ''}: ${p.name} (вы). Сменить имя`);
  if(r.kick){
    r.kick.hidden = !(isHost() && between());
    r.kick.setAttribute('aria-label', 'Выгнать ' + p.name);
  }
}
function drawPlayers(s){
  const list = roster(s), ul = $('plist');
  // a new room (or a reconnect): every row goes, a rename in one of them too (a removed
  // input gets no blur, so its end is not heard)
  if(S.room !== NET.room){ for(const r of rows.values()) r.li.remove(); rows.clear(); S.room = NET.room; S.armed = null; S.editing = false; }
  const seen = new Set();
  list.forEach(([id, p], i) => {
    seen.add(id);
    let r = rows.get(id); if(!r){ r = makeRow(id); rows.set(id, r); }
    fillRow(r, id, p, i, s);
  });
  for(const [id, r] of rows) if(!seen.has(id)){
    if(r.li.contains(document.activeElement)) $('startRace').focus({ preventScroll: true });
    r.li.remove(); rows.delete(id);
    if(S.kickFor === id) $('kickPop').hidePopover();
  }
  // the order: only what is out of place moves (a moved element loses its focus)
  list.forEach(([id], i) => { const li = rows.get(id).li; if(ul.children[i] !== li) ul.insertBefore(li, ul.children[i] || null); });
  // the free seats
  ul.querySelectorAll('.pl-empty').forEach(e => e.remove());
  for(let i = list.length; i < SEATS; i++){
    const li = el('li', 'pl pl-empty'); li.style.setProperty('--seat', hex(seatHex(i)));
    const ava = el('span', 'pl-ava'); ava.setAttribute('aria-hidden', 'true'); ava.append(el('b', 'pl-num', String(i + 1)));
    li.append(ava, el('span', 'pl-who', 'Свободно'));
    ul.append(li);
  }
  $('plCount').textContent = `${list.length} из ${SEATS}`;
}

/* ---------- sending a player out: ✕, then «Да» ---------- */
let anchor = null;
function askKick(id, btn){
  const s = state(); const p = s && s.players.get(id);
  if(!p || !isHost() || !between()) return;
  S.kickFor = id;
  $('kickQ').textContent = `Выгнать ${p.name}?`;
  // the panel stands next to this ✕ (one explicit anchor at a time)
  if(anchor) anchor.style.anchorName = '';
  btn.style.anchorName = '--kick'; anchor = btn;
  const pop = $('kickPop');
  if(pop.matches(':popover-open')) pop.hidePopover();
  try{ pop.showPopover({ source: btn }); }catch(e){ pop.showPopover(); }
  $('kickYes').focus({ preventScroll: true });
}
$('kickYes').addEventListener('click', () => {
  const id = S.kickFor;
  $('kickPop').hidePopover();
  if(id && NET.room && isHost()) NET.room.send('kick', { id });
});
$('kickPop').addEventListener('toggle', e => {
  if(e.newState !== 'closed') return;
  const id = S.kickFor; S.kickFor = null;
  // focus goes back to the ✕ it came from, or, if that player is gone, to the main button
  const r = id && rows.get(id);
  if(document.activeElement === document.body || $('kickPop').contains(document.activeElement)) (r && r.kick && !r.kick.hidden ? r.kick : $('startRace')).focus({ preventScroll: true });
});

/* ---------- renaming myself ---------- */
function startRename(){
  const r = rows.get(meId()), s = state(); const p = s && s.players.get(meId());
  if(!r || !p || S.editing || !between()) return;
  S.editing = true;
  const input = el('input', 'pl-input');
  Object.assign(input, { type: 'text', maxLength: 16, value: p.name, autocomplete: 'nickname', spellcheck: false, enterKeyHint: 'done' });
  input.setAttribute('aria-label', 'Ваше имя, до 16 символов');
  r.who.hidden = true; r.li.insertBefore(input, r.who.nextSibling);
  input.focus(); input.select();
  let done = false;
  const finish = keep => {
    if(done) return; done = true; S.editing = false;
    const v = input.value.replace(/\s+/g, ' ').trim().slice(0, 16);
    input.remove(); r.who.hidden = false;
    if(keep && v && v !== p.name && NET.room){
      NET.room.send('name', { name: v });
      try{ localStorage.setItem('nightdrift.name', v); }catch(e){}
      r.name.textContent = v + ' (вы)';                 // shown at once; the room's answer follows
    }
    if(!keep || document.activeElement === document.body) r.who.focus({ preventScroll: true });
  };
  input.addEventListener('keydown', e => {
    if(e.key === 'Enter'){ if(e.isComposing || e.keyCode === 229) return; e.preventDefault(); finish(true); }
    else if(e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

/* ---------- the code ---------- */
let copyTimer = 0, lastSaid = '';
function legacyCopy(text){
  const f = Object.assign(document.createElement('textarea'), { value: text });
  f.setAttribute('readonly', ''); f.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  document.body.append(f); f.select();
  try{ return document.execCommand('copy'); }catch(e){ return false; }finally{ f.remove(); }
}
$('copyCode').addEventListener('click', async () => {
  if(!NET.room) return;
  const code = NET.room.roomId, btn = $('copyCode'), tip = $('copyTip');
  let ok = true;
  // (a game on the local network is served over plain http: no async clipboard there)
  try{ await navigator.clipboard.writeText(code); }
  catch(e){ ok = legacyCopy(code); }
  clearTimeout(copyTimer);
  btn.removeAttribute('data-copied'); btn.removeAttribute('data-failed');
  tip.textContent = ''; void btn.offsetWidth;
  btn.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  let say = ok ? 'Скопировано' : 'Не скопировалось: код ' + code;
  if(say === lastSaid) say += ' ';                 // a repeat is still read out
  lastSaid = say;
  requestAnimationFrame(() => { tip.textContent = say; });
  copyTimer = setTimeout(() => { btn.removeAttribute('data-copied'); btn.removeAttribute('data-failed'); tip.textContent = ''; }, 2000);
});

/* ---------- the run's settings ---------- */
function drawSettings(s){
  const host = isHost(), track = s.mode !== 'traffic', mins = Math.round(s.duration / 60);
  $('cfgWho').textContent = host ? 'меняете вы' : 'меняет хост';
  for(const r of document.querySelectorAll('#cfgMode input')){ r.checked = r.value === s.mode; r.disabled = !host; }
  for(const r of document.querySelectorAll('#cfgDens input')){ r.checked = r.value === (s.density || 'mid'); r.disabled = !host; }
  $('rowLaps').hidden = !track;
  $('rowMins').hidden = $('cfgDens').hidden = track;
  $('cfgLaps').textContent = s.laps; $('cfgMins').textContent = mins;
  for(const [id, off] of [['cfgLapsDown', s.laps <= MIN_LAPS], ['cfgLapsUp', s.laps >= MAX_LAPS], ['cfgMinsDown', mins <= MIN_MINS], ['cfgMinsUp', mins >= MAX_MINS]]){
    const b = $(id); b.hidden = !host; b.disabled = off;
  }
  $('lobCfg').toggleAttribute('data-guest', !host);
}
const config = m => { if(NET.room && isHost() && between()) NET.room.send('config', m); };
// A step counts from the number on screen, which changes at once: two quick presses are
// two steps even before the room has answered the first (its answer then confirms it).
function step(key, d){
  const s = state(); if(!s || !isHost()) return;
  const out = $(key === 'laps' ? 'cfgLaps' : 'cfgMins');
  const [lo, hi] = key === 'laps' ? [MIN_LAPS, MAX_LAPS] : [MIN_MINS, MAX_MINS];
  const was = Number(out.textContent), n = Math.max(lo, Math.min(hi, was + d));
  if(n === was) return;
  out.textContent = n;
  $(key === 'laps' ? 'cfgLapsDown' : 'cfgMinsDown').disabled = n <= lo;
  $(key === 'laps' ? 'cfgLapsUp' : 'cfgMinsUp').disabled = n >= hi;
  config(key === 'laps' ? { laps: n } : { duration: n * 60 });
}
$('cfgLapsDown').addEventListener('click', () => step('laps', -1));
$('cfgLapsUp').addEventListener('click', () => step('laps', +1));
$('cfgMinsDown').addEventListener('click', () => step('mins', -1));
$('cfgMinsUp').addEventListener('click', () => step('mins', +1));
for(const r of document.querySelectorAll('#cfgMode input')) r.addEventListener('change', () => { if(r.checked) config({ mode: r.value }); });
for(const r of document.querySelectorAll('#cfgDens input')) r.addEventListener('change', () => { if(r.checked) config({ density: r.value }); });
// an arrow that just went out hands its focus to the other one
for(const [a, b] of [['cfgLapsDown', 'cfgLapsUp'], ['cfgMinsDown', 'cfgMinsUp']]) for(const [x, y] of [[a, b], [b, a]])
  $(x).addEventListener('click', () => requestAnimationFrame(() => { if($(x).disabled && document.activeElement === $(x)) $(y).focus(); }));

/* ---------- the map («Дрифт») ---------- */
function drawMap(s){
  const track = s.mode !== 'traffic', host = isHost(), m = MAPS[s.map] || MAPS.neon;
  $('lobMap').hidden = !track;
  $('lobMapBtn').hidden = !(track && host);
  $('lobMapBtn').disabled = !between();
  if($('lobMap').dataset.map !== m.id){ $('lobMapThumb').innerHTML = blueprintSvg(m.id); $('lobMap').dataset.map = m.id; }
  $('lobMapName').textContent = m.name;
  if(!(track && host) && mapPicker.open) mapPicker.close();     // the host is gone or the mode changed
  // a new map in this room (not the first look at it): the guests are told
  if(S.mapRoom === NET.room && S.map && S.map !== m.id && !host && track){
    note(`Хост сменил карту на «${m.name}». «Готово» сброшено.`, { short: true });
    $('lobMapLive').textContent = `Новая карта: ${m.name}. «Готово» снято.`;
  }
  S.map = m.id; S.mapRoom = NET.room;
}
$('lobMapBtn').addEventListener('click', () => {
  const s = state(); if(!s || !isHost() || !between() || s.mode === 'traffic') return;
  openMapPicker({ current: s.map, source: $('lobMapBtn'), onPick(id){ if(id !== s.map) config({ map: id }); } });
});

/* ---------- the main button ---------- */
function waiting(s){ let n = 0; s.players.forEach((o, id) => { if(id !== s.hostId && o.connected && !o.ready) n++; }); return n; }
function drawButton(s){
  const b = $('startRace'), host = isHost(), me = s.players.get(meId()), n = waiting(s);
  if(host){
    const lit = n === 0;
    b.textContent = 'Старт';
    b.removeAttribute('aria-pressed');
    b.setAttribute('aria-disabled', String(!lit));
    // lit just now (not on the first look): one short flash, once
    if(lit && S.armed === false){ b.classList.remove('armed'); void b.offsetWidth; b.classList.add('armed'); }
    S.armed = lit;
    netStatus('lobbyStatus', s.players.size < 2 ? 'Можно стартовать и одному. Друзьям — код комнаты.' : n ? `Ждём «Готово»: ${n} ${plural(n, 'игрок', 'игрока', 'игроков')}.` : 'Все готовы. Можно стартовать.');
  } else {
    const on = !!(me && me.ready);
    b.textContent = 'Готово';
    b.setAttribute('aria-pressed', String(on));
    b.removeAttribute('aria-disabled'); b.classList.remove('armed'); S.armed = null;
    netStatus('lobbyStatus', on ? 'Вы готовы. Ждём, когда хост запустит заезд.' : 'Нажмите «Готово», когда выберете машину.');
  }
}
function mainAction(){
  const s = state(); if(!s) return;
  if(isHost()){ if(waiting(s) === 0) NET.room.send('start'); else netStatus('lobbyStatus', 'Старт откроется, когда все нажмут «Готово».'); }
  else { const p = s.players.get(meId()); NET.room.send('ready', { value: !(p && p.ready) }); }
}
$('startRace').addEventListener('click', mainAction);

/* ---------- my car ---------- */
function drawCar(s){
  const p = s.players.get(meId()); if(!p) return;
  const c = carById(p.car);
  $('lobCarName').textContent = c.name;
  $('lobCarClass').textContent = classById(c.cls).name;
  $('lobPaint').textContent = 'Цвет: ' + paintByCode(p.color).name.toLowerCase();
  if(S.car !== c.id){ stand.setCar(c.id, p.color, S.car ? 1 : 0); S.car = c.id; S.paint = p.color; }
  else if(S.paint !== p.color){ stand.repaint(p.color); S.paint = p.color; }
}
// «Авто»: the garage, from the car I have now; «Выбрать» sends the pick, «←» changes nothing.
export function openRoomGarage(back){
  const s = state(); if(!s || !between()) return;
  const p = s.players.get(meId()); if(!p) return;
  closeLobby();
  openGarage({ kind: 'lobby', mode: s.mode, car: p.car, paint: p.color, dir: 'forward',
    onGo(carId, paint){ savePick(carId, paint); if(NET.room) NET.room.send('pick', { car: carId, paint }); back(); },
    onBack: back,
  }).then(() => $('garGo').focus({ preventScroll: true }));
}
$('lobCar').addEventListener('click', () => openRoomGarage(() => openLobby('back').then(() => $('lobCar').focus({ preventScroll: true }))));

/* ---------- open, close, draw ---------- */
export function renderLobby(){
  const s = state(); if(!s) return;
  $('roomCode').textContent = NET.room.roomId;
  $('lobMode').textContent = s.mode === 'traffic' ? 'Трасса' : 'Дрифт';
  drawPlayers(s); drawSettings(s); drawMap(s); drawButton(s); drawCar(s);
  $('lobCar').disabled = !between();
  // the game follows the room's mode (the city behind is the same for both)
  if(G.setMode && G.mode.id !== s.mode) G.setMode(s.mode).catch(e => console.error('mode failed to load', s.mode, e));
}
export function openLobby(dir){
  S.open = true;
  menuPixels(true);
  renderLobby();
  return showPanel('pLobby', dir);
}
export function closeLobby(){
  if(!S.open) return;
  S.open = false;
  if($('kickPop').matches(':popover-open')) $('kickPop').hidePopover();
  mapPicker.close();
  menuPixels(false);
}
// leaving the room or a run starting: the garage opened from here goes too
export function leaveLobby(){ closeLobby(); if(garage.open) garage.close(); }

// Keys: Esc leaves the room (after closing the ✕ panel or a rename first), Enter is the
// main button unless a control has the focus.
addEventListener('keydown', e => {
  if(!lobby.open || e.repeat || e.defaultPrevented) return;    // (the garage's Esc or Enter that brought us here)
  const t = e.target;
  if(S.editing || (t && (t.tagName === 'INPUT' && t.type === 'text'))) return;
  const popOpen = document.querySelector('#pLobby .pop:popover-open');
  if(e.key === 'Escape'){ if(!popOpen){ e.preventDefault(); $('leaveLobby').click(); } return; }   // the browser closes the popover itself
  if(popOpen) return;
  if(e.key === 'Enter' && (t === document.body || !t.closest || !t.closest('button, a, input, select, summary'))){ e.preventDefault(); mainAction(); }
});

export const lobby = {
  get open(){ return S.open && !$('pLobby').hidden && !$('menu').hidden; },
  frame(now){ drawBackdrop(stand.measure()); stand.frame(now); },
  stand,
};
if(isTouch) $('pLobby').classList.add('touch');
