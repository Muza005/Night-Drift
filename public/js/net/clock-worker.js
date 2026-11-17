// Clock sync helper, running in its own thread.
//
// The game syncs its clock to the server by asking for the server's time and halving
// the round trip. Done on the main thread, a reply that arrives while a frame is being
// drawn waits for that frame, which makes the round trip look longer on one side and
// shifts the clock (by tens of ms on a slow device: at 90 km/h, 20 ms is half a metre).
// This worker is never blocked by drawing, so its measurements are clean. The game
// keeps whichever sample (this one or its own ping) had the shortest round trip.
let url = null, timer = 0, run = 0;

async function sample(my) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json();
    const t1 = Date.now();
    if (my === run && typeof j.t === 'number') postMessage({ rtt: t1 - t0, offset: j.t + (t1 - t0) / 2 - t1 });
  } catch (e) { /* the WebSocket ping still works */ }
}

async function start(my) {
  for (let i = 0; i < 8 && my === run; i++) { await sample(my); await new Promise(r => setTimeout(r, 120)); }
  const loop = () => { timer = setTimeout(async () => { if (my !== run) return; await sample(my); loop(); }, 1000); };
  if (my === run) loop();
}

onmessage = e => {
  clearTimeout(timer); run++;
  url = e.data && e.data.url;
  if (url) start(run);
};
