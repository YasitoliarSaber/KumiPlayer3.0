"""SQLite 图片需求与已发布资源；本模块不触碰文件系统或网络。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime

from app.media_v4.persistence.metadata_lifecycle import (
    episode_signature,
    identity_signature,
    snapshot_requirements_valid,
)

RECIPE_VERSION = 'webp-v1'
ROLE_WIDTHS = {
    'poster': (256, 384, 512),
    'fanart': (512, 768, 1280),
    'clearlogo': (256, 384, 512),
    'episode_thumb': (384, 768),
    'profile': (256, 384),
    'related_poster': (256, 384, 512),
}
ALL_WIDTHS = frozenset(width for widths in ROLE_WIDTHS.values() for width in widths)


def _enqueue(conn, *, work_id, subject_type, subject_id, role, source_url='', local_source='',
             priority=0, revision_id='', snapshot_id='', member_signature='') -> str:
    if role not in ROLE_WIDTHS:
        raise ValueError('Unsupported artwork role')
    resource_id = hashlib.sha256((source_url or f'local:{local_source}').encode('utf-8')).hexdigest()
    conn.execute("INSERT OR IGNORE INTO artwork_resources(resource_id,source_url,local_source,created_at) "
                 "VALUES (?,?,?,?)", (resource_id, source_url, local_source, datetime.now(UTC).isoformat()))
    conn.execute("""INSERT INTO artwork_bindings(subject_type,subject_id,work_id,role,candidate_id,
                        priority,revision_id,snapshot_id,automatic_id,member_signature,
                        automatic_revision_id,automatic_snapshot_id,automatic_member_signature)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(subject_type,subject_id,role) DO UPDATE SET
            candidate_id=CASE WHEN excluded.priority>=artwork_bindings.priority
                THEN excluded.candidate_id ELSE artwork_bindings.candidate_id END,
            priority=MAX(excluded.priority,artwork_bindings.priority),
            revision_id=CASE WHEN excluded.priority>=artwork_bindings.priority
                THEN excluded.revision_id ELSE artwork_bindings.revision_id END,
            snapshot_id=CASE WHEN excluded.priority>=artwork_bindings.priority
                THEN excluded.snapshot_id ELSE artwork_bindings.snapshot_id END,
            member_signature=CASE WHEN excluded.priority>=artwork_bindings.priority
                THEN excluded.member_signature ELSE artwork_bindings.member_signature END,
            automatic_id=CASE WHEN excluded.priority=0 THEN excluded.candidate_id
                ELSE artwork_bindings.automatic_id END,
            automatic_revision_id=CASE WHEN excluded.priority=0 THEN excluded.revision_id
                ELSE artwork_bindings.automatic_revision_id END,
            automatic_snapshot_id=CASE WHEN excluded.priority=0 THEN excluded.snapshot_id
                ELSE artwork_bindings.automatic_snapshot_id END,
            automatic_member_signature=CASE WHEN excluded.priority=0 THEN excluded.member_signature
                ELSE artwork_bindings.automatic_member_signature END""",
                 (subject_type, subject_id, work_id, role, resource_id, priority, revision_id, snapshot_id,
                  resource_id if priority == 0 else None, member_signature,
                  revision_id if priority == 0 else '', snapshot_id if priority == 0 else '',
                  member_signature if priority == 0 else ''))
    # 已就绪来源也需要经过后台发布，确保新增角色的全部尺寸已经存在。
    conn.execute("UPDATE artwork_resources SET state='pending',retry_at=0 WHERE resource_id=? AND state='ready' "
                 "AND EXISTS (SELECT 1 FROM artwork_bindings WHERE candidate_id=? "
                 "AND (published_id IS NULL OR published_id<>candidate_id))", (resource_id, resource_id))
    return resource_id


def enqueue_metadata(conn: sqlite3.Connection, *, revision_id: str, work_id: str,
                     snapshot_id: str, metadata: dict) -> None:
    snapshot = current_artwork_snapshot(conn, revision_id, work_id, snapshot_id)
    if snapshot is None:
        return
    # 图片来源只消费被本事务选中的不可变资料，不能被过时调用参数替换。
    metadata = json.loads(snapshot['metadata_json'])
    for role in ('poster', 'fanart', 'clearlogo'):
        url = str(metadata.get(f'{role}_url') or '').strip()
        if url:
            _enqueue(conn, work_id=work_id, subject_type='work', subject_id=work_id, role=role,
                     source_url=url, revision_id=revision_id, snapshot_id=snapshot_id)
    episode_sources = {}
    for episode in [*_metadata_items(metadata, 'episode_artworks'), *_metadata_items(metadata, 'episode_mappings')]:
        if episode.get('episode_id') and episode.get('still_url'):
            episode_sources[str(episode['episode_id'])] = episode
    for episode in episode_sources.values():
        episode_id = str(episode.get('episode_id') or '')
        url = str(episode.get('still_url') or '').strip()
        if not episode_id or not url:
            continue
        # 刮削只能关联已确认的集，不能凭上游 ID 创建本地身份。
        member = conn.execute('SELECT e.* FROM episodes e JOIN revision_bindings b ON b.episode_id=e.episode_id '
                              'WHERE b.revision_id=? AND b.episode_id=? AND b.work_id=?',
                              (revision_id, episode_id, work_id)).fetchone()
        if member:
            signature = episode_signature(dict(member))
            stored_signatures = json.loads(snapshot['episode_signatures_json'])
            if episode_id in stored_signatures and stored_signatures[episode_id] != signature:
                continue
            _enqueue(conn, work_id=work_id, subject_type='episode', subject_id=episode_id,
                     role='episode_thumb', source_url=url, revision_id=revision_id, snapshot_id=snapshot_id,
                     member_signature=signature)
    for role, items, keys in (
        ('profile', _metadata_items(metadata, 'cast'), ('profile_url', 'profile_path')),
        ('related_poster', [*_metadata_items(metadata, 'related_works'),
                            *_metadata_items(metadata, 'collection_related_works')], ('poster_url', 'poster_path')),
    ):
        for item in items:
            url = metadata_image_source(next((item.get(key) for key in keys if item.get(key)), ''))
            if url:
                subject = f'{work_id}:{hashlib.sha256(url.encode("utf-8")).hexdigest()}'
                _enqueue(conn, work_id=work_id, subject_type='metadata', subject_id=subject, role=role,
                         source_url=url, revision_id=revision_id, snapshot_id=snapshot_id)


def _metadata_items(metadata: dict, key: str) -> list[dict]:
    items = metadata.get(key)
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def current_artwork_snapshot(conn, revision_id: str, work_id: str, snapshot_id: str) -> dict | None:
    """自动图片发布与资料使用同一当前确认/身份/快照防线，全程只读 SQLite。"""
    row = conn.execute("""SELECT ms.* FROM revision_metadata_refs mr
        JOIN import_revisions ir ON ir.revision_id=mr.revision_id
        JOIN source_roots sr ON sr.root_id=ir.root_id
        JOIN metadata_snapshots ms ON ms.snapshot_id=mr.snapshot_id AND ms.work_id=mr.work_id
        WHERE mr.revision_id=? AND mr.work_id=? AND mr.snapshot_id=?
            AND ir.status='confirmed' AND sr.retired_at='' AND sr.enabled=1
            AND NOT EXISTS (SELECT 1 FROM v4_meta cancelled
                WHERE cancelled.key='artwork_cancelled_revision:'||mr.revision_id||':'||mr.work_id)
            AND EXISTS (SELECT 1 FROM revision_bindings rb
                WHERE rb.revision_id=mr.revision_id AND rb.work_id=mr.work_id)""",
                       (revision_id, work_id, snapshot_id)).fetchone()
    if row is None or row['identity_signature'] != identity_signature(conn, work_id):
        return None
    if not snapshot_requirements_valid(json.loads(row['metadata_json'])):
        return None
    return dict(row)


def binding_publishable(conn, binding: dict) -> bool:
    if binding['priority'] >= 100:
        return bool(conn.execute("SELECT 1 FROM works WHERE work_id=? AND status='active'",
                                 (binding['work_id'],)).fetchone())
    snapshot = current_artwork_snapshot(conn, binding['revision_id'], binding['work_id'], binding['snapshot_id'])
    if snapshot is None:
        return False
    if binding['subject_type'] != 'episode':
        return True
    member = conn.execute('SELECT e.* FROM episodes e JOIN revision_bindings rb ON rb.episode_id=e.episode_id '
                          'WHERE rb.revision_id=? AND rb.work_id=? AND e.episode_id=?',
                          (binding['revision_id'], binding['work_id'], binding['subject_id'])).fetchone()
    return bool(member and binding['member_signature']
                and binding['member_signature'] == episode_signature(dict(member)))


def metadata_image_source(value: str) -> str:
    value = str(value or '').strip()
    return f'https://image.tmdb.org/t/p/original{value}' if value.startswith('/') else value


def get_metadata_image(conn: sqlite3.Connection, source: str, width: int = 384) -> str | None:
    """演员和推荐图同样消费后台已发布资源，保持它们与媒体身份独立。"""
    url = metadata_image_source(source)
    resource_id = hashlib.sha256(url.encode('utf-8')).hexdigest()
    row = conn.execute("SELECT r.content_digest FROM artwork_resources r JOIN artwork_variants v "
                       "ON v.content_digest=r.content_digest WHERE r.resource_id=? "
                       "AND v.recipe_version=? AND v.width=? "
                       "AND EXISTS (SELECT 1 FROM artwork_bindings b WHERE b.published_id=r.resource_id)",
                       (resource_id, RECIPE_VERSION, width)).fetchone()
    if row:
        return f'/api/assets/artwork/{resource_id}/{row["content_digest"]}-{RECIPE_VERSION}/{width}'
    return None


def enqueue_manual(conn: sqlite3.Connection, *, work_id: str, role: str, local_path: str) -> str:
    return _enqueue(conn, work_id=work_id, subject_type='work', subject_id=work_id, role=role,
                    local_source=local_path, priority=100)


def retry_work(conn: sqlite3.Connection, work_id: str) -> int:
    """显式图片重试只解除这个作品的取消域，不重新刮削或唤醒其他作品。"""
    revisions = {row[0] for row in conn.execute('SELECT revision_id FROM artwork_bindings WHERE work_id=? '
                                              'UNION SELECT automatic_revision_id FROM artwork_bindings WHERE work_id=?',
                                              (work_id, work_id)) if row[0]}
    for revision in revisions:
        conn.execute('DELETE FROM v4_meta WHERE key=?', (f'artwork_cancelled_revision:{revision}:{work_id}',))
    return conn.execute("UPDATE artwork_resources SET state='pending',retry_at=0,error_kind='' "
                        "WHERE state IN ('retry','failed','cancelled') AND resource_id IN "
                        "(SELECT candidate_id FROM artwork_bindings WHERE work_id=?)", (work_id,)).rowcount


def restore_auto(conn: sqlite3.Connection, work_id: str, role: str) -> None:
    """恢复自动角色关联；手工原图与旧发布图保留到自动候选就绪。"""
    row = conn.execute("SELECT * FROM artwork_bindings WHERE subject_type='work' "
                       'AND subject_id=? AND role=?', (work_id, role)).fetchone()
    if row is None:
        return
    if not row['automatic_id']:
        conn.execute("DELETE FROM artwork_bindings WHERE subject_type='work' AND subject_id=? AND role=?",
                     (work_id, role))
        from app.media_v4.projection.library import bump_display_version

        bump_display_version(conn, work_id, kind='artwork')
        return
    conn.execute("UPDATE artwork_bindings SET candidate_id=automatic_id,priority=0, "
                 "revision_id=automatic_revision_id,snapshot_id=automatic_snapshot_id, "
                 "member_signature=automatic_member_signature "
                 "WHERE subject_type='work' AND subject_id=? AND role=?", (work_id, role))
    if current_artwork_snapshot(conn, row['automatic_revision_id'], work_id, row['automatic_snapshot_id']) is None:
        return
    conn.execute("UPDATE artwork_resources SET state='pending',retry_at=0 WHERE resource_id=? "
                 "AND state IN ('ready','retry','failed')", (row['automatic_id'],))


def get_subject_artwork(conn: sqlite3.Connection, subject_type: str, subject_id: str) -> dict:
    return _get_subject_artwork_many(conn, subject_type, [subject_id]).get(subject_id, {})


def _get_subject_artwork_many(conn: sqlite3.Connection, subject_type: str, subject_ids: list[str]) -> dict:
    result = {}
    subjects = list(dict.fromkeys(subject_ids))
    for offset in range(0, len(subjects), 500):
        batch = subjects[offset:offset + 500]
        placeholders = ','.join('?' for _ in batch)
        rows = conn.execute(f"""SELECT b.subject_id,b.role,r.resource_id,r.content_digest,v.width
            FROM artwork_bindings b JOIN artwork_resources r ON r.resource_id=b.published_id
            JOIN artwork_variants v ON v.content_digest=r.content_digest AND v.recipe_version=?
            WHERE b.subject_type=? AND b.subject_id IN ({placeholders}) AND r.content_digest<>''""",
                            (RECIPE_VERSION, subject_type, *batch))
        for row in rows:
            if row['width'] not in ROLE_WIDTHS[row['role']]:
                continue
            version = f'{row["content_digest"]}-{RECIPE_VERSION}'
            image = result.setdefault(row['subject_id'], {}).setdefault(row['role'], {
                'resource_id': row['resource_id'], 'content_version': version, 'variants': {}, 'state': 'ready',
            })
            image['variants'][str(row['width'])] = (
                f'/api/assets/artwork/{row["resource_id"]}/{version}/{row["width"]}'
            )
    return result


def get_work_artwork(conn: sqlite3.Connection, work_id: str) -> dict:
    return get_subject_artwork(conn, 'work', work_id)


def get_episode_artwork(conn: sqlite3.Connection, episode_id: str) -> dict:
    return get_subject_artwork(conn, 'episode', episode_id)


def get_work_artwork_many(conn: sqlite3.Connection, work_ids: list[str]) -> dict:
    return _get_subject_artwork_many(conn, 'work', work_ids)


def get_episode_artwork_many(conn: sqlite3.Connection, episode_ids: list[str]) -> dict:
    return _get_subject_artwork_many(conn, 'episode', episode_ids)
