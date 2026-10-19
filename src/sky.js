/**
 * sky.js — a gradient sky with a soft sun, drawn on a big inside-out sphere.
 *
 * It doubles as the lighting environment: PMREMGenerator turns this exact sky
 * into an environment map, so the rocks and the banks pick up the same warm
 * bounce light that the sky shows behind them.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;

  varying vec3 vDir;

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;

    vec3 col = mix(uHorizon, uZenith, smoothstep(0.0, 0.62, h));
    col = mix(col, uGround, smoothstep(0.02, -0.30, h));

    // haze thickens towards the horizon, which is what sells the depth
    float haze = exp(-max(h, 0.0) * 6.0);
    col = mix(col, uHorizon * 0.92, haze * 0.35);

    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunColor * pow(sd, 350.0) * 4.0;     // the disc itself
    col += uSunColor * pow(sd, 6.0) * 0.22;      // the glow around it
    col += uSunColor * pow(sd, 1.5) * 0.05;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const SUN_DIRECTION = new THREE.Vector3(0.86, 0.34, 0.35).normalize();

export function createSky({ radius = 200, sunDirection } = {}) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color('#4f7db6') },
      uHorizon: { value: new THREE.Color('#d8c39c') },
      uGround: { value: new THREE.Color('#434b39') },
      uSunColor: { value: new THREE.Color('#ffcb8e') },
      uSunDir: { value: (sunDirection || SUN_DIRECTION).clone().normalize() },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 32), material);
  mesh.name = 'Sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/**
 * Bake the sky into an environment map so the PBR materials get sky light.
 * Returns the texture, or null if the generator failed for any reason.
 */
export function bakeEnvironment(renderer, sky) {
  let pmrem = null;
  try {
    pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();

    const tmp = new THREE.Scene();
    const clone = sky.clone();
    clone.material = sky.material;          // same uniforms, no extra compile
    tmp.add(clone);

    const rt = pmrem.fromScene(tmp, 0.02, 1, sky.geometry.parameters.radius * 1.5);
    tmp.remove(clone);
    return rt.texture;
  } catch (err) {
    console.warn('[creek] environment map skipped:', err);
    return null;
  } finally {
    if (pmrem) pmrem.dispose();
  }
}
