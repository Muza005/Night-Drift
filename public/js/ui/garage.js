// The player's pick of car and paint, remembered in the browser. The garage screen
// (ui/garageScreen.js) changes it; online it is also sent to the room.
import { CAR_IDS, DEFAULT_CAR, DEFAULT_PAINT, isPaint } from '../core/cars.js';

const LS = {
  get(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch(e){} },
};

// What the player picked last time (or the car and colour the game always had).
export const choice = {
  car: CAR_IDS.includes(LS.get('nightdrift.car')) ? LS.get('nightdrift.car') : DEFAULT_CAR,
  paint: isPaint(Number(LS.get('nightdrift.paint'))) && LS.get('nightdrift.paint') !== null ? Number(LS.get('nightdrift.paint')) : DEFAULT_PAINT,
};
export function savePick(car, paint){
  if(CAR_IDS.includes(car)){ choice.car = car; LS.set('nightdrift.car', car); }
  if(isPaint(paint)){ choice.paint = paint; LS.set('nightdrift.paint', String(paint)); }
}
