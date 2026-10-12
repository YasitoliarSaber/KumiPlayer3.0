"""目录树相对路径与显式挂载范围的纯词法合同；不访问源盘。"""

from __future__ import annotations

from typing import Literal

TreeMappingMode = Literal["direct", "export_subdir", "mounted_subdir"]
MAPPING_MODES = frozenset({"direct", "export_subdir", "mounted_subdir"})
_DEVICE_NAMES = frozenset({
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
})


def relative_parts(value: str) -> tuple[str, ...]:
    """先检查原始段，再规范化分隔符，避免路径库消去跳转或覆盖根。"""
    if not value or value.startswith(("/", "\\")):
        raise ValueError("需要非空相对目录，不能填写盘符或绝对路径")
    if any(ord(ch) < 32 for ch in value):
        raise ValueError("路径包含控制字符")
    parts = tuple(value.replace("\\", "/").split("/"))
    for part in parts:
        if part in {"", ".", ".."}:
            raise ValueError("路径包含空段或路径跳转")
        if any(ch in part for ch in ':<>"|?*') or part.endswith((" ", ".")):
            raise ValueError("路径包含 Windows 不支持的字符或结尾")
        if part.split(".", 1)[0].casefold() in _DEVICE_NAMES:
            raise ValueError("路径包含 Windows 设备名称")
    return parts


def mapping_scope(mode: str, scope: str) -> tuple[str, ...]:
    if mode not in MAPPING_MODES:
        raise ValueError("未知的目录树路径对应方式")
    return () if mode == "direct" else relative_parts(scope.strip())


def mapped_entries(
    entries: list[tuple[str, str]], *, mode: str = "direct", scope: str = "",
) -> list[tuple[str, str, str]]:
    """返回（原始相对路径、映射相对路径、类型）。播放根已包含 export_subdir。

    mounted_subdir 只接受完整目录段前缀；其余分支排除。所有条目先通过
    安全检查，真实相邻同名目录保留，原始证据路径不随挂载方式改写。
    """
    prefix = mapping_scope(mode, scope)
    output = []
    for relative, kind in entries:
        parts = relative_parts(relative)
        mapped = parts
        if mode == "mounted_subdir":
            if len(parts) <= len(prefix) or parts[:len(prefix)] != prefix:
                continue
            mapped = parts[len(prefix):]
        output.append((relative, "/".join(mapped), kind))
    if mode == "mounted_subdir" and not output:
        raise ValueError("TXT 中找不到所选目录下的视频，请检查目录对应范围")
    return output
