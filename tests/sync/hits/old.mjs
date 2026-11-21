// The collision code as it is at 6a4c289 (net.js collideGhosts / onBump / kick / ghost
// display), copied with NET/G replaced by a client object, for the "before" numbers.
const angDiff=(a,b)=>{ const t=Math.PI*2; return (((b-a+Math.PI)%t)+t)%t-Math.PI; };
export function predict(s0,s1,nowS){
  const age=Math.min(.5,Math.max(0,(nowS-s1.t)/1000));
  let w=0; if(s0){ const span=(s1.t-s0.t)/1000; if(span>.005) w=Math.max(-3,Math.min(3,angDiff(s0.h,s1.h)/span)); }
  const turn=w*age, c=Math.cos(-turn/2), sn=Math.sin(-turn/2);
  return {x:s1.x+(s1.vx*c-s1.vz*sn)*age, z:s1.z+(s1.vx*sn+s1.vz*c)*age, h:s1.h+turn};
}
function kickDisp(g,nowS){
  const K=g.kick; if(!K) return {x:0,z:0,h:0,vx:0,vz:0,w:0};
  const tau=Math.max(0,(nowS-K.t)/1000), e=Math.exp(-K.k*tau), f=(1-e)/K.k;
  return {x:K.bx+K.vx*f, z:K.bz+K.vz*f, h:K.bh+K.w*f, vx:K.vx*e, vz:K.vz*e, w:K.w*e};
}
const CAR_R=1.05, CAR_OFF=1.15, CAR_I=1.87, BOUNCE=.3;
function carCircles(x,z,h){ const fx=Math.sin(h), fz=Math.cos(h); return [[x+fx*CAR_OFF,z+fz*CAR_OFF],[x-fx*CAR_OFF,z-fz*CAR_OFF]]; }
const clampN=(v,a)=>Math.max(-a,Math.min(a,v));

export const oldAlgo = {
  name: 'before',
  ghost(cl, g, nowS, dt, keep){
    const b=g.buf; if(!b.length) return;
    const s1=b[b.length-1], s0=b.length>1?b[0]:null;
    const T=predict(s0,s1,nowS);
    if(!g.off) g.off={x:0,z:0,h:0};
    if(g.last && g.last!==s1){
      const O=predict(g.lastPrev,g.last,nowS), ko=kickDisp(g,nowS);
      if(g.kick && s1.t>g.kick.t+(cl.rtt||250)+80) g.kick=null;
      const kn=kickDisp(g,nowS);
      g.off.x+=O.x+ko.x-T.x-kn.x; g.off.z+=O.z+ko.z-T.z-kn.z; g.off.h+=angDiff(T.h+kn.h,O.h+ko.h);
    }
    g.last=s1; g.lastPrev=s0;
    { const kd=kickDisp(g,nowS); T.x+=kd.x; T.z+=kd.z; T.h+=kd.h; g.vx=s1.vx+kd.vx; g.vz=s1.vz+kd.vz; }
    if(Math.hypot(g.off.x,g.off.z)>12){ g.off.x=g.off.z=g.off.h=0; }
    const k=Math.exp(-10*dt); g.off.x*=k; g.off.z*=k; g.off.h*=k;
    const s={x:T.x+g.off.x,z:T.z+g.off.z,h:T.h+g.off.h,idx:s1.idx};
    if(keep) keep(s,g);
    g.x=s.x; g.z=s.z; g.h=s.h;
  },
  collide(cl){
    const car=cl.car, g=cl.ghost, now=cl.nowMs(), nowS=cl.nowMs();
    if(g.vx===undefined) return;
    if(Math.hypot(g.x-car.x,g.z-car.z)>6) return;
    let best=null;
    for(const a of carCircles(car.x,car.z,car.h)) for(const b of carCircles(g.x,g.z,g.h)){
      const dx=a[0]-b[0], dz=a[1]-b[1], d=Math.hypot(dx,dz);
      if(d<2*CAR_R && (!best||d<best.d)) best={d,dx,dz,b};
    }
    if(!best) return;
    const d=Math.max(best.d,1e-3), nx=best.dx/d, nz=best.dz/d, pen=2*CAR_R-d;
    car.x+=nx*pen*.5; car.z+=nz*pen*.5; cl.stat.push(pen*.5);
    const vn=(car.vx-g.vx)*nx+(car.vz-g.vz)*nz;
    if(vn>=0) return;
    const cx=best.b[0]+nx*CAR_R, cz=best.b[1]+nz*CAR_R;
    const j=-(1+BOUNCE)*vn/2, Jx=nx*j, Jz=nz*j;
    car.vx+=Jx; car.vz+=Jz; cl.stat.apply('own', Math.hypot(Jx,Jz));
    car.spinV=clampN(car.spinV+((cz-car.z)*Jx-(cx-car.x)*Jz)/CAR_I*.6,4);
    cl.hitAt=now;
    if(now-(cl.sentAt||0)>250){
      cl.sentAt=now;
      const w=clampN(((cz-g.z)*-Jx-(cx-g.x)*-Jz)/CAR_I*.6,4);
      cl.send({jx:-Jx,jz:-Jz,w,dx:-nx*pen*.5,dz:-nz*pen*.5});
      const kd=kickDisp(g,nowS);
      g.kick={t:nowS,k:3,bx:kd.x,bz:kd.z,bh:kd.h,vx:kd.vx-Jx,vz:kd.vz-Jz,w:kd.w+w};
    }
  },
  onBump(cl, m){
    const car=cl.car, now=cl.nowMs();
    if(now-(cl.hitAt||0)<300){ cl.stat.ignored++; return; }
    cl.hitAt=now;
    car.vx+=m.jx; car.vz+=m.jz; car.spinV=clampN(car.spinV+m.w,4);
    car.x+=m.dx; car.z+=m.dz; cl.stat.push(Math.hypot(m.dx,m.dz));
    cl.stat.apply('recv', Math.hypot(m.jx,m.jz));
  },
};
