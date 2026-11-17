// Tire marks and smoke.
import { scene, glowTex } from './render.js';

const MARKS=2600;
const marks=new THREE.InstancedMesh(new THREE.PlaneGeometry(.34,1).rotateX(-Math.PI/2),
  new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.6,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2}),MARKS);
marks.count=0; marks.frustumCulled=false; scene.add(marks);
let markI=0, markTotal=0;
const _m=new THREE.Matrix4(), _q=new THREE.Quaternion(), _e=new THREE.Euler(), _v=new THREE.Vector3(), _s=new THREE.Vector3();
export function addMark(holder,k,x,z){
  const L=holder.lastMark[k]; if(!L){ holder.lastMark[k]={x,z}; return; }
  const dx=x-L.x, dz=z-L.z, d=Math.hypot(dx,dz); if(d<.45) return;
  if(d>4){ holder.lastMark[k]={x,z}; return; }
  _v.set((x+L.x)/2,.04,(z+L.z)/2); _e.set(0,Math.atan2(dx,dz),0); _q.setFromEuler(_e); _s.set(1,1,d+.05);
  _m.compose(_v,_q,_s); marks.setMatrixAt(markI,_m); markI=(markI+1)%MARKS; markTotal++;
  marks.count=Math.min(markTotal,MARKS); marks.instanceMatrix.needsUpdate=true; holder.lastMark[k]={x,z};
}
export function clearMarks(){ marks.count=0; markTotal=0; markI=0; }
const SMOKE=360;
const smokePos=new Float32Array(SMOKE*3), smokeCol=new Float32Array(SMOKE*3);
const smoke=[]; for(let i=0;i<SMOKE;i++){ smoke.push({x:0,y:-99,z:0,vx:0,vy:0,vz:0,life:0,max:1}); smokePos[i*3+1]=-99; }
const smokeGeo=new THREE.BufferGeometry();
smokeGeo.setAttribute('position',new THREE.BufferAttribute(smokePos,3));
smokeGeo.setAttribute('color',new THREE.BufferAttribute(smokeCol,3));
const smokePts=new THREE.Points(smokeGeo,new THREE.PointsMaterial({size:3.4,map:glowTex,vertexColors:true,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,sizeAttenuation:true}));
smokePts.frustumCulled=false; scene.add(smokePts);
let smokeI=0;
export function emitSmoke(x,z,vx,vz,amt){
  const p=smoke[smokeI]; smokeI=(smokeI+1)%SMOKE;
  p.x=x+(Math.random()-.5)*.6; p.y=.4; p.z=z+(Math.random()-.5)*.6;
  p.vx=vx*.25+(Math.random()-.5)*2; p.vy=1+Math.random()*1.5; p.vz=vz*.25+(Math.random()-.5)*2;
  p.max=p.life=.9+Math.random()*.8*amt;
}
export function updateSmoke(dt){
  for(let i=0;i<SMOKE;i++){ const p=smoke[i];
    if(p.life>0){ p.life-=dt; p.x+=p.vx*dt; p.y+=p.vy*dt; p.z+=p.vz*dt; const k=Math.exp(-2.2*dt); p.vx*=k; p.vz*=k; p.vy*=k; }
    const a=Math.max(0,p.life/p.max)*.32;
    smokePos[i*3]=p.x; smokePos[i*3+1]=p.life>0?p.y:-99; smokePos[i*3+2]=p.z;
    smokeCol[i*3]=a*.95; smokeCol[i*3+1]=a*.85; smokeCol[i*3+2]=a*1.0;
  }
  smokeGeo.attributes.position.needsUpdate=true; smokeGeo.attributes.color.needsUpdate=true;
}
