// Car physics. FROZEN.
//
// This is the single-file version's physics() up to the point where it looked at the
// track, moved here word for word. The track part now lives in each mode's constrain().
// Every mode drives the car through this one function, so the car feels the same
// everywhere.
//
// Do not change anything in this file without running `npm test`: the test replays
// three minutes of driving and requires every position and speed to match the
// recording made from the original code, bit for bit.

export const VMAX=50, ACC=24, BRAKE=34, VREV=11;

// I = {up, down, left, right, hb}, each 0 or 1.
export function stepCar(car,I,dt){
  const thr=I.up, brk=I.down, hb=I.hb;
  const sIn=I.right-I.left;
  car.steer+=(sIn-car.steer)*Math.min(1,dt*(sIn?6.5:10));
  const fx=Math.sin(car.h), fz=Math.cos(car.h), rx=Math.cos(car.h), rz=-Math.sin(car.h);
  let vF=car.vx*fx+car.vz*fz, vR=car.vx*rx+car.vz*rz;
  const speed=Math.hypot(vF,vR);

  if(thr){ if(vF<-.5) vF+=BRAKE*dt; else vF+=ACC*Math.max(0,1-vF/VMAX)*dt*(car.off?.55:1); }
  if(brk){ if(vF>.5) vF-=BRAKE*dt; else vF=Math.max(-VREV,vF-ACC*.5*dt); }
  if(!thr&&!brk){ const r=Math.min(Math.abs(vF),4.5*dt); vF-=Math.sign(vF)*r; }
  vF-=vF*.1*dt;
  if(hb){ const r=Math.min(Math.abs(vF),8*dt); vF-=Math.sign(vF)*r; }

  let grip=11;
  const sliding=Math.abs(vR)>5.2;
  if(sliding) grip=2.5;
  if(thr&&Math.abs(vR)>3) grip*=.78;
  if(hb) grip=.9;
  if(car.off) grip*=.7;
  if(speed<5) grip=14;
  const vR2=vR*Math.exp(-grip*dt);
  const lost=Math.abs(vR)-Math.abs(vR2);
  if(vF>2) vF+=lost*.4;
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
