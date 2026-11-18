// The local player's car: the 3D model plus the physics state that stepCar() moves.
import { makeCar, dressCar } from './core/carModel.js';
import { carById, paintHex } from './core/cars.js';
import { setPaint } from './core/carModels.js';
import { choice } from './ui/garage.js';

export const car = Object.assign(makeCar(paintHex(choice.paint, choice.car), true),
  {x:0,z:0,h:0,vx:0,vz:0,vF:0,vR:0,steer:0,idx:0,prog:0,off:false,pitch:0,spinV:0});

// Which car this is (core/cars.js) and its paint code. car.spec is what the physics reads.
export function applyLook(carId, paint){
  const c = carById(carId);
  const same = car.model && car.model.carId === c.id;
  car.carId = c.id; car.spec = c.stats; car.paintHex = paint;
  setPaint(car.paint, paintHex(paint, c.id));
  if(same) car.model.code = paint;
  else dressCar(car, c.id, paint);                // the picked car's own model (loads once)
}
applyLook(choice.car, choice.paint);
