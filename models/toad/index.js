/**
 * The toad in the shallows — the worked example to copy if your model needs to
 * do more than stand there.
 *
 * It is the most demanding guest in the scene, and the reason the model API has
 * a context at all. Between them, the two files next to this one reach for:
 *
 *   - the terrain heightmap, to find the waterline it walks along
 *   - the water height, to decide how deep it is standing
 *   - the ripple sim, to leave rings behind it
 *   - the camera, so it can tell whether you are looking at it
 *   - the fireflies, which it eats — and those live only in a shader, so
 *     fireflies.js runs the same drift a second time on the CPU for it
 *
 * That is a lot to ask of a guest, and it is fine: `setup` gets whatever the
 * scene has, the same objects main.js uses itself.
 *
 * `selfPlaced` is doing real work here. The toad walks a path in world metres
 * and squashes itself as it hops, so it owns its own position, rotation and
 * scale — wrapping it in a holder and scaling that would fight with both. The
 * loader takes that flag as "hand it over and stay out of the way".
 */

import { createMonster } from './monster.js';
import { createHunt } from './hunt.js';

export default {
  id: 'toad',
  name: 'Giant toad',

  model: new URL('./model.glb', import.meta.url),

  credit: {
    work: 'Standing_giant_toad_green_skin_animated',
    by: 'pikupila',
    licence: 'CC BY 4.0',
    via: 'Sketchfab',
    url: 'https://sketchfab.com/3d-models/db8e45b28c9e495d8472b10f75d82847',
  },

  selfPlaced: true,
  needs: ['creek'],     // it reads the terrain to find its shoreline

  setup(ctx) {
    const monster = createMonster({
      gltf: ctx.gltf,
      terrain: ctx.terrain,
      waterY: 0,        // the waterline itself; the walker's -0.05 is its own
      ripples: ctx.ripples,
      camera: ctx.camera,
      reducedMotion: ctx.reducedMotion,
    });

    // the tongue is driven in world space, so it is a sibling of the toad
    // rather than a child of it
    ctx.scene.add(monster.tongue);

    // A miss is not fatal here either: a toad that never eats is still a toad.
    const hunt = ctx.fireflies
      ? createHunt({ monster, fireflies: ctx.fireflies, ripples: ctx.ripples })
      : null;

    // the names the screenshot tool and the README reach for
    ctx.expose('monster', monster);
    if (hunt) ctx.expose('hunt', hunt);

    return {
      update(dt, elapsed) {
        monster.update(dt, elapsed);
        // ...and the appetite runs after, so it reads a mouth that has already
        // been placed this frame
        if (hunt) hunt.update(dt);
      },
    };
  },
};
