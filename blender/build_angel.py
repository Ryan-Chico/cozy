"""
build_angel.py -- bring the colossal Angel of Justice in from Sketchfab and
export it to models/angel/model.glb for the Three.js page.

Same two-step shape as build_monster.py and build_b17.py, because the download
is an MCP tool call rather than plain bpy. First, in the agent session:

    import_asset(source="sketchfab",
                 id="0c6ea584860a42a2aa25015a86dab881",   # see ASSET_UID
                 target_size=10)                           # run() normalises anyway

Then, inside Blender:

    exec(open(r"C:\\Users\\ryanc\\projects\\cozy\\blender\\build_angel.py").read())
    run()

What run() does:
  - finds the import's two meshes by the materials they carry ("Statue" and
    "Wings"), so the shogun's leftover wrapper -- or a second angel import --
    cannot be mistaken for this one
  - bakes the Sketchfab wrapper transforms into the geometry and drops the
    empties they came in with
  - turns it to face Blender -Y. The statue arrives facing -X: its back, and
    the back of its wings, are what the camera meets when it turns around, and
    the spec wants that back on three.js +X. The export maps Blender -Y to
    three.js +Z, so the turn is a plain +90 degree yaw about Z, and `face: 180`
    in the spec then puts its back to the visitor.
  - normalises on the statue's own height (TARGET_HEIGHT), not on the wingspan,
    and grounds it: feet on z = 0, base centred on the origin
  - trims the five dead UV layers the Sketchfab export left behind, so the GLB
    does not carry five TEXCOORD sets to the GPU for one used layout
  - cuts the textures to 1024 (512 for the metallicRoughness maps, which carry
    almost no detail at this distance) and lets the opaque maps go to JPEG
  - saves the tidied statue back into blender/creek.blend, off the east bank

The asset is a posed sculpt -- no armature, no actions. Nothing in it moves.
"""

import bpy
import json
import os
import shutil
import struct
from mathutils import Matrix, Vector

PROJECT = r"C:\Users\ryanc\projects\cozy"
OUT_DIR = os.path.join(PROJECT, "models", "angel")
OUT_PATH = os.path.join(OUT_DIR, "model.glb")

# "Angel of Justice" by Joao Lacerda (panc0), CC BY 4.0, via Sketchfab.
ASSET_UID = "0c6ea584860a42a2aa25015a86dab881"
AUTHOR = "Joao Lacerda (panc0)"

# The importer's two meshes, identified by the materials the artist gave them.
SOURCE_MESHES = {
    "Statue": "Angel_Body",
    "Wings": "Angel_Wings",
}

# The statue itself, not its wings: the wings reach highest, and scaling the
# whole tableau would make the body a little shorter than the number says.
TARGET_HEIGHT = 80.0        # metres, the statue's standing height
BODY_NAME = "Angel_Body"

# Where the tidied statue is left in creek.blend, in Blender metres. x = 80 is
# clear of the east edge of the terrain, wingspan included, so it never overlaps
# the creek while still being framed by it from the preview camera.
BLEND_PLACEMENT = (80.0, 0.0, 0.0)

# stem -> (longest side, format). The metallicRoughness maps carry no shapes at
# all, only broad tonal variation, so half res is invisible at 40 m.
TEXTURES = {
    "Statue_baseColor": (1024, 'JPEG'),
    "Statue_normal": (1024, 'JPEG'),
    "Statue_metallicRoughness": (512, 'JPEG'),
    "Wings_baseColor": (1024, 'JPEG'),
    "Wings_normal": (1024, 'JPEG'),
    "Wings_metallicRoughness": (512, 'JPEG'),
}


# ------------------------------------------------------------------ helpers

def find_meshes():
    """This import's meshes, whether or not a previous run already tidied them.

    Matching on the materials is what makes it safe next to the shogun's own
    flattened meshes and the wrapper empty it left in the file: no other guest
    carries a material called Statue or Wings.
    """
    found = []
    for material, clean in SOURCE_MESHES.items():
        for ob in bpy.data.objects:
            if ob.type != 'MESH':
                continue
            if ob.name == clean:
                found.append(ob)
                break
            if any(m is not None and m.name.split('.')[0] == material
                   for m in ob.data.materials):
                found.append(ob)
                break
    if len(found) != 2:
        raise RuntimeError(
            "expected the statue and the wings -- found %d of 2 meshes; "
            "import the asset first" % len(found))
    return found


def source_ancestors(meshes):
    """The empties above these meshes, and nothing else."""
    seen = []
    for ob in meshes:
        p = ob.parent
        while p is not None and p not in seen:
            seen.append(p)
            p = p.parent
    return seen


def bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in objs:
        for v in ob.data.vertices:
            for i in range(3):
                lo[i] = min(lo[i], v.co[i])
                hi[i] = max(hi[i], v.co[i])
    return lo, hi


def bake_transforms(meshes):
    """Fold the wrapper transforms into the geometry and drop the wrappers."""
    if bpy.context.object is not None and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')

    # collect them before unparenting: afterwards the chain is already gone
    ancestors = source_ancestors(meshes)

    for ob in meshes:
        mw = ob.matrix_world.copy()
        ob.parent = None
        ob.matrix_world = mw

    bpy.ops.object.select_all(action='DESELECT')
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    for p in ancestors:
        bpy.data.objects.remove(p, do_unlink=True)

    for ob in meshes:
        for material, clean in SOURCE_MESHES.items():
            if any(m is not None and m.name.split('.')[0] == material
                   for m in ob.data.materials):
                ob.name = clean
                ob.data.name = clean + "Mesh"
                break

    print("flattened to", ", ".join(ob.name for ob in meshes))


def face_minus_y(meshes):
    """Turn the statue so its front meets Blender -Y, the export convention.

    On a clean import the front faces -X: +90 degrees about Z takes -X onto -Y,
    which the glTF exporter maps to three.js +Z. Guarded by a custom property,
    because rotating an already-turned statue is a silent 90-degree trap.
    """
    if all(ob.get("creek_angel_faced") for ob in meshes):
        print("already faced -Y")
        return
    for ob in meshes:
        ob.data.transform(Matrix.Rotation(1.5707963267948966, 4, 'Z'))
        ob.data.update()
        ob["creek_angel_faced"] = True
    print("turned to face Blender -Y (three.js +Z)")


def fit(meshes, height=TARGET_HEIGHT):
    """Normalise on the statue's height and put its feet on the origin.

    The wings spread wider than the body is deep and reach a little above the
    head, so the whole model's longest axis is the standing height; the fit
    measures that, scales every mesh by the same factor, and grounds it so the
    spec's `grounded` and `size` describe the statue rather than the box.
    """
    lo, hi = bounds(meshes)
    reach = max(hi[i] - lo[i] for i in range(3))
    if reach <= 1e-6:
        raise RuntimeError("the statue has no extent")
    k = height / reach
    anchor = (lo + hi) * 0.5
    anchor.z = lo.z                     # feet, not centre

    for ob in meshes:
        for v in ob.data.vertices:
            v.co = (v.co - anchor) * k
        ob.data.update()
        ob.location = (0.0, 0.0, 0.0)
        ob.rotation_euler = (0.0, 0.0, 0.0)
        ob.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()

    lo, hi = bounds(meshes)
    body = bpy.data.objects.get(BODY_NAME)
    dims = tuple(hi[i] - lo[i] for i in range(3))
    print("statue %.1f x %.1f x %.1f m (scale %.4f)" % (dims + (k,)))
    if body is not None:
        blo, bhi = bounds([body])
        print("body   %.1f x %.1f x %.1f m" % tuple(bhi[i] - blo[i] for i in range(3)))


def dress_material(meshes):
    """Metallic off, so the statue stops reading as a hole in the haze.

    The statue arrives fully metallic. This is a dusk with a cheap environment
    map and the statue's whole visible side is turned away from the sun, so
    metalness 1 has nothing to reflect and renders near black -- the toad and
    the B-17 both needed the same correction. The roughness map stays linked so
    the artist's surface variation survives; only the metallic link is cut.
    """
    done = set()
    for ob in meshes:
        for mat in ob.data.materials:
            if mat is None or not mat.use_nodes or mat.name in done:
                continue
            done.add(mat.name)
            mat.blend_method = 'OPAQUE'
            mat.use_backface_culling = False
            for node in mat.node_tree.nodes:
                if node.type != 'BSDF_PRINCIPLED':
                    continue
                metal = node.inputs.get('Metallic')
                if metal is not None:
                    for link in list(metal.links):
                        mat.node_tree.links.remove(link)
                    metal.default_value = 0.0
            print("material %s: opaque, double-sided, metallic 0" % mat.name)


def trim_uvs(meshes):
    """Drop the UV layers no texture in this mesh actually samples.

    The Sketchfab export arrives with five layouts on the body and four on the
    wings, of which the materials use at most four. Every layer left on the
    mesh becomes another TEXCOORD set in the GLB, so the dead ones are paid for
    by every visitor.
    """
    for ob in meshes:
        active = ob.data.uv_layers.active.name if ob.data.uv_layers.active else None
        used = set()
        for mat in ob.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            for node in mat.node_tree.nodes:
                if node.type != 'TEX_IMAGE' or node.image is None:
                    continue
                source = None
                for link in node.inputs['Vector'].links:
                    if link.from_node.type == 'UVMAP':
                        source = link.from_node.uv_map
                used.add(source or active)
        for layer in list(ob.data.uv_layers):
            if layer.name not in used:
                print("dropped UV layer %s.%s" % (ob.name, layer.name))
                ob.data.uv_layers.remove(layer)


def stem_of(name):
    """Image name -> the identity the TEXTURES table is keyed on."""
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
    """Cut the textures down and send the opaque ones to JPEG.

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

    shutil.rmtree(tmpdir, ignore_errors=True)


def export_glb(meshes):
    os.makedirs(OUT_DIR, exist_ok=True)

    bpy.ops.object.select_all(action='DESELECT')
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]

    rt = bpy.ops.export_scene.gltf.get_rna_type()
    valid = set(p.identifier for p in rt.properties)
    kw = {
        "filepath": OUT_PATH,
        "export_format": 'GLB',
        "use_selection": True,          # the creek, toad, B-17 and shogun are here too
        "export_apply": True,
        "export_yup": True,
        "export_materials": 'EXPORT',
        "export_normals": True,
        "export_texcoords": True,
        "export_cameras": False,
        "export_lights": False,
        "export_animations": False,     # nothing rigged
        "export_skins": False,
        "export_morph": False,
        "export_extras": False,
        "export_all_vertex_colors": False,
        # every map is opaque, so JPEG everywhere; AUTO keeps the packed PNG
        # bytes for the metallicRoughness maps, which is worth about a megabyte
        "export_image_format": 'JPEG',
        "export_image_quality": 88,
        "export_draco_mesh_compression_enable": False,
        "export_hierarchy_flatten_objs": False,
    }
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in valid})
    print("exported %s -> %.2f MB" % (OUT_PATH, os.path.getsize(OUT_PATH) / 1048576.0))
    return OUT_PATH


def inspect_glb(path=None):
    """Read the GLB's JSON chunk and report what actually made it into the file."""
    path = path or OUT_PATH
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

    print("images:", [(i.get("name"), i.get("mimeType")) for i in js.get("images", [])])
    tris = 0
    for mesh in js.get("meshes", []):
        for prim in mesh.get("primitives", []):
            print("mesh %-12s attrs=%s" % (mesh.get("name"),
                                           sorted(prim.get("attributes", {}).keys())))
            tris += js["accessors"][prim["indices"]]["count"] // 3
    print("TOTAL TRIS:", tris)
    return js


def save_blend(meshes):
    """Park the tidied statue east of the creek and save the scene."""
    x, y, z = BLEND_PLACEMENT
    for ob in meshes:
        ob.location = (x, y, z)
    bpy.context.view_layer.update()
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(PROJECT, "blender", "creek.blend"), compress=True)
    print("saved blender/creek.blend with the statue at", BLEND_PLACEMENT)


# --------------------------------------------------------------------- run

def run(save=True):
    meshes = find_meshes()
    bake_transforms(meshes)
    face_minus_y(meshes)
    fit(meshes)
    dress_material(meshes)
    trim_uvs(meshes)
    trim_textures(meshes)
    path = export_glb(meshes)
    inspect_glb(path)
    if save:
        save_blend(meshes)
    return meshes
