"""Renders pieces on the Decentraland avatar in the hosted wearable-preview (Babylon, headless Chrome on
SwiftShader), and the `studio-preview` command the agent uses to look at its work.

    studio-preview out/hat [out/eyewear ...] [--out review]
    studio-preview out/hat [out/eyewear ...] --emote dance [--body male] [--out review/dance]

Each render runs in a child process that a watchdog kills, so a hung Chrome can never hang the machine. Readiness
comes from the preview's own messages, and the item counts as loaded only when the scene's triangle count moves
away from the bare avatar's (up, or down for a piece that hides or replaces a base part).
"""
import argparse
import base64
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image

from . import config

MALE = 'urn:decentraland:off-chain:base-avatars:BaseMale'
FEMALE = 'urn:decentraland:off-chain:base-avatars:BaseFemale'
PAGE_JS = Path(__file__).parent / 'preview_page.js'
LOAD_SEC = 90  # the longest the preview may take to send `load` for the item (on SwiftShader, about 10 s)
METRICS_SEC = 10  # after `load`, how long the triangle count may take to rise
CHROME_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
LOOK_NAMES = ('front', 'right', 'back', 'left')
# Inspect: the item alone over a sphere of camera elevations (beta, degrees), the eye-level ring first, 24 columns
# round each, then one frame looking straight down (frame 120) and one looking straight up (frame 121)
ORBIT_ROWS = (90, 60, 120, 30, 150)
ORBIT_COLS = 24
ORBIT_FRAMES = len(ORBIT_ROWS) * ORBIT_COLS + 2
WALK_FPS, WALK_MIN_SEC, WALK_MAX_FRAMES = 24, 4.0, 120
EMOTE_SAMPLE = 16  # frames studio-preview --emote keeps


def orbit_steps(ring: bool) -> list[dict]:
    """The camera move before each orbit frame. Moves are relative and the camera starts at the front, at eye level
    (beta 90°); each row ends one column short of a full turn, so the next row's first move completes it."""
    col = 2 * math.pi / ORBIT_COLS
    steps, beta = [], 90
    for r, row in enumerate(ORBIT_ROWS[:1] if ring else ORBIT_ROWS):
        steps.append({} if r == 0 else {'alpha': col, 'beta': math.radians(row - beta)})
        steps += [{'alpha': col}] * (ORBIT_COLS - 1)
        beta = row
    if not ring:
        steps += [{'alpha': col, 'beta': math.radians(0 - beta)}, {'beta': math.radians(180)}]
    return steps


def walk_schedule(length: float) -> tuple[list[float], float]:
    """The animation times of a walk-around's frames and the rate they play back at: 24 a second, the camera's one
    turn spread over at least 4 s (looping a short emote), at most 120 frames."""
    if not length or length <= 0:
        return [0.0] * round(WALK_MIN_SEC * WALK_FPS), float(WALK_FPS)
    total = max(length, WALK_MIN_SEC)
    n = min(WALK_MAX_FRAMES, round(total * WALK_FPS))
    return [(i * total / n) % length for i in range(n)], n / total


def render(pieces: list[dict], view: dict, out: Path, frames: int = 36, size: int = 512,
           watchdog_sec: int = 300) -> dict:
    """pieces: [{'category', 'glbs': {'male'|'female'|'unisex': Path}, 'meta'}];
    view: {'bodyShape': 'male'|'female', 'outfit', 'emote', 'mode': 'spin'|'emote'|'look'|'thumbnail'|'orbit'|'walk'}.
    A thumbnail is one 256 px square PNG on a transparent background (an emote paused halfway). An orbit is the item
    alone from every angle (`ring` keeps the eye-level 24); a walk-around steps the emote through its timeline while
    the camera turns once (`sample`: keep that many evenly spaced frames, as PNGs). Both ignore `frames`.
    Returns {'ok', 'frames': [Path], 'error': None|'timeout'|'item_not_loaded'|'blank'|str, 'bootSec'}, plus
    'fps' for a walk-around, and on 'blank' `blankFrame`: {'index', 'path'}, that frame as a PNG beside `out`."""
    out = Path(out).absolute()  # the child process runs in another directory
    out.mkdir(parents=True, exist_ok=True)
    spec = {'pieces': [{**p, 'glbs': {k: str(Path(v).absolute()) for k, v in p['glbs'].items()}} for p in pieces],
            'view': view,
            'out': str(out), 'frames': frames, 'size': size, 'url': config.PREVIEW_URL,
            'proxy': os.environ.get('HTTPS_PROXY')}
    with tempfile.TemporaryDirectory() as tmp:
        spec_path, result_path = Path(tmp) / 'spec.json', Path(tmp) / 'result.json'
        spec_path.write_text(json.dumps(spec))
        proc = subprocess.Popen([sys.executable, '-m', 'studio_worker.render', '--run', str(spec_path),
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


def is_blank(image: Image.Image, threshold: float = 4.0) -> bool:
    """True when the frame is one flat colour: the renderer drew nothing."""
    pixels = np.asarray(image.convert('RGB'), dtype=np.float32).reshape(-1, 3)
    return float(pixels.std(axis=0).max()) < threshold  # per channel: one flat colour differs between channels


def chrome_available() -> bool:
    return bool(shutil.which('google-chrome') or Path('/Applications/Google Chrome.app').exists())


def _kill(proc: subprocess.Popen) -> None:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(proc.pid, sig)
            proc.wait(timeout=5)
            return
        except ProcessLookupError:
            return
        except subprocess.TimeoutExpired:
            continue


def _clear(out: Path) -> None:
    """No frames survive a failed render: a bare avatar must never be uploaded as the design."""
    for f in list(out.glob('*.webp')) + list(out.glob('*.png')):
        f.unlink()


def _query(view: dict) -> str:
    shape = FEMALE if view.get('bodyShape') == 'female' else MALE
    if view.get('mode') == 'orbit':  # the item alone: with an outfit the page shows the outfit's first wearable
        return f'bodyShape={shape}&disableAutoRotate=true&disableBackground=false&type=wearable'
    return '&'.join([f"profile={config.OUTFITS.get(view.get('outfit') or 'default', 'default1')}",
                     f'bodyShape={shape}', 'disableAutoRotate=true',
                     f"disableBackground={'true' if view.get('mode') == 'thumbnail' else 'false'}",
                     f"emote={'idle' if view.get('emote') in (None, 'own') else view['emote']}"])


def _run(spec: dict) -> dict:
    """The child process: one browser, one page, one render."""
    from playwright.sync_api import sync_playwright

    view, out, frames, size = spec['view'], Path(spec['out']), spec['frames'], spec['size']
    files, items = {}, []
    for p in spec['pieces']:
        names = {}
        for shape, path in p['glbs'].items():
            name = f"{p['category']}-{shape}-{Path(path).name}"
            files[name] = base64.b64encode(Path(path).read_bytes()).decode()
            names[shape] = name
        items.append({'category': p['category'], 'glbs': names, 'meta': p.get('meta') or {}})
    url = spec['url'] + ('&' if '?' in spec['url'] else '?') + _query(view)
    start = time.monotonic()
    with sync_playwright() as pw:
        args = CHROME_ARGS + ([f"--proxy-server={spec['proxy']}"] if spec.get('proxy') else [])
        browser = pw.chromium.launch(channel='chrome', headless=True, args=args)
        page = browser.new_page(viewport={'width': size, 'height': size})
        page.add_init_script(path=str(PAGE_JS))
        page.goto(url)
        if not _wait(page, "__studio.count('ready') + __studio.count('error') > 0", LOAD_SEC) or \
                not _wait(page, "__studio.count('load') + __studio.count('error') > 0", LOAD_SEC):
            return _fail('timeout', start)
        if page.evaluate("__studio.count('error')"):
            return _fail('preview error: ' + json.dumps(page.evaluate("__studio.messages")), start)
        has_emote = any(i['category'] == 'emote' for i in items)
        baseline = _triangles(page), _length(page) if has_emote else None
        loads = page.evaluate("__studio.count('load')")
        page.evaluate('([files, items]) => __studio.update(files, items)', [files, items])
        if not _wait(page, f"__studio.count('load') > {loads} || __studio.count('error') > 0", LOAD_SEC):
            return _fail('item_not_loaded', start)
        deadline = time.monotonic() + METRICS_SEC
        # a wearable changes the triangle count (up, or down when it hides or replaces a base part); an emote
        # without props changes none, so it shows as a new animation length
        while _triangles(page) == baseline[0] and not (has_emote and _length(page) not in (baseline[1], 0, None)):
            if time.monotonic() > deadline:
                return _fail('item_not_loaded', start)
            page.wait_for_timeout(250)
        boot = round(time.monotonic() - start, 1)

        shots = []
        mode = view.get('mode', 'spin')
        if mode == 'thumbnail':
            if has_emote:
                page.evaluate("__studio.call('emote', 'pause')")
                length = page.evaluate("__studio.call('emote', 'getLength')") or 0
                page.evaluate("([ns, m, p]) => __studio.call(ns, m, p)", ['emote', 'goTo', [length / 2]])
            page.evaluate('__studio.frames()')
            image = Image.open(_png(page, transparent=True)).convert('RGBA')
            if is_blank(image):
                return _blank(image, out, 0, start)
            path = out / 'thumbnail.png'
            fit_square(image).save(path)
            browser.close()
            return {'ok': True, 'frames': [str(path)], 'error': None, 'bootSec': boot}
        fps, names = None, None
        if mode == 'emote':
            page.evaluate("__studio.call('emote', 'pause')")
            length = page.evaluate("__studio.call('emote', 'getLength')") or 0
            steps = [('emote', 'goTo', [i * length / frames]) for i in range(frames)]
        elif mode == 'orbit':
            steps = [('scene', 'changeCameraPosition', [m]) if m else None for m in orbit_steps(bool(view.get('ring')))]
        elif mode == 'walk':
            page.evaluate("__studio.call('emote', 'pause')")
            times, fps = walk_schedule(page.evaluate("__studio.call('emote', 'getLength')") or 0)
            n = len(times)
            keep = sorted({round(j * n / view['sample']) for j in range(view['sample'])}) if view.get('sample') \
                else list(range(n))
            # each kept frame turns the camera on by as many steps as frames were skipped, so angles match the full run
            steps = [[('emote', 'goTo', [times[i]]),
                      ('scene', 'changeCameraPosition', [{'alpha': 2 * math.pi * (i - prev) / n}])]
                     for prev, i in zip([-1] + keep, keep)]
            if view.get('sample'):
                names = [f'{j:02d}.png' for j in range(len(keep))]
        else:
            n = 4 if mode == 'look' else frames
            turn = ('scene', 'changeCameraPosition', [{'alpha': 2 * math.pi / n}])
            # a spin turns before each frame; a look starts at the front so its four views are named right
            steps = [None] + [turn] * (n - 1) if mode == 'look' else [turn] * n
        for i, step in enumerate(steps):
            for call in (step if isinstance(step, list) else [step] if step else []):
                page.evaluate('([ns, m, p]) => __studio.call(ns, m, p)', list(call))
            page.evaluate('__studio.frames()')
            image = Image.open(_png(page))
            if is_blank(image):
                return _blank(image, out, i, start)
            if mode == 'look':
                path = out / f"{view.get('bodyShape', 'male')}-{LOOK_NAMES[i]}.png"
                image.save(path)
            elif names:
                path = out / names[i]
                image.save(path)
            else:
                path = out / f'{i:03d}.webp'
                image.save(path, 'WEBP', quality=80)
            shots.append(str(path))
        browser.close()
    return {'ok': True, 'frames': shots, 'error': None, 'bootSec': boot, **({'fps': fps} if fps else {})}


def _png(page, transparent: bool = False):
    import io
    return io.BytesIO(page.screenshot(type='png', omit_background=transparent))


def fit_square(image: Image.Image, size: int = 256, margin: float = 0.08) -> Image.Image:
    """The opaque part of an RGBA image, centred on a transparent square of `size` px."""
    box = image.getchannel('A').getbbox() or (0, 0, image.width, image.height)
    item = image.crop(box)
    side = int(max(item.size) * (1 + 2 * margin)) or 1
    canvas = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    canvas.paste(item, ((side - item.width) // 2, (side - item.height) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


def _wait(page, expression: str, seconds: float) -> bool:
    try:
        page.wait_for_function(expression, timeout=seconds * 1000, polling=100)
        return True
    except Exception:  # playwright's TimeoutError
        return False


def _triangles(page) -> int:
    try:
        metrics = page.evaluate("__studio.call('scene', 'getMetrics')") or {}
    except Exception:  # the item-alone view (orbit) has no scene, so no controller, until the item arrives
        return 0
    return int(metrics.get('triangles') or 0)


def _length(page):
    try:
        return page.evaluate("__studio.call('emote', 'getLength')")
    except Exception:  # the controller rejects: no emote playing
        return None


def _fail(error: str, start: float) -> dict:
    return {'ok': False, 'frames': [], 'error': error, 'bootSec': round(time.monotonic() - start, 1)}


def _blank(image: Image.Image, out: Path, index: int, start: float) -> dict:
    """A blank-frame failure, the frame kept beside `out` (whose frames are cleared) so someone can see what rendered."""
    kept = out.with_name(f'{out.name}.blank-{index:03d}.png')
    image.save(kept)
    return {**_fail('blank', start), 'blankFrame': {'index': index, 'path': str(kept)}}


def _load_pieces(piece_dirs: list[Path]) -> list[dict]:
    from .pieces import Piece, glbs_by_shape
    pieces = []
    for d in piece_dirs:
        d = Path(d)
        meta = json.loads((d / 'piece.json').read_text()) if (d / 'piece.json').exists() else {}
        glbs = sorted(d.glob('*.glb'))
        if not glbs:
            raise SystemExit(f'{d} has no GLB')
        piece = Piece(category=meta.get('category') or d.name, glbs=glbs, meta=meta, changed=True, checker={})
        pieces.append({'category': piece.category, 'glbs': glbs_by_shape(piece), 'meta': meta})
    return pieces


def look(piece_dirs: list[Path], out: Path) -> list[Path]:
    """studio-preview: front, right, back and left views of the pieces together, on each body shape they have."""
    pieces = _load_pieces(piece_dirs)
    shapes = sorted({s for p in pieces for s in p['glbs']} - {'unisex'}) or ['male', 'female']
    paths = []
    for shape in shapes:
        r = render(pieces, {'bodyShape': shape, 'outfit': 'default', 'emote': None, 'mode': 'look'}, Path(out) / shape)
        if not r['ok']:
            raise SystemExit(f'studio-preview failed on the {shape} body: {r["error"]}')
        paths += r['frames']
    return paths


def look_emote(piece_dirs: list[Path], out: Path, emote: str, body: str = 'male', outfit: str = 'default',
               pieces: list[dict] | None = None) -> list[Path]:
    """studio-preview --emote: 16 evenly spaced frames of an emote (`own` for an emote design's own) with the pieces
    worn together, the camera turning once round over the playthrough. Saved as out/NN.png."""
    if emote != 'own' and emote not in config.BASE_EMOTES:
        raise SystemExit(f"unknown emote {emote!r}: use one of {', '.join(config.BASE_EMOTES)}, or own")
    r = render(pieces if pieces is not None else _load_pieces(piece_dirs),
               {'bodyShape': body, 'outfit': outfit, 'emote': emote, 'mode': 'walk', 'sample': EMOTE_SAMPLE}, Path(out))
    if not r['ok']:
        raise SystemExit(f'studio-preview failed on the {emote} ({body}): {r["error"]}')
    return r['frames']


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if argv[:1] == ['--run']:
        result = _run(json.loads(Path(argv[1]).read_text()))
        Path(argv[2]).write_text(json.dumps(result))
        return 0
    ap = argparse.ArgumentParser(prog='studio-preview', description='Look at pieces on the Decentraland avatar: '
                                 'writes front, right, back and left views for each body shape and prints their paths.')
    ap.add_argument('pieces', nargs='+', type=Path, help='piece folders, such as out/hat')
    ap.add_argument('--out', type=Path, help='where to write the frames (default review, or review/<emote>)')
    ap.add_argument('--emote', help=f"instead, 16 frames of this emote with the pieces worn: "
                                    f"{', '.join(config.BASE_EMOTES)}, or own for an emote design")
    ap.add_argument('--body', choices=('male', 'female'), default='male', help='the body shape for --emote')
    ap.add_argument('--outfit', choices=tuple(config.OUTFITS), default='default', help='the base outfit for --emote')
    a = ap.parse_args(argv)
    if a.emote:
        paths = look_emote(a.pieces, a.out or Path('review') / a.emote, a.emote, a.body, a.outfit)
    else:
        paths = look(a.pieces, a.out or Path('review'))
    for p in paths:
        print(p)
    return 0


if __name__ == '__main__':
    sys.exit(main())
