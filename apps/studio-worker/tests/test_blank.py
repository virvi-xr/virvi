import numpy as np
from PIL import Image

from conftest import FIXTURES
from studio_worker.render import is_blank


def flat(rgb=(215, 215, 217), size=512):
    return np.full((size, size, 3), rgb, dtype=np.uint8)


def test_one_flat_colour_is_blank():
    assert is_blank(Image.fromarray(flat()))


def test_a_little_noise_is_still_blank():
    rng = np.random.default_rng(1)
    noisy = np.clip(flat().astype(int) + rng.integers(-3, 4, (512, 512, 3)), 0, 255).astype(np.uint8)
    assert is_blank(Image.fromarray(noisy))


def test_a_pale_thin_item_on_the_item_alone_background_is_not_blank():
    # a real beard rendered alone in Inspect: light grey on light grey, its colour spread under the old cut-off of 4
    assert not is_blank(Image.open(FIXTURES / 'pale_beard_alone.png'))


def test_a_small_item_is_not_blank():
    a = flat()
    a[240:272, 240:272] = (60, 60, 70)  # 0.4% of the frame
    assert not is_blank(Image.fromarray(a))


def test_a_transparent_frame_is_blank_and_one_with_an_item_is_not():
    clear = np.zeros((256, 256, 4), dtype=np.uint8)
    assert is_blank(Image.fromarray(clear, 'RGBA'))
    clear[100:140, 100:140] = (200, 30, 30, 255)
    assert not is_blank(Image.fromarray(clear, 'RGBA'))
