/**
 * water.js — the creek surface.
 *
 * The Blender export gives us a flat ribbon of geometry following the channel,
 * with three numbers baked into COLOR_0 per vertex:
 *
 *   r = depth      (0 at the waterline, 1 where the creek is deepest)
 *   g = shore      (1 in the shallows, 0 out in the deep water)
 *   b = flow       (a slow noise, used to vary the current)
 *
 * We swap Blender's placeholder material for this shader. All the motion —
 * waves, glints, foam, and the rings the pointer sends out — is computed here,
 * which is why the water is a shader instead of baked into the model.
 */

import * as THREE from 'three';

export const WATER_COLORS = {
  shallow: new THREE.Color('#5f9479'),
  deep: new THREE.Color('#113638'),
  bed: new THREE.Color('#8a7857'),
  sky: new THREE.Color('#638cb2'),
  horizon: new THREE.Color('#bfab89'),
  foam: new THREE.Color('#e8f1ee'),
  sun: new THREE.Color('#ffd6a0'),
};

export function createWaterMaterial({ fogColor, fogDensity, sunDirection }) {
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: sunDirection.clone().normalize() },
    uSunColor: { value: WATER_COLORS.sun.clone() },
    uShallow: { value: WATER_COLORS.shallow.clone() },
    uDeep: { value: WATER_COLORS.deep.clone() },
    uBed: { value: WATER_COLORS.bed.clone() },
    uSky: { value: WATER_COLORS.sky.clone() },
    uHorizon: { value: WATER_COLORS.horizon.clone() },
    uFoam: { value: WATER_COLORS.foam.clone() },

    uRipple: { value: null },
    uRippleTexel: { value: new THREE.Vector2(1 / 512, 1 / 256) },
    uRippleOrigin: { value: new THREE.Vector2(0, 0) },   // world xz at uv 0,0
    uRippleScale: { value: new THREE.Vector2(1, 1) },    // world size of the field
    uRippleStrength: { value: 0.26 },

    uFogColor: { value: new THREE.Color(fogColor) },
    uFogDensity: { value: fogDensity },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide,
    vertexShader: /* glsl */ `
      attribute vec3 aData;              // depth, shore, flow

      uniform float uTime;
      uniform sampler2D uRipple;
      uniform vec2 uRippleTexel;
      uniform vec2 uRippleOrigin;
      uniform vec2 uRippleScale;
      uniform float uRippleStrength;

      varying vec3 vWorld;
      varying vec3 vData;
      varying float vViewDepth;
      varying vec3 vNormal;

      // layered travelling waves: returns height, fills deriv with d/dx and d/dz
      float waves(vec2 p, float t, out vec2 deriv) {
        deriv = vec2(0.0);
        float h = 0.0;
        //        dir             freq   amp     speed
        const int N = 5;
        vec2 dirs[5];
        dirs[0] = vec2( 1.00,  0.10); // downstream swell, long and slow
        dirs[1] = vec2( 0.88, -0.47);
        dirs[2] = vec2( 0.62,  0.78);
        dirs[3] = vec2( 1.00, -0.22);
        dirs[4] = vec2( 0.35,  0.94); // cross-chop
        float freq[5];
        freq[0] = 1.05; freq[1] = 2.30; freq[2] = 3.70; freq[3] = 6.10; freq[4] = 8.90;
        float amp[5];
        amp[0] = 0.0195; amp[1] = 0.0105; amp[2] = 0.0060; amp[3] = 0.0038; amp[4] = 0.0024;
        float spd[5];
        spd[0] = 1.30; spd[1] = 2.10; spd[2] = 2.90; spd[3] = 4.20; spd[4] = 5.30;

        for (int i = 0; i < N; i++) {
          vec2 d = normalize(dirs[i]);
          float phase = dot(p, d) * freq[i] + t * spd[i];
          float s = sin(phase);
          float c = cos(phase);
          h += s * amp[i];
          deriv += d * (c * amp[i] * freq[i]);
        }
        return h;
      }

      float rippleAt(vec2 world, vec2 offset) {
        vec2 uv = (world - uRippleOrigin) / uRippleScale;
        uv += offset * uRippleTexel;
        // fade the field out near its border so the edges never show
        vec2 e = smoothstep(vec2(0.0), vec2(0.045), uv) *
                 smoothstep(vec2(0.0), vec2(0.045), 1.0 - uv);
        return texture2D(uRipple, clamp(uv, 0.0, 1.0)).r * e.x * e.y;
      }

      void main() {
        vData = aData;

        vec4 world = modelMatrix * vec4(position, 1.0);
        vec2 p = world.xz;

        // the current runs along +x, and the banks calm it near the edges
        float calm = smoothstep(0.0, 0.35, 1.0 - vData.g);

        vec2 deriv;
        float h = waves(p, uTime, deriv) * calm;

        float rl = rippleAt(p, vec2(-1.0,  0.0));
        float rr = rippleAt(p, vec2( 1.0,  0.0));
        float rd = rippleAt(p, vec2( 0.0, -1.0));
        float ru = rippleAt(p, vec2( 0.0,  1.0));
        float rc = rippleAt(p, vec2( 0.0,  0.0));

        float texelWorldX = uRippleScale.x * uRippleTexel.x;
        float texelWorldZ = uRippleScale.y * uRippleTexel.y;
        vec2 rippleGrad = vec2((rr - rl) / max(texelWorldX, 1e-4),
                               (ru - rd) / max(texelWorldZ, 1e-4));

        world.y += h + (rc - (rl + rr + rd + ru) * 0.25) * 0.55 * calm;

        vNormal = normalize(vec3(-deriv.x, 1.0, -deriv.y));
        vNormal.xz += rippleGrad * uRippleStrength;
        vNormal = normalize(vNormal);

        vWorld = world.xyz;

        vec4 mv = viewMatrix * world;
        vViewDepth = -mv.z;

        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uBed;
      uniform vec3 uSky;
      uniform vec3 uHorizon;
      uniform vec3 uFoam;
      uniform vec3 uFogColor;
      uniform float uFogDensity;

      varying vec3 vWorld;
      varying vec3 vData;
      varying float vViewDepth;
      varying vec3 vNormal;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i), b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      void main() {
        float depth = clamp(vData.r, 0.0, 1.0);
        float shore = clamp(vData.g, 0.0, 1.0);

        vec3 N = vNormal;
        vec3 V = normalize(cameraPosition - vWorld);

        // ---- body colour: sandy where it's shallow, green-dark where it pools
        vec3 col = mix(uShallow, uDeep, smoothstep(0.04, 0.60, depth));
        col = mix(uBed, col, smoothstep(0.0, 0.16, depth));

        // ---- reflection: fresnel against a simple sky gradient
        float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 4.0);
        vec3 R = reflect(-V, N);
        vec3 sky = mix(uHorizon, uSky, clamp(R.y * 1.6 + 0.12, 0.0, 1.0));
        col = mix(col, sky, clamp(fres * 0.55, 0.0, 0.55));

        // ---- sun: a tight glint plus a broad sheen
        vec3 H = normalize(uSunDir + V);
        float ndh = clamp(dot(N, H), 0.0, 1.0);
        col += uSunColor * pow(ndh, 260.0) * 2.0;
        col += uSunColor * pow(ndh, 22.0) * 0.06;

        // ---- foam along the stones and the edges
        float wob = vnoise(vWorld.xz * 2.6 + vec2(uTime * 0.55, -uTime * 0.32));
        float edge = smoothstep(0.42, 0.98, shore);
        float foam = edge * (0.35 + 0.65 * wob);
        foam *= 0.55 + 0.45 * sin(uTime * 1.7 + shore * 26.0 + wob * 6.0);
        col = mix(col, uFoam, clamp(foam * 0.42, 0.0, 0.60));

        float alpha = mix(0.52, 1.0, smoothstep(0.02, 0.30, depth));
        alpha = max(alpha, foam * 0.5);

        // ---- exp2 fog, matched to the scene's
        float f = 1.0 - exp(-uFogDensity * uFogDensity * vViewDepth * vViewDepth);
        col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

        // linear output: the composer's OutputPass handles tone mapping + sRGB
        gl_FragColor = vec4(col, alpha);
      }
    `,
  });

  return material;
}
