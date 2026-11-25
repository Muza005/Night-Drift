// The collision code (stage 8): net.js collideGhosts / onBump / updateGhosts (the parts that
// move the ghost), with NET/G replaced by a client object. The maths is the real bump.js.
const B = await import('../../../public/js/net/bump.js');
const S = await import('../../../public/js/net/ghostsync.js');
const P = process.env.SMOOTH ? { ...S.SMOOTH, ...JSON.parse(process.env.SMOOTH) } : S.SMOOTH;
const add=(p,k)=>({x:p.x+k.x,z:p.z+k.z,h:p.h+k.h,vx:p.vx+k.vx,vz:p.vz+k.vz,w:(p.w||0)+k.w});
export const newAlgo = {
  name: 'after', B,
  ghost(cl, g, nowS, dt, keep, car){
    const b=g.buf; if(!b.length) return;
    const s1=b[b.length-1], s0=b.length>1?b[0]:null;
    const T=S.predict(s0,s1,nowS,P);
    if(!g.view) g.view=S.newView();
    if(g.last && g.last!==s1){
      const O=S.predict(g.lastPrev,g.last,nowS,P), ko=B.kickAt(g.kick,nowS,g.last.t);
      g.kick=B.kickUpdate(g.kick,g.last,s1,cl.rtt);
      const kn=B.kickAt(g.kick,nowS,s1.t);
      S.correct(g.view, add(O,ko), add(T,kn), P);
    }
    g.last=s1; g.lastPrev=s0;
    const kd=B.kickAt(g.kick,nowS,s1.t); T.x+=kd.x; T.z+=kd.z; T.h+=kd.h;
    g.vx=s1.vx+kd.vx; g.vz=s1.vz+kd.vz; g.rvx=s1.vx; g.rvz=s1.vz; g.spinV=kd.w;
    if(g.pinned){ g.view.ov.x=g.view.ov.z=0; } else S.settle(g.view,dt,P);
    const o=g.view.off, s={x:T.x+o.x,z:T.z+o.z,h:T.h+o.h,idx:s1.idx};
    if(keep) keep(s,g);
    g.pinned=false;
    if(g.mem){ const bx=s.x, bz=s.z; B.keepOut(s,car,g.mem,cl.nowMs(),cl.rtt,g.car); if(s.x!==bx||s.z!==bz){ g.view.off.x+=s.x-bx; g.view.off.z+=s.z-bz; g.pinned=true; } }
    g.x=s.x; g.z=s.z; g.h=s.h;
  },
  collide(cl, dt=1/120){
    const car=cl.car, g=cl.ghost, now=cl.nowMs(), tS=cl.nowMs();
    B.catchUp(car,dt);
    const mem=g.mem||(g.mem=B.newMem());
    const out=B.takeOut(mem,now); if(out) cl.send(out);
    if(g.vx===undefined || Math.hypot(g.x-car.x,g.z-car.z)>6) return;
    const x0=car.x, z0=car.z, v0x=car.vx, v0z=car.vz;
    const r=B.collideStep(car,g,mem,{now,tS,mMe:B.carMass(car.carId),mOther:B.carMass(g.car),air:!!cl.air});
    if(r && r.pushed) cl.stat.push(Math.hypot(car.x-x0,car.z-z0));
    if(r && r.wait) cl.stat.waits=(cl.stat.waits||0)+1;
    if(!r || !r.other) return;
    cl.stat.apply('own', Math.hypot(car.vx-v0x,car.vz-v0z));
    g.kick=B.kickStart(g.kick,g,r.other,r.push,tS);
  },
  onBump(cl, m){
    const car=cl.car, g=cl.ghost, mem=g.mem||(g.mem=B.newMem());
    const v0x=car.vx, v0z=car.vz;
    const hit=B.receive(car,m,mem,{now:cl.nowMs(),tS:cl.nowMs(),mMe:B.carMass(car.carId),mOther:B.carMass(g.car),meId:cl.id,fromId:m.from,rtt:cl.rtt,air:!!cl.air});
    if(mem.undone){ g.kick=null; cl.stat.undone=(cl.stat.undone||0)+1; cl.stat.apps.push([cl.now,'undo',0]); }
    if(!hit){ cl.stat.ignored++; return; }
    cl.stat.push(Math.hypot(m.dx,m.dz));
    cl.stat.apply('recv', Math.hypot(car.vx-v0x,car.vz-v0z));
  },
};
