"""Writes tests/fixtures/scene/: a walk-in kiosk, a chair people sit on and a wide couch. Run it after changing it:

    python3 tests/make_scene_fixtures.py
"""
import json
from pathlib import Path

import glbfactory as gf

HERE = Path(__file__).parent / 'fixtures' / 'scene'


def piece(folder, meta, glb_name, nodes, extras=None):
    d = HERE / folder
    d.mkdir(parents=True, exist_ok=True)
    gf.write(d / glb_name, nodes)
    (d / 'piece.json').write_text(json.dumps({'description': '', 'changeKind': 'new', **meta}, indent=1))
    for name, data in (extras or {}).items():
        (d / name).write_text(json.dumps(data, indent=1))


def room(door_width=1.2):
    """A 10 x 10 m room, 3 m walls 0.2 m thick, a doorway 2.4 m high in the +Z wall."""
    t, h, half = 0.2, 3.0, door_width / 2
    walls = [('Back', (-5, 0, -5), (5, h, -5 + t)), ('Left', (-5, 0, -5), (-5 + t, h, 5)),
             ('Right', (5 - t, 0, -5), (5, h, 5)), ('FrontL', (-5, 0, 5 - t), (-half, h, 5)),
             ('FrontR', (half, 0, 5 - t), (5, h, 5)), ('Lintel', (-half, 2.4, 5 - t), (half, h, 5))]
    return [gf.box(n, lo, hi) for n, lo, hi in walls] + [gf.box(f'{n}_collider', lo, hi, material=None) for n, lo, hi in walls]


if __name__ == '__main__':
    piece('building', {'name': 'Little Kiosk', 'kind': 'building', 'type': 'kiosk', 'footprint': '1x1'}, 'kiosk.glb',
          room(), {'route.json': {'waypoints': [[0, 8], [0, 0], [-3, -3]]},
                   'layout.json': {'furniture': [{'category': 'furniture_chair', 'x': 3, 'z': -3, 'yaw': 0}]}})
    piece('furniture_chair', {'name': 'Neon Chair', 'kind': 'furniture', 'type': 'chair'}, 'chair.glb', [
        gf.box('Seat', (-0.25, 0.40, -0.25), (0.25, 0.47, 0.25)),
        gf.box('Legs', (-0.22, 0.0, -0.22), (0.22, 0.40, 0.22)),
        gf.box('Back', (-0.25, 0.47, -0.25), (0.25, 1.0, -0.18)),
        gf.box('Chair_collider', (-0.25, 0.0, -0.25), (0.25, 0.47, 0.2), material=None)],
        {'chair.sittables.json': {'file': 'chair.glb', 'scale': 1, 'uprightX': 0, 'yawOffset': 0, 'collision': 'colliders',
                                  'kind': 'bench', 'seats': [{'across': 0, 'forward': 0.38, 'rise': 0, 'orbForward': 0, 'orbRise': 0.7}]}})
    piece('furniture_wide_couch', {'name': 'Wide Couch', 'kind': 'furniture', 'type': 'couch'}, 'couch.glb', [
        gf.box('Couch', (-1, 0, -0.4), (1, 0.8, 0.4)),
        gf.box('Couch_collider', (-1, 0, -0.4), (1, 0.8, 0.4), material=None)])
