// Renderer, scene, camera, sky and lights shared by every mode.
import { $, isTouch } from '../state.js';

export const canvas = $('c');
export const renderer = new THREE.WebGLRenderer({canvas, antialias:true, powerPreference:'high-performance'});
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.5 : 2));
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

export const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080f);
scene.fog = new THREE.FogExp2(0x0d0a1e, 0.0058);
export const camera = new THREE.PerspectiveCamera(64, 1, 0.1, 1200);
function resize(){ renderer.setSize(innerWidth, innerHeight, false); camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();

/* ---------- canvas textures ---------- */
export function cv(w,h){ const c=document.createElement('canvas'); c.width=w; c.height=h; return [c, c.getContext('2d')]; }
export function tex(c, rep){ const t=new THREE.CanvasTexture(c); t.encoding=THREE.sRGBEncoding; if(rep){t.wrapS=t.wrapT=THREE.RepeatWrapping;} t.anisotropy=renderer.capabilities.getMaxAnisotropy(); return t; }

export const glowTex = (() => {
  const [c,g]=cv(128,128); const gr=g.createRadialGradient(64,64,0,64,64,64);
  gr.addColorStop(0,'rgba(255,255,255,1)'); gr.addColorStop(.35,'rgba(255,255,255,.45)'); gr.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=gr; g.fillRect(0,0,128,128); return tex(c,false);
})();
export const winTex = (() => {
  const [c,g]=cv(128,256); g.fillStyle='#000'; g.fillRect(0,0,128,256);
  const cols=['#ffcf7a','#ffcf7a','#7ff5ff','#ff6b93','#c9b8ff'];
  for(let y=8;y<250;y+=14) for(let x=6;x<124;x+=12){ if(Math.random()<.32){ g.fillStyle=cols[(Math.random()*cols.length)|0]; g.globalAlpha=.35+Math.random()*.65; g.fillRect(x,y,7,8);} }
  g.globalAlpha=1; return tex(c,false);
})();
const skyTex = (() => {
  const [c,g]=cv(4,256); const gr=g.createLinearGradient(0,0,0,256);
  gr.addColorStop(0,'#03040a'); gr.addColorStop(.55,'#0a0a20'); gr.addColorStop(.8,'#26104a'); gr.addColorStop(.875,'#7a1f55'); gr.addColorStop(.9,'#1d0e2a'); gr.addColorStop(1,'#07080f');
  g.fillStyle=gr; g.fillRect(0,0,4,256); return tex(c,false);
})();

// What glossy car paint and glass reflect: a tiny picture of the night around the road
// (dark sky, the rose glow on the horizon, street lamps, the two neon rails). Six 64 px
// faces drawn once; only the cars use it, so the road and the buildings look as before.
export const carEnv = (() => {
  const side = k => { const [c,g]=cv(64,64);
    const gr=g.createLinearGradient(0,0,0,64);
    gr.addColorStop(0,'#04050d'); gr.addColorStop(.36,'#141033'); gr.addColorStop(.47,'#5a1c58'); gr.addColorStop(.5,'#ff5a9a'); gr.addColorStop(.53,'#2a1038'); gr.addColorStop(.62,'#0b0b16'); gr.addColorStop(1,'#07070c');
    g.fillStyle=gr; g.fillRect(0,0,64,64);
    g.fillStyle=k%2?'#3ef0ff':'#ff3b6b'; g.fillRect(0,33,64,1);                         // a neon rail
    for(const [x,y,r] of [[10+k*7,20,3],[38-k*3,14,2.4],[54,24,2]]){ const l=g.createRadialGradient(x,y,0,x,y,r*2.4);
      l.addColorStop(0,'rgba(255,236,200,1)'); l.addColorStop(1,'rgba(255,200,140,0)'); g.fillStyle=l; g.fillRect(x-8,y-8,16,16); }   // lamps
    return c; };
  const flat = col => { const [c,g]=cv(64,64); g.fillStyle=col; g.fillRect(0,0,64,64); return c; };
  const t=new THREE.CubeTexture([side(0),side(1),flat('#04050d'),flat('#08080d'),side(2),side(3)]);
  t.encoding=THREE.sRGBEncoding; t.needsUpdate=true; return t;
})();

/* ---------- sky ---------- */
// The sky and stars stay centred on the drift track; the highway moves them with the camera.
export const stars = new THREE.Group();
export const sky = new THREE.Mesh(new THREE.CylinderGeometry(800,800,400,40,1,true), new THREE.MeshBasicMaterial({map:skyTex, side:THREE.BackSide, fog:false, depthWrite:false}));
sky.position.y = 150; scene.add(sky, stars);
{ const n=700, a=new Float32Array(n*3); for(let i=0;i<n;i++){ const th=Math.random()*Math.PI*2, ph=Math.random()*Math.PI*.42; a[i*3]=Math.cos(th)*Math.sin(ph)*700; a[i*3+1]=Math.cos(ph)*700*.6+60; a[i*3+2]=Math.sin(th)*Math.sin(ph)*700; }
  const g=new THREE.BufferGeometry(); g.setAttribute('position',new THREE.BufferAttribute(a,3));
  stars.add(new THREE.Points(g,new THREE.PointsMaterial({color:0xcfd6ff,size:1.4,sizeAttenuation:false,fog:false,transparent:true,opacity:.8}))); }

/* ---------- lights ---------- */
scene.add(new THREE.HemisphereLight(0x8090ff, 0x241030, 0.65));
export const moon = new THREE.DirectionalLight(0xbcc6ff, 0.75);
moon.castShadow = true; moon.shadow.mapSize.set(2048,2048);
Object.assign(moon.shadow.camera,{left:-40,right:40,top:40,bottom:-40,near:1,far:220});
moon.shadow.bias = -0.0006;
scene.add(moon, moon.target);

/* ---------- automatic quality ----------
   While racing, the frame rate is averaged over 3 s. Below 45 fps the picture steps
   down one level, at most every 3 s: first fewer pixels, then coarser moon shadows,
   then fewer pixels again. (Shadows are made cheaper, not switched off: switching them
   off recompiles every material, a second-long freeze on a slow phone.) It never steps
   back up during a session, so it cannot flicker between levels; a reload starts
   from the top again. A fast device never leaves level 0 and looks as before. */
const TOP_RATIO = Math.min(devicePixelRatio, isTouch ? 1.5 : 2);
export const QUALITY = [
  { ratio: TOP_RATIO, shadow: 2048 },
  { ratio: Math.min(TOP_RATIO, 1.25), shadow: 2048 },
  { ratio: Math.min(TOP_RATIO, 1), shadow: 2048 },
  { ratio: Math.min(TOP_RATIO, 1), shadow: 1024 },
  { ratio: Math.min(TOP_RATIO, .8), shadow: 512 },
];
const Q = { level: 0, t: 0, frames: 0 };
export const quality = () => Q.level;
function applyQuality(){
  const L = QUALITY[Q.level];
  if(renderer.getPixelRatio() !== L.ratio){ renderer.setPixelRatio(L.ratio); resize(); }
  if(moon.shadow.mapSize.x !== L.shadow){
    moon.shadow.mapSize.set(L.shadow, L.shadow);
    if(moon.shadow.map){ moon.shadow.map.dispose(); moon.shadow.map = null; }   // rebuilt at the new size next frame
  }
}
// realDt: seconds since the last frame; racing: whether the clock should run.
export function qualityTick(realDt, racing){
  if(!racing || realDt > .25){ Q.t = Q.frames = 0; return; }   // a hitch (tab switch, loading) is not slowness
  Q.t += realDt; Q.frames++;
  if(Q.t < 3) return;
  const fps = Q.frames / Q.t; Q.t = Q.frames = 0;
  if(fps < 45 && Q.level < QUALITY.length - 1){ Q.level++; applyQuality(); }
}

/* ---------- the menu backdrop ----------
   Behind the menus (home, the mode cards, the garage, the lobby) the race is not drawn: a
   drawn night city stands there instead. Two layers of skyline are painted once into
   canvases at the screen's resolution (the far one at half of it: it sits in the haze
   anyway); everything smooth (the sky, the glow on the horizon, the haze, the wet floor,
   the light pool under the podium) is worked out per pixel in one pass, in floats, and
   dithered, so no gradient bands. The floor mirrors the near skyline, stretched and
   smeared like wet asphalt.
   captureBackdrop() repaints the skyline when the window's size changed (cheap otherwise;
   drawBackdrop calls it); drawBackdrop(anchor) fills the canvas, one quad per frame. The
   horizon depends on the window only (where the garage's and the lobby's podiums stand,
   about the car's waist), so going from one menu screen to the next never moves the city.
   `anchor` is a stand's podium on screen ({x, y, sway}, css px): a light pool fades in
   under it, and the two layers drift apart a little as the stand turns (not with reduced
   motion).
   WebGL and not CSS: the stand draws into this same canvas over what is behind it, and a
   transparent canvas would make every race frame pay for blending with the page. */
const BACK = { key: '', far: null, near: null, ov: 28, sway: 0, pool: 0, t: 0 };
// a lost and restored GL context: paint the skyline again into fresh textures
canvas.addEventListener('webglcontextrestored', () => { BACK.key = ''; });
const NEAR_SHIFT = 16, FAR_SHIFT = 5;             // css px the layers drift at full sway
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const backScene = new THREE.Scene(), backCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const backMat = new THREE.ShaderMaterial({
  uniforms: {
    farMap: { value: null }, nearMap: { value: null },
    view: { value: new THREE.Vector2(1, 1) }, scale: { value: 1 }, horizon: { value: 0 },
    pod: { value: new THREE.Vector3() }, sway: { value: 0 },
    farBox: { value: new THREE.Vector3() }, nearBox: { value: new THREE.Vector3() },
  },
  vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0., 1.); }',
  // colours are sRGB values written straight out (no tone mapping): they are the tokens'
  fragmentShader: `uniform sampler2D farMap, nearMap; uniform vec2 view; uniform float scale, horizon, sway;
    uniform vec3 pod, farBox, nearBox;
    const vec3 ROSE = vec3(1., .231, .420), CYAN = vec3(.243, .941, 1.), HAZE = vec3(.17, .09, .25);
    // a layer of skyline: box = (left, width, height above the horizon), css px
    vec4 layer(sampler2D m, vec3 box, vec2 p){
      vec2 uv = vec2((p.x - box.x) / box.y, (horizon - p.y) / box.z);
      if(uv.x < 0. || uv.x > 1. || uv.y < 0. || uv.y > 1.) return vec4(0.);
      return texture2D(m, uv);
    }
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main(){
      vec2 p = vec2(gl_FragCoord.x * scale, view.y - gl_FragCoord.y * scale);
      float H = view.y, up = horizon - p.y;
      vec3 col;
      if(up >= 0.){
        // the sky: near black on top, violet lower down, the city's rose glow on the horizon
        float t = up / max(horizon, 1.);
        col = mix(vec3(.060, .035, .120), vec3(.030, .032, .090), smoothstep(0., .45, t));
        col = mix(col, vec3(.010, .013, .035), smoothstep(.4, 1., t));
        col += ROSE * .26 * exp(-up / (.08 * H)) + vec3(.30, .10, .42) * .12 * exp(-up / (.28 * H));
        vec4 f = layer(farMap, farBox, vec2(p.x + sway * ${FAR_SHIFT.toFixed(1)}, p.y));
        col = col * (1. - f.a) + f.rgb;
        col = mix(col, HAZE, .5 * exp(-up / (.06 * H)));                 // haze between the layers
        vec4 n = layer(nearMap, nearBox, vec2(p.x + sway * ${NEAR_SHIFT.toFixed(1)}, p.y));
        col = col * (1. - n.a) + n.rgb;
        col = mix(col, HAZE, .5 * exp(-up / (.025 * H)));                // and low over the street
      } else {
        // the floor: wet asphalt, lit by the horizon, mirroring the near skyline
        float d = -up, fd = d / max(H - horizon, 1.);
        col = mix(vec3(.045, .040, .095), vec3(.010, .012, .028), smoothstep(0., 1., fd));
        col += ROSE * .10 * exp(-d / (.05 * H));
        vec2 q = vec2(p.x + sway * ${NEAR_SHIFT.toFixed(1)} + sin(d * .23) * 1.1, horizon - d * .62);
        vec4 r = layer(nearMap, nearBox, q) * .3
               + (layer(nearMap, nearBox, q + vec2(-2., 0.)) + layer(nearMap, nearBox, q + vec2(2., 0.))) * .2
               + (layer(nearMap, nearBox, q + vec2(0., -5.)) + layer(nearMap, nearBox, q + vec2(0., 5.))) * .15;
        float fade = .6 * exp(-d / (.2 * H));
        col = col * (1. - r.a * fade * .5) + r.rgb * fade;
        col = mix(col, HAZE, .45 * exp(-d / (.035 * H)));
        if(pod.z > 0.){                                                  // the light under the podium (z: how much)
          vec2 e = (p - pod.xy) / vec2(.36 * H + 60., .09 * H + 20.);
          float k = dot(e, e);
          col += (CYAN * .045 * exp(-k * 1.6) + ROSE * .03 * exp(-k * .35)) * smoothstep(0., 12., d) * pod.z;
        }
        col += (hash(gl_FragCoord.xy * .37) - .5) * .012;                // the asphalt's grain
      }
      // dither: a triangular ±1/255, so the smooth parts do not band
      col += (hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + 19.19) - 1.) / 255.;
      gl_FragColor = vec4(col, 1.);
    }`,
  depthTest: false, depthWrite: false,
});
backScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), backMat));

// a seeded random: the same city every time it is painted again (a resize, a new screen)
function seeded(seed){ return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
// One layer of skyline in css px (w × h, the base on the bottom edge) at `ratio` device px each.
function paintSkyline(w, h, ratio, near, tall){
  const [c, g] = cv(Math.max(2, Math.round(w * ratio)), Math.max(2, Math.round(h * ratio)));
  g.scale(ratio, ratio);
  const rnd = seeded(near ? 7331 : 1999), s = Math.min(1, Math.max(.5, w / 1500));
  const lights = near ? [['255,207,122', .55], ['127,245,255', .22], ['255,107,147', .13], ['201,184,255', .1]]
                      : [['255,196,140', .5], ['160,200,255', .3], ['255,120,170', .2]];
  const pick = () => { let r = rnd(); for(const [col, p] of lights){ if((r -= p) < 0) return col; } return lights[0][0]; };
  if(!near){                                                       // a few stars where the city's glow is thin
    for(let i = 0; i < 70; i++){ g.fillStyle = `rgba(210,220,255,${(.15 + rnd() * .45).toFixed(2)})`; const r = .5 + rnd() * .8; g.fillRect(rnd() * w, rnd() * h * .45, r, r); }
  }
  const signs = [];
  for(let x = -rnd() * 30; x < w;){
    const bw = (near ? 38 + rnd() * 92 : 26 + rnd() * 70) * s;
    const bh = near ? h * (.22 + Math.pow(rnd(), 1.8) * .78) : tall * (.3 + Math.pow(rnd(), 1.4) * .7);
    const top = h - bh;
    const body = g.createLinearGradient(0, top, 0, h);
    if(near){ body.addColorStop(0, '#0d0f22'); body.addColorStop(1, '#06070e'); }
    else { body.addColorStop(0, '#1b1640'); body.addColorStop(1, '#251a48'); }
    g.fillStyle = body; g.fillRect(x, top, bw, bh);
    // a setback on top, sometimes a mast with its red light
    let roof = top;
    if(rnd() < .35){ const sw = bw * (.4 + rnd() * .35), sh = bh * (.05 + rnd() * .1); g.fillRect(x + (bw - sw) / 2, top - sh, sw, sh); roof = top - sh; }
    if(rnd() < .25){ const mx = x + bw * (.3 + rnd() * .4), mh = (10 + rnd() * 26) * s; g.fillStyle = near ? '#0d0f22' : '#1b1640'; g.fillRect(mx, roof - mh, 1.2, mh);
      g.fillStyle = near ? 'rgba(255,59,107,.9)' : 'rgba(255,90,130,.5)'; g.fillRect(mx - .9, roof - mh - 1.5, 3, 3); }
    // the roof catches a little of the neon
    if(near && rnd() < .5){ g.fillStyle = rnd() < .6 ? 'rgba(62,240,255,.28)' : 'rgba(255,59,107,.3)'; g.fillRect(x, top, bw, 1); }
    // windows, floor by floor: some floors are lit through, most here and there
    const px = (near ? 7 : 5) * Math.max(.8, s), py = (near ? 9 : 6.5) * Math.max(.8, s);
    const ww = px * .45, wh = py * .5, rate = near ? .04 + rnd() * .24 : .03 + rnd() * .16;
    const tone = pick(), mixTone = rnd() < .3;
    for(let y = top + py * .9; y < h - py; y += py){
      const busy = rnd() < .12 ? 3.5 : rnd() < .3 ? 0 : 1;
      for(let wx = x + px * .6; wx < x + bw - px * .6; wx += px){
        if(rnd() >= rate * busy) continue;
        g.fillStyle = `rgba(${mixTone ? pick() : tone},${((near ? .3 : .12) + rnd() * (near ? .55 : .26)).toFixed(2)})`;
        g.fillRect(wx, y, ww, wh);
      }
    }
    if(near && bw > 60 * s && rnd() < .3) signs.push([x, top, bw, bh]);
    x += bw + (rnd() < .3 ? rnd() * 16 * s : 0);
  }
  // neon signs: a few vertical tubes, glowing (drawn last, so the glow lies over the walls)
  for(const [x, top, bw, bh] of signs){
    const col = rnd() < .55 ? '62,240,255' : '255,59,107', sx = x + bw * (rnd() < .5 ? .12 : .82), sy = top + bh * (.08 + rnd() * .15), sl = bh * (.18 + rnd() * .22);
    g.shadowColor = `rgba(${col},.9)`; g.shadowBlur = 14 * ratio;
    g.fillStyle = `rgba(${col},.85)`; g.fillRect(sx, sy, 2.6 * s, sl);
    g.shadowBlur = 0; g.fillStyle = 'rgba(255,255,255,.55)'; g.fillRect(sx + .8 * s, sy + 1, 1, sl - 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.premultiplyAlpha = true; t.generateMipmaps = false; t.minFilter = t.magFilter = THREE.LinearFilter;
  return t;
}
export function captureBackdrop(){
  const w = innerWidth, h = innerHeight;
  // the skyline at the menus' pixel ratio (menuPixels: 1.5, 1.25 on a touch screen), not
  // the canvas's current one, so home ↔ garage does not paint it again; under ~3.5 M pixels
  const span = w + BACK.ov * 2, nearH = h * .3, farH = h * .8;
  const ratio = Math.min(devicePixelRatio, isTouch ? 1.25 : 1.5, Math.sqrt(3.5e6 / (span * nearH)));
  const key = w + 'x' + h + '@' + ratio.toFixed(3);
  if(key === BACK.key) return;
  BACK.key = key;
  if(BACK.far){ BACK.far.dispose(); BACK.near.dispose(); }
  BACK.far = paintSkyline(span, farH, ratio / 2, false, h * .4);
  BACK.near = paintSkyline(span, nearH, ratio, true);
  const u = backMat.uniforms;
  u.farMap.value = BACK.far; u.nearMap.value = BACK.near;
  u.farBox.value.set(-BACK.ov, span, farH); u.nearBox.value.set(-BACK.ov, span, nearH);
}
// what the backdrop shows now (for tests): the horizon (css px from the top), the pool
export const backdropState = () => ({ horizon: backMat.uniforms.horizon.value, pool: backMat.uniforms.pod.value.z, key: BACK.key });
export function drawBackdrop(anchor){
  captureBackdrop();
  const u = backMat.uniforms, w = innerWidth, h = innerHeight, now = performance.now();
  const dt = now - BACK.t > 100 ? 1 / 60 : (now - BACK.t) / 1000; BACK.t = now;   // after a gap: a first frame
  u.view.value.set(w, h);
  u.scale.value = 1 / renderer.getPixelRatio();
  // the horizon: 43% of the height on a tall phone, 49% on a wide screen
  const a = Math.min(1, Math.max(0, (w / h - .5) / .5));
  u.horizon.value = h * (.43 + .06 * a * a * (3 - 2 * a));
  // the light pool follows the podium and fades in with it (~250 ms; at once for reduced motion)
  if(anchor){ u.pod.value.x = anchor.x; u.pod.value.y = anchor.y; }
  BACK.pool = !anchor ? 0 : reducedMotion.matches ? 1 : BACK.pool + (1 - BACK.pool) * (1 - Math.exp(-dt / .08));
  u.pod.value.z = BACK.pool < .002 ? 0 : BACK.pool;
  // the drift follows the stand's turn slowly: a flick does not shake the city
  const want = anchor && !reducedMotion.matches ? anchor.sway || 0 : 0;
  BACK.sway = reducedMotion.matches ? 0 : BACK.sway + (want - BACK.sway) * (1 - Math.exp(-dt / .9));
  u.sway.value = BACK.sway;
  renderer.setScissorTest(false);
  renderer.render(backScene, backCam);
}

// While a menu screen with a stand is up, fewer pixels (1.5x, 1.25x on a phone): the
// stand is small and the backdrop is soft. Back in the race, the quality level's own.
export function menuPixels(on){
  const r = on ? Math.min(TOP_RATIO, isTouch ? 1.25 : 1.5) : QUALITY[Q.level].ratio;
  if(renderer.getPixelRatio() !== r){ renderer.setPixelRatio(r); resize(); }
}
