import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import glbfactory as gf
from conftest import FIXTURES
from studio_worker import render, scene_render

SCENE = FIXTURES / 'scene'
needs_page = pytest.mark.skipif(not scene_render.available(), reason='no Chrome or no scene_page/vendor (run scripts/fetch_babylon.sh)')


def item(folder, glb, at=None):
    meta = json.loads((SCENE / folder / 'piece.json').read_text())
    return {'category': folder, 'glbs': {'unisex': SCENE / folder / glb}, 'meta': meta, 'at': at}


def differ(a, b):
    return np.abs(np.asarray(Image.open(a).convert('RGB'), float) - np.asarray(Image.open(b).convert('RGB'), float)).mean() > 1


@needs_page
def test_scene_orbit_renders_the_ring_and_the_sphere(tmp_path):
    ring = scene_render.render([item('furniture_chair', 'chair.glb')], {'mode': 'scene-orbit', 'ring': True}, tmp_path / 'ring')
    assert ring['ok'], ring
    assert len(ring['frames']) == 24 and not any(render.is_blank(Image.open(f)) for f in ring['frames'])
    full = scene_render.render([item('furniture_chair', 'chair.glb')], {'mode': 'scene-orbit', 'ring': False}, tmp_path / 'full')
    assert full['ok'] and len(full['frames']) == 122
    assert differ(full['frames'][120], full['frames'][121])  # straight down and straight up


@needs_page
def test_scale_turns_round_the_piece_beside_the_mannequin(tmp_path):
    r = scene_render.render([item('furniture_chair', 'chair.glb')], {'mode': 'scale'}, tmp_path / 'scale')
    assert r['ok'], r
    assert len(r['frames']) == 36 and differ(r['frames'][0], r['frames'][9])


@needs_page
def test_tour_walks_into_the_building(tmp_path, skills):
    route = json.loads((SCENE / 'building/route.json').read_text())
    path = scene_render.tour_path(SCENE / 'building/kiosk.glb', route, [])
    r = scene_render.render([item('building', 'kiosk.glb')], {'mode': 'tour', 'path': path}, tmp_path / 'tour')
    assert r['ok'], r
    assert r['fps'] == 24.0 and len(r['frames']) >= 4 * 24
    assert differ(r['frames'][0], r['frames'][-1])


def test_tour_path_follows_the_floors(skills):
    route = json.loads((SCENE / 'building/route.json').read_text())
    path = scene_render.tour_path(SCENE / 'building/kiosk.glb', route, [])
    assert path[0][0] == pytest.approx(0) and path[0][2] == pytest.approx(8)
    assert path[-1][0] == pytest.approx(-3) and path[-1][2] == pytest.approx(-3)
    assert all(abs(y - 1.6) < 0.01 for _, y, _ in path)  # a flat floor: eye height all the way
    steps = [np.hypot(b[0] - a[0], b[2] - a[2]) for a, b in zip(path, path[1:])]
    assert max(steps) <= 0.051


@needs_page
def test_a_blank_scene_frame_is_kept(tmp_path):
    glb = gf.write(tmp_path / 'ghost.glb', [gf.box('Ghost', (-0.3, 0, -0.3), (0.3, 0.6, 0.3))],
                   materials=[{'name': 'Clear', 'alphaMode': 'BLEND',
                               'pbrMetallicRoughness': {'baseColorFactor': [1, 1, 1, 0]}}])
    piece = {'category': 'furniture_ghost', 'glbs': {'unisex': glb}, 'meta': {'kind': 'decor'}, 'at': None}
    r = scene_render.render([piece], {'mode': 'scene-orbit', 'ring': True}, tmp_path / 'o')
    assert r['ok'] is False and r['error'] == 'blank' and r['blankFrame']['index'] == 0


def test_render_dispatches_scene_modes(tmp_path, monkeypatch):
    seen = []
    monkeypatch.setattr(scene_render, 'render', lambda *a, **k: seen.append(a[1]) or {'ok': True, 'frames': []})
    render.render([], {'mode': 'scale'}, tmp_path / 'x')
    assert seen == [{'mode': 'scale'}]
    assert render.SCENE_MODES == ('scene-orbit', 'scale', 'tour')


@needs_page
def test_studio_preview_on_a_scene_piece_writes_four_views(tmp_path):
    design = tmp_path / 'd'
    shutil.copytree(SCENE / 'furniture_chair', design / 'out/furniture_chair')
    run = subprocess.run([sys.executable, '-m', 'studio_worker.render', 'out/furniture_chair'], cwd=design,
                         capture_output=True, text=True, timeout=300, env={**__import__('os').environ,
                         'PYTHONPATH': str(Path(__file__).parents[1])})
    assert run.returncode == 0, run.stdout + run.stderr
    names = sorted(Path(p).name for p in run.stdout.split())
    assert names == ['furniture_chair-back.png', 'furniture_chair-front.png', 'furniture_chair-left.png', 'furniture_chair-right.png']


def test_a_plain_wall_filling_the_frame_is_drawn_but_the_background_alone_is_not():
    assert scene_render.nothing_drawn(Image.new('RGB', (64, 64), scene_render.BACKGROUND))
    assert not scene_render.nothing_drawn(Image.new('RGB', (64, 64), (110, 110, 110)))


@needs_page
def test_inspect_starts_at_the_front_which_is_plus_z(tmp_path):
    # the front of a scene piece is glTF +Z (the skills' convention): Inspect's first frame looks at it
    glb = gf.write(tmp_path / 'marked.glb', [gf.box('Body', (-0.5, 0, -0.5), (0.5, 1, 0.5), material=0),
                                             gf.box('FrontMark', (-0.3, 0.3, 0.5), (0.3, 0.7, 0.6), material=1)],
                   materials=[{'name': 'Grey', 'pbrMetallicRoughness': {'baseColorFactor': [0.5, 0.5, 0.5, 1]}},
                              {'name': 'Red', 'pbrMetallicRoughness': {'baseColorFactor': [1, 0, 0, 1]}}])
    piece = {'category': 'furniture_marked', 'glbs': {'unisex': glb}, 'meta': {'kind': 'decor'}, 'at': None}
    r = scene_render.render([piece], {'mode': 'scene-orbit', 'ring': True}, tmp_path / 'o')
    assert r['ok'], r

    def red(path):
        a = np.asarray(Image.open(path).convert('RGB'), int)
        return int(((a[..., 0] > a[..., 1] + 40) & (a[..., 0] > a[..., 2] + 40)).sum())  # red, however it's lit
    assert red(r['frames'][0]) > 500, 'the front (+Z) is not facing the camera in frame 0'
    assert red(r['frames'][12]) == 0


@needs_page
def test_the_walk_through_camera_stands_where_the_path_says(tmp_path):
    # a path in front of the red +Z face, looking at it: the walk-through sees red; walking behind the box, it doesn't
    glb = gf.write(tmp_path / 'marked.glb', [gf.box('Body', (-1, 0, -1), (1, 2, 1), material=0),
                                             gf.box('FrontMark', (-0.6, 0.6, 1), (0.6, 1.6, 1.1), material=1)],
                   materials=[{'name': 'Grey', 'pbrMetallicRoughness': {'baseColorFactor': [0.5, 0.5, 0.5, 1]}},
                              {'name': 'Red', 'pbrMetallicRoughness': {'baseColorFactor': [1, 0, 0, 1]}}])
    piece = {'category': 'building', 'glbs': {'unisex': glb}, 'meta': {'kind': 'building'}, 'at': None}

    def reddest(path):
        r = scene_render.render([piece], {'mode': 'tour', 'path': path, 'sample': 4}, tmp_path / f'tour{len(path)}{path[0][2]}')
        assert r['ok'], r
        a = np.asarray(Image.open(r['frames'][0]).convert('RGB'), int)
        return int(((a[..., 0] > a[..., 1] + 40) & (a[..., 0] > a[..., 2] + 40)).sum())
    front = [[0, 1.2, 5 - i * 0.05] for i in range(40)]   # walking towards the +Z face
    back = [[0, 1.2, -5 + i * 0.05] for i in range(40)]   # walking towards the -Z face
    assert reddest(front) > 500
    assert reddest(back) == 0


@needs_page
def test_a_glb_cannot_pull_local_files_into_its_frames(tmp_path):
    # an agent-written GLB whose texture points at a file on the worker: whatever happens, that file never shows
    import json as _json
    import struct
    red = tmp_path / 'secret.png'
    Image.new('RGB', (64, 64), (255, 0, 0)).save(red)
    glb = gf.write(tmp_path / 'plain.glb', [gf.box('Body', (-0.5, 0, -0.5), (0.5, 1, 0.5))])
    data = glb.read_bytes()
    n = struct.unpack('<I', data[12:16])[0]
    g = _json.loads(data[20:20 + n])
    uvs = np.array([[0.5, 0.5]] * 8, '<f4').tobytes()
    rest = bytearray(data[20 + n + 8:])
    g['bufferViews'].append({'buffer': 0, 'byteOffset': len(rest), 'byteLength': len(uvs)})
    rest += uvs
    g['buffers'][0]['byteLength'] = len(rest)
    g['accessors'].append({'bufferView': len(g['bufferViews']) - 1, 'componentType': 5126, 'count': 8, 'type': 'VEC2'})
    g['meshes'][0]['primitives'][0]['attributes']['TEXCOORD_0'] = len(g['accessors']) - 1
    g['images'] = [{'uri': red.as_uri()}]
    g['textures'] = [{'source': 0}]
    g['materials'][0]['pbrMetallicRoughness'] = {'baseColorTexture': {'index': 0}}
    js = _json.dumps(g).encode()
    js += b' ' * (-len(js) % 4)
    out = struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(rest)) + struct.pack('<II', len(js), 0x4E4F534A) + js + \
        struct.pack('<II', len(rest), 0x004E4942) + bytes(rest)
    glb.write_bytes(out)
    piece = {'category': 'furniture_plain', 'glbs': {'unisex': glb}, 'meta': {'kind': 'decor'}, 'at': None}
    r = scene_render.render([piece], {'mode': 'scene-orbit', 'ring': True}, tmp_path / 'o')
    if r['ok']:
        a = np.asarray(Image.open(r['frames'][0]).convert('RGB'), int)
        assert int(((a[..., 0] > a[..., 1] + 60) & (a[..., 0] > a[..., 2] + 60)).sum()) == 0
