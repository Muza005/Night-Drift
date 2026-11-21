// The drift track mode.
//
// A mode is everything that depends on where you drive. The game loop calls it like this
// every frame:
//   stepCar(car, input, dt)            frozen physics, same for every mode (core/physics.js)
//   mode.constrain(car, dt, hooks)     walls, off-track, laps: right after stepCar, every substep
//   mode.camera(car, dt)               the race camera
//   mode.hud(car, dt, info)            mode-specific HUD: laps, minimap, warnings
//   mode.world(car, dt)                every frame in any state: keep the scenery around the car
// and on events:
//   mode.show() / mode.hide()          switch the mode's scenery and HUD on and off
//   mode.enter(car, {slot})            put the car on the start grid for a new run
//   mode.idle(car)                     where the car stands behind the menu
//   mode.respawn(car)                  the R key: back onto the road
// The traffic mode will implement the same methods.
import { $, G, NET, isTouch } from '../../state.js';
import { camera } from '../../core/render.js';
import { rig } from '../../core/cameraRig.js';
import { setT, fmtT, flash, hex } from '../../ui/hud.js';
import { renderStandings } from '../../net/net.js';
import { P, TG, Y, N, BRIDGE, START, FLAT, MAP, SHORTCUTS, SAME_LEVEL, LEVELS, placeAt, placeOnCut, placeGrid, constrainToTrack, keepInWalls, nearest, setMap, onMapChange, carPose } from './geometry.js';
import { MAPS, MAP_IDS, DEFAULT_MAP } from './maps/index.js';
import { group } from './scene.js';
import { chase } from './chase.js';

// The solo map: the one picked in the garage (ui/mapPicker.js), remembered in localStorage
// ('nightdrift.map'); ?map=<id> opens another one for this page load (development: the
// hidden test map, ?map=_testhill). Online the room's map wins (net.js calls G.setMap with
// the room's map and G.setMap(null) when the player leaves the room: back to the solo map).
const MAP_KEY = 'nightdrift.map';
let soloMap = (() => { let q=null, saved=null;
  try{ q=new URLSearchParams(location.search).get('map'); }catch(e){}
  try{ saved=localStorage.getItem(MAP_KEY); }catch(e){}
  return q && Object.hasOwn(MAPS, q) ? q : saved && MAP_IDS.includes(saved) ? saved : DEFAULT_MAP; })();
setMap(soloMap);
G.soloMap = soloMap;
G.setMap = id => { const before=MAP; setMap(id && Object.hasOwn(MAPS, id) ? id : soloMap); return MAP!==before; };
// the garage's pick: kept, and the track switches to it at once (not while in a room)
G.setSoloMap = id => {
  if(!MAP_IDS.includes(id)) return false;
  soloMap = G.soloMap = id;
  try{ localStorage.setItem(MAP_KEY, id); }catch(e){}
  return NET.room ? false : G.setMap(id);
};

/* minimap
   The road, then every bridge drawn again over it with a shadow beside it, so it reads as
   passing over. On a map with heights a small gauge at the left shows how high my car is
   (between the map's lowest and highest road); under a bridge my arrow is drawn below it. */
const map=$('map'), mg=map.getContext('2d');
let mx, mz, trackPath, bridgePaths, cutPaths=[], yMin=0, yMax=0, floorPaths=null;
function buildMap(){
  let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9; for(const p of P){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);}
  const mScale=250/Math.max(maxX-minX,maxZ-minZ), mOx=150-(minX+maxX)/2*mScale, mOz=150-(minZ+maxZ)/2*mScale;
  mx=x=>300-(x*mScale+mOx); mz=z=>300-(z*mScale+mOz);
  trackPath=new Path2D(); P.forEach((p,i)=>i?trackPath.lineTo(mx(p.x),mz(p.z)):trackPath.moveTo(mx(p.x),mz(p.z))); trackPath.closePath();
  bridgePaths=[];
  for(let i=0;i<N;i++){ if(!BRIDGE[i] || BRIDGE[(i-1+N)%N]) continue;
    const path=new Path2D(); let j=i, k=0; path.moveTo(mx(P[j].x),mz(P[j].z));
    while(BRIDGE[j] && k++<N){ j=(j+1)%N; path.lineTo(mx(P[j].x),mz(P[j].z)); }
    bridgePaths.push({path, from:i, to:j}); }
  yMin=Math.min(...Y); yMax=Math.max(...Y);
  // stacked levels («Паркинг»): the roads of each floor (within half a floor of its
  // height), drawn bright for the floor my car is on over the rest drawn dim
  floorPaths=null;
  if(LEVELS){ const gap=LEVELS.gap, top=Math.round(yMax/gap);
    floorPaths=[]; for(let f=0;f<=top;f++){ const path=new Path2D(), on=i=>Math.abs(Y[i]-f*gap)<gap/2;
      for(let i=0;i<N;i++){ const j=(i+1)%N; if(!on(i)&&!on(j)) continue; if(!on((i-1+N)%N)||i===0) path.moveTo(mx(P[i].x),mz(P[i].z)); path.lineTo(mx(P[j].x),mz(P[j].z)); }
      floorPaths.push(path); } }
  // shortcuts: thin yellow lines
  cutPaths=SHORTCUTS.map(sc=>{ const path=new Path2D(); for(let k=0;k<sc.n;k+=2) k?path.lineTo(mx(sc.x[k]),mz(sc.z[k])):path.moveTo(mx(sc.x[k]),mz(sc.z[k])); path.lineTo(mx(sc.x[sc.n-1]),mz(sc.z[sc.n-1])); return path; });
}
buildMap(); onMapChange(buildMap);
const onBridge=(i,b)=>b.from<=b.to ? (i>=b.from && i<=b.to) : (i>=b.from || i<=b.to);
function drawCar(car){
  mg.save(); mg.translate(mx(car.x),mz(car.z)); mg.rotate(car.h); mg.fillStyle='#ff3b6b'; mg.shadowColor='#ff3b6b'; mg.shadowBlur=12;
  mg.beginPath(); mg.moveTo(0,12); mg.lineTo(8,-8); mg.lineTo(-8,-8); mg.closePath(); mg.fill(); mg.restore();
}
function drawMap(car){
  mg.clearRect(0,0,300,300);
  mg.lineJoin='round'; mg.strokeStyle='rgba(62,240,255,.18)'; mg.lineWidth=16; mg.stroke(trackPath);
  if(floorPaths){
    mg.strokeStyle='rgba(238,240,255,.22)'; mg.lineWidth=4; mg.stroke(trackPath);
    const f=floorPaths[Math.max(0,Math.min(floorPaths.length-1,Math.round((car.y||0)/LEVELS.gap)))];
    mg.strokeStyle='rgba(238,240,255,.9)'; mg.lineWidth=4; mg.stroke(f);
  } else { mg.strokeStyle='rgba(238,240,255,.75)'; mg.lineWidth=4; mg.stroke(trackPath); }
  if(cutPaths.length){ mg.strokeStyle='rgba(255,194,61,.85)'; mg.lineWidth=2; mg.setLineDash([4,3]); for(const c of cutPaths) mg.stroke(c); mg.setLineDash([]); }
  const s=P[START]; mg.fillStyle='#ffc23d'; mg.beginPath(); mg.arc(mx(s.x),mz(s.z),6,0,7); mg.fill();
  // cars below the bridges first (the bridges then pass over them), cars on a bridge after;
  // another player's track point is the one keepInWalls found for them (g.walls)
  const up=i=>i!==undefined && bridgePaths.some(b=>onBridge(i,b));
  const ghost=g=>{ mg.globalAlpha=floorPaths && Math.abs((g.y||0)-(car.y||0))>SAME_LEVEL ? .35 : 1;
    mg.fillStyle=hex(g.accent); mg.beginPath(); mg.arc(mx(g.x),mz(g.z),7,0,7); mg.fill(); mg.globalAlpha=1; };
  const ghosts=[...NET.ghosts.values()].filter(g=>g.m.root.visible);
  for(const g of ghosts) if(!up(g.walls&&g.walls.idx)) ghost(g);
  const mine=up(car.idx);
  if(!mine) drawCar(car);
  for(const b of bridgePaths){
    mg.save(); mg.translate(3,4); mg.strokeStyle='rgba(0,0,0,.6)'; mg.lineWidth=12; mg.stroke(b.path); mg.restore();
    mg.strokeStyle='rgba(16,18,34,1)'; mg.lineWidth=11; mg.stroke(b.path);
    mg.strokeStyle='rgba(255,194,61,.95)'; mg.lineWidth=5; mg.stroke(b.path);
  }
  for(const g of ghosts) if(up(g.walls&&g.walls.idx)) ghost(g);
  if(mine) drawCar(car);
  if(!FLAT && yMax-yMin>.5){
    const top=40, bot=260, y=bot-(bot-top)*Math.max(0,Math.min(1,((car.y||0)-yMin)/(yMax-yMin)));
    mg.fillStyle='rgba(238,240,255,.18)'; mg.fillRect(10,top,6,bot-top);
    mg.fillStyle=car.air?'#ffc23d':'#ff3b6b'; mg.beginPath(); mg.moveTo(20,y); mg.lineTo(30,y-6); mg.lineTo(30,y+6); mg.closePath(); mg.fill();
    mg.fillRect(8,y-1.5,10,3);
  }
}

export const trackMode = {
  ghostBounds(s, g){ keepInWalls(s, g.walls || (g.walls = {})); },   // another player's predicted car stays inside the walls
  // the active map (records.js keeps the records per map)
  get mapId(){ return MAP.id; },
  get mapName(){ return MAP.name; },
  // cars this much apart in height are on different roads: no collision, no slipstream (net.js)
  get sameLevel(){ return SAME_LEVEL; },
  // a hard hit by another car lifts ours off the road (net/bump.js) where the road has
  // heights: the flight of geometry.js flies it (a flat map has no vertical motion)
  get hops(){ return !FLAT; },
  id: 'track',

  show(){ group.visible=true; $('map').hidden=false; },
  hide(){ group.visible=false; },
  world(){},

  enter(car, {slot=0}={}){ placeGrid(car, slot); },
  idle(car){ placeAt(car, START); },
  // back onto the road: the point nearest to where the car is, by height too (a car that
  // fell off a bridge comes back on the road it is on, not on the bridge)
  // (on a shortcut: back onto the shortcut)
  respawn(car){ if(car.cut>=0 && placeOnCut(car)) return; placeAt(car, FLAT ? car.idx : nearest(car, true)); },
  pose(car, dt){ return carPose(car, dt, car.pose || (car.pose = { y:0, pitch:0, roll:0, squash:0 })); },
  constrain(car, dt, hooks){ constrainToTrack(car, dt, hooks); },

  // Chase camera (chase.js): behind the car, leaning toward the direction of travel in a
  // slide; on touch screens a bit closer; under the ceilings of «Паркинг».
  camera(car, dt){
    const sp=chase(car, dt, rig, isTouch?.9:1), camLook=rig.look;
    camera.position.copy(rig.pos);
    // phone held upright: shift the picture up (the view is unchanged, only framed higher)
    // so the car sits above the speedometer and the touch buttons
    if(isTouch && innerWidth<innerHeight) camera.setViewOffset(innerWidth, innerHeight, 0, innerHeight*0.1, innerWidth, innerHeight); else if(camera.view && camera.view.enabled) camera.clearViewOffset();
    if(G.shake>0){ camera.position.x+=(Math.random()-.5)*G.shake*.8; camera.position.y+=(Math.random()-.5)*G.shake*.5; G.shake=Math.max(0,G.shake-dt*2.5);
      if(LEVELS) camera.position.y=Math.min(camera.position.y, rig.pos.y); }     // (never up into a ceiling)
    camera.lookAt(camLook);
    camera.fov=62+Math.min(11,sp*.2);
  },

  hud(car, dt, info){
    if(NET.online){
      const myBest=NET.me&&NET.me.bestLap?NET.me.bestLap/1000:0;
      setT('lapn',NET.finished?'Финиш':G.lap+' / '+NET.laps);
      setT('lapt',fmtT(NET.finished&&NET.me?NET.me.finishTime/1000:G.lapT));
      setT('best',myBest?'Лучший '+fmtT(myBest):'Лучший —');
      NET.standT-=dt; if(NET.standT<=0){ NET.standT=.25; renderStandings();
        const pe=$('ping'); pe.hidden=!NET.rtt; if(NET.rtt){ pe.textContent='Пинг '+Math.round(NET.rtt)+' мс'; pe.classList.toggle('bad',NET.rtt>180); } }
    } else {
      setT('lapn',G.lap+' / '+G.soloLaps); setT('lapt',fmtT(G.lapT)); setT('best',G.best?'Лучший '+fmtT(G.best):'Лучший —');
    }
    if(G.state==='race'){
      const fx=Math.sin(car.h), fz=Math.cos(car.h);
      const back=!(car.cut>=0) && (fx*TG[car.idx].x+fz*TG[car.idx].z)<-.3 && info.speed>4;   // (a shortcut runs its own way)
      G.wrongT=back?G.wrongT+dt:0;
      if(G.wrongT>.8 && G.toastT<=0) flash('Не туда — разворачивайся',null,.6);
    }
  },

  drawMap,
};
