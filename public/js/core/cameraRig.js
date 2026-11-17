// Smoothed camera position and look target, shared by the menu orbit and the modes'
// race cameras. `init` false means: snap to the target on the next frame.
export const rig = { pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false };
