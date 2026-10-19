/**
 * The raid boss, standing in the creek.
 *
 * "Raid Boss Shogun" by zeroswat, CC BY 4.0, via Sketchfab. The download is a
 * Gundam-scale mecha in a wide planted stance, holding a gun that is nearly as
 * tall as it is. blender/build_shogun.py strips the author's baked-in slash card
 * and smoke puffs, flattens the Sketchfab wrappers, fixes the materials and
 * decimates it; what is left is 103k triangles and 3.8 MB.
 *
 * Two things about the asset matter when placing it.
 *
 * Its longest axis is not its height. The gun reaches 7.33 m front-to-back
 * against a 5.42 m standing height, so `size` measures the reach rather than
 * the machine: at 13 m the mecha itself stands about 9.6 m, which is a head
 * above the tallest tree and roughly seven toads. Shrinking the spec to the
 * height instead would put it under the treeline and lose the point.
 *
 * It faces three.js +Z at `face: 0`. A yaw of -80 turns its chest towards the
 * opening camera and leaves the gun pointing across the channel, which is what
 * makes the silhouette read from the hero shot rather than edge-on.
 */

const ENV_INTENSITY = 1.12;
const COLOUR_LIFT = [1.16, 1.12, 1.05];
const GLOW_BOOST = 1.25;

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

  // At x = 18 the channel is about 10.8 m wide and 1.4 m deep, so `grounded`
  // puts its feet on the bed with the water at mid-shin. The camera is then
  // 36 m away, where the opening shot's fifteen degrees of sky allow a top at
  // roughly 11.8 m: 9.6 m of machine clears it with the treeline behind.
  size: 13,
  at: [18, 0, 0],
  face: -80,
  grounded: true,

  castShadow: true,
  receiveShadow: true,

  setup({ object }) {
    object.traverse((o) => {
      if (!o.isMesh) return;

      const materials = Array.isArray(o.material) ? o.material : [o.material];
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
