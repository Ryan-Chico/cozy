/**
 * b17.js — the aircraft over the creek.
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
 * The bomber is a small part of the model's own extent: the tracer fire sweeps
 * roughly six times its wingspan. blender/build_b17.py normalises on the
 * aircraft's span rather than on the tableau, and scales every part by the same
 * factor — which it has to, because the tracers are anchored at the gun
 * positions and anything else detaches them from the aircraft firing them. The
 * consequence here is that the model is far larger than the bomber: at 26 m of
 * wingspan the tableau runs 151 m across and 62 m tall, so parts of it leave the
 * frame at almost any distance you view it from. That is intended. It reads as
 * a moment rather than as an object.
 */

import * as THREE from 'three';

// Three.js metres. The opening shot looks up the creek towards +x from about
// (-18, 2, -4.6) with a 36 degree vertical field of view, which leaves only
// about fifteen degrees of sky above the horizon. That ceiling is what fixes
// the placement: to be in frame at all, height has to stay under roughly 0.27 x
// distance. "Near" and "high" are therefore one dial rather than two, and this
// is as near as the aircraft can be while still clearing the treeline.
//
// At ~55 m it fills about two fifths of the frame's width, sits up near the top
// edge where the bough cuts across it, and reads at roughly 45% into the haze
// rather than the ~70% it wore at 75 m. Push it nearer and it drops behind the
// trees; lift it and the top of the frame takes its wings.
const POSITION = new THREE.Vector3(37, 12.2, 0.1);
const YAW_DEG = -155;     // broadside-on to the opening shot, nose a little toward it
const PITCH_DEG = 0;      // the dive attitude is baked into the sculpt
const ROLL_DEG = 0;

// The scene's fog seats it: at this distance FogExp2 has already blended it
// nearly halfway into the warm haze, which is what stops a 26 m object reading
// as pasted on the sky. What is left to fix here is brightness. The airframe is
// a dark olive that went to flat black while the material was still metallic;
// even with that corrected it wants the toad's colour lift to sit under this
// dusk rather than in it.
const ENV_INTENSITY = 1.15;
const COLOUR_LIFT = [1.16, 1.14, 1.10];
const EMISSIVE_BOOST = 1.7;    // the burning wing roots should carry at distance

// Nothing here casts a shadow, and that is a finding rather than an omission.
// At the sun's 22 degrees of elevation a shadow falls about 2.5x its height
// up-sun, so this aircraft's lands roughly 30 m further along +x — and the
// aircraft already sits past the terrain's edge, so the shadow arrives where
// there is no ground to receive it. Checked from directly above the point it
// would land on, and again from the creek: nothing. Left as a constant rather
// than hardcoded false, because it is the placement that rules it out, not the
// aircraft.
const CAST_SHADOW = false;

// The rounds arrive from the build already carrying a warm emission of their own
// (TRACER_EMISSION_STRENGTH in blender/build_b17.py, which is where the colour
// lives). This scales whatever they arrived with, so the glow can be worked
// against the bloom without a Blender round-trip.
const TRACER_GLOW_SCALE = 1.0;

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
    obj.castShadow = CAST_SHADOW;
    obj.receiveShadow = false;

    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of materials) {
      if (!m) continue;
      m.envMapIntensity = ENV_INTENSITY;
      if (m.map) m.color.setRGB(COLOUR_LIFT[0], COLOUR_LIFT[1], COLOUR_LIFT[2]);
      if (m.emissiveMap) m.emissiveIntensity = EMISSIVE_BOOST;
      if (obj.name === 'B17_Tracers') m.emissiveIntensity *= TRACER_GLOW_SCALE;

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
