"""Do an emote's legs pass through each other? A check on the exported GLB alone (numpy, no Blender).

Forward kinematics of the avatar's leg chain (Avatar_Hips, then UpLeg -> Leg -> Foot on each side): every node's rest
TRS, overridden by the avatar clip's animated channels at time t (LINEAR with slerp for rotations, STEP, or
CUBICSPLINE). At sampled times across the clip it measures the closest distance between the two thighs (hip joint to
knee) and between the two shins (knee to ankle), centre line to centre line.

Thresholds, from the official avatars (AvatarShape_A and _B): the hip joints sit 17.8 cm apart, a thigh is 44.9 cm
long and 11-12 cm in radius at the hip, about 6 at the knee; a shin is 40.7 cm long, 5-6 cm in radius at the calf
and about 3.7 at the ankle. Legs that touch on purpose (knees together, ankles crossed, a thigh resting on the other)
keep their centre lines at least about twice the radius apart: 12 cm at the knees, 7 cm at the ankles; Blender's
mesh-overlap test (emotelib.limb_overlaps) first sees the meshes meet at about 12 cm (thighs) and 10 cm (shins).
A verdict needs the centre lines under 6 cm (thighs) or 5 cm (shins): the limbs are then at least 6 cm into each
other at the knee and 2.4 cm at the ankle, which is passing through, never resting against. Standing, wide stances,
squats, kneeling and sitting keep the lines 17 cm or more apart. Distances are in the official rig's cm, scaled by
the GLB's own thigh length, so a rig exported in metres reads the same.

No verdict (None) when the file isn't a regular GLB file this can read (or is over MAX_BYTES), has no animation or no
single avatar clip, lacks one of the leg bones, or nests them in a parent cycle or more than MAX_DEPTH deep. Any error
inside the check is no verdict too, logged to stderr: the check never fails a prompt.
"""
import json
import os
import stat
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

THIGH_CM = 44.89  # the official avatar's thigh, hip joint to knee
THRESHOLD_CM = {'thighs': 6.0, 'shins': 5.0}
EVEN_SAMPLES = 30
MAX_SAMPLES = 240
MAX_BYTES = 64 * 1024 * 1024  # an emote GLB is at most a few MB
MAX_DEPTH = 64  # nodes from the scene root down to a foot; deeper (or a parent cycle) is no verdict
SIDES = ('Left', 'Right')
CHAIN = ['Avatar_Hips'] + [f'Avatar_{s}{b}' for s in SIDES for b in ('UpLeg', 'Leg', 'Foot')]
PAIRS = {'thighs': ('UpLeg', 'Leg'), 'shins': ('Leg', 'Foot')}
COMPONENTS = {5126: (np.float32, None), 5120: (np.int8, 127.0), 5121: (np.uint8, 255.0),
              5122: (np.int16, 32767.0), 5123: (np.uint16, 65535.0)}
WIDTH = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}


@dataclass
class Hit:
    t: float  # seconds into the clip
    pair: str  # 'thighs' or 'shins'
    distance_cm: float  # centre line to centre line


@dataclass
class LegCheck:
    clip: str
    samples: int
    hits: list[Hit] = field(default_factory=list)

    @property
    def crossing(self) -> bool:
        return bool(self.hits)

    def describe(self) -> str:
        """Plain words: which segments pass through each other, and when."""
        parts = []
        for pair in PAIRS:
            hits = [h for h in self.hits if h.pair == pair]
            if not hits:
                continue
            spans = ', '.join(f'{a:.2f} s' if a == b else f'{a:.2f} s to {b:.2f} s' for a, b in self._spans(pair))
            closest = min(h.distance_cm for h in hits)
            parts.append(f'the {pair} pass through each other at {spans} (closest {closest:.1f} cm apart, '
                         f'centre to centre, in {len(hits)} of {self.samples} sampled frames)')
        return '; '.join(parts)

    def _spans(self, pair):
        """Runs of consecutive sampled times that hit, as (first, last)."""
        hit = {h.t for h in self.hits if h.pair == pair}
        spans, start, prev = [], None, None
        for t in self._times:
            if t in hit:
                start = t if start is None else start
                prev = t
            elif start is not None:
                spans.append((start, prev))
                start = None
        if start is not None:
            spans.append((start, prev))
        return spans

    _times: list = field(default_factory=list, repr=False)


class _Unreadable(Exception):
    pass


def check(path: Path) -> LegCheck | None:
    """The check on a file: a regular file only (never through a symlink, never blocking on a pipe), at most MAX_BYTES."""
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return None
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_BYTES:
                return None
            data = f.read(MAX_BYTES + 1)
    except OSError:
        return None
    return check_bytes(data) if len(data) <= MAX_BYTES else None


def check_bytes(data: bytes) -> LegCheck | None:
    try:
        return _check(*_parse(data))
    except (_Unreadable, KeyError, IndexError, TypeError, ValueError, struct.error, json.JSONDecodeError,
            UnicodeDecodeError, AttributeError):
        return None
    except Exception as e:  # whatever an agent's file does to the check, it is no verdict, never a failed prompt
        print(f'[worker] emote leg check skipped: {type(e).__name__}: {e}', file=sys.stderr)
        return None


def _parse(data: bytes):
    if len(data) < 20 or data[:4] != b'glTF':
        raise _Unreadable
    n, kind = struct.unpack('<II', data[12:20])
    if kind != 0x4E4F534A:
        raise _Unreadable
    gltf = json.loads(data[20:20 + n])
    off = 20 + n
    blob = b''
    if off + 8 <= len(data):
        bn, bkind = struct.unpack('<II', data[off:off + 8])
        if bkind == 0x004E4942:
            blob = data[off + 8:off + 8 + bn]
    return gltf, blob


def _accessor(gltf, blob, i) -> np.ndarray:
    acc = gltf['accessors'][i]
    if 'sparse' in acc or acc['type'] not in WIDTH or acc['componentType'] not in COMPONENTS:
        raise _Unreadable
    view = gltf['bufferViews'][acc['bufferView']]
    if view.get('buffer', 0) != 0 or 'uri' in gltf['buffers'][0]:
        raise _Unreadable
    dtype, norm = COMPONENTS[acc['componentType']]
    width, count = WIDTH[acc['type']], int(acc['count'])
    item = np.dtype(dtype).itemsize * width
    stride = view.get('byteStride') or item
    start = view.get('byteOffset', 0) + acc.get('byteOffset', 0)
    if count <= 0 or start + stride * (count - 1) + item > len(blob):
        raise _Unreadable
    raw = np.frombuffer(blob, np.uint8, stride * (count - 1) + item, start)
    rows = np.lib.stride_tricks.as_strided(raw, (count, item), (stride, 1))
    out = np.ascontiguousarray(rows).view(dtype).reshape(count, width).astype(float)
    if norm and acc.get('normalized'):
        out = np.maximum(out / norm, -1.0)
    return out


def _check(gltf, blob) -> LegCheck | None:
    nodes = gltf.get('nodes') or []
    index = {}
    for i, nd in enumerate(nodes):
        index.setdefault(nd.get('name'), i)
    if any(b not in index for b in CHAIN):
        return None
    parent = {c: i for i, nd in enumerate(nodes) for c in nd.get('children') or []}
    for s in SIDES:  # the chain must really be one: Hips -> UpLeg -> Leg -> Foot
        for child, up in ((f'Avatar_{s}UpLeg', 'Avatar_Hips'), (f'Avatar_{s}Leg', f'Avatar_{s}UpLeg'),
                          (f'Avatar_{s}Foot', f'Avatar_{s}Leg')):
            if parent.get(index[child]) != index[up]:
                return None
    paths = {}  # bone -> its node indices from the scene root down, without recursion
    for b in CHAIN:
        path, i = [], index[b]
        while i is not None:
            if i in path or len(path) >= MAX_DEPTH:
                return None
            path.append(i)
            i = parent.get(i)
        paths[b] = path[::-1]
    needed = {i for p in paths.values() for i in p}
    clips = gltf.get('animations') or []
    avatar = [a for a in clips if str(a.get('name', '')).endswith('_Avatar')]
    if len(avatar) == 1:
        clip = avatar[0]  # <Name>_Avatar, beside a <Name>_Prop or a stale clip the agent left
    elif len(clips) == 1 and not avatar:
        clip = clips[0]
    else:
        return None  # no clip, or no telling which one is the avatar's
    tracks, all_times, key_times = {}, [], []
    for ch in clip.get('channels') or []:
        target = ch.get('target') or {}
        node, prop = target.get('node'), target.get('path')
        smp = clip['samplers'][ch['sampler']]
        times = _accessor(gltf, blob, smp['input'])[:, 0]
        all_times += [times.min(), times.max()]
        if node not in needed or prop not in ('translation', 'rotation', 'scale'):
            continue
        values = _accessor(gltf, blob, smp['output'])
        interp = smp.get('interpolation', 'LINEAR')
        if interp == 'CUBICSPLINE':
            if len(values) != 3 * len(times):
                raise _Unreadable
        elif len(values) != len(times):
            raise _Unreadable
        tracks[(node, prop)] = (times, values, interp)
        key_times += list(times)
    if not all_times:
        return None
    t0, t1 = float(min(all_times)), float(max(all_times))
    keys = sorted({round(float(t), 4) for t in key_times if t0 <= t <= t1})
    if len(keys) > MAX_SAMPLES - EVEN_SAMPLES:
        keys = [keys[int(i)] for i in np.linspace(0, len(keys) - 1, MAX_SAMPLES - EVEN_SAMPLES)]
    times = sorted({round(float(t), 4) for t in np.linspace(t0, t1, EVEN_SAMPLES)} | set(keys))

    rest = _joints(nodes, paths, {})
    unit = np.mean([np.linalg.norm(rest[f'Avatar_{s}Leg'] - rest[f'Avatar_{s}UpLeg']) for s in SIDES]) / THIGH_CM
    if not np.isfinite(unit) or unit <= 0:
        return None
    result = LegCheck(clip=str(clip.get('name', '')), samples=len(times), _times=times)
    for t in times:
        pose = {k: _sample(tr, t) for k, tr in tracks.items()}
        j = _joints(nodes, paths, pose)
        for pair, (a, b) in PAIRS.items():
            d = _segments(j[f'Avatar_Left{a}'], j[f'Avatar_Left{b}'], j[f'Avatar_Right{a}'], j[f'Avatar_Right{b}']) / unit
            if d < THRESHOLD_CM[pair]:
                result.hits.append(Hit(t=t, pair=pair, distance_cm=round(float(d), 2)))
    return result


def _joints(nodes, paths, pose) -> dict:
    """World positions of the chain's joints (each bone node's origin), walking each root-to-bone path."""
    world = {}
    out = {}
    for b, path in paths.items():
        m = np.eye(4)
        for i in path:
            if i not in world:
                world[i] = m @ _local(nodes[i], i, pose)
            m = world[i]
        out[b] = m[:3, 3]
    return out


def _local(nd, i, pose) -> np.ndarray:
    animated = any((i, p) in pose for p in ('translation', 'rotation', 'scale'))
    if 'matrix' in nd and not animated:
        return np.array(nd['matrix'], float).reshape(4, 4).T
    t = pose.get((i, 'translation'), nd.get('translation', [0, 0, 0]))
    r = pose.get((i, 'rotation'), nd.get('rotation', [0, 0, 0, 1]))
    s = pose.get((i, 'scale'), nd.get('scale', [1, 1, 1]))
    local = np.eye(4)
    local[:3, :3] = _rot(r) * np.asarray(s, float)
    local[:3, 3] = t
    return local


def _rot(q) -> np.ndarray:
    x, y, z, w = np.asarray(q, float) / (np.linalg.norm(q) or 1.0)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def _sample(track, t):
    times, values, interp = track
    rotation = values.shape[1] == 4
    if interp == 'CUBICSPLINE':
        tangents_in, points, tangents_out = values[0::3], values[1::3], values[2::3]
    else:
        points = values
    if t <= times[0]:
        return points[0]
    if t >= times[-1]:
        return points[-1]
    k = int(np.searchsorted(times, t, side='right')) - 1
    dt = times[k + 1] - times[k]
    u = (t - times[k]) / dt if dt > 0 else 0.0
    if interp == 'STEP':
        return points[k]
    if interp == 'CUBICSPLINE':
        u2, u3 = u * u, u * u * u
        v = ((2 * u3 - 3 * u2 + 1) * points[k] + (u3 - 2 * u2 + u) * dt * tangents_out[k]
             + (-2 * u3 + 3 * u2) * points[k + 1] + (u3 - u2) * dt * tangents_in[k + 1])
        return v / (np.linalg.norm(v) or 1.0) if rotation else v
    if rotation:
        return _slerp(points[k], points[k + 1], u)
    return points[k] + (points[k + 1] - points[k]) * u


def _slerp(a, b, u):
    a, b = a / (np.linalg.norm(a) or 1.0), b / (np.linalg.norm(b) or 1.0)
    d = float(a @ b)
    if d < 0:
        b, d = -b, -d
    if d > 0.9995:
        v = a + (b - a) * u
        return v / np.linalg.norm(v)
    th = np.arccos(min(d, 1.0))
    return (np.sin((1 - u) * th) * a + np.sin(u * th) * b) / np.sin(th)


def _segments(p1, q1, p2, q2) -> float:
    """Closest distance between segments p1-q1 and p2-q2."""
    d1, d2, r = q1 - p1, q2 - p2, p1 - p2
    a, e, f = d1 @ d1, d2 @ d2, d2 @ r
    if a < 1e-12 or e < 1e-12:  # a degenerate segment: fall back to its point
        if a < 1e-12 and e < 1e-12:
            return float(np.linalg.norm(r))
        if a < 1e-12:
            return float(np.linalg.norm(p1 - (p2 + d2 * np.clip(f / e, 0, 1))))
        return float(np.linalg.norm(p1 + d1 * np.clip(-(d1 @ r) / a, 0, 1) - p2))
    c, b = d1 @ r, d1 @ d2
    den = a * e - b * b
    s = float(np.clip((b * f - c * e) / den, 0, 1)) if den > 1e-12 else 0.0
    t = (b * s + f) / e
    if t < 0:
        t, s = 0.0, float(np.clip(-c / a, 0, 1))
    elif t > 1:
        t, s = 1.0, float(np.clip((b - c) / a, 0, 1))
    return float(np.linalg.norm(p1 + d1 * s - (p2 + d2 * t)))
