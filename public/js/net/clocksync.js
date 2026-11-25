/* ---------- the clock synced to the server (plan 3, stage 5) ----------
   Pure logic (no DOM): net.js feeds it, tests/clocksync.test.mjs checks it.

   Every car's update is stamped with the sender's synced clock, and every other car is drawn
   where it is "now" on ours. So the synced clock (NET.offset) moves every car drawn on this
   screen: a step of 20 ms in it moved each car by its speed × 20 ms in one frame (0.5 m at
   90 km/h), a jump nothing smoothed.

   It used to keep the sample with the shortest round trip, letting that record age by 10 ms
   every 2 s so a newer sample could take over: the offset then stepped by up to ~25 ms every
   few seconds (half the jitter of the trip), also during the countdown and the race.

   Now:
   - a sample is (round trip, offset); the last N of the last MAX_AGE ms are kept and the
     target is the median offset of the K with the shortest round trips (one lucky or unlucky
     sample moves it little); ODD samples in a row off by more than SNAP start it afresh;
   - out of a run (the lobby, the results) the clock takes the target at once;
   - in the countdown and the race it moves toward it at most RATE ms per second (1 %: at
     250 km/h a car drawn moves 1 cm a frame more or less), unless it is off by more than
     SNAP (a reconnect, a sleeping laptop): then it takes the target at once. */
export const CLOCK = Object.freeze({ N: 16, K: 5, RATE: 10, SNAP: 250, MAX_AGE: 20000, ODD: 3 });

export const newClock = () => ({ samples: [], target: null, offset: 0, odd: [] });

// at: when the sample was taken (performance.now(), ms: it never steps with the wall clock).
// Samples older than MAX_AGE are dropped: after this computer's clock was set (NTP on waking
// up) the old ones would hold the median on the old time. ODD samples in a row that disagree
// with the target by more than SNAP mean the clock moved: the samples start afresh from them
// (and clockTick then takes the new target at once).
export function clockSample(C, rtt, offset, at, P = CLOCK) {
  if (!Number.isFinite(rtt) || !Number.isFinite(offset) || rtt < 0 || !Number.isFinite(at)) return C.target;
  const s = { rtt, offset, at };
  C.samples = C.samples.filter(o => at - o.at <= P.MAX_AGE);
  if (C.target !== null && Math.abs(offset - C.target) > P.SNAP) {
    C.odd.push(s);
    if (C.odd.length < P.ODD) return C.target;          // one odd sample: a fluke, kept out
    C.samples = C.odd; C.odd = [];
  } else { C.odd = []; C.samples.push(s); }
  while (C.samples.length > P.N) C.samples.shift();
  const best = [...C.samples].sort((a, b) => a.rtt - b.rtt).slice(0, P.K).map(o => o.offset).sort((a, b) => a - b);
  const m = best.length >> 1;
  C.target = best.length % 2 ? best[m] : (best[m - 1] + best[m]) / 2;
  return C.target;
}

// dt s of a frame. smooth: in the countdown or the race (slew), else jump to the target.
export function clockTick(C, dt, smooth, P = CLOCK) {
  if (C.target === null) return C.offset;
  const e = C.target - C.offset, step = P.RATE * Math.max(0, dt);
  C.offset = !smooth || Math.abs(e) > P.SNAP ? C.target : C.offset + Math.max(-step, Math.min(step, e));
  return C.offset;
}
