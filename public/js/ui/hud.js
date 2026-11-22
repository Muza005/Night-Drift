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
const PANELS=['pHome','pModes','pGarage','pPause','pLobby','pResults','pOver'];
let panelGen=0;
// A run starting hides the menu: a screen change still on its way must not show it again.
export function cancelPanels(){ panelGen++; }
export function showPanel(id, dir){
  const menu=$('menu'), to=$(id), gen=++panelGen;
  const from=menu.hidden ? null : PANELS.map(p=>$(p)).find(p=>!p.hidden);
  for(const p of PANELS) $(p).style.viewTransitionName='';
  const swap=()=>{ if(gen!==panelGen) return; for(const p of PANELS) $(p).hidden=p!==id; menu.hidden=false; };
  if(!dir || !from || from===to){ swap(); return Promise.resolve(); }
  document.documentElement.dataset.nav=dir;
  if(document.startViewTransition){
    from.style.viewTransitionName='screen-out';
    const vt=document.startViewTransition(()=>{ from.style.viewTransitionName=''; swap(); to.style.viewTransitionName='screen-in'; });
    vt.ready.catch(()=>{});              // skipped (a resize, a phone turned): the swap still happened
    vt.finished.finally(()=>{ to.style.viewTransitionName=''; }).catch(()=>{});
    return vt.updateCallbackDone.catch(()=>{});
  } else {
    swap();
    to.classList.remove('screen-enter','back'); void to.offsetWidth;
    to.classList.add('screen-enter'); to.classList.toggle('back', dir==='back');
    to.addEventListener('animationend',()=>to.classList.remove('screen-enter','back'),{once:true});
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
