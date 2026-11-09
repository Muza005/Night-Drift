// Traffic mode: the endless highway, the top-down camera, the traffic (stage 2),
// collisions with it (stage 3), scoring (stage 4) and playing it online (stage 6:
// the server's traffic, crashing without leaving the run).
// Same interface as the track mode (see modes/track/index.js), so the car drives
// through the same frozen stepCar().
import { $, G, NET, drift, serverNow, isTouch } from '../../state.js';
import { scene, camera, moon, sky, stars } from '../../core/render.js';
import { rig } from '../../core/cameraRig.js';
import { setT, fmtT, fmtN, flash } from '../../ui/hud.js';
import { renderStandings } from '../../net/net.js';
import { whoosh, thud, horn } from '../../core/audio.js';
import { laneCenter, nearestLane, startPose, constrainToHighway, topDownView, CAM, keepOnRoad } from './geometry.js';
import { group, updateChunks, followGround } from './scene.js';
import { createTraffic, TYPES } from './sim.js';
import { createRemoteTraffic } from './remote.js';
import { drawTraffic } from './view.js';
import { collideWithTraffic, HARD_HIT, HARD_SIDE } from './collide.js';
import { createScoring, COMBO_WINDOW, COMBO_MAX } from './score.js';

// Solo: the simulation runs here, a new seed every run. Online: the server runs it and
// `remote` predicts its bots to the present moment (remote.js). `src` is the one in use.
const newSeed = () => (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
export const traffic = createTraffic(1);
export const remote = createRemoteTraffic({ now: serverNow, send: (t, m) => NET.room && NET.room.send(t, m), rtt: () => NET.rtt });
let src = traffic;

// Online crash: stopped and blinking for 3 s, then back on a free lane at traffic
// speed and 1.5 s in which bots and other cars pass through (the server keeps the same
// times in the player's wreckUntil / ghostUntil, so everyone sees the same).
const WRECK_MS = 3000, GHOST_MS = 1500;
let wreckUntil = 0, ghostUntil = 0, respawned = true, wrecks = 0;
const wrecked = () => serverNow() < wreckUntil;
const ghosted = () => serverNow() < ghostUntil;
const asPlayer = car => ({ x: car.x, z: car.z, v: car.vz });
export const score = createScoring();

// Phones: the bottom of the screen belongs to the touch buttons and the speedometer.
// The car is drawn above them. How high they reach is measured on the page itself,
// so it holds for any phone, either orientation, and with the home-bar inset.
let carAtKey = '', carAtTouch = CAM.carAt;
function carAtOnScreen(fovV){
  if(!isTouch) return CAM.carAt;
  const W = innerWidth, H = innerHeight, key = W + 'x' + H;
  if(key !== carAtKey){
    let top = H;
    for(const el of document.querySelectorAll('#touch .tb, #speedo')){
      const r = el.getBoundingClientRect(); if(r.height > 0) top = Math.min(top, r.top);
    }
    if(top === H) return carAtTouch;                       // HUD not laid out yet: measure next frame
    const reserve = H - top + 44;                           // half the car on screen plus a gap
    const d = Math.max(0, H / 2 - reserve) / (H / 2);       // car's distance below the centre, 0..1
    const a = Math.atan(d * Math.tan(fovV * Math.PI / 360)) * 180 / Math.PI;
    carAtTouch = Math.max(0.1, Math.min(CAM.carAt, a / fovV));
    carAtKey = key;
  }
  return carAtTouch;
}

// Best score, kept in this browser.
const BEST_KEY = 'nightdrift.trafficBest';
let best = 0; try { best = parseInt(localStorage.getItem(BEST_KEY), 10) || 0; } catch (e) {}
let banked = 0, record = false, summarised = false;

const _v = new THREE.Vector3();
// A hit with a bot: how hard it was against the crash line, next to the car, so the
// player learns where a bump ends and a crash begins. Speeds in km/h, rounded.
const kmh = v => Math.round(v * 3.6);
let lastHit = null;
function hitPopup(car, hit){
  for(const old of document.querySelectorAll('.hitpop')) old.remove();   // one at a time
  const d = document.createElement('div');
  d.className = 'hitpop' + (hit.hard ? ' hard' : '');
  d.textContent = (hit.hard ? 'Авария · ' : 'Удар · ') + kmh(hit.impact) + ' км/ч';
  const sm = document.createElement('small');
  sm.textContent = 'авария — от ' + kmh(hit.side ? HARD_SIDE : HARD_HIT) + ' км/ч' + (hit.side ? ' в борт' : '');
  d.appendChild(sm);
  document.querySelector('.hud').appendChild(d);
  setTimeout(() => d.remove(), 1500);
}

// "ВПРИТЫК +250" next to the car, on the side of the bot it just slipped past.
function nearMissPopup(car, ev){
  _v.set(car.x, 1.5, car.z).project(camera);
  const x = (_v.x * .5 + .5) * innerWidth + (ev.side === 'left' ? -1 : 1) * Math.min(130, innerWidth * .2);
  const y = (-_v.y * .5 + .5) * innerHeight - 40;
  const d = document.createElement('div');
  d.className = 'nmpop t' + ev.level.tier;
  d.style.left = x + 'px'; d.style.top = y + 'px';
  d.textContent = ev.level.name.toUpperCase() + ' +' + fmtN(ev.points);
  const extra = [ev.mult > 1 ? '×' + String(ev.mult).replace('.', ',') : '', ev.drift ? 'в заносе ×2' : ''].filter(Boolean).join(' · ');
  if (extra) { const sm = document.createElement('small'); sm.textContent = extra; d.appendChild(sm); }
  document.querySelector('.hud').appendChild(d);
  setTimeout(() => d.remove(), 1150);
}

const HINT = '<b>W A S D</b> руль и газ · <b>Пробел</b> ручник · <b>R</b> на дорогу · <b>C</b> камера';
let lastZ = 0, fogDensity = 0, hintWas = '', shadowWas = null, view = null, camSpeed = 0, topSpeed = 0;

function pose(car, x, z){
  car.x=x; car.z=z; car.h=0; car.vx=car.vz=0; car.steer=0; car.spinV=0; car.idx=0; car.prog=0; car.off=false;
  car.lastMark=[null,null];
}

// Two cameras, switched with the C key or the «Камера» button; the choice is remembered.
//  'top'   — high above the road, looking down it (see topDownView in geometry.js);
//  'chase' — behind the car like on the track, but higher: it looks far down the road, and
//            rises with speed, so the car never hides the traffic ahead of it.
const CAM_KEY = 'nightdrift.trafficCam';
let camMode = 'top'; try { if (localStorage.getItem(CAM_KEY) === 'chase') camMode = 'chase'; } catch (e) {}
const CAM_LABEL = { top: 'Камера: сверху', chase: 'Камера: сзади' };
const pose3 = () => ({ pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 60 });
const camWas = pose3(), camGoal = pose3();
let camBlend = 1, chaseX = 0;
function setCamLabel(){ const b = $('bCam'); if (b) b.textContent = CAM_LABEL[camMode]; }
function toggleCamera(){
  camWas.pos.copy(camera.position); camWas.look.copy(camGoal.look); camWas.fov = camera.fov;
  camBlend = 0;                                              // glide to the new view over 0.45 s
  camMode = camMode === 'top' ? 'chase' : 'top';
  try { localStorage.setItem(CAM_KEY, camMode); } catch (e) {}
  setCamLabel(); flash(CAM_LABEL[camMode], null, .9);
}
// Behind the car, 6.5 m up at a standstill and 9.5 m at 180 km/h. From there the car's
// roof hides less than 3 m of road beyond it, so a bot right in front is always seen.
// The camera aims 18–40 m ahead (farther at speed) and the road runs to the horizon in
// the upper third of the screen, so traffic is seen from hundreds of metres away.
function chasePose(car, dt, out){
  const s = Math.min(1, camSpeed / 50);
  const h = 6.5 + 3 * s, back = 12 + 4 * s, ahead = 18 + 22 * s;
  chaseX += (car.x - chaseX) * (rig.init ? 1 - Math.exp(-4 * dt) : 1);
  out.pos.set(chaseX, h, car.z - back);
  out.look.set(chaseX * .5 + car.x * .5 + Math.sin(car.h) * 3, 0, car.z + ahead);
  // narrow (phone) screens: widen the view so it still spans at least 64° across
  const fitW = 2 * Math.atan(Math.tan(32 * Math.PI / 180) / camera.aspect) * 180 / Math.PI;
  out.fov = Math.min(90, Math.max(58 + 10 * s, fitW));
}

// Back on the road after an online crash: the nearest lane with no bot within 30 m,
// at the speed of the traffic (80 km/h), facing down the road.
function comeBack(car){
  const order = [0, 1, 2, 3].sort((a, b) => Math.abs(laneCenter(a) - car.x) - Math.abs(laneCenter(b) - car.x));
  const free = order.find(L => !src.bots.some(b => Math.abs(b.z - car.z) < 30 + TYPES[b.t].len / 2 && Math.abs(b.x - laneCenter(L)) < 3)) ?? order[0];
  pose(car, laneCenter(free), car.z);
  car.vz = 22; car.vF = 22;
}

export const trafficMode = {
  id: 'traffic',

  show(){
    group.visible = true;
    // Thinner fog: from above the camera is farther from the road than in the chase view.
    fogDensity = scene.fog.density; scene.fog.density = 0.0034;
    // The camera is always 20+ m above the road here, so a near plane of 1 m (instead of
    // 0.1) gives the depth buffer ten times the precision and stops the shoulders and the
    // ground from flickering through each other.
    camera.near = 1; camera.updateProjectionMatrix();
    const sc = moon.shadow.camera; shadowWas = {l:sc.left, r:sc.right, t:sc.top, b:sc.bottom};
    Object.assign(sc, {left:-60, right:60, top:60, bottom:-60}); sc.updateProjectionMatrix();
    $('map').hidden = true; $('combo').hidden = false;
    document.querySelector('#lapbox .lbl').textContent = 'Дистанция';
    document.querySelector('#scorebox .sc .lbl').textContent = 'Очки';
    hintWas = $('hint').innerHTML; $('hint').innerHTML = HINT;
    document.querySelector('.hud').classList.add('hw');
    $('bCam').hidden = false; setCamLabel();
  },
  hide(){
    group.visible = false;
    scene.fog.density = fogDensity;
    camera.near = 0.1; camera.updateProjectionMatrix();
    Object.assign(moon.shadow.camera, {left:shadowWas.l, right:shadowWas.r, top:shadowWas.t, bottom:shadowWas.b}); moon.shadow.camera.updateProjectionMatrix();
    sky.position.set(0, 150, 0); stars.position.set(0, 0, 0);
    $('map').hidden = false; $('combo').hidden = true; $('speedo').classList.remove('hot');
    document.querySelector('#lapbox .lbl').textContent = 'Круг';
    document.querySelector('#scorebox .sc .lbl').textContent = 'Очки дрифта';
    $('hint').innerHTML = hintWas;
    document.querySelector('.hud').classList.remove('hw');
    $('bCam').hidden = true;
    if(camera.view && camera.view.enabled) camera.clearViewOffset();
  },

  enter(car, {slot=0, seed=newSeed(), online=false}={}){
    const p=startPose(slot); pose(car, p.x, p.z); camSpeed=0; topSpeed=0;
    if(online){ src = remote; remote.reset(); } else { src = traffic; traffic.reset(seed, [asPlayer(car)], G.density); }
    score.reset(); banked=0; record=false; summarised=false; lastHit=null;
    wreckUntil = ghostUntil = 0; respawned = true; wrecks = 0; car.root.visible = true;
  },
  idle(car){ const p=startPose(0); pose(car, p.x, p.z); src = traffic; traffic.reset(newSeed(), [asPlayer(car)], G.density);
    wreckUntil = ghostUntil = 0; respawned = true; car.root.visible = true; },
  respawn(car){ if(wrecked()) return; pose(car, laneCenter(nearestLane(car.x)), car.z); },
  constrain(car, dt, hooks){
    constrainToHighway(car, dt, hooks);
    // a wrecked car comes to a stop within ~0.3 s (a force from outside, like a hit:
    // the physics itself is untouched)
    if(wrecked()){ const k=Math.exp(-12*dt); car.vx*=k; car.vz*=k; car.spinV*=k; }
  },
  // after every physics substep: hits with the traffic (hooks.onTrafficHit); none while ghosted
  collide(car, hooks){ if(!ghosted()) collideWithTraffic(car, src, hooks); },
  inputBlocked(){ return wrecked(); },
  isGhost(){ return ghosted(); },
  // Online: a hard hit does not end the run. Stop, blink 3 s, come back.
  ghostBounds(s){ keepOnRoad(s); },                     // another player's predicted car stays inside the rails
  onHit(car, hit){ lastHit = hit; hitPopup(car, hit); if(!hit.hard) horn(Math.max(-1, Math.min(1, (hit.bot.x - car.x) / 4)), .9); },
  wreck(car){
    const t = serverNow();
    wreckUntil = t + WRECK_MS; ghostUntil = t + WRECK_MS + GHOST_MS; respawned = false; wrecks++;
    score.breakCombo(); G.shake = 1; thud(30);
    if(NET.room) NET.room.send('wreck');
    flash('Авария', (lastHit ? 'удар ' + kmh(lastHit.impact) + ' км/ч · ' : '') + 'возврат через 3 секунды', 1.2);
  },
  netTraffic(arr){ remote.push(arr); },
  stats(){ return { misses: score.misses, wrecks }; },
  // Every race frame, after the physics and the drift scoring: near misses, combo, distance.
  score(car, dt, info){
    if(ghosted()){ score.passes.clear(); return; }      // passing through bots after a crash earns nothing
    const events = score.update(car, src, dt, info.drifting);
    G.score += score.points - banked; banked = score.points;     // drift points are added by game.js
    for(const ev of events){
      nearMissPopup(car, ev);
      whoosh(ev.side === 'left' ? -0.8 : 0.8, ev.level.tier / 3);
      // a pass within 30 cm always gets a horn, a close one now and then
      if(ev.level.tier === 3 || (ev.level.tier === 2 && Math.random() < .3)) horn(ev.side === 'left' ? -0.6 : 0.6, ev.level.tier / 3);
      const cm = $('cmult'); cm.classList.remove('bump'); void cm.offsetWidth; cm.classList.add('bump');
    }
  },
  breakCombo(){ score.breakCombo(); },
  // What the crash screen shows. The run's score is checked against the record once.
  summary(){
    if(!summarised){ summarised = true;
      record = G.score > best && G.score > 0;
      if(record){ best = G.score; try { localStorage.setItem(BEST_KEY, String(best)); } catch (e) {} } }
    return {
      score: G.score, record, best,
      stats: [
        ['Дистанция', (Math.max(0, lastZ)/1000).toFixed(2).replace('.', ',') + ' км'],
        ['Обгонов впритык', String(score.misses)],
        ['Макс. комбо', '×' + String(score.maxMult).replace('.', ',')],
        ['Макс. скорость', Math.round(topSpeed*3.6) + ' км/ч'],
        ...(lastHit && lastHit.hard ? [['Удар', kmh(lastHit.impact) + ' км/ч (авария от ' + kmh(lastHit.side ? HARD_SIDE : HARD_HIT) + ')']] : []),
        ['Время', fmtT(G.lapT)],
      ],
    };
  },
  best: () => best,

  // Every frame, in any state: keep road, ground and sky around the car, run the traffic
  // (it keeps moving behind the menu too, but stops while the game is paused).
  world(car, dt){
    if(src === remote) remote.advance(dt);
    else if(G.state!=='pause') traffic.advance(dt, [asPlayer(car)]);
    drawTraffic(src);
    // online crash: blink while wrecked (fast) and ghosted (slow); then back on the road
    if(wreckUntil){
      const t = serverNow();
      if(!respawned && t >= wreckUntil){ respawned = true; comeBack(car); $('count').textContent = ''; }
      car.root.visible = t >= ghostUntil ? true : Math.floor(t / (t < wreckUntil ? 62 : 125)) % 2 === 0;
      if(G.state==='race' && t < wreckUntil) $('count').textContent = String(Math.ceil((wreckUntil - t) / 1000));
    }
    updateChunks(car.z); followGround(car.x, car.z);
    sky.position.set(car.x, 150, car.z); stars.position.set(car.x, 0, car.z);
  },

  // Top-down camera (default), always facing down the road. Height and tilt follow the
  // car's speed along the road (smoothed), so at any speed you see at least 3 s ahead of
  // closing in on the slowest traffic. See topDownView() in geometry.js.
  // Or the chase camera (chasePose above). Switching glides from one to the other.
  camera(car, dt){
    const along = Math.max(0, car.vz);
    if(!rig.init){ camSpeed = along; chaseX = car.x; }
    camSpeed += (along - camSpeed) * (1 - Math.exp(-1.6*dt));
    const portraitPhone = isTouch && innerWidth < innerHeight;
    if(camMode === 'chase'){
      chasePose(car, dt, camGoal);
      rig.init = true;
    } else {
      view = topDownView(camSpeed, camera.aspect);
      if(isTouch) view = topDownView(camSpeed, camera.aspect, carAtOnScreen(view.fovV));
      const p = view.pitch * Math.PI / 180;
      const tx = car.x * 0.55, ty = view.height, tz = car.z - view.back;
      const k = rig.init ? 1 - Math.exp(-6*dt) : 1; rig.init = true;
      rig.pos.x += (tx - rig.pos.x) * k; rig.pos.y += (ty - rig.pos.y) * k;
      rig.pos.z = tz;                       // along the road the camera never lags: the car stays put on screen
      camGoal.pos.copy(rig.pos);
      camGoal.look.set(rig.pos.x, rig.pos.y - Math.sin(p)*10, rig.pos.z + Math.cos(p)*10);
      camGoal.fov = view.fovV;
    }
    // phones held upright, chase view: frame the picture a little higher so the car
    // sits above the touch buttons (as on the track)
    if(camMode === 'chase' && portraitPhone) camera.setViewOffset(innerWidth, innerHeight, 0, innerHeight*0.1, innerWidth, innerHeight);
    else if(camera.view && camera.view.enabled) camera.clearViewOffset();
    if(camBlend < 1){
      camBlend = Math.min(1, camBlend + dt / .45);
      const e = camBlend * camBlend * (3 - 2 * camBlend);
      camera.position.lerpVectors(camWas.pos, camGoal.pos, e);
      rig.look.lerpVectors(camWas.look, camGoal.look, e);
      camera.fov = camWas.fov + (camGoal.fov - camWas.fov) * e;
    } else {
      camera.position.copy(camGoal.pos); rig.look.copy(camGoal.look); camera.fov = camGoal.fov;
    }
    // the crash shake moves the camera sideways without turning it (a near miss moves
    // nothing: only its text fades in and out)
    let ox = 0, oz = 0;
    if(G.shake>0){ ox+=(Math.random()-.5)*G.shake*.8; oz+=(Math.random()-.5)*G.shake*.8; G.shake=Math.max(0,G.shake-dt*2.5); }
    camera.position.x += ox; camera.position.z += oz; rig.look.x += ox; rig.look.z += oz;
    camera.lookAt(rig.look);
  },
  toggleCamera,

  hud(car, dt, info){
    if(G.state==='race'){ lastZ = car.z; topSpeed = Math.max(topSpeed, Math.hypot(car.vx, car.vz)); }
    setT('lapn', (Math.max(0, car.z)/1000).toFixed(2).replace('.', ',') + ' км');
    if(NET.online && NET.room && NET.room.state.endAt){
      // online: time left in the run, the live ranking by score, the ping
      const left = Math.max(0, (NET.room.state.endAt - serverNow()) / 1000);
      setT('lapt', G.state==='count' ? fmtT(NET.room.state.duration) : 'осталось ' + Math.floor(left / 60) + ':' + String(Math.floor(left % 60)).padStart(2, '0'));
      NET.standT -= dt; if(NET.standT <= 0){ NET.standT = .25; renderStandings();
        const pe=$('ping'); pe.hidden=!NET.rtt; if(NET.rtt){ pe.textContent='Пинг '+Math.round(NET.rtt)+' мс'; pe.classList.toggle('bad',NET.rtt>180); } }
    } else setT('lapt', fmtT(G.lapT));
    setT('best', best ? 'Рекорд ' + fmtN(best) : 'Рекорд —');
    // combo panel
    const on = score.chain > 0;
    setT('cmult', '×' + String(on ? score.mult : 1).replace('.', ','));
    $('cmult').classList.toggle('max', on && score.mult >= COMBO_MAX);
    document.querySelector('#combo .cbar i').style.width = (on ? score.comboLeft / COMBO_WINDOW * 100 : 0) + '%';
    $('ctag').classList.toggle('on', G.state==='race' && drift.active);
    // the speedometer lights up when near misses count (above 80 km/h)
    const hot = G.state==='race' && Math.hypot(car.vx, car.vz) > 80/3.6;
    $('speedo').classList.toggle('hot', hot);
    // phones: the same numbers in one compact strip (#hwbar); the panels above are hidden there
    if(isTouch){
      setT('hwSpd', String(Math.round(Math.hypot(car.vx, car.vz) * 3.6))); setT('hwGear', $('gear').textContent);
      setT('hwDist', $('lapn').textContent); setT('hwTime', $('lapt').textContent);
      setT('hwScore', $('score').textContent); setT('hwMult', $('cmult').textContent);
      setT('hwBest', ($('ping').hidden ? '' : $('ping').textContent.replace('Пинг ', '') + ' · ') + $('best').textContent.toLowerCase());
      $('hwbar').classList.toggle('hot', hot);
      $('hwMult').classList.toggle('max', on && score.mult >= COMBO_MAX);
      $('hwMult').classList.toggle('drift', G.state==='race' && drift.active);
      document.querySelector('#hwbar .hwcbar i').style.width = (on ? score.comboLeft / COMBO_WINDOW * 100 : 0) + '%';
    }
    if(G.state==='race'){
      const back = Math.cos(car.h) < -.3 && info.speed > 4;
      G.wrongT = back ? G.wrongT + dt : 0;
      if(G.wrongT>.8 && G.toastT<=0) flash('Не туда — разворачивайся', null, .6);
    }
  },

  drawMap(){},
  view: () => view,
};
