import json
import math
import shutil
import threading
import time
from functools import partial
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import pytest

from conftest import FIXTURES
from studio_worker import config, render

HAT = {'category': 'hat', 'glbs': {'male': FIXTURES / 'cap/neon_cap_male.glb',
                                   'female': FIXTURES / 'cap/neon_cap_female.glb'}, 'meta': {'name': 'Neon Cap'}}
WAVE = {'category': 'emote', 'glbs': {'unisex': FIXTURES / 'wave.glb'}, 'meta': {'name': 'Wave', 'loop': False}}
SPIN = {'bodyShape': 'male', 'outfit': 'default', 'emote': None, 'mode': 'spin'}

pytestmark = pytest.mark.skipif(not (shutil.which('google-chrome') or render.chrome_available()),
                                reason='needs Google Chrome')


@pytest.fixture
def stub(monkeypatch):
    """Serves the stub preview and records the controller requests it is sent."""
    calls = []

    class Handler(SimpleHTTPRequestHandler):
        def do_POST(self):
            calls.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            self.send_response(204)
            self.end_headers()

        def log_message(self, *a):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(FIXTURES)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f'http://127.0.0.1:{server.server_port}/preview_stub.html'

    def use(mode=''):
        monkeypatch.setattr(config, 'PREVIEW_URL', base + (f'?stub={mode}' if mode else ''))
        return calls

    yield use
    server.shutdown()


def test_render_watchdog_kills_hung_preview(tmp_path, stub):
    stub('hang')
    start = time.monotonic()
    r = render.render([HAT], SPIN, tmp_path, watchdog_sec=3)
    assert r['ok'] is False and r['error'] == 'timeout'
    assert time.monotonic() - start < 10


def test_item_not_loaded_is_reported(tmp_path, stub):
    stub('noload')
    r = render.render([HAT], SPIN, tmp_path, watchdog_sec=60)
    assert r['ok'] is False and r['error'] == 'item_not_loaded'
    assert not list(tmp_path.glob('*.webp'))  # no frames of a bare avatar


def test_piece_that_lowers_the_triangles_counts_as_loaded(tmp_path, stub):
    stub('fewer')  # a hat that hides the hair, or a jacket replacing the base top
    r = render.render([{**HAT, 'meta': {'name': 'Neon Cap', 'hides': ['hair']}}], SPIN, tmp_path, frames=4,
                      watchdog_sec=60)
    assert r['ok'] is True, r


def test_spin_sends_36_rotations(tmp_path, stub):
    calls = stub()
    r = render.render([HAT], SPIN, tmp_path, watchdog_sec=60)
    assert r['ok'] is True, r
    turns = [c for c in calls if c['method'] == 'changeCameraPosition']
    assert len(turns) == 36
    assert all(c['params'][0]['alpha'] == pytest.approx(0.1745, abs=1e-4) for c in turns)
    assert len(r['frames']) == 36 and all(f.suffix == '.webp' and f.exists() for f in r['frames'])


def test_emote_frames_step_through_length(tmp_path, stub):
    calls = stub()
    r = render.render([WAVE], {**SPIN, 'mode': 'emote'}, tmp_path, frames=10, watchdog_sec=60)
    assert r['ok'] is True, r
    names = [c['method'] for c in calls if c['namespace'] == 'emote']
    i = names.index('pause')  # getLength is also read earlier, to see that the emote loaded
    assert names[i + 1] == 'getLength'
    goes = [c['params'][0] for c in calls if c['method'] == 'goTo']
    assert goes == pytest.approx([i * 0.3 for i in range(10)])
    assert len(r['frames']) == 10


def test_studio_preview_takes_relative_paths(tmp_path, stub, monkeypatch):
    stub()
    hat = tmp_path / 'out/hat'
    hat.mkdir(parents=True)
    for g in (FIXTURES / 'cap').glob('*.glb'):
        shutil.copy(g, hat / g.name)
    (hat / 'piece.json').write_text('{"name": "Neon Cap", "category": "hat"}')
    monkeypatch.chdir(tmp_path)
    paths = render.look([Path('out/hat')], Path('review'))
    assert sorted(p.name for p in paths) == sorted(f'{s}-{v}.png' for s in ('male', 'female')
                                                   for v in ('front', 'right', 'back', 'left'))
    assert all((tmp_path / p).exists() for p in paths)


def test_thumbnail_mode_query():
    assert 'disableBackground=true' in render._query({'bodyShape': 'male', 'outfit': 'default', 'emote': None, 'mode': 'thumbnail'})
    assert 'disableBackground=false' in render._query(SPIN)


def test_emote_thumbnail_is_mid_emote_and_square(tmp_path, stub):
    from PIL import Image
    calls = stub()
    r = render.render([WAVE], {**SPIN, 'mode': 'thumbnail'}, tmp_path, size=512, watchdog_sec=60)
    assert r['ok'] is True, r
    assert [c['params'][0] for c in calls if c['method'] == 'goTo'] == pytest.approx([1.5])
    assert [f.name for f in r['frames']] == ['thumbnail.png']
    image = Image.open(r['frames'][0])
    assert image.size == (256, 256) and image.mode == 'RGBA'


def test_orbit_steps_cover_the_sphere():
    steps = render.orbit_steps(ring=False)
    assert len(steps) == 122
    beta, betas = math.pi / 2, []
    for s in steps:
        beta += s.get('beta', 0)
        betas.append(round(math.degrees(beta)))
    assert betas[:24] == [90] * 24 and betas[24:48] == [60] * 24 and betas[96:120] == [150] * 24
    assert betas[120] == 0 and betas[121] == 180
    assert sum(s.get('alpha', 0) for s in steps[:24]) == pytest.approx(2 * math.pi * 23 / 24)


def test_orbit_rows_start_back_at_the_front():
    steps = render.orbit_steps(ring=False)
    alpha = 0.0
    for i, s in enumerate(steps[:120]):
        alpha += s.get('alpha', 0)
        cols = alpha / (2 * math.pi / 24)
        assert cols == pytest.approx(round(cols), abs=1e-6) and round(cols) % 24 == i % 24


def test_orbit_ring_is_the_first_24():
    assert render.orbit_steps(ring=True) == render.orbit_steps(ring=False)[:24]


def test_walk_schedule_spreads_a_short_emote_over_four_seconds():
    times, fps = render.walk_schedule(2.0)
    assert len(times) == 96 and fps == pytest.approx(24.0)
    assert max(times) < 2.0  # loops the animation


def test_walk_schedule_caps_a_long_emote_at_120():
    times, fps = render.walk_schedule(10.0)
    assert len(times) == 120 and fps == pytest.approx(12.0) and times[-1] == pytest.approx(9.9166, abs=1e-3)


def test_walk_schedule_without_a_length():
    assert render.walk_schedule(0) == ([0.0] * 96, 24.0)


def test_orbit_and_walk_queries():
    assert 'type=wearable' in render._query({**SPIN, 'mode': 'orbit'})
    assert 'type=wearable' not in render._query({**SPIN, 'mode': 'walk', 'emote': 'run'})
    assert 'emote=run' in render._query({**SPIN, 'mode': 'walk', 'emote': 'run'})
    assert 'emote=idle' in render._query({**SPIN, 'mode': 'walk', 'emote': 'own'})  # an emote design plays its own


def test_orbit_renders_the_ring(tmp_path, stub):
    calls = stub()
    r = render.render([HAT], {**SPIN, 'mode': 'orbit', 'ring': True}, tmp_path, watchdog_sec=60)
    assert r['ok'] is True, r
    assert len(r['frames']) == 24 and r['frames'][23].name == '023.webp'
    assert len([c for c in calls if c['method'] == 'changeCameraPosition']) == 23


def test_walk_steps_time_and_turns_together(tmp_path, stub):
    calls = stub()  # the stub's emote length is 3.0 s
    r = render.render([WAVE], {**SPIN, 'mode': 'walk', 'emote': 'own'}, tmp_path, watchdog_sec=60)
    assert r['ok'] is True, r
    assert len(r['frames']) == 96 and r['fps'] == pytest.approx(24.0)
    goes = [c['params'][0] for c in calls if c['method'] == 'goTo']
    turns = [c for c in calls if c['method'] == 'changeCameraPosition']
    assert len(goes) == 96 and len(turns) == 96 and goes[1] == pytest.approx(4.0 / 96)


def test_walk_sample_keeps_evenly_spaced_pngs(tmp_path, stub):
    calls = stub()
    r = render.render([WAVE], {**SPIN, 'mode': 'walk', 'emote': 'own', 'sample': 16}, tmp_path, watchdog_sec=60)
    assert r['ok'] is True, r
    assert [f.name for f in r['frames']] == [f'{j:02d}.png' for j in range(16)]
    turns = [c['params'][0]['alpha'] for c in calls if c['method'] == 'changeCameraPosition']
    assert sum(turns) == pytest.approx(2 * math.pi * 91 / 96)  # frame 90 is the last kept, after 91 turns
