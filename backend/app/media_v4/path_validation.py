"""本地播放路径校验：导入与播放共享词法规则。

规则只读取文件元数据，不打开视频内容、不计算哈希、不递归枚举目录。
"""

from __future__ import annotations

import re
from pathlib import Path

_REMOTE_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*://")
_PLAYLIST_SUFFIXES = frozenset({".strm", ".m3u", ".m3u8", ".pls", ".asx", ".xspf"})

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


def validate_playback_locator(locator: str) -> tuple[bool, str]:
    """校验单个可播放定位符。

    只检查本次选定文件，不读取媒体内容或修改来源/媒体状态。
    """
    ok, reason = validate_playback_locator_syntax(locator)
    if not ok:
        return ok, reason
    value = (locator or "").strip()
    path = Path(value)
    if not path.is_file():
        return False, "媒体挂载路径不可访问，请检查来源映射或挂载状态"
    return True, ""
