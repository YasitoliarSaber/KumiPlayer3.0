"""Read-only extra-video hints derived from the latest confirmed V4 facts."""

from __future__ import annotations

import json
import re
import sqlite3
from pathlib import PurePosixPath
from typing import Any

_AUXILIARY_CLASS_MARKERS = {
    "auxiliary", "opening", "ending", "promotional", "trailer", "commercial",
}
_SPECIAL_CLASS_MARKERS = {
    "attached_special", "playable_special", "special", "ova", "oad", "season_zero", "season0",
}
_AUXILIARY_NAME_MARKER = re.compile(
    r"(?i)(?:^|[\s._\-\[\(])(?P<marker>NCOP|NCED|OP|ED|PV|CM|MENU|MV|TRAILER|EYECATCH)(?P<number>\s*\d+)?(?:$|[\s._\-\]\)])"
)
_SUBSTANTIVE_NAME_MARKER = re.compile(
    r"(?i)(?:^|[\s._\-\[\(])(?:SP|SPECIAL|OVA|OAD)(?:\s*\d+(?:\.\d+)?|$|[\s._\-\]\)])"
)


def _normalized_title(value: Any) -> str:
    return "".join(ch.casefold() for ch in str(value or "") if ch.isalnum())


def classify_saved_video(fact: dict[str, Any], relative_path: str) -> tuple[str, str]:
    """Classify only from persisted ParsedFacts and a filename marker.

    Folder names are deliberately not evidence: a `SPs/` folder containing
    PV/CM/Menu files remains auxiliary material.
    """

    content_class = str(fact.get("content_class") or "").strip().casefold()
    classification_state = str(fact.get("classification_state") or "").strip().casefold()
    reasons = fact.get("reasons")
    if isinstance(reasons, str):
        try:
            reasons = json.loads(reasons)
        except (TypeError, ValueError):
            reasons = []
    reason_text = " ".join(str(item) for item in reasons or []).casefold()
    filename = PurePosixPath(str(relative_path).replace("\\", "/")).name

    if content_class in _AUXILIARY_CLASS_MARKERS or int(fact.get("is_auxiliary") or 0):
        return "auxiliary", "ParsedFacts 标记为辅助视频"
    if content_class in _SPECIAL_CLASS_MARKERS or classification_state in _SPECIAL_CLASS_MARKERS:
        return "substantive_special", "ParsedFacts 将内容分类为特别篇"
    if _SUBSTANTIVE_NAME_MARKER.search(filename):
        return "substantive_special", "文件名含明确 SP/OVA/OAD 标记"

    if any(marker in reason_text for marker in ("auxiliary_video", "opening", "ending", "promotional", "commercial")):
        return "auxiliary", "ParsedFacts 标记为片头、片尾或宣传辅助内容"
    if _AUXILIARY_NAME_MARKER.search(filename):
        return "auxiliary", "文件名含 OP/ED/PV/CM/Menu/MV 等辅助标记"

    if int(fact.get("special_candidate") or 0) or fact.get("special_number") is not None:
        return "substantive_special", "ParsedFacts 保留特别篇编号"
    if fact.get("season_candidate") == 0:
        return "substantive_special", "ParsedFacts 指向零季候选"
    episode_token = str(fact.get("episode_token_raw") or "")
    if re.search(r"\d+\.\d+", episode_token):
        return "substantive_special", "ParsedFacts 保留小数集号候选"

    if int(fact.get("is_importable", 0)):
        return "unmatched", "ParsedFacts 可导入，但当前确认 revision 没有正片绑定"
    return "uncertain", "SQLite 中有视频证据，但 ParsedFacts 未提供可靠分类"


def _split_relative_path(path: str) -> tuple[str, ...]:
    return tuple(part for part in re.split(r"[\\/]+", str(path or "")) if part and part != ".")


def _explicit_regular_episode_key(fact: dict[str, Any]) -> tuple[int, int] | None:
    """Return only a persisted, explicit local season/episode pair."""

    if (str(fact.get("content_class") or "").casefold() != "regular"
            or not int(fact.get("is_importable") or 0)
            or int(fact.get("is_auxiliary") or 0)
            or int(fact.get("special_candidate") or 0)
            or fact.get("special_number") is not None):
        return None
    season = fact.get("season_candidate")
    episode = fact.get("episode_candidate")
    if not isinstance(season, int) or season <= 0 or not isinstance(episode, int) or episode <= 0:
        return None
    return season, episode


def _parsed_candidate_identity(row: dict[str, Any]) -> tuple[str, ...] | None:
    """Build category-scoped identities only when existing facts are explicit."""

    fact = row["fact"]
    category = str(fact.get("category") or "")
    work_title = _normalized_title(fact.get("work_title"))

    if category == "unmatched":
        regular_key = _explicit_regular_episode_key(fact)
        if regular_key:
            return ("regular-edition", work_title, str(regular_key[0]), str(regular_key[1]))

    if category == "substantive_special":
        special_number = fact.get("special_number")
        if special_number is None and int(fact.get("special_candidate") or 0):
            special_number = fact.get("episode_candidate")
        if special_number is not None:
            return ("special-edition", work_title, str(special_number).casefold())
        if fact.get("season_candidate") == 0 and fact.get("episode_candidate") is not None:
            return ("special-zero-edition", work_title, str(fact["episode_candidate"]))
        token = str(fact.get("episode_token_raw") or "").strip().casefold()
        if token and re.search(r"\d+(?:\.\d+)?", token):
            return ("special-token-edition", work_title, token)

    if category == "auxiliary":
        filename = PurePosixPath(str(row.get("relative_path") or "").replace("\\", "/")).name
        marker = _AUXILIARY_NAME_MARKER.search(filename)
        if marker and marker.group("number"):
            return ("auxiliary-marker-edition", work_title, marker.group("marker").casefold(), re.sub(r"\D", "", marker.group("number")))

    return None


def _deduplicate_candidates(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse editions by explicit facts, keeping identities category-scoped."""

    selected: dict[tuple[str, ...], dict[str, Any]] = {}
    for row in rows:
        fact = row["fact"]
        category = str(fact.get("category") or "")
        work_title = _normalized_title(fact.get("work_title"))
        identity = _parsed_candidate_identity(row)
        if identity:
            key = (category, *identity)
        else:
            fingerprint = str(row.get("fingerprint") or "").strip()
            if fingerprint:
                key = (category, "fingerprint", fingerprint.casefold())
            else:
                filename = PurePosixPath(str(row.get("relative_path") or "").replace("\\", "/")).name
                marker = _AUXILIARY_NAME_MARKER.search(filename) if category == "auxiliary" else None
                marker_key = marker.group(0).casefold() if marker else _normalized_title(filename)
                key = (category, "unresolved", work_title, marker_key)
        previous = selected.get(key)
        if previous is None or str(row.get("relative_path") or "") < str(previous.get("relative_path") or ""):
            selected[key] = row
    return list(selected.values())


def get_extra_video_overview(conn: sqlite3.Connection, work_id: str) -> dict[str, Any] | None:
    """Summarize persisted, unbound videos related to currently visible regular episodes.

    The service only reads the latest confirmed revision for source roots that
    still have available regular episode assets. It never scans a mounted path,
    parses files, or treats a folder name as a special-work classification.
    """

    work = conn.execute(
        "SELECT preferred_title, original_title FROM works WHERE work_id = ?", (work_id,)
    ).fetchone()
    if work is None:
        return None
    accepted_titles = {
        normalized for normalized in (
            _normalized_title(work["preferred_title"]),
            _normalized_title(work["original_title"]),
        ) if normalized
    }
    accepted_titles.update(
        str(row[0]) for row in conn.execute(
            "SELECT normalized_title FROM work_aliases WHERE work_id = ?", (work_id,)
        ).fetchall() if str(row[0])
    )
    if not accepted_titles:
        return {
            "work_id": work_id, "substantive_special_count": 0, "auxiliary_count": 0,
            "unmatched_count": 0, "uncertain_count": 0,
            "reasons": ["作品没有可用于严格关联的已保存标题"],
        }

    anchors = conn.execute(
        """
        WITH latest_revisions AS (
            SELECT ir.root_id, ir.revision_id, ir.confirmed_at,
                   ROW_NUMBER() OVER (
                       PARTITION BY ir.root_id
                       ORDER BY ir.confirmed_at DESC, ir.revision_id DESC
                   ) AS revision_rank
            FROM import_revisions ir
            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
            WHERE ir.status = 'confirmed'
        )
        SELECT DISTINCT ir.root_id, ir.revision_id, ir.confirmed_at,
               se.relative_path AS matched_path, se.fingerprint AS matched_fingerprint,
               ss.local_season_number, ep.local_episode_number
        FROM latest_revisions ir
        JOIN revision_bindings rb ON rb.revision_id = ir.revision_id
        JOIN episodes ep ON ep.episode_id = rb.episode_id AND ep.work_id = rb.work_id
        JOIN seasons ss ON ss.season_id = ep.season_id AND ss.work_id = ep.work_id
        JOIN assets a ON a.asset_id = rb.asset_id AND a.availability_state = 'available'
        JOIN source_evidence se ON se.evidence_id = rb.evidence_id
        WHERE ir.revision_rank = 1 AND rb.work_id = ?
          AND ep.episode_kind = 'regular' AND rb.asset_id IS NOT NULL
        ORDER BY ir.root_id, ir.confirmed_at DESC, se.relative_path
        """,
        (work_id,),
    ).fetchall()
    latest_revision_by_root: dict[str, str] = {}
    matched_fingerprints: dict[str, set[str]] = {}
    bound_regular_keys: dict[str, set[tuple[int, int]]] = {}
    for anchor in anchors:
        root_id = str(anchor["root_id"])
        if root_id in latest_revision_by_root and latest_revision_by_root[root_id] != str(anchor["revision_id"]):
            continue
        latest_revision_by_root[root_id] = str(anchor["revision_id"])
        fingerprint = str(anchor["matched_fingerprint"] or "").strip().casefold()
        if fingerprint:
            matched_fingerprints.setdefault(root_id, set()).add(fingerprint)
        season_number = anchor["local_season_number"]
        episode_number = anchor["local_episode_number"]
        if isinstance(season_number, int) and isinstance(episode_number, int):
            bound_regular_keys.setdefault(root_id, set()).add((season_number, episode_number))

    if not latest_revision_by_root:
        return {
            "work_id": work_id, "substantive_special_count": 0, "auxiliary_count": 0,
            "unmatched_count": 0, "uncertain_count": 0,
            "reasons": ["没有仍可用的已确认正片资产，无法建立额外视频关联"],
        }

    rows: list[dict[str, Any]] = []
    reasons: set[str] = set()
    for root_id, revision_id in latest_revision_by_root.items():
        facts = conn.execute(
            """
            SELECT se.evidence_id, se.relative_path, se.fingerprint, se.entry_kind,
                   pf.content_class, pf.classification_state, pf.is_importable,
                   pf.is_auxiliary, pf.special_candidate, pf.special_number,
                   pf.season_candidate, pf.season_token_raw, pf.episode_token_raw,
                   pf.episode_candidate, pf.episode_title, pf.work_title, pf.reasons_json
            FROM revision_evidence re
            JOIN source_evidence se ON se.evidence_id = re.evidence_id
            JOIN parsed_facts pf ON pf.parsed_fact_id = re.parsed_fact_id
            WHERE re.revision_id = ? AND se.root_id = ? AND se.presence_state = 'present'
              AND se.entry_kind = 'video' AND pf.resource_type = 'video'
              AND NOT EXISTS (
                  SELECT 1 FROM revision_bindings bound
                  WHERE bound.revision_id = re.revision_id
                    AND bound.evidence_id = se.evidence_id AND bound.asset_id IS NOT NULL
              )
            """,
            (revision_id, root_id),
        ).fetchall()
        for raw in facts:
            fact = dict(raw)
            if _normalized_title(fact.get("work_title")) not in accepted_titles:
                continue
            path_parts = _split_relative_path(str(fact.get("relative_path") or ""))
            # A root-level video can be a neighboring work; require a child directory
            # and an exact parsed work title before associating it with this work.
            if len(path_parts) < 2:
                reasons.add("已省略根目录直放视频：不足以确认属于该作品")
                continue
            if str(fact.get("fingerprint") or "").strip().casefold() in matched_fingerprints.get(root_id, set()):
                reasons.add("已省略与当前正片指纹相同的重复文件")
                continue
            try:
                parsed_reasons = json.loads(str(fact.get("reasons_json") or "[]"))
            except (TypeError, ValueError):
                parsed_reasons = []
            fact["reasons"] = parsed_reasons
            category, reason = classify_saved_video(fact, str(fact.get("relative_path") or ""))
            fact["category"] = category
            fact["reason"] = reason
            if category == "unmatched" and _explicit_regular_episode_key(fact) in bound_regular_keys.get(root_id, set()):
                reasons.add("已省略与当前已匹配正片季集号相同的另一版本")
                continue
            rows.append({
                "root_id": root_id,
                "relative_path": str(fact.get("relative_path") or ""),
                "fingerprint": str(fact.get("fingerprint") or ""),
                "fact": fact,
            })

    unique = _deduplicate_candidates(rows)
    counts = {"substantive_special": 0, "auxiliary": 0, "unmatched": 0, "uncertain": 0}
    category_reasons: dict[str, set[str]] = {key: set() for key in counts}
    for row in unique:
        fact = row["fact"]
        category = str(fact["category"])
        counts[category] += 1
        category_reasons[category].add(str(fact["reason"]))

    details = [
        {"category": category, "count": count, "reasons": sorted(category_reasons[category])}
        for category, count in counts.items() if count
    ]
    return {
        "work_id": work_id,
        "substantive_special_count": counts["substantive_special"],
        "auxiliary_count": counts["auxiliary"],
        "unmatched_count": counts["unmatched"],
        "uncertain_count": counts["uncertain"],
        "reasons": sorted(reasons),
        "categories": details,
    }
