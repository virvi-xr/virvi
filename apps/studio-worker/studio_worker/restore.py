"""Put a design's out/ back exactly as it was: used when the emote leg retry fails, so the first run's export stands.

The agent owns out/ and everything in it, and this runs as root, so nothing here ever follows a link. Every step goes
through directory file descriptors opened with O_NOFOLLOW: a snapshot keeps only real folders and regular files
(single-linked, within size budgets), and a restore removes whatever else is there (links are unlinked, never
followed; folders are removed with rmtree relative to their parent's descriptor), recreates what is missing, and
writes every kept file afresh with O_CREAT | O_EXCL, owned by the agent user. collect reads every out/<category>/
folder, so the whole out/ is kept and put back, not only out/emote/.
"""
import os
import pwd
import shutil
import stat
import sys
from dataclasses import dataclass, field
from pathlib import Path

MAX_FILE_BYTES = 64 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_ENTRIES = 2000
MAX_DEPTH = 8
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


@dataclass
class Tree:
    files: dict[str, bytes] = field(default_factory=dict)
    dirs: dict[str, 'Tree'] = field(default_factory=dict)


class _TooBig(Exception):
    pass


def snapshot(design: Path) -> Tree | None:
    """out/ as it is now, or None when out/ isn't a real folder (a link, a file, missing) or is over the budgets."""
    try:
        fd = os.open(Path(design) / 'out', DIR_FLAGS)
    except OSError:
        return None
    try:
        return _snap(fd, 0, [0, 0])
    except (_TooBig, OSError) as e:
        print(f'[worker] out/ not snapshotted: {type(e).__name__}: {e}', file=sys.stderr)
        return None
    finally:
        os.close(fd)


def _snap(fd: int, depth: int, used: list[int]) -> Tree:
    if depth > MAX_DEPTH:
        raise _TooBig('too deep')
    t = Tree()
    with os.scandir(fd) as entries:
        for e in entries:
            used[1] += 1
            if used[1] > MAX_ENTRIES:
                raise _TooBig('too many entries')
            if e.is_dir(follow_symlinks=False):
                sub = os.open(e.name, DIR_FLAGS, dir_fd=fd)
                try:
                    t.dirs[e.name] = _snap(sub, depth + 1, used)
                finally:
                    os.close(sub)
            elif e.is_file(follow_symlinks=False):
                data = _read(fd, e.name)
                if data is not None:
                    used[0] += len(data)
                    if used[0] > MAX_TOTAL_BYTES:
                        raise _TooBig('too large')
                    t.files[e.name] = data
            # links, pipes, sockets and devices are not kept, so a restore removes them
    return t


def _read(dir_fd: int, name: str) -> bytes | None:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except OSError:
        return None
    with os.fdopen(fd, 'rb') as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            return None
        if st.st_size > MAX_FILE_BYTES:
            raise _TooBig(f'{name} is too large')
        data = f.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise _TooBig(f'{name} is too large')
    return data


def restore(design: Path, kept: Tree, as_user: str | None) -> None:
    """Makes out/ exactly `kept`. design/ is the worker's own folder; everything below it is treated as hostile."""
    uid = _uid(as_user) if as_user else None
    fd = os.open(Path(design), os.O_RDONLY | os.O_DIRECTORY)
    try:
        _put(fd, 'out', kept, uid)
    finally:
        os.close(fd)


def _uid(user: str) -> int:
    return pwd.getpwnam(user).pw_uid


def _put(parent: int, name: str, kept: Tree, uid: int | None) -> None:
    try:
        st = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        st = None
    if st is not None and not stat.S_ISDIR(st.st_mode):
        os.unlink(name, dir_fd=parent)  # a link or a file where the folder was: the name goes, never its target
        st = None
    if st is None:
        os.mkdir(name, 0o755, dir_fd=parent)
        if uid is not None:
            os.chown(name, uid, -1, dir_fd=parent, follow_symlinks=False)
    fd = os.open(name, DIR_FLAGS, dir_fd=parent)
    try:
        with os.scandir(fd) as entries:
            present = [(e.name, e.is_dir(follow_symlinks=False)) for e in entries]
        for n, is_dir in present:
            if is_dir and n in kept.dirs:
                continue  # put right below
            if is_dir:
                shutil.rmtree(n, dir_fd=fd)
            else:
                os.unlink(n, dir_fd=fd)  # every kept file is written afresh
        for n, data in kept.files.items():
            f = os.open(n, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644, dir_fd=fd)
            with os.fdopen(f, 'wb') as fh:
                fh.write(data)
                if uid is not None:
                    os.fchown(fh.fileno(), uid, -1)
        for n, sub in kept.dirs.items():
            _put(fd, n, sub, uid)
    finally:
        os.close(fd)
