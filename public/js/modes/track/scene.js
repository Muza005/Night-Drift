// Drift track scenery: ground, road, curbs, neon walls, start gantry, lamps, city.
import { scene, cv, tex, glowTex, winTex } from '../../core/render.js';
import { P, NM, TG, DIST, N, SC, ROAD, HALF, CURB, WALL, START } from './geometry.js';

const roadTex = (() => {
  const [c,g]=cv(256,512); g.fillStyle='#24262f'; g.fillRect(0,0,256,512);
  const id=g.getImageData(0,0,256,512); for(let k=0;k<id.data.length;k+=4){const n=(Math.random()-.5)*26; id.data[k]+=n; id.data[k+1]+=n; id.data[k+2]+=n;} g.putImageData(id,0,0);
  g.fillStyle='rgba(235,240,255,.85)'; g.fillRect(8,0,6,512); g.fillRect(242,0,6,512);
  g.fillStyle='rgba(255,194,61,.9)'; g.fillRect(125,0,6,220);
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

function ribbon(o0,o1,y,vScale,colorFn){
  const pos=[],uv=[],nor=[],col=[]; const A=new THREE.Vector3(),B=new THREE.Vector3(),C=new THREE.Vector3(),D=new THREE.Vector3();
  for(let i=0;i<N;i++){ const j=(i+1)%N;
    A.copy(P[i]).addScaledVector(NM[i],o0); B.copy(P[i]).addScaledVector(NM[i],o1);
    C.copy(P[j]).addScaledVector(NM[j],o0); D.copy(P[j]).addScaledVector(NM[j],o1);
    const v0=DIST[i]/vScale, v1=(DIST[i]+P[i].distanceTo(P[j]))/vScale;
    for(const [p,u,v] of [[A,0,v0],[C,0,v1],[B,1,v0],[B,1,v0],[C,0,v1],[D,1,v1]]){ pos.push(p.x,y,p.z); uv.push(u,v); nor.push(0,1,0); }
    if(colorFn){ const c=colorFn(i); for(let k=0;k<6;k++) col.push(c.r,c.g,c.b); }
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3));
  if(colorFn) g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
  return g;
}
function vribbon(off,y0,y1){
  const pos=[]; const A=new THREE.Vector3(),B=new THREE.Vector3();
  for(let i=0;i<N;i++){ const j=(i+1)%N; A.copy(P[i]).addScaledVector(NM[i],off); B.copy(P[j]).addScaledVector(NM[j],off);
    pos.push(A.x,y0,A.z, B.x,y0,B.z, A.x,y1,A.z, A.x,y1,A.z, B.x,y0,B.z, B.x,y1,B.z); }
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); g.computeVertexNormals(); return g;
}

const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400,2400).rotateX(-Math.PI/2), new THREE.MeshStandardMaterial({map:groundTex, roughness:.95}));
ground.receiveShadow = true; scene.add(ground);

const runoffMat = new THREE.MeshStandardMaterial({color:0x17142a, roughness:1});
for(const s of [1,-1]){ const m=new THREE.Mesh(ribbon(s*(HALF+CURB), s*WALL, .012, 10), runoffMat); m.receiveShadow=true; m.material.side=THREE.DoubleSide; scene.add(m); }

const road = new THREE.Mesh(ribbon(-HALF, HALF, .02, 32), new THREE.MeshStandardMaterial({map:roadTex, roughness:.82, metalness:.05, side:THREE.DoubleSide}));
road.receiveShadow = true; scene.add(road);

const cRed=new THREE.Color(0xff2e5a), cWhite=new THREE.Color(0xf0f0f6);
const curbMat = new THREE.MeshStandardMaterial({vertexColors:true, roughness:.6, side:THREE.DoubleSide});
for(const [a,b] of [[HALF,HALF+CURB],[-HALF-CURB,-HALF]]){ const m=new THREE.Mesh(ribbon(a,b,.035,1,i=>Math.floor(DIST[i]/3)%2?cRed:cWhite), curbMat); m.receiveShadow=true; scene.add(m); }

const wallMat = new THREE.MeshStandardMaterial({color:0x161929, roughness:.7, side:THREE.DoubleSide});
for(const [s,col] of [[1,0x3ef0ff],[-1,0xff3b6b]]){
  scene.add(new THREE.Mesh(vribbon(s*WALL,0,.95), wallMat));
  const neon = new THREE.Mesh(vribbon(s*(WALL-.02),.78,.95), new THREE.MeshBasicMaterial({color:col, side:THREE.DoubleSide, toneMapped:false}));
  scene.add(neon);
}

/* start gantry */
{ const g=new THREE.Group(); const t=TG[START]; g.position.copy(P[START]); g.rotation.y=Math.atan2(t.x,t.z);
  const chk=checkerTex.clone(); chk.needsUpdate=true;
  const line=new THREE.Mesh(new THREE.PlaneGeometry(ROAD,2.2).rotateX(-Math.PI/2), new THREE.MeshStandardMaterial({map:chk, roughness:.7}));
  line.position.y=.045; line.receiveShadow=true; g.add(line);
  const dark=new THREE.MeshStandardMaterial({color:0x1b1e2e, roughness:.5, metalness:.6});
  for(const s of [1,-1]){ const p=new THREE.Mesh(new THREE.BoxGeometry(.6,7,.6),dark); p.position.set(s*(HALF+2.2),3.5,0); p.castShadow=true; g.add(p); }
  const beam=new THREE.Mesh(new THREE.BoxGeometry(ROAD+5,.9,.7),dark); beam.position.y=7; g.add(beam);
  const strip=new THREE.Mesh(new THREE.BoxGeometry(ROAD+4.6,.22,.74),new THREE.MeshBasicMaterial({color:0xffc23d,toneMapped:false})); strip.position.y=6.75; g.add(strip);
  scene.add(g); }

/* lamps */
{ const idx=[]; for(let i=0;i<N;i+=16) idx.push(i);
  const postG=new THREE.CylinderGeometry(.14,.2,7.5,6).translate(0,3.75,0);
  const headG=new THREE.BoxGeometry(2.4,.22,.6);
  const posts=new THREE.InstancedMesh(postG,new THREE.MeshStandardMaterial({color:0x22253a,metalness:.6,roughness:.4}),idx.length);
  const heads=new THREE.InstancedMesh(headG,new THREE.MeshBasicMaterial({color:0xffd59a,toneMapped:false}),idx.length);
  const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler(), one=new THREE.Vector3(1,1,1), v=new THREE.Vector3();
  const poolMat=new THREE.MeshBasicMaterial({map:glowTex,color:0xffa956,transparent:true,opacity:.28,blending:THREE.AdditiveBlending,depthWrite:false});
  const poolG=new THREE.PlaneGeometry(15,15).rotateX(-Math.PI/2);
  idx.forEach((i,k)=>{ const s=k%2?1:-1; const n=NM[i];
    v.copy(P[i]).addScaledVector(n,s*(WALL+1.3)); const ang=Math.atan2(n.x,n.z);
    e.set(0,ang,0); q.setFromEuler(e); m.compose(v,q,one); posts.setMatrixAt(k,m);
    const hp=v.clone().addScaledVector(n,-s*1.1); hp.y=7.4; m.compose(hp,q,one); heads.setMatrixAt(k,m);
    const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,color:0xffb15a,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:.8}));
    sp.position.copy(hp); sp.scale.set(6,6,1); scene.add(sp);
    const pool=new THREE.Mesh(poolG,poolMat); pool.position.copy(P[i]).addScaledVector(n,s*(WALL-3.5)); pool.position.y=.05; scene.add(pool);
  });
  posts.castShadow=true; scene.add(posts, heads); }

/* city */
{ const cnt=150, g=new THREE.BoxGeometry(1,1,1).translate(0,.5,0);
  const mat=new THREE.MeshStandardMaterial({color:0x0e1020,roughness:.8,emissive:0xffffff,emissiveMap:winTex,emissiveIntensity:.9});
  const city=new THREE.InstancedMesh(g,mat,cnt); const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler();
  let placed=0, tries=0;
  while(placed<cnt && tries<6000){ tries++;
    const x=(Math.random()*600-260)*SC/1.2, z=(Math.random()*560-200)*SC/1.2;
    const w=10+Math.random()*22, d=10+Math.random()*22, h=12+Math.random()*(Math.random()<.2?90:40);
    let ok=true, need=WALL+Math.max(w,d)*.75+5;
    for(let i=0;i<N;i+=3){ const dx=P[i].x-x, dz=P[i].z-z; if(dx*dx+dz*dz<need*need){ok=false;break;} }
    if(!ok) continue;
    e.set(0,Math.random()*Math.PI,0); q.setFromEuler(e); m.compose(new THREE.Vector3(x,0,z),q,new THREE.Vector3(w,h,d)); city.setMatrixAt(placed++,m);
  }
  city.count=placed; city.castShadow=true; city.receiveShadow=true; scene.add(city); }

