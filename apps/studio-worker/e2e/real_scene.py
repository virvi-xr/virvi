#!/usr/bin/env python3
"""Runs the worker against a real agent on a scene design: a small walk-in kiosk and a stool, then the Inspect sphere,
the walk-through and a finalize of both pieces, with tests/fake_api.py standing in for Virvi's API. Spends about $1-3.

    python3 /opt/e2e/real_scene.py --agent codex [--out /out]

Prints each job's progress and result, small thumbnails of chosen frames as `FRAME <name> <base64 webp>` lines, checks
them, and exits non-zero if a check fails.
"""
import argparse
import base64
import io
import json
import re
import secrets
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tests'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import fake_api  # noqa: E402
from real_prompt import MODELS, fresh_design  # noqa: E402
from studio_worker import jobs  # noqa: E402
from studio_worker.scene_render import nothing_drawn  # noqa: E402

BRIEF = ('A small cosy kiosk that fits a 0.5x0.5 parcel footprint, that visitors can walk into through an open doorway, '
         'with one bar stool inside people can sit on. Keep it simple and low-poly.')
LIMITS = {'timeoutSec': 2700, 'maxTurns': 150, 'costCeilingUsd': 6.0}


def thumb(name: str, data: bytes) -> None:
    image = Image.open(io.BytesIO(data)).convert('RGB')
    image.thumbnail((192, 192))
    buf = io.BytesIO()
    image.save(buf, 'WEBP', quality=70)
    print(f'FRAME {name} {base64.b64encode(buf.getvalue()).decode()}', flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--agent', default='codex', choices=list(MODELS))
    ap.add_argument('--out', type=Path, default=Path('/out'))
    a = ap.parse_args()
    failures = []

    def expect(ok: bool, what: str):
        print(('OK   ' if ok else 'FAIL ') + what, flush=True)
        if not ok:
            failures.append(what)

    def frames_of(prefix: str) -> list[str]:
        return sorted(k for k in api.files if k.startswith(prefix))

    def drawn(keys: list[str]) -> int:
        return sum(not nothing_drawn(Image.open(io.BytesIO(api.files[k]))) for k in keys)

    fresh_design()
    token = secrets.token_urlsafe(24)
    with fake_api.serve(token=token, design='real-design') as api:
        api.on_event = lambda job, e: print(f"  [{job}] {e.get('phase') or e.get('text')}", flush=True)
        env = {'VIRVI_API_URL': api.url, 'STUDIO_WORKER_TOKEN': token, 'STUDIO_DESIGN_ID': 'real-design',
               'STUDIO_IDLE_EXIT_SEC': '3'}

        def run(job: dict) -> dict:
            api.jobs.append({'agent': None, 'model': None, 'prompt': None, 'selectedSlots': None, 'limits': None,
                             'render': None, 'kind': 'scene', **job})
            print(f"--- {job['jobId']}", flush=True)
            jobs.main({**env})
            r = api.results[-1]
            print(json.dumps({k: r.get(k) for k in ('outcome', 'costUsd', 'wallSec', 'error', 'set', 'warnings')}), flush=True)
            return r

        r = run({'jobId': 'build', 'type': 'prompt', 'agent': a.agent, 'model': MODELS[a.agent], 'prompt': BRIEF, 'limits': LIMITS})
        print('  reply:', (r.get('reply') or '')[:500], flush=True)
        pieces = {p['category']: p for p in r['pieces']}
        building = pieces.get('building')
        furniture = [p for c, p in pieces.items() if re.fullmatch(r'furniture_[a-z_]+', c)]
        expect(r['outcome'] == 'ok', 'the build ended ok')
        expect(bool(building and building['checker']['pass']), 'the building passes its checks (model and walk)')
        expect(bool(furniture) and all(p['checker']['pass'] for p in furniture), 'the furniture passes its checks')
        for p in pieces.values():
            ring = frames_of(f"build/renders/{p['category']}/orbit-scene/")
            expect(len(ring) == 24 and drawn(ring) == 24, f"{p['category']}: 24 drawn Inspect frames ({len(ring)}, {drawn(ring)} drawn)")
            for i in (0, 6, 12, 18):
                if i < len(ring):
                    thumb(f"{p['category']}-orbit-{i:03d}", api.files[ring[i]])
        for p in furniture:
            scale = frames_of(f"build/renders/{p['category']}/scale/")
            expect(len(scale) == 36 and drawn(scale) == 36, f"{p['category']}: 36 drawn scale frames ({len(scale)})")
            if scale:
                thumb(f"{p['category']}-scale-000", api.files[scale[0]])
        if building:
            print('  building checker report:\n' + (api.files.get('build/checks/building.txt') or b'').decode()[:3000], flush=True)

        r = run({'jobId': 'sphere', 'type': 'render', 'render': {'categories': ['building'], 'mode': 'orbit', 'ring': False}})
        sphere = frames_of('sphere/renders/building/orbit-scene/')
        expect(r['outcome'] == 'ok' and len(sphere) == 122 and drawn(sphere) == 122, f'the whole sphere ({len(sphere)})')
        for i in (48, 96, 120, 121):
            if i < len(sphere):
                thumb(f'building-orbit-{i:03d}', api.files[sphere[i]])

        r = run({'jobId': 'tour', 'type': 'render', 'render': {'set': True, 'tour': True}})
        tour = frames_of('tour/renders/set/tour/')
        expect(r['outcome'] == 'ok' and (r.get('set') or {}).get('fps') == 24.0 and len(tour) >= 96,
               f"the walk-through ({len(tour)} frames at {(r.get('set') or {}).get('fps')} fps)")
        expect(drawn(tour) == len(tour), f'every walk-through frame drawn ({drawn(tour)}/{len(tour)})')
        for i in range(8):
            if tour:
                thumb(f'tour-{i}', api.files[tour[int(i * (len(tour) - 1) / 7)]])

        # Finalize both pieces from the files the build uploaded, as Virvi hands them back
        spec = []
        for p in pieces.values():
            for f in p['files']:
                api.inputs[f'final/{f}'] = api.files[f'build/{f}']
            spec.append({'category': p['category'], 'name': p['meta'].get('name') or p['category'], 'revision': 1,
                         'files': p['files'], 'sourceJobId': 'build'})
        r = run({'jobId': 'final', 'type': 'finalize', 'finalize': {'designName': 'Kiosk', 'pieces': spec},
                 'limits': {'timeoutSec': 1800, 'maxTurns': 0, 'costCeilingUsd': 0}})
        expect(r['outcome'] == 'ok', 'finalize ended ok')
        for p in pieces.values():
            c = p['category']
            expect(f'final/final/{c}/package.zip' in api.files and f'final/final/{c}/thumbnail.png' in api.files,
                   f'{c}: package and thumbnail')
            if f'final/final/{c}/thumbnail.png' in api.files:
                thumb(f'{c}-thumbnail', api.files[f'final/final/{c}/thumbnail.png'])

        out = a.out / 'scene'
        out.mkdir(parents=True, exist_ok=True)
        for key, data in api.files.items():
            if key.startswith('build/pieces/') or key.startswith('final/final/'):
                dest = out / key.replace('/', '__')
                dest.write_bytes(data)
    print('PASSED' if not failures else f'FAILED: {failures}', flush=True)
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main())
