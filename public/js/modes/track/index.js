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
import { P, TG, START, placeAt, placeGrid, constrainToTrack } from './geometry.js';
import { group } from './scene.js';

/* minimap */
const map=$('map'), mg=map.getContext('2d');
let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9; for(const p of P){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);}
const mScale=250/Math.max(maxX-minX,maxZ-minZ), mOx=150-(minX+maxX)/2*mScale, mOz=150-(minZ+maxZ)/2*mScale;
const mx=x=>300-(x*mScale+mOx), mz=z=>300-(z*mScale+mOz);
const trackPath=new Path2D(); P.forEach((p,i)=>i?trackPath.lineTo(mx(p.x),mz(p.z)):trackPath.moveTo(mx(p.x),mz(p.z))); trackPath.closePath();
function drawMap(car){
  mg.clearRect(0,0,300,300);
  mg.lineJoin='round'; mg.strokeStyle='rgba(62,240,255,.18)'; mg.lineWidth=16; mg.stroke(trackPath);
  mg.strokeStyle='rgba(238,240,255,.75)'; mg.lineWidth=4; mg.stroke(trackPath);
  const s=P[START]; mg.fillStyle='#ffc23d'; mg.beginPath(); mg.arc(mx(s.x),mz(s.z),6,0,7); mg.fill();
  const cx=mx(car.x), cz=mz(car.z);
  for(const g of NET.ghosts.values()){ if(!g.m.root.visible) continue;
    mg.fillStyle=hex(g.p.color); mg.beginPath(); mg.arc(mx(g.x),mz(g.z),7,0,7); mg.fill(); }
  mg.save(); mg.translate(cx,cz); mg.rotate(car.h); mg.fillStyle='#ff3b6b'; mg.shadowColor='#ff3b6b'; mg.shadowBlur=12;
  mg.beginPath(); mg.moveTo(0,12); mg.lineTo(8,-8); mg.lineTo(-8,-8); mg.closePath(); mg.fill(); mg.restore();
}

export const trackMode = {
  id: 'track',

  show(){ group.visible=true; $('map').hidden=false; },
  hide(){ group.visible=false; },
  world(){},

  enter(car, {slot=0}={}){ placeGrid(car, slot); },
  idle(car){ placeAt(car, START); },
  respawn(car){ placeAt(car, car.idx); },
  constrain(car, dt, hooks){ constrainToTrack(car, dt, hooks); },

  // Chase camera: behind the car, leaning toward the direction of travel in a slide.
  camera(car, dt){
    const fx=Math.sin(car.h), fz=Math.cos(car.h);
    const sp=Math.hypot(car.vx,car.vz);
    let dx=fx, dz=fz;
    if(sp>3 && car.vF>0){ dx=fx*.55+car.vx/sp*.45; dz=fz*.55+car.vz/sp*.45; const l=Math.hypot(dx,dz); dx/=l; dz/=l; }
    const back=7.6+sp*.03, up=3.1+sp*.012;
    const tx=car.x-dx*back, tz=car.z-dz*back;
    const camPos=rig.pos, camLook=rig.look;
    const k=rig.init?1-Math.exp(-5.5*dt):1; rig.init=true;
    camPos.x+=(tx-camPos.x)*k; camPos.y+=(up-camPos.y)*k; camPos.z+=(tz-camPos.z)*k;
    camLook.x+=(car.x+fx*4-camLook.x)*k; camLook.y=1.1; camLook.z+=(car.z+fz*4-camLook.z)*k;
    camera.position.copy(camPos);
    // phone held upright: shift the picture up (the view is unchanged, only framed higher)
    // so the car sits above the speedometer and the touch buttons
    if(isTouch && innerWidth<innerHeight) camera.setViewOffset(innerWidth, innerHeight, 0, innerHeight*0.1, innerWidth, innerHeight); else if(camera.view && camera.view.enabled) camera.clearViewOffset();
    if(G.shake>0){ camera.position.x+=(Math.random()-.5)*G.shake*.8; camera.position.y+=(Math.random()-.5)*G.shake*.5; G.shake=Math.max(0,G.shake-dt*2.5); }
    camera.lookAt(camLook);
    camera.fov=62+Math.min(20,sp*.38);
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
      setT('lapn',String(G.lap)); setT('lapt',fmtT(G.lapT)); setT('best',G.best?'Лучший '+fmtT(G.best):'Лучший —');
    }
    if(G.state==='race'){
      const fx=Math.sin(car.h), fz=Math.cos(car.h);
      const back=(fx*TG[car.idx].x+fz*TG[car.idx].z)<-.3 && info.speed>4;
      G.wrongT=back?G.wrongT+dt:0;
      if(G.wrongT>.8 && G.toastT<=0) flash('Не туда — разворачивайся',null,.6);
    }
  },

  drawMap,
};
