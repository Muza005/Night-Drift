// Car physics. FROZEN.
//
// Started as the single-file version's physics(), moved here word for word; the track
// part lives in each mode's constrain(). Every mode drives the car through this one
// function, so the car feels the same everywhere.
//
// Version 2 (changed on purpose; everything else is as before):
//  0. Top speed on a straight is 200 km/h (VMAX 72.3; was 50, which gave 149 km/h).
//  1. Grip no longer makes speed out of nothing. Version 1 added 40% of the sideways
//     speed that grip took away to the forward speed. Every turn makes a little
//     sideways speed, so weaving left and right pushed the car to 210-280 km/h while
//     driving straight topped out at 149 (version 1's numbers). Now at most 75% of the sideways motion's
//     energy carries on forward, so a turn can never speed the car up.
//  2. Turning at speed scrubs a little speed (the tyres work sideways): driving straight
//     is the fastest way, weaving costs 10-25 km/h of top speed.
//  3. Slipstream: I.draft (0..1, from core/draft.js) adds up to DRAFT_ACC of push while
//     on the throttle behind another player: twice the pull at 150 km/h, and a top
//     speed of 250 km/h instead of 200.
// Off the asphalt the throttle keeps 77.5% of its pull (was 55%): half the penalty.
//
// Do not change anything in this file without running `npm test`: the test replays
// three minutes of driving and requires every position and speed to match the
// recording of version 2 (tests/fixtures/physics-golden-v2.json), bit for bit.

export const VMAX=72.3, ACC=24, BRAKE=34, VREV=11, DRAFT_ACC=6;
const KEEP=.75, SCRUB=.1;

// Hitting a wall or rail: how much speed the car keeps, by how hard it hit (vn, m/s
// into the wall). Version 1 always kept 90 %, every physics substep in contact, so a
// car sliding along a rail lost most of its speed within a second. Now a glancing
// touch keeps 99 %+ and only a hard hit (5 m/s and up) costs the full 10 %.
export const wallKeep = vn => 1 - Math.min(.1, vn * .02);

// Scraping along a wall turns the car parallel to it (nx, nz: the wall's normal, pointing
// into the wall). Without this a car pressed against a rail kept its nose angled in while
// the rail forced it to move along: all that motion was sideways for the tyres, grip
// killed it, and the car stopped dead within a second.
export function wallAlign(car, nx, nz, dt){
  const fx=Math.sin(car.h), fz=Math.cos(car.h), into=fx*nx+fz*nz;
  if(into<=0 || car.vx*fx+car.vz*fz<=0) return;           // nose already away, or reversing
  const tx=fx-into*nx, tz=fz-into*nz;                      // along the wall, the way the nose points
  let d=Math.atan2(tx,tz)-car.h; d=Math.atan2(Math.sin(d),Math.cos(d));
  car.h+=d*Math.min(1,30*dt);
}

// I = {up, down, left, right, hb}, each 0 or 1; optional I.draft 0..1.
export function stepCar(car,I,dt){
  const thr=I.up, brk=I.down, hb=I.hb;
  const sIn=I.right-I.left;
  car.steer+=(sIn-car.steer)*Math.min(1,dt*(sIn?6.5:10));
  const fx=Math.sin(car.h), fz=Math.cos(car.h), rx=Math.cos(car.h), rz=-Math.sin(car.h);
  let vF=car.vx*fx+car.vz*fz, vR=car.vx*rx+car.vz*rz;
  const speed=Math.hypot(vF,vR);

  if(thr){ if(vF<-.5) vF+=BRAKE*dt; else vF+=ACC*Math.max(0,1-vF/VMAX)*dt*(car.off?.775:1); }
  if(thr && I.draft>0 && vF>0) vF+=DRAFT_ACC*I.draft*dt;
  if(brk){ if(vF>.5) vF-=BRAKE*dt; else vF=Math.max(-VREV,vF-ACC*.5*dt); }
  if(!thr&&!brk){ const r=Math.min(Math.abs(vF),4.5*dt); vF-=Math.sign(vF)*r; }
  vF-=vF*.1*dt;
  if(speed>8 && !hb) vF-=vF*SCRUB*Math.abs(car.steer)*Math.min(1,(speed-8)/20)*dt;
  if(hb){ const r=Math.min(Math.abs(vF),8*dt); vF-=Math.sign(vF)*r; }

  let grip=11;
  const sliding=Math.abs(vR)>5.2;
  if(sliding) grip=2.5;
  if(thr&&Math.abs(vR)>3) grip*=.78;
  if(hb) grip=.9;
  if(car.off) grip*=.7;
  if(speed<5) grip=14;
  const vR2=vR*Math.exp(-grip*dt);
  if(vF>2) vF=Math.sqrt(vF*vF+(vR*vR-vR2*vR2)*KEEP);
  vR=vR2;

  const sp=Math.abs(vF);
  let yawK=2.35*Math.min(1,sp/7)/(1+sp/55);
  if(hb||sliding) yawK*=1.5;
  car.vx=fx*vF+rx*vR; car.vz=fz*vF+rz*vR;
  car.h-=car.steer*yawK*dt*(vF<-.5?-1:1);
  // spin left over from being hit by another car
  car.h+=car.spinV*dt; car.spinV*=Math.exp(-2.5*dt);
  car.x+=car.vx*dt; car.z+=car.vz*dt;
  car.vF=vF; car.vR=vR;
}
