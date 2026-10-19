"""
build_b17.py -- bring the B-17 in from Sketchfab and export it to assets/b17.glb
for the Three.js page.

Same two-step shape as build_monster.py, because the download is an MCP tool
call rather than plain bpy. First, in the agent session:

    import_asset(source="sketchfab",
                 id="2693bbf7485c4f038a31b6e3e47c62c5",   # see ASSET_UID
                 target_size=30)                           # run() normalises anyway

Then, inside Blender:

    exec(open(r"C:\\Users\\ryanc\\projects\\cozy\\blender\\build_b17.py").read())
    run()

It keeps its own file rather than joining creek.glb so that re-running
build_creek.py can never clobber it.

What run() does:
  - bakes the Sketchfab wrapper transforms into each mesh and drops the empties
    they came in with -- *only* the ones above this import, since the toad's
    import also arrived under an empty called Sketchfab_model
  - recentres on the aircraft itself, so positioning it is just "put the plane
    here" and the smoke and tracer fire hang off it where the artist left them
  - normalises the whole tableau (aircraft, smoke, tracers, bombs) to
    TARGET_SIZE, not just the plane: the tracers sweep about six times the
    aircraft's own span, and normalising on the plane alone would throw a
    hundred metres of tracer fire across the sky
  - cuts the textures down and sends everything except the FX base colour to
    JPEG, because that one carries the alpha that makes the smoke soft

Note the asset has no armature and no actions: the dive is a posed sculpt. All
of it is static, which is all the page wants from it.
"""

import bpy
import json
import os
import shutil
import struct
from mathutils import Vector

PROJECT = r"C:\Users\ryanc\projects\cozy"
ASSETS = os.path.join(PROJECT, "assets")

# "Crash of a B-17" by Pedro B. Goulart (Pebegou), CC BY 4.0, via Sketchfab.
ASSET_UID = "2693bbf7485c4f038a31b6e3e47c62c5"
AUTHOR = "Pedro B. Goulart"

# The mesh objects the importer creates, in the order they are worth naming.
SOURCE_MESHES = {
    "B-17_Chassi_0": "B17_Hull",
    "B-17Bones_Chassi_0": "B17_Bones",
    "B-17Guts_Chassi_0": "B17_Guts",
    "Bombs_Chassi_0": "B17_Bombs",
    "Smoke_FX_0": "B17_Smoke",
    "Bullets_FX_0": "B17_Tracers",
}
TARGET_SIZE = 40.0        # metres, the whole tableau's largest dimension
AIRCRAFT_PREFIX = "B-17"  # what the recentring anchors on

# stem -> (longest side, format). PNG only where an alpha channel matters.
# Keyed on the stem, not the filename: after one run the JPEGs are renamed to
# .jpg, and matching on the whole name would silently stop trimming them.
TEXTURES = {
    "Chassi_baseColor": (1024, 'JPEG'),
    "Chassi_normal": (1024, 'JPEG'),
    "Chassi_metallicRoughness": (512, 'JPEG'),
    "Chassi_emissive": (1024, 'JPEG'),
    "material_baseColor": (512, 'PNG'),   # the smoke's alpha lives here
    "material_emissive": (512, 'JPEG'),
}


# ------------------------------------------------------------------ helpers

def find_meshes():
    """This import's meshes, whether or not a previous run already tidied them."""
    found = []
    for name, clean in SOURCE_MESHES.items():
        for candidate in (clean, name):
            ob = bpy.data.objects.get(candidate)
            if ob is not None and ob.type == 'MESH':
                found.append(ob)
                break
    if not found:
        raise RuntimeError("no B-17 in the scene -- import the asset first")
    return found


def source_ancestors(meshes):
    """The empties above these meshes, and nothing else.

    The toad's import arrived under an empty called Sketchfab_model too, and it
    has already been cleaned up, so deleting by name would be a loaded gun.
    Only walk up from our own meshes.
    """
    seen = []
    for ob in meshes:
        p = ob.parent
        while p is not None and p not in seen:
            seen.append(p)
            p = p.parent
    return seen


def bake_transforms(meshes):
    """Fold the wrapper transforms into the geometry and drop the wrappers."""
    if bpy.context.object is not None and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')

    for ob in meshes:
        mw = ob.matrix_world.copy()
        ob.parent = None
        ob.matrix_world = mw

    bpy.ops.object.select_all(action='DESELECT')
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    for p in source_ancestors(meshes):
        bpy.data.objects.remove(p, do_unlink=True)

    for ob in meshes:
        clean = SOURCE_MESHES.get(ob.name)
        if clean:
            ob.name = clean
            ob.data.name = clean + "Mesh"


def bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in objs:
        for v in ob.data.vertices:
            for i in range(3):
                lo[i] = min(lo[i], v.co[i])
                hi[i] = max(hi[i], v.co[i])
    return lo, hi


def fit(meshes, size=TARGET_SIZE):
    """Normalise the tableau and put the origin on the aircraft's centre.

    One offset and one factor for every mesh, so the parts keep their relative
    placement. The origin lands on the aircraft rather than on the tableau,
    because the aircraft is the thing worth saying "put this here" about.
    """
    lo, hi = bounds(meshes)
    span = max(hi[i] - lo[i] for i in range(3))
    if span <= 1e-6:
        raise RuntimeError("B-17 has no extent")
    k = size / span

    aircraft = [m for m in meshes if m.name[len("B17_"):] in ("Hull", "Bones", "Guts")]
    if not aircraft:
        aircraft = meshes
    alo, ahi = bounds(aircraft)
    anchor = (alo + ahi) * 0.5

    for ob in meshes:
        for v in ob.data.vertices:
            v.co = (v.co - anchor) * k
        ob.data.update()
        ob.location = (0.0, 0.0, 0.0)
        ob.rotation_euler = (0.0, 0.0, 0.0)
        ob.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()

    # measured after the fit, not from lo/hi above: those are the bounds it
    # arrived with, and printing those reports the input, not the result
    lo, hi = bounds(meshes)
    alo, ahi = bounds(aircraft)
    print("tableau %.1f x %.1f x %.1f m" % tuple(hi[i] - lo[i] for i in range(3)))
    print("aircraft %.2f x %.2f x %.2f m (scale %.4f)" % (
        ahi.x - alo.x, ahi.y - alo.y, ahi.z - alo.z, k))


def dress_material(meshes):
    """Metallic off, so the airframe stops reading as a hole in the sky.

    Chassi arrives fully metallic: the glTF importer wires Metallic and
    Roughness to Chassi_metallicRoughness, and the factor defaults to 1. This
    scene is a dusk with nothing bright for a rough metal to reflect, so
    metalness 1 renders the whole aircraft near black -- the toad needed
    exactly the same treatment on arrival.

    Only the Metallic link is cut. Roughness stays on the map so the panels keep
    the artist's variation, and glTF multiplies the texture's blue channel by
    metallicFactor, so writing 0 here is enough to carry through the export.
    """
    done = set()
    for ob in meshes:
        for mat in ob.data.materials:
            if mat is None or not mat.use_nodes or mat.name in done:
                continue
            done.add(mat.name)
            for node in mat.node_tree.nodes:
                if node.type != 'BSDF_PRINCIPLED':
                    continue
                metal = node.inputs.get('Metallic')
                if metal is None:
                    continue
                for link in list(metal.links):
                    mat.node_tree.links.remove(link)
                metal.default_value = 0.0
                print("material %s: metallic forced to 0" % mat.name)


def stem_of(name):
    """Image name -> the identity the TEXTURES table is keyed on.

    Neither the whole name nor a single rsplit is a stable key. The exporter
    may change an extension, and Blender renames a re-loaded image with a .001
    suffix, so a second run sees 'Chassi_baseColor.jpg.001' and a plain
    rsplit would quietly stop trimming every texture it had already done.
    """
    base = name
    for _ in range(3):
        root, dot, ext = base.rpartition('.')
        if not dot:
            break
        if ext.isdigit() or ext.lower() in ('jpg', 'jpeg', 'png', 'webp', 'tif', 'exr'):
            base = root
        else:
            break
    return base


def trim_textures(meshes):
    """Cut the textures down, and choose a container for each.

    Chassi_* are opaque, so JPEG. material_baseColor carries the smoke's alpha
    in its alpha channel, so it has to stay PNG or the plumes come out square.

    Setting image.file_format is not enough: the exporter's AUTO mode reads the
    packed bytes, which are still PNG, and ships them as PNG whatever the
    attribute says. So the JPEGs are written out through disk and loaded back,
    which is the only way to genuinely change the data behind the image.
    """
    tmpdir = os.path.join(PROJECT, "blender", "_tex_tmp")
    os.makedirs(tmpdir, exist_ok=True)
    seen = {}

    for ob in meshes:
        for mat in ob.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            for node in mat.node_tree.nodes:
                if node.type != 'TEX_IMAGE' or node.image is None:
                    continue
                stem = stem_of(node.image.name)
                spec = TEXTURES.get(stem)
                if spec is None:
                    continue
                size, fmt = spec
                key = (stem, size, fmt)
                if key in seen:
                    node.image = seen[key]
                    continue

                img = node.image
                before = list(img.size[:])
                space = img.colorspace_settings.name
                if max(before) > size:
                    img.scale(size, size)

                if fmt == 'JPEG':
                    path = os.path.join(tmpdir, stem + ".jpg")
                    img.filepath_raw = path
                    img.file_format = 'JPEG'
                    try:
                        img.save(quality=88)
                    except TypeError:
                        img.save()
                    fresh = bpy.data.images.load(path, check_existing=False)
                    fresh.pack()
                    fresh.colorspace_settings.name = space
                    node.image = fresh
                    new = fresh
                else:
                    img.file_format = 'PNG'
                    img.pack()
                    new = img

                seen[key] = new
                print("texture %s %s -> %s %s" % (img.name, before, list(new.size[:]), fmt))

    try:
        shutil.rmtree(tmpdir, ignore_errors=True)
    except OSError:
        pass


def export_glb(meshes):
    os.makedirs(ASSETS, exist_ok=True)
    path = os.path.join(ASSETS, "b17.glb")

    bpy.ops.object.select_all(action='DESELECT')
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]

    rt = bpy.ops.export_scene.gltf.get_rna_type()
    valid = set(p.identifier for p in rt.properties)
    kw = {
        "filepath": path,
        "export_format": 'GLB',
        "use_selection": True,          # the creek and the toad are in the scene too
        "export_apply": True,
        "export_yup": True,
        "export_materials": 'EXPORT',
        "export_normals": True,
        "export_texcoords": True,
        "export_cameras": False,
        "export_lights": False,
        "export_animations": False,     # nothing rigged, see the header
        "export_skins": False,
        "export_morph": False,
        "export_extras": False,
        "export_all_vertex_colors": False,
        # AUTO keeps the JPEGs we asked for as JPEG and only the alpha-carrying
        # PNG as PNG; forcing JPEG here would flatten the smoke
        "export_image_format": 'AUTO',
        "export_image_quality": 88,
        "export_draco_mesh_compression_enable": False,
        "export_hierarchy_flatten_objs": False,
    }
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in valid})
    print("exported %s -> %.2f MB" % (path, os.path.getsize(path) / 1048576.0))
    return path


def inspect_glb(path=None):
    """Read the GLB's JSON chunk and report what actually made it into the file."""
    path = path or os.path.join(ASSETS, "b17.glb")
    with open(path, "rb") as fh:
        data = fh.read()
    magic, _ver, total = struct.unpack_from("<III", data, 0)
    print("glb magic=%s bytes=%d" % (magic == 0x46546C67, total))
    off, js = 12, None
    while off + 8 <= len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        if ctype == 0x4E4F534A:
            js = json.loads(data[off + 8: off + 8 + clen].decode("utf-8"))
            break
        off += 8 + clen + ((4 - clen % 4) % 4)
    if js is None:
        print("no JSON chunk found")
        return None

    print("materials:", [json.dumps(m) for m in js.get("materials", [])])
    print("images:", [(i.get("name"), i.get("mimeType")) for i in js.get("images", [])])
    tris = 0
    for mesh in js.get("meshes", []):
        for prim in mesh.get("primitives", []):
            print("mesh %-12s attrs=%s" % (mesh.get("name"),
                                           sorted(prim.get("attributes", {}).keys())))
            tris += js["accessors"][prim["indices"]]["count"] // 3
    print("TOTAL TRIS:", tris)
    return js


def run():
    meshes = find_meshes()
    bake_transforms(meshes)
    fit(meshes)
    dress_material(meshes)
    trim_textures(meshes)
    path = export_glb(meshes)
    inspect_glb(path)
    return meshes
