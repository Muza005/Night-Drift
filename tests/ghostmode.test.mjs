// Ghost mode on the client (plan 3 stage 4b, net/ghostmode.js): in a ghost-mode room the
// game skips every contact between players' cars (net.js touchable: no collideStep, no hit
// sent, no keep-out push; onBump ignores a hit), and draws a car near ours see-through on
// its own copies of the materials, never on the ones it shares with other cars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { playersCollide, ghostAlpha, setCarAlpha, disposeAlpha, NEAR, FAR, ALPHA } from '../public/js/net/ghostmode.js';

const THREE = createRequire(import.meta.url)('three');

test('ghost mode: players collide only when it is off', () => {
  assert.equal(playersCollide({ ghostMode: false }), true);
  assert.equal(playersCollide({ ghostMode: true }), false);
  assert.equal(playersCollide({}), true, 'an older room state without the field: hits as before');
  assert.equal(playersCollide(null), true);
});

test('ghost mode: net.js skips contact, hits and keep-out between players through playersCollide', () => {
  const src = readFileSync(new URL('../public/js/net/net.js', import.meta.url), 'utf8');
  // touchable() gates collideStep (contact and the hit sent), keepOut (the drawn push) ...
  const touch = src.match(/function touchable\(g,nowS\)\{([\s\S]*?)\n\}/);
  assert.ok(touch, 'touchable() is in net.js');
  assert.match(touch[1], /playersCollide\(NET\.room\.state\)/, 'touchable() is off in ghost mode');
  assert.match(src, /if\(!touchable\(g,tS\)[^\n]*continue;\s*\n\s*const r=collideStep\(/, 'collideStep only for touchable cars');
  assert.match(src, /if\(g\.mem && touchable\(g,nowS\)\)\{[^\n]*keepOut\(/, 'keepOut only for touchable cars');
  // ... and a hit that comes in anyway is dropped
  const bump = src.match(/function onBump\(m\)\{([\s\S]*?)\n\}/);
  assert.ok(bump && /!playersCollide\(NET\.room\.state\)\) return;/.test(bump[1]), 'onBump ignores hits in ghost mode');
});

test('ghost mode: see-through near our car, solid farther off or when off', () => {
  assert.equal(ghostAlpha(false, 0), 1, 'off: always solid');
  assert.equal(ghostAlpha(true, 0), ALPHA);
  assert.equal(ghostAlpha(true, NEAR), ALPHA);
  assert.equal(ghostAlpha(true, FAR), 1);
  assert.equal(ghostAlpha(true, 50), 1);
  const mid = ghostAlpha(true, (NEAR + FAR) / 2);
  assert.ok(mid > ALPHA && mid < 1, 'fades in between');
  assert.equal(ghostAlpha(true, NaN), 1);
});

test('ghost mode: see-through copies, the shared materials untouched, solid again after', () => {
  const shared = new THREE.MeshStandardMaterial({ color: 0xff0000, emissiveIntensity: 1.4 });
  const glow = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55 });
  const root = new THREE.Group(), a = new THREE.Mesh(new THREE.BoxGeometry(), shared), b = new THREE.Mesh(new THREE.BoxGeometry(), shared), c = new THREE.Mesh(new THREE.PlaneGeometry(), glow);
  root.add(a, b, c);
  const other = new THREE.Mesh(new THREE.BoxGeometry(), shared);   // another car with the same model
  const cache = new Map();
  assert.equal(setCarAlpha(root, 0.5, cache), 0.5);
  assert.notEqual(a.material, shared); assert.equal(a.material, b.material, 'one copy per material');
  assert.equal(a.material.transparent, true); assert.equal(a.material.opacity, 0.5);
  assert.equal(shared.transparent, false); assert.equal(shared.opacity, 1, 'the shared material is not changed');
  assert.equal(other.material, shared);
  assert.equal(c.material, glow, 'a glow is left as it is'); assert.equal(glow.opacity, 0.55);
  shared.emissiveIntensity = 4.5;                  // braking
  setCarAlpha(root, 0.7, cache);
  assert.equal(a.material.opacity, 0.7); assert.equal(a.material.emissiveIntensity, 4.5, 'brake lights follow');
  assert.equal(cache.size, 1, 'no new copy per frame');
  assert.equal(setCarAlpha(root, 1, cache), 1);
  assert.equal(a.material, shared); assert.equal(b.material, shared);
  disposeAlpha(cache); assert.equal(cache.size, 0);
});
