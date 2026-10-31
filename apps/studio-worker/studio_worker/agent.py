"""Runs one prompt through Claude Code, Codex or Grok Build, streaming its progress, and charges it its share of the session.

Each agent runs as the unprivileged `agent` user in its own process group, holding no real key (keyproxy.py adds it): the group is
killed at the prompt's timeout, or once Claude's or Grok's running cost passes the prompt's ceiling (Codex reports
usage only at the end of a turn, so time alone caps it).
"""
import json
import os
import queue
import re
import signal
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from .config import AGENT_USER, DESIGN

PRICES = Path(__file__).parent / 'prices.json'
CLAUDE_PRICE_ROW = 'claude-opus-5-5'  # prices Claude's running cost while it streams
KILL_GRACE_SEC = 5
PROGRESS_DRAIN_SEC = 1  # after the agent ends, how long its last progress lines may hold up the job
DEFAULT_TIMEOUT_SEC, DEFAULT_MAX_TURNS, DEFAULT_CEILING_USD = 1500, 80, 3.0
# Never handed to an agent: the other agent's key, the worker's token, and anything else that looks like a secret
SECRET = re.compile(r'(_API_KEY|_TOKEN|_SECRET)$')


@dataclass
class Usage:
    input: int
    cached_input: int
    cache_write: int
    output: int
    turns: int
    cost_usd: float | None = None


@dataclass
class AgentRun:
    outcome: str  # 'ok' | 'timeout' | 'ceiling' | 'turns' | 'error'
    reply: str
    session: str | None
    usage: Usage | None  # this prompt's share only
    session_total: Usage | None
    cost_usd: float | None
    wall_sec: float
    error: str | None
    images_viewed: int = 0  # Grok only: the image files it read


def parse_claude_result(obj: dict) -> Usage:
    """Totals modelUsage, which total_cost_usd is computed from; the top-level usage can miss calls."""
    models = (obj.get('modelUsage') or {}).values()
    if not models:
        u = obj.get('usage') or {}
        return Usage(input=u.get('input_tokens', 0), cached_input=u.get('cache_read_input_tokens', 0),
                     cache_write=u.get('cache_creation_input_tokens', 0), output=u.get('output_tokens', 0),
                     turns=obj.get('num_turns', 0), cost_usd=obj.get('total_cost_usd'))
    total = lambda k: sum(m.get(k, 0) for m in models)
    return Usage(input=total('inputTokens'), cached_input=total('cacheReadInputTokens'),
                 cache_write=total('cacheCreationInputTokens'), output=total('outputTokens'),
                 turns=obj.get('num_turns', 0), cost_usd=obj.get('total_cost_usd'))


def parse_codex_events(events: list[dict]) -> Usage | None:
    """The usage on the last turn.completed event, which is the session's running total; None when there is none.

    Codex's input_tokens includes its cached and cache-write tokens, and output_tokens its reasoning tokens."""
    turns = [e for e in events if e.get('type') == 'turn.completed' and e.get('usage')]
    if not turns:
        return None
    u = turns[-1]['usage']
    cached, written = u.get('cached_input_tokens', 0), u.get('cache_write_input_tokens', 0)
    return Usage(input=u.get('input_tokens', 0) - cached - written, cached_input=cached, cache_write=written,
                 output=u.get('output_tokens', 0), turns=len(turns))


def cost_usd(usage: Usage, prices: dict, model: str) -> float | None:
    p = prices.get(model)
    if not p:
        return None
    per_m = lambda n, rate: n * rate / 1_000_000
    return round(per_m(usage.input, p['input']) + per_m(usage.cached_input, p['cachedInput'])
                 + per_m(usage.cache_write, p['cacheWrite']) + per_m(usage.output, p['output']), 6)


def prices() -> dict:
    return json.loads(PRICES.read_text())['models']


# The agents hold a placeholder key; keyproxy.py adds the real one on loopback
KEY_PLACEHOLDER = 'studio-proxy'
ANTHROPIC_BASE_URL = 'http://127.0.0.1:8890'
CODEX_CONFIG = """model_provider = "studio"
web_search = "disabled"

[model_providers.studio]
name = "studio"
base_url = "http://127.0.0.1:8891/v1"
env_key = "CODEX_API_KEY"
wire_api = "responses"
"""
GROK_BASE_URL = 'http://127.0.0.1:8892/v1'
IMAGE_EXTS = ('.png', '.webp', '.jpg', '.jpeg')
# Grok's image tools invent renders, and search would leave the studio: neither is ever offered
GROK_DISALLOWED = 'image_gen,image_edit,image_to_video,reference_to_video,web_search'


def agent_env(agent: str, base: Mapping[str, str], design: Path = DESIGN) -> dict[str, str]:
    env = {k: v for k, v in base.items() if not SECRET.search(k)}
    if agent == 'claude':
        env.update(ANTHROPIC_API_KEY=KEY_PLACEHOLDER, ANTHROPIC_BASE_URL=ANTHROPIC_BASE_URL,
                   CLAUDE_CONFIG_DIR=str(design / '.claude-home'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1')
    elif agent == 'codex':  # codex exec reads its key from CODEX_API_KEY, and its provider from CODEX_HOME/config.toml
        env.update(CODEX_API_KEY=KEY_PLACEHOLDER, CODEX_HOME=str(design / '.codex-home'))
    elif agent == 'grok':
        env.update(XAI_API_KEY=KEY_PLACEHOLDER, GROK_XAI_API_BASE_URL=GROK_BASE_URL, GROK_HOME=str(design / '.grok-home'),
                   GROK_DISABLE_AUTOUPDATER='1', DISABLE_TELEMETRY='1', GROK_TELEMETRY_ENABLED='0')
    else:
        raise ValueError(f'unknown agent: {agent}')
    return env


def command_for(agent: str, model: str, prompt: str, session: str | None, max_turns: int) -> list[str]:
    if agent == 'claude':
        return ['claude', '-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', str(max_turns),
                '--model', model, '--dangerously-skip-permissions', '--disallowedTools', 'WebSearch,WebFetch'] + \
            (['--resume', session] if session else [])
    if agent == 'grok':  # --trust loads the skills in .claude/skills and .agents/skills; without it none load
        return ['grok', '-p', prompt, '--output-format', 'streaming-json', '--permission-mode', 'bypassPermissions',
                '--max-turns', str(max_turns), '-m', model, '--trust', '--disable-web-search',
                '--disallowed-tools', GROK_DISALLOWED] + (['-r', session] if session else [])
    return ['codex', 'exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox',
            '-m', model] + (['resume', session, prompt] if session else [prompt])


class _Stream:
    """Reads the CLI's JSONL as it arrives: progress lines, the session, the reply and Claude's or Grok's running cost."""

    def __init__(self, agent: str, on_progress: Callable[[str], None], secrets: list[str] = ()):
        self.agent, self.secrets = agent, [x for x in secrets if len(x) >= 8]
        self.progress: queue.Queue = queue.Queue()
        self.on_progress = lambda text: self.progress.put(self.redact(text))
        self.events: list[dict] = []
        self.session = self.reply = None
        self.result: dict | None = None
        self._claude_usage: dict[str, dict] = {}  # message id -> usage; a message streams once per content block
        self._text: list[str] = []  # Grok's text tokens since its last tool call
        self.images_viewed = 0
        self._lock = threading.Lock()  # the reader thread adds usage while the main thread prices it

    def feed(self, line: str) -> None:
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(e, dict):
            return
        self.events.append(e)
        try:
            {'claude': self._claude, 'codex': self._codex, 'grok': self._grok}[self.agent](e)
        except (AttributeError, TypeError, KeyError):  # an event of an unexpected shape is skipped, not fatal
            pass

    def _claude(self, e: dict) -> None:
        self.session = e.get('session_id') or self.session
        if e.get('type') == 'result':
            self.result = e
            self.reply = e.get('result') or self.reply
        if e.get('type') != 'assistant':
            return
        msg = e.get('message') or {}
        if msg.get('usage'):
            with self._lock:
                self._claude_usage[msg.get('id') or str(len(self._claude_usage))] = msg['usage']
        for block in msg.get('content') or []:
            if not isinstance(block, dict):
                continue
            if block.get('type') == 'text' and (block.get('text') or '').strip():
                self.reply = block['text']
                self.on_progress(block['text'])
            elif block.get('type') == 'tool_use':
                i = block.get('input') or {}
                what = i.get('command') or ' '.join(filter(None, [block.get('name'), i.get('file_path') or i.get('pattern')]))
                self.on_progress('Running: ' + str(what)[:80])

    def _codex(self, e: dict) -> None:
        if e.get('type') == 'thread.started':
            self.session = e.get('thread_id')
        if e.get('type') != 'item.completed':
            return
        item = e.get('item') or {}
        if item.get('type') == 'agent_message' and (item.get('text') or '').strip():
            self.reply = item['text']
            self.on_progress(item['text'])
        elif item.get('type') == 'command_execution':
            cmd = re.sub(r"^/bin/(ba)?sh -lc '(.*)'$", r'\2', item.get('command', ''), flags=re.S)
            self.on_progress('Running: ' + cmd[:80])

    def _grok(self, e: dict) -> None:
        kind = e.get('type')
        if kind == 'text':
            self._text.append(e.get('data') or '')
        elif kind == 'tool_call':
            self._flush_text()
            self._text = []
            i = e.get('rawInput') or {}
            target = str(i.get('target_file') or i.get('path') or '')
            if e.get('toolName') == 'read_file' and target.lower().endswith(IMAGE_EXTS):
                self.images_viewed += 1
            what = i.get('command') or ' '.join(filter(None, [e.get('toolName'), target or i.get('pattern')]))
            self.on_progress('Running: ' + str(what)[:80])
        elif kind == 'usage' and e.get('usage'):
            with self._lock:  # one event per model call
                self._claude_usage[str(len(self._claude_usage))] = e['usage']
        elif kind == 'end':
            self.result = e
            self.session = e.get('sessionId') or self.session
            self._flush_text()

    def _flush_text(self) -> None:
        """Grok streams its text a token at a time: what it said since its last tool call is one progress line."""
        text = ''.join(self._text).strip()
        if text:
            self.reply = text
            self.on_progress(text)

    def redact(self, text: str) -> str:
        for secret in self.secrets:
            text = text.replace(secret, '[redacted]')
        return text

    def streamed_usage(self) -> Usage:
        """Claude's or Grok's usage so far, summed over its model calls."""
        with self._lock:
            us = list(self._claude_usage.values())
        total = lambda k: sum(u.get(k, 0) for u in us)
        return Usage(input=total('input_tokens'), cached_input=total('cache_read_input_tokens'),
                     cache_write=total('cache_creation_input_tokens'), output=total('output_tokens'), turns=len(us))


def run_agent(agent: str, model: str, prompt: str, session: str | None, before: Usage | None, limits: dict,
              on_progress: Callable[[str], None], command: list[str] | None = None,
              as_user: str | None = AGENT_USER, cwd: Path | None = None) -> AgentRun:
    cwd = Path(cwd or DESIGN)
    timeout = limits.get('timeoutSec') or DEFAULT_TIMEOUT_SEC
    ceiling = limits.get('costCeilingUsd') or DEFAULT_CEILING_USD
    table = prices()
    env = agent_env(agent, os.environ, cwd)
    for home in ('.claude-home', '.codex-home', '.grok-home'):
        (cwd / home).mkdir(exist_ok=True)
        if home == '.codex-home':  # rewritten every run: the agent can edit its own home
            (cwd / home / 'config.toml').write_text(CODEX_CONFIG)
        if as_user and os.geteuid() == 0:
            subprocess.run(['chown', '-R', as_user, str(cwd / home)], check=False)
    cmd = command or command_for(agent, model, prompt, session, limits.get('maxTurns') or DEFAULT_MAX_TURNS)
    if as_user:
        cmd = ['runuser', '-u', as_user, '--'] + cmd

    secrets = [v for k, v in os.environ.items() if SECRET.search(k) and v]
    stream, stderr = _Stream(agent, on_progress, secrets), []
    sender = threading.Thread(target=_deliver, args=(stream.progress, on_progress), daemon=True)
    sender.start()
    start, start_wall = time.monotonic(), time.time()
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, text=True, start_new_session=True)
    readers = [threading.Thread(target=lambda: [stream.feed(l) for l in proc.stdout], daemon=True),
               threading.Thread(target=lambda: [stderr.append(l) for l in proc.stderr], daemon=True)]
    for t in readers:
        t.start()
    stopped = None
    try:
        while proc.poll() is None:
            if time.monotonic() - start > timeout:
                stopped = 'timeout'
            elif agent in ('claude', 'grok') and (_running_cost(agent, stream, table, model) or 0) > ceiling:
                stopped = 'ceiling'
            if stopped:
                break
            time.sleep(0.1)
    finally:
        _kill_group(proc)  # also ends anything the agent left running in the background, such as a Blender
        if as_user and os.geteuid() == 0:  # and anything it started in a session of its own
            subprocess.run(['pkill', '-KILL', '-u', as_user], check=False)
        for t in readers:
            t.join(timeout=KILL_GRACE_SEC)
        stream.progress.put(None)
        sender.join(timeout=PROGRESS_DRAIN_SEC)
    wall = round(time.monotonic() - start, 1)

    total = _session_total(agent, stream, table, model, before)
    usage = _share(total, before) if total else None
    if total is None and agent in ('claude', 'grok') and stream.streamed_usage().turns:  # stopped before its last line
        usage = stream.streamed_usage()
        usage.cost_usd = _running_cost(agent, stream, table, model)
        total = _add(before, usage) if before else usage
    failed = proc.returncode not in (0, None) or bool((stream.result or {}).get('is_error')) or \
        any(e.get('type') == 'turn.failed' for e in stream.events)
    if not stopped and _hit_max_turns(agent, stream):  # Continue resumes it: not a failure
        stopped = 'turns'
    outcome = stopped or ('error' if failed or total is None else 'ok')
    error = None
    if outcome == 'error':
        error = stream.redact((''.join(stderr) or (stream.result or {}).get('result') or
                               'the agent reported no usage')[-2000:])
    elif stopped:
        error = 'stopped at the ' + {'timeout': 'time limit', 'ceiling': 'cost ceiling', 'turns': 'step limit'}[stopped]
    if agent == 'grok' and not stream.session:  # stopped before its end event, which is what names the session
        stream.session = _grok_disk_session(cwd, since=start_wall)
    return AgentRun(outcome=outcome, reply=stream.redact(stream.reply or ''), session=stream.session or session,
                    usage=usage, session_total=total, cost_usd=usage.cost_usd if usage else None, wall_sec=wall,
                    error=error, images_viewed=stream.images_viewed)


def then(first: AgentRun, second: AgentRun) -> AgentRun:
    """Two runs of one prompt as one: the second's outcome, reply and session, both runs' usage and cost."""
    usage = _add(first.usage, second.usage) if first.usage and second.usage else (second.usage or first.usage)
    cost = None if first.cost_usd is None and second.cost_usd is None else \
        round((first.cost_usd or 0) + (second.cost_usd or 0), 6)
    return AgentRun(outcome=second.outcome, reply=second.reply or first.reply, session=second.session or first.session,
                    usage=usage, session_total=second.session_total or first.session_total, cost_usd=cost,
                    wall_sec=round(first.wall_sec + second.wall_sec, 1), error=second.error,
                    images_viewed=first.images_viewed + second.images_viewed)


def _hit_max_turns(agent: str, stream: '_Stream') -> bool:
    result = stream.result or {}
    if agent == 'grok':  # Grok also exits 1 here
        return result.get('stopReason') == 'max_turn_requests'
    return agent == 'claude' and result.get('subtype') == 'error_max_turns'


def _grok_disk_session(cwd: Path, since: float) -> str | None:
    """The session Grok started in this run, from its home ($GROK_HOME/sessions/<cwd>/<id>/), so a Continue after a
    stop resumes it instead of starting blank."""
    found = [d for d in (cwd / '.grok-home' / 'sessions').glob('*/*')
             if d.is_dir() and not d.is_symlink() and d.stat().st_mtime >= since - 1]
    return max(found, key=lambda d: d.stat().st_mtime).name if found else None


def _running_cost(agent: str, stream: '_Stream', table: dict, model: str) -> float | None:
    """The cost so far from the streamed usage: Claude's by its price row whatever the model, Grok's by its model's."""
    usage = stream.streamed_usage()
    if agent == 'claude':
        return cost_usd(usage, table, model) or cost_usd(usage, table, CLAUDE_PRICE_ROW)
    return cost_usd(usage, table, model)


def _deliver(progress: queue.Queue, on_progress: Callable[[str], None]) -> None:
    """Sends progress from its own thread, so a slow or failing API never holds up reading the agent's output."""
    while (text := progress.get()) is not None:
        try:
            on_progress(text)
        except Exception:
            pass


def parse_grok_end(e: dict) -> Usage:
    """Grok's end event covers this run alone, not the session: a resumed run starts its count again."""
    u = e.get('usage') or {}
    return Usage(input=u.get('input_tokens', 0), cached_input=u.get('cache_read_input_tokens', 0),
                 cache_write=u.get('cache_creation_input_tokens', 0), output=u.get('output_tokens', 0),
                 turns=e.get('num_turns', 0), cost_usd=e.get('total_cost_usd'))


def _session_total(agent: str, stream: _Stream, table: dict, model: str, before: Usage | None = None) -> Usage | None:
    if agent == 'claude':
        if not stream.result:
            return None
        total = parse_claude_result(stream.result)
    elif agent == 'grok':
        if not stream.result:
            return None
        run = parse_grok_end(stream.result)
        if run.cost_usd is None:
            run.cost_usd = cost_usd(run, table, model)
        total = _add(before, run) if before else run  # so that _share gives back this run
    else:
        total = parse_codex_events(stream.events)
    if total and total.cost_usd is None:
        total.cost_usd = cost_usd(total, table, model)
    return total


def _share(total: Usage, before: Usage | None) -> Usage:
    """Claude and Codex report the whole session's usage (Grok's is made so), so a resumed prompt is charged the
    total less `before`."""
    if not before:
        return Usage(**vars(total))
    cost = None if total.cost_usd is None or before.cost_usd is None else round(total.cost_usd - before.cost_usd, 6)
    return Usage(input=total.input - before.input, cached_input=total.cached_input - before.cached_input,
                 cache_write=total.cache_write - before.cache_write, output=total.output - before.output,
                 turns=total.turns, cost_usd=cost)


def _add(a: Usage, b: Usage) -> Usage:
    cost = None if a.cost_usd is None or b.cost_usd is None else round(a.cost_usd + b.cost_usd, 6)
    return Usage(input=a.input + b.input, cached_input=a.cached_input + b.cached_input,
                 cache_write=a.cache_write + b.cache_write, output=a.output + b.output, turns=a.turns + b.turns,
                 cost_usd=cost)


def _kill_group(proc: subprocess.Popen) -> None:
    for sig, wait in ((signal.SIGTERM, KILL_GRACE_SEC), (signal.SIGKILL, KILL_GRACE_SEC)):
        try:
            os.killpg(proc.pid, sig)
        except (ProcessLookupError, PermissionError):
            return
        try:
            proc.wait(timeout=wait)
        except subprocess.TimeoutExpired:
            continue
        try:  # the leader is gone; give the rest of the group the same grace before the next signal
            os.killpg(proc.pid, 0)
        except (ProcessLookupError, PermissionError):
            return
