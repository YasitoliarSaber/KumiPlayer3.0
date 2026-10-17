"""Explicit ongoing source refresh shared by manual and scheduled triggers."""

from __future__ import annotations

import threading
import uuid
from typing import Literal

from fastapi import HTTPException

from app.media_v4.persistence.database import V4Database

_refresh_lock = threading.RLock()


def list_refresh_sources(
    database: V4Database,
    *,
    work_id: str | None = None,
    content_scopes: tuple[str, ...] = ("ongoing",),
    root_ids: tuple[str, ...] | None = None,
) -> list[dict]:
    """Read only source/revision/task summaries; never resolve credentials or files.

    ``content_scopes`` 默认只含新番（``ongoing``），保持既有追更语义；
    ``root_ids`` 用于按稳定来源标识收窄，供按来源调度复用同一状态判定。
    """

    scopes = tuple(dict.fromkeys(str(scope) for scope in content_scopes)) or ("ongoing",)
    scope_placeholders = ",".join("?" for _ in scopes)
    selected_roots = tuple(dict.fromkeys(str(root) for root in (root_ids or ()) if root))
    root_clause = ""
    params: list[str | None] = [*scopes]
    if selected_roots:
        root_clause = f" AND sr.root_id IN ({','.join('?' for _ in selected_roots)})"
        params.extend(selected_roots)
    params.extend([work_id, work_id])
    with database.connect() as conn:
        rows = conn.execute(
            f"""
            SELECT sr.* FROM source_roots sr
            WHERE sr.content_scope IN ({scope_placeholders}) AND sr.enabled = 1 AND sr.retired_at = ''
              AND EXISTS (SELECT 1 FROM import_revisions ir WHERE ir.root_id = sr.root_id AND ir.status = 'confirmed')
              {root_clause}
              AND (? IS NULL OR EXISTS (
                  SELECT 1 FROM import_revisions ir JOIN revision_bindings rb ON rb.revision_id = ir.revision_id
                  WHERE ir.root_id = sr.root_id AND ir.status = 'confirmed' AND rb.work_id = ?))
            ORDER BY sr.root_id
            """, tuple(params),
        ).fetchall()
        items = []
        for row in rows:
            root_id = row["root_id"]
            latest = conn.execute(
                "SELECT revision_id FROM import_revisions WHERE root_id = ? AND status = 'confirmed' ORDER BY rowid DESC LIMIT 1",
                (root_id,),
            ).fetchone()
            draft = conn.execute(
                "SELECT revision_id FROM import_revisions WHERE root_id = ? AND status = 'draft' ORDER BY rowid DESC LIMIT 1",
                (root_id,),
            ).fetchone()
            scan = conn.execute(
                "SELECT scan_id, status, cancel_requested FROM source_scans WHERE root_id = ? "
                "ORDER BY (status IN ('queued', 'running', 'paused', 'cancelling')) DESC, generation DESC, rowid DESC LIMIT 1",
                (root_id,),
            ).fetchone()
            jobs = {job["status"] for job in conn.execute(
                "SELECT DISTINCT status FROM jobs WHERE revision_id = ?", (latest["revision_id"],),
            ).fetchall()}
            item = {
                "root_id": root_id, "display_name": row["display_name"] or root_id,
                "provider": row["provider"], "ingest_method": row["ingest_method"],
                "source_mode": row["source_mode"], "content_scope": row["content_scope"],
                "status": "idle", "task_id": "", "reason": "", "activity_kind": "", "can_cancel": False,
                "latest_revision_id": latest["revision_id"], "draft_revision_id": draft["revision_id"] if draft else "",
            }
            if scan and scan["status"] in {"queued", "running", "paused", "cancelling"}:
                if scan["status"] == "paused":
                    item.update(status="blocked", reason="扫描已暂停，请到媒体管理继续或取消扫描")
                elif scan["cancel_requested"] or scan["status"] == "cancelling":
                    item.update(status="running", reason="正在取消扫描，请等待任务结束", activity_kind="scan")
                else:
                    item.update(status=scan["status"], task_id=scan["scan_id"], activity_kind="scan", can_cancel=True)
            elif draft:
                item.update(status="needs_confirmation", reason="已有待确认更新，请到媒体管理查看并确认")
            elif jobs & {"queued", "running"}:
                item.update(status="running", activity_kind="execution", reason="已确认更新正在整理或刮削")
            elif "failed" in jobs:
                item.update(status="failed", activity_kind="execution", reason="更新执行失败，请到媒体管理检查并重试作业")
            elif scan and scan["status"] == "failed":
                item.update(status="failed", reason="来源扫描失败，请检查来源连接并在媒体管理重试")
            elif scan and scan["status"] == "cancelled":
                item.update(status="cancelled")
            elif row["source_mode"] == "tree_snapshot":
                item.update(status="needs_new_txt", reason="此来源使用目录树 TXT，请上传新的 TXT 更新目录事实")
            elif "cancelled" in jobs:
                item.update(status="cancelled", activity_kind="execution")
            elif scan and scan["status"] == "completed":
                item.update(status="completed")
            items.append(item)
    return items


def refresh_all_sources(
    database: V4Database,
    *,
    include_scrape: bool = True,
    work_id: str | None = None,
    content_scopes: tuple[str, ...] = ("ongoing",),
    root_ids: tuple[str, ...] | None = None,
) -> list[dict]:
    """Serialize manual/startup/timer triggers and retain existing scans and previews.

    普通来源（``completed``）被显式纳入时只产生草稿 revision，新结果仍需用户确认；
    只有 ``ongoing`` 且已有已确认基线的来源按既有追更规则决定是否自动处理。
    """
    from app.api import media_v4, tracking_v4

    with _refresh_lock:
        sources = list_refresh_sources(database, work_id=work_id, content_scopes=content_scopes,
                                       root_ids=root_ids)
        results = []
        for source in sources:
            if source["status"] in {"queued", "running", "blocked", "needs_confirmation", "needs_new_txt"}:
                results.append(source)
                continue
            if source["source_mode"] == "tree_snapshot":
                source.update(status="needs_new_txt", reason="此来源使用目录树 TXT，请上传新的 TXT 更新目录事实")
                results.append(source)
                continue
            with database.connect() as conn:
                root = conn.execute("SELECT source_locator, playback_locator FROM source_roots WHERE root_id = ?",
                                    (source["root_id"],)).fetchone()
            revision_id = "rev_" + uuid.uuid4().hex
            raw_scope = str(source.get("content_scope") or "ongoing")
            source_scope: Literal["completed", "ongoing"] = (
                "ongoing" if raw_scope == "ongoing" else "completed"
            )
            try:
                if source["source_mode"] == "local":
                    result = media_v4._start_durable_local_scan(media_v4.SourceScanRequest(
                        source="local", root_path=root["source_locator"] or root["playback_locator"],
                        target_root_id=source["root_id"], content_scope=source_scope,
                        auto_update=source_scope == "ongoing" and include_scrape,
                        revision_id=revision_id, source_display_name=source["display_name"],
                    ))
                    task_id = result["scan_id"]
                elif source["source_mode"] in {"tree_openlist", "openlist_full"}:
                    result = tracking_v4._enqueue_root_incremental(
                        database, tracking_v4.load_config(), root_id=source["root_id"], remote_root=root["source_locator"],
                        include_scrape=include_scrape, revision_id=revision_id,
                    )
                    task_id = result["task_id"]
                    source["remote_root"] = root["source_locator"]
                else:
                    source.update(status="blocked", reason="此来源尚未配置支持的更新方式，请在媒体管理检查来源")
                    results.append(source)
                    continue
                source.update(status="queued", task_id=task_id, can_cancel=True, activity_kind="scan", reason="")
                with database.connect() as conn:
                    registered = conn.execute("SELECT 1 FROM source_scans WHERE scan_id = ? AND root_id = ?",
                                              (task_id, source["root_id"])).fetchone()
                if registered:
                    # Registration may reuse a scan advanced by another endpoint or the worker.
                    current = next((item for item in list_refresh_sources(database, work_id=work_id)
                                    if item["root_id"] == source["root_id"]), None)
                    if current:
                        source.update(current)
            except HTTPException as exc:
                # Only controlled API messages are surfaced; task last_error may contain credentials.
                source.update(status="blocked", reason=str(exc.detail))
            results.append(source)
        return results
