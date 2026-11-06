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
export function showPanel(id){ for(const p of ['pMain','pOnline','pLobby','pResults','pOver']) $(p).hidden=p!==id; $('menu').hidden=false; }
export function netStatus(id,text,err){ const s=$(id); s.textContent=text||''; s.classList.toggle('err',!!err); }
