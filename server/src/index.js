// Night Drift — multiplayer server (Colyseus 0.15)
//
// The server is the single source of truth for everything that decides the race:
// who is in the room, when the race starts, lap times, finishing order and results.
// Car movement is calculated on each player's computer (no lag for your own car)
// and streamed here 20 times a second; cars are "ghosts" and don't collide.

const http = require('http');
const path = require('path');
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
    this.lap = 0;            // completed laps
    this.prog = 0;           // progress along the current lap, 0..900
    this.score = 0;
    this.bestLap = 0;        // ms, measured by the server
    this.finished = false;
    this.finishTime = 0;     // ms since green light, measured by the server
    this.place = 0;
  }
}
defineTypes(Player, {
  name: 'string', color: 'number', slot: 'uint8', connected: 'boolean',
  x: 'float32', z: 'float32', h: 'float32',
  vf: 'float32', steer: 'float32', slide: 'float32',
  lap: 'uint8', prog: 'int16', score: 'uint32', bestLap: 'number',
  finished: 'boolean', finishTime: 'number', place: 'uint8',
});

class RaceState extends Schema {
  constructor() {
    super();
    this.phase = 'lobby';    // lobby | countdown | race | results
    this.hostId = '';
    this.laps = LAPS;
    this.startAt = 0;        // server clock (ms) of the green light
    this.players = new MapSchema();
  }
}
defineTypes(RaceState, {
  phase: 'string', hostId: 'string', laps: 'uint8', startAt: 'number',
  players: { map: Player },
});

const finite = (v, lo, hi, d = 0) => (typeof v === 'number' && Number.isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : d;
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
  async onCreate() {
    this.maxClients = MAX_PLAYERS;
    this.roomId = await freeCode();
    this.setState(new RaceState());
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

    this.onMessage('state', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !m || this.state.phase === 'lobby') return;
      const now = Date.now();
      const x = finite(m.x, -2000, 2000, p.x), z = finite(m.z, -2000, 2000, p.z);
      const last = this.lastState.get(client.sessionId);
      if (last) {
        // A car tops out around 50 m/s. Allow generous slack for lag spikes and the
        // "back to track" reset, but reject obvious teleports.
        const dt = Math.max(0.05, (now - last.t) / 1000);
        if (Math.hypot(x - last.x, z - last.z) > 70 * dt + 25) return;
      }
      this.lastState.set(client.sessionId, { t: now, x, z });
      p.x = x; p.z = z;
      p.h = finite(m.h, -1e4, 1e4, p.h);
      p.vf = finite(m.vf, -20, 60);
      p.steer = finite(m.steer, -1, 1);
      p.slide = finite(m.slide, 0, 1);
      p.prog = Math.round(finite(m.prog, -50, 900));
      if (!p.finished) p.score = Math.round(finite(m.score, 0, 1e7, p.score));
    });

    this.onMessage('lap', (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.finished || this.state.phase !== 'race') return;
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
      if (p && m) p.score = Math.round(finite(m.score, 0, 1e7, p.score));
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

  onDispose() { this.timers.forEach(clearTimeout); }

  later(ms, fn) { const t = setTimeout(fn, ms); this.timers.push(t); return t; }

  beginCountdown() {
    this.timers.forEach(clearTimeout); this.timers = [];
    const s = this.state;
    s.players.forEach((p) => {
      p.lap = 0; p.prog = 0; p.score = 0; p.bestLap = 0;
      p.finished = false; p.finishTime = 0; p.place = 0;
    });
    this.lapStamp.clear(); this.lastState.clear();
    s.phase = 'countdown';
    s.startAt = Date.now() + COUNTDOWN_MS;
    this.lock();
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
    if (this.state.phase !== 'race') return;
    const active = [...this.state.players.values()].filter(p => p.connected);
    if (active.length && active.every(p => p.finished)) this.endRace();
  }

  endRace() {
    if (this.state.phase !== 'race') return;
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
// The same server also hands out the game itself, so one link is enough to play.
app.use(express.static(path.join(__dirname, '..', '..', 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server }) });
gameServer.define('race', RaceRoom);
gameServer.listen(PORT).then(() => console.log('Night Drift server on port ' + PORT));
