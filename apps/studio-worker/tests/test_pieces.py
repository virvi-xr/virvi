import hashlib
import json
import os
import shutil

from conftest import FIXTURES
from studio_worker.instructions import closing
from studio_worker.pieces import check, collect, glbs_by_shape, new_hashes

HAT = {'name': 'Neon Cap', 'description': 'A cap with a glowing visor', 'category': 'hat', 'hides': [],
       'replaces': [], 'tags': ['cyberpunk'], 'changeKind': 'new'}


def lay_out(design, category, glbs, meta):
    d = design / 'out' / category
    d.mkdir(parents=True)
    for g in glbs:
        shutil.copy(g, d / g.name)
    (d / 'piece.json').write_text(json.dumps(meta))
    return d


def cap(design):
    return lay_out(design, 'hat', sorted((FIXTURES / 'cap').glob('*.glb')), HAT)


def test_collects_pieces_and_runs_checker(tmp_path, skills):
    cap(tmp_path)
    pieces, proposal, error = collect(tmp_path, 'wearable', {})
    assert error is None and proposal is None
    assert [p.category for p in pieces] == ['hat']
    assert pieces[0].changed is True and pieces[0].meta['name'] == 'Neon Cap'
    assert pieces[0].checker['ran'] is True and pieces[0].checker['pass'] is True
    assert set(glbs_by_shape(pieces[0])) == {'male', 'female'}


def test_unchanged_piece_not_reported_changed(tmp_path, skills):
    d = cap(tmp_path)
    hashes = {'hat': {g.name: hashlib.sha256(g.read_bytes()).hexdigest() for g in d.glob('*.glb')}}
    pieces, _, error = collect(tmp_path, 'wearable', hashes)
    assert error is None and pieces[0].changed is False
    assert new_hashes(pieces) == hashes


def test_glb_outside_pieces_is_an_error(tmp_path):
    (tmp_path / 'out').mkdir()
    shutil.copy(FIXTURES / 'cap/neon_cap_male.glb', tmp_path / 'out/cap.glb')
    pieces, proposal, error = collect(tmp_path, 'wearable', {})
    assert pieces == [] and proposal is None
    assert 'out/cap.glb' in error


def test_proposal_is_read(tmp_path):
    (tmp_path / 'out').mkdir()
    slots = {'slots': [{'category': 'hat', 'recommended': True, 'reason': 'the visor is the idea'},
                       {'category': 'eyewear', 'recommended': False, 'reason': 'goggles would match'}]}
    (tmp_path / 'out/proposal.json').write_text(json.dumps(slots))
    pieces, proposal, error = collect(tmp_path, 'wearable', {})
    assert proposal == slots and pieces == [] and error is None


def test_checker_fail_is_recorded(tmp_path, skills):
    # 1346 triangles: fine for the jacket it is, over an earring's 500
    lay_out(tmp_path, 'earring', [FIXTURES / 'jacket.glb'], {**HAT, 'category': 'earring'})
    pieces, _, error = collect(tmp_path, 'wearable', {})
    assert error is None
    assert pieces[0].checker['pass'] is False and pieces[0].checker['failures'] >= 1


def test_emote_checker_runs(tmp_path, skills):
    lay_out(tmp_path, 'emote', [FIXTURES / 'wave.glb'], {**HAT, 'category': 'emote', 'loop': False})
    pieces, _, error = collect(tmp_path, 'emote', {})
    assert error is None and pieces[0].checker['pass'] is True
    assert list(glbs_by_shape(pieces[0])) == ['unisex'] and glbs_by_shape(pieces[0])['unisex'].name == 'wave.glb'


def test_closing_names_the_slots_and_forbids_renders():
    text = closing('wearable', ['hat', 'eyewear'])
    for words in ('hat', 'eyewear', 'studio-preview', 'never render', '/opt/assets', 'piece.json'):
        assert words in text
    assert 'proposal.json' in closing('wearable', None)


def test_closing_asks_for_listing_fields_on_wearables_only():
    wearable = closing('wearable', ['hat'])
    assert '"rarity": "common" | "uncommon" | "rare" | "epic" | "legendary" | "exotic" | "mythic" | "unique"' in wearable
    assert 'listing-dcl-wearables' in wearable and 'at most 64 characters' in wearable
    emote = closing('emote', None)
    assert '"rarity"' not in emote and '"loop": true | false' in emote


def test_pieces_are_read_into_the_stage(tmp_path, skills):
    cap(tmp_path / 'design')
    pieces, _, error = collect(tmp_path / 'design', 'wearable', {}, stage=tmp_path / 'stage')
    assert error is None
    assert all(g.is_relative_to(tmp_path / 'stage') for g in pieces[0].glbs)  # root reads the agent's files once


def test_symlinked_glb_is_an_error(tmp_path):
    secret = tmp_path / 'environ'
    secret.write_text('STUDIO_WORKER_TOKEN=tok')
    d = tmp_path / 'design/out/hat'
    d.mkdir(parents=True)
    (d / 'piece.json').write_text(json.dumps(HAT))
    os.symlink(secret, d / 'hat_male.glb')
    pieces, _, error = collect(tmp_path / 'design', 'wearable', {}, stage=tmp_path / 'stage')
    assert pieces == [] and 'out/hat/hat_male.glb' in error and 'not a regular file' in error
    assert not list((tmp_path / 'stage').rglob('*.glb')) if (tmp_path / 'stage').exists() else True


def test_symlinked_piece_folder_is_an_error(tmp_path):
    real = tmp_path / 'elsewhere'
    lay_out(real, 'hat', sorted((FIXTURES / 'cap').glob('*.glb')), HAT)
    (tmp_path / 'design/out').mkdir(parents=True)
    os.symlink(real / 'out/hat', tmp_path / 'design/out/hat')
    pieces, _, error = collect(tmp_path / 'design', 'wearable', {})
    assert pieces == [] and 'out/hat' in error


def test_uppercase_glb_outside_pieces_is_an_error(tmp_path):
    (tmp_path / 'out').mkdir()
    shutil.copy(FIXTURES / 'cap/neon_cap_male.glb', tmp_path / 'out/CAP.GLB')
    pieces, _, error = collect(tmp_path, 'wearable', {})
    assert pieces == [] and 'out/CAP.GLB' in error


def test_grok_is_told_to_read_its_renders():
    grok, claude = closing('wearable', ['hat'], agent='grok'), closing('wearable', ['hat'], agent='claude')
    assert 'read_file' in grok and 'never from the preview' in grok
    assert 'read_file' not in claude
    assert 'read_file' in closing('emote', None, agent='grok')
