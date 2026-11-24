// Small HUD and menu helpers shared by every module.
import { $, G } from '../state.js';

export const fmtN=n=>Math.round(n).toLocaleString('ru-RU');
export function fmtT(t){ const m=Math.floor(t/60), s=t-m*60; return m+':'+(s<10?'0':'')+s.toFixed(2); }
export function popup(text,bad){ const d=document.createElement('div'); d.className='float'+(bad?' bad':''); d.textContent=text; document.querySelector('.hud').appendChild(d); setTimeout(()=>d.remove(),1400); }
export function flash(text,sub,dur=1.4){ const t=$('toast'); t.textContent=text; if(sub){ const s=document.createElement('small'); s.textContent=sub; t.appendChild(s);} t.classList.add('on'); G.toastT=dur; }
const cache={};
export function setT(id,v){ if(cache[id]!==v){ cache[id]=v; $(id).textContent=v; } }
export const hex=c=>'#'+(c>>>0).toString(16).padStart(6,'0');
export const el=(tag,cls,text)=>{ const e=document.createElement(tag); if(cls) e.className=cls; if(text!=null) e.textContent=text; return e; };
export function info(text){ const d=el('div','info',text); document.querySelector('.hud').appendChild(d); setTimeout(()=>d.remove(),3000); }
// The menu's screens. showPanel(id) shows one of them; with dir ('forward' | 'back') the
// change is animated: the View Transitions API where there is one (only the two screens
// move, the scene behind stays still), a CSS class otherwise. A second change while the
// first is still running takes over from it (the browser skips the first). Returns a
// promise kept once the new screen is in the page (to move focus there).
// Shared pictures: an element with data-vt="name" in the screen you leave and one with the
// same name in the screen you come to are one picture that moves (the map's diagram from its
// card into the garage's header and back). With the API: one view-transition-name on both
// (both get it here, for this change only).
// Without: the coming one is measured and flown in from where the leaving one was (FLIP:
// translate and scale only). With reduced motion it is simply there.
const PANELS=['pHome','pGarage','pPause','pLobby','pResults','pOver'];
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
let panelGen=0;
// A run starting hides the menu: a screen change still on its way must not show it again.
export function cancelPanels(){ panelGen++; }
const visible=e=>e.getClientRects().length>0;
export function showPanel(id, dir){
  const menu=$('menu'), to=$(id), gen=++panelGen;
  const from=menu.hidden ? null : PANELS.map(p=>$(p)).find(p=>!p.hidden);
  for(const p of PANELS) $(p).style.viewTransitionName='';
  const swap=()=>{ if(gen!==panelGen) return; for(const p of PANELS) $(p).hidden=p!==id; menu.hidden=false; };
  if(!dir || !from || from===to){ swap(); return Promise.resolve(); }
  document.documentElement.dataset.nav=dir;
  // the shared pictures on the way out: name → its element (only one that is on screen)
  const shared=new Map();
  for(const e of from.querySelectorAll('[data-vt]')) if(visible(e) && !shared.has(e.dataset.vt)) shared.set(e.dataset.vt, e);
  if(document.startViewTransition){
    from.style.viewTransitionName='screen-out';
    const temp=[...shared].map(([n, e])=>{ e.style.viewTransitionName=n; return e; });
    const vt=document.startViewTransition(()=>{
      from.style.viewTransitionName=''; for(const e of temp) e.style.viewTransitionName='';
      swap(); to.style.viewTransitionName='screen-in';
      // the same pictures in the screen you come to take the names (for this change only)
      for(const e of to.querySelectorAll('[data-vt]')) if(shared.has(e.dataset.vt) && !temp.some(x=>x.style.viewTransitionName===e.dataset.vt) && visible(e)){ e.style.viewTransitionName=e.dataset.vt; temp.push(e); }
    });
    vt.ready.catch(()=>{});              // skipped (a resize, a phone turned): the swap still happened
    // (only what still holds this change's names, and only if no newer change has started:
    // a skipped transition finishes late and must not undo the names the next one just gave)
    vt.finished.finally(()=>{ if(gen!==panelGen) return; if(to.style.viewTransitionName==='screen-in') to.style.viewTransitionName=''; for(const e of temp) if(e.style.viewTransitionName===e.dataset.vt) e.style.viewTransitionName=''; }).catch(()=>{});
    return vt.updateCallbackDone.catch(()=>{});
  } else {
    const was=[...shared].map(([n, e])=>[n, e.getBoundingClientRect()]);
    swap();
    to.classList.remove('screen-enter','back'); void to.offsetWidth;
    to.classList.add('screen-enter'); to.classList.toggle('back', dir==='back');
    to.addEventListener('animationend',()=>to.classList.remove('screen-enter','back'),{once:true});
    if(!reducedMotion.matches) for(const [n, a] of was){
      const e=[...to.querySelectorAll('[data-vt]')].find(x=>x.dataset.vt===n && visible(x)); if(!e) continue;
      const b=e.getBoundingClientRect(); if(!b.width || !b.height) continue;
      e.animate([{ transformOrigin:'0 0', transform:`translate(${a.left-b.left}px, ${a.top-b.top}px) scale(${a.width/b.width}, ${a.height/b.height})` }, { transformOrigin:'0 0', transform:'none' }],
        { duration:parseFloat(getComputedStyle(to).getPropertyValue('--dur-screen'))||320, easing:'cubic-bezier(0.23, 1, 0.32, 1)' });
    }
    return Promise.resolve();
  }
}
export function netStatus(id,text,err){ const s=$(id); s.textContent=text||''; s.classList.toggle('err',!!err); }

// A note at the top of the page that outlives the screen it came from ("you were sent out
// of the room"). It stays 6 s (longer while the focus is on its close button). What it says
// is also on the screen below it (a status line there reads it out), so it says nothing
// itself: a second voice would only repeat it.
// { short: true }: a passing note (the host picked another map), 3 s, in the calm cyan.
let noteTimer=0;
export function note(text, { short=false }={}){
  const t=$('noteToast'); if(!t) return;
  $('noteText').textContent=text;
  t.toggleAttribute('data-info', short);
  if(!t.matches(':popover-open')) t.showPopover();
  clearTimeout(noteTimer);
  const later=()=>{ noteTimer=setTimeout(()=>{ if(t.contains(document.activeElement)) later(); else if(t.matches(':popover-open')) t.hidePopover(); },short?3000:6000); };
  later();
}
