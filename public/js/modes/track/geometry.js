// Drift track geometry and the track's rules for a car: walls, off-track slowdown, laps,
// and (track engine v2) heights, slopes, banking, jumps and bridges.
// No rendering and no DOM here, so the Node tests can run this file.
//
// The track comes from a map (maps/*.js: control points [x, z, height, bank], width,
// start, bridges). setMap(id) builds every array below from it; they are filled in place
// (and N, START, ... are live bindings), so scene.js, index.js and net.js always read the
// active map. Listeners from onMapChange() run after a switch (the scenery, the minimap).
//
// On a flat map («Ночной город») the heights, jumps and bridges are skipped. The walls are
// the car's hitbox against the drawn wall polylines on every map (plan 3 stage 3,
// core/contact.js); the physics golden test was re-recorded once for that.
import { closedCurve } from './curve.js';
import { MAPS, DEFAULT_MAP } from './maps/index.js';
import { HITLOG } from '../../core/hitlog.js';
import { WALL_ALLOW, WALL as WALLK, bodyOf, wallContact, resolveWalls, pushOut } from '../../core/contact.js';
import { worldPoly } from '../../core/hitboxes.js';
import { buildWalls, safeOffsetsOf, wallsNear as wallsNearIn } from './walls.js';

export const CURB = 1.4, GRAV = 9.81;
export let MAP = null, N = 0, ROAD = 16, HALF = 8, WALL = 14, START = 0, TRACK_LEN = 0, SC = 1, FLAT = true;
// braking off the asphalt (1/s: the speed lost per second is this × the speed) and the
// shortest legal lap (m: through every shortcut)
export let VDRAG = .45, LAP_MIN = 0;
// Stacked levels (maps' `levels: { gap, slab }`, «Паркинг»): roads pass over each other one
// floor apart (gap, m) with a slab or a deck (slab, m thick) between them. LEVELS is the
// map's field or null; YW weighs the height difference in nearest()'s full search (4 m per
// m; 10 on a map with levels, so a car is never put on the floor above or below); SAME_LEVEL
// is the height difference under which two cars are on the same road (collisions,
// slipstream: 3 m; half a floor on a map with levels).
export let LEVELS = null, YW = 4, SAME_LEVEL = 3;
// per track point: position (y = road height), horizontal tangent and normal (NM points to
// the driver's left), distance along the lap
export const P = [], TG = [], NM = [], DIST = [];
// per track point: height (= P[i].y), grade dY/ds, bank (radians, > 0 lifts the left/+NM
// edge) and its tangent, horizontal length to the next point, signed radius of the
// centre line (> 0: a right-hand turn, the centre of the turn on the -NM side), whether
// it is part of a bridge, and its control-point coordinate (maps' `bridges`, `start`)
export const Y = [], GR = [], BANK = [], TB = [], HL = [], RAD = [], BRIDGE = [], CP = [];
// Shortcuts (maps' `shortcuts`, see buildShortcut) and the lap's checkpoints: the track
// points a lap must pass in order (GATES), none of them on a stretch a shortcut skips.
export const SHORTCUTS = [], GATES = [];
// Per track point on a map with levels: how far above the road (its centre) the nearest
// ceiling is: a floor slab of the building over it, or the deck of a road above it (m, to
// the underside); Infinity under the open sky (and everywhere on other maps).
export const CEIL = [];

const listeners = [];
export function onMapChange(fn){ listeners.push(fn); }

// Everything the track is, built from a map's data (pure: setMap copies it into the live
// arrays above; blueprint() uses it for any map without switching).
function buildGeometry(map){
  const g = { map, SC: map.scale || 1, ROAD: map.width || 16 };
  g.HALF = g.ROAD / 2; g.WALL = g.HALF + (map.verge || 6);
  const curve = closedCurve(map.points.map(([x, z, h = 0, b = 0]) => ({ x: x * g.SC, y: h, z: z * g.SC, w: b * Math.PI / 180 })));
  const N = g.N = map.samples || Math.max(300, Math.round(curve.length / 1.6));
  const P=g.P=[], TG=g.TG=[], NM=g.NM=[], DIST=g.DIST=[], Y=g.Y=[], GR=g.GR=[], BANK=g.BANK=[], TB=g.TB=[], HL=g.HL=[], RAD=g.RAD=[], BRIDGE=g.BRIDGE=[], CP=g.CP=[];
  const l = map.points.length;
  for(let i=0;i<N;i++){ const u=i/N;
    const c=curve.getPointAt(u); P.push(new THREE.Vector3(c.x, c.y, c.z));
    const gt=curve.getTangentAt(u), t=new THREE.Vector3(gt.x, gt.y, gt.z); t.y=0; t.normalize(); TG.push(t); NM.push(new THREE.Vector3(t.z,0,-t.x));
    BANK.push(c.w); TB.push(Math.tan(c.w)); Y.push(c.y); CP.push(curve.uToT(u) * l);
  }
  // Heights: the spline through the control points bends in steps at every control point
  // (it is only C1), which a fast car would feel as bumps and false take-offs. The profile
  // is smoothed along the track (12 passes of [1 2 1]/4: σ ≈ 2.4 points ≈ 4 m).
  if(Y.some(y => y !== 0)){
    let a=Float64Array.from(Y), b=new Float64Array(N);
    for(let k=0;k<12;k++){ for(let i=0;i<N;i++) b[i]=(a[(i-1+N)%N]+2*a[i]+a[(i+1)%N])/4; [a,b]=[b,a]; }
    for(let i=0;i<N;i++){ Y[i]=a[i]; P[i].y=a[i]; }
  }
  g.TRACK_LEN = (() => { let L=0; for(let i=0;i<N;i++){ DIST.push(L); L+=P[i].distanceTo(P[(i+1)%N]); } return L; })();
  g.FLAT = Y.every(y => y === 0) && BANK.every(b => b === 0);
  for(let i=0;i<N;i++){ const j=(i+1)%N; HL.push(Math.hypot(P[j].x-P[i].x, P[j].z-P[i].z)); }
  // grades: the slopes of the periodic cubic spline through the heights (C2: the road's
  // curvature over a crest changes smoothly, see surface()), by Gauss-Seidel
  for(let i=0;i<N;i++){ const a=(i-1+N)%N, b=(i+1)%N; GR.push((Y[b]-Y[a])/(HL[a]+HL[i])); }
  if(Y.some(y => y !== 0)) for(let it=0;it<300;it++) for(let i=0;i<N;i++){ const a=(i-1+N)%N, b=(i+1)%N, h0=HL[a], h1=HL[i];
    GR[i]=(3*(h1*(Y[i]-Y[a])/h0+h0*(Y[b]-Y[i])/h1)-h1*GR[a]-h0*GR[b])/(2*(h0+h1)); }
  // signed radius from the turn of the tangent over ±1 point
  for(let i=0;i<N;i++){ const a=TG[(i-1+N)%N], b=TG[(i+1)%N];
    let s=0; for(let k=-1;k<1;k++) s+=HL[(i+k+N)%N];
    const turn=Math.asin(Math.max(-1,Math.min(1,a.x*b.z-a.z*b.x)));
    RAD.push(Math.abs(turn)<1e-9 ? 1e9 : s/turn); }
  const inSpan = (k, f, t) => f <= t ? (k >= f && k <= t) : (k >= f || k <= t);
  for(let i=0;i<N;i++) BRIDGE.push((map.bridges||[]).some(b => inSpan(CP[i], b.from, b.to)) ? 1 : 0);
  g.sampleAt = k => { k=((k%l)+l)%l;
    let best=0, bd=1e9; for(let i=0;i<N;i++){ let d=Math.abs(CP[i]-k); d=Math.min(d, l-d); if(d<bd){bd=d;best=i;} }
    return best; };
  g.START = map.start && map.start.sample !== undefined ? map.start.sample : g.sampleAt(map.start ? map.start.at : 0);
  g.VDRAG = map.vergeDrag || .45;
  g.SHORTCUTS = (map.shortcuts || []).map((s, k) => buildShortcut(g, s, k));
  g.LAP_MIN = g.TRACK_LEN - g.SHORTCUTS.reduce((a, s) => a + Math.max(0, s.saves), 0);
  g.GATES = buildGates(g);
  g.CEIL = buildCeil(g);
  return g;
}
// The ceilings (see CEIL): the slabs of the map's `building` (a box x0..x1, z0..z1 with
// floors at the heights in `floors`) over a point inside it, and the decks of the roads
// above it: a road whose cross-section (out to its walls) passes over the point, more
// than 1 m higher; its deck's underside there.
function buildCeil(g){
  const { map, N, P, Y, NM, TG, TB, GR, HL, WALL } = g, out = new Array(N).fill(Infinity);
  if(!map.levels) return out;
  const slab = map.levels.slab || 0, b = map.building;
  for(let i=0;i<N;i++){
    let c = Infinity;
    if(b && P[i].x>=b.x0 && P[i].x<=b.x1 && P[i].z>=b.z0 && P[i].z<=b.z1)
      for(const f of b.floors) if(f>Y[i]+1) c=Math.min(c, f-slab-Y[i]);
    for(let j=0;j<N;j++){ const dx=P[i].x-P[j].x, dz=P[i].z-P[j].z; if(dx*dx+dz*dz>(WALL+1)*(WALL+1) || Y[j]<Y[i]+1) continue;
      const along=dx*TG[j].x+dz*TG[j].z; if(along<-HL[(j-1+N)%N]/2-.01 || along>HL[j]/2+.01) continue;
      const lat=dx*NM[j].x+dz*NM[j].z; if(Math.abs(lat)>WALL+.3) continue;
      c=Math.min(c, Y[j]+lat*TB[j]+along*GR[j]-slab-Y[i]); }
    out[i]=c;
  }
  return out;
}

// A shortcut (map field `shortcuts: [{ from, to, points, width }]`): a narrow road (width
// 4-6 m, default 5) that leaves the main road at control-point coordinate `from`, runs
// through `points` ([x, z] or [x, z, height] in map units, × scale like the main points)
// and joins the main road again at `to`, further along the lap. It starts and ends on the
// main road's centre line; the main road's walls open where it passes through them.
// Its corners are rounded (Chaikin), so put a point where it should bend. Heights, when
// not given, go linearly from the main road's height at one end to the other's.
// Built: one sample per metre: x, z, y, tangent (tx, tz), normal to the left (nx, nz),
// distance d; E, X: the main track points where it leaves and joins; span: how many
// main points it skips; saves: how many metres it saves.
export const CUT_VERGE = .9;           // m from a shortcut's asphalt edge to its wall
function buildShortcut(g, s, k){
  const { P, Y, N, DIST, TRACK_LEN, SC } = g;
  const E = g.sampleAt(s.from), X = g.sampleAt(s.to);
  let pts = [[P[E].x, P[E].z, Y[E]], ...s.points.map(([x, z, h]) => [x*SC, z*SC, h]), [P[X].x, P[X].z, Y[X]]];
  // heights not given: linear in the distance along the polyline
  { let L=[0]; for(let i=1;i<pts.length;i++) L.push(L[i-1]+Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
    pts = pts.map((p, i) => [p[0], p[1], p[2] !== undefined ? p[2] : Y[E] + (Y[X]-Y[E]) * L[i] / L[L.length-1]]); }
  for(let it=0;it<4;it++){ const q=[pts[0]];
    for(let i=0;i<pts.length-1;i++){ const a=pts[i], b=pts[i+1];
      const mix=f=>[a[0]+(b[0]-a[0])*f, a[1]+(b[1]-a[1])*f, a[2]+(b[2]-a[2])*f];
      if(i>0) q.push(mix(.25)); if(i<pts.length-2) q.push(mix(.75)); }
    q.push(pts[pts.length-1]); pts=q; }
  // resample: one point per metre
  const L=[0]; for(let i=1;i<pts.length;i++) L.push(L[i-1]+Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
  const len = L[L.length-1], n = Math.max(2, Math.round(len) + 1);
  const x=new Float64Array(n), z=new Float64Array(n), y=new Float64Array(n), d=new Float64Array(n);
  for(let i=0, j=0;i<n;i++){ const t=len*i/(n-1); while(j<pts.length-2 && L[j+1]<t) j++;
    const f=(t-L[j])/((L[j+1]-L[j])||1), a=pts[j], b=pts[j+1];
    x[i]=a[0]+(b[0]-a[0])*f; z[i]=a[1]+(b[1]-a[1])*f; y[i]=a[2]+(b[2]-a[2])*f; d[i]=t; }
  const tx=new Float64Array(n), tz=new Float64Array(n), nx=new Float64Array(n), nz=new Float64Array(n), gr=new Float64Array(n);
  for(let i=0;i<n;i++){ const a=Math.max(0,i-1), b=Math.min(n-1,i+1), dx=x[b]-x[a], dz=z[b]-z[a], l=Math.hypot(dx,dz)||1;
    tx[i]=dx/l; tz[i]=dz/l; nx[i]=tz[i]; nz[i]=-tx[i]; gr[i]=(y[b]-y[a])/l; }
  const half = (s.width || 5) / 2, wall = half + CUT_VERGE, m = wall + 2;
  let x0=1e9,x1=-1e9,z0=1e9,z1=-1e9; for(let i=0;i<n;i++){ x0=Math.min(x0,x[i]); x1=Math.max(x1,x[i]); z0=Math.min(z0,z[i]); z1=Math.max(z1,z[i]); }
  const span = (X - E + N) % N, skipped = (DIST[X] - DIST[E] + TRACK_LEN) % TRACK_LEN;
  return { k, E, X, span, n, x, z, y, d, tx, tz, nx, nz, gr, len, half, wall, lim: wall - WALL_ALLOW,
    box: [x0-m, x1+m, z0-m, z1+m], saves: skipped - len };
}
// The lap's checkpoints: about one every 150 m (at least 6), counted from the start line,
// moved off any stretch a shortcut skips (a lap through a shortcut passes all of them; a
// lap that skips a section of track misses one and does not count).
function buildGates(g){
  const { N, START, SHORTCUTS, TRACK_LEN } = g;
  const skipped = i => SHORTCUTS.some(s => ((i - s.E + 16 + N) % N) <= s.span + 32);   // ±16 points round the mouths too
  const n = Math.max(6, Math.round(TRACK_LEN / 150)), out = [];
  for(let k=1;k<n;k++){ let i=(START + Math.round(k*N/n)) % N, tries=0;
    while(skipped(i) && tries++<N) i=(i+1)%N;
    if(!out.includes(i)) out.push(i); }
  // in lap order from the start line
  return out.sort((a, b) => ((a - START + N) % N) - ((b - START + N) % N));
}

export function setMap(id){
  const map = MAPS[typeof id==='string' && Object.hasOwn(MAPS, id) ? id : DEFAULT_MAP];
  if(MAP === map) return MAP;
  const g = buildGeometry(map);
  MAP = map; SC = g.SC; ROAD = g.ROAD; HALF = g.HALF; WALL = g.WALL; N = g.N;
  LEVELS = map.levels || null; YW = LEVELS ? 10 : 4; SAME_LEVEL = LEVELS ? LEVELS.gap / 2 : 3;
  for(const k of ['P','TG','NM','DIST','Y','GR','BANK','TB','HL','RAD','BRIDGE','CP','SHORTCUTS','GATES','CEIL']){ const a=ARRAYS[k]; a.length=0; for(const v of g[k]) a.push(v); }
  TRACK_LEN = g.TRACK_LEN; FLAT = g.FLAT; START = g.START; VDRAG = g.VDRAG; LAP_MIN = g.LAP_MIN;
  WALLS = buildWalls({ N, P, NM, TG, Y, TB, RAD, WALL, HALF, SHORTCUTS, SAME_LEVEL, LEVELS });
  for(const fn of listeners) fn(MAP);
  return MAP;
}
const ARRAYS = { P, TG, NM, DIST, Y, GR, BANK, TB, HL, RAD, BRIDGE, CP, SHORTCUTS, GATES, CEIL };
// The active map's walls as polylines (walls.js buildWalls): what scene.js draws, and (plan 3
// stage 3) what the car's hitbox collides with (trackWalls).
export let WALLS = null;
// the wall segments within r m of (x, z) at about height y (NaN: any): see walls.js wallsNear
export function wallsNear(x, z, y, r, out){ return wallsNearIn(WALLS, x, z, y, r, out); }
// the track point at control-point coordinate k
export function sampleAt(k){
  const l=MAP.points.length; k=((k%l)+l)%l;
  let best=0, bd=1e9; for(let i=0;i<N;i++){ let d=Math.abs(CP[i]-k); d=Math.min(d, l-d); if(d<bd){bd=d;best=i;} }
  return best;
}
// A map's plan for the map card (stage 6) and the blueprint images, without switching to
// it: the centre line (x, z, height per track point), the bridges as track-point spans, the
// shortcuts' centre lines, the start point and direction, the lap length.
const blueprints = new Map();
export function blueprint(id){
  if(!Object.hasOwn(MAPS, id)) return null;
  if(!blueprints.has(id)){
    const g = buildGeometry(MAPS[id]), b = [];
    for(let i=0;i<g.N;i++) if(g.BRIDGE[i] && !g.BRIDGE[(i-1+g.N)%g.N]){ let j=i; while(g.BRIDGE[(j+1)%g.N] && j-i<g.N) j++; b.push({ from:i, to:j%g.N }); }
    blueprints.set(id, { id, name: MAPS[id].name, len: g.TRACK_LEN, lapMin: g.LAP_MIN, width: g.ROAD, wall: g.WALL,
      path: g.P.map((p, i) => [p.x, p.z, g.Y[i]]), bridges: b,
      shortcuts: g.SHORTCUTS.map(s => ({ path: Array.from(s.x, (x, i) => [x, s.z[i]]), width: 2 * s.half, from: s.E, to: s.X })),
      start: { i: g.START, x: g.P[g.START].x, z: g.P[g.START].z, dir: [g.TG[g.START].x, g.TG[g.START].z] } });
  }
  return blueprints.get(id);
}
setMap(DEFAULT_MAP);

// Offset curves that never fold (curbs, run-off, walls, scenery): offset `off` (m, > 0 to
// the left/+NM) for every track point, limited on the inside of a turn to 0.9 × the local
// radius. The limit is a running minimum over ±W points, then a running average over ±W/2
// (both keep it under 0.9·R everywhere), so a curb narrows smoothly instead of breaking.
export function safeOffsets(off, W=8){ return safeOffsetsOf(N, RAD, off, W); }

export function placeAt(car,i){
  // a short move (the R key) passes the checkpoints in between, as driving there would
  if(GATES.length && car.idx!==undefined){ let d=i-car.idx; if(d>N/2) d-=N; if(d<-N/2) d+=N; if(d && Math.abs(d)<60) passGates(car, car.idx, d); }
  car.cut=-1;
  const t=TG[i]; car.x=P[i].x; car.z=P[i].z; car.h=Math.atan2(t.x,t.z); car.vx=car.vz=0; car.vF=car.vR=0; car.steer=0; car.spinV=0; car.idx=i;
  car.lastMark=[null,null];
  car.y=Y[i]; car.vy=0; car.air=false; car.yawRate=0; car.hPrev=car.h; car.squash=0;
}
// Starting grid: two columns behind the start line, 7 m between rows.
export function placeGrid(car,slot){
  const row=Math.floor(slot/2), side=slot%2?-1:1, back=7+row*7;
  let i=START, d=0; while(d<back){ const j=(i-1+N)%N; d+=P[j].distanceTo(P[i]); i=j; }
  placeAt(car,i); car.x+=NM[i].x*side*3.6; car.z+=NM[i].z*side*3.6;
  if(!FLAT) car.y=surface(car).y;
  car.prog=-((START-i+N)%N); car.gate=0;
}
// Back onto a shortcut (the R key while on one): its sample nearest the car, facing along it.
export function placeOnCut(car){
  const s=SHORTCUTS[car.cut]; if(!s) return false;
  const k=cutLocate(s, car).k, i=cutIdx(s, k);
  placeAt(car, i);
  car.cut=s.k; car.x=s.x[k]; car.z=s.z[k]; car.h=Math.atan2(s.tx[k], s.tz[k]); car.hPrev=car.h; car.y=s.y[k];
  return true;
}
// The nearest track point. Local (±36 points from car.idx) every substep, so at a
// crossing the car never jumps to the other road. A full search (after a jump to a new
// place) also weighs the height difference when the car's height is known (YW per m), so
// a car on a bridge finds the bridge and not the road below it, and a car on a floor of
// the car park its own floor.
export function nearest(car,full){
  let bi=car.idx, bd=1e12; const from=full?0:-36, to=full?N:36;
  if(FLAT || car.y===undefined){
    for(let k=from;k<to;k++){ const j=full?k:(car.idx+k+N)%N; const dx=P[j].x-car.x, dz=P[j].z-car.z, d=dx*dx+dz*dz; if(d<bd){bd=d;bi=j;} }
    return bi;
  }
  for(let k=from;k<to;k++){ const j=full?k:(car.idx+k+N)%N; const dx=P[j].x-car.x, dz=P[j].z-car.z, dy=(Y[j]-car.y)*YW, d=dx*dx+dz*dz+dy*dy; if(d<bd){bd=d;bi=j;} }
  return bi;
}

// The road surface under (x, z) near track point car.idx: height, grade along the track
// and its rate of change (d²y/ds²), and the horizontal gradient of the surface (gx, gz:
// dy/dx, dy/dz). Height between two track points is a cubic Hermite of their heights and
// grades, so it is smooth (C1) and a car's vertical speed has no steps. The position is
// measured along the chord between the two points, so whichever of them is car.idx the
// answer is the same. The bank tilts the surface across the road.
const SURF = { y:0, gx:0, gz:0, grade:0, curv:0, bank:0, lat:0 };
export function surface(car, out=SURF){
  if(car.cut>=0 && SHORTCUTS[car.cut]) return cutSurface(SHORTCUTS[car.cut], car, out);
  const i=car.idx, p=P[i], t=TG[i];
  let a, b;
  if((car.x-p.x)*t.x+(car.z-p.z)*t.z>=0){ a=i; b=(i+1)%N; } else { a=(i-1+N)%N; b=i; }
  const L=HL[a], cx=(P[b].x-P[a].x)/L, cz=(P[b].z-P[a].z)/L, rx=car.x-P[a].x, rz=car.z-P[a].z;
  const f=Math.max(0,Math.min(1,(rx*cx+rz*cz)/L)), lat=rx*cz-rz*cx;     // lat: to the left (+NM)
  const f2=f*f, f3=f2*f;
  const y=(2*f3-3*f2+1)*Y[a]+(f3-2*f2+f)*L*GR[a]+(-2*f3+3*f2)*Y[b]+(f3-f2)*L*GR[b];
  const grade=((6*f2-6*f)*Y[a]+(3*f2-4*f+1)*L*GR[a]+(-6*f2+6*f)*Y[b]+(3*f2-2*f)*L*GR[b])/L;
  const curv=((12*f-6)*Y[a]+(6*f-4)*L*GR[a]+(6-12*f)*Y[b]+(6*f-2)*L*GR[b])/(L*L);
  const tb=TB[a]+(TB[b]-TB[a])*f;
  out.y=y+lat*tb; out.grade=grade; out.curv=curv; out.bank=Math.atan(tb); out.lat=lat;
  out.gx=grade*cx+tb*cz; out.gz=grade*cz-tb*cx;
  out.tx=cx; out.tz=cz;
  return out;
}

// Another player's predicted car must not be drawn through the walls (see keepOnRoad in
// modes/traffic/geometry.js): a prediction past a wall is bounced back off it. `memo`
// keeps the last track point found for this car, so the search stays local. p.idx, when
// set, is the track point the other player reported (their own local search): a fresh
// search starts there. p.y, when set, is their height (bridges: see nearest()).
export function keepInWalls(p, memo){
  if(p.idx!==undefined && memo.sent!==p.idx){ memo.sent=p.idx; if(p.idx>=0 && p.idx<N) memo.idx=p.idx; }
  const q0={x:p.x,z:p.z,idx:memo.idx||0}; if(!FLAT && p.y!==undefined) q0.y=p.y;
  let i=nearest(q0, memo.idx===undefined);
  // The local search looks 36 points each way from the last one. When the car jumped (a new
  // run puts it back on the grid) the point it finds is on a far piece of track, and the
  // car would be "bounced" off that piece's walls. A car is never this far from its own
  // piece of track: search the whole track again.
  { const dx=P[i].x-p.x, dz=P[i].z-p.z, far=WALL+12; if(dx*dx+dz*dz>far*far){ q0.idx=i; i=nearest(q0, true); } }
  // (with stacked levels: nor beside its own walls or on another floor; a car never flies there)
  if(LEVELS && q0.y!==undefined){ const dx=P[i].x-p.x, dz=P[i].z-p.z, w=WALL+1;
    if(dx*dx+dz*dz>w*w || Math.abs(Y[i]-q0.y)>SAME_LEVEL){ q0.idx=i; i=nearest(q0, true); } }
  memo.idx=i;
  const q=P[i], n=NM[i], lat=(p.x-q.x)*n.x+(p.z-q.z)*n.z, lim=WALL-WALL_ALLOW, over=Math.abs(lat)-lim;
  // which road it is on: a shortcut's (a prediction a little past a shortcut's wall is found
  // too, and put back against it, not thrown across onto the main road) or the main road
  const cut=over>0 && SHORTCUTS.length ? cutAt(p, 3) : null;
  // A prediction far through a wall (it does not know the walls: up to several metres at
  // speed) is first brought back along its road's normal until its body (as it is turned) is
  // at most GHOST_DEPTH / 2 behind the road's wall line; then its hitbox is pushed out of the
  // drawn walls (contact.js, looking up to GHOST_DEPTH deep), as the car itself would be
  // stopped, with no bounce.
  const B=bodyOf(memo.car), lid=(cut?cut.s.lim:lim)+WALL_ALLOW, sx=cut?cut.s.nx[cut.loc.k]:n.x, sz=cut?cut.s.nz[cut.loc.k]:n.z, sl=cut?cut.loc.lat:lat;
  if(Math.abs(sl)+B.r>lid){ const sg=Math.sign(sl), back=Math.abs(sl)+reach(p, B, sx*sg, sz*sg)-lid-GHOST_DEPTH/2;
    if(back>0){ p.x-=sx*sg*back; p.z-=sz*sg*back; } }
  if(WALLS && nearWalls(p.x, p.z, B, !FLAT, i, cut?cut.s.k:-1, GHOST_DEPTH)) pushOut(p, B, detectGhost);
  if(!FLAT){
    // drawn height: their reported flight (ballistic), never below the road
    const ys=surface({x:p.x,z:p.z,idx:i,cut:cut?cut.s.k:-1}).y;
    p.y = p.y===undefined ? ys : Math.max(ys, p.y);
  }
  return p;
}

// Vertical motion (maps with heights only). Grounded, the car follows the road; it takes
// off where the road falls away faster than gravity can bend the car's path down (a
// crest taken fast), flies (main.js does not call stepCar while car.air), and lands.
export const AIR = {
  MARGIN: 0.5,       // m/s²: the road must bend down this much harder than gravity to lift the car
  HARD: 3,           // m/s into the road: a landing harder than this costs speed and shakes
  LOSS: .02,         // speed lost per m/s over HARD (at most 12 %)
};
// Flight: no grip, steering or throttle. The car keeps its velocity and its turn rate.
function fly(car,dt){
  car.h+=car.yawRate*dt;                        // (the turn rate measured on the ground includes any spin from a hit)
  car.spinV*=Math.exp(-2.5*dt);
  car.x+=car.vx*dt; car.z+=car.vz*dt;
  const fx=Math.sin(car.h), fz=Math.cos(car.h);
  car.vF=car.vx*fx+car.vz*fz; car.vR=car.vx*Math.cos(car.h)-car.vz*Math.sin(car.h);
}
function vertical(car,dt,hooks){
  const S=surface(car);
  const vyRoad=car.vx*S.gx+car.vz*S.gz;                      // the road's vertical speed under the moving car
  if(car.air){
    car.y+=car.vy*dt-.5*GRAV*dt*dt; car.vy-=GRAV*dt;
    if(car.y<=S.y){
      const vn=vyRoad-car.vy;                                 // how hard it hits the road
      car.y=S.y; car.vy=vyRoad; car.air=false;
      car.squash=Math.min(.16, vn*.02);
      if(vn>AIR.HARD){ const k=1-Math.min(.12,(vn-AIR.HARD)*AIR.LOSS); car.vx*=k; car.vz*=k; car.vF*=k; car.vR*=k; }
      if(hooks.onLand) hooks.onLand(vn);
    }
  } else {
    // to stay on the road the car would have to be pulled down at v²·(d²y/ds²); gravity
    // gives at most g. Over a crest taken faster than that, the wheels leave the road.
    const vt=car.vx*S.tx+car.vz*S.tz;
    car.y=S.y; car.vy=vyRoad;
    if(vt*vt*S.curv < -(GRAV+AIR.MARGIN)){ car.air=true; if(hooks.onTakeoff) hooks.onTakeoff(); }
    else {
      // gravity along the slope (uphill slower, downhill faster) and across a bank (the
      // banked road pushes the car into the turn): the part of g that lies in the road
      const cg=1/Math.sqrt(1+S.gx*S.gx+S.gz*S.gz), k=-GRAV*cg*dt;
      car.vx+=S.gx*k; car.vz+=S.gz*k;
    }
    car.yawRate=car.hPrev===undefined?0:Math.atan2(Math.sin(car.h-car.hPrev),Math.cos(car.h-car.hPrev))/dt;
  }
  car.hPrev=car.h;
}

// Runs right after stepCar() in the same substep (or instead of it while the car is in
// the air). hooks.onWall(power) is the old crash(power) call, hooks.onLap() the old
// finishLap() call, hooks.onLand(power) a landing after a jump.
export function constrainToTrack(car,dt,hooks){
  if(!FLAT && car.air) fly(car,dt);
  if(SHORTCUTS.length){ constrainWithCuts(car,dt,hooks); return; }
  // track
  const ni=nearest(car,false);
  moveIdx(car, ni);
  const p=P[ni], n=NM[ni];
  const lat=(car.x-p.x)*n.x+(car.z-p.z)*n.z;
  trackWalls(car, dt, hooks);
  car.off=Math.abs(lat)>HALF+CURB;
  if(car.off && !car.air){ const k=Math.exp(-VDRAG*dt); car.vx*=k; car.vz*=k; }   // off the asphalt: the map's verge drag (VDRAG, default .45/s)
  if(!FLAT) vertical(car,dt,hooks);
  laps(car,hooks);
}
// The walls (plan 3 stage 3): the car's hitbox against the wall polylines near it, at its own
// level (contact.js). The lap logic (car.idx, the gates, which road) stays on the centre.
const NEAR=[]; let nNear=0;
// The wall segments within reach of a car's hitbox at (x, z), into NEAR (nNear); on a map
// with heights (level) only the walls of its own level: the road's height under the car
// (its track point i, or shortcut cut), carried out to each wall along the road's slope and
// bank (on «Перевал»'s banks the edge is 2.2 m below the centre), within SAME_LEVEL.
const SQ={ x:0, z:0, idx:0, cut:-1 };
function nearWalls(x, z, B, level, i, cut, depth=WALLK.DEPTH){
  nNear=wallsNearIn(WALLS, x, z, NaN, B.r+depth, NEAR);
  if(!nNear || !level) return nNear;
  SQ.x=x; SQ.z=z; SQ.idx=i; SQ.cut=cut;
  const S=surface(SQ), lev=WALLS.sameLevel, y0=S.y;
  let m=0;
  for(let k=0;k<nNear;k++){ const e=NEAR[k], yw=y0+S.gx*(e.px-x)+S.gz*(e.pz-z);
    if(Math.abs(e.y-yw)<=lev){ if(m!==k){ const t=NEAR[m]; NEAR[m]=e; NEAR[k]=t; } m++; } }
  return nNear=m;
}
// how deep a vertex is looked for: WALLK.DEPTH, or the car's travel in this substep plus a margin
// when that is more (a stalled frame: main.js clamps dt to .05, a substep of 25 ms at 72 m/s is 1.8 m)
let depthNow=WALLK.DEPTH;
const detectTrack=(P, nv, c, B, out)=>wallContact(WALLS, NEAR, nNear, P, nv, c.x, c.z, B.r, depthNow, out);
// another player's prediction: it may be deeper in a wall than our own car ever gets in a substep
const GHOST_DEPTH=4;
const detectGhost=(P, nv, c, B, out)=>wallContact(WALLS, NEAR, nNear, P, nv, c.x, c.z, B.r, GHOST_DEPTH, out);
// how far the body at p (heading p.h) reaches from its centre along (ux, uz)
const PR=new Float64Array(64);
function reach(p, B, ux, uz){
  worldPoly(B.id, p.x, p.z, p.h||0, PR); let m=0;
  for(let v=0;v<B.nv;v++){ const d=(PR[2*v]-p.x)*ux+(PR[2*v+1]-p.z)*uz; if(d>m) m=d; }
  return m;
}
function trackWalls(car, dt, hooks){
  if(!WALLS) return;
  const B=bodyOf(car.carId);
  depthNow=Math.max(WALLK.DEPTH, Math.hypot(car.vx, car.vz)*dt+.3);
  if(!nearWalls(car.x, car.z, B, !FLAT, car.idx, car.cut, depthNow)) return;
  resolveWalls(car, B, detectTrack, hooks, dt);
}
// The car's track point moves to ni: the lap progress (car.prog, in track points) and the
// checkpoints follow.
function moveIdx(car, ni){
  let d=ni-car.idx; if(d>N/2) d-=N; if(d<-N/2) d+=N; car.prog+=d;
  if(d && GATES.length) passGates(car, car.idx, d);
  car.idx=ni;
}
// Checkpoints: car.gate is how many of GATES this lap has passed, in order. A step forward
// over the next one passes it, a step back over the last one un-passes it. A step longer
// than 60 points (a jump across the track) passes nothing.
function passGates(car, from, d){
  const g=car.gate|0;
  if(d>0 && d<60){ if(g<GATES.length && ((GATES[g]-from+N)%N)>0 && ((GATES[g]-from+N)%N)<=d) car.gate=g+1; }
  else if(d<0 && d>-60){ if(g>0 && ((from-GATES[g-1]+N)%N)<-d) car.gate=g-1; }
}
// A lap: once round (car.prog) with every checkpoint passed. Round without them (a
// section skipped): the lap does not count, and the next one starts at the line as usual.
function laps(car,hooks){
  if(car.prog>=N){ const ok=(car.gate|0)>=GATES.length; car.prog-=N; car.gate=0; if(ok) hooks.onLap(); }
}

// --- shortcuts ---
// Where (x, z) is on shortcut s: the nearest sample k, the offset to its left (lat), and
// whether it is inside the shortcut's walls (in) and on its asphalt (road).
const LOC = { k:0, lat:0, in:false, road:false, end:false };
function cutLocate(s, p, out=LOC){
  let k=0, bd=1e18; for(let i=0;i<s.n;i++){ const dx=p.x-s.x[i], dz=p.z-s.z[i], d=dx*dx+dz*dz; if(d<bd){bd=d;k=i;} }
  const rx=p.x-s.x[k], rz=p.z-s.z[k], along=rx*s.tx[k]+rz*s.tz[k];
  const end=(k===0 && along<0) || (k===s.n-1 && along>0);
  out.k=k; out.lat=rx*s.nx[k]+rz*s.nz[k]; out.end=end; out.in=!end && Math.abs(out.lat)<=s.lim; out.road=!end && Math.abs(out.lat)<=s.half+.3;
  return out;
}
// the shortcut (and where on it) whose walls contain (x, z), or null; with a margin (m),
// also one whose walls it is just outside of
function cutAt(p, margin=0){
  for(const s of SHORTCUTS){ const b=s.box; if(p.x<b[0]-margin || p.x>b[1]+margin || p.z<b[2]-margin || p.z>b[3]+margin) continue;
    const loc=cutLocate(s, p, { k:0, lat:0, in:false, road:false });
    if(loc.in || (margin && !loc.end && Math.abs(loc.lat)<=s.lim+margin)) return { s, loc }; }
  return null;
}
// the main track point a car at shortcut sample k counts as (its lap progress): from the
// point where the shortcut leaves to where it joins, in proportion
const cutIdx = (s, k) => (s.E + Math.round(s.span * k / (s.n - 1))) % N;
// Where the car is on the main road near shortcut s's two ends (searched around them, as
// the car's own track point is the shortcut's): the nearest point, the offset, inside the walls
const MN = { j:0, lat:0, in:false };
function mainNear(s, car){
  let bj=s.E, bd=1e18;
  for(const c of [s.E, s.X]) for(let k=-40;k<=40;k++){ const j=(c+k+N)%N, dx=P[j].x-car.x, dz=P[j].z-car.z, d=dx*dx+dz*dz; if(d<bd){bd=d;bj=j;} }
  const rx=car.x-P[bj].x, rz=car.z-P[bj].z;
  MN.j=bj; MN.lat=rx*NM[bj].x+rz*NM[bj].z;
  MN.in=Math.abs(MN.lat)<=WALL-WALL_ALLOW && Math.abs(rx*TG[bj].x+rz*TG[bj].z)<3;
  return MN;
}
// The road surface on a shortcut: its height, grade along it; no bank, no crest.
function cutSurface(s, car, out){
  const L=cutLocate(s, car, { k:0, lat:0, in:false, road:false }), k=L.k;
  const along=(car.x-s.x[k])*s.tx[k]+(car.z-s.z[k])*s.tz[k];
  out.y=s.y[k]+s.gr[k]*along; out.grade=s.gr[k]; out.curv=0; out.bank=0; out.lat=L.lat;
  out.gx=s.gr[k]*s.tx[k]; out.gz=s.gr[k]*s.tz[k]; out.tx=s.tx[k]; out.tz=s.tz[k];
  return out;
}
// constrainToTrack on a map with shortcuts. The car is on the main road (car.cut -1) or
// on shortcut car.cut. The space it may drive in is the main road's walls together with
// the shortcuts' walls: inside either, nothing stops it; outside both, it hits the walls
// of the road it is on. It changes road where it is inside one road's walls and not the
// other's (the main road's walls are open where a shortcut passes through them). On a
// shortcut its track point (car.idx) runs from where the shortcut leaves the main road
// to where it joins, so the lap progress and the checkpoints count it as the bit of road
// it skips.
function constrainWithCuts(car,dt,hooks){
  let s=car.cut>=0 ? SHORTCUTS[car.cut] : null, onRoad=false;
  if(!s){
    const ni=nearest(car,false); moveIdx(car, ni);
    const p=P[ni], n=NM[ni], lat=(car.x-p.x)*n.x+(car.z-p.z)*n.z, lim=WALL-WALL_ALLOW;
    const c=Math.abs(lat)>HALF ? cutAt(car) : null;
    if(c && Math.abs(lat)>lim){ s=c.s; car.cut=s.k; }                    // through the gap in the wall: onto the shortcut
    else onRoad=Math.abs(lat)<=HALF+CURB || (c && c.loc.road);
  }
  if(s){
    const L=cutLocate(s, car), m=mainNear(s, car);
    if(m.in && !L.in){ car.cut=-1; moveIdx(car, m.j); onRoad=Math.abs(m.lat)<=HALF+CURB; }   // back on the main road
    else {
      moveIdx(car, cutIdx(s, L.k));
      onRoad=L.road || (m.in && Math.abs(m.lat)<=HALF+CURB);
    }
  }
  trackWalls(car, dt, hooks);
  car.off=!onRoad;
  if(car.off && !car.air){ const k=Math.exp(-VDRAG*dt); car.vx*=k; car.vz*=k; }
  if(!FLAT) vertical(car,dt,hooks);
  laps(car,hooks);
}

// How to draw a car on the road: its height, and pitch and roll (radians, for a
// rotation order 'YXZ' with rotation.y = car.h) from the road under it. In the air the
// body keeps the attitude it left the road with, the nose dropping slowly.
export function carPose(car, dt, out){
  out = out || { y:0, pitch:0, roll:0, squash:0 };
  if(FLAT || car.idx===undefined){ out.y=0; out.pitch=0; out.roll=0; out.squash=0; return out; }
  const fx=Math.sin(car.h), fz=Math.cos(car.h), rx=Math.cos(car.h), rz=-Math.sin(car.h);
  let pitch, roll;
  if(car.air){ pitch=out.pitch+(.12-out.pitch)*Math.min(1,dt*.8); roll=out.roll*(1-Math.min(1,dt*2)); }
  else { const S=surface(car); pitch=-Math.atan(S.gx*fx+S.gz*fz); roll=Math.atan(S.gx*rx+S.gz*rz); }
  const k=Math.min(1,dt*12);
  out.pitch+=(pitch-out.pitch)*(car.air?1:k); out.roll+=(roll-out.roll)*(car.air?1:k);
  out.y=car.y===undefined?0:car.y;
  car.squash=(car.squash||0)*Math.exp(-6*dt); out.squash=car.squash;
  return out;
}
