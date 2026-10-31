"""Reads what the agent wrote: one piece per category under out/<category>/, or a slot proposal, and runs the skills'
checker on each piece."""
import hashlib
import json
import os
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from . import config

CHECKER_TIMEOUT_SEC = 300


@dataclass
class Piece:
    category: str
    glbs: list[Path]
    meta: dict  # piece.json
    changed: bool
    checker: dict  # ran, pass, failures, warnings, report


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
        proposal = json.loads(_read(out / 'proposal.json')) if os.path.lexists(out / 'proposal.json') else None
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
        try:
            meta = json.loads(_read(d / 'piece.json'))
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
            staged = stage / d.name
            staged.mkdir(parents=True, exist_ok=True)
            copies = []
            for g in glbs:
                copies.append(staged / g.name)
                copies[-1].write_bytes(_read(g))
            (staged / 'piece.json').write_text(json.dumps(meta))
        except UnsafeFile as e:
            problems.append(str(e))
            continue
        except json.JSONDecodeError as e:
            problems.append(f'{rel}/piece.json is not JSON: {e}')
            continue
        pieces.append(Piece(category=d.name, glbs=copies, meta=meta,
                            changed=_shas(copies) != set((hashes.get(d.name) or {}).values()), checker={'ran': False}))
    placed = {(p.category, g.name) for p in pieces for g in p.glbs}
    strays = [g for g in _glbs_under(out) if (g.parent.name, g.name) not in placed or g.parent.parent != out]
    if strays:
        names = ', '.join(g.relative_to(design).as_posix() for g in strays)
        problems.append(f'GLBs outside out/<category>/ with a piece.json: {names}')
    if problems:
        return [], proposal, '; '.join(problems)
    for p in pieces if run_checker else []:
        p.checker = check(p, kind)
    return pieces, proposal, None


def read_declined(design: Path) -> str | None:
    """The agent's reason for stopping, from out/declined.json (read once, as a regular file); None when it didn't.
    A file that is there but unreadable still means the agent stopped."""
    path = Path(design) / 'out' / 'declined.json'
    if not os.path.lexists(path):
        return None
    try:
        reason = json.loads(_read(path)).get('reason')
    except (UnsafeFile, json.JSONDecodeError, AttributeError, UnicodeDecodeError):
        reason = None
    return str(reason)[:120] if reason else 'no reason given'


class UnsafeFile(Exception):
    pass


def _read(path: Path) -> bytes:
    """A regular file's bytes, never through a symlink and never a hard link to something else."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise UnsafeFile(f'{_rel(path)} is not a regular file') from None
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise UnsafeFile(f'{_rel(path)} is not a regular file')
        return f.read()


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
    levels = [l.split()[0] for l in p.stdout.splitlines() if l.startswith('  ') and l.split()]
    return {'ran': True, 'pass': p.returncode == 0, 'warnings': levels.count('WARN'), 'failures': levels.count('FAIL'),
            'report': p.stdout + p.stderr}


def new_hashes(pieces: list[Piece]) -> dict:
    return {p.category: {g.name: _sha(g) for g in p.glbs} for p in pieces}


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
