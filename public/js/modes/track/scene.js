// Drift track scenery: ground, road, curbs, neon walls, start gantry, lamps, city, and
// (track engine v2) embankments, bridges with pillars. Built from the active map
// (geometry.js) and built again when the map changes.
//
// Every offset line (curb, run-off, wall) is limited on the inside of a turn to 0.9 × the
// local radius (geometry.js safeOffsets) and checked for folds, so on a hairpin tighter
// than the offset the line narrows instead of looping over itself ("broken curbs").
import { scene, cv, tex, glowTex, winTex } from '../../core/render.js';
import { P, NM, TG, DIST, Y, TB, RAD, BRIDGE, MAP, N, ROAD, HALF, CURB, WALL, START, SHORTCUTS, CEIL, LEVELS, safeOffsets, onMapChange } from './geometry.js';
import { buildParking, hazardMat } from './scene-parking.js';

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
// the ground of a forest and a port (maps' decor.theme)
const themeGround = (bg, line) => { const [c,g]=cv(256,256); g.fillStyle=bg; g.fillRect(0,0,256,256);
  g.strokeStyle=line; g.lineWidth=2; g.strokeRect(0,0,256,256); const t=tex(c,true); t.repeat.set(90,90); return t; };
const forestGroundTex = themeGround('#0a130e', 'rgba(90,160,110,.10)'), portGroundTex = themeGround('#101219', 'rgba(140,150,190,.12)');
// White zebra hatching on the outside of an apex (maps with curb: 'zebra'): bars across the
// strip at 45°, a solid line along its outer edge. u: across (0 at the road edge), v: along, one bar per tile.
const zebraTex = (() => {
  const [c,g]=cv(64,64); g.clearRect(0,0,64,64); g.fillStyle='#f4f6ff';
  g.beginPath(); g.moveTo(0,0); g.lineTo(26,0); g.lineTo(64,38); g.lineTo(64,64); g.lineTo(0,0); g.fill();
  g.beginPath(); g.moveTo(0,38); g.lineTo(26,64); g.lineTo(0,64); g.fill();
  g.fillRect(56,0,8,64);
  const t=tex(c,true); t.encoding=THREE.sRGBEncoding; return t;
})();
// A shortcut's asphalt: lighter, white edges, yellow chevrons along it. u across, v along (one tile = 6 m).
const cutTex = (() => {
  const W=128, H=192, [c,g]=cv(W,H); g.fillStyle='#2b2d36'; g.fillRect(0,0,W,H);
  const id=g.getImageData(0,0,W,H); for(let k=0;k<id.data.length;k+=4){const n=(Math.random()-.5)*22; id.data[k]+=n; id.data[k+1]+=n; id.data[k+2]+=n;} g.putImageData(id,0,0);
  g.fillStyle='rgba(235,240,255,.9)'; g.fillRect(6,0,5,H); g.fillRect(W-11,0,5,H);
  g.strokeStyle='rgba(255,194,61,.9)'; g.lineWidth=9; g.lineJoin='miter';
  g.beginPath(); g.moveTo(34,70); g.lineTo(64,40); g.lineTo(94,70); g.stroke();
  g.beginPath(); g.moveTo(34,150); g.lineTo(64,120); g.lineTo(94,150); g.stroke();
  return tex(c,true);
})();
// A car park's floor (maps with levels, under a ceiling): pale concrete, white edge lines,
// a dashed white centre line.
const parkRoadTex = (() => {
  const W=512, H=1024, pxV=H/ROAD_TILE;
  const [c,g]=cv(W,H); g.fillStyle='#3d3f48'; g.fillRect(0,0,W,H);
  const id=g.getImageData(0,0,W,H); for(let k=0;k<id.data.length;k+=4){const n=(Math.random()-.5)*20; id.data[k]+=n; id.data[k+1]+=n; id.data[k+2]+=n;} g.putImageData(id,0,0);
  g.fillStyle='rgba(235,240,255,.85)'; g.fillRect(16,0,6,H); g.fillRect(W-22,0,6,H);
  for(let m=0;m<ROAD_TILE;m+=6) g.fillRect(W/2-3,Math.round(m*pxV),6,Math.round(2.5*pxV));
  return tex(c,true);
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
// maps' curb: 'zebra': a concrete strip instead of the red and white curb, and the hatching;
// the paint glows a little, as it does in the lamps' light
const cConcrete=new THREE.Color(0x4a4d5a);
const zebraMat=new THREE.MeshStandardMaterial({map:zebraTex, transparent:true, alphaTest:.4, roughness:.6, emissive:0x9aa2c0, emissiveMap:zebraTex, emissiveIntensity:.35, side:THREE.DoubleSide, depthWrite:false});
const cutMat=new THREE.MeshStandardMaterial({map:cutTex, roughness:.8, metalness:.05, side:THREE.DoubleSide});
// a car park («Паркинг»): its floors, concrete barriers with the hazard band in place of neon
const parkRoadMat=new THREE.MeshStandardMaterial({map:parkRoadTex, roughness:.85, side:THREE.DoubleSide});
const parkRunoffMat=new THREE.MeshStandardMaterial({color:0x5d606c, roughness:.92, side:THREE.DoubleSide});
const barrierMat=new THREE.MeshStandardMaterial({color:0x585b67, roughness:.85, side:THREE.DoubleSide});
const hazardSide=hazardMat.clone(); hazardSide.side=THREE.DoubleSide;
// forest and port decor
const leafMat=new THREE.MeshStandardMaterial({color:0x123222, roughness:.9, emissive:0x0b2416, emissiveIntensity:.5});
const trunkMat=new THREE.MeshStandardMaterial({color:0x2a1d14, roughness:1});
const boxMat=new THREE.MeshStandardMaterial({roughness:.7, metalness:.3});
const craneMat=new THREE.MeshStandardMaterial({color:0x3a2a12, roughness:.6, metalness:.5, emissive:0xffa020, emissiveIntensity:.12});
const THEMES = {
  city: { ground: groundTex, runoff: 0x17142a },
  forest: { ground: forestGroundTex, runoff: 0x13241a },
  port: { ground: portGroundTex, runoff: 0x1a1c25 },
  parking: { ground: groundTex, runoff: 0x2a2c35 },
};
// An open strip along a shortcut (geometry.js SHORTCUTS: x, z, y, nx, nz, d per sample)
// from offset o0 to o1, yOff above its road; skip(k): leave out the piece from sample k to k+1.
function cutRibbon(sc, o0, o1, yOff, vScale, skip, colorFn){
  const pos=[], uv=[], nor=[], col=[];
  for(let k=0;k<sc.n-1;k++){ if(skip && skip(k)) continue; const j=k+1;
    const pt=(i,o)=>[sc.x[i]+sc.nx[i]*o, sc.y[i]+yOff, sc.z[i]+sc.nz[i]*o];
    const A=pt(k,o0), B=pt(k,o1), C=pt(j,o0), D=pt(j,o1), v0=sc.d[k]/vScale, v1=sc.d[j]/vScale;
    for(const [p,u,v] of [[A,0,v0],[C,0,v1],[B,1,v0],[B,1,v0],[C,0,v1],[D,1,v1]]){ pos.push(p[0],p[1],p[2]); uv.push(u,v); nor.push(0,1,0); }
    if(colorFn){ const c=colorFn(k); for(let q=0;q<6;q++) col.push(c.r,c.g,c.b); }
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
  g.setAttribute('normal',new THREE.Float32BufferAttribute(nor,3)); if(colorFn) g.setAttribute('color',new THREE.Float32BufferAttribute(col,3));
  return g;
}
function cutWall(sc, o, y0, y1, skip){
  const pos=[];
  for(let k=0;k<sc.n-1;k++){ if(skip && skip(k)) continue; const j=k+1;
    const ax=sc.x[k]+sc.nx[k]*o, az=sc.z[k]+sc.nz[k]*o, bx=sc.x[j]+sc.nx[j]*o, bz=sc.z[j]+sc.nz[j]*o, ya=sc.y[k], yb=sc.y[j];
    pos.push(ax,ya+y0,az, bx,yb+y0,bz, ax,ya+y1,az, ax,ya+y1,az, bx,yb+y0,bz, bx,yb+y1,bz); }
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3)); g.computeVertexNormals(); return g;
}
// whether (x, z) is inside some shortcut's walls (plus `m` m): the main road's walls open there
function inCut(x, z, m=0){
  for(const sc of SHORTCUTS){ const b=sc.box; if(x<b[0]-m || x>b[1]+m || z<b[2]-m || z>b[3]+m) continue;
    let k=0, bd=1e18; for(let i=0;i<sc.n;i++){ const dx=x-sc.x[i], dz=z-sc.z[i], d=dx*dx+dz*dz; if(d<bd){bd=d;k=i;} }
    const rx=x-sc.x[k], rz=z-sc.z[k], along=rx*sc.tx[k]+rz*sc.tz[k];
    if((k===0 && along<0) || (k===sc.n-1 && along>0)) continue;
    if(Math.abs(rx*sc.nx[k]+rz*sc.nz[k])<=sc.wall+m) return true; }
  return false;
}
// how far (x, z) is from the main road's centre line (the nearest of every second point)
function mainDist(x, z){ let bd=1e18; for(let i=0;i<N;i+=2){ const dx=P[i].x-x, dz=P[i].z-z, d=dx*dx+dz*dz; if(d<bd) bd=d; } return Math.sqrt(bd); }

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

  const theme = THEMES[(MAP.decor && MAP.decor.theme) || 'city'] || THEMES.city;
  if(groundMat.map!==theme.ground){ groundMat.map=theme.ground; groundMat.needsUpdate=true; }
  runoffMat.color.setHex(theme.runoff);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400,2400).rotateX(-Math.PI/2), groundMat);
  if(!flatMap) ground.position.set(cx,-.02,cz);   // («Ночной город» keeps its ground where it always was)
  ground.receiveShadow = true; B.add(ground);

  // (a car park: concrete off the street, on its floors, ramps and roof)
  const deckRoad = i => LEVELS && (CEIL[i]<8 || Y[i]>.3) && (CEIL[(i+1)%N]<8 || Y[(i+1)%N]>.3);
  for(const s of [1,-1]){ const m=new THREE.Mesh(ribbon(s*(HALF+CURB), s*WALL, .012, 10, null, LEVELS ? deckRoad : undefined), runoffMat); m.receiveShadow=true; B.add(m);
    if(LEVELS){ const c=new THREE.Mesh(ribbon(s*(HALF+CURB), s*WALL, .012, 10, null, i=>!deckRoad(i)), parkRunoffMat); c.receiveShadow=true; B.add(c); } }
  // (a car park: its own floor under the ceilings, asphalt in the open)
  const under = i => CEIL[i] < 8 && CEIL[(i+1)%N] < 8;
  const road = new THREE.Mesh(ribbon(-HALF, HALF, .02, ROAD_TILE, null, LEVELS ? under : undefined), roadMat);
  road.receiveShadow = true; B.add(road);
  if(LEVELS){ const r = new THREE.Mesh(ribbon(-HALF, HALF, .02, ROAD_TILE, null, i => !under(i)), parkRoadMat); r.receiveShadow = true; B.add(r); }
  const zebra = MAP.curb==='zebra';
  for(const [a,b] of [[HALF,HALF+CURB],[-HALF-CURB,-HALF]]){ const m=new THREE.Mesh(ribbon(a,b,.035,1,zebra?()=>cConcrete:i=>Math.floor(DIST[i]/3)%2?cRed:cWhite), curbMat); m.receiveShadow=true; B.add(m); }
  if(zebra){
    // the hatching's width: up to 3.2 m on the outside of turns under ~110 m radius, widest
    // at the tightest (a running maximum over ±12 points, then smoothed over ±6)
    const f=new Float64Array(N), w=new Float64Array(N), sm=new Float64Array(N);
    for(let i=0;i<N;i++) f[i]=Math.max(0,Math.min(1,(1/Math.abs(RAD[i])-1/110)/(1/35-1/110)))*Math.sign(RAD[i]);
    for(let i=0;i<N;i++){ let v=0; for(let k=-12;k<=12;k++){ const q=f[(i+k+N)%N]; if(Math.abs(q)>Math.abs(v)) v=q; } w[i]=v; }
    for(let i=0;i<N;i++){ let a=0; for(let k=-6;k<=6;k++) a+=w[(i+k+N)%N]; sm[i]=a/13; }
    for(const s of [1,-1]){
      const on=i=>sm[i]*s>.08, O0=new Float64Array(N), O1=new Float64Array(N);
      for(let i=0;i<N;i++){ O0[i]=s*(HALF-.12); O1[i]=s*(HALF+(on(i)?.6+2.6*Math.abs(sm[i]):.6)); }
      const m=new THREE.Mesh(ribbon(O0,O1,.04,2.2,null,i=>!on(i)||!on((i+1)%N)||(SHORTCUTS.length&&inCut(P[i].x+NM[i].x*O1[i],P[i].z+NM[i].z*O1[i]))), zebraMat);
      m.renderOrder=1; B.add(m); }
  }
  for(const s of [1,-1]){
    // the neon strip 2 cm inside the wall, also where a hairpin pulls the wall in; open
    // where a shortcut passes through
    const O=safeOffsets(s*WALL), In=O.map(o=>o-Math.sign(o)*.02);
    const gap=SHORTCUTS.length ? (()=>{ const g=new Uint8Array(N); for(let i=0;i<N;i++) g[i]=inCut(P[i].x+NM[i].x*O[i], P[i].z+NM[i].z*O[i], .3)?1:0; return i=>g[i]||g[(i+1)%N]; })() : null;
    B.add(new THREE.Mesh(vribbon(O,0,.95,gap), LEVELS ? barrierMat : wallMat));
    B.add(new THREE.Mesh(vribbon(In,LEVELS?.62:.78,.95,gap), LEVELS ? hazardSide : neonMat[s]));
  }
  // shortcuts: asphalt (where it is off the main road's asphalt and curbs), small red and
  // white curbs, run-off, walls with neon (where outside the main road's walls)
  for(const sc of SHORTCUTS){
    const dm=Float64Array.from({length:sc.n},(_,k)=>mainDist(sc.x[k],sc.z[k]));
    const onMain=(k,r)=>dm[k]<r||dm[k+1]<r;
    B.add(new THREE.Mesh(cutRibbon(sc,-sc.wall,sc.wall,.01,10,k=>onMain(k,WALL-.5)), runoffMat));
    // (its asphalt runs on over the main road's curb up to the edge of its asphalt, a little
    // above the curb, so the mouth is one clean surface)
    const road=new THREE.Mesh(cutRibbon(sc,-sc.half,sc.half,.04,6,k=>dm[k]<HALF-.3&&dm[k+1]<HALF-.3), cutMat); road.receiveShadow=true; B.add(road);
    for(const [a,b] of [[sc.half,sc.half+.5],[-sc.half-.5,-sc.half]]) B.add(new THREE.Mesh(cutRibbon(sc,a,b,.035,1,k=>onMain(k,HALF+CURB),k=>Math.floor(sc.d[k]/1.5)%2?cRed:cWhite), curbMat));
    for(const s of [1,-1]){ const skip=k=>onMain(k,WALL);
      B.add(new THREE.Mesh(cutWall(sc,s*sc.wall,0,.95,skip), wallMat));
      B.add(new THREE.Mesh(cutWall(sc,s*(sc.wall-.02),.78,.95,skip), neonMat[s])); }
  }

  // Raised road: an embankment (sides down to the ground) where it is not a bridge; a
  // bridge is a deck 1.1 m thick on pillars, with a lit arch at each end.
  // (a car park: slabs, decks and columns instead, scene-parking.js)
  if(MAP.building) buildParking(B, { ribbon, vribbon });
  if(!flatMap && !MAP.building){
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
      if(SHORTCUTS.length && inCut(v.x,v.z,2)) continue;
      // a car park: none under a ceiling, none standing over a road below (the towers)
      if(LEVELS && (CEIL[i]<1e9 || roadsNear(v.x,v.z,WALL+1.5).some(j=>Y[j]<base-1))) continue;
      // nor in the street right against the car park's front (taller than its first floor)
      if(MAP.building){ const bd=MAP.building, m=6; if(base<1 && v.x>bd.x0-m && v.x<bd.x1+m && v.z>bd.z0-m && v.z<bd.z1+m) continue; }
      // nor on or beside a bridge (its deck; the arches light it), where the post would graze the deck
      if(BRIDGE[i] || roadsNear(v.x,v.z,WALL+4).some(j=>BRIDGE[j] && Y[j]>base+1)) continue;
      spots.push([i,s,v,base]); }
    const postG=new THREE.CylinderGeometry(.14,.2,1,6).translate(0,.5,0);
    const headG=new THREE.BoxGeometry(2.4,.22,.6);
    const posts=new THREE.InstancedMesh(postG,postMat,spots.length), heads=new THREE.InstancedMesh(headG,headMat,spots.length);
    const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler(), one=new THREE.Vector3(1,1,1);
    const poolG=new THREE.PlaneGeometry(15,15).rotateX(-Math.PI/2);
    spots.forEach(([i,s,v,base],k)=>{ const n=NM[i];
      const ang=Math.atan2(n.x,n.z); e.set(0,ang,0); q.setFromEuler(e);
      const bd=MAP.building, onRoof=bd && v.x>bd.x0 && v.x<bd.x1 && v.z>bd.z0 && v.z<bd.z1;
      const bot=flatMap?0:onRoof?base:Math.min(0,base); v.y=bot; m.compose(v,q,new THREE.Vector3(1,7.5+base-bot,1)); posts.setMatrixAt(k,m);
      const hp=v.clone().addScaledVector(n,-s*1.1); hp.y=base+7.4; m.compose(hp,q,one); heads.setMatrixAt(k,m);
      const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,color:0xffb15a,blending:THREE.AdditiveBlending,depthWrite:false,transparent:true,opacity:.8}));
      sp.position.copy(hp); sp.scale.set(6,6,1); B.add(sp);
      const po=s*(WALL-3.5), pool=new THREE.Mesh(poolG,poolMat); pool.position.copy(P[i]).addScaledVector(n,po); pool.position.y=Y[i]+po*TB[i]+.05; B.add(pool);
    });
    posts.castShadow=true; B.add(posts, heads); }

  // nothing of the scenery stands on a road or a shortcut: (x, z) at least `r` m clear of their walls
  const clear=(x,z,r)=>{ const need=WALL+r; for(let i=0;i<N;i+=3){ const dx=P[i].x-x, dz=P[i].z-z; if(dx*dx+dz*dz<need*need) return false; }
    for(const sc of SHORTCUTS) for(let k=0;k<sc.n;k+=2){ const dx=sc.x[k]-x, dz=sc.z[k]-z, nd=sc.wall+r; if(dx*dx+dz*dz<nd*nd) return false; }
    return true; };
  const decor=MAP.decor||{}, themeId=decor.theme||'city';
  /* forest: dark cones on trunks round the track and in its infields */
  if(themeId==='forest'){
    const cnt=decor.trees||220, cone=new THREE.ConeGeometry(1,1,7).translate(0,.5,0), stem=new THREE.CylinderGeometry(.18,.25,1,5).translate(0,.5,0);
    const leaves=new THREE.InstancedMesh(cone,leafMat,cnt), trunks=new THREE.InstancedMesh(stem,trunkMat,cnt);
    const m=new THREE.Matrix4(), q=new THREE.Quaternion(), one=new THREE.Vector3();
    let placed=0, tries=0;
    while(placed<cnt && tries<8000){ tries++;
      const x=minX-90+Math.random()*(maxX-minX+180), z=minZ-90+Math.random()*(maxZ-minZ+180);
      const h=7+Math.random()*9, r=h*(.28+Math.random()*.08);
      if(!clear(x,z,r+2)) continue;
      m.compose(new THREE.Vector3(x,1.6,z),q,one.set(r,h,r)); leaves.setMatrixAt(placed,m);
      m.compose(new THREE.Vector3(x,0,z),q,one.set(1,1.8,1)); trunks.setMatrixAt(placed,m); placed++; }
    leaves.count=trunks.count=placed; leaves.castShadow=true; B.add(leaves, trunks);
  }
  /* port: stacks of shipping containers and a few cranes */
  if(themeId==='port'){
    const cnt=decor.containers||140, g=new THREE.BoxGeometry(12.2,2.6,2.45).translate(0,1.3,0), box=new THREE.InstancedMesh(g,boxMat,cnt);
    const cols=[0x8c2b2b,0x2b4f8c,0x2f6b3d,0x8c6a2b,0x5b5f6b,0x6b2b5f].map(c=>new THREE.Color(c));
    const m=new THREE.Matrix4(), q=new THREE.Quaternion(), e=new THREE.Euler(), one=new THREE.Vector3(1,1,1);
    let placed=0, tries=0;
    while(placed<cnt && tries<4000){ tries++;
      const x=minX-110+Math.random()*(maxX-minX+220), z=minZ-110+Math.random()*(maxZ-minZ+220), a=Math.random()<.5?0:Math.PI/2;
      if(!clear(x,z,9)) continue;
      const rows=1+Math.floor(Math.random()*3), side=1+Math.floor(Math.random()*3);
      e.set(0,a,0); q.setFromEuler(e);
      // side by side across their long sides, `rows` high
      for(let s=0;s<side && placed<cnt;s++) for(let r=0;r<rows && placed<cnt;r++){
        const off=(s-1)*2.5; m.compose(new THREE.Vector3(x+(a?off:0), r*2.6, z+(a?0:off)),q,one); box.setMatrixAt(placed,m); box.setColorAt(placed,cols[Math.floor(Math.random()*cols.length)]); placed++; } }
    box.count=placed; box.castShadow=true; box.receiveShadow=true; if(box.instanceColor) box.instanceColor.needsUpdate=true; B.add(box);
    for(let k=0,tries2=0;k<(decor.cranes||3) && tries2<400;tries2++){
      const x=minX-60+Math.random()*(maxX-minX+120), z=minZ-60+Math.random()*(maxZ-minZ+120);
      if(!clear(x,z,22)) continue; k++;
      const c=new THREE.Group(); c.position.set(x,0,z); c.rotation.y=Math.random()*Math.PI;
      for(const sx of [-6,6]) for(const sz of [-5,5]){ const leg=new THREE.Mesh(new THREE.BoxGeometry(.9,30,.9),craneMat); leg.position.set(sx,15,sz); c.add(leg); }
      const beam=new THREE.Mesh(new THREE.BoxGeometry(14,2,12),craneMat); beam.position.y=30; c.add(beam);
      const boom=new THREE.Mesh(new THREE.BoxGeometry(2,1.6,52),craneMat); boom.position.set(0,31,8); c.add(boom);
      B.add(c); }
  }
  /* city */
  if(themeId==='city' || decor.city){ const cnt=decor.city||150, g=new THREE.BoxGeometry(1,1,1).translate(0,.5,0);
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
      if(!ok || (SHORTCUTS.length && !clear(x,z,Math.max(w,d)*.75+5))) continue;
      // (a car park: clear of the building and its towers, so it stands free in the city)
      { const bd=MAP.building, r=Math.max(w,d)*.75+16; if(bd && ((x>bd.x0-r && x<bd.x1+r && z>bd.z0-r && z<bd.z1+r) || bd.towers.some(t=>Math.hypot(x-t.x,z-t.z)<t.r+WALL+r))) continue; }
      e.set(0,Math.random()*Math.PI,0); q.setFromEuler(e); m.compose(new THREE.Vector3(x,0,z),q,new THREE.Vector3(w,h,d)); city.setMatrixAt(placed++,m);
    }
    city.count=placed; city.castShadow=true; city.receiveShadow=true; B.add(city); }
}
build();
onMapChange(build);
