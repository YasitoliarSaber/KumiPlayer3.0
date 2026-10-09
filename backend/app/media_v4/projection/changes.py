"""发布事务中的有界变更日志；浏览请求只读取已提交序号。"""

from datetime import UTC, datetime

RETENTION = 20_000


def latest_sequence(conn) -> int:
    return int(conn.execute("SELECT COALESCE(MAX(sequence),0) FROM library_changes").fetchone()[0])


def record_change(conn, kind: str, work_id: str = '') -> int:
    if kind not in {'work_upsert', 'work_remove', 'artwork', 'watch', 'reset'}:
        raise ValueError('Unknown library change')
    sequence = conn.execute('INSERT INTO library_changes(kind,work_id,created_at) VALUES (?,?,?)',
                            (kind, work_id, datetime.now(UTC).isoformat())).lastrowid
    conn.execute('DELETE FROM library_changes WHERE sequence<=?', (sequence - RETENTION,))
    return int(sequence)


def read_changes(conn, after: int, limit: int = 128) -> dict:
    """调用者保持同一 SQLite 读事务，序号只推进到实际返回的末项。"""
    if after < 0 or not 1 <= limit <= 128:
        raise ValueError('Invalid change cursor or page size')
    bounds = conn.execute('SELECT MIN(sequence),COALESCE(MAX(sequence),0) FROM library_changes').fetchone()
    earliest, latest = bounds[0], int(bounds[1])
    reset = after > latest or (earliest is not None and after < earliest - 1)
    if reset:
        return {'changes': [], 'next_sequence': latest, 'has_more': False, 'reset_required': True}
    rows = [dict(row) for row in conn.execute(
        'SELECT sequence,kind,work_id FROM library_changes WHERE sequence>? ORDER BY sequence LIMIT ?',
        (after, limit + 1))]
    page = rows[:limit]
    return {'changes': page, 'next_sequence': page[-1]['sequence'] if page else after,
            'has_more': len(rows) > limit, 'reset_required': any(row['kind'] == 'reset' for row in page)}
