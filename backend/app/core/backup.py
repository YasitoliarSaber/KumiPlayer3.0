"""受控的 .kumibak 备份与恢复（配置 / 来源配置 / 观看记录）。

红线：

- 凭据绝不入包、不入日志、不入响应；恢复也不隐式清除本机现有凭据。
- 归档校验全部在只读阶段完成，校验失败不修改任何数据。
- 观看记录只回写当前库中仍存在的身份；孤立身份只报告，不猜测合并。
- 自动备份由应用运行时调度，保留最近 7 份 auto 备份，手动备份永不参与轮换。
"""

from __future__ import annotations

import copy
import hashlib
import hmac
import io
import json
import logging
import os
import re
import tempfile
import threading
import uuid
import zipfile
from collections.abc import Callable
from dataclasses import asdict
from dataclasses import fields as dataclass_fields
from datetime import UTC, datetime, timedelta
from pathlib import Path

from app.core.atomic_json import write_json_atomic
from app.core.config import (
    CREDENTIAL_FIELD_NAMES,
    AppConfig,
    load_config,
    normalize_backup_time,
    normalize_completed_threshold,
    save_config,
    update_config,
    validate_source_scan_schedules,
)
from app.core.local_roots import validate_records as validate_local_root_records
from app.core.openlist_connections import CONNECTION_FIELDS, OpenListConnectionConfig
from app.core.paths import get_data_dir

LOGGER = logging.getLogger(__name__)

BACKUP_FORMAT = "kumibak"
BACKUP_FORMAT_VERSION = 1
WATCH_FORMAT = "kumibak-watch-records"
WATCH_FORMAT_VERSION = 1
# 固定成员白名单：其它成员一律视为非法。
ALLOWED_MEMBERS = ("manifest.json", "config.json", "watch_records.json")
MANIFEST_MEMBER = "manifest.json"
CONFIG_MEMBER = "config.json"
WATCH_MEMBER = "watch_records.json"
MAX_MEMBERS = 8
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_UPLOAD_BYTES = 64 * 1024 * 1024
MAX_WATCH_ROWS = 200_000
AUTO_KEEP = 7
PREVIEW_TTL_SECONDS = 900
MAX_PREVIEWS = 8
SCOPE_INCLUDES = ("config", "sources", "watch_records")
SCOPE_EXCLUDES = ("credentials", "media_files", "artwork", "full_database")
_AUTO_STATE_FILE = "auto-backup-state.json"
_FILE_ID_PATTERN = re.compile(r"bkp_[0-9a-f]{24}")
_TEXT_FIELD_LIMIT = 512


class BackupError(ValueError):
    """归档校验失败（对应 HTTP 400，且不产生任何副作用）。"""


class BackupPreviewError(RuntimeError):
    """预览身份失效或摘要不匹配（对应 HTTP 409）。"""


def backups_root() -> Path:
    return get_data_dir() / "backups"


def _kind_dir(kind: str) -> Path:
    return backups_root() / ("manual" if kind == "manual" else "auto")


def _ensure_kind_dir(kind: str) -> Path:
    directory = _kind_dir(kind)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def scope_payload() -> dict:
    return {"includes": list(SCOPE_INCLUDES), "excludes": list(SCOPE_EXCLUDES)}


def _file_id(kind: str, path: Path) -> str:
    digest = hashlib.sha256(f"{kind}/{path.name}".encode()).hexdigest()
    return f"bkp_{digest[:24]}"


def _file_info(kind: str, path: Path) -> dict:
    stat = path.stat()
    created = datetime.fromtimestamp(stat.st_mtime, tz=UTC)
    file_id = _file_id(kind, path)
    return {
        "file_id": file_id,
        "file_name": path.name,
        "kind": kind,
        "size_bytes": int(stat.st_size),
        "created_at": created.isoformat(),
        "download_url": f"/api/backup/files/{file_id}/download",
    }


def _write_bytes_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        last_error: OSError | None = None
        for attempt in range(5):
            try:
                os.replace(temp_name, path)
                return
            except OSError as exc:  # Windows 瞬时文件锁，重试后通常成功
                last_error = exc
                if attempt + 1 < 5:
                    import time as _time

                    _time.sleep(0.05)
        raise last_error if last_error is not None else RuntimeError("备份原子替换未执行")
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def _config_payload() -> dict:
    """导出配置：所有凭据字段（含 OpenList 连接）显式置空。"""

    payload = asdict(load_config())
    for key in CREDENTIAL_FIELD_NAMES:
        if key in payload:
            payload[key] = ""
    for record in payload.get("openlist_connections") or []:
        if isinstance(record, dict):
            record["openlist_username"] = ""
            record["openlist_password"] = ""
    return payload


def _watch_records(database) -> dict:
    """导出观看记录：进度、历史、本地观看状态与人工观看选择。"""

    with database.connect() as conn:
        # 读事务内导出，保证同一份备份里的观看记录来自一致快照。
        conn.execute("BEGIN")
        progress = [
            {
                "work_id": str(row["work_id"]),
                "episode_id": str(row["episode_id"]),
                "asset_id": str(row["asset_id"]),
                "position": float(row["position"] or 0.0),
                "duration": float(row["duration"] or 0.0),
                "completed": bool(row["completed"]),
                "updated_at": str(row["updated_at"] or ""),
            }
            for row in conn.execute(
                "SELECT work_id, episode_id, asset_id, position, duration, completed, updated_at "
                "FROM playback_progress ORDER BY work_id, episode_id, asset_id"
            )
        ]
        history = [
            {
                "event_id": str(row["event_id"]),
                "work_id": str(row["work_id"]),
                "episode_id": str(row["episode_id"] or ""),
                "asset_id": str(row["asset_id"] or ""),
                "played_at": str(row["played_at"] or ""),
                "title_snapshot": str(row["title_snapshot"] or ""),
                "season_snapshot": str(row["season_snapshot"] or ""),
                "episode_snapshot": str(row["episode_snapshot"] or ""),
                "source_provider": str(row["source_provider"] or ""),
            }
            for row in conn.execute(
                "SELECT event_id, work_id, episode_id, asset_id, played_at, title_snapshot, "
                "season_snapshot, episode_snapshot, source_provider FROM playback_history "
                "ORDER BY played_at, event_id"
            )
        ]
        watch_status = []
        for row in conn.execute(
            "SELECT work_id, provider_id, last_watched_episode, metadata_json, updated_at "
            "FROM tracking_states WHERE provider = 'local' ORDER BY work_id"
        ):
            try:
                metadata = json.loads(row["metadata_json"] or "{}")
            except (TypeError, ValueError):
                metadata = {}
            if not isinstance(metadata, dict):
                metadata = {}
            watch_status.append({
                "work_id": str(row["work_id"]),
                "status": str(metadata.get("status") or ""),
                "note": str(metadata.get("note") or ""),
                "favorite": bool(metadata.get("favorite")),
                "last_watched_episode": row["last_watched_episode"],
                "updated_at": str(row["updated_at"] or ""),
            })
        overrides = []
        for row in conn.execute("SELECT work_id, override_json FROM work_overrides ORDER BY work_id"):
            try:
                payload = json.loads(row["override_json"] or "{}")
            except (TypeError, ValueError):
                continue
            if not isinstance(payload, dict):
                continue
            states = payload.get("episode_watch_state")
            changed = payload.get("episode_watch_updated_at")
            states = {str(k): v for k, v in states.items() if isinstance(v, bool)} if isinstance(states, dict) else {}
            if not states:
                continue
            changed = {str(k): str(v) for k, v in changed.items()} if isinstance(changed, dict) else {}
            overrides.append({
                "work_id": str(row["work_id"]),
                "episode_watch_state": states,
                "episode_watch_updated_at": changed,
            })
    return {
        "format": WATCH_FORMAT,
        "format_version": WATCH_FORMAT_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "progress": progress,
        "history": history,
        "watch_status": watch_status,
        "overrides": overrides,
    }


def _build_archive_bytes(config_payload: dict, watch_payload: dict, *, created_at: datetime,
                         schema_version: int) -> bytes:
    members = {
        CONFIG_MEMBER: json.dumps(config_payload, ensure_ascii=False, indent=2).encode("utf-8"),
        WATCH_MEMBER: json.dumps(watch_payload, ensure_ascii=False, indent=2).encode("utf-8"),
    }
    manifest = {
        "format": BACKUP_FORMAT,
        "format_version": BACKUP_FORMAT_VERSION,
        "created_at": created_at.isoformat(),
        "app_version": "2.0.0",
        "schema_version": int(schema_version),
        "scope": list(SCOPE_INCLUDES),
        "excludes": list(SCOPE_EXCLUDES),
        "members": [
            {
                "name": name,
                "size_bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest(),
            }
            for name, payload in sorted(members.items())
        ],
    }
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(MANIFEST_MEMBER, json.dumps(manifest, ensure_ascii=False, indent=2))
        for name, payload in sorted(members.items()):
            archive.writestr(name, payload)
    return buffer.getvalue()


def create_backup(database, kind: str = "manual", *, created_at: datetime | None = None) -> dict:
    """生成一份备份文件并返回其元数据（不返回任何凭据或绝对路径）。"""

    from app.media_v4.persistence.schema_v4 import V4_SCHEMA_VERSION

    stamp = created_at or datetime.now(UTC)
    payload = _build_archive_bytes(
        _config_payload(),
        _watch_records(database),
        created_at=stamp,
        schema_version=V4_SCHEMA_VERSION,
    )
    directory = _ensure_kind_dir(kind)
    file_name = f"kumiplayer-backup-{stamp.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.kumibak"
    path = directory / file_name
    _write_bytes_atomic(path, payload)
    if kind != "manual":
        _rotate_auto_backups()
    return _file_info(kind, path)


def list_backups() -> list[dict]:
    files: list[dict] = []
    for kind in ("manual", "auto"):
        directory = _kind_dir(kind)
        if not directory.is_dir():
            continue
        for path in directory.glob("*.kumibak"):
            if path.is_file():
                files.append(_file_info(kind, path))
    files.sort(key=lambda item: (item["created_at"], item["file_name"]), reverse=True)
    return files


def resolve_backup_file(file_id: str) -> Path:
    if not _FILE_ID_PATTERN.fullmatch(str(file_id or "")):
        raise KeyError(file_id)
    for kind in ("manual", "auto"):
        directory = _kind_dir(kind)
        if not directory.is_dir():
            continue
        for path in directory.glob("*.kumibak"):
            if path.is_file() and _file_id(kind, path) == file_id:
                return path
    raise KeyError(file_id)


def _rotate_auto_backups() -> None:
    directory = _kind_dir("auto")
    if not directory.is_dir():
        return
    # 文件名内嵌时间戳，字典序即时间序；只删除 auto 目录内的更早备份。
    candidates = sorted(path for path in directory.glob("*.kumibak") if path.is_file())
    for path in candidates[: max(0, len(candidates) - AUTO_KEEP)]:
        try:
            path.unlink()
        except OSError:
            LOGGER.warning("自动备份轮换未删除过期文件（%s）", path.name)


# ── 只读校验 ────────────────────────────────────────────────────────────────

def _unsafe_member_name(name: str) -> bool:
    if not name or name.startswith(("/", "\\")):
        return True
    if "\\" in name or ".." in name.split("/"):
        return True
    return bool(re.match(r"^[A-Za-z]:", name))


def _read_member(archive: zipfile.ZipFile, info: zipfile.ZipInfo) -> bytes:
    # ZipInfo.file_size 可以被伪造，必须按真实解压字节数设界。
    with archive.open(info) as handle:
        data = handle.read(MAX_MEMBER_BYTES + 1)
    if len(data) > MAX_MEMBER_BYTES:
        raise BackupError("归档成员超过解压大小上限")
    return data


def _parse_json_member(members: dict, name: str) -> dict:
    try:
        payload = json.loads(members[name].decode("utf-8"))
    except (KeyError, UnicodeDecodeError, ValueError):
        raise BackupError("备份内容无法解析") from None
    if not isinstance(payload, dict):
        raise BackupError("备份内容无法解析")
    return payload


def _require_text(item: dict, key: str, *, limit: int = _TEXT_FIELD_LIMIT) -> str:
    value = item.get(key)
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > limit:
        raise BackupError("备份内容无法解析")
    return value


def _require_list(payload: dict, key: str) -> list:
    value = payload.get(key)
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_WATCH_ROWS:
        raise BackupError("备份内容无法解析")
    return value


def _validate_watch_records(payload: dict) -> dict:
    if str(payload.get("format") or "") != WATCH_FORMAT:
        raise BackupError("备份内容无法解析")
    try:
        if int(payload.get("format_version") or 0) > WATCH_FORMAT_VERSION:
            raise BackupError("归档版本高于当前程序，请升级 KumiPlayer")
    except (TypeError, ValueError):
        raise BackupError("备份内容无法解析") from None
    progress = []
    for item in _require_list(payload, "progress"):
        if not isinstance(item, dict):
            raise BackupError("备份内容无法解析")
        try:
            position = float(item.get("position") or 0.0)
            duration = float(item.get("duration") or 0.0)
        except (TypeError, ValueError):
            raise BackupError("备份内容无法解析") from None
        if not isinstance(item.get("completed"), bool):
            raise BackupError("备份内容无法解析")
        progress.append({
            "work_id": _require_text(item, "work_id"),
            "episode_id": _require_text(item, "episode_id"),
            "asset_id": _require_text(item, "asset_id"),
            "position": position,
            "duration": duration,
            "completed": bool(item["completed"]),
            "updated_at": _require_text(item, "updated_at"),
        })
    history = []
    for item in _require_list(payload, "history"):
        if not isinstance(item, dict):
            raise BackupError("备份内容无法解析")
        event_id = _require_text(item, "event_id")
        if not event_id:
            raise BackupError("备份内容无法解析")
        history.append({
            "event_id": event_id,
            "work_id": _require_text(item, "work_id"),
            "episode_id": _require_text(item, "episode_id"),
            "asset_id": _require_text(item, "asset_id"),
            "played_at": _require_text(item, "played_at"),
            "title_snapshot": _require_text(item, "title_snapshot"),
            "season_snapshot": _require_text(item, "season_snapshot"),
            "episode_snapshot": _require_text(item, "episode_snapshot"),
            "source_provider": _require_text(item, "source_provider"),
        })
    watch_status = []
    for item in _require_list(payload, "watch_status"):
        if not isinstance(item, dict):
            raise BackupError("备份内容无法解析")
        last = item.get("last_watched_episode")
        if last is not None and (isinstance(last, bool) or not isinstance(last, int)):
            raise BackupError("备份内容无法解析")
        watch_status.append({
            "work_id": _require_text(item, "work_id"),
            "status": _require_text(item, "status", limit=32),
            "note": _require_text(item, "note"),
            "favorite": bool(item.get("favorite", False)),
            "last_watched_episode": last,
            "updated_at": _require_text(item, "updated_at"),
        })
    overrides = []
    for item in _require_list(payload, "overrides"):
        if not isinstance(item, dict):
            raise BackupError("备份内容无法解析")
        states = item.get("episode_watch_state")
        if states is None:
            states = {}
        if not isinstance(states, dict) or any(not isinstance(value, bool) for value in states.values()):
            raise BackupError("备份内容无法解析")
        changed = item.get("episode_watch_updated_at")
        if changed is None:
            changed = {}
        if not isinstance(changed, dict) or any(
            not isinstance(key, str) or not isinstance(value, str) for key, value in changed.items()
        ):
            raise BackupError("备份内容无法解析")
        overrides.append({
            "work_id": _require_text(item, "work_id"),
            "episode_watch_state": {str(key): bool(value) for key, value in states.items()},
            "episode_watch_updated_at": {str(key): str(value) for key, value in changed.items()},
        })
    return {
        "format": WATCH_FORMAT,
        "format_version": WATCH_FORMAT_VERSION,
        "progress": progress,
        "history": history,
        "watch_status": watch_status,
        "overrides": overrides,
    }


def inspect_archive(raw: bytes) -> dict:
    """只读校验归档，返回 manifest / config / watch 三份已解析内容。"""

    if not raw:
        raise BackupError("备份文件为空")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise BackupError("备份文件超过上传大小上限")
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
    except (zipfile.BadZipFile, OSError):
        raise BackupError("归档格式不受支持") from None
    with archive:
        infos = archive.infolist()
        if len(infos) > MAX_MEMBERS:
            raise BackupError("归档成员数量超过上限")
        members: dict[str, bytes] = {}
        total = 0
        for info in infos:
            name = str(info.filename or "")
            if info.is_dir() or _unsafe_member_name(name) or name not in ALLOWED_MEMBERS:
                raise BackupError("归档成员非法")
            if name in members:
                raise BackupError("归档成员重复")
            data = _read_member(archive, info)
            total += len(data)
            if total > MAX_TOTAL_BYTES:
                raise BackupError("归档解压大小超过上限")
            members[name] = data
    for required in (MANIFEST_MEMBER, CONFIG_MEMBER, WATCH_MEMBER):
        if required not in members:
            raise BackupError("归档缺少必要成员")
    manifest = _parse_json_member(members, MANIFEST_MEMBER)
    if str(manifest.get("format") or "") != BACKUP_FORMAT:
        raise BackupError("归档格式不受支持")
    try:
        format_version = int(manifest.get("format_version") or 0)
        schema_version = int(manifest.get("schema_version") or 0)
    except (TypeError, ValueError):
        raise BackupError("备份内容无法解析") from None
    if format_version > BACKUP_FORMAT_VERSION:
        raise BackupError("归档版本高于当前程序，请升级 KumiPlayer")
    from app.media_v4.persistence.schema_v4 import V4_SCHEMA_VERSION

    if schema_version > V4_SCHEMA_VERSION:
        raise BackupError("归档来自更高的媒体库结构版本，请升级 KumiPlayer")
    declared: dict[str, dict] = {}
    for entry in manifest.get("members") or []:
        if not isinstance(entry, dict):
            raise BackupError("备份内容无法解析")
        declared[str(entry.get("name") or "")] = entry
    expected = {name for name in members if name != MANIFEST_MEMBER}
    if set(declared) != expected:
        raise BackupError("归档成员与清单不一致")
    for name in sorted(expected):
        entry = declared[name]
        try:
            size = int(str(entry.get("size_bytes")))
        except (TypeError, ValueError):
            raise BackupError("备份内容无法解析") from None
        digest = hashlib.sha256(members[name]).hexdigest()
        if size != len(members[name]) or str(entry.get("sha256") or "") != digest:
            raise BackupError("归档摘要不匹配")
    return {
        "manifest": manifest,
        "config": _parse_json_member(members, CONFIG_MEMBER),
        "watch": _validate_watch_records(_parse_json_member(members, WATCH_MEMBER)),
    }


# ── 恢复计划（预览阶段，全部只读）──────────────────────────────────────────

_CONNECTION_KEYS = frozenset(CONNECTION_FIELDS) | {"connection_id", "name", "connector_type"}
# 遗留镜像字段不参与恢复：连接级路由已经覆盖它，直接写回会破坏 dataclass 结构。
_IGNORED_CONFIG_FIELDS = frozenset({"openlist_routes", "local_root"})


def _merge_openlist_connections(current) -> Callable[[object], list | None]:
    """按连接标识合并 OpenList 连接；未携带的凭据保持本机现有值。"""

    def merge(value):
        from app.integrations.openlist.providers import OpenListRouteConfig

        if not isinstance(value, list):
            return None
        existing = {record.connection_id: record for record in current.openlist_connections}
        merged = []
        for item in value:
            if not isinstance(item, dict):
                return None
            record = {key: item[key] for key in item if key in _CONNECTION_KEYS}
            record["openlist_username"] = ""
            record["openlist_password"] = ""
            routes = item.get("openlist_routes") or []
            if not isinstance(routes, list):
                return None
            try:
                record["openlist_routes"] = [
                    OpenListRouteConfig(**route) for route in routes if isinstance(route, dict)
                ]
                candidate = OpenListConnectionConfig(**record)
            except (TypeError, ValueError):
                return None
            kept = existing.get(candidate.connection_id)
            if kept is not None:
                # 凭据按连接标识保留，不隐式清除也不隐式覆盖。
                candidate.openlist_username = kept.openlist_username
                candidate.openlist_password = kept.openlist_password
            merged.append(candidate)
        return merged

    return merge


def config_plan(raw_config: dict) -> dict:
    """把备份配置转成可安全恢复的字段改动；凭据与遗留镜像字段永不恢复。"""

    current = load_config()
    valid = {field.name for field in dataclass_fields(AppConfig)}
    merge_connections = _merge_openlist_connections(current)
    changes: dict = {}
    ignored: list[str] = []
    source_changes: list[dict] = []
    for key, value in raw_config.items():
        if key in CREDENTIAL_FIELD_NAMES or key in _IGNORED_CONFIG_FIELDS:
            continue
        if key not in valid:
            ignored.append(key)
            continue
        if key == "openlist_connections":
            merged = merge_connections(value)
            if merged is None:
                ignored.append(key)
                continue
            changes[key] = merged
            source_changes.append({"field": key, "action": "replace"})
            continue
        if key == "local_roots":
            try:
                changes[key] = validate_local_root_records(value)
            except ValueError:
                ignored.append(key)
                continue
            source_changes.append({"field": key, "action": "replace"})
            continue
        if key == "source_scan_schedules":
            try:
                changes[key] = validate_source_scan_schedules(value)
            except ValueError:
                ignored.append(key)
            continue
        if key == "completed_threshold_percent":
            changes[key] = normalize_completed_threshold(value)
            continue
        if key == "backup_auto_daily_time":
            changes[key] = normalize_backup_time(value)
            continue
        expected = type(getattr(current, key, None))
        accepted = (
            (expected is bool and isinstance(value, bool))
            or (expected is int and isinstance(value, int) and not isinstance(value, bool))
            or (expected is str and isinstance(value, str))
            or (expected is list and isinstance(value, list))
        )
        if accepted:
            changes[key] = value
        else:
            ignored.append(key)
    for key in ("pan115_root", "baidu_root", "quark_root", "directory_tree_dir", "local_roots"):
        if key in changes:
            source_changes.append({"field": key, "action": "replace"})
    deduped_sources = []
    for entry in source_changes:
        if entry not in deduped_sources:
            deduped_sources.append(entry)
    return {"changes": changes, "changed_fields": sorted(changes), "ignored_fields": sorted(set(ignored)),
            "source_changes": deduped_sources}


def _confirmed_progress_binding(conn, work_id: str, episode_id: str, asset_id: str) -> bool:
    if episode_id == f"movie:{work_id}":
        row = conn.execute(
            "SELECT 1 FROM revision_bindings rb JOIN import_revisions ir ON ir.revision_id = rb.revision_id "
            "WHERE rb.work_id = ? AND rb.episode_id IS NULL AND rb.asset_id = ? AND ir.status = 'confirmed' LIMIT 1",
            (work_id, asset_id),
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT 1 FROM revision_bindings rb JOIN import_revisions ir ON ir.revision_id = rb.revision_id "
            "WHERE rb.work_id = ? AND rb.episode_id = ? AND rb.asset_id = ? AND ir.status = 'confirmed' LIMIT 1",
            (work_id, episode_id, asset_id),
        ).fetchone()
    return row is not None


def _work_confirmed(conn, work_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM revision_bindings rb JOIN import_revisions ir ON ir.revision_id = rb.revision_id "
        "WHERE rb.work_id = ? AND ir.status = 'confirmed' LIMIT 1",
        (work_id,),
    ).fetchone()
    return row is not None


def _confirmed_episode_binding(conn, work_id: str, episode_id: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM revision_bindings rb JOIN import_revisions ir ON ir.revision_id = rb.revision_id "
        "WHERE rb.work_id = ? AND rb.episode_id = ? AND ir.status = 'confirmed' LIMIT 1",
        (work_id, episode_id),
    ).fetchone()
    return row is not None


def _watch_plan(database, payload: dict) -> dict:
    """把观看记录映射到当前库中的真实身份；孤立身份只报告，不猜测合并。"""

    progress_rows: list[tuple] = []
    history_rows: list[tuple] = []
    status_rows: list[tuple] = []
    override_rows: list[tuple] = []
    orphans: list[dict] = []
    with database.connect() as conn:
        conn.execute("BEGIN")
        for item in payload["progress"]:
            if not item["work_id"] or not item["episode_id"] or not item["asset_id"]:
                orphans.append({"kind": "progress", "work_id": item["work_id"], "episode_id": item["episode_id"],
                                "asset_id": item["asset_id"]})
                continue
            if not _confirmed_progress_binding(conn, item["work_id"], item["episode_id"], item["asset_id"]):
                orphans.append({"kind": "progress", "work_id": item["work_id"], "episode_id": item["episode_id"],
                                "asset_id": item["asset_id"]})
                continue
            progress_rows.append((
                item["episode_id"], item["asset_id"], item["work_id"], item["position"], item["duration"],
                int(item["completed"]), item["updated_at"] or datetime.now(UTC).isoformat(),
            ))
        for item in payload["history"]:
            if not item["work_id"] or not _work_confirmed(conn, item["work_id"]):
                orphans.append({"kind": "history", "work_id": item["work_id"], "episode_id": item["episode_id"],
                                "asset_id": item["asset_id"]})
                continue
            history_rows.append((
                item["event_id"], item["work_id"], item["episode_id"], item["asset_id"],
                item["played_at"] or datetime.now(UTC).isoformat(), item["title_snapshot"],
                item["season_snapshot"], item["episode_snapshot"], item["source_provider"],
            ))
        for item in payload["watch_status"]:
            if not item["work_id"] or not _work_confirmed(conn, item["work_id"]):
                orphans.append({"kind": "watch_status", "work_id": item["work_id"], "episode_id": "", "asset_id": ""})
                continue
            metadata = json.dumps(
                {"status": item["status"], "note": item["note"], "favorite": item["favorite"]},
                ensure_ascii=False, sort_keys=True,
            )
            status_rows.append((
                item["work_id"], item["last_watched_episode"], metadata,
                item["updated_at"] or datetime.now(UTC).isoformat(),
            ))
        for item in payload["overrides"]:
            work_id = item["work_id"]
            if not work_id or not _work_confirmed(conn, work_id):
                orphans.append({"kind": "overrides", "work_id": work_id, "episode_id": "", "asset_id": ""})
                continue
            states = {
                episode_id: value
                for episode_id, value in item["episode_watch_state"].items()
                if _confirmed_episode_binding(conn, work_id, episode_id)
            }
            missing = len(item["episode_watch_state"]) - len(states)
            if missing:
                orphans.append({"kind": "overrides", "work_id": work_id, "episode_id": "", "asset_id": ""})
            if states:
                override_rows.append((
                    work_id, states,
                    {episode_id: item["episode_watch_updated_at"].get(episode_id, "")
                     for episode_id in states},
                ))
    matched = len(progress_rows) + len(history_rows) + len(status_rows) + len(override_rows)
    return {
        "apply": {"progress": progress_rows, "history": history_rows,
                  "watch_status": status_rows, "overrides": override_rows},
        "orphans": orphans,
        "counts": {
            "progress": len(progress_rows), "history": len(history_rows),
            "watch_status": len(status_rows), "overrides": len(override_rows),
        },
        "declared": {
            "progress": len(payload["progress"]), "history": len(payload["history"]),
            "watch_status": len(payload["watch_status"]), "overrides": len(payload["overrides"]),
        },
        "matched": matched,
    }


# ── 预览身份登记 ────────────────────────────────────────────────────────────

_preview_lock = threading.Lock()
_previews: dict[str, dict] = {}


def _store_preview(preview: dict) -> None:
    with _preview_lock:
        now = datetime.now(UTC)
        for key, value in list(_previews.items()):
            if value["expires_at"] <= now:
                _previews.pop(key, None)
        while len(_previews) >= MAX_PREVIEWS:
            oldest = min(_previews, key=lambda key: _previews[key]["created_at"])
            _previews.pop(oldest, None)
        _previews[preview["preview_id"]] = preview


def _claim_preview(preview_id: str, digest: str) -> dict:
    with _preview_lock:
        preview = _previews.get(str(preview_id or ""))
        if preview is None or preview["expires_at"] <= datetime.now(UTC):
            _previews.pop(str(preview_id or ""), None)
            raise BackupPreviewError("预览已失效，请重新选择备份文件")
        if not hmac.compare_digest(str(digest or ""), preview["digest"]):
            raise BackupPreviewError("备份摘要与预览不一致，请重新选择备份文件")
        return preview


def _public_orphans(orphans: list[dict], limit: int = 50) -> list[dict]:
    return orphans[:limit]


def preview_restore(database, raw: bytes) -> dict:
    """只读校验 + 影响预览；不写库、不写配置。"""

    inspected = inspect_archive(raw)
    plan = config_plan(inspected["config"])
    watch = _watch_plan(database, inspected["watch"])
    now = datetime.now(UTC)
    preview_id = "prev_" + uuid.uuid4().hex
    digest = hashlib.sha256(raw).hexdigest()
    manifest = inspected["manifest"]
    _store_preview({
        "preview_id": preview_id,
        "digest": digest,
        "created_at": now,
        "expires_at": now + timedelta(seconds=PREVIEW_TTL_SECONDS),
        "changes": plan["changes"],
        "watch": watch["apply"],
        "counts": watch["counts"],
        "orphans": watch["orphans"],
    })
    return {
        "ok": True,
        "preview_id": preview_id,
        "digest": digest,
        "backup": {
            "created_at": str(manifest.get("created_at") or ""),
            "app_version": str(manifest.get("app_version") or ""),
            "schema_version": int(manifest.get("schema_version") or 0),
            "format_version": int(manifest.get("format_version") or 0),
            "scope": list(manifest.get("scope") or SCOPE_INCLUDES),
        },
        "config": {
            "changed_fields": plan["changed_fields"],
            "ignored_fields": plan["ignored_fields"],
            "source_changes": plan["source_changes"],
        },
        "watch_records": {
            **watch["counts"],
            "declared": watch["declared"],
            "matched": watch["matched"],
            "orphans": len(watch["orphans"]),
        },
        "orphans": _public_orphans(watch["orphans"]),
        "credentials": {"included": False, "note": "备份不含凭据；恢复不会清除本机现有凭据"},
        "expires_at": (now + timedelta(seconds=PREVIEW_TTL_SECONDS)).isoformat(),
    }


# ── 恢复应用（配置 + 观看记录，失败回滚）────────────────────────────────────

def _apply_watch_records(database, plan: dict) -> dict:
    """在单一事务内回写观看记录；任何异常都整体回滚。"""

    from app.media_v4.projection.changes import record_change

    applied = {"progress": 0, "history": 0, "watch_status": 0, "overrides": 0}
    touched: set[str] = set()
    with database.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        for episode_id, asset_id, work_id, position, duration, completed, updated_at in plan["progress"]:
            conn.execute(
                "INSERT INTO playback_progress(episode_id, asset_id, work_id, position, duration, completed, updated_at) "
                "VALUES (?,?,?,?,?,?,?) ON CONFLICT(episode_id, asset_id) DO UPDATE SET "
                "work_id = excluded.work_id, position = excluded.position, duration = excluded.duration, "
                "completed = excluded.completed, updated_at = excluded.updated_at",
                (episode_id, asset_id, work_id, position, duration, completed, updated_at),
            )
            applied["progress"] += 1
            touched.add(work_id)
        for row in plan["history"]:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO playback_history(event_id, work_id, episode_id, asset_id, played_at, "
                "title_snapshot, season_snapshot, episode_snapshot, source_provider) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                row,
            )
            if cursor.rowcount > 0:
                applied["history"] += 1
                touched.add(str(row[1]))
        for work_id, last_watched_episode, metadata_json, updated_at in plan["watch_status"]:
            conn.execute(
                "INSERT INTO tracking_states(work_id, provider, provider_id, last_watched_episode, "
                "metadata_json, updated_at) VALUES (?, 'local', '', ?, ?, ?) "
                "ON CONFLICT(work_id, provider) DO UPDATE SET "
                "last_watched_episode = excluded.last_watched_episode, "
                "metadata_json = excluded.metadata_json, updated_at = excluded.updated_at",
                (work_id, last_watched_episode, metadata_json, updated_at),
            )
            applied["watch_status"] += 1
            touched.add(work_id)
        for work_id, states, changed in plan["overrides"]:
            existing = conn.execute(
                "SELECT override_json FROM work_overrides WHERE work_id = ?", (work_id,)
            ).fetchone()
            try:
                payload = json.loads(existing["override_json"]) if existing else {}
            except (TypeError, ValueError):
                payload = {}
            if not isinstance(payload, dict):
                payload = {}
            merged_states = payload.get("episode_watch_state")
            merged_states = dict(merged_states) if isinstance(merged_states, dict) else {}
            merged_states.update(states)
            merged_changed = payload.get("episode_watch_updated_at")
            merged_changed = dict(merged_changed) if isinstance(merged_changed, dict) else {}
            merged_changed.update(changed)
            payload["episode_watch_state"] = merged_states
            payload["episode_watch_updated_at"] = merged_changed
            stamp = datetime.now(UTC).isoformat()
            conn.execute(
                "INSERT INTO work_overrides(work_id, override_json, created_at, updated_at) VALUES (?,?,?,?) "
                "ON CONFLICT(work_id) DO UPDATE SET override_json = excluded.override_json, "
                "updated_at = excluded.updated_at",
                (work_id, json.dumps(payload, ensure_ascii=False), stamp, stamp),
            )
            applied["overrides"] += len(states)
            touched.add(work_id)
        for work_id in sorted(touched):
            record_change(conn, "watch", work_id)
    return applied


def _restore_config_snapshot(previous: AppConfig) -> None:
    try:
        save_config(copy.deepcopy(previous))
    except Exception:
        LOGGER.critical("恢复失败后未能回滚配置快照，请检查 data/config.json")


def apply_restore(database, preview_id: str, digest: str) -> dict:
    """按服务端预览身份应用恢复；配置或观看记录任一失败则回滚配置。"""

    preview = _claim_preview(preview_id, digest)
    previous = copy.deepcopy(load_config())
    if preview["changes"]:
        update_config(copy.deepcopy(preview["changes"]))
    try:
        applied = _apply_watch_records(database, preview["watch"])
    except Exception:
        _restore_config_snapshot(previous)
        raise
    orphans = preview["orphans"]
    return {
        "ok": True,
        "applied": {
            "config_fields": sorted(preview["changes"]),
            "watch_records": applied,
            "orphans": _public_orphans(orphans),
        },
        "message": "备份已恢复；孤立身份已列在报告中，未做猜测合并" if orphans else "备份已恢复",
    }


# ── 自动备份（应用运行时调度）───────────────────────────────────────────────

def _auto_state() -> dict:
    path = backups_root() / _AUTO_STATE_FILE
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _save_auto_state(state: dict) -> None:
    write_json_atomic(backups_root() / _AUTO_STATE_FILE, state)


def auto_backup_status(*, now: datetime | None = None) -> dict:
    config = load_config()
    enabled = bool(getattr(config, "backup_auto_daily_enabled", False))
    time_text = normalize_backup_time(getattr(config, "backup_auto_daily_time", "03:00"))
    state = _auto_state()
    next_run = ""
    if enabled:
        local = (now or datetime.now(UTC)).astimezone()
        target = local.replace(hour=int(time_text[:2]), minute=int(time_text[3:5]), second=0, microsecond=0)
        if local >= target:
            target += timedelta(days=1)
        next_run = target.isoformat()
    return {
        "enabled": enabled,
        "time": time_text,
        "keep": AUTO_KEEP,
        "last_run_at": str(state.get("last_run_at") or ""),
        "next_run_at": next_run,
        "last_status": str(state.get("last_status") or ""),
        "last_error": str(state.get("last_error") or ""),
        "last_file_id": str(state.get("last_file_id") or ""),
    }


def run_due_auto_backup(*, now: datetime | None = None, database=None) -> dict | None:
    """到点则执行一次自动备份；同一天只执行一次（成功或失败都记账）。"""

    config = load_config()
    if not bool(getattr(config, "backup_auto_daily_enabled", False)):
        return None
    time_text = normalize_backup_time(getattr(config, "backup_auto_daily_time", "03:00"))
    stamp = now or datetime.now(UTC)
    local = stamp.astimezone()
    state = _auto_state()
    slot = local.date().isoformat()
    if str(state.get("last_slot") or "") == slot:
        return None
    if (local.hour, local.minute) < (int(time_text[:2]), int(time_text[3:5])):
        return None
    if database is None:
        from app.media_v4.runtime import get_database

        database = get_database()
    entry = {"last_slot": slot, "last_run_at": stamp.isoformat()}
    try:
        info = create_backup(database, kind="auto", created_at=stamp)
        entry.update(last_status="ok", last_error="", last_file_id=info["file_id"])
    except Exception as exc:
        # 只记录异常类型，避免把本地路径或凭据写进状态文件。
        LOGGER.warning("自动备份失败（%s）", type(exc).__name__)
        entry.update(last_status="failed", last_error=type(exc).__name__, last_file_id="")
    state.update(entry)
    _save_auto_state(state)
    return entry
