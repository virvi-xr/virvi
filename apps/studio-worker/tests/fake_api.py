"""A real local HTTP server implementing Virvi's side of CONTRACT.md, recording every call. Tests and the e2e scripts
run the worker against it.

    with serve(token='t', design='d1') as api:
        api.jobs.append({...})
        ...  # api.url, api.calls, api.events, api.files, api.results, api.workspace
"""
import json
import re
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

PREFIX = '/api/studio/worker'
# The job file paths Virvi accepts (apps/server/src/studio/store.ts FILE_PATH): anything else is a 400
FILE_PATH = re.compile(r'^(pieces/[a-z_]+/[A-Za-z0-9._-]+\.(glb|json)|checks/[a-z_]+(\.txt|/[a-z0-9-]+\.png)|'
                       r'renders/[a-z_]+/[a-z0-9-]+/[0-9]{3}\.webp|final/[a-z_]+/(package\.zip|thumbnail\.png))$')


class FakeApi:
    def __init__(self, token: str, design: str):
        self.token, self.design = token, design
        self.url = ''
        self.jobs: list[dict] = []
        self.workspace: bytes | None = None
        self.calls: list[tuple[str, str]] = []  # (method, path) in order
        self.events: list[tuple[str, dict]] = []  # (job id, event)
        self.files: dict[str, bytes] = {}  # '<job id>/<path>' -> body
        self.results: list[dict] = []
        self.inputs: dict[str, bytes] = {}  # '<job id>/<path>' -> body, served by GET /jobs/{id}/inputs/{path}
        self.fail: dict[tuple[str, str], int] = {}  # (method, path suffix) -> status to answer instead
        self.on_event = None  # called with (job id, event) as each arrives

    def phases(self, job_id: str) -> list[str]:
        return [e['phase'] for j, e in self.events if j == job_id and e['type'] == 'phase']

    def handle(self, method: str, path: str, body: bytes, auth: str):
        self.calls.append((method, path))
        if auth != f'Bearer {self.token}':
            return 401, b''
        for (m, suffix), status in self.fail.items():
            if m == method and path.endswith(suffix):
                return status, b''
        if not path.startswith(PREFIX):
            return 404, b''
        parts = path[len(PREFIX):].strip('/').split('/')
        if parts[:1] == ['designs']:
            if parts[1] != self.design:
                return 403, b''
            if parts[2:] == ['workspace'] and method == 'GET':
                return (200, self.workspace) if self.workspace is not None else (404, b'')
            if parts[2:] == ['workspace'] and method == 'PUT':
                self.workspace = body
                return 204, b''
            if parts[2:] == ['jobs', 'next'] and method == 'GET':
                return (200, json.dumps(self.jobs.pop(0)).encode()) if self.jobs else (204, b'')
        if parts[:1] == ['jobs'] and len(parts) >= 3:
            job_id, what = parts[1], parts[2]
            if what == 'events' and method == 'POST':
                self.events.append((job_id, json.loads(body)))
                if self.on_event:
                    self.on_event(job_id, self.events[-1][1])
                return 204, b''
            if what == 'files' and method == 'PUT':
                if not FILE_PATH.match('/'.join(parts[3:])):
                    return 400, b''
                self.files[f"{job_id}/{'/'.join(parts[3:])}"] = body
                return 204, b''
            if what == 'inputs' and method == 'GET':
                key = f"{job_id}/{'/'.join(parts[3:])}"
                return (200, self.inputs[key]) if key in self.inputs else (404, b'')
            if what == 'result' and method == 'POST':
                self.results.append(json.loads(body))
                return 204, b''
        return 404, b''


@contextmanager
def serve(token: str = 'test-token', design: str = 'design-1'):
    api = FakeApi(token, design)

    class Handler(BaseHTTPRequestHandler):
        def _do(self):
            body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
            status, out = api.handle(self.command, unquote(urlparse(self.path).path), body,
                                     self.headers.get('Authorization', ''))
            self.send_response(status)
            self.send_header('Content-Length', str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        do_GET = do_PUT = do_POST = _do

        def log_message(self, *a):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    api.url = f'http://127.0.0.1:{server.server_port}'
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield api
    finally:
        server.shutdown()
