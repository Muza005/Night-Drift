/* ---------- online ----------
   Each player's car is simulated on their own computer and streamed to the server
   30-40 times a second, stamped with a clock synced to the server. The server owns the
   race itself: the room, the start moment, lap times, finishing order. Other players'
   cars are predicted forward to the present moment (position + velocity × age of the
   update) and eased toward each new prediction, so what you see matches what they see.

   Started as a move from the single-file version (same rates, clock sync, prediction,
   smoothing and collision exchange); the lobby since added the ready, kick/kicked,
   name, pick and config messages, a per-browser id (pid) on joining, and close code
   4001 for a kicked player.

   Stage 6 adds the highway: the room's mode (picked by the host in the lobby), the
   server's traffic snapshots ('tr', handed to the traffic mode), and crashed cars that
   blink and pass through others for a moment (no bumps either way while ghosted).

   The new interface: the lobby is drawn by ui/lobbyScreen.js; every other player's car
   is the model and paint they picked; a player's colour in the standings, on the name
   tag and the minimap is their seat's (ui/seats.js), since paints may repeat.

   Stage 9 (sync): the server passes every car's state on the moment it comes ('st',
   statecodec.js) instead of in the 33 ms schema patches; we send 40 times a second near
   another car, 30 otherwise, evenly (the remainder of a frame is kept); the prediction
   carries the change of speed and its corrections fade on a spring (ghostsync.js), so a
   correction never shows as a jump; ?debug=net shows ping, jitter, update age and how far
   the picture of each car was off.

   Plan 3, stage 4: car-to-car hits between the cars' hitbox polygons (bump.js), and the
   protocol number sent on creating or joining a room (protocol.js): a server of another
   version turns the game away with "the game was updated, reload the page".

   Plan 3, stage 5 (the stutter at the start): the synced clock no longer steps (clocksync.js:
   the median of the best samples, approached slowly while racing; a step moved every car
   drawn here by its speed × the step in one frame), an update that comes late (a lost packet)
   glides on instead of stopping the car at MAX_AGE (ghostsync.js), and the race scene is
   compiled in the lobby (core/warm.js) instead of freezing the first frame of the countdown. */
import { $, G, NET, serverNow } from '../state.js';
import { car, applyLook } from '../player.js';
import { choice } from '../ui/garage.js';
import { carById, paintHex } from '../core/cars.js';
import { setPaint } from '../core/carModels.js';
import { canvas, cv, tex, scene, camera } from '../core/render.js';
import { wake, stepDraft, createTrail, trailPush, trailReset } from '../core/draft.js';
import { createWake, updateWake, disposeWake } from '../core/draftfx.js';
import { makeCar, dressCar, disposeCar } from '../core/carModel.js';
import { addMark, emitSmoke, clearMarks } from '../core/fx.js';
import { clearInput } from '../core/input.js';
import { audioInit } from '../core/audio.js';
import { crash, bank, dropDrift } from '../game.js';
import { flash, fmtT, fmtN, hex, el, info, showPanel, netStatus, note, dismissMenu, holdPicture, releasePicture, dropPicture } from '../ui/hud.js';
import { fly, DUR as FLY } from '../ui/startFx.js';
import { renderLobby as drawLobby, openLobby, leaveLobby, openRoomGarage, lobbyPicture } from '../ui/lobbyScreen.js';
import { roster, seatOf, seatHex } from '../ui/seats.js';
import { carMass, keepOut, newMem, collideStep, takeOut, receive, catchUp, kickStart, kickAt, kickUpdate } from './bump.js';
import { predict, newView, correct, settle, reset as resetView, newStats, statArrive, statErr, errPct } from './ghostsync.js';
import { decodeState } from './statecodec.js';
import { PROTOCOL, UPDATED, UPDATED_CODE } from './protocol.js';
import { playersCollide, ghostAlpha, setCarAlpha, disposeAlpha } from './ghostmode.js';
import { newClock, clockSample, clockTick } from './clocksync.js';
import { warmAgain } from '../core/warm.js';

function endpoint(){
  try{ const q=new URLSearchParams(location.search).get('server'); if(q) return q; }catch(e){}
  // Served by the game server itself (Render, or localhost:2567): talk to the same address.
  if(location.port==='2567' || /\.onrender\.com$/.test(location.hostname)) return (location.protocol==='https:'?'wss://':'ws://')+location.host;
  if(window.NIGHT_DRIFT_SERVER) return window.NIGHT_DRIFT_SERVER;
  if(/^(localhost|127\.0\.0\.1|\[::1\]|)$/.test(location.hostname)) return 'ws://localhost:2567';
  return '';
}
function errText(e){
  const m=String((e&&e.message)||e||'');
  // the server is of another version than this tab (net/protocol.js): reloading gets the game it plays with
  if((e&&e.code)===UPDATED_CODE || m===UPDATED) return UPDATED;
  if(/not found/i.test(m)) return 'Комнаты с таким кодом нет. Проверьте код.';
  if(/locked|full/i.test(m)) return 'В комнате нет мест или заезд уже идёт. Дождитесь конца заезда.';
  // the room said no to this player: the host sent them out of it earlier
  if(/onAuth/i.test(m)) return 'Хост исключил вас из этой комнаты. Создайте свою или попросите другой код.';
  if(/fetch|network|ECONNREFUSED|connect|socket/i.test(m)) return 'Сервер не отвечает. Проверьте адрес в config.js. Бесплатный сервер может просыпаться до минуты: попробуйте ещё раз.';
  return 'Не получилось: '+m;
}
// The name we come into a room with: the last one used (it is changed in the lobby).
function myName(){ try{ return (localStorage.getItem('nightdrift.name')||'').trim().slice(0,16)||'Гонщик'; }catch(e){ return 'Гонщик'; } }
// This browser's player id: a room the host kicked us out of knows it and won't let us back.
// (crypto.randomUUID exists only on https and localhost; a game on the local network is
// plain http, where getRandomValues still works)
const uid=()=>crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
const PID=(()=>{ try{ let v=localStorage.getItem('nightdrift.pid'); if(!v){ v=uid(); localStorage.setItem('nightdrift.pid',v); } return v; }catch(e){ return uid(); } })();

let connecting=false;
// kind: 'create' (a room in NET.wantMode, from a mode card) or 'join' (the code typed in)
export async function connectRoom(kind){
  // One attempt at a time: a second click or Enter while the first is on its way would
  // come into the room a second time, as a second player.
  if(connecting || NET.online) return;
  const ep=endpoint();
  if(!ep){ netStatus('netStatus','Онлайн-сервер не настроен. Укажите его адрес в файле config.js.',true); return; }
  if(typeof Colyseus==='undefined'){ netStatus('netStatus','Не загрузилась библиотека мультиплеера. Проверьте интернет и обновите страницу.',true); return; }
  const code=$('codeIn').value.trim().toUpperCase();
  if(kind==='join' && code.length!==4){ netStatus('netStatus','Введите код из 4 символов.',true); return; }
  audioInit();
  connecting=true;
  $('pHome').setAttribute('aria-busy','true'); $('joinRoom').disabled=true;
  netStatus('netStatus', kind==='create' ? 'Создаю комнату…' : 'Подключаюсь…');
  try{
    NET.client=new Colyseus.Client(ep);
    const room=kind==='create' ? await NET.client.create('race',{proto:PROTOCOL,name:myName(),pid:PID,mode:NET.wantMode||'track',map:G.soloMap||'neon',density:G.density||'mid',car:choice.car,paint:choice.paint}) : await NET.client.joinById(code,{proto:PROTOCOL,name:myName(),pid:PID,car:choice.car,paint:choice.paint});
    netStatus('netStatus','');
    try{ bindRoom(room); }
    catch(e){ console.error('joining the room failed', e); try{ room.leave(true); }catch(_){} leaveOnline('Не получилось войти в комнату. Обновите страницу.'); }
  }catch(e){ console.warn('connectRoom', kind, e); netStatus('netStatus',errText(e),true); }
  finally{ connecting=false; $('pHome').removeAttribute('aria-busy'); $('joinRoom').disabled=false; }
}

// Clock samples from a worker thread that drawing never blocks (see clock-worker.js), and
// from the WebSocket ping below. Both go to clocksync.js: the median of the best ones, taken
// at once out of a run, approached slowly (no step) in the countdown and the race.
const racing = () => G.state==='count' || G.state==='race' || G.state==='crash';
function clockIn(rtt, offset){
  clockSample(NET.clock, rtt, offset, performance.now());
  if(!racing()) NET.offset=clockTick(NET.clock, 0, false);
}
let clockWorker=null;
function startClockWorker(){
  try{
    const ep=endpoint(); if(!ep) return;
    if(!clockWorker){
      clockWorker=new Worker(new URL('./clock-worker.js', import.meta.url));
      clockWorker.onmessage=e=>{ const m=e.data; if(!NET.online||!m) return; clockIn(m.rtt, m.offset); };
    }
    clockWorker.postMessage({url:ep.replace(/^ws/,'http').replace(/\/$/,'')+'/time'});
  }catch(e){ clockWorker=null; }
}
function stopClockWorker(){ if(clockWorker) clockWorker.postMessage({url:null}); }

function bindRoom(room){
  clearGhosts();
  clearInterval(NET.pingTimer);
  // (a reconnect starts its samples afresh from the clock as it stands: no step in a race)
  Object.assign(NET,{room,online:true,leaving:false,token:room.reconnectionToken,clock:{...newClock(),offset:NET.offset}});
  startClockWorker();
  const ping=()=>{ if(NET.room===room) room.send('ping',{t:Date.now()}); };
  room.onMessage('pong',m=>{ if(!m || typeof m.t!=='number' || typeof m.server!=='number') return; const rtt=Date.now()-m.t;
    NET.rtt=NET.rtt?NET.rtt*.7+rtt*.3:rtt;
    clockIn(rtt, m.server+rtt/2-Date.now()); });
  for(let i=0;i<6;i++) setTimeout(ping,i*180);
  NET.pingTimer=setInterval(ping,2000);
  room.onMessage('event',m=>info(m.text));
  // highway: the server's traffic, 10 snapshots a second
  room.onMessage('tr',m=>{ if(G.mode.id==='traffic' && G.mode.netTraffic) G.mode.netTraffic(m); });
  room.onMessage('bump',onBump);
  // the other players' cars, each state passed on by the server the moment it came
  room.onMessage('st',m=>{ if(NET.room!==room || room.state.phase==='lobby') return;
    const s=decodeState(m), g=s && NET.ghosts.get(s.id); if(g && s.t) pushSnap(g,s,serverNow()); });
  // the host sent us out of the room: no reconnecting, back to the online mode cards
  room.onMessage('kicked',()=>{ if(NET.room===room) leaveOnline('Вас исключили из комнаты.'); });
  room.onMessage('lapTime',m=>{
    const last=m.lap>=room.state.laps;
    flash(last?'Финиш!':'Круг '+m.lap+' из '+room.state.laps, fmtT(m.ms/1000)+(m.lap>1&&m.best===m.ms?' · лучший круг':''), 2.6);
  });
  room.state.players.onAdd((p,id)=>{
    if(id===room.sessionId){ NET.me=p; applyLook(p.car,p.color); }
    else addGhost(id,p);
    p.onChange(()=>{
      if(id===room.sessionId && (p.car!==car.carId || p.color!==car.paintHex)) applyLook(p.car,p.color);
      const g=NET.ghosts.get(id); if(g) ghostLook(g,p);
      const ph=room.state.phase; if(ph==='lobby') renderLobby(); else if(ph==='results') renderResults();
    });
    renderLobby(); if(room.state.phase==='results') renderResults();
  });
  room.state.players.onRemove((p,id)=>{ removeGhost(id); relabel(); renderLobby(); if(room.state.phase==='results') renderResults(); });
  room.state.listen('hostId',()=>{ relabel(); renderLobby(); renderResults(); });
  // between runs the scene behind the lobby follows the mode the host picked
  room.state.listen('mode',m=>{ warmAgain(); if(NET.room===room && room.state.phase!=='countdown' && room.state.phase!=='race' && G.setMode) G.setMode(m).catch(e=>console.error('mode failed to load', m, e)); renderLobby(); });
  // the room's drift map: everyone in the room drives the same one (not mid-run)
  room.state.listen('map',id=>{ warmAgain(); if(NET.room===room && room.state.phase!=='countdown' && room.state.phase!=='race' && G.setMap && G.setMap(id) && G.mode.id==='track'){ G.mode.idle(car); clearMarks(); } renderLobby(); });
  room.state.listen('duration',()=>renderLobby());
  room.state.listen('density',()=>renderLobby());
  room.state.listen('laps',()=>renderLobby());
  room.state.listen('ghostMode',()=>renderLobby());
  room.state.listen('phase',ph=>onPhase(ph));
  room.onLeave(code=>onRoomLeave(room,code));
}

function onPhase(ph){
  if(!NET.room) return;
  const s=NET.room.state;
  if(ph==='lobby'||ph==='countdown') for(const g of NET.ghosts.values()) forget(g);   // a new run: last run's states are gone
  if(ph==='lobby'){ const from=G.state; leaveLobby(); G.state='lobby'; openLobby(from==='menu'||from==='results'?'forward':undefined); }
  else if(ph==='countdown'||ph==='race'){
    // the way in: the lobby (or the garage opened from it) leaves its picture, dissolves, and
    // the camera flies to the grid during the countdown's dark first second (hud.js, startFx.js)
    const racing=G.state==='race'||G.state==='count', draw=!racing && ph==='countdown' && lobbyPicture();
    if(draw) holdPicture(draw);
    leaveLobby();                                      // a garage opened from the lobby goes too
    if(racing) return;                                 // already racing (e.g. after a reconnect)
    const go=()=>{
      if(!NET.room || G.state==='race'||G.state==='count'){ dropPicture(); return; }
      canvas.focus();
      dismissMenu().then(ok=>{ if(ok && NET.room && G.state!=='race' && G.state!=='count') enter(); else dropPicture(); });
    };
    const enter=()=>{
      G.mode.enter(car,{slot:NET.me?NET.me.slot:0, online:true});
      G.raceT=0; G.lapT=0; G.lap=1; G.score=0; dropDrift(); clearMarks();
      NET.finished=false; NET.laps=s.laps; NET.sendT=0;
      const p=NET.room.state.phase;
      if(p==='race'){ G.state='race'; G.lapT=Math.max(0,(serverNow()-s.startAt)/1000); fly(false); }
      // (the flight only if it ends before the green light: a slow load leaves less time)
      else { G.state='count'; G.prevCount=99; fly(!!draw && (s.startAt-serverNow())/1000 > FLY+0.2); }
      releasePicture();
    };
    // the room's map and mode decide the scene (the highway module may still need to load)
    if(G.setMap) G.setMap(s.map);
    if(G.mode.id!==s.mode && G.setMode) G.setMode(s.mode).then(go, e=>{ console.error('mode failed to load', s.mode, e); leaveOnline('Не загрузился режим «Трасса». Обновите страницу.'); });
    else go();
  }
  else if(ph==='results'){ leaveLobby(); G.state='results'; clearInput(); bank(); car.root.visible=true; $('count').textContent=''; showPanel('pResults'); renderResults(); }
}

const KICKED=4001;                 // the close code the server uses for a kicked player
function onRoomLeave(room,code){
  if(NET.room!==room||NET.leaving) return;
  if(code===KICKED){ leaveOnline('Вас исключили из комнаты.'); return; }
  flash('Связь потеряна','переподключаюсь…',4);
  // The player may press «Выйти» while this is trying (and then start a solo run or join
  // another room): from that moment the attempts must stop. They used to carry on, and
  // either pulled the player back into the room or, failing, threw them out of whatever
  // they were doing by then.
  const client=NET.client, token=NET.token, mine=()=>NET.room===room && !NET.leaving;
  (async()=>{
    let last=null;
    for(let i=0;i<4;i++){
      if(!mine()) return;
      let r=null;
      try{ r=await client.reconnect(token); }
      catch(e){ last=e; console.warn('reconnect attempt', i+1, e);
        if(/onAuth|kicked/i.test(String(e&&e.message||e))) break;    // the host sent us out meanwhile: no use trying again
        await new Promise(res=>setTimeout(res,1500)); continue; }
      if(!mine()){ try{ r.leave(true); }catch(e){} return; }   // left while the attempt was on its way
      bindRoom(r); flash('Связь восстановлена'); return;
    }
    if(mine()) leaveOnline(/onAuth|kicked/i.test(String(last&&last.message||last)) ? 'Вас исключили из комнаты.' : 'Связь с комнатой потеряна.');
  })();
}
export async function leaveOnline(msg){
  const r=NET.room;
  Object.assign(NET,{leaving:true,room:null,online:false,me:null,finished:false});
  leaveLobby();
  clearInterval(NET.pingTimer); clearGhosts(); stopClockWorker();
  applyLook(choice.car,choice.paint); $('standings').hidden=true;
  // nothing of the online run stays on screen: the countdown digit, the ping, the drift meter
  $('count').textContent=''; $('ping').hidden=true; NET.rtt=0; dropDrift(); clearMarks();
  if(G.setMap) G.setMap(null);           // back to the solo map
  G.state='menu'; G.mode.idle(car); car.vF=car.vR=0;
  $('codeIn').value='';                    // the old room's code is no use any more
  if(G.openModes) G.openModes('online','back'); else showPanel('pHome');
  netStatus('netStatus',msg||'',!!msg);
  if(msg) note(msg);                       // and a note at the top, in case the eye is elsewhere
  try{ if(r) await r.leave(true); }catch(e){}
}

// The colour of a player's car: their paint on it ("Заводской" is the car's own colour).
const look = p => paintHex(p.color, p.car);
// The player's own colour in the interface: their seat's.
const accent = id => NET.room ? seatHex(seatOf(NET.room.state, id)) : seatHex(0);

/* ghosts */
function makeLabel(name,color){
  const [c,g]=cv(256,64); let fs=30;
  g.font='700 '+fs+'px Manrope, system-ui, sans-serif';
  while(g.measureText(name).width>228 && fs>14){ fs-=2; g.font='700 '+fs+'px Manrope, system-ui, sans-serif'; }
  g.fillStyle='rgba(8,10,20,.72)'; g.fillRect(0,6,256,46);
  g.fillStyle=hex(color); g.fillRect(0,48,256,4);
  g.fillStyle='#f4f6ff'; g.textAlign='center'; g.textBaseline='middle'; g.fillText(name,128,29);
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex(c,false),transparent:true,depthWrite:false,fog:false}));
  sp.scale.set(4.4,1.1,1); sp.position.y=2.8; return sp;
}
function addGhost(id,p){
  if(NET.ghosts.has(id)) return;
  const ac=accent(id), m=makeCar(look(p),false), label=makeLabel(p.name,ac); m.root.add(label); m.root.visible=false;
  m.under.material.color.setHex(ac);
  const fx=createWake(); scene.add(fx.root);              // its slipstream air (core/draftfx.js)
  const g={id,p,m,fx,trail:createTrail(),label,color:p.color,car:p.car,name:p.name,accent:ac,buf:[],x:0,z:0,view:newView(),stats:newStats(),alpha:1,seeThrough:new Map()};
  NET.ghosts.set(id,g);
  dressCar(m,p.car,p.color);                              // their car's own model (it loads once)
}
// A player picked another car or paint, renamed, or moved up a seat (the host left): the
// model, the paint, the name tag and the glow under the car follow.
function ghostLook(g,p){
  const ac=accent(g.id);
  if(g.car!==p.car || g.color!==p.color) solid(g);          // repaint the real materials, not a see-through copy
  if(g.car!==p.car){ g.car=p.car; g.color=p.color; setPaint(g.m.paint, look(p)); dressCar(g.m,p.car,p.color); }
  else if(g.color!==p.color){ g.color=p.color; g.m.wantCode=p.color; setPaint(g.m.paint, look(p)); if(g.m.model) g.m.model.code=p.color; }
  if(g.name===p.name && g.accent===ac) return;
  g.name=p.name; g.accent=ac;
  g.m.under.material.color.setHex(ac);
  const on=g.label.visible;
  g.m.root.remove(g.label); g.label.material.map.dispose(); g.label.material.dispose();
  g.label=makeLabel(p.name,ac); g.label.visible=on; g.m.root.add(g.label);
}
// seats move when a player leaves: every tag again
function relabel(){ if(!NET.room) return; NET.room.state.players.forEach((p,id)=>{ const g=NET.ghosts.get(id); if(g) ghostLook(g,p); }); }
function removeGhost(id){ const g=NET.ghosts.get(id); if(!g) return; g.m.dressing=(g.m.dressing||0)+1; solid(g); disposeCar(g.m); scene.remove(g.fx.root); disposeWake(g.fx); NET.ghosts.delete(id); }
function clearGhosts(){ for(const id of [...NET.ghosts.keys()]) removeGhost(id); }
// A state of that car arrived (at our server clock `arrival`). Its t is the sender's clock
// (synced to the server) at the moment the state was true; an older one than we have is dropped.
function pushSnap(g,s,arrival){
  const b=g.buf, l=b[b.length-1];
  if(l && s.t<=l.t) return;
  statArrive(g.stats,s.t,arrival);
  b.push(s);
  if(b.length>2) b.shift();
}
function forget(g){ g.buf.length=0; g.last=g.lastPrev=null; resetView(g.view); g.kick=null; solid(g); }
// ghost mode's see-through look off, its material copies freed (ghostmode.js)
function solid(g){ if(g.alpha<1) g.alpha=setCarAlpha(g.m.root,1,g.seeThrough); disposeAlpha(g.seeThrough); }
const plus=(p,k)=>({x:p.x+k.x,z:p.z+k.z,h:p.h+k.h,vx:p.vx+k.vx,vz:p.vz+k.vz,w:p.w+k.w});
// g.kick: our local guess of how an opponent reacts to a hit we just decided (bump.js
// kickStart/kickAt), drawn until their own updates show the real reaction.

/* ---------- car-to-car collisions ----------
   The maths and the rule of who decides a hit are in bump.js: the player driving into the
   other decides it (one judge per hit), changes its own car and sends the other car's share
   through the server; the other player applies only that, lined up with what the judge
   already shows. While it waits, the other car is drawn out of its own (updateGhosts). */
// Can our car and g touch right now? (both racing, neither a blinking crashed car, same level,
// and not in a ghost-mode room: there players' cars pass through each other, ghostmode.js)
function touchable(g,nowS){
  return NET.online && NET.room && playersCollide(NET.room.state) && G.state==='race' && !NET.finished && !(G.mode.isGhost && G.mode.isGhost())
    && g.m.root.visible && !g.p.finished && g.vx!==undefined && nowS>=g.p.ghostUntil
    && Math.abs((g.y||0)-(car.y||0))<=(G.mode.sameLevel||3);
}
// one physics substep (dt s): main.js calls it after each physics step
export function collideGhosts(dt=1/120){
  if(!NET.online || !NET.room || G.state!=='race' || NET.finished) return;
  catchUp(car,dt);                                         // a hit we got: its reaction lined up with the judge's picture
  const now=performance.now(), tS=serverNow(), me=NET.room.sessionId, mMe=carMass(car.carId);
  for(const g of NET.ghosts.values()){
    const mem=g.mem||(g.mem=newMem());
    // a scrape's impulses are sent together, one message per SEND_GAP at most
    const out=takeOut(mem,now); if(out) NET.room.send('bump',{to:g.id,...out});
    if(!touchable(g,tS) || Math.hypot(g.x-car.x,g.z-car.z)>6) continue;
    const r=collideStep(car,g,mem,{now,tS,mMe,mOther:carMass(g.car),air:!!G.mode.hops});
    if(!r || !r.other) continue;
    if(r.impact>3) crash(r.impact);
    // show the other car reacting right away instead of after a round trip
    g.kick=kickStart(g.kick,g,r.other,r.push,tS);
  }
}
function onBump(m){
  if(G.state!=='race' || NET.finished || !m) return;
  if(G.mode.isGhost && G.mode.isGhost()) return;
  if(NET.room && !playersCollide(NET.room.state)) return;   // ghost mode: no hits (the server drops them too)
  const g=NET.ghosts.get(m.from); if(!g) return;
  const mem=g.mem||(g.mem=newMem());
  const hit=receive(car,m,mem,{now:performance.now(),tS:serverNow(),mMe:carMass(car.carId),mOther:carMass(g.car),meId:NET.room&&NET.room.sessionId,fromId:m.from,rtt:NET.rtt,air:!!G.mode.hops});
  if(mem.undone) g.kick=null;                               // their hit stands, not ours: their car as they report it
  if(hit>3) crash(hit);
}
// The air behind our own car: the players behind us see our slipstream (each from their
// game, the loop below), and so do we, the same white trails out of our car, while one of
// them is close behind us (the same wake() maths, with them as the follower).
let own=null;
const ownLead={x:0,z:0,y:0,h:0,vx:0,vz:0}, follower={x:0,z:0,vx:0,vz:0};
function updateOwnWake(dt, drafting, nowS){
  if(!own){ own={fx:createWake(true), trail:createTrail()}; scene.add(own.fx.root); }
  const show=NET.online && (G.state==='count'||G.state==='race');
  if(!show){ trailReset(own.trail); updateWake(own.fx,null,null,null,dt,camera.position); return; }
  ownLead.x=car.x; ownLead.z=car.z; ownLead.y=car.y||0; ownLead.h=car.h; ownLead.vx=car.vx; ownLead.vz=car.vz;
  trailPush(own.trail,ownLead.x,ownLead.z,ownLead.y,ownLead.h,dt);
  let best=null;
  if(drafting) for(const g of NET.ghosts.values()){
    if(!g.m.root.visible || nowS<g.p.ghostUntil || g.p.finished || Math.abs(g.y-ownLead.y)>(G.mode.sameLevel||3)) continue;
    follower.x=g.x; follower.z=g.z; follower.vx=g.vx||0; follower.vz=g.vz||0;
    const wk=wake(follower,ownLead,own.trail);
    if(wk && (!best || wk.show>best.show)) best=wk;
  }
  updateWake(own.fx,best,ownLead,own.trail,dt,camera.position,scene.fog&&scene.fog.density);
}
export function updateGhosts(dt){
  if(NET.online && NET.clock) NET.offset=clockTick(NET.clock, dt, racing());   // (clocksync.js: no step while racing)
  const show=NET.online && (G.state==='count'||G.state==='race'||G.state==='results');
  const nowS=serverNow();
  // Slipstream: only racing, and not while either car is a blinking ghost after a crash.
  const drafting=NET.online && G.state==='race' && !NET.finished && !(G.mode.isGhost && G.mode.isGhost());
  let inPocket=false;
  for(const g of NET.ghosts.values()){
    const b=g.buf, m=g.m;
    m.root.visible=show && b.length>0 && g.p.connected;
    if(!m.root.visible){ trailReset(g.trail); updateWake(g.fx,null,null,null,dt,camera.position); continue; }
    // a crashed car blinks (its parts, not the car: the car still counts as on the road):
    // fast while stopped, slower while it can't be hit yet
    const blink = nowS < g.p.ghostUntil;
    if(blink || g.blinked){ const on = !blink || Math.floor(nowS / (nowS < g.p.wreckUntil ? 62 : 125)) % 2 === 0;
      // the body (the model is in it), its tag, its glow, and the coupe's wheels when it has
      // no model yet; never the coupe parts a model hides
      m.body.visible=on; g.label.visible=on; m.under.visible=on;
      if(!m.model) for(const o of m.proc.parts) if(o.isGroup) o.visible=on; }
    g.blinked = blink;
    // Predict where the car is right now: last known position moved forward by its
    // velocity for as long as the update was travelling, turning at its last turn rate,
    // speeding up or braking as it did (ghostsync.js predict).
    const s1=b[b.length-1], s0=b.length>1?b[0]:null;
    const T=predict(s0,s1,nowS);
    // When a fresh update moves the prediction, the drawn car stays where it was and keeps
    // its speed; that small correction fades out on a spring (ghostsync.js), so corrections
    // never look like jumps and the car itself never trails behind the prediction.
    if(g.last && g.last!==s1){
      const O=predict(g.lastPrev,g.last,nowS), ko=kickAt(g.kick,nowS,g.last.t);
      // The opponent's own updates include our hit once they have reacted (their velocity
      // jumps by the hit's change): from then on only the distance their car is still
      // making up is added (bump.js kickUpdate), until it is all in their updates.
      g.kick=kickUpdate(g.kick,g.last,s1,NET.rtt);
      const kn=kickAt(g.kick,nowS,s1.t);
      statErr(g.stats, correct(g.view, plus(O,ko), plus(T,kn)));
    }
    g.last=s1; g.lastPrev=s0; g.stats.age=nowS-s1.t;
    const kd=kickAt(g.kick,nowS,s1.t); T.x+=kd.x; T.z+=kd.z; T.h+=kd.h;
    g.vx=s1.vx+kd.vx; g.vz=s1.vz+kd.vz; g.rvx=s1.vx; g.rvz=s1.vz; g.spinV=kd.w;   // (rv: as reported, without our guess; spinV: our guess's spin, the hit's lever)
    // (held while the car rests against ours, below: the spring would pull it back inside)
    if(g.pinned){ g.view.ov.x=g.view.ov.z=0; } else settle(g.view,dt);
    g.off=g.view.off;
    // height: their reported height carried on by their vertical speed (in a jump it is the
    // flight; vy is 0 on the road), the track mode keeps it on or above the road
    const age=Math.min(.5,Math.max(0,(nowS-s1.t)/1000));
    const s={x:T.x+g.off.x,z:T.z+g.off.z,h:T.h+g.off.h,vf:s1.vf,steer:s1.steer,slide:s1.slide,
      y:s1.vy?s1.y+s1.vy*age-4.905*age*age:s1.y, idx:s1.idx};
    if(G.mode.ghostBounds) G.mode.ghostBounds(s,g);        // never through a wall or a rail (the prediction does not know them)
    // a hit theirs to decide: drawn against our car, not inside it, until it comes (bump.js).
    // The push out stays in the smoothing offset (it fades on the spring like a correction):
    // the car rests against ours instead of being pushed out afresh from deep inside each
    // frame, which flipped it from one side of our car to the other (up to 4 m a frame), and
    // it does not snap back when the push ends. While it rests against ours the spring is
    // held, so each frame only pushes it out by the little its prediction moved in (a clear
    // direction), not from deep inside (where the direction out flips from frame to frame).
    g.pinned=false;
    if(g.mem && touchable(g,nowS)){ const bx=s.x, bz=s.z; keepOut(s,car,g.mem,performance.now(),NET.rtt,g.car);
      if(s.x!==bx || s.z!==bz){ g.view.off.x+=s.x-bx; g.view.off.z+=s.z-bz; g.pinned=true;
        // a long push (they keep driving into us) must not build up to a reset-sized offset
        const o=g.view.off, n=Math.hypot(o.x,o.z), cap=PIN_MAX; if(n>cap){ o.x*=cap/n; o.z*=cap/n; } } }
    g.x=s.x; g.z=s.z; g.h=s.h; g.y=s.y||0;
    m.root.position.set(s.x,g.y+(G.mode.hops?0:kd.y),s.z); m.root.rotation.y=s.h;   // (with heights their own hop comes in y)
    // ghost mode: a car near ours is see-through, so ours shows through it (ghostmode.js)
    { const a=ghostAlpha(G.state==='race' && NET.room && !playersCollide(NET.room.state), Math.hypot(s.x-car.x,s.z-car.z));
      if((a<1 || g.alpha<1) && Math.abs(a-g.alpha)>0.005) g.alpha=setCarAlpha(m.root,a,g.seeThrough); }   // only when it changes
    // a name tag right at the camera (that car is just behind ours) would fill the screen:
    // it fades out closer than 16 m and is gone by 8 m (the tags are for cars further off;
    // the cars around ours are named in the standings)
    { const d=Math.hypot(camera.position.x-s.x, camera.position.y-2.8, camera.position.z-s.z);
      g.label.material.opacity=Math.max(0,Math.min(1,(d-8)/8)); }
    // its pocket follows the path it drove (its trail); seen from our car, the white air
    // shows when we are close behind it
    trailPush(g.trail,g.x,g.z,g.y,g.h,dt);
    const wk=(drafting && nowS>=g.p.ghostUntil && !g.p.finished && Math.abs(g.y-(car.y||0))<=(G.mode.sameLevel||3)) ? wake(car,g,g.trail) : null;   // not across a bridge or a floor
    if(wk && wk.inside) inPocket=true;
    updateWake(g.fx,wk,g,g.trail,dt,camera.position,scene.fog&&scene.fog.density);
    m.spin+=s.vf*dt/.38; m.wheels.forEach(w=>w.rotation.x=m.spin);
    m.pivots.forEach(pv=>pv.rotation.y=-s.steer*.5);
    m.under.material.opacity=.4+s.slide*.35;
    const fx=Math.sin(s.h), fz=Math.cos(s.h), rx=Math.cos(s.h), rz=-Math.sin(s.h);
    for(const [k,lx] of [[0,.95],[1,-.95]]){
      const wx=s.x+rx*lx-fx*1.35, wz=s.z+rz*lx-fz*1.35;
      if(s.slide>.12 && s.vf>5 && !(s1.vy)){ addMark(m,k,wx,wz,g.y); if(Math.random()<.3) emitSmoke(wx,wz,fx*s.vf,fz*s.vf,s.slide+.3,g.y); }
      else m.lastMark[k]=null;
    }
  }
  // how much slipstream push our car gets (main.js passes it to stepCar as input.draft)
  stepDraft(NET.draft, inPocket, dt);
  updateOwnWake(dt, drafting, nowS);
  if(NET_DEBUG) drawNetDebug(dt);
}

// Sends our car while racing, called once per frame from the loop: 40 times a second when
// another car is within 20 m (a hit is seen sooner and lines up better), 30 otherwise.
// Evenly: the part of a frame past the moment is kept for the next one (it used to be
// dropped, and at 45 fps that sent ~22 a second instead of 30); never a burst after a
// long frame.
export const SEND_NEAR=1/40, SEND_FAR=1/30, NEAR_M=20;
export function sendState(dt,slide){
  if(NET.online && NET.room && (G.state==='race'||G.state==='count')){
    let gap=SEND_FAR;
    for(const g of NET.ghosts.values()) if(g.m.root.visible && Math.hypot(g.x-car.x,g.z-car.z)<NEAR_M){ gap=SEND_NEAR; break; }
    NET.sendT+=dt;
    if(NET.sendT>=gap){ NET.sendT=Math.min(NET.sendT-gap,gap);
      NET.room.send('state',{x:car.x,z:car.z,h:car.h,y:car.y||0,vy:car.air?car.vy:0,idx:car.idx||0,vx:car.vx*NET.pace,vz:car.vz*NET.pace,vf:car.vF,steer:car.steer,slide,prog:car.prog,score:G.score,t:serverNow(),
        ...(G.mode.stats ? { misses: G.mode.stats().misses } : {})}); }
  }
}

/* ?debug=net: the network numbers, bottom left, 4 times a second. Per opponent: how often its
   updates come (their stamps), the one-way delay (with the clocks' error) and its jitter,
   how old the update it is drawn from is, and how far our picture of it was off when each
   update came (median / 95th percentile of the last 300). NET.report() gives the same to tests. */
const NET_DEBUG=(()=>{ try{ return /[?&]debug=net\b/.test(location.search); }catch(e){ return false; } })();
export function netReport(){
  const out=[];
  for(const g of NET.ghosts.values()){ const S=g.stats;
    out.push({name:g.name, n:S.n, hz:S.gap?1000/S.gap:0, delay:S.delay, jitter:S.jitter, age:S.age, p50:errPct(S,.5), p95:errPct(S,.95)}); }
  return {rtt:NET.rtt||0, ghosts:out};
}
NET.report=netReport;
let dbgBox=null, dbgT=0;
const PIN_MAX=6;   // m: the most the keep-out push may move a car from its prediction (ghostsync RESET is 12)
function drawNetDebug(dt){
  if((dbgT-=dt)>0) return; dbgT=.25;
  if(!dbgBox){ dbgBox=document.createElement('pre'); dbgBox.id='netDebug';
    Object.assign(dbgBox.style,{position:'fixed',left:'8px',bottom:'8px',zIndex:99,margin:0,padding:'6px 8px',font:'12px/1.35 ui-monospace,monospace',color:'#e8ecff',background:'rgba(8,10,20,.72)',borderRadius:'6px',pointerEvents:'none',whiteSpace:'pre-wrap',maxWidth:'calc(100vw - 16px)'});
    document.body.append(dbgBox); }
  const r=netReport(), f=(v,d=0)=>Number(v||0).toFixed(d);
  dbgBox.hidden=!NET.online;
  dbgBox.textContent='ping '+f(r.rtt)+' ms\n'+r.ghosts.map(g=>g.name+': '+f(g.hz)+'/s · delay '+f(g.delay)+' ms · jitter '+f(g.jitter,1)+' ms · age '+f(g.age)+' ms · off p50 '+f(g.p50,2)+' m p95 '+f(g.p95,2)+' m').join('\n');
}

/* lobby, standings, results */
// The lobby is drawn by ui/lobbyScreen.js; here only when the room is in it.
function renderLobby(){ if(NET.room && NET.room.state.phase==='lobby') drawLobby(); }
export function renderStandings(){
  const box=$('standings');
  if(!NET.online || !NET.room || !(G.state==='race'||G.state==='count')){ box.hidden=true; return; }
  const me=NET.room.sessionId, rows=[];
  if(NET.room.state.mode==='traffic'){
    // highway: by score (ours live, others' as last reported)
    NET.room.state.players.forEach((p,id)=>{ const mine=id===me, sc=mine?G.score:p.score;
      rows.push({name:p.name,color:accent(id),mine,key:sc,tag:fmtN(sc)}); });
  } else
  NET.room.state.players.forEach((p,id)=>{
    const mine=id===me, laps=mine?Math.min(G.lap-1,NET.laps):p.lap, prog=mine?car.prog:p.prog;
    rows.push({name:p.name,color:accent(id),mine,fin:p.finished,
      key:p.finished?1e9-p.place:laps*1e5+prog,
      tag:p.finished?'финиш':Math.min(laps+1,NET.laps)+'/'+NET.laps});
  });
  rows.sort((a,b)=>b.key-a.key);
  box.replaceChildren(...rows.map((r,i)=>{
    const d=el('div','st'+(r.mine?' me':'')); const dot=el('span','dot'); dot.style.color=hex(r.color); dot.style.background=hex(r.color);
    d.append(el('span','pos',String(i+1)), dot, el('span','nm',r.name), el('span','lp',r.tag)); return d;
  }));
  box.hidden=false;
}
function renderResults(){
  if(!NET.room) return;
  const s=NET.room.state, me=NET.room.sessionId, tb=$('resBody'); tb.replaceChildren();
  const hw = s.mode==='traffic';
  $('resHead').replaceChildren(...(hw ? ['#','Гонщик','Очки','Дистанция','Обгоны','Аварии'] : ['#','Гонщик','Время','Лучший круг','Дрифт']).map(t=>el('th',null,t)));
  [...s.players.entries()].sort((a,b)=>(a[1].place||99)-(b[1].place||99)).forEach(([id,p])=>{
    const tr=el('tr',id===me?'me':null);
    const nm=el('td'); const d=el('span','dot'); d.style.color=d.style.background=hex(accent(id)); d.style.display='inline-block'; d.style.marginRight='8px';
    nm.append(d, document.createTextNode(p.name));
    if(hw) tr.append(el('td','rank',p.place?String(p.place):'—'), nm,
      el('td',null,fmtN(p.score)),
      el('td',null,(Math.max(0,p.z)/1000).toFixed(2).replace('.',',')+' км'),
      el('td',null,String(p.misses)),
      el('td',null,String(p.wrecks)));
    else tr.append(el('td','rank',p.place?String(p.place):'—'), nm,
      el('td',null,p.finished?fmtT(p.finishTime/1000):'не доехал'),
      el('td',null,p.bestLap?fmtT(p.bestLap/1000):'—'),
      el('td',null,fmtN(p.score)));
    tb.append(tr);
  });
  // the next run: as in the lobby, the host starts once every other player is ready
  const isHost=s.hostId===me, meP=s.players.get(me), ag=$('again');
  let waiting=0; s.players.forEach((o,oid)=>{ if(oid!==s.hostId && o.connected && !o.ready) waiting++; });
  $('resLobby').hidden=!isHost;            // the host takes everyone back to the lobby (settings, kicks)
  if(isHost){ ag.textContent='Ещё заезд'; ag.disabled=waiting>0; ag.removeAttribute('aria-pressed'); }
  else { ag.textContent=meP&&meP.ready?'Готов ✓':'Готово'; ag.disabled=false; ag.setAttribute('aria-pressed',String(!!(meP&&meP.ready))); }
  netStatus('resStatus', isHost?(waiting?'Ждём «Готово» от игроков: '+waiting+'.':''):'Нажмите «Готово», и хост запустит следующий заезд.');
}

// The online mode cards: a card creates a room (main.js → connectRoom('create')); this
// form joins a friend's room by its code.
$('joinForm').addEventListener('submit',e=>{ e.preventDefault(); connectRoom('join'); });
$('codeIn').addEventListener('input',e=>{ const v=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,''); if(v!==e.target.value) e.target.value=v; });
$('again').addEventListener('click',()=>{
  if(!NET.room) return;
  const s=NET.room.state, me=NET.room.sessionId;
  if(s.hostId===me) NET.room.send('start');
  else { const p=s.players.get(me); NET.room.send('ready',{value:!(p&&p.ready)}); }
});
$('leaveLobby').addEventListener('click',()=>leaveOnline());
$('leaveRes').addEventListener('click',()=>leaveOnline());
$('resLobby').addEventListener('click',()=>{ if(NET.room && NET.room.state.hostId===NET.room.sessionId) NET.room.send('toLobby'); });
// «Авто» on the results: the garage, then back to the results
$('resCar').addEventListener('click',()=>{ if(!NET.room) return;
  openRoomGarage(()=>{ if(NET.room && NET.room.state.phase==='results') showPanel('pResults','back').then(()=>$('resCar').focus({preventScroll:true})); }); });
// The "?room=CODE" invite link: main.js opens the online screen with the code filled in.
export function inviteCode(){ try{ return (new URLSearchParams(location.search).get('room')||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4); }catch(e){ return ''; } }
