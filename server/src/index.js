// Night Drift — multiplayer server (Colyseus 0.15)
//
// The server is the single source of truth for everything that decides the race:
// who is in the room, when the race starts, lap times, finishing order and results.
// Car movement is calculated on each player's computer (no lag for your own car)
// and streamed here ~30 times a second.
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
const LAPS = 3;
const COUNTDOWN_MS = 4000;      // time from "start" to green light
const MIN_LAP_MS = Number(process.env.MIN_LAP_MS) || 20000;       // no lap on this track can be faster than this
const FINISH_GRACE_MS = Number(process.env.FINISH_GRACE_MS) || 45000;  // after the winner finishes, others get this long
const COLORS = [0xff3b6b, 0x3ef0ff, 0xffc23d, 0x9b7bff, 0x4dff9a, 0xff8a3d];
const MODES = ['track', 'traffic'];
// Traffic run lengths (s) the host can pick. EXTRA_DURATION adds one (tests use a short run).
const DURATIONS = [120, 180, 300].concat(Number(process.env.EXTRA_DURATION) > 0 ? [Number(process.env.EXTRA_DURATION)] : []);
const DENSITIES = ['low', 'mid', 'high'];   // traffic density (public/js/modes/traffic/sim.js DENSITY)
const WRECK_MS = 3000, GHOST_MS = 1500;     // online crash: stopped and blinking, then can't be hit
const SNAPSHOT_EVERY = 2;                    // traffic steps (1/20 s) per snapshot: 10 a second
const SNAP_BEHIND = 120, SNAP_AHEAD = 780;   // a player is sent the bots this far behind and ahead of its car (m)

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
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

class Player extends Schema {
  constructor() {
    super();
    this.name = '';
    this.color = 0;
    this.slot = 0;
    this.connected = true;
    this.x = 0; this.z = 0; this.h = 0;
    this.vf = 0; this.steer = 0; this.slide = 0;
    this.vx = 0; this.vz = 0;
    this.t = 0;              // sender's synced clock (server ms) when this position was true
    this.lap = 0;            // completed laps
    this.prog = 0;           // progress along the current lap, 0..900
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
  }
}
defineTypes(Player, {
  name: 'string', color: 'number', slot: 'uint8', connected: 'boolean',
  x: 'float32', z: 'float32', h: 'float32',
  vf: 'float32', steer: 'float32', slide: 'float32',
  vx: 'float32', vz: 'float32', t: 'float64',
  lap: 'uint8', prog: 'int16', score: 'uint32', bestLap: 'number',
  finished: 'boolean', finishTime: 'number', place: 'uint8',
  wreckUntil: 'float64', ghostUntil: 'float64', misses: 'uint16', wrecks: 'uint8',
});

class RaceState extends Schema {
  constructor() {
    super();
    this.phase = 'lobby';    // lobby | countdown | race | results
    this.hostId = '';
    this.laps = LAPS;
    this.startAt = 0;        // server clock (ms) of the green light
    this.mode = 'track';     // track | traffic, picked by the host in the lobby
    this.duration = 180;     // traffic: run length, s
    this.density = 'mid';    // traffic: low | mid | high
    this.endAt = 0;          // traffic: server clock (ms) when the run ends
    this.seed = 0;           // traffic: seed of this run's traffic
    this.players = new MapSchema();
  }
}
defineTypes(RaceState, {
  phase: 'string', hostId: 'string', laps: 'uint8', startAt: 'number',
  mode: 'string', duration: 'uint16', density: 'string', endAt: 'float64', seed: 'uint32',
  players: { map: Player },
});

const finite = (v, lo, hi, d = 0) => {
  if (typeof v === 'bigint') v = Number(v);   // large integers (e.g. timestamps) arrive as BigInt
  return (typeof v === 'number' && Number.isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
};
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || 'Гонщик';

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
    this.roomId = await freeCode();
    this.setState(new RaceState());
    if (options && MODES.includes(options.mode)) this.state.mode = options.mode;
    if (options && DENSITIES.includes(options.density)) this.state.density = options.density;
    this.traffic = null;         // traffic mode: the simulation of the current run
    this.trafficTimer = null;
    this.botHitAt = new Map();   // bot id -> server ms of the last accepted hit
    this.setPatchRate(33);       // send updates ~30 times a second
    this.lapStamp = new Map();   // sessionId -> server ms when the current lap started
    this.lastState = new Map();  // sessionId -> { t, x, z } for sanity checks
    this.timers = [];

    this.onMessage('ping', (client, msg) => {
      client.send('pong', { t: msg && msg.t, server: Date.now() });
    });

    this.onMessage('start', (client) => {
      if (client.sessionId !== this.state.hostId) return;
      if (this.state.phase !== 'lobby' && this.state.phase !== 'results') return;
      this.beginCountdown();
    });

    // Host only, between runs: pick the mode and (traffic) the run length.
    this.onMessage('config', (client, m) => {
      if (client.sessionId !== this.state.hostId || !m) return;
      if (this.state.phase !== 'lobby' && this.state.phase !== 'results') return;
      if (MODES.includes(m.mode)) this.state.mode = m.mode;
      if (DURATIONS.includes(m.duration)) this.state.duration = m.duration;
      if (DENSITIES.includes(m.density)) this.state.density = m.density;
    });

    this.onMessage('state', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !m || this.state.phase === 'lobby') return;
      const now = Date.now();
      // the track fits in ±2000 m; the highway runs on for as long as anyone can drive
      const hw = this.state.mode === 'traffic';
      const x = finite(m.x, hw ? -20 : -2000, hw ? 20 : 2000, p.x), z = finite(m.z, hw ? -1e7 : -2000, hw ? 1e7 : 2000, p.z);
      const last = this.lastState.get(client.sessionId);
      if (last) {
        // A car tops out around 70 m/s (250 km/h in a slipstream). Allow generous slack for lag spikes and the
        // "back to track" reset, but reject obvious teleports.
        const dt = Math.max(0.05, (now - last.t) / 1000);
        if (Math.hypot(x - last.x, z - last.z) > 90 * dt + 25) return;
      }
      this.lastState.set(client.sessionId, { t: now, x, z });
      p.x = x; p.z = z;
      p.h = finite(m.h, -1e4, 1e4, p.h);
      p.vf = finite(m.vf, -20, 80);          // forward speed: 72.3 m/s flat out, a little more in a slipstream
      p.steer = finite(m.steer, -1, 1);
      p.slide = finite(m.slide, 0, 1);
      p.vx = finite(m.vx, -70, 70); p.vz = finite(m.vz, -70, 70);
      // Trust the sender's timestamp only within a sane window around the server clock.
      p.t = finite(m.t, now - 1500, now, now);
      p.prog = Math.round(finite(m.prog, -50, 900));
      if (!p.finished) p.score = this.acceptScore(p, finite(m.score, 0, 1e8, p.score), now);
      if (hw) p.misses = Math.round(finite(m.misses, p.misses, 65535, p.misses));
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
      if (lapMs < MIN_LAP_MS) return;           // impossible lap: ignore
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

    // Car-to-car hits: the player who noticed the contact sends the other car's share of
    // the impulse, and the server passes it on. Values are clamped to what a real hit
    // between two cars can produce, so a modified client can't launch anyone off the map.
    this.onMessage('bump', (client, m) => {
      if (this.state.phase !== 'race' || !m) return;
      const from = this.state.players.get(client.sessionId), to = this.state.players.get(m.to);
      if (!from || !to || from.finished || to.finished) return;
      const now = Date.now();
      if (now < from.ghostUntil || now < to.ghostUntil) return;   // a crashed, blinking car can't push or be pushed
      if (Math.hypot(from.x - to.x, from.z - to.z) > 25) return;   // they weren't even close (positions here are a ping old)
      const target = this.clients.find(c => c.sessionId === m.to);
      if (!target) return;
      target.send('bump', {
        from: client.sessionId,
        jx: finite(m.jx, -30, 30), jz: finite(m.jz, -30, 30), w: finite(m.w, -4, 4),
        dx: finite(m.dx, -1.5, 1.5), dz: finite(m.dz, -1.5, 1.5),
      });
    });
  }

  onJoin(client, options) {
    const used = new Set([...this.state.players.values()].map(p => p.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const p = new Player();
    p.name = cleanName(options && options.name);
    p.slot = slot;
    p.color = COLORS[slot % COLORS.length];
    this.state.players.set(client.sessionId, p);
    if (!this.state.hostId) this.state.hostId = client.sessionId;
    this.broadcast('event', { text: p.name + ' в комнате' }, { except: client });
  }

  async onLeave(client, consented) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    p.connected = false;
    try {
      if (consented) throw new Error('left');
      await this.allowReconnection(client, 20);
      p.connected = true;
    } catch (e) {
      this.state.players.delete(client.sessionId);
      this.lapStamp.delete(client.sessionId);
      this.lastState.delete(client.sessionId);
      this.broadcast('event', { text: p.name + ' вышел' });
      if (this.state.hostId === client.sessionId) {
        const next = [...this.state.players.keys()][0];
        this.state.hostId = next || '';
      }
      this.checkRaceOver();
    }
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
    const age = Math.min(0.5, Math.max(0, (now - p.t) / 1000));
    return { x: p.x + p.vx * age, z: p.z + p.vz * age, v: p.vz };
  }
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
    s.players.forEach(p => { const g = lib.startPose(p.slot); p.x = g.x; p.z = g.z; p.vx = 0; p.vz = 0; p.vf = 0; p.t = 0; });
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
      p.lap = 0; p.prog = 0; p.score = 0; p.bestLap = 0;
      p.finished = false; p.finishTime = 0; p.place = 0;
      p.wreckUntil = 0; p.ghostUntil = 0; p.misses = 0; p.wrecks = 0; p._scoreAt = 0;
    });
    this.lapStamp.clear(); this.lastState.clear();
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
      [...this.state.players.values()].sort((a, b) => (b.score - a.score) || (b.z - a.z))
        .forEach((p, i) => { p.place = i + 1; p.finished = true; });
      this.stopTraffic();
      this.state.phase = 'results';
      this.unlock();
      return;
    }
    // Unfinished players are ranked by distance covered.
    const rest = [...this.state.players.values()].filter(p => !p.finished)
      .sort((a, b) => (b.lap * 1000 + b.prog) - (a.lap * 1000 + a.prog));
    let place = [...this.state.players.values()].filter(p => p.finished).length;
    rest.forEach(p => { p.place = ++place; });
    this.state.phase = 'results';
    this.unlock();
  }
}

const app = express();
trafficLib().catch(e => console.error('traffic simulation failed to load:', e));
// The same server also hands out the game itself, so one link is enough to play.
app.use(express.static(path.join(__dirname, '..', '..', 'public')));
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
