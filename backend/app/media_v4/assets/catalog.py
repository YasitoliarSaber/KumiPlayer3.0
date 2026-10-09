"""SQLite 图片需求与已发布资源；本模块不触碰文件系统或网络。"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

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
            url = metadata_image_source(str(next((item.get(key) for key in keys if item.get(key)), '')))
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


def get_metadata_images_many(conn: sqlite3.Connection, sources: list[str], width: int = 384) -> dict[str, str]:
    """按有限 IN 批次读取演员/相关推荐图，键保留调用方传入的来源字符串。"""
    if width not in {256, 384, 512}:
        return {}
    source_urls = {}
    for source in sources:
        raw = str(source or '')
        if raw.strip():
            source_urls[raw] = metadata_image_source(raw)
    resource_to_url = {
        hashlib.sha256(url.encode('utf-8')).hexdigest(): url for url in source_urls.values()
    }
    resource_ids = list(resource_to_url)
    if not resource_ids:
        return {}

    published = {}
    for offset in range(0, len(resource_ids), 500):
        batch = resource_ids[offset:offset + 500]
        placeholders = ','.join('?' for _ in batch)
        rows = conn.execute(
            f"""SELECT r.resource_id,r.content_digest FROM artwork_resources r
            JOIN artwork_variants v ON v.content_digest=r.content_digest
            WHERE r.resource_id IN ({placeholders}) AND v.recipe_version=? AND v.width=?
            AND r.content_digest<>''
            AND EXISTS (SELECT 1 FROM artwork_bindings b WHERE b.published_id=r.resource_id)""",
            (*batch, RECIPE_VERSION, width),
        )
        for row in rows:
            version = f'{row["content_digest"]}-{RECIPE_VERSION}'
            published[resource_to_url[row['resource_id']]] = (
                f'/api/assets/artwork/{row["resource_id"]}/{version}/{width}'
            )
    return {raw: published[url] for raw, url in source_urls.items() if url in published}


def enqueue_manual(conn: sqlite3.Connection, *, work_id: str, role: str, local_path: str) -> str:
    if role not in {'poster', 'fanart', 'clearlogo'}:
        raise ValueError('Unsupported manual artwork role')
    if (not isinstance(local_path, str) or not local_path or '\x00' in local_path
            or not Path(local_path).is_absolute()
            or Path(local_path).suffix.lower() not in {'.jpg', '.jpeg', '.png', '.webp'}):
        raise ValueError('Invalid manual artwork source')
    return _enqueue(conn, work_id=work_id, subject_type='work', subject_id=work_id, role=role,
                    local_source=local_path, priority=100)


def enqueue_legacy_manual_for_diagnosis(conn: sqlite3.Connection, *, work_id: str, role: str,
                                        local_path: str) -> str:
    """登记历史无效覆盖以产生终态诊断；新手工入队必须走 enqueue_manual。"""
    if role not in {'poster', 'fanart', 'clearlogo'} or not isinstance(local_path, str) or not local_path:
        raise ValueError('Invalid historical manual artwork source')
    return _enqueue(conn, work_id=work_id, subject_type='work', subject_id=work_id, role=role,
                    local_source=local_path, priority=100)


def capture_identity_repair_bindings(conn: sqlite3.Connection, old_work_id: str) -> list[dict]:
    """在身份变更前捕获手工绑定及仍可发布的自动封面资格。"""
    captured = []
    for raw in conn.execute(
        "SELECT * FROM artwork_bindings WHERE subject_type='work' AND subject_id=?",
        (old_work_id,),
    ).fetchall():
        binding = dict(raw)
        manual = int(binding['priority']) >= 100
        automatic = _valid_identity_repair_automatic(conn, binding)
        if manual or automatic:
            binding['_automatic_validated'] = automatic
            captured.append(binding)
    return captured


def _valid_identity_repair_automatic(conn: sqlite3.Connection, binding: dict) -> bool:
    resource_id = binding.get('automatic_id')
    if not resource_id or binding.get('published_id') != resource_id:
        return False
    resource = conn.execute('SELECT state,content_digest FROM artwork_resources WHERE resource_id=?',
                            (resource_id,)).fetchone()
    if resource is None or resource['state'] != 'ready' or not resource['content_digest']:
        return False
    automatic = dict(binding)
    automatic.update({
        'priority': 0,
        'revision_id': binding.get('automatic_revision_id') or '',
        'snapshot_id': binding.get('automatic_snapshot_id') or '',
        'member_signature': binding.get('automatic_member_signature') or '',
    })
    if not binding_publishable(conn, automatic):
        return False
    sizes = {int(row[0]) for row in conn.execute(
        'SELECT width FROM artwork_variants WHERE content_digest=? AND recipe_version=?',
        (resource['content_digest'], RECIPE_VERSION),
    )}
    return set(ROLE_WIDTHS[binding['role']]) <= sizes


def preserve_identity_repair_bindings(conn: sqlite3.Connection, old_work_id: str,
                                     target_work_ids: list[str], *, source_bindings: list[dict] | None = None
                                     ) -> dict[str, list[str]]:
    """复制可保留的手工封面和当前已发布自动图，不修改旧作品行或文件。

    身份修复若先使旧作品/revision 失效，应在变更前用
    :func:`capture_identity_repair_bindings` 捕获并传入同一写事务中的快照。
    """
    targets = list(dict.fromkeys(target for target in target_work_ids if target and target != old_work_id))
    if not targets:
        return {'manual': [], 'automatic': []}
    source_rows = source_bindings if source_bindings is not None else [dict(row) for row in conn.execute(
        "SELECT * FROM artwork_bindings WHERE subject_type='work' AND subject_id=?",
        (old_work_id,),
    ).fetchall()]
    changed_manual = set()
    changed_automatic = set()

    def valid_automatic(binding: dict) -> bool:
        if '_automatic_validated' in binding:
            return bool(binding['_automatic_validated'])
        return _valid_identity_repair_automatic(conn, binding)

    for raw in source_rows:
        source = dict(raw)
        manual = int(source['priority']) >= 100
        automatic_ok = valid_automatic(source)
        if not manual and not automatic_ok:
            continue
        for target in targets:
            existing_row = conn.execute(
                "SELECT * FROM artwork_bindings WHERE subject_type='work' AND subject_id=? AND role=?",
                (target, source['role']),
            ).fetchone()
            existing = dict(existing_row) if existing_row else None
            target_has_manual = bool(existing and int(existing['priority']) >= 100)
            existing_automatic_ok = bool(existing and valid_automatic(existing))
            copy_manual = manual and not target_has_manual
            copy_automatic = automatic_ok and not existing_automatic_ok
            if not copy_manual and not copy_automatic:
                continue

            if existing is None:
                if copy_manual:
                    published_id = source['published_id'] or (source['automatic_id'] if automatic_ok else None)
                    values = (
                        'work', target, target, source['role'], source['candidate_id'], published_id,
                        source['priority'], source['revision_id'], source['snapshot_id'],
                        source['member_signature'],
                    )
                    automatic_values = ((source['automatic_id'], source['automatic_revision_id'],
                                         source['automatic_snapshot_id'], source['automatic_member_signature'])
                                        if automatic_ok else (None, '', '', ''))
                    conn.execute("""INSERT INTO artwork_bindings
                        (subject_type,subject_id,work_id,role,candidate_id,published_id,priority,
                         revision_id,snapshot_id,member_signature,automatic_id,automatic_revision_id,
                         automatic_snapshot_id,automatic_member_signature)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (*values, *automatic_values))
                    changed_manual.add(target)
                    if automatic_ok:
                        changed_automatic.add(target)
                else:
                    conn.execute("""INSERT INTO artwork_bindings
                        (subject_type,subject_id,work_id,role,candidate_id,published_id,priority,
                         revision_id,snapshot_id,member_signature,automatic_id,automatic_revision_id,
                         automatic_snapshot_id,automatic_member_signature)
                        VALUES ('work',?,?,?, ?,?,0,?,?,?, ?,?,?,?)""",
                        (target, target, source['role'], source['automatic_id'], source['automatic_id'],
                         source['automatic_revision_id'], source['automatic_snapshot_id'],
                         source['automatic_member_signature'], source['automatic_id'],
                         source['automatic_revision_id'], source['automatic_snapshot_id'],
                         source['automatic_member_signature']))
                    changed_automatic.add(target)
                continue

            if copy_manual:
                published_id = source['published_id']
                if not published_id and existing.get('automatic_id') == existing.get('published_id'):
                    published_id = existing['published_id']
                conn.execute("UPDATE artwork_bindings SET candidate_id=?,published_id=?,priority=100, "
                             "revision_id=?,snapshot_id=?,member_signature=? "
                             "WHERE subject_type='work' AND subject_id=? AND role=?",
                             (source['candidate_id'], published_id, source['revision_id'], source['snapshot_id'],
                              source['member_signature'], target, source['role']))
                changed_manual.add(target)
            if copy_automatic:
                conn.execute("UPDATE artwork_bindings SET automatic_id=?,automatic_revision_id=?, "
                             "automatic_snapshot_id=?,automatic_member_signature=? "
                             "WHERE subject_type='work' AND subject_id=? AND role=?",
                             (source['automatic_id'], source['automatic_revision_id'],
                              source['automatic_snapshot_id'], source['automatic_member_signature'],
                              target, source['role']))
                changed_automatic.add(target)
    return {'manual': sorted(changed_manual), 'automatic': sorted(changed_automatic)}


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
    result: dict[str, dict] = {}
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
