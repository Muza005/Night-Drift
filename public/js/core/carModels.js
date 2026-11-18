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
// Needs the global THREE (r128) and THREE.GLTFLoader (three/examples/js/loaders/GLTFLoader.js
// of the same version), both loaded by index.html.
import { CARS, carById, paintHex } from './cars.js';

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
const PUBLIC = new URL('../../', import.meta.url);
const modelUrl = path => new URL(path, PUBLIC).href;

const templates = new Map();      // model path -> Promise<template>
let loader = null;

function gltfLoader(){
  if(!loader){
    if(!THREE.GLTFLoader) throw new Error('THREE.GLTFLoader is missing: load three/examples/js/loaders/GLTFLoader.js');
    loader = new THREE.GLTFLoader();
  }
  return loader;
}

// The wheels of each model, by node name as GLTFLoader gives it (it drops dots and turns
// spaces into "_"): where wheels are separate nodes they can spin. Some models have the
// tyre and the rim as two nodes (Nexus, Dodge): both are listed. Models whose wheels are
// part of the body mesh (the Lamborghini, the RX-7) have none.
const WHEEL = /^(DEF-Wheel(Ft|Bk)[LR]_\d+|Tire_(FL|FR|RL|RR)|(FL|FR|RL|RR)W|(Tire|Rim)_(FL|FR|RL|RR)_low|(FL|FR|RL|RR)(tire|rim)_[A-Za-z]+\d*)$/;

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

// Load (once) the model of car `carId`. Resolves to its template.
export function loadModel(carId){
  const c = carById(carId);
  if(!templates.has(c.model)){
    templates.set(c.model, new Promise((resolve, reject) => {
      gltfLoader().load(modelUrl(c.model), gltf => {
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
        t.model = c.model;
        resolve(t);
      }, undefined, err => { templates.delete(c.model); reject(err); });
    }));
  }
  return templates.get(c.model);
}

// Load models ahead of time, when the browser is idle (the next and previous car in the
// garage): a car scrolled to is then already there, without a freeze.
const idle = globalThis.requestIdleCallback || (fn => setTimeout(fn, 200));
export function preload(carIds){
  for(const id of carIds) idle(() => { loadModel(id).catch(() => {}); });
}
export const isLoaded = carId => templates.has(carById(carId).model);

// A car to put on screen: a clone of the template with its own Paint material.
//   inst.root     the THREE.Group to add to a scene
//   inst.wheels   the wheel nodes (may be empty)
//   inst.repaint(code)   any paint code from core/cars.js (FACTORY too)
//   inst.dispose()       frees what this clone owns (not the shared template)
export async function makeModel(carId, code, envMap){
  const t = await loadModel(carId);
  const root = t.root.clone(true);
  const paint = t.paint.clone();
  if(envMap) paint.envMap = envMap;
  const wheels = [];
  root.traverse(o => {
    if(o.isMesh && o.material === t.paint) o.material = paint;
    if(WHEEL.test(o.name)) wheels.push(o);
  });
  const inst = {
    carId, root, wheels, paint, size: t.size,
    repaint(c){ setPaint(paint, paintHex(c, carId)); inst.code = c; },
    dispose(){ if(root.parent) root.parent.remove(root); paint.dispose(); },   // (r128 has no removeFromParent)
  };
  inst.repaint(code);
  return inst;
}

export const MODEL_IDS = CARS.map(c => c.id);
