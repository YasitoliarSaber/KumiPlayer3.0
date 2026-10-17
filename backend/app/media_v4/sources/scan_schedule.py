"""按稳定来源标识（source_roots.root_id）的定时扫描调度。

复用持久 SourceScan 与既有追更规则：调度只是把来源交给原有扫描入口，
不重新识别来源、不新建执行链、不伪造进度百分比。
树快照（纯 TXT）来源不可自动刷新，必须由用户提供新的 TXT 导出。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.core.config import load_config, normalize_source_scan_schedules
from app.media_v4.persistence.database import V4Database
from app.media_v4.tracking.refresh import list_refresh_sources, refresh_all_sources

_META_PREFIX = "source_scan_schedule:"
_ACTIVE_SCAN_STATUSES = ("queued", "running", "paused", "cancelling")
_CANCELABLE_SCAN_STATUSES = frozenset({"queued", "running", "paused"})


def _parse_stamp(value: object) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def _read_meta(database: V4Database, key: str) -> str:
    with database.connect() as conn:
        row = conn.execute("SELECT value FROM v4_meta WHERE key = ?", (key,)).fetchone()
    return str(row["value"]) if row else ""


def last_run_at(database: V4Database, root_id: str) -> str:
    return _read_meta(database, _META_PREFIX + str(root_id))


def record_run(database: V4Database, root_id: str, stamp: datetime) -> None:
    with database.connect() as conn:
        conn.execute(
            "INSERT INTO v4_meta(key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (_META_PREFIX + str(root_id), stamp.isoformat()),
        )


def configured_schedules(config) -> dict[str, dict]:
    """读取并规范化配置中的调度记录（按 root_id 去重）。"""

    records = normalize_source_scan_schedules(getattr(config, "source_scan_schedules", []) or [])
    return {record["root_id"]: record for record in records}


def due_root_ids(
    database: V4Database,
    schedules: dict[str, dict],
    *,
    now: datetime | None = None,
) -> list[str]:
    """返回当前到期且来源仍活动的 root_id（按稳定来源标识排序）。"""

    stamp = now or datetime.now(UTC)
    with database.connect() as conn:
        active = {
            str(row["root_id"])
            for row in conn.execute(
                "SELECT root_id FROM source_roots WHERE enabled = 1 AND retired_at = ''"
            ).fetchall()
        }
    due = []
    for root_id in sorted(schedules):
        record = schedules[root_id]
        if not record.get("enabled") or root_id not in active:
            continue
        previous = _parse_stamp(last_run_at(database, root_id))
        if previous is not None and stamp < previous + timedelta(minutes=int(record["interval_minutes"])):
            continue
        due.append(root_id)
    return due


def run_due_scan_schedules(
    database: V4Database,
    *,
    now: datetime | None = None,
    content_scopes: tuple[str, ...] = ("ongoing", "completed"),
) -> list[dict]:
    """执行到期调度；每个来源只登记一次扫描，繁忙/待确认来源自动跳过。"""

    schedules = configured_schedules(load_config())
    if not schedules:
        return []
    due = due_root_ids(database, schedules, now=now)
    if not due:
        return []
    # 复用既有追更/扫描链：ongoing 走追更规则，completed 只产生待确认草稿；
    # tree_snapshot 由 refresh_all_sources 返回 needs_new_txt，不伪造刷新。
    results = refresh_all_sources(
        database,
        include_scrape=True,
        content_scopes=content_scopes,
        root_ids=tuple(due),
    )
    stamp = now or datetime.now(UTC)
    for root_id in due:
        # 无论本轮是登记扫描还是被判定为待确认/需新 TXT，都记录运行时间，
        # 避免同一窗口内反复触发。
        record_run(database, root_id, stamp)
    return results


def _scan_detail(database: V4Database, root_id: str) -> dict:
    with database.connect() as conn:
        scan = conn.execute(
            """
            SELECT scan_id, status, stage, processed_count, total_count,
                   cancel_requested, started_at, finished_at, error
            FROM source_scans WHERE root_id = ?
            ORDER BY (status IN ('queued','running','paused','cancelling')) DESC,
                     generation DESC, rowid DESC
            LIMIT 1
            """,
            (root_id,),
        ).fetchone()
    if scan is None:
        return {
            "scan_id": "", "status": "", "stage": "", "started_at": "", "finished_at": "",
            "processed_count": 0, "total_count": 0,
            "can_resume": False, "can_cancel": False, "message": "",
        }
    status = str(scan["status"] or "")
    processed = int(scan["processed_count"] or 0)
    total = int(scan["total_count"] or 0)
    message = ""
    stage = str(scan["stage"] or "")
    if status == "paused":
        message = "扫描已暂停，可在媒体管理继续或取消"
    elif status in {"queued", "running"}:
        # 只报告真实已处理/总数计数，不合成连续百分比。
        message = f"已处理 {processed} 项" + (f" / 共 {total} 项" if total else "")
    elif status == "failed":
        message = "来源扫描失败，请检查来源连接后在媒体管理重试"
    elif status == "cancelled":
        message = "来源扫描已取消"
    return {
        "scan_id": str(scan["scan_id"]),
        "status": status,
        "stage": stage,
        "started_at": str(scan["started_at"] or ""),
        "finished_at": str(scan["finished_at"] or ""),
        "processed_count": processed,
        "total_count": total,
        "can_resume": status == "paused",
        "can_cancel": status in _CANCELABLE_SCAN_STATUSES,
        "message": message,
    }


def _revision_and_jobs(database: V4Database, root_id: str) -> tuple[dict, dict]:
    with database.connect() as conn:
        latest = conn.execute(
            "SELECT revision_id, created_at FROM import_revisions "
            "WHERE root_id = ? AND status = 'confirmed' ORDER BY rowid DESC LIMIT 1",
            (root_id,),
        ).fetchone()
        draft = conn.execute(
            "SELECT revision_id, created_at FROM import_revisions "
            "WHERE root_id = ? AND status = 'draft' ORDER BY rowid DESC LIMIT 1",
            (root_id,),
        ).fetchone()
        job_rows = conn.execute(
            "SELECT j.status AS status, COUNT(*) AS total FROM jobs j "
            "JOIN import_revisions ir ON ir.revision_id = j.revision_id "
            "WHERE ir.root_id = ? GROUP BY j.status",
            (root_id,),
        ).fetchall()
        latest_job = conn.execute(
            "SELECT j.job_id, j.job_type, j.status FROM jobs j "
            "JOIN import_revisions ir ON ir.revision_id = j.revision_id "
            "WHERE ir.root_id = ? ORDER BY j.created_at DESC, j.job_id DESC LIMIT 1",
            (root_id,),
        ).fetchone()
    jobs = {
        "queued": 0, "running": 0, "succeeded": 0, "failed": 0, "cancelled": 0,
        "latest_job_id": str(latest_job["job_id"]) if latest_job else "",
        "latest_job_type": str(latest_job["job_type"]) if latest_job else "",
        "latest_job_status": str(latest_job["status"]) if latest_job else "",
    }
    for row in job_rows:
        key = str(row["status"] or "")
        if key in jobs:
            jobs[key] = int(row["total"] or 0)
    revision = {
        "latest_revision_id": str(latest["revision_id"]) if latest else "",
        "draft_revision_id": str(draft["revision_id"]) if draft else "",
        "status": "needs_confirmation" if draft else ("confirmed" if latest else ""),
        "reason": "已有待确认更新，请到媒体管理查看并确认" if draft else "",
    }
    return revision, jobs


def list_scan_schedules(database: V4Database) -> list[dict]:
    """只读聚合：来源身份、扫描、revision、jobs、调度分成独立子对象。"""

    schedules = configured_schedules(load_config())
    activity = {
        item["root_id"]: item
        for item in list_refresh_sources(database, content_scopes=("ongoing", "completed"))
    }
    with database.connect() as conn:
        roots = conn.execute(
            "SELECT root_id, display_name, provider, ingest_method, source_mode, content_scope "
            "FROM source_roots WHERE enabled = 1 AND retired_at = '' "
            "ORDER BY updated_at DESC, root_id"
        ).fetchall()
    items = []
    for row in roots:
        root_id = str(row["root_id"])
        record = schedules.get(root_id)
        interval = int(record["interval_minutes"]) if record else 0
        previous = _parse_stamp(last_run_at(database, root_id))
        schedule = {
            "enabled": bool(record.get("enabled")) if record else False,
            "interval_minutes": interval,
            "last_run_at": previous.isoformat() if previous else "",
            "next_run_at": (previous + timedelta(minutes=interval)).isoformat()
            if previous and interval else "",
        }
        base = activity.get(root_id) or {}
        revision, jobs = _revision_and_jobs(database, root_id)
        items.append({
            "root_id": root_id,
            "display_name": str(row["display_name"] or root_id),
            "provider": str(row["provider"] or ""),
            "ingest_method": str(row["ingest_method"] or ""),
            "source_mode": str(row["source_mode"] or ""),
            "content_scope": str(row["content_scope"] or ""),
            "enabled": True,
            "schedule": schedule,
            "status": str(base.get("status") or "idle"),
            "reason": str(base.get("reason") or ""),
            "task_id": str(base.get("task_id") or ""),
            "activity_kind": str(base.get("activity_kind") or ""),
            "can_cancel": bool(base.get("can_cancel")),
            "scan": _scan_detail(database, root_id),
            "revision": revision,
            "jobs": jobs,
        })
    return items


def scan_schedule_item(database: V4Database, root_id: str) -> dict | None:
    return next((item for item in list_scan_schedules(database) if item["root_id"] == root_id), None)
