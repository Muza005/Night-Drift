// Engine and tire sound generated in code, plus the impact thud.
import { $ } from '../state.js';

let A=null, muted=false;
export function audioInit(){
  if(A) { if(A.ctx.state==='suspended') A.ctx.resume(); return; }
  try{
    const ctx=new (window.AudioContext||window.webkitAudioContext)();
    const master=ctx.createGain(); master.gain.value=muted?0:.5; master.connect(ctx.destination);
    const o1=ctx.createOscillator(); o1.type='sawtooth'; const o2=ctx.createOscillator(); o2.type='square';
    const lp=ctx.createBiquadFilter(); lp.type='lowpass'; lp.frequency.value=600; lp.Q.value=5;
    const eg=ctx.createGain(); eg.gain.value=.07; o1.connect(lp); o2.connect(lp); lp.connect(eg); eg.connect(master); o1.start(); o2.start();
    const buf=ctx.createBuffer(1,ctx.sampleRate*2,ctx.sampleRate); const d=buf.getChannelData(0); for(let i=0;i<d.length;i++) d[i]=Math.random()*2-1;
    const ns=ctx.createBufferSource(); ns.buffer=buf; ns.loop=true;
    const bp=ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1500; bp.Q.value=3.5;
    const sg=ctx.createGain(); sg.gain.value=0; ns.connect(bp); bp.connect(sg); sg.connect(master); ns.start();
    A={ctx,master,o1,o2,lp,eg,sg,bp,buf};
  }catch(e){ A=null; }
}
export function audioUpdate(rpm,thr,slide){
  if(!A) return; const t=A.ctx.currentTime;
  const f=48+rpm*120+thr*8;
  A.o1.frequency.setTargetAtTime(f,t,.05); A.o2.frequency.setTargetAtTime(f*.5,t,.05);
  A.lp.frequency.setTargetAtTime(350+rpm*1500*(thr?1:.55),t,.08);
  A.eg.gain.setTargetAtTime(.05+thr*.05,t,.1);
  A.sg.gain.setTargetAtTime(slide*.16,t,.06); A.bp.frequency.setTargetAtTime(1300+slide*700,t,.1);
}
export function thud(power){
  if(!A||muted) return; const c=A.ctx; const s=c.createBufferSource(); s.buffer=A.buf;
  const f=c.createBiquadFilter(); f.type='lowpass'; f.frequency.value=380; const g=c.createGain();
  g.gain.setValueAtTime(Math.min(.9,power*.06),c.currentTime); g.gain.exponentialRampToValueAtTime(.001,c.currentTime+.35);
  s.connect(f); f.connect(g); g.connect(A.master); s.start(); s.stop(c.currentTime+.4);
}
export function toggleSound(){ muted=!muted; $('bSound').textContent='Звук: '+(muted?'выкл':'вкл'); if(A) A.master.gain.setTargetAtTime(muted?0:.5,A.ctx.currentTime,.05); }
export function audioSuspend(){ if(A) A.ctx.suspend(); }
export function audioResume(){ if(A) A.ctx.resume(); }
