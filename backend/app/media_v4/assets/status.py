"""独立图片任务状态，纯 SQLite 汇总，不与资料完成状态相互改写。"""

import time


def required_artwork_status(conn, work_id: str, revision_id: str | None = None) -> dict:
    """发布门槛只看海报、背景和当前正片预览；不读文件、不请求网络。

    演员、推荐图和 logo 不阻断作品。没有来源的必需图片也是缺项，不能
    因为没有登记下载任务而误报 not_required。电影无需剧集预览图。
    """
    from app.media_v4.assets.catalog import RECIPE_VERSION, ROLE_WIDTHS

    episodes = [row[0] for row in conn.execute(
        "SELECT DISTINCT e.episode_id FROM revision_bindings rb "
        "JOIN import_revisions ir ON ir.revision_id=rb.revision_id AND ir.status='confirmed' "
        "JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.enabled=1 AND sr.retired_at='' "
        "JOIN episodes e ON e.episode_id=rb.episode_id JOIN seasons s ON s.season_id=e.season_id "
        "WHERE rb.work_id=? AND rb.asset_id IS NOT NULL "
        "AND e.episode_kind NOT IN ('special','auxiliary','movie') AND s.season_kind<>'special' "
        "AND (? IS NULL OR rb.revision_id=?)", (work_id, revision_id, revision_id))]
    required = [('work', work_id, 'poster'), ('work', work_id, 'fanart')]
    required.extend(('episode', episode_id, 'episode_thumb') for episode_id in episodes)
    bindings = {}
    for row in conn.execute(
        "SELECT b.subject_type,b.subject_id,b.role,b.candidate_id,b.published_id,r.state,r.error_kind,v.width "
        "FROM artwork_bindings b LEFT JOIN artwork_resources r ON r.resource_id=b.candidate_id "
        "LEFT JOIN artwork_variants v ON v.content_digest=r.content_digest AND v.recipe_version=? "
        "WHERE b.work_id=? AND b.role IN ('poster','fanart','episode_thumb')", (RECIPE_VERSION, work_id)):
        key = (row['subject_type'], row['subject_id'], row['role'])
        item = bindings.setdefault(key, {**dict(row), 'widths': set()})
        if row['width'] is not None:
            item['widths'].add(row['width'])
    counts = {}
    missing = {'poster': 0, 'fanart': 0, 'episode_thumb': 0}
    error_codes = set()
    for key in required:
        item = bindings.get(key)
        if item and item['published_id'] == item['candidate_id'] and set(ROLE_WIDTHS[key[2]]) <= item['widths']:
            state = 'ready'
        else:
            missing[key[2]] += 1
            state = (item or {}).get('state') or 'failed'
            if state == 'retry':
                state = 'pending'
            elif state == 'ready':
                state = 'failed'
            error_codes.add((item or {}).get('error_kind') or ('missing_source' if not item else 'not_published'))
        counts[state] = counts.get(state, 0) + 1
    status = ('running' if counts.get('running') else 'pending' if counts.get('pending') else
              'failed' if counts.get('failed') else 'cancelled' if counts.get('cancelled') else 'ready')
    labels = {'poster': '海报', 'fanart': '背景图', 'episode_thumb': '正片预览图'}
    reasons = [f'{labels[role]}尚未就绪（{count} 张）' for role, count in missing.items() if count]
    return {'status': status, 'counts': counts, 'total': len(required),
            'reason_codes': sorted(error_codes), 'reasons': reasons}


def has_active_artwork(conn) -> bool:
    """只查询仍有活动来源的需求；完整身份校验由后台发布链执行。"""
    return bool(conn.execute("""SELECT 1 FROM artwork_resources r
        WHERE (r.state IN ('pending','running') OR (r.state='retry' AND r.retry_at<=?))
        AND EXISTS (SELECT 1 FROM artwork_bindings b
            JOIN works w ON w.work_id=b.work_id AND w.status='active'
            WHERE b.candidate_id=r.resource_id AND (b.priority>=100 OR EXISTS (
                SELECT 1 FROM revision_metadata_refs mr
                JOIN import_revisions ir ON ir.revision_id=mr.revision_id AND ir.status='confirmed'
                JOIN source_roots sr ON sr.root_id=ir.root_id AND sr.enabled=1 AND sr.retired_at=''
                WHERE mr.revision_id=b.revision_id AND mr.work_id=b.work_id AND mr.snapshot_id=b.snapshot_id
                AND EXISTS (SELECT 1 FROM revision_bindings rb
                    WHERE rb.revision_id=b.revision_id AND rb.work_id=b.work_id)
                AND NOT EXISTS (SELECT 1 FROM v4_meta cancelled
                    WHERE cancelled.key='artwork_cancelled_revision:'||b.revision_id||':'||b.work_id))))
        LIMIT 1""", (time.time(),)).fetchone())


def artwork_status(conn, work_id: str) -> dict:
    counts = {row['state']: int(row['count']) for row in conn.execute(
        'SELECT r.state,COUNT(DISTINCT r.resource_id) AS count FROM artwork_bindings b '
        'JOIN artwork_resources r ON r.resource_id=b.candidate_id WHERE b.work_id=? GROUP BY r.state', (work_id,))}
    total = sum(counts.values())
    status = ('not_required' if not total else 'running' if counts.get('running') else
              'pending' if counts.get('pending') else 'failed' if counts.get('failed') or counts.get('retry') else
              'cancelled' if counts.get('cancelled') else 'ready')
    reasons = [row[0] for row in conn.execute(
        "SELECT DISTINCT r.error_kind FROM artwork_bindings b "
        "JOIN artwork_resources r ON r.resource_id=b.candidate_id "
        "WHERE b.work_id=? AND r.state IN ('failed','retry') AND r.error_kind<>'' "
        "ORDER BY r.error_kind LIMIT 16", (work_id,))]
    return {'status': status, 'counts': counts, 'total': total, 'reason_codes': reasons}
