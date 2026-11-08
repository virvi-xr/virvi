#!/usr/bin/env python3
"""A fake agent CLI: prints a JSONL fixture line by line, as the real CLI streams it.

    replay.py <fixture.jsonl>

Control lines (never printed): {"sleep": seconds}; {"spawn_sleep": seconds, "pidfile": path} starts a child
`sleep` and writes its pid, as an agent's Blender would be; {"write": path, "text": str} writes a file relative
to the working directory; {"remove": path} deletes a file, link or folder there; {"copy": src, "to": dst} copies a fixture file into the working directory;
{"env": path} writes the environment it was given as JSON; {"exit": n} ends with exit code n."""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

for line in Path(sys.argv[1]).read_text().splitlines():
    obj = json.loads(line) if line.strip() else None
    if not isinstance(obj, dict):
        continue
    if 'sleep' in obj:
        time.sleep(obj['sleep'])
    elif 'spawn_sleep' in obj:
        child = subprocess.Popen(['sleep', str(obj['spawn_sleep'])])
        Path(obj['pidfile']).write_text(str(child.pid))
    elif 'write' in obj:
        Path(obj['write']).parent.mkdir(parents=True, exist_ok=True)
        Path(obj['write']).write_text(obj['text'])
    elif 'remove' in obj:
        p = Path(obj['remove'])
        shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()
    elif 'copy' in obj:
        Path(obj['to']).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(Path(__file__).parent.parent / 'fixtures' / obj['copy'], obj['to'])
    elif 'exit' in obj:
        sys.exit(obj['exit'])
    elif 'env' in obj:
        Path(obj['env']).write_text(json.dumps(dict(os.environ)))
    else:
        print(line, flush=True)
