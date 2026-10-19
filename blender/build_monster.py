"""
build_monster.py -- bring the creek's toad in from Sketchfab and export it to
models/toad/model.glb for the Three.js page.

The download is an MCP tool call rather than plain bpy, so this runs in two
steps. First, in the agent session (this is the part that actually fetches the
mesh, and it needs the user's Sketchfab account):

    import_asset(source="sketchfab",
                 id="db8e45b28c9e495d8472b10f75d82847",   # see ASSET_UID
                 target_size=1.35)                        # run() normalises anyway

Then, inside Blender:

    exec(open(r"C:\\Users\\ryanc\\projects\\cozy\\blender\\build_monster.py").read())
    run()

It keeps its own file rather than joining creek.glb so that re-running
build_creek.py can never clobber the creature.

What run() does:
  - bakes the Sketchfab wrapper transforms into the mesh and deletes the
    Sketchfab_model / root / GLTF_SceneRootNode / geometry_0_0 empties they
    came in with
  - works out which way the toad faces (a sitting toad carries its head and
    shoulders high, so the tall vertices lean towards the front) and rotates
    that onto Blender -Y. The glTF exporter maps Blender (x, y, z) to three.js
    (x, z, -y), so -Y arrives as +Z: the axis an Object3D aims at a target
  - moves the origin to the feet, centred in x/z, so placing it is just a
    position and a yaw
  - drops the base colour to 1024 and exports a JPEG-compressed GLB
"""

import bpy
import json
import math
import os
import struct
from mathutils import Matrix, Vector

PROJECT = r"C:\Users\ryanc\projects\cozy"
# the toad is a guest: it is built into its own folder under models/, with the
# spec and the behaviour that drive it, so everything about it lives together
OUT_DIR = os.path.join(PROJECT, "models", "toad")

# "Standing_giant_toad_green_skin_animated" by pikupila, CC BY 4.0, via Sketchfab.
# The name promises an animation but the download carries no armature and no
# actions, so the walk is done in three.js -- see models/toad/monster.js.
ASSET_UID = "db8e45b28c9e495d8472b10f75d82847"
SOURCE_NAME = "Object_4"           # what the importer calls the mesh
TARGET_SIZE = 1.35                 # metres, largest dimension -- a creek monster,
                                   # not a frog; the scene's lanterns are 1.8 m
TARGET_NAME = "Monster"
TEXTURE_SIZE = 1024
ROUGHNESS = 0.58                   # damp, not lacquered


# ------------------------------------------------------------------ helpers

def find_mesh():
    """The imported mesh, whether or not a previous run already tidied it."""
    for name in (TARGET_NAME, SOURCE_NAME):
        ob = bpy.data.objects.get(name)
        if ob is not None and ob.type == 'MESH':
            return ob
    raise RuntimeError("no monster mesh in the scene -- import the asset first")


def bake_transforms(mesh):
    """Fold the wrapper empties' transforms into the geometry and drop them."""
    mw = mesh.matrix_world.copy()
    mesh.parent = None
    mesh.matrix_world = mw

    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    if bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    for name in ('geometry_0_0', 'GLTF_SceneRootNode', 'root', 'Sketchfab_model'):
        ob = bpy.data.objects.get(name)
        if ob is not None:
            bpy.data.objects.remove(ob, do_unlink=True)

    mesh.name = TARGET_NAME
    mesh.data.name = TARGET_NAME + "Mesh"


def face_along_neg_y(mesh):
    """Rotate the creature so it looks down Blender -Y (three.js +Z)."""
    co = [v.co.copy() for v in mesh.data.vertices]
    top = max(c.z for c in co)

    hi = [c for c in co if c.z > top * 0.82]
    n_hi, n_all = len(hi), len(co)
    chigh = Vector((sum(p.x for p in hi) / n_hi, sum(p.y for p in hi) / n_hi, 0.0))
    call = Vector((sum(p.x for p in co) / n_all, sum(p.y for p in co) / n_all, 0.0))

    facing = chigh - call
    facing.z = 0.0
    facing.normalize()
    alpha = math.degrees(math.atan2(facing.y, facing.x))

    rot = Matrix.Rotation(math.radians(-90.0 - alpha), 4, 'Z')
    for v in mesh.data.vertices:
        v.co = rot @ v.co
    mesh.data.update()
    print("faced -Y (was %.1f deg off +X)" % alpha)


def scale_to_target(mesh, size=TARGET_SIZE):
    """Normalise the largest dimension, whatever the import happened to use.

    Done here rather than left to import_asset's target_size so the exported
    creature is the same size every time, however it was fetched. Idempotent:
    it sets an absolute size rather than multiplying.
    """
    co = [v.co.copy() for v in mesh.data.vertices]
    span = max(
        max(c.x for c in co) - min(c.x for c in co),
        max(c.y for c in co) - min(c.y for c in co),
        max(c.z for c in co) - min(c.z for c in co),
    )
    if span <= 1e-6:
        raise RuntimeError("monster mesh has no extent")
    k = size / span
    for v in mesh.data.vertices:
        v.co *= k
    mesh.data.update()
    print("scaled by %.4f to %.2f m" % (k, size))


def centre_on_feet(mesh):
    """Origin at the centre of the footprint, on the ground plane."""
    co = [v.co.copy() for v in mesh.data.vertices]
    minx = min(c.x for c in co)
    maxx = max(c.x for c in co)
    miny = min(c.y for c in co)
    maxy = max(c.y for c in co)
    minz = min(c.z for c in co)
    maxz = max(c.z for c in co)
    cx, cy = (minx + maxx) / 2.0, (miny + maxy) / 2.0
    for v in mesh.data.vertices:
        v.co.x -= cx
        v.co.y -= cy
        v.co.z -= minz
    mesh.data.update()

    mesh.location = (0.0, 0.0, 0.0)
    mesh.rotation_euler = (0.0, 0.0, 0.0)
    mesh.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()
    print("size %.3f x %.3f x %.3f m" % (maxx - minx, maxy - miny, maxz - minz))


def dress_material(mesh):
    """Metallic off and a damp roughness, so it sits next to the creek props."""
    for mat in mesh.data.materials:
        if mat is None or not mat.use_nodes:
            continue
        for node in mat.node_tree.nodes:
            if node.type != 'BSDF_PRINCIPLED':
                continue
            node.inputs['Metallic'].default_value = 0.0
            node.inputs['Roughness'].default_value = ROUGHNESS
            spec = node.inputs.get('Specular IOR Level')
            if spec is not None:
                spec.default_value = 0.35


def shrink_texture(mesh, size=TEXTURE_SIZE):
    for mat in mesh.data.materials:
        if mat is None or not mat.use_nodes:
            continue
        for node in mat.node_tree.nodes:
            if node.type == 'TEX_IMAGE' and node.image is not None:
                if max(node.image.size[:]) > size:
                    node.image.scale(size, size)
                print("texture %s -> %s" % (node.image.name, node.image.size[:]))


def export_glb(mesh):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "model.glb")

    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh

    rt = bpy.ops.export_scene.gltf.get_rna_type()
    valid = set(p.identifier for p in rt.properties)
    kw = {
        "filepath": path,
        "export_format": 'GLB',
        "use_selection": True,          # the creek is in the scene too
        "export_apply": True,
        "export_yup": True,
        "export_materials": 'EXPORT',
        "export_normals": True,
        "export_texcoords": True,       # creek.glb ships without them; this needs them
        "export_cameras": False,
        "export_lights": False,
        "export_animations": False,     # nothing rigged, see the header
        "export_skins": False,
        "export_morph": False,
        "export_extras": False,
        "export_all_vertex_colors": False,
        "export_image_format": 'JPEG',
        "export_image_quality": 88,
        "export_draco_mesh_compression_enable": False,
        "export_hierarchy_flatten_objs": False,
    }
    bpy.ops.export_scene.gltf(**{k: v for k, v in kw.items() if k in valid})
    print("exported %s -> %.2f MB" % (path, os.path.getsize(path) / 1048576.0))
    return path


def inspect_glb(path=None):
    """Read the GLB's JSON chunk and report what actually made it into the file."""
    path = path or os.path.join(OUT_DIR, "model.glb")
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

    print("nodes:", [(n.get("name"), n.get("translation"), n.get("rotation"))
                     for n in js.get("nodes", [])])
    print("materials:", [json.dumps(m) for m in js.get("materials", [])])
    print("images:", [(i.get("name"), i.get("mimeType")) for i in js.get("images", [])])
    tris = 0
    for mesh in js.get("meshes", []):
        for prim in mesh.get("primitives", []):
            print("mesh %s attrs=%s" % (mesh.get("name"),
                                        sorted(prim.get("attributes", {}).keys())))
            tris += js["accessors"][prim["indices"]]["count"] // 3
    print("TOTAL TRIS:", tris)
    return js


def run():
    mesh = find_mesh()
    bake_transforms(mesh)
    face_along_neg_y(mesh)
    scale_to_target(mesh)
    centre_on_feet(mesh)
    dress_material(mesh)
    shrink_texture(mesh)
    path = export_glb(mesh)
    inspect_glb(path)
    return mesh
