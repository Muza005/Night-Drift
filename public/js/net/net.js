/* ---------- online ----------
   Each player's car is simulated on their own computer and streamed to the server
   ~30 times a second, stamped with a clock synced to the server. The server owns the
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
   tag and the minimap is their seat's (ui/seats.js), since paints may repeat. */
import { $, G, NET, serverNow } from '../state.js';
import { car, applyLook } from '../player.js';
import { choice } from '../ui/garage.js';
import { carById, paintHex } from '../core/cars.js';
import { setPaint } from '../core/carModels.js';
import { canvas, cv, tex, scene, camera } from '../core/render.js';
import { wake, stepDraft } from '../core/draft.js';
import { createWake, updateWake, disposeWake } from '../core/draftfx.js';
import { makeCar, dressCar, disposeCar } from '../core/carModel.js';
import { addMark, emitSmoke, clearMarks } from '../core/fx.js';
import { clearInput } from '../core/input.js';
import { audioInit } from '../core/audio.js';
import { crash, bank, dropDrift } from '../game.js';
import { flash, fmtT, fmtN, hex, el, info, showPanel, netStatus, note, cancelPanels } from '../ui/hud.js';
import { renderLobby as drawLobby, openLobby, leaveLobby, openRoomGarage } from '../ui/lobbyScreen.js';
import { roster, seatOf, seatHex } from '../ui/seats.js';

const angDiff=(a,b)=>{ const t=Math.PI*2; return (((b-a+Math.PI)%t)+t)%t-Math.PI; };

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
  $('pModes').setAttribute('aria-busy','true'); $('joinRoom').disabled=true;
  netStatus('netStatus', kind==='create' ? 'Создаю комнату…' : 'Подключаюсь…');
  try{
    NET.client=new Colyseus.Client(ep);
    const room=kind==='create' ? await NET.client.create('race',{name:myName(),pid:PID,mode:NET.wantMode||'track',map:G.soloMap||'neon',density:G.density||'mid',car:choice.car,paint:choice.paint}) : await NET.client.joinById(code,{name:myName(),pid:PID,car:choice.car,paint:choice.paint});
    netStatus('netStatus','');
    try{ bindRoom(room); }
    catch(e){ console.error('joining the room failed', e); try{ room.leave(true); }catch(_){} leaveOnline('Не получилось войти в комнату. Обновите страницу.'); }
  }catch(e){ console.warn('connectRoom', kind, e); netStatus('netStatus',errText(e),true); }
  finally{ connecting=false; $('pModes').removeAttribute('aria-busy'); $('joinRoom').disabled=false; }
}

// Clock samples from a worker thread that drawing never blocks (see clock-worker.js).
// They feed the same shortest-round-trip choice as the WebSocket ping below.
let clockWorker=null;
function startClockWorker(){
  try{
    const ep=endpoint(); if(!ep) return;
    if(!clockWorker){
      clockWorker=new Worker(new URL('./clock-worker.js', import.meta.url));
      clockWorker.onmessage=e=>{ const m=e.data; if(!NET.online||!m) return;
        if(m.rtt<=NET.bestRtt){ NET.bestRtt=m.rtt; NET.offset=m.offset; } };
    }
    clockWorker.postMessage({url:ep.replace(/^ws/,'http').replace(/\/$/,'')+'/time'});
  }catch(e){ clockWorker=null; }
}
function stopClockWorker(){ if(clockWorker) clockWorker.postMessage({url:null}); }

function bindRoom(room){
  clearGhosts();
  clearInterval(NET.pingTimer);
  Object.assign(NET,{room,online:true,leaving:false,token:room.reconnectionToken,bestRtt:1e9});
  startClockWorker();
  // Clock sync: keep the reply with the shortest round trip; it is the most accurate.
  const ping=()=>{ if(NET.room===room) room.send('ping',{t:Date.now()}); };
  room.onMessage('pong',m=>{ const rtt=Date.now()-m.t;
    NET.rtt=NET.rtt?NET.rtt*.7+rtt*.3:rtt;
    if(rtt<=NET.bestRtt){ NET.bestRtt=rtt; NET.offset=m.server+rtt/2-Date.now(); } });
  for(let i=0;i<6;i++) setTimeout(ping,i*180);
  NET.pingTimer=setInterval(()=>{ NET.bestRtt+=10; ping(); },2000);
  room.onMessage('event',m=>info(m.text));
  // highway: the server's traffic, 10 snapshots a second
  room.onMessage('tr',m=>{ if(G.mode.id==='traffic' && G.mode.netTraffic) G.mode.netTraffic(m); });
  room.onMessage('bump',onBump);
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
      const g=NET.ghosts.get(id); if(g){ ghostLook(g,p); pushSnap(g,p); }
      const ph=room.state.phase; if(ph==='lobby') renderLobby(); else if(ph==='results') renderResults();
    });
    renderLobby(); if(room.state.phase==='results') renderResults();
  });
  room.state.players.onRemove((p,id)=>{ removeGhost(id); relabel(); renderLobby(); if(room.state.phase==='results') renderResults(); });
  room.state.listen('hostId',()=>{ relabel(); renderLobby(); renderResults(); });
  // between runs the scene behind the lobby follows the mode the host picked
  room.state.listen('mode',m=>{ if(NET.room===room && room.state.phase!=='countdown' && room.state.phase!=='race' && G.setMode) G.setMode(m).catch(e=>console.error('mode failed to load', m, e)); renderLobby(); });
  // the room's drift map: everyone in the room drives the same one (not mid-run)
  room.state.listen('map',id=>{ if(NET.room===room && room.state.phase!=='countdown' && room.state.phase!=='race' && G.setMap && G.setMap(id) && G.mode.id==='track'){ G.mode.idle(car); clearMarks(); } renderLobby(); });
  room.state.listen('duration',()=>renderLobby());
  room.state.listen('density',()=>renderLobby());
  room.state.listen('laps',()=>renderLobby());
  room.state.listen('phase',ph=>onPhase(ph));
  room.onLeave(code=>onRoomLeave(room,code));
}

function onPhase(ph){
  if(!NET.room) return;
  const s=NET.room.state;
  if(ph==='lobby'){ const from=G.state; leaveLobby(); G.state='lobby'; openLobby(from==='menu'||from==='results'?'forward':undefined); }
  else if(ph==='countdown'||ph==='race'){
    leaveLobby();                                      // a garage opened from the lobby goes too
    if(G.state==='race'||G.state==='count') return;   // already racing (e.g. after a reconnect)
    const go=()=>{
      if(!NET.room || G.state==='race'||G.state==='count') return;
      cancelPanels(); $('menu').hidden=true; canvas.focus();
      G.mode.enter(car,{slot:NET.me?NET.me.slot:0, online:true});
      G.raceT=0; G.lapT=0; G.lap=1; G.score=0; dropDrift(); clearMarks();
      NET.finished=false; NET.laps=s.laps; NET.sendT=0;
      const p=NET.room.state.phase;
      if(p==='race'){ G.state='race'; G.lapT=Math.max(0,(serverNow()-s.startAt)/1000); }
      else { G.state='count'; G.prevCount=99; }
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
  if(G.openModes) G.openModes('online','back'); else showPanel('pModes');
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
  const fx=createWake(); scene.add(fx.root);              // its slipstream lines (core/draftfx.js)
  const g={id,p,m,fx,label,color:p.color,car:p.car,name:p.name,accent:ac,buf:[],x:0,z:0};
  NET.ghosts.set(id,g);
  dressCar(m,p.car,p.color);                              // their car's own model (it loads once)
}
// A player picked another car or paint, renamed, or moved up a seat (the host left): the
// model, the paint, the name tag and the glow under the car follow.
function ghostLook(g,p){
  const ac=accent(g.id);
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
function removeGhost(id){ const g=NET.ghosts.get(id); if(!g) return; g.m.dressing=(g.m.dressing||0)+1; disposeCar(g.m); scene.remove(g.fx.root); disposeWake(g.fx); NET.ghosts.delete(id); }
function clearGhosts(){ for(const id of [...NET.ghosts.keys()]) removeGhost(id); }
function pushSnap(g,p){
  if(NET.room && NET.room.state.phase==='lobby'){ g.buf.length=0; g.last=g.lastPrev=null; g.off=null; return; }
  const b=g.buf, l=b[b.length-1];
  if(!p.t || (l && p.t<=l.t)) return;      // nothing new, or an out-of-date update
  // t is the sender's clock (synced to the server) at the moment this position was true.
  b.push({t:p.t,x:p.x,z:p.z,h:p.h,vx:p.vx,vz:p.vz,vf:p.vf,steer:p.steer,slide:p.slide,y:p.y||0,vy:p.vy||0,idx:p.idx});
  if(b.length>2) b.shift();
}
// Where a car is at server time nowS: its last reported position moved forward by its
// velocity for as long as the update was travelling, turning at its last turn rate.
function predict(s0,s1,nowS){
  const age=Math.min(.5,Math.max(0,(nowS-s1.t)/1000));
  let w=0; if(s0){ const span=(s1.t-s0.t)/1000; if(span>.005) w=Math.max(-3,Math.min(3,angDiff(s0.h,s1.h)/span)); }
  const turn=w*age, c=Math.cos(-turn/2), sn=Math.sin(-turn/2);
  return {x:s1.x+(s1.vx*c-s1.vz*sn)*age, z:s1.z+(s1.vx*sn+s1.vz*c)*age, h:s1.h+turn};
}
// Our local guess of how an opponent reacts to a hit we just gave them, used until their
// own updates (which include the real reaction) arrive. Velocity fades like tyre grip would.
function kickDisp(g,nowS){
  const K=g.kick; if(!K) return {x:0,z:0,h:0,vx:0,vz:0,w:0};
  const tau=Math.max(0,(nowS-K.t)/1000), e=Math.exp(-K.k*tau), f=(1-e)/K.k;
  return {x:K.bx+K.vx*f, z:K.bz+K.vz*f, h:K.bh+K.w*f, vx:K.vx*e, vz:K.vz*e, w:K.w*e};
}

/* ---------- car-to-car collisions ----------
   Each car is two overlapping circles (front and rear), which follows the long box shape
   closely and is cheap to test. Each player resolves the hit for their own car against
   the predicted position of the other car, and also sends the other car's half of the hit
   through the server. Whoever notices the contact first decides it; the second notice
   within 0.3 s is ignored, so a hit is never applied twice. */
const CAR_R=1.05, CAR_OFF=1.15, CAR_I=1.87, BOUNCE=.3;
function carCircles(x,z,h){ const fx=Math.sin(h), fz=Math.cos(h); return [[x+fx*CAR_OFF,z+fz*CAR_OFF],[x-fx*CAR_OFF,z-fz*CAR_OFF]]; }
const clampN=(v,a)=>Math.max(-a,Math.min(a,v));
export function collideGhosts(){
  if(!NET.online || !NET.room || G.state!=='race' || NET.finished) return;
  if(G.mode.isGhost && G.mode.isGhost()) return;          // our car crashed and is blinking: nothing touches it
  const now=performance.now(), nowS=serverNow();
  for(const g of NET.ghosts.values()){
    if(!g.m.root.visible || g.p.finished || g.vx===undefined) continue;
    if(nowS < g.p.ghostUntil) continue;                     // their car crashed and is blinking
    if(Math.hypot(g.x-car.x,g.z-car.z)>6) continue;
    if(Math.abs((g.y||0)-(car.y||0))>(G.mode.sameLevel||3)) continue;   // one on a bridge, the other under it (or on another floor)
    let best=null;
    for(const a of carCircles(car.x,car.z,car.h)) for(const b of carCircles(g.x,g.z,g.h)){
      const dx=a[0]-b[0], dz=a[1]-b[1], d=Math.hypot(dx,dz);
      if(d<2*CAR_R && (!best||d<best.d)) best={d,dx,dz,b};
    }
    if(!best) continue;
    const d=Math.max(best.d,1e-3), nx=best.dx/d, nz=best.dz/d, pen=2*CAR_R-d;
    car.x+=nx*pen*.5; car.z+=nz*pen*.5;              // the other car moves the other half
    const vn=(car.vx-g.vx)*nx+(car.vz-g.vz)*nz;
    if(vn>=0) continue;                                // already moving apart
    const cx=best.b[0]+nx*CAR_R, cz=best.b[1]+nz*CAR_R; // contact point
    const j=-(1+BOUNCE)*vn/2, Jx=nx*j, Jz=nz*j;        // equal masses
    car.vx+=Jx; car.vz+=Jz;
    car.spinV=clampN(car.spinV+((cz-car.z)*Jx-(cx-car.x)*Jz)/CAR_I*.6,4);
    NET.hitAt[g.id]=now;
    if(-vn>3) crash(-vn);
    if(now-(NET.sentAt[g.id]||0)>250){
      NET.sentAt[g.id]=now;
      const w=clampN(((cz-g.z)*-Jx-(cx-g.x)*-Jz)/CAR_I*.6,4);
      NET.room.send('bump',{to:g.id,jx:-Jx,jz:-Jz,w,dx:-nx*pen*.5,dz:-nz*pen*.5});
      // Show the opponent reacting right away instead of after a round trip.
      const nowS=serverNow(), kd=kickDisp(g,nowS);
      g.kick={t:nowS,k:3,bx:kd.x,bz:kd.z,bh:kd.h,vx:kd.vx-Jx,vz:kd.vz-Jz,w:kd.w+w};
    }
  }
}
function onBump(m){
  if(G.state!=='race' || NET.finished || !m) return;
  if(G.mode.isGhost && G.mode.isGhost()) return;
  const now=performance.now();
  if(now-(NET.hitAt[m.from]||0)<300) return;        // we already handled this contact ourselves
  NET.hitAt[m.from]=now;
  car.vx+=m.jx; car.vz+=m.jz; car.spinV=clampN(car.spinV+m.w,4);
  car.x+=m.dx; car.z+=m.dz;
  const hit=Math.hypot(m.jx,m.jz)*1.5; if(hit>3) crash(hit);
}
export function updateGhosts(dt){
  const show=NET.online && (G.state==='count'||G.state==='race'||G.state==='results');
  const nowS=serverNow();
  // Slipstream: only racing, and not while either car is a blinking ghost after a crash.
  const drafting=NET.online && G.state==='race' && !NET.finished && !(G.mode.isGhost && G.mode.isGhost());
  let inPocket=false;
  for(const g of NET.ghosts.values()){
    const b=g.buf, m=g.m;
    m.root.visible=show && b.length>0 && g.p.connected;
    if(!m.root.visible){ updateWake(g.fx,null,g.x,g.z,dt); continue; }
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
    // velocity for as long as the update was travelling, turning at its last turn rate.
    const s1=b[b.length-1], s0=b.length>1?b[0]:null;
    const T=predict(s0,s1,nowS);
    // When a fresh update moves the prediction, keep the drawn car where it was and fade
    // that small correction out over ~0.1 s, so corrections never look like jumps and the
    // car itself never trails behind the prediction.
    if(!g.off) g.off={x:0,z:0,h:0};
    if(g.last && g.last!==s1){
      const O=predict(g.lastPrev,g.last,nowS), ko=kickDisp(g,nowS);
      // The opponent's own updates include our hit once they have had time to react;
      // from then on stop adding our local guess of that hit.
      if(g.kick && s1.t>g.kick.t+(NET.rtt||250)+80) g.kick=null;
      const kn=kickDisp(g,nowS);
      g.off.x+=O.x+ko.x-T.x-kn.x; g.off.z+=O.z+ko.z-T.z-kn.z; g.off.h+=angDiff(T.h+kn.h,O.h+ko.h);
    }
    g.last=s1; g.lastPrev=s0;
    { const kd=kickDisp(g,nowS); T.x+=kd.x; T.z+=kd.z; T.h+=kd.h;
      g.vx=s1.vx+kd.vx; g.vz=s1.vz+kd.vz; }
    if(Math.hypot(g.off.x,g.off.z)>12){ g.off.x=g.off.z=g.off.h=0; }
    const k=Math.exp(-10*dt); g.off.x*=k; g.off.z*=k; g.off.h*=k;
    // height: their reported height carried on by their vertical speed (in a jump it is the
    // flight; vy is 0 on the road), the track mode keeps it on or above the road
    const age=Math.min(.5,Math.max(0,(nowS-s1.t)/1000));
    const s={x:T.x+g.off.x,z:T.z+g.off.z,h:T.h+g.off.h,vf:s1.vf,steer:s1.steer,slide:s1.slide,
      y:s1.vy?s1.y+s1.vy*age-4.905*age*age:s1.y, idx:s1.idx};
    if(G.mode.ghostBounds) G.mode.ghostBounds(s,g);        // never through a wall or a rail (the prediction does not know them)
    g.x=s.x; g.z=s.z; g.h=s.h; g.y=s.y||0;
    m.root.position.set(s.x,g.y,s.z); m.root.rotation.y=s.h;
    // a name tag right at the camera (that car is just behind ours) would fill the screen:
    // it fades out closer than 16 m and is gone by 8 m (the tags are for cars further off;
    // the cars around ours are named in the standings)
    { const d=Math.hypot(camera.position.x-s.x, camera.position.y-2.8, camera.position.z-s.z);
      g.label.material.opacity=Math.max(0,Math.min(1,(d-8)/8)); }
    // its pocket, seen from our car: the white lines show when we are close behind it
    const wk=(drafting && nowS>=g.p.ghostUntil && !g.p.finished && Math.abs(g.y-(car.y||0))<=(G.mode.sameLevel||3)) ? wake(car,g) : null;   // not across a bridge or a floor
    if(wk && wk.inside) inPocket=true;
    updateWake(g.fx,wk,s.x,s.z,dt,g.y);
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
}

// Sends our car ~30 times a second while racing. Called once per frame from the loop.
export function sendState(dt,slide){
  if(NET.online && NET.room && (G.state==='race'||G.state==='count')){
    NET.sendT+=dt;
    if(NET.sendT>=.033){ NET.sendT=0;
      NET.room.send('state',{x:car.x,z:car.z,h:car.h,y:car.y||0,vy:car.air?car.vy:0,idx:car.idx||0,vx:car.vx*NET.pace,vz:car.vz*NET.pace,vf:car.vF,steer:car.steer,slide,prog:car.prog,score:G.score,t:serverNow(),
        ...(G.mode.stats ? { misses: G.mode.stats().misses } : {})}); }
  }
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
