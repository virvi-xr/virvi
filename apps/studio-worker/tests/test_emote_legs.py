import json
from pathlib import Path
import struct

import pytest

import glbfactory as gf
from conftest import FIXTURES
from studio_worker import emote_legs

X, Z = (1, 0, 0), (0, 0, 1)
REST = {}


def crossed(u=0.75):
    """Thighs swung across into an X (knees past each other's side), shins hanging straight down."""
    import math
    deg = math.degrees(math.asin(2 * 8.91 * u / 44.89))
    return {'Avatar_LeftUpLeg': gf.quat(Z, -deg), 'Avatar_LeftLeg': gf.quat(Z, deg),
            'Avatar_RightUpLeg': gf.quat(Z, deg), 'Avatar_RightLeg': gf.quat(Z, -deg)}


SEATED = {'Avatar_LeftUpLeg': gf.quat(X, -90), 'Avatar_LeftLeg': gf.quat(X, 90),
          'Avatar_RightUpLeg': gf.quat(X, -90), 'Avatar_RightLeg': gf.quat(X, 90)}
WIDE = {'Avatar_LeftUpLeg': gf.quat(Z, 25), 'Avatar_LeftLeg': gf.quat(Z, -10),
        'Avatar_RightUpLeg': gf.quat(Z, -25), 'Avatar_RightLeg': gf.quat(Z, 10)}
SQUAT = {'Avatar_LeftUpLeg': gf.quat((-1, 0, 0.4), 100), 'Avatar_LeftLeg': gf.quat(X, 130),
         'Avatar_RightUpLeg': gf.quat((-1, 0, -0.4), 100), 'Avatar_RightLeg': gf.quat(X, 130)}
KNEEL = {'Avatar_LeftUpLeg': gf.quat(X, -90), 'Avatar_LeftLeg': gf.quat(X, 90),   # front foot flat, knee up
         'Avatar_RightUpLeg': gf.quat(X, 10), 'Avatar_RightLeg': gf.quat(X, 80)}   # back knee down, shin behind


def check(tmp_path, keys, **kw):
    return emote_legs.check(gf.emote(tmp_path / 'e.glb', keys, **kw))


@pytest.mark.parametrize('pose', [REST, SEATED, WIDE, SQUAT, KNEEL], ids=['standing', 'seated', 'wide', 'squat', 'kneel'])
def test_poses_with_the_legs_apart_pass(tmp_path, pose):
    r = check(tmp_path, [REST, pose, pose, REST])
    assert r is not None and not r.crossing and r.hits == []


def test_thighs_crossed_into_an_x_fail(tmp_path):
    r = check(tmp_path, [REST, crossed(), crossed(), REST], times=[0, 1, 2, 3])
    assert r.crossing
    thighs = [h for h in r.hits if h.pair == 'thighs']
    assert thighs and min(h.distance_cm for h in thighs) < 1
    assert 1.0 in [h.t for h in thighs] and 2.0 in [h.t for h in thighs]
    assert all(0.3 < h.t < 2.7 for h in thighs)  # rest at both ends: the sampled in-betweens near them are clear
    text = r.describe()
    assert text.startswith('the thighs pass through each other at 0.') and ' s to 2.' in text


def test_a_slight_inward_swing_is_not_crossing(tmp_path):
    # knees drawn in 15% of the way (knock-kneed, thighs touching): mesh contact, not limbs through each other
    assert not check(tmp_path, [REST, crossed(0.15)]).crossing


def test_crossed_shins_are_reported_as_shins(tmp_path):
    # thighs straight down, shins swung across each other below the knee
    import math
    deg = math.degrees(math.asin(0.75 * 2 * 8.91 / 40.71))
    pose = {'Avatar_LeftLeg': gf.quat(Z, -deg), 'Avatar_RightLeg': gf.quat(Z, deg)}
    r = check(tmp_path, [pose, pose])
    assert r.crossing and {h.pair for h in r.hits} == {'shins'}


def test_step_interpolation_holds_the_key(tmp_path):
    # with STEP, the crossed key at t=1 holds until t=2; with LINEAR it blends back toward rest
    r = check(tmp_path, [REST, crossed(), REST], times=[0, 1, 2], interpolation='STEP')
    assert r.crossing and max(h.t for h in r.hits) > 1.9 - 1e-6
    assert min(h.t for h in r.hits) >= 1.0


def test_only_the_avatar_clip_counts_with_a_prop_armature(tmp_path):
    r = check(tmp_path, [REST, crossed(), REST], times=[0, 1, 2], prop=True)
    assert r.clip == 'Test_Avatar' and r.crossing and max(h.t for h in r.hits) < 2
    assert not check(tmp_path, [REST, SEATED, REST], times=[0, 1, 2], prop=True).crossing


def test_hips_translation_moves_both_legs_together(tmp_path):
    hips = [[0, 95, 0], [0, 50, 30], [0, 95, 0]]
    assert not check(tmp_path, [REST, SEATED, REST], hips=hips).crossing


@pytest.mark.parametrize('drop', ['Avatar_RightFoot', 'Avatar_LeftUpLeg', 'Avatar_Hips'])
def test_missing_bones_give_no_verdict(tmp_path, drop):
    assert check(tmp_path, [crossed(), crossed()], drop=(drop,)) is None


def test_not_a_glb_gives_no_verdict(tmp_path):
    (tmp_path / 'x.glb').write_bytes(b'not a glb at all')
    assert emote_legs.check(tmp_path / 'x.glb') is None
    assert emote_legs.check(tmp_path / 'missing.glb') is None


def test_no_animation_gives_no_verdict(tmp_path):
    path = gf.write(tmp_path / 'box.glb', [gf.box('b', (0, 0, 0), (1, 1, 1))])
    assert emote_legs.check(path) is None


def test_thresholds_scale_with_the_rig(tmp_path):
    # the same poses on a rig exported in metres (bones in m, Armature unscaled) give the same verdicts
    path = gf.emote(tmp_path / 'm.glb', [REST, crossed(), crossed(0.15)])
    b = path.read_bytes()
    n = struct.unpack('<I', b[12:16])[0]
    g = json.loads(b[20:20 + n])
    g['nodes'][0]['scale'] = [1, 1, 1]
    for nd in g['nodes'][1:]:
        nd['translation'] = [x / 100 for x in nd.get('translation', [0, 0, 0])]
    js = json.dumps(g).encode()
    js += b' ' * (-len(js) % 4)
    rest = b[20 + n:]
    path.write_bytes(b[:8] + struct.pack('<I', 20 + len(js) + len(rest)) + struct.pack('<I', len(js)) + b[16:20] + js + rest)
    r = emote_legs.check(path)
    assert r.crossing and all(0.3 < h.t < 1.9 for h in r.hits)


# The official avatar rig, posed and exported by Blender with emotelib (body shape A): the real bone rolls and
# rest rotations, not the test rig's identity ones.
def test_real_rig_crossed_thighs_fail():
    r = emote_legs.check(FIXTURES / 'emote_legs' / 'crossed_thighs.glb')
    assert r.crossing and {h.pair for h in r.hits} == {'thighs'}


def test_real_rig_seated_passes():
    r = emote_legs.check(FIXTURES / 'emote_legs' / 'seated.glb')
    assert r is not None and not r.crossing


def test_real_wave_emote_passes():
    r = emote_legs.check(FIXTURES / 'wave.glb')
    assert r is not None and not r.crossing and r.samples >= 30


# ---- fix round 1
def test_cubicspline_with_flat_tangents_eases_between_keys(tmp_path):
    r = check(tmp_path, [REST, crossed(), REST], times=[0, 1, 2], interpolation='CUBICSPLINE')
    assert r.crossing and all(0.3 < h.t < 1.7 for h in r.hits)
    assert not check(tmp_path, [REST, SEATED, REST], times=[0, 1, 2], interpolation='CUBICSPLINE').crossing


def _restride(path, normalized_int16=False):
    """Rewrite every rotation output into its own strided bufferView (float VEC4 with 4 bytes of padding, or
    normalized int16 VEC4 with 4 bytes of padding)."""
    import numpy as np
    g, blob = gf.read_glb(path)
    outs = {s['output'] for a in g['animations'] for s in a['samplers']
            if g['accessors'][s['output']]['type'] == 'VEC4'}
    for i in outs:
        acc = g['accessors'][i]
        v = g['bufferViews'][acc['bufferView']]
        vals = np.frombuffer(bytes(blob[v['byteOffset']:v['byteOffset'] + v['byteLength']]), np.float32).reshape(-1, 4)
        if normalized_int16:
            items, ctype, stride = np.round(vals * 32767).astype(np.int16), 5122, 12
        else:
            items, ctype, stride = vals, 5126, 20
        rows = b''.join(r.tobytes() + b'\xab' * (stride - r.nbytes) for r in items)
        while len(blob) % 4:
            blob.append(0)
        g['bufferViews'].append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(rows), 'byteStride': stride})
        blob.extend(rows)
        acc.update(bufferView=len(g['bufferViews']) - 1, componentType=ctype, **({'normalized': True} if normalized_int16 else {}))
    gf.write_glb(path, g, blob)
    return path


@pytest.mark.parametrize('int16', [False, True], ids=['float', 'normalized-int16'])
def test_strided_rotation_accessors_read_the_same(tmp_path, int16):
    path = _restride(gf.emote(tmp_path / 'e.glb', [REST, crossed(), crossed(0.15)]), int16)
    r = emote_legs.check(path)
    assert r.crossing and all(0.3 < h.t < 1.9 for h in r.hits)
    assert not emote_legs.check(_restride(gf.emote(tmp_path / 's.glb', [REST, SEATED]), int16)).crossing


def test_integers_are_only_normalized_when_flagged(tmp_path):
    path = _restride(gf.emote(tmp_path / 'e.glb', [REST, crossed()]), normalized_int16=True)
    g, blob = gf.read_glb(path)
    for acc in g['accessors']:
        acc.pop('normalized', None)  # int16 read raw: quaternions of ~32767 that normalize to the same rotation
    gf.write_glb(path, g, blob)
    assert emote_legs._accessor(g, blob, next(i for i, a in enumerate(g['accessors']) if a['componentType'] == 5122)).max() > 1000


def _standing_ankles_crossed():
    import numpy as np
    # right leg straight, its ankle 10 cm in front of the left one; left leg straight down
    hip, ankle = np.array([-8.91, 0, 0]), np.array([8.91, -85.6, 10])
    d = (ankle - hip) / np.linalg.norm(ankle - hip)
    down = np.array([0, -1, 0])
    axis = np.cross(down, d)
    return {'Avatar_RightUpLeg': gf.quat(axis, np.degrees(np.arccos(down @ d)))}


def test_standing_with_the_ankles_crossed_passes(tmp_path):
    pose = _standing_ankles_crossed()
    assert not check(tmp_path, [REST, pose, pose, REST]).crossing


def test_the_clip_named_avatar_wins_over_a_stale_one(tmp_path):
    path = gf.emote(tmp_path / 'e.glb', [REST, crossed(), REST], times=[0, 1, 2])
    g, blob = gf.read_glb(path)
    stale = json.loads(json.dumps(g['animations'][0]))
    stale['name'] = 'Action'
    stale['channels'] += [dict(stale['channels'][0])]  # more chain channels than the real clip
    g['animations'].insert(0, stale)
    gf.write_glb(path, g, blob)
    assert emote_legs.check(path).clip == 'Test_Avatar'


def test_several_clips_none_named_avatar_give_no_verdict(tmp_path):
    path = gf.emote(tmp_path / 'e.glb', [REST, crossed()], name='Test')
    g, blob = gf.read_glb(path)
    g['animations'][0]['name'] = 'Reading'
    g['animations'].append({**json.loads(json.dumps(g['animations'][0])), 'name': 'Action'})
    gf.write_glb(path, g, blob)
    assert emote_legs.check(path) is None
    g['animations'] = g['animations'][:1]  # one clip, whatever its name, is the clip
    gf.write_glb(path, g, blob)
    assert emote_legs.check(path).crossing


def test_a_parent_cycle_gives_no_verdict(tmp_path):
    path = gf.emote(tmp_path / 'e.glb', [REST, crossed()])
    g, blob = gf.read_glb(path)
    g['nodes'].append({'name': 'Loop', 'children': [0]})
    g['nodes'][0].setdefault('children', []).append(len(g['nodes']) - 1)
    gf.write_glb(path, g, blob)
    assert emote_legs.check(path) is None


def test_a_very_deep_chain_gives_no_verdict(tmp_path):
    path = gf.emote(tmp_path / 'e.glb', [REST, crossed()])
    g, blob = gf.read_glb(path)
    below = 0
    for _ in range(3000):
        g['nodes'].append({'name': 'Wrap', 'children': [below]})
        below = len(g['nodes']) - 1
    g['scenes'][0]['nodes'] = [below]
    gf.write_glb(path, g, blob)
    assert emote_legs.check(path) is None


def test_any_error_inside_the_check_is_no_verdict(tmp_path, monkeypatch, capsys):
    path = gf.emote(tmp_path / 'e.glb', [REST, crossed()])
    monkeypatch.setattr(emote_legs, '_joints', lambda *a: (_ for _ in ()).throw(RuntimeError('boom')))
    assert emote_legs.check(path) is None
    assert 'boom' in capsys.readouterr().err


def test_an_oversized_or_odd_file_is_not_read(tmp_path, monkeypatch):
    import os
    path = gf.emote(tmp_path / 'e.glb', [REST, crossed()])
    monkeypatch.setattr(emote_legs, 'MAX_BYTES', 100)
    assert emote_legs.check(path) is None
    monkeypatch.undo()
    os.mkfifo(tmp_path / 'fifo.glb')
    assert emote_legs.check(tmp_path / 'fifo.glb') is None  # returns at once instead of blocking on the pipe
    os.symlink(path, tmp_path / 'link.glb')
    assert emote_legs.check(tmp_path / 'link.glb') is None


# ---- fix round 2: malformed accessors never read out of bounds
BAD_LAYOUTS = {
    'negative stride': {'view': {'byteStride': -12}},
    'huge negative stride': {'view': {'byteStride': -100000000}},
    'zero stride': {'view': {'byteStride': 0}},
    'stride below the element': {'view': {'byteStride': 8}},
    'stride not a multiple of the component': {'view': {'byteStride': 18}},
    'huge stride': {'view': {'byteStride': 10 ** 12}},
    'stride not an int': {'view': {'byteStride': 16.5}},
    'negative view offset': {'view': {'byteOffset': -4}},
    'view past the chunk': {'view': {'byteOffset': 10 ** 9}},
    'view longer than the chunk': {'view': {'byteLength': 10 ** 9}},
    'negative accessor offset': {'acc': {'byteOffset': -16}},
    'accessor past its view': {'acc': {'byteOffset': 10 ** 6}},
    'count past its view': {'acc': {'count': 10 ** 7}},
    'negative count': {'acc': {'count': -3}},
    'count not an int': {'acc': {'count': 'many'}},
    'view index out of range': {'acc': {'bufferView': 999}},
    'negative view index': {'acc': {'bufferView': -1}},
}


def test_malformed_accessors_are_no_verdict_and_never_crash(tmp_path):
    import subprocess
    import sys
    paths = []
    for label, change in BAD_LAYOUTS.items():
        path = gf.emote(tmp_path / f'{len(paths)}.glb', [REST, crossed()])
        g, blob = gf.read_glb(path)
        out = next(s['output'] for s in g['animations'][0]['samplers'] if g['accessors'][s['output']]['type'] == 'VEC4')
        acc = g['accessors'][out]
        g['bufferViews'][acc['bufferView']].update(change.get('view', {}))
        acc.update(change.get('acc', {}))
        gf.write_glb(path, g, blob)
        paths.append((label, str(path)))
    # in a child process: a crash there fails this test instead of killing pytest
    code = ('import sys, json; from studio_worker import emote_legs\n'
            'print(json.dumps([emote_legs.check(p) is None for p in sys.argv[1:]]))')
    p = subprocess.run([sys.executable, '-c', code, *[p for _, p in paths]], capture_output=True, text=True,
                       cwd=Path(__file__).parent.parent, timeout=120)
    assert p.returncode == 0, p.stderr[-2000:]
    verdicts = json.loads(p.stdout.splitlines()[-1])
    assert [label for (label, _), none in zip(paths, verdicts) if not none] == []
