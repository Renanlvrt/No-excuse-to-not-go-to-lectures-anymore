"""Persistent, on-disk cache for generated widgets/images, keyed by a
normalized concept label.

The point: infinite variety (any concept gets a bespoke widget) genuinely
needs one LLM call per NEW concept - there's no way around that. But
lecture topics repeat constantly (gradient descent, recursion, linear
regression...), so caching by concept makes almost every REPEAT view free
and instant, which is what actually makes it feel unlimited rather than
rate-limited. Survives server restarts (plain JSON files, not per-connection
state) so the cache only ever grows across every lecture ever run here.
"""
import json
import re
from pathlib import Path
from threading import Lock

CACHE_DIR = Path(__file__).parent.parent.parent / "data"
CACHE_DIR.mkdir(exist_ok=True)

_lock = Lock()  # single-process, single-writer-at-a-time is enough here


def _slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_") or "unnamed"


slug = _slug  # public alias for services that key FILES (audio, video) by concept


def _cache_path(cache_name: str) -> Path:
    return CACHE_DIR / f"{cache_name}_cache.json"


def _load(cache_name: str) -> dict:
    path = _cache_path(cache_name)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def get_cached(cache_name: str, label: str):
    with _lock:
        return _load(cache_name).get(_slug(label))


def set_cached(cache_name: str, label: str, value) -> None:
    with _lock:
        data = _load(cache_name)
        data[_slug(label)] = value
        _cache_path(cache_name).write_text(json.dumps(data), encoding="utf-8")
