"""Run by Blender (not by you): turns whatever Blender can open into one binary STL in millimetres.

    blender --background --factory-startup -Y [file.blend] --python blender_to_stl.py -- <input> <output.stl>

A .blend is opened by Blender itself (it is given before --python); every other type is imported here.
"""
import os
import struct
import sys

import bpy

src, dst = sys.argv[sys.argv.index("--") + 1:][:2]
ext = os.path.splitext(src)[1].lower()


def importer():
    ops = {
        ".fbx": lambda: bpy.ops.import_scene.fbx(filepath=src),
        ".gltf": lambda: bpy.ops.import_scene.gltf(filepath=src),
        ".glb": lambda: bpy.ops.import_scene.gltf(filepath=src),
        ".dae": lambda: bpy.ops.wm.collada_import(filepath=src),
        ".usd": lambda: bpy.ops.wm.usd_import(filepath=src),
        ".usda": lambda: bpy.ops.wm.usd_import(filepath=src),
        ".usdc": lambda: bpy.ops.wm.usd_import(filepath=src),
        ".usdz": lambda: bpy.ops.wm.usd_import(filepath=src),
        ".abc": lambda: bpy.ops.wm.alembic_import(filepath=src),
        ".x3d": lambda: bpy.ops.import_scene.x3d(filepath=src),
        ".wrl": lambda: bpy.ops.import_scene.x3d(filepath=src),
        ".3ds": lambda: bpy.ops.import_scene.max3ds(filepath=src),
        ".obj": lambda: bpy.ops.wm.obj_import(filepath=src),
        ".ply": lambda: bpy.ops.wm.ply_import(filepath=src),
        ".stl": lambda: bpy.ops.wm.stl_import(filepath=src),
    }
    if ext not in ops:
        raise RuntimeError("Blender has no importer for %s files" % ext)
    for o in list(bpy.data.objects):          # start from an empty scene
        bpy.data.objects.remove(o, do_unlink=True)
    try:
        ops[ext]()
    except AttributeError:
        raise RuntimeError("This version of Blender cannot open %s files" % ext)


if ext != ".blend":
    importer()

scene = bpy.context.scene
to_mm = 1000.0 * (scene.unit_settings.scale_length or 1.0)
deps = bpy.context.evaluated_depsgraph_get()
tris = []
for inst in deps.object_instances:            # includes collection instances and modifiers
    obj = inst.object
    if obj.type not in {"MESH", "CURVE", "SURFACE", "FONT", "META"}:
        continue
    try:
        mesh = obj.to_mesh()
    except RuntimeError:
        continue
    if mesh is None:
        continue
    mesh.calc_loop_triangles()
    mat = inst.matrix_world.copy()
    verts = [(mat @ v.co) * to_mm for v in mesh.vertices]
    for t in mesh.loop_triangles:
        a, b, c = (verts[i] for i in t.vertices)
        tris.append((a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z))
    obj.to_mesh_clear()

if not tris:
    print("PLASMA_ERROR no mesh objects found in the file")
    sys.exit(3)
with open(dst, "wb") as f:
    f.write(b"plasma table: converted by Blender".ljust(80, b" "))
    f.write(struct.pack("<I", len(tris)))
    for t in tris:
        f.write(struct.pack("<12fH", 0.0, 0.0, 0.0, *t, 0))
print("PLASMA_OK %d triangles" % len(tris))
