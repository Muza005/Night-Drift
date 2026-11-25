// The clock synced to the server (plan 3 stage 5, public/js/net/clocksync.js): the median of
// the best samples, taken at once out of a run, approached without a step in a run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newClock, clockSample, clockTick, CLOCK } from '../public/js/net/clocksync.js';

test('clock: the median offset of the samples with the shortest round trips', () => {
  const C = newClock();
  // true offset 100 ms; a sample's error is up to half its extra round trip
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  for (let i = 0; i < 40; i++) { const up = 75 + (rnd() - .5) * 80, down = 75 + (rnd() - .5) * 80; clockSample(C, up + down, 100 + (up - down) / 2, i * 500); }
  assert.ok(Math.abs(C.target - 100) < 12, `target ${C.target}`);
  // one wild sample with a short trip moves the median little
  clockSample(C, 1, 400, 20000);
  assert.ok(Math.abs(C.target - 100) < 25, `target after an outlier ${C.target}`);
  // nonsense is ignored
  const t = C.target; clockSample(C, NaN, 5, 20000); clockSample(C, -1, 5, 20000); assert.equal(C.target, t);
});

test('clock: out of a run at once, in a run at most RATE ms a second, a big error at once', () => {
  const C = newClock();
  clockSample(C, 100, 50, 0);
  assert.equal(clockTick(C, 0, false), 50, 'lobby: at once');
  clockSample(C, 90, 80, 1000); clockSample(C, 95, 80, 2000);   // the median of the best moves to 80
  let most = 0, prev = C.offset;
  for (let i = 0; i < 600; i++) { const o = clockTick(C, 1 / 60, true); most = Math.max(most, Math.abs(o - prev)); prev = o; }
  assert.ok(most <= CLOCK.RATE / 60 + 1e-9, `a step of ${most} ms in a frame`);
  assert.equal(C.offset, 80, 'gets there');
  const D = newClock(); D.offset = 0; clockSample(D, 50, 1000, 0);
  assert.equal(clockTick(D, 1 / 60, true), 1000, 'off by more than SNAP: at once');
});

test('clock: old samples expire; a stepped computer clock is followed (NTP on waking up)', () => {
  const C = newClock();
  for (let i = 0; i < 16; i++) clockSample(C, 40, 0, i * 1000);     // offset 0, short trips
  // the computer's clock steps by 100 ms (under SNAP): new samples say 100 with longer trips;
  // the old better ones expire after MAX_AGE and the target follows
  let t = 16000; for (; t < 16000 + CLOCK.MAX_AGE + 2000; t += 1000) clockSample(C, 80, 100, t);
  assert.equal(C.target, 100, 'old samples expired');
  // a step of 2 s (over SNAP): one odd sample is ignored, ODD in a row start the clock afresh
  clockSample(C, 60, 2100, t += 1000); assert.equal(C.target, 100, 'one odd sample is a fluke');
  clockSample(C, 80, 100, t += 1000); clockSample(C, 60, 2100, t += 1000);
  for (let i = 1; i < CLOCK.ODD; i++) { assert.equal(C.target, 100); clockSample(C, 60, 2100, t += 1000); }
  assert.equal(C.target, 2100, 'odd samples in a row: afresh');
  C.offset = 100; assert.equal(clockTick(C, 1 / 60, true), 2100, 'and taken at once even in a run');
});
