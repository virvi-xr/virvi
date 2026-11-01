import io
import json
import zipfile
from pathlib import Path

import pytest
from PIL import Image

import fake_api
from studio_worker import jobs
from studio_worker.api import Api
from studio_worker.finalize import Tools

TOKEN = 'tok-final-secret'
HAT_FILES = ['pieces/hat/neon_cap_male.glb', 'pieces/hat/neon_cap_female.glb', 'pieces/hat/piece.json', 'checks/hat.txt']
HAT_META = {'name': 'Neon Cap', 'description': 'A cap with a glowing visor', 'category': 'hat', 'hides': ['hair'],
            'replaces': [], 'tags': ['cyberpunk', 'neon'], 'rarity': 'rare', 'changeKind': 'new'}
LAYOUT = {'neon_cap_male.glb', 'neon_cap_female.glb', 'thumbnail.png', 'builder.json', 'listing.json', 'item.zip',
          'promo.mp4', 'REPORT.md'} | {f'renders/{s}-{v}.png' for s in ('male', 'female')
                                       for v in ('front', 'right', 'back', 'left')}


class FakeTools:
    """Writes what each real tool would and records the calls. `clip_fail` names clips check_clipping fails."""

    def __init__(self, clip_fail=(), crash=()):
        self.calls, self.clip_fail, self.crash = [], list(clip_fail), set(crash)

    def tools(self) -> Tools:
        return Tools(blender=self.blender, python=self.python, ffmpeg=self.ffmpeg)

    def _arg(self, args, flag):
        return args[args.index(flag) + 1]

    def blender(self, args, timeout):
        self.calls.append(('blender', args))
        if any('thumbnail_blend' in str(a) for a in args):
            if 'thumbnail' in self.crash:
                return False, 'Blender crashed'
            # an item framed badly: small, in a corner (as when a stray object widens the camera's frame)
            size = int(self._arg(args, '--size'))
            image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
            image.paste((200, 30, 120, 255), (10, 10, 10 + size // 10, 10 + size // 20))
            image.save(self._arg(args, '--out'))
            return True, 'Saved'
        if any('check_clipping' in str(a) for a in args):
            clips = {'Idle': {'status': 'PASS'}, 'Walk': {'status': 'PASS'}}
            clips.update({c: {'status': 'FAIL'} for c in self.clip_fail})
            Path(self._arg(args, '--json')).write_text(json.dumps({'clips': clips}))
            gate = 'FAIL: ' + ', '.join(self.clip_fail) if self.clip_fail else 'PASS'
            noise = '\n'.join(f'04:00:{i:02d} | INFO: glTF import finished in 0.05s' for i in range(40))
            return not self.clip_fail, f'{noise}\n  PASS   Idle    0/61 frames clip\nCLIP GATE {gate}'
        return False, 'unknown blender call'

    def python(self, script, args, timeout):
        self.calls.append(('python', [str(script), *map(str, args)]))
        name = Path(script).name
        if name == 'package_item.py':
            if 'package' in self.crash:
                return False, 'package_item failed'
            with zipfile.ZipFile(args[0], 'w') as z:
                z.writestr('wearable.json', '{}')
            return True, 'wrote item.zip'
        if name == 'check_thumbnail.py':
            return True, '  PASS  transparent background'
        if name == 'check_listing.py':
            return True, '  PASS  name'
        return False, f'unknown script {name}'

    def ffmpeg(self, args, timeout):
        self.calls.append(('ffmpeg', args))
        Path(args[-1]).write_bytes(b'mp4')
        return True, ''


def fake_render(calls, blank_for=()):
    def render(pieces, view, out, frames=36, size=512, watchdog_sec=300):
        calls.append((pieces, view, frames, size))
        out = Path(out)
        out.mkdir(parents=True, exist_ok=True)
        if any(p['category'] in blank_for for p in pieces):
            return {'ok': False, 'frames': [], 'error': 'blank', 'bootSec': 1.0}
        if view['mode'] == 'look':
            paths = [out / f"{view['bodyShape']}-{v}.png" for v in ('front', 'right', 'back', 'left')]
            for p in paths:
                Image.new('RGB', (size, size), (90, 40, 40)).save(p)
        elif view['mode'] == 'thumbnail':
            paths = [out / 'thumbnail.png']
            Image.new('RGBA', (256, 256), (0, 0, 0, 0)).save(paths[0])
        else:
            paths = [out / f'{i:03d}.webp' for i in range(frames)]
            for p in paths:
                Image.new('RGB', (8, 8), (1, 2, 3)).save(p, 'WEBP')
        return {'ok': True, 'frames': paths, 'error': None, 'bootSec': 1.0}
    return render


@pytest.fixture
def api():
    with fake_api.serve(token=TOKEN, design='design-1') as server:
        yield server


def finalize_job(pieces, kind='wearable', job_id='job-f'):
    return {'jobId': job_id, 'type': 'finalize', 'kind': kind, 'agent': None, 'model': None, 'prompt': None,
            'selectedSlots': None, 'limits': {'timeoutSec': 1800, 'maxTurns': 0, 'costCeilingUsd': 0}, 'render': None,
            'finalize': {'designName': 'Neon set', 'pieces': pieces}}


def give_inputs(api, job_id, category, files, meta, glb=b'glTF-bytes', report='  PASS  triangles 1200/1500\n'):
    for f in files:
        if f.endswith('.glb'):
            api.inputs[f'{job_id}/{f}'] = glb + f.encode()
        elif f.endswith('piece.json'):
            api.inputs[f'{job_id}/{f}'] = json.dumps(meta).encode()
        else:
            api.inputs[f'{job_id}/{f}'] = report.encode()
    return {'category': category, 'name': meta['name'], 'revision': 2, 'files': files, 'sourceJobId': 'src-1'}


def run(api, tmp_path, job, tools=None, render_calls=None, blank_for=()):
    client = Api(api.url, TOKEN, 'design-1', backoff=0.01)
    calls = [] if render_calls is None else render_calls
    tools = tools or FakeTools()
    return jobs.run_job(job, client, tmp_path / 'design', render_fn=fake_render(calls, blank_for),
                        tools=tools.tools())


def package(api, job_id, category):
    return zipfile.ZipFile(io.BytesIO(api.files[f'{job_id}/final/{category}/package.zip']))


def test_package_has_every_file(api, tmp_path):
    piece = give_inputs(api, 'job-f', 'hat', HAT_FILES, HAT_META)
    tools = FakeTools()
    renders = []
    result = run(api, tmp_path, finalize_job([piece]), tools, renders)
    assert result['outcome'] == 'ok', result['error']
    assert result['costUsd'] is None and result['tokens'] is None
    assert result['pieces'] == [{'category': 'hat', 'files': ['final/hat/package.zip'], 'finalize': {
        'thumbnail': {'pass': True}, 'listing': {'pass': True}, 'clipping': {'pass': True, 'failed': []},
        'emoteCheck': None}}]
    z = package(api, 'job-f', 'hat')
    assert set(z.namelist()) == LAYOUT
    assert json.loads(z.read('builder.json')) == {'name': 'Neon Cap', 'category': 'hat', 'hides': ['hair'],
                                                  'replaces': [], 'tags': ['cyberpunk', 'neon']}
    assert json.loads(z.read('listing.json')) == {'name': 'Neon Cap', 'rarity': 'rare',
                                                  'description': 'A cap with a glowing visor',
                                                  'tags': ['cyberpunk', 'neon']}
    report = z.read('REPORT.md').decode()
    for section in ('Wearable checker', 'Thumbnail', 'Listing', 'Clipping', 'Not run here', 'item.zip',
                    'wearable-validator', 'desktop explorer'):
        assert section in report
    assert 'triangles 1200/1500' in report
    # renders at 1024 per body shape, a 72-frame 720 px promo on the dancing avatar
    looks = [c for c in renders if c[1]['mode'] == 'look']
    assert sorted(c[1]['bodyShape'] for c in looks) == ['female', 'male'] and all(c[3] == 1024 for c in looks)
    promo = [c for c in renders if c[1]['mode'] == 'spin']
    assert len(promo) == 1 and promo[0][1]['emote'] == 'dance' and promo[0][2:] == (72, 720)
    clipping = [a for k, a in tools.calls if k == 'blender' and any('check_clipping' in str(x) for x in a)]
    assert len(clipping) == 2 and all('--hides' in a and a[a.index('--hides') + 1] == 'hair' for a in clipping)
    assert api.workspace is None and ('PUT', '/api/studio/worker/designs/design-1/workspace') not in api.calls
    assert api.phases('job-f') == ['packaging']


def test_builds_from_inputs_not_workspace(api, tmp_path):
    out = tmp_path / 'design' / 'out' / 'hat'
    out.mkdir(parents=True)
    (out / 'neon_cap_male.glb').write_bytes(b'NEWER-WORKSPACE-GLB')
    (out / 'piece.json').write_text(json.dumps({**HAT_META, 'name': 'Changed later'}))
    piece = give_inputs(api, 'job-f', 'hat', HAT_FILES, HAT_META, glb=b'PAID-')
    assert run(api, tmp_path, finalize_job([piece]))['outcome'] == 'ok'
    z = package(api, 'job-f', 'hat')
    assert z.read('neon_cap_male.glb') == b'PAID-pieces/hat/neon_cap_male.glb'
    assert json.loads(z.read('builder.json'))['name'] == 'Neon Cap'


def test_failed_checks_are_reported_not_fatal(api, tmp_path):
    piece = give_inputs(api, 'job-f', 'hat', HAT_FILES, HAT_META)
    result = run(api, tmp_path, finalize_job([piece]), FakeTools(clip_fail=['Dance']))
    assert result['outcome'] == 'ok'
    assert result['pieces'][0]['finalize']['clipping'] == {'pass': False, 'failed': ['Dance']}
    report = package(api, 'job-f', 'hat').read('REPORT.md').decode()
    assert 'Dance' in report and 'FAIL' in report


def test_render_failure_fails_only_that_piece(api, tmp_path):
    hat = give_inputs(api, 'job-f', 'hat', HAT_FILES, HAT_META)
    feet_files = ['pieces/feet/boots_male.glb', 'pieces/feet/boots_female.glb', 'pieces/feet/piece.json', 'checks/feet.txt']
    feet = give_inputs(api, 'job-f', 'feet', feet_files, {**HAT_META, 'name': 'Boots', 'category': 'feet', 'hides': []})
    result = run(api, tmp_path, finalize_job([feet, hat]), blank_for=('feet',))
    assert result['outcome'] == 'error'
    assert 'feet' in result['error'] and 'blank' in result['error']
    assert [p['category'] for p in result['pieces']] == ['hat']
    assert 'job-f/final/feet/package.zip' not in api.files and 'job-f/final/hat/package.zip' in api.files


def test_emote_package(api, tmp_path):
    files = ['pieces/emote/robot_dance.glb', 'pieces/emote/piece.json', 'checks/emote.txt']
    meta = {'name': 'Robot Dance', 'description': 'Stiff arms, perfect beat', 'category': 'emote', 'tags': ['dance'],
            'loop': True, 'changeKind': 'new'}
    piece = give_inputs(api, 'job-f', 'emote', files, meta, report='  PASS  length 2.0s\n  WARN  no sound\n')
    renders, tools = [], FakeTools()
    result = run(api, tmp_path, finalize_job([piece], kind='emote'), tools, renders)
    assert result['outcome'] == 'ok', result['error']
    assert result['pieces'][0]['finalize'] == {'thumbnail': {'pass': True}, 'listing': None, 'clipping': None,
                                               'emoteCheck': {'pass': True}}
    names = set(package(api, 'job-f', 'emote').namelist())
    assert {'robot_dance.glb', 'thumbnail.png', 'builder.json', 'promo.mp4', 'REPORT.md'} <= names
    assert not {'item.zip', 'listing.json'} & names
    assert any(c[1]['mode'] == 'thumbnail' for c in renders)
    assert not any(k == 'blender' for k, _ in tools.calls)
    assert [c[1]['mode'] for c in renders if c[2] == 72] == ['emote']
    assert 'Emote checker' in package(api, 'job-f', 'emote').read('REPORT.md').decode()


def test_missing_input_fails_piece(api, tmp_path):
    piece = give_inputs(api, 'job-f', 'hat', HAT_FILES, HAT_META)
    del api.inputs['job-f/pieces/hat/neon_cap_female.glb']
    result = run(api, tmp_path, finalize_job([piece]))
    assert result['outcome'] == 'error' and 'neon_cap_female.glb' in result['error']
    assert result['pieces'] == []


def test_builder_zip_failure_fails_piece_but_odd_names_are_fitted(api, tmp_path):
    meta = {**HAT_META, 'name': 'Neon: The Cap of the Very Long Future Edition', 'description': 'x' * 90}
    piece = give_inputs(api, 'job-f', 'hat', HAT_FILES, meta)
    tools = FakeTools()
    assert run(api, tmp_path, finalize_job([piece]), tools)['outcome'] == 'ok'
    args = next(a for k, a in tools.calls if k == 'python' and a[0].endswith('package_item.py'))
    name, description = args[args.index('--name') + 1], args[args.index('--description') + 1]
    assert len(name) <= 32 and ':' not in name and len(description) <= 64
    piece = give_inputs(api, 'job-g', 'hat', HAT_FILES, HAT_META)
    result = run(api, tmp_path, finalize_job([piece], job_id='job-g'), FakeTools(crash=['package']))
    assert result['outcome'] == 'error' and 'item.zip' in result['error']


def test_thumbnail_is_cropped_to_the_item(api, tmp_path):
    piece = give_inputs(api, 'job-f', 'hat', HAT_FILES, HAT_META)
    tools = FakeTools()
    assert run(api, tmp_path, finalize_job([piece]), tools)['outcome'] == 'ok'
    blender = next(a for k, a in tools.calls if k == 'blender' and any('thumbnail_blend' in str(x) for x in a))
    assert blender[blender.index('--size') + 1] == '1024'  # rendered large, then fitted
    thumb = Image.open(io.BytesIO(package(api, 'job-f', 'hat').read('thumbnail.png')))
    assert thumb.size == (256, 256) and thumb.mode == 'RGBA'
    left, top, right, bottom = thumb.getchannel('A').getbbox()
    assert max(right - left, bottom - top) >= 0.8 * 256  # the item fills the frame
    assert thumb.getpixel((0, 0))[3] == 0 and thumb.getpixel((255, 255))[3] == 0


def test_report_leaves_out_blender_noise(api, tmp_path):
    piece = give_inputs(api, 'job-f', 'hat', HAT_FILES, HAT_META)
    assert run(api, tmp_path, finalize_job([piece]))['outcome'] == 'ok'
    report = package(api, 'job-f', 'hat').read('REPORT.md').decode()
    assert '| INFO:' not in report
    assert 'CLIP GATE PASS' in report and 'Idle    0/61 frames clip' in report
