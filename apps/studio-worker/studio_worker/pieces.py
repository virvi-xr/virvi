"""Reads what the agent wrote: one piece per category under out/<category>/, or a slot proposal, and runs the skills'
checker on each piece."""
import hashlib
import json
import os
import stat
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from . import config, emote_legs, scene

CHECKER_TIMEOUT_SEC = 300


@dataclass
class Piece:
    category: str
    glbs: list[Path]
    meta: dict  # piece.json
    changed: bool
    checker: dict  # ran, pass, failures, warnings, report (and triangles, for a scene piece)
    extras: list[Path] = field(default_factory=list)  # a scene piece's route/layout/sittables JSON, an emote's sound


def collect(design: Path, kind: str, hashes: dict, run_checker: bool = True, stage: Path | None = None
            ) -> tuple[list[Piece], dict | None, str | None]:
    """The pieces under out/, the slot proposal in out/proposal.json, and an error when the layout is wrong.

    The agent owns the design folder, so its files are read once, refusing anything but a regular file (a symlink
    could point at the worker's environment), into `stage`, a fresh root-owned folder by default. Pieces point at
    those copies. A GLB anywhere but out/<category>/ beside a piece.json is an error: the design is not reported
    ready with pieces missing."""
    design = Path(design)
    out = design / 'out'
    stage = Path(stage or tempfile.mkdtemp(prefix='studio-stage-'))
    if os.path.islink(out) or out.exists() and not out.is_dir():
        return [], None, 'out/ is not a folder'
    proposal, problems = None, []
    try:
        proposal = json.loads(read_regular(out / 'proposal.json')) if os.path.lexists(out / 'proposal.json') else None
    except (UnsafeFile, json.JSONDecodeError) as e:
        problems.append(f'out/proposal.json: {e}')
    pieces = []
    for d in sorted(out.iterdir()) if out.is_dir() else []:
        rel = d.relative_to(design).as_posix()
        if os.path.islink(d):
            problems.append(f'{rel} is a symlink, not a folder')
            continue
        if not d.is_dir() or not os.path.lexists(d / 'piece.json'):
            continue  # its GLBs are reported as strays below
        if kind == 'scene' and scene.folder_problem(d.name):
            problems.append(scene.folder_problem(d.name))
            continue
        try:
            meta = json.loads(read_regular(d / 'piece.json'))
            glbs = [g for g in sorted(d.iterdir()) if g.suffix.lower() == '.glb']
            if not glbs:
                problems.append(f'{rel}/ has a piece.json but no GLB')
                continue
            if kind == 'emote' and d.name != 'emote':
                problems.append(f'an emote goes in out/emote/, not {rel}/')
                continue
            if not isinstance(meta, dict) or meta.get('category', d.name) != d.name:
                problems.append(f'{rel}/piece.json says category {meta.get("category") if isinstance(meta, dict) else meta!r}')
                continue
            if kind == 'scene' and scene.validate(d.name, meta, glbs):
                problems.append(scene.validate(d.name, meta, glbs))
                continue
            staged = stage / d.name
            staged.mkdir(parents=True, exist_ok=True)
            copies, extras = [], []
            for g in glbs:
                copies.append(staged / g.name)
                copies[-1].write_bytes(read_regular(g))
            if kind == 'emote':
                sound, problem = emote_sound(d, sum(g.stat().st_size for g in glbs))
                if problem:
                    problems.append(problem)
                    continue
                travels = [sound] if sound else []
            else:
                travels = scene.extras(d, meta) if kind == 'scene' else []
            for e in travels:
                extras.append(staged / e.name)
                extras[-1].write_bytes(read_regular(e))
            (staged / 'piece.json').write_text(json.dumps(meta))
        except UnsafeFile as e:
            problems.append(str(e))
            continue
        except json.JSONDecodeError as e:
            problems.append(f'{rel}/piece.json is not JSON: {e}')
            continue
        pieces.append(Piece(category=d.name, glbs=copies, meta=meta, extras=extras,
                            changed=_shas(copies + extras) != set((hashes.get(d.name) or {}).values()),
                            checker={'ran': False}))
    if kind == 'scene' and scene.limits([p.category for p in pieces]):
        problems.append(scene.limits([p.category for p in pieces]))
    placed = {(p.category, g.name) for p in pieces for g in p.glbs}
    strays = [g for g in _glbs_under(out) if (g.parent.name, g.name) not in placed or g.parent.parent != out]
    if strays:
        names = ', '.join(g.relative_to(design).as_posix() for g in strays)
        problems.append(f'GLBs outside out/<category>/ with a piece.json: {names}')
    if problems:
        return [], proposal, '; '.join(problems)
    for p in pieces if run_checker else []:
        p.checker = scene.check(p, pieces) if kind == 'scene' else check(p, kind)
    return pieces, proposal, None


def read_declined(design: Path) -> str | None:
    """The agent's reason for stopping, from out/declined.json (read once, as a regular file); None when it didn't.
    A file that is there but unreadable still means the agent stopped."""
    path = Path(design) / 'out' / 'declined.json'
    if not os.path.lexists(path):
        return None
    try:
        reason = json.loads(read_regular(path)).get('reason')
    except (UnsafeFile, json.JSONDecodeError, AttributeError, UnicodeDecodeError):
        reason = None
    return str(reason)[:120] if reason else 'no reason given'


class UnsafeFile(Exception):
    pass


def read_regular(path: Path, max_bytes: int | None = None) -> bytes:
    """A regular file's bytes, never through a symlink, never a hard link to something else, never a pipe or device
    (opened without blocking), and at most max_bytes when given."""
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            raise UnsafeFile(f'{_rel(path)} is not a regular file')
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        raise UnsafeFile(f'{_rel(path)} is not a regular file') from None
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise UnsafeFile(f'{_rel(path)} is not a regular file')
        if max_bytes is not None and st.st_size > max_bytes:
            raise UnsafeFile(f'{_rel(path)} is too large')
        data = f.read() if max_bytes is None else f.read(max_bytes + 1)
    if max_bytes is not None and len(data) > max_bytes:
        raise UnsafeFile(f'{_rel(path)} is too large')
    return data


# An emote's sound (Decentraland plays it with the emote): one .mp3 or .ogg beside the GLB, the item 3 MB at most
SOUND_SUFFIXES = ('.mp3', '.ogg')
OTHER_AUDIO = ('.wav', '.m4a', '.aac', '.flac', '.opus', '.aif', '.aiff')
ITEM_MAX_BYTES = 3 * 1024 * 1024


def is_sound(data: bytes, suffix: str) -> bool:
    """The bytes are the audio the name says: an Ogg stream, or an MP3 (an ID3 tag or a frame sync)."""
    if suffix == '.ogg':
        return data[:4] == b'OggS'
    return data[:3] == b'ID3' or (len(data) > 1 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0)


def emote_sound(folder: Path, glb_bytes: int) -> tuple[Path | None, str | None]:
    """out/emote/'s sound file, if it has one: (path, None), (None, None) without one, or (None, problem)."""
    rel = _rel(folder)
    files = [f for f in sorted(folder.iterdir()) if f.is_file() or os.path.islink(f)]
    other = [f.name for f in files if f.suffix.lower() in OTHER_AUDIO]
    if other:
        return None, (f'{rel}/{other[0]}: an emote\'s sound has to be .mp3 or .ogg: convert it (ffmpeg) or move it '
                      f'out of {rel}/')
    sounds = [f for f in files if f.suffix.lower() in SOUND_SUFFIXES]
    if not sounds:
        return None, None
    if len(sounds) > 1:
        return None, f'{rel}/ has {len(sounds)} sound files: an emote plays one ({", ".join(f.name for f in sounds)})'
    sound = sounds[0]
    try:
        data = read_regular(sound)
    except UnsafeFile as e:
        return None, str(e)
    if not is_sound(data, sound.suffix.lower()):
        return None, f'{rel}/{sound.name} is not {sound.suffix.lower()[1:]} audio'
    if glb_bytes + len(data) > ITEM_MAX_BYTES:
        return None, (f'{rel}/: the GLB and {sound.name} come to {(glb_bytes + len(data)) / 1048576:.2f} MB; an emote '
                      'is 3 MB at most with its sound: shorten or compress the sound')
    return sound, None


def _rel(path: Path) -> str:
    parts = Path(path).parts
    return '/'.join(parts[parts.index('out'):]) if 'out' in parts else str(path)


def _glbs_under(root: Path) -> list[Path]:
    """Every *.glb (any case) under root, without following symlinked folders."""
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not os.path.islink(os.path.join(dirpath, d))]
        found += [Path(dirpath) / f for f in filenames if f.lower().endswith('.glb')]
    return sorted(found)


def glbs_outside(design: Path, since: float) -> list[Path]:
    """GLBs written since `since` anywhere in the design but out/: an export to the wrong place."""
    design = Path(design)
    return [g for g in _glbs_under(design)
            if 'out' != g.relative_to(design).parts[0] and g.lstat().st_mtime >= since]


def glbs_exported(design: Path, since: float) -> list[Path]:
    """GLBs written to out/ since `since`: the pieces a run changed."""
    design = Path(design)
    return [g for g in _glbs_under(design)
            if 'out' == g.relative_to(design).parts[0] and g.lstat().st_mtime >= since]


def check(piece: Piece, kind: str) -> dict:
    scripts = config.SKILLS / 'skills'
    if kind == 'emote':
        cmd = ['python3', str(scripts / 'creating-dcl-emotes/scripts/check_emote.py'), *map(str, piece.glbs)]
        cmd += ['--loop'] if piece.meta.get('loop') in (True, 'yes') else []
    else:
        cmd = ['python3', str(scripts / 'creating-dcl-wearables/scripts/check_wearable.py'), *map(str, piece.glbs),
               '--category', piece.category]
        hides = piece.meta.get('hides') or []
        cmd += ['--hides', ','.join(hides) if isinstance(hides, list) else str(hides)] if hides else []
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=CHECKER_TIMEOUT_SEC)
    report = p.stdout + (legs_report(piece.glbs) if kind == 'emote' else '')
    levels = [l.split()[0] for l in report.splitlines() if l.startswith('  ') and l.split()]
    return {'ran': True, 'pass': p.returncode == 0, 'warnings': levels.count('WARN'), 'failures': levels.count('FAIL'),
            'report': report + p.stderr}


def legs_report(glbs: list[Path]) -> str:
    """The studio's own leg check (emote_legs), in the checker's line format: a WARN when the legs pass through each
    other, never a FAIL, so the emote still saves."""
    lines = ['Studio leg check:']
    for g in glbs:
        r = emote_legs.check(g)
        if r is None:
            lines.append(f'  INFO  {"legs check":<38} {g.name}: not checked (no avatar clip with both legs)')
        elif r.crossing:
            lines.append(f'  WARN  {"legs pass through each other":<38} {g.name}: {r.describe()}')
        else:
            lines.append(f'  PASS  {"legs apart":<38} {g.name}: thighs and shins stay clear of each other')
    return '\n'.join(lines) + '\n'


def new_hashes(pieces: list[Piece]) -> dict:
    return {p.category: {g.name: _sha(g) for g in p.glbs + p.extras} for p in pieces}


def glbs_by_shape(piece: Piece) -> dict:
    """{'male': path, 'female': path} from the _male/_female names, or {'unisex': path} for one GLB."""
    shapes = {s: g for g in piece.glbs for s in ('male', 'female') if g.stem.lower().endswith('_' + s)}
    return shapes or {'unisex': piece.glbs[0]}


def _shas(glbs: list[Path]) -> set[str]:
    return {_sha(g) for g in glbs}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _read_json(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
