/**
 * fireflies.js — warm blinking motes drifting over the creek.
 *
 * One THREE.Points draw call. The wander, the blink and the pull toward the
 * pointer all happen in the vertex shader, so the CPU only ever updates a
 * couple of uniforms.
 *
 * The one thing that breaks that clean split is the toad, which wants to eat
 * one. It can't see a vertex shader's output, so `positionAt()` mirrors the
 * drift on the CPU — the motion is closed-form, so both sides can agree
 * exactly. The numbers live in DRIFT and get interpolated into the GLSL, which
 * means a retune can only ever break the *shape* of the motion. If you change
 * that shape, change positionAt to match, or the toad will snap at empty water.
 *
 * Eating is handled with a single `aEatAt` attribute. Writing one element and
 * re-uploading the array is cheap at this size, and it keeps the whole
 * lifecycle — drag into the mouth, lie low, drift back — inside the shader.
 */

import * as THREE from 'three';

/**
 * The drift field: two octaves per axis, each `fn(t * freq + seed * phase) * amp`.
 * Both the GLSL below and positionAt() iterate this, so the two can't disagree
 * about the numbers.
 */
const DRIFT = {
  x: { fn: 'sin', octaves: [[0.23, 6.3, 0.55], [0.51, 2.1, 0.18]] },
  y: { fn: 'sin', octaves: [[0.31, 4.7, 0.20], [0.73, 1.3, 0.06]] },
  z: { fn: 'cos', octaves: [[0.19, 5.1, 0.55], [0.43, 3.7, 0.18]] },
};

/** Seconds from the strike until the firefly is swallowed. */
const EAT_DRAG = 0.35;
/** How long it stays gone before drifting back in. */
const EAT_GONE = 24.0;
/** And how long that return takes. */
const EAT_FADE = 2.5;

const driftLines = (axis) => DRIFT[axis].octaves
  .map(([f, s, a]) => `p.${axis} += ${DRIFT[axis].fn}(t * ${glf(f)} + aSeed * ${glf(s)}) * ${glf(a)};`)
  .join('\n    ');

/**
 * GLSL has no implicit int-to-float: `${24.0}` renders as `24`, which the
 * compiler reads as an int and refuses. Force the decimal point.
 */
const glf = (n) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

const VERT = /* glsl */ `
  attribute float aSeed;
  attribute float aScale;
  attribute float aPhase;
  attribute float aEatAt;

  uniform float uTime;
  uniform vec3  uPointer;
  uniform float uAttract;
  uniform float uSize;
  uniform vec3  uEatTarget;

  varying float vAlpha;
  varying float vWarm;

  void main() {
    vec3 p = position;
    float t = uTime;

    // two octaves of slow drift, per-firefly offset
    ${driftLines('x')}
    ${driftLines('y')}
    ${driftLines('z')}

    // let them come closer when the pointer is near
    vec3 toPointer = uPointer - p;
    float d = length(toPointer);
    float pull = smoothstep(7.0, 0.0, d) * uAttract;
    p += normalize(toPointer + 1e-4) * pull;

    // if this one has been caught, haul it into the mouth and put it away
    float fade = 1.0;
    float since = aEatAt < 0.0 ? -1.0 : t - aEatAt;
    if (since >= 0.0) {
      if (since < ${glf(EAT_DRAG)}) {
        float e = since / ${glf(EAT_DRAG)};
        p = mix(p, uEatTarget, e * e);          // yanked, not eased
        fade = 1.0 - smoothstep(0.5, 1.0, e);
      } else if (since < ${glf(EAT_GONE)}) {
        fade = 0.0;
      } else {
        fade = smoothstep(${glf(EAT_GONE)}, ${glf(EAT_GONE + EAT_FADE)}, since);
      }
    }

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aScale * uSize * (46.0 / max(-mv.z, 0.6));
    gl_PointSize = min(gl_PointSize, 22.0);

    // a slow blink, brighter at the peak of each pulse
    float pulse = sin(t * 1.7 + aPhase * 6.283) * 0.5 + 0.5;
    vAlpha = pow(pulse, 2.4) * (0.5 + 0.5 * (sin(t * 0.9 + aPhase * 3.1) * 0.5 + 0.5)) * fade;
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
  const base = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const scales = new Float32Array(count);
  const phases = new Float32Array(count);
  const eatAt = new Float32Array(count).fill(-1);

  let s = 9871.0;
  const rand = () => {
    s = (s * 16807.0) % 2147483647.0;
    return s / 2147483647.0;
  };

  for (let i = 0; i < count; i++) {
    // clustered over the water and the low banks, not up in the canopy
    const t = rand();
    const side = rand() < 0.5 ? -1 : 1;
    base[i * 3 + 0] = origin.x + (t - 0.5) * spread.x;
    base[i * 3 + 1] = 0.25 + Math.pow(rand(), 1.7) * 3.4;
    base[i * 3 + 2] = origin.y + side * Math.pow(rand(), 1.4) * spread.y;

    seeds[i] = rand() * 10.0;
    scales[i] = 0.55 + rand() * 1.1;
    phases[i] = rand();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(base, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  geo.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  const eatAttr = new THREE.BufferAttribute(eatAt, 1);
  geo.setAttribute('aEatAt', eatAttr);

  const uniforms = {
    uTime: { value: 0 },
    uPointer: { value: new THREE.Vector3(0, 1.2, 0) },
    uAttract: { value: 0 },
    uSize: { value: 7.5 },
    uColorA: { value: new THREE.Color('#ffc65e') },
    uColorB: { value: new THREE.Color('#fff0a8') },
    uIntensity: { value: 1.7 },
    uEatTarget: { value: new THREE.Vector3() },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
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

  // ---- the CPU's view of the swarm ---------------------------------------

  const toPointer = new THREE.Vector3();
  let lastEatAt = -Infinity;

  /**
   * Where firefly `i` actually is this instant, to the same precision the
   * shader uses. Reads the live uniforms rather than taking them as arguments,
   * so it is impossible to check the swarm against a stale time or pointer.
   */
  function positionAt(i, out) {
    const t = uniforms.uTime.value;
    const seed = seeds[i];

    out.set(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
    for (const axis of ['x', 'y', 'z']) {
      const { fn, octaves } = DRIFT[axis];
      let v = out[axis];
      for (const [freq, phase, amp] of octaves) {
        v += Math[fn](t * freq + seed * phase) * amp;
      }
      out[axis] = v;
    }

    // the same pointer pull, mirrored. GLSL's smoothstep(7.0, 0.0, d) is 1 at
    // the pointer and eases to 0 by 7 m; three's MathUtils.smoothstep assumes
    // min < max and would invert that, so the arithmetic is done out here.
    toPointer.copy(uniforms.uPointer.value).sub(out).addScalar(1e-4).normalize();
    const d = out.distanceTo(uniforms.uPointer.value);
    const k = THREE.MathUtils.clamp((d - 7) / -7, 0, 1);
    out.addScaledVector(toPointer, k * k * (3 - 2 * k) * uniforms.uAttract.value);

    // a caught one is being hauled into the mouth; mirror that too, so nothing
    // aims at where it used to be
    const since = eatAt[i] < 0 ? -1 : t - eatAt[i];
    if (since >= 0 && since < EAT_DRAG) {
      const e = since / EAT_DRAG;
      out.lerp(uniforms.uEatTarget.value, e * e);       // yanked, not eased
    }

    return out;
  }

  /**
   * Is `i` out there to be caught? A fly on its way into the mouth, or sitting
   * in the toad's belly, is invisible in the shader — nothing should aim at it.
   */
  function isFlying(i) {
    const at = eatAt[i];
    return at < 0 || uniforms.uTime.value - at >= EAT_GONE;
  }

  /**
   * Send firefly `i` into the mouth at `target` (world space). Refuses if one
   * is already on its way: they all share a single uEatTarget, so a second
   * strike mid-flight would drag the first one off course.
   */
  function eat(i, target) {
    if (!(i >= 0 && i < count)) return false;
    const t = uniforms.uTime.value;
    if (t - lastEatAt < EAT_DRAG) return false;

    eatAt[i] = t;
    eatAttr.needsUpdate = true;
    uniforms.uEatTarget.value.copy(target);
    lastEatAt = t;
    return true;
  }

  return { points, material, uniforms, count, positionAt, isFlying, eat };
}
