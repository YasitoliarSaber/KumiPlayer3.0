"""Read-only, bounded diagnostics for a V4 source."""

from __future__ import annotations

import json
import re
import time
from collections import defaultdict
from pathlib import Path, PureWindowsPath

from app.media_v4.sources.tree_mapping_probe import bounded_call, inspect_metadata

_MAX_DIRECTORY_SAMPLES = 3
_SECRET_NAME = r"(?:authorization|access[_-]?token|refresh[_-]?token|token|password|passwd|pwd|api[_-]?key|client[_-]?secret|secret)"
_URL_USERINFO = re.compile(r"(?i)((?:https?|ftp)://)[^/?#@\s]+@")
_QUERY_SECRET = re.compile(rf"(?i)([?&]{_SECRET_NAME}=)[^&#\r\n]*")
_KEY_VALUE_SECRET = re.compile(
    rf"(?i)([\"']?{_SECRET_NAME}[\"']?\s*[:=]\s*)"
    r"(\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|[^,;\r\n}&\]]+)"
)
_AUTH_HEADER = re.compile(r"(?i)(\bauthorization\s*[:=]\s*)(?:bearer\s+)?[^\r\n,;]+")
_BEARER = re.compile(r"(?i)\bbearer\s+[^\s,;]+")


def _safe_text(value: object, *, limit: int | None = 500) -> str:
    text = str(value or "").strip()
    text = _URL_USERINFO.sub(r"\1[已脱敏]@", text)
    text = _QUERY_SECRET.sub(r"\1[已脱敏]", text)
    text = _KEY_VALUE_SECRET.sub(lambda match: match.group(1) + '"[已脱敏]"', text)
    text = _AUTH_HEADER.sub(r"\1[已脱敏]", text)
    text = _BEARER.sub("Bearer [已脱敏]", text)
    return text if limit is None else text[:limit]


def _json_object(value: object) -> dict:
    try:
        parsed = json.loads(value or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _revision_hierarchies(conn, revision_id: str) -> dict[str, dict]:
    rows = conn.execute(
        """SELECT DISTINCT w.work_id, w.preferred_title, w.work_type,
                  s.local_season_number, s.season_kind, s.title AS season_title,
                  e.local_episode_number, e.absolute_episode_number, e.special_number,
                  e.display_title AS episode_title
           FROM revision_bindings rb
           JOIN works w ON w.work_id=rb.work_id
           LEFT JOIN seasons s ON s.season_id=rb.season_id
           LEFT JOIN episodes e ON e.episode_id=rb.episode_id
           WHERE rb.revision_id=?""",
        (revision_id,),
    ).fetchall()
    works: dict[str, dict] = {}
    seasons_by_work: dict[str, dict[tuple, dict]] = defaultdict(dict)
    episodes_by_season: dict[tuple[str, tuple], dict[tuple, dict]] = defaultdict(dict)
    for row in rows:
        work_id = str(row["work_id"])
        works.setdefault(work_id, {
            "work_id": work_id,
            "title": _safe_text(row["preferred_title"], limit=None),
            "media_type": _safe_text(row["work_type"], limit=80),
            "seasons": [],
        })
        if row["season_kind"] is None:
            continue
        season_key = (row["local_season_number"], str(row["season_kind"]), str(row["season_title"] or ""))
        season = seasons_by_work[work_id].setdefault(season_key, {
            "number": row["local_season_number"],
            "kind": _safe_text(row["season_kind"], limit=80),
            "title": _safe_text(row["season_title"], limit=None),
            "episodes": [],
        })
        if row["local_episode_number"] is None and row["absolute_episode_number"] is None and row["special_number"] is None and not row["episode_title"]:
            continue
        episode_key = (row["local_episode_number"], row["absolute_episode_number"], row["special_number"], str(row["episode_title"] or ""))
        episodes_by_season[(work_id, season_key)].setdefault(episode_key, {
            "number": row["local_episode_number"],
            "absolute_number": row["absolute_episode_number"],
            "special_number": row["special_number"],
            "title": _safe_text(row["episode_title"], limit=None),
        })
    for work_id, seasons in seasons_by_work.items():
        for season_key, season in seasons.items():
            season["episodes"] = sorted(
                episodes_by_season[(work_id, season_key)].values(),
                key=lambda item: (item["number"] is None, item["number"] or 0, item["special_number"] is None, item["special_number"] or 0, item["title"]),
            )
        works[work_id]["seasons"] = sorted(
            seasons.values(),
            key=lambda item: (item["number"] is None, item["number"] or 0, item["kind"], item["title"]),
        )
    return works


def _metadata_problems(conn, revision_id: str, hierarchies: dict[str, dict]) -> list[dict]:
    rows = conn.execute(
        """SELECT sb.work_id, sb.provider, sb.status, sb.metadata_json, sb.updated_at
           FROM scrape_bindings sb
           WHERE sb.revision_id=?
           ORDER BY sb.updated_at DESC, sb.work_id, sb.provider""",
        (revision_id,),
    ).fetchall()
    latest_by_work: dict[str, object] = {}
    for row in rows:
        latest_by_work.setdefault(str(row["work_id"]), row)

    # 成功的 scrape job 也可能以 waiting_review/not_found 等业务结果完成；
    # 只挑每部作品最新一次，且仅解析报告允许的结果字段。
    job_rows = conn.execute(
        """SELECT work_id, status, result_json, last_error, updated_at
           FROM jobs WHERE revision_id=? AND job_type='scrape_work' AND work_id<>''
           ORDER BY updated_at DESC, job_id""",
        (revision_id,),
    ).fetchall()
    latest_job_by_work: dict[str, object] = {}
    for row in job_rows:
        latest_job_by_work.setdefault(str(row["work_id"]), row)

    problems = []
    good_states = {"ready", "confirmed", "not_required", "succeeded", "success"}
    for work_id in sorted(set(latest_by_work) | set(latest_job_by_work)):
        binding = latest_by_work.get(work_id)
        job = latest_job_by_work.get(work_id)
        use_job = job is not None and (binding is None or str(job["updated_at"]) >= str(binding["updated_at"]))
        binding_payload = _json_object(binding["metadata_json"]) if binding is not None else {}
        job_payload = _json_object(job["result_json"]) if job is not None else {}
        payload = job_payload if use_job else binding_payload
        supplement = binding_payload if use_job else job_payload
        binding_status = str(binding["status"] or "") if binding is not None else ""
        job_status = str(job["status"] or "") if job is not None else ""
        metadata_state = str(payload.get("metadata_state") or payload.get("work_metadata_status") or payload.get("outcome")
                             or supplement.get("metadata_state") or supplement.get("work_metadata_status") or binding_status)
        refresh_status = str(payload.get("refresh_status") or supplement.get("refresh_status") or "")
        artifact_status = str(payload.get("artifact_status") or payload.get("artifact_state")
                              or supplement.get("artifact_status") or supplement.get("artifact_state") or "")
        reasons: list[str] = []
        for key in ("reason", "metadata_reason", "metadata_refresh_error", "last_error"):
            values = [payload.get(key), supplement.get(key)]
            if key == "last_error" and job is not None:
                values.append(job["last_error"])
            for value in values:
                if isinstance(value, str) and value.strip():
                    safe = _safe_text(value, limit=None)
                    if safe not in reasons:
                        reasons.append(safe)
        for key in ("reason_codes", "unmapped_reasons"):
            for value in (payload.get(key), supplement.get(key)):
                if isinstance(value, list):
                    for item in value:
                        if isinstance(item, str) and item.strip():
                            safe = _safe_text(item, limit=None)
                        elif isinstance(item, dict):
                            safe = _safe_text(item.get("reason") or item.get("reason_code") or item.get("message"), limit=None)
                        else:
                            continue
                        if safe and safe not in reasons:
                            reasons.append(safe)
        needs_attention = (
            metadata_state.casefold() not in good_states
            or refresh_status.casefold() in {"failed", "cancelled", "pending", "running", "retry"}
            or artifact_status.casefold() in {"failed", "degraded", "cancelled"}
            or (use_job and job_status in {"failed", "cancelled", "queued", "running"})
        )
        if not needs_attention:
            continue
        hierarchy = hierarchies.get(work_id)
        if hierarchy is None:
            row = conn.execute("SELECT work_id, preferred_title, work_type FROM works WHERE work_id=?", (work_id,)).fetchone()
            hierarchy = None if row is None else {
                "work_id": work_id,
                "title": _safe_text(row["preferred_title"], limit=None),
                "media_type": _safe_text(row["work_type"], limit=80),
                "seasons": [],
            }
        problems.append({
            "layer": "scrape_result",
            "work_id": work_id,
            "provider": _safe_text((binding["provider"] if binding is not None else payload.get("provider")), limit=80),
            "source": "scrape_job" if use_job else "scrape_binding",
            "job_status": job_status,
            "metadata_state": _safe_text(metadata_state, limit=80),
            "refresh_status": _safe_text(refresh_status, limit=80),
            "artifact_status": _safe_text(artifact_status, limit=80),
            "reason_code": _safe_text(payload.get("reason_code") or payload.get("refresh_reason_code")
                                       or supplement.get("reason_code") or supplement.get("refresh_reason_code"), limit=None),
            "reasons": reasons or [_safe_text(metadata_state or refresh_status or artifact_status or job_status or binding_status, limit=None)],
            "updated_at": _safe_text(job["updated_at"] if use_job else binding["updated_at"] if binding is not None else "", limit=80),
            "hierarchy": hierarchy,
        })
    return problems


def _unfinished_artwork(conn, revision_id: str, hierarchies: dict[str, dict]) -> list[dict]:
    rows = conn.execute(
        """SELECT b.work_id, b.subject_type, b.subject_id, b.role, b.candidate_id,
                  r.state, r.attempts, r.error_kind,
                  w.preferred_title, w.work_type,
                  s.local_season_number, s.season_kind, s.title AS season_title,
                  e.local_episode_number, e.absolute_episode_number, e.special_number,
                  e.display_title AS episode_title
           FROM artwork_bindings b
           JOIN artwork_resources r ON r.resource_id=b.candidate_id
           JOIN works w ON w.work_id=b.work_id
           LEFT JOIN episodes e ON b.subject_type='episode' AND e.episode_id=b.subject_id
           LEFT JOIN seasons s ON (b.subject_type='episode' AND s.season_id=e.season_id)
                                OR (b.subject_type='season' AND s.season_id=b.subject_id)
           WHERE b.revision_id=? AND r.state<>'ready'
           ORDER BY w.preferred_title, b.role, b.subject_type, b.subject_id, b.candidate_id""",
        (revision_id,),
    ).fetchall()
    records = []
    for row in rows:
        work_id = str(row["work_id"])
        work_hierarchy = hierarchies.get(work_id) or {
            "work_id": work_id,
            "title": _safe_text(row["preferred_title"], limit=None),
            "media_type": _safe_text(row["work_type"], limit=80),
            "seasons": [],
        }
        # The complete hierarchy is exported once at report level. Artwork rows
        # only need their subject branch, which keeps repeated episode images O(N).
        hierarchy = {
            "work_id": work_id,
            "title": work_hierarchy["title"],
            "media_type": work_hierarchy["media_type"],
            "seasons": [],
        }
        subject = {
            "type": _safe_text(row["subject_type"], limit=40),
            "role": _safe_text(row["role"], limit=80),
        }
        if row["season_kind"] is not None:
            subject["season"] = row["local_season_number"]
            subject["season_title"] = _safe_text(row["season_title"], limit=None)
            subject["season_kind"] = _safe_text(row["season_kind"], limit=80)
            season_branch = {
                "number": row["local_season_number"],
                "kind": _safe_text(row["season_kind"], limit=80),
                "title": _safe_text(row["season_title"], limit=None),
                "episodes": [],
            }
            hierarchy["seasons"].append(season_branch)
        if row["subject_type"] == "episode":
            episode_branch = {
                "number": row["local_episode_number"],
                "absolute_number": row["absolute_episode_number"],
                "special_number": row["special_number"],
                "title": _safe_text(row["episode_title"], limit=None),
            }
            subject.update({
                "episode": row["local_episode_number"],
                "absolute_episode": row["absolute_episode_number"],
                "special_number": row["special_number"],
                "episode_title": _safe_text(row["episode_title"], limit=None),
            })
            if hierarchy["seasons"]:
                hierarchy["seasons"][0]["episodes"].append(episode_branch)
        records.append({
            "layer": "artwork_resource",
            "work_id": work_id,
            "hierarchy": hierarchy,
            "subject": subject,
            "resource_id": _safe_text(row["candidate_id"], limit=160),
            "state": _safe_text(row["state"], limit=40),
            "attempts": int(row["attempts"] or 0),
            "reason": _safe_text(row["error_kind"] or row["state"], limit=None),
        })
    return records


def _path_depth(path: str) -> int:
    windows = PureWindowsPath(path)
    if windows.is_absolute() or "\\" in path:
        return len(windows.parts)
    return len(Path(path).parts)


def check_scan_directories(database, scan_id: str, *, timeout: float = 1.5) -> dict:
    """Probe up to three distinct deep parent directories using metadata only."""
    with database.connect() as conn:
        scan = conn.execute(
            "SELECT scan_id, root_id, status FROM source_scans WHERE scan_id=?",
            (scan_id,),
        ).fetchone()
        if scan is None:
            raise KeyError(scan_id)
        rows = conn.execute(
            "SELECT playback_locator FROM source_evidence "
            "WHERE scan_id=? AND entry_kind='video' AND playback_locator<>'' "
            "ORDER BY relative_path, evidence_id",
            (scan_id,),
        ).fetchall()

    distinct: dict[str, str] = {}
    has_non_local_location = False
    for row in rows:
        locator = str(row["playback_locator"] or "")
        windows = PureWindowsPath(locator)
        if re.match(r"(?i)^[a-z][a-z0-9+.-]*://", locator):
            # 网盘/HTTP 定位符无法用本地文件系统属性检查。尤其不能让
            # Path("https://...").parent 退化成当前工作目录并误报可达。
            has_non_local_location = True
            continue
        local = windows.is_absolute() or Path(locator).is_absolute()
        if not local:
            has_non_local_location = True
            continue
        parent = str(windows.parent) if windows.is_absolute() else str(Path(locator).parent)
        key = parent.casefold()
        distinct.setdefault(key, parent)
    sample_paths = sorted(distinct.values(), key=lambda path: (_path_depth(path), path.casefold()), reverse=True)[:_MAX_DIRECTORY_SAMPLES]
    if not sample_paths:
        if has_non_local_location:
            return {
                "scan_id": scan_id,
                "state": "unavailable",
                "sampled_directories": 0,
                "reachable_directories": 0,
                "missing_directories": 0,
                "message": "来源位置无法通过本地文件系统核对；当前没有可确认的访问结果。",
                "scope": "网盘定位符未被本地文件系统探测；没有读取视频，也不代表目录或全部视频可用。",
            }
        return {
            "scan_id": scan_id,
            "state": "no_samples",
            "sampled_directories": 0,
            "reachable_directories": 0,
            "missing_directories": 0,
            "message": "没有可抽查的视频目录位置。",
            "scope": "未读取视频文件；此状态不代表全部视频可播放。",
        }

    deadline = time.monotonic() + max(0.0, timeout)
    statuses: list[str] = []
    for path in sample_paths:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            statuses.append("unavailable")
            break
        result = bounded_call(lambda target=path: inspect_metadata(target), timeout=remaining)
        if not isinstance(result, dict):
            statuses.append("unavailable")
            break
        state = str(result.get("status") or "unavailable")
        statuses.append("reachable" if state == "directory" else "missing" if state == "missing" else "unavailable")
        if state == "unavailable":
            break

    sampled = len(statuses)
    reachable = statuses.count("reachable")
    missing = statuses.count("missing")
    if "unavailable" in statuses or sampled < len(sample_paths):
        state = "unavailable"
        message = "目录抽查超时或当前无法访问；本次核对结果不完整。"
    elif has_non_local_location:
        state = "unavailable"
        message = f"已抽查 {sampled} 个本地目录；部分来源位置无法通过本地文件系统核对。"
    elif missing:
        state = "missing"
        message = f"抽查 {sampled} 个不同目录，其中 {missing} 个当前不存在。"
    elif reachable:
        state = "reachable"
        message = f"已抽查 {sampled} 个不同深层目录，均可访问。"
    else:
        state = "unavailable"
        message = "未能确认抽查目录是否可访问。"
    return {
        "scan_id": scan_id,
        "state": state,
        "sampled_directories": sampled,
        "reachable_directories": reachable,
        "missing_directories": missing,
        "message": message,
        "scope": "仅检查少量本地目录元数据，没有读取视频；网盘定位符无法由此核对；不能据此认定每个视频都已验收。",
    }


def export_source_diagnostics(database, root_id: str) -> dict:
    """Build an explicit-export report from SQLite source, revision and job facts."""
    with database.connect() as conn:
        root = conn.execute(
            "SELECT root_id, provider, source_mode, display_name, source_locator, playback_locator "
            "FROM source_roots WHERE root_id=?",
            (root_id,),
        ).fetchone()
        if root is None:
            raise KeyError(root_id)
        scan = conn.execute(
            "SELECT ss.scan_id, ss.status, ss.stage, ss.error, ss.started_at, ss.finished_at, "
            "ss.generation, ssr.request_json "
            "FROM source_scans ss LEFT JOIN source_scan_requests ssr ON ssr.scan_id=ss.scan_id "
            "WHERE ss.root_id=? ORDER BY ss.generation DESC LIMIT 1",
            (root_id,),
        ).fetchone()
        revision = conn.execute(
            "SELECT revision_id, status, created_at, confirmed_at FROM import_revisions "
            "WHERE root_id=? ORDER BY created_at DESC LIMIT 1",
            (root_id,),
        ).fetchone()
        issues = []
        jobs = []
        uncertain = []
        metadata_problems = []
        unfinished_artwork = []
        work_hierarchies = []
        if revision is not None:
            revision_id = str(revision["revision_id"])
            hierarchies = _revision_hierarchies(conn, revision_id)
            work_hierarchies = list(hierarchies.values())
            metadata_problems = _metadata_problems(conn, revision_id, hierarchies)
            unfinished_artwork = _unfinished_artwork(conn, revision_id, hierarchies)
            issue_rows = conn.execute(
                "SELECT ri.code, ri.evidence_id, ri.message, ri.resolved, se.relative_path "
                "FROM revision_issues ri LEFT JOIN source_evidence se ON se.evidence_id=ri.evidence_id "
                "WHERE ri.revision_id=? ORDER BY ri.resolved, ri.code, ri.evidence_id",
                (revision_id,),
            ).fetchall()
            issues = [{
                "layer": "revision_issue",
                "code": _safe_text(row["code"], limit=120),
                "reason": _safe_text(row["message"], limit=None),
                "resolved": bool(row["resolved"]),
                "evidence_id": _safe_text(row["evidence_id"], limit=120),
                "path": _safe_text(row["relative_path"], limit=None),
            } for row in issue_rows]
            uncertain = [issue for issue in issues if not issue["resolved"]]
            if str(revision["status"]) == "draft":
                fact_rows = conn.execute(
                    """SELECT se.evidence_id, se.relative_path, pf.work_title, pf.media_type, pf.group_type,
                              pf.season_candidate, pf.episode_candidate, pf.absolute_episode_candidate,
                              pf.special_number, pf.special_candidate
                       FROM revision_evidence re
                       JOIN source_evidence se ON se.evidence_id=re.evidence_id
                       JOIN parsed_facts pf ON pf.parsed_fact_id=re.parsed_fact_id
                       LEFT JOIN revision_overrides ro ON ro.revision_id=re.revision_id AND ro.evidence_id=re.evidence_id
                       WHERE re.revision_id=? AND ro.evidence_id IS NULL AND pf.resource_type='video'""",
                    (revision_id,),
                ).fetchall()
                for row in fact_rows:
                    media_type = str(row["media_type"] or "unknown")
                    paths = str(row["relative_path"] or "")
                    evidence_id = str(row["evidence_id"] or "")
                    if media_type in {"", "unknown"}:
                        uncertain.append({"layer": "parsed_fact", "code": "media_type_unresolved", "reason": "媒体类型尚未确定。", "resolved": False,
                                          "hierarchy": {"work": _safe_text(row["work_title"], limit=None), "season": None, "episode": None},
                                          "evidence_id": _safe_text(evidence_id, limit=120), "path": _safe_text(paths, limit=None)})
                    if media_type != "movie" and row["season_candidate"] is None and not bool(row["special_candidate"]):
                        uncertain.append({"layer": "parsed_fact", "code": "season_number_unresolved", "reason": "季度尚未确定。", "resolved": False,
                                          "hierarchy": {"work": _safe_text(row["work_title"], limit=None), "season": None, "episode": row["episode_candidate"]},
                                          "evidence_id": _safe_text(evidence_id, limit=120), "path": _safe_text(paths, limit=None)})
                    if (media_type != "movie" and row["episode_candidate"] is None
                            and row["absolute_episode_candidate"] is None and row["special_number"] is None):
                        uncertain.append({"layer": "parsed_fact", "code": "episode_number_unresolved", "reason": "集号尚未确定。", "resolved": False,
                                          "hierarchy": {"work": _safe_text(row["work_title"], limit=None), "season": row["season_candidate"], "episode": None},
                                          "evidence_id": _safe_text(evidence_id, limit=120), "path": _safe_text(paths, limit=None)})
            elif str(revision["status"]) in {"confirmed", "executing", "completed", "failed"}:
                fact_rows = conn.execute(
                    """SELECT DISTINCT se.evidence_id, se.relative_path, w.work_type, w.preferred_title,
                              s.local_season_number, s.title AS season_title,
                              e.local_episode_number, e.special_number, e.display_title AS episode_title
                       FROM revision_bindings rb
                       JOIN source_evidence se ON se.evidence_id=rb.evidence_id
                       JOIN works w ON w.work_id=rb.work_id
                       LEFT JOIN seasons s ON s.season_id=rb.season_id
                       LEFT JOIN episodes e ON e.episode_id=rb.episode_id
                       WHERE rb.revision_id=?""",
                    (revision_id,),
                ).fetchall()
                for row in fact_rows:
                    evidence_id = str(row["evidence_id"] or "")
                    path = _safe_text(row["relative_path"], limit=None)
                    work_type = str(row["work_type"] or "unknown")
                    hierarchy = {
                        "work": _safe_text(row["preferred_title"], limit=None),
                        "season": row["local_season_number"],
                        "season_title": _safe_text(row["season_title"], limit=None),
                        "episode": row["local_episode_number"],
                        "episode_title": _safe_text(row["episode_title"], limit=None),
                        "special": row["special_number"],
                    }
                    if work_type == "unknown":
                        uncertain.append({"layer": "revision_binding", "code": "media_type_unresolved", "reason": "媒体类型尚未确定。", "resolved": False,
                                          "hierarchy": hierarchy,
                                          "evidence_id": _safe_text(evidence_id, limit=120), "path": path})
                    if work_type == "series" and row["local_season_number"] is None:
                        uncertain.append({"layer": "revision_binding", "code": "season_number_unresolved", "reason": "季度尚未确定。", "resolved": False,
                                          "hierarchy": hierarchy,
                                          "evidence_id": _safe_text(evidence_id, limit=120), "path": path})
                    if (work_type == "series" and row["local_episode_number"] is None
                            and row["special_number"] is None):
                        uncertain.append({"layer": "revision_binding", "code": "episode_number_unresolved", "reason": "集号尚未确定。", "resolved": False,
                                          "hierarchy": hierarchy,
                                          "evidence_id": _safe_text(evidence_id, limit=120), "path": path})
            job_rows = conn.execute(
                "SELECT job_type, status, attempts, last_error, work_id, updated_at "
                "FROM jobs WHERE revision_id=? AND status<>'succeeded' "
                "ORDER BY status, job_type, updated_at",
                (revision_id,),
            ).fetchall()
            jobs = [{
                "layer": "job",
                "job_type": _safe_text(row["job_type"], limit=120),
                "status": _safe_text(row["status"], limit=40),
                "attempts": int(row["attempts"] or 0),
                "reason": _safe_text(row["last_error"], limit=None),
                "work_id": _safe_text(row["work_id"], limit=120),
                "updated_at": _safe_text(row["updated_at"], limit=80),
            } for row in job_rows]

        request_data: dict = {}
        if scan is not None:
            try:
                candidate = json.loads(scan["request_json"] or "{}")
                if isinstance(candidate, dict):
                    request_data = candidate
            except (TypeError, ValueError):
                pass
        # Explicit allowlist: never export connection settings, authorization headers or credentials.
        location = {
            key: _safe_text(request_data.get(key), limit=None)
            for key in ("tree_file_path", "root_path", "source_root", "effective_playback_root")
            if request_data.get(key)
        }
        return {
            "format": "kumiplayer-source-diagnostics-v1",
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": {
                "root_id": str(root["root_id"]),
                "display_name": _safe_text(root["display_name"], limit=None),
                "provider": _safe_text(root["provider"], limit=80),
                "source_mode": _safe_text(root["source_mode"], limit=80),
                "locations": {
                    "source_locator": _safe_text(root["source_locator"], limit=None),
                    "playback_locator": _safe_text(root["playback_locator"], limit=None),
                    **location,
                },
            },
            "scan": None if scan is None else {
                "scan_id": str(scan["scan_id"]),
                "status": _safe_text(scan["status"], limit=40),
                "stage": _safe_text(scan["stage"], limit=80),
                "reason": _safe_text(scan["error"], limit=None),
                "started_at": _safe_text(scan["started_at"], limit=80),
                "finished_at": _safe_text(scan["finished_at"], limit=80),
            },
            "revision": None if revision is None else {
                "revision_id": str(revision["revision_id"]),
                "status": _safe_text(revision["status"], limit=40),
                "created_at": _safe_text(revision["created_at"], limit=80),
                "confirmed_at": _safe_text(revision["confirmed_at"], limit=80),
            },
            "identification_uncertainties": uncertain,
            "work_hierarchies": work_hierarchies,
            "issues": issues,
            "unfinished_or_failed_jobs": jobs,
            "metadata_problems": metadata_problems,
            "unfinished_artwork": unfinished_artwork,
            "privacy": "仅在用户主动导出时生成；报告包含此来源必要目录路径，不含连接配置或凭据。",
        }
