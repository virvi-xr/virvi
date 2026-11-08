import os
from pathlib import Path

import pytest

from studio_worker import restore


def build(design: Path):
    (design / 'out/emote').mkdir(parents=True)
    (design / 'out/emote/reading.glb').write_bytes(b'first export')
    (design / 'out/emote/piece.json').write_text('{"category": "emote"}')
    return restore.snapshot(design)


def tree(root: Path) -> dict:
    """{relative path: bytes | 'dir' | 'link'} without following links."""
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for n in dirnames + filenames:
            p = Path(dirpath) / n
            rel = p.relative_to(root).as_posix()
            out[rel] = 'link' if p.is_symlink() else 'dir' if p.is_dir() else p.read_bytes()
    return out


FIRST = {'out': 'dir', 'out/emote': 'dir', 'out/emote/reading.glb': b'first export',
         'out/emote/piece.json': b'{"category": "emote"}'}


def test_nothing_changed_restores_the_same(tmp_path):
    kept = build(tmp_path)
    restore.restore(tmp_path, kept, None)
    assert tree(tmp_path) == FIRST


def test_a_half_written_export_and_added_files_and_folders_go(tmp_path):
    kept = build(tmp_path)
    victim = tmp_path.parent / f'{tmp_path.name}-victim.txt'
    victim.write_text('not yours')
    (tmp_path / 'out/emote/reading.glb').write_bytes(b'half')
    (tmp_path / 'out/emote/extra/deeper').mkdir(parents=True)
    (tmp_path / 'out/emote/extra/deeper/x.glb').write_bytes(b'x')
    os.symlink(victim, tmp_path / 'out/emote/link.glb')
    os.mkfifo(tmp_path / 'out/emote/pipe.glb')
    restore.restore(tmp_path, kept, None)
    assert tree(tmp_path) == FIRST and victim.read_text() == 'not yours'


def test_a_deleted_emote_folder_comes_back(tmp_path):
    kept = build(tmp_path)
    import shutil
    shutil.rmtree(tmp_path / 'out/emote')
    restore.restore(tmp_path, kept, None)
    assert tree(tmp_path) == FIRST


@pytest.mark.parametrize('what', ['symlink', 'file'])
def test_an_emote_folder_replaced_by_a_link_or_file_comes_back(tmp_path, what):
    kept = build(tmp_path)
    import shutil
    elsewhere = tmp_path.parent / f'{tmp_path.name}-elsewhere'
    (elsewhere / 'inside').mkdir(parents=True)
    (elsewhere / 'inside/keep.txt').write_text('untouched')
    shutil.rmtree(tmp_path / 'out/emote')
    if what == 'symlink':
        os.symlink(elsewhere, tmp_path / 'out/emote')
    else:
        (tmp_path / 'out/emote').write_text('a file')
    restore.restore(tmp_path, kept, None)
    assert tree(tmp_path) == FIRST
    assert tree(elsewhere) == {'inside': 'dir', 'inside/keep.txt': b'untouched'}  # never followed


def test_out_replaced_by_a_link_after_the_snapshot_is_put_back_without_following_it(tmp_path):
    kept = build(tmp_path)
    import shutil
    elsewhere = tmp_path.parent / f'{tmp_path.name}-other'
    (elsewhere / 'emote').mkdir(parents=True)
    (elsewhere / 'emote/theirs.glb').write_bytes(b'theirs')
    shutil.rmtree(tmp_path / 'out')
    os.symlink(elsewhere, tmp_path / 'out')
    restore.restore(tmp_path, kept, None)
    assert tree(tmp_path) == FIRST
    assert tree(elsewhere) == {'emote': 'dir', 'emote/theirs.glb': b'theirs'}


def test_glbs_the_retry_wrote_to_other_folders_are_reverted(tmp_path):
    kept_hat = tmp_path / 'out/hat'
    kept_hat.mkdir(parents=True)
    (kept_hat / 'cap.glb').write_bytes(b'old cap')
    kept = build(tmp_path)
    (kept_hat / 'cap.glb').write_bytes(b'new cap')
    (tmp_path / 'out/shoes').mkdir()
    (tmp_path / 'out/shoes/shoe.glb').write_bytes(b'shoe')
    (tmp_path / 'out/stray.glb').write_bytes(b'stray')
    restore.restore(tmp_path, kept, None)
    assert tree(tmp_path) == {**FIRST, 'out/hat': 'dir', 'out/hat/cap.glb': b'old cap'}


def test_a_symlinked_out_is_never_snapshotted(tmp_path):
    elsewhere = tmp_path.parent / f'{tmp_path.name}-far'
    (elsewhere / 'emote').mkdir(parents=True)
    (elsewhere / 'emote/x.glb').write_bytes(b'x')
    os.symlink(elsewhere, tmp_path / 'out')
    assert restore.snapshot(tmp_path) is None
    (tmp_path / 'out').unlink()
    (tmp_path / 'out').write_text('a file')
    assert restore.snapshot(tmp_path) is None
    (tmp_path / 'out').unlink()
    assert restore.snapshot(tmp_path) is None  # no out/ at all


def test_links_pipes_and_hard_links_are_not_kept(tmp_path):
    (tmp_path / 'out/emote').mkdir(parents=True)
    secret = tmp_path.parent / f'{tmp_path.name}-secret'
    secret.write_text('secret')
    os.symlink(secret, tmp_path / 'out/emote/link.glb')
    os.link(secret, tmp_path / 'out/emote/hard.glb')
    os.mkfifo(tmp_path / 'out/emote/pipe.glb')
    kept = restore.snapshot(tmp_path)  # returns at once: the pipe is never opened
    assert kept.files == {} and set(kept.dirs) == {'emote'} and kept.dirs['emote'].files == {}


def test_a_snapshot_over_the_size_budget_is_none(tmp_path, monkeypatch):
    build(tmp_path)
    monkeypatch.setattr(restore, 'MAX_TOTAL_BYTES', 10)
    assert restore.snapshot(tmp_path) is None


def test_restored_files_and_folders_go_to_the_agent_user(tmp_path, monkeypatch):
    kept = build(tmp_path)
    import shutil
    shutil.rmtree(tmp_path / 'out/emote')
    owned = []
    monkeypatch.setattr(restore, '_uid', lambda user: 4242)
    monkeypatch.setattr(restore.os, 'chown', lambda name, uid, gid, dir_fd=None, follow_symlinks=True:
                        owned.append((name, uid, follow_symlinks)) if isinstance(name, str) else None)
    monkeypatch.setattr(restore.os, 'fchown', lambda fd, uid, gid: owned.append(('fd', uid, False)))
    restore.restore(tmp_path, kept, 'agent')
    assert ('emote', 4242, False) in owned  # the recreated folder
    assert sum(1 for n, *_ in owned if n == 'fd') == 2  # both files
    assert all(uid == 4242 and not follow for _, uid, follow in owned)
