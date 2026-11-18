// Car 3D model: a low coupe with a rounded body, a glass cabin, light strips and wheels
// with steering pivots. The shapes come from carShapes.js and are built once: every car
// of this kind (the player's and the other players') shares them.
import { scene, glowTex, carEnv } from './render.js';
import { coupeShape, wheelShape } from './carShapes.js';
import { setPaint, makeModel } from './carModels.js';
import { paintHex, carById } from './cars.js';

let SHAPE = null;
function shapes(){
  if(!SHAPE){
    SHAPE = { body: coupeShape('high'), wheel: wheelShape() };
    for(const part of [SHAPE.body, SHAPE.wheel]) for(const g of Object.values(part)) for(const one of [].concat(g)) if(one && one.isBufferGeometry) one.userData.shared = true;
  }
  return SHAPE;
}

export function makeCar(color, local){
  const { body: B, wheel: Wh } = shapes();
  const root=new THREE.Group(), body=new THREE.Group(); root.add(body);
  const paint=new THREE.MeshStandardMaterial({metalness:.55,roughness:.26,envMap:carEnv,envMapIntensity:1.1}); setPaint(paint,color);
  const dark=new THREE.MeshStandardMaterial({color:0x12141c,roughness:.6});
  const glass=new THREE.MeshStandardMaterial({color:0x101c30,metalness:.9,roughness:.08,envMap:carEnv,envMapIntensity:1.5});
  const add=(geo,mat,par=body)=>{ const o=new THREE.Mesh(geo,mat); o.castShadow=true; par.add(o); return o; };
  add(B.paint,paint); add(B.glass,glass); add(B.dark,dark);
  for(const g of B.flares) add(g,dark);
  add(B.stripes,new THREE.MeshBasicMaterial({color:0x3ef0ff,toneMapped:false})).castShadow=false;
  add(B.heads,new THREE.MeshBasicMaterial({color:0xf4f8ff,toneMapped:false})).castShadow=false;
  const tailMat=new THREE.MeshStandardMaterial({color:0x330008,emissive:0xff1a3c,emissiveIntensity:1.4});
  add(B.tails,tailMat).castShadow=false;
  const under=new THREE.Mesh(new THREE.PlaneGeometry(3.4,6).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({map:glowTex,color:local?0x3ef0ff:color,transparent:true,opacity:.55,blending:THREE.AdditiveBlending,depthWrite:false}));
  under.position.y=.06; root.add(under);
  const tire=new THREE.MeshStandardMaterial({color:0x0b0b0f,roughness:.9});
  const rim=new THREE.MeshStandardMaterial({color:0xb8bccc,metalness:.9,roughness:.3,envMap:carEnv});
  const wheels=[], pivots=[];
  for(const [x,z,front] of [[B.wheelX,B.wheelZ[0],1],[-B.wheelX,B.wheelZ[0],1],[B.wheelX,B.wheelZ[1],0],[-B.wheelX,B.wheelZ[1],0]]){
    const pivot=new THREE.Group(); pivot.position.set(x,.38,z); root.add(pivot);
    const spin=new THREE.Group(); pivot.add(spin);
    add(Wh.tyre,tire,spin); spin.add(new THREE.Mesh(Wh.rim,rim));
    wheels.push(spin); if(front) pivots.push(pivot);
  }
  if(local){
    const spot=new THREE.SpotLight(0xe8f0ff,2.4,80,.48,.55,1.2); spot.position.set(0,1,1.9); spot.target.position.set(0,0,22);
    root.add(spot, spot.target);
  }
  scene.add(root);
  // the coupe's own parts: its body meshes and its four wheel pivots (not `body` itself)
  const proc = { parts: [...body.children, ...root.children.filter(o => o.isGroup && o !== body)], wheels, pivots, tailMat, paint };
  return {root, body, wheels, pivots, tailMat, under, paint, proc, lastMark:[null,null], spin:0, roll:0};
}

// Put the 3D model of car `carId` (core/cars.js, painted `code`) on a car made by makeCar,
// in place of the coupe built from shapes. The car keeps its fields: body (roll, pitch),
// wheels (spin; front-left, front-right, rear-left, rear-right), pivots (steering),
// tailMat (brake lights), paint. Where a model's wheels are part of its body, there are
// none to turn; where its tail lights are only painted in the texture, a red glow comes up
// over them on braking.
// Loads once per model; a later call wins over one still loading.
const glowGeo = new THREE.PlaneGeometry(1, 1).rotateY(Math.PI); glowGeo.userData.shared = true;   // faces backwards
export async function dressCar(m, carId, code){
  const my = m.dressing = (m.dressing || 0) + 1;
  m.wantCode = code;                       // a repaint while this loads changes it
  let inst;
  try { inst = await makeModel(carId, code, carEnv); }
  catch(e){
    // the coupe built from shapes comes back (not the car that was there before)
    console.error('car model failed, showing the coupe', carId, e);
    if(my === m.dressing) undress(m);
    return null;
  }
  if(my !== m.dressing){ inst.dispose(); return null; }
  if(m.wantCode !== code) inst.repaint(m.wantCode);
  undress(m);
  inst.root.traverse(o => { if(o.isMesh) o.castShadow = true; });
  m.body.add(inst.root);
  for(const o of m.proc.parts) o.visible = false;
  m.model = inst;
  m.paint = inst.paint;
  // the headlight beam starts just in front of the bumper (inside a taller body it lit the car itself)
  const spot = m.root.children.find(o => o.isSpotLight);
  if(spot) spot.position.set(0, 0.75, inst.size.z / 2 + 0.25);
  m.wheels = inst.wheels.length >= 4 ? inst.wheels.slice(0, 4) : [];
  m.pivots = m.wheels.filter(w => w.userData.wheel.front);
  if(inst.tails.length){
    // one number drives every tail-light material of the model
    m.tailMat = { set emissiveIntensity(v){ for(const t of inst.tails) t.emissiveIntensity = v * 0.5; } };
  } else {
    // the lights are painted in the texture: on braking a soft red glow comes up over them
    const size = inst.size;                       // the model's own size (wheels at y 0, centred)
    const [y, x, w] = carById(carId).tail || [0.52, 0.3, 0.3];
    const mat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0xff1a3c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    for(const side of [1, -1]){
      const g = new THREE.Mesh(glowGeo, mat);
      g.scale.set(size.x * w, size.x * w * 0.55, 1);
      g.position.set(side * size.x * x, size.y * y, -size.z / 2 - 0.04);
      inst.root.add(g);
    }
    inst.strips = mat;
    // driven like the coupe's tail material: 1.4 is lights on, 4.5 is braking
    m.tailMat = { set emissiveIntensity(v){ mat.opacity = Math.max(0, Math.min(1, (v - 1.4) / 3.1)) * 0.95; } };
  }
  return inst;
}
function undress(m){
  if(!m.model) return;
  if(m.model.strips) m.model.strips.dispose();
  m.model.dispose(); m.model = null;
  for(const o of m.proc.parts) o.visible = true;
  const spot = m.root.children.find(o => o.isSpotLight); if(spot) spot.position.set(0, 1, 1.9);
  Object.assign(m, { wheels: m.proc.wheels, pivots: m.proc.pivots, tailMat: m.proc.tailMat, paint: m.proc.paint });
}
export function disposeCar(m){
  // the model first, by its own dispose: its other materials and textures belong to the
  // shared template (every car of that model, the stand), not to this car
  undress(m);
  scene.remove(m.root);
  // the body and wheel shapes are shared by every car: only this car's own things go
  m.root.traverse(o=>{ if(o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); if(o.material){ if(o.material.map&&o.material.map!==glowTex) o.material.map.dispose(); o.material.dispose(); } });
}
