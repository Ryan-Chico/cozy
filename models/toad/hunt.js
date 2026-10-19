/**
 * hunt.js — the toad's appetite.
 *
 * The toad cannot see the fireflies. Their motion lives in a vertex shader, and
 * deliberately so: one draw call, no per-frame CPU bookkeeping. But that motion
 * is closed-form, so `fireflies.positionAt()` mirrors it exactly, and this is
 * the only thing that reads the mirror — pick the nearest fly the toad could
 * actually reach, aim, snap.
 *
 * This module only ever decides *when* and *which*. The pose and the tongue
 * belong to monster.js, the dragging-into-the-mouth belongs to fireflies.js.
 *
 * Prey is not scarce, but it is not on tap either. Measured against the mouth —
 * not the toad's feet, because the mouth sits 0.83 m up and the swarm spreads
 * from 0.25 m to 3.65 m, so height dominates the distance — a reachable fly is
 * there 9% of the time, 1.1 of them on average when it is. That works out at
 * roughly two strikes a minute end to end, and widening the reach barely moves
 * it: what governs the rate is the cooldown, so that is the knob to turn. A
 * lure would be the other option, and the measurement says it is not needed.
 */

import * as THREE from 'three';

const REACH = 1.25;             // how far the tongue can go, metres
const CONE_COS = 0.42;          // roughly +/-65 degrees off the toad's facing
const COOLDOWN_MIN = 6.0;
const COOLDOWN_MAX = 13.0;
const MISS_CHANCE = 0.22;       // it does not always connect
const FIRST_PEACE = 4.0;        // let the scene settle before the first strike
const MIN_RANGE = 0.14;         // ignore anything already at the mouth

export function createHunt({ monster, fireflies, ripples = null }) {
  const prey = new THREE.Vector3();
  let cooldown = FIRST_PEACE;
  let strikes = 0;
  let misses = 0;
  let caught = 0;

  function update(dt) {
    if (!monster || !fireflies) return;

    if (cooldown > 0) cooldown -= dt;
    if (cooldown > 0 || monster.striking) return;
    if (monster.mode === 'flee') return;

    const mouth = monster.mouthWorld;
    const fx = Math.sin(monster.yaw);
    const fz = Math.cos(monster.yaw);

    let best = -1;
    let bestD = Infinity;

    for (let i = 0; i < fireflies.count; i++) {
      if (!fireflies.isFlying(i)) continue;    // it is already in the mouth
      fireflies.positionAt(i, prey);
      const dx = prey.x - mouth.x;
      const dy = prey.y - mouth.y;
      const dz = prey.z - mouth.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > REACH || d < MIN_RANGE || d >= bestD) continue;

      // it strikes forwards, not over its own shoulder
      const flat = Math.hypot(dx, dz);
      if (flat < 1e-4) continue;
      if ((dx * fx + dz * fz) / flat < CONE_COS) continue;

      best = i;
      bestD = d;
    }

    if (best < 0) return;

    fireflies.positionAt(best, prey);
    const hit = Math.random() > MISS_CHANCE;
    const fly = best;

    // A fly is caught when the tongue lands on it, not when the toad decides to
    // try — otherwise it would be hauled into the mouth during the wind-up and
    // the tongue would snap at nothing.
    const onSnap = (mouthNow, connected) => {
      if (connected && fireflies.eat(fly, mouthNow)) caught++;
      // and the lunge is heavy enough to shove the water it is standing in
      if (ripples) {
        ripples.drop(monster.object.position.x, monster.object.position.z, 0.05, 1.1);
      }
    };

    if (!monster.strike(prey, hit, onSnap)) return;

    strikes++;
    if (!hit) misses++;
    cooldown = COOLDOWN_MIN + Math.random() * (COOLDOWN_MAX - COOLDOWN_MIN);
  }

  return {
    update,
    get strikes() { return strikes; },   // attempts
    get misses() { return misses; },     // attempts that fell short
    get caught() { return caught; },     // flies actually swallowed
    get cooldown() { return cooldown; },
  };
}
