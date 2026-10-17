"""V4 SQLite 投影读模型与本地观看状态接口。"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.api.media_v4 import get_database
from app.media_v4.assets.status import has_active_artwork
from app.media_v4.projection.collections import related_works
from app.media_v4.projection.details import _watch_payload
from app.media_v4.projection.library import V4LibraryProjection
from app.media_v4.projection.presentation import PRESENTATION_POLICY_VERSION, display_work_title

router = APIRouter(prefix="/api/library", tags=["library"])


class WatchStatusRequest(BaseModel):
    status: str | None = None
    note: str | None = None
    favorite: bool | None = None






def _published_artwork_payload(conn, payload: dict) -> None:
    from app.media_v4.assets.catalog import get_episode_artwork_many, get_work_artwork

    payload['artwork'] = get_work_artwork(conn, str(payload['work_id']))
    for role in ('poster', 'fanart', 'clearlogo'):
        variants = payload['artwork'].get(role, {}).get('variants', {})
        url = variants.get('384') or next(iter(variants.values()), '')
        payload[f'{role}_path'] = url
        payload[f'local_{role}_path'] = url
    episodes = payload.get('episodes') or []
    artwork = get_episode_artwork_many(conn, [episode['episode_id'] for episode in episodes])
    for episode in episodes:
        image = artwork.get(episode['episode_id'], {}).get('episode_thumb', {})
        episode['thumb_path'] = image.get('variants', {}).get('384', '')
    episode_map = {episode['episode_id']: episode for episode in episodes}
    for season in payload.get('seasons') or []:
        season['episodes'] = [episode_map[episode['episode_id']] for episode in season.get('episodes') or []
                              if episode['episode_id'] in episode_map]
    from app.media_v4.assets.catalog import get_metadata_images_many

    people = payload.get('cast') or []
    image_sources = list(dict.fromkeys(
        str(person.get('profile_path') or person.get('profile_url') or '') for person in people
    ))
    images = get_metadata_images_many(conn, [source for source in image_sources if source])
    for person in people:
        person['profile_path'] = images.get(person.get('profile_path') or person.get('profile_url') or '', '')


def _card_payload(card: dict, override: dict | None = None, related_payload: list[dict] | None = None) -> dict:
    metadata = card.get("metadata") or {}
    override = override or {}
    media_type = card['media_type'] if card['media_type'] in {'tv', 'movie', 'unknown'} else 'unknown'
    # P-001 7.7 R4：show_type/card_type 以后端持久化权威为准，不再硬编码。
    show_type = str(card.get("show_type") or metadata.get("show_type") or "")
    if not show_type:
        show_type = {'tv': 'anime_series', 'movie': 'anime_movie'}.get(media_type, '')
    card_type = str(card.get("card_type") or metadata.get("card_type") or "")
    if not card_type:
        card_type = {'tv': 'main_series', 'movie': 'standalone'}.get(media_type, '')
    sources = metadata.get("sources") or ["local"]
    watch_status = metadata.get("watch_status")
    if watch_status is None:
        watch_status = {"work_id": card["work_id"], "status": "", "note": "", "favorite": False, "updated_at": ""}
    # P-006：用户覆盖层（标题/图片）优先于刮削事实；不覆盖原始抓取数据。
    # 投影记录真正的身份保护原因；旧的未标记精简卡片仍按已投影标题兜底。
    display_title = display_work_title(
        card.get("title") or "", metadata,
        preserve_identity=metadata.get("preserve_identity_title", True), override=override,
    )
    local_poster = str(override.get("local_poster_path") or "") or metadata.get("local_poster_path") or ""
    local_fanart = str(override.get("local_fanart_path") or "") or metadata.get("local_fanart_path") or ""
    local_clearlogo = str(override.get("local_clearlogo_path") or "") or metadata.get("local_clearlogo_path") or ""
    return {
        "work_id": card["work_id"],
        "title": display_title,
        "original_title": metadata.get("original_title") or card["title"],
        "year": card["year"],
        "title_provenance": "manual" if str(override.get('title') or '').strip() else (
            "online" if metadata.get("provider") not in {None, "", "local"} else "local"),
        "rating": metadata.get("rating") or 0,
        "plot": metadata.get("plot") or "",
        "genres": metadata.get("genres") or [],
        "studios": metadata.get("studios") or [],
        "media_type": media_type,
        "show_type": show_type,
        "card_type": card_type,
        "source": sources[0],
        "sources": sources,
        "episodes": [],
        "seasons": [],
        "episode_count": card["episode_count"],
        "asset_count": card["asset_count"],
        "season_count": int(metadata.get("regular_season_count") or card.get("regular_season_count") or 0),
        "special_season_count": int(metadata.get("special_season_count") or card.get("special_season_count") or 0),
        "latest_episode_number": card.get("latest_episode_number"),
        "source_locations": {},
        "poster_path": metadata.get("poster_url") or "",
        "fanart_path": metadata.get("fanart_url") or "",
        "local_poster_path": local_poster,
        "local_fanart_path": local_fanart,
        "local_clearlogo_path": local_clearlogo,
        "clearlogo_path": metadata.get("clearlogo_url") or metadata.get("clearlogo_path") or local_clearlogo,
        "dir_path": "",
        "related_works": related_payload or [],
        "collections": metadata.get("collections") or [],
        "cast": metadata.get("cast") or [],
        "tags": metadata.get("tags") or [],
        "certification": metadata.get("certification") or "",
        "certification_country": metadata.get("certification_country") or "",
        "last_played": None,
        "watch_status": watch_status,
        "metadata_state": metadata.get("metadata_state") or ("ready" if metadata else "pending"),
    }


def _library_snapshot(*, work_ids: tuple[str, ...] | None = None):
    database = get_database()
    projection = V4LibraryProjection(database)
    from app.media_v4.projection.library import LibrarySnapshot

    return projection.current(work_ids=work_ids) or LibrarySnapshot('', '', ())


def _work_overrides_map(work_ids: list[str]) -> dict[str, dict]:
    """批量读取作品用户覆盖层（标题/图片/隐藏标记）。"""

    if not work_ids:
        return {}
    import json as _json

    rows = _rows_for_work_ids('SELECT work_id,override_json FROM work_overrides WHERE work_id IN (', work_ids)
    result: dict[str, dict] = {}
    for row in rows:
        try:
            result[str(row["work_id"])] = _json.loads(row["override_json"] or "{}")
        except (TypeError, ValueError):
            result[str(row["work_id"])] = {}
    return result


def _rows_for_work_ids(sql: str, work_ids: list[str]) -> list:
    """有界参数批次，避免大库碰到 SQLite 连接的变量上限。"""
    import sqlite3

    rows = []
    with get_database().connect() as conn:
        size = max(1, min(500, conn.getlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER)))
        for offset in range(0, len(work_ids), size):
            batch = work_ids[offset:offset + size]
            rows.extend(conn.execute(sql + ','.join('?' for _ in batch) + ')', batch).fetchall())
    return rows


def _background_active(publication: dict) -> bool:
    if publication['updating']:
        return True
    with get_database().connect() as conn:
        return has_active_artwork(conn) or bool(conn.execute("""SELECT 1 FROM jobs j
            JOIN import_revisions ir ON ir.revision_id=j.revision_id AND ir.status='confirmed'
            JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.enabled=1 AND sr.retired_at=''
            WHERE j.status IN ('queued','running') AND j.cancel_requested=0
            AND j.job_type IN ('scrape_work','recover_work_aliases','refresh_projection') LIMIT 1""").fetchone())


@router.get("")
def get_library(source: str | None = None, work_ids: str | None = None):
    selected = tuple(dict.fromkeys(filter(None, (work_ids or '').split(',')))) if work_ids is not None else None
    if selected is not None and len(selected) > 128:
        raise HTTPException(status_code=400, detail='一次最多读取 128 个作品')
    snapshot = _library_snapshot(work_ids=selected)
    publication = V4LibraryProjection(get_database()).summary()
    card_work_ids = [card["work_id"] for card in snapshot.cards]
    watch_map = _watch_status_map(card_work_ids)
    override_map = _work_overrides_map(card_work_ids)
    from app.media_v4.assets.catalog import get_work_artwork_many
    with get_database().connect() as conn:
        artwork_map = get_work_artwork_many(conn, card_work_ids)
        related_map = {
            str(card['work_id']): related_works(conn, str(card['work_id']), card.get('metadata') or {})
            for card in snapshot.cards
        }
    works = []
    for card in snapshot.cards:
        override = override_map.get(card["work_id"], {})
        if override.get("hidden"):
            # 单作品删除：从活动媒体库排除（不可变快照保留审计事实）。
            continue
        payload = _card_payload(card, override, related_map.get(str(card['work_id']), []))
        payload['artwork'] = artwork_map.get(card['work_id'], {})
        for role in ('poster', 'fanart', 'clearlogo'):
            variants = payload['artwork'].get(role, {}).get('variants', {})
            published = variants.get('384') or next(iter(variants.values()), '')
            payload[f'{role}_path'] = published
            payload[f'local_{role}_path'] = published
        for key in ('cast', 'studios', 'tags', 'certification', 'certification_country'):
            payload.pop(key, None)
        payload['content_scope'] = card.get('metadata', {}).get('content_scope', '')
        payload["watch_status"] = watch_map.get(card["work_id"], {
            "work_id": card["work_id"], "status": "", "note": "", "favorite": False, "updated_at": "",
        })
        works.append(payload)
    # 所有卡片都来自已确认成员；资料与图片等待不能隐藏可播放媒体。
    if source and source != "all":
        works = [work for work in works if source in work["sources"]]
    collections: dict[str, dict] = {}
    for work in works:
        for collection in work.get("collections") or []:
            item = collections.setdefault(collection["collection_id"], {**collection, "work_ids": []})
            item["work_ids"].append(work["work_id"])
    return {
        'change_sequence': snapshot.change_sequence,
        "works": works,
        "collections": list(collections.values()),
        "summary": {
            "work_count": len(works),
            "episode_count": sum(int(work["episode_count"]) for work in works),
        },
        "generated_at": snapshot.generation_id,
        "generation_id": snapshot.generation_id,
        "updating": publication['updating'] or publication['generation_id'] != snapshot.generation_id,
        "background_active": _background_active(publication),
        "digest": snapshot.digest,
    }




@router.get('/changes')
def get_changes(after: int = 0, limit: int = 128):
    from app.media_v4.projection.changes import read_changes
    try:
        with get_database().connect() as conn:
            conn.execute('BEGIN')
            changes = read_changes(conn, after, limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    publication = V4LibraryProjection(get_database()).summary()
    changes['generation_id'] = publication['generation_id']
    changes['updating'] = publication['updating']
    changes['background_active'] = _background_active(publication)
    return changes


@router.get('/cards')
def get_cards(work_ids: str):
    return {'works': get_library(work_ids=work_ids)['works']}


# 全局搜索：只读有界轻量字段（标题/原名/别名/标签/制作公司），不逐作品读详情。
_SEARCH_FIELD_LIMITS = {"aliases": 8, "tags": 12, "studios": 8}
_SEARCH_TEXT_LIMIT = 120
_SEARCH_METADATA_FIELD = (
    "CASE WHEN json_valid(c.metadata_json) THEN lower(COALESCE(json_extract(c.metadata_json,'$.{key}'),'')) ELSE '' END"
)
_SEARCH_SQL = f"""
    SELECT c.work_id, c.title, c.year, c.media_type, c.metadata_json,
           COALESCE(w.original_title, '') AS original_title
    FROM library_cards c
    LEFT JOIN works w ON w.work_id = c.work_id
    WHERE c.generation_id = ?
      AND NOT EXISTS (
          SELECT 1 FROM work_overrides o
          WHERE o.work_id = c.work_id AND json_valid(o.override_json)
            AND json_extract(o.override_json,'$.hidden') = 1
      )
      AND (
          lower(c.title) LIKE ? ESCAPE '!'
          OR lower(COALESCE(w.original_title,'')) LIKE ? ESCAPE '!'
          OR {_SEARCH_METADATA_FIELD.format(key='original_title')} LIKE ? ESCAPE '!'
          OR {_SEARCH_METADATA_FIELD.format(key='tags')} LIKE ? ESCAPE '!'
          OR {_SEARCH_METADATA_FIELD.format(key='studios')} LIKE ? ESCAPE '!'
          OR EXISTS (
              SELECT 1 FROM work_aliases wa
              WHERE wa.work_id = c.work_id AND lower(wa.normalized_title) LIKE ? ESCAPE '!'
          )
      )
    ORDER BY c.work_id
    LIMIT ?
"""


def _bounded_texts(values, limit: int) -> list[str]:
    """有界文本列表：去重、裁剪单条长度并限制条数。"""

    result: list[str] = []
    for value in values if isinstance(values, list) else []:
        text = str(value or "").strip()[:_SEARCH_TEXT_LIMIT]
        if text and text not in result:
            result.append(text)
        if len(result) >= limit:
            break
    return result


def _like_pattern(needle: str) -> str:
    """把用户关键词转为 LIKE 模式，转义通配符避免 `%`/`_` 变成任意匹配。"""

    escaped = needle.replace("!", "!!").replace("%", "!%").replace("_", "!_")
    return f"%{escaped}%"


@router.get('/search')
def search_library(q: str = Query(default=''), limit: int = 30):
    """全局搜索：单次有界 SQL 读取轻量字段，不读取作品详情、不建第二索引。"""

    query = " ".join(str(q or "").split())
    if not query:
        raise HTTPException(status_code=400, detail='请输入搜索关键词')
    if len(query) > 64:
        raise HTTPException(status_code=400, detail='搜索关键词过长')
    safe_limit = max(1, min(int(limit or 30), 100))
    needle = query.casefold()
    like = _like_pattern(needle)
    database = get_database()
    with database.connect() as conn:
        generation_row = conn.execute(
            "SELECT value FROM v4_meta WHERE key = 'current_library_generation'"
        ).fetchone()
        generation = str(generation_row["value"]) if generation_row else ""
        rows = []
        if generation:
            rows = conn.execute(
                _SEARCH_SQL,
                (generation, like, like, like, like, like, like, safe_limit + 1),
            ).fetchall()
        truncated = len(rows) > safe_limit
        rows = rows[:safe_limit]
        work_ids = [str(row["work_id"]) for row in rows]
        alias_map: dict[str, list[str]] = {}
        if work_ids:
            placeholders = ",".join("?" for _ in work_ids)
            for alias_row in conn.execute(
                "SELECT work_id, normalized_title FROM work_aliases "
                f"WHERE work_id IN ({placeholders}) ORDER BY work_id, normalized_title",
                work_ids,
            ).fetchall():
                alias_map.setdefault(str(alias_row["work_id"]), []).append(
                    str(alias_row["normalized_title"])
                )
    items = []
    for row in rows:
        try:
            metadata = json.loads(row["metadata_json"] or "{}")
        except (TypeError, ValueError):
            metadata = {}
        if not isinstance(metadata, dict):
            metadata = {}
        title = str(row["title"] or "")
        original_title = str(metadata.get("original_title") or row["original_title"] or "")
        aliases = _bounded_texts(alias_map.get(str(row["work_id"]), []), _SEARCH_FIELD_LIMITS['aliases'])
        tags = _bounded_texts(metadata.get("tags"), _SEARCH_FIELD_LIMITS['tags'])
        studios = _bounded_texts(metadata.get("studios"), _SEARCH_FIELD_LIMITS['studios'])
        matched_fields = [
            field
            for field, values in (
                ("title", [title]),
                ("original_title", [original_title]),
                ("aliases", aliases),
                ("tags", tags),
                ("studios", studios),
            )
            if any(needle in value.casefold() for value in values if value)
        ]
        items.append({
            "work_id": str(row["work_id"]),
            "title": title,
            "original_title": original_title,
            "year": row["year"],
            "media_type": row["media_type"],
            "matched_fields": matched_fields,
            "aliases": aliases,
            "tags": tags,
            "studios": studios,
        })
    return {"query": query, "limit": safe_limit, "truncated": truncated, "items": items}


@router.get("/works/{work_id}")
def get_work_detail(work_id: str):
    with get_database().connect() as conn:
        conn.execute('BEGIN')
        row = conn.execute("SELECT d.detail_json FROM library_details d JOIN v4_meta m "
                           "ON m.key='current_library_generation' AND m.value=d.generation_id "
                           "JOIN v4_meta p ON p.key='library_presentation_policy' AND p.value=? "
                           "WHERE d.work_id=?", (PRESENTATION_POLICY_VERSION, work_id)).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail='作品展示尚未发布')
        payload = json.loads(row['detail_json'])
        _published_artwork_payload(conn, payload)
        override = conn.execute('SELECT override_json FROM work_overrides WHERE work_id=?', (work_id,)).fetchone()
        values = json.loads(override['override_json']) if override else {}
        if values.get('hidden'):
            raise HTTPException(status_code=404, detail='作品已隐藏')
        automatic_title = payload.pop('_automatic_title', payload['title'])
        payload['title'] = values.get('title') or automatic_title
        automatic_provenance = payload.pop('_automatic_title_provenance', payload.get('title_provenance', 'local'))
        payload['title_provenance'] = 'manual' if values.get('title') else automatic_provenance
        state = conn.execute("SELECT * FROM tracking_states WHERE work_id=? AND provider='local'", (work_id,)).fetchone()
        if state:
            payload['watch_status'] = _watch_payload(dict(state))
        return payload






def _watch_status_map(work_ids: list[str]) -> dict[str, dict]:
    """批量读取 tracking_states，供列表卡片补 watch_status（收藏/追更）。"""

    if not work_ids:
        return {}
    rows = _rows_for_work_ids(
        "SELECT work_id,metadata_json,updated_at FROM tracking_states WHERE provider='local' AND work_id IN (",
        work_ids,
    )
    result: dict[str, dict] = {}
    for row in rows:
        result[str(row["work_id"])] = _watch_payload(dict(row))
    return result


@router.get("/diagnostics")
def diagnostics():
    summary = V4LibraryProjection(get_database()).summary()
    return {"ok": True, "digest": summary['digest'], "summary": {"work_count": summary['work_count']},
            "updating": summary['updating']}


@router.get("/watch-status")
def list_watch_status():
    with get_database().connect() as conn:
        rows = conn.execute("SELECT * FROM tracking_states WHERE provider = 'local' ORDER BY work_id").fetchall()
    return {"items": [_watch_payload(dict(row)) for row in rows]}


@router.get("/watch-status/{work_id}")
def get_watch_status(work_id: str):
    with get_database().connect() as conn:
        row = conn.execute(
            "SELECT * FROM tracking_states WHERE work_id = ? AND provider = 'local'",
            (work_id,),
        ).fetchone()
    return _watch_payload(dict(row)) if row else {"work_id": work_id, "status": "", "note": "", "favorite": False}


@router.patch("/watch-status/{work_id}")
def patch_watch_status(work_id: str, request: WatchStatusRequest):
    if request.status is not None and request.status not in {"", "watching", "watched", "on_hold", "dropped"}:
        raise HTTPException(status_code=400, detail="未知观看状态")
    with get_database().connect() as conn:
        exists = conn.execute(
            """
            SELECT 1 FROM revision_bindings rb
            JOIN import_revisions ir ON ir.revision_id = rb.revision_id
            WHERE rb.work_id = ? AND ir.status = 'confirmed' LIMIT 1
            """,
            (work_id,),
        ).fetchone()
    if exists is None:
        raise HTTPException(status_code=404, detail="作品不存在")
    with get_database().connect() as conn:
        current = conn.execute(
            "SELECT * FROM tracking_states WHERE work_id = ? AND provider = 'local'",
            (work_id,),
        ).fetchone()
    current_metadata = _watch_payload(dict(current)) if current else {"status": "", "note": "", "favorite": False}
    metadata = {
        "status": request.status if request.status is not None else current_metadata["status"],
        "note": request.note if request.note is not None else current_metadata["note"],
        "favorite": request.favorite if request.favorite is not None else current_metadata["favorite"],
    }
    from app.media_v4.tracking.store import V4TrackingStore

    store = V4TrackingStore(get_database())
    try:
        store.save_state(
            work_id,
            "local",
            provider_id="",
            last_watched_episode=None,
            metadata=metadata,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="作品不存在或已经失效") from exc
    return _watch_payload(store.get_state(work_id, "local"))


@router.post("/rescan")
def rescan_library():
    from app.media_v4.projection.library import request_projection_refresh

    task_id = request_projection_refresh(get_database())
    return {"task_id": task_id, "status": "accepted"}
