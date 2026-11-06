// Traffic mode: the endless highway, the top-down camera, the traffic (stage 2) and
// collisions with it (stage 3). Scoring arrives in stage 4. Same interface as the track mode
// (see modes/track/index.js), so the car drives through the same frozen stepCar().
import { $, G } from '../../state.js';
import { scene, camera, moon, sky, stars } from '../../core/render.js';
import { rig } from '../../core/cameraRig.js';
import { setT, fmtT, flash } from '../../ui/hud.js';
import { laneCenter, nearestLane, startPose, constrainToHighway, topDownView } from './geometry.js';
import { group, updateChunks, followGround } from './scene.js';
import { createTraffic } from './sim.js';
import { drawTraffic } from './view.js';
import { collideWithTraffic } from './collide.js';

// Solo: a new seed every run. Online (stage 6) the server will hand out the seed.
const newSeed = () => (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
export const traffic = createTraffic(1);
const asPlayer = car => ({ x: car.x, z: car.z, v: car.vz });

const HINT = '<b>W A S D</b> руль и газ · <b>Пробел</b> ручник · <b>R</b> на дорогу';
let lastZ = 0, fogDensity = 0, hintWas = '', shadowWas = null, view = null, camSpeed = 0, topSpeed = 0;

function pose(car, x, z){
  car.x=x; car.z=z; car.h=0; car.vx=car.vz=0; car.steer=0; car.spinV=0; car.idx=0; car.prog=0; car.off=false;
  car.lastMark=[null,null];
}

export const trafficMode = {
  id: 'traffic',

  show(){
    group.visible = true;
    // Thinner fog: from above the camera is farther from the road than in the chase view.
    fogDensity = scene.fog.density; scene.fog.density = 0.0034;
    // The camera is always 20+ m above the road here, so a near plane of 1 m (instead of
    // 0.1) gives the depth buffer ten times the precision and stops the shoulders and the
    // ground from flickering through each other.
    camera.near = 1; camera.updateProjectionMatrix();
    const sc = moon.shadow.camera; shadowWas = {l:sc.left, r:sc.right, t:sc.top, b:sc.bottom};
    Object.assign(sc, {left:-60, right:60, top:60, bottom:-60}); sc.updateProjectionMatrix();
    $('map').hidden = true;
    document.querySelector('#lapbox .lbl').textContent = 'Дистанция';
    hintWas = $('hint').innerHTML; $('hint').innerHTML = HINT;
  },
  hide(){
    group.visible = false;
    scene.fog.density = fogDensity;
    camera.near = 0.1; camera.updateProjectionMatrix();
    Object.assign(moon.shadow.camera, {left:shadowWas.l, right:shadowWas.r, top:shadowWas.t, bottom:shadowWas.b}); moon.shadow.camera.updateProjectionMatrix();
    sky.position.set(0, 150, 0); stars.position.set(0, 0, 0);
    $('map').hidden = false;
    document.querySelector('#lapbox .lbl').textContent = 'Круг';
    $('hint').innerHTML = hintWas;
  },

  enter(car, {slot=0, seed=newSeed()}={}){ const p=startPose(slot); pose(car, p.x, p.z); camSpeed=0; topSpeed=0; traffic.reset(seed, [asPlayer(car)]); },
  idle(car){ const p=startPose(0); pose(car, p.x, p.z); traffic.reset(newSeed(), [asPlayer(car)]); },
  respawn(car){ pose(car, laneCenter(nearestLane(car.x)), car.z); },
  constrain(car, dt, hooks){ constrainToHighway(car, dt, hooks); },
  // after every physics substep: hits with the traffic (hooks.onTrafficHit)
  collide(car, hooks){ collideWithTraffic(car, traffic, hooks); },
  // what the crash screen shows
  summary(){ return [
    ['Дистанция', (Math.max(0, lastZ)/1000).toFixed(2).replace('.', ',') + ' км'],
    ['Время', fmtT(G.lapT)],
    ['Макс. скорость', Math.round(topSpeed*3.6) + ' км/ч'],
  ]; },

  // Every frame, in any state: keep road, ground and sky around the car, run the traffic
  // (it keeps moving behind the menu too, but stops while the game is paused).
  world(car, dt){
    if(G.state!=='pause') traffic.advance(dt, [asPlayer(car)]);
    drawTraffic(traffic);
    updateChunks(car.z); followGround(car.x, car.z);
    sky.position.set(car.x, 150, car.z); stars.position.set(car.x, 0, car.z);
  },

  // Top-down camera, always facing down the road. Height and tilt follow the car's
  // speed along the road (smoothed), so at any speed you see at least 2.5 s ahead of
  // closing in on the slowest traffic. See topDownView() in geometry.js.
  camera(car, dt){
    const along = Math.max(0, car.vz);
    if(!rig.init){ camSpeed = along; }
    camSpeed += (along - camSpeed) * (1 - Math.exp(-1.6*dt));
    view = topDownView(camSpeed, camera.aspect);
    const p = view.pitch * Math.PI / 180;
    const tx = car.x * 0.55, ty = view.height, tz = car.z - view.back;
    const k = rig.init ? 1 - Math.exp(-6*dt) : 1; rig.init = true;
    rig.pos.x += (tx - rig.pos.x) * k; rig.pos.y += (ty - rig.pos.y) * k;
    rig.pos.z = tz;                       // along the road the camera never lags: the car stays put on screen
    camera.position.copy(rig.pos);
    if(G.shake>0){ camera.position.x+=(Math.random()-.5)*G.shake*.8; camera.position.z+=(Math.random()-.5)*G.shake*.8; G.shake=Math.max(0,G.shake-dt*2.5); }
    rig.look.set(camera.position.x, camera.position.y - Math.sin(p)*10, camera.position.z + Math.cos(p)*10);
    camera.lookAt(rig.look);
    camera.fov = view.fovV;
  },

  hud(car, dt, info){
    if(G.state==='race'){ lastZ = car.z; topSpeed = Math.max(topSpeed, Math.hypot(car.vx, car.vz)); }
    setT('lapn', (Math.max(0, car.z)/1000).toFixed(2).replace('.', ',') + ' км');
    setT('lapt', fmtT(G.lapT));
    setT('best', '');
    if(G.state==='race'){
      const back = Math.cos(car.h) < -.3 && info.speed > 4;
      G.wrongT = back ? G.wrongT + dt : 0;
      if(G.wrongT>.8 && G.toastT<=0) flash('Не туда — разворачивайся', null, .6);
    }
  },

  drawMap(){},
  view: () => view,
};
