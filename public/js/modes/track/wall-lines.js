// Plan 3, stage 0: the track's walls as lines. One source for what is drawn (scene.js takes
// its offset lines, the shortcuts' gaps, the strips' heights and the walls from here) and
// what is checked: the ?debug=hit overlay (core/hitdebug.js) and the map scan
// (tests/tools/map-scan.mjs). Pure (no DOM, no rendering): Node runs it.
//
// Two kinds of wall, which up to stage 2 were not the same line:
// - drawn: drawnWalls(), the polylines scene.js puts the wall meshes on (stage 2: walls.js,
//   built by geometry.js setMap as WALLS; stage 3 collides with the same lines).
// - collision: where constrainToTrack really stops the car. Not computed from the rules
//   but measured: a still car (the coupe, pointing along the road) is put at a point and
//   constrainToTrack is run once; if it moved the car, the point is outside. Along a ray
//   (out from the centre line, or from a shortcut's centre line) the first such point is
//   the limit for the car's centre. Since stage 3 the car's body is its hitbox polygon
//   (core/hitboxes.js), stopped where the polygon meets a wall: at the limit the body must
//   rest on a drawn wall (anywhere, not only where the ray meets one: on a bend a corner of
//   the car touches first), and reach no drawn wall along the ray before it.
//   (Up to stage 2 the check was one point, the car's centre, kept WALL_ALLOW from the
//   wall, whatever the car's heading and shape.)
import { P, NM, TG, Y, TB, N, WALL, SHORTCUTS, SAME_LEVEL, WALLS, safeOffsets, constrainToTrack } from './geometry.js';
import { offsetLineOf } from './walls.js';
import { bodyOf } from '../../core/contact.js';
import { worldPoly } from '../../core/hitboxes.js';
import { HITLOG } from '../../core/hitlog.js';

// Heights above the road of the flat strips scene.js draws (m). The main road, its curbs and
// run-off lie on the road itself: they never overlap, and the ground under them and the
// shortcuts' strips over them are kept apart by polygonOffset (scene.js LAYER), not by
// height. The shortcuts' asphalt and curbs keep a few cm over the main road's (their mouths
// are one clean surface), the zebra hatching over the curb.
export const STRIP_Y = { road: 0, curb: 0, runoff: 0, zebra: .04, cutRunoff: 0, cutRoad: .04, cutCurb: .035 };
// polygonOffset (factor = units) per layer: > 0 pushed back, < 0 drawn over
export const LAYER = { ground: 4, cutRunoff: 2, main: 0, cutRoad: -1, zebra: -2, line: -3 };
export const GROUND_Y = -.02;
// The ground plane's height on the active map: 0 on a flat map («Ночной город», where it
// always was); on a map with heights GROUND_Y, or, where some drivable surface (the banked
// edge of the road, out to its walls, a shortcut) dips below that, 0.5 m under the lowest of
// them (the walls then get a skirt down to the ground all round, scene.js).
export const GROUND_DROP = .5;
export function groundLevel(){
  const flat = Y.every(y => y === 0), base = flat ? 0 : GROUND_Y;
  let lo = Infinity;
  for(const s of [1,-1]){ const L=offsetLine(s*WALL, 0); for(let i=0;i<N;i++) lo=Math.min(lo, L.y[i], Y[i]); }
  for(const sc of SHORTCUTS) for(let k=0;k<sc.n;k++) lo=Math.min(lo, sc.y[k]);
  if(WALLS) for(const L of WALLS.lines) for(let k=0;k<L.n;k++) lo=Math.min(lo, L.y[k]);
  return lo < base + (flat ? -1e-6 : .01) ? Math.floor((lo - GROUND_DROP) * 100) / 100 : base;
}

// An offset line along the track: offset off (m, > 0 left, or per-point array) of every track point,
// on the banked road plus yOff; a point that would step back along the track is pulled
// onto the previous one
export function offsetLine(off, yOff){
  return offsetLineOf({ N, P, NM, TG, Y, TB }, typeof off==='number'?safeOffsets(off):off, yOff);
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

// The walls of the active map as drawn (scene.js builds its wall meshes from this): the
// polylines of walls.js (geometry.js WALLS): { lines, fillets, ... }; each line: n points
// x, y, z, closed or open, i (the main track point of a point, or -1), s (the side per
// segment: 1 left, -1 right, the neon's colour), nx, nz (per segment) and px, pz (per point):
// the normal into the drivable space. fillets: the rounded corners at the shortcuts' mouths.
export function drawnWalls(){ return WALLS; }
// --- the collision walls, measured ---
const HOOKS = { onWall(){}, onLap(){}, onLand(){}, onTakeoff(){} };
const probe = {};
const PUSH = { x: 0, z: 0 };
// The probe: the coupe (its hitbox), pointing along the road (h)
export const PROBE_CAR = 'coupe';
// whether constrainToTrack moves a still car at (x, z) heading h (car.idx idx, on shortcut
// cut or -1); PUSH: where it moved it. (Not a contact of a real car: nothing goes to HITLOG.)
function pushed(x, z, y, idx, cut, h){
  const c=probe, log=HITLOG.on;
  c.carId=PROBE_CAR; c.x=x; c.z=z; c.y=y; c.idx=idx; c.cut=cut; c.h=h; c.hPrev=h; c.vx=c.vz=c.vF=c.vR=c.vy=0; c.steer=0; c.spinV=0;
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
function limitAlong(ox, oz, oy, bank, dx, dz, idx, cut, max, h){
  const at=o=>pushed(ox+dx*o, oz+dz*o, oy+bank*o, idx, cut, h);
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
  for(const L of D.lines){ const m=L.closed?L.n:L.n-1; for(let k=0;k<m;k++){ const j=(k+1)%L.n; add(L.x[k],L.z[k],L.x[j],L.z[j],(L.y[k]+L.y[j])/2); } }
  // the drawn wall pieces within r of (x, z) at about height y: [ax, az, bx, bz, y] each
  const around = (x, z, y, r) => { const out=[], seen=new Set();
    for(let gx=Math.floor((x-r)/cell); gx<=Math.floor((x+r)/cell); gx++) for(let gz=Math.floor((z-r)/cell); gz<=Math.floor((z+r)/cell); gz++){ const l=grid.get(gx+','+gz); if(!l) continue;
      for(const id of l){ if(seen.has(id)) continue; seen.add(id); if(Math.abs(segs[id][4]-y)<=SAME_LEVEL) out.push(segs[id]); } }
    return out; };
  // the nearest drawn wall along a ray (m), at about the ray's height (bank: per m), or NaN
  const ray = (ox, oz, oy, bank, dx, dz, max) => {
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
  return { ray, around };
}
// The distance between the polygon P (nv vertices) and the wall pieces (0: they touch or cross)
const segDist = (x, z, ax, az, bx, bz) => { const ex=bx-ax, ez=bz-az, L2=ex*ex+ez*ez, t=L2?Math.max(0, Math.min(1, ((x-ax)*ex+(z-az)*ez)/L2)):0; return Math.hypot(x-ax-ex*t, z-az-ez*t); };
const cross2 = (ax, az, bx, bz, cx, cz, dx, dz) => { const ex=bx-ax, ez=bz-az, fx=dx-cx, fz=dz-cz, den=ex*fz-ez*fx; if(Math.abs(den)<1e-12) return false;
  const wx=cx-ax, wz=cz-az, t=(wx*fz-wz*fx)/den, u=(wx*ez-wz*ex)/den; return t>=0 && t<=1 && u>=0 && u<=1; };
function polyToWalls(P, nv, pieces){
  let best=Infinity;
  for(const [ax,az,bx,bz] of pieces){
    for(let i=0;i<nv;i++){ const j=(i+1)%nv;
      if(cross2(P[2*i],P[2*i+1],P[2*j],P[2*j+1],ax,az,bx,bz)) return 0;
      best=Math.min(best, segDist(P[2*i],P[2*i+1],ax,az,bx,bz)); }
    for(const [x,z] of [[ax,az],[bx,bz]]) for(let i=0;i<nv;i++){ const j=(i+1)%nv; best=Math.min(best, segDist(x,z,P[2*i],P[2*i+1],P[2*j],P[2*j+1])); } }
  return best;
}

// Both walls along every ray: out from each track point to each side (main: ray 2i for
// the left, 2i+1 for the right), then out from each shortcut sample to each side (cuts, on
// the shortcut; ref [shortcut, sample]). Per ray: the origin (ox, oy, oz), direction (dx, dz),
// height change per m (bank), the reach (max, m, for the centre), and
//   c      the limit of the centre of the probe car, pointing along the road (NaN: open within reach)
//   cos    the cosine between the ray and the push out of the wall at c (information)
//   body   how far the probe's body (its hitbox) reaches along the ray there
//   touch  the distance from the body at c to the nearest drawn wall (anywhere around it)
//   drawn  the nearest drawn wall along the ray (NaN: none within reach)
//   type   'ok' (the body rests on a drawn wall, and the ray's drawn wall is not inside it;
//          or neither wall within reach), 'invisible' (the body is stopped with no drawn
//          wall within TOL of it), 'through' (the body reaches past the drawn wall along the
//          ray, or no collision stops it before the drawn wall)
//   miss   by how much (m; with NaN on one side: at least this much, to the end of reach)
export const TOL = .05;
// The rays one at a time (a generator: the overlay measures a few per idle moment);
// measureWalls() runs it through.
export function* wallRays(D=drawnWalls()){
  const G=wallGrid(D), B=bodyOf(PROBE_CAR), PW=new Float64Array(64);
  const ray=(kind, ref, s, ox, oz, oy, bank, dx, dz, idx, cut, max, tx, tz) => {
    const h=Math.atan2(tx, tz), L=limitAlong(ox, oz, oy, bank, dx, dz, idx, cut, max, h), c=L.c, cos=L.cos;
    worldPoly(PROBE_CAR, 0, 0, h, PW); let sup=-Infinity; for(let i=0;i<B.nv;i++) sup=Math.max(sup, PW[2*i]*dx+PW[2*i+1]*dz);
    const reach=max+sup, drawn=G.ray(ox, oz, oy, bank, dx, dz, reach);
    let body=NaN, touch=NaN, type='ok', miss=0;
    if(isFinite(c)){
      const o=c-.003, x=ox+dx*o, z=oz+dz*o; body=c+sup;
      worldPoly(PROBE_CAR, x, z, h, PW); touch=polyToWalls(PW, B.nv, G.around(x, z, oy+bank*o, B.r+1));
      if(isFinite(drawn) && body-drawn>TOL){ type='through'; miss=body-drawn; }
      else if(!(touch<=TOL)){ type='invisible'; miss=isFinite(touch)?touch:B.r+1; }
    } else if(isFinite(drawn)){ type='through'; miss=reach-drawn; }
    return { kind, ref, s, ox, oz, oy, bank, dx, dz, max, c, cos, body, touch, drawn, type, miss }; };
  for(let i=0;i<N;i++) for(const s of [1,-1]) yield ray('main', i, s, P[i].x, P[i].z, Y[i], s*TB[i], NM[i].x*s, NM[i].z*s, i, -1, WALL+3, TG[i].x, TG[i].z);
  for(const sc of SHORTCUTS) for(let k=0;k<sc.n;k++){ const idx=(sc.E+Math.round(sc.span*k/(sc.n-1)))%N;
    for(const s of [1,-1]) yield ray('cut', [sc.k,k], s, sc.x[k], sc.z[k], sc.y[k], 0, sc.nx[k]*s, sc.nz[k]*s, idx, sc.k, sc.wall+3, sc.tx[k], sc.tz[k]); }
}
export function measureWalls(D=drawnWalls()){ return [...wallRays(D)]; }
