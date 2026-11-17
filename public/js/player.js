// The local player's car: the 3D model plus the physics state that stepCar() moves.
import { makeCar } from './core/carModel.js';

export const car = Object.assign(makeCar(0xff3b6b, true),
  {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,pitch:0,spinV:0});
