// Night Drift — multiplayer server (Colyseus 0.15)
//
// The server is the single source of truth for everything that decides the race:
// who is in the room, when the race starts, lap times, finishing order and results.
// Car movement is calculated on each player's computer (no lag for your own car)
// and streamed here 30-40 times a second; the server checks each state and passes it on to
// the other players at once (stage 9: not through the schema patches).
//
// Two modes. "track": the drift track, 3 laps (unchanged). "traffic": the highway, a
// timed run ranked by score. In traffic mode this server also runs the traffic itself
// (the same simulation file the game uses solo, public/js/modes/traffic/sim.js), so
// every player sees the same bots: 20 steps a second, a snapshot to everyone 10 times
// a second (each player gets the bots near its own car), players' hits on bots applied
// here and passed on in the next snapshot.

const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
const express = require('express');
const { Server, Room, matchMaker } = require('colyseus');
const { WebSocketTransport } = require('@colyseus/ws-transport');
const { Schema, MapSchema, defineTypes } = require('@colyseus/schema');

const PORT = Number(process.env.PORT) || 2567;
const MAX_PLAYERS = 6;
const LAPS = 3, MIN_LAPS = 1, MAX_LAPS = 10;            // drift track: laps the host can pick
const COUNTDOWN_MS = 4000;      // time from "start" to green light
// No lap can be faster than this: by default per map (public/js/modes/track/maps/meta.js
// minLapMs: the lap at 80 m/s); MIN_LAP_MS overrides it for tests.
const MIN_LAP_MS = Number(process.env.MIN_LAP_MS) || 0;
// Hidden maps (test maps such as _testhill) can be picked only on a server started with
// ALLOW_HIDDEN_MAPS=1.
const ALLOW_HIDDEN_MAPS = process.env.ALLOW_HIDDEN_MAPS === '1';
const FINISH_GRACE_MS = Number(process.env.FINISH_GRACE_MS) || 45000;  // after the winner finishes, others get this long
const MODES = ['track', 'traffic'];
// Traffic run lengths the host can pick: 1 to 10 minutes, whole minutes. EXTRA_DURATION
// (seconds) adds one more, for tests that need a short run.
const EXTRA_DURATION = Number(process.env.EXTRA_DURATION) > 0 ? Number(process.env.EXTRA_DURATION) : 0;
const okDuration = d => Number.isInteger(d) && ((d >= 60 && d <= 600 && d % 60 === 0) || (EXTRA_DURATION > 0 && d === EXTRA_DURATION));
const DENSITIES = ['low', 'mid', 'high'];   // traffic density (public/js/modes/traffic/sim.js DENSITY)
const WRECK_MS = 3000, GHOST_MS = 1500;     // online crash: stopped and blinking, then can't be hit
const SNAPSHOT_EVERY = 2;                    // traffic steps (1/20 s) per snapshot: 10 a second
const SNAP_BEHIND = 120, SNAP_AHEAD = 780;   // a player is sent the bots this far behind and ahead of its car (m)
const CAR_TOP = 80;                           // m/s: faster than any car (72 m/s flat out in a slipstream)
const HIST_MS = 800;                         // a player's states kept for the speed check (speedSeen)

// The traffic simulation is an ES module shared with the game; load it once.
let T = null;
async function trafficLib() {
  if (!T) {
    const dir = path.join(__dirname, '..', '..', 'public', 'js', 'modes', 'traffic');
    const load = f => import(pathToFileURL(path.join(dir, f)).href);
    const [sim, geo, codec] = await Promise.all([load('sim.js'), load('geometry.js'), load('netcodec.js')]);
    T = { ...sim, ...geo, ...codec };
  }
  return T;
}
// The drift maps' ids, lap lengths and hidden flags: public/js/modes/track/maps/meta.js
// (plain data, shared with the game; the geometry itself stays in the browser).
let MAPS = null;
async function mapsLib() {
  if (!MAPS) MAPS = await import(pathToFileURL(path.join(__dirname, '..', '..', 'public', 'js', 'modes', 'track', 'maps', 'meta.js')).href);
  return MAPS;
}
// A car's state as the server passes it on to the other players ('st', see 'state' below).
let CODEC = null;
async function codecLib() {
  if (!CODEC) CODEC = await import(pathToFileURL(path.join(__dirname, '..', '..', 'public', 'js', 'net', 'statecodec.js')).href);
  return CODEC;
}
// The cars and paints players can pick: public/js/core/cars.js, shared with the game.
// Players may share a paint: the interface marks a player by their seat, not by colour.
let CARS = null;
async function carsLib() {
  if (!CARS) CARS = await import(pathToFileURL(path.join(__dirname, '..', '..', 'public', 'js', 'core', 'cars.js')).href);
  return CARS;
}
// Car-to-car hits: the limits of public/js/net/bump.js (restitution, friction, spin, push,
// hop), shared with the game so the server checks a hit against the same model.
let BUMPS = null;
async function bumpLib() {
  if (!BUMPS) BUMPS = await import(pathToFileURL(path.join(__dirname, '..', '..', 'public', 'js', 'net', 'bump.js')).href);
  return BUMPS;
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class Player extends Schema {
  constructor() {
    super();
    this.name = '';
    this.color = 0;
    this.car = '';           // public/js/core/cars.js, set on join
    this.slot = 0;           // start grid position (and the traffic simulation's player id)
    this.order = 0;          // when the player came in: 1, 2, 3... never reused in a room.
                             // Everyone lists the room the same way: the host first, then by order.
    this.ready = false;      // pressed "Готово" in the lobby (the host does not need to)
    this.connected = true;
    // How far down the road (traffic: the distance in the results). Updated twice a second:
    // the car's movement itself is not in the schema (_s below).
    this.z = 0;
    this.lap = 0;            // completed laps
    this.prog = 0;           // progress along the current lap, 0..track points (900 on «Ночной город»)
    this.score = 0;
    this.bestLap = 0;        // ms, measured by the server
    this.finished = false;
    this.finishTime = 0;     // ms since green light, measured by the server
    this.place = 0;
    // traffic mode
    this.wreckUntil = 0;     // server ms: crashed into a bot, stopped and blinking until then
    this.ghostUntil = 0;     // server ms: until then bots and other cars pass through
    this.misses = 0;         // near misses this run (reported by the player)
    this.wrecks = 0;         // crashes this run (counted here)
    // The car's last state (stage 9: not in the schema; the server passes each state on to
    // the other players the moment it comes, 'st'): position, heading, height and, in a
    // jump, vertical speed, the nearest track point (the right road at a bridge), speeds,
    // steering, slide, and t: the sender's synced clock (server ms) when it was true.
    this._s = { x: 0, z: 0, h: 0, y: 0, vy: 0, idx: 0, vf: 0, steer: 0, slide: 0, vx: 0, vz: 0, t: 0 };
    this._hist = [];         // the last states as they arrived: { a: server ms, t: stamp, x, z } (speedSeen)
  }
}
defineTypes(Player, {
  name: 'string', color: 'number', car: 'string', slot: 'uint8', order: 'uint16', ready: 'boolean', connected: 'boolean',
  z: 'float32',
  lap: 'uint8', prog: 'int16', score: 'uint32', bestLap: 'number',
  finished: 'boolean', finishTime: 'number', place: 'uint8',
  wreckUntil: 'float64', ghostUntil: 'float64', misses: 'uint16', wrecks: 'uint8',
});

class RaceState extends Schema {
  constructor() {
    super();
    this.phase = 'lobby';    // lobby | countdown | race | results
    this.hostId = '';
    this.laps = LAPS;        // drift track: laps in a race (1..10)
    this.startAt = 0;        // server clock (ms) of the green light
    this.mode = 'track';     // track | traffic, picked by the host in the lobby
    this.map = 'neon';       // drift map id (public/js/modes/track/maps/), picked by the host in the lobby
    this.duration = 180;     // traffic: run length, s (60..600, whole minutes)
    this.density = 'mid';    // traffic: low | mid | high
    this.endAt = 0;          // traffic: server clock (ms) when the run ends
    this.seed = 0;           // traffic: seed of this run's traffic
    this.players = new MapSchema();
  }
}
defineTypes(RaceState, {
  phase: 'string', hostId: 'string', laps: 'uint8', startAt: 'number',
  mode: 'string', map: 'string', duration: 'uint16', density: 'string', endAt: 'float64', seed: 'uint32',
  players: { map: Player },
});

const finite = (v, lo, hi, d = 0) => {
  if (typeof v === 'bigint') v = Number(v);   // large integers (e.g. timestamps) arrive as BigInt
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
};
const isObj = m => m !== null && typeof m === 'object' && !Array.isArray(m);
// No control characters, no angle brackets, and no invisible or direction-flipping ones
// (zero-width spaces, right-to-left overrides): those let a name pass for someone else's.
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').trim().slice(0, 16) || 'Гонщик';

async function freeCode() {
  for (let i = 0; i < 50; i++) {
    let code = '';
    for (let k = 0; k < 4; k++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    const taken = await matchMaker.query({ roomId: code });
    if (!taken.length) return code;
  }
  throw new Error('no free room code');
}

class RaceRoom extends Room {
  async onCreate(options) {
    this.maxClients = MAX_PLAYERS;
    this.cars = await carsLib();
    this.maps = await mapsLib();
    this.bumps = await bumpLib();
    this.codec = await codecLib();
    this.bumpRate = new Map();   // "from>to" -> { tokens, t }: how many hits one player may still send another
    this.roomId = await freeCode();
    this.setState(new RaceState());
    if (options && MODES.includes(options.mode)) this.state.mode = options.mode;
    if (options && this.maps.mapAllowed(options.map, ALLOW_HIDDEN_MAPS)) this.state.map = options.map;
    if (options && DENSITIES.includes(options.density)) this.state.density = options.density;
    this.nextOrder = 1;          // the next player's order
    this.banned = new Set();     // sessionIds and player ids the host kicked out: never back in
    this.reconnecting = new Map();   // sessionId -> the seat kept for a player who lost connection
    this.traffic = null;         // traffic mode: the simulation of the current run
    this.trafficTimer = null;
    this.botHitAt = new Map();   // bot id -> server ms of the last accepted hit
    this.setPatchRate(50);       // the schema (scores, laps, phases): 20 times a second; cars go at once ('st')
    this.lapStamp = new Map();   // sessionId -> server ms when the current lap started
    this.lastState = new Map();  // sessionId -> { t, x, z } for sanity checks
    this.timers = [];

    this.onMessage('ping', (client, msg) => {
      client.send('pong', { t: msg && msg.t, server: Date.now() });
    });

    // Host only, between runs, and only when every other player in the room has pressed
    // "Готово" (checked here, not only on the host's screen). A host alone can start at once.
    this.onMessage('start', (client) => {
      if (client.sessionId !== this.state.hostId || !this.betweenRuns()) return;
      if (!this.allReady()) return;
      this.beginCountdown();
    });

    // Host only, on the results: everyone back to the lobby (settings, kicks, renames).
    this.onMessage('toLobby', (client) => {
      if (client.sessionId !== this.state.hostId || this.state.phase !== 'results') return;
      this.state.phase = 'lobby';
    });

    // Anyone but the host, between runs: ready or not ({ value: true | false }).
    this.onMessage('ready', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !isObj(m) || typeof m.value !== 'boolean' || !this.betweenRuns()) return;
      if (client.sessionId === this.state.hostId) return;
      p.ready = m.value;
    });

    // Anyone, between runs: their car and paint (any paint: players may share one).
    this.onMessage('pick', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !isObj(m) || !this.betweenRuns()) return;
      if (this.cars.CAR_IDS.includes(m.car)) p.car = m.car;
      if (this.cars.isPaint(m.paint)) p.color = m.paint;
    });

    // Anyone, between runs: their name.
    this.onMessage('name', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !isObj(m) || typeof m.name !== 'string' || !this.betweenRuns()) return;
      const now = Date.now();
      if (now - (p._nameAt || 0) < 500) return;                // at most two renames a second: no flooding the room
      p._nameAt = now;
      p.name = cleanName(m.name);
    });

    // Host only, between runs: the mode, map and laps (track), run length and density (traffic).
    // A value out of range is ignored, the rest of the message still counts.
    this.onMessage('config', (client, m) => {
      if (client.sessionId !== this.state.hostId || !isObj(m) || !this.betweenRuns()) return;
      if (MODES.includes(m.mode)) this.state.mode = m.mode;
      // an unknown or hidden id is ignored; a new map takes back everyone's «Готово»
      // (they said yes to the other track)
      if (this.maps.mapAllowed(m.map, ALLOW_HIDDEN_MAPS) && m.map !== this.state.map) {
        this.state.map = m.map;
        for (const p of this.state.players.values()) p.ready = false;
      }
      if (Number.isInteger(m.laps) && m.laps >= MIN_LAPS && m.laps <= MAX_LAPS) this.state.laps = m.laps;
      if (okDuration(m.duration)) this.state.duration = m.duration;
      if (DENSITIES.includes(m.density)) this.state.density = m.density;
    });

    // Host only, between runs: send a player out of the room for good. They are told
    // ('kicked') and disconnected; neither that connection nor that player's id can come
    // back into this room.
    this.onMessage('kick', (client, m) => {
      if (client.sessionId !== this.state.hostId || !isObj(m) || !this.betweenRuns()) return;
      const id = m.id;
      if (typeof id !== 'string' || id === client.sessionId) return;
      const p = this.state.players.get(id);
      if (!p) return;
      this.banned.add(id);
      if (p._pid) this.banned.add('pid:' + p._pid);
      const target = this.clients.find(c => c.sessionId === id);
      const seat = this.reconnecting.get(id);
      if (seat && seat.reject) seat.reject(new Error('kicked'));   // was reconnecting: that seat is gone too
      this.removePlayer(id, p, 'исключён');
      if (target) { target.send('kicked', {}); target.leave(4001); }
    });

    // A player's car, 30-40 times a second. Checked, kept here (_s: hits, traffic and the
    // speed check use it) and passed on at once to every other player ('st', statecodec.js).
    // At most ~60 a second per player (a burst of 12): each one goes out to everyone else.
    this.onMessage('state', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !isObj(m) || this.state.phase === 'lobby') return;
      const now = Date.now();
      p._stTok = Math.min(12, (p._stTok ?? 12) + (now - (p._stAt || now)) * 0.06); p._stAt = now;
      if (p._stTok < 1) return;
      p._stTok -= 1;
      // the track fits in ±2000 m; the highway runs on for as long as anyone can drive
      const hw = this.state.mode === 'traffic', S = p._s;
      const x = finite(m.x, hw ? -20 : -2000, hw ? 20 : 2000, S.x), z = finite(m.z, hw ? -1e7 : -2000, hw ? 1e7 : 2000, S.z);
      const last = this.lastState.get(client.sessionId);
      if (last) {
        // A car tops out around 70 m/s (250 km/h in a slipstream). Allow generous slack for lag spikes and the
        // "back to track" reset, but reject obvious teleports.
        const dt = Math.max(0.05, (now - last.t) / 1000);
        const jump = Math.hypot(x - last.x, z - last.z);
        if (jump > 90 * dt + 25) return;
      }
      // A step faster than any car (a reset back to the track, or a made-up position) is not
      // driving: the speed check (speedSeen) never looks back across it. Its time is the longer
      // of the stamps' and the arrivals' (unfloored), so neither many small messages nor
      // bunched arrivals let a hop pass for speed; an honest step is ≤ 72 m/s over its stamp time.
      let bad = false;
      if (last) {
        const dts = Math.max(0, finite(m.t, now - 1500, now, now) - p._s.t), dta = now - last.t;
        bad = Math.hypot(x - last.x, z - last.z) > CAR_TOP * Math.max(dts, dta) / 1000 + 0.3;
      }
      this.lastState.set(client.sessionId, { t: now, x, z });
      S.x = x; S.z = z;
      S.h = finite(m.h, -1e4, 1e4, S.h);
      S.y = hw ? 0 : finite(m.y, -50, 200, 0);     // a map's roads stay within this; a jump's peak too
      S.vy = hw ? 0 : finite(m.vy, -60, 60, 0);
      S.idx = Math.round(finite(m.idx, 0, 65535, 0));
      S.vf = finite(m.vf, -20, 80);          // forward speed: 72.3 m/s flat out, a little more in a slipstream
      S.steer = finite(m.steer, -1, 1);
      S.slide = finite(m.slide, 0, 1);
      S.vx = finite(m.vx, -80, 80); S.vz = finite(m.vz, -80, 80);   // the fastest car in a slipstream: ~72 m/s
      // Trust the sender's timestamp only within a sane window around the server clock,
      // and never older than its last one (the others drop an out-of-date state anyway).
      S.t = Math.max(S.t, finite(m.t, now - 1500, now, now));
      const H = p._hist; H.push({ a: now, t: S.t, x, z, bad });
      while (H.length && now - H[0].a > HIST_MS) H.shift();
      if (now - (p._zAt || 0) >= 500) { p.z = z; p._zAt = now; }     // the schema's distance: twice a second
      p.prog = Math.round(finite(m.prog, -50, 8000));   // track points into the lap: 900 on «Ночной город», more on longer maps
      if (!p.finished) p.score = this.acceptScore(p, finite(m.score, 0, 1e8, p.score), now);
      if (hw) p.misses = Math.round(finite(m.misses, p.misses, 65535, p.misses));
      this.broadcast('st', this.codec.encodeState(client.sessionId, S), { except: client });
    });

    // Traffic: a player hit a bot. The player's game resolved the hit for its own car at
    // once; here the bot gets its share, so every player sees it slow down. The hit must
    // be plausible: the bot exists and was near that player (positions here are up to a
    // ping old, so allow 9 m), and one bot can't be hit by the same player twice in 0.3 s.
    this.onMessage('hitBot', (client, m) => {
      if (this.state.mode !== 'traffic' || this.state.phase !== 'race' || !this.traffic || !m) return;
      const p = this.state.players.get(client.sessionId);
      if (!p || Date.now() < p.ghostUntil) return;
      const id = Math.round(finite(m.id, 0, 1e9, -1));
      const b = this.traffic.bots.find(o => o.id === id);
      if (!b) return;
      const P = this.playerNow(p, Date.now());
      if (Math.abs(P.z - b.z) > 9 + T.TYPES[b.t].len / 2 || Math.abs(P.x - b.x) > 6) return;
      const key = client.sessionId + ':' + id, now = Date.now();
      if (now - (this.botHitAt.get(key) || 0) < 300) return;
      this.botHitAt.set(key, now);
      // the hit happened when the player's game saw it (m.t, server clock): the bot is
      // moved on by that much, so its reaction lines up with what that player already shows
      const ht = finite(m.t, 0, 1e15, 0), age = ht ? Math.min(0.3, Math.max(0, (now - ht) / 1000)) : 0;
      this.traffic.hit(id, { dv: finite(m.dv, -12, 6), sv: finite(m.sv, -3.5, 3.5, 0), hard: m.hard === true, age });
    });

    // Traffic: a player crashed hard into a bot. The car stops and blinks for 3 s for
    // everyone, then has 1.5 s in which bots and other cars pass through it.
    this.onMessage('wreck', (client) => {
      if (this.state.mode !== 'traffic' || this.state.phase !== 'race') return;
      const p = this.state.players.get(client.sessionId), now = Date.now();
      if (!p || now < p.ghostUntil) return;                  // already wrecked or still ghosted
      p.wreckUntil = now + WRECK_MS; p.ghostUntil = now + WRECK_MS + GHOST_MS; p.wrecks += 1;
    });

    this.onMessage('lap', (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.finished || this.state.phase !== 'race' || this.state.mode !== 'track') return;
      const now = Date.now();
      const lapMs = now - (this.lapStamp.get(client.sessionId) || this.state.startAt);
      if (lapMs < (MIN_LAP_MS || this.maps.minLapMs(this.state.map))) return;   // impossible lap: ignore
      this.lapStamp.set(client.sessionId, now);
      p.lap += 1;
      if (!p.bestLap || lapMs < p.bestLap) p.bestLap = lapMs;
      client.send('lapTime', { lap: p.lap, ms: lapMs, best: p.bestLap });
      if (p.lap >= this.state.laps) this.finishPlayer(client.sessionId, p, now);
    });

    this.onMessage('score', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (p && m) p.score = this.acceptScore(p, finite(m.score, 0, 1e8, p.score), Date.now());
    });

    // Car-to-car hits: the player who decided the hit (net/bump.js: the faster car) sends
    // the other car's share, and the server passes it on. A modified client can't launch
    // anyone off the map:
    // - only between two racing cars that are close (positions here are a ping old), neither
    //   finished nor a blinking crashed car;
    // - the velocity change can't be more than a hit between these two cars at their last
    //   reported speeds can give, a speed never above what the server saw the car move at
    //   (speedOf: a modified client can't claim speed for a bigger hit) (restitution,
    //   friction and masses of bump.js, closing speed at most the sum of the two speeds,
    //   +3 m/s for speeds a ping old), and never
    //   more than MAX_DV; spin and hop only as much as that hit can give, push within PUSH;
    // - at most 10 hits a second from one player to another (a burst of 3), the game sends
    //   one per 100 ms while two cars scrape.
    this.onMessage('bump', (client, m) => {
      if (this.state.phase !== 'race' || !isObj(m) || typeof m.to !== 'string') return;
      const from = this.state.players.get(client.sessionId), to = this.state.players.get(m.to);
      if (!from || !to || m.to === client.sessionId || from.finished || to.finished) return;
      const now = Date.now();
      if (now < from.ghostUntil || now < to.ghostUntil) return;   // a crashed, blinking car can't push or be pushed
      if (Math.hypot(from._s.x - to._s.x, from._s.z - to._s.z) > 25) return;   // they weren't even close (positions here are a ping old)
      const target = this.clients.find(c => c.sessionId === m.to);
      if (!target) return;
      const key = client.sessionId + '>' + m.to, r = this.bumpRate.get(key) || { tokens: 3, t: now };
      r.tokens = Math.min(3, r.tokens + (now - r.t) / 100); r.t = now;
      if (r.tokens < 1) { this.bumpRate.set(key, r); return; }
      r.tokens -= 1; this.bumpRate.set(key, r);
      const B = this.bumps.BUMP, mass = this.bumps.carMass;
      const mf = mass(from.car), mt = mass(to.car);
      // the speeds as the server saw the cars move, not as claimed (speedOf)
      const closing = this.speedOf(from) + this.speedOf(to) + 3;
      const most = Math.min(B.MAX_DV, (1 + B.E) * Math.hypot(1, B.MU) * closing * mf / (mf + mt));
      let jx = finite(m.jx, -B.MAX_DV, B.MAX_DV), jz = finite(m.jz, -B.MAX_DV, B.MAX_DV);
      const j = Math.hypot(jx, jz); if (j > most) { jx *= most / j; jz *= most / j; }
      let dx = finite(m.dx, -B.PUSH, B.PUSH), dz = finite(m.dz, -B.PUSH, B.PUSH);
      const d = Math.hypot(dx, dz); if (d > B.PUSH) { dx *= B.PUSH / d; dz *= B.PUSH / d; }
      // spin and hop come only with a hit's strength: the spin of a velocity change of |j|
      // at the far end of the car (lever arm OFF + R, SPIN_K of it taken, +0.1 slack); a hop
      // only from HOP of closing speed, whose share for this car is at least ~0.9 of
      // (1 + E) × HOP × mf / (mf + mt)
      const jj = Math.hypot(jx, jz), spinMost = Math.min(B.SPIN, (B.OFF + B.R) * B.SPIN_K / B.I * jj + 0.1);
      const hops = closing >= B.HOP && jj >= 0.9 * (1 + B.E) * B.HOP * mf / (mf + mt);
      target.send('bump', {
        from: client.sessionId, jx, jz, dx, dz,
        w: finite(m.w, -spinMost, spinMost), vy: hops ? finite(m.vy, 0, B.HOP_MAX) : 0,
        t: finite(m.t, now - 1500, now, now),     // when the hit happened (the sender's synced clock)
      });
    });
  }

  // A player the host kicked out can't come back: not on that connection (a reconnect
  // keeps the sessionId) and not as the same player (pid: the game's id for this browser).
  onAuth(client, options) {
    if (this.banned.has(client.sessionId)) return false;
    const pid = options && typeof options.pid === 'string' ? options.pid.slice(0, 64) : '';
    if (pid && this.banned.has('pid:' + pid)) return false;
    return true;
  }

  onJoin(client, options) {
    const used = new Set([...this.state.players.values()].map(p => p.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const p = new Player();
    p.name = cleanName(options && options.name);
    p.slot = slot;
    p.order = this.nextOrder++;
    // the car and paint the player asked for (an unknown one: the first car, its own colour)
    const want = options || {};
    p.car = this.cars.CAR_IDS.includes(want.car) ? want.car : this.cars.DEFAULT_CAR;
    p.color = this.cars.isPaint(want.paint) ? want.paint : this.cars.DEFAULT_PAINT;
    if (typeof want.pid === 'string') p._pid = want.pid.slice(0, 64);
    this.state.players.set(client.sessionId, p);
    if (!this.state.hostId) this.state.hostId = client.sessionId;
    this.broadcast('event', { text: p.name + ' в комнате' }, { except: client });
  }

  async onLeave(client, consented) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;                                          // already gone (kicked)
    p.connected = false;
    try {
      if (consented || this.banned.has(client.sessionId)) throw new Error('left');
      const seat = this.allowReconnection(client, 20);
      this.reconnecting.set(client.sessionId, seat);
      await seat;
      p.connected = true;
    } catch (e) {
      if (this.state.players.get(client.sessionId) === p) this.removePlayer(client.sessionId, p, 'вышел');
    } finally {
      this.reconnecting.delete(client.sessionId);
    }
  }

  // A player leaves the room for good. If it was the host, the next player by order is.
  removePlayer(id, p, how) {
    this.state.players.delete(id);
    this.lapStamp.delete(id);
    this.lastState.delete(id);
    for (const k of this.bumpRate.keys()) if (k.startsWith(id + '>') || k.endsWith('>' + id)) this.bumpRate.delete(k);
    this.broadcast('event', { text: p.name + ' ' + how });
    if (this.state.hostId === id) {
      // a player who is connected first (one who is reconnecting may never come back), then by order
      const next = [...this.state.players.entries()].sort((a, b) => (b[1].connected - a[1].connected) || (a[1].order - b[1].order))[0];
      this.state.hostId = next ? next[0] : '';
      if (next) next[1].ready = false;                       // the host has no "Готово"
    }
    this.checkRaceOver();
  }

  betweenRuns() { return this.state.phase === 'lobby' || this.state.phase === 'results'; }
  // Every other player who is connected has pressed "Готово".
  allReady() {
    for (const [id, p] of this.state.players) if (id !== this.state.hostId && p.connected && !p.ready) return false;
    return true;
  }

  onDispose() { this.timers.forEach(clearTimeout); this.stopTraffic(); }

  // Score sanity: on the highway a score can't climb faster than the best possible
  // near misses allow (a ×5 combo, ×2 drift, 180 km/h: ~9 000 a pass); 30 000 a second
  // leaves room for lag bursts. The track keeps its old rule.
  acceptScore(p, v, now) {
    v = Math.round(v);
    if (this.state.mode !== 'traffic') return Math.min(v, 1e7);
    const last = p._scoreAt || this.state.startAt || now, dt = Math.max(0, (now - last) / 1000);
    p._scoreAt = now;
    return Math.max(p.score, Math.min(v, p.score + 30000 * Math.max(dt, 0.05)));
  }

  // A player's position now: the last report moved on by its velocity (at most 0.5 s).
  playerNow(p, now) {
    const S = p._s, age = Math.min(0.5, Math.max(0, (now - S.t) / 1000));
    return { x: S.x + S.vx * age, z: S.z + S.vz * age, v: S.vz };
  }
  // How fast a player's car really moves, from its own positions as they came here, not
  // the speed it claims (a modified client could claim 80 m/s standing still, for a bigger
  // hit): the fastest average over the windows of 150-700 ms that end at its latest state.
  // A window's time is the stamps' (the sender's clock: arrival times shift with the jitter),
  // but never less than the arrival times' less 60 ms (a stamp can be made up).
  speedSeen(p) {
    const H = p._hist, L = H[H.length - 1]; let v = 0;
    if (!L || L.bad) return 0;
    for (let i = H.length - 2; i >= 0; i--) {
      if (H[i + 1].bad) break;                 // a hop between H[i] and H[i+1]: no window across it
      const da = L.a - H[i].a; if (da < 150) continue; if (da > 700) break;
      const dt = Math.max(L.t - H[i].t, da - 60) / 1000;
      v = Math.max(v, Math.hypot(L.x - H[i].x, L.z - H[i].z) / dt);
    }
    return v;
  }
  // The speed a hit is checked with: the claimed one, but no more than the seen one, +10%
  // and 3 m/s (a window's average lags a car that speeds up or was just hit), and never
  // more than the fastest car can go.
  speedOf(p) { return Math.min(Math.hypot(p._s.vx, p._s.vz), this.speedSeen(p) * 1.1 + 3, CAR_TOP); }
  trafficPlayers(now) {
    return [...this.state.players.values()].filter(p => p.connected).sort((a, b) => a.slot - b.slot)
      .map(p => ({ ...this.playerNow(p, now), id: p.slot, ghost: now < p.ghostUntil }));
  }
  async startTraffic() {
    this.stopTraffic();
    const lib = await trafficLib();
    const s = this.state;
    s.seed = (Math.random() * 0xffffffff) >>> 0;
    this.traffic = lib.createTraffic(s.seed);
    const grid = [...s.players.values()].sort((a, b) => a.slot - b.slot).map(p => ({ ...lib.startPose(p.slot), v: 0 }));
    this.traffic.reset(s.seed, grid, s.density);
    // Every car is on the start grid now, whatever it last reported. Without this the
    // simulation's first steps saw the cars where the previous run ended (kilometres down
    // the road) until their first new reports came in, dropped the traffic it had just
    // put around the start as "far behind every player", and the second run in a room
    // began with an empty road up to 380 m instead of 200 m. t = 0: not a report, so the
    // games do not draw it (net.js pushSnap).
    s.players.forEach(p => { const g = lib.startPose(p.slot); Object.assign(p._s, { x: g.x, z: g.z, vx: 0, vz: 0, vf: 0, t: 0 }); p.z = g.z; p._hist = []; });
    this.botHitAt.clear();
    let last = Date.now(), steps = 0;
    this.trafficTimer = setInterval(() => {
      const now = Date.now(), sim = this.traffic;
      if (!sim) return;
      const before = Math.round(sim.time / lib.STEP);
      sim.advance((now - last) / 1000, this.trafficPlayers(now)); last = now;
      steps += Math.round(sim.time / lib.STEP) - before;
      // stamp the snapshot with the moment its positions are true: the simulation keeps a
      // remainder of less than one step that it has not simulated yet
      if (steps >= SNAPSHOT_EVERY) {
        steps = 0;
        // Each player gets the bots near its own car: everything from 120 m behind it to
        // 780 m ahead (its traffic lives from 60 m behind to 700 m ahead). Players who
        // drive apart each have their own traffic, so the whole road can hold several times
        // what one player sees. Cars level with each other get the very same bots.
        const at = now - sim.alpha * lib.STEP * 1000;
        for (const c of this.clients) {
          const p = s.players.get(c.sessionId); if (!p) continue;
          const z = this.playerNow(p, now).z;
          c.send('tr', lib.encodeSnapshot(sim, at, b => b.z >= z - SNAP_BEHIND && b.z <= z + SNAP_AHEAD));
        }
      }
    }, 25);
  }
  stopTraffic() { if (this.trafficTimer) clearInterval(this.trafficTimer); this.trafficTimer = null; this.traffic = null; }

  later(ms, fn) { const t = setTimeout(fn, ms); this.timers.push(t); return t; }

  beginCountdown() {
    this.timers.forEach(clearTimeout); this.timers = [];
    const s = this.state;
    s.players.forEach((p) => {
      p.ready = false;                                       // back in the lobby, everyone presses "Готово" again
      p.lap = 0; p.prog = 0; p.score = 0; p.bestLap = 0;
      p.finished = false; p.finishTime = 0; p.place = 0;
      p.wreckUntil = 0; p.ghostUntil = 0; p.misses = 0; p.wrecks = 0; p._scoreAt = 0;
      p._hist = [];                                          // the speed check starts afresh
    });
    this.lapStamp.clear(); this.lastState.clear(); this.bumpRate.clear();
    s.phase = 'countdown';
    s.startAt = Date.now() + COUNTDOWN_MS;
    s.endAt = s.mode === 'traffic' ? s.startAt + s.duration * 1000 : 0;
    this.lock();
    if (s.mode === 'traffic') {
      this.startTraffic();
      this.later(COUNTDOWN_MS + s.duration * 1000, () => this.endRace());
    } else this.stopTraffic();
    this.later(COUNTDOWN_MS, () => { s.phase = 'race'; });
  }

  finishPlayer(id, p, now) {
    p.finished = true;
    p.finishTime = now - this.state.startAt;
    p.place = [...this.state.players.values()].filter(q => q.finished).length;
    this.broadcast('event', { text: p.name + ' финишировал ' + p.place + '-м' });
    if (p.place === 1) this.later(FINISH_GRACE_MS, () => this.endRace());
    this.checkRaceOver();
  }

  checkRaceOver() {
    if (this.state.phase !== 'race' || this.state.mode !== 'track') return;   // a traffic run ends on time
    const active = [...this.state.players.values()].filter(p => p.connected);
    if (active.length && active.every(p => p.finished)) this.endRace();
  }

  endRace() {
    if (this.state.phase !== 'race') return;
    if (this.state.mode === 'traffic') {
      // Ranked by score; equal scores by distance.
      this.state.players.forEach(p => { p.z = p._s.z; });     // the distance as it is now, not half a second ago
      [...this.state.players.values()].sort((a, b) => (b.score - a.score) || (b.z - a.z))
        .forEach((p, i) => { p.place = i + 1; p.finished = true; });
      this.stopTraffic();
      this.state.phase = 'results';
      this.unlock();
      return;
    }
    // Unfinished players are ranked by distance covered.
    const rest = [...this.state.players.values()].filter(p => !p.finished)
      .sort((a, b) => (b.lap * 1e5 + b.prog) - (a.lap * 1e5 + a.prog));   // prog: up to a few thousand track points
    let place = [...this.state.players.values()].filter(p => p.finished).length;
    rest.forEach(p => { p.place = ++place; });
    this.state.phase = 'results';
    this.unlock();
  }
}

const app = express();
trafficLib().catch(e => console.error('traffic simulation failed to load:', e));
// The same server also hands out the game itself, so one link is enough to play.
// The car models: the game asks for each with its content hash in the URL
// (models/cars/x.glb?v=<hash>, written by tools/prep-car-model.mjs), so such a URL never
// changes content and the browser keeps it a year without asking again. A changed model
// gets a new hash, a new URL. Without ?v= (and for everything else) express's default
// stands: max-age=0, checked with its ETag on every visit.
const PUBLIC = path.join(__dirname, '..', '..', 'public');
app.use(express.static(PUBLIC, {
  setHeaders(res, file){
    if(res.req.query.v && /^models[\\/]/.test(path.relative(PUBLIC, file))) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
app.get('/health', (_req, res) => res.json({ ok: true }));
// The server clock, for the game's clock sync (net/clock-worker.js). Any origin may ask:
// the game may be hosted elsewhere (Netlify, Vercel) and talk to this server.
app.get('/time', (_req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.json({ t: Date.now() });
});

const server = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
gameServer.define('race', RaceRoom);
gameServer.listen(PORT).then(() => console.log('Night Drift server on port ' + PORT));
