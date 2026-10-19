/**
 * controls.js — standing in the scene.
 *
 * Two modes share the same camera:
 *
 *   idle — the composed hero shot, with its slow breath and pointer parallax.
 *   free — walk the banks with WASD, drag to look, R to glide back home.
 *
 * Walking is grounded on a heightmap sampled straight out of the terrain mesh at
 * load, and the water is treated as a wall rather than a floor: you can walk down
 * to the edge, but the camera never dives under the surface.
 *
 * Blender authored the terrain as a regular grid, so the vertex positions are
 * already the height samples. That makes the sampler exact and cheap, with a
 * downward raycast kept as a fallback in case the export ever changes shape.
 */

import * as THREE from 'three';

import { buildHeightSampler } from './heightmap.js';

const KEY_ACTIONS = new Map([
  ['KeyW', 'fwd'], ['ArrowUp', 'fwd'],
  ['KeyS', 'back'], ['ArrowDown', 'back'],
  ['KeyA', 'left'], ['ArrowLeft', 'left'],
  ['KeyD', 'right'], ['ArrowRight', 'right'],
  ['ShiftLeft', 'sprint'], ['ShiftRight', 'sprint'],
]);

const WALK_SPEED = 1.3;      // m/s
const SPRINT_SPEED = 2.4;
const EYE_HEIGHT = 1.55;     // m above ground
const BOB_HEIGHT = 0.035;    // m of head bob at walking pace
const LOOK_SENS = 0.0032;    // radians per pixel (grab-the-world direction)
const PITCH_LIMIT = THREE.MathUtils.degToRad(75);
const DRAG_THRESHOLD = 4;    // px before a press counts as a look-drag
const CLICK_SLOP = 5;        // px under which a press counts as a click
const RETURN_SECONDS = 1.25;

export function createWalker({
  camera,
  hero,
  bounds,
  waterY = 0.08,
  reducedMotion = false,
  onEngage,
  onReturn,
  onClick,
}) {
  const heroPos = hero.pos.clone();
  const heroTarget = hero.target.clone();

  // the composition's own axes, for the idle drift
  const forward = heroTarget.clone().sub(heroPos).normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const heroQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().lookAt(heroPos, heroTarget, new THREE.Vector3(0, 1, 0)),
  );
  const heroDir = heroTarget.clone().sub(heroPos).normalize();

  const parallax = new THREE.Vector2();
  const parallaxTarget = new THREE.Vector2();

  let mode = 'idle';                 // idle | free | returning
  let yaw = 0;
  let pitch = 0;
  let targetYaw = 0;
  let targetPitch = 0;
  const pos = new THREE.Vector2(heroPos.x, heroPos.z);
  let eyeY = heroPos.y;
  const vel = new THREE.Vector2();
  const actions = new Set();
  const stick = new THREE.Vector2();
  let dragging = false;
  let returnTween = null;
  let bobPhase = 0;

  // ---- terrain -----------------------------------------------------------
  let sampler = null;
  let terrainMesh = null;
  const raycaster = new THREE.Raycaster();
  const DOWN = new THREE.Vector3(0, -1, 0);
  const rayOrigin = new THREE.Vector3();

  function attachTerrain(mesh) {
    terrainMesh = mesh;
    sampler = mesh ? buildHeightSampler(mesh) : null;
    if (mesh && !sampler) {
      console.warn('[creek] terrain is not a regular grid; falling back to raycasts');
    }
  }

  function groundAt(x, z) {
    if (sampler) return sampler.sample(x, z);
    if (terrainMesh) {
      // slow but correct; only used if the grid detection fails
      rayOrigin.set(x, 200, z);
      raycaster.set(rayOrigin, DOWN);
      raycaster.far = 400;
      const hit = raycaster.intersectObject(terrainMesh, false)[0];
      if (hit) return hit.point.y;
    }
    return 0.2;
  }

  // ---- pointer look ------------------------------------------------------
  const canvas = camera.userData.canvas || document.getElementById('scene');
  let press = null;
  let lastTapAt = -1;

  function enter() {
    if (mode !== 'idle') return;
    mode = 'free';

    const dir = camera.getWorldDirection(new THREE.Vector3());
    yaw = targetYaw = Math.atan2(-dir.x, -dir.z);
    pitch = targetPitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));

    pos.set(camera.position.x, camera.position.z);
    eyeY = camera.position.y;
    vel.set(0, 0);
    onEngage?.();
  }

  function returnHome() {
    if (mode !== 'free') return;
    mode = 'returning';
    returnTween = {
      t: 0,
      fromPos: camera.position.clone(),
      fromQuat: camera.quaternion.clone(),
    };
    vel.set(0, 0);
    actions.clear();
    stick.set(0, 0);
    onReturn?.();
  }

  if (canvas) {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.pointerType === 'mouse' && e.buttons !== 1) return;
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
      try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    });

    canvas.addEventListener('pointermove', (e) => {
      if (!press || e.pointerId !== press.id) return;

      const dx = e.clientX - press.x;
      const dy = e.clientY - press.y;
      press.x = e.clientX;
      press.y = e.clientY;
      press.moved += Math.hypot(dx, dy);

      if (press.moved > DRAG_THRESHOLD) {
        dragging = true;
        if (mode === 'idle') enter();
        if (mode === 'free') {
          // grab the world: drag right and the view turns left, as on a map
          targetYaw += dx * LOOK_SENS;
          targetPitch = THREE.MathUtils.clamp(
            targetPitch + dy * LOOK_SENS, -PITCH_LIMIT, PITCH_LIMIT,
          );
          e.preventDefault();
        }
      }
    });

    const endPress = (e) => {
      if (!press || e.pointerId !== press.id) return;
      const wasClick = press.moved < CLICK_SLOP;
      press = null;
      dragging = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* fine */ }
      if (!wasClick) return;

      // no keyboard on a phone: a double tap walks you back to the hero shot
      if (isTouch && performance.now() - lastTapAt < 320) {
        lastTapAt = -1;
        returnHome();
        return;
      }
      lastTapAt = performance.now();
      onClick?.(e.clientX, e.clientY);
    };
    canvas.addEventListener('pointerup', endPress);
    canvas.addEventListener('pointercancel', endPress);
  }

  // ---- keyboard ----------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const action = KEY_ACTIONS.get(e.code);
    if (action) {
      actions.add(action);
      if (mode === 'idle') enter();
      if (mode === 'free') e.preventDefault();
      return;
    }

    if (e.code === 'KeyR' || e.code === 'Escape') {
      returnHome();
    }
  });

  window.addEventListener('keyup', (e) => {
    const action = KEY_ACTIONS.get(e.code);
    if (action) actions.delete(action);
  });

  window.addEventListener('blur', () => {
    actions.clear();
    stick.set(0, 0);
  });

  // ---- touch stick -------------------------------------------------------
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  if (isTouch) {
    document.body.classList.add('is-touch');
    const pad = document.getElementById('pad');
    const knob = document.getElementById('knob');
    if (pad && knob) {
      let stickId = null;

      const track = (e) => {
        const r = pad.getBoundingClientRect();
        const max = r.width * 0.36;
        let dx = e.clientX - (r.left + r.width / 2);
        let dy = e.clientY - (r.top + r.height / 2);
        const len = Math.hypot(dx, dy);
        if (len > max) { dx = (dx / len) * max; dy = (dy / len) * max; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        stick.set(dx / max, dy / max);
      };

      const release = () => {
        stickId = null;
        stick.set(0, 0);
        knob.style.transform = 'translate(0px, 0px)';
      };

      pad.addEventListener('pointerdown', (e) => {
        stickId = e.pointerId;
        try { pad.setPointerCapture(e.pointerId); } catch { /* fine */ }
        track(e);
        e.preventDefault();
      });
      pad.addEventListener('pointermove', (e) => {
        if (e.pointerId === stickId) { track(e); e.preventDefault(); }
      });
      pad.addEventListener('pointerup', release);
      pad.addEventListener('pointercancel', release);
    }
  }

  // ---- update ------------------------------------------------------------
  function updateIdle(dt, elapsed) {
    if (reducedMotion) {
      camera.position.copy(heroPos);
      camera.lookAt(heroTarget);
      return;
    }

    parallax.lerp(parallaxTarget, Math.min(dt * 2.1, 1));

    const breath = Math.sin(elapsed * 0.28) * 0.055;
    const sway = Math.cos(elapsed * 0.19) * 0.075;

    camera.position.copy(heroPos)
      .addScaledVector(right, parallax.x * 0.38 + sway)
      .addScaledVector(up, parallax.y * 0.24 + breath)
      .addScaledVector(forward, Math.sin(elapsed * 0.15) * 0.16);

    const look = heroTarget.clone()
      .addScaledVector(right, parallax.x * 0.85)
      .addScaledVector(up, parallax.y * 0.55 + Math.sin(elapsed * 0.23) * 0.10);
    camera.lookAt(look);
  }

  function updateReturning(dt) {
    returnTween.t += dt;
    const k = THREE.MathUtils.clamp(returnTween.t / RETURN_SECONDS, 0, 1);
    const e = k * k * (3 - 2 * k);

    camera.position.lerpVectors(returnTween.fromPos, heroPos, e);
    camera.quaternion.slerpQuaternions(returnTween.fromQuat, heroQuat, e);

    if (k >= 1) {
      mode = 'idle';
      returnTween = null;
      parallax.set(0, 0);
      parallaxTarget.set(0, 0);
      // snap the look angles to the hero frame for a clean handover
      yaw = targetYaw = Math.atan2(-heroDir.x, -heroDir.z);
      pitch = targetPitch = Math.asin(THREE.MathUtils.clamp(heroDir.y, -1, 1));
    }
  }

  const lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');

  function updateFree(dt) {
    // look
    const lookK = 1 - Math.exp(-dt * 20);
    yaw += (targetYaw - yaw) * lookK;
    pitch += (targetPitch - pitch) * lookK;

    // desired direction, flattened to the ground
    let fwd = (actions.has('fwd') ? 1 : 0) + (actions.has('back') ? -1 : 0) - stick.y;
    let strafe = (actions.has('right') ? 1 : 0) + (actions.has('left') ? -1 : 0) + stick.x;
    fwd = THREE.MathUtils.clamp(fwd, -1, 1);
    strafe = THREE.MathUtils.clamp(strafe, -1, 1);

    let len = Math.hypot(fwd, strafe);
    if (len > 1) { fwd /= len; strafe /= len; len = 1; }

    const speed = actions.has('sprint') ? SPRINT_SPEED : WALK_SPEED;
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    // forward = (-sin yaw, 0, -cos yaw); right = (cos yaw, 0, -sin yaw)
    const wantX = (-sinY * fwd + cosY * strafe) * speed;
    const wantZ = (-cosY * fwd - sinY * strafe) * speed;

    const accel = 1 - Math.exp(-dt * (len > 0.05 ? 9 : 12));
    vel.x += (wantX - vel.x) * accel;
    vel.y += (wantZ - vel.y) * accel;

    let nextX = pos.x + vel.x * dt;
    let nextZ = pos.y + vel.y * dt;

    // stay on the map
    if (nextX < bounds.minX) { nextX = bounds.minX; vel.x = Math.max(vel.x, 0); }
    if (nextX > bounds.maxX) { nextX = bounds.maxX; vel.x = Math.min(vel.x, 0); }
    if (nextZ < bounds.minZ) { nextZ = bounds.minZ; vel.y = Math.max(vel.y, 0); }
    if (nextZ > bounds.maxZ) { nextZ = bounds.maxZ; vel.y = Math.min(vel.y, 0); }

    // the creek is a wall. Try the move, then each axis on its own, so the
    // camera slides along the bank instead of sticking to it.
    if (groundAt(nextX, nextZ) < waterY) {
      const xOk = groundAt(nextX, pos.y) >= waterY;
      const zOk = groundAt(pos.x, nextZ) >= waterY;
      if (xOk) { nextZ = pos.y; vel.y = 0; }
      else if (zOk) { nextX = pos.x; vel.x = 0; }
      else { nextX = pos.x; nextZ = pos.y; vel.set(0, 0); }
    }

    pos.set(nextX, nextZ);

    // settle onto the ground rather than snapping over bumps
    const wanted = groundAt(pos.x, pos.y) + EYE_HEIGHT;
    eyeY += (wanted - eyeY) * (1 - Math.exp(-dt * 8));

    // a small bob, in step with how fast you're actually moving: it eases in
    // from a standstill and stops dead when you do
    const moving = Math.hypot(vel.x, vel.y);
    bobPhase += dt * (3.2 + moving * 2.6);
    const bob = reducedMotion
      ? 0
      : Math.min(moving / WALK_SPEED, 1) * BOB_HEIGHT * Math.sin(bobPhase);

    camera.position.set(pos.x, eyeY + bob, pos.y);
    lookEuler.set(pitch, yaw, 0);
    camera.quaternion.setFromEuler(lookEuler);
  }

  return {
    attachTerrain,
    enter,
    returnHome,

    get isFree() { return mode === 'free'; },
    get isReturning() { return mode === 'returning'; },
    get isIdle() { return mode === 'idle'; },
    get dragging() { return dragging; },
    get usingStick() { return isTouch; },

    /** pointer position in NDC, for the idle parallax */
    setPointerParallax(x, y) {
      parallaxTarget.set(x, y);
    },

    update(dt, elapsed) {
      if (mode === 'idle') updateIdle(dt, elapsed);
      else if (mode === 'free') updateFree(dt);
      else updateReturning(dt);
    },
  };
}
