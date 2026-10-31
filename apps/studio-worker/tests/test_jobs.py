import io
import sys
from pathlib import Path

import pytest
from PIL import Image

import fake_api
from conftest import FIXTURES
from studio_worker import jobs, scope
from studio_worker.api import Api
from studio_worker.workspace import State, pack, save_state

FAKES = Path(__file__).parent / 'fakes'
TOKEN = 'tok-3b1f-secret'
LIMITS = {'timeoutSec': 30, 'maxTurns': 80, 'costCeilingUsd': 3.0}


def prompt_job(**kw):
    return {'jobId': 'job-1', 'type': 'prompt', 'kind': 'wearable', 'agent': 'claude', 'model': 'claude-opus-5-5',
            'prompt': 'a neon cap', 'selectedSlots': ['hat'], 'limits': LIMITS, 'render': None, **kw}


def fake_command(fixture):
    return [sys.executable, str(FAKES / 'replay.py'), str(FAKES / fixture)]


def fake_render(calls):
    def render(pieces, view, out, frames=36, size=512, watchdog_sec=300):
        calls.append((pieces, view))
        out.mkdir(parents=True, exist_ok=True)
        paths = []
        for i in range(frames):
            paths.append(out / f'{i:03d}.webp')
            Image.new('RGB', (8, 8), (i, 0, 0)).save(paths[-1], 'WEBP')
        return {'ok': True, 'frames': paths, 'error': None, 'bootSec': 1.0}
    return render


@pytest.fixture
def api():
    with fake_api.serve(token=TOKEN, design='design-1') as server:
        yield server


def client(api):
    return Api(api.url, TOKEN, 'design-1', backoff=0.01)


def run(api, tmp_path, job, fixture, renders=None):
    return jobs.run_job(job, client(api), tmp_path, render_fn=fake_render(renders if renders is not None else []),
                        command=fake_command(fixture), as_user=None)


def test_prompt_job_end_to_end(api, tmp_path, skills):
    result = run(api, tmp_path, prompt_job(), 'claude_builds_hat.jsonl')
    assert result['outcome'] == 'ok', result
    assert api.phases('job-1') == ['building', 'checking', 'rendering', 'saving']
    assert ('job-1', {'type': 'progress', 'text': 'Built a neon cap with a glowing visor.'}) in api.events
    assert {'job-1/pieces/hat/neon_cap_male.glb', 'job-1/pieces/hat/neon_cap_female.glb',
            'job-1/pieces/hat/piece.json', 'job-1/checks/hat.txt'} <= set(api.files)
    assert len([f for f in api.files if f.startswith('job-1/renders/hat/spin-male-default/')]) == 36
    assert api.workspace is not None
    assert [c for c in api.calls if c[0] != 'GET'][-2:] == [('PUT', '/api/studio/worker/designs/design-1/workspace'),
                                                             ('POST', '/api/studio/worker/jobs/job-1/result')]
    posted = api.results[-1]
    assert posted == result and len(api.results) == 1
    hat = posted['pieces'][0]
    assert hat['category'] == 'hat' and hat['changed'] is True and hat['checker']['pass'] is True
    assert hat['changeKind'] == 'new' and hat['renders'] == {'spin-male-default': 36}
    assert posted['costUsd'] == pytest.approx(0.0125) and posted['reply'] == 'Built a neon cap with a glowing visor.'


def test_tweak_with_no_export_is_no_change(api, tmp_path, skills):
    run(api, tmp_path, prompt_job(), 'claude_builds_hat.jsonl')
    result = run(api, tmp_path, prompt_job(jobId='job-2', prompt='make it pinker'), 'claude_stream.jsonl')
    assert result['outcome'] == 'no_change'
    assert result['pieces'][0]['changed'] is False and result['pieces'][0]['files'] == []
    assert not [f for f in api.files if f.startswith('job-2/')]


def test_result_waits_for_workspace_save(api, tmp_path, skills):
    api.fail[('PUT', '/workspace')] = 500
    result = run(api, tmp_path, prompt_job(), 'claude_builds_hat.jsonl')
    assert result['outcome'] == 'error' and 'workspace' in result['error']
    assert [r['outcome'] for r in api.results] == ['error']


def test_proposal_needs_input(api, tmp_path):
    renders = []
    result = run(api, tmp_path, prompt_job(selectedSlots=None), 'claude_proposes.jsonl', renders)
    assert result['outcome'] == 'needs_input'
    assert [s['category'] for s in result['proposal']['slots']] == ['hat', 'eyewear']
    assert renders == [] and result['pieces'] == []


def test_render_job_renders_requested_view(api, tmp_path):
    design = tmp_path / 'design'
    hat = design / 'out/hat'
    hat.mkdir(parents=True)
    for g in (FIXTURES / 'cap').glob('*.glb'):
        (hat / g.name).write_bytes(g.read_bytes())
    (hat / 'piece.json').write_text('{"name": "Neon Cap", "category": "hat"}')
    renders = []
    job = {'jobId': 'job-r', 'type': 'render', 'kind': 'wearable', 'agent': None, 'model': None, 'prompt': None,
           'selectedSlots': None, 'limits': None,
           'render': {'categories': ['hat'], 'bodyShape': 'female', 'outfit': 'outfit-2', 'emote': None}}
    result = jobs.run_job(job, client(api), design, render_fn=fake_render(renders),
                          command=fake_command('hang_with_child.jsonl'), as_user=None)
    assert result['outcome'] == 'ok', result
    assert len([f for f in api.files if f.startswith('job-r/renders/hat/spin-female-outfit-2/')]) == 36
    assert renders[0][1] == {'bodyShape': 'female', 'outfit': 'outfit-2', 'emote': None, 'mode': 'spin'}
    assert not (design / 'child.pid').exists()  # no agent ran
    assert api.workspace is None


def test_idle_exit(api, tmp_path, monkeypatch):
    env = {'VIRVI_API_URL': api.url, 'STUDIO_WORKER_TOKEN': TOKEN, 'STUDIO_DESIGN_ID': 'design-1',
           'STUDIO_IDLE_EXIT_SEC': '1'}
    import time
    start = time.monotonic()
    assert jobs.main(env, design=tmp_path / 'design', poll_sec=0.2) == 0
    assert time.monotonic() - start < 5


def test_workspace_restored_on_start(api, tmp_path):
    src = tmp_path / 'src'
    (src / 'out/hat').mkdir(parents=True)
    (src / 'out/hat/piece.json').write_text('{}')
    save_state(tmp_path / 'src-state', State())
    api.workspace = pack(src, tmp_path / 'src-state')
    env = {'VIRVI_API_URL': api.url, 'STUDIO_WORKER_TOKEN': TOKEN, 'STUDIO_DESIGN_ID': 'design-1',
           'STUDIO_IDLE_EXIT_SEC': '0'}
    assert jobs.main(env, design=tmp_path / 'design', poll_sec=0.1) == 0
    assert (tmp_path / 'design/out/hat/piece.json').exists()


def test_token_never_logged(api, tmp_path, capsys, skills):
    api.jobs.append(prompt_job())
    api.fail[('PUT', '/workspace')] = 500  # the error path too
    env = {'VIRVI_API_URL': api.url, 'STUDIO_WORKER_TOKEN': TOKEN, 'STUDIO_DESIGN_ID': 'design-1',
           'STUDIO_IDLE_EXIT_SEC': '1'}
    assert jobs.main(env, design=tmp_path / 'design', poll_sec=0.2, render_fn=fake_render([]),
                     command=fake_command('claude_builds_hat.jsonl'), as_user=None) == 0
    out = capsys.readouterr()
    assert api.results and 'job-1' in out.err
    assert TOKEN not in out.out + out.err


def failing_render(calls, fail_first=1):
    ok = fake_render(calls)

    def render(pieces, view, out, **kw):
        if len(calls) < fail_first:
            calls.append((pieces, view))
            return {'ok': False, 'frames': [], 'error': 'item_not_loaded', 'bootSec': 1.0}
        return ok(pieces, view, out, **kw)
    return render


def test_failed_save_keeps_the_piece_changed(api, tmp_path, skills):
    api.fail[('PUT', '/workspace')] = 500
    assert run(api, tmp_path, prompt_job(), 'claude_builds_hat.jsonl')['outcome'] == 'error'
    del api.fail[('PUT', '/workspace')]
    result = run(api, tmp_path, prompt_job(jobId='job-2', prompt='try again'), 'claude_stream.jsonl')
    assert result['outcome'] == 'ok' and result['pieces'][0]['changed'] is True
    assert 'job-2/pieces/hat/neon_cap_male.glb' in api.files


def test_failed_render_is_rendered_again(api, tmp_path, skills):
    calls = []
    first = jobs.run_job(prompt_job(), client(api), tmp_path, render_fn=failing_render(calls),
                         command=fake_command('claude_builds_hat.jsonl'), as_user=None)
    assert first['outcome'] == 'error' and 'item_not_loaded' in first['error']
    second = jobs.run_job(prompt_job(jobId='job-2', prompt='again'), client(api), tmp_path,
                          render_fn=failing_render(calls), command=fake_command('claude_stream.jsonl'), as_user=None)
    assert second['outcome'] == 'ok' and second['pieces'][0]['renders'] == {'spin-male-default': 36}


def test_proposal_with_built_pieces_keeps_them_for_later(api, tmp_path, skills):
    renders = []
    result = run(api, tmp_path, prompt_job(selectedSlots=None), 'claude_proposes_and_builds.jsonl', renders)
    assert result['outcome'] == 'needs_input'
    assert all(p['files'] == [] for p in result['pieces']) and not [f for f in api.files if '/pieces/' in f]
    later = run(api, tmp_path, prompt_job(jobId='job-2', prompt='just the hat'), 'claude_stream.jsonl', renders)
    assert later['outcome'] == 'ok' and 'job-2/pieces/hat/piece.json' in api.files


def test_glbs_exported_outside_out_are_an_error(api, tmp_path):
    result = run(api, tmp_path, prompt_job(), 'claude_exports_elsewhere.jsonl')
    assert result['outcome'] == 'error' and 'exports/neon_cap_male.glb' in result['error']


def verdict(v, category=None, note='', cost=0.001):
    calls = []

    def checker(words, kind, history, upload_names):
        calls.append((words, kind, upload_names))
        return scope.Verdict(v, category, note, cost)
    checker.calls = calls
    return checker


def run_checked(api, tmp_path, job, fixture, checker, renders=None):
    return jobs.run_job(job, client(api), tmp_path, render_fn=fake_render(renders if renders is not None else []),
                        command=fake_command(fixture), as_user=None, checker=checker)


def test_off_topic_skips_the_agent(api, tmp_path):
    checker = verdict('off_topic', 'coding', 'python help')
    job = prompt_job(check=True, prompt='reverse a linked list', uploads=[{'path': 'uploads/x/logo.png', 'name': 'logo.png', 'kind': 'image'}])
    result = run_checked(api, tmp_path, job, 'claude_builds_hat.jsonl', checker)
    assert result['outcome'] == 'off_topic'
    assert result['scope'] == {'by': 'check', 'category': 'coding', 'note': 'python help'}
    assert result['costUsd'] == 0.001 and result['pieces'] == []
    assert checker.calls == [('reverse a linked list', 'wearable', ['logo.png'])]
    assert not (tmp_path / 'out').exists() and api.workspace is None  # the agent never ran, nothing was saved


def test_unsure_runs_the_agent(api, tmp_path):
    result = run_checked(api, tmp_path, prompt_job(check=True, selectedSlots=None), 'claude_proposes.jsonl', verdict('unsure'))
    assert result['outcome'] == 'needs_input' and result['scope'] is None


def test_no_check_flag_runs_without_checking(api, tmp_path):
    checker = verdict('off_topic', 'coding')
    result = run_checked(api, tmp_path, prompt_job(selectedSlots=None), 'claude_proposes.jsonl', checker)
    assert result['outcome'] == 'needs_input' and checker.calls == []


def test_agent_decline_is_declined(api, tmp_path):
    (tmp_path / 'out').mkdir()
    (tmp_path / 'out' / 'declined.json').write_text('{"reason": "stale"}')
    result = run_checked(api, tmp_path, prompt_job(check=True, prompt='hm'), 'claude_stream.jsonl', verdict('design'))
    assert result['outcome'] == 'no_change'  # an earlier prompt's decline doesn't count for this one
    result = run_checked(api, tmp_path, prompt_job(jobId='job-2', check=True), 'claude_declines.jsonl', verdict('unsure'))
    assert result['outcome'] == 'declined'
    assert result['scope'] == {'by': 'agent', 'category': 'other', 'note': 'not a design'}
    assert api.workspace is not None  # the agent ran: its session is saved


def test_declined_with_a_changed_piece_is_ok(api, tmp_path, skills):
    result = run_checked(api, tmp_path, prompt_job(check=True), 'claude_declines_but_builds.jsonl', verdict('design'))
    assert result['outcome'] == 'ok' and result['scope'] is None


def test_turns_outcome_collects_no_pieces(api, tmp_path, skills):
    result = run(api, tmp_path, prompt_job(), 'claude_max_turns.jsonl')
    assert result['outcome'] == 'turns' and result['pieces'] == []


def test_switch_to_grok_carries_the_conversation(api, tmp_path, skills, monkeypatch):
    run(api, tmp_path, prompt_job(), 'claude_builds_hat.jsonl')
    seen = {}
    real = jobs.run_agent

    def spy(agent, model, prompt, session, *a, **kw):
        if not seen:  # the prompt's own run, not a look-again
            seen.update(agent=agent, prompt=prompt, session=session)
        return real(agent, model, prompt, session, *a, **kw)
    monkeypatch.setattr(jobs, 'run_agent', spy)
    run(api, tmp_path, prompt_job(jobId='job-2', agent='grok', model='grok-build-0.1', prompt='make it pink'),
        'grok_builds_hat.jsonl')
    assert seen['agent'] == 'grok' and seen['session'] is None
    assert seen['prompt'].startswith('Conversation so far:') and 'The user now says:\nmake it pink' in seen['prompt']


def grok_job(**kw):
    return prompt_job(agent='grok', model='grok-build-0.1', **kw)


def spy_on_runs(monkeypatch):
    calls = []
    real = jobs.run_agent

    def spy(agent, model, prompt, session, *a, **kw):
        calls.append({'prompt': prompt, 'session': session})
        return real(agent, model, prompt, session, *a, **kw)
    monkeypatch.setattr(jobs, 'run_agent', spy)
    return calls


def test_grok_that_never_looked_is_sent_back_to_look(api, tmp_path, skills, monkeypatch):
    calls = spy_on_runs(monkeypatch)
    result = run(api, tmp_path, grok_job(), 'grok_builds_hat.jsonl')
    assert len(calls) == 2
    assert calls[1]['prompt'] == jobs.LOOK_AGAIN and calls[1]['session'] == 'sess-grok-1'
    assert result['outcome'] == 'ok', result['error']
    assert result['costUsd'] == pytest.approx(1.8)


def test_grok_that_looked_runs_once(api, tmp_path, skills, monkeypatch):
    calls = spy_on_runs(monkeypatch)
    result = run(api, tmp_path, grok_job(), 'grok_builds_hat_and_looks.jsonl')
    assert len(calls) == 1 and result['costUsd'] == pytest.approx(0.9)


def test_claude_is_never_sent_back(api, tmp_path, skills, monkeypatch):
    calls = spy_on_runs(monkeypatch)
    run(api, tmp_path, prompt_job(), 'claude_builds_hat.jsonl')
    assert len(calls) == 1
