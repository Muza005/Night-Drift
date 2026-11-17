// Shared game state. Modules import these objects and change their fields
// (an ES module cannot reassign another module's variables, but it can change an
// object's fields), so everything that used to be a top-level `let` lives here.

export const $ = id => document.getElementById(id);
export const isTouch = matchMedia('(pointer:coarse)').matches;

export const G = {
  state: 'menu',      // menu | count | race | crash | over | pause | lobby | results
  mode: null,         // the active game mode (see modes/track/index.js for the interface)
  cd: 0, prevCount: 3,
  raceT: 0, lapT: 0, lap: 1,
  score: 0, best: null,
  shake: 0, wrongT: 0, toastT: 0,
  crashT: 0,          // seconds since a crash (traffic mode)
};

export const drift = { pts: 0, time: 0, grace: 0, mult: 1, active: false };

// Online session. Every field is used exactly as in the single-file version.
export const NET = {client:null,room:null,online:false,me:null,offset:0,bestRtt:1e9,ghosts:new Map(),
  sendT:0,standT:0,rtt:0,hitAt:{},sentAt:{},finished:false,leaving:false,token:null,laps:3,pingTimer:0,
  draft:{level:0}};   // slipstream push 0..1 (core/draft.js)

export const serverNow = () => Date.now() + NET.offset;
