"""独立图片任务状态，纯 SQLite 汇总，不与资料完成状态相互改写。"""

import time


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
