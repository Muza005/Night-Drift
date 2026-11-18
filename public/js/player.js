// The local player's car: the 3D model plus the physics state that stepCar() moves.
import { makeCar } from './core/carModel.js';
import { carById } from './core/cars.js';
import { choice } from './ui/garage.js';

export const car = Object.assign(makeCar(choice.paint, true),
  {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,pitch:0,spinV:0});

// Which car this is (core/cars.js) and its paint. car.spec is what the physics reads.
export function applyLook(carId, paint){
  const c = carById(carId);
  car.carId = c.id; car.spec = c.stats; car.paintHex = paint;
  car.paint.color.setHex(paint);
}
applyLook(choice.car, choice.paint);
