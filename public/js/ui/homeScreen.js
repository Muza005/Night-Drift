// The home screen (#pHome): the player's car on the wet street, and under it a deck of
// slanted cards. The card in focus sits in the middle, wide open; the others are narrow.
//
//   ← → or a tap on another card   focus moves: the old card closes, the deck slides, the new
//                                   one opens in the middle; the street's light takes its colour
//                                   and the layers of the street shift a little (near ones more)
//   Enter or a tap on the open card goes in; Esc / «‹» back
//
// Level «home»: Дрифт, Трасса, С друзьями, Карьера (not yet). «Дрифт» rolls on to the map deck:
// a diagram of each track drawn from its real centre line (geometry.js blueprint()).
// «С друзьями» rolls on to «Создать комнату» / «Войти по коду» (the code field opens under the
// deck while that card is in focus), and «Создать комнату» to the room's mode, Дрифт or
// Трасса. Every level is the same strip: the card in focus grows, its neighbours step aside. One deck
// leaves to one side and the next comes in from the other (WAAPI, ~320 ms, ease-out);
// with reduced motion it is a short cross-fade.
//
//   openHome({ level, dir, focus })   shows the screen ('home' | 'maps'), focus: a card's id
//   homeScreen.open, .frame(now)      the main loop draws the street and the car while it is up
//   homeScreen.on = { drift(mapId), traffic(), online(mode) }   what going in does (main.js)
//   homeScreen.map = () => id         the map the deck opens on (the solo map now)
//   homeScreen.record = it => text    the player's own record for a card ('' when none)
import { $ } from '../state.js';
import { renderer, drawBackdrop, menuPixels } from '../core/render.js';
import { createStand } from './stand.js';
import { showPanel } from './hud.js';
import { mapInfo, diagram } from './mapPicker.js';
import { MAP_IDS } from '../modes/track/maps/index.js';
import { choice } from './garage.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const saveData = !!(navigator.connection && navigator.connection.saveData);
const root = document.documentElement;
const css = v => getComputedStyle(document.getElementById('pHome')).getPropertyValue(v).trim();
// a length token in px, whatever it is written as (px, vw, clamp()): measured on a probe
const probe = document.createElement('i');
probe.style.cssText = 'position:absolute;visibility:hidden;block-size:0;pointer-events:none';
document.getElementById('pHome').append(probe);
const px = v => { probe.style.inlineSize = `var(${v})`; return probe.getBoundingClientRect().width; };
const km = m => (m / 1000).toFixed(2).replace('.', ',') + ' км';
const DIFF_NAME = ['', 'лёгкая', 'средняя', 'сложная'];
const CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const stand = createStand({ renderer, el: $('homeStand'), street: true });

/* ---------- the decks ---------- */
// accent: the light the card gives the street (and its bar); video: its loop from the game
const LEVELS = {
  home: () => [
    { id: 'dTrack', go: 'drift', name: 'Дрифт', accent: '--c-rose', video: 'drift' },
    { id: 'dTraffic', go: 'traffic', name: 'Трасса', accent: '--c-cyan', video: 'traffic' },
    { id: 'goOnline', go: 'friends', name: 'С друзьями', accent: '--c-amber', img: 'media/friends.webp' },
    { id: 'goCareer', name: 'Карьера', accent: '--c-ink-3', img: 'media/career.webp', soon: 'Скоро: сезон заездов и свой гараж' },
  ],
  maps: () => MAP_IDS.filter(id => mapInfo(id)).map(id => ({ id: 'map-' + id, map: id, go: 'map', name: mapInfo(id).name, accent: '--c-rose' })),
  friends: () => [
    { id: 'fHost', go: 'host', name: 'Создать комнату', accent: '--c-amber', img: 'media/friends.webp' },
    { id: 'fJoin', go: 'join', name: 'Войти по коду', accent: '--c-cyan', img: 'media/join.webp' },
  ],
  room: () => [
    { id: 'rTrack', go: 'online', mode: 'track', name: 'Дрифт', accent: '--c-rose', video: 'drift' },
    { id: 'rTraffic', go: 'online', mode: 'traffic', name: 'Трасса', accent: '--c-cyan', video: 'traffic' },
  ],
};
const LABEL = { home: 'Режим', maps: 'Карта', friends: 'С друзьями', room: 'Режим комнаты' };
const TITLE = { maps: 'Дрифт', friends: 'С друзьями', room: 'Комната' };
const CUP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10v4a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const deck = $('homeDeck'), back = $('homeBack'), title = $('homeTitle');
const S = { level: null, el: null, items: [], i: 0, lane: 0, trail: [] };
export const homeScreen = { on: {}, get open(){ return !$('menu').hidden && !$('pHome').hidden; }, frame, stand, get level(){ return S.level; }, get focus(){ return S.items[S.i] && S.items[S.i].id; } };

function card(it, i){
  const c = document.createElement('div');
  c.className = 'dcard' + (it.map ? ' dcard-map' : '');
  c.id = it.id; c.setAttribute('role', 'option'); c.tabIndex = -1;
  c.style.setProperty('--accent', `var(${it.accent})`);
  let art = '', figs = '';
  const rec = homeScreen.record ? homeScreen.record(it) : '';
  const recFig = rec ? `<span class="dcard-rec num">${CUP}${rec}</span>` : '';
  if(it.map){
    const d = diagram(it.map);
    art = d.svg;
    figs = `<span class="dcard-figs">${recFig}<span class="num">${km(d.len)}</span><span class="diff d${d.diff}" title="${DIFF_NAME[d.diff]}"><i></i><i></i><i></i></span></span>`;
    c.setAttribute('aria-label', `${d.name}, ${km(d.len)}, сложность ${DIFF_NAME[d.diff]}` + (rec ? `, лучший круг ${rec}` : ''));
  } else if(it.video){
    // the loop plays only on the card in focus; the poster stands in otherwise, and always
    // with reduced motion or Save-Data. Sources go in on the first focus (nothing loads before).
    art = `<video muted playsinline loop preload="none" poster="media/${it.video}.webp" aria-hidden="true" data-src="${it.video}"></video>`;
    if(recFig) figs = `<span class="dcard-figs">${recFig}</span>`;
    c.setAttribute('aria-label', it.name + (rec ? `, рекорд ${rec}` : ''));
  } else {
    art = `<img src="${it.img}" alt="" decoding="async">`;
    c.setAttribute('aria-label', it.name + (it.soon ? '. ' + it.soon : ''));
  }
  if(it.soon) c.setAttribute('aria-disabled', 'true');
  c.innerHTML = art + figs + `<span class="dcard-name">${it.name}</span><span class="dcard-bar"></span>`
    + (it.soon ? '<span class="dcard-soon" aria-hidden="true">Скоро</span>' : `<span class="dcard-go" aria-hidden="true">${CHEV}</span>`);
  // a tap on another card brings it to the middle; on the card in the middle, goes in
  c.addEventListener('click', () => { if(S.el !== c.parentNode) return; if(i === S.i) enter(); else focusAt(i); });
  return c;
}
function build(level){
  const t = document.createElement('div');
  t.className = 'deck-track'; t.setAttribute('role', 'listbox'); t.setAttribute('aria-orientation', 'horizontal'); t.setAttribute('aria-label', LABEL[level]);
  const items = LEVELS[level]();
  items.forEach((it, i) => t.append(card(it, i)));
  return { t, items };
}
// Where the deck stands: when the whole strip fits, it is centred as one piece (the open
// card grows and its neighbours step aside); when it does not (a phone, the map deck on a
// narrow window), the card in focus is brought to the middle, the ends kept on screen.
function place(t, i){
  const n = t.children.length, w = px('--deck-card'), open = Math.min(px('--deck-open'), innerWidth * 0.62), gap = px('--deck-gap') - px('--deck-slant');
  const total = (n - 1) * (w + gap) + open, room = deck.clientWidth, edge = Math.min(24, room * 0.04);
  let x = total + 2 * edge <= room ? (room - total) / 2 : room / 2 - i * (w + gap) - open / 2;
  if(total + 2 * edge > room) x = Math.min(edge, Math.max(room - edge - total, x));
  t.style.transform = `translateX(${Math.round(x)}px)`;
}
let runner = null;
function focusAt(i, moveFocus = true){
  const cs = [...S.el.children]; i = Math.max(0, Math.min(cs.length - 1, i));
  S.i = i;
  cs.forEach((c, k) => { c.setAttribute('aria-selected', String(k === i)); c.tabIndex = k === i ? 0 : -1; });
  S.el.setAttribute('aria-activedescendant', cs[i].id);
  place(S.el, i);
  light.want.set(css(S.items[i].accent));
  stand.setGlow(light.want);
  lane.want = (i - (cs.length - 1) / 2) + S.lane;
  // the loop of the card in focus plays; the one it left stops
  for(const [k, c] of cs.entries()){ const v = c.querySelector('video'); if(v) play(v, k === i && homeScreen.open); }
  if(runner){ runner.cancel(); runner = null; }
  // the diagram in focus is the one that flies into the garage's header (hud.js showPanel)
  for(const [k, c] of cs.entries()){ const g = c.querySelector('.dg'); if(g){ if(k === i) g.dataset.vt = 'map-dg'; else delete g.dataset.vt; } }
  const dot = cs[i].querySelector('.dg-run');
  if(dot && !reduced.matches) runner = dot.animate([{ offsetDistance: '0%' }, { offsetDistance: '100%' }], { duration: Math.round(mapInfo(S.items[i].map).len * 3.2), iterations: Infinity });
  // «Войти по коду»: its field opens under the deck while the card is in focus
  dock.classList.toggle('open', S.items[i].go === 'join');
  if(moveFocus) cs[i].focus({ preventScroll: true, focusVisible: kb });
}
const dock = $('homeDock');
// The loops play only while the home screen is up: under the garage, the lobby or a race
// every card video is paused, and the focused one goes on when home shows again. A change of
// the reduced-motion setting at run time is followed at once (videos, the lap runner).
let wasUp = false;
function syncMedia(){
  if(!S.el) return;
  const up = homeScreen.open;
  // (placed while hidden, the deck was measured at zero: placed again, without a slide)
  if(up && !wasUp){ S.el.style.transition = 'none'; place(S.el, S.i); S.el.getBoundingClientRect(); S.el.style.transition = ''; }
  wasUp = up;
  [...S.el.children].forEach((c, k) => { const v = c.querySelector('video'); if(v) play(v, up && k === S.i); });
  if(runner && (reduced.matches || !up)){ runner.cancel(); runner = null; }
  else if(!runner && up && !reduced.matches){ const dot = S.el.children[S.i] && S.el.children[S.i].querySelector('.dg-run'); if(dot) runner = dot.animate([{ offsetDistance: '0%' }, { offsetDistance: '100%' }], { duration: Math.round(mapInfo(S.items[S.i].map).len * 3.2), iterations: Infinity }); }
}
new MutationObserver(syncMedia).observe($('pHome'), { attributes: true, attributeFilter: ['hidden'] });
new MutationObserver(syncMedia).observe($('menu'), { attributes: true, attributeFilter: ['hidden'] });
reduced.addEventListener('change', syncMedia);
// (the change event does not always reach a list made at load: frame() also watches it)
let wasReduced = reduced.matches;
function play(v, on){
  if(!on || reduced.matches || saveData){ if(!v.paused) v.pause(); return; }
  if(!v.dataset.ready){
    const n = v.dataset.src;
    v.innerHTML = `<source src="media/${n}-av1.mp4" type='video/mp4; codecs="av01.0.05M.08"'><source src="media/${n}.mp4" type="video/mp4">`;
    v.dataset.ready = '1'; v.load();
  }
  v.play().catch(() => {});
}

// One deck to the next: the old one rolls off to one side, the new one comes in from the other
// a little behind it, and the street rolls on with them (lane). dir: +1 in, -1 back.
function show(level, dir, focusId){
  const old = S.el, { t, items } = build(level);
  t.style.transition = 'none'; deck.append(t);
  if(old) S.lane += dir * 3;
  S.level = level; S.el = t; S.items = items;
  const at = Math.max(0, items.findIndex(it => it.id === focusId || it.map === focusId));
  focusAt(at, false);
  t.getBoundingClientRect(); t.style.transition = '';
  back.hidden = level === 'home';
  title.classList.toggle('sub', level !== 'home');
  title.innerHTML = level === 'home' ? 'Night <span>Drift</span>' : TITLE[level];
  if(!old) return;
  old.inert = true;
  if(runner && old.contains(runner.effect && runner.effect.target)){ runner.cancel(); runner = null; }
  const d = parseFloat(css('--dur-level')) || 320;
  if(reduced.matches){
    old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' }).finished.then(() => old.remove());
    t.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    return;
  }
  const from = old.style.transform, to = t.style.transform;
  // leaving: it speeds away (ease-in) and is gone before the new one lands
  old.animate([{ transform: from, opacity: 1 }, { opacity: 0, offset: 0.75 }, { transform: `${from} translateX(${-dir * 60}vw)`, opacity: 0 }],
    { duration: d * 0.8, easing: 'cubic-bezier(0.55, 0, 0.75, 0.4)', fill: 'forwards' }).finished.then(() => old.remove());
  t.animate([{ transform: `${to} translateX(${dir * 70}vw)`, opacity: 0 }, { transform: to, opacity: 1 }],
    { duration: d, delay: 40, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', fill: 'backwards' });
}
const NEXT = { drift: 'maps', friends: 'friends', host: 'room' };
function enter(){
  const it = S.items[S.i]; if(!it || it.soon) return;
  if(NEXT[it.go]){ S.trail.push({ level: S.level, focus: it.id }); show(NEXT[it.go], 1, it.go === 'drift' ? homeScreen.map && homeScreen.map() : null); return; }
  if(it.go === 'map'){ homeScreen.on.drift && homeScreen.on.drift(it.map); return; }
  if(it.go === 'join'){ $('codeIn').focus(); return; }
  if(it.go === 'online'){ homeScreen.on.online && homeScreen.on.online(it.mode); return; }
  homeScreen.on[it.go] && homeScreen.on[it.go]();
}
function goBack(){
  if(S.level === 'home') return;
  const prev = S.trail.pop() || { level: 'home', focus: S.level === 'maps' ? 'dTrack' : 'goOnline' };
  show(prev.level, -1, prev.focus);
  S.el.children[S.i].focus({ preventScroll: true, focusVisible: kb });
}
back.addEventListener('click', goBack);

// the key row shows once the keyboard is used and goes with the first touch or click
let kb = false;
addEventListener('keydown', () => { kb = true; $('pHome').classList.add('kb'); }, true);
addEventListener('pointerdown', () => { kb = false; $('pHome').classList.remove('kb'); }, true);
addEventListener('keydown', e => {
  if(!homeScreen.open || !S.el) return;
  const k = e.key;
  if(k === 'Escape'){ if(S.level !== 'home'){ e.preventDefault(); goBack(); } return; }
  if(e.target.closest && e.target.closest('input, textarea, select')) return;
  if(k === 'ArrowRight' || k === 'ArrowLeft'){ e.preventDefault(); focusAt(S.i + (k === 'ArrowRight' ? 1 : -1)); }
  else if(k === 'Home' || k === 'End'){ e.preventDefault(); focusAt(k === 'Home' ? 0 : 99); }
  else if((k === 'Enter' || k === ' ') && !(e.target.closest && e.target.closest('button'))){ e.preventDefault(); enter(); }
});
// a finger: a swipe along the deck moves the focus (a tap is a click)
{ let sx = null, id = null;
  deck.addEventListener('pointerdown', e => { if(e.pointerType !== 'mouse'){ sx = e.clientX; id = e.pointerId; } });
  deck.addEventListener('pointerup', e => {
    if(sx === null || e.pointerId !== id) return;
    const dx = e.clientX - sx; sx = null;
    if(Math.abs(dx) > 40){ swiped = true; focusAt(S.i + Math.sign(-dx) * Math.max(1, Math.round(Math.abs(dx) / 120))); setTimeout(() => { swiped = false; }, 0); }
  });
  deck.addEventListener('click', e => { if(swiped){ e.stopPropagation(); e.preventDefault(); } }, true);
}
let swiped = false;
// a mouse wheel or a trackpad along the deck moves the focus one card per notch (a burst of
// trackpad events counts once per ~140 ms)
{ let acc = 0, quiet = 0;
  $('pHome').addEventListener('wheel', e => {
    if(!S.el) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    e.preventDefault();
    const now = performance.now();
    if(now - quiet > 300) acc = 0;
    quiet = now; acc += d;
    if(Math.abs(acc) >= 40){ const step = Math.sign(acc); acc = 0; if(now - (deck._t || 0) > 140){ deck._t = now; focusAt(S.i + step); } }
  }, { passive: false });
}
addEventListener('resize', () => { if(S.el) place(S.el, S.i); });

/* ---------- the street and the car ---------- */
// The light's colour and the layers' shift ease to where the focus asks (≈ 300 ms), at once
// with reduced motion.
const light = { now: new THREE.Color(0xff3b6b), want: new THREE.Color(0xff3b6b) };
const lane = { now: 0, want: 0 };
const anchor = { x: 0, y: 0, sway: 0, glow: light.now, shift: 0, lamps: 1 };
let last = 0;
function frame(now){
  if(reduced.matches !== wasReduced){ wasReduced = reduced.matches; syncMedia(); }
  const dt = last && now - last < 250 ? (now - last) / 1000 : 1 / 60; last = now;
  const k = reduced.matches ? 1 : 1 - Math.exp(-dt / 0.11);
  light.now.lerp(light.want, k);
  lane.now += (lane.want - lane.now) * (reduced.matches ? 1 : 1 - Math.exp(-dt / 0.16));
  const unit = Math.min(26, innerWidth * 0.018);                // px of near-layer shift per card
  const hz = innerHeight * (0.43 + 0.06 * smooth(Math.min(1, Math.max(0, (innerWidth / innerHeight - 0.5) / 0.5))));
  stand.setStreet(hz, innerWidth < 760 ? 0.05 : 0.07);
  const a = stand.measure();
  if(a){ anchor.x = a.x; anchor.y = a.y; anchor.sway = 0; }
  anchor.shift = -lane.now * unit;
  drawBackdrop(a ? anchor : null);
  stand.frame(now);
}
const smooth = a => a * a * (3 - 2 * a);                          // (as render.js places the horizon)

export function openHome({ level = 'home', dir, focus } = {}){
  stand.setCar(choice.car, choice.paint, 0);
  menuPixels(true);
  if(level === 'maps') S.trail = [{ level: 'home', focus: 'dTrack' }];
  if(level === 'friends') S.trail = [{ level: 'home', focus: 'goOnline' }];
  if(level === 'home') S.trail = [];
  // built afresh each time: the records on the cards may have changed with a run
  if(S.el){ S.el.remove(); S.el = null; }
  show(level, 1, focus);
  return showPanel('pHome', dir).then(() => { if(dir && S.el) S.el.children[S.i].focus({ preventScroll: true, focusVisible: kb }); });
}
