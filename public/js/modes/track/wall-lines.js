// Plan 3, stage 0: the track's walls as lines. One source for what is drawn (scene.js takes
// its offset lines, the shortcuts' gaps, the strips' heights and the walls from here) and
// what is checked: the ?debug=hit overlay (core/hitdebug.js) and the map scan
// (tests/tools/map-scan.mjs). Pure (no DOM, no rendering): Node runs it.
//
// Two kinds of wall, which today are not the same line:
// - drawn: drawnWalls(), the lines scene.js puts the wall meshes on.
// - collision: where constrainToTrack really stops the car. Not computed from the rules
//   but measured: a still car is put at a point and constrainToTrack is run once; if it
//   moved the car, the point is outside. Along a ray (out from the centre line, or from a
//   shortcut's centre line) the first such point is the limit for the car's centre; the
//   car's body (its allowance, WALL_ALLOW) reaches that much further, measured along the
//   wall's normal there (the direction the car was pushed back).
import { P, NM, TG, Y, TB, N, WALL, SHORTCUTS, SAME_LEVEL, safeOffsets, constrainToTrack } from './geometry.js';
import { WALL_ALLOW } from '../../core/contact.js';
import { HITLOG } from '../../core/hitlog.js';

export const ALLOW = WALL_ALLOW;        // m: how close the car's centre may come to a wall
// Heights above the road of the flat strips scene.js draws (m) and of the ground plane on a
// map with heights (on a flat map the ground is at 0)
export const STRIP_Y = { road: .02, curb: .035, runoff: .012, zebra: .04, cutRunoff: .01, cutRoad: .04, cutCurb: .035 };
export const GROUND_Y = -.02;

// An offset line along the track: offset off (m, > 0 left, or per-point array) of every track point,
// on the banked road plus yOff; a point that would step back along the track is pulled
// onto the previous one
export function offsetLine(off, yOff){
  const O=typeof off==='number'?safeOffsets(off):off, x=new Float64Array(N), y=new Float64Array(N), z=new Float64Array(N);
  for(let i=0;i<N;i++){ const o=O[i]; x[i]=P[i].x+NM[i].x*o; z[i]=P[i].z+NM[i].z*o; y[i]=Y[i]+o*TB[i]+yOff; }
  for(let pass=0;pass<2;pass++) for(let i=0;i<N;i++){ const j=(i+1)%N, t=TG[i];
    if((x[j]-x[i])*t.x+(z[j]-z[i])*t.z<0){ x[j]=x[i]; z[j]=z[i]; } }
  return {x,y,z};
}
// whether (x, z) is inside some shortcut's walls (plus m): the main road's walls open there
export function inCut(x, z, m=0){
  for(const sc of SHORTCUTS){ const b=sc.box; if(x<b[0]-m || x>b[1]+m || z<b[2]-m || z>b[3]+m) continue;
    let k=0, bd=1e18; for(let i=0;i<sc.n;i++){ const dx=x-sc.x[i], dz=z-sc.z[i], d=dx*dx+dz*dz; if(d<bd){bd=d;k=i;} }
    const rx=x-sc.x[k], rz=z-sc.z[k], along=rx*sc.tx[k]+rz*sc.tz[k];
    if((k===0 && along<0) || (k===sc.n-1 && along>0)) continue;
    if(Math.abs(rx*sc.nx[k]+rz*sc.nz[k])<=sc.wall+m) return true; }
  return false;
}
// how far (x, z) is from the main road's centre line
export function mainDist(x, z){ let bd=1e18; for(let i=0;i<N;i+=2){ const dx=P[i].x-x, dz=P[i].z-z, d=dx*dx+dz*dz; if(d<bd) bd=d; } return Math.sqrt(bd); }

// The walls of the active map as drawn (scene.js builds its wall meshes from this):
// main: per side s (1 left, -1 right): the offset per track point (O: safeOffsets(±WALL)),
//   the line x, y, z, on[i]: the piece i → i+1 is drawn (not where a shortcut passes through)
// cuts: per shortcut and side: x, y, z per sample, on[k]: the piece k → k+1 is drawn
export function drawnWalls(){
  const main=[], cuts=[];
  for(const s of [1,-1]){
    const O=safeOffsets(s*WALL), L=offsetLine(O,0), on=new Uint8Array(N);
    const g=new Uint8Array(N); if(SHORTCUTS.length) for(let i=0;i<N;i++) g[i]=inCut(P[i].x+NM[i].x*O[i], P[i].z+NM[i].z*O[i], .3)?1:0;
    for(let i=0;i<N;i++) on[i]=g[i]||g[(i+1)%N]?0:1;
    main.push({ s, O, ...L, on });
  }
  for(const sc of SHORTCUTS){
    const dm=Float64Array.from({length:sc.n},(_,k)=>mainDist(sc.x[k],sc.z[k]));
    for(const s of [1,-1]){ const o=s*sc.wall, x=new Float64Array(sc.n), y=new Float64Array(sc.n), z=new Float64Array(sc.n), on=new Uint8Array(sc.n);
      for(let k=0;k<sc.n;k++){ x[k]=sc.x[k]+sc.nx[k]*o; z[k]=sc.z[k]+sc.nz[k]*o; y[k]=sc.y[k]; }
      for(let k=0;k<sc.n-1;k++) on[k]=(dm[k]<WALL||dm[k+1]<WALL)?0:1;
      cuts.push({ sc, s, x, y, z, on }); }
  }
  return { main, cuts };
}

// --- the collision walls, measured ---
const HOOKS = { onWall(){}, onLap(){}, onLand(){}, onTakeoff(){} };
const probe = {};
const PUSH = { x: 0, z: 0 };
// whether constrainToTrack moves a still car at (x, z) (car.idx idx, on shortcut cut or -1);
// PUSH: where it moved it. (Not a contact of a real car: nothing goes to HITLOG.)
function pushed(x, z, y, idx, cut){
  const c=probe, log=HITLOG.on;
  c.x=x; c.z=z; c.y=y; c.idx=idx; c.cut=cut; c.h=0; c.hPrev=0; c.vx=c.vz=c.vF=c.vR=c.vy=0; c.steer=0; c.spinV=0;
  c.air=false; c.yawRate=0; c.prog=0; c.gate=0; c.off=false; c.squash=0;
  HITLOG.on=false;
  try { constrainToTrack(c, 1/120, HOOKS); } finally { HITLOG.on=log; }
  PUSH.x=c.x-x; PUSH.z=c.z-z;
  return Math.abs(PUSH.x)>1e-9 || Math.abs(PUSH.z)>1e-9;
}
// The first point along a ray from (ox, oz) in direction (dx, dz) where the centre of a
// car is pushed back (m from the origin, ~2 mm), or NaN if none within max m; and the cosine
// between the ray and the wall's normal there (the push, just past the limit). bank: the
// road's height change per m along the ray.
const LIM = { c: NaN, cos: 1 };
function limitAlong(ox, oz, oy, bank, dx, dz, idx, cut, max){
  const at=o=>pushed(ox+dx*o, oz+dz*o, oy+bank*o, idx, cut);
  let prev=0; LIM.c=NaN; LIM.cos=1;
  for(let o=.5;o<=max+1e-9;o+=.5){
    if(at(o)){ let a=prev, b=o; for(let k=0;k<8;k++){ const m=(a+b)/2; if(at(m)) b=m; else a=m; }
      at(b+.01); const l=Math.hypot(PUSH.x, PUSH.z);
      LIM.c=b; LIM.cos=l>0 ? Math.abs(PUSH.x*dx+PUSH.z*dz)/l : 1; return LIM; }
    prev=o;
  }
  return LIM;
}
// Drawn wall pieces in an 8 m grid, for the ray tests
function wallGrid(D){
  const cell=8, grid=new Map(), segs=[];
  const add=(ax,az,bx,bz,y)=>{ const id=segs.length; segs.push([ax,az,bx,bz,y]);
    const x0=Math.floor(Math.min(ax,bx)/cell), x1=Math.floor(Math.max(ax,bx)/cell), z0=Math.floor(Math.min(az,bz)/cell), z1=Math.floor(Math.max(az,bz)/cell);
    for(let gx=x0;gx<=x1;gx++) for(let gz=z0;gz<=z1;gz++){ const k=gx+','+gz; if(!grid.has(k)) grid.set(k,[]); grid.get(k).push(id); } };
  for(const W of D.main) for(let i=0;i<N;i++) if(W.on[i]){ const j=(i+1)%N; add(W.x[i],W.z[i],W.x[j],W.z[j],(W.y[i]+W.y[j])/2); }
  for(const W of D.cuts) for(let k=0;k<W.x.length-1;k++) if(W.on[k]) add(W.x[k],W.z[k],W.x[k+1],W.z[k+1],(W.y[k]+W.y[k+1])/2);
  // the nearest drawn wall along a ray (m), at about the ray's height (bank: per m), or NaN
  return (ox, oz, oy, bank, dx, dz, max) => {
    const seen=new Set(); let best=NaN;
    for(let o=0;o<=max+cell;o+=cell/2){ const gx=Math.floor((ox+dx*o)/cell), gz=Math.floor((oz+dz*o)/cell);
      for(let ax=-1;ax<=1;ax++) for(let az=-1;az<=1;az++){ const l=grid.get((gx+ax)+','+(gz+az)); if(!l) continue;
        for(const id of l){ if(seen.has(id)) continue; seen.add(id);
          const [x1,z1,x2,z2,y]=segs[id], ex=x2-x1, ez=z2-z1, den=dx*ez-dz*ex; if(Math.abs(den)<1e-12) continue;
          const wx=x1-ox, wz=z1-oz, t=(wx*ez-wz*ex)/den, u=(wx*dz-wz*dx)/den;
          if(t<.05 || t>max || u<-1e-9 || u>1+1e-9) continue;
          if(Math.abs(y-(oy+bank*t))>SAME_LEVEL) continue;            // a wall of a road above or below
          if(!(t>=best)) best=t; } } }
    return best;
  };
}

// Both walls along every ray: out from each track point to each side (main: ray 2i for
// the left, 2i+1 for the right), then out from each shortcut sample to each side (cuts, on
// the shortcut; ref [shortcut, sample]). Per ray: the origin (ox, oy, oz), direction (dx, dz),
// height change per m (bank), the reach (max, m, for the centre), and
//   c      the limit of the car's centre (NaN: open within reach)
//   cos    the cosine between the ray and the collision wall's normal at c
//   body   c + ALLOW / cos: where the body touches, along the ray
//   drawn  the nearest drawn wall (NaN: none within reach)
//   type   'ok' (both within 5 cm, or neither), 'invisible' (the body is stopped before any
//          drawn wall), 'through' (the body goes through a drawn wall), 'grazing' (the ray
//          meets the collision wall at under 0.2 cosine: too uncertain along it, not judged;
//          the rays beside it are)
//   miss   by how much (m; with NaN on one side: at least this much, to the end of reach)
export const TOL = .05;
// The rays one at a time (a generator: the overlay measures a few per idle moment);
// measureWalls() runs it through.
export function* wallRays(D=drawnWalls()){
  const near=wallGrid(D);
  const ray=(kind, ref, s, ox, oz, oy, bank, dx, dz, idx, cut, max) => {
    const L=limitAlong(ox, oz, oy, bank, dx, dz, idx, cut, max), c=L.c, cos=L.cos;
    const reach=max+ALLOW/Math.max(cos, .2), drawn=near(ox, oz, oy, bank, dx, dz, reach), body=c+ALLOW/Math.max(cos, .2);
    const b=isFinite(body)?body:reach, d=isFinite(drawn)?drawn:reach, miss=Math.abs(b-d);
    const type=isFinite(c) && cos<.2 ? 'grazing' : miss<=TOL ? 'ok' : b<d ? 'invisible' : 'through';
    return { kind, ref, s, ox, oz, oy, bank, dx, dz, max, c, cos, body, drawn, type, miss }; };
  for(let i=0;i<N;i++) for(const s of [1,-1]) yield ray('main', i, s, P[i].x, P[i].z, Y[i], s*TB[i], NM[i].x*s, NM[i].z*s, i, -1, WALL+3);
  for(const sc of SHORTCUTS) for(let k=0;k<sc.n;k++){ const idx=(sc.E+Math.round(sc.span*k/(sc.n-1)))%N;
    for(const s of [1,-1]) yield ray('cut', [sc.k,k], s, sc.x[k], sc.z[k], sc.y[k], 0, sc.nx[k]*s, sc.nz[k]*s, idx, sc.k, sc.wall+3); }
}
export function measureWalls(D=drawnWalls()){ return [...wallRays(D)]; }
