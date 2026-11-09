// Slipstream ("карман"): driving close behind another player cuts the air in front of
// you, so your car pulls harder. Pure maths, no three.js: the game, the tests and the
// drawing of the white air lines (core/draftfx.js) all use these same numbers.
//
// The pocket trails behind the other car in the direction it is moving:
//   - only behind a car doing at least 60 km/h;
//   - from 1.5 m behind its rear bumper to 10 m + 0.55 s of its speed (31 m at 140 km/h,
//     at most 40 m);
//   - 1.4 m to each side of its centre line right behind it, widening by 3 cm per metre;
//   - you must be going the same way (within ~37°).
// Inside, the push builds up over 0.8 s and adds up to DRAFT_ACC (core/physics.js) while
// you are on the throttle; outside it fades over 0.5 s. Its white lines start to show
// once you are within 45 m behind it, and glow brighter while you are in the pocket.
export const DRAFT = { MIN_SPEED: 60 / 3.6, NEAR: 1.5, SHOW: 45, CHARGE: .8, FADE: .5, REAR: 2.15 };
export const pocketLen = v => Math.min(40, 10 + .55 * v);
export const pocketHalf = behind => 1.4 + .03 * Math.max(0, behind);

// me, lead: {x, z, vx, vz}. Returns null when the lead car is too slow to leave a pocket.
export function wake(me, lead) {
  const v = Math.hypot(lead.vx, lead.vz);
  if (v < DRAFT.MIN_SPEED) return null;
  const fx = lead.vx / v, fz = lead.vz / v;
  const dx = me.x - lead.x, dz = me.z - lead.z;
  const behind = -(dx * fx + dz * fz) - DRAFT.REAR;         // metres behind its rear bumper
  const side = dx * fz - dz * fx;                            // metres off its centre line
  const len = pocketLen(v);
  const mv = Math.hypot(me.vx, me.vz);
  const same = mv > 1 && (me.vx * fx + me.vz * fz) / mv > .8;
  const inside = same && behind > DRAFT.NEAR && behind < len && Math.abs(side) < pocketHalf(behind);
  const near = same && behind > -1 && behind < DRAFT.SHOW && Math.abs(side) < 10;
  const show = !near ? 0 : inside ? 1 : .55 * Math.min(1, (DRAFT.SHOW - behind) / 12);
  return { behind, side, len, speed: v, dirX: fx, dirZ: fz, inside, show };
}

// The push level, 0..1: builds while inside a pocket, fades outside.
export function stepDraft(st, inside, dt) {
  st.level = inside ? Math.min(1, st.level + dt / DRAFT.CHARGE) : Math.max(0, st.level - dt / DRAFT.FADE);
  return st.level;
}
