// Plan 3, stage 2: the track's walls as polylines, one source for what is drawn (scene.js,
// the ?debug=hit overlay, the map scan) and, from stage 3, for collisions (wallsNear).
// Pure: no DOM, no rendering, no imports from geometry.js (geometry.js builds them in
// setMap from its own arrays, see buildWalls), so Node runs it.
//
// The walls are the boundary of the drivable space: the main road's corridor out to its
// walls (the offset line safeOffsets(±WALL): pulled in on the inside of hairpins) together
// with each shortcut's corridor (its centre line ± its wall offset). Where a shortcut leaves
// or joins the main road its two walls cross the main road's wall: the main wall opens
// between the two crossings and the shortcut's walls start there. Each crossing is a corner
// of wall poking into the drivable space (a "blade" when the shortcut meets the road at a
// shallow angle): it is rounded off by an arc of radius FILLET.R (tangent to both walls),
// so the wall runs on without a gap and without a sharp end.
//
// Every polyline is oriented with the drivable space on its right (for the direction
// d = (dx, dz) the right is (-dz, dx); the track's NM, "left", is (dz, -dx)), and the
// pieces are joined end to start into chains: closed loops on every map. Segments carry
// their normal into the drivable space.
//
// Collision query (stage 3): wallsNear(W, x, z, y, r, out) - the wall segments within r m
// of (x, z) at about height y (on a map with storeys, the car's own storey), each with the
// closest point, the distance and the normal. The segments sit in an 8 m grid.

export const CELL = 8;                 // m: the grid of the segments
export const FILLET = { R: 5, RMIN: 4, MAXD: 18, STEP: .5 };   // m: arc radius, smallest allowed, longest trim, arc point spacing

// Offset curves that never fold (geometry.js safeOffsets): offset `off` for every track
// point, limited on the inside of a turn to 0.9 × the local radius (a running minimum over
// ±W points, then a running average over ±W/2).
export function safeOffsetsOf(N, RAD, off, W = 8){
  const lim=new Float64Array(N);
  for(let i=0;i<N;i++){ const r=RAD[i]; lim[i] = (off*r<0) ? 0.9*Math.abs(r) : 1e9; }
  const m=new Float64Array(N);
  for(let i=0;i<N;i++){ let v=1e9; for(let k=-W;k<=W;k++) v=Math.min(v, lim[(i+k+N)%N]); m[i]=v; }
  const out=new Float64Array(N), h=W>>1, a=Math.abs(off);
  for(let i=0;i<N;i++){ let s=0; for(let k=-h;k<=h;k++) s+=Math.min(a, m[(i+k+N)%N]); out[i]=Math.sign(off)*s/(2*h+1); }
  return out;
}
// An offset line along the track (per-point offsets O), on the banked road plus yOff; a
// point that would step back along the track is pulled onto the previous one
export function offsetLineOf(g, O, yOff = 0){
  const { N, P, NM, TG, Y, TB } = g, x=new Float64Array(N), y=new Float64Array(N), z=new Float64Array(N);
  for(let i=0;i<N;i++){ const o=O[i]; x[i]=P[i].x+NM[i].x*o; z[i]=P[i].z+NM[i].z*o; y[i]=Y[i]+o*TB[i]+yOff; }
  for(let pass=0;pass<2;pass++) for(let i=0;i<N;i++){ const j=(i+1)%N, t=TG[i];
    if((x[j]-x[i])*t.x+(z[j]-z[i])*t.z<0){ x[j]=x[i]; z[j]=z[i]; } }
  return {x,y,z};
}

// a piece of wall: points {x, y, z, i (main track point or -1), s (side: 1 left, -1 right)}
const pt = (x, y, z, i, s) => ({ x, y, z, i, s });
// segments a→b and c→d: the parameters (t on a→b, u on c→d) where they cross, or null
function cross2(ax, az, bx, bz, cx, cz, dx, dz){
  const ex=bx-ax, ez=bz-az, fx=dx-cx, fz=dz-cz, den=ex*fz-ez*fx;
  if(Math.abs(den)<1e-12) return null;
  const wx=cx-ax, wz=cz-az, t=(wx*fz-wz*fx)/den, u=(wx*ez-wz*ex)/den;
  return t>=0 && t<=1 && u>=0 && u<=1 ? { t, u } : null;
}

// g: { N, P, NM, TG, Y, TB, RAD, WALL, SHORTCUTS, SAME_LEVEL, LEVELS }
export function buildWalls(g){
  const { N, WALL, SHORTCUTS } = g, problems = [];
  // main walls: per side, the offset line and its crossings with the shortcuts' walls
  const main = {};
  for(const s of [1,-1]){ const O=safeOffsetsOf(N, g.RAD, s*WALL), L=offsetLineOf(g, O, 0); main[s]={ s, O, ...L, hits:[] }; }
  // shortcut walls: per shortcut and side, the line and the two crossings (entry, exit)
  const cuts = [];
  const W = 90;                                 // track points searched round each end
  for(const sc of SHORTCUTS) for(const s2 of [1,-1]){
    const o=s2*sc.wall, n=sc.n, x=new Float64Array(n), z=new Float64Array(n), y=Float64Array.from(sc.y);
    for(let k=0;k<n;k++){ x[k]=sc.x[k]+sc.nx[k]*o; z[k]=sc.z[k]+sc.nz[k]*o; }
    const C={ sc, s:s2, x, y, z, n, ends:[null,null] };
    const find=(c, ks)=>{ for(const k of ks){ let best=null;
        for(const s of [1,-1]){ const M=main[s];
          for(let q=-W;q<=W;q++){ const i=(c+q+N)%N, j=(i+1)%N;
            const h=cross2(x[k], z[k], x[k+1], z[k+1], M.x[i], M.z[i], M.x[j], M.z[j]);
            if(h && (!best || h.t<best.t)) best={ s, i, u:h.u, k, t:h.t }; } }
        if(best) return best; }
      return null; };
    const fwd=[...Array(n-1).keys()];
    const e0=find(sc.E, fwd), e1=find(sc.X, fwd.slice().reverse());
    if(!e0 || !e1){ problems.push(`shortcut ${sc.k} side ${s2}: its wall does not cross the main road's`); continue; }
    if(e0.k>=e1.k){ problems.push(`shortcut ${sc.k} side ${s2}: no wall left between the two crossings`); continue; }
    for(const [e, end] of [[e0,0],[e1,1]]){
      const M=main[e.s], j=(e.i+1)%N, X=M.x[e.i]+(M.x[j]-M.x[e.i])*e.u, Z=M.z[e.i]+(M.z[j]-M.z[e.i])*e.u;
      const ym=M.y[e.i]+(M.y[j]-M.y[e.i])*e.u, yc=y[e.k]+(y[e.k+1]-y[e.k])*e.t;
      e.p={ x:X, z:Z, ym, yc }; e.end=end; e.cut=C;
      C.ends[end]=e; M.hits.push(e); }
    cuts.push(C);
  }
  // pieces, each oriented with the drivable space on its right
  const pieces = [];
  for(const s of [1,-1]){ const M=main[s];
    // the gaps: per shortcut end, between the crossings of its two walls (along the track)
    const by=new Map();
    for(const h of M.hits){ const key=h.cut.sc.k+':'+h.end; if(!by.has(key)) by.set(key, []); by.get(key).push(h); }
    const gaps=[];
    for(const [key, hs] of by){
      if(hs.length!==2){ problems.push(`shortcut end ${key}: ${hs.length} crossing(s) with the ${s>0?'left':'right'} wall`); continue; }
      let [a, b]=hs; const pa=a.i+a.u, pb=b.i+b.u; let d=pb-pa; if(d>N/2) d-=N; if(d<-N/2) d+=N;
      if(d<0) [a, b]=[b, a];
      gaps.push({ a, b, from:a.i+a.u });
    }
    gaps.sort((p, q) => p.from-q.from);
    const P=(i)=>pt(M.x[i], M.y[i], M.z[i], i, s), H=(h)=>pt(h.p.x, h.p.ym, h.p.z, -1, s);
    let list=[];
    if(!gaps.length){ const a=[]; for(let i=0;i<N;i++) a.push(P(i)); list.push({ pts:a, closed:true }); }
    else for(let q=0;q<gaps.length;q++){
      // from the end of gap q to the start of gap q+1 (round the ring): the crossing, the
      // track points after it up to the segment of the next crossing, that crossing
      const g0=gaps[q], g1=gaps[(q+1)%gaps.length], a=[H(g0.b)];
      let cnt=(g1.a.i-g0.b.i+N)%N; if(cnt===0 && (gaps.length===1 || g1.a.u<g0.b.u)) cnt=N;
      for(let m=1;m<=cnt;m++) a.push(P((g0.b.i+m)%N));
      a.push(H(g1.a));
      list.push({ pts:a, closed:false, start:g0.b, end:g1.a });
    }
    for(const p of list){ if(s<0){ p.pts.reverse(); [p.start, p.end]=[p.end, p.start]; } pieces.push({ ...p, kind:'main', s }); }
  }
  for(const C of cuts){ const [e0, e1]=C.ends, a=[pt(e0.p.x, e0.p.yc, e0.p.z, -1, C.s)];
    for(let k=e0.k+1;k<=e1.k;k++) a.push(pt(C.x[k], C.y[k], C.z[k], -1, C.s));
    a.push(pt(e1.p.x, e1.p.yc, e1.p.z, -1, C.s));
    const p={ pts:a, closed:false, start:e0, end:e1, kind:'cut', s:C.s, cut:C.sc.k };
    if(C.s<0){ p.pts.reverse(); [p.start, p.end]=[p.end, p.start]; }
    pieces.push(p); }
  for(const p of pieces) dedupe(p);
  // the corners: every crossing ends one piece and starts another; round it off
  const fillets = [], byStart=new Map(), byEnd=new Map();
  for(const p of pieces) if(!p.closed){ byStart.set(p.start, p); byEnd.set(p.end, p); }
  const hits=[...new Set([...byStart.keys(), ...byEnd.keys()])], plan=[];
  for(const h of hits){ const A=byEnd.get(h), B=byStart.get(h);
    if(!A || !B){ problems.push(`a wall end at x ${h.p.x.toFixed(0)} z ${h.p.z.toFixed(0)} joins nothing`); continue; }
    const th=cornerAngle(A, B); if(th===null) continue;
    plan.push({ h, A, B, th, d:Math.min(FILLET.MAXD, FILLET.R/Math.tan(th/2)) }); }
  // a piece between two corners shares its length between their trims (a small island
  // between a shortcut and a hairpin: both arcs shrink alike)
  for(const p of pieces){ const at=plan.filter(c=>c.A===p || c.B===p), L=.995*plen(p.pts), need=at.reduce((a, c)=>a+c.d, 0);
    if(need>L) for(const c of at) c.d*=L/need; }
  for(const c of plan){ const f=fillet(c.A, c.B, c.d, problems); if(f) fillets.push(f); }
  // chains: pieces joined end to start
  const lines=[], used=new Set();
  for(const p0 of pieces){ if(used.has(p0)) continue;
    if(p0.closed){ used.add(p0); lines.push(chain([p0], true)); continue; }
    // walk back to the start of an open chain (or round a loop)
    let p=p0, guard=0; while(guard++<pieces.length){ const q=byEnd.get(p.start); if(!q || q===p0 || used.has(q)) break; p=q; }
    const seq=[]; let closed=false;
    for(let q=p;q && !used.has(q);){ used.add(q); seq.push(q); const nx=byStart.get(q.end); if(nx===seq[0]){ closed=true; break; } q=nx; }
    lines.push(chain(seq, closed));
  }
  const W2 = { lines, fillets, problems, sameLevel: g.SAME_LEVEL || 3, gap: g.LEVELS ? g.LEVELS.gap : 0 };
  index(W2);
  return W2;
}
function dedupe(p){ const a=[p.pts[0]]; for(let k=1;k<p.pts.length;k++){ const q=a[a.length-1], r=p.pts[k]; if(Math.hypot(r.x-q.x, r.z-q.z)>1e-6) a.push(r); else if(r.i<0) a[a.length-1]=r; }
  if(p.closed && a.length>1 && Math.hypot(a[0].x-a[a.length-1].x, a[0].z-a[a.length-1].z)<=1e-6) a.pop();
  p.pts=a; }
const plen=pts=>{ let L=0; for(let k=1;k<pts.length;k++) L+=Math.hypot(pts[k].x-pts[k-1].x, pts[k].z-pts[k-1].z); return L; };
// the point on polyline pts (walked from its end `fromEnd` or its start) at straight-line
// distance d from that end: { k (the index of the first point kept), p }
function atDist(pts, d, fromEnd){
  const n=pts.length, o=fromEnd?pts[n-1]:pts[0];
  for(let m=1;m<n;m++){ const a=fromEnd?pts[n-m]:pts[m-1], b=fromEnd?pts[n-1-m]:pts[m];
    const da=Math.hypot(a.x-o.x, a.z-o.z), db=Math.hypot(b.x-o.x, b.z-o.z);
    if(db>=d){ // solve |a + (b-a)f - o| = d on this segment
      const ex=b.x-a.x, ez=b.z-a.z, wx=a.x-o.x, wz=a.z-o.z, A=ex*ex+ez*ez, B=2*(ex*wx+ez*wz), C=wx*wx+wz*wz-d*d;
      const f=A>0 ? Math.max(0, Math.min(1, (-B+Math.sqrt(Math.max(0, B*B-4*A*C)))/(2*A))) : 0;
      const p=pt(a.x+ex*f, a.y+(b.y-a.y)*f, a.z+ez*f, -1, a.s);
      return { k: fromEnd ? n-1-m : m, p, ok:true };
    } }
  return { ok:false };
}
// the angle between the walls of the corner where piece A ends and piece B starts, away
// from the corner (measured over 3 m), or null when they run straight on
function cornerAngle(A, B){
  const I=A.pts[A.pts.length-1], d=Math.min(3, .3*plen(A.pts), .3*plen(B.pts)), ta=atDist(A.pts, d, true), tb=atDist(B.pts, d, false);
  if(!ta.ok || !tb.ok) return null;
  const th=Math.acos(Math.max(-1, Math.min(1, ((ta.p.x-I.x)*(tb.p.x-I.x)+(ta.p.z-I.z)*(tb.p.z-I.z))/(d*d))));
  return th>Math.PI-.02 ? null : th;
}
// Rounds that corner: trims A to the point T_A at distance d from the corner and puts in an
// arc tangent to A's segment there and to B's segment near the point at d along B (it ends
// where it touches that segment's line, T_B; B then starts with the arc). Its radius comes
// out about d·tan(θ/2), θ the angle between the walls.
function fillet(A, B, d, problems){
  const I=A.pts[A.pts.length-1], ta=atDist(A.pts, d, true), tb=atDist(B.pts, d, false);
  if(!ta.ok || !tb.ok){ problems.push(`corner at x ${I.x.toFixed(0)} z ${I.z.toFixed(0)}: walls too short to round`); return null; }
  const unit=(p, q)=>{ const x=q.x-p.x, z=q.z-p.z, l=Math.hypot(x, z)||1; return [x/l, z/l]; };
  // the arc: tangent to A's segment at T_A, and to the segment of B it ends on (searched
  // from the one at d along B: the arc may end on a neighbour where B bends)
  const tA=unit(A.pts[ta.k], A.pts[ta.k+1]);
  let j=tb.k, tB, r=NaN, cx, cz, ex, ez, s0, s1, sl, ok=false;
  for(let it=0;it<8;it++){
    s0=B.pts[j-1]; s1=B.pts[j]; tB=unit(s0, s1); sl=Math.hypot(s1.x-s0.x, s1.z-s0.z)||1;
    const cr=tA[0]*tB[1]-tA[1]*tB[0], sg=cr>=0?1:-1, nA=[-tA[1]*sg, tA[0]*sg], nB=[-tB[1]*sg, tB[0]*sg];
    const den=1-(nA[0]*nB[0]+nA[1]*nB[1]);
    r=den>1e-9 ? ((ta.p.x-s0.x)*nB[0]+(ta.p.z-s0.z)*nB[1])/den : NaN;
    if(!(r>0)) break;
    cx=ta.p.x+nA[0]*r; cz=ta.p.z+nA[1]*r; ex=cx-nB[0]*r; ez=cz-nB[1]*r;
    const f=((ex-s0.x)*tB[0]+(ez-s0.z)*tB[1])/sl;
    if(f>1+1e-6 && j<B.pts.length-1) j++; else if(f<-1e-6 && j>1) j--; else { ok=f>-.02 && f<1.02; break; }
  }
  if(!ok){
    // no segment fits (a small island's tip): the arc tangent to the chords from the corner
    // to the two points at d instead
    const ua=[(ta.p.x-I.x)/d, (ta.p.z-I.z)/d], ub=[(tb.p.x-I.x)/d, (tb.p.z-I.z)/d];
    const t2=Math.acos(Math.max(-1, Math.min(1, ua[0]*ub[0]+ua[1]*ub[1])));
    let bx=ua[0]+ub[0], bz=ua[1]+ub[1]; const bl=Math.hypot(bx, bz)||1; bx/=bl; bz/=bl;
    const cd=d/Math.cos(t2/2); r=d*Math.tan(t2/2); cx=I.x+bx*cd; cz=I.z+bz*cd; ex=tb.p.x; ez=tb.p.z;
    j=tb.k; s0=B.pts[j-1]; s1=B.pts[j]; tB=unit(s0, s1); sl=Math.hypot(s1.x-s0.x, s1.z-s0.z)||1;
  }
  const th=Math.PI-Math.acos(Math.max(-1, Math.min(1, tA[0]*tB[0]+tA[1]*tB[1])));
  if(r<FILLET.RMIN-1e-6) problems.push(`corner at x ${I.x.toFixed(0)} z ${I.z.toFixed(0)}: arc radius ${r.toFixed(2)} m (the walls are too short for ${FILLET.RMIN} m)`);
  // where on B's segment the arc ends: its height, and whether it ends past the segment's end
  const fc=Math.max(0, Math.min(1, ((ex-s0.x)*tB[0]+(ez-s0.z)*tB[1])/sl)), tbp=pt(ex, s0.y+(s1.y-s0.y)*fc, ez, -1, s0.s);
  let from=j; while(from<B.pts.length-1 && (B.pts[from].x-ex)*tB[0]+(B.pts[from].z-ez)*tB[1]<.05) from++;   // (B's points the arc passed)
  const a0=Math.atan2(ta.p.z-cz, ta.p.x-cx); let sw=Math.atan2(ez-cz, ex-cx)-a0;
  while(sw>Math.PI) sw-=2*Math.PI; while(sw<-Math.PI) sw+=2*Math.PI;
  const m=Math.max(2, Math.ceil(Math.max(Math.abs(sw)*r/FILLET.STEP, Math.abs(sw)/(6*Math.PI/180))));
  const arc=[];
  for(let q=1;q<m;q++){ const a=a0+sw*q/m, u=q/m; arc.push(pt(cx+Math.cos(a)*r, ta.p.y+(tbp.y-ta.p.y)*u, cz+Math.sin(a)*r, -1, A.s)); }
  // the space the arc opens: from the corner back along A to the arc, the arc, along B back
  // to the corner (scene.js fills it with run-off, a fan from the corner)
  const fill=[...A.pts.slice(ta.k+1, -1).reverse(), ta.p, ...arc, tbp, ...B.pts.slice(1, from).reverse()];
  A.pts=[...A.pts.slice(0, ta.k+1), ta.p];
  B.pts=[...arc, tbp, ...B.pts.slice(from)];
  return { x:I.x, y:I.y, z:I.z, r, theta:th, d, cx, cz, arc:[ta.p, ...arc, tbp], fill, main:A.kind==='main'?A.s:B.s, cut:A.kind==='cut'?A.cut:B.cut };
}
// a chain: points x, y, z, the main track point per point (i, or -1), the side per segment
// (s: the colour of the neon), closed or open; the normals into the drivable space per
// segment (nx, nz) and per point (px, pz: the average of its two segments')
function chain(seq, closed){
  const all=[]; for(const p of seq) for(const q of p.pts){ const l=all[all.length-1]; if(l && Math.hypot(l.x-q.x, l.z-q.z)<=1e-6) continue; all.push(q); }
  if(closed && all.length>1 && Math.hypot(all[0].x-all[all.length-1].x, all[0].z-all[all.length-1].z)<=1e-6) all.pop();
  const n=all.length, ns=closed?n:n-1;
  const L={ n, closed, x:new Float64Array(n), y:new Float64Array(n), z:new Float64Array(n), i:new Int32Array(n), s:new Int8Array(n),
    nx:new Float64Array(ns), nz:new Float64Array(ns), px:new Float64Array(n), pz:new Float64Array(n), kinds:[...new Set(seq.map(p=>p.kind))] };
  all.forEach((q, k)=>{ L.x[k]=q.x; L.y[k]=q.y; L.z[k]=q.z; L.i[k]=q.i; L.s[k]=q.s; });
  for(let k=0;k<ns;k++){ const j=(k+1)%n, dx=L.x[j]-L.x[k], dz=L.z[j]-L.z[k], l=Math.hypot(dx, dz)||1; L.nx[k]=-dz/l; L.nz[k]=dx/l; }
  for(let k=0;k<n;k++){ const a=closed?(k-1+n)%n:k-1, b=closed||k<ns?k:-1;
    let x=0, z=0; if(a>=0){ x+=L.nx[a]; z+=L.nz[a]; } if(b>=0){ x+=L.nx[b]; z+=L.nz[b]; } const l=Math.hypot(x, z)||1; L.px[k]=x/l; L.pz[k]=z/l; }
  return L;
}

// --- the collision query ---
// segments: SEG (stride 9: ax, az, bx, bz, ay, by, nx, nz, length), the line and point
// index of each, and the grid (cell → segment ids)
function index(W){
  let ns=0; for(const L of W.lines) ns+=L.closed?L.n:L.n-1;
  const SEG=new Float64Array(ns*9), line=new Int32Array(ns), at=new Int32Array(ns), grid=new Map();
  let id=0;
  for(let li=0;li<W.lines.length;li++){ const L=W.lines[li], m=L.closed?L.n:L.n-1;
    for(let k=0;k<m;k++,id++){ const j=(k+1)%L.n, o=id*9;
      SEG[o]=L.x[k]; SEG[o+1]=L.z[k]; SEG[o+2]=L.x[j]; SEG[o+3]=L.z[j]; SEG[o+4]=L.y[k]; SEG[o+5]=L.y[j]; SEG[o+6]=L.nx[k]; SEG[o+7]=L.nz[k];
      SEG[o+8]=Math.hypot(L.x[j]-L.x[k], L.z[j]-L.z[k]); line[id]=li; at[id]=k;
      const x0=Math.floor(Math.min(L.x[k], L.x[j])/CELL), x1=Math.floor(Math.max(L.x[k], L.x[j])/CELL);
      const z0=Math.floor(Math.min(L.z[k], L.z[j])/CELL), z1=Math.floor(Math.max(L.z[k], L.z[j])/CELL);
      for(let gx=x0;gx<=x1;gx++) for(let gz=z0;gz<=z1;gz++){ const c=key(gx, gz); let a=grid.get(c); if(!a) grid.set(c, a=[]); a.push(id); } } }
  W.SEG=SEG; W.segLine=line; W.segAt=at; W.nseg=ns; W.grid=grid; W.stamp=new Uint32Array(ns); W.tick=0;
}
const key=(gx, gz)=>(gx+32768)*65536+(gz+32768);
// The wall segments within r m of (x, z) whose height at the closest point is within
// W.sameLevel of y (pass y = NaN for any height). Fills out[0..count-1] (objects reused) with
//   seg     the segment id (W.SEG[seg*9...]: ax, az, bx, bz, ay, by, nx, nz, length)
//   t       where on it the closest point is (0..1; 0 or 1: one of its ends, a rounded end)
//   px, pz  the closest point; y: the wall's base height there
//   d       the distance from (x, z) to it
//   nx, nz  the segment's normal into the drivable space
//   side    (x, z) - closest point along that normal: > 0 on the drivable side, < 0 through the wall
// and returns the count, nearest first (entries past the count are stale).
export function wallsNear(W, x, z, y, r, out){
  const S=W.SEG, g=W.grid, st=W.stamp, tick=++W.tick, lev=W.sameLevel;
  if(tick>=0xffffffff){ st.fill(0); W.tick=1; }
  const gx0=Math.floor((x-r)/CELL), gx1=Math.floor((x+r)/CELL), gz0=Math.floor((z-r)/CELL), gz1=Math.floor((z+r)/CELL);
  let n=0;
  for(let gx=gx0;gx<=gx1;gx++) for(let gz=gz0;gz<=gz1;gz++){ const a=g.get(key(gx, gz)); if(!a) continue;
    for(let q=0;q<a.length;q++){ const id=a[q]; if(st[id]===W.tick) continue; st[id]=W.tick;
      const o=id*9, ax=S[o], az=S[o+1], ex=S[o+2]-ax, ez=S[o+3]-az, L2=ex*ex+ez*ez;
      let t=L2>0 ? ((x-ax)*ex+(z-az)*ez)/L2 : 0; t=t<0?0:t>1?1:t;
      const px=ax+ex*t, pz=az+ez*t, dx=x-px, dz=z-pz, d=Math.sqrt(dx*dx+dz*dz);
      if(d>r) continue;
      const wy=S[o+4]+(S[o+5]-S[o+4])*t;
      if(y===y && Math.abs(wy-y)>lev) continue;
      let e=out[n]; if(!e) e=out[n]={};
      e.seg=id; e.t=t; e.px=px; e.pz=pz; e.y=wy; e.d=d; e.nx=S[o+6]; e.nz=S[o+7]; e.side=dx*S[o+6]+dz*S[o+7]; n++;
    } }
  for(let k=1;k<n;k++){ const e=out[k]; let m=k; while(m>0 && out[m-1].d>e.d){ out[m]=out[m-1]; m--; } out[m]=e; }   // nearest first
  return n;
}
