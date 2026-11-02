"""Scene pieces (buildings, furniture, decor): where they live under out/, what goes with each, and the scene skills'
checks (check_scene_model.py, and check_walk.py for a building) merged into one checker result."""
import json
import re
import subprocess
from pathlib import Path

from . import config

# out/building/ or out/furniture_<slug>/: lowercase letters and underscores only, as Virvi's file paths allow
CATEGORY = re.compile(r'^(building|furniture_[a-z_]{1,32})$')
MAX_FURNITURE = 12
FOOTPRINTS = ('0.5x0.5', '1x1', '1x2', '2x2', '4x4')
FURNITURE_KINDS = ('furniture', 'decor')
CHECK_TIMEOUT_SEC = 300
MISSING_ROUTE = ('  FAIL  route.json missing: write {"waypoints": [[x, z], [x, z, y], ...]} from outside, through the '
                 'doorway, round every room and floor')


def _scripts() -> Path:
    return config.SKILLS / 'skills' / 'creating-dcl-buildings' / 'scripts'


def folder_problem(name: str) -> str | None:
    if CATEGORY.match(name):
        return None
    return (f'out/{name}/ is not a scene piece folder: use out/building/ or out/furniture_<name>/ '
            '(lowercase letters and underscores)')


def validate(category: str, meta: dict, glbs: list[Path]) -> str | None:
    """A problem with one piece's folder, or None."""
    if len(glbs) != 1:
        return f'out/{category}/ needs exactly one GLB, not {len(glbs)}'
    kind = meta.get('kind')
    if category == 'building':
        if kind != 'building':
            return f'out/building/piece.json needs "kind": "building", not {kind!r}'
        if meta.get('footprint') not in FOOTPRINTS:
            return f'out/building/piece.json needs "footprint": one of {", ".join(FOOTPRINTS)}'
    elif kind not in FURNITURE_KINDS:
        return f'out/{category}/piece.json needs "kind": "furniture" or "decor", not {kind!r}'
    return None


def limits(categories: list[str]) -> str | None:
    furniture = [c for c in categories if c != 'building']
    if len(furniture) > MAX_FURNITURE:
        return f'a scene design holds at most one building and {MAX_FURNITURE} furniture pieces, not {len(furniture)}'
    return None


def extras(folder: Path, meta: dict) -> list[Path]:
    """The files that travel with a piece: a building's route.json and layout.json, a furniture piece's
    <name>.sittables.json."""
    if meta.get('kind') == 'building':
        names = ['layout.json', 'route.json']
        return [folder / n for n in names if (folder / n).exists()]
    return sorted(p for p in folder.iterdir() if p.name.endswith('.sittables.json'))


def _rows(report: str) -> list[list[str]]:
    return [line.split() for line in report.splitlines() if line.startswith('  ') and line.split()]


def _run(args: list) -> str:
    p = subprocess.run(['python3', *map(str, args)], capture_output=True, text=True, timeout=CHECK_TIMEOUT_SEC)
    out = p.stdout + p.stderr
    if p.returncode not in (0, 1) or not _rows(out):  # it crashed: a FAIL, so nothing passes unchecked
        out += f'\n  FAIL  the check did not run (exit {p.returncode})'
    return out


def _triangles(model_report: str) -> dict | None:
    for line in model_report.splitlines():
        m = re.match(r'\s+WARN\s+triangles\s+(\d+)\s+recommended <= (\d+)', line)
        if m:
            return {'count': int(m.group(1)), 'limit': int(m.group(2))}
    return None


def check(piece, others: list) -> dict:
    """Runs the scene checks on one piece. A building's walk with its furniture placed (layout.json) only warns: the
    arrangement is a preview and never blocks a building that's fine on its own."""
    meta, glb = piece.meta, piece.glbs[0]
    named = {e.name: e for e in piece.extras}
    args = [_scripts() / 'check_scene_model.py', glb, '--kind', meta.get('kind', 'furniture')]
    if meta.get('footprint'):
        args += ['--footprint', meta['footprint']]
    if meta.get('type'):
        args += ['--type', str(meta['type'])]
    seats = [e for e in piece.extras if e.name.endswith('.sittables.json')]
    if seats:
        args += ['--sittables', seats[0]]
    model = _run(args)
    sections, failures, warnings = [('model check', model)], 0, 0
    for r in _rows(model):
        failures += r[0] == 'FAIL'
        warnings += r[0] == 'WARN'

    if meta.get('kind') == 'building':
        walk = _run([_scripts() / 'check_walk.py', glb, '--route', named['route.json']]) if 'route.json' in named \
            else MISSING_ROUTE
        sections.append(('walk check', walk))
        for r in _rows(walk):
            failures += r[0] == 'FAIL'
            warnings += r[0] == 'WARN'
        furnished = _furnished_walk(glb, named, others)
        if furnished:
            sections.append(('furnished walk', furnished))
            warnings += sum(r[0] in ('FAIL', 'WARN') for r in _rows(furnished))

    report = '\n'.join(f'== {title}\n{text.rstrip()}' for title, text in sections) + '\n'
    return {'ran': True, 'pass': failures == 0, 'failures': failures, 'warnings': warnings,
            'triangles': _triangles(model), 'report': report}


def _furnished_walk(glb: Path, named: dict, others: list) -> str | None:
    if 'route.json' not in named or 'layout.json' not in named:
        return None
    try:
        layout = json.loads(named['layout.json'].read_text()).get('furniture') or []
    except (ValueError, AttributeError):
        return '  WARN  layout.json is not {"furniture": [{"category", "x", "z", "yaw"}, ...]}: skipped'
    pieces = {p.category: p for p in others}
    place, notes = [], []
    for item in layout:
        p = pieces.get(item.get('category')) if isinstance(item, dict) else None
        if p is None:
            notes.append(f"  WARN  layout names {item.get('category') if isinstance(item, dict) else item!r}, which is "
                         'not a piece: skipped')
            continue
        place += ['--place', p.glbs[0], item.get('x', 0), item.get('z', 0), item.get('yaw', 0)]
    walk = _run([_scripts() / 'check_walk.py', glb, '--route', named['route.json'], *place]) if place else ''
    text = '\n'.join(x for x in notes + [walk.rstrip()] if x)
    return text or None
