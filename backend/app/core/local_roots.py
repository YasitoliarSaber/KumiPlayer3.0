"""本地媒体来源条目。

一个分类下可以登记多条本地目录（例如「动画库」「影视库」），每条记录只描述
"用户登记过的本地来源位置"，不构成媒体事实：真正的来源身份仍由扫描时保存的
本地绝对播放路径决定（见 ``backend/app/api/media_v4.py`` 的 ``_local_root_identity``）。

``AppConfig.local_root`` 保留为兼容镜像，始终等于第一条记录的路径；首次启动引导、
来源健康检查与维护保护继续读取它，因此两条数据不会分叉。
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

# 登记条目上限：只约束配置规模，不限制一个目录内能有多少媒体文件。
MAX_LOCAL_ROOTS = 24
# 名称上限与追更分类名称保持一致（Unicode 码点）。
MAX_LOCAL_ROOT_NAME = 24
DEFAULT_LOCAL_ROOT_NAME = "本地媒体库"


@dataclass
class LocalRootConfig:
    """一条本地来源记录。

    ``root_id`` 由路径确定性推导（同一目录重复保存不会新建身份），只用于前端
    列表键与去重，不作为扫描来源身份；扫描的来源身份由运行时按路径计算。
    """

    root_id: str
    name: str = DEFAULT_LOCAL_ROOT_NAME
    path: str = ""


def clean_path(path: str) -> str:
    """只做去空白与 ``~`` 展开，不改变分隔符文本。

    保留用户原样书写的路径（``D:/媒体库`` 与 ``D:\\媒体库`` 都按原样保存），
    避免一次读写就把既有配置的写法改掉。
    """
    text = str(path or "").strip()
    if not text:
        return ""
    return os.path.expanduser(text)


def path_key(path: str) -> str:
    """比较用键：平台规范化 + Windows 大小写不敏感，用于去重。"""
    text = clean_path(path)
    if not text:
        return ""
    return os.path.normcase(os.path.normpath(text))


def is_usable_local_path(path: str) -> bool:
    """必须是当前平台上的绝对路径。

    只校验语法，不要求目录此刻可达：挂载盘离线时用户仍应能保存登记。
    """
    text = clean_path(path)
    if not text:
        return False
    try:
        return Path(text).is_absolute()
    except (OSError, ValueError):
        return False


def root_id_for(path: str) -> str:
    digest = hashlib.sha256(path_key(path).encode("utf-8")).hexdigest()
    return "local_" + digest[:16]


def display_name_for(path: str) -> str:
    """空名称回退到目录名，避免列表里出现无名条目。"""
    text = clean_path(path).rstrip("\\/")
    name = os.path.basename(text) if text else ""
    return name[:MAX_LOCAL_ROOT_NAME] or DEFAULT_LOCAL_ROOT_NAME


def _coerce_record(raw) -> LocalRootConfig | None:
    if isinstance(raw, LocalRootConfig):
        name, path = raw.name, raw.path
    elif isinstance(raw, dict):
        name, path = str(raw.get("name") or ""), str(raw.get("path") or "")
    elif isinstance(raw, str):
        name, path = "", raw
    else:
        return None
    cleaned = clean_path(path)
    if not cleaned:
        return None
    label = str(name or "").strip()[:MAX_LOCAL_ROOT_NAME] or display_name_for(cleaned)
    return LocalRootConfig(root_id=root_id_for(cleaned), name=label, path=cleaned)


def normalize_records(raw_records) -> list[LocalRootConfig]:
    """读取期使用的宽松规范化：丢弃空路径、按路径去重、名称回退到目录名。

    读取期不因路径非法或列表重复而报错，避免一次读取就丢掉用户配置；
    写入期由 ``validate_records`` 明确拒绝这些输入。
    """
    records: list[LocalRootConfig] = []
    seen: set[str] = set()
    for raw in raw_records or ():
        record = _coerce_record(raw)
        if record is None:
            continue
        key = path_key(record.path)
        if not key or key in seen:
            continue
        seen.add(key)
        records.append(record)
        if len(records) >= MAX_LOCAL_ROOTS:
            break
    return records


def validate_records(raw_records) -> list[LocalRootConfig]:
    """写入期校验：拒绝非法路径、重复路径与超限名称，并返回规范化记录。"""
    if not isinstance(raw_records, (list, tuple)):
        raise ValueError("本地目录列表格式不正确")
    if len(raw_records) > MAX_LOCAL_ROOTS:
        raise ValueError(f"本地目录最多登记 {MAX_LOCAL_ROOTS} 条")
    records: list[LocalRootConfig] = []
    seen: set[str] = set()
    for raw in raw_records:
        name = ""
        path = ""
        if isinstance(raw, LocalRootConfig):
            name, path = raw.name, raw.path
        elif isinstance(raw, dict):
            name, path = str(raw.get("name") or ""), str(raw.get("path") or "")
        elif isinstance(raw, str):
            path = raw
        else:
            raise ValueError("本地目录条目格式不正确")
        cleaned = clean_path(path)
        if not cleaned:
            continue
        if not is_usable_local_path(cleaned):
            raise ValueError(f"本地目录必须是绝对路径：{cleaned}")
        key = path_key(cleaned)
        if key in seen:
            raise ValueError(f"本地目录重复：{cleaned}")
        seen.add(key)
        label = str(name or "").strip()
        if len(label) > MAX_LOCAL_ROOT_NAME:
            raise ValueError(f"本地目录名称最多 {MAX_LOCAL_ROOT_NAME} 个字符")
        records.append(
            LocalRootConfig(
                root_id=root_id_for(cleaned),
                name=label or display_name_for(cleaned),
                path=cleaned,
            )
        )
    return records


def with_primary(records, path: str) -> list[LocalRootConfig]:
    """把 ``path`` 提升为第一条（主）来源。

    首次启动引导与来源设置写入单值 ``local_root`` 时使用：已登记则不新建重复条目，
    只把该条目移到首位；未登记则追加为第一条。其余条目保持原有顺序。
    """
    cleaned = clean_path(path)
    if not cleaned:
        return list(records)
    key = path_key(cleaned)
    existing = next((record for record in records if path_key(record.path) == key), None)
    rest = [record for record in records if path_key(record.path) != key]
    primary = existing or LocalRootConfig(
        root_id=root_id_for(cleaned),
        name=display_name_for(cleaned),
        path=cleaned,
    )
    return [primary, *rest][:MAX_LOCAL_ROOTS]


def apply_primary_change(records, requested) -> list[LocalRootConfig]:
    """单值 ``local_root`` 写入的语义：非空提升为第一条，空值清空登记。

    PATCH 与首次启动引导共用这一条规则，避免两个写入通道对同一字段给出
    不同结果。
    """
    text = str(requested or "").strip()
    if not text:
        return []
    return with_primary(records, text)


def sync_local_roots(config) -> None:
    """读取与写入共用的规范化：迁移旧单目录字段并同步兼容镜像 ``local_root``。"""
    records = normalize_records(getattr(config, "local_roots", None))
    legacy = str(getattr(config, "local_root", "") or "").strip()
    if not records and legacy:
        # 旧配置（或首次启动引导写入的单值）迁移为第一条记录。
        records = normalize_records([legacy])
    config.local_roots = records
    config.local_root = records[0].path if records else legacy


def public_records(config) -> list[dict]:
    """给前端的公开记录；只包含非敏感字段。"""
    return [
        {"root_id": record.root_id, "name": record.name, "path": record.path}
        for record in normalize_records(getattr(config, "local_roots", None))
    ]
