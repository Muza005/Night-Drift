// Night Drift: start-up, game flow and the frame loop.
//
// Each physics substep is: stepCar() (frozen, same for every mode) and then
// G.mode.constrain() (the mode's walls and rules). Everything else here is the
// single-file version's loop, split across modules.
import { $, G, NET, drift, isTouch, serverNow } from './state.js';
import { canvas, renderer, scene, camera, moon, qualityTick, drawBackdrop } from './core/render.js';
import './modes/track/scene.js';            // scenery first, then the cars (same order as before)
import { trackMode } from './modes/track/index.js';
import { car } from './player.js';
import { addMark, emitSmoke, clearMarks, updateSmoke } from './core/fx.js';
import { input, NOINPUT, KEYMAP, clearInput } from './core/input.js';
import { audioInit, audioUpdate, toggleSound, audioSuspend, audioResume, audioDraft, audioRumble, beep } from './core/audio.js';
import { stepCar } from './core/physics.js';
import { rig } from './core/cameraRig.js';
import { scoring, dropDrift, resetToTrack, physicsHooks } from './game.js';
import { collideGhosts, updateGhosts, sendState, leaveOnline, connectRoom, inviteCode } from './net/net.js';
import { lift } from './net/bump.js';
import { setT, fmtN, fmtT, showPanel, netStatus, dismissMenu, hideMenu, releasePicture, dropPicture } from './ui/hud.js';
import { fly, flying, flyCamera } from './ui/startFx.js';
import { openGarage, garage } from './ui/garageScreen.js';
import { lobby } from './ui/lobbyScreen.js';
import { homeScreen, openHome as openHomeDeck } from './ui/homeScreen.js';
import { choice, savePick } from './ui/garage.js';
import { applyLook } from './player.js';
import { preloadAll } from './core/carModels.js';

if (isTouch) document.body.classList.add('touch');
import { records, saveScore, migrate } from './records.js';
const LS = {
  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} },
};
// solo drift records per map (records.js): G.best (lap, s) and G.bestScore are the active map's
migrate();
function loadRecords(){ const r=records(trackMode.mapId); G.best=r.lap; G.bestScore=r.score; }
loadRecords();

/* ---------- modes ----------
   The drift track is built at start-up; the highway module loads the first time it is
   needed. Switching hides one mode's scenery and HUD and shows the other's. */
const modes = { track: trackMode, traffic: null };
let trafficMod = null;
async function loadMode(id){
  if(id==='traffic' && !modes.traffic){ trafficMod = await import('./modes/traffic/index.js'); modes.traffic = trafficMod.trafficMode; }
  return modes[id] || trackMode;
}
let modeWanted = 'track';
async function setMode(id){
  modeWanted = id;
  const m = await loadMode(id);
  // the highway module loads the first time it is asked for: if another mode was asked
  // for meanwhile (the host flips the mode in the lobby), that later request wins
  if(modeWanted!==id || G.mode===m) return;
  G.mode.hide(); m.show(); G.mode=m;
  m.idle(car); clearMarks(); rig.init=false;
  LS.set('nightdrift.mode', m.id);
}
G.mode = trackMode; trackMode.show();
G.setMode = setMode;            // net.js switches to the room's mode
{ const q=new URLSearchParams(location.search).get('mode'), id=(q==='traffic'||q==='track') ? q : LS.get('nightdrift.mode');
  if(id==='traffic') await setMode('traffic'); }

/* ---------- physics step ---------- */
function physics(dt){
  const I=((NET.online&&NET.finished)||G.state==='crash'||(G.mode.inputBlocked&&G.mode.inputBlocked()))?NOINPUT:input;
  // in the air after a crest (maps with heights): no grip, steering or throttle; the
  // track mode flies the car in constrain() instead (modes/track/geometry.js)
  if(!(car.air && G.mode.id==='track')) stepCar(car,I,dt);
  G.mode.constrain(car,dt,physicsHooks);
  if(G.mode.collide) G.mode.collide(car,physicsHooks);   // traffic mode: hits with bots
}

/* ---------- keys ---------- */
addEventListener('keydown',e=>{
  if(e.target && e.target.tagName==='INPUT') return;
  // A key held since before a screen opened (the handbrake through a crash or a pause)
  // must not press that screen's button. Its auto-repeat lands on the button the screen
  // focused, and letting the key go then clicked it: the pause ended by itself.
  if(e.repeat && e.target && e.target.tagName==='BUTTON') e.preventDefault();
  const k=KEYMAP[e.code]; if(k){ input[k]=1; if(G.state==='race'||G.state==='count') e.preventDefault(); }
  if(e.code==='KeyR' && G.state==='race' && !NET.finished) resetToTrack();
  // one press, one switch: held a moment too long, these keys used to flick the pause, the
  // sound and the camera on and off 30 times a second (the keyboard's auto-repeat)
  if(!NET.online && !e.repeat){
    if((e.code==='KeyP'||e.code==='Escape') && (G.state==='race'||G.state==='count')) pause();
    else if((e.code==='KeyP'||e.code==='Escape') && G.state==='pause'){ e.preventDefault(); resume(); }
  }
  // (not when another screen's handler already took this Esc: the garage going back here)
  if(e.code==='KeyM' && !e.repeat) toggleSound();
  if(e.code==='KeyC' && !e.repeat && G.mode && G.mode.toggleCamera) G.mode.toggleCamera();
  if(G.state==='over' && !e.repeat){                           // a fresh press only: a held handbrake skipped the crash screen
    if(e.code==='Space'||e.code==='Enter'){ e.preventDefault(); startRace(true); }
    else if(e.code==='Escape') toMenu();
  }
});
addEventListener('keyup',e=>{ const k=KEYMAP[e.code]; if(k) input[k]=0; });
addEventListener('blur',()=>{ clearInput(); });
$('bSound').addEventListener('click',()=>{ toggleSound(); canvas.focus(); });
$('bCam').addEventListener('click',()=>{ if(G.mode && G.mode.toggleCamera) G.mode.toggleCamera(); canvas.focus(); });
$('bPause').addEventListener('click',()=>{ if(NET.online) leaveOnline(); else if(G.state==='race'||G.state==='count') pause(); });

/* ---------- flow ---------- */
// quick: straight after a crash, skip the 3-2-1 (back on the road in under a second)
// flight: from the garage. The garage dissolves (its last picture was kept: hud.js
// holdPicture), the camera flies to the car on the grid during a dark first second, then 3-2-1.
function startRace(quick=false, flight=false){
  audioInit();
  canvas.focus();
  if(flight){ dismissMenu().then(ok=>{ if(ok && G.state!=='race' && G.state!=='count') enterRun(quick, flight); else dropPicture(); }); return; }
  hideMenu();                                                 // a restart: straight back on the road
  enterRun(quick, flight);
}
function enterRun(quick, flight){
  G.mode.enter(car,{slot:0}); loadRecords();
  G.raceT=0; G.lapT=0; G.lap=1; G.score=0; G.runBest=0; G.runRecord=false; G.runEnd=false; dropDrift(); clearMarks();
  G.state='count';
  fly(flight); releasePicture();
  if(quick){ G.cd=0.45; G.prevCount=1; $('count').textContent=''; }
  else if(flying()){ G.cd=4; G.prevCount=4; $('count').textContent=''; }   // (no flight, reduced motion: 3 at once)
  else { G.cd=3; G.prevCount=3; showCount('3'); }
}
// A number of the countdown: it lands with its beep (core/audio.js beep), «Старт!» higher.
function showCount(t){
  const c=$('count'), go=t==='Старт!';
  c.textContent=t; c.classList.toggle('go',go);
  c.classList.remove('tick'); void c.offsetWidth; c.classList.add('tick');
  beep(go);
}
function pause(){ G.state='pause'; clearInput(); audioSuspend(); showPanel('pPause'); $('resume').focus(); }
function resume(){ $('menu').hidden=true; G.state=G.cd>0?'count':'race'; audioResume(); canvas.focus(); }
function toMenu(){
  if(G.state==='pause') audioResume();
  // back to the mode screen the run was started from, with its records up to date
  G.state='menu'; G.mode.idle(car); clearMarks(); dropDrift(); $('count').textContent='';
  // solo: back to the garage the run was started from (one more step back: the mode cards)
  if(menuKind==='solo') openSoloGarage('back'); else openModes(menuKind,'back');
}
// a key press on a focused button also fires its click: act only in the right state
$('resume').addEventListener('click',()=>{ if(G.state==='pause') resume(); });
$('restart').addEventListener('click',()=>{ if(G.state==='pause'){ audioResume(); startRace(); } });
$('pauseMenu').addEventListener('click',()=>{ if(G.state==='pause') toMenu(); });

/* ---------- menu screens ----------
   Home: Одиночная, Онлайн (Карьера is not ready). Either opens the mode screen: Дрифт
   (track) or Трасса (traffic). Solo, a card starts the run; online, it makes a room in
   that mode, and a code typed under the cards joins a friend's room. */
// highway traffic density: low | mid | high (modes/traffic/sim.js DENSITY), remembered;
// online the host's choice in the lobby wins
G.density = ['low','mid','high'].includes(LS.get('nightdrift.density')) ? LS.get('nightdrift.density') : 'mid';
let menuKind = 'solo';                   // which mode screen is open: 'solo' | 'online'

// Focus moves with the screens when they are changed, so the keyboard carries on where the
// eye is; on the very first screen nothing is focused (no ring on a card nobody chose).
// After a click or tap the ring stays hidden (focusVisible: false): it is for keyboards.
let viaKeys = false;
addEventListener('keydown', () => { viaKeys = true; }, true);
addEventListener('pointerdown', () => { viaKeys = false; }, true);
const moveFocus = el => el.focus({ preventScroll: true, focusVisible: viaKeys });
// Home: the car on the street and the deck of cards (ui/homeScreen.js). Back from the online
// screen the focus is on «С друзьями», otherwise on the mode last played.
function openHome(dir){
  const was = menuKind;
  menuKind = 'solo';
  openHomeDeck({ level:'home', dir, focus: was==='online' ? 'goOnline' : G.mode.id==='traffic' ? 'dTraffic' : 'dTrack' });
}
homeScreen.map = () => trackMode.mapId;
// the player's own records on the cards: a map's best lap, the highway's best score
homeScreen.record = it => {
  if(it.map){ const r = records(it.map); return r.lap ? fmtT(r.lap) : ''; }
  if(it.go==='traffic'){ const tb = parseInt(LS.get('nightdrift.trafficBest'),10) || 0; return tb ? fmtN(tb) : ''; }
  return '';
};
homeScreen.on = {
  // a map card: that map, its records, then the garage
  async drift(mapId){
    if(G.state!=='menu') return;
    if(G.setSoloMap(mapId) && G.mode.id==='track'){ G.mode.idle(car); clearMarks(); }
    loadRecords();
    menuKind = 'solo'; pick('track');
  },
  traffic(){ if(G.state==='menu'){ menuKind = 'solo'; pick('traffic'); } },
  // «С друзьями» → «Создать комнату» → a mode: the room is made in it
  online(mode){ if(G.state==='menu'){ menuKind = 'online'; pick(mode); } },
};
// The online level of the home deck («С друзьями»): after leaving a room, from a run online,
// from an invite. kind 'solo' is the home screen itself.
function openModes(kind, dir){
  if(kind!=='online') return openHome(dir);
  menuKind = 'online';
  return openHomeDeck({ level:'friends', dir, focus:'fHost' });
}
G.openModes = openModes;                 // net.js: back here after leaving a room

async function pick(id){
  if(G.state!=='menu') return;
  // the highway's module loads the first time it is picked: a failed load says so
  try{ await setMode(id); }
  catch(e){ console.error('mode failed to load', id, e); netStatus('netStatus','Не загрузился режим. Проверьте интернет и попробуйте ещё раз.',true); return; }
  if(menuKind==='online'){
    NET.wantMode = id;                   // the room starts in this mode
    connectRoom('create');
    return;
  }
  openSoloGarage('forward');
}
// Solo: the mode card leads to the garage; "Поехали" starts the run with the pick, "←"
// goes back to the mode cards and drops it.
function openSoloGarage(dir){
  return openGarage({ kind:'solo', mode:G.mode.id, car:choice.car, paint:choice.paint, dir,
    onGo(carId, paint){ savePick(carId, paint); applyLook(carId, paint); startRace(false, true); },
    // back to the deck it came from: the map deck (on the map) or the modes (on «Трасса»)
    onBack(){ if(G.mode.id==='track') openHomeDeck({ level:'maps', dir:'back', focus: trackMode.mapId }); else openHome('back'); },
    // a map picked in the garage: the track switches to it now, its records come with it
    onMap(id){ if(G.setSoloMap(id) && G.mode.id==='track'){ G.mode.idle(car); clearMarks(); } loadRecords(); },
  }).then(()=>moveFocus($('garGo')));
}

// Crash screen (traffic mode, solo): the score big, a record badge, the run's numbers.
function showOver(){
  G.state='over'; clearInput();
  // The car stands still from here on (no physics on this screen): without this the
  // speedometer kept the last speed, the wheels kept turning, and the traffic took the
  // wreck for a car still doing that speed and drove through it.
  car.vx=car.vz=car.vF=car.vR=0; car.spinV=0; dropDrift();
  const R = G.mode.summary();
  overTitle('Авария', 'на трассе'); $('overLbl').textContent = 'Очки';
  $('overScore').textContent = fmtN(R.score);
  $('overRecord').hidden = !R.record; $('overRecord').textContent = 'Новый рекорд';
  $('overBest').textContent = R.record ? '' : (R.best ? 'Рекорд ' + fmtN(R.best) : '');
  const box=$('overStats'); box.replaceChildren();
  for(const [k,v] of R.stats){
    const d=document.createElement('div'); const a=document.createElement('span'); a.className='lbl'; a.textContent=k;
    const b=document.createElement('b'); b.className='num'; b.textContent=v; d.append(a,b); box.append(d);
  }
  showPanel('pOver'); $('retry').focus();
}
function overTitle(a, b){ const h=$('overTitle'), sp=document.createElement('span'); sp.textContent=b; h.replaceChildren(a+' ', sp); }
// Solo drift: the run is N laps (the garage's gear button); after the last one, the finish screen:
// the drift points big, the run's time, its best lap, a badge for a lap record.
function showFinish(){
  G.state='over'; clearInput(); G.runEnd=false;
  car.vx=car.vz=car.vF=car.vR=0; car.spinV=0;
  overTitle('Финиш', G.soloLaps+' '+(G.soloLaps===1?'круг':G.soloLaps<5?'круга':'кругов'));
  $('overLbl').textContent = 'Очки дрифта';
  $('overScore').textContent = fmtN(G.score);
  // the map's records: the lap (finishLap keeps it) and the run's drift score
  const scoreRec = saveScore(trackMode.mapId, G.score); if(scoreRec) G.bestScore = G.score;
  $('overRecord').hidden = !G.runRecord && !scoreRec;
  $('overRecord').textContent = G.runRecord && scoreRec ? 'Рекорд круга и очков' : G.runRecord ? 'Рекорд круга' : 'Рекорд очков';
  $('overBest').textContent = [!G.runRecord && G.best ? 'Рекорд круга ' + fmtT(G.best) : '', !scoreRec && G.bestScore ? 'рекорд очков ' + fmtN(G.bestScore) : ''].filter(Boolean).join(' · ');
  const box=$('overStats'); box.replaceChildren();
  for(const [k,v] of [['Время', fmtT(G.raceT)], ['Лучший круг', G.runBest ? fmtT(G.runBest) : '—'], ['Круги', String(G.soloLaps)]]){
    const d=document.createElement('div'); const a=document.createElement('span'); a.className='lbl'; a.textContent=k;
    const b=document.createElement('b'); b.className='num'; b.textContent=v; d.append(a,b); box.append(d);
  }
  showPanel('pOver'); $('retry').focus();
}
$('retry').addEventListener('click',()=>{ if(G.state==='over') startRace(true); });
$('overMenu').addEventListener('click',()=>{ if(G.state==='over') toMenu(); });
G.mode.idle(car);
// The "?room=CODE" invite link opens the online screen with the code filled in.
{ const code=inviteCode();
  if(code){ openHomeDeck({ level:'friends', focus:'fJoin' }); $('codeIn').value=code; netStatus('netStatus','Вас пригласили в комнату '+code+'. Нажмите «Войти».'); $('joinRoom').focus(); }
  else openHome(); }

/* ---------- loop ---------- */
let last=performance.now(), menuA=0;
// The camera behind a menu screen: circling the car (the menus themselves show the drawn
// city of core/render.js drawBackdrop, not the race).
function menuView(){
  rig.pos.set(car.x+Math.sin(menuA)*11,4.2,car.z+Math.cos(menuA)*11);
  camera.position.copy(rig.pos); rig.look.set(car.x,.9,car.z); camera.lookAt(rig.look); rig.init=false;
  camera.fov=58; if(camera.view && camera.view.enabled) camera.clearViewOffset();
  camera.updateProjectionMatrix();
}
// A menu screen with nothing of the race moving (home, the mode cards, the results, the
// pause and the finish or crash screen): the scene is drawn once, not every frame, and the
// canvas keeps that picture. Behind home, the cards and the results it is the drawn night
// city the garage uses; behind pause and the finish screen, the race as it stood.
// Drawn again only when something it shows changes: the mode, my car, the window.
let stillKey='', audioIdle=false;
canvas.addEventListener('webglcontextrestored',()=>{ stillKey=''; });   // the still picture is gone with the context: draw it again
function stillFrame(){
  if($('menu').hidden){ stillKey=''; return false; }
  const s=G.state, frozen=s==='pause'||s==='over';
  if(!frozen && s!=='menu' && s!=='results' && s!=='lobby') return false;
  const key=s+'|'+G.mode.id+'|'+(car.model?car.model.carId+':'+car.model.code:'')+'|'+innerWidth+'x'+innerHeight+'@'+renderer.getPixelRatio();
  if(key!==stillKey){
    stillKey=key;
    if(frozen) renderer.render(scene,camera);
    else drawBackdrop();
  }
  return true;
}
function frame(now){
  requestAnimationFrame(frame);
  const realDt=Math.max(.001,(now-last)/1000), dt=Math.min(.05,realDt); last=now;
  // The garage is up: only the stand is drawn, on the drawn night city.
  // Out of the race (results, the menu, the garage…) the engine and the tyres go back to
  // idle once, and the shoulder rumble and the slipstream wind stop: the screens below
  // return early and never reach the audio further down.
  const racing=G.state==='race'||G.state==='count'||G.state==='crash';
  if(!racing && !audioIdle){ audioUpdate(.2,0,0); audioRumble(0); audioDraft(0); audioIdle=true; } else if(racing) audioIdle=false;
  if(garage.open){ stillKey=''; garage.frame(now); return; }
  if(lobby.open){ stillKey=''; lobby.frame(now); return; }        // the lobby: the same, with my car
  if(homeScreen.open){ stillKey=''; homeScreen.frame(now); return; }   // home: my car on the street
  if(stillFrame()) return;
  // Below 20 fps the game runs in slow motion; others must predict this car at its real pace.
  NET.pace=(NET.pace||1)*.9+(dt/realDt)*.1;
  qualityTick(realDt, G.state==='race');                      // slow device: fewer pixels, then no shadows
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

  input.draft=NET.draft.level;                               // slipstream behind another player
  audioDraft(G.state==='race' ? NET.draft.level : 0);
  if(G.state==='race'){
    G.raceT+=dt; G.lapT+=dt;
    const h=dt/2; physics(h); collideGhosts(h); physics(h); collideGhosts(h);
    // a crash in one of the two steps ends the run right there: no drift or near miss is
    // scored for the frame of the crash (the drift meter used to come back on and stay)
    if(G.state==='race'){
      info=scoring(dt);
      if(G.mode.score) G.mode.score(car,dt,info);            // traffic mode: near misses, combo, distance
    }
    if(G.runEnd) showFinish();                                 // solo drift: the last lap is done
  } else if(G.state==='crash'){
    const h=gdt/2; physics(h); physics(h);
    if(G.crashT>=1.2) showOver();
  }

  /* visuals */
  const fx=Math.sin(car.h), fz=Math.cos(car.h), rx=Math.cos(car.h), rz=-Math.sin(car.h);
  // on a map with heights: the car's height, and pitch and roll from the road under it
  const pose=G.mode.pose?G.mode.pose(car,dt):null, cy=pose?pose.y:0;
  // a hard hit by another player's car lifts it a moment (net/bump.js): on maps with heights
  // that is a real hop (car.air, in pose.y); elsewhere only drawn
  car.root.position.set(car.x,cy+lift(car,dt),car.z);
  // a landing squashes the body toward the road (scaled from the ground up, so the wheels
  // never sink into it)
  if(pose){ car.root.rotation.set(pose.pitch,car.h,pose.roll,'YXZ'); car.body.scale.y=1-pose.squash*.5; }
  else { car.root.rotation.set(0,car.h,0); car.body.scale.y=1; }
  // No body roll in a slide: the 3D models' wheels are part of the body, so leaning it
  // pushed the tyres on one side into the road.
  car.pitch+=(((input.down&&car.vF>1)?.035:input.up?-.02:0)-car.pitch)*Math.min(1,dt*5);
  car.body.rotation.x=car.pitch;
  if(G.state!=='pause') car.spin+=car.vF*dt/.38;             // paused: the wheels stand still like everything else
  car.wheels.forEach((w,i)=>{ w.rotation.x=(i>1&&input.hb&&G.state==='race')?w.rotation.x:car.spin; });
  car.pivots.forEach(p=>p.rotation.y=-car.steer*.5);
  car.tailMat.emissiveIntensity=input.down&&G.state==='race'?4.5:1.4;

  const slide=G.state==='race'?Math.min(1,Math.max(0,(Math.abs(car.vR)-3)/10)):0;
  const smokeOn=G.state==='race' && info.speed>5 && (Math.abs(car.vR)>4.5 || (input.hb&&info.speed>8));
  for(const [k,lx] of [[0,.95],[1,-.95]]){
    const wx=car.x+rx*lx+fx*-1.35, wz=car.z+rz*lx+fz*-1.35;
    if(smokeOn && !car.air){ addMark(car,k,wx,wz,cy); if(Math.random()<.425) emitSmoke(wx,wz,car.vx,car.vz,slide+.3,cy); }
    else car.lastMark[k]=null;
  }
  sendState(dt,slide);
  updateGhosts(dt);
  updateSmoke(dt);
  car.under.material.opacity=.45+slide*.35;

  // camera
  if(G.state==='menu'||G.state==='lobby'||G.state==='results'){
    menuA+=dt*.22; menuView();
  } else {
    G.mode.camera(car,dt);
    flyCamera(camera,car,rig.look,dt,G.state==='race');                         // the way in: to the grid (ui/startFx.js)
  }
  camera.updateProjectionMatrix();
  moon.position.set(car.x+30,60+cy,car.z+20); moon.target.position.set(car.x,cy,car.z);

  // audio
  const spd=Math.abs(car.vF);
  const bands=[0,12,22,33,45,58,72]; let gear=1; while(gear<6 && spd>bands[gear]) gear++;   // six gears up to 250 km/h
  const lo=bands[gear-1], hi=bands[gear]; const rpm=.25+.75*Math.min(1,(spd-lo)/(hi-lo));
  audioUpdate(G.state==='race'?rpm:.2, G.state==='race'?input.up:0, slide);
  audioRumble(G.state==='race' && car.off && G.mode.id==='traffic' ? Math.hypot(car.vx,car.vz) : 0);   // on the highway shoulder

  // HUD
  const kmh=Math.round(Math.hypot(car.vx,car.vz)*3.6);
  { const on=NET.draft.level>.05; $('speedo').classList.toggle('draft',on); $('hwbar').classList.toggle('draft',on); }
  setT('spd',String(kmh)); setT('gear',car.vF<-.5?'R':kmh<2?'N':String(gear));
  $('sbar').firstChild.style.width=Math.min(100,kmh/250*100)+'%';
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
if(/[?&]debug/.test(location.search)) window.__nd={car,NET,G,camera,renderer,scene,get traffic(){ return trafficMod&&trafficMod.traffic; },get remote(){ return trafficMod&&trafficMod.remote; },setMode};
requestAnimationFrame(frame);
// The other cars' models load in the background once the first menu frame is up, one by
// one, nearest to the picked car first (that one started at once: player.js asks for it,
// and index.html already preloads its file). Held while a race runs (crash included).
requestAnimationFrame(()=>setTimeout(()=>preloadAll(choice.car,()=>G.state==='race'||G.state==='count'||G.state==='crash'),0));
document.addEventListener('visibilitychange',()=>{ if(document.hidden && !NET.online && (G.state==='race'||G.state==='count')) pause(); });
