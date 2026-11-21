// Solo drift records, one pair per map: the best lap (s) and the best drift score of a
// run. Kept in localStorage under 'nightdrift.best.<map id>' as JSON { lap, score }.
// The old single key 'nightdrift.best' (a best lap, from before there were several maps)
// was «Ночной город»'s: migrate() moves it there once.
// Pure apart from the store: tests pass their own ({ getItem, setItem, removeItem }).
const safeStore = {
  getItem(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  setItem(k, v){ try{ localStorage.setItem(k, v); }catch(e){} },
  removeItem(k){ try{ localStorage.removeItem(k); }catch(e){} },
};
export const OLD_KEY = 'nightdrift.best';
export const recordKey = mapId => OLD_KEY + '.' + mapId;

// the records of a map: { lap: seconds or 0, score: points or 0 }
export function records(mapId, store = safeStore){
  let r = null; try{ r = JSON.parse(store.getItem(recordKey(mapId)) || 'null'); }catch(e){}
  const lap = r && Number.isFinite(r.lap) && r.lap > 0 ? r.lap : 0, score = r && Number.isFinite(r.score) && r.score > 0 ? r.score : 0;
  return { lap, score };
}
function save(mapId, r, store){ store.setItem(recordKey(mapId), JSON.stringify(r)); }
// a lap of t s: true when it is the map's new record (then it is stored)
export function saveLap(mapId, t, store = safeStore){
  const r = records(mapId, store); if(!(t > 0) || (r.lap && t >= r.lap)) return false;
  r.lap = t; save(mapId, r, store); return true;
}
// a run's drift score: true when it is the map's new record (then it is stored)
export function saveScore(mapId, pts, store = safeStore){
  const r = records(mapId, store); if(!(pts > 0) || pts <= r.score) return false;
  r.score = pts; save(mapId, r, store); return true;
}
// the old key's lap goes to «Ночной город» (unless it already has a better one); the old key is removed
export function migrate(store = safeStore, mapId = 'neon'){
  const old = parseFloat(store.getItem(OLD_KEY));
  if(old > 0) saveLap(mapId, old, store);
  if(store.getItem(OLD_KEY) !== null) store.removeItem(OLD_KEY);
}
