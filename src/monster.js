/**
 * monster.js — the toad that lives in the shallows.
 *
 * It came in from Sketchfab through Blender (see blender/build_monster.py) as
 * a plain static mesh: the asset is called "…_animated" but it carries no
 * armature and no actions, so all of the life here is procedural — a hop cycle
 * with squash and stretch, a yaw that follows the bank, and a wake of rings
 * dropped into the same wave field the pointer stirs.
 *
 * The path traces the waterline rather than running in a straight lane: for
 * each x it asks the terrain heightmap where the near bank falls away under
 * the surface, then steps out just far enough to be wading. The east end stops
 * short of the fallen log and the stepping stones, which a toad has no way to
 * climb.
 *
 * It is aware of you. Inside NOTICE_RADIUS it stops and turns to look; inside
 * FLEE_RADIUS it hops off along its path until you give it room.
 */

import * as THREE from 'three';

import { buildHeightSampler } from './heightmap.js';

const CRUISE_SPEED = 0.62;      // m/s
const FLEE_SPEED = 1.75;
const HOP_RATE = 1.45;          // hops per second at cruising speed
const HOP_HEIGHT = 0.17;        // m at the top of a hop
const SQUASH = 0.16;            // how far the hop's squash and stretch goes
const TURN_RATE = 4.2;          // yaw easing, 1/s
const WADE_DEPTH = 0.13;        // feet this far below the waterline
const NOTICE_RADIUS = 9.0;
const NOTICE_RELEASE = 11.5;    // hysteresis, so it can't flicker at the edge
const FLEE_RADIUS = 3.0;
const FLEE_SECONDS = 2.0;
const FLEE_COOLDOWN = 5.0;
const DWELL_MIN = 1.6;
const DWELL_MAX = 4.2;
const WAKE_STEP = 0.55;         // metres of travel between wake rings
const WAKE_STRENGTH = 0.10;
const WAKE_RADIUS = 2.6;        // a body shoving water, not a dropped stone
const PATH_X0 = -27.0;
const PATH_X1 = -3.5;
const PATH_STEP = 1.0;
const SMOOTH_PASSES = 2;
const START_X = -8.0;

// The mouth, in the toad's own space. Measured off the mesh rather than
// guessed: the snout tip reaches z ≈ 0.67 and spans y ≈ 0.88..1.04, centred on
// x = 0, so the mouth sits just inside the front of that.
const MOUTH_LOCAL = new THREE.Vector3(0, 0.93, 0.62);

// The strike, in four beats. The aim is the long one on purpose — it is what
// separates "hunting" from "teleporting into a snap".
const AIM_SECONDS = 0.38;
const SNAP_SECONDS = 0.09;
const HOLD_SECONDS = 0.06;
const RECOVER_SECONDS = 0.34;
const STRIKE_TOTAL = AIM_SECONDS + SNAP_SECONDS + HOLD_SECONDS + RECOVER_SECONDS;
const STRIKE_LUNGE = 0.06;      // metres of body thrown into it
const MISS_SHORT = 0.7;         // a miss stops this far short of the fly
const TONGUE_ROOT = 0.055;
const TONGUE_TIP = 0.016;

// the near bank is the one the hero camera stands on: three.js z heads
// negative towards it, so walk in from there and out into the channel
const SCAN_Z0 = -13.0;
const SCAN_Z1 = 2.0;

/** How far off the shore the water is WADE_DEPTH deep, at this x. */
function wadeLine(heightAt, x, waterY) {
  let shore = null;
  for (let z = SCAN_Z0; z <= SCAN_Z1; z += 0.08) {
    if (heightAt(x, z) < waterY) { shore = z; break; }
  }
  if (shore === null) return null;

  let out = shore;
  for (let z = shore; z <= SCAN_Z1; z += 0.05) {
    out = z;
    if (heightAt(x, z) < waterY - WADE_DEPTH) return z;
  }
  return out;
}

/** The toad's beat, smoothed so the shallows don't jitter the hop. */
function buildPath(heightAt, waterY, x0, x1) {
  const count = Math.max(2, Math.round((x1 - x0) / PATH_STEP) + 1);
  const zs = [];
  for (let i = 0; i < count; i++) {
    const x = x0 + (x1 - x0) * (i / (count - 1));   // lands exactly on x0 and x1
    const z = wadeLine(heightAt, x, waterY);
    if (z === null) return null;
    zs.push(z);
  }
  if (zs.length < 4) return null;

  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    for (let i = 1; i < zs.length - 1; i++) {
      zs[i] = (zs[i - 1] + zs[i] * 2 + zs[i + 1]) * 0.25;
    }
  }

  return new THREE.CatmullRomCurve3(
    zs.map((z, i) => new THREE.Vector3(x0 + (x1 - x0) * (i / (count - 1)), 0, z)),
    false,
    'catmullrom',
    0.5,
  );
}

export function createMonster({
  gltf,
  terrain,
  waterY = 0,
  ripples = null,
  camera = null,
  reducedMotion = false,
  x0 = PATH_X0,
  x1 = PATH_X1,
  startX = START_X,
}) {
  const object = gltf.scene;
  // yaw first, then the hop's pitch, so the tilt stays in the toad's own frame
  object.rotation.order = 'YXZ';

  object.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) {
      if (!m) continue;
      // the scene is painted in washed vertex colours, so a realistic albedo
      // reads as a silhouette next to it: lift it back into the palette
      m.envMapIntensity = 1.0;
      if (m.color) m.color.setRGB(1.14, 1.18, 1.10);
    }
  });

  const sampler = terrain ? buildHeightSampler(terrain) : null;
  const heightAt = sampler ? (x, z) => sampler.sample(x, z) : null;
  const curve = heightAt ? buildPath(heightAt, waterY, x0, x1) : null;
  const length = curve ? curve.getLength() : 0;
  if (!curve) {
    console.warn('[creek] no shoreline for the toad to walk; it will sit at the origin');
  }

  // The tongue has no geometry in the GLB — the asset is a static sculpt — so
  // it is made here: a tapered spike along +Z, scaled to reach. It is driven in
  // world space rather than parented to the toad, because it has to aim at
  // something that is not part of the toad.
  const tongueGeo = new THREE.CylinderGeometry(TONGUE_TIP, TONGUE_ROOT, 1, 6, 1, true);
  tongueGeo.rotateX(Math.PI / 2);     // +Y becomes +Z, the axis lookAt aims
  tongueGeo.translate(0, 0, 0.5);     // root at the origin, tip at 1
  const tongue = new THREE.Mesh(
    tongueGeo,
    new THREE.MeshStandardMaterial({
      color: 0xa25f57,
      roughness: 0.55,
      side: THREE.DoubleSide,
      envMapIntensity: 0.8,
    }),
  );
  tongue.name = 'Tongue';
  tongue.castShadow = false;
  tongue.receiveShadow = false;
  tongue.visible = false;

  // ---- state -------------------------------------------------------------
  let s = length * THREE.MathUtils.clamp((startX - x0) / (x1 - x0), 0, 1);
  let dir = 1;                  // +1 travels towards x1
  let speed = 0;                // signed, m/s along the path
  let yaw = 0;
  let hopPhase = 0;
  let mode = 'cruise';          // cruise | dwell | flee
  let timer = 0;
  let cooldown = 0;
  let alert = false;
  let groundY = waterY - WADE_DEPTH;
  let placed = false;
  let lastDistance = Infinity;
  let strikeT = -1;             // seconds since the strike began; -1 is idle
  let strikeHit = true;
  let strikeNotify = null;      // called once, when the tongue lands
  const strikeTarget = new THREE.Vector3();
  const mouthWorld = new THREE.Vector3();

  const point = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const meXZ = new THREE.Vector2();
  const youXZ = new THREE.Vector2();
  const wakeAt = new THREE.Vector2(9999, 9999);

  function dwellFor() {
    return DWELL_MIN + Math.random() * (DWELL_MAX - DWELL_MIN);
  }

  function update(dt, elapsed) {
    if (!curve) return;

    if (strikeT >= 0) {
      strikeT += dt;
      if (strikeT >= STRIKE_TOTAL) {
        strikeT = -1;
        strikeNotify = null;
      }
    }

    // ---- how close are you? ---------------------------------------------
    let distance = Infinity;
    if (camera) {
      meXZ.set(object.position.x, object.position.z);
      youXZ.set(camera.position.x, camera.position.z);
      distance = meXZ.distanceTo(youXZ);
    }
    lastDistance = distance;

    // stuck once noticed, but with enough slack that standing on the edge
    // doesn't make it flicker between watching you and carrying on
    alert = distance < (alert ? NOTICE_RELEASE : NOTICE_RADIUS);

    if (cooldown > 0) cooldown -= dt;

    if (mode === 'flee') {
      timer -= dt;
      if (timer <= 0) { mode = 'cruise'; cooldown = FLEE_COOLDOWN; }
    } else if (distance < FLEE_RADIUS && cooldown <= 0) {
      mode = 'flee';
      timer = FLEE_SECONDS;
      // bolt down whichever way of the path is away from you
      curve.getPointAt(THREE.MathUtils.clamp(s / Math.max(length, 1e-6), 0, 1), point);
      const away = Math.sign(point.x - camera.position.x) || 1;
      const wants = (away > 0) === (x1 > x0) ? 1 : -1;
      dir = wants;
    } else if (mode === 'dwell') {
      timer -= dt;
      if (timer <= 0) { mode = 'cruise'; dir = -dir; }
    }

    // ---- how fast it wants to be going ----------------------------------
    let wantSpeed = 0;
    if (mode === 'flee') wantSpeed = FLEE_SPEED * dir;
    else if (mode === 'dwell' || alert) wantSpeed = 0;
    else wantSpeed = CRUISE_SPEED * dir;

    // a strike outranks all of it: it stops to aim, and stays stopped to
    // swallow before carrying on
    if (strikeT >= 0) wantSpeed = 0;

    // it settles down faster than it sets off
    const k = 1 - Math.exp(-dt * (wantSpeed === 0 ? 2.8 : 1.6));
    speed += (wantSpeed - speed) * k;

    // ---- travel along the path ------------------------------------------
    s += speed * dt;
    if (s <= 0 || s >= length) {
      s = THREE.MathUtils.clamp(s, 0, length);
      if (mode === 'cruise') { mode = 'dwell'; timer = dwellFor(); }
      else if (mode === 'flee') dir = -dir;
    }

    const u = THREE.MathUtils.clamp(s / Math.max(length, 1e-6), 0, 1);
    curve.getPointAt(u, point);
    curve.getTangentAt(u, tangent);

    // ---- standing on the bed --------------------------------------------
    const bed = heightAt ? heightAt(point.x, point.z) : waterY - WADE_DEPTH;
    if (!placed) groundY = bed;
    else groundY += (bed - groundY) * (1 - Math.exp(-dt * 5));

    // ---- the hop ---------------------------------------------------------
    const gait = Math.min(Math.abs(speed) / CRUISE_SPEED, 1.2);
    const still = reducedMotion ? 0 : Math.min(gait, 1);
    hopPhase += dt * HOP_RATE * gait * Math.PI * 2;
    if (hopPhase > Math.PI * 2) hopPhase %= Math.PI * 2;
    const lift = Math.max(0, Math.sin(hopPhase));
    const air = lift * still;

    // ---- facing ----------------------------------------------------------
    // While striking, the prey outranks you: it will look away from the camera
    // to take a fly, then come back to watching.
    let targetYaw;
    if (strikeT >= 0 && strikeT < AIM_SECONDS + SNAP_SECONDS + HOLD_SECONDS) {
      targetYaw = Math.atan2(strikeTarget.x - point.x, strikeTarget.z - point.z);
    } else if ((alert || mode === 'flee') && camera) {
      targetYaw = Math.atan2(camera.position.x - point.x, camera.position.z - point.z);
      targetYaw += Math.sin(elapsed * 0.7) * 0.05;      // and a slow breath
    } else {
      targetYaw = Math.atan2(tangent.x * dir, tangent.z * dir);
    }
    const turn = Math.atan2(
      Math.sin(targetYaw - yaw),
      Math.cos(targetYaw - yaw),
    );
    // it swings round faster when there is something to catch
    yaw += turn * (1 - Math.exp(-dt * (strikeT >= 0 ? TURN_RATE * 2.4 : TURN_RATE)));

    // ---- pose ------------------------------------------------------------
    // The lunge is time-based only. The mouth is derived afterwards, because it
    // rides on the body that this block is about to move.
    let lunge = 0;
    if (strikeT >= 0) {
      const s = strikeT - AIM_SECONDS;
      if (s > 0) {
        const out = Math.min(s / SNAP_SECONDS, 1);
        const back = s > SNAP_SECONDS + HOLD_SECONDS
          ? Math.min((s - SNAP_SECONDS - HOLD_SECONDS) / RECOVER_SECONDS, 1)
          : 0;
        lunge = out * (1 - back);
      }
    }

    const stretch = SQUASH * still * (lift - 0.5);
    const breath = 1 + 0.012 * Math.sin(elapsed * 1.5) * (1 - still);

    object.position.set(
      point.x + Math.sin(yaw) * lunge * STRIKE_LUNGE,
      groundY + air * HOP_HEIGHT,
      point.z + Math.cos(yaw) * lunge * STRIKE_LUNGE,
    );
    object.rotation.set(
      -0.13 * Math.cos(hopPhase) * still + lunge * 0.16,
      yaw,
      0,
    );
    object.scale.set(1 - stretch * 0.55, breath + stretch, 1 - stretch * 0.55);

    // ---- the tongue ------------------------------------------------------
    object.updateMatrixWorld(true);
    mouthWorld.copy(MOUTH_LOCAL).applyMatrix4(object.matrixWorld);

    if (strikeT >= 0) {
      const s = strikeT - AIM_SECONDS;
      // a miss aims at the fly but simply stops short of it
      const far = strikeTarget.distanceTo(mouthWorld) * (strikeHit ? 1 : MISS_SHORT);

      // The tongue has landed. A fly is not caught in mid-air — it is caught
      // now — so whoever asked to be told gets told at this instant, and only
      // once.
      if (strikeNotify && s >= SNAP_SECONDS) {
        strikeNotify(mouthWorld, strikeHit);
        strikeNotify = null;
      }

      let reach = 0;
      if (s > 0 && s < SNAP_SECONDS) {
        const e = s / SNAP_SECONDS;
        reach = far * (1 - (1 - e) * (1 - e));      // out fast, then slacken
      } else if (s >= SNAP_SECONDS && s < SNAP_SECONDS + HOLD_SECONDS) {
        reach = far;
      } else if (s >= SNAP_SECONDS + HOLD_SECONDS) {
        const r = (s - SNAP_SECONDS - HOLD_SECONDS) / RECOVER_SECONDS;
        reach = r >= 1 ? 0 : far * (1 - r);
      }

      tongue.visible = reach > 0.004;
      if (tongue.visible) {
        tongue.position.copy(mouthWorld);
        tongue.lookAt(strikeTarget);
        tongue.scale.set(1, 1, reach);
      }
    } else {
      tongue.visible = false;
    }

    // ---- the wake --------------------------------------------------------
    if (ripples && Math.abs(speed) > 0.05) {
      if (wakeAt.distanceToSquared(meXZ.set(point.x, point.z)) > WAKE_STEP * WAKE_STEP) {
        ripples.drop(point.x, point.z, WAKE_STRENGTH, WAKE_RADIUS);
        wakeAt.set(point.x, point.z);
      }
    }

    placed = true;
  }

  /**
   * Aim the tongue at a world-space point. False if a strike is in flight.
   * `onSnap(mouth, connected)` fires once, the instant the tongue lands — which
   * is where a fly actually gets caught, not when the toad decides to try.
   */
  function strike(target, hit = true, onSnap = null) {
    if (strikeT >= 0) return false;
    strikeTarget.copy(target);
    strikeHit = hit;
    strikeNotify = onSnap;
    strikeT = 0;
    return true;
  }

  // put it in position before the first frame, so it never flashes at the origin
  update(0, 0);

  return {
    object,
    tongue,          // driven in world space, so the caller adds it to the scene
    update,
    strike,
    curve,
    mouthWorld,      // live: valid once update() has run
    get mode() { return mode; },
    get alerted() { return alert; },
    get speed() { return speed; },
    get distance() { return lastDistance; },
    get striking() { return strikeT >= 0; },
    get yaw() { return yaw; },
  };
}
