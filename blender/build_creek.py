"""
build_creek.py -- procedurally build a cozy creek scene in Blender and export it
to assets/creek.glb for the Three.js page.

Usage (inside Blender, via MCP execute_blender_code):
    exec(open(r"C:\\Users\\ryanc\\projects\\cozy\\blender\\build_creek.py").read())
    build_all()

Individual steps can be re-run on their own, e.g. build_terrain(), build_rocks().
Everything is seeded, so results are reproducible.
"""

import bpy
import bmesh
import math
import os
import random
from mathutils import Vector, Matrix, noise as mnoise

PROJECT = r"C:\Users\ryanc\projects\cozy"
ASSETS = os.path.join(PROJECT, "assets")
BLEND = os.path.join(PROJECT, "blender", "creek.blend")

# scene extents (metres, Blender Z-up). The creek runs along +X.
X0, X1 = -32.0, 32.0
Y0, Y1 = -14.0, 14.0
NX, NY = 144, 104          # terrain grid
WATER_Z = 0.0              # waterline
SEED = 7

# the shot: on the near bank, low, looking down the creek
CAM_POS = (-18.0, 4.6, 2.00)
CAM_TARGET = (18.0, 1.5, 0.10)
CAM_CLEAR = 10.5           # keep big props out of this radius around the camera


# --------------------------------------------------------------------- maths

def n(x, y, z=0.0):
    """Signed Perlin noise in roughly [-1, 1]."""
    return mnoise.noise(Vector((x, y, z)))


def clamp(v, a=0.0, b=1.0):
    return a if v < a else (b if v > b else v)


def smoothstep(a, b, x):
    t = clamp((x - a) / (b - a)) if b != a else 0.0
    return t * t * (3.0 - 2.0 * t)


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexc(s):
    s = s.lstrip("#")
    r, g, b = (int(s[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b))


def mixc(a, b, t):
    t = clamp(t)
    return (a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
            a[2] + (b[2] - a[2]) * t)


def vary(c, amt, seed):
    f = 1.0 + amt * n(seed * 13.7, seed * 7.3, seed * 3.1)
    return (clamp(c[0] * f), clamp(c[1] * f), clamp(c[2] * f))


P = {
    "bed_deep":    hexc("#463f34"),
    "bed_pebble":  hexc("#6a6459"),
    "sand_wet":    hexc("#7a6b52"),
    "sand_dry":    hexc("#9c8a6b"),
    "grass_dark":  hexc("#3c5730"),
    "grass_mid":   hexc("#527239"),
    "grass_light": hexc("#6a8a4b"),
    "dirt":        hexc("#63513f"),
    "moss":        hexc("#4d6b33"),
    "moss_light":  hexc("#6b8a42"),
    "rock_light":  hexc("#9d978d"),
    "rock_mid":    hexc("#7e7a72"),
    "rock_dark":   hexc("#5c5a54"),
    "bark":        hexc("#5b4632"),
    "bark_dark":   hexc("#41301f"),
    "canopy_dark": hexc("#2c4626"),
    "canopy_mid":  hexc("#3d5c31"),
    "canopy_lite": hexc("#527437"),
    "reed":        hexc("#8a9a3f"),
    "reed_tip":    hexc("#b6bb60"),
    "fern":        hexc("#3f6b33"),
    "cap":         hexc("#b8452f"),
    "stem":        hexc("#ded2b8"),
    "glow":        hexc("#ffb45c"),
    "lily":        hexc("#436b34"),
    "water":       hexc("#3f6e68"),
    "wet_stone":   hexc("#4a4a48"),
}


# --------------------------------------------------------------- creek shape

def half_width(x):
    """Waterline half-width of the channel at station x."""
    return (4.6
            + 1.10 * math.sin(x * 0.16)
            + 0.70 * math.sin(x * 0.41 + 2.0)
            + 0.50 * math.sin(x * 0.07 + 0.4))


def channel_depth(x):
    return 1.15 + 0.30 * math.sin(x * 0.11 + 0.7) + 0.15 * math.sin(x * 0.35 + 2.2)


def ground_z(x, y):
    """Terrain height. 0.0 is the waterline, the channel bottom is negative."""
    w = half_width(x)
    d = channel_depth(x)
    t = abs(y) / w
    if t < 1.0:
        z = -d * ((1.0 - t * t) ** 1.6)
    else:
        # u is how far past the waterline we are. The old form of this added
        # 0.09 * abs(y), which is ~0.4m at the waterline itself and put a cliff
        # right at the shore; measuring from the waterline keeps the beach smooth.
        u = t - 1.0
        z = 0.55 * (u ** 1.35) + 0.22 * u + 0.09 * (abs(y) - w)
    damp = clamp((t - 0.85) / 0.55)
    z += damp * (0.50 * n(x * 0.055, y * 0.055) + 0.16 * n(x * 0.17, y * 0.17))
    z += damp * (0.115 * n(x * 0.55, y * 0.55) + 0.048 * n(x * 1.15, y * 1.15))
    z += 0.045 * n(x * 0.55, y * 0.55) * (0.35 + 0.65 * damp)
    return z


def water_depth(x, y):
    return max(0.0, WATER_Z - ground_z(x, y))


# --------------------------------------------------------------- accumulators

class Acc:
    """Collects transformed geometry and per-vertex colour into a single mesh."""

    def __init__(self, name):
        self.name = name
        self.v = []
        self.f = []
        self.c = []

    def add(self, verts, faces, mat=None, color_fn=None):
        base = len(self.v)
        for co in verts:
            p = Vector(co)
            if mat is not None:
                p = mat @ p
            self.v.append((p.x, p.y, p.z))
            self.c.append(color_fn(p) if color_fn else (1.0, 1.0, 1.0))
        for fc in faces:
            self.f.append(tuple(base + i for i in fc))
        return self

    def add_bm(self, bm, mat=None, color_fn=None):
        bm.verts.ensure_lookup_table()
        verts = [v.co.copy() for v in bm.verts]
        faces = [tuple(v.index for v in f.verts) for f in bm.faces]
        self.add(verts, faces, mat, color_fn)
        bm.free()
        return self

    def build(self, mat=None, smooth=True):
        me = bpy.data.meshes.new(self.name)
        me.from_pydata(self.v, [], self.f)
        me.validate(verbose=False)
        attr = me.color_attributes.new(name="Col", type='FLOAT_COLOR', domain='POINT')
        for i, c in enumerate(self.c):
            if i < len(attr.data):
                attr.data[i].color = (c[0], c[1], c[2], 1.0)
        if smooth:
            for p in me.polygons:
                p.use_smooth = True
        ob = bpy.data.objects.new(self.name, me)
        bpy.context.scene.collection.objects.link(ob)
        if mat is not None:
            me.materials.append(mat)
        return ob


def new_ico(subdiv=1, radius=1.0):
    bm = bmesh.new()
    try:
        bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    except TypeError:
        bmesh.ops.create_icosphere(bm, subdivisions=subdiv, diameter=radius)
    return bm


def blob(subdiv=1, radius=1.0, amp=0.32, freq=1.3, offset=(0, 0, 0), squash=1.0, seed=0.0,
         angular=0.0):
    """A noise-displaced icosphere: the base shape for rocks, pebbles, canopies."""
    bm = new_ico(subdiv, radius)
    o = Vector((offset[0] + seed * 5.1, offset[1] - seed * 2.7, offset[2] + seed * 1.9))
    for v in bm.verts:
        p = v.co
        f = 1.0 + amp * n(p.x * freq + o.x, p.y * freq + o.y, p.z * freq + o.z)
        if angular:
            # a second, coarser octave plus a soft step: reads as chipped stone
            big = n(p.x * freq * 0.42 + o.x * 1.7, p.y * freq * 0.42 + o.y * 1.7,
                    p.z * freq * 0.42 + o.z * 1.3)
            f += angular * (big + 0.35 * math.copysign(abs(big) ** 0.6, big))
        v.co = Vector((p.x * f, p.y * f, p.z * f * squash))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def flatten_bottom(bm, cut=-0.35, soft=0.3):
    for v in bm.verts:
        if v.co.z < cut:
            v.co.z = cut + (v.co.z - cut) * soft


def tube(pts, radii, sides=8, cap_start=True, cap_end=True, wobble=0.06):
    """Lofted tube along a polyline. Used for logs, trunks, stems, lantern posts."""
    pts = [Vector(p) for p in pts]
    cnt = len(pts)
    if cnt < 2:
        return [], []
    tangents = []
    for i in range(cnt):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == cnt - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        tangents.append(t.normalized())

    verts = []
    for i in range(cnt):
        t = tangents[i]
        ref = Vector((0.0, 0.0, 1.0))
        if abs(t.z) > 0.9:
            ref = Vector((0.0, 1.0, 0.0))
        nrm = ref.cross(t).normalized()
        bino = t.cross(nrm).normalized()
        r = radii[i]
        for k in range(sides):
            a = 2.0 * math.pi * k / sides
            rr = r * (1.0 + wobble * math.sin(a * 3.0 + pts[i].x * 2.0 + pts[i].z))
            verts.append(tuple(pts[i] + nrm * (math.cos(a) * rr) + bino * (math.sin(a) * rr)))

    faces = []
    for i in range(cnt - 1):
        for k in range(sides):
            a = i * sides + k
            b = i * sides + (k + 1) % sides
            c = (i + 1) * sides + (k + 1) % sides
            d = (i + 1) * sides + k
            faces.append((a, b, c, d))
    if cap_start:
        faces.append(tuple(range(sides - 1, -1, -1)))
    if cap_end:
        faces.append(tuple(range((cnt - 1) * sides, cnt * sides)))
    return verts, faces


def blade(base, height, lean, sides=3, segs=2, r0=0.030, r1=0.004, curve=0.35):
    """A single tapering, curving blade of grass or reed."""
    bx, by, bz = base
    dx, dy = lean
    pts, rad = [], []
    for i in range(segs + 1):
        t = i / float(segs)
        pts.append((bx + dx * t * height,
                    by + dy * t * height,
                    bz + height * t - curve * height * t * t * 0.55))
        rad.append(r0 + (r1 - r0) * (t ** 0.7))
    return tube(pts, rad, sides=sides, cap_start=False, wobble=0.0)


def mat_trs(loc=(0, 0, 0), scale=(1, 1, 1), rotz=0.0, tilt=0.0, tilt_axis=0.0):
    m = Matrix.Translation(Vector(loc))
    m = m @ Matrix.Rotation(rotz, 4, 'Z')
    if tilt:
        axis = Vector((math.cos(tilt_axis), math.sin(tilt_axis), 0.0))
        m = m @ Matrix.Rotation(tilt, 4, axis)
    m = m @ Matrix.Diagonal(Vector((scale[0], scale[1], scale[2], 1.0)))
    return m


# ----------------------------------------------------------------- materials

def make_materials():
    mats = {}

    m = bpy.data.materials.get("MAT_nature") or bpy.data.materials.new("MAT_nature")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(nd for nd in nt.nodes if nd.type == 'BSDF_PRINCIPLED')
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    vc.location = (-320, 120)
    nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Metallic"].default_value = 0.0
    bsdf.inputs["Roughness"].default_value = 0.86
    m.use_backface_culling = False
    mats["nature"] = m

    m = bpy.data.materials.get("MAT_water") or bpy.data.materials.new("MAT_water")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = next(nd for nd in nt.nodes if nd.type == 'BSDF_PRINCIPLED')
    # placeholder only: the real water is a shader in the Three.js page.
    # unlit and flat, so Blender previews stay readable at grazing angles.
    wet = hexc("#7fb0aa")
    bsdf.inputs["Roughness"].default_value = 1.0
    for key in ("Specular IOR Level", "Specular"):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = 0.0
            break
    for key in ("Emission Color", "Emission"):
        if key in bsdf.inputs:
            bsdf.inputs[key].default_value = (wet[0], wet[1], wet[2], 1.0)
            break
    if "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = 1.0
    # the water mesh carries depth/shore/flow in COLOR_0 for the Three.js water
    # shader. The glTF exporter only writes COLOR_0 for materials that actually
    # reference the colour attribute, so wire it into Base Color.
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    vc.location = (-320, 120)
    nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    mats["water"] = m

    m = bpy.data.materials.get("MAT_glow") or bpy.data.materials.new("MAT_glow")
    m.use_nodes = True
    bsdf = next(nd for nd in m.node_tree.nodes if nd.type == 'BSDF_PRINCIPLED')
    bsdf.inputs["Base Color"].default_value = (P["glow"][0], P["glow"][1], P["glow"][2], 1.0)
    if "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = (1.0, 0.62, 0.26, 1.0)
    elif "Emission" in bsdf.inputs:
        bsdf.inputs["Emission"].default_value = (1.0, 0.62, 0.26, 1.0)
    if "Emission Strength" in bsdf.inputs:
        bsdf.inputs["Emission Strength"].default_value = 6.0
    mats["glow"] = m

    return mats


# -------------------------------------------------------------------- scene

def clear():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights,
                 bpy.data.cameras, bpy.data.curves, bpy.data.images):
        for item in list(coll):
            try:
                coll.remove(item)
            except Exception:
                pass
    print("cleared scene")


def build_terrain():
    verts, cols, faces = [], [], []
    for iy in range(NY + 1):
        y = Y0 + (Y1 - Y0) * iy / NY
        for ix in range(NX + 1):
            x = X0 + (X1 - X0) * ix / NX
            z = ground_z(x, y)
            verts.append((x, y, z))
            cols.append(terrain_color(x, y, z))
    for iy in range(NY):
        for ix in range(NX):
            a = iy * (NX + 1) + ix
            faces.append((a, a + 1, a + NX + 2, a + NX + 1))

    me = bpy.data.meshes.new("Terrain")
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    attr = me.color_attributes.new(name="Col", type='FLOAT_COLOR', domain='POINT')
    for i, c in enumerate(cols):
        attr.data[i].color = (c[0], c[1], c[2], 1.0)
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new("Terrain", me)
    bpy.context.scene.collection.objects.link(ob)
    print("terrain: %d verts, %d quads" % (len(verts), len(faces)))
    return ob


def terrain_color(x, y, z):
    e = 0.25
    dzx = (ground_z(x + e, y) - ground_z(x - e, y)) / (2.0 * e)
    dzy = (ground_z(x, y + e) - ground_z(x, y - e)) / (2.0 * e)
    slope = math.hypot(dzx, dzy)
    m = n(x * 0.31, y * 0.31, 4.0)
    g = n(x * 0.9, y * 0.9, 9.0)
    fine = n(x * 1.2, y * 1.2, 23.0)
    # broad drifts across the banks. Without them the ground away from the water
    # is one flat green, and it reads as a painted ramp the moment you walk on it
    patch = n(x * 0.075, y * 0.075, 41.0)
    worn = n(x * 0.26, y * 0.26, 53.0)

    c = mixc(P["grass_dark"], P["grass_mid"], clamp(0.5 + 0.6 * m))
    c = mixc(c, P["grass_light"], clamp(0.35 + 0.5 * g))
    c = mixc(c, P["moss"], smoothstep(0.34, 0.82, patch) * 0.68)
    c = mixc(c, P["sand_dry"], smoothstep(0.62, 0.95, patch) * 0.46)
    c = mixc(c, P["dirt"], smoothstep(0.70, 0.97, worn) * 0.38 * smoothstep(0.6, 1.6, z))
    c = mixc(c, P["grass_dark"], clamp(0.5 - 0.6 * fine) * 0.30)
    c = mixc(c, P["sand_dry"], (1.0 - smoothstep(0.05, 0.75, z)) * 0.85)
    c = mixc(c, P["sand_wet"], 1.0 - smoothstep(-0.65, 0.02, z))
    c = mixc(c, P["bed_pebble"], (1.0 - smoothstep(-1.15, -0.50, z)) * 0.9)
    c = mixc(c, P["bed_deep"], (1.0 - smoothstep(-1.35, -0.90, z)) * 0.7)
    c = mixc(c, P["dirt"], smoothstep(0.55, 1.15, slope) * 0.8)
    c = mixc(c, P["moss"], clamp(n(x * 0.2, y * 0.2, 17.0)) * 0.35 * smoothstep(0.4, 1.2, z))
    return vary(c, 0.14, x * 0.7 + y * 1.3)


def build_water():
    """Flat ribbon that follows the channel, with depth/shore baked into COLOR_0."""
    nx, nrow = 240, 6
    verts, cols, faces = [], [], []
    xs = [X0 + 1.0 + (X1 - X0 - 2.0) * i / nx for i in range(nx + 1)]
    for i, x in enumerate(xs):
        w = half_width(x) * 1.14
        for j in range(nrow + 1):
            y = -w + 2.0 * w * j / nrow
            d = water_depth(x, y)
            verts.append((x, y, WATER_Z))
            depth01 = clamp(d / 1.8)
            shore = 1.0 - smoothstep(0.0, 0.32, d)
            flow = 0.5 + 0.5 * n(x * 0.12, y * 0.12, 31.0)
            cols.append((depth01, shore, flow))
    for i in range(nx):
        for j in range(nrow):
            a = i * (nrow + 1) + j
            faces.append((a, a + nrow + 1, a + nrow + 2, a + 1))

    me = bpy.data.meshes.new("Water")
    me.from_pydata(verts, [], faces)
    me.validate(verbose=False)
    attr = me.color_attributes.new(name="Col", type='FLOAT_COLOR', domain='POINT')
    for i, c in enumerate(cols):
        attr.data[i].color = (c[0], c[1], c[2], 1.0)
    ob = bpy.data.objects.new("Water", me)
    bpy.context.scene.collection.objects.link(ob)
    print("water: %d verts" % len(verts))
    return ob


def rock_color(p, seed, pal_light=None, pal_mid=None, pal_dark=None):
    pl = pal_light or P["rock_light"]
    pm = pal_mid or P["rock_mid"]
    pd = pal_dark or P["rock_dark"]
    k = n(p.x * 1.7 + seed, p.y * 1.7, p.z * 2.3)
    c = mixc(pm, pl, clamp(0.5 + 0.9 * k))
    c = mixc(c, pd, clamp(0.5 - 0.7 * canup(p)))
    # stones sitting in the water read darker and sleeker
    wet = 1.0 - smoothstep(0.02, 0.48, p.z)
    c = mixc(c, mixc(c, P["wet_stone"], 0.75), wet)
    return vary(c, 0.10, seed + p.x)


def canup(p):
    return n(p.x * 0.8, p.y * 0.8, p.z * 0.8 + 13.0)


R_ROCK = (hexc("#7b7468"), hexc("#615a4f"), hexc("#494640"))
R_ROCK2 = (hexc("#786e60"), hexc("#5c5446"), hexc("#453f36"))
R_ROCK3 = (hexc("#847d72"), hexc("#69635a"), hexc("#4d4841"))


def build_rocks():
    random.seed(SEED)
    acc = Acc("Rocks")
    count = 0
    while count < 54:
        x = random.uniform(X0 + 3, X1 - 3)
        w = half_width(x)
        roll = random.random()
        if roll < 0.45:                      # in the stream
            y = random.uniform(-0.55, 0.55) * w
            big = random.random() < 0.55
        elif roll < 0.78:                    # waterline
            s = random.choice([-1.0, 1.0])
            y = s * w * random.uniform(0.85, 1.15)
            big = random.random() < 0.35
        else:                                # on the banks
            s = random.choice([-1.0, 1.0])
            y = s * (w + random.uniform(0.6, 4.5))
            big = random.random() < 0.30

        size = random.uniform(0.85, 1.7) if big else random.uniform(0.22, 0.7)

        # keep the camera's foreground readable: nothing large right in front of the lens
        d = math.hypot(x - CAM_POS[0], y - CAM_POS[1])
        if d < CAM_CLEAR:
            if size > 0.42 or d < CAM_CLEAR * 0.62:
                continue
            size *= 0.55

        sub = 3 if size > 0.9 else (2 if size > 0.35 else 1)
        seed = count * 3.7
        bm = blob(subdiv=sub, radius=size, amp=0.26, freq=1.15 / max(size, 0.2),
                  offset=(12.3, 4.4, 7.1), squash=random.uniform(0.58, 0.82),
                  seed=seed, angular=0.16)
        flatten_bottom(bm, cut=-size * 0.45, soft=0.35)
        z = ground_z(x, y) + size * random.uniform(0.05, 0.28)
        m = mat_trs(loc=(x, y, z),
                    scale=(random.uniform(0.9, 1.3), random.uniform(0.9, 1.3), 1.0),
                    rotz=random.uniform(0, 6.283),
                    tilt=random.uniform(-0.28, 0.28),
                    tilt_axis=random.uniform(0, 6.283))
        pal = random.choice([R_ROCK, R_ROCK2, R_ROCK3])
        acc.add_bm(bm, m, lambda p, s=seed, pl=pal: rock_color(p, s, pal_light=pl[0],
                                                              pal_mid=pl[1], pal_dark=pl[2]))
        count += 1
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("rocks: %d" % count)


def build_pebbles():
    random.seed(SEED + 3)
    acc = Acc("Pebbles")
    count = 0
    for i in range(260):
        x = random.uniform(X0 + 4, X1 - 4)
        w = half_width(x)
        y = random.uniform(-0.88, 0.88) * w
        size = random.uniform(0.05, 0.20)
        seed = i * 1.31
        bm = blob(subdiv=1, radius=size, amp=0.38, freq=2.1 / size * 0.25,
                  offset=(3.1, 9.7, 2.2), squash=random.uniform(0.55, 0.8), seed=seed)
        flatten_bottom(bm, cut=-size * 0.4, soft=0.4)
        z = ground_z(x, y) + size * random.uniform(-0.15, 0.25)
        m = mat_trs(loc=(x, y, z), scale=(random.uniform(0.85, 1.25),
                                          random.uniform(0.85, 1.25), 1.0),
                    rotz=random.uniform(0, 6.283),
                    tilt=random.uniform(-0.4, 0.4),
                    tilt_axis=random.uniform(0, 6.283))
        acc.add_bm(bm, m, lambda p, s=seed: rock_color(p, s, pal_light=hexc("#8d8577"),
                                                       pal_mid=hexc("#6f6a5f"),
                                                       pal_dark=hexc("#544f47")))
        count += 1
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("pebbles: %d" % count)


def build_log():
    """A mossy fallen log sagging across the creek, plus a few stub branches."""
    acc = Acc("Log")
    path = [(-1.4, 7.9, 1.05), (-0.9, 5.0, 0.62), (-0.2, 2.0, 0.30),
            (0.5, -1.5, 0.22), (1.1, -4.6, 0.52), (1.6, -7.2, 0.98)]
    radii = [0.36, 0.35, 0.33, 0.31, 0.28, 0.25]
    verts, faces = tube(path, radii, sides=11, cap_start=True, cap_end=True, wobble=0.10)

    def log_axis(p):
        """Interpolate the log's centreline (and radius) at the vertex's y."""
        ys = [q[1] for q in path]
        yy = clamp(p.y, ys[-1], ys[0])
        for k in range(len(path) - 1):
            if ys[k] >= yy >= ys[k + 1]:
                f = (ys[k] - yy) / (ys[k] - ys[k + 1])
                c = Vector(path[k]).lerp(Vector(path[k + 1]), f)
                r = radii[k] + (radii[k + 1] - radii[k]) * f
                return c, r
        return Vector(path[0]), radii[0]

    def log_color(p):
        cen, r = log_axis(p)
        above = clamp((p.z - cen.z) / max(r, 0.01))          # -1 under, +1 on top
        grain = n(p.x * 1.7, p.y * 1.7, 5.0) * 0.5 + 0.5
        c = mixc(P["bark"], P["bark_dark"], clamp(0.5 - 0.7 * n(p.x * 2.1, p.y * 2.1, 3.3)))
        # moss creeps over the upper surface, thicker in patches
        mossy = clamp((above - 0.05) * 1.6) * (0.35 + 0.85 * grain)
        c = mixc(c, mixc(P["moss"], P["moss_light"], grain), clamp(mossy))
        return vary(c, 0.12, p.x * 1.9)

    acc.add(verts, faces, None, log_color)

    # stub branches
    random.seed(SEED + 11)
    for i in range(5):
        t = random.uniform(0.15, 0.85)
        idx = t * (len(path) - 1)
        i0 = int(idx)
        i1 = min(i0 + 1, len(path) - 1)
        f = idx - i0
        base = Vector(path[i0]).lerp(Vector(path[i1]), f)
        ang = random.uniform(0, 6.283)
        ln = random.uniform(0.35, 0.85)
        tip = base + Vector((math.cos(ang) * 0.25, math.sin(ang) * 0.25, ln))
        mid = base.lerp(tip, 0.5) + Vector((0, 0, 0.08))
        v, fc = tube([tuple(base), tuple(mid), tuple(tip)],
                     [0.10, 0.065, 0.03], sides=6, wobble=0.14)
        acc.add(v, fc, None, lambda p: vary(mixc(P["bark_dark"], P["bark"], 0.5), 0.12, p.z * 3.0))

    # moss lumps on top
    for i in range(14):
        t = random.uniform(0.05, 0.95)
        idx = t * (len(path) - 1)
        i0 = int(idx)
        i1 = min(i0 + 1, len(path) - 1)
        base = Vector(path[i0]).lerp(Vector(path[i1]), idx - i0)
        off = random.uniform(-0.16, 0.16)
        r = random.uniform(0.10, 0.24)
        bm = blob(subdiv=1, radius=r, amp=0.42, freq=3.2, offset=(7.7, 1.3, 5.9),
                  squash=0.55, seed=i * 2.3)
        m = mat_trs(loc=(base.x + off, base.y + off * 0.4, base.z + 0.26),
                    rotz=random.uniform(0, 6.283))
        acc.add_bm(bm, m, lambda p: vary(mixc(P["moss"], P["moss_light"],
                                             clamp(0.4 + 0.6 * n(p.x * 3.0, p.y * 3.0, 2.0))),
                                         0.12, p.x * 2.0))
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("log built")


def build_stones():
    """Stepping stones crossing the creek."""
    random.seed(SEED + 5)
    acc = Acc("Stones")
    x_cross = 5.2
    for i in range(6):
        y = -4.6 + i * 1.84
        x = x_cross + random.uniform(-0.5, 0.5)
        r = random.uniform(0.62, 0.92)
        bm = blob(subdiv=2, radius=r, amp=0.24, freq=1.5, offset=(2.2, 8.8, 4.4),
                  squash=0.80, seed=i * 4.1)
        for v in bm.verts:
            if v.co.z < -0.18:
                v.co.z = -0.18 + (v.co.z + 0.18) * 0.30
        m = mat_trs(loc=(x, y, WATER_Z + random.uniform(0.02, 0.12)),
                    scale=(1.0, 1.0, 1.0), rotz=random.uniform(0, 6.283))
        acc.add_bm(bm, m, lambda p, s=i: rock_color(p, s * 2.0, pal_light=hexc("#948d80"),
                                                    pal_mid=hexc("#77726a"),
                                                    pal_dark=hexc("#57544e")))
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("stones: 6")


def build_reeds():
    random.seed(SEED + 7)
    acc = Acc("Reeds")
    clusters = 34
    blades = 0
    for ci in range(clusters):
        x = random.uniform(X0 + 5, X1 - 5)
        w = half_width(x)
        s = random.choice([-1.0, 1.0])
        cy = s * w * random.uniform(0.92, 1.30)
        cz = ground_z(x, cy)
        for b in range(random.randint(7, 16)):
            ox = random.uniform(-0.55, 0.55)
            oy = random.uniform(-0.45, 0.45)
            h = random.uniform(0.55, 1.55)
            ang = random.uniform(0, 6.283)
            lean = random.uniform(0.06, 0.30)
            bx, by, bz = x + ox, cy + oy, ground_z(x + ox, cy + oy) - 0.06
            v, f = blade((bx, by, bz), h, (math.cos(ang) * lean, math.sin(ang) * lean),
                         sides=3, segs=2, r0=0.032, r1=0.004, curve=0.42)
            tip = bz + h
            acc.add(v, f, None, lambda p, bz=bz, h=h: vary(mixc(
                mixc(P["reed"], P["reed_tip"], clamp((p.z - bz) / max(h, 0.01))),
                P["grass_dark"], 0.35), 0.12, p.x * 4.0 + p.y))
            blades += 1
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("reeds: %d clusters, %d blades" % (clusters, blades))


def build_grass():
    """Grass clumps rather than scattered single blades, so it reads as turf."""
    random.seed(SEED + 9)
    acc = Acc("Grass")
    count = 0
    clumps = 0
    for c in range(1150):
        x = random.uniform(X0 + 3, X1 - 3)
        w = half_width(x)
        s = random.choice([-1.0, 1.0])
        # sqrt spreads clumps by area rather than by distance from the water, so
        # the upper banks fill in instead of piling every tuft along the edge
        reach = random.uniform(0.0, 1.0) ** 0.5 * 12.5
        cy = s * (w * random.uniform(1.02, 1.5) + reach)
        if ground_z(x, cy) < -0.02:
            continue
        clumps += 1
        for b in range(random.randint(5, 9)):
            bx = x + random.uniform(-0.30, 0.30)
            by = cy + random.uniform(-0.24, 0.24)
            z = ground_z(bx, by)
            if z < -0.02:
                continue
            h = random.uniform(0.09, 0.30)
            ang = random.uniform(0, 6.283)
            lean = random.uniform(0.14, 0.55)
            v, f = blade((bx, by, z - 0.03), h,
                         (math.cos(ang) * lean, math.sin(ang) * lean),
                         sides=3, segs=2, r0=0.034, r1=0.004, curve=0.5)
            acc.add(v, f, None, lambda p, z=z: vary(mixc(
                mixc(P["grass_dark"], P["grass_mid"], 0.72),
                P["grass_light"], clamp(0.35 + 0.65 * n(p.x * 2.0, p.y * 2.0, 6.0))),
                0.12, p.x * 5.0))
            count += 1
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("grass: %d clumps, %d blades" % (clumps, count))


def build_ferns():
    random.seed(SEED + 13)
    acc = Acc("Ferns")
    n_fern = 80
    fronds = 0
    for fi in range(n_fern):
        x = random.uniform(X0 + 6, X1 - 6)
        w = half_width(x)
        s = random.choice([-1.0, 1.0])
        # area-spread so ferns break up the open bank, not just the waterline
        y = s * (w + 1.0 + random.uniform(0.0, 1.0) ** 0.5 * 10.0)
        z = ground_z(x, y)
        for k in range(random.randint(6, 9)):
            ang = 2.0 * math.pi * k / 8.0 + random.uniform(-0.3, 0.3)
            ln = random.uniform(0.45, 0.85)
            h = 0.20 + ln * 0.42
            r0, r1 = 0.045, 0.006
            sides = 3
            pts, rad = [], []
            segs = 5
            for t in range(segs + 1):
                tt = t / float(segs)
                px = x + math.cos(ang) * ln * tt
                py = y + math.sin(ang) * ln * tt
                pz = z + h * math.sin(tt * 1.35) - 0.10 * tt
                pts.append((px, py, pz))
                rad.append(r0 + (r1 - r0) * (tt ** 0.5))
            v, f = tube(pts, rad, sides=sides, cap_start=False, cap_end=False, wobble=0.0)
            acc.add(v, f, None, lambda p, z=z: vary(mixc(
                P["fern"], P["moss_light"], clamp(0.3 + 0.7 * n(p.x * 3.0, p.y * 3.0, 8.0))),
                0.14, p.x * 3.3))
            fronds += 1
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("ferns: %d plants, %d fronds" % (n_fern, fronds))


def build_bushes():
    """Low shrubs across the open banks. Between the water and the tree line
    there is a long strip of nothing, and grass alone doesn't fill it."""
    random.seed(SEED + 23)
    acc = Acc("Bushes")
    count = 0
    for i in range(165):
        x = random.uniform(X0 + 4, X1 - 4)
        w = half_width(x)
        s = random.choice([-1.0, 1.0])
        # Spread them evenly along the slope. Biased outward they all end up
        # behind the ridge, hidden; the empty part of the bank is the whole of it.
        foot = w + 1.6
        room = 13.2 - foot
        if room < 1.0:
            continue
        y = s * (foot + random.uniform(0.0, 1.0) * min(9.5, room))
        z = ground_z(x, y)
        if z < 0.05:
            continue

        r = random.uniform(0.36, 0.82)
        # The hero camera sits at the edge of the near bank: keep its foreground
        # clean, but fill the open ground beyond, which is what reads as empty
        # once you walk up it.
        d = math.hypot(x - CAM_POS[0], y - CAM_POS[1])
        if d < CAM_CLEAR * 0.85 or (d < CAM_CLEAR and r > 0.85):
            continue

        sub = 2 if r > 0.62 else 1
        bm = blob(subdiv=sub, radius=r, amp=0.34, freq=1.25 / max(r, 0.3),
                  offset=(3.1, 8.2, 1.7), squash=random.uniform(0.50, 0.78),
                  seed=i * 4.1, angular=0.12)
        flatten_bottom(bm, cut=-r * 0.30, soft=0.40)
        m = mat_trs(loc=(x, y, z + r * random.uniform(0.10, 0.30)),
                    scale=(random.uniform(0.85, 1.35), random.uniform(0.85, 1.35), 1.0),
                    rotz=random.uniform(0, 6.283))
        acc.add_bm(bm, m, lambda p: vary(mixc(
            P["canopy_mid"], P["moss_light"],
            clamp(0.30 + 0.70 * (n(p.x * 0.8, p.y * 0.8, p.z * 0.8 + 7.0) * 0.5 + 0.5))),
            0.15, p.x * 1.4 + p.z * 0.9))
        count += 1
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("bushes: %d" % count)


def make_tree(acc, x, y, scale=1.0, lean=0.0, lean_dir=0.0, seed=0.0, hero=False):
    z = ground_z(x, y) - 0.25
    height = 5.2 * scale
    steps = 6
    pts, rad = [], []
    bend = random.uniform(0.25, 0.75)
    for i in range(steps + 1):
        t = i / float(steps)
        px = x + lean * math.cos(lean_dir) * height * t + bend * math.sin(t * 1.5) * math.cos(seed)
        py = y + lean * math.sin(lean_dir) * height * t + bend * math.sin(t * 1.5) * math.sin(seed)
        pz = z + height * t
        pts.append((px, py, pz))
        rad.append((0.30 + 0.06 * (seed % 1.0)) * scale * (1.0 - 0.72 * t ** 0.85) + 0.03)
    v, f = tube(pts, rad, sides=9, cap_start=True, cap_end=False, wobble=0.09)
    acc.add(v, f, None, lambda p, z=z, h=height: vary(
        mixc(P["bark_dark"], P["bark"], clamp(0.3 + 0.7 * ((p.z - z) / h))), 0.14, p.x * 2.2))

    top = Vector(pts[-1])
    # a couple of limbs
    for b in range(3):
        ang = 2.0 * math.pi * b / 3.0 + seed
        ln = random.uniform(1.1, 1.9) * scale
        base = Vector(pts[steps - 1]).lerp(top, 0.5)
        tip = base + Vector((math.cos(ang) * ln, math.sin(ang) * ln, ln * 0.55))
        mid = base.lerp(tip, 0.5) + Vector((0, 0, 0.12))
        v, f = tube([tuple(base), tuple(mid), tuple(tip)],
                    [0.11 * scale, 0.075 * scale, 0.035 * scale], sides=6, wobble=0.12)
        acc.add(v, f, None, lambda p: vary(P["bark_dark"], 0.14, p.y * 2.0))

    # canopy blobs
    blobs = 7 if hero else 5
    for b in range(blobs):
        ang = random.uniform(0, 6.283)
        rr = random.uniform(0.0, 1.15) * scale
        bz = top.z + random.uniform(-0.35, 0.75) * scale
        r = random.uniform(1.05, 1.75) * scale
        bm = blob(subdiv=2, radius=r, amp=0.30, freq=1.05, offset=(5.5, 2.2, 8.8),
                  squash=random.uniform(0.62, 0.80), seed=seed * 3.0 + b * 1.7)
        m = mat_trs(loc=(top.x + math.cos(ang) * rr, top.y + math.sin(ang) * rr, bz),
                    rotz=random.uniform(0, 6.283))
        acc.add_bm(bm, m, lambda p: vary(mixc(P["canopy_dark"], P["canopy_lite"],
                                             clamp(0.35 + 0.65 * (n(p.x * 0.9, p.y * 0.9,
                                                                     p.z * 0.9 + 21.0) * 0.5 + 0.5))),
                                         0.14, p.x * 1.1 + p.z))
    return top


def build_trees():
    random.seed(SEED + 17)
    acc = Acc("Trees")
    placements = [
        (-6.0, 9.6, 1.15, 0.0), (-13.5, 8.2, 0.95, 0.0), (2.0, 11.6, 1.25, 0.0),
        (10.5, 9.0, 1.0, 0.0), (18.0, 11.0, 1.15, 0.0), (26.0, 8.6, 0.9, 0.0),
        (-9.0, -9.0, 1.0, 0.0), (0.5, -11.2, 1.2, 0.0), (8.0, -8.6, 0.95, 0.0),
        (16.0, -10.4, 1.3, 0.0), (24.0, -8.2, 1.0, 0.0), (-18.0, -10.0, 1.1, 0.0),
    ]
    for i, (x, y, sc, ln) in enumerate(placements):
        hero = (i == 0)
        make_tree(acc, x, y, scale=sc, lean=0.045 if sc > 1.0 else 0.02,
                  lean_dir=random.uniform(0, 6.283), seed=i * 2.9, hero=hero)
    # one long branch reaching out over the water from the hero tree
    top = Vector((-6.0, 9.6, ground_z(-6.0, 9.6) - 0.25 + 5.2 * 1.15 * 0.72))
    for k in range(2):
        tipy = 1.6 - k * 1.4
        base = Vector((-6.0 + k * 0.6, 9.2, top.z + 0.2 + k * 0.5))
        tip = Vector((-4.4 + k * 1.8, tipy, top.z - 0.15 - k * 0.5))
        mid = base.lerp(tip, 0.5) + Vector((0.2, 0, 0.55))
        v, f = tube([tuple(base), tuple(mid), tuple(tip)],
                    [0.17, 0.12, 0.05], sides=7, wobble=0.10)
        acc.add(v, f, None, lambda p: vary(P["bark_dark"], 0.12, p.z * 2.0))
        # leaves at the tip, so the bough ends in foliage instead of mid-air
        for b in range(2):
            r = random.uniform(0.75, 1.15)
            bm = blob(subdiv=2, radius=r, amp=0.30, freq=1.05, offset=(5.5, 2.2, 8.8),
                      squash=0.72, seed=41.0 + k * 3.0 + b * 1.7)
            loc = Vector(tip).lerp(Vector(base), 0.18 + b * 0.24)
            m = mat_trs(loc=(loc.x + random.uniform(-0.2, 0.2), loc.y,
                             loc.z + r * 0.35), rotz=random.uniform(0, 6.283))
            acc.add_bm(bm, m, lambda p: vary(mixc(P["canopy_dark"], P["canopy_lite"],
                                                  clamp(0.35 + 0.65 * (n(p.x * 0.9, p.y * 0.9,
                                                                         p.z * 0.9 + 21.0) * 0.5 + 0.5))),
                                             0.14, p.x * 1.1 + p.z))
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("trees: %d" % len(placements))


def build_lilies():
    random.seed(SEED + 19)
    acc = Acc("Lilies")
    count = 0
    for i in range(16):
        x = random.uniform(3.0, 16.0)
        w = half_width(x)
        y = random.uniform(-0.7, 0.7) * w
        if water_depth(x, y) > 0.85:
            continue
        r = random.uniform(0.16, 0.36)
        segs = 12
        verts = [(0.0, 0.0, 0.02)]
        for k in range(segs):
            a = 2.0 * math.pi * k / segs
            verts.append((math.cos(a) * r, math.sin(a) * r, 0.0))
        faces = []
        for k in range(segs):
            faces.append((0, 1 + k, 1 + (k + 1) % segs))
        m = mat_trs(loc=(x, y, WATER_Z + 0.012), rotz=random.uniform(0, 6.283))
        acc.add(verts, faces, m, lambda p: vary(P["lily"], 0.16, p.x * 6.0 + p.y * 3.0))
        count += 1
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("lilies: %d pads" % count)


def build_mushrooms():
    random.seed(SEED + 23)
    acc = Acc("Mushrooms")
    spots = [(-0.9, 5.0, 0.72), (0.4, -1.9, 0.40), (1.1, -4.6, 0.68),
             (-11.0, 8.4, None), (7.0, -7.6, None), (-16.5, -8.7, None)]
    count = 0
    for (sx, sy, sz) in spots:
        if sz is None:
            sz = ground_z(sx, sy) + 0.02
        for k in range(random.randint(3, 6)):
            x = sx + random.uniform(-0.45, 0.45)
            y = sy + random.uniform(-0.35, 0.35)
            z = sz + random.uniform(-0.05, 0.05)
            h = random.uniform(0.07, 0.16)
            r = h * random.uniform(0.75, 1.15)
            v, f = tube([(x, y, z), (x, y, z + h * 0.6), (x, y, z + h)],
                        [r * 0.30, r * 0.26, r * 0.24], sides=6, cap_start=False)
            acc.add(v, f, None, lambda p: vary(P["stem"], 0.06, p.y * 5.0))
            bm = blob(subdiv=1, radius=r, amp=0.12, freq=3.0, offset=(1.1, 4.4, 2.2),
                      squash=0.55, seed=k * 1.9)
            m = mat_trs(loc=(x, y, z + h * 0.94))
            acc.add_bm(bm, m, lambda p: vary(P["cap"], 0.14, p.z * 6.0))
            count += 1
    acc.build(mat=bpy.data.materials.get("MAT_nature"))
    print("mushrooms: %d" % count)


def build_lanterns():
    """Two warm lanterns: one near the bank, one across the water for depth."""
    glow = bpy.data.materials.get("MAT_glow")
    nature = bpy.data.materials.get("MAT_nature")
    acc = Acc("Lanterns")
    glow_acc = Acc("LanternGlass")

    def one(x, y, scale=1.0, seed=1.0):
        z = ground_z(x, y) - 0.06
        h = 1.62 * scale
        v, f = tube([(x, y, z), (x, y, z + h * 0.55), (x, y, z + h)],
                    [0.075 * scale, 0.062 * scale, 0.052 * scale], sides=8)
        acc.add(v, f, None, lambda p: vary(mixc(P["bark_dark"], P["bark"], 0.4), 0.12, p.y * 3.0))
        # curved arm
        tip = (x + 0.34 * scale, y + 0.10 * scale, z + h + 0.10 * scale)
        mid = (x + 0.10 * scale, y, z + h + 0.14 * scale)
        v, f = tube([(x, y, z + h * 0.98), mid, tip], [0.045 * scale, 0.038 * scale, 0.030 * scale],
                    sides=6)
        acc.add(v, f, None, lambda p: vary(P["bark_dark"], 0.10, p.x * 3.0))
        # hanging glass, hexagonal
        gx, gy = tip[0], tip[1]
        gh = 0.30 * scale
        v, f = tube([(gx, gy, tip[2] - 0.06 * scale), (gx, gy, tip[2] - 0.10 * scale)],
                    [0.012 * scale, 0.012 * scale], sides=5)
        acc.add(v, f, None, lambda p: P["bark_dark"])
        top_z = tip[2] - 0.10 * scale
        v, f = tube([(gx, gy, top_z), (gx, gy, top_z - gh)],
                    [0.115 * scale, 0.115 * scale], sides=6, cap_start=True, cap_end=True)
        glow_acc.add(v, f, None, lambda p: (1.0, 1.0, 1.0))
        # cap plate
        v, f = tube([(gx, gy, top_z + 0.015 * scale), (gx, gy, top_z - 0.015 * scale)],
                    [0.145 * scale, 0.145 * scale], sides=6)
        acc.add(v, f, None, lambda p: P["bark_dark"])

    one(2.2, 5.9, scale=1.0, seed=1.0)
    one(19.5, -6.5, scale=0.9, seed=2.0)
    acc.build(mat=nature, smooth=False)
    glow_acc.build(mat=glow, smooth=False)
    print("lanterns: 2")


# ---------------------------------------------------------------- look dev

def look_at_matrix(loc, target):
    """Explicit Blender camera matrix: -Z forward, +Y up, +X right."""
    loc = Vector(loc)
    f = (Vector(target) - loc).normalized()
    right = f.cross(Vector((0.0, 0.0, 1.0))).normalized()
    up = right.cross(f).normalized()
    return Matrix(((right.x, up.x, -f.x, loc.x),
                   (right.y, up.y, -f.y, loc.y),
                   (right.z, up.z, -f.z, loc.z),
                   (0.0, 0.0, 0.0, 1.0)))


def build_camera_and_light():
    """A camera matching the intended web framing, plus a sun for previews."""
    for name in ("PreviewCam", "Sun"):
        old = bpy.data.objects.get(name)
        if old:
            bpy.data.objects.remove(old, do_unlink=True)
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.lens = 34.0
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.matrix_world = look_at_matrix(CAM_POS, CAM_TARGET)
    bpy.context.scene.camera = cam

    sun_data = bpy.data.lights.new("Sun", type='SUN')
    sun_data.energy = 1.9
    sun_data.color = (1.0, 0.80, 0.58)
    sun_data.angle = math.radians(2.5)
    sun = bpy.data.objects.new("Sun", sun_data)
    bpy.context.scene.collection.objects.link(sun)
    sun.location = (-30.0, 20.0, 14.0)
    # low, raking, coming from behind the camera's shoulder
    travel = Vector((0.90, -0.33, -0.28))
    sun.rotation_euler = travel.to_track_quat('-Z', 'Y').to_euler()

    world = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = next((nd for nd in world.node_tree.nodes if nd.type == 'BACKGROUND'), None)
    if bg:
        bg.inputs[0].default_value = (0.55, 0.60, 0.68, 1.0)
        bg.inputs[1].default_value = 0.55

    scn = bpy.context.scene
    try:
        scn.render.engine = 'BLENDER_EEVEE'
    except TypeError:
        pass
    try:
        scn.view_settings.view_transform = 'Standard'
    except Exception as e:
        print("view transform: %s" % e)
    scn.render.resolution_x = 1280
    scn.render.resolution_y = 720
    print("camera + sun ready")


# -------------------------------------------------------------------- steps

def build_all():
    """Full clean rebuild: wipes the scene, then builds every layer."""
    clear()
    mats = make_materials()
    build_terrain()
    build_water()
    build_rocks()
    build_pebbles()
    build_stones()
    build_log()
    build_reeds()
    build_grass()
    build_ferns()
    build_bushes()
    build_trees()
    build_lilies()
    build_mushrooms()
    build_lanterns()
    build_camera_and_light()
    assign_materials()
    print("BUILD COMPLETE")


def assign_materials():
    """Make sure every object has the right material."""
    nature = bpy.data.materials.get("MAT_nature")
    water = bpy.data.materials.get("MAT_water")
    glow = bpy.data.materials.get("MAT_glow")
    for ob in bpy.data.objects:
        if ob.type != 'MESH':
            continue
        if ob.name == "Water":
            ob.data.materials.clear()
            ob.data.materials.append(water)
            continue
        if ob.name == "LanternGlass":
            ob.data.materials.clear()
            ob.data.materials.append(glow)
            continue
        ob.data.materials.clear()
        ob.data.materials.append(nature)
    print("materials assigned")


def export_glb():
    os.makedirs(ASSETS, exist_ok=True)
    path = os.path.join(ASSETS, "creek.glb")
    rt = bpy.ops.export_scene.gltf.get_rna_type()
    valid = set(p.identifier for p in rt.properties)

    kw = {
        "filepath": path,
        "export_format": 'GLB',
        "use_selection": False,
        "use_visible": True,
        "use_renderable": False,
        "export_apply": True,
        "export_yup": True,
        "export_materials": 'EXPORT',
        "export_normals": True,
        "export_tangents": False,
        "export_texcoords": False,
        "export_cameras": False,
        "export_lights": False,
        "export_animations": False,
        "export_extras": False,
        "export_all_vertex_colors": True,
        "export_attributes": True,
        "export_skins": False,
        "export_morph": False,
        "export_draco_mesh_compression_enable": False,
        "export_use_gltfpack": False,
        "export_meshopt_compression_enable": False,
        "export_hierarchy_flatten_objs": False,
        "export_shared_accessors": False,
    }
    try:
        items = [i.identifier for i in rt.properties["export_vertex_color"].enum_items]
        for want in ("MATERIAL", "ACTIVE", "ALL"):
            if want in items:
                kw["export_vertex_color"] = want
                break
    except Exception as e:
        print("vertex colour enum: %s" % e)

    kw = {k: v for k, v in kw.items() if k in valid}
    result = bpy.ops.export_scene.gltf(**kw)
    size = os.path.getsize(path) / 1048576.0 if os.path.exists(path) else -1
    print("export %s -> %.2f MB" % (result, size))
    return size


def inspect_glb(path=None):
    """Read the GLB's JSON chunk and report what actually made it into the file."""
    import struct
    import json as _json
    path = path or os.path.join(ASSETS, "creek.glb")
    with open(path, "rb") as fh:
        data = fh.read()
    magic, ver, total = struct.unpack_from("<III", data, 0)
    print("glb magic=%s version=%d bytes=%d" % (magic == 0x46546C67, ver, total))
    off = 12
    js = None
    while off + 8 <= len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        body = data[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = _json.loads(body.decode("utf-8"))
            break
        off += 8 + clen + ((4 - clen % 4) % 4)
    if js is None:
        print("no JSON chunk found")
        return None
    mats = [m.get("name") for m in js.get("materials", [])]
    print("extensions:", js.get("extensionsUsed", []))
    print("materials:", mats)
    total_tris = 0
    for mesh in js.get("meshes", []):
        attrs = set()
        for prim in mesh.get("primitives", []):
            attrs.update(prim.get("attributes", {}).keys())
            idx = prim.get("indices")
            if idx is not None:
                total_tris += js["accessors"][idx]["count"] // 3
            mname = mats[prim["material"]] if "material" in prim else None
        print("%-14s attrs=%-34s mat=%s" % (mesh.get("name"), ",".join(sorted(attrs)), mname))
    print("TOTAL TRIS IN GLB:", total_tris)
    return js


def save_blend():
    os.makedirs(os.path.dirname(BLEND), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    print("saved %s" % BLEND)


def report():
    tris = 0
    for ob in bpy.data.objects:
        if ob.type == 'MESH':
            ob.data.calc_loop_triangles()
            t = len(ob.data.loop_triangles)
            tris += t
            print("%-14s %6d tris  %5d verts" % (ob.name, t, len(ob.data.vertices)))
    print("TOTAL %d tris" % tris)
    return tris
