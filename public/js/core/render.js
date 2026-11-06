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
