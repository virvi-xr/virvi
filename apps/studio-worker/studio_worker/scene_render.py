"""Renders scene pieces (buildings, furniture, decor) in the worker's own Babylon page (scene_page/), headless Chrome on
SwiftShader, the way render.py renders wearables in Decentraland's preview. Modes:

- scene-orbit: the piece alone from every angle, the same frame grid as a wearable's Inspect (`ring`: the first 24)
- scale: 36 frames turning once round the piece beside a 1.8 m mannequin (`look`: four, front/right/back/left)
- tour: a first-person walk along `path` (eye-height points in the building's glTF frame) at 24 fps

Each render runs in a child process a watchdog kills, as render.py's do.
"""
import base64
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image

from . import config
from .render import CHROME_ARGS, LOOK_NAMES, _blank, _clear, _fail, _kill, _png, _wait, is_blank, orbit_steps

PAGE = Path(__file__).parent.parent / 'scene_page' / 'index.html'
VENDOR = PAGE.parent / 'vendor'
LOAD_SEC = 60
TOUR_FPS, TOUR_SPEED, TOUR_MIN_SEC, TOUR_MAX_SEC = 24, 1.4, 4.0, 20.0
EYE = 1.6
SCALE_FRAMES = 36
BACKGROUND = (0x5c, 0x63, 0x70)  # the page's clear colour (scene_page/index.html, scene_page.js)


def nothing_drawn(image: Image.Image) -> bool:
    """One flat colour, and it's the page's background: the renderer drew nothing. A walk-through can look straight at
    a plain wall, which is one flat colour too, but the wall's."""
    if not is_blank(image):
        return False
    r, g, b = image.convert('RGB').resize((1, 1), Image.BOX).getpixel((0, 0))
    return max(abs(r - BACKGROUND[0]), abs(g - BACKGROUND[1]), abs(b - BACKGROUND[2])) <= 6


def available() -> bool:
    chrome = shutil.which('google-chrome') or Path('/Applications/Google Chrome.app').exists()
    return bool(chrome) and (VENDOR / 'babylon.js').exists() and (VENDOR / 'babylonjs.loaders.min.js').exists()


def _walker():
    scripts = config.SKILLS / 'skills' / 'creating-dcl-buildings' / 'scripts'
    if str(scripts) not in sys.path:
        sys.path.insert(0, str(scripts))
    import check_walk
    import glbscene
    return check_walk, glbscene


def tour_path(building_glb: Path, route: dict, place: list) -> list[list[float]]:
    """Eye-height points every 5 cm along the route, at the floor the skills' walker stands on (so the camera climbs
    the stairs it climbs). `place`: [(glb, x, z, yaw)] furniture whose colliders the walker steps round."""
    cw, gs = _walker()
    world = cw.World()
    world.add(gs.parts(str(building_glb))[0])
    for glb, x, z, yaw in place:
        world.add(gs.parts(str(glb))[0], yaw, (x, z))
    wps = route['waypoints']
    _, stats = cw.walk(world, wps)
    xz = [(wps[0][0], wps[0][1])]
    for (ax, az, *_), (bx, bz, *_) in zip(wps, wps[1:]):
        n = max(1, int(math.ceil(math.hypot(bx - ax, bz - az) / cw.STRIDE)))
        xz += [(ax + (bx - ax) * k / n, az + (bz - az) * k / n) for k in range(1, n + 1)]
    return [[x, y + EYE, z] for (x, z), y in zip(xz, stats['heights'])]


def render(pieces: list[dict], view: dict, out: Path, frames: int = 36, size: int = 512, watchdog_sec: int = 300) -> dict:
    """pieces: [{'category', 'glbs': {'unisex': Path}, 'meta', 'at': {'x', 'z', 'yaw'} | None}]. Returns render.py's
    result shape: {'ok', 'frames', 'error', 'bootSec'}, plus 'fps' for a tour and 'blankFrame' on a blank frame."""
    out = Path(out).absolute()
    out.mkdir(parents=True, exist_ok=True)
    spec = {'pieces': [{**p, 'glbs': {k: str(Path(v).absolute()) for k, v in p['glbs'].items()}} for p in pieces],
            'view': view, 'out': str(out), 'size': size}
    with tempfile.TemporaryDirectory() as tmp:
        spec_path, result_path = Path(tmp) / 'spec.json', Path(tmp) / 'result.json'
        spec_path.write_text(json.dumps(spec))
        proc = subprocess.Popen([sys.executable, '-m', 'studio_worker.scene_render', '--run', str(spec_path),
                                 str(result_path)], start_new_session=True, stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, text=True, cwd=Path(__file__).parent.parent)
        try:
            log, _ = proc.communicate(timeout=watchdog_sec)
        except subprocess.TimeoutExpired:
            _kill(proc)
            _clear(out)
            return {'ok': False, 'frames': [], 'error': 'timeout', 'bootSec': None}
        if not result_path.exists():
            _clear(out)
            return {'ok': False, 'frames': [], 'error': (log or 'the renderer crashed')[-1000:], 'bootSec': None}
        result = json.loads(result_path.read_text())
    if not result['ok']:
        _clear(out)
    result['frames'] = [Path(f) for f in result['frames']] if result['ok'] else []
    return result


def _tour_frames(path: list) -> list[tuple]:
    """(eye position, the point 1 m ahead) for each frame: a walk at TOUR_SPEED, squeezed into TOUR_MAX_SEC."""
    lengths = [0.0]
    for a, b in zip(path, path[1:]):
        lengths.append(lengths[-1] + math.dist(a, b))
    total = lengths[-1]
    seconds = min(TOUR_MAX_SEC, max(TOUR_MIN_SEC, total / TOUR_SPEED))
    n = round(seconds * TOUR_FPS)

    def at(s):
        s = max(0.0, min(total, s))
        i = next((k for k in range(1, len(lengths)) if lengths[k] >= s), len(lengths) - 1)
        seg = lengths[i] - lengths[i - 1] or 1.0
        t = (s - lengths[i - 1]) / seg
        return [path[i - 1][j] + (path[i][j] - path[i - 1][j]) * t for j in range(3)]
    shots = []
    for f in range(n):
        s = total * f / max(1, n - 1)
        here, ahead = at(s), at(s + 1.0)
        if math.dist(here, ahead) < 1e-6:  # the end of the walk: keep looking the way it came
            back = at(s - 1.0)
            ahead = [2 * here[j] - back[j] for j in range(3)]
        ahead[1] = here[1]  # look level, not at the floor of the next step
        shots.append((here, ahead))
    return shots


def _run(spec: dict) -> dict:
    from playwright.sync_api import sync_playwright

    view, out, size = spec['view'], Path(spec['out']), spec['size']
    files, items = {}, []
    for p in spec['pieces']:
        path = Path(next(iter(p['glbs'].values())))
        name = f"{p['category']}-{path.name}"
        files[name] = base64.b64encode(path.read_bytes()).decode()
        items.append({'category': p['category'], 'file': name, 'at': p.get('at')})
    start = time.monotonic()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome', headless=True, args=CHROME_ARGS + ['--allow-file-access-from-files'])
        page = browser.new_page(viewport={'width': size, 'height': size})
        page.goto(PAGE.as_uri())
        if not _wait(page, 'window.__scene && window.__scene.ready', LOAD_SEC):
            return _fail('timeout', start)
        try:
            loaded = page.evaluate('([f, i]) => __scene.load(f, i)', [files, items])
        except Exception as e:  # a GLB Babylon can't read
            return _fail(f'item_not_loaded: {str(e)[:300]}', start)
        if not loaded['triangles']:
            return _fail('item_not_loaded', start)
        boot = round(time.monotonic() - start, 1)
        mode, names, fps = view['mode'], None, None
        if mode == 'scene-orbit':
            page.evaluate('__scene.frameOrbit()')
            steps = [('orbit', s.get('alpha', 0), s.get('beta', 0)) for s in orbit_steps(bool(view.get('ring')))]
        elif mode == 'scale':
            page.evaluate('__scene.ground()')
            lo, hi = loaded['min'], loaded['max']
            page.evaluate('([x, z]) => __scene.mannequin(x, z)', [hi[0] + 0.6, -(lo[2] + hi[2]) / 2])
            page.evaluate('__scene.frameOrbit(1.05)')
            n = 4 if view.get('look') else SCALE_FRAMES
            steps = [('orbit', 0 if i == 0 else 2 * math.pi / n, 0) for i in range(n)]
            if view.get('look'):
                names = [f"{spec['pieces'][0]['category']}-{LOOK_NAMES[i]}.png" for i in range(4)]
        elif mode == 'tour':
            page.evaluate('__scene.ground()')
            shots = _tour_frames(view['path'])
            if view.get('sample'):
                keep = sorted({round(j * (len(shots) - 1) / max(1, view['sample'] - 1)) for j in range(view['sample'])})
                shots = [shots[i] for i in keep]
                names = [f'tour-{j:02d}.png' for j in range(len(shots))]
            steps = [('eye', *here, *ahead) for here, ahead in shots]
            fps = float(TOUR_FPS)
        else:
            return _fail(f'unknown scene mode {mode!r}', start)
        frames = []
        for i, step in enumerate(steps):
            if step[0] == 'orbit':
                page.evaluate('([a, b]) => __scene.orbit(a, b)', list(step[1:]))
            else:
                page.evaluate('(p) => __scene.eye(...p)', list(step[1:]))
            page.evaluate('__scene.frame()')
            image = Image.open(_png(page))
            if nothing_drawn(image):
                return _blank(image, out, i, start)
            if names:
                path = out / names[i]
                image.save(path)
            else:
                path = out / f'{i:03d}.webp'
                image.save(path, 'WEBP', quality=80)
            frames.append(str(path))
        browser.close()
    return {'ok': True, 'frames': frames, 'error': None, 'bootSec': boot, **({'fps': fps} if fps else {})}


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['--run']:
        result = _run(json.loads(Path(argv[1]).read_text()))
        Path(argv[2]).write_text(json.dumps(result))
        return 0
    return 2


if __name__ == '__main__':
    sys.exit(main())
