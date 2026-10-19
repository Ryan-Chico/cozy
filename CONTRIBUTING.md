# Adding a model

The creek is a place, and other people's things are allowed to be in it. A model
you add is a guest: it fetches its own file, the loader works out its size and
where it stands, and one line in the manifest puts it in the scene.

You do not need Blender, and you do not need to touch `src/`. If your model is a
`.glb` and a number for how big it is, you are nearly done.

## What belongs here

Anything that would plausibly be sitting by a quiet creek at dusk, or passing
over it. A heron, a rowboat, a leaning fence, a deer at the treeline, a paper
lantern caught in a branch. The B-17 is the proof that the loose end of that
brief is wide: it is a burning bomber, and it works because it is *somewhere*
rather than *anywhere*.

What does not belong: interfaces, text, logos, GIF-scale effects that only work
at one camera angle, or anything that needs the camera to stay put. The camera
is free — the shot opens composed, but a visitor can walk the banks. A model is
seen from wherever they stand.

One hard rule, and it is about the project rather than the model: **no build
step, no bundler, no dependencies.** A contribution that adds an `npm install`
to the path between "clone" and "run" will not be merged, however good the
model is. Everything here is a static file and a module import.

## Four steps

### 1. Make a folder

```
models/heron/
  model.glb
  index.js
```

The folder name should match the spec's `id`. It is not enforced, but it is the
only thing that keeps the tree readable once there are several guests.

### 2. Write the spec

```js
// models/heron/index.js
export default {
  id: 'heron',
  name: 'Heron',

  // Relative to THIS file, not to the page. That is the whole reason it is a
  // URL: the folder can be moved, and the import still points at its own model.
  model: new URL('./model.glb', import.meta.url),

  credit: {
    by: 'A. Contributor',
    licence: 'CC BY 4.0',
    via: 'Sketchfab',
    url: 'https://sketchfab.com/3d-models/...',
  },

  // How big it should be, in metres, across its longest axis. A heron standing
  // up is about 1 m tall.
  size: 1.0,

  // Where it stands. With `grounded`, y is measured from the terrain, so this
  // is "0.4 m above the ground at x = 4.2, z = -2.6".
  grounded: true,
  at: [4.2, 0.4, -2.6],

  // Which way it looks. 0 is whatever direction it faced in the export; the
  // heron wants to face the water, which is towards -z from that spot.
  face: 180,
};
```

That is a complete contribution. It will appear, be the right size, stand on
the bank, and put its author in the credit line.

### 3. Add one line to the manifest

```js
// models/index.js
import toad from './toad/index.js';
import b17 from './b17/index.js';
import heron from './heron/index.js';   // <-- here

export default [toad, b17, heron];
```

Order is the order they load and the order their `update` callbacks run. It
rarely matters, but it is deterministic.

### 4. Look at it

```
npm start
```

Then open <http://127.0.0.1:5173>. If the model is not there, the console will
say why — every failure path names the model and the reason.

## The spec, in full

Everything except `id`, `model` and `credit` is optional.

| Field | Type | What it does |
| --- | --- | --- |
| `id` | string | Unique. Becomes `window.__creek[id]` for debugging, and names the folder |
| `name` | string | Short human name for the credit line. Falls back to `id` |
| `model` | URL | `new URL('./model.glb', import.meta.url)` — a string is rejected, deliberately |
| `credit` | object | `{ by, licence, via?, work?, url? }`. See **Rights** below |
| `size` | number | Metres across the longest axis of whatever is measured |
| `measure` | string | Name of a node to measure instead of the whole model |
| `at` | `[x, y, z]` | Position in metres. Default `[0, 0, 0]` |
| `grounded` | boolean | `at[1]` is a height **above the terrain** rather than an absolute y. Implies `needs: ['creek']` |
| `face` | number | Yaw in degrees |
| `tilt` | number | Pitch in degrees — nose down / tail down |
| `roll` | number | Roll in degrees |
| `castShadow` | boolean | Applied to every mesh. Default: leave the model's own flags alone |
| `receiveShadow` | boolean | As above |
| `needs` | string[] | `['creek']` delays `setup` until the terrain and water exist |
| `selfPlaced` | boolean | Skips fit and placement entirely; your `setup` owns the transform |
| `setup` | function | `setup(ctx)` — see below. May return `{ object, update }` |

### How `size` and `at` actually work

`size` scales the model so its **longest axis** is that many metres, then moves
its origin onto its own **centre** — or onto its **feet** if `grounded` — so
`at` means the same thing for a pebble and for an airliner. Non-uniform exports
and odd origins are handled; you are saying how big the thing is, not what scale
factor to apply.

`grounded: true` with `at: [x, 0, z]` puts the model's lowest point exactly on
the ground. A small `y` floats it, which is what you want for something that
hangs.

`face` rotates about the vertical axis. A model whose nose points three.js `+Z`
turns towards `+X` at `face: 90` and faces away from you at `180`. If your model
arrives facing somewhere unexpected, the export is probably Blender: Blender is
Z-up and glTF is Y-up, and the exporter maps `(x, y, z)` onto `(x, z, -y)`, so
something facing Blender `-Y` arrives facing three.js `+Z`.

### When the model is bigger than its subject

Some models contain something much larger than the thing you are placing — smoke
plumes, muzzle flashes, an effect card, a ground plane the artist left in. Then
the model's bounding box describes the effect rather than the subject, and
`size` starts describing the wrong thing.

`measure` names a node to measure instead:

```js
size: 26,                // the wingspan, in metres
measure: 'B17_Hull',     // ...of the airframe, not of the trailing smoke
```

The named node is what both the size and the centre refer to. If the name is
wrong the loader says so by name rather than silently scaling to nothing.

## Making it do something

Most guests stand still, and the declarative spec above is all they need.

If yours needs more, `setup(ctx)` runs once, after the model has been fitted and
placed, and gets the scene's own systems. It may:

- return `{ update(dt, elapsed) }` and be called every frame
- return `{ object }` to say which node to add to the scene (default: the one the
  loader made)
- add things to `ctx.scene` itself — `models/toad/index.js` adds the tongue this
  way, because it is driven in world space and must not inherit the toad's
  transform
- return nothing at all, if it only wanted to adjust materials

### The context

Everything `main.js` uses itself. Treat this list as the stable part — if you
need something that is not on it, ask in an issue rather than reaching into
`__creek`.

| Name | What it is |
| --- | --- |
| `scene`, `camera`, `renderer` | The three.js objects, as you would expect |
| `spec`, `object`, `gltf` | Your spec, your placed model, the raw `GLTFLoader` result |
| `terrain` | The terrain mesh |
| `heightAt(x, z)` | Ground height in metres. `null` until the creek lands |
| `waterY` | The crack in the shoreline, `-0.05`. Raise it to keep things further from the water |
| `water`, `waterMat` | The creek surface and its shader |
| `ripples` | `ripples.drop(x, z, strength, radius?)` — rings on the water |
| `fireflies` | `.points`, `.uniforms`, `.count`, `.positionAt(i, out)`, `.isFlying(i)`, `.eat(i, mouth)`. The first two read `uniforms.uTime.value`, so if you drive your own clock you must drive that too |
| `lantern` | The glowing lantern mesh, `emissiveIntensity` flickering each frame |
| `sun`, `sky` | The key light, and the gradient sky sphere |
| `wind` | `.uniforms`, `.patch(material)`, `.depthMaterial`, `.update(elapsed)` |
| `walker` | The camera rig: hero shot, walking, `attachTerrain` |
| `reducedMotion` | `prefers-reduced-motion` at load. Damp, do not disable |
| `needs: ['creek']` → `creekReady` | A promise for the terrain and water. Resolves before `setup` runs |
| `onFrame(fn)` | The same thing as returning `{ update }`; use whichever reads better |
| `expose(key, value)` | `window.__creek[key] = value`, safely, whenever you run |

Two rules worth stating because they are easy to get wrong:

- **Do not move the camera.** Anything that needs a particular view is a
  screenshot, not a guest.
- **`reducedMotion` is a damp, not a switch.** The wind runs at a quarter
  strength rather than stopping. Follow that: slow down, do not freeze.

### If your model owns its own transform

`selfPlaced: true` hands you the raw `gltf.scene` with no fit, no placement and
no rotation, and skips `at`/`size`/`face` entirely. Use it if the model walks a
path in world metres or manages its own scale — `models/toad/index.js` is the
example, and its header explains why a wrapper would fight with it.

If you only want to move a model that is otherwise placed, do that in `update`
and leave the flag off.

## Rights and attribution

**Every guest needs a `credit.by`.** This is not a formality: both built-in
models are CC BY, which obliges anyone showing them to name the author, and the
credit line in the page corner is generated from these blocks. A spec without
one is a console warning *and* a failed check — shipping someone's model without
naming them is worse than shipping it badly.

```js
credit: {
  work: 'Standing_giant_toad_green_skin_animated',   // the asset's own title
  by: 'pikupila',
  licence: 'CC BY 4.0',
  via: 'Sketchfab',
  url: 'https://sketchfab.com/3d-models/db8e45b28c9e495d8472b10f75d82847',
},
```

Only `by` is required to load; give the rest so the README's Credits section can
link to the source. If you want to contribute a model you did not make, check
its licence permits redistribution **and** this kind of use, and say where it
came from in the pull request. Do not contribute ripped game assets.

The code is MIT (see `LICENSE`). That does not cover the models.

## Size

The whole scene downloads before it shows you anything, so every model is paid
for by everyone on every first visit. `npm run check` prints the running total
and fails if a guest goes over 5 MB or 250k triangles, or the guests together go
over 10 MB or 500k.

Those numbers are the current scene's own measurements, not laws. If you need
more, say why and raise them in the same commit. What is not negotiable is the
page staying something you would wait for on a phone.

## Testing it

```
npm run check                                   # budgets
npm start                                       # then look at it
node tools/shot.mjs http://127.0.0.1:5173/ shot.png 1600 900
```

`shot.mjs` drives headless Chrome, waits for `window.__creekReady`, and exits
non-zero if the page threw or never came up — so it is the same check CI runs.
It also writes the screenshot either way, which matters: when it fails, the
picture is the evidence.

Set `EVAL` to poke at your model before the shot:

```
EVAL="__creek.heron.object.position.toArray()"
```

Or to stand somewhere specific and look at it, which is the only way to see a
small prop in a still:

```
EVAL="__creek.walker.update = () => {}; __creek.camera.position.set(2, 1.6, -2); __creek.camera.lookAt(4.2, 1, -2.6)"
```

`walker.update` has to be stubbed first, or the rig puts the camera back on its
own every frame.

The page exposes `window.__creek`, including `__creek[id]` for every guest, so
anything you can see you can also measure.

## Things that will look wrong first

Nearly every imported model needs the same two corrections, and both have the
same cause: this is a dim scene with a cheap environment map, and assets are
usually authored for a bright studio.

**It renders as a black silhouette.** The asset is metallic. There is nothing
bright enough here to reflect, so a rough metal has nothing to show. Cut the
metalness:

```js
setup({ object }) {
  object.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material)) if (m) m.metalness = 0;
  });
},
```

**It is too dark against the water, or too bright.** Set `envMapIntensity`, and
lift the base colour slightly. The toad uses `1.0` and a lift of
`setRGB(1.14, 1.18, 1.10)`; the B-17 uses `1.15` and `setRGB(1.16, 1.14, 1.10)`.
The scene's own meshes sit at `0.6`.

**The file is enormous.** Textures are the size of a model, not its polygons.
Cut them to 1024 and let opaque maps go to JPEG — the exporter only does that if
you write the image out through disk and read it back, which is what
`blender/build_b17.py` does and explains. PNG is only for alpha.

**It is the wrong way round.** See `face`. If that does not fix it, check
whether the export kept a wrapper node with a transform on it — the loader
preserves whatever the file says rather than normalising it away.

**It is floating, or half underground.** With `grounded: true` the model's
lowest point lands exactly on the terrain. If your export has a stray particle
or a stray vertex below the feet, the bounding box includes it; `measure` fixes
that the same way it fixes an oversized effect.

**It is in the wrong place entirely.** Objects sit at `at` by the *centre* of
their bounding box unless `grounded`, and z is negative towards the near bank.
The camera opens at `(-18, 2, -4.6)` looking at `(18, 0.1, -1.5)`.

## Getting it merged

- One model per pull request, with its own folder.
- `npm run check` and a screenshot in the description.
- Say where the model came from and under what licence.
- If it does something, a sentence on what and why is worth more than a
  paragraph on how.

Small things are welcome. A good heron is worth more than a second aircraft.
