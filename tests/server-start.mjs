// Starts server/src/index.js for a test on a free port, and stops it.
//
// A fixed port could already be taken (a dev server, another test run). Then the spawned
// server died on EADDRINUSE while /health answered from the foreign one, with other
// settings, and the test hung. Now the port is one the system just handed out, the server
// must still be alive when /health answers, and stopping a server that already exited
// returns at once.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as Colyseus from 'colyseus.js';
import { PROTOCOL } from '../public/js/net/protocol.js';

// The game sends its protocol number when it creates or joins a room (net/protocol.js), and
// the server turns away any client without it. The tests' clients send it too: every
// create/join here gets { proto: PROTOCOL } unless the options name their own (an old
// client: proto: undefined).
for (const k of ['create', 'joinById', 'join', 'joinOrCreate']) {
  const f = Colyseus.Client.prototype[k];
  Colyseus.Client.prototype[k] = function (name, options, ...rest) { return f.call(this, name, { proto: PROTOCOL, ...options }, ...rest); };
}

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// env: extra environment for the server. Resolves to { port, proc, stop() }.
export async function startServer(env = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, ['src/index.js'], { cwd: SERVER_DIR, env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; proc.stderr.on('data', d => { err = (err + d).slice(-2000); });
  const stop = () => new Promise(r => { if (proc.exitCode !== null || proc.signalCode !== null) return r(); proc.once('exit', r); proc.kill(); });
  for (let i = 0; i < 50; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited with code ${proc.exitCode} (did you run npm install in server/?)\n${err}`);
    try { if ((await fetch(`http://localhost:${port}/health`)).ok) return { port, proc, stop }; } catch {}
    await sleep(200);
  }
  await stop();
  throw new Error('server did not start in 10 s\n' + err);
}
