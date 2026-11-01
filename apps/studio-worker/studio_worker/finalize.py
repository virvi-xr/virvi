"""A finalize job: builds the package of each paid revision listed in the job, from that revision's own files (read
from Virvi with `inputs`, never from the workspace), and uploads it as final/<category>/package.zip. See CONTRACT.md,
"Package". No agent runs and no workspace is saved.

Checks that fail (thumbnail, listing, clipping) go in the package's REPORT.md, plainly: the customer has paid. A tool
that crashes, a failed render or a missing input fails that piece only.
"""
import json
import re
import shutil
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from PIL import Image

from . import config
from .api import ApiError
from .pieces import Piece, glbs_by_shape
from .render import fit_square

THUMBNAIL_BLEND = Path(__file__).parent / 'thumbnail_blend.py'
AVATARS = {'male': 'AvatarShape_A.blend', 'female': 'AvatarShape_B.blend'}
SHAPES = ('male', 'female')
LOOK_VIEWS = ('front', 'right', 'back', 'left')
PROMO_FRAMES, PROMO_SIZE, PROMO_FPS = 72, 720, 24
RENDER_SIZE = 1024
REPORT_LINES = 200
SAFE_NAME = re.compile(r'^[A-Za-z0-9._-]{1,120}$')
# package_item.py's own limits (the Builder's)
BUILDER_NAME_MAX, BUILDER_DESCRIPTION_MAX = 32, 64


def _run(cmd: list[str], timeout: int) -> tuple[bool, str]:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, f'timed out after {timeout}s'
    except OSError as e:
        return False, str(e)
    return p.returncode == 0, p.stdout + p.stderr


@dataclass
class Tools:
    """The programs a package needs, each returning (ok, output); tests pass fakes."""
    blender: Callable[[list[str], int], tuple[bool, str]]
    python: Callable[[Path, list[str], int], tuple[bool, str]]
    ffmpeg: Callable[[list[str], int], tuple[bool, str]]

    @staticmethod
    def real() -> 'Tools':
        return Tools(blender=lambda args, t: _run(['blender', *map(str, args)], t),
                     python=lambda script, args, t: _run([sys.executable, str(script), *map(str, args)], t),
                     ffmpeg=lambda args, t: _run(['ffmpeg', *map(str, args)], t))


class PieceFailed(Exception):
    pass


def finalize_job(job: dict, client, render_fn, tools: Tools, result: dict, stage: Path) -> None:
    spec, kind = job.get('finalize') or {}, job.get('kind', 'wearable')
    _phase(client, job['jobId'])
    problems = []
    for piece in spec.get('pieces') or []:
        category = piece.get('category', '')
        try:
            if not re.fullmatch(r'[a-z_]{1,32}', category):
                raise PieceFailed('not a piece category')
            work = Path(stage) / category
            work.mkdir(parents=True, exist_ok=True)
            summary, zipped = _package(job, piece, kind, spec.get('designName') or '', client, render_fn, tools, work)
            path = f'final/{category}/package.zip'
            client.put_file(job['jobId'], path, zipped.read_bytes(), 'application/zip')
            result['pieces'].append({'category': category, 'files': [path], 'finalize': summary})
        except PieceFailed as e:
            problems.append(f'{category}: {e}')
        except ApiError as e:
            problems.append(f'{category}: upload failed: {e}')
    result.update(outcome='error' if problems else 'ok', error='; '.join(problems) or None)


def _phase(client, job_id):
    try:
        client.event(job_id, {'type': 'phase', 'phase': 'packaging'})
    except ApiError as e:
        print(f'event not sent: {e}', file=sys.stderr)


def _inputs(job_id: str, piece: dict, client, into: Path) -> tuple[list[Path], dict, str]:
    """The paid revision's GLBs, piece.json and checker report, downloaded into `into`."""
    category = piece['category']
    glbs, meta, report = [], None, ''
    for f in piece.get('files') or []:
        name = f.rsplit('/', 1)[-1]
        if not SAFE_NAME.match(name):
            raise PieceFailed(f'odd input name {f!r}')
        try:
            data = client.get_input(job_id, f)
        except ApiError as e:
            raise PieceFailed(f'input {name} could not be read ({e.status or e})') from None
        if f.startswith(f'pieces/{category}/') and name.lower().endswith('.glb'):
            (into / name).write_bytes(data)
            glbs.append(into / name)
        elif f == f'pieces/{category}/piece.json':
            try:
                meta = json.loads(data)
            except json.JSONDecodeError:
                raise PieceFailed('piece.json is not JSON') from None
        elif f == f'checks/{category}.txt':
            report = data.decode(errors='replace')
    if not glbs:
        raise PieceFailed('no GLB among the inputs')
    if not isinstance(meta, dict):
        raise PieceFailed('no piece.json among the inputs')
    return sorted(glbs), meta, report


def _skill(path: str) -> Path:
    return config.SKILLS / 'skills' / path


def _as_list(v) -> list[str]:
    return [str(x) for x in v] if isinstance(v, list) else []


def _fit(text: str, limit: int) -> str:
    """What the Builder accepts: at most `limit` characters, no ':'."""
    text = ' '.join(str(text).replace(':', ' -').split())
    return text if len(text) <= limit else text[:limit - 1].rstrip() + '…'


def _check_levels(report: str) -> bool:
    """A skills checker's report passes when no line is a FAIL."""
    return not any(l.split()[:1] == ['FAIL'] for l in report.splitlines() if l.startswith('  '))


# Blender's own log lines (`04:00:43 | INFO: glTF import finished`), which bury a check's output
BLENDER_NOISE = re.compile(r'^\d\d:\d\d:\d\d \| (INFO|DEBUG|WARNING):')


def _clip(text: str) -> str:
    lines = [l for l in text.strip().splitlines() if not BLENDER_NOISE.match(l)]
    return '\n'.join(lines[:REPORT_LINES] + ([f'… ({len(lines) - REPORT_LINES} more lines)'] if len(lines) > REPORT_LINES else []))


def _package(job, piece, kind, design_name, client, render_fn, tools: Tools, work: Path):
    inputs = work / 'in'
    inputs.mkdir(exist_ok=True)
    glbs, meta, checker_report = _inputs(job['jobId'], piece, client, inputs)
    category, emote = piece['category'], kind == 'emote'
    name = str(meta.get('name') or piece.get('name') or category)
    hides, replaces, tags = _as_list(meta.get('hides')), _as_list(meta.get('replaces')), _as_list(meta.get('tags'))
    description = str(meta.get('description') or '')
    rarity = meta.get('rarity') if meta.get('rarity') in RARITIES else 'epic'
    shaped = glbs_by_shape(Piece(category=category, glbs=glbs, meta=meta, changed=True, checker={}))
    shapes = [s for s in SHAPES if s in shaped] or list(SHAPES)
    render_pieces = [{'category': category, 'glbs': shaped, 'meta': meta}]
    out = work / 'package'
    out.mkdir(exist_ok=True)
    for g in glbs:
        shutil.copy(g, out / g.name)
    sections = []

    # Thumbnail: a wearable alone, rendered in Blender; an emote, the avatar halfway through it
    thumb = out / 'thumbnail.png'
    if emote:
        r = render_fn(render_pieces, {'mode': 'thumbnail', 'bodyShape': 'male', 'outfit': 'default', 'emote': None},
                      work / 'thumb', size=512)
        if not r['ok']:
            raise PieceFailed(f"thumbnail render failed: {r['error']}")
        shutil.copy(r['frames'][0], thumb)
    else:
        # Rendered large, then cropped to what rendered: an invisible stray object can't shrink the item in the frame
        large = work / 'thumbnail-large.png'
        ok, log = tools.blender(['-b', '--factory-startup', '--python', THUMBNAIL_BLEND, '--', '--glb',
                                 shaped.get('male') or glbs[0], '--out', large, '--size', '1024'], 300)
        if not ok or not large.exists():
            raise PieceFailed(f'thumbnail failed: {log.strip()[-300:]}')
        fit_square(Image.open(large).convert('RGBA')).save(thumb)
    thumb_ok, thumb_log = tools.python(_skill('curating-dcl-wearables/scripts/check_thumbnail.py'), [thumb], 60)

    checker_ok = _check_levels(checker_report)
    sections.append((f"{'Emote' if emote else 'Wearable'} checker", checker_ok, checker_report or '(no report)'))
    sections.append(('Thumbnail', thumb_ok, thumb_log))
    summary = {'thumbnail': {'pass': thumb_ok}, 'listing': None, 'clipping': None,
               'emoteCheck': {'pass': checker_ok} if emote else None}

    builder = {'name': name, 'category': category, 'hides': hides, 'replaces': replaces, 'tags': tags}
    (out / 'builder.json').write_text(json.dumps(builder, indent=1))

    if not emote:
        listing = {'name': name, 'rarity': rarity, 'description': description, 'tags': tags}
        (out / 'listing.json').write_text(json.dumps(listing, indent=1))
        sheet = work / 'listing-check.json'
        sheet.write_text(json.dumps({'collection': design_name or name, 'items': [{
            'file': category, 'name': name, 'category': category, 'rarity': rarity, 'description': description,
            'utility': '', 'tags': tags, 'hides': hides, 'price': None, 'giveaways': 0, 'event_tag': None}]}))
        listing_ok, listing_log = tools.python(_skill('listing-dcl-wearables/scripts/check_listing.py'), [sheet], 60)
        sections.append(('Listing', listing_ok, listing_log))
        summary['listing'] = {'pass': listing_ok}

        failing: dict[str, list[str]] = {}  # clip -> the body shapes it fails on
        unfinished, logs = [], []
        for shape in SHAPES:
            glb = shaped.get(shape) or shaped.get('unisex')
            if not glb:
                continue
            report_json = work / f'clip_{shape}.json'
            ok, log = tools.blender([config.ASSETS / AVATARS[shape], '-b', '--python',
                                     _skill('curating-dcl-wearables/scripts/check_clipping.py'), '--', '--glb', glb,
                                     '--category', category, '--hides', ','.join(hides), '--anims', config.ANIMATIONS,
                                     '--json', report_json], 900)
            try:
                clips = json.loads(report_json.read_text()).get('clips') or {}
            except (OSError, json.JSONDecodeError, AttributeError):
                clips = {}
            for clip, v in clips.items():
                if isinstance(v, dict) and v.get('status') == 'FAIL':
                    failing.setdefault(clip, []).append(shape)
            if not ok and not clips:
                unfinished.append(shape)
            logs.append(f'{shape} body:\n{log.strip()}')
        failed = list(failing) + [f'check did not finish ({s})' for s in unfinished]
        clip_ok = not failed
        head = ''.join(f'FAIL {clip}: {", ".join(on)} body\n' for clip, on in failing.items())
        sections.append(("Clipping through Decentraland's animations", clip_ok, head + '\n'.join(logs)))
        summary['clipping'] = {'pass': clip_ok, 'failed': failed}

        args = [out / 'item.zip', '--name', _fit(name, BUILDER_NAME_MAX), '--category', category, '--rarity', rarity,
                '--thumbnail', thumb, '--description', _fit(description, BUILDER_DESCRIPTION_MAX),
                '--hides', ','.join(hides), '--replaces', ','.join(replaces), '--tags', ','.join(tags)]
        for shape, glb in shaped.items():
            args += [f'--{shape}', glb]
        ok, log = tools.python(_skill('curating-dcl-wearables/scripts/package_item.py'), args, 120)
        if not ok or not (out / 'item.zip').exists():
            raise PieceFailed(f'item.zip failed: {log.strip()[-300:]}')

    # Renders in Decentraland's own renderer, and the promo clip
    renders = out / 'renders'
    renders.mkdir(exist_ok=True)
    for shape in shapes:
        r = render_fn(render_pieces, {'mode': 'look', 'bodyShape': shape, 'outfit': 'default', 'emote': None},
                      work / 'look' / shape, size=RENDER_SIZE)
        if not r['ok']:
            raise PieceFailed(f"renders failed: {r['error']}")
        for frame in r['frames']:
            shutil.copy(frame, renders / Path(frame).name)
    promo_view = {'mode': 'emote' if emote else 'spin', 'bodyShape': shapes[0], 'outfit': 'default',
                  'emote': None if emote else 'dance'}
    r = render_fn(render_pieces, promo_view, work / 'promo', frames=PROMO_FRAMES, size=PROMO_SIZE)
    if not r['ok']:
        raise PieceFailed(f"promo render failed: {r['error']}")
    promo = out / 'promo.mp4'
    ok, log = tools.ffmpeg(['-y', '-loglevel', 'error', '-framerate', str(PROMO_FPS), '-i', work / 'promo' / '%03d.webp',
                            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', promo], 300)
    if not ok or not promo.exists():
        raise PieceFailed(f'promo clip failed: {log.strip()[-300:]}')

    (out / 'REPORT.md').write_text(_report(name, category, emote, sections))
    zipped = work / 'package.zip'
    with zipfile.ZipFile(zipped, 'w', zipfile.ZIP_DEFLATED) as z:
        for f in sorted(out.rglob('*')):
            if f.is_file():
                z.write(f, f.relative_to(out).as_posix())
    return summary, zipped


RARITIES = ('common', 'uncommon', 'rare', 'epic', 'legendary', 'exotic', 'mythic', 'unique')

NOT_RUN = """## Not run here

The studio can't run these. Do them yourself before you submit:

- **Builder upload:** upload `item.zip` in the Decentraland Builder (Collections, New item, upload the zip).
- **Builder preview:** check the item on the Builder's own avatar preview, on both body shapes.
- **In-world self-preview:** wear it in the Decentraland desktop explorer (the Builder's "See in world") and walk,
  run and emote.
- **Official validator:** run Decentraland's `wearable-validator validate item.zip`.
"""

NOT_RUN_EMOTE = """## Not run here

The studio can't run these. Do them yourself before you submit:

- **Builder upload:** upload the GLB and `thumbnail.png` in the Decentraland Builder as a new emote.
- **Builder preview:** play it on the Builder's own avatar preview, on both body shapes.
- **In-world self-preview:** play it in the Decentraland desktop explorer (the Builder's "See in world").
- **Official validator:** run Decentraland's `wearable-validator` on the uploaded emote.
"""


def _report(name: str, category: str, emote: bool, sections: list[tuple[str, bool, str]]) -> str:
    lines = [f'# {name}: curation report', '', f'Category: `{category}`', '',
             '| Check | Result |', '|---|---|']
    lines += [f'| {title} | {"PASS" if ok else "FAIL"} |' for title, ok, _ in sections]
    for title, ok, log in sections:
        lines += ['', f'## {title}: {"PASS" if ok else "FAIL"}', '', '```', _clip(log) or '(no output)', '```']
    return '\n'.join(lines) + '\n\n' + (NOT_RUN_EMOTE if emote else NOT_RUN)
