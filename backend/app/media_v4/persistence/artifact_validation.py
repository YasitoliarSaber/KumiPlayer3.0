"""单次构建内复用文件摘要；不同构建重新检查，维护删除不使用缓存。"""

import hashlib
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path

_SCOPE: ContextVar[dict | None] = ContextVar('artifact_validation_scope', default=None)


@contextmanager
def validation_scope():
    token = _SCOPE.set({})
    try:
        yield
    finally:
        _SCOPE.reset(token)


def artifact_matches(path: str | Path, expected: str) -> bool:
    path = Path(path)
    try:
        before = path.stat()
        if not path.is_file():
            return False
        key = (str(path), expected, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        cache = _SCOPE.get()
        if cache is not None and key in cache:
            return cache[key]
        digest = hashlib.sha256()
        with path.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(chunk)
        after = path.stat()
        valid = (before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (
            after.st_size, after.st_mtime_ns, after.st_ctime_ns) and digest.hexdigest() == expected
        if cache is not None:
            cache[key] = valid
        return valid
    except OSError:
        return False
