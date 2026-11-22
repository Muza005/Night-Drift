// The track's chase camera, as numbers (no DOM, no rendering: tests/maps.test.mjs drives
// it in Node). index.js puts the camera where this leaves rig.pos and looks at rig.look.
//
// Behind the car, leaning toward the direction of travel in a slide; it pulls back a
// little with speed (0.8 m and 11° more at 200 km/h); `near` < 1 brings it closer (touch
// screens). On a map with stacked levels («Паркинг») it also keeps under the ceilings:
// it comes closer and lower before the car drives in under a slab or a deck (the ceiling
// a little ahead of the car, eased), and every frame it is held inside the walls of the
// road behind the car (never through a column or a wall) and 0.45 m under the ceiling over
// it and over the car.
import { P, NM, Y, TB, N, WALL, CEIL, LEVELS } from './geometry.js';

export const CAM_ROOF = .45;          // m the camera keeps under a ceiling
export function chase(car, dt, rig, near = 1){
  const fx=Math.sin(car.h), fz=Math.cos(car.h);
  const sp=Math.hypot(car.vx,car.vz);
  let dx=fx, dz=fz;
  if(sp>3 && car.vF>0){ dx=fx*.55+car.vx/sp*.45; dz=fz*.55+car.vz/sp*.45; const l=Math.hypot(dx,dz); dx/=l; dz/=l; }
  let back=(7.6+sp*.016)*near, up=(3.1+sp*.0064)*near;
  if(LEVELS){
    let ahead=Infinity; for(let k=-6;k<=16;k++) ahead=Math.min(ahead, CEIL[(car.idx+k+N)%N]);
    const want=Math.min(ahead, 12);
    rig.ceil = (!rig.init || rig.ceil===undefined) ? want : rig.ceil+(want-rig.ceil)*(1-Math.exp(-(want<rig.ceil?6:1.5)*dt));
    const f=Math.max(0, Math.min(1, (9-rig.ceil)/4));         // 1 under a 3.25 m ceiling, 0 under 9 m or more
    back*=1-.28*f; up=Math.min(up, rig.ceil-.75);
  }
  const tx=car.x-dx*back, tz=car.z-dz*back;
  const camPos=rig.pos, camLook=rig.look;
  const k=rig.init?1-Math.exp(-5.5*dt):1; rig.init=true;
  const cy=car.y||0;
  camPos.x+=(tx-camPos.x)*k; camPos.y+=(cy+up-camPos.y)*k; camPos.z+=(tz-camPos.z)*k;
  camLook.x+=(car.x+fx*4-camLook.x)*k; camLook.y=cy+1.1; camLook.z+=(car.z+fz*4-camLook.z)*k;
  if(LEVELS) hold(car, camPos);
  return sp;
}
// inside the walls of the road just behind the car, under the ceilings
function hold(car, c){
  const ci=car.idx;
  let jc=ci, bd=1e18;
  for(let k=-18;k<=2;k++){ const j=(ci+k+N)%N, dx=P[j].x-c.x, dz=P[j].z-c.z, d=dx*dx+dz*dz; if(d<bd){ bd=d; jc=j; } }
  let lat=(c.x-P[jc].x)*NM[jc].x+(c.z-P[jc].z)*NM[jc].z;
  const lim=WALL-.8;
  if(Math.abs(lat)>lim){ const s=Math.sign(lat), d=Math.abs(lat)-lim; c.x-=NM[jc].x*s*d; c.z-=NM[jc].z*s*d; lat=s*lim; }
  const latc=(c.x-P[ci].x)*NM[ci].x+(c.z-P[ci].z)*NM[ci].z;
  const roof=Math.min(Y[jc]+lat*TB[jc]+CEIL[jc], Y[ci]+latc*TB[ci]+CEIL[ci])-CAM_ROOF;
  if(c.y>roof) c.y=roof;
  const floor=Y[jc]+lat*TB[jc]+.9;
  if(c.y<floor) c.y=floor;
}
