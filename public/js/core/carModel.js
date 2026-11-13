// Car 3D model: a low coupe with a rounded body, a glass cabin, light strips and wheels
// with steering pivots. The shapes come from carShapes.js and are built once: every car
// of this kind (the player's and the other players') shares them.
import { scene, glowTex, carEnv } from './render.js';
import { coupeShape, wheelShape } from './carShapes.js';

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
  const paint=new THREE.MeshStandardMaterial({color,metalness:.55,roughness:.26,envMap:carEnv,envMapIntensity:1.1});
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
  return {root, body, wheels, pivots, tailMat, under, paint, lastMark:[null,null], spin:0, roll:0};
}
export function disposeCar(m){
  scene.remove(m.root);
  // the body and wheel shapes are shared by every car: only this car's own things go
  m.root.traverse(o=>{ if(o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); if(o.material){ if(o.material.map&&o.material.map!==glowTex) o.material.map.dispose(); o.material.dispose(); } });
}
