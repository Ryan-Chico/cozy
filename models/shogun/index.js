/**
 * The raid boss, standing in the creek.
 *
 * "Raid Boss Shogun" by zeroswat, CC BY 4.0, via Sketchfab. The download is a
 * Gundam-scale mecha in a wide planted stance, holding a gun that is nearly as
 * tall as it is. blender/build_shogun.py strips the author's two smoke puffs,
 * flattens the Sketchfab wrappers, fixes the materials and decimates it; what
 * is left is 103k triangles and 3.8 MB. The red blade stays: the script bakes
 * its alpha card into a grayscale emissive map, and the setup below tints it
 * red and adds it over the scene.
 *
 * Three things about the asset matter when placing it.
 *
 * Its longest axis is not its height. The gun reaches 7.33 m front-to-back
 * against a 5.42 m standing height, and `measure` names the gun so `size` still
 * measures the weapon's reach rather than the machine — without it the blade's
 * extra reach would shrink the mecha from 9.6 m to about 7.6 m. At 13 m the
 * machine itself stands about 9.6 m, which is a head above the tallest tree and
 * roughly seven toads. Shrinking the spec to the height instead would put it
 * under the treeline and lose the point.
 *
 * The blade belongs to the other weapon. The machine holds the gun in one hand
 * and a smaller sword in the other, and the red card is that sword's beam: it
 * leaves the sword's emitter and sprays down and out past the machine's side.
 * The build bakes the Sketchfab node's own matrix into it, so it stays on that
 * emitter instead of floating beside the shoulder. `face: -70` turns it
 * further to its right: the chest squares to the camera and the beam swings
 * clear of the hip to lie across the near water, the gun across the channel.
 */

const ENV_INTENSITY = 1.12;
const COLOUR_LIFT = [1.16, 1.12, 1.05];
const GLOW_BOOST = 1.25;

// the blade's own linear emission and card opacity, both from the Blender
// material before its alpha was baked away. It is a light source, so it is
// kept out of the fog and pushed past the general glow boost: at 36 m the haze
// otherwise turns a red beam into a pink smudge.
const BLADE_COLOUR = [1.0, 0.064, 0.08];
const BLADE_OPACITY = 0.95;
const BLADE_GLOW = 2.2;

export default {
  id: 'shogun',
  name: 'Shogun',

  model: new URL('./model.glb', import.meta.url),

  credit: {
    work: 'Raid Boss Shogun',
    by: 'zeroswat',
    licence: 'CC BY 4.0',
    via: 'Sketchfab',
    url: 'https://sketchfab.com/3d-models/raid-boss-shogun-8700d16e247d4a51956ef904643b95fa',
  },

  // At x = 18 the channel is about 10.8 m wide and 1.5 m deep. `grounded`
  // anchors whatever `measure` names, and here that is the gun: at this scale
  // the weapon hangs 1.4 m above the feet, so left alone the feet would stand
  // 1.4 m inside the bed. The 1.5 m of `at` gives that back; the extra 0.6 m
  // lifts the whole red card clear of the near bank, where at the waterline it
  // read as a pink smudge. The feet stay under the surface. The camera is then
  // 36 m away, where the opening shot's fifteen degrees of sky allow a top at
  // roughly 11.8 m: 9.6 m of machine clears it with the treeline behind.
  size: 13,
  measure: 'Gun_Sword002',   // three.js strips the space and dot from "Gun Sword.002"
  at: [18, 2.1, 0],
  face: -70,
  grounded: true,

  castShadow: true,
  receiveShadow: true,

  setup({ object }) {
    object.traverse((o) => {
      if (!o.isMesh) return;

      const materials = Array.isArray(o.material) ? o.material : [o.material];

      // The blade is a flat emissive card, not a lit surface. Add it over the
      // scene so the black around the mask disappears, keep it out of the
      // shadow map or its rectangle lands on the water, and give it back the
      // red the JPEG could not carry.
      if (o.name === 'Blade') {
        o.castShadow = false;
        o.receiveShadow = false;
        for (const m of materials) {
          if (!m) continue;
          m.transparent = true;
          m.blending = 2;   // THREE.AdditiveBlending
          m.depthWrite = false;
          m.side = 2;       // THREE.DoubleSide
          m.fog = false;    // the beam is the light, not the haze
          m.toneMapped = false;
          m.color.setRGB(0, 0, 0);
          if (m.emissive) m.emissive.setRGB(BLADE_COLOUR[0], BLADE_COLOUR[1], BLADE_COLOUR[2]);
          m.emissiveIntensity = BLADE_GLOW;
          m.opacity = BLADE_OPACITY;
        }
        return;
      }

      for (const m of materials) {
        if (!m) continue;
        m.envMapIntensity = ENV_INTENSITY;

        // the armour and the gun carry their detail in the map; lifting the
        // factor keeps the rust from going to mud in this dusk
        if (m.map) m.color.setRGB(COLOUR_LIFT[0], COLOUR_LIFT[1], COLOUR_LIFT[2]);

        // the vents and sensors arrived emissive; give them a little more so
        // they survive the fog at 36 m
        if (m.emissive && m.emissive.getHex() !== 0) m.emissiveIntensity = GLOW_BOOST;
      }
    });
  },
};
