import os
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

import glbfactory as gf

SCRIPT = Path(__file__).parents[1] / 'studio_worker' / 'thumbnail_blend.py'
BLENDER = os.environ.get('BLENDER') or shutil.which('blender') or '/Applications/Blender 4.4.app/Contents/MacOS/Blender'
pytestmark = pytest.mark.skipif(not Path(BLENDER).exists(), reason='no Blender')


def test_a_scene_piece_thumbnail_leaves_its_colliders_out(tmp_path):
    # a red stool inside a collider box twice its size: the thumbnail shows the stool, framed on it, nothing else
    glb = gf.write(tmp_path / 'stool.glb', [gf.box('Stool', (-0.2, 0, -0.2), (0.2, 0.8, 0.2), material=0),
                                            gf.box('Stool_collider', (-0.5, 0, -0.5), (0.5, 1.6, 0.5), material=None)],
                   materials=[{'name': 'Red', 'pbrMetallicRoughness': {'baseColorFactor': [1, 0, 0, 1]}}])
    out = tmp_path / 'thumb.png'
    run = subprocess.run([BLENDER, '-b', '--factory-startup', '--python', str(SCRIPT), '--', '--glb', str(glb),
                          '--out', str(out), '--size', '128'], capture_output=True, text=True, timeout=300)
    assert run.returncode == 0 and out.exists(), run.stdout[-1500:] + run.stderr[-1500:]
    a = np.asarray(Image.open(out).convert('RGBA'), int)
    opaque = a[..., 3] > 128
    red = opaque & (a[..., 0] > a[..., 1] + 40) & (a[..., 0] > a[..., 2] + 40)
    assert opaque.sum() > 0
    assert (opaque & ~red).sum() < 0.05 * opaque.sum(), 'something other than the stool is in the thumbnail'
    ys, xs = np.nonzero(opaque)
    assert ys.max() - ys.min() > 0.7 * 128  # framed on the stool, not on the bigger collider
