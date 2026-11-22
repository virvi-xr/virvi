import json

import numpy as np
from PIL import Image

from ringmarker.codec import TEST_MARKERS
from ringmarker.render import render
from ringmarker.testset import FOCAL_PX, IMAGE, generate


def test_generates(tmp_path):
    generate(tmp_path)
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert len(manifest) >= 38
    for e in manifest:
        with Image.open(tmp_path / e["file"]) as im:
            assert im.size == IMAGE
    ranges = [e for e in manifest if e["case"] == "range"]
    assert len(ranges) == 27
    for e in ranges:
        (m,) = e["markers"]
        assert 0 <= m["center_px"][0] < IMAGE[0] and 0 <= m["center_px"][1] < IMAGE[1]
    assert {e["expect"] for e in manifest} == {"ids", "none"}


def test_ground_truth_geometry(tmp_path):
    generate(tmp_path)
    by = {e["name"]: e for e in json.loads((tmp_path / "manifest.json").read_text())}
    m = by["range-RING120-1.8-0"]["markers"][0]
    assert abs(m["center_px"][0] - IMAGE[0] / 2) < 1e-6 and abs(m["center_px"][1] - IMAGE[1] / 2) < 1e-6
    assert by["rotated_73"]["markers"][0]["rotation_deg"] == 73
    assert FOCAL_PX == 867.0
    assert all(e["focal_px"] == FOCAL_PX for e in by.values())
    # the dot centre in the image is dark: ground truth sits on the dot
    for name in ("rotated_73", "two_markers"):
        im = np.asarray(Image.open(tmp_path / by[name]["file"]))
        for mk in by[name]["markers"]:
            x, y = (int(round(v - 0.5)) for v in mk["center_px"])
            assert im[y - 1:y + 2, x - 1:x + 2].mean() < 90


def test_render_inverted_swaps_dark_and_light():
    mid, dia = TEST_MARKERS["RING140"]
    normal = np.asarray(render(mid, dia, 2.0), np.int16)
    inv = np.asarray(render(mid, dia, 2.0, inverted=True), np.int16)
    assert normal.shape == inv.shape
    # DARK + LIGHT = 255, so the inverted plaque is the photographic negative (to box-filter rounding)
    assert np.abs(inv - (255 - normal)).max() <= 1
    assert inv[0, 0] == normal[150, 150] and inv[150, 150] == normal[0, 0]  # plaque and dot swap
