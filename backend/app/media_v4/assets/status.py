"""独立图片任务状态，纯 SQLite 汇总，不与资料完成状态相互改写。"""


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
