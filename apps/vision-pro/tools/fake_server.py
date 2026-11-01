"""Fixture server for running Virvi Builder in the visionOS simulator.

    python3 tools/fake_server.py <fixture dir> [--flip-live SECONDS]

<fixture dir> holds Duck.glb (the Khronos Duck, as in the AR spike) and tex.png; they are served under /media/.
The API answers on http://127.0.0.1:8787 and placeholder web pages (analytics, publish, upload, pairing) on
http://localhost:3000, the dashboard origin `analyticsUrlFor` derives for a local API. Pairing approves on the second
claim poll. `--flip-live` turns the "Stage" stream live/offline every SECONDS, so Alerts has something to show.

It logs only the method and the path, without the query string and with pairing and upload codes masked: never a
token, secret or code.
"""
import json
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer, BaseHTTPRequestHandler

MEDIA = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "."
FLIP = float(sys.argv[sys.argv.index("--flip-live") + 1]) if "--flip-live" in sys.argv else 0
API = "http://127.0.0.1:8787"
WEB = "http://localhost:3000"
B = API + "/media/"


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def redact(path):
    """The path without its query, and with pairing and upload codes replaced: those are secrets too."""
    path = path.split("?")[0]
    path = re.sub(r"^/api/ar/pair/[^/]+", "/api/ar/pair/:code", path)
    return re.sub(r"^/(u|pair/headset)/[^/]+", r"/\1/:code", path)


def now():
    return datetime.now(timezone.utc)


def inst(sk, p, r=(0, 0, 0), s=(1, 1, 1)):
    return {"sk": sk, "position": dict(zip("xyz", p)), "rotation": dict(zip("xyz", r)), "scale": dict(zip("xyz", s))}


lock = threading.Condition()
state = {
    "version": 1,
    "claims": {},
    "activePresetId": "p1",
    "live": {"v1": True, "v2": False},
    "enabled": {},
    "roles": [
        {"wallet": "0x" + "ab" * 20, "role": "cohost", "displayName": "Ana"},
        {"wallet": "0x" + "cd" * 20, "role": "editor", "displayName": None},
    ],
}
PRESETS = [{"id": "p1", "name": "Gallery"}, {"id": "p2", "name": "Night show"}]
SCENES = [
    {"sceneId": "s1", "sceneName": "Fixture Gallery", "role": "host"},
    {"sceneId": "s2", "sceneName": "Rooftop Stage", "role": "editor"},
]
LIBRARY = [
    {"id": "a1", "kind": "model", "name": "Duck.glb", "url": B + "Duck.glb", "contentType": "model/gltf-binary", "status": "ready", "error": None},
    {"id": "a2", "kind": "media", "name": "Poster.png", "url": B + "tex.png", "contentType": "image/png", "status": "ready", "error": None},
    {"id": "a3", "kind": "model", "name": "Lamp.glb", "url": "", "contentType": "model/gltf-binary", "status": "processing", "error": None},
    {"id": "a4", "kind": "media", "name": "Banner.jpg", "url": "", "contentType": "image/jpeg", "status": "failed", "error": "File is too large"},
]


def scene_snapshot():
    en = state["enabled"]
    return {
        "sk": state["activePresetId"],
        "name": next(p["name"] for p in PRESETS if p["id"] == state["activePresetId"]),
        "images": [
            {"sk": "img", "name": "Poster", "enabled": en.get("img", True), "textureSrc": B + "tex.png",
             "instances": [inst("a", (6, 1.5, 11), s=(2, 2, 1)), inst("b", (10.5, 1.5, 10), (0, 30, 0), (2, 2, 1))]},
        ],
        "models": [
            {"sk": "duck", "name": "Duck", "enabled": en.get("duck", True), "modelSrc": B + "Duck.glb",
             "instances": [inst("d", (6.3, 0, 8.5), (0, 0, 0), (1.5, 1.5, 1.5))]},
            {"sk": "missing", "name": "Missing model", "enabled": en.get("missing", False), "modelSrc": B + "nope.glb",
             "instances": [inst("m", (9.5, 0, 8))]},
        ],
        "videos": [
            {"sk": "v1", "name": "Main screen", "enabled": en.get("v1", True), "isLive": state["live"]["v1"], "instances": []},
            {"sk": "v2", "name": "Stage", "enabled": en.get("v2", True), "isLive": state["live"]["v2"], "instances": []},
        ],
        "sounds": [],
    }


def bump():
    with lock:
        state["version"] += 1
        lock.notify_all()


def flipper():
    while True:
        time.sleep(FLIP)
        state["live"]["v2"] = not state["live"]["v2"]
        bump()


class Api(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=MEDIA, **k)

    def log_message(self, fmt, *args):
        # Method and path only: queries and bodies can carry passes, secrets or codes.
        print(f"{self.command} {redact(self.path)}", flush=True)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except ValueError:
            return {}

    def send(self, status, obj=None):
        data = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(status)
        if obj is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the app went away mid long-poll

    def route(self, method):
        path = self.path.split("?")[0]
        query = self.path.split("?")[1] if "?" in self.path else ""
        b = self.body() if method in ("POST", "PUT", "PATCH") else {}

        if method == "POST" and path == "/api/ar/pair":
            state["claims"] = {}
            return self.send(201, {"code": "ABC123", "approveUrl": WEB + "/pair/headset/ABC123",
                                   "codeExpiresAt": iso(now() + timedelta(minutes=10))})
        m = re.fullmatch(r"/api/ar/pair/([^/]+)/claim", path)
        if method == "POST" and m:
            n = state["claims"].get(m[1], 0) + 1
            state["claims"][m[1]] = n
            if n < 2:
                return self.send(200, {"status": "pending"})
            return self.send(200, {"status": "approved", "deviceId": "dev-fixture", "kind": "personal",
                                   "expiresAt": iso(now() + timedelta(days=30))})
        m = re.fullmatch(r"/api/ar/devices/([^/]+)/(scenes|pass|end)", path)
        if method == "POST" and m:
            if m[2] == "scenes":
                return self.send(200, SCENES)
            if m[2] == "pass":
                return self.send(200, {"pass": "fixture-pass", "passExpiresAt": iso(now() + timedelta(minutes=15)),
                                       "sceneId": b.get("sceneId", "s1")})
            return self.send(204)
        m = re.fullmatch(r"/api/ar/scenes/([^/]+)/feed", path)
        if method == "GET" and m:
            since = re.search(r"since=([^&]+)", query)
            with lock:
                if since and since[1] == f"fixture{state['version']}":
                    lock.wait(timeout=25)
                version = state["version"]
            return self.send(200, {"v": 1, "version": f"fixture{version}", "scene": scene_snapshot()})
        if method == "POST" and path in ("/api/ar/drafts", "/api/ar/drafts/end"):
            return self.send(204)

        m = re.fullmatch(r"/api/scenes/([^/]+)", path)
        if m and method == "GET":
            return self.send(200, {"scene": {"id": m[1], "name": "Fixture Gallery", "activePresetId": state["activePresetId"],
                                             "presets": PRESETS}})
        if m and method == "PUT":
            if b.get("activePresetId") in [p["id"] for p in PRESETS]:
                state["activePresetId"] = b["activePresetId"]
                bump()
            return self.send(200, {"scene": {"id": m[1], "activePresetId": state["activePresetId"]}})
        m = re.fullmatch(r"/api/scenes/([^/]+)/(library|events|roles|dcl/publish-status)", path)
        if m and method == "GET":
            if m[2] == "library":
                return self.send(200, {"items": LIBRARY})
            if m[2] == "events":
                start = now().replace(minute=0, second=0, microsecond=0)
                return self.send(200, {"events": [
                    {"id": "e1", "name": "Opening night", "startTime": iso(start - timedelta(hours=1)),
                     "endTime": iso(start + timedelta(hours=2)), "live": True},
                    {"id": "e2", "name": "Artist talk", "startTime": iso(start + timedelta(days=2)), "endTime": None, "live": False},
                ]})
            if m[2] == "roles":
                return self.send(200, {"host": {"wallets": ["0x" + "1f" * 20]}, "roles": state["roles"]})
            return self.send(200, {"destination": {"id": "d1", "world": "virvi-fixture.dcl.eth", "mode": "sign",
                                                   "status": "ready", "granted": True, "pending": 1,
                                                   "publishUrl": WEB + "/publish/?d=d1"}})
        if method == "POST" and re.fullmatch(r"/api/scenes/[^/]+/roles", path):
            state["roles"] = [r for r in state["roles"] if r["wallet"] != b.get("wallet")]
            state["roles"].append({"wallet": b.get("wallet"), "role": b.get("role"), "displayName": None})
            return self.send(201, {"role": state["roles"][-1]})
        m = re.fullmatch(r"/api/scenes/[^/]+/roles/([^/]+)", path)
        if method == "DELETE" and m:
            state["roles"] = [r for r in state["roles"] if r["wallet"] != m[1]]
            return self.send(204)
        m = re.fullmatch(r"/api/scenes/[^/]+/library/([^/]+)", path)
        if m and method == "PATCH":
            for a in LIBRARY:
                if a["id"] == m[1] and b.get("name"):
                    a["name"] = b["name"]
                    return self.send(200, {"item": a})
            return self.send(404, {"error": "not_found"})
        if m and method == "DELETE":
            LIBRARY[:] = [a for a in LIBRARY if a["id"] != m[1]]
            return self.send(204)
        if method == "POST" and path == "/api/upload-tokens":
            return self.send(201, {"token": {"code": "K7Q2PX", "uploadUrl": WEB + "/u/K7Q2PX", "qrUrl": WEB + "/qr/K7Q2PX.png",
                                             "expiresAt": iso(now() + timedelta(minutes=30)), "maxUploads": 10}})

        if method == "PUT" and re.fullmatch(r"/api/instances/[^/]+", path):
            return self.send(200, {"instance": {"id": path.rsplit("/", 1)[1]}})
        m = re.fullmatch(r"/api/elements/([^/]+)(/live|/instances)?", path)
        if m and method == "PUT" and not m[2]:
            if "enabled" in b:
                state["enabled"][m[1]] = bool(b["enabled"])
                bump()
            return self.send(200, {"element": {"id": m[1]}})
        if m and method == "DELETE" and not m[2]:
            return self.send(204)
        if m and method == "POST" and m[2] == "/live":
            if m[1] in state["live"]:
                state["live"][m[1]] = bool(b.get("enabled"))
                bump()
            return self.send(200, {"ok": True})
        if m and method == "POST" and m[2] == "/instances":
            return self.send(201, {"instance": {"id": "inst-new"}})
        if method == "POST" and re.fullmatch(r"/api/presets/[^/]+/elements", path):
            return self.send(201, {"element": {"id": "el-new"}})
        return self.send(404, {"error": "not_found"})

    def do_GET(self):
        if self.path.startswith("/media/"):
            self.path = self.path[len("/media"):]
            return super().do_GET()
        return self.route("GET")

    def do_POST(self): return self.route("POST")
    def do_PUT(self): return self.route("PUT")
    def do_PATCH(self): return self.route("PATCH")
    def do_DELETE(self): return self.route("DELETE")


class Web(BaseHTTPRequestHandler):
    """Placeholder dashboard pages for the browser window."""

    def log_message(self, fmt, *args):
        print(f"web {self.command} {redact(self.path)}", flush=True)

    def do_GET(self):
        page = self.path.split("?")[0].strip("/").split("/")[0] or "home"
        titles = {"analytics": "Scene analytics", "publish": "Publish to your World", "u": "Upload media", "pair": "Approve headset"}
        html = f"""<!doctype html><meta name=viewport content="width=device-width"><title>Virvi</title>
<body style="font:20px -apple-system;background:#0f0f1a;color:#fff;padding:40px">
<h1>{titles.get(page, 'Virvi')}</h1><p style="color:#8c8c99">Fixture page from tools/fake_server.py</p></body>"""
        data = html.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    if FLIP:
        threading.Thread(target=flipper, daemon=True).start()
    threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", 3000), Web).serve_forever, daemon=True).start()
    print(f"API on {API}, web pages on {WEB}, media from {MEDIA}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8787), Api).serve_forever()
