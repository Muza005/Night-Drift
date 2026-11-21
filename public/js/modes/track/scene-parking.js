// The car park of «Паркинг» (maps with a `building`): floor slabs with their ceilings,
// columns, parapets, the decks of the ramp towers, painted bays and parked cars, strip
// lights under the ceilings and their pools of light, the sign on the front. Called by
// scene.js build(); everything goes into the map's group B (disposed on a map change).
// Cheap on purpose: a dozen instanced meshes, no real lights (the strips glow, the pools
// are additive planes), so a floor full of columns still runs at 60 fps.
import { cv, tex, glowTex } from '../../core/render.js';
import { P, Y, N, WALL, LEVELS, MAP } from './geometry.js';
import { layout, COL } from './building.js';

const concrete = (base, spots) => { const [c,g]=cv(128,128); g.fillStyle=base; g.fillRect(0,0,128,128);
  const id=g.getImageData(0,0,128,128); for(let k=0;k<id.data.length;k+=4){ const n=(Math.random()-.5)*spots; id.data[k]+=n; id.data[k+1]+=n; id.data[k+2]+=n; } g.putImageData(id,0,0);
  const t=tex(c,true); return t; };
const slabTex = concrete('#4a4d57', 18);
const slabMat = new THREE.MeshStandardMaterial({ map: slabTex, roughness: .92, color: 0xffffff });
const floorMat = new THREE.MeshStandardMaterial({ map: slabTex, roughness: .9, color: 0x8a8d96 });     // the ground floor
// The ceilings (the slabs' and decks' undersides): pale concrete with the joints of the
// formwork and a beam every 8 m, glowing a little as if lit by the strip lights (no real
// light reaches them: the hemisphere light shades a face turned down very dark).
const ceilTex = (() => { const [c,g]=cv(256,256); g.fillStyle='#8a8e9c'; g.fillRect(0,0,256,256);
  const id=g.getImageData(0,0,256,256); for(let k=0;k<id.data.length;k+=4){ const n=(Math.random()-.5)*14; id.data[k]+=n; id.data[k+1]+=n; id.data[k+2]+=n; } g.putImageData(id,0,0);
  g.fillStyle='rgba(40,42,52,.22)'; g.fillRect(0,0,256,5); g.fillStyle='rgba(30,32,40,.18)'; for(let k=64;k<256;k+=64){ g.fillRect(k,0,2,256); g.fillRect(0,k,256,2); }
  return tex(c,true); })();
const ceilMat = new THREE.MeshStandardMaterial({ map: ceilTex, color: 0x6a6e7a, roughness: .95, emissive: 0xffffff, emissiveMap: ceilTex, emissiveIntensity: .22, side: THREE.DoubleSide });
// the decks under the ramps: the same, mapped along the road (u across its 16.6 m, v one
// tile per 8 m: two tiles across, not the slabs' repeat, which ringed into moiré there)
const deckTex = ceilTex.clone(); deckTex.needsUpdate = true; deckTex.repeat.set(2, 1);
const deckMat = ceilMat.clone(); deckMat.map = deckTex; deckMat.emissiveMap = deckTex;
const colMat = new THREE.MeshStandardMaterial({ color: 0x6d707a, roughness: .85 });
// yellow and black hazard stripes round the foot of a column
const hazardTex = (() => { const [c,g]=cv(64,64); g.fillStyle='#14151a'; g.fillRect(0,0,64,64); g.fillStyle='#ffc23d';
  for(let k=-64;k<128;k+=32){ g.beginPath(); g.moveTo(k,64); g.lineTo(k+16,64); g.lineTo(k+80,0); g.lineTo(k+64,0); g.fill(); } return tex(c,true); })();
export const hazardMat = new THREE.MeshStandardMaterial({ map: hazardTex, roughness: .6, emissive: 0xffffff, emissiveMap: hazardTex, emissiveIntensity: .22 });
const bayMat = new THREE.MeshBasicMaterial({ color: 0xdfe4f2, transparent: true, opacity: .75, depthWrite: false });
const carMat = new THREE.MeshStandardMaterial({ roughness: .35, metalness: .55 });
const glassMat = new THREE.MeshStandardMaterial({ color: 0x0a0c14, roughness: .15, metalness: .8 });
const stripMat = new THREE.MeshBasicMaterial({ color: 0xeaf4ff, toneMapped: false });
const poolMat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0xd6e4ff, transparent: true, opacity: .22, blending: THREE.AdditiveBlending, depthWrite: false });
// a soft glow on the ceiling round every strip, so the lights read as lights
const haloMat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0xe4eeff, transparent: true, opacity: .5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const signTex = (() => { const [c,g]=cv(512,256); g.clearRect(0,0,512,256);
  g.shadowColor='#3ef0ff'; g.shadowBlur=24; g.fillStyle='#3ef0ff'; g.font='bold 210px sans-serif'; g.textBaseline='middle'; g.fillText('P',22,132);
  g.shadowColor='#ff3b6b'; g.fillStyle='#ff6f91'; g.font='bold 60px sans-serif'; g.fillText('ПАРКИНГ',168,132);
  return tex(c,false); })();
const signMat = new THREE.MeshBasicMaterial({ map: signTex, transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide });

const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), V = new THREE.Vector3(), S = new THREE.Vector3();
function instanced(geo, mat, items, place){
  if(!items.length) return null;
  const im=new THREE.InstancedMesh(geo, mat, items.length);
  items.forEach((it, k) => { place(it, k); im.setMatrixAt(k, M); });
  return im;
}
const at = (x, y, z, ang, sx=1, sy=1, sz=1) => { E.set(0, ang, 0); Q.setFromEuler(E); M.compose(V.set(x, y, z), Q, S.set(sx, sy, sz)); };

// B: the group to add to; ribbon and vribbon: scene.js's strips along the track (a flat
// one between two offsets, an upright one at an offset), for the decks under the raised
// roads outside the building and their edges
export function buildParking(B, { ribbon, vribbon }){
  const b = MAP.building, F = b.floors, slab = LEVELS.slab, L = layout();
  const w = b.x1 - b.x0, d = b.z1 - b.z0, cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
  // the ground floor's concrete, then a slab under every upper floor and the roof
  { const g = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), floorMat); g.position.set(cx, -.008, cz); g.receiveShadow = true; B.add(g); }
  slabTex.repeat.set(w / 6, d / 6); ceilTex.repeat.set(w / 8, d / 8);
  // (the box's faces: +x, -x, +y, -y, +z, -z; the bottom one is a ceiling)
  const faces = [slabMat, slabMat, slabMat, ceilMat, slabMat, slabMat];
  for(const f of F) if(f > 0){
    const s = new THREE.Mesh(new THREE.BoxGeometry(w, slab, d), faces);
    s.position.set(cx, f - .006 - slab / 2, cz); s.castShadow = true; s.receiveShadow = true; B.add(s); }
  // decks under the roads outside the building that are off the ground (the towers'
  // ramps, the links to the building, the bridge to the east tower)
  const out = i => Y[i] < .3 || (P[i].x > b.x0 && P[i].x < b.x1 && P[i].z > b.z0 && P[i].z < b.z1);
  const skip = i => out(i) || out((i + 1) % N);
  { const deck = new THREE.Mesh(ribbon(-WALL - .3, WALL + .3, -slab, 8, null, skip), deckMat); deck.castShadow = true; deck.receiveShadow = true; B.add(deck); }
  for(const s of [1, -1]){ const side = new THREE.Mesh(vribbon(s * (WALL + .3), -slab, .05, skip), colMat); side.castShadow = true; B.add(side); }
  // columns (the hazard sleeve on their foot), the towers' cores
  const cols = instanced(new THREE.BoxGeometry(COL, 1, COL).translate(0, .5, 0), colMat, L.columns, ([x, z, y0, y1]) => at(x, y0, z, 0, 1, y1 - y0, 1));
  if(cols){ cols.castShadow = true; cols.receiveShadow = true; B.add(cols); }
  const sleeves = instanced(new THREE.BoxGeometry(COL + .03, .9, COL + .03).translate(0, .45, 0), hazardMat, L.columns, ([x, z, y0]) => at(x, y0, z, 0));
  if(sleeves) B.add(sleeves);
  for(const t of L.towers){ const c = new THREE.Mesh(new THREE.CylinderGeometry(t.core, t.core, t.y1, 24).translate(0, t.y1 / 2, 0), colMat);
    c.position.set(t.x, 0, t.z); c.castShadow = true; B.add(c);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(t.core + .03, t.core + .03, .9, 24).translate(0, .45, 0), hazardMat);
    band.position.set(t.x, 0, t.z); B.add(band); }
  // parapets round the slab edges
  const par = instanced(new THREE.BoxGeometry(2.02, 1.05, .25).translate(0, .525, 0), colMat, L.parapets, ([x, z, y, a]) => at(x, y, z, a));
  if(par){ par.castShadow = true; par.receiveShadow = true; B.add(par); }
  // painted bays and parked cars
  const lines = instanced(new THREE.PlaneGeometry(.13, 5.2).rotateX(-Math.PI / 2), bayMat, L.lines, ([x, z, y, a]) => at(x, y + .016, z, a + Math.PI / 2));
  if(lines){ lines.renderOrder = 1; B.add(lines); }
  const paint = [0x8c2b2b, 0x2b4f8c, 0xd8d8de, 0x1d1f26, 0x6b6f78, 0x8c6a2b].map(c => new THREE.Color(c));
  const body = instanced(new THREE.BoxGeometry(1.8, .7, 4.3).translate(0, .62, 0), carMat, L.cars, ([x, z, y, a]) => at(x, y, z, a));
  if(body){ L.cars.forEach((c, k) => body.setColorAt(k, paint[c[4]])); body.instanceColor.needsUpdate = true; body.castShadow = true; B.add(body); }
  const cabin = instanced(new THREE.BoxGeometry(1.6, .55, 2.2).translate(0, 1.24, -.2), glassMat, L.cars, ([x, z, y, a]) => at(x, y, z, a));
  if(cabin) B.add(cabin);
  // the strip lights and the light they throw on the floor
  const strips = instanced(new THREE.BoxGeometry(.2, .06, 2.4), stripMat, L.lights, ([x, y, z, a]) => at(x, y, z, a));
  if(strips) B.add(strips);
  const halos = instanced(new THREE.PlaneGeometry(1.8, 3.6).rotateX(Math.PI / 2), haloMat, L.lights, ([x, y, z, a]) => at(x, y + .02, z, a));
  if(halos){ halos.renderOrder = 2; B.add(halos); }
  const pools = instanced(new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2), poolMat, L.pools, ([x, y, z]) => at(x, y + .06, z, 0));
  if(pools){ pools.renderOrder = 2; B.add(pools); }
  // the signs on the roof's south and west edges, each on two posts
  for(const [x, z, a] of [[b.x0 + w * .3, b.z1 - .4, 0], [b.x0 + .4, cz, -Math.PI / 2]]){
    const g = new THREE.Group(); g.position.set(x, F[F.length - 1], z); g.rotation.y = a;
    const s = new THREE.Mesh(new THREE.PlaneGeometry(16, 8), signMat); s.position.set(0, 5.6, .3); g.add(s);
    for(const px of [-5, 5]){ const p = new THREE.Mesh(new THREE.BoxGeometry(.3, 5.4, .3).translate(0, 2.7, 0), colMat); p.position.set(px, 0, 0); g.add(p); }
    B.add(g); }
}
