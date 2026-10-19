/**
 * fireflies.js — warm blinking motes drifting over the creek.
 *
 * One THREE.Points draw call. The wander, the blink and the pull toward the
 * pointer all happen in the vertex shader, so the CPU only ever updates a
 * couple of uniforms.
 */

import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aScale;
  attribute float aPhase;

  uniform float uTime;
  uniform vec3  uPointer;
  uniform float uAttract;
  uniform float uSize;

  varying float vAlpha;
  varying float vWarm;

  void main() {
    vec3 p = position;
    float t = uTime;

    // two octaves of slow drift, per-firefly offset
    p.x += sin(t * 0.23 + aSeed * 6.3) * 0.55 + sin(t * 0.51 + aSeed * 2.1) * 0.18;
    p.y += sin(t * 0.31 + aSeed * 4.7) * 0.20 + sin(t * 0.73 + aSeed * 1.3) * 0.06;
    p.z += cos(t * 0.19 + aSeed * 5.1) * 0.55 + cos(t * 0.43 + aSeed * 3.7) * 0.18;

    // let them come closer when the pointer is near
    vec3 toPointer = uPointer - p;
    float d = length(toPointer);
    float pull = smoothstep(7.0, 0.0, d) * uAttract;
    p += normalize(toPointer + 1e-4) * pull;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aScale * uSize * (46.0 / max(-mv.z, 0.6));
    gl_PointSize = min(gl_PointSize, 22.0);

    // a slow blink, brighter at the peak of each pulse
    float pulse = sin(t * 1.7 + aPhase * 6.283) * 0.5 + 0.5;
    vAlpha = pow(pulse, 2.4) * (0.5 + 0.5 * (sin(t * 0.9 + aPhase * 3.1) * 0.5 + 0.5));
    vWarm = fract(aSeed * 7.13);
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uIntensity;

  varying float vAlpha;
  varying float vWarm;

  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float a = exp(-r * r * 9.0);
    a *= a;
    vec3 c = mix(uColorA, uColorB, vWarm);
    gl_FragColor = vec4(c * a * vAlpha * uIntensity, a * vAlpha);
  }
`;

export function createFireflies({ count = 110, origin, spread, fogColor }) {
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);
  const phases = new Float32Array(count);

  let s = 9871.0;
  const rand = () => {
    s = (s * 16807.0) % 2147483647.0;
    return s / 2147483647.0;
  };

  for (let i = 0; i < count; i++) {
    // clustered over the water and the low banks, not up in the canopy
    const t = rand();
    const side = rand() < 0.5 ? -1 : 1;
    positions[i * 3 + 0] = origin.x + (t - 0.5) * spread.x;
    positions[i * 3 + 1] = 0.25 + Math.pow(rand(), 1.7) * 3.4;
    positions[i * 3 + 2] = origin.y + side * Math.pow(rand(), 1.4) * spread.y;

    seeds[i] = rand() * 10.0;
    scales[i] = 0.55 + rand() * 1.1;
    phases[i] = rand();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPointer: { value: new THREE.Vector3(0, 1.2, 0) },
      uAttract: { value: 0 },
      uSize: { value: 7.5 },
      uColorA: { value: new THREE.Color('#ffc65e') },
      uColorB: { value: new THREE.Color('#fff0a8') },
      uIntensity: { value: 1.7 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  void fogColor;

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.name = 'Fireflies';
  return points;
}
