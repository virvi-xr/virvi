import io
import os
import tarfile

import pytest

import fake_api
from studio_worker import jobs
from studio_worker.api import Api
from studio_worker.instructions import closing, uploads_text
from studio_worker.workspace import pack

TOKEN = 'tok-uploads'
PNG = b'\x89PNG\r\n\x1a\n' + b'\x01' * 32
GLB = b'glTF\x02\x00\x00\x00' + b'\x02' * 32
LOGO = {'path': 'uploads/11111111-1111-4111-8111-111111111111/logo.png', 'name': 'logo.png', 'kind': 'image'}
FART = {'path': 'uploads/33333333-3333-4333-8333-333333333333/fart.mp3', 'name': 'fart.mp3', 'kind': 'audio'}
BASE = {'path': 'uploads/22222222-2222-4222-8222-222222222222/base.glb', 'name': 'base.glb', 'kind': 'model'}


@pytest.fixture
def api():
    with fake_api.serve(token=TOKEN, design='design-1') as server:
        yield server


def client(api):
    return Api(api.url, TOKEN, 'design-1', backoff=0.01)


def test_uploads_are_fetched_into_the_uploads_folder(api, tmp_path):
    api.inputs[f"job-1/{LOGO['path']}"] = PNG
    api.inputs[f"job-1/{BASE['path']}"] = GLB
    got = jobs.fetch_uploads({'jobId': 'job-1', 'uploads': [LOGO, BASE]}, client(api), tmp_path)
    assert [u['name'] for u in got] == ['logo.png', 'base.glb']
    assert (tmp_path / 'uploads' / 'logo.png').read_bytes() == PNG
    assert (tmp_path / 'uploads' / 'base.glb').read_bytes() == GLB


def test_a_deleted_upload_leaves_the_folder_and_a_planted_link_is_not_followed(api, tmp_path):
    outside = tmp_path / 'outside.txt'
    outside.write_text('keep me')
    design = tmp_path / 'design'
    (design / 'uploads').mkdir(parents=True)
    (design / 'uploads' / 'old.png').write_bytes(PNG)
    os.symlink(outside, design / 'uploads' / 'logo.png')
    api.inputs[f"job-2/{LOGO['path']}"] = PNG
    jobs.fetch_uploads({'jobId': 'job-2', 'uploads': [LOGO]}, client(api), design)
    assert sorted(p.name for p in (design / 'uploads').iterdir()) == ['logo.png']
    assert not (design / 'uploads' / 'logo.png').is_symlink()
    assert outside.read_text() == 'keep me'


def test_an_unreadable_upload_is_skipped_and_odd_names_are_refused(api, tmp_path):
    api.inputs[f"job-3/{LOGO['path']}"] = PNG
    sneaky = {'path': 'uploads/33333333-3333-4333-8333-333333333333/x.png', 'name': '../escape.png', 'kind': 'image'}
    got = jobs.fetch_uploads({'jobId': 'job-3', 'uploads': [BASE, sneaky, LOGO]}, client(api), tmp_path)
    assert [u['name'] for u in got] == ['logo.png']
    assert not (tmp_path / 'escape.png').exists()


def test_no_uploads_means_no_folder_and_no_words(api, tmp_path):
    assert jobs.fetch_uploads({'jobId': 'job-4'}, client(api), tmp_path) == []
    assert not (tmp_path / 'uploads').exists()
    assert uploads_text([]) == ''


def test_the_prompt_names_the_files_and_what_they_can_be_for():
    text = uploads_text([LOGO, BASE])
    assert 'uploads/logo.png (image)' in text and 'uploads/base.glb (3D model)' in text
    assert 'texture' in text and 'decal' in text and 'logo' in text
    assert 'FBX' in text and '.blend' in text and 'glTF' in text


def test_uploads_are_not_saved_with_the_workspace(tmp_path):
    design, state = tmp_path / 'design', tmp_path / 'state'
    (design / 'uploads').mkdir(parents=True)
    (design / 'uploads' / 'logo.png').write_bytes(PNG)
    (design / 'out').mkdir()
    (design / 'out' / 'note.txt').write_text('kept')
    state.mkdir()
    names = tarfile.open(fileobj=io.BytesIO(pack(design, state)), mode='r:gz').getnames()
    assert 'design/out/note.txt' in names
    assert not [n for n in names if n.startswith('design/uploads')]


def test_the_names_the_server_stores_are_the_names_the_worker_takes():
    # apps/server/test/studio-uploads.test.ts "cleans names": the server's output must pass the worker's rule
    for name in ['DSC0042.jpg', 'logo.final.png', 'My-Logo-final-2.png', 'base-cap.glb', 'image-2.png', 'a_b.c-d.png']:
        assert jobs.UPLOAD_NAME.fullmatch(name) and '..' not in name, name


def test_a_sound_is_listed_and_what_it_can_be_for():
    text = uploads_text([FART])
    assert '- uploads/fart.mp3 (sound)' in text
    assert "the user's own" in text and 'within 3 MB' in text and 'time the moves to' in text
    assert 'Only an emote has a sound' in text


def test_the_emote_brief_prefers_an_uploaded_sound():
    text = closing('emote', None)
    assert 'use the sound the user uploaded' in text
    assert 'never a sample you found' in text
