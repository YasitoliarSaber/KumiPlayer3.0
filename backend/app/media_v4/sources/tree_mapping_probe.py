"""可选目录映射探测：只读元数据、总时间/请求预算、有限后台工作线程。"""

from __future__ import annotations

import ctypes
import os
import stat
import threading
import time
from pathlib import Path, PureWindowsPath

_SLOTS = threading.BoundedSemaphore(2)


def bounded_call(callback, *, timeout: float):
    """内核 I/O 无法靠线程取消；最多两条 daemon，超时后不再追加工作。"""
    if timeout <= 0 or not _SLOTS.acquire(blocking=False):
        return None
    done = threading.Event()
    output: list = []

    def run() -> None:
        try:
            output.append(callback())
        except Exception:
            output.append(None)
        finally:
            _SLOTS.release()
            done.set()

    worker = threading.Thread(target=run, name="tree-mapping-metadata", daemon=True)
    try:
        worker.start()
    except RuntimeError:
        _SLOTS.release()
        return None
    return output[0] if done.wait(timeout) and output else None


def inspect_metadata(path: str) -> dict:
    """不打开文件、不启动播放器；只把明确 not-found 归类为 missing。"""
    if os.name == "nt":
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        attributes = kernel.GetFileAttributesW
        attributes.argtypes = [ctypes.c_wchar_p]
        attributes.restype = ctypes.c_uint32
        target = str(PureWindowsPath(path))
        if len(target) >= 260 and PureWindowsPath(target).is_absolute():
            target = "\\\\?\\UNC\\" + target[2:] if target.startswith("\\\\") else "\\\\?\\" + target
        value = attributes(target)
        if value != 0xFFFFFFFF:
            return {"status": "directory" if value & 0x10 else "file"}
        error = ctypes.get_last_error()
        return {"status": "missing" if error in {2, 3} else "unavailable", "error_kind": str(error)}
    try:
        value = os.stat(path)
        return {"status": "directory" if stat.S_ISDIR(value.st_mode) else "file"}
    except FileNotFoundError:
        return {"status": "missing"}
    except OSError:
        return {"status": "unavailable", "error_kind": "access"}


class BoundedMetadataProbe:
    """初始保守预算，不作为网盘性能承诺；只有待区分候选才调用。"""

    def __init__(self, *, timeout: float = 2.0, max_requests: int = 12, inspect=inspect_metadata, roots=()):
        self.deadline = time.monotonic() + max(0, timeout)
        self.remaining = max_requests
        self.inspect = inspect
        self.cache: dict[str, dict] = {}
        self.stopped = False
        self.roots = list(roots)

    def _inspect(self, path: str) -> dict:
        if path in self.cache:
            return self.cache[path]
        if self.stopped or self.remaining <= 0 or time.monotonic() >= self.deadline:
            self.stopped = True
            return {"status": "unavailable", "error_kind": "budget"}
        self.remaining -= 1
        value = bounded_call(lambda: self.inspect(path), timeout=self.deadline - time.monotonic())
        if not isinstance(value, dict):
            self.stopped = True
            return {"status": "unavailable", "error_kind": "timeout"}
        self.cache[path] = value
        if value.get("status") == "unavailable":
            self.stopped = True
        return value

    def __call__(self, path: str) -> dict:
        for root in self.roots:
            try:
                PureWindowsPath(path).relative_to(PureWindowsPath(root))
            except ValueError:
                continue
            if self._inspect(root)["status"] != "directory":
                return {"status": "unavailable", "error_kind": "mount_unavailable"}
            break
        parent = str(PureWindowsPath(path).parent) if os.name == "nt" else str(Path(path).parent)
        parent_result = self._inspect(parent)
        if parent_result["status"] == "directory":
            return self._inspect(path)
        return parent_result
