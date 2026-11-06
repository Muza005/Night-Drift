// Drift track geometry and the track's rules for a car: walls, off-track slowdown, laps.
// No rendering and no DOM here, so the physics test can run this file in Node.
// Everything below is the single-file version's code, unchanged except that the car
// is passed in instead of read from a global.

const RAW=[[0,0],[80,-20],[150,10],[170,80],[120,130],[60,110],[20,160],[-60,170],[-130,120],[-120,50],[-60,40],[-90,-30],[-50,-80]];
export const SC=1.45;
const curve = new THREE.CatmullRomCurve3(RAW.map(([x,z])=>new THREE.Vector3(x*SC,0,z*SC)), true, 'centripetal');
export const N=900, ROAD=16, HALF=ROAD/2, CURB=1.4, WALL=HALF+6;
export const P=[], TG=[], NM=[], DIST=[];
for(let i=0;i<N;i++){ const u=i/N; P.push(curve.getPointAt(u)); const t=curve.getTangentAt(u); t.y=0; t.normalize(); TG.push(t); NM.push(new THREE.Vector3(t.z,0,-t.x)); }
export const TRACK_LEN = (() => { let L=0; for(let i=0;i<N;i++){ DIST.push(L); L+=P[i].distanceTo(P[(i+1)%N]); } return L; })();
export const START=12;

export function placeAt(car,i){
  const t=TG[i]; car.x=P[i].x; car.z=P[i].z; car.h=Math.atan2(t.x,t.z); car.vx=car.vz=0; car.steer=0; car.spinV=0; car.idx=i;
  car.lastMark=[null,null];
}
// Starting grid: two columns behind the start line, 7 m between rows.
export function placeGrid(car,slot){
  const row=Math.floor(slot/2), side=slot%2?-1:1, back=7+row*7;
  let i=START, d=0; while(d<back){ const j=(i-1+N)%N; d+=P[j].distanceTo(P[i]); i=j; }
  placeAt(car,i); car.x+=NM[i].x*side*3.6; car.z+=NM[i].z*side*3.6;
  car.prog=-((START-i+N)%N);
}
export function nearest(car,full){
  let bi=car.idx, bd=1e12; const from=full?0:-36, to=full?N:36;
  for(let k=from;k<to;k++){ const j=full?k:(car.idx+k+N)%N; const dx=P[j].x-car.x, dz=P[j].z-car.z, d=dx*dx+dz*dz; if(d<bd){bd=d;bi=j;} }
  return bi;
}

// Runs right after stepCar() in the same substep. hooks.onWall(power) is the old
// crash(power) call, hooks.onLap() the old finishLap() call.
export function constrainToTrack(car,dt,hooks){
  // track
  const ni=nearest(car,false);
  let d=ni-car.idx; if(d>N/2) d-=N; if(d<-N/2) d+=N; car.prog+=d; car.idx=ni;
  const p=P[ni], n=NM[ni];
  const lat=(car.x-p.x)*n.x+(car.z-p.z)*n.z, lim=WALL-1.25;
  if(Math.abs(lat)>lim){
    const s=Math.sign(lat), push=Math.abs(lat)-lim; car.x-=n.x*s*push; car.z-=n.z*s*push;
    const vn=(car.vx*n.x+car.vz*n.z)*s;
    if(vn>0){ car.vx-=n.x*s*vn*1.45; car.vz-=n.z*s*vn*1.45; car.vx*=.9; car.vz*=.9; if(vn>2.5) hooks.onWall(vn); }
  }
  car.off=Math.abs(lat)>HALF+CURB;
  if(car.off){ const k=Math.exp(-.9*dt); car.vx*=k; car.vz*=k; }

  // laps
  if(car.prog>=N){ car.prog-=N; hooks.onLap(); }
}
