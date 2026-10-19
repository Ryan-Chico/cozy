"""
build_shogun.py -- bring the creek's raid boss in from Sketchfab and export it
to models/shogun/model.glb for the Three.js page.

The download is an MCP tool call rather than plain bpy, so this runs in two
steps. First, in the agent session (this part fetches the mesh and needs the
user's Sketchfab account):

    import_asset(source="sketchfab",
                 id="8700d16e247d4a51956ef904643b95fa",   # see ASSET_UID
                 target_size=10)                          # the loader normalises

Then, inside Blender:

    exec(open(r"C:\\Users\\ryanc\\projects\\cozy\\blender\\build_shogun.py").read())
    run()

What run() does:
  - drops the two smoke puffs. They are frozen VFX from the author's render, not
    parts of the machine, and their cards widen the bounding box enough to
    change what `size` means. The red blade is kept: it is the weapon's beam,
    not smoke, and its white alpha card is baked to a grayscale emissive map
    because the rest of the export is JPEG.
  - bakes the Sketchfab wrapper transforms into the meshes and deletes the
    `Sketchfab_model` / `Root` / part empties they came in with
  - puts the feet on z = 0
  - fixes the materials: the pipes arrived black at metallic 1.0 (the toad and
    the B-17 both needed this), and every other map was flagged alpha-blended
    although none of them carry alpha
  - decimates the two heavy meshes and drops the base-colour maps to 1024, so
    the guest fits the 5 MB per-model budget
  - exports a JPEG-compressed GLB

The model arrives facing Blender -Y, which the glTF exporter maps to three.js
+Z -- the same convention as the toad and the B-17. `face` in the spec is
therefore a plain yaw with zero pointing down +Z.
"""

import bpy
import os
from mathutils import Matrix, Vector

PROJECT = r"C:\Users\ryanc\projects\cozy"
OUT_DIR = os.path.join(PROJECT, "models", "shogun")
OUT_PATH = os.path.join(OUT_DIR, "model.glb")

# "Raid Boss Shogun" by zeroswat, CC BY 4.0, via Sketchfab.
ASSET_UID = "8700d16e247d4a51956ef904643b95fa"

HULL_SOURCE_NAME = "Shougun_Gundam.002"    # the author's spelling
HULL_NAME = "Shogun_Hull"

# the two smoke puffs, with the empties that hold them. The blade stays: it is
# the weapon's red beam, and prepare_blade() turns its alpha card into an
# emissive map the JPEG export can carry.
VFX_NAMES = ("Smoke0324_S.001", "Smoke0330_S.001")

# only the two meshes that carry the triangles: 97k + 43k of the 167k total
DECIMATE = {
    "Shogun_Hull": 0.55,
    "Gun Sword.002": 0.55,
}
TEXTURE_SIZE = 1024
JPEG_QUALITY = 88


# ------------------------------------------------------------------ helpers

def find_root():
    """The imported hierarchy, whether or not a previous run flattened it."""
    root = bpy.data.objects.get("Root")
    if root is not None:
        return root.parent or root
    for name in ("Sketchfab_model.001", "Sketchfab_model"):
        ob = bpy.data.objects.get(name)
        if ob is not None:
            return ob
    return None


# what the hierarchy is called once run() has flattened it, so a second run does
# not need the empties it deleted the first time
FLAT_NAMES = (
    "Shogun_Hull", "Gun Sword.001", "Gun Sword.002", "Pipes.001",
    "Shougun_Gundam.001", "Shougun_Gundam.003", "Shougun_Gundam.004",
    "Blade",
)
SHOGUN_PREFIXES = ("Shougun_Gundam", "Shogun_Hull", "Gun Sword", "Pipes")


def gather():
    """(root, meshes) on a fresh import, or (None, meshes) after a previous run."""
    root = find_root()
    if root is not None:
        meshes = [ob for ob in root.children_recursive if ob.type == 'MESH']
        # the scene still carries the B-17's wrapper empties; make sure the
        # hierarchy we found is actually this model's before flattening it
        if meshes and any(ob.name.startswith(SHOGUN_PREFIXES) for ob in meshes):
            return root, meshes
    # no usable hierarchy: either a previous run flattened it, or the empty we
    # found belongs to another import (the B-17's wrapper is still in the file)
    meshes = [bpy.data.objects[name] for name in FLAT_NAMES if name in bpy.data.objects]
    if not meshes:
        raise RuntimeError("no Shogun meshes in the scene -- import the asset first")
    return None, meshes


def strip_vfx(root):
    for name in VFX_NAMES:
        ob = bpy.data.objects.get(name)
        if ob is None:
            continue
        for child in list(ob.children_recursive):
            bpy.data.objects.remove(child, do_unlink=True)
        bpy.data.objects.remove(ob, do_unlink=True)
        print("removed VFX:", name)


def bake_and_flatten(root):
    """Fold the wrapper transforms into geometry, then drop the empties."""
    meshes = [ob for ob in root.children_recursive if ob.type == 'MESH']
    empties = [ob for ob in root.children_recursive if ob.type == 'EMPTY']
    if root.type == 'EMPTY':
        empties.append(root)
    if not meshes:
        raise RuntimeError("the hierarchy has no meshes -- did the import fail?")

    for ob in meshes:
        mw = ob.matrix_world.copy()
        ob.parent = None
        ob.matrix_world = mw

    bpy.ops.object.select_all(action='DESELECT')
    for ob in meshes:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    for ob in empties:
        if ob.name in bpy.data.objects:
            bpy.data.objects.remove(ob, do_unlink=True)

    print("flattened to", len(meshes), "meshes")
    return meshes


def ground(meshes):
    """The loader will re-ground it, but an asset whose feet are at zero is
    easier to inspect in Blender and to reason about when writing the spec."""
    lowest = min(
        (ob.matrix_world @ Vector(corner)).z
        for ob in meshes
        for corner in ob.bound_box
    )
    if abs(lowest) < 1e-4:
        return
    for ob in meshes:
        ob.data.transform(Matrix.Translation((0.0, 0.0, -lowest)))
    print("feet moved from z=%.3f to 0" % lowest)


def prepare_blade(mat):
    """Bake the blade's white alpha card into a grayscale emissive map.

    The beam's shape lives entirely in the alpha channel of a 128 px white
    texture. JPEG cannot carry that alpha, and every other map in this export
    wants to stay JPEG, so the mask is baked to white-on-black and the material
    is rebuilt as an opaque emissive card. three.js tints it red and adds it
    over the scene, which is what the original alpha blend was doing. Safe to
    run twice: the custom property marks the material as done.
    """
    if mat.get("creek_blade_prepared"):
        return

    image_node = next(
        (n for n in mat.node_tree.nodes if n.type == 'TEX_IMAGE' and n.image),
        None,
    )
    if image_node is None:
        return
    src = image_node.image
    w, h = src.size
    src_px = list(src.pixels)

    mask = bpy.data.images.new("Blade_mask", width=w, height=h, alpha=False)
    mask.colorspace_settings.name = 'sRGB'
    px = [0.0] * (w * h * 4)
    for i in range(w * h):
        a = src_px[i * 4 + 3]
        px[i * 4 + 0] = a
        px[i * 4 + 1] = a
        px[i * 4 + 2] = a
        px[i * 4 + 3] = 1.0
    mask.pixels = px
    mask.file_format = 'JPEG'
    mask.pack()

    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    out_node = nodes.new('ShaderNodeOutputMaterial')
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = mask
    mat.node_tree.links.new(bsdf.outputs['BSDF'], out_node.inputs['Surface'])
    mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Emission Color'])
    bsdf.inputs['Base Color'].default_value = (0.0, 0.0, 0.0, 1.0)
    bsdf.inputs['Metallic'].default_value = 0.0
    bsdf.inputs['Roughness'].default_value = 1.0
    bsdf.inputs['Alpha'].default_value = 1.0
    bsdf.inputs['Emission Strength'].default_value = 1.0
    mat.blend_method = 'OPAQUE'
    mat.use_backface_culling = False
    mat["creek_blade_prepared"] = True
    print("blade mask baked %dx%d" % (w, h))


def fix_materials(meshes):
    mats = {m for ob in meshes for m in ob.data.materials if m is not None}
    for mat in mats:
        if not mat.use_nodes:
            continue
        if mat.name == "Blade":
            # not an opaque surface: keep its card double-sided and let the
            # emissive map carry the shape
            prepare_blade(mat)
            continue
        mat.blend_method = 'OPAQUE'
        # closed hard-surface parts are single-sided; the glow shells may be
        # open, so leave those double-sided
        mat.use_backface_culling = mat.name not in ("BlueGlow", "GreenGlow")

        bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
        if bsdf is None:
            continue

        if mat.name == "Pipes":
            # arrived at base colour (0, 0, 0), metallic 1.0: with this scene's
            # dim environment that renders as a hole, not a pipe
            bsdf.inputs['Base Color'].default_value = (0.085, 0.085, 0.095, 1.0)
            bsdf.inputs['Metallic'].default_value = 0.55
            bsdf.inputs['Roughness'].default_value = 0.38

        print("material %-10s opaque, culling=%s" % (mat.name, mat.use_backface_culling))


def decimate(meshes):
    for ob in meshes:
        ratio = DECIMATE.get(ob.name)
        if ratio is None or ob.get("creek_decimated"):
            continue
        before = len(ob.data.polygons)
        mod = ob.modifiers.new("Decimate", 'DECIMATE')
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bpy.ops.object.select_all(action='DESELECT')
        ob.select_set(True)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier=mod.name)
        ob["creek_decimated"] = True
        print("decimated %-16s %6d -> %6d polys" % (ob.name, before, len(ob.data.polygons)))


def shrink_textures(meshes):
    seen = set()
    for ob in meshes:
        for mat in ob.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            for node in mat.node_tree.nodes:
                if node.type != 'TEX_IMAGE' or node.image is None:
                    continue
                img = node.image
                if img.name in seen:
                    continue
                seen.add(img.name)
                if max(img.size[:]) > TEXTURE_SIZE:
                    img.scale(TEXTURE_SIZE, TEXTURE_SIZE)
                print("texture %-24s -> %dx%d" % (img.name, img.size[0], img.size[1]))


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
        "use_selection": True,          # the creek, toad and B-17 are in the scene too
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
        # no alpha survives the VFX strip, so this can force JPEG
        "export_image_format": 'JPEG',
        "export_image_quality": JPEG_QUALITY,
        "export_draco_mesh_compression_enable": False,
        "export_hierarchy_flatten_objs": False,
    }
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in valid})
    print("exported %s -> %.2f MB" % (OUT_PATH, os.path.getsize(OUT_PATH) / 1048576.0))
    return OUT_PATH


# --------------------------------------------------------------------- run

def run():
    root, meshes = gather()

    if root is not None:
        strip_vfx(root)

        hull = bpy.data.objects.get(HULL_SOURCE_NAME)
        if hull is not None:
            hull.name = HULL_NAME

        # collect before flattening: clearing the parents empties the hierarchy
        meshes = bake_and_flatten(root)
        ground(meshes)
        print("source hierarchy flattened")
    else:
        print("already flattened; fixing the meshes in place")

    fix_materials(meshes)
    decimate(meshes)
    shrink_textures(meshes)
    return export_glb(meshes)
