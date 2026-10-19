/**
 * main.js — a cozy creek.
 *
 * The terrain, rocks, log, reeds, trees and lantern were built procedurally in
 * Blender and exported to assets/creek.glb (see blender/build_creek.py).
 * Everything that moves — the water, the fireflies, the light — lives here.
 *
 * Blender is Z-up; glTF is Y-up, and the exporter maps (x, y, z) -> (x, z, -y).
 * So the camera position below is the Blender one with y and z swapped.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { createWaterMaterial } from './water.js';
import { createFireflies } from './fireflies.js';
import { createSky, bakeEnvironment } from './sky.js';
import { RippleSim } from './ripples.js';
import { createWalker } from './controls.js';
import { createMonster } from './monster.js';
import { createHunt } from './hunt.js';
import { createB17 } from './b17.js';
import { buildHeightSampler } from './heightmap.js';
import { bakeSway, createWind, SWAY_TYPES } from './wind.js';

// ---------------------------------------------------------------- the shot

// Blender preview camera was (-18.0, 4.6, 2.00) looking at (18.0, 1.5, 0.10)
const CAM_POS = new THREE.Vector3(-18.0, 2.00, -4.60);
const CAM_TARGET = new THREE.Vector3(18.0, 0.10, -1.50);
const CAM_FOV = 36;

// sun: 0deg is straight down the creek (+x), 90deg is towards +z (screen right)
const SUN_AZIMUTH = 210;
const SUN_ELEVATION = 22;

const FOG_COLOR = new THREE.Color('#c9bda4');
const FOG_DENSITY = 0.0148;

// cover the whole walkable corridor, not just the hero framing
const RIPPLE_ORIGIN = new THREE.Vector2(-32, -14);
const RIPPLE_SIZE = new THREE.Vector2(64, 28);
const RIPPLE_W = 768;
const RIPPLE_H = 384;

// stay a little inside the terrain edge so you never see the world end
const WALK_BOUNDS = { minX: -30, maxX: 30, minZ: -13, maxZ: 13 };

const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ setup

const canvas = document.getElementById('scene');
const loaderEl = document.getElementById('loader');
const barEl = document.querySelector('#bar i');
const overlayEl = document.getElementById('overlay');
const hintEl = document.getElementById('hint');
const roamHintEl = document.getElementById('roamHint');

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
  stencil: false,
});
const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 700;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, smallScreen ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.84;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoft was removed in r186

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY);

const camera = new THREE.PerspectiveCamera(CAM_FOV, window.innerWidth / window.innerHeight, 0.1, 600);
camera.position.copy(CAM_POS);
camera.lookAt(CAM_TARGET);

// ------------------------------------------------------------------ sun

const sunDir = new THREE.Vector3(
  Math.cos(THREE.MathUtils.degToRad(SUN_ELEVATION)) * Math.cos(THREE.MathUtils.degToRad(SUN_AZIMUTH)),
  Math.sin(THREE.MathUtils.degToRad(SUN_ELEVATION)),
  Math.cos(THREE.MathUtils.degToRad(SUN_ELEVATION)) * Math.sin(THREE.MathUtils.degToRad(SUN_AZIMUTH)),
).normalize();

const sun = new THREE.DirectionalLight('#ffd6a0', 1.95);
sun.position.copy(sunDir).multiplyScalar(70);
sun.castShadow = true;
sun.shadow.mapSize.set(smallScreen ? 1024 : 3072, smallScreen ? 1024 : 3072);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 180;
// wide enough to cover the whole walkable corridor from one static box, so
// shadows never have to chase the camera (which would pop on mode changes)
sun.shadow.camera.left = -42;
sun.shadow.camera.right = 42;
sun.shadow.camera.top = 34;
sun.shadow.camera.bottom = -34;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
scene.add(sun);
scene.add(sun.target);

// soft sky/ground fill so the shaded banks stay warm instead of going navy
const hemi = new THREE.HemisphereLight('#a6c2e0', '#4a5236', 0.62);
scene.add(hemi);

// a cool bounce from the camera side, keeps the shadow side from going flat
const fill = new THREE.DirectionalLight('#8fb0d0', 0.14);
fill.position.set(-30, 8, -14);
scene.add(fill);

// ------------------------------------------------------------------ sky

const sky = createSky({ sunDirection: sunDir });
scene.add(sky);

const envMap = bakeEnvironment(renderer, sky);
if (envMap) {
  scene.environment = envMap;
  scene.environmentIntensity = 0.38;
}

// ------------------------------------------------------------------ load

let water = null;         // the creek surface mesh
let waterMat = null;
let ripples = null;
let fireflies = null;
let lantern = null;
let walker = null;        // the camera rig: hero shot + walking
let terrain = null;       // the mesh the walker stands on
let monster = null;       // the toad in the shallows
let monsterGltf = null;   // its own download, arrives when it arrives
let hunt = null;          // its appetite
let b17 = null;           // the aircraft hanging over the creek
let ready = false;

// the breeze, and the mask that makes foliage bend from its roots rather than
// slide. Shared by every swaying mesh, so it is created once, up here.
const wind = createWind({ reducedMotion: REDUCED_MOTION });

/**
 * The Blender terrain is a smooth vertex-coloured sheet, which reads as flat
 * paint under a single key light. Rather than re-baking the model, break the
 * surface up in the shader: mottling plus a soft canopy dapple, both in world
 * space so every prop picks up the same grain.
 */
const patchedMaterials = new WeakSet();

function addSurfaceDetail(material) {
  if (!material || patchedMaterials.has(material)) return;
  patchedMaterials.add(material);

  const NOISE = /* glsl */ `
    varying vec3 vCreekPos;
    float creekHash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }
    float creekNoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(creekHash(i), creekHash(i + vec2(1.0, 0.0)), f.x),
                 mix(creekHash(i + vec2(0.0, 1.0)), creekHash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
  `;

  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCreekPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvCreekPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + NOISE)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // two broad octaves of mottling: moss, then bare patches.
          // Keep the frequencies low — a finer octave just reads as video static.
          float m1 = creekNoise(vCreekPos.xz * 0.34);
          float m2 = creekNoise(vCreekPos.xz * 1.15 + 17.0);
          float detail = (m1 - 0.5) * 0.34 + (m2 - 0.5) * 0.15;
          diffuseColor.rgb *= 1.0 + detail;

          // a finer grain, but only where it can be seen: close up it reads as
          // turf, and out in the haze it would just alias into static
          float close = 1.0 - smoothstep(2.5, 11.0, distance(vCreekPos, cameraPosition));
          if (close > 0.0) {
            float m3 = creekNoise(vCreekPos.xz * 3.7 + 5.0);
            float m4 = creekNoise(vCreekPos.xz * 8.3 - 11.0);
            diffuseColor.rgb *= 1.0 + ((m3 - 0.5) * 0.20 + (m4 - 0.5) * 0.11) * close;
          }

          // a slow dapple, as if the canopy above broke the light up
          float dap = creekNoise(vCreekPos.xz * 0.22 + 31.0);
          diffuseColor.rgb *= 0.84 + 0.34 * smoothstep(0.20, 0.86, dap);
        }`,
      );
  };
  material.needsUpdate = true;
}

const gltfLoader = new GLTFLoader();
const manager = new THREE.LoadingManager();

manager.onProgress = (_url, loaded, total) => {
  if (barEl) barEl.style.width = `${Math.round((loaded / Math.max(total, 1)) * 92)}%`;
};

manager.onLoad = () => {
  if (barEl) barEl.style.width = '100%';
};

gltfLoader.manager = manager;

/**
 * The toad needs both halves at once: its own model, and the terrain whose
 * heightmap it reads to find the waterline. Whichever of the two arrives
 * second is the one that builds it.
 */
function tryCreateMonster() {
  if (monster || !monsterGltf || !terrain) return;

  // the toad is a guest here: if anything about it fails, the creek must not
  // go down with it (this runs inside the creek's own load callback)
  try {
    monster = createMonster({
      gltf: monsterGltf,
      terrain,
      waterY: 0,        // the waterline itself; the walker's -0.05 is its own
      ripples,
      camera,
      reducedMotion: REDUCED_MOTION,
    });
    scene.add(monster.object);
    scene.add(monster.tongue);
    // the tongue is driven in world space, so it is a sibling of the toad
    // rather than a child of it
    if (fireflies) hunt = createHunt({ monster, fireflies, ripples });
    if (window.__creek) {
      window.__creek.monster = monster;
      window.__creek.hunt = hunt;
    }
  } catch (err) {
    console.warn('[creek] could not place the toad — the creek carries on without one', err);
    monster = null;
  }
}

gltfLoader.load(
  './assets/creek.glb',
  (gltf) => {
    const root = gltf.scene;

    // meshes from Blender carry a single material, but be safe about arrays
    const eachMaterial = (obj, fn) => {
      const m = obj.material;
      if (!m) return;
      if (Array.isArray(m)) m.forEach(fn);
      else fn(m);
    };

    root.traverse((obj) => {
      if (!obj.isMesh) return;
      const name = obj.name;

      // ---- the creek surface becomes our own shader
      if (name === 'Water') {
        water = obj;
        obj.material = waterMat = createWaterMaterial({
          fogColor: FOG_COLOR,
          fogDensity: FOG_DENSITY,
          sunDirection: sunDir,
        });
        // COLOR_0 carries (depth, shore, flow) from the Blender build
        const geo = obj.geometry;
        if (geo.attributes.color) {
          geo.setAttribute('aData', geo.attributes.color);
        } else {
          // no baked data: pretend it is a shallow, calm pool
          const n = geo.attributes.position.count;
          const fake = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) fake[i * 3] = 0.45;
          geo.setAttribute('aData', new THREE.BufferAttribute(fake, 3));
          console.warn('[creek] water had no COLOR_0; using a flat depth');
        }
        // draw the water before the additive fireflies, on top of the world
        obj.renderOrder = 1;
        obj.castShadow = false;
        obj.receiveShadow = false;
        return;
      }

      // ---- everything else just receives the sun
      const solid = ['Terrain', 'Rocks', 'Stones', 'Log', 'Trees', 'Bushes', 'Lanterns', 'Mushrooms'].includes(name);
      obj.castShadow = solid;
      obj.receiveShadow = true;

      if (name === 'Terrain') terrain = obj;

      eachMaterial(obj, (mat) => {
        mat.envMapIntensity = 0.6;
        if (name === 'LanternGlass') {
          lantern = obj;
          mat.emissiveIntensity = 6.0;
        }
        // foliage reads better lit from both sides
        if (['Grass', 'Reeds', 'Ferns', 'Lilies'].includes(name)) {
          mat.side = THREE.DoubleSide;
        }
        if (name !== 'LanternGlass') addSurfaceDetail(mat);
      });
    });

    // ---- the breeze
    // The foliage gets a clone of the nature material, so the wind code only
    // ever compiles for plants. Rocks, stones, the log and the mushrooms share
    // the original and stay perfectly still. (Every mesh here comes out of one
    // glTF material, so cloning the first is cloning them all.)
    const swaying = [];
    root.traverse((obj) => {
      if (obj.isMesh && SWAY_TYPES[obj.name] && obj.geometry.attributes.position) {
        swaying.push(obj);
      }
    });

    if (swaying.length) {
      const sampler = terrain ? buildHeightSampler(terrain) : null;
      const groundAt = sampler ? (x, z) => sampler.sample(x, z) : null;

      const windMat = swaying[0].material.clone();
      // a clone does not inherit onBeforeCompile, so the grain has to be put
      // back — and patch() chains in front of it, because the grain is sampled
      // from world position and must read the un-bent vertex
      addSurfaceDetail(windMat);
      wind.patch(windMat);

      const peaks = [];
      for (const mesh of swaying) {
        mesh.material = windMat;
        peaks.push(`${mesh.name} ${(bakeSway(mesh, SWAY_TYPES[mesh.name], groundAt) * 100).toFixed(1)}cm`);
        // only bushes and trees cast, and their shadows need the same
        // displacement or they stay rigid while the foliage above moves
        if (mesh.castShadow) mesh.customDepthMaterial = wind.depthMaterial;
      }
      console.info(`[creek] breeze — tip reach: ${peaks.join(', ')}`);
    }

    scene.add(root);

    // fireflies spread across the corridor you can now walk
    fireflies = createFireflies({
      count: smallScreen ? 90 : 140,
      origin: new THREE.Vector2(0, 0),
      spread: new THREE.Vector2(54, 13),
      fogColor: FOG_COLOR,
    });
    fireflies.points.renderOrder = 10;
    scene.add(fireflies.points);

    ripples = new RippleSim(renderer, {
      origin: RIPPLE_ORIGIN,
      size: RIPPLE_SIZE,
      width: RIPPLE_W,
      height: RIPPLE_H,
    });
    if (waterMat) {
      waterMat.uniforms.uRipple.value = ripples.texture;
      waterMat.uniforms.uRippleOrigin.value.copy(RIPPLE_ORIGIN);
      waterMat.uniforms.uRippleScale.value.copy(RIPPLE_SIZE);
      waterMat.uniforms.uRippleTexel.value.set(1 / RIPPLE_W, 1 / RIPPLE_H);
    }

    // the camera rig: composed shot until you take over, then walk the banks
    walker = createWalker({
      camera,
      hero: { pos: CAM_POS, target: CAM_TARGET },
      bounds: WALK_BOUNDS,
      // Blender's WATER_Z is 0, so this is "the water surface minus a few cm of
      // wading". The banks rise from exactly 0 at the waterline, so anything
      // above 0 here would wall you off the moment you set foot on the shore.
      waterY: -0.05,
      reducedMotion: REDUCED_MOTION,
      onEngage: () => {
        document.body.classList.add('is-free');
        overlayEl.classList.add('is-roaming');
        // the idle hint is obsolete the moment you're roaming, and it sits on
        // the same line as the roam hint — which overlaps for anyone who
        // started walking without ever moving the pointer
        hintEl.classList.add('is-hidden');
        roamHintEl.textContent = walker?.usingStick
          ? 'drag to look · stick to wander · double-tap to go home'
          : 'drag to look · wasd to wander · r to return home';
        roamHintEl.classList.add('is-on');
        clearTimeout(roamFadeTimer);
        roamHintEl.classList.remove('is-faded');
        roamFadeTimer = setTimeout(() => roamHintEl.classList.add('is-faded'), 6500);
      },
      onReturn: () => {
        document.body.classList.remove('is-free');
        overlayEl.classList.remove('is-roaming');
        roamHintEl.classList.remove('is-on');
        clearTimeout(roamFadeTimer);
      },
      onClick: (x, y) => dropStone(x, y, 0.42),
    });
    walker.attachTerrain(terrain);

    // welcome rings, so the water is alive before anyone touches it
    for (let i = 0; i < 7; i++) {
      ripples.drop(-14 + i * 3.4, (i % 3 - 1) * 2.6, 0.34);
    }

    ready = true;
    loaderEl.classList.add('is-done');
    overlayEl.classList.add('is-ready');
    window.__creekReady = true;
    // handle for debugging and for the screenshot tool's A/B checks
    // b17 is read from the variable, not set to null: it is the smaller file and
    // can easily finish before this callback runs, in which case its own
    // assignment above had nothing to attach itself to
    window.__creek = { scene, camera, renderer, sun, sky, water, waterMat, ripples, fireflies, walker, monster: null, hunt: null, b17, wind: wind.uniforms };

    tryCreateMonster();
  },
  (evt) => {
    if (evt.total && barEl) barEl.style.width = `${Math.round((evt.loaded / evt.total) * 92)}%`;
  },
  (err) => {
    console.error('[creek] could not load assets/creek.glb', err);
    loaderEl.classList.add('is-done');
    document.getElementById('fallback').style.display = 'grid';
  },
);

// The toad ships as its own GLB so that re-running the creek build can never
// clobber it. It fetches alongside the creek and is built by whichever of the
// two lands second. A miss is not fatal — the creek reads fine without it.
gltfLoader.load(
  './assets/monster.glb',
  (gltf) => { monsterGltf = gltf; tryCreateMonster(); },
  undefined,
  (err) => console.warn('[creek] no toad today — the creek carries on without one', err),
);

// The aircraft does the same, and for the same reason. It needs nothing from
// the terrain, so unlike the toad it can be built the moment it lands.
gltfLoader.load(
  './assets/b17.glb',
  (gltf) => {
    try {
      b17 = createB17({ gltf });
      scene.add(b17.object);
      if (window.__creek) window.__creek.b17 = b17;
    } catch (err) {
      console.warn('[creek] no aircraft today — the sky carries on without one', err);
      b17 = null;
    }
  },
  undefined,
  (err) => console.warn('[creek] no aircraft today — the sky carries on without one', err),
);

// ------------------------------------------------------------- composer

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, {
  type: THREE.HalfFloatType,
  // the composer builds its buffers without MSAA, which leaves thin geometry —
  // reeds, grass blades — jagged against the sky once you can walk up to it
  samples: smallScreen ? 2 : 4,
}));
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.30,   // strength
  0.58,   // radius
  0.86,   // threshold
);
composer.addPass(bloom);

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    uTime: { value: 0 },
    uVignette: { value: 0.85 },
    uGrain: { value: 0.009 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 d = vUv - 0.5;
      float r2 = dot(d, d);

      // a whisper of chromatic aberration towards the corners
      vec2 off = d * r2 * 0.004;
      vec4 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col.a = 1.0;

      // warm it a touch
      col.rgb *= vec3(1.045, 1.0, 0.945);

      // vignette
      float v = smoothstep(1.18, 0.30, length(d) * 1.32);
      col.rgb *= mix(1.0, v, uVignette);

      // very fine grain
      float g = hash(vUv * uResolution + fract(uTime) * 137.0) - 0.5;
      col.rgb += g * uGrain;

      gl_FragColor = col;
    }
  `,
};

const gradePass = new ShaderPass(GradeShader);
composer.addPass(gradePass);
composer.addPass(new OutputPass());

// ----------------------------------------------------------------- input

const pointerNDC = new THREE.Vector2(0, 0);
const pointerWorld = new THREE.Vector3(0, 0, 0);
const raycaster = new THREE.Raycaster();
const waterPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.02);

let lastDrop = new THREE.Vector2(9999, 9999);
let lastMoveAt = -10;
let hintHidden = false;
let roamFadeTimer = 0;

/** screen point -> a point on the water plane, or null if the ray misses */
function pointerToWater(clientX, clientY) {
  pointerNDC.x = (clientX / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointerNDC, camera);
  return raycaster.ray.intersectPlane(waterPlane, pointerWorld);
}

/** a deliberate click: one proper stone, wider than an ambient ring */
function dropStone(clientX, clientY, strength = 0.4) {
  if (!ready || !ripples) return;
  if (!pointerToWater(clientX, clientY)) return;
  ripples.drop(pointerWorld.x, pointerWorld.z, strength, 1.35);
  lastDrop.copy(pointerWorld);
}

function onPointerMove(clientX, clientY) {
  pointerNDC.x = (clientX / window.innerWidth) * 2 - 1;
  pointerNDC.y = -(clientY / window.innerHeight) * 2 + 1;

  walker?.setPointerParallax(pointerNDC.x, pointerNDC.y);
  lastMoveAt = elapsed;

  if (!hintHidden) {
    hintHidden = true;
    hintEl.classList.add('is-hidden');
  }

  // while turning the camera the pointer is a steering wheel, not a fingertip
  if (!ready || walker?.dragging) return;

  if (!pointerToWater(clientX, clientY)) return;

  // scatter rings along the path rather than one per event
  const far = Math.min(pointerWorld.distanceTo(camera.position), 45);
  const strength = THREE.MathUtils.mapLinear(
    THREE.MathUtils.clamp(far, 4, 40), 4, 40, 0.30, 0.16,
  );

  if (lastDrop.distanceTo(pointerWorld) > Math.max(0.35, far * 0.045)) {
    if (ripples) ripples.drop(pointerWorld.x, pointerWorld.z, strength);
    lastDrop.copy(pointerWorld);
  }
}

window.addEventListener('pointermove', (e) => onPointerMove(e.clientX, e.clientY), { passive: true });
window.addEventListener('touchmove', (e) => {
  if (e.touches[0]) onPointerMove(e.touches[0].clientX, e.touches[0].clientY);
}, { passive: true });

function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const aspect = w / h;

  // CAM_FOV is the vertical field of view that frames the creek at 16:9. On a
  // narrow or portrait window a vertical fov would crop the scene to a sliver,
  // so widen it to hold the horizontal framing — but not so far that the
  // perspective goes fish-eyed.
  const BASE_ASPECT = 16 / 9;
  const vFov = aspect >= BASE_ASPECT
    ? CAM_FOV
    : Math.min(58, THREE.MathUtils.radToDeg(2 * Math.atan(
        Math.tan(THREE.MathUtils.degToRad(CAM_FOV) / 2) * (BASE_ASPECT / aspect),
      )));

  camera.aspect = aspect;
  camera.fov = vFov;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, smallScreen ? 1.5 : 2));
  renderer.setSize(w, h);
  composer.setSize(w, h);
  gradePass.uniforms.uResolution.value.set(w, h);
}
window.addEventListener('resize', onResize);

// ------------------------------------------------------------------ loop

let elapsed = 0;
let lastFrameAt = 0;

const waterUniforms = () => (waterMat ? waterMat.uniforms : null);

function frame(now) {
  const t = now * 0.001;
  // a plain clock: THREE.Clock is deprecated in favour of THREE.Timer, and we
  // only need a delta and a running total anyway
  let dt = lastFrameAt === 0 ? 0.016 : t - lastFrameAt;
  lastFrameAt = t;
  dt = Math.min(Math.max(dt, 0), 0.05);
  elapsed += dt;

  // ---- ripples
  if (ripples) {
    ripples.update(dt);
    const u = waterUniforms();
    if (u) u.uRipple.value = ripples.texture;
  }

  // ---- water motion
  const u = waterUniforms();
  if (u) u.uTime.value = elapsed;

  // ---- fireflies: drift toward the pointer for a while after it moves
  if (fireflies) {
    const fu = fireflies.uniforms;
    fu.uTime.value = elapsed;
    const since = elapsed - lastMoveAt;
    const target = since < 0.35 ? 1.0 : (since > 3.0 ? 0.0 : 1.0 - (since - 0.35) / 2.65);
    fu.uAttract.value += (target - fu.uAttract.value) * Math.min(dt * 2.6, 1);
    fu.uPointer.value.lerp(
      new THREE.Vector3(pointerWorld.x, 1.05, pointerWorld.z),
      Math.min(dt * 2.2, 1),
    );
  }

  // ---- lantern flicker
  if (lantern) {
    const f = 0.86 + 0.14 * Math.sin(elapsed * 2.1) * Math.sin(elapsed * 5.7 + 1.3);
    lantern.material.emissiveIntensity = 6.0 * f;
  }

  // ---- the breeze through the foliage
  wind.update(elapsed);

  // ---- camera: the composed shot, or the walker once you've taken over
  if (walker) walker.update(dt, elapsed);

  // ---- the toad, which is watching you back
  if (monster) monster.update(dt, elapsed);
  // ...and taking the occasional fly. Runs after the toad so it reads a mouth
  // that has already been placed this frame.
  if (hunt) hunt.update(dt);

  // the sky is a 200m sphere; keep it centred so the gradient never skews
  sky.position.copy(camera.position);

  gradePass.uniforms.uTime.value = elapsed;

  composer.render();
}

renderer.setAnimationLoop(frame);
