/**
 * b17.js — the aircraft in the sky.
 *
 * It is a guest, and a still one: the asset arrives as a posed sculpt with no
 * armature and no actions, and it is deliberately left that way. Nothing here
 * moves it. What this file does own is where it hangs over the creek, which way
 * it is turned, and the handful of material settings that glTF does not carry.
 *
 * Two things about the asset are worth knowing before moving it around.
 *
 * The nose points three.js +Z — the exporter maps Blender -Y onto +Z, and the
 * smoke trail sits on the aircraft's Blender +Y side, which is to say behind it.
 * So a yaw of zero has it flying directly away from the opening shot.
 *
 * The aircraft is only about a fifth of the model's own extent. The rest is the
 * tracer fire, which sweeps roughly six times the aircraft's span, and the smoke
 * plumes. blender/build_b17.py normalises the whole tableau for that reason: the
 * aircraft is a silhouette in the sky, not something you walk up to, so the
 * tracers are what wants keeping in bounds.
 */

import * as THREE from 'three';

// Three.js metres. The opening shot looks up the creek towards +x from about
// (-18, 2, -4.6) with a 36 degree vertical field of view, which only leaves
// about fifteen degrees of sky above the horizon — so "high in the sky" is much
// lower than it sounds, and the aircraft has to sit well down the creek to be in
// that band at all. Raise Y and it leaves the top of the frame.
const POSITION = new THREE.Vector3(57, 15, 2);
const YAW_DEG = -155;     // broadside-on to the opening shot, nose a little toward it
const PITCH_DEG = 0;      // the dive attitude is baked into the sculpt
const ROLL_DEG = 0;

// The scene's fog does most of the work of seating it: at the distance the
// opening shot puts it, FogExp2 has already blended it roughly seven tenths of
// the way into the warm haze, which is why it reads as something far off rather
// than a model pasted on the sky. What is left to fix here is brightness. The
// airframe is a dark olive that went to flat black while the material was still
// metallic; even with that corrected it wants the toad's colour lift to sit
// under this dusk rather than in it.
const ENV_INTENSITY = 1.15;
const COLOUR_LIFT = [1.16, 1.14, 1.10];
const EMISSIVE_BOOST = 1.7;    // the burning wing roots should carry at distance

export function createB17({ gltf }) {
  const object = gltf.scene;
  object.name = 'B17';
  object.position.copy(POSITION);
  object.rotation.set(
    THREE.MathUtils.degToRad(PITCH_DEG),
    THREE.MathUtils.degToRad(YAW_DEG),
    THREE.MathUtils.degToRad(ROLL_DEG),
    'YXZ',
  );

  object.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = false;      // it never comes within thirty metres of the ground
    obj.receiveShadow = false;

    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) {
      if (!m) continue;
      m.envMapIntensity = ENV_INTENSITY;
      if (m.map) m.color.setRGB(COLOUR_LIFT[0], COLOUR_LIFT[1], COLOUR_LIFT[2]);
      if (m.emissiveMap) m.emissiveIntensity = EMISSIVE_BOOST;

      // The smoke and the tracer fire are FX cards, not surfaces. They are
      // alpha-blended, so they must not write depth or they punch holes in each
      // other and in the sky behind them.
      if (m.transparent) {
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
      }
    }
  });

  return { object };
}
