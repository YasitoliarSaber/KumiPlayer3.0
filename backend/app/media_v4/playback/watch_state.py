"""按 Episode 保存显式观看选择；覆盖远端状态，不改写媒体事实。"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from app.media_v4.projection.changes import record_change


def _payload(conn, work_id: str) -> dict:
    row = conn.execute(
        "SELECT override_json FROM work_overrides WHERE work_id=?", (work_id,),
    ).fetchone()
    payload = json.loads(row["override_json"]) if row else {}
    return payload if isinstance(payload, dict) else {}


def manual_watch_states(conn, work_id: str) -> dict[str, bool]:
    states = _payload(conn, work_id).get("episode_watch_state", {})
    return {str(key): value for key, value in states.items() if isinstance(value, bool)} if isinstance(states, dict) else {}


def _save(conn, work_id: str, payload: dict) -> None:
    now = datetime.now(UTC).isoformat()
    conn.execute(
        "INSERT INTO work_overrides(work_id,override_json,created_at,updated_at) VALUES (?,?,?,?) "
        "ON CONFLICT(work_id) DO UPDATE SET override_json=excluded.override_json,updated_at=excluded.updated_at",
        (work_id, json.dumps(payload, ensure_ascii=False), now, now),
    )


def preserve_manual_unwatched(conn, work_id: str, episode_id: str, captured_at: str) -> bool:
    """手工未看晚于会话启动时，旧会话不得恢复被重置的位置或完成状态。"""
    payload = _payload(conn, work_id)
    states = payload.get("episode_watch_state", {})
    if not isinstance(states, dict) or states.get(episode_id) is not False:
        return False
    changed = payload.get("episode_watch_updated_at", {})
    marked_at = changed.get(episode_id) if isinstance(changed, dict) else None
    return not captured_at or not isinstance(marked_at, str) or marked_at >= captured_at


def clear_manual_watch_state(conn, work_id: str, episode_id: str, *, captured_at: str = "") -> None:
    """只有手工选择之后新开启的播放完成，才能移除该选择。"""
    payload = _payload(conn, work_id)
    states = payload.get("episode_watch_state", {})
    changed = payload.get("episode_watch_updated_at", {})
    marked_at = changed.get(episode_id) if isinstance(changed, dict) else None
    if not captured_at or not isinstance(marked_at, str) or captured_at <= marked_at:
        return
    if isinstance(states, dict) and episode_id in states:
        del states[episode_id]
        changed.pop(episode_id, None)
        _save(conn, work_id, payload)


def mark_watch_state(database, work_id: str, episode_id: str, completed: bool, *, through: bool = False, asset_id: str = "") -> list[dict]:
    """同一写事务核实活动身份，并对目标集所有版本落盘。"""
    with database.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        target = conn.execute(
            "SELECT e.*,s.local_season_number FROM episodes e LEFT JOIN seasons s ON s.season_id=e.season_id "
            "WHERE e.episode_id=? AND e.work_id=? "
            "AND EXISTS (SELECT 1 FROM revision_bindings rb JOIN import_revisions ir ON ir.revision_id=rb.revision_id "
            "JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.retired_at='' "
            "WHERE rb.episode_id=e.episode_id AND rb.work_id=e.work_id AND ir.status='confirmed')",
            (episode_id, work_id),
        ).fetchone()
        if asset_id and not conn.execute(
            "SELECT 1 FROM revision_bindings rb JOIN import_revisions ir ON ir.revision_id=rb.revision_id "
            "JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.retired_at='' "
            "WHERE rb.work_id=? AND rb.asset_id=? AND ir.status='confirmed' "
            "AND (rb.episode_id=? OR (rb.episode_id IS NULL AND ?='movie:'||rb.work_id))",
            (work_id, asset_id, episode_id, episode_id),
        ).fetchone():
            raise KeyError((work_id, episode_id, asset_id))
        if through:
            if (target is None or target["episode_kind"] != "regular" or not target["season_id"]
                    or not target["local_episode_number"] or not target["local_season_number"]
                    or target["local_season_number"] < 1):
                raise ValueError("看到本集仅适用于已确认季度的正片")
            episodes = [str(row["episode_id"]) for row in conn.execute(
                "SELECT episode_id FROM episodes WHERE work_id=? AND season_id=? AND episode_kind='regular' "
                "AND local_episode_number>0 AND local_episode_number<=? ORDER BY local_episode_number,episode_id",
                (work_id, target["season_id"], target["local_episode_number"]),
            )]
        else:
            episodes = [episode_id]
        rows = []
        for current_id in episodes:
            assets = conn.execute(
                "SELECT DISTINCT rb.asset_id FROM revision_bindings rb "
                "JOIN import_revisions ir ON ir.revision_id=rb.revision_id AND ir.status='confirmed' "
                "JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.retired_at='' "
                "WHERE rb.work_id=? AND (rb.episode_id=? OR (rb.episode_id IS NULL AND ?='movie:'||rb.work_id)) "
                "AND rb.asset_id IS NOT NULL ORDER BY rb.asset_id",
                (work_id, current_id, current_id),
            ).fetchall()
            if not assets:
                if through:
                    continue
                raise KeyError((work_id, current_id))
            rows.extend((current_id, str(row["asset_id"])) for row in assets)
        if not rows:
            raise KeyError((work_id, episode_id))
        payload = _payload(conn, work_id)
        states = manual_watch_states(conn, work_id)
        changed = payload.get("episode_watch_updated_at", {})
        if not isinstance(changed, dict):
            changed = {}
        now = datetime.now(UTC).isoformat()
        for current_id, asset_id in rows:
            states[current_id] = completed
            changed[current_id] = now
            conn.execute(
                "INSERT INTO playback_progress(episode_id,asset_id,work_id,position,duration,completed,updated_at) "
                "VALUES (?,?,?,0,0,?,?) ON CONFLICT(episode_id,asset_id) DO UPDATE SET "
                "position=CASE WHEN excluded.completed=0 THEN 0 ELSE playback_progress.position END,"
                "duration=CASE WHEN excluded.completed=0 THEN 0 ELSE playback_progress.duration END,"
                "completed=excluded.completed,updated_at=excluded.updated_at",
                (current_id, asset_id, work_id, int(completed), now),
            )
        payload["episode_watch_state"] = states
        payload["episode_watch_updated_at"] = changed
        _save(conn, work_id, payload)
        record_change(conn, "watch", work_id)
        return [dict(conn.execute(
            "SELECT * FROM playback_progress WHERE episode_id=? AND asset_id=?", (current_id, asset_id),
        ).fetchone()) for current_id, asset_id in rows]
