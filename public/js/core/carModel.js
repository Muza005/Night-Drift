// Car 3D model: body, glass, light strips, wheels with steering pivots.
import { scene, glowTex } from './render.js';

export function makeCar(color, local){
  const root=new THREE.Group(), body=new THREE.Group(); root.add(body);
  const paint=new THREE.MeshStandardMaterial({color,metalness:.45,roughness:.32});
  const dark=new THREE.MeshStandardMaterial({color:0x12141c,roughness:.6});
  const glass=new THREE.MeshStandardMaterial({color:0x14223a,metalness:.85,roughness:.12});
  const add=(geo,mat,x,y,z,par=body)=>{ const o=new THREE.Mesh(geo,mat); o.position.set(x,y,z); o.castShadow=true; par.add(o); return o; };
  add(new THREE.BoxGeometry(2.0,.5,4.3),paint,0,.6,0);
  add(new THREE.BoxGeometry(2.04,.18,4.34),dark,0,.38,0);
  add(new THREE.BoxGeometry(1.62,.5,2.0),glass,0,1.1,-.3);
  add(new THREE.BoxGeometry(1.5,.08,1.6),paint,0,1.38,-.35);
  add(new THREE.BoxGeometry(1.95,.07,.42),dark,0,1.18,-2.0);
  for(const s of [1,-1]) add(new THREE.BoxGeometry(.08,.32,.2),dark,s*.7,1.0,-2.0);
  add(new THREE.BoxGeometry(.32,.02,4.32),new THREE.MeshBasicMaterial({color:0x3ef0ff,toneMapped:false}),.35,.86,0);
  add(new THREE.BoxGeometry(.32,.02,4.32),new THREE.MeshBasicMaterial({color:0x3ef0ff,toneMapped:false}),-.35,.86,0);
  const headMat=new THREE.MeshBasicMaterial({color:0xf4f8ff,toneMapped:false});
  for(const s of [1,-1]) add(new THREE.BoxGeometry(.5,.14,.05),headMat,s*.65,.66,2.16);
  const tailMat=new THREE.MeshStandardMaterial({color:0x330008,emissive:0xff1a3c,emissiveIntensity:1.4});
  for(const s of [1,-1]) add(new THREE.BoxGeometry(.6,.14,.05),tailMat,s*.6,.7,-2.16);
  const under=new THREE.Mesh(new THREE.PlaneGeometry(3.4,6).rotateX(-Math.PI/2),new THREE.MeshBasicMaterial({map:glowTex,color:local?0x3ef0ff:color,transparent:true,opacity:.55,blending:THREE.AdditiveBlending,depthWrite:false}));
  under.position.y=.06; root.add(under);
  const wheelG=new THREE.CylinderGeometry(.38,.38,.32,18).rotateZ(Math.PI/2);
  const tire=new THREE.MeshStandardMaterial({color:0x0b0b0f,roughness:.9});
  const rimG=new THREE.CylinderGeometry(.24,.24,.34,10).rotateZ(Math.PI/2);
  const rim=new THREE.MeshStandardMaterial({color:0xb8bccc,metalness:.9,roughness:.3});
  const wheels=[], pivots=[];
  for(const [x,z,front] of [[.95,1.35,1],[-.95,1.35,1],[.95,-1.35,0],[-.95,-1.35,0]]){
    const pivot=new THREE.Group(); pivot.position.set(x,.38,z); root.add(pivot);
    const spin=new THREE.Group(); pivot.add(spin);
    const t=new THREE.Mesh(wheelG,tire); t.castShadow=true; spin.add(t); spin.add(new THREE.Mesh(rimG,rim));
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
  m.root.traverse(o=>{ if(o.geometry) o.geometry.dispose(); if(o.material){ if(o.material.map&&o.material.map!==glowTex) o.material.map.dispose(); o.material.dispose(); } });
}
