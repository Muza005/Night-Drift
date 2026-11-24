/* ---------- the race made ready to draw before it starts (plan 3, stage 5) ----------
   The first frame of a run used to stop the game for ~0.7 s on a desktop GPU (seconds on a
   laptop, whose driver compiles shaders slower): three.js compiles a shader program for
   every kind of material the first time it draws it (~20 of them: the road, the walls, the
   cars, the lights, the smoke…), and uploads textures and geometry. Online that frame came
   right at the countdown, and the players' cars then stood still on everyone else's screen
   while their states piled up behind it.

   Now it is done in the garage before a run (solo too), in the lobby and between runs, a
   little each frame:
   - warmStep compiles the materials that have no program yet, one object at a time, until
     `budget` ms of this frame are used (renderer.compile on a stand-in for the scene that
     walks just that object: same lights, fog and shadows, so the same program; a program
     compiled once is shared by every material of its kind);
   - their textures are uploaded the same way;
   - once all is compiled, with `draw`, the race scene is drawn once from above my car into
     the canvas (the shadow map's programs, the buffers). The garage or the lobby draws over
     it in the same frame, so it never shows.
   Things that come later (another player's car model loading) are picked up the same way. */
import { renderer, scene } from './render.js';

const props = renderer.properties;
const stand = Object.create(scene);          // the scene, but compile() walks only `batch`
let batch = [];
stand.traverse = fn => { for (const o of batch) fn(o); };
const cam = new THREE.PerspectiveCamera(100, 16 / 9, 0.1, 1200);
const texDone = new WeakSet(), seen = new WeakMap();   // seen: object → the material it was compiled with
const tries = new WeakMap();                            // texture → scans it was found still loading
const TEX_TRIES = 30;                                   // (~10 s of scans) then it uploads when drawn, as before
const SCAN_BUSY = 250, SCAN_IDLE = 500;                 // ms between scans of the scene
let drawn = false, nextScan = 0, objs = [], texs = [];
cam.name = 'warm';                                      // (tests/perf tells this drawing from the race's)

const mats = o => !o.material ? [] : Array.isArray(o.material) ? o.material : [o.material];
const fresh = m => { const p = props.get(m); return !p.programs || !p.programs.size; };
function textures(m, out){
  for(const k in m){ const v = m[k]; if(v && v.isTexture && !texDone.has(v)) out.push(v); }
  if(m.uniforms) for(const k in m.uniforms){ const v = m.uniforms[k] && m.uniforms[k].value; if(v && v.isTexture && !texDone.has(v)) out.push(v); }
}
// What is left to do: the objects whose program is not there yet, the textures not uploaded.
// The whole scene is walked at most every SCAN_BUSY ms (SCAN_IDLE once all is done), never
// every frame; the frames between work through the lists.
function scan(){
  objs = []; const tex = [];
  scene.traverse(o => { const ms = mats(o); if(!ms.length) return;
    // each object, not each material: one material on a plain and an instanced mesh, or with
    // and without vertex colours, is two programs
    if(seen.get(o) !== o.material || ms.some(fresh)) objs.push(o);
    for(const m of ms) textures(m, tex); });
  texs = [...new Set(tex)];
}

// One frame's share. Returns true when everything is ready (and drawn once, with `draw`).
// at: {x, z, h} where the camera of the drawing stands (my car).
export function warmStep({ budget = 4, draw = false, at = null } = {}){
  const t0 = performance.now();
  if(t0 >= nextScan && !objs.length && !texs.length){
    scan(); nextScan = t0 + (objs.length || texs.length ? SCAN_BUSY : SCAN_IDLE);
  }
  if(objs.length || texs.length){
    renderer.setRenderTarget(null);
    while(objs.length && performance.now() - t0 <= budget){
      const o = objs.shift(); if(!o.parent) continue;   // gone from the scene meanwhile
      batch = [o]; renderer.compile(stand, cam); seen.set(o, o.material); drawn = false;
    }
    batch = [];
    while(!objs.length && texs.length && performance.now() - t0 <= budget){
      const t = texs.shift();
      if(t.isCubeTexture || (t.image === undefined && !t.isDataTexture)) { texDone.add(t); continue; }
      // an image still loading: looked at again on the next scans, for TEX_TRIES of them
      if(t.image && t.image.complete === false){ const n = (tries.get(t) || 0) + 1; tries.set(t, n); if(n >= TEX_TRIES) texDone.add(t); continue; }
      renderer.initTexture(t); texDone.add(t); drawn = false;
    }
    if(objs.length || texs.length) return false;
  }
  if(drawn) return true;
  if(!draw) return false;
  if(at){ cam.position.set(at.x - Math.sin(at.h) * 8, 14, at.z - Math.cos(at.h) * 8); cam.lookAt(at.x + Math.sin(at.h) * 30, 0, at.z + Math.cos(at.h) * 30); }
  cam.aspect = innerWidth / Math.max(1, innerHeight); cam.updateProjectionMatrix();
  renderer.render(scene, cam);
  drawn = true;
  return true;
}
// something new to draw (a new map or mode): looked over at once, drawn again when ready
export function warmAgain(){ drawn = false; nextScan = 0; }
