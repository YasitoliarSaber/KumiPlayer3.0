"""从 V4 SQLite authority 原子重建 Library Projection。"""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from app.media_v4.persistence.database import V4Database
from app.media_v4.projection.presentation import (
    PRESENTATION_POLICY_VERSION,
    VISIBLE_BINDING_SQL,
    display_work_title,
    preserve_identity_title,
)

# 同一进程只允许一个构建发布；读请求不获取此锁。RLock 保留嵌套维护调用。
_BUILD_LOCK = threading.RLock()
COMPACT_METADATA_FIELDS = (
    'provider', 'original_title', 'rating', 'plot', 'genres', 'sources', 'show_type', 'card_type',
    'regular_season_count', 'special_season_count', 'latest_episode_number', 'poster_url', 'fanart_url', 'clearlogo_url',
    'local_poster_path', 'local_fanart_path', 'local_clearlogo_path', 'clearlogo_path',
    'metadata_state', 'preserve_identity_title', 'title', 'related_works', 'collection_related_works', 'collections', 'content_scope',
)


def bump_display_version(conn, work_id: str = '', *, kind: str = 'work_upsert') -> None:
    """与覆盖/观看写入同事务通知展示变化，不要求重新物化媒体投影。"""
    conn.execute("INSERT OR REPLACE INTO v4_meta(key,value) VALUES ('library_display_version',?)",
                 (str(uuid.uuid4()),))
    from app.media_v4.projection.changes import record_change

    record_change(conn, kind if work_id else 'reset', work_id)


def mark_projection_dirty(conn, work_ids=None) -> str:
    """同事实事务记录受影响作品；无法确定范围的维护操作显式要求全量。"""
    stamp = str(uuid.uuid4())
    conn.execute("INSERT OR REPLACE INTO v4_meta(key,value) VALUES ('library_projection_dirty',?)", (stamp,))
    if work_ids is None:
        conn.execute("INSERT OR REPLACE INTO v4_meta(key,value) VALUES ('library_projection_full_dirty',?)", (stamp,))
    else:
        affected = set(work_ids)
        originals = sorted(affected)
        for offset in range(0, len(originals), 200):
            batch = originals[offset:offset + 200]
            placeholders = ','.join('?' for _ in batch)
            # 父子关系、共享 TV 绑定和合集邻居也会改变已发布展示，不能留下旧标题/成员。
            affected.update(row[0] for row in conn.execute(f'''
                SELECT wr.parent_work_id FROM work_relations wr WHERE wr.child_work_id IN ({placeholders})
                UNION SELECT wr.child_work_id FROM work_relations wr WHERE wr.parent_work_id IN ({placeholders})
                UNION SELECT other.work_id FROM provider_bindings local JOIN provider_bindings other
                    ON other.provider=local.provider AND other.media_type=local.media_type
                    AND other.provider_id=local.provider_id
                    WHERE local.work_id IN ({placeholders}) AND local.provider_id<>''
                UNION SELECT other.work_id FROM revision_collection_members local
                    JOIN revision_collection_members other ON other.collection_id=local.collection_id
                    JOIN import_revisions ir ON ir.revision_id=other.revision_id AND ir.status='confirmed'
                    JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.retired_at=''
                    WHERE local.work_id IN ({placeholders})
            ''', (*batch, *batch, *batch, *batch)))
        conn.executemany('INSERT OR REPLACE INTO v4_meta(key,value) VALUES (?,?)',
                         [('library_dirty_work:' + str(work_id), stamp) for work_id in affected])
    return stamp


def request_projection_refresh(database: V4Database, work_ids=None) -> str:
    """Persist projection dirtiness and enqueue the existing refresh job when possible."""
    stamp = str(uuid.uuid4())
    now = _now()
    with database.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        stamp = mark_projection_dirty(conn, work_ids)
        revision = conn.execute(
            "SELECT ir.revision_id FROM import_revisions ir "
            "WHERE ir.status='confirmed' ORDER BY ir.confirmed_at DESC, ir.created_at DESC, ir.revision_id DESC LIMIT 1"
        ).fetchone()
        job_id = ''
        if revision is not None:
            job_id = str(uuid.uuid4())
            conn.execute(
                "INSERT INTO jobs(job_id,job_type,revision_id,work_id,idempotency_key,status,created_at,updated_at) "
                "VALUES (?,'refresh_projection',?,'',?,'queued',?,?)",
                (job_id, revision['revision_id'], f'refresh_projection:maintenance:{stamp}', now, now),
            )
    return job_id or f'projection:{stamp}'


def display_digest(digest: str, version: str) -> str:
    return hashlib.sha256(f'{digest}:{version}'.encode()).hexdigest() if digest else ''


def _now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True, slots=True)
class LibrarySnapshot:
    generation_id: str
    digest: str
    cards: tuple[dict, ...] = field(default_factory=tuple)
    change_sequence: int = 0


class V4LibraryProjection:
    """在读快照中构建投影，只在原子发布阶段持有写入锁。"""

    def __init__(self, database: V4Database):
        self.database = database

    def current(self, *, work_ids: tuple[str, ...] | None = None) -> LibrarySnapshot | None:
        """读取已发布 generation；没有 generation 时返回空。

        三条 SELECT 必须在**同一个读事务**里完成：并发 rebuild 的收尾会
        `DELETE FROM library_generations WHERE generation_id != ?`，而 library_cards
        是 `ON DELETE CASCADE`。没有读事务时（sqlite3 默认 autocommit，SELECT 各自
        看一次最新提交），若 rebuild 在"读到 generation"与"读 cards"之间提交，
        cards 查询会返回空集，于是媒体墙在一切正常的情况下瞬间清空。WAL 下读事务会稳定持有快照。
        """

        with self.database.connect() as conn:
            conn.execute("BEGIN")
            try:
                snapshot = self._read_current(conn, work_ids=work_ids)
            except Exception:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")
        return snapshot

    @staticmethod
    def _read_current(
        conn, *, work_ids: tuple[str, ...] | None = None, for_publication: bool = False,
    ) -> LibrarySnapshot | None:
        """在同一读事务内读取 generation 与它的 cards。"""

        generation_id_row = conn.execute(
            "SELECT value FROM v4_meta WHERE key = 'current_library_generation'"
        ).fetchone()
        if generation_id_row is None:
            return None
        generation_id = str(generation_id_row["value"])
        generation = conn.execute(
            "SELECT digest FROM library_generations WHERE generation_id = ? AND status = 'published'",
            (generation_id,),
        ).fetchone()
        if generation is None:
            return None
        fields = ','.join(f"'{key}',json_extract(metadata_json,'$.{key}')" for key in COMPACT_METADATA_FIELDS)
        metadata_column = f"CASE WHEN json_valid(metadata_json) THEN json_patch('{{}}',json_object({fields})) ELSE '{{}}' END AS metadata_json"
        if for_publication:
            # 发布时比较同一份持久内容；公开读取始终保持精简卡片。
            metadata_column = 'metadata_json'
        scope = '' if work_ids is None else ' AND work_id IN (' + ','.join('?' for _ in work_ids) + ')'
        cards = tuple(
            V4LibraryProjection._decode_card(dict(row))
            for row in conn.execute(
                f"""
                SELECT work_id, title, year, media_type, episode_count, asset_count, {metadata_column}
                FROM library_cards WHERE generation_id = ? {scope} ORDER BY title COLLATE NOCASE, work_id
                """,
                (generation_id, *(work_ids or ())),
            ).fetchall()
        )
        from app.media_v4.projection.changes import latest_sequence

        return LibrarySnapshot(generation_id, str(generation["digest"]), cards, latest_sequence(conn))

    def summary(self) -> dict:
        """只读已发布代次和持久计数，复杂度不随作品数增长。"""
        with self.database.connect() as conn:
            row = conn.execute("""
                SELECT g.generation_id,g.digest,s.value AS summary,
                       COALESCE(v.value,'') AS display_version,
                       EXISTS(SELECT 1 FROM v4_meta WHERE key='library_projection_dirty') AS dirty
                FROM v4_meta m JOIN library_generations g ON g.generation_id=m.value AND g.status='published'
                LEFT JOIN v4_meta s ON s.key='library_published_summary'
                LEFT JOIN v4_meta v ON v.key='library_display_version'
                WHERE m.key='current_library_generation'
            """).fetchone()
        if row is None:
            return {'digest': '', 'generation_id': '', 'work_count': 0, 'updating': True}
        try:
            summary = json.loads(row['summary'] or '{}')
        except (ValueError, TypeError):
            summary = {}
        valid = summary.get('generation_id') == row['generation_id']
        return {'digest': display_digest(row['digest'], row['display_version']),
                'generation_id': row['generation_id'], 'work_count': summary.get('work_count', 0) if valid else 0,
                'updating': bool(row['dirty']) or not valid}

    def refresh_if_needed(self) -> LibrarySnapshot | None:
        """构建锁内复核，合并并发后台调度，避免等待后又构建同一代次。"""
        with _BUILD_LOCK:
            summary = self.summary()
            with self.database.connect() as conn:
                policy = conn.execute("SELECT value FROM v4_meta WHERE key='library_presentation_policy'").fetchone()
            if not summary['updating'] and policy is not None and policy[0] == PRESENTATION_POLICY_VERSION:
                return None
            with self.database.connect() as conn:
                full = conn.execute("SELECT 1 FROM v4_meta WHERE key='library_projection_full_dirty'").fetchone()
                dirty_ids = tuple(row[0].split(':', 1)[1] for row in conn.execute(
                    "SELECT key FROM v4_meta WHERE key LIKE 'library_dirty_work:%' ORDER BY key LIMIT 64"))
            scope = dirty_ids if dirty_ids and not full and policy and policy[0] == PRESENTATION_POLICY_VERSION else None
            return self._rebuild(work_ids=scope)

    def rebuild(self) -> LibrarySnapshot:
        from app.media_v4.persistence.artifact_validation import validation_scope

        with _BUILD_LOCK, validation_scope():
            return self._rebuild()

    def _rebuild(self, *, work_ids: tuple[str, ...] | None = None) -> LibrarySnapshot:
        generation_id = str(uuid.uuid4())
        now = _now()
        with self.database.connect() as conn:
            # 文件摘要检查可能很慢；WAL 读快照允许扫描、刮削心跳继续写入。
            # data_version 必须在同一连接比较，并在取得发布锁之后复查。
            data_version = conn.execute("PRAGMA data_version").fetchone()[0]
            conn.execute("BEGIN")
            try:
                previous_generation = conn.execute(
                    "SELECT value FROM v4_meta WHERE key='current_library_generation'"
                ).fetchone()
                previous_generation_id = previous_generation[0] if previous_generation else None
                if work_ids is not None and previous_generation_id is None:
                    work_ids = None
                if work_ids is not None:
                    assert previous_generation_id is not None
                    generation_id = previous_generation_id
                scope_sql = '' if work_ids is None else ' AND w.work_id IN (' + ','.join('?' for _ in work_ids) + ')'
                rows = conn.execute(
                    f"""
                    WITH visible_bindings AS (
                        SELECT rb.* FROM revision_bindings rb WHERE {VISIBLE_BINDING_SQL}
                    ), scrape_rows AS (
                        SELECT
                            sb.work_id,
                            sb.revision_id,
                            sb.status,
                            sb.metadata_json,
                            ROW_NUMBER() OVER (
                                PARTITION BY sb.work_id
                                ORDER BY sb.updated_at DESC, sb.binding_id DESC
                            ) AS latest_rank,
                            -- 同一 work 中"最近一次 confirmed 结果"。最新一次刷新失败时用它
                            -- 回退，而不是把已经发布过的作品整条移出媒体墙。
                            ROW_NUMBER() OVER (
                                PARTITION BY sb.work_id, CASE WHEN sb.status = 'confirmed' THEN 1 ELSE 0 END
                                ORDER BY sb.updated_at DESC, sb.binding_id DESC
                            ) AS confirmed_rank
                        FROM scrape_bindings sb
                        JOIN import_revisions sir ON sir.revision_id = sb.revision_id
                        JOIN source_roots srs ON srs.root_id = sir.root_id
                        WHERE sir.status = 'confirmed' AND srs.retired_at = ''
                    ),
                    latest_scrapes AS (
                        SELECT * FROM scrape_rows WHERE latest_rank = 1
                    ),
                    latest_confirmed AS (
                        SELECT * FROM scrape_rows WHERE confirmed_rank = 1 AND status = 'confirmed'
                    )
                    SELECT
                        w.work_id,
                        w.preferred_title AS title,
                        w.year,
                        w.show_type,
                        w.card_type,
                        CASE WHEN w.work_type = 'series' THEN 'tv' WHEN w.work_type = 'movie' THEN 'movie' ELSE 'unknown' END AS media_type,
                        latest_scrapes.revision_id AS revision_id,
                        (SELECT sr.content_scope FROM visible_bindings rb
                         JOIN import_revisions ir ON ir.revision_id=rb.revision_id
                         JOIN source_roots sr ON sr.root_id=ir.root_id
                         WHERE rb.work_id=w.work_id AND ir.status='confirmed' AND sr.retired_at=''
                         AND sr.content_scope IN ('ongoing','completed')
                         ORDER BY CASE sr.content_scope WHEN 'ongoing' THEN 0 ELSE 1 END LIMIT 1) AS content_scope,
                        CASE WHEN w.work_type != 'movie' THEN (
                            SELECT COUNT(DISTINCT rb.episode_id)
                            FROM visible_bindings rb
                            JOIN import_revisions ir ON ir.revision_id = rb.revision_id
                            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
                            WHERE rb.work_id = w.work_id AND rb.episode_id IS NOT NULL
                              AND ir.status = 'confirmed'
                        ) ELSE CASE WHEN EXISTS (
                            SELECT 1 FROM visible_bindings rb
                            JOIN import_revisions ir ON ir.revision_id = rb.revision_id
                            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
                            WHERE rb.work_id = w.work_id AND rb.episode_id IS NULL
                              AND rb.asset_id IS NOT NULL AND ir.status = 'confirmed'
                        ) THEN 1 ELSE 0 END END AS episode_count,
                        (
                            SELECT COUNT(DISTINCT rb.asset_id)
                            FROM visible_bindings rb
                            JOIN import_revisions ir ON ir.revision_id = rb.revision_id
                            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
                            WHERE rb.work_id = w.work_id AND rb.asset_id IS NOT NULL
                              AND ir.status = 'confirmed'
                        ) AS asset_count,
                        COALESCE(latest_scrapes.metadata_json, '{{}}') AS scraped_metadata_json,
                        COALESCE(latest_scrapes.status, '') AS scrape_binding_status,
                        latest_confirmed.revision_id AS previous_ready_revision_id,
                        COALESCE(latest_confirmed.metadata_json, '{{}}') AS previous_ready_metadata_json,
                        COALESCE((
                            SELECT GROUP_CONCAT(DISTINCT provider) FROM (
                                SELECT se.provider
                                FROM visible_bindings rb
                                JOIN import_revisions ir ON ir.revision_id = rb.revision_id
                            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
                                JOIN assets a ON a.asset_id = rb.asset_id
                                JOIN source_evidence se ON se.evidence_id = rb.evidence_id
                                WHERE rb.work_id = w.work_id AND ir.status = 'confirmed'
                            )
                        ), '') AS source_providers,
                        (
                            SELECT COUNT(DISTINCT s.local_season_number)
                            FROM seasons s
                            JOIN episodes e ON e.season_id = s.season_id
                            JOIN visible_bindings rb ON rb.episode_id = e.episode_id
                            JOIN import_revisions ir ON ir.revision_id = rb.revision_id
                            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
                            WHERE s.work_id = w.work_id AND ir.status = 'confirmed'
                              AND s.season_kind = 'regular'
                        ) AS regular_season_count,
                        (
                            SELECT COUNT(DISTINCT s.local_season_number)
                            FROM seasons s
                            JOIN episodes e ON e.season_id = s.season_id
                            JOIN visible_bindings rb ON rb.episode_id = e.episode_id
                            JOIN import_revisions ir ON ir.revision_id = rb.revision_id
                            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
                            WHERE s.work_id = w.work_id AND ir.status = 'confirmed'
                              AND s.season_kind != 'regular'
                        ) AS special_season_count,
                        (
                            SELECT MAX(e.local_episode_number)
                            FROM episodes e
                            JOIN visible_bindings rb ON rb.episode_id = e.episode_id
                            JOIN import_revisions ir ON ir.revision_id = rb.revision_id
                            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
                            WHERE e.work_id = w.work_id AND ir.status = 'confirmed'
                              AND e.episode_kind = 'regular'
                        ) AS latest_episode_number
                    FROM works w
                    LEFT JOIN latest_scrapes
                      ON latest_scrapes.work_id = w.work_id
                    LEFT JOIN latest_confirmed
                      ON latest_confirmed.work_id = w.work_id
                    WHERE EXISTS (
                        SELECT 1 FROM visible_bindings rb
                        JOIN import_revisions ir ON ir.revision_id = rb.revision_id
                            JOIN source_roots sr ON sr.root_id = ir.root_id AND sr.retired_at = ''
                        WHERE rb.work_id = w.work_id AND ir.status = 'confirmed'
                    )
                    {scope_sql}
                    ORDER BY title COLLATE NOCASE, w.work_id
                    """, work_ids or (),
                ).fetchall()
                cards_list = []
                from app.media_v4.projection.collections import collection_metadata, title_identity_guards
                local_collections = collection_metadata(conn)
                identity_title_ids, shared_tv_ids = title_identity_guards(conn)
                for row in rows:
                    try:
                        metadata = json.loads(row["scraped_metadata_json"] or "{}")
                    except (TypeError, ValueError):
                        metadata = {}
                    metadata["sources"] = sorted(
                        filter(None, str(row["source_providers"] or "").split(","))
                    )
                    regular_season_count = int(row["regular_season_count"] or 0)
                    special_season_count = int(row["special_season_count"] or 0)
                    metadata["regular_season_count"] = regular_season_count
                    metadata["special_season_count"] = special_season_count
                    metadata['latest_episode_number'] = row['latest_episode_number']
                    # 元数据状态：只有 confirmed + ready 才是正式可发布；
                    # 等待类状态保持非 ready，不得冒充成功（P-001 7.3.E）。
                    binding_status = str(row["scrape_binding_status"] or "")
                    meta_state = str(metadata.get("metadata_state") or "")
                    from app.media_v4.jobs.completeness import artifact_only_failure

                    if artifact_only_failure(metadata):
                        # 历史记录里“只缺图片”的失败只读归一：作品照常进入媒体库，
                        # 产物标成 degraded 供 UI 提示，不写回真实数据。
                        state = "ready"
                        metadata["artifact_state"] = "degraded"
                        metadata["artifact_reasons"] = [
                            str(item) for item in (metadata.get("completeness") or [])
                        ]
                        metadata["reason"] = "部分图片产物缺失，可重新下载"
                    elif binding_status == "confirmed" and meta_state == "ready":
                        state = "ready"
                    elif binding_status in {"waiting_metadata", "waiting_review", "source_unavailable", "failed"}:
                        state = binding_status
                    elif binding_status == "not_required":
                        state = "not_required"
                    elif binding_status == "confirmed":
                        state = meta_state or "waiting_metadata"
                    else:
                        state = "waiting_metadata"
                    metadata["metadata_state"] = state
                    from app.media_v4.persistence.metadata_lifecycle import referenced_metadata

                    retained_metadata = referenced_metadata(conn, str(row['work_id']))
                    if retained_metadata is not None:
                        metadata = {**metadata, **retained_metadata}
                    elif state == 'ready':
                        # 未引用的历史成功绑定不是已发布快照，不能形成隐藏资料恢复链。
                        metadata = {
                            'sources': metadata['sources'], 'regular_season_count': regular_season_count,
                            'special_season_count': special_season_count,
                            'latest_episode_number': row['latest_episode_number'],
                            'metadata_state': 'waiting_metadata',
                        }
                    from app.media_v4.jobs.metadata_quality import current_episode_metadata
                    if retained_metadata is None:
                        metadata = current_episode_metadata(conn, None, str(row['work_id']), metadata)
                    show_type = str(row["show_type"] or "")
                    card_type = str(row["card_type"] or "")
                    metadata["show_type"] = show_type
                    metadata["card_type"] = card_type
                    metadata['content_scope'] = row['content_scope'] or ''
                    metadata.update(local_collections.get(str(row["work_id"]), {
                        "collections": [], "collection_related_works": [],
                    }))
                    metadata["preserve_identity_title"] = preserve_identity_title(
                        str(row["work_id"]), row["media_type"], metadata, identity_title_ids, shared_tv_ids,
                    )
                    cards_list.append({
                        "work_id": row["work_id"],
                        "title": display_work_title(row["title"], metadata,
                                                    preserve_identity=metadata["preserve_identity_title"]),
                        "year": metadata.get("year") or row["year"],
                        "media_type": row["media_type"],
                        "show_type": show_type,
                        "card_type": card_type,
                        "episode_count": row["episode_count"],
                        "asset_count": row["asset_count"],
                        "regular_season_count": regular_season_count,
                        "special_season_count": special_season_count,
                        "latest_episode_number": row["latest_episode_number"],
                        "metadata": metadata,
                    })
                cards = tuple(cards_list)
                from app.media_v4.projection.details import build_work_detail

                detail_rows = [(generation_id, card['work_id'], json.dumps(
                    build_work_detail(conn, str(card['work_id']), dict(card['metadata'])),
                    ensure_ascii=False, sort_keys=True)) for card in cards]
                digest = hashlib.sha256(
                    json.dumps(cards, ensure_ascii=False, sort_keys=True).encode("utf-8")
                ).hexdigest()
                card_rows = [(
                    generation_id, card["work_id"], card["title"], card["year"],
                    card["media_type"], card["episode_count"], card["asset_count"],
                    json.dumps(card["metadata"], ensure_ascii=False, sort_keys=True),
                ) for card in cards]
                conn.commit()
                conn.execute("BEGIN IMMEDIATE")
                changed_during_build = conn.execute("PRAGMA data_version").fetchone()[0] != data_version
                current_generation = conn.execute(
                    "SELECT value FROM v4_meta WHERE key='current_library_generation'"
                ).fetchone()
                current_generation_id = current_generation[0] if current_generation else None
                if current_generation_id != previous_generation_id:
                    # 另一个重建已经发布了更新的快照，不能用本次旧读快照覆盖。
                    current_snapshot = self._read_current(conn)
                    if current_snapshot is not None:
                        conn.commit()
                        return current_snapshot
                current_snapshot = (
                    self._read_current(conn, work_ids=work_ids, for_publication=True)
                    if current_generation_id else None
                )
                previous_cards = {
                    card['work_id']: card for card in (current_snapshot.cards if current_snapshot else ())
                }
                detail_scope = '' if work_ids is None else ' AND work_id IN (' + ','.join('?' for _ in work_ids) + ')'
                previous_details = {row['work_id']: row['detail_json'] for row in conn.execute(
                    'SELECT work_id,detail_json FROM library_details WHERE generation_id=?' + detail_scope,
                    (current_generation_id, *(work_ids or ())))}
                next_details = {row[1]: row[2] for row in detail_rows}
                changed_ids = set()
                from app.media_v4.projection.changes import record_change

                for card in cards:
                    if card != previous_cards.pop(card['work_id'], None) or next_details.get(card['work_id']) != previous_details.get(card['work_id']):
                        changed_ids.add(card['work_id'])
                        record_change(conn, 'work_upsert', str(card['work_id']))
                for work_id in previous_cards:
                    changed_ids.add(work_id)
                    record_change(conn, 'work_remove', work_id)
                if work_ids is None:
                    conn.execute("INSERT INTO library_generations(generation_id, digest, created_at) VALUES (?, ?, ?)",
                                 (generation_id, digest, now))
                else:
                    previous_digest = conn.execute('SELECT digest FROM library_generations WHERE generation_id=?',
                                                   (generation_id,)).fetchone()[0]
                    digest = hashlib.sha256((previous_digest + digest + repr(work_ids)).encode()).hexdigest() if changed_ids else previous_digest
                    conn.execute('UPDATE library_generations SET digest=? WHERE generation_id=?', (digest, generation_id))
                    conn.executemany('DELETE FROM library_cards WHERE generation_id=? AND work_id=?',
                                     [(generation_id, work_id) for work_id in changed_ids])
                    conn.executemany('DELETE FROM library_details WHERE generation_id=? AND work_id=?',
                                     [(generation_id, work_id) for work_id in changed_ids])
                    card_rows = [row for row in card_rows if row[1] in changed_ids]
                    detail_rows = [row for row in detail_rows if row[1] in changed_ids]
                conn.executemany(
                    """
                    INSERT INTO library_cards(
                        generation_id, work_id, title, year, media_type,
                        episode_count, asset_count, metadata_json
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    card_rows,
                )
                conn.executemany('INSERT INTO library_details(generation_id,work_id,detail_json) VALUES (?,?,?)',
                                 detail_rows)
                conn.execute(
                    "UPDATE library_generations SET status = 'published', published_at = ? WHERE generation_id = ?",
                    (now, generation_id),
                )
                conn.execute(
                    "INSERT INTO v4_meta(key, value) VALUES ('current_library_generation', ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (generation_id,),
                )
                visible_count = conn.execute('SELECT COUNT(*) FROM library_cards c WHERE generation_id=? AND NOT EXISTS ('
                                             "SELECT 1 FROM work_overrides o WHERE o.work_id=c.work_id "
                                             "AND json_valid(o.override_json) AND json_extract(o.override_json,'$.hidden')=1)",
                                             (generation_id,)).fetchone()[0]
                conn.execute("INSERT OR REPLACE INTO v4_meta(key,value) VALUES ('library_published_summary',?)",
                             (json.dumps({'generation_id': generation_id, 'work_count': visible_count}),))
                if changed_during_build:
                    # 发布的是完整但稍早的快照。保留刷新要求，不能吞掉并发事实更新。
                    conn.execute(
                        "INSERT OR REPLACE INTO v4_meta(key,value) VALUES ('library_projection_dirty',?)",
                        (now,),
                    )
                else:
                    if work_ids is None:
                        conn.execute("DELETE FROM v4_meta WHERE key='library_projection_full_dirty' OR key LIKE 'library_dirty_work:%'")
                    else:
                        conn.executemany('DELETE FROM v4_meta WHERE key=?',
                                         [('library_dirty_work:' + work_id,) for work_id in work_ids])
                    if not conn.execute("SELECT 1 FROM v4_meta WHERE key LIKE 'library_dirty_work:%' LIMIT 1").fetchone():
                        conn.execute("DELETE FROM v4_meta WHERE key = 'library_projection_dirty'")
                conn.execute(
                    "INSERT INTO v4_meta(key,value) VALUES ('library_presentation_policy',?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (PRESENTATION_POLICY_VERSION,),
                )
                conn.execute(
                    "DELETE FROM library_generations WHERE generation_id != ?",
                    (generation_id,),
                )
                from app.media_v4.projection.changes import latest_sequence
                sequence = latest_sequence(conn)
                conn.commit()
                return LibrarySnapshot(generation_id, digest, cards, sequence)
            except Exception:
                conn.rollback()
                raise


    @staticmethod
    def _decode_card(card: dict) -> dict:
        try:
            card["metadata"] = json.loads(card.pop("metadata_json") or "{}")
            card['latest_episode_number'] = card['metadata'].get('latest_episode_number')
            for key in ('show_type', 'card_type'):
                card[key] = card['metadata'].get(key) or ''
            for key in ('regular_season_count', 'special_season_count'):
                card[key] = int(card['metadata'].get(key) or 0)
        except (TypeError, ValueError):
            card.pop("metadata_json", None)
            card["metadata"] = {}
        return card
