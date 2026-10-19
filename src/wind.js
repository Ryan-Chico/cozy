/**
 * wind.js — the breeze that stops the scene being a statue.
 *
 * Blender ships the foliage as static geometry, so the motion lives here, the
 * same way the water, the fireflies and the toad do.
 *
 * The whole trick is the mask. A uniform push just slides grass across the
 * ground; what sells it is a per-vertex weight that is 0 at the root and 1 at
 * the tip, so a blade bends from where it is planted. The terrain heightmap
 * hands us the pivot for free — height above the ground over a per-species
 * reference height — and baking that weight into a vertex attribute also means
 * one shared material can serve every swaying mesh, because the per-species
 * reach rides along inside the weight itself.
 *
 * Two things worth knowing before touching this:
 *
 *   - Every creek mesh exports with an identity transform (checked against the
 *     GLB's node table), so object space *is* world space and the shader can
 *     push `transformed` directly instead of hauling a matrix in. If the build
 *     ever starts emitting real node transforms, this is the thing that breaks.
 *   - `patch()` chains onto whatever `onBeforeCompile` is already there, and it
 *     runs the wind first. That ordering is load-bearing: the surface-detail
 *     patch in main.js samples its grain from world position, so it has to read
 *     the *un-bent* vertex. Swap the two and the fine grain will shimmer as the
 *     foliage moves.
 */

import * as THREE from 'three';

/**
 * Per species: the height over which a plant reaches full sway, the curve on
 * that ramp, and how far the tip actually travels, in metres.
 *
 * The tree row is the one that matters. The trunk has to stay planted while the
 * canopy leans, and the ramp has to run the full height of the tree rather than
 * saturating at canopy level — weights that flatten out up there make the
 * canopy slide off the trunk as one rigid lump instead of bending.
 */
export const SWAY_TYPES = {
  Grass: { ref: 0.55, exponent: 1.0, reach: 0.160 },
  Reeds: { ref: 1.20, exponent: 1.0, reach: 0.280 },
  Ferns: { ref: 0.90, exponent: 1.0, reach: 0.180 },
  Bushes: { ref: 1.10, exponent: 1.6, reach: 0.120 },
  Trees: { ref: 8.00, exponent: 2.0, reach: 0.500 },
  // lilies float, so there is no root to bend from: their whole pad drifts.
  // Keep this small or they read as sliding across the water.
  Lilies: { ref: 1.00, exponent: 1.0, reach: 0.040 },
};

const DECLARATIONS = /* glsl */ `
  attribute float aSway;
  uniform float uWindTime;
  uniform vec2 uWindDir;
  uniform float uWindStrength;
`;

const DISPLACE = /* glsl */ `
  {
    // object space is world space here, so \`transformed\` is already in the
    // frame the gust field wants

    // a slow front rolling down the creek: two crossing waves beat against each
    // other at a walking pace, then get eased so the peaks swell instead of
    // switching on and off. A plain square here spends most of its time in a
    // lull, which reads as a still scene rather than a breezy one.
    float gust = sin(transformed.x * 0.085 - uWindTime * 0.62)
               * sin(transformed.z * 0.13 + uWindTime * 0.31 + 1.7);
    gust = 0.5 + 0.5 * gust;
    gust = gust * gust * (3.0 - 2.0 * gust);

    // and a quick local flutter, phased off world position so neighbouring
    // blades move out of step instead of as one sheet. Not too quick: it is the
    // only term the tree canopies get, and anything faster turns them twitchy.
    float flutter = 0.5 + 0.5 * sin(uWindTime * 1.7 + transformed.x * 1.9 + transformed.z * 1.4);

    float amp = aSway * uWindStrength * (0.35 + 0.76 * gust + 0.24 * flutter);

    // let the direction wander, or it reads as a metronome
    float swing = sin(uWindTime * 0.19 + transformed.x * 0.02) * 0.5;
    float cs = cos(swing);
    float sn = sin(swing);
    vec2 dir = vec2(uWindDir.x * cs - uWindDir.y * sn,
                    uWindDir.x * sn + uWindDir.y * cs);

    transformed.x += dir.x * amp;
    transformed.z += dir.y * amp;
    // dip as it pushes, so a blade bends instead of sliding sideways
    transformed.y -= amp * 0.35;
  }
`;

/**
 * Bake the sway weight for one mesh, in place.
 *
 * `groundAt(x, z)` must be the terrain height under the vertex; that is what
 * turns "height above sea level" into "height above the root", which is the
 * difference between grass on the low bank moving and grass up the slope
 * doing all of it.
 *
 * Returns the peak displacement so callers can sanity-check it.
 */
export function bakeSway(mesh, spec, groundAt) {
  const pos = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
  if (!pos) return 0;

  const count = pos.count;
  const sway = new Float32Array(count);
  let peak = 0;

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);

    const base = groundAt ? groundAt(x, z) : 0;
    let w = (y - base) / spec.ref;
    w = w < 0 ? 0 : (w > 1 ? 1 : w);
    if (spec.exponent !== 1) w = Math.pow(w, spec.exponent);

    sway[i] = w * spec.reach;
    if (sway[i] > peak) peak = sway[i];
  }

  mesh.geometry.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
  return peak;
}

/**
 * The shared wind: one set of uniforms, one patcher, and a matching depth
 * material so the shadows of swaying things sway with them.
 */
export function createWind({ strength = 1, reducedMotion = false } = {}) {
  const uniforms = {
    uWindTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.94, 0.34).normalize() },
    // reduced motion damps rather than kills it: the scene shouldn't look
    // frozen, but nothing should visibly sweep
    uWindStrength: { value: reducedMotion ? strength * 0.25 : strength },
  };

  const patched = new WeakSet();

  const inject = (shader) => {
    shader.uniforms.uWindTime = uniforms.uWindTime;
    shader.uniforms.uWindDir = uniforms.uWindDir;
    shader.uniforms.uWindStrength = uniforms.uWindStrength;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + DECLARATIONS)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + DISPLACE);
  };

  /**
   * Install the displacement on any material whose geometry carries `aSway`.
   * Safe to call on a material that is already patched by something else.
   */
  function patch(material) {
    if (!material || patched.has(material)) return material;
    patched.add(material);

    const previous = material.onBeforeCompile;
    material.onBeforeCompile = function (shader, renderer) {
      // wind first, so the other patch sees the un-displaced vertex
      inject(shader);
      if (previous) previous.call(this, shader, renderer);
    };
    return material;
  }

  // Bushes and Trees cast shadows, and onBeforeCompile never reaches the shadow
  // depth pass — without this their shadows would stay rigid while the geometry
  // above them moved.
  const depthMaterial = patch(
    new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }),
  );

  return {
    uniforms,
    depthMaterial,
    patch,
    update(elapsed) {
      uniforms.uWindTime.value = elapsed;
    },
  };
}
