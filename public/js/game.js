// Drift scoring, wall hits, laps. Same rules and numbers as the single-file version.
import { G, NET, drift } from './state.js';
import { car } from './player.js';
import { thud } from './core/audio.js';
import { popup, flash, fmtN, fmtT } from './ui/hud.js';

export function resetToTrack(){ G.mode.respawn(car); dropDrift(); flash('На трассе'); }

export function crash(power){
  G.shake=Math.min(1,power/14); thud(power);
  if(drift.pts>30){ popup('Удар — занос сгорел', true); }
  dropDrift();
}
export function dropDrift(){ drift.pts=0; drift.time=0; drift.grace=0; drift.mult=1; drift.active=false; }
export function bank(){
  const gained=Math.round(drift.pts*drift.mult);
  if(gained>=20){ G.score+=gained; popup('+'+fmtN(gained)+(drift.mult>1?'  ×'+drift.mult:'')); }
  dropDrift();
}
export function scoring(dt){
  const speed=Math.hypot(car.vF,car.vR);
  const ang=Math.atan2(Math.abs(car.vR),Math.max(.01,Math.abs(car.vF)))*180/Math.PI;
  const drifting=speed>9 && car.vF>3 && ang>10 && !car.off;
  drift.ang=ang;
  if(drifting){
    drift.active=true; drift.grace=.75; drift.time+=dt;
    drift.pts+=(Math.min(ang,65)-6)*speed*.22*dt;
    drift.mult=Math.min(5,1+Math.floor(drift.time/1.8));
  } else if(drift.active){
    drift.grace-=dt; if(drift.grace<=0) bank();
  }
  return {drifting,ang,speed};
}

export function finishLap(){
  const t=G.lapT; G.lapT=0; G.lap++;
  if(NET.online){
    // The server measures the official lap time and replies with 'lapTime'.
    if(NET.room) NET.room.send('lap');
    if(G.lap>NET.laps){ NET.finished=true; G.lap=NET.laps; bank(); if(NET.room) NET.room.send('score',{score:G.score}); }
    return;
  }
  let rec=false; if(!G.best||t<G.best){ G.best=t; rec=true; try{localStorage.setItem('nightdrift.best',String(t));}catch(e){} }
  flash((rec?'Новый рекорд круга':'Круг '+(G.lap-1)+' пройден'), fmtT(t), 2.6);
}

// What the physics step reports back to the game: wall hits and completed laps.
export const physicsHooks = { onWall: crash, onLap: finishLap };
