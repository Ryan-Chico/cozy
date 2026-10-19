# cozy creek

A full-viewport animated creek. The bank, water bed, rocks, log, reeds, trees,
mushrooms and lanterns are a procedural Blender build exported to `assets/creek.glb`.
A toad came in from Sketchfab as `assets/monster.glb`. The water, fireflies and
sky are Three.js shaders. No build step, no bundler.

## Run it

```
npm start
```

then open <http://127.0.0.1:5173>.

It has to be **served** — the page fetches the `.glb`, which a `file://` page is
not allowed to do. If you open `index.html` directly you'll get a message saying so.

Anything modern with WebGL2 will do. `three` r0.186.1 is pulled from unpkg through
an import map in `index.html`, so the first load needs a network connection.

## What you're looking at

A slow creek running away from the camera, banks of grass, ferns and low shrubs,
stepping stones, a fallen log, fireflies drifting over the water. Dusk, warm and
hazy.

It opens on a composed shot. Move and you take the camera over: walk the banks,
or just stand and watch. `R` glides you back to where you started.

There is a breeze. It is not decoration — it travels in gusts down the creek,
swelling and easing, and every blade, frond and canopy in the scene bends from
its own root rather than sliding sideways.

There is a toad in the shallows, and it is aware of you. It works its way along
the waterline leaving faint rings in the water; come within about nine metres
and it stops and turns to face you; crowd it and it hops off down the creek.

| Action | How |
| --- | --- |
| Look around | drag — the world follows your hand, as on a map |
| Walk | `W` `A` `S` `D` or the arrow keys |
| Walk faster | hold `Shift` |
| Return to the opening shot | `R`, or `Esc` |
| Stir the water | move the pointer across it — no clicking needed |
| Drop a stone | click, or tap |
| Walk back home (touch) | double tap |

You're held at eye height on the terrain, and the creek is a wall rather than a
floor: you can walk down to the edge but never in. `prefers-reduced-motion`
quietly drops the idle drift.

One honest gap: only the ground and the water are solid. Trees, bushes and
boulders have no collision, so you can walk through them.

## How it's built

The split matters: **Blender owns the geometry, the browser owns the motion.**

glTF can carry meshes, vertex colours and a few material extensions — it cannot
carry Blender's procedural node trees. So everything that animates is
re-implemented in GLSL here instead of being baked. What survives the export is
the shape.

The water is the clearest case. Blender writes three numbers per vertex into
`COLOR_0` — depth, shore, and a flow noise — and the water shader reads them back
as `aData` to decide how deep and how fast each part of the surface is. That
baked data is what lets the shader know where the shallows and the stones are
without a depth buffer.

The breeze does the same trick from the other direction. Sway needs a weight
that is 0 at a plant's root and 1 at its tip, and the terrain heightmap hands
that over for free: height above the ground, over a per-species reference
height. `src/wind.js` bakes that into an `aSway` attribute at load, which also
means one shared material can drive every swaying mesh — the per-species reach
rides along inside the weight. No Blender changes, no extra draw calls.

Two consequences worth remembering. Every creek mesh exports with an identity
transform, so object space *is* world space and the shader can push vertices
directly instead of hauling a matrix around — a build that starts emitting real
node transforms would break that. And `patch()` runs the wind *before* the
surface-detail grain, because that grain is sampled from world position and has
to read the un-bent vertex; swap the order and the fine detail will shimmer as
the foliage moves.

Blender is Z-up and glTF is Y-up; the exporter maps `(x, y, z)` to `(x, z, -y)`.
The camera constants in `src/main.js` are the Blender ones after that swap.

## Files

| Path | What it is |
| --- | --- |
| `index.html` | Canvas, overlay type, loader, import map |
| `src/main.js` | Scene assembly, lighting, camera, input, render loop |
| `src/controls.js` | The camera rig: composed shot, walking, ground sampling |
| `src/monster.js` | The toad: its waterline path, hop cycle, wake and wariness |
| `src/heightmap.js` | Bilinear height sampler, shared by the walker, the toad and the wind |
| `src/wind.js` | The breeze: sway mask, gust field, and a shadow depth pass to match |
| `src/water.js` | The creek surface: waves, fresnel, depth colour, foam |
| `src/ripples.js` | Ping-pong damped wave field for the pointer rings |
| `src/fireflies.js` | One `Points` draw call; wander, blink, pointer attraction |
| `src/sky.js` | Gradient sky, sun glow, and the baked environment map |
| `server.mjs` | Zero-dependency static server (`npm start`) |
| `assets/creek.glb` | The exported model — ~193k tris, 5.9 MB |
| `assets/monster.glb` | The toad — 50k tris, 1.4 MB, imported from Sketchfab |
| `blender/build_creek.py` | The whole procedural build |
| `blender/build_monster.py` | Cleans up the imported toad and exports it |
| `blender/creek.blend` | Saved Blender scene |
| `tools/shot.mjs` | Headless-Chrome screenshot checker |

## Turning the knobs

Nearly everything worth changing is a named constant at the top of a file.

**Look and light** — `src/main.js`

| Constant | Effect |
| --- | --- |
| `CAM_POS`, `CAM_TARGET` | Where the shot is taken from |
| `CAM_FOV` | Vertical field of view (36 is tight and painterly) |
| `SUN_AZIMUTH`, `SUN_ELEVATION` | Sun position. 210/22 is behind-left, raking warm light |
| `FOG_COLOR`, `FOG_DENSITY` | The haze that gives the distance its depth |
| `renderer.toneMappingExposure` | Whole-frame brightness |
| the `sun` / `hemi` / `fill` lights | Key, ambient bounce, and cool fill |
| `new UnrealBloomPass(...)` | Bloom strength, radius, threshold |
| `uVignette`, `uGrain` | Corner falloff and film grain |

**Water** — `src/water.js`

| Constant | Effect |
| --- | --- |
| `WATER_COLORS` | Shallow, deep, bed, sky reflection, foam, sun |
| `amp[0..4]` | The five layered wave trains; `amp[0]` sets the swell |
| `uRippleStrength` | How hard the pointer disturbs the surface |

**Ripples** — `src/ripples.js`: `uSpeed` (how fast rings travel), `uDamping`
(how long they last), `uDropRadius` (how tight each one is).

**Fireflies** — `src/fireflies.js`: `count`, `uSize`, `uIntensity`, `uColorA/B`.

**Walking** — `src/controls.js`

| Constant | Effect |
| --- | --- |
| `EYE_HEIGHT` | How tall you stand above the ground |
| `WALK_SPEED`, `SPRINT_SPEED` | Walking pace, and how much `Shift` adds |
| `BOB_HEIGHT` | Head bob at walking pace, ramped by how fast you're actually moving |
| `LOOK_SENS` | Radians of turn per pixel dragged |
| `PITCH_LIMIT` | How far up and down you can look |
| `RETURN_SECONDS` | Length of the glide back to the opening shot |
| `WALK_BOUNDS` | How far you're allowed to roam, in `main.js` |
| `waterY` | Ground height below which the creek counts as a wall — raise it to keep further from the water |

**The toad** — `src/monster.js`

| Constant | Effect |
| --- | --- |
| `CRUISE_SPEED`, `FLEE_SPEED` | How fast it ambles, and how fast it bolts |
| `HOP_RATE`, `HOP_HEIGHT`, `SQUASH` | The gait: hops per second, how high, and how far the squash and stretch goes |
| `WADE_DEPTH` | How deep it stands in the shallows — this is what traces its path |
| `NOTICE_RADIUS`, `NOTICE_RELEASE` | How close you get before it stops and stares, and how far you retreat before it relaxes |
| `FLEE_RADIUS`, `FLEE_SECONDS` | When it bolts, and for how long |
| `DWELL_MIN`, `DWELL_MAX` | How long it loiters at each end of its beat |
| `WAKE_STEP`, `WAKE_STRENGTH` | How often it disturbs the water, and how hard |
| `PATH_X0`, `PATH_X1`, `START_X` | Which stretch of shore it patrols, and where it begins |
| `TARGET_SIZE` | The toad's length, in `blender/build_monster.py` |

**The breeze** — `src/wind.js`

| Constant | Effect |
| --- | --- |
| `SWAY_TYPES[].reach` | How far a tip travels, in metres — the main dial |
| `SWAY_TYPES[].ref` | How much height it takes to get there |
| `SWAY_TYPES[].exponent` | The curve on that ramp; higher keeps more of the plant still |
| `uWindStrength` | Runtime multiplier over the lot — the quickest way to taste-test |
| `uWindDir` | Prevailing direction; it wanders slowly around this |
| the three terms in `amp` | Baseline breeze, travelling gust, and local flutter |

The tree row is the one to get right. `ref` has to run the full height of a tree
rather than saturating at canopy level, or the canopy slides off the trunk as one
rigid lump instead of bending — and an over-high `exponent` does the same thing
from the other side. Under `prefers-reduced-motion` the whole thing runs at a
quarter strength rather than stopping dead.

**Sky** — `src/sky.js`: `uZenith`, `uHorizon`, `uGround`, `uSunColor`.
**The model** — `blender/build_creek.py`: `SEED` for a different scatter of
rocks, grass, ferns, shrubs and trees, and the `P` palette for every material
colour.

## Rebuilding the model

Needs Blender with the MCP addon running, then:

```python
exec(open(r"...\blender\build_creek.py").read())
build_all()      # clears the scene and rebuilds everything
report()         # poly counts
export_glb()     # writes assets/creek.glb
save_blend()
inspect_glb()    # confirms the water still carries its COLOR_0 attributes
```

`build_all()` is destructive — it wipes the scene first, so it is always safe to
re-run and never safe to re-run on a scene you have hand-edited.

If you change the shape of the creek, check `RIPPLE_ORIGIN` and `RIPPLE_SIZE` in
`src/main.js` still cover the water you can see; the ripple field only exists
inside that rectangle.

### The toad

The creature is deliberately kept out of `creek.glb`, so `build_all()` can never
clobber it. It is fetched from Sketchfab by the MCP import tool, then cleaned up
and exported on its own:

```python
# first, from the agent session -- this is the part that downloads:
#   import_asset(source="sketchfab", id="db8e45b28c9e495d8472b10f75d82847",
#                target_size=1.35)
exec(open(r"...\blender\build_monster.py").read())
run()            # bakes the imports, faces it, sizes it, writes assets/monster.glb
```

`run()` is idempotent, so it is safe to re-run against a scene that has already
been through it. It bakes the Sketchfab wrapper transforms into the mesh, works
out which way the toad is facing and turns that onto Blender `-Y` (which the
exporter maps to three.js `+Z` — the axis `Object3D.lookAt` aims at a target),
puts the origin at its feet, cuts the base colour to 1024, and exports with
textures embedded as JPEG.

Worth knowing: the asset is named `…_animated`, but it arrives with no armature
and no actions, so all of its movement is procedural in `src/monster.js`.

The toad walks the waterline from `x = -27` to `x = -3.5`. That stretch stops
short of the fallen log at `x ≈ 0` and the stepping stones at `x ≈ 4`, neither of
which it can climb. Widen `PATH_X0` / `PATH_X1` and it will try to walk through
them.

## Checking it

```
node server.mjs
node tools/shot.mjs http://127.0.0.1:5173/ shot.png 1600 900
```

Drives headless Chrome over the DevTools protocol, waits for `window.__creekReady`,
prints any console errors, then screenshots. WebGL runs on SwiftShader, so expect
~20s. Env knobs: `SETTLE_MS`, `WAIT_MS`, `CDP_PORT`, `CHROME`.

Set `MOVES` to drive the pointer before the shot — useful for checking the
interactive bits, which a still otherwise can't show:

```
MOVES="760,400 1000,520 1080,580" node tools/shot.mjs
```

`DRAG` and `KEYS` do the same for the camera, so walking can be checked in a
still too:

```
DRAG="800,300,800,215" KEYS="KeyW:2200,KeyD:3200" node tools/shot.mjs
```

`EVAL` runs before the first frame and `EVAL2` just before the second, so a
"before" and an "after" can be read in a single run — the page exposes
`window.__creek` for exactly this:

```
EVAL="window.__p0 = __creek.camera.position.toArray()" \
EVAL2="JSON.stringify({from: __p0, to: __creek.camera.position.toArray()})" \
OUT2=b.png node tools/shot.mjs ...
```

`EVAL2` can also restage the scene before the second shot, which is how the
toad's wariness gets checked (walk the camera up to it, then read `mode` back).

And because of that dt clamp, the quickest way to check anything slow — the toad
crossing its beat, say — is to drive the clock yourself:

```
EVAL2="for (let i=0;i<200;i++) { __creek.monster.update(0.05, i*0.05); __creek.ripples.update(0.05); }"
```

Timed input runs on the frame clock, not the wall clock: `main.js` clamps `dt` to
50ms, so under SwiftShader at a few frames per second anything you trigger
advances roughly ten times slower than it would on a real GPU. Give a `KEYS`
sequence seconds, not milliseconds, to see its effect.

## Credits

- **Toad** — "Standing_giant_toad_green_skin_animated" by
  [pikupila](https://sketchfab.com/pikupila), licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), via
  [Sketchfab](https://sketchfab.com/3d-models/db8e45b28c9e495d8472b10f75d82847).
  The credit is also shown quietly in the corner of the page, which is what the
  licence asks for.
- Everything else — geometry, shaders, motion — is built here.
