"""The worker's job loop: restore the design's workspace, take jobs from Virvi's API until it has been idle for
STUDIO_IDLE_EXIT_SEC, then exit so the machine stops. See CONTRACT.md for the API.

A prompt job runs the agent, checks and renders what changed, uploads it, saves the workspace, and only then posts
its result. A render job renders a view of the workspace's current pieces (one piece's, or every piece worn together
for an emote view) and saves nothing. A finalize job builds
paid packages from Virvi's copies of the paid files (finalize.py) and saves nothing either.
"""
import copy
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import time
import traceback
from dataclasses import asdict
from pathlib import Path
from typing import Callable, Mapping

from . import render as renderer
from . import scope
from .agent import Usage, run_agent
from .api import Api, ApiError
from .config import AGENT_USER, DESIGN, skills_sha
from .finalize import Tools, finalize_job
from .instructions import closing, uploads_text
from .pieces import Piece, collect, glbs_by_shape, glbs_outside, new_hashes, read_declined
from .workspace import load_state, pack, prompt_with_context, save_state, state_dir, unpack

IDLE_EXIT_SEC = 600
POLL_SEC = 2.0
DEFAULT_LIMITS = {'timeoutSec': 1500, 'maxTurns': 80, 'costCeilingUsd': 3.0}


def run_job(job: dict, client: Api, design: Path, render_fn: Callable = renderer.render,
            command: list[str] | None = None, as_user: str | None = AGENT_USER, tools: Tools | None = None,
            checker: Callable | None = None) -> dict:
    """Runs one job and posts its Result, which it also returns."""
    start = time.monotonic()
    result = {'jobId': job['jobId'], 'outcome': 'error', 'agent': job.get('agent'), 'model': job.get('model'),
              'skillsSha': skills_sha(), 'wallSec': None, 'tokens': None, 'costUsd': None, 'reply': '',
              'proposal': None, 'pieces': [], 'error': None, 'scope': None}
    try:
        if job.get('type') == 'render':
            _render_job(job, client, Path(design), render_fn, result)
        elif job.get('type') == 'finalize':
            with tempfile.TemporaryDirectory(prefix='studio-final-') as stage:
                finalize_job(job, client, render_fn, tools or Tools.real(), result, Path(stage))
        else:
            _prompt_job(job, client, Path(design), render_fn, command, as_user, result, checker or scope.check)
    except Exception as e:  # the result still goes out, so the design isn't left waiting
        result.update(outcome='error', error=f'worker: {type(e).__name__}: {e}')
        traceback.print_exc(file=sys.stderr)
    result['wallSec'] = round(time.monotonic() - start, 1)
    client.post_result(job['jobId'], result)
    return result


UPLOAD_NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,80}')


def fetch_uploads(job, client, design: Path) -> list[dict]:
    """The owner's uploads the job lists, written fresh into design/uploads/ (what was there before goes, so a
    deleted upload leaves and nothing the agent left in the folder is followed). Returns the ones written."""
    folder = Path(design) / 'uploads'
    if os.path.lexists(folder):
        if folder.is_symlink() or not folder.is_dir():
            os.unlink(folder)
        else:
            shutil.rmtree(folder)
    got = []
    for u in job.get('uploads') or []:
        name = u.get('name') or ''
        if not UPLOAD_NAME.fullmatch(name) or '..' in name:
            print(f'[worker] skipped an upload with an odd name: {name!r}', file=sys.stderr)
            continue
        try:
            data = client.get_input(job['jobId'], u['path'])
        except ApiError as e:
            print(f'[worker] could not read upload {name}: {e}', file=sys.stderr)
            continue
        folder.mkdir(exist_ok=True)
        fd = os.open(folder / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        got.append(u)
    return got


def _prompt_job(job, client, design, render_fn, command, as_user, result, checker):
    job_id, agent, kind = job['jobId'], job['agent'], job.get('kind', 'wearable')
    state_path = state_dir(design)
    state = load_state(state_path)
    check_cost = None
    if job.get('check'):  # only the user's own words are checked; the server's (Continue, fix the checks) never are
        v = checker(job['prompt'], kind, state.messages, [u.get('name') or '' for u in job.get('uploads') or []])
        check_cost = v.cost_usd
        if v.verdict == 'off_topic':  # the agent never runs, and nothing about the design changes
            result.update(outcome='off_topic', costUsd=v.cost_usd,
                          scope={'by': 'check', 'category': v.category, 'note': v.note})
            return
    fix = job.get('fixClipping')
    if fix:  # the agent starts from frames of the clipping, before it changes anything
        frames_error = _clipping_frames(design, kind, fix, render_fn, as_user)
        if frames_error:
            result['error'] = f'could not render the clipping frames: {frames_error}'
            return
    saved = copy.deepcopy(state)
    for answered in ('proposal.json', 'declined.json'):  # an earlier prompt's; don't read it as this one's
        if os.path.lexists(design / 'out' / answered):
            os.unlink(design / 'out' / answered)
    totals = state.totals.get(agent)
    before = Usage(**totals) if totals else None
    uploads = fetch_uploads(job, client, design)
    words = job['prompt'] + (_clipping_text(design, kind, agent, fix) if fix else '')
    prompt = prompt_with_context(state, agent, words) + uploads_text(uploads) + closing(kind, job.get('selectedSlots'))
    limits = {**DEFAULT_LIMITS, **{k: v for k, v in (job.get('limits') or {}).items() if v is not None}}

    _phase(client, job_id, 'building')
    started = time.time()
    run = run_agent(agent, job['model'], prompt, state.sessions.get(agent), before, limits,
                    lambda text: _send(client, job_id, {'type': 'progress', 'text': text}),
                    command=command, as_user=as_user, cwd=design)
    usage = run.usage
    cost = None if run.cost_usd is None and check_cost is None else round((run.cost_usd or 0) + (check_cost or 0), 6)
    result.update(reply=run.reply, costUsd=cost, tokens=usage and {
        'input': usage.input, 'cachedInput': usage.cached_input, 'cacheWrite': usage.cache_write,
        'output': usage.output})

    _phase(client, job_id, 'checking')
    with tempfile.TemporaryDirectory(prefix='studio-stage-') as stage:
        pieces, proposal, error = collect(design, kind, state.hashes, stage=Path(stage)) \
            if run.outcome == 'ok' else ([], None, None)
        changed = [p for p in pieces if p.changed]
        declined = read_declined(design) if run.outcome == 'ok' and not changed and not proposal else None
        if run.outcome == 'ok' and not error and not changed and not proposal:
            elsewhere = glbs_outside(design, started)
            if elsewhere:
                error = 'GLBs exported outside out/<category>/: ' + ', '.join(
                    g.relative_to(design).as_posix() for g in elsewhere)
        renders, render_errors, uploaded = {}, [], set()
        if changed and not proposal and not error:
            _phase(client, job_id, 'rendering')
            for p in changed:
                counts, problem = {}, None
                for view in _prompt_views(kind):
                    count, problem = _render_and_upload(client, job_id, p, view, render_fn)
                    if problem:
                        break
                    counts.update(count)
                if problem:  # not uploaded and not recorded: the next prompt sees it as changed and tries again
                    render_errors.append(f'{p.category}: {problem}')
                    continue
                _upload_piece(client, job_id, p)
                renders[p.category] = counts
                uploaded.add(p.category)

        _phase(client, job_id, 'saving')
        state.messages += [{'role': 'user', 'agent': agent, 'text': job['prompt']}]
        if run.reply:
            state.messages += [{'role': 'agent', 'agent': agent, 'text': run.reply}]
        if run.session:
            state.sessions[agent] = run.session
        if run.session_total:
            state.totals[agent] = asdict(run.session_total)
        state.last_agent = agent
        # only what reached Virvi counts as the design's current pieces
        state.hashes.update({c: h for c, h in new_hashes(pieces).items() if c in uploaded})
        save_state(state_path, state)
        try:
            client.put_workspace(pack(design, state_path))
        except ApiError as e:  # nothing may claim this revision is saved, here or in the next prompt
            save_state(state_path, saved)
            result.update(outcome='error', error=f'workspace save failed: {e}')
            return

        result['proposal'] = proposal
        result['pieces'] = [_piece_result(p, renders.get(p.category), p.category in uploaded) for p in pieces]
    if run.outcome != 'ok':
        result.update(outcome=run.outcome, error=run.error)
    elif error:
        result.update(outcome='error', error=error)
    elif declined is not None:  # the agent stopped on a request that isn't design work
        result.update(outcome='declined', scope={'by': 'agent', 'category': 'other', 'note': declined})
    elif proposal:
        result['outcome'] = 'needs_input'
    elif render_errors:
        result.update(outcome='error', error='render failed: ' + '; '.join(render_errors))
    else:
        result['outcome'] = 'ok' if uploaded else 'no_change'


def _prompt_views(kind: str) -> list[dict]:
    """What a prompt renders for each changed piece: the on-avatar spin, and for a wearable the Inspect ring (the rest
    of the sphere is a render job Virvi queues behind it)."""
    if kind == 'emote':
        return [{'bodyShape': 'male', 'outfit': 'default', 'emote': None, 'mode': 'emote'}]
    return [{'bodyShape': 'male', 'outfit': 'default', 'emote': None, 'mode': 'spin'},
            {'bodyShape': 'male', 'outfit': 'default', 'emote': None, 'mode': 'orbit', 'ring': True}]


def _worn(pieces: list[Piece]) -> list[dict]:
    return [{'category': p.category, 'glbs': glbs_by_shape(p), 'meta': p.meta} for p in pieces]


def _clipping_frames(design, kind, fix, render_fn, as_user) -> str | None:
    """Writes 16 frames of the reported emote, every piece worn, to review/clipping/<emote>/. Returns an error."""
    out = design / 'review' / 'clipping' / fix['emote']
    if out.exists():
        shutil.rmtree(out)
    with tempfile.TemporaryDirectory(prefix='studio-stage-') as stage:
        pieces, _, error = collect(design, kind, {}, run_checker=False, stage=Path(stage))
        if error or not pieces:
            return error or 'the design has no pieces'
        r = render_fn(_worn(pieces), {'bodyShape': fix['bodyShape'], 'outfit': fix['outfit'],
                                      'emote': fix['emote'], 'mode': 'walk', 'sample': renderer.EMOTE_SAMPLE}, out)
    if not r['ok']:
        return r['error']
    if as_user:
        import subprocess
        subprocess.run(['chown', '-R', as_user, str(design / 'review')], check=False)
    return None


def _clipping_text(design, kind, agent, fix) -> str:
    folders = ' '.join(f'out/{d.name}' for d in sorted((design / 'out').iterdir()) if d.is_dir() and
                       (d / 'piece.json').exists()) if (design / 'out').is_dir() else 'out/<category>'
    opener = 'open every one with read_file' if agent == 'grok' else 'open every one'
    return (f"\nFrames of the clipping are in review/clipping/{fix['emote']}/: {opener} before you change anything, "
            f"and after your fix run studio-preview {folders} --emote {fix['emote']} --body {fix['bodyShape']} "
            f"--outfit {fix['outfit']} and open those frames to check it.")


def _render_job(job, client, design, render_fn, result):
    spec, kind = job['render'], job.get('kind', 'wearable')
    with tempfile.TemporaryDirectory(prefix='studio-stage-') as stage:
        pieces, _, error = collect(design, kind, {}, run_checker=False, stage=Path(stage))
        if error:
            result['error'] = error
            return
        if spec.get('set'):
            _set_render(job, client, pieces, spec, render_fn, result)
            return
        wanted = {p.category: p for p in pieces}
        missing = [c for c in spec['categories'] if c not in wanted]
        if missing:
            result['error'] = f'no piece for {", ".join(missing)}'
            return
        view = {'bodyShape': spec.get('bodyShape') or 'male', 'outfit': spec.get('outfit') or 'default',
                'emote': spec.get('emote'), 'mode': 'emote' if kind == 'emote' else 'spin'}
        if spec.get('mode') == 'orbit' and kind != 'emote':
            view = {**view, 'outfit': 'default', 'emote': None, 'mode': 'orbit', 'ring': bool(spec.get('ring'))}
        _phase(client, job['jobId'], 'rendering')
        problems = []
        for category in spec['categories']:
            count, problem = _render_and_upload(client, job['jobId'], wanted[category], view, render_fn)
            result['pieces'].append({'category': category, 'renders': count})
            if problem:
                problems.append(f'{category}: {problem}')
    result.update(outcome='error' if problems else 'ok', error='; '.join(problems) or None)


def _set_render(job, client, pieces, spec, render_fn, result):
    """Every piece worn together, walking round once through the emote: renders/set/<viewKey>/."""
    if not pieces:
        result['error'] = 'the design has no pieces'
        return
    view = {'bodyShape': spec.get('bodyShape') or 'male', 'outfit': spec.get('outfit') or 'default',
            'emote': spec.get('emote') or 'own', 'mode': 'walk'}
    key = view_key(view)
    _phase(client, job['jobId'], 'rendering')
    with tempfile.TemporaryDirectory() as tmp:
        r = render_fn(_worn(pieces), view, Path(tmp) / key)
        if not r['ok']:
            result['error'] = r['error']
            return
        for i, frame in enumerate(r['frames']):
            client.put_file(job['jobId'], f'renders/set/{key}/{i:03d}{frame.suffix}', frame.read_bytes(),
                            mimetypes.guess_type(frame.name)[0] or 'image/webp')
    result.update(outcome='ok', set={'viewKey': key, 'frames': len(r['frames']), 'fps': r.get('fps')})


def view_key(view: dict) -> str:
    if view['mode'] == 'orbit':
        return f"orbit-{view['bodyShape']}"
    return '-'.join([view['mode'], view['bodyShape'], view['outfit']] + ([view['emote']] if view.get('emote') else []))


def _render_and_upload(client, job_id, piece: Piece, view, render_fn) -> tuple[dict, str | None]:
    """Renders one piece's view and uploads its frames: ({view key: frames}, error)."""
    key = view_key(view)
    with tempfile.TemporaryDirectory() as tmp:
        r = render_fn([{'category': piece.category, 'glbs': glbs_by_shape(piece), 'meta': piece.meta}], view,
                      Path(tmp) / key)
        if not r['ok']:
            return {key: 0}, r['error']
        for i, frame in enumerate(r['frames']):
            client.put_file(job_id, f'renders/{piece.category}/{key}/{i:03d}{frame.suffix}', frame.read_bytes(),
                            mimetypes.guess_type(frame.name)[0] or 'image/webp')
    return {key: len(r['frames'])}, None


def _upload_piece(client, job_id, piece: Piece) -> None:
    for f in piece.glbs + [piece.glbs[0].parent / 'piece.json']:
        client.put_file(job_id, f'pieces/{piece.category}/{f.name}', f.read_bytes(),
                        'model/gltf-binary' if f.suffix == '.glb' else 'application/json')
    client.put_file(job_id, f'checks/{piece.category}.txt', piece.checker.get('report', '').encode(), 'text/plain')


def _piece_result(p: Piece, renders: dict | None, uploaded: bool) -> dict:
    files = [f'pieces/{p.category}/{f.name}' for f in p.glbs] + [f'pieces/{p.category}/piece.json',
                                                                 f'checks/{p.category}.txt']
    return {'category': p.category, 'changed': p.changed, 'changeKind': p.meta.get('changeKind'), 'meta': p.meta,
            'checker': {k: p.checker.get(k) for k in ('pass', 'failures', 'warnings')},
            'files': files if uploaded else [], 'renders': renders or {}}


def _phase(client, job_id, phase):
    _send(client, job_id, {'type': 'phase', 'phase': phase})


def _send(client, job_id, event):
    """Progress is best effort: a dropped event never fails the job."""
    try:
        client.event(job_id, event)
    except ApiError as e:
        print(f'event not sent: {e}', file=sys.stderr)


def main(env: Mapping[str, str] | None = None, design: Path | None = None, poll_sec: float = POLL_SEC,
         **run_kwargs) -> int:
    env = os.environ if env is None else env
    design = Path(design or DESIGN)
    client = Api(env['VIRVI_API_URL'], env['STUDIO_WORKER_TOKEN'], env['STUDIO_DESIGN_ID'])
    idle_exit = float(env.get('STUDIO_IDLE_EXIT_SEC', IDLE_EXIT_SEC))
    data = client.get_workspace()
    if data:
        unpack(data, design, state_dir(design))
    design.mkdir(parents=True, exist_ok=True)
    print(f'studio worker: design {client.design}, workspace {"restored" if data else "new"}', file=sys.stderr)
    idle_since = time.monotonic()
    while True:
        try:
            job = client.next_job()
        except ApiError as e:
            print(f'polling failed: {e}', file=sys.stderr)
            job = None
        if job:
            print(f"job {job['jobId']} ({job.get('type')}) started", file=sys.stderr)
            try:
                result = run_job(job, client, design, **run_kwargs)
            except ApiError as e:  # the result itself couldn't be posted; the API times the job out
                print(f"job {job['jobId']}: result not posted: {e}", file=sys.stderr)
                idle_since = time.monotonic()
                continue
            print(f"job {job['jobId']} -> {result['outcome']}" + (f": {result['error']}" if result['error'] else ''),
                  file=sys.stderr)
            idle_since = time.monotonic()
            continue
        if time.monotonic() - idle_since >= idle_exit:
            print(f'idle for {idle_exit:.0f}s, exiting', file=sys.stderr)
            return 0
        time.sleep(poll_sec)
