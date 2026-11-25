// Ghost mode («Призраки», plan 3 stage 4b): a room setting the host picks in the lobby
// (room state ghostMode). While it is on, players' cars pass through each other: no contact,
// no hits sent or taken, no keep-out push (net.js). Walls and the highway's traffic stay
// solid (those are not hits between players), the slipstream works as usual.
// So that a player sees their own car through another, an opponent's car closer than
// NEAR m is drawn at ALPHA, fading back to solid by FAR m.

export const NEAR = 6, FAR = 8, ALPHA = 0.5;

// Do players' cars touch in this room? (no room: nothing to touch, but nothing to skip either)
export const playersCollide = st => !(st && st.ghostMode === true);

// How solid another player's car is drawn at distance d (m) from ours.
export function ghostAlpha(ghostMode, d) {
  if (!ghostMode || !(d < FAR)) return 1;
  if (d <= NEAR) return ALPHA;
  return ALPHA + (1 - ALPHA) * (d - NEAR) / (FAR - NEAR);
}

// Draw the car root `root` (a three.js object) at `alpha`. Car models share their materials
// with every car of that model (and the player's own car), so the car gets its own see-through
// copies (kept in `cache`: original material -> copy), swapped in while it is see-through and
// swapped back when it is solid again. Materials that are already see-through (glows, the tag)
// are left as they are. Returns the alpha now drawn.
export function setCarAlpha(root, alpha, cache) {
  const solid = alpha >= 0.999;
  root.traverse(o => {
    if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
    if (solid) {
      if (o.userData.solidMat) { o.material = o.userData.solidMat; o.userData.solidMat = null; }
      return;
    }
    const orig = o.userData.solidMat || o.material;
    if (orig.transparent) return;
    let see = cache.get(orig);
    // no depth writes: the car's parts are sorted by centre, and a half-seen body must not hide its own wheels
    if (!see) { see = orig.clone(); see.transparent = true; see.depthWrite = false; cache.set(orig, see); }
    see.opacity = alpha;
    if (orig.emissiveIntensity !== undefined) see.emissiveIntensity = orig.emissiveIntensity;   // brake lights
    if (!o.userData.solidMat) { o.userData.solidMat = orig; o.material = see; }
  });
  return solid ? 1 : alpha;
}

// Free the copies (the car is gone or got another model).
export function disposeAlpha(cache) {
  for (const m of cache.values()) m.dispose();
  cache.clear();
}
