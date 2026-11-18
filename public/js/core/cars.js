// The cars a player can pick, their classes, and the paint colours.
//
// Plain data, no three.js: the game reads it (physics, the car picker, the 3D model) and
// so does the multiplayer server (server/src/index.js checks a player's pick against it).
//
// Stats are multipliers on the base physics in core/physics.js; 1 everywhere is the car
// the game always had, and drives exactly as before. Every car is better at something
// and pays for it somewhere else, within a few per cent, so no car is simply the best:
// tests/cars.test.mjs drives each one around the drift track and down the highway and
// checks how close they stay.
//
//   vmax   top speed            acc    acceleration        brake   braking
//   grip   tyre grip while gripping (how planted it is in a turn)
//   slide  grip while sliding (higher: a drift settles quicker, lower: it slides longer
//          and a drift is easier to hold)
//   turn   how fast the nose turns in
//   dirt   pull off the asphalt (only the rally car differs: it loses less on the verge)
//
// model: the 3D model file under public/ (models/cars/, see README there). Every model has
// a material "Paint" (the body: recolour it by its colour, no texture); the four detailed
// ones also have "Glass" (the windows). core/carModels.js loads and recolours them.
// factory: the colour of the model's own Paint material (sRGB), the "Заводской" paint;
// tests/cars.test.mjs checks it against the file.

export const BASE = Object.freeze({ vmax: 1, acc: 1, brake: 1, grip: 1, slide: 1, turn: 1, dirt: 1 });
const S = o => Object.freeze({ ...BASE, ...o });

// Classes, in the order the picker shows them.
export const CLASSES = [
  { id: 'gt',     name: 'GT',        tag: 'Золотая середина: ничего лишнего, ничего не хватает' },
  { id: 'jdm',    name: 'JDM',       tag: 'Японские дрифт-машины: легко идут боком и держат занос' },
  { id: 'muscle', name: 'Маслкар',   tag: 'Мощь на прямой и занос на мощности, тяжело в повороте' },
  { id: 'super',  name: 'Суперкар',  tag: 'Самая высокая скорость, но не для дрифта' },
  { id: 'sedan',  name: 'Седан',     tag: 'Тяжёлые и устойчивые: прощают ошибки, тормозят лучше всех' },
  { id: 'rally',  name: 'Ралли',     tag: 'Универсал: дрифт, горы, бездорожье; медленнее на прямой' },
];

export const CARS = [
  // GT: the base car. Exactly the physics the game always had.
  { id: 'coupe',  cls: 'gt',     name: 'Aston Martin', model: 'models/cars/generic_sport_coupe_car.glb', factory: 0x881413,
    tag: 'Эталон: ровно во всём, ни одной слабости и ни одного козыря',
    stats: BASE },

  // JDM: the drift cars. Both hold a slide easily; one grips, one is pure drift.
  { id: 'gtr',    cls: 'jdm',    name: 'Skyline GT-R R32', model: 'models/cars/nissan_gtr_r32.glb', factory: 0x2f2f2f,
    tag: 'Полный привод: цепкий и резвый с места, легко идёт в занос, но невысокая максималка',
    stats: S({ vmax: 0.98, acc: 1.03, brake: 1.01, grip: 1.04, slide: 0.95, turn: 1.02 }) },
  { id: 'rx7',    cls: 'jdm',    name: 'Mazda RX-7',   model: 'models/cars/lowpoly_stylized_rx_7_free.glb', factory: 0xfc6d00,
    tag: 'Король дрифта: лёгкий, острый руль, дольше всех держит занос, но слабый мотор',
    stats: S({ vmax: 0.98, acc: 1.0, brake: 1.03, grip: 1.06, slide: 0.92, turn: 1.07 }) },

  // Muscle: power and a tail that steps out; pays in corners and brakes.
  { id: 'muscle', cls: 'muscle', name: 'Dodge',        model: 'models/cars/muscle_car.glb', factory: 0xe70900,
    tag: 'Мощный, второй по скорости, охотно идёт боком, но тяжёлый в повороте и тормоза так себе',
    stats: S({ vmax: 1.02, acc: 1.03, brake: 0.94, grip: 0.94, slide: 0.94, turn: 0.95 }) },

  // Super: the fastest car; planted, so a drift dies quickly.
  { id: 'super',  cls: 'super',  name: 'Lamborghini',  model: 'models/cars/sports_car.glb', factory: 0xe22727,
    tag: 'Самая высокая максималка, но неохотно поворачивает и не любит занос',
    stats: S({ vmax: 1.05, acc: 1.0, brake: 1.03, grip: 0.92, slide: 1.0, turn: 0.92 }) },

  // Sedans: heavy and stable, forgiving.
  { id: 'sedan',  cls: 'sedan',  name: 'Ford',         model: 'models/cars/generic_sedan_car.glb', factory: 0x656770,
    tag: 'Для новичка: устойчивый, отличные тормоза, прощает ошибки, но неторопливый',
    stats: S({ vmax: 0.98, acc: 0.97, brake: 1.06, grip: 1.05, slide: 1.06, turn: 1.0 }) },
  { id: 'nexus',  cls: 'sedan',  name: 'Nexus RX',     model: 'models/cars/nexus_rx.glb', factory: 0x4f5471,
    tag: 'Электромобиль: лучший разгон с места, но скромная максималка и тяжёлый в повороте',
    stats: S({ vmax: 0.96, acc: 1.08, brake: 1.02, grip: 1.02, slide: 1.03, turn: 0.93 }) },

  // Rally: agile, at home off the asphalt, slow at the top.
  { id: 'rally',  cls: 'rally',  name: 'Rally',        model: 'models/cars/everest.glb', factory: 0x1f5cff,
    tag: 'Вёрткий, уверенно скользит и лучше всех едет по бездорожью, но низкая максималка',
    stats: S({ vmax: 0.95, acc: 1.02, brake: 1.0, grip: 1.03, slide: 0.97, turn: 1.06, dirt: 1.25 }) },
];
export const CAR_IDS = CARS.map(c => c.id);
export const DEFAULT_CAR = CARS[0].id;           // the first car of the list: reorder CARS to change it
export const carById = id => CARS.find(c => c.id === id) || CARS[0];
export const classById = id => CLASSES.find(c => c.id === id) || CLASSES[0];

// The paints. The first is "Заводской": the colour the car's own model came with (each
// car's `factory` above). The rest are strong, saturated colours: no pastels and no pink
// (pink is the interface's brand colour, not a car's). Players may share a colour.
//
// A paint travels as a number (localStorage, the room's state): its sRGB hex, or FACTORY
// (-1) for the car's own colour. paintHex() turns that into the colour to draw.
export const FACTORY = -1;
export const PAINTS = [
  { hex: null,     name: 'Заводской' },
  { hex: 0xf2f4f7, name: 'Белый' },
  { hex: 0x16181d, name: 'Чёрный' },
  { hex: 0xa7afba, name: 'Серебро' },
  { hex: 0xd3202a, name: 'Красный' },
  { hex: 0xf0661a, name: 'Оранжевый' },
  { hex: 0xf4c20d, name: 'Жёлтый' },
  { hex: 0x1fa34a, name: 'Зелёный' },
  { hex: 0x1793d1, name: 'Голубой' },
  { hex: 0x2041c2, name: 'Синий' },
  { hex: 0x6a35c9, name: 'Фиолетовый' },
];
export const paintCode = p => p.hex === null ? FACTORY : p.hex;
export const PAINT_CODES = PAINTS.map(paintCode);
export const PAINT_HEXES = PAINT_CODES;          // old name, still read by the server
export const DEFAULT_PAINT = FACTORY;
export const isPaint = code => PAINT_CODES.includes(code);
export const paintByCode = code => PAINTS[Math.max(0, PAINT_CODES.indexOf(code))];
// The colour (sRGB hex) a paint code gives on a car: FACTORY is that car's own colour.
export const paintHex = (code, carId) => (code === FACTORY || !isPaint(code)) ? carById(carId).factory : code;

// Stats as 0..10 bars for the picker. The base car sits at 6 on every bar and ±6 % moves a
// bar by ±3, so the differences show without looking bigger than they are.
const bar = m => Math.max(1, Math.min(10, Math.round((6 + (m - 1) * 50) * 2) / 2));
export function statBars(stats) {
  return [
    ['Скорость', bar(stats.vmax)],
    ['Разгон', bar(stats.acc)],
    ['Тормоза', bar(stats.brake)],
    ['Сцепление', bar(stats.grip)],
    ['Поворот', bar(stats.turn)],
    ['Занос', bar(2 - stats.slide)],      // less grip in a slide: an easier, longer drift
    ['Бездорожье', bar(1 + (stats.dirt - 1) / 4)],   // +20 % off-road pull shows as +3
  ];
}
