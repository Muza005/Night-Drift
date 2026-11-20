// Drift track scenery: ground, road, curbs, neon walls, start gantry, lamps, city, and
// (track engine v2) embankments, bridges with pillars. Built from the active map
// (geometry.js) and built again when the map changes.
//
// Every offset line (curb, run-off, wall) is limited on the inside of a turn to 0.9 × the
// local radius (geometry.js safeOffsets) and checked for folds, so on a hairpin tighter
// than the offset the line narrows instead of looping over itself ("broken curbs").
import { scene, cv, tex, glowTex, winTex } from '../../core/render.js';
import { P, NM, TG, DIST, Y, TB, BRIDGE, MAP, N, ROAD, HALF, CURB, WALL, START, safeOffsets, onMapChange } from './geometry.js';

// Road texture: 512 px across the 16 m road (32 px/m), one tile = ROAD_TILE m along it.
// Edge lines 5 px = 0.156 m, 0.5 m in from the asphalt edge; centre line 4 px = 0.125 m,
// dashed 3 m with a 6 m gap (two 9 m periods per 18 m tile). Anisotropy and mipmaps come from tex().
const ROAD_TILE = 18;
const roadTex = (() => {
  const W=512, H=1024, pxV=H/ROAD_TILE;
  const [c,g]=cv(W,H); g.fillStyle='#24262f'; g.fillRect(0,0,W,H);
  const id=g.getImageData(0,0,W,H); for(let k=0;k<id.data.length;k+=4){const n=(Math.random()-.5)*26; id.data[k]+=n; id.data[k+1]+=n; id.data[k+2]+=n;} g.putImageData(id,0,0);
  g.fillStyle='rgba(235,240,255,.85)'; g.fillRect(16,0,5,H); g.fillRect(W-21,0,5,H);
  g.fillStyle='rgba(255,194,61,.9)'; for(let m=0;m<ROAD_TILE;m+=9) g.fillRect(W/2-2,Math.round(m*pxV),4,Math.round(3*pxV));
  return tex(c,true);
})();
const groundTex = (() => {
  const [c,g]=cv(256,256); g.fillStyle='#0c0d18'; g.fillRect(0,0,256,256);
  g.strokeStyle='rgba(120,90,255,.20)'; g.lineWidth=2; g.strokeRect(0,0,256,256);
  g.strokeStyle='rgba(120,90,255,.07)'; g.lineWidth=1; g.beginPath(); g.moveTo(128,0); g.lineTo(128,256); g.moveTo(0,128); g.lineTo(256,128); g.stroke();
  const t=tex(c,true); t.repeat.set(90,90); return t;
})();
const checkerTex = (() => {
  const [c,g]=cv(256,32); for(let x=0;x<16;x++) for(let y=0;y<2;y++){ g.fillStyle=(x+y)%2?'#111':'#f2f2f2'; g.fillRect(x*16,y*16,16,16);} return tex(c,false);
})();

// An offset line along the track: off (m, > 0 left) or a per-point array. Returns the
// points x, y (on the banked road surface plus yOff), z. A point that would step backwards
// along the track (a fold) is pulled onto the previous one, so no quad turns inside out.
function offsetLine(off, yOff){
  const O=typeof off==='number'?safeOffsets(off):off, x=new Float64Array(N), y=new Float64Array(N), z=new Float64Array(N);
  for(let i=0;i<N;i++){ const o=O[i]; x[i]=P[i].x+NM[i].x*o; z[i]=P[i].z+NM[i].z*o; y[i]=Y[i]+o*TB[i]+yOff; }
  for(let pass=0;pass<2;pass++) for(let i=0;i<N;i++){ const j=(i+1)%N, t=TG[i];
    if((x[j]-x[i])*t.x+(z[j]-z[i])*t.z<0){ x[j]=x[i]; z[j]=z[i]; } }
  return {x,y,z};
}
// skip(i): leave out the piece from point i to i+1
function ribbon(o0,o1,yOff,vScale,colorFn,skip){
  const pos=[],uv=[],nor=[],col=[]; const L0=offsetLine(o0,yOff), L1=offsetLine(o1,yOff);
  for(let i=0;i<N;i++){ const j=(i+1)%N; if(skip && skip(i)) continue;
    const v0=DIST[i]/vScale, v1=(DIST[i]+P[i].distanceTo(P[j]))/vScale;
    const A=[L0.x[i],L0.y[i],L0.z[i]], B=[L1.x[i],L1.y[i],L1.z[i]], C=[L0.x[j],L0.y[j],L0.z[j]], D=[L1.x[j],L1.y[j],L1.z[j]];
    for(const [p,u,v] of [[A,0,v0],[C,0,v1],[B,1,v0],[B,1,v0],[C,0,v1],[D,1,v1]]){ pos.push(p[0],p[1],p[2]); uv.push(u,v); nor.push(0,1,0); }
    if(colorFn){ const c=colorFn(i); for(let k=0;k<6;k++) col.push(c.r,c.g,c.b); }
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
  if(colorFn) g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
  return g;
}
// A vertical strip along offset `off`, from y0 to y1 above the road surface there.
// ground: the bottom goes down to the ground (y0 is then the ground height) - embankments.
function vribbon(off,y0,y1,skip,ground){
  const pos=[]; const L=offsetLine(off,0);
  for(let i=0;i<N;i++){ const j=(i+1)%N; if(skip && skip(i)) continue;
    const ax=L.x[i], az=L.z[i], bx=L.x[j], bz=L.z[j];
    const a0=ground?y0:L.y[i]+y0, b0=ground?y0:L.y[j]+y0, a1=L.y[i]+y1, b1=L.y[j]+y1;
    pos.push(ax,a0,az, bx,b0,bz, ax,a1,az, ax,a1,az, bx,b0,bz, bx,b1,bz); }
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); g.computeVertexNormals(); return g;
}

// Everything the track adds to the scene lives in this group, so the track mode can
// hide it while another mode is active. The map's own pieces are in `built`.
export const group = new THREE.Group();
scene.add(group);
let built = null;

const groundMat = new THREE.MeshStandardMaterial({map:groundTex, roughness:.95});
const runoffMat = new THREE.MeshStandardMaterial({color:0x17142a, roughness:1, side:THREE.DoubleSide});
const roadMat = new THREE.MeshStandardMaterial({map:roadTex, roughness:.82, metalness:.05, side:THREE.DoubleSide});
const curbMat = new THREE.MeshStandardMaterial({vertexColors:true, roughness:.6, side:THREE.DoubleSide});
const wallMat = new THREE.MeshStandardMaterial({color:0x161929, roughness:.7, side:THREE.DoubleSide});
const neonMat = { 1: new THREE.MeshBasicMaterial({color:0x3ef0ff, side:THREE.DoubleSide, toneMapped:false}),
  '-1': new THREE.MeshBasicMaterial({color:0xff3b6b, side:THREE.DoubleSide, toneMapped:false}) };
const bankMat = new THREE.MeshStandardMaterial({color:0x1c1a2c, roughness:.9, side:THREE.DoubleSide});     // embankment sides
const deckMat = new THREE.MeshStandardMaterial({color:0x232636, roughness:.8, side:THREE.DoubleSide});     // bridge deck and pillars
const archMat = new THREE.MeshBasicMaterial({color:0xffc23d, toneMapped:false});
const cRed=new THREE.Color(0xff2e5a), cWhite=new THREE.Color(0xf0f0f6);
const dark=new THREE.MeshStandardMaterial({color:0x1b1e2e, roughness:.5, metalness:.6});
const postMat=new THREE.MeshStandardMaterial({color:0x22253a,metalness:.6,roughness:.4});
const headMat=new THREE.MeshBasicMaterial({color:0xffd59a,toneMapped:false});
const poolMat=new THREE.MeshBasicMaterial({map:glowTex,color:0xffa956,transparent:true,opacity:.28,blending:THREE.AdditiveBlending,depthWrite:false});
const cityMat=new THREE.MeshStandardMaterial({color:0x0e1020,roughness:.8,emissive:0xffffff,emissiveMap:winTex,emissiveIntensity:.9});
const chk=checkerTex.clone(); chk.needsUpdate=true;
const lineMat=new THREE.MeshStandardMaterial({map:chk, roughness:.7});

// The track points (every second one) within `r` m of horizontal point (x, z), at any
// height (for lamps and pillars: nothing stands on another road or under a bridge).
function roadsNear(x,z,r){ const out=[]; for(let i=0;i<N;i+=2){ const dx=P[i].x-x, dz=P[i].z-z; if(dx*dx+dz*dz<r*r) out.push(i); } return out; }

function build(){
  // the old map's pieces: geometries, the instanced meshes' instance buffers and the
  // lamps' sprite materials (every other material is shared and kept)
  if(built){ group.remove(built); built.traverse(o=>{ if(o.geometry) o.geometry.dispose(); if(o.isInstancedMesh) o.dispose(); if(o.isSprite) o.material.dispose(); }); }
  const B = built = new THREE.Group(); group.add(B);
  let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9; for(const p of P){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);}
  const cx=(minX+maxX)/2, cz=(minZ+maxZ)/2;
  const flatMap = Y.every(y=>y===0);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400,2400).rotateX(-Math.PI/2), groundMat);
  if(!flatMap) ground.position.set(cx,-.02,cz);   // («Ночной город» keeps its ground where it always was)
  ground.receiveShadow = true; B.add(ground);

  for(const s of [1,-1]){ const m=new THREE.Mesh(ribbon(s*(HALF+CURB), s*WALL, .012, 10), runoffMat); m.receiveShadow=true; B.add(m); }
  const road = new THREE.Mesh(ribbon(-HALF, HALF, .02, ROAD_TILE), roadMat);
  road.receiveShadow = true; B.add(road);
  for(const [a,b] of [[HALF,HALF+CURB],[-HALF-CURB,-HALF]]){ const m=new THREE.Mesh(ribbon(a,b,.035,1,i=>Math.floor(DIST[i]/3)%2?cRed:cWhite), curbMat); m.receiveShadow=true; B.add(m); }
  for(const s of [1,-1]){
    // the neon strip 2 cm inside the wall, also where a hairpin pulls the wall in
    const O=safeOffsets(s*WALL), In=O.map(o=>o-Math.sign(o)*.02);
    B.add(new THREE.Mesh(vribbon(O,0,.95), wallMat));
    B.add(new THREE.Mesh(vribbon(In,.78,.95), neonMat[s]));
  }

  // Raised road: an embankment (sides down to the ground) where it is not a bridge; a
  // bridge is a deck 1.1 m thick on pillars, with a lit arch at each end.
  if(!flatMap){
    const low=i=>Math.max(Y[i],Y[(i+1)%N])<.05;
    for(const s of [1,-1]) B.add(new THREE.Mesh(vribbon(s*(WALL+.02),-.05,0,i=>low(i)||BRIDGE[i]||BRIDGE[(i+1)%N],true), bankMat));
    const notBridge=i=>!(BRIDGE[i]&&BRIDGE[(i+1)%N]);
    // the deck casts a shadow, so a car on the bridge does not throw its own onto the road below
    const deck=new THREE.Mesh(ribbon(-WALL-.2, WALL+.2, -1.1, 10, null, notBridge), deckMat); deck.castShadow=true; B.add(deck);
    for(const s of [1,-1]){ const side=new THREE.Mesh(vribbon(s*(WALL+.2),-1.1,.05,notBridge), deckMat); side.castShadow=true; B.add(side); }
    const pil=[]; let last=-1e9;
    for(let i=0;i<N;i++){ if(!BRIDGE[i] || DIST[i]-last<14) continue; last=DIST[i];
      for(const s of [1,-1]){ const o=s*(WALL-1), x=P[i].x+NM[i].x*o, z=P[i].z+NM[i].z*o, top=Y[i]+o*TB[i]-1.1;
        // not on a road below
        if(roadsNear(x,z,WALL+1.5).some(j=>Y[j]<top-3)) continue;
        if(top>.5) pil.push([x,z,top,Math.atan2(TG[i].x,TG[i].z)]); } }
    if(pil.length){ const pg=new THREE.BoxGeometry(1.4,1,2.2).translate(0,.5,0), im=new THREE.InstancedMesh(pg,deckMat,pil.length);
      const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler();
      pil.forEach(([x,z,h,a],k)=>{ e.set(0,a,0); q.setFromEuler(e); m.compose(new THREE.Vector3(x,0,z),q,new THREE.Vector3(1,h,1)); im.setMatrixAt(k,m); });
      im.castShadow=true; B.add(im); }
    // arches over the two ends of each bridge
    for(let i=0;i<N;i++){ if(BRIDGE[i]===BRIDGE[(i+1)%N]) continue; const k=BRIDGE[i]?i:(i+1)%N;
      const g=new THREE.Group(); g.position.copy(P[k]); g.rotation.y=Math.atan2(TG[k].x,TG[k].z);
      for(const s of [1,-1]){ const p=new THREE.Mesh(new THREE.BoxGeometry(.5,6,.5),dark); p.position.set(s*(WALL-.4),3,0); g.add(p); }
      const beam=new THREE.Mesh(new THREE.BoxGeometry(2*WALL,.35,.5),dark); beam.position.y=6; g.add(beam);
      const strip=new THREE.Mesh(new THREE.BoxGeometry(2*WALL-.6,.14,.54),archMat); strip.position.y=5.8; g.add(strip);
      B.add(g); }
  }

  /* start gantry */
  { const g=new THREE.Group(); const t=TG[START]; g.position.copy(P[START]); g.rotation.y=Math.atan2(t.x,t.z);
    const line=new THREE.Mesh(new THREE.PlaneGeometry(ROAD,2.2).rotateX(-Math.PI/2), lineMat);
    line.position.y=.045; line.receiveShadow=true; g.add(line);
    for(const s of [1,-1]){ const p=new THREE.Mesh(new THREE.BoxGeometry(.6,7,.6),dark); p.position.set(s*(HALF+2.2),3.5,0); p.castShadow=true; g.add(p); }
    const beam=new THREE.Mesh(new THREE.BoxGeometry(ROAD+5,.9,.7),dark); beam.position.y=7; g.add(beam);
    const strip=new THREE.Mesh(new THREE.BoxGeometry(ROAD+4.6,.22,.74),archMat); strip.position.y=6.75; g.add(strip);
    B.add(g); }

  /* lamps: on the road's level, never on another road (the inside of a hairpin) or under a bridge */
  { const every=(MAP.decor&&MAP.decor.lamps)||16, spots=[];
    for(let i=0,k=0;i<N;i+=every,k++){ const s=k%2?1:-1, n=NM[i], o=s*(WALL+1.3);
      const v=P[i].clone().addScaledVector(n,o), base=Y[i]+o*TB[i];
      const near=roadsNear(v.x,v.z,WALL+.5);
      if(near.some(j=>Math.abs(j-i)>40 && Math.abs(j-i)<N-40)) continue;
      if(roadsNear(v.x,v.z,WALL+3).some(j=>Y[j]>base+2 && Y[j]<base+9.5)) continue;
      spots.push([i,s,v,base]); }
    const postG=new THREE.CylinderGeometry(.14,.2,1,6).translate(0,.5,0);
    const headG=new THREE.BoxGeometry(2.4,.22,.6);
    const posts=new THREE.InstancedMesh(postG,postMat,spots.length), heads=new THREE.InstancedMesh(headG,headMat,spots.length);
    const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler(), one=new THREE.Vector3(1,1,1);
    const poolG=new THREE.PlaneGeometry(15,15).rotateX(-Math.PI/2);
    spots.forEach(([i,s,v,base],k)=>{ const n=NM[i];
      const ang=Math.atan2(n.x,n.z); e.set(0,ang,0); q.setFromEuler(e);
      const bot=flatMap?0:Math.min(0,base); v.y=bot; m.compose(v,q,new THREE.Vector3(1,7.5+base-bot,1)); posts.setMatrixAt(k,m);
      const hp=v.clone().addScaledVector(n,-s*1.1); hp.y=base+7.4; m.compose(hp,q,one); heads.setMatrixAt(k,m);
      const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,color:0xffb15a,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:.8}));
      sp.position.copy(hp); sp.scale.set(6,6,1); B.add(sp);
      const po=s*(WALL-3.5), pool=new THREE.Mesh(poolG,poolMat); pool.position.copy(P[i]).addScaledVector(n,po); pool.position.y=Y[i]+po*TB[i]+.05; B.add(pool);
    });
    posts.castShadow=true; B.add(posts, heads); }

  /* city */
  { const cnt=(MAP.decor&&MAP.decor.city)||150, g=new THREE.BoxGeometry(1,1,1).translate(0,.5,0);
    const city=new THREE.InstancedMesh(g,cityMat,cnt); const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler();
    // «Ночной город»'s city box (x from -315 to 410, z from -242 to 435 m); other maps: around their own track
    const w0=flatMap&&MAP.id==='neon'?600*MAP.scale/1.2:(maxX-minX)+260, d0=flatMap&&MAP.id==='neon'?560*MAP.scale/1.2:(maxZ-minZ)+260;
    const x0=flatMap&&MAP.id==='neon'?-260*MAP.scale/1.2:minX-130, z0=flatMap&&MAP.id==='neon'?-200*MAP.scale/1.2:minZ-130;
    let placed=0, tries=0;
    while(placed<cnt && tries<6000){ tries++;
      const x=x0+Math.random()*w0, z=z0+Math.random()*d0;
      const w=10+Math.random()*22, d=10+Math.random()*22, h=12+Math.random()*(Math.random()<.2?90:40);
      let ok=true, need=WALL+Math.max(w,d)*.75+5;
      for(let i=0;i<N;i+=3){ const dx=P[i].x-x, dz=P[i].z-z; if(dx*dx+dz*dz<need*need){ok=false;break;} }
      if(!ok) continue;
      e.set(0,Math.random()*Math.PI,0); q.setFromEuler(e); m.compose(new THREE.Vector3(x,0,z),q,new THREE.Vector3(w,h,d)); city.setMatrixAt(placed++,m);
    }
    city.count=placed; city.castShadow=true; city.receiveShadow=true; B.add(city); }
}
build();
onMapChange(build);
