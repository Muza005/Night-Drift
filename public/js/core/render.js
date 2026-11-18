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
   Behind the garage and the lobby the track is not drawn every frame: it is drawn once,
   small, into a texture, and that picture is shown blurred and dimmed behind the stand.
   captureBackdrop() takes the picture (on opening the screen, and on resize);
   drawBackdrop() fills the canvas with it, a single cheap pass per frame. */
let backRT = null;
const backScene = new THREE.Scene(), backCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const backMat = new THREE.ShaderMaterial({
  uniforms: { map: { value: null }, texel: { value: new THREE.Vector2() }, dim: { value: 0.62 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
  // a 25-tap blur on an eighth-size picture: soft enough to read as "behind", no detail left
  fragmentShader: `uniform sampler2D map; uniform vec2 texel; uniform float dim; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(map, vUv).rgb * .12;
      for(int i = 0; i < 8; i++){
        float a = float(i) * .7854 + .39;
        vec2 o = vec2(cos(a), sin(a)) * texel;
        c += texture2D(map, vUv + o * 1.3).rgb * .05 + texture2D(map, vUv + o * 2.8).rgb * .036 + texture2D(map, vUv + o * 4.6).rgb * .024;
      }
      gl_FragColor = vec4(c * dim, 1.);
      #include <tonemapping_fragment>
      #include <encodings_fragment>
    }`,
  depthTest: false, depthWrite: false,
});
backScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), backMat));
export function captureBackdrop(){
  const w = Math.max(48, Math.round(innerWidth / 8)), h = Math.max(48, Math.round(innerHeight / 8));
  if(!backRT || backRT.width !== w || backRT.height !== h){
    if(backRT) backRT.dispose();
    const half = renderer.capabilities.isWebGL2 || renderer.extensions.has('OES_texture_half_float');
    backRT = new THREE.WebGLRenderTarget(w, h, half ? { type: THREE.HalfFloatType } : {});   // linear light: tone mapping comes on the way out
  }
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setRenderTarget(backRT); renderer.render(scene, camera); renderer.setRenderTarget(null);
  backMat.uniforms.map.value = backRT.texture;
  backMat.uniforms.texel.value.set(1 / w, 1 / h);
}
export function drawBackdrop(){
  if(!backRT) captureBackdrop();
  renderer.setScissorTest(false);
  renderer.render(backScene, backCam);
}

// While a menu screen with a stand is up, fewer pixels (1.5x, 1.25x on a phone): the
// stand is small and the backdrop is a blur. Back in the race, the quality level's own.
export function menuPixels(on){
  const r = on ? Math.min(TOP_RATIO, isTouch ? 1.25 : 1.5) : QUALITY[Q.level].ratio;
  if(renderer.getPixelRatio() !== r){ renderer.setPixelRatio(r); resize(); }
}
