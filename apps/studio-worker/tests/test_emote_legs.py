import json
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
