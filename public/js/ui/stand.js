// The car stand: a round podium with a thin neon rim, the car on it, a soft shadow under
// the car. It turns slowly by itself; a horizontal drag (mouse or finger) turns it by
// hand, a flick keeps it turning and slowing down, and ~2 s after the last touch the slow
// turn comes back. The garage (solo and from a room) and the lobby each show one of these,
// drawn into the game's single renderer.
//
// The stand has no renderer and no loop of its own: the game has one WebGLRenderer, and
// the stand draws into it, only inside the box of its DOM element (`el`), and only when
// the host's loop calls frame(). Nothing is drawn while the element is hidden or off
// screen. startLoop() below is a loop that stops while the tab is hidden.
//
//   const stand = createStand({ renderer, el });
//   stand.setCar('rx7', paintCode, dir)  shows a car (loads its model once, see carModels.js);
//                                    dir ±1 slides the podium out and the next one in. While a
//                                    model is still loading, its podium shows a neon outline
//                                    of a car, breathing softly; if it fails to load, the game's
//                                    own coupe stands there in the chosen paint, with a note:
//                                    never an empty podium
//   stand.repaint(paintCode)         recolours it at once
//   stand.repaint(paintCode, { flow: true })   the new paint flows over the body behind a band
//                                    of light (~0.5 s); the material and the label have the new
//                                    colour at once, only the picture catches up
//   stand.sweep(dir)                 a short band of light across the body (dir ±1: which way)
//
// createStand({ renderer, el, studio: true }) is the garage's: a light from straight above
// (the stand under a lamp, as the street outside is under its lamps), and a car that comes on
// the stand is swept by a band of light as it settles. Nothing of this with reduced motion.
//   stand.frame(now)                 draws one frame (now: rAF time, ms); false if not drawn
//   stand.measure()                  the podium on screen now, for the backdrop (or null)
//   stand.dispose()
//
// createStand({ renderer, el, street: true }) is the home screen's version: no podium. The
// car stands on the wet street of the backdrop: a tight dark spot under each tyre, a wider
// soft shadow under the body, and its reflection, the same car mirrored in the ground at a
// third of its strength, starting at the tyres' contact line. The camera is low (~4°), the
// car is framed to a share of the box's width and its contact line is put on the backdrop's
// street just under the horizon; it does not turn by itself.
//   stand.setGlow(color)             the colour of the light from the street (the focused card's)
import { CARS, carById, paintByCode, paintHex } from '../core/cars.js';
import { makeModel, preload, setPaint, PAINT_FINISH } from '../core/carModels.js';
import { coupeShape, wheelShape } from '../core/carShapes.js';

const TAU = Math.PI * 2;
const DISC_R = 3.0;
const AUTO = TAU / 28;            // the slow turn: one round in 28 s (rad/s)
const DRAG_TURN = 1.15 * Math.PI; // a drag across the whole stand turns it this much
const COAST = 0.998;              // after a flick: speed kept per ms (Apple's scroll deceleration)
const IDLE = 2;                   // s without a touch before the slow turn comes back
const RESUME = 0.7;               // s: how quickly it settles into the slow turn again
const MAX_SPIN = 2.5 * TAU;       // a flick never spins it faster than this (rad/s)
const EXPOSURE = 0.9;             // ACES at the track's 1.15 lifts a red toward coral

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

// A soft round spot, white in the middle: the shadow and the rim's halo are this, tinted.
function spotTexture(inner){
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(inner, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}
// The street's shadows (home): `box` a soft rounded rectangle, the ambient occlusion under the
// body (its core 0.62 of the half-size, falling off to the edge); otherwise a tight spot for a
// tyre's contact, dark almost to its edge.
function contactTexture(box){
  const N = 128, c = document.createElement('canvas'); c.width = c.height = N;
  const g = c.getContext('2d'), img = g.createImageData(N, N);
  for(let j = 0; j < N; j++) for(let i = 0; i < N; i++){
    const x = Math.abs((i + 0.5) / N * 2 - 1), y = Math.abs((j + 0.5) / N * 2 - 1);
    let a;
    if(box){
      const r = 0.3, qx = Math.max(x - 0.62 + r, 0), qy = Math.max(y - 0.62 + r, 0);
      const d = Math.hypot(qx, qy) + Math.min(Math.max(x - 0.62 + r, y - 0.62 + r), 0) - r;
      const t = Math.min(1, Math.max(0, (d + 0.04) / 0.42)); a = Math.pow(1 - t * t * (3 - 2 * t), 1.6);
    } else {
      const d = Math.hypot(x, y), t = Math.min(1, Math.max(0, (d - 0.35) / 0.65)); a = Math.pow(1 - t, 2.2);
    }
    const k = (j * N + i) * 4; img.data[k] = img.data[k + 1] = img.data[k + 2] = 255; img.data[k + 3] = Math.round(a * 255);
  }
  g.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(c);
}
// The neon halo around the rim: a ring that is bright at the rim and fades outward.
function haloTexture(){
  const c = document.createElement('canvas'); c.width = 256; c.height = 1;
  const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 256, 0);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(.42, 'rgba(255,255,255,.9)'); gr.addColorStop(.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 256, 1);
  return new THREE.CanvasTexture(c);
}

// What the paint reflects: a dark studio with a long light above and two coloured side
// panels (cyan and rose, the game's neon), prefiltered once per renderer.
const envs = new WeakMap();
function studioEnv(renderer){
  if(envs.has(renderer)) return envs.get(renderer);
  const s = new THREE.Scene(), box = new THREE.BoxGeometry(1, 1, 1), mats = [];
  const add = (color, x, y, z, w, h, d, back) => {
    const m = new THREE.MeshBasicMaterial({ color, side: back ? THREE.BackSide : THREE.FrontSide }); mats.push(m);
    const o = new THREE.Mesh(box, m); o.position.set(x, y, z); o.scale.set(w, h, d); s.add(o);
  };
  add(0x0b0d1a, 0, 0, 0, 30, 14, 30, true);   // the room
  add(0xffffff, 0, 6.8, 0, 12, 0.2, 4);       // the long light overhead
  add(0x9fdfff, -14, 3, 0, 0.2, 3, 10);       // cool side panel
  add(0xffb3c4, 14, 2, -4, 0.2, 2, 6);        // warm side panel
  const pm = new THREE.PMREMGenerator(renderer);
  const env = pm.fromScene(s, 0.02).texture;
  pm.dispose(); box.dispose(); mats.forEach(m => m.dispose());
  envs.set(renderer, env);
  return env;
}

// The stand-in while a model loads: the outline of the game's own coupe (core/carShapes.js,
// the same 4.3 m as every model), its edges only, and four wheels. Built once, shared.
let OUTLINE = null;
function outlineGeometry(){
  if(OUTLINE) return OUTLINE;
  const B = coupeShape('low'), parts = [];
  for(const g of [B.paint, B.glass]) parts.push(new THREE.EdgesGeometry(g, 28));
  // a wheel: its two rims, nothing more (a drum: the side's facets are under the angle)
  const drum = new THREE.CylinderGeometry(0.38, 0.38, 0.26, 28, 1, true).rotateZ(Math.PI / 2), tyre = new THREE.EdgesGeometry(drum, 30);
  for(const x of [B.wheelX, -B.wheelX]) for(const z of B.wheelZ) parts.push(tyre.clone().translate(x, 0.38, z));
  for(const g of [drum, tyre, B.paint, B.glass, B.dark, B.stripes, B.heads, B.tails, ...B.flares]) g.dispose();
  OUTLINE = parts;
  return OUTLINE;
}

// When a model can't be loaded: the game's own coupe (core/carShapes.js, the car drawn
// before there were models), built once and shared, its paint the stand's own per car.
let COUPE = null;
function coupeParts(){
  if(COUPE) return COUPE;
  const B = coupeShape('high'), W = wheelShape();
  const wheels = [];
  for(const x of [B.wheelX, -B.wheelX]) for(const z of B.wheelZ) wheels.push([x, 0.38, z]);
  COUPE = { paint: B.paint, glass: B.glass, dark: [B.dark, ...B.flares], lights: [B.heads], tails: B.tails, tyre: W.tyre, rim: W.rim, wheels };
  B.stripes.dispose();
  return COUPE;
}

// The paint's flow: the paint material (only on a stand) gets a few lines in its shader. A
// point of the body further along x (world, so the band runs across the screen) than the
// moving edge still shows the old colour; at the edge, a narrow band of light. uFlow 0 → 1
// moves the edge from one side of the stand to the other; uOn 0 (no flow running) turns it
// all off, wherever the car is on the stand. One
// program for every car's paint (customProgramCacheKey), each material its own uniforms.
const FLOW_SPAN = 3.2;            // m either side of the stand's middle the edge travels
const PAINT_MS = 520, SWEEP_MS = 440;
function flowCompile(sh){
  Object.assign(sh.uniforms, this.userData.flow);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying float vFlowX;')
    .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n\tvFlowX = (modelMatrix * vec4(transformed, 1.0)).x;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vFlowX;\nuniform float uFlow, uCx, uDir, uGlint, uSpan, uOn;\nuniform vec3 uFrom;')
    .replace('#include <color_fragment>', `#include <color_fragment>
	float ndX = (vFlowX - uCx) * uDir, ndE = mix(-uSpan, uSpan, uFlow);
	diffuseColor.rgb = mix(diffuseColor.rgb, uFrom, uOn * smoothstep(-.22, .22, ndX - ndE));`)
    .replace('gl_FragColor = vec4( outgoingLight, diffuseColor.a );', `float ndB = (ndX - ndE) / .42;
	outgoingLight += uOn * uGlint * exp(-ndB * ndB) * (vec3(.92, .94, 1.) * .32 + diffuseColor.rgb * 1.1);
	gl_FragColor = vec4( outgoingLight, diffuseColor.a );`);
}
const flowKey = () => 'nd-paint-flow';
function flowable(mat){
  if(mat.userData.flow) return;
  mat.userData.flow = { uOn: { value: 0 }, uFlow: { value: 1 }, uFrom: { value: mat.color.clone() }, uCx: { value: 0 }, uDir: { value: 1 }, uGlint: { value: 0 }, uSpan: { value: FLOW_SPAN } };
  mat.onBeforeCompile = flowCompile;
  mat.customProgramCacheKey = flowKey;
}
const easeOut = t => 1 - Math.pow(1 - t, 3);

export function createStand({ renderer, el, street = false, studio = false }){
  const scene = new THREE.Scene();
  const env = studioEnv(renderer);
  const own = [];                                   // what dispose() frees
  const keep = x => (own.push(x), x);

  // lights: a soft sky/ground fill, a key from above-front, a cool rim from behind
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x15172a, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(4, 8, 6);
  const rim = new THREE.DirectionalLight(0x7fe9ff, 0.7); rim.position.set(-5, 3, -6);
  scene.add(key, rim);
  // street: the light coming up from the lit asphalt in front of the car, in the colour of
  // the card in focus (setGlow); it also tints the rim light
  const bounce = new THREE.DirectionalLight(0x3ef0ff, street ? 0.55 : 0); bounce.position.set(1.5, -1.2, 5);
  if(street){ scene.add(bounce); key.intensity = 1.25; }
  // studio: a warm white lamp straight above the stand; the key steps back a little
  if(studio){ const top = new THREE.DirectionalLight(0xfff0dc, 1.6); top.position.set(0.4, 10, 1.2); scene.add(top); key.intensity = 1.15; rim.intensity = 0.55; }

  // The podium: a low dark disc, a thin cyan rim on its top edge, a halo outside it, a dark
  // spot under it, and the car's own soft shadow (a blurred spot, no shadow map). Its parts
  // are made once and shared: while one car slides out and the next slides in, two podiums
  // are on show.
  const DISC_H = 0.14;
  const discGeo = keep(new THREE.CylinderGeometry(DISC_R, DISC_R + 0.05, DISC_H, 72));
  const discMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(studio ? 0x262b42 : 0x141829).convertSRGBToLinear(), metalness: 0.2, roughness: 0.62, envMap: env, envMapIntensity: 0.22 }));   // an sRGB colour, as the paints
  const edgeGeo = keep(new THREE.TorusGeometry(DISC_R - 0.02, 0.022, 8, 120));
  const edgeMat = keep(new THREE.MeshBasicMaterial({ color: 0x3ef0ff, toneMapped: false }));
  const haloGeo = keep(new THREE.RingGeometry(DISC_R - 0.3, DISC_R + 0.55, 96, 1));
  // map the gradient across the ring's width (RingGeometry's uv is planar: redo it radially)
  { const p = haloGeo.attributes.position, uv = haloGeo.attributes.uv, r0 = DISC_R - 0.3, r1 = DISC_R + 0.55;
    for(let i = 0; i < p.count; i++){ const r = Math.hypot(p.getX(i), p.getY(i)); uv.setXY(i, (r - r0) / (r1 - r0), 0.5); }
    uv.needsUpdate = true; }
  const haloMat = keep(new THREE.MeshBasicMaterial({ map: keep(haloTexture()), color: 0x3ef0ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  const flatGeo = keep(new THREE.PlaneGeometry(1, 1));
  const underMat = keep(new THREE.MeshBasicMaterial({ map: keep(spotTexture(0.5)), color: 0x000000, transparent: true, opacity: 0.7, depthWrite: false }));
  const blobMat = keep(new THREE.MeshBasicMaterial({ map: keep(street ? contactTexture(true) : spotTexture(0.6)), color: 0x000000, transparent: true, opacity: street ? 0.92 : 0.85, depthWrite: false }));
  const aoMat = keep(new THREE.MeshBasicMaterial({ map: keep(contactTexture(false)), color: 0x000000, transparent: true, opacity: 1, depthWrite: false }));
  // the stand-in coupe's parts other than its paint
  const coupeMats = {
    glass: keep(new THREE.MeshStandardMaterial({ color: 0x101c30, metalness: 0.9, roughness: 0.08, envMap: env, envMapIntensity: 1.5 })),
    dark: keep(new THREE.MeshStandardMaterial({ color: 0x12141c, roughness: 0.6 })),
    lights: keep(new THREE.MeshBasicMaterial({ color: 0xf4f8ff, toneMapped: false })),
    tails: keep(new THREE.MeshStandardMaterial({ color: 0x330008, emissive: 0xff1a3c, emissiveIntensity: 0.6 })),
    tyre: keep(new THREE.MeshStandardMaterial({ color: 0x0b0b0f, roughness: 0.9 })),
    rim: keep(new THREE.MeshStandardMaterial({ color: 0xb8bccc, metalness: 0.9, roughness: 0.3, envMap: env })),
  };
  // A car the stand can show like a model (repaint, dispose, size), flagged `fallback`.
  function standInCoupe(carId, code){
    const P = coupeParts(), root = new THREE.Group();
    const paint = new THREE.MeshStandardMaterial({ envMap: env, ...PAINT_FINISH });
    const add = (g, m) => { const o = new THREE.Mesh(g, m); root.add(o); return o; };
    add(P.paint, paint); add(P.glass, coupeMats.glass); add(P.tails, coupeMats.tails);
    for(const g of P.dark) add(g, coupeMats.dark);
    for(const g of P.lights) add(g, coupeMats.lights);
    for(const [x, y, z] of P.wheels){ add(P.tyre, coupeMats.tyre).position.set(x, y, z); add(P.rim, coupeMats.rim).position.set(x, y, z); }
    const inst = {
      carId, root, paint, fallback: true, size: new THREE.Vector3(1.98, 1.3, 4.3),
      repaint(c){ setPaint(paint, paintHex(c, carId)); inst.code = c; },
      dispose(){ if(root.parent) root.parent.remove(root); paint.dispose(); },
    };
    inst.repaint(code);
    return inst;
  }
  // the note under a stand-in: visible, small (the label says it to a screen reader)
  const note = document.createElement('p');
  note.className = 'stand-note'; note.textContent = 'Модель не загрузилась';
  note.hidden = true; note.setAttribute('aria-hidden', 'true');
  el.append(note);
  const showNote = () => { note.hidden = !(cur.inst && cur.inst.fallback); };

  // the loading outline: brand cyan, added light, breathing in frame()
  const outlineMat = keep(new THREE.LineBasicMaterial({ color: 0x3ef0ff, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));

  function makeSlot(){
    const group = new THREE.Group(), turn = new THREE.Group();
    const disc = new THREE.Mesh(discGeo, discMat); disc.position.y = -DISC_H / 2;
    const edge = new THREE.Mesh(edgeGeo, edgeMat); edge.rotation.x = Math.PI / 2; edge.position.y = 0.002;
    const halo = new THREE.Mesh(haloGeo, haloMat); halo.rotation.x = -Math.PI / 2; halo.position.y = -DISC_H + 0.01;
    const under = new THREE.Mesh(flatGeo, underMat); under.rotation.x = -Math.PI / 2; under.position.y = -DISC_H - 0.01; under.scale.set(DISC_R * 2.9, DISC_R * 2.9, 1);
    const blob = new THREE.Mesh(flatGeo, blobMat); blob.rotation.x = -Math.PI / 2; blob.position.y = 0.004; blob.visible = false;
    const outline = new THREE.Group(); outline.visible = false;
    for(const g of outlineGeometry()) outline.add(new THREE.LineSegments(g, outlineMat));
    turn.add(blob, outline); group.add(disc, edge, halo, under, turn); scene.add(group);
    if(street){ disc.visible = edge.visible = halo.visible = under.visible = false; }
    // x, v, target: where it is across the stand, its speed, where it is going
    return { group, turn, blob, outline, ao: [], inst: null, carId: null, ready: Promise.resolve(null), token: 0, alive: true, x: 0, v: 0, target: 0, flow: null, sweepIn: 0 };
  }

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const LOOK = new THREE.Vector3(0, 0.55, 0);

  /* ---------- the car ---------- */
  // cur: the podium on show; gone: the one sliding away after a change (or null)
  let cur = makeSlot(), gone = null, wanted = null, span = 12;
  function fill(slot, id, code){
    const my = ++slot.token;
    slot.carId = id;
    // nothing on this podium yet: the outline stands in until the model is there (a car
    // already standing here stays instead, until the new one replaces it)
    if(!slot.inst){
      slot.outline.visible = true;
      if(slot === cur){ el.setAttribute('aria-label', carById(id).name + ': загружается'); showNote(); }
    }
    return makeModel(id, code, env).then(inst => {
      if(my !== slot.token || !slot.alive || disposed){ inst.dispose(); return null; }   // another car was asked for meanwhile
      if(slot.inst) slot.inst.dispose();
      slot.inst = inst;
      if(!street) flowable(inst.paint);
      slot.outline.visible = false;
      if(slot === cur && wanted.code !== inst.code) inst.repaint(wanted.code);
      slot.turn.add(inst.root);
      slot.blob.scale.set(inst.size.x * 1.55, inst.size.z * 1.22, 1);
      slot.blob.visible = true;
      if(street) contact(slot, inst);
      if(slot === cur) describe();
      return inst;
    }).catch(e => {
      if(my !== slot.token || !slot.alive || disposed) return null;
      console.error('stand: the model of ' + id + ' did not load: ' + (e && e.message || e));
      // never an empty podium: the game's own coupe stands in, in the paint asked for
      if(slot.inst) slot.inst.dispose();
      const inst = slot.inst = standInCoupe(id, slot === cur ? wanted.code : code);
      if(!street) flowable(inst.paint);
      slot.outline.visible = false;
      slot.turn.add(inst.root);
      slot.blob.scale.set(inst.size.x * 1.55, inst.size.z * 1.22, 1);
      slot.blob.visible = true;
      if(street) contact(slot, inst);
      if(slot === cur) describe();
      return inst;
    });
  }
  // On the street: the ambient occlusion under the body, a soft rounded rectangle the size of
  // the footprint (dark in its middle, fading out a hand past the sills), and under each tyre
  // its contact: a small, tight, near-black spot the width of the tread, found from the wheel
  // pivots. Both lie over the reflection, so the mirrored car meets the real one at the tyres.
  function contact(slot, inst){
    for(const m of slot.ao) slot.turn.remove(m);
    slot.ao.length = 0;
    slot.blob.scale.set(inst.size.x * 1.32, inst.size.z * 1.22, 1);
    slot.turn.updateMatrixWorld(true);
    const v = new THREE.Vector3(), tw = Math.max(0.2, inst.size.x * 0.12), tl = 0.36;
    let wheels = inst.wheels.map(w => slot.turn.worldToLocal(w.getWorldPosition(v.clone())));
    if(!wheels.length){ const hx = inst.size.x * 0.4, hz = inst.size.z * 0.32; wheels = [[hx, hz], [-hx, hz], [hx, -hz], [-hx, -hz]].map(([x, z]) => new THREE.Vector3(x, 0, z)); }
    for(const w of wheels){
      const m = new THREE.Mesh(flatGeo, aoMat); m.rotation.x = -Math.PI / 2; m.position.set(w.x, 0.006, w.z); m.scale.set(tw * 1.7, tl * 1.9, 1);
      slot.turn.add(m); slot.ao.push(m);
    }
  }
  function drop(slot){
    slot.alive = false; slot.token++;
    if(slot.inst){ slot.inst.dispose(); slot.inst = null; }
    scene.remove(slot.group);
  }
  // Show car `carId` painted `code`. dir: 0 swaps in place (the old car stays until the new
  // one is loaded); +1 / -1 slides: the podium leaves to the left (+1, the next car) or the
  // right (-1) and the new one comes in from the other side. A change while one is still
  // sliding carries on from where things are; changing back brings the leaving car back.
  function setCar(carId, code, dir = 0){
    const id = carById(carId).id;
    wanted = { id, code };
    const i = CARS.findIndex(c => c.id === id);
    preload([CARS[i - 1], CARS[i + 1]].filter(Boolean).map(c => c.id));   // the neighbours next, while idle
    if(cur.carId === id){ repaint(code); return cur.ready; }
    if(dir && !reduced.matches && cur.carId){
      if(gone && gone.carId === id){                  // back to the car that is leaving: it turns round
        [cur, gone] = [gone, cur];
        if(cur.inst) describe(); else { el.setAttribute('aria-label', carById(id).name + ': загружается'); showNote(); }
      } else {
        if(gone) drop(gone);
        gone = cur;
        cur = makeSlot();
        cur.x = dir * span;
        cur.ready = fill(cur, id, code);
      }
      if(studio) cur.sweepIn = -dir;                  // swept as it settles, the way it came
      gone.target = -dir * span; cur.target = 0;
      repaint(code);
      return cur.ready;
    }
    if(gone){ drop(gone); gone = null; }
    cur.x = cur.target = cur.v = 0;
    cur.ready = fill(cur, id, code);
    return cur.ready;
  }
  function repaint(code, { flow = false } = {}){
    if(wanted) wanted.code = code;
    if(!cur.inst || cur.inst.code === code) return;
    // what the body shows now (half-way through a flow, still mostly the old colour)
    const was = cur.flow && cur.flow.t < 0.5 ? cur.flow.from.clone() : cur.inst.paint.color.clone();
    cur.inst.repaint(code); describe();
    if(flow && !reduced.matches && cur.inst.paint.userData.flow) startFlow(cur, was, 1, PAINT_MS);
    else endFlow(cur);
  }
  // a flow on a slot: from: the colour still ahead of the edge; dir: +1 left to right
  function startFlow(slot, from, dir, ms){
    const u = slot.inst && slot.inst.paint.userData.flow; if(!u) return;
    slot.flow = { t: 0, ms, from, dir };
    u.uFrom.value.copy(from); u.uDir.value = dir; u.uFlow.value = 0; u.uGlint.value = 1; u.uCx.value = slot.x; u.uOn.value = 1;
  }
  function endFlow(slot){
    slot.flow = null;
    const u = slot.inst && slot.inst.paint.userData.flow; if(!u) return;
    u.uFlow.value = 1; u.uGlint.value = 0; u.uOn.value = 0;   // idle: the shader's lines change nothing
  }
  function tickFlow(slot, dt){
    if(slot.sweepIn && slot.inst && Math.abs(slot.x - slot.target) < span * 0.12){
      const d = slot.sweepIn; slot.sweepIn = 0;
      if(!reduced.matches) startFlow(slot, slot.inst.paint.color, d, SWEEP_MS);
    }
    const f = slot.flow; if(!f) return;
    if(!slot.inst || reduced.matches){ endFlow(slot); return; }
    f.t = Math.min(1, f.t + dt * 1000 / f.ms);
    const u = slot.inst.paint.userData.flow;
    u.uFlow.value = easeOut(f.t); u.uCx.value = slot.x;
    if(f.t >= 1) endFlow(slot);
  }
  function sweep(dir = 1){
    if(reduced.matches || !cur.inst) return;
    startFlow(cur, cur.inst.paint.color, dir, SWEEP_MS);
  }
  function describe(){
    showNote();
    if(!cur.inst) return;
    el.setAttribute('aria-label', carById(cur.inst.carId).name + ', цвет ' + paintByCode(cur.inst.code).name.toLowerCase()
      + (cur.inst.fallback ? '; модель не загрузилась' : ''));
  }
  // The slide: a critically damped spring (no overshoot) that keeps its speed when the
  // target changes mid-way. RESPONSE: about how long it takes, in seconds.
  const RESPONSE = 0.42, W = TAU / RESPONSE;
  function slide(slot, dt){
    for(let t = dt; t > 0; t -= 1 / 120){
      const h = Math.min(t, 1 / 120);
      slot.v += (-W * W * (slot.x - slot.target) - 2 * W * slot.v) * h;
      slot.x += slot.v * h;
    }
    if(Math.abs(slot.x - slot.target) < 0.004 && Math.abs(slot.v) < 0.05){ slot.x = slot.target; slot.v = 0; }   // 4 mm: there
    slot.group.position.x = slot.x;
  }
  el.setAttribute('role', 'img');

  /* ---------- turning: by itself, by hand, coasting after a flick ---------- */
  // angle: where it is; vel: rad/s now; idle: s since the last touch.
  const spin = { angle: 0.6, vel: 0, idle: IDLE, grab: null };
  const autoSpeed = () => reduced.matches || street ? 0 : AUTO;
  spin.vel = autoSpeed();
  const hist = [];                                   // the last moves: [t ms, x px]
  function down(e){
    if(spin.grab !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;   // one finger at a time
    spin.grab = e.pointerId;
    el.setPointerCapture(e.pointerId);
    spin.vel = 0; spin.lastX = e.clientX;           // caught: it stops under the finger at once
    hist.length = 0; hist.push([e.timeStamp, e.clientX]);
    el.classList.add('grabbing');
  }
  function move(e){
    if(e.pointerId !== spin.grab) return;
    const w = Math.max(1, el.clientWidth);
    // coalesced events: every point the pointer passed, for an even turn and a true speed
    const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for(const p of (pts.length ? pts : [e])){
      spin.angle += (p.clientX - spin.lastX) / w * DRAG_TURN;
      spin.lastX = p.clientX;
      hist.push([p.timeStamp, p.clientX]);
    }
    while(hist.length > 2 && hist[hist.length - 1][0] - hist[0][0] > 100) hist.shift();
  }
  function up(e){
    if(e.pointerId !== spin.grab) return;
    spin.grab = null; spin.idle = 0;
    el.classList.remove('grabbing');
    // the speed over the last ~100 ms; a finger that stopped before letting go doesn't fling.
    // "Stopped": no move for 80 ms, or for three of its own move gaps on a slow device
    // (where moves come only every frame, 100+ ms apart), at most 250 ms.
    const a = hist[0], b = hist[hist.length - 1];
    const dt = b && a ? (b[0] - a[0]) / 1000 : 0;
    const gap = hist.length > 1 ? dt * 1000 / (hist.length - 1) : 0;
    const still = b ? (e.timeStamp - b[0]) > Math.max(80, Math.min(gap * 3, 250)) : true;
    let v = dt > 0.005 && !still ? (b[1] - a[1]) / dt / Math.max(1, el.clientWidth) * DRAG_TURN : 0;
    spin.vel = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, v));
  }
  const off = new AbortController(), opt = { signal: off.signal };
  el.addEventListener('pointerdown', down, opt);
  el.addEventListener('pointermove', move, opt);
  for(const t of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(t, up, opt);
  el.classList.add('stand');

  function step(dt){
    if(spin.grab !== null) return;                  // under the finger: only the finger moves it
    spin.idle += dt;
    if(spin.idle < IDLE){
      spin.vel *= Math.pow(COAST, dt * 1000);       // a flick coasts and slows down
    } else {
      // then eases back into the slow turn, from whatever speed it has now
      spin.vel += (autoSpeed() - spin.vel) * (1 - Math.exp(-dt / RESUME * 3));
    }
    spin.angle += spin.vel * dt;
  }

  /* ---------- drawing ---------- */
  let last = 0, disposed = false;
  const box = { w: 0, h: 0, hz: 0 }, P = new THREE.Vector3(), anchor = { x: 0, y: 0, sway: 0 };
  // street: where the backdrop's horizon is (css px from the top), and how far under it the
  // tyres stand (a share of the box's height); the host sets it (setStreet)
  const streetAt = { horizon: 0, below: 0.06 };
  // The box on screen, the camera framed to it, and where the podium stands in it (for the
  // backdrop behind: its light pool). Null while the box is hidden or off screen.
  function place(){
    if(disposed || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const vw = renderer.domElement.clientWidth || innerWidth, vh = renderer.domElement.clientHeight || innerHeight;
    if(r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return null;
    if(el.checkVisibility && !el.checkVisibility({ visibilityProperty: true })) return null;   // in a hidden screen
    if(street && (r.width !== box.w || r.height !== box.h || box.hz !== streetAt.horizon)){
      box.w = r.width; box.h = r.height; box.hz = streetAt.horizon;
      // the car takes a share of the width (more on a narrow screen), seen from ~4° up, and
      // its contact line is put a little under the horizon of the backdrop's street
      const aspect = r.width / r.height, vFov = camera.fov * Math.PI / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const share = aspect < 0.8 ? 0.9 : aspect < 1.3 ? 0.62 : 0.42;
      const dist = 2.45 / (share * Math.tan(hFov / 2));
      span = dist * Math.tan(hFov / 2) + 3.5;
      const elev = 0.07;
      camera.aspect = aspect; camera.clearViewOffset();
      camera.position.set(0, LOOK.y + Math.sin(elev) * dist, Math.cos(elev) * dist);
      camera.lookAt(LOOK); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      P.set(0, 0, 0).project(camera);
      const at = (1 - P.y) / 2 * r.height, want = (streetAt.horizon - r.top) + r.height * streetAt.below;
      camera.setViewOffset(r.width, r.height, 0, at - want, r.width, r.height);
      camera.updateProjectionMatrix();
    } else if(!street && (r.width !== box.w || r.height !== box.h)){
      box.w = r.width; box.h = r.height;
      // frame the whole podium in any box: wide boxes fit its height, narrow ones its width
      const aspect = r.width / r.height, vFov = camera.fov * Math.PI / 180;
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
      const reach = DISC_R + 0.6;
      const dist = Math.max(reach / Math.tan(hFov / 2), 2.6 / Math.tan(vFov / 2));
      span = dist * Math.tan(hFov / 2) + DISC_R + 0.8;        // far enough to the side to be out of the box
      const elev = 0.24;                                    // ~14° from above
      camera.aspect = aspect; camera.clearViewOffset();
      camera.position.set(0, LOOK.y + Math.sin(elev) * dist, Math.cos(elev) * dist);
      camera.lookAt(LOOK);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();                           // (render() would, but the anchor below is now)
      // a tall narrow box (a phone upright): the podium stands lower in it, on the floor
      // under the lamp, not in the middle of the sky with an empty floor beneath
      if(studio && aspect < 1){
        P.set(0, -DISC_H / 2, 0).project(camera);
        const at = (1 - P.y) / 2 * r.height, want = r.height * 0.7;
        camera.setViewOffset(r.width, r.height, 0, at - want, r.width, r.height);
        camera.updateProjectionMatrix();
      }
    }
    P.set(0, street ? 0 : -DISC_H / 2, 0).project(camera);
    anchor.x = r.left + (P.x + 1) / 2 * r.width; anchor.y = r.top + (1 - P.y) / 2 * r.height;
    anchor.sway = Math.sin(spin.angle);
    return r;
  }
  function frame(now){
    const dt = last ? Math.min(0.25, (now - last) / 1000) : 0;   // from time, not frames; a long gap is not a jump
    last = now;
    const r = place();
    if(!r) return false;
    const vw = renderer.domElement.clientWidth || innerWidth, vh = renderer.domElement.clientHeight || innerHeight;
    step(dt);
    for(const slot of [cur, gone]) if(slot){ slide(slot, dt); slot.turn.rotation.y = spin.angle; tickFlow(slot, dt); }
    // the outline breathes (1.6 s), or holds still for reduced motion
    outlineMat.opacity = reduced.matches ? 0.6 : 0.42 + 0.3 * (0.5 + 0.5 * Math.sin(now / 1000 * TAU / 1.6));
    if(gone && Math.abs(gone.x) > span - 0.2){ drop(gone); gone = null; }   // out of the box: gone

    const x = r.left, y = vh - r.bottom;
    // only depth is cleared: what the host drew behind the box (the night city) shows through
    const exposure = renderer.toneMappingExposure, scissor = renderer.getScissorTest(), clearColor = renderer.autoClearColor;
    renderer.toneMappingExposure = EXPOSURE; renderer.autoClearColor = false;
    renderer.setViewport(x, y, r.width, r.height);
    renderer.setScissor(x, y, r.width, r.height);
    renderer.setScissorTest(true);
    if(street) mirror();
    renderer.render(scene, camera);
    renderer.setScissorTest(scissor);
    renderer.setViewport(0, 0, vw, vh);
    renderer.toneMappingExposure = exposure; renderer.autoClearColor = clearColor;
    return true;
  }

  // The reflection on the wet street: the cars flipped under the ground and drawn first,
  // with nothing else of the stand (shadows, outlines) in that pass, marking the stencil where
  // they are. Then thin dark sheets of "water" at the ground and every 12 cm under it, drawn
  // only over the reflection: a point of the mirrored car h metres down is seen through about
  // h / 12 cm of them, so the reflection is clear at the tyres and fades out with height, as on
  // asphalt; nothing around the car is darkened.
  const SHEETS = 9, sheetScene = new THREE.Scene();
  const sheetMat = (op) => keep(new THREE.MeshBasicMaterial({ color: 0x05060d, transparent: true, opacity: op, depthWrite: false, toneMapped: false,
    stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc, stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.KeepStencilOp }));
  if(street){
    const sheetGeo = keep(new THREE.PlaneGeometry(60, 60)), top = sheetMat(0.55), under = sheetMat(0.3);
    for(let i = 0; i < SHEETS; i++){ const m = new THREE.Mesh(sheetGeo, i ? under : top); m.rotation.x = -Math.PI / 2; m.position.y = -0.002 - i * 0.12; m.renderOrder = i; sheetScene.add(m); }
  }
  const saved = [], seen = new Set();
  function mirror(){
    const shown = [cur, gone].filter(s => s && s.inst);
    if(!shown.length) return;
    for(const s of [cur, gone]) if(s){ s.blob.visible = false; for(const m of s.ao) m.visible = false; s.outline.visible = false; }
    for(const s of shown){
      s.turn.scale.y = -1;
      // (a material shared by several meshes, the four tyres, is changed and put back once)
      s.inst.root.traverse(o => { if(!o.isMesh) return; for(const m of [].concat(o.material)){ if(seen.has(m)) continue; seen.add(m);
        saved.push([m, m.stencilWrite, m.stencilRef, m.stencilFunc, m.stencilZPass]);
        m.stencilWrite = true; m.stencilRef = 1; m.stencilFunc = THREE.AlwaysStencilFunc; m.stencilZPass = THREE.ReplaceStencilOp; } });
    }
    const e = renderer.toneMappingExposure; renderer.toneMappingExposure = e * 0.7;
    renderer.clear(false, false, true);
    renderer.render(scene, camera);
    renderer.toneMappingExposure = e;
    for(const [m, sw, sr, sf, sz] of saved){ m.stencilWrite = sw; m.stencilRef = sr; m.stencilFunc = sf; m.stencilZPass = sz; }
    saved.length = 0; seen.clear();
    for(const s of [cur, gone]) if(s){ s.turn.scale.y = 1; s.blob.visible = !!s.inst; for(const m of s.ao) m.visible = true; s.outline.visible = !s.inst; }
    // the sheets lie where the car stands now (it may be sliding across)
    sheetScene.position.copy(cur.group.position);
    const auto = renderer.autoClear; renderer.autoClear = false;
    renderer.render(sheetScene, camera);
    renderer.autoClear = auto;
    renderer.clear(false, true, true);
  }
  const glow = new THREE.Color();
  function setGlow(c){
    glow.set(c);
    bounce.color.copy(glow);
    rim.color.copy(glow).lerp(new THREE.Color(0xffffff), 0.35);
  }

  function dispose(){
    disposed = true;                 // (drop() below retires each slot's pending load)
    off.abort();
    drop(cur); if(gone) drop(gone);
    note.remove();
    for(const x of own) x.dispose();
  }

  return {
    setCar, repaint, sweep, frame, dispose, scene, camera, setGlow,
    // street: the backdrop's horizon (css px) and how far under it the tyres stand
    setStreet(horizon, below = streetAt.below){ streetAt.horizon = horizon; streetAt.below = below; },
    get car(){ return cur.inst; },
    // the podium on screen now ({x, y, sway}, css px), or null while the box is not shown;
    // the host calls it before drawing what is behind, in the same frame
    measure(){ return place() ? anchor : null; },
    get sliding(){ return !!gone || cur.x !== cur.target; },
    get podiums(){ return [cur, gone].filter(Boolean).map(s => ({ carId: s.carId, x: s.x, loaded: !!s.inst && !s.inst.fallback, fallback: !!(s.inst && s.inst.fallback), outline: s.outline.visible })); },
    get spin(){ return { angle: spin.angle, vel: spin.vel, idle: spin.idle, held: spin.grab !== null }; },
  };
}

// A drawing loop that stands still while the tab is hidden (no frame is even scheduled),
// and comes back without a jump: tick(now) gets the rAF time.
export function startLoop(tick){
  let id = 0, on = true;
  const run = now => { id = 0; if(!on || document.hidden) return; tick(now); id = requestAnimationFrame(run); };
  const wake = () => { if(on && !document.hidden && !id) id = requestAnimationFrame(run); };
  document.addEventListener('visibilitychange', wake);
  wake();
  return { stop(){ on = false; if(id) cancelAnimationFrame(id); id = 0; document.removeEventListener('visibilitychange', wake); },
           get running(){ return !!id; } };
}
