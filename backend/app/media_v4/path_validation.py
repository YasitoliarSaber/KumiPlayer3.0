"""本地播放路径校验：导入与播放共享词法规则。

规则只读取文件元数据，不打开视频内容、不计算哈希、不递归枚举目录。
"""

from __future__ import annotations

import re
import threading
from pathlib import Path

_REMOTE_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
_PLAYLIST_SUFFIXES = frozenset({".strm", ".m3u", ".m3u8", ".pls", ".asx", ".xspf"})
_PROBE_LOCK = threading.Lock()
_PROBE_SLOTS = threading.BoundedSemaphore(4)
_PENDING_PROBES: dict[str, tuple[threading.Event, list[bool]]] = {}

# Windows 设备路径段（CON/NUL/COM1 等）出现在定位符中一律拒绝。
_WINDOWS_DEVICE_NAMES = frozenset({
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
})


def validate_playback_locator_syntax(locator: str) -> tuple[bool, str]:
    """纯语法校验单个可播放定位符；不访问源盘、不检查文件存在性。

    返回 (ok, reason)。只接受本地文件系统绝对路径，网盘必须由本地挂载提供。
    失败原因使用面向用户的可操作中文，不泄露内部路径细节。
    """
    value = locator or ""
    if not value:
        return False, "媒体播放定位为空，请重新扫描来源"
    if any(ord(ch) < 32 for ch in value):
        return False, "媒体播放路径包含控制字符"
    if value != value.strip():
        return False, "媒体播放路径包含首尾空白，请检查来源映射"
    if _REMOTE_SCHEME.match(value):
        return False, "网盘媒体必须配置本地挂载路径，不能使用远程播放地址"
    if value.startswith(("\\\\.\\", "\\\\?\\")):
        return False, "媒体播放路径包含设备路径"
    path = Path(value)
    if not path.is_absolute():
        return False, "媒体播放定位不是本地绝对路径，请检查来源映射"
    if path.suffix.casefold() in _PLAYLIST_SUFFIXES:
        return False, "媒体播放路径必须指向媒体文件，不能使用播放列表或镜像文件"
    # Path 会折叠单点段；校验原始段，避免归一化掩盖不合法映射。
    for index, part in enumerate(re.split(r"[\\/]", value)):
        if part in {"..", "."}:
            return False, "媒体播放定位包含路径跳转"
        if part and part[-1] in {" ", "."}:
            return False, "媒体播放路径包含不明确的尾部空格或句点"
        if ":" in part and not (index == 0 and re.fullmatch(r"[a-zA-Z]:", part)):
            return False, "媒体播放路径包含非法路径段"
        if any(ch in part for ch in '<>"|?*'):
            return False, "媒体播放路径包含非法路径段"
        if part.rstrip(" .").split(".", 1)[0].casefold() in _WINDOWS_DEVICE_NAMES:
            return False, "媒体播放定位包含设备路径"
    return True, ""


def validate_playback_locator(locator: str, *, timeout: float = 15.0) -> tuple[bool, str]:
    """校验单个可播放定位符。

    只检查本次选定文件，不读取媒体内容或修改来源/媒体状态。
    挂载冷启动允许等待最多 15 秒，文件就绪即返回；为前端 30 秒请求预算
    留出会话切换和播放器启动时间，不把短暂等待误判成挂载配置故障。
    """
    ok, reason = validate_playback_locator_syntax(locator)
    if not ok:
        return ok, reason
    value = (locator or "").strip()
    # 挂载盘的 stat 也可能等网络；只检查选中项，并把等待与请求线程隔离。
    # 同一路径复用尚未结束的探测，最多保留四个 daemon，避免断网时线程堆积。
    with _PROBE_LOCK:
        probe = _PENDING_PROBES.get(value)
        if probe is None:
            if not _PROBE_SLOTS.acquire(blocking=False):
                return False, "媒体挂载仍未响应，请恢复挂载连接后重试"
            done = threading.Event()
            result: list[bool] = []
            probe = (done, result)
            _PENDING_PROBES[value] = probe

            def inspect_file() -> None:
                try:
                    result.append(Path(value).is_file())
                except (OSError, ValueError):
                    result.append(False)
                finally:
                    done.set()
                    with _PROBE_LOCK:
                        _PENDING_PROBES.pop(value, None)
                    _PROBE_SLOTS.release()

            worker = threading.Thread(target=inspect_file, name="playback-file-probe", daemon=True)
            try:
                worker.start()
            except RuntimeError:
                _PENDING_PROBES.pop(value, None)
                _PROBE_SLOTS.release()
                raise
    done, result = probe
    if not done.wait(timeout=max(0.0, timeout)):
        return False, "等待媒体文件响应超时，请稍后重试；若持续超时，请检查挂载连接"
    if not result or not result[0]:
        return False, "媒体挂载路径不可访问，请检查来源映射或挂载状态"
    return True, ""
