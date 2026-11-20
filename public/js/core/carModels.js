// The cars' 3D models (public/models/cars/*.glb, picked in core/cars.js).
//
// One loaded template per model file, cached; every car on screen is a clone of it that
// shares the template's geometry and textures and owns only a copy of the Paint material,
// so repainting one car never repaints another car of the same model.
//
// Every template is normalised once, the same way, so all cars match on the stand and in
// the race: 4.3 m long, wheels on the ground (y = 0), centred on x and z, nose to +Z (the
// files already face +Z).
//
// Needs the global THREE (r128), THREE.GLTFLoader (three/examples/js/loaders/GLTFLoader.js
// of the same version) and MeshoptDecoder (three/examples/js/libs/meshopt_decoder.js: the
// models' geometry is meshopt-compressed, see tools/prep-car-model.mjs), all loaded by
// index.html.
import { CARS, carById, paintHex } from './cars.js';
import { MODEL_VERSIONS } from './modelVersions.js';

export const CAR_LEN = 4.3;

// Paint is set from an sRGB hex. The renderer works in linear light (outputEncoding is
// sRGB), so the hex is converted first; set as is, every colour came out washed, pastel
// (a red turned coral). The finish: a lacquer with a little metal flake, not chrome.
export const PAINT_FINISH = { metalness: 0.15, roughness: 0.3, envMapIntensity: 0.9 };
export function setPaint(mat, hex){
  mat.color.setHex(hex).convertSRGBToLinear();
}

// Model paths in cars.js are relative to public/: resolve them from this file, so any page
// (the game, the preview in dev/) finds them.
// Each URL carries the file's content hash (?v=, modelVersions.js, written by the pack
// step): it may be cached for good, and a changed model is a new URL.
const PUBLIC = new URL('../../', import.meta.url);
export const modelUrl = path => {
  const v = MODEL_VERSIONS[path.split('/').pop()];
  return new URL(path + (v ? '?v=' + v : ''), PUBLIC).href;
};

const templates = new Map();      // model path -> Promise<template>
let loader = null;

function gltfLoader(){
  if(!loader){
    if(!THREE.GLTFLoader) throw new Error('THREE.GLTFLoader is missing: load three/examples/js/loaders/GLTFLoader.js');
    if(!globalThis.MeshoptDecoder) throw new Error('MeshoptDecoder is missing: load three/examples/js/libs/meshopt_decoder.js');
    loader = new THREE.GLTFLoader().setMeshoptDecoder(globalThis.MeshoptDecoder);
  }
  return loader;
}

// The wheels of each model, by node name as GLTFLoader gives it (it drops dots and turns
// spaces into "_"): where wheels are separate nodes they can spin. Some models have the
// tyre and the rim as two nodes (Nexus, Dodge, the RX-7's Circle.001 and .004-.010;
// .002 and .003 are its tail lights): both are listed. The Lamborghini's wheels were part of
// its one body mesh: the pack step cuts them out into nodes FLW, FRW, RLW, RRW.
export const WHEEL = /^(DEF-Wheel(Ft|Bk)[LR]_\d+|Tire_(FL|FR|RL|RR)|(FL|FR|RL|RR)W|(Tire|Rim)_(FL|FR|RL|RR)_low|(FL|FR|RL|RR)(tire|rim)_[A-Za-z]+\d*|Circle0(0[14-9]|10))$/;

function normalise(scene){
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene), size = box.getSize(new THREE.Vector3());
  const k = CAR_LEN / size.z;
  const wrap = new THREE.Group();
  scene.scale.multiplyScalar(k);
  scene.position.set(-(box.min.x + box.max.x) / 2 * k, -box.min.y * k, -(box.min.z + box.max.z) / 2 * k);
  wrap.add(scene);
  wrap.updateMatrixWorld(true);
  return { root: wrap, size: size.multiplyScalar(k) };
}

// Wheels spin about their hub, but in some files a wheel node's own origin is elsewhere
// (the car's centre: the coupe, the Dodge, the Nexus). So every wheel gets a pivot at its
// hub, in the car's own axes (x across, z forward); a tyre and its rim (two nodes at the
// same hub) share one. pivot.rotation.x spins it, .y steers it (order YXZ: the spin is
// about the steered axle). userData.wheel: { front, left }.
function pivotWheels(t){
  const nodes = [];
  t.root.traverse(o => { if(WHEEL.test(o.name)) nodes.push(o); });
  const hubs = [];
  for(const n of nodes){
    const c = new THREE.Box3().setFromObject(n).getCenter(new THREE.Vector3());
    t.root.worldToLocal(c);
    let hub = hubs.find(h => h.c.distanceTo(c) < 0.2);
    if(!hub){ hub = { c, nodes: [] }; hubs.push(hub); }
    hub.nodes.push(n);
  }
  for(const h of hubs){
    const pivot = new THREE.Group();
    pivot.name = 'wheel-pivot'; pivot.rotation.order = 'YXZ';
    pivot.position.copy(h.c);
    pivot.userData.wheel = { front: h.c.z > 0, left: h.c.x > 0 };
    t.root.add(pivot); pivot.updateMatrixWorld(true);
    for(const n of h.nodes) pivot.attach(n);          // keeps where it is, now under the pivot
  }
}
// Tail and brake lights, where a model has them as materials of their own: they light up
// on braking. (Models without get two thin strips instead, see core/carModel.js.)
const TAIL = /^(Glass_-_Red(_-_Rough)?|brakelights|rearlights|glow|Material\.00[45])$/;

// Load (once) the model of car `carId`. Resolves to its template.
export function loadModel(carId){
  const c = carById(carId);
  if(!templates.has(c.model)){
    const fail = err => { templates.delete(c.model); throw err; };   // a failure is not kept: the next ask tries again
    templates.set(c.model, new Promise((resolve, reject) => {
      const url = modelUrl(c.model);
      gltfLoader().load(url, gltf => { try {
        const t = normalise(gltf.scene);
        t.root.traverse(o => {
          if(!o.isMesh) return;
          o.castShadow = false; o.receiveShadow = false;
          if(o.material && o.material.name === 'Paint'){
            Object.assign(o.material, PAINT_FINISH);
            t.paint = o.material;           // the template's own paint: never drawn repainted
          }
          if(o.geometry) o.geometry.userData.shared = true;
        });
        if(!t.paint) throw new Error(c.model + ': no material named "Paint"');
        pivotWheels(t);
        t.model = c.model;
        resolve(t);
      } catch(err){ reject(new Error(url + ': ' + err.message)); } }, undefined, e => {
        // FileLoader hands over the request's ProgressEvent: say which file and what came back
        const x = e && e.target;
        reject(e instanceof Error ? new Error(url + ': ' + e.message)
          : new Error(url + ': ' + (x && 'status' in x ? (x.status ? 'HTTP ' + x.status + ' ' + (x.statusText || '') : 'network error') : String(e))));
      });
    }).catch(fail));
  }
  return templates.get(c.model);
}

// Load models ahead of time, when the browser is idle (the next and previous car in the
// garage): a car scrolled to is then already there, without a freeze.
const idle = globalThis.requestIdleCallback ? fn => requestIdleCallback(fn, { timeout: 1500 }) : fn => setTimeout(fn, 200);
export function preload(carIds){
  for(const id of carIds) idle(() => { loadModel(id).catch(() => {}); });
}
// Is it asked for (loading or loaded)?
export const isLoaded = carId => templates.has(carById(carId).model);

// The whole garage in the background, after the first menu frame: one model at a time
// (never two downloads fighting over the line), nearest to car `fromId` in the garage's
// order first, each one only once the browser is idle. paused(): true while loading must
// wait (a race on: parsing a model mid-race would cost a frame). A car asked for meanwhile
// (flipped to in the garage, an opponent's pick in a room) loads at once, ahead of this.
let queued = false;
export function preloadAll(fromId, paused = () => false){
  if(queued) return; queued = true;
  const i0 = Math.max(0, CARS.findIndex(c => c.id === fromId));
  const order = CARS.map((c, i) => ({ id: c.id, d: Math.abs(i - i0) + (i < i0 ? 0.5 : 0) })).sort((a, b) => a.d - b.d).map(c => c.id);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  (async () => {
    for(const id of order){
      while(paused()) await wait(1000);
      await new Promise(r => idle(r));
      await loadModel(id).catch(() => {});          // (a failure is not kept: the garage tries again)
    }
  })();
}

// A car to put on screen: a clone of the template with its own Paint material.
//   inst.root     the THREE.Group to add to a scene
//   inst.wheels   the wheel pivots, front-left, front-right, rear-left, rear-right (may be empty)
//   inst.tails    its own tail-light materials (may be empty)
//   inst.repaint(code)   any paint code from core/cars.js (FACTORY too)
//   inst.dispose()       frees what this clone owns (not the shared template)
export async function makeModel(carId, code, envMap){
  const t = await loadModel(carId);
  const root = t.root.clone(true);
  const paint = t.paint.clone();
  if(envMap) paint.envMap = envMap;
  const wheels = [], tails = new Map();
  root.traverse(o => {
    if(o.isMesh && o.material === t.paint) o.material = paint;
    // its own copy of the tail-light materials: one car braking lights up only its own
    if(o.isMesh && o.material && TAIL.test(o.material.name)){
      if(!tails.has(o.material)){ const m = o.material.clone(); m.emissive.setHex(0xff1a3c); m.emissiveIntensity = 1.2; tails.set(o.material, m); }
      o.material = tails.get(o.material);
    }
    if(o.userData.wheel) wheels.push(o);
  });
  // front first, then left (x > 0) before right: the order core/carModel.js uses
  wheels.sort((a, b) => (b.userData.wheel.front - a.userData.wheel.front) || (b.userData.wheel.left - a.userData.wheel.left));
  const inst = {
    carId, root, wheels, paint, size: t.size, tails: [...tails.values()],
    repaint(c){ setPaint(paint, paintHex(c, carId)); inst.code = c; },
    dispose(){ if(root.parent) root.parent.remove(root); paint.dispose(); for(const m of tails.values()) m.dispose(); },   // (r128 has no removeFromParent)
  };
  inst.repaint(code);
  return inst;
}

export const MODEL_IDS = CARS.map(c => c.id);
