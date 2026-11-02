"""Scene pieces (buildings, furniture, decor): where they live under out/, what goes with each, and the scene skills'
checks (check_scene_model.py, and check_walk.py for a building) merged into one checker result."""
import json
import re
import subprocess
from pathlib import Path

from . import config

# out/building/ or out/furniture_<slug>/: lowercase letters and underscores only, as Virvi's file paths allow, and
# at most 32 characters in all (a finalize job's category limit)
CATEGORY = re.compile(r'^(building|furniture_[a-z_]{1,22})$')
MAX_FURNITURE = 12
FOOTPRINTS = ('0.5x0.5', '1x1', '1x2', '2x2', '4x4')
FURNITURE_KINDS = ('furniture', 'decor')
CHECK_TIMEOUT_SEC = 300
FURNITURE_MAX_M = 8.0  # half a parcel: anything wider or deeper is a building (and priced as one)
SAFE_NAME = re.compile(r'^[A-Za-z0-9._-]{1,120}$')  # what Virvi stores as a file name
MISSING_ROUTE = ('  FAIL  route.json missing: write {"waypoints": [[x, z], [x, z, y], ...]} from outside, through the '
                 'doorway, round every room and floor')


def _scripts() -> Path:
    return config.SKILLS / 'skills' / 'creating-dcl-buildings' / 'scripts'


def folder_problem(name: str) -> str | None:
    if CATEGORY.match(name):
        return None
    return (f'out/{name}/ is not a scene piece folder: use out/building/ or out/furniture_<name>/ '
            '(<name>: up to 22 lowercase letters and underscores)')


def validate(category: str, meta: dict, glbs: list[Path]) -> str | None:
    """A problem with one piece's folder, or None."""
    if len(glbs) != 1:
        return f'out/{category}/ needs exactly one GLB, not {len(glbs)}'
    folder = glbs[0].parent
    bad = [p.name for p in [*glbs, *folder.glob('*.json')] if not SAFE_NAME.match(p.name)]
    if bad:
        return f'out/{category}/: rename {", ".join(bad)} (letters, digits, dots, dashes and underscores only)'
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


def layout_items(path: Path, pieces: dict) -> tuple[list[dict], list[str]]:
    """The furniture a building's layout.json places, as {'piece', 'x', 'z', 'yaw'}, and a warning for each entry that
    can't be placed (not a piece, the building itself, or a position that isn't numbers): skipped, never fatal."""
    try:
        entries = json.loads(Path(path).read_text()).get('furniture') or []
        if not isinstance(entries, list):
            raise ValueError
    except (ValueError, AttributeError, OSError):
        return [], ['layout.json is not {"furniture": [{"category", "x", "z", "yaw"}, ...]}: no furniture placed']
    placed, warnings = [], []
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool)
    for item in entries:
        name = item.get('category') if isinstance(item, dict) else item
        piece = pieces.get(name) if isinstance(name, str) and name != 'building' else None
        if piece is None:
            warnings.append(f'layout names {name!r}, which is not a furniture piece: skipped')
            continue
        where = {k: item.get(k, 0) for k in ('x', 'z', 'yaw')}
        if not all(num(v) for v in where.values()):
            warnings.append(f'layout places {name} at {where}, and that is not a number: skipped')
            continue
        placed.append({'piece': piece, **where})
    return placed, warnings


def _size(model_report: str) -> tuple[float, float, float] | None:
    m = re.search(r'size w x h x d\s+([\d.]+) x ([\d.]+) x ([\d.]+) m', model_report)
    return tuple(float(g) for g in m.groups()) if m else None


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
    size = _size(model)
    if meta.get('kind') != 'building' and size and max(size[0], size[2]) > FURNITURE_MAX_M:
        model += (f'\n  FAIL  {size[0]:.1f} x {size[2]:.1f} m is bigger than furniture can be ({FURNITURE_MAX_M:g} m, half a '
                  'parcel): a piece this size is a building, so build it in out/building/ with its footprint')
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
    placed, warned = layout_items(named['layout.json'], {p.category: p for p in others})
    notes = [f'  WARN  {w}' for w in warned]
    place = []
    for item in placed:
        place += ['--place', item['piece'].glbs[0], item['x'], item['z'], item['yaw']]
    walk = _run([_scripts() / 'check_walk.py', glb, '--route', named['route.json'], *place]) if place else ''
    text = '\n'.join(x for x in notes + [walk.rstrip()] if x)
    return text or None
