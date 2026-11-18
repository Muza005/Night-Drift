// The garage: pick a car and its paint. One widget, drawn into several places (the main
// menu, the lobby, the results screen between runs). The pick is remembered in the browser
// and, online, sent to the room (net.js), which keeps every player's colour different.
import { CARS, PAINTS, CAR_IDS, DEFAULT_CAR, DEFAULT_PAINT, carById, classById, statBars, isPaint, paintCode, paintHex } from '../core/cars.js';
import { hex, el } from './hud.js';

const LS = {
  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} },
};

// What the player picked last time (or the car and colour the game always had).
export const choice = {
  car: CAR_IDS.includes(LS.get('nightdrift.car')) ? LS.get('nightdrift.car') : DEFAULT_CAR,
  paint: isPaint(Number(LS.get('nightdrift.paint'))) && LS.get('nightdrift.paint') !== null ? Number(LS.get('nightdrift.paint')) : DEFAULT_PAINT,
};
export function savePick(car, paint){
  if(CAR_IDS.includes(car)){ choice.car = car; LS.set('nightdrift.car', car); }
  if(isPaint(paint)){ choice.paint = paint; LS.set('nightdrift.paint', String(paint)); }
}

// Draw the garage into `root`.
//   car, paint      what is selected now
//   taken           colours other players in the room already have (shown, not pickable)
//   onCar(id), onPaint(hex)
export function renderGarage(root, { car, paint, taken = new Set(), onCar, onPaint }){
  const c = carById(car);
  root.replaceChildren();

  const cars = el('div', 'g-cars'); cars.setAttribute('role', 'group'); cars.setAttribute('aria-label', 'Машина');
  for(const o of CARS){
    const b = el('button', null, o.name); b.type = 'button';
    b.setAttribute('aria-pressed', String(o.id === c.id));
    b.addEventListener('click', () => { if(o.id !== c.id) onCar(o.id); });
    cars.append(b);
  }

  const info = el('div', 'g-info');
  info.append(el('div', 'g-tag', classById(c.cls).name + ' · ' + c.tag));
  const stats = el('div', 'g-stats');
  for(const [name, v] of statBars(c.stats)){
    const row = el('div', 'g-stat');
    const bar = el('span', 'g-bar'); const fill = el('i'); fill.style.width = (v * 10) + '%'; bar.append(fill);
    row.append(el('span', 'lbl', name), bar);
    stats.append(row);
  }
  info.append(stats);

  const paints = el('div', 'g-paints'); paints.setAttribute('role', 'group'); paints.setAttribute('aria-label', 'Цвет');
  for(const p of PAINTS){
    const code = paintCode(p), busy = taken.has(code) && code !== paint;
    const b = el('button', 'g-paint'); b.type = 'button';
    b.style.color = b.style.background = hex(paintHex(code, c.id));
    b.title = busy ? p.name + ' — занят' : p.name;
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(code === paint));
    b.disabled = busy;
    b.addEventListener('click', () => { if(code !== paint) onPaint(code); });
    paints.append(b);
  }

  root.append(cars, info, paints);
}
