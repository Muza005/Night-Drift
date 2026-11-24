// The map picker (#mapPop) and the blueprints of the drift maps.
//
//   blueprintSvg(id)          the map's plan as a 16:10 SVG string (cached): the road coloured by
//                             height, bridges and upper floors drawn over what they cross
//                             (a dark gap and a shadow round them), shortcuts dashed amber,
//                             the start line and an arrow the way the lap is driven. Seen
//                             like the race minimap (modes/track/index.js), so it is the same
//                             picture the player meets in the race.
//   diagram(id)               the map as the home deck draws it (tilted, lifted by height,
//                             cyan → rose along the lap): { svg, lap, len, diff, name }, cached;
//                             the garage's header shows the same picture
//   mapInfo(id)               what a card says: name, lap length, difficulty, badges
//   openMapPicker({ current, source, onPick(id) })
//                             the picker: a popover next to `source` (a bottom sheet on a
//                             phone), one card per map; ← → ↑ ↓ move between cards, Enter or
//                             a click picks (onPick, then it closes), Esc closes it. Focus
//                             goes back to `source`.
//
// geometry.js blueprint() builds a map's track data without switching to it (no scene is
// built): about 5-15 ms a map, once; the SVG strings are cached on top of that.
import { $ } from '../state.js';
import { MAPS, MAP_IDS } from '../modes/track/maps/index.js';
import { blueprint } from '../modes/track/geometry.js';
import { records } from '../records.js';
import { el, fmtT, fmtN } from './hud.js';

// How hard a map is to drive clean (1-3), for the cards. UI data: the track files do not
// rate themselves.
const DIFF = { neon: 1, estakada: 2, serpantin: 3, parking: 3, pereval: 2, razvyazka: 2, _testhill: 1 };
export const DIFF_NAME = ['', 'лёгкая', 'средняя', 'сложная'];

export const km = m => (m / 1000).toFixed(2).replace('.', ',') + ' км';

const info = new Map();
export function mapInfo(id){
  if(!info.has(id)){
    const b = blueprint(id); if(!b) return null;
    const m = MAPS[id], ys = b.path.map(p => p[2]), rise = Math.max(...ys) - Math.min(...ys);
    const badges = [];
    if(b.bridges.length) badges.push('мост');
    if(m.levels) badges.push('этажи');
    else if(rise > 1) badges.push('уклоны');
    if(b.shortcuts.length) badges.push('срезка');
    info.set(id, { id, name: m.name, desc: m.desc || '', len: b.len, diff: DIFF[id] || 2, badges });
  }
  return info.get(id);
}

/* ---------- a track as a diagram (the home map deck, the garage's header) ----------
   The plan turned to the angle that fills the card best, tilted back (depth × 0.5), each
   point lifted by its real height (× 3, so a 7 m bridge reads) over its shadow on the ground,
   thin posts under what is up in the air. The route in short segments coloured from cyan at
   the start line to rose at the end of the lap; drawn in bands of height, each band's dark
   casing first, so a road crossing over another cuts a gap in it. Shortcuts dashed amber,
   the start a white bar, and on the card in focus a light running the lap. */
const diagrams = new Map();
export function diagram(id, W = 380, H = 215){
  const key = id + W + 'x' + H;
  if(diagrams.has(key)) return diagrams.get(key);
  const b = blueprint(id), info = mapInfo(id);
  const all = b.path, step = Math.max(1, Math.round(all.length / 260));
  const P = all.filter((_, i) => i % step === 0), n = P.length, st = Math.round(b.start.i / step) % n;
  const TILT = 0.5, LIFT = 3, PAD = 18;
  let best = null;
  for(let a = 0; a < 180; a += 7.5){
    const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for(const [x, z, h] of P){ const u = x * c - z * s, v = (x * s + z * c) * TILT; x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v - h * LIFT); y1 = Math.max(y1, v); }
    const k = Math.min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (y1 - y0));
    if(!best || k > best.k) best = { c, s, k, x0, x1, y0, y1 };
  }
  const { c, s, k } = best, ox = (W - (best.x1 - best.x0) * k) / 2 - best.x0 * k, oy = (H - (best.y1 - best.y0) * k) / 2 - best.y0 * k;
  const pr = (x, z, h = 0) => [(x * c - z * s) * k + ox, ((x * s + z * c) * TILT - h * LIFT) * k + oy];
  const f = v => v.toFixed(1);
  const cy = [62, 240, 255], ro = [255, 59, 107];
  const col = t => `rgb(${cy.map((v, i) => Math.round(v + (ro[i] - v) * t)).join(',')})`;
  const order = i => ((i - st + n) % n) / n;
  const pts = P.map(p => pr(p[0], p[1], p[2])), gnd = P.map(p => pr(p[0], p[1], 0));
  const ring = a => 'M' + a.map(p => f(p[0]) + ' ' + f(p[1])).join('L') + 'Z';
  let posts = '';
  for(let i = 0; i < n; i += 3) if(P[i][2] > 1.2) posts += `M${f(gnd[i][0])} ${f(gnd[i][1])}V${f(pts[i][1])}`;
  const segs = [];
  for(let i = 0; i < n; i++){ const j = (i + 1) % n; segs.push({ i, j, h: (P[i][2] + P[j][2]) / 2, d: (pts[i][1] + pts[j][1]) / 2 }); }
  segs.sort((a, z) => a.h - z.h || a.d - z.d);
  const w = 3.6, band = h => Math.round(h / 2.5), seg = sg => `M${f(pts[sg.i][0])} ${f(pts[sg.i][1])}L${f(pts[sg.j][0])} ${f(pts[sg.j][1])}`;
  let route = '';
  for(let lo = 0; lo < segs.length;){
    let hi = lo; while(hi < segs.length && band(segs[hi].h) === band(segs[lo].h)) hi++;
    const grp = segs.slice(lo, hi);
    if(band(grp[0].h) > 0) route += `<path d="${grp.map(seg).join('')}" class="dg-case" stroke-width="${w + 4}"/>`;
    for(const sg of grp) route += `<path d="${seg(sg)}" stroke="${col(order(sg.i))}" stroke-width="${w}"/>`;
    lo = hi;
  }
  const cuts = b.shortcuts.map(sc => 'M' + sc.path.filter((_, i) => i % 3 === 0).map(p => pr(p[0], p[1], 0)).map(p => f(p[0]) + ' ' + f(p[1])).join('L')).join('');
  const a = pts[st], q = pts[(st + 2) % n], L = Math.hypot(q[0] - a[0], q[1] - a[1]) || 1, nx = -(q[1] - a[1]) / L * 9, ny = (q[0] - a[0]) / L * 9;
  const lap = ring(pts.slice(st).concat(pts.slice(0, st)));
  const svg = `<svg class="dg" viewBox="0 0 ${W} ${H}" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="${ring(gnd)}" class="dg-shadow" stroke-width="${w + 5}" transform="translate(0 4)"/>
    <path d="${ring(gnd)}" class="dg-ground"/>
    ${posts ? `<path d="${posts}" class="dg-post"/>` : ''}
    ${cuts ? `<path d="${cuts}" class="dg-cut"/>` : ''}
    <g class="dg-glow">${route}</g><g>${route}</g>
    <path d="M${f(a[0] - nx)} ${f(a[1] - ny)}L${f(a[0] + nx)} ${f(a[1] + ny)}" class="dg-start"/>
    <circle class="dg-run" r="3.6" style="offset-path: path('${lap}')"/>
  </svg>`;
  const out = { svg, lap, len: info.len, diff: info.diff, name: info.name };
  diagrams.set(key, out);
  return out;
}

/* ---------- the blueprint ---------- */
// height colours: the ground in quiet ink, the highest road in bright cyan
const LOW = [0x9a, 0xa0, 0xc8], HIGH = [0x8a, 0xf7, 0xff];
const mix = t => '#' + LOW.map((a, i) => Math.round(a + (HIGH[i] - a) * t).toString(16).padStart(2, '0')).join('');
const BANDS = 6, W = 400, H = 250, PAD = 24;
const svgs = new Map();
export function blueprintSvg(id){
  if(svgs.has(id)) return svgs.get(id);
  const b = blueprint(id); if(!b) return '';
  const lv = MAPS[id].levels, N = b.path.length;
  // fit into the 16:10 frame (W × H, a margin for the road's width), both axes turned the way
  // the minimap turns them
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
  for(const [x, z] of b.path){ x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  for(const s of b.shortcuts) for(const [x, z] of s.path){ x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const k = Math.min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (z1 - z0));
  const X = x => (W / 2 - (x - (x0 + x1) / 2) * k).toFixed(1), Z = z => (H / 2 - (z - (z0 + z1) / 2) * k).toFixed(1);
  const ys = b.path.map(p => p[2]), yLo = Math.min(...ys), yHi = Math.max(...ys), span = yHi - yLo;
  // each point's layer: on a map with floors, its floor; elsewhere 1 on a bridge, else 0.
  // Layers are drawn from the bottom up, each over the one below with a gap round it.
  const onBridge = new Uint8Array(N);
  for(const r of b.bridges){ for(let i = r.from; ; i = (i + 1) % N){ onBridge[i] = 1; if(i === r.to) break; } }
  const layer = i => lv ? Math.round(ys[i] / lv.gap) : onBridge[i];
  const band = i => span > 1 ? Math.min(BANDS - 1, Math.floor((ys[i] - yLo) / span * BANDS)) : 0;
  // runs of points with the same layer and height band, each one point into the next so they join
  const runs = [];
  let start = 0; while(start < N && layer(start) === layer((start - 1 + N) % N) && band(start) === band((start - 1 + N) % N)) start++;
  if(start === N) runs.push({ layer: layer(0), band: band(0), pts: [...Array(N + 1).keys()].map(i => i % N) });
  else for(let n = 0, i = start; n < N;){
    const L = layer(i), B = band(i), pts = [i];
    do { i = (i + 1) % N; n++; pts.push(i); } while(n < N && layer(i) === L && band(i) === B);
    runs.push({ layer: L, band: B, pts });
  }
  const d = pts => pts.filter((p, j) => j === 0 || j === pts.length - 1 || j % 3 === 0).map((p, j) => (j ? 'L' : 'M') + X(b.path[p][0]) + ' ' + Z(b.path[p][1])).join('');
  const layers = [...new Set(runs.map(r => r.layer))].sort((a, c) => a - c);
  let out = '';
  for(const L of layers){
    const rs = runs.filter(r => r.layer === L), all = rs.map(r => d(r.pts)).join('');
    if(L > layers[0]) out += `<path d="${all}" class="bp-shadow"/>`;
    out += `<path d="${all}" class="bp-gap"/>`;
    for(let B = 0; B < BANDS; B++){ const p = rs.filter(r => r.band === B).map(r => d(r.pts)).join(''); if(p) out += `<path d="${p}" class="bp-road" stroke="${mix(span > 1 ? B / (BANDS - 1) : 0)}"/>`; }
    // shortcuts go with the ground layer (they never climb onto a bridge)
    if(L === layers[0]) for(const s of b.shortcuts) out += `<path d="${s.path.filter((p, j) => j % 2 === 0 || j === s.path.length - 1).map((p, j) => (j ? 'L' : 'M') + X(p[0]) + ' ' + Z(p[1])).join('')}" class="bp-cut"/>`;
  }
  // the start: a line across the road and an arrow ahead of it
  const sx = +X(b.start.x), sz = +Z(b.start.z), dx = -b.start.dir[0], dz = -b.start.dir[1], nx = -dz, nz = dx;
  const f = (a, c) => `${(sx + dx * a + nx * c).toFixed(1)} ${(sz + dz * a + nz * c).toFixed(1)}`;
  out += `<path d="M${f(0, -9)}L${f(0, 9)}" class="bp-start"/>`;
  out += `<path d="M${f(22, 0)}L${f(11, 6)}L${f(11, -6)}Z" class="bp-arrow"/>`;
  const svg = `<svg class="bp" viewBox="0 0 ${W} ${H}" aria-hidden="true" focusable="false">${out}</svg>`;
  svgs.set(id, svg);
  return svg;
}

/* ---------- the cards ---------- */
const pop = $('mapPop'), grid = $('mapGrid');
const S = { current: null, source: null, onPick: null, cards: new Map() };
const DOTS = n => `<span class="map-diff" aria-hidden="true">${[1, 2, 3].map(i => `<i${i <= n ? ' class="on"' : ''}></i>`).join('')}</span>`;
// my records on a map: the best lap and the best drift score of a run, «—» for none
function recs(id){ const r = records(id); return { lap: r.lap ? fmtT(r.lap) : '—', score: r.score ? fmtN(r.score) : '—', any: !!(r.lap || r.score) }; }
function makeCard(id){
  const m = mapInfo(id);
  const c = el('div', 'map-card'); c.id = 'map-' + id; c.dataset.map = id;
  c.setAttribute('role', 'option'); c.tabIndex = -1;
  const thumb = el('span', 'map-thumb'); thumb.innerHTML = blueprintSvg(id);
  const name = el('span', 'map-name', m.name);
  const meta = el('span', 'map-meta');
  meta.innerHTML = `<b class="num">${km(m.len)}</b>${DOTS(m.diff)}<span>${DIFF_NAME[m.diff]}</span>`;
  const tags = el('span', 'map-tags');
  for(const t of m.badges) tags.append(el('span', 'map-tag', t));
  const rec = el('span', 'map-rec'), lap = el('b', 'num'), score = el('b', 'num');
  const cell = (k, v) => { const e = el('span', 'map-rec-cell'); e.append(el('span', 'lbl', k), v); return e; };
  rec.append(cell('Круг', lap), cell('Очки', score));
  c.append(thumb, name, meta, tags, rec);
  c.addEventListener('click', () => pick(id));
  return { c, lap, score };
}
function draw(){
  for(const id of MAP_IDS){
    let card = S.cards.get(id);
    if(!card){ card = makeCard(id); S.cards.set(id, card); grid.append(card.c); }
    const on = id === S.current, m = mapInfo(id), r = recs(id);
    card.c.setAttribute('aria-selected', String(on));
    card.c.tabIndex = on ? 0 : -1;
    card.lap.textContent = r.lap; card.score.textContent = r.score;
    card.lap.classList.toggle('none', r.lap === '—'); card.score.classList.toggle('none', r.score === '—');
    card.c.setAttribute('aria-label', `${m.name}. Круг ${km(m.len)}, ${DIFF_NAME[m.diff]}${m.badges.length ? ', ' + m.badges.join(', ') : ''}. ` +
      (r.any ? `Ваш рекорд: круг ${r.lap === '—' ? 'нет' : r.lap}, очки ${r.score === '—' ? 'нет' : r.score}` : 'Рекорда пока нет'));
  }
  // (the current map may be a hidden test map, ?map=_testhill: then no card is selected,
  // the first one takes the focus)
  if(!S.cards.has(S.current)) S.cards.get(MAP_IDS[0]).c.tabIndex = 0;
}
function pick(id){
  const go = S.onPick;
  S.current = id; draw();
  if(pop.matches(':popover-open')) pop.hidePopover();
  go && go(id);
}

// ← → ↑ ↓: the nearest card that way, by where the cards are on screen (the grid wraps
// differently on a phone and a sheet held sideways). No card that way: nothing happens.
function neighbour(from, key){
  const a = from.getBoundingClientRect(), t = 2;
  const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[key];
  let best = null, bs = Infinity;
  for(const { c } of S.cards.values()){
    if(c === from || !(c.checkVisibility ? c.checkVisibility() : c.getClientRects().length)) continue;   // (checkVisibility: Safari 17.4+)
    const r = c.getBoundingClientRect();
    const gap = dir[0] > 0 ? r.left - a.right : dir[0] < 0 ? a.left - r.right : dir[1] > 0 ? r.top - a.bottom : a.top - r.bottom;
    if(gap < -t) continue;
    const overlap = dir[0] ? Math.min(a.bottom, r.bottom) - Math.max(a.top, r.top) : Math.min(a.right, r.right) - Math.max(a.left, r.left);
    const off = dir[0] ? Math.abs((r.top + r.bottom) - (a.top + a.bottom)) / 2 : Math.abs((r.left + r.right) - (a.left + a.right)) / 2;
    const s = overlap > 0 ? gap + off * .01 : 1e5 + gap + 3 * off;
    if(s < bs){ bs = s; best = c; }
  }
  return best;
}
grid.addEventListener('keydown', e => {
  const c = e.target.closest && e.target.closest('.map-card');
  if(!c || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
  if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); e.stopPropagation(); pick(c.dataset.map); return; }
  if(!e.key.startsWith('Arrow')) return;
  const to = neighbour(c, e.key); if(!to) return;
  e.preventDefault();
  c.tabIndex = -1; to.tabIndex = 0; to.focus(); to.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});

pop.addEventListener('toggle', e => {
  const on = e.newState === 'open';
  if(S.source) S.source.setAttribute('aria-expanded', String(on));
  if(!on){
    // focus back to the button it came from (a pick or Esc; not when it moved elsewhere)
    if(S.source && (document.activeElement === document.body || pop.contains(document.activeElement))) S.source.focus({ preventScroll: true });
  }
});

export function openMapPicker({ current, source, onPick }){
  Object.assign(S, { current, source, onPick });
  // the popover lives in the screen it is opened from (its keys know a panel of theirs is open)
  const home = source.closest('.screen');
  if(home && pop.parentElement !== home){ if(pop.matches(':popover-open')) pop.hidePopover(); home.append(pop); }
  draw();
  if(pop.matches(':popover-open')){ pop.hidePopover(); return; }
  try{ pop.showPopover({ source }); }catch(e){ pop.showPopover(); }
  // the picked card takes the focus now, not in 'toggle' (a task later): keys pressed at
  // once already move between the cards
  const c = (S.cards.get(S.current) || S.cards.get(MAP_IDS[0])).c;
  c.focus({ preventScroll: true }); c.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
export const mapPicker = { get open(){ return pop.matches(':popover-open'); }, close(){ if(pop.matches(':popover-open')) pop.hidePopover(); } };
