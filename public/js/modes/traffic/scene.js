// Highway scenery, built from 200 m chunks that are moved forward as the car drives.
//
// Each chunk is a group whose children use local coordinates (z from 0 to 200), and
// only the group's position holds the big world number. three.js multiplies the
// matrices in 64-bit JavaScript before handing them to the GPU, so road, rails and
// lamps stay steady even tens of kilometres from the start.
import { scene, cv, tex, glowTex, winTex } from '../../core/render.js';
import { HALF, RAIL, SHOULDER, CHUNK, AHEAD, BEHIND, chunkRange } from './geometry.js';

export const group = new THREE.Group();
group.visible = false;
scene.add(group);

const GROUND = 1600, TILE = GROUND/60;   // ground plane size and one grid tile (m)

/* textures */
// 16 px per metre across: 4 lanes of 4 m. Along the road one tile is 25 m: two dashes
// of 4.5 m every 12.5 m, so a 200 m chunk holds exactly 8 tiles and dashes line up
// across chunk joints.
const roadTex = (() => {
  const [c,g]=cv(256,400); g.fillStyle='#24262f'; g.fillRect(0,0,256,400);
  const id=g.getImageData(0,0,256,400); for(let k=0;k<id.data.length;k+=4){ const n=(Math.random()-.5)*26; id.data[k]+=n; id.data[k+1]+=n; id.data[k+2]+=n; } g.putImageData(id,0,0);
  g.fillStyle='rgba(235,240,255,.85)'; g.fillRect(4,0,5,400); g.fillRect(247,0,5,400);      // edge lines
  g.fillStyle='rgba(235,240,255,.7)';
  for(const x of [64,128,192]) for(const y of [0,200]) g.fillRect(x-2,y,4,72);            // lane dashes
  const t=tex(c,true); t.repeat.set(1,CHUNK/25); return t;
})();
const groundTex = (() => {
  const [c,g]=cv(256,256); g.fillStyle='#0c0d18'; g.fillRect(0,0,256,256);
  g.strokeStyle='rgba(120,90,255,.20)'; g.lineWidth=2; g.strokeRect(0,0,256,256);
  g.strokeStyle='rgba(120,90,255,.07)'; g.lineWidth=1; g.beginPath(); g.moveTo(128,0); g.lineTo(128,256); g.moveTo(0,128); g.lineTo(256,128); g.stroke();
  const t=tex(c,true); t.repeat.set(GROUND/TILE,GROUND/TILE); return t;
})();
const checkerTex = (() => {
  const [c,g]=cv(256,32); for(let x=0;x<16;x++) for(let y=0;y<2;y++){ g.fillStyle=(x+y)%2?'#111':'#f2f2f2'; g.fillRect(x*16,y*16,16,16);} return tex(c,false);
})();

/* ground: one big plane that follows the car in whole tiles, so its grid never slides */
export const ground = new THREE.Mesh(new THREE.PlaneGeometry(GROUND,GROUND).rotateX(-Math.PI/2), new THREE.MeshStandardMaterial({map:groundTex, roughness:.95}));
ground.receiveShadow = true; group.add(ground);
export function followGround(x,z){ ground.position.set(Math.round(x/TILE)*TILE, 0, Math.round(z/TILE)*TILE); }

/* shared geometry and materials */
const roadMat=new THREE.MeshStandardMaterial({map:roadTex, roughness:.82, metalness:.05});
const shoulderMat=new THREE.MeshStandardMaterial({color:0x17142a, roughness:1});
const wallMat=new THREE.MeshStandardMaterial({color:0x161929, roughness:.7});
const neonL=new THREE.MeshBasicMaterial({color:0x3ef0ff, toneMapped:false});   // left rail (+X): cyan
const neonR=new THREE.MeshBasicMaterial({color:0xff3b6b, toneMapped:false});   // right rail (-X): rose
const roadG=new THREE.PlaneGeometry(2*HALF,CHUNK).rotateX(-Math.PI/2).translate(0,.04,CHUNK/2);
const shoulderG=new THREE.PlaneGeometry(SHOULDER+.3,CHUNK).rotateX(-Math.PI/2).translate(0,.03,CHUNK/2);
const railG=new THREE.BoxGeometry(.3,.95,CHUNK).translate(0,.475,CHUNK/2);
const stripG=new THREE.BoxGeometry(.05,.17,CHUNK).translate(0,.865,CHUNK/2);
const capG=new THREE.BoxGeometry(.34,.05,CHUNK).translate(0,.975,CHUNK/2);   // neon on top: what the top-down camera sees
const postG=new THREE.CylinderGeometry(.14,.2,7.5,6).translate(0,3.75,0);
const headG=new THREE.BoxGeometry(.6,.22,2.4);
const postMat=new THREE.MeshStandardMaterial({color:0x22253a,metalness:.6,roughness:.4});
const headMat=new THREE.MeshBasicMaterial({color:0xffd59a,toneMapped:false});
const poolMat=new THREE.MeshBasicMaterial({map:glowTex,color:0xffa956,transparent:true,opacity:.28,blending:THREE.AdditiveBlending,depthWrite:false});
const poolG=new THREE.PlaneGeometry(15,15).rotateX(-Math.PI/2);
const glowMat=new THREE.SpriteMaterial({map:glowTex,color:0xffb15a,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:.8});
const boxG=new THREE.BoxGeometry(1,1,1).translate(0,.5,0);
const cityMat=new THREE.MeshStandardMaterial({color:0x0e1020,roughness:.8,emissive:0xffffff,emissiveMap:winTex,emissiveIntensity:.9});

const LAMP_STEP=40, BUILDINGS=16;
// Buildings come from a seeded generator keyed by the chunk index, so the same stretch
// of highway always has the same skyline (and will look the same to every online player).
function rng(seed){ let s=(seed*2654435761)>>>0||1; return ()=>((s=(s*1664525+1013904223)>>>0)/4294967296); }

function makeChunk(){
  const g=new THREE.Group(); g.userData.index=null;
  const road=new THREE.Mesh(roadG,roadMat); road.receiveShadow=true; g.add(road);
  for(const s of [-1,1]){
    const sh=new THREE.Mesh(shoulderG,shoulderMat); sh.position.x=s*(HALF+SHOULDER/2+.15); sh.receiveShadow=true; g.add(sh);
    const rail=new THREE.Mesh(railG,wallMat); rail.position.x=s*(RAIL+.15); rail.castShadow=true; g.add(rail);
    const strip=new THREE.Mesh(stripG,s>0?neonL:neonR); strip.position.x=s*(RAIL-.02); g.add(strip);
    const cap=new THREE.Mesh(capG,s>0?neonL:neonR); cap.position.x=s*(RAIL+.15); g.add(cap);
  }
  // lamps every 40 m, alternating sides; the side is set when the chunk is placed
  g.userData.lamps=[];
  for(let z=LAMP_STEP/2; z<CHUNK; z+=LAMP_STEP){
    const post=new THREE.Mesh(postG,postMat); post.castShadow=true;
    const head=new THREE.Mesh(headG,headMat);
    const glow=new THREE.Sprite(glowMat); glow.scale.set(6,6,1);
    const pool=new THREE.Mesh(poolG,poolMat);
    g.add(post,head,glow,pool); g.userData.lamps.push({z,post,head,glow,pool});
  }
  const city=new THREE.InstancedMesh(boxG,cityMat,BUILDINGS); city.castShadow=true; city.receiveShadow=true;
  g.add(city); g.userData.city=city;
  group.add(g); return g;
}
const m4=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler(), v=new THREE.Vector3(), sc=new THREE.Vector3();
function placeChunk(g,index){
  g.userData.index=index; g.position.z=index*CHUNK;
  g.userData.lamps.forEach((L,k)=>{
    const s=((index*5+k)&1)?1:-1;
    L.post.position.set(s*(RAIL+1.3),0,L.z);
    L.head.position.set(s*(RAIL+.2),7.4,L.z);
    L.glow.position.set(s*(RAIL+.2),7.4,L.z);
    L.pool.position.set(s*(RAIL-3.5),.05,L.z);
  });
  const r=rng(index+7919), city=g.userData.city;
  for(let i=0;i<BUILDINGS;i++){
    const s=i&1?1:-1, w=10+r()*22, d=10+r()*22, h=12+r()*(r()<.2?90:40);
    v.set(s*(RAIL+12+w/2+r()*40), 0, r()*CHUNK); e.set(0,r()*Math.PI,0); q.setFromEuler(e); sc.set(w,h,d);
    m4.compose(v,q,sc); city.setMatrixAt(i,m4);
  }
  city.instanceMatrix.needsUpdate=true;
}
const chunks=[]; for(let i=0;i<AHEAD+BEHIND+1;i++) chunks.push(makeChunk());

// Keeps the chunks around z: any chunk outside the needed range takes a missing index.
export function updateChunks(z){
  const {from,to}=chunkRange(z);
  const kept=new Set(), free=[];
  for(const c of chunks){ const i=c.userData.index;
    if(i!==null && i>=from && i<=to && !kept.has(i)) kept.add(i); else free.push(c); }
  for(let i=from;i<=to;i++) if(!kept.has(i)) placeChunk(free.shift(),i);
}

/* start line at z = 0 */
{ const g=new THREE.Group();
  const line=new THREE.Mesh(new THREE.PlaneGeometry(2*HALF,2.2).rotateX(-Math.PI/2), new THREE.MeshStandardMaterial({map:checkerTex, roughness:.7}));
  line.position.set(0,.045,8); line.receiveShadow=true; g.add(line);
  const dark=new THREE.MeshStandardMaterial({color:0x1b1e2e, roughness:.5, metalness:.6});
  for(const s of [1,-1]){ const p=new THREE.Mesh(new THREE.BoxGeometry(.6,7,.6),dark); p.position.set(s*(RAIL+1.2),3.5,8); p.castShadow=true; g.add(p); }
  const beam=new THREE.Mesh(new THREE.BoxGeometry(2*RAIL+3,.9,.7),dark); beam.position.set(0,7,8); g.add(beam);
  const strip=new THREE.Mesh(new THREE.BoxGeometry(2*RAIL+2.6,.22,.74),new THREE.MeshBasicMaterial({color:0xffc23d,toneMapped:false})); strip.position.set(0,6.75,8); g.add(strip);
  group.add(g); }
