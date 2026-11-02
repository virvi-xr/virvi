"""A piece's thumbnail: the item alone, on a transparent background, the way the Builder wants it. Runs inside
Blender (Cycles on the CPU: the worker has no GPU). A scene piece's *_collider meshes are invisible in Decentraland, so
they're left out here too.

    blender -b --factory-startup --python thumbnail_blend.py -- --glb item.glb --out thumbnail.png [--size 256]
"""
import argparse
import math
import re
import sys

import bpy
from mathutils import Vector

SAMPLES = 32
MARGIN = 1.1  # the item fills the frame with a 10% margin
YAW = math.radians(30)  # a 3/4 front view
PITCH = math.radians(15)
COLLIDER = re.compile(r'_collider(_(box|sphere|capsule))?(\.\d+)?$', re.IGNORECASE)


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--glb', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--size', type=int, default=256)
    a = ap.parse_args(argv)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=a.glb)
    scene = bpy.context.scene
    meshes = [o for o in scene.objects if o.type == 'MESH' and not COLLIDER.search(o.name)]
    if not meshes:
        sys.exit(f'no meshes in {a.glb}')
    for o in scene.objects:
        if o not in meshes:
            o.hide_render = True

    depsgraph = bpy.context.evaluated_depsgraph_get()
    corners = [o.evaluated_get(depsgraph).matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    center, extent = (lo + hi) / 2, max((hi - lo).length, 1e-3)

    # glTF's front (+Z) is Blender's -Y: the camera sits in front, turned a little to the item's left and above it
    direction = Vector((math.sin(YAW) * math.cos(PITCH), -math.cos(YAW) * math.cos(PITCH), math.sin(PITCH)))
    cam_data = bpy.data.cameras.new('thumb')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = extent * MARGIN
    cam = bpy.data.objects.new('thumb', cam_data)
    scene.collection.objects.link(cam)
    cam.location = center + direction * extent * 3
    cam.rotation_euler = (center - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam_data.clip_end = extent * 10
    scene.camera = cam

    key = bpy.data.lights.new('key', 'AREA')
    key.energy, key.size = 400 * extent * extent, extent * 2
    key_obj = bpy.data.objects.new('key', key)
    scene.collection.objects.link(key_obj)
    key_obj.location = center + Vector((-1, -1.5, 1.5)) * extent * 2
    key_obj.rotation_euler = (center - key_obj.location).to_track_quat('-Z', 'Y').to_euler()
    world = bpy.data.worlds.new('soft')
    world.use_nodes = True
    background = next(n for n in world.node_tree.nodes if n.type == 'BACKGROUND')
    background.inputs[0].default_value = (0.8, 0.8, 0.8, 1)
    background.inputs[1].default_value = 0.8
    scene.world = world

    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    scene.cycles.samples = SAMPLES
    scene.render.film_transparent = True
    scene.render.resolution_x = scene.render.resolution_y = a.size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    try:
        scene.view_settings.view_transform = 'Standard'  # AgX, the default, darkens the item's own colours
    except TypeError:
        pass
    scene.render.filepath = a.out
    bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
