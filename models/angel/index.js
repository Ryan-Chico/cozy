/**
 * The last guest, and the biggest thing here by an order of magnitude.
 *
 * "Angel of Justice" by João Lacerda (panc0), CC BY 4.0, via Sketchfab. The
 * statue is 34k triangles and 2.9 MB; blender/build_angel.py flattens the
 * Sketchfab wrappers, turns it onto the project's facing convention, grounds
 * the base, trims the dead UV layers and cuts the maps to 1024/512.
 *
 * It stands past the upstream end of the creek, behind the opening camera. On
 * foot you never reach it -- the walk bounds stop at x = -30 and it is at
 * x = -86 -- so `grounded` is off and its height is given directly: the terrain
 * sampler clamps outside the terrain, and asking it where the ground is out
 * there would answer for a bank 54 m away. Its feet are 8 m under the
 * waterline, so the upstream bank's sightline cuts the pedestal off and the
 * figure reads as standing at the edge of the world rather than floating in
 * front of it.
 *
 * The reveal is the placement. The opening shot looks downstream at +x; the
 * statue is directly behind the camera, and turning around is the whole
 * mechanic. It faces -x (up-valley, away from the visitor), so what turning
 * around shows is the statue's back and the back of its wings: `face` is -90
 * because the build leaves it nose-on +z like every other guest, and -90 turns
 * +z onto -x.
 *
 * Size is the asset's longest axis, which is its height: 80 m to the wing
 * tips, 68 m to the crown against a 13 m treeline. At 68 m away it fills the
 * frame from the waterline up, so turning around shows the pedestal and the
 * long fall of the drapery; the head and the spread wings are one look up.
 *
 * The back faces away from the sun and this is a dusk, so the two lifts below
 * are what keep it from being a hole cut in the haze:
 *
 *   ENV_INTENSITY   how much of the baked sky the bronze picks up
 *   COLOUR_LIFT     how far off black the shaded side sits
 *
 * `castShadow` is off on purpose. At the sun's 22 degrees a shadow from 80 m
 * of statue lands ~200 m up-sun -- past the far side of the terrain, where
 * there is nothing to receive it -- and the shadow camera only covers the
 * creek anyway. What it would buy is a 34k-triangle depth pass per frame.
 */

const ENV_INTENSITY = 1.25;

// warm the shaded side: the material is bronze, and the only fill it gets back
// there is blue-ish hemisphere and sky
const COLOUR_LIFT = [1.2, 1.12, 1.0];

// The haze at 68 m is 64% of the final pixel, which turns an 80 m statue into a
// cloud. Scaling the statue's own fog depth keeps a trace of the veil -- it
// still sits in the world -- while leaving the shaded bronze to read as a
// silhouette. 0.22 puts it at about 20% fogged instead of 64%.
const FOG_SCALE = 0.22;

export default {
  id: 'angel',
  name: 'Angel of Justice',

  model: new URL('./model.glb', import.meta.url),

  credit: {
    work: 'Angel of Justice',
    by: 'João Lacerda (panc0)',
    licence: 'CC BY 4.0',
    via: 'Sketchfab',
    url: 'https://sketchfab.com/3d-models/angel-of-justice-0c6ea584860a42a2aa25015a86dab881',
  },

  // 80 m to the wing tips; the crown is at 68 m. See the note above on why the
  // whole asset, not `measure`, is the subject.
  size: 80,

  // 68 m behind the opening camera at (-18, 2, -4.6), up the valley from it. A
  // drag of about 980 px is a full 180 degrees and lands it in frame, a little
  // left of centre; another short drag centres it. y is the model's centre: its
  // feet lie 40 m below it, so 32 puts the base 8 m under the waterline -- below
  // the sightline that grazes the upstream bank, which is what cuts the pedestal
  // off instead of letting it hang in the haze.
  at: [-86, 32, -8],
  face: -90,

  // outside the terrain, so the height sampler cannot answer for the ground
  // here -- the base height is given in `at` instead
  grounded: false,

  castShadow: false,
  receiveShadow: false,

  setup({ object }) {
    object.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of [].concat(o.material)) {
        if (!m) continue;
        m.envMapIntensity = ENV_INTENSITY;
        if (m.map) m.color.setRGB(COLOUR_LIFT[0], COLOUR_LIFT[1], COLOUR_LIFT[2]);

        // the scene's fog, at 22% depth. Same maths as three.js's own
        // FogExp2 chunk, with the distance scaled at the end.
        m.onBeforeCompile = (shader) => {
          shader.uniforms.uAngelFogScale = { value: FOG_SCALE };
          shader.fragmentShader = shader.fragmentShader
            .replace(
              '#include <fog_pars_fragment>',
              '#include <fog_pars_fragment>\nuniform float uAngelFogScale;',
            )
            .replace(
              '#include <fog_fragment>',
              `#ifdef USE_FOG
                float angelFog = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth * uAngelFogScale);
                gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, angelFog);
              #endif`,
            );
        };
        m.needsUpdate = true;
      }
    });
  },
};
