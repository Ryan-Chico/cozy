/**
 * models.js — the guest list.
 *
 * Everything in the scene that was not built here is a model: a glTF file that
 * arrives with no idea what scale it is, which way it is facing, or where the
 * ground is. This works that out, and it is deliberately the whole of what a
 * contribution has to go through — see CONTRIBUTING.md.
 *
 * Three things happen to every model, in this order:
 *
 *   fit     The longest axis is scaled to the metres the spec asks for, so a
 *           spec says "26 across" rather than carrying a scale factor nobody
 *           can check. It also means nobody needs Blender to contribute: the
 *           two models that shipped first both needed a Blender pass purely to
 *           fix their scale and origin, and neither needed to.
 *
 *   place   The origin is moved onto the model's own centre — or its feet, if
 *           the spec says `grounded` — so `at` means the same thing for a
 *           pebble and for an airliner. The transform goes on a holder around
 *           the model rather than on the model itself, because plenty of
 *           exporters bake a correction into the root node, and multiplying
 *           that away would silently tip the thing over. A spec that drives its
 *           own transform — something that walks a path, say — says
 *           `selfPlaced` and is handed the model with none of this applied.
 *
 *   setup   A spec that needs to do more than stand there gets a context with
 *           the scene's systems on it. See the context reference in
 *           CONTRIBUTING.md.
 *
 * A model that throws is warned about and skipped — the creek is the thing being
 * looked at, and a guest that fails to appear is a disappointment, not an
 * outage. It does go into `window.__creekErrors`, though, so the screenshot tool
 * and CI both notice: a broken contribution must not be able to slip through
 * review by being quiet.
 */

import * as THREE from 'three';
import { noteError } from './errors.js';

const DEG = THREE.MathUtils.degToRad;

const _box = new THREE.Box3();
const _extent = new THREE.Vector3();
const _centre = new THREE.Vector3();
const _pivot = new THREE.Vector3();

/**
 * Wrap `model` in a holder whose origin sits where `at` will place it, with the
 * model already scaled to `spec.size` metres across its longest axis.
 *
 * `spec.measure` names a node to measure instead of the whole model. Some
 * models carry something far larger than their subject — the B-17's tracer fire
 * spans six times its wingspan — and on those the model's own bounding box
 * describes the effect rather than the thing you are placing. The named node is
 * what both the size and the centre refer to.
 *
 * Exported because it is the useful half of this file on its own, and because it
 * is the part worth testing without a renderer.
 */
export function fitAndPlace(model, spec) {
  const holder = new THREE.Group();
  holder.name = `model:${spec.id}`;
  holder.add(model);

  let subject = model;
  if (spec.measure) {
    subject = model.getObjectByName(spec.measure);
    if (!subject) {
      throw new Error(
        `nothing in this model is named "${spec.measure}" — \`measure\` has to be a `
        + `node name that survived the export`,
      );
    }
  }

  model.updateMatrixWorld(true);
  _box.setFromObject(subject);
  // nothing measurable: leave it at unit scale and let the spec's author see
  // for themselves that their export is empty
  if (_box.isEmpty()) return holder;

  _box.getSize(_extent);
  const longest = Math.max(_extent.x, _extent.y, _extent.z);
  const k = spec.size && longest > 1e-6 ? spec.size / longest : 1;

  _box.getCenter(_centre);
  _pivot
    .set(_centre.x, spec.grounded ? _box.min.y : _centre.y, _centre.z)
    .multiplyScalar(k);

  holder.scale.setScalar(k);
  holder.rotation.set(DEG(spec.tilt || 0), DEG(spec.face || 0), DEG(spec.roll || 0), 'YXZ');
  // the offset has to be rotated with it: leave this out and `face` swings the
  // model off the mark it was aimed at, which reads as "the yaw did something
  // weird" rather than as a bug in here
  _pivot.applyEuler(holder.rotation);
  holder.position.copy(_pivot).negate();

  return holder;
}

async function loadOne({ spec, ctx, loader }) {
  if (!(spec.model instanceof URL)) {
    throw new TypeError(
      `model "${spec.id}": \`model\` must be a URL — write `
      + `new URL('./model.glb', import.meta.url), so the path is relative to the `
      + `file that names it rather than to the page`,
    );
  }

  const gltf = await loader.loadAsync(spec.model.href);

  // `selfPlaced` hands the model over untouched: it owns its own position,
  // rotation and scale, and wrapping it in a holder would fight with all three.
  const holder = spec.selfPlaced ? gltf.scene : fitAndPlace(gltf.scene, spec);

  // A grounded model is placed from the terrain's height, so it necessarily
  // waits for the terrain. Making that automatic stops the obvious footgun of
  // asking for `grounded` and getting a model buried in a hillside.
  const wantsCreek = spec.grounded || (spec.needs || []).includes('creek');
  if (wantsCreek) await ctx.creekReady;

  if (!spec.selfPlaced) {
    const at = spec.at || [0, 0, 0];
    const ground = spec.grounded && ctx.heightAt ? ctx.heightAt(at[0], at[2]) : 0;
    holder.position.x += at[0];
    holder.position.y += ground + at[1];
    holder.position.z += at[2];
  }

  if (spec.castShadow !== undefined || spec.receiveShadow !== undefined) {
    holder.traverse((o) => {
      if (!o.isMesh) return;
      if (spec.castShadow !== undefined) o.castShadow = spec.castShadow;
      if (spec.receiveShadow !== undefined) o.receiveShadow = spec.receiveShadow;
    });
  }

  const handle = spec.setup
    ? await spec.setup({ ...ctx, spec, object: holder, gltf })
    : null;

  // a setup that built its own node says which one by returning `object`;
  // otherwise the thing to add is the one the loader already made
  ctx.scene.add((handle && handle.object) || holder);
  if (handle && handle.update) ctx.onFrame(handle.update);
  ctx.expose(spec.id, { ...(handle || {}), object: holder, spec });

  console.info(`[creek] ${spec.id} — in, at ${holder.position.toArray().map((v) => v.toFixed(1)).join(', ')}`);
}

/**
 * Load every model in the manifest. Returns immediately: each guest fetches in
 * parallel with the creek and with each other, and settles on its own.
 */
export function loadModels({ specs, ctx, loader }) {
  for (const spec of specs) {
    loadOne({ spec, ctx, loader }).catch((err) => {
      console.warn(`[creek] ${spec.id} — the creek carries on without it`, err);
      noteError(`model ${spec.id}`, err);
    });
  }
}
