// Night Drift: start-up, game flow and the frame loop.
//
// Each physics substep is: stepCar() (frozen, same for every mode) and then
// G.mode.constrain() (the mode's walls and rules). Everything else here is the
// single-file version's loop, split across modules.
import { $, G, NET, drift, isTouch, serverNow } from './state.js';
import { canvas, renderer, scene, camera, moon } from './core/render.js';
import './modes/track/scene.js';            // scenery first, then the cars (same order as before)
import { trackMode } from './modes/track/index.js';
import { car } from './player.js';
import { addMark, emitSmoke, clearMarks, updateSmoke } from './core/fx.js';
import { input, NOINPUT, KEYMAP, clearInput } from './core/input.js';
import { audioInit, audioUpdate, toggleSound, audioSuspend, audioResume } from './core/audio.js';
import { stepCar } from './core/physics.js';
import { rig } from './core/cameraRig.js';
import { scoring, dropDrift, resetToTrack, physicsHooks } from './game.js';
import { collideGhosts, updateGhosts, sendState, leaveOnline } from './net/net.js';
import { setT, fmtN, fmtT, showPanel } from './ui/hud.js';

if (isTouch) document.body.classList.add('touch');
try{ const b=parseFloat(localStorage.getItem('nightdrift.best')); if(b>0) G.best=b; }catch(e){}
// Mode. Until the menu gets its mode picker (stage 5), the highway opens with ?mode=traffic.
const MODE = new URLSearchParams(location.search).get('mode');
let trafficMod = null;
if (MODE === 'traffic') {
  trafficMod = await import('./modes/traffic/index.js');
  const { trafficMode } = trafficMod;
  trackMode.hide(); G.mode = trafficMode;
  // Not online yet (stage 6), and the menu text is still about the track.
  $('toOnline').hidden = true;
  document.querySelector('#pMain h1').innerHTML = 'Night <span>Traffic</span>';
  document.querySelector('#pMain p').textContent = 'Шоссе в разработке: обгоняй поток. Задел бота — он притормозит, влетел в него на скорости — авария. Очки появятся на следующем этапе.';
} else G.mode = trackMode;
G.mode.show();

/* ---------- physics step ---------- */
function physics(dt){
  const I=((NET.online&&NET.finished)||G.state==='crash')?NOINPUT:input;
  stepCar(car,I,dt);
  G.mode.constrain(car,dt,physicsHooks);
  if(G.mode.collide) G.mode.collide(car,physicsHooks);   // traffic mode: hits with bots
}

/* ---------- keys ---------- */
addEventListener('keydown',e=>{
  if(e.target && e.target.tagName==='INPUT') return;
  const k=KEYMAP[e.code]; if(k){ input[k]=1; if(G.state==='race'||G.state==='count') e.preventDefault(); }
  if(e.code==='KeyR' && G.state==='race' && !NET.finished) resetToTrack();
  if(!NET.online){
    if((e.code==='KeyP'||e.code==='Escape') && (G.state==='race'||G.state==='count')) pause();
    else if((e.code==='KeyP') && G.state==='pause') resume();
  }
  if(e.code==='KeyM') toggleSound();
  if(G.state==='over'){
    if(e.code==='Space'||e.code==='Enter'){ e.preventDefault(); startRace(); }
    else if(e.code==='Escape') toMenu();
  }
});
addEventListener('keyup',e=>{ const k=KEYMAP[e.code]; if(k) input[k]=0; });
addEventListener('blur',()=>{ clearInput(); });
$('bSound').addEventListener('click',()=>{ toggleSound(); canvas.focus(); });
$('bPause').addEventListener('click',()=>{ if(NET.online) leaveOnline(); else if(G.state==='race'||G.state==='count') pause(); });

/* ---------- flow ---------- */
function startRace(){
  audioInit();
  $('menu').hidden=true; canvas.focus();
  G.mode.enter(car,{slot:0});
  G.raceT=0; G.lapT=0; G.lap=1; G.score=0; dropDrift(); clearMarks();
  G.state='count'; G.cd=3; G.prevCount=3; showCount('3');
}
function showCount(t){ const c=$('count'); c.textContent=t; c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
function pause(){ G.state='pause'; clearInput(); audioSuspend();
  showPanel('pMain'); $('go').textContent='Продолжить'; renderBest(); }
function resume(){ $('menu').hidden=true; G.state=G.cd>0?'count':'race'; audioResume(); canvas.focus(); }
function renderBest(){ $('menuBest').textContent=G.best&&G.mode.id==='track'?'Лучший круг: '+fmtT(G.best):''; }
$('go').addEventListener('click',()=>{ if(G.state==='pause') resume(); else startRace(); });

// Crash screen (traffic mode, solo). The full results screen arrives with the menu (stage 5).
function showOver(){
  G.state='over'; clearInput();
  const box=$('overStats'); box.replaceChildren();
  for(const [k,v] of (G.mode.summary ? G.mode.summary() : [])){
    const d=document.createElement('div'); const a=document.createElement('span'); a.className='lbl'; a.textContent=k;
    const b=document.createElement('b'); b.className='num'; b.textContent=v; d.append(a,b); box.append(d);
  }
  showPanel('pOver'); $('retry').focus();
}
function toMenu(){ G.state='menu'; G.mode.idle(car); clearMarks(); showPanel('pMain'); $('go').textContent='Поехали'; renderBest(); }
// a key press on a focused button also fires its click: act only once
$('retry').addEventListener('click',()=>{ if(G.state==='over') startRace(); });
$('overMenu').addEventListener('click',()=>{ if(G.state==='over') toMenu(); });
renderBest();
G.mode.idle(car);

/* ---------- loop ---------- */
let last=performance.now(), menuA=0;
function frame(now){
  requestAnimationFrame(frame);
  const realDt=Math.max(.001,(now-last)/1000), dt=Math.min(.05,realDt); last=now;
  // Below 20 fps the game runs in slow motion; others must predict this car at its real pace.
  NET.pace=(NET.pace||1)*.9+(dt/realDt)*.1;
  let info={drifting:false,ang:0,speed:Math.hypot(car.vF,car.vR)};

  if(G.state==='count'){
    // Online, every player counts down to the same server moment, so all cars launch together.
    if(NET.online && NET.room) G.cd=(NET.room.state.startAt-serverNow())/1000; else G.cd-=dt;
    const n=Math.ceil(G.cd);
    if(n!==G.prevCount){ G.prevCount=n;
      if(n>3) $('count').textContent='';
      else if(n>0) showCount(String(n));
      else { showCount('Старт!'); G.state='race'; G.lapT=Math.max(0,-G.cd); setTimeout(()=>{ if($('count').textContent==='Старт!') $('count').textContent=''; },900); } }
  }
  // A crash plays in slow motion for 0.6 s, the car sliding on without input; the
  // crash screen follows at 1.2 s.
  let gdt=dt;
  if(G.state==='crash'){ G.crashT+=dt; if(G.crashT<0.6) gdt=dt*0.25; }
  // The mode's world goes first (the traffic moves), so the physics below collides with
  // bots exactly where they are drawn this frame.
  G.mode.world(car,gdt);

  if(G.state==='race'){
    G.raceT+=dt; G.lapT+=dt;
    const h=dt/2; physics(h); collideGhosts(); physics(h); collideGhosts();
    info=scoring(dt);
  } else if(G.state==='crash'){
    const h=gdt/2; physics(h); physics(h);
    if(G.crashT>=1.2) showOver();
  }

  /* visuals */
  const fx=Math.sin(car.h), fz=Math.cos(car.h), rx=Math.cos(car.h), rz=-Math.sin(car.h);
  car.root.position.set(car.x,0,car.z); car.root.rotation.y=car.h;
  car.roll+=(Math.max(-.11,Math.min(.11,car.vR*.012))-car.roll)*Math.min(1,dt*6);
  car.body.rotation.z=car.roll;
  car.pitch+=(((input.down&&car.vF>1)?.035:input.up?-.02:0)-car.pitch)*Math.min(1,dt*5);
  car.body.rotation.x=car.pitch;
  car.spin+=car.vF*dt/.38;
  car.wheels.forEach((w,i)=>{ w.rotation.x=(i>1&&input.hb&&G.state==='race')?w.rotation.x:car.spin; });
  car.pivots.forEach(p=>p.rotation.y=-car.steer*.5);
  car.tailMat.emissiveIntensity=input.down&&G.state==='race'?4.5:1.4;

  const slide=G.state==='race'?Math.min(1,Math.max(0,(Math.abs(car.vR)-3)/10)):0;
  const smokeOn=G.state==='race' && info.speed>5 && (Math.abs(car.vR)>4.5 || (input.hb&&info.speed>8));
  for(const [k,lx] of [[0,.95],[1,-.95]]){
    const wx=car.x+rx*lx+fx*-1.35, wz=car.z+rz*lx+fz*-1.35;
    if(smokeOn){ addMark(car,k,wx,wz); if(Math.random()<.85) emitSmoke(wx,wz,car.vx,car.vz,slide+.3); }
    else car.lastMark[k]=null;
  }
  sendState(dt,slide);
  updateGhosts(dt);
  updateSmoke(dt);
  car.under.material.opacity=.45+slide*.35;

  // camera
  if(G.state==='menu'||G.state==='lobby'||G.state==='results'){
    menuA+=dt*.22; rig.pos.set(car.x+Math.sin(menuA)*11,4.2,car.z+Math.cos(menuA)*11);
    camera.position.copy(rig.pos); rig.look.set(car.x,.9,car.z); camera.lookAt(rig.look); rig.init=false;
    camera.fov=58;
  } else {
    G.mode.camera(car,dt);
  }
  camera.updateProjectionMatrix();
  moon.position.set(car.x+30,60,car.z+20); moon.target.position.set(car.x,0,car.z);

  // audio
  const spd=Math.abs(car.vF);
  const bands=[0,12,22,32,42,60]; let gear=1; while(gear<5 && spd>bands[gear]) gear++;
  const lo=bands[gear-1], hi=bands[gear]; const rpm=.25+.75*Math.min(1,(spd-lo)/(hi-lo));
  audioUpdate(G.state==='race'?rpm:.2, G.state==='race'?input.up:0, slide);

  // HUD
  const kmh=Math.round(Math.hypot(car.vx,car.vz)*3.6);
  setT('spd',String(kmh)); setT('gear',car.vF<-.5?'R':kmh<2?'N':String(gear));
  $('sbar').firstChild.style.width=Math.min(100,kmh/180*100)+'%';
  setT('bPause',NET.online?'Выйти':'Пауза');
  setT('score',fmtN(G.score));
  const dEl=$('drift');
  if(drift.active && drift.pts>5){ dEl.classList.add('on'); setT('dpts',fmtN(drift.pts)); setT('dmult','×'+drift.mult); setT('dang',Math.round(info.ang)+'°');
    $('dbar').firstChild.style.width=(drift.mult>=5?100:((drift.time%1.8)/1.8*100))+'%'; }
  else dEl.classList.remove('on');
  G.mode.hud(car,dt,info);
  if(G.toastT>0){ G.toastT-=dt; if(G.toastT<=0) $('toast').classList.remove('on'); }
  G.mode.drawMap(car);
  renderer.render(scene,camera);
}
if(/[?&]debug/.test(location.search)) window.__nd={car,NET,G,camera,renderer,traffic:trafficMod&&trafficMod.traffic};
requestAnimationFrame(frame);
document.addEventListener('visibilitychange',()=>{ if(document.hidden && !NET.online && (G.state==='race'||G.state==='count')) pause(); });
