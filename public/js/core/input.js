// Player input: keyboard map and touch buttons. Keyboard listeners live in main.js,
// because some keys (pause, reset) act on the game flow.
export const input={up:0,down:0,left:0,right:0,hb:0};
export const NOINPUT={up:0,down:0,left:0,right:0,hb:0};
export const KEYMAP={KeyW:'up',ArrowUp:'up',KeyS:'down',ArrowDown:'down',KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right',Space:'hb'};
export function clearInput(){ for(const k in input) input[k]=0; }

document.querySelectorAll('.tb').forEach(b=>{
  const k=b.dataset.k;
  const on=e=>{ e.preventDefault(); input[k]=1; b.classList.add('on'); try{b.setPointerCapture(e.pointerId);}catch(_){} };
  const off=e=>{ input[k]=0; b.classList.remove('on'); };
  b.addEventListener('pointerdown',on); b.addEventListener('pointerup',off); b.addEventListener('pointercancel',off); b.addEventListener('lostpointercapture',off);
});
