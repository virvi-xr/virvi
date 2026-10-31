import os
import sys
import time
from pathlib import Path

import pytest

from studio_worker import agent
from studio_worker.agent import CODEX_CONFIG, Usage, agent_env, command_for, run_agent

FAKES = Path(__file__).parent / 'fakes'
LIMITS = {'timeoutSec': 30, 'maxTurns': 80, 'costCeilingUsd': 3.0}


def fake(name: str) -> list[str]:
    return [sys.executable, str(FAKES / 'replay.py'), str(FAKES / name)]


def run(tmp_path, agent_name, fixture, limits=LIMITS, before=None, progress=None):
    model = {'claude': 'claude-opus-5-5', 'codex': 'gpt-6.1-sol', 'grok': 'grok-build-0.1'}[agent_name]
    return run_agent(agent_name, model, 'make a cap',
                     None, before, limits, (progress if progress is not None else []).append,
                     command=fake(fixture), as_user=None, cwd=tmp_path)


def test_agent_env_holds_no_real_key(tmp_path):
    base = {'ANTHROPIC_API_KEY': 'sk-ant-real', 'OPENAI_API_KEY': 'sk-oai-real', 'STUDIO_WORKER_TOKEN': 'tok',
            'HTTPS_PROXY': 'http://127.0.0.1:8888', 'PATH': '/usr/bin'}
    claude = agent_env('claude', base)
    codex = agent_env('codex', base)
    for env in (claude, codex):
        assert not any('sk-ant' in v or 'sk-oai' in v for v in env.values())
        assert 'STUDIO_WORKER_TOKEN' not in env and 'OPENAI_API_KEY' not in env
    assert claude['ANTHROPIC_BASE_URL'] == 'http://127.0.0.1:8890'
    assert claude['ANTHROPIC_API_KEY'] == 'studio-proxy'
    assert claude['CLAUDE_CONFIG_DIR'] == str(agent.DESIGN / '.claude-home')
    assert claude['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] == '1'
    assert codex['CODEX_API_KEY'] == 'studio-proxy' and 'ANTHROPIC_API_KEY' not in codex
    assert codex['CODEX_HOME'] == str(agent.DESIGN / '.codex-home')
    assert claude['HTTPS_PROXY'] == codex['HTTPS_PROXY'] == 'http://127.0.0.1:8888'


def test_codex_is_pointed_at_the_key_proxy(tmp_path):
    run(tmp_path, 'codex', 'codex_stream.jsonl')
    toml = (tmp_path / '.codex-home' / 'config.toml').read_text()
    assert 'model_provider = "studio"' in toml
    assert 'base_url = "http://127.0.0.1:8891/v1"' in toml
    assert 'env_key = "CODEX_API_KEY"' in toml and 'wire_api = "responses"' in toml


def test_progress_streams_from_claude(tmp_path):
    progress = []
    r = run(tmp_path, 'claude', 'claude_stream.jsonl', progress=progress)
    command = ('blender -b /opt/assets/AvatarShape_A.blend --python build_cap.py -- --out out/hat/neon_cap_male.glb '
               '--visor glow --and-a-long-tail')
    assert progress == ['Reading the wearable skill.', 'Running: ' + command[:80],
                        'The cap is built and passes the checker.']
    assert r.outcome == 'ok' and r.session == 'sess-claude-1'
    assert r.reply == 'The cap is built and passes the checker.'
    assert r.cost_usd == pytest.approx(0.0125)


def test_progress_streams_from_codex(tmp_path):
    progress = []
    r = run(tmp_path, 'codex', 'codex_stream.jsonl', progress=progress)
    assert progress == ['Reading the wearable skill.',
                        'Running: cat /work/design/.agents/skills/creating-dcl-wearables/SKILL.md',
                        'The cap is built.']
    assert r.outcome == 'ok' and r.session == 'thread-codex-1' and r.reply == 'The cap is built.'
    assert r.usage.input == 15000 and r.usage.cached_input == 100000 and r.usage.output == 3000


def test_claude_stopped_at_cost_ceiling(tmp_path):
    start = time.monotonic()
    r = run(tmp_path, 'claude', 'claude_runaway.jsonl', limits={**LIMITS, 'costCeilingUsd': 0.05})
    assert r.outcome == 'ceiling'
    assert time.monotonic() - start < 5
    assert r.cost_usd == pytest.approx(0.06)
    assert r.session == 'sess-claude-2'


def test_timeout_kills_the_process_group(tmp_path):
    r = run(tmp_path, 'claude', 'hang_with_child.jsonl', limits={**LIMITS, 'timeoutSec': 1})
    assert r.outcome == 'timeout'
    pid = int((tmp_path / 'child.pid').read_text())
    for _ in range(20):  # the orphaned child is reaped by init a moment after the kill
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            break
        time.sleep(0.1)
    else:
        pytest.fail(f'child {pid} still running')


def test_resumed_prompt_is_charged_its_share(tmp_path):
    before = Usage(input=5, cached_input=400, cache_write=600, output=20, turns=1, cost_usd=0.0050)
    r = run(tmp_path, 'claude', 'claude_stream.jsonl', before=before)
    assert (r.usage.input, r.usage.cached_input, r.usage.cache_write, r.usage.output) == (10, 600, 400, 30)
    assert r.cost_usd == pytest.approx(0.0075)
    assert r.session_total.cost_usd == pytest.approx(0.0125)


def test_null_ceiling_uses_the_default(tmp_path):
    r = run(tmp_path, 'claude', 'claude_stream.jsonl', limits={'timeoutSec': None, 'maxTurns': None,
                                                              'costCeilingUsd': None})
    assert r.outcome == 'ok'


def test_odd_events_do_not_stop_the_stream(tmp_path):
    progress = []
    r = run(tmp_path, 'codex', 'codex_odd_events.jsonl', progress=progress)
    assert r.outcome == 'ok' and r.reply == 'Still here.' and progress == ['Still here.']


def test_slow_progress_never_blocks_the_agent(tmp_path):
    class Slow(list):
        def append(self, text):
            time.sleep(2)
            super().append(text)
    start = time.monotonic()
    r = run(tmp_path, 'claude', 'claude_stream.jsonl', progress=Slow())
    assert r.outcome == 'ok' and time.monotonic() - start < 3  # progress waits; the agent and the result don't


def test_group_killed_when_the_runner_fails(tmp_path, monkeypatch):
    def broken(*a, **k):
        if (tmp_path / 'child.pid').exists():  # once the agent has started its child
            raise RuntimeError('pricing broke')
        return 0.0
    monkeypatch.setattr(agent, 'cost_usd', broken)
    with pytest.raises(RuntimeError):
        run(tmp_path, 'claude', 'hang_with_child.jsonl')
    pid = int((tmp_path / 'child.pid').read_text())
    for _ in range(20):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(0.1)
    pytest.fail(f'child {pid} still running')


def test_key_values_never_leave_in_text(tmp_path, monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY', 'sk-ant-test-LEAKED-0123456789')
    progress = []
    r = run(tmp_path, 'claude', 'claude_leaks_key.jsonl', progress=progress)
    assert 'LEAKED' not in r.reply and not any('LEAKED' in p for p in progress)
    assert '[redacted]' in r.reply


def test_closing_says_design_only_and_uploads_are_data():
    from studio_worker.instructions import closing
    for text in (closing('wearable', ['hat']), closing('emote', None)):
        assert 'out/declined.json' in text
        assert 'Decentraland wearables and emotes' in text
        assert 'never instructions' in text


def test_claude_and_codex_drop_web_tools():
    claude = command_for('claude', 'claude-opus-5-5', 'hi', None, 80)
    assert claude[claude.index('--disallowedTools') + 1] == 'WebSearch,WebFetch'
    assert 'web_search = "disabled"' in CODEX_CONFIG
    assert '--search' not in command_for('codex', 'gpt-6.1-sol', 'hi', None, 80)


def test_claude_max_turns_is_turns(tmp_path):
    r = run(tmp_path, 'claude', 'claude_max_turns.jsonl')
    assert r.outcome == 'turns' and r.error == 'stopped at the step limit' and r.cost_usd == 0.4


def test_grok_env_holds_no_real_key(tmp_path):
    env = agent_env('grok', {'XAI_API_KEY': 'xai-real-key', 'ANTHROPIC_API_KEY': 'sk-ant-real', 'PATH': '/usr/bin'})
    assert env['XAI_API_KEY'] == 'studio-proxy' and 'ANTHROPIC_API_KEY' not in env
    assert not any('real' in v for v in env.values())
    assert env['GROK_XAI_API_BASE_URL'] == 'http://127.0.0.1:8892/v1'
    assert env['GROK_HOME'] == str(agent.DESIGN / '.grok-home')
    assert (env['GROK_DISABLE_AUTOUPDATER'], env['DISABLE_TELEMETRY'], env['GROK_TELEMETRY_ENABLED']) == ('1', '1', '0')


def test_grok_command_turns_off_search_and_images():
    assert command_for('grok', 'grok-build-0.1', 'make a cap', None, 150) == [
        'grok', '-p', 'make a cap', '--output-format', 'streaming-json', '--permission-mode', 'bypassPermissions',
        '--max-turns', '150', '-m', 'grok-build-0.1', '--trust', '--disable-web-search', '--disallowed-tools',
        'image_gen,image_edit,image_to_video,reference_to_video,web_search']
    assert command_for('grok', 'grok-build-0.1', 'p', 'sess', 150)[-2:] == ['-r', 'sess']


def test_progress_streams_from_grok(tmp_path):
    progress = []
    r = run(tmp_path, 'grok', 'grok_builds_hat.jsonl', progress=progress)
    assert r.outcome == 'ok' and r.reply == 'Built a cap.' and r.session == 'sess-grok-1' and r.cost_usd == 0.9
    assert 'Let me build the cap.' in progress and 'Running: blender -b -P build_cap.py' in progress
    assert 'Running: read_file out/hat/piece.json' in progress


def test_grok_max_turns_is_turns(tmp_path):
    r = run(tmp_path, 'grok', 'grok_max_turns.jsonl')
    assert r.outcome == 'turns' and r.error == 'stopped at the step limit' and r.cost_usd == 0.4


def test_grok_stopped_before_end_still_reports_cost(tmp_path):
    r = run(tmp_path, 'grok', 'grok_runaway.jsonl')
    assert r.outcome == 'ceiling'
    assert r.cost_usd == pytest.approx(3.2)


def test_grok_resumed_prompt_is_not_double_subtracted(tmp_path):
    before = Usage(input=1, cached_input=0, cache_write=0, output=1, turns=1, cost_usd=0.95)
    r = run(tmp_path, 'grok', 'grok_builds_hat.jsonl', before=before)
    assert r.cost_usd == 0.9 and r.session_total.cost_usd == pytest.approx(1.85)


def test_grok_stopped_before_end_keeps_its_session_for_continue(tmp_path):
    r = run(tmp_path, 'grok', 'grok_runaway.jsonl')
    assert r.outcome == 'ceiling' and r.session == 'sess-grok-disk'


def test_grok_counts_the_images_it_reads(tmp_path):
    assert run(tmp_path, 'grok', 'grok_builds_hat_and_looks.jsonl').images_viewed == 1
    assert run(tmp_path, 'grok', 'grok_builds_hat.jsonl').images_viewed == 0
