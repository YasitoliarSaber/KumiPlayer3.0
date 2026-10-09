"""媒体墙耗时校验不能占用任务写入锁，也不能清掉并发更新。"""
from app.media_v4.jobs.control import claim_running, heartbeat
from app.media_v4.persistence.database import V4Database
from app.media_v4.projection import collections
from app.media_v4.projection.library import V4LibraryProjection
from app.media_v4.revisions.service import V4RevisionService

from backend.tests.test_v4_library_projection import _entry


def _database(tmp_path, monkeypatch):
    database = V4Database(tmp_path / 'contention.db')
    database.initialize()
    service = V4RevisionService(database)
    service.create_draft('rev-1', [_entry('video')])
    service.confirm('rev-1')
    original = V4Database.open_connection

    def open_connection(self):
        conn = original(self)
        conn.execute('PRAGMA busy_timeout=100')
        return conn

    monkeypatch.setattr(V4Database, 'open_connection', open_connection)
    return database


def test_job_heartbeat_can_commit_while_projection_is_building(tmp_path, monkeypatch):
    database = _database(tmp_path, monkeypatch)
    with database.connect() as conn:
        job_id = conn.execute("SELECT job_id FROM jobs WHERE status='queued' LIMIT 1").fetchone()[0]
    assert claim_running(database, job_id)
    original = collections.collection_metadata
    completed = []

    def during_build(conn):
        heartbeat(database, job_id)
        completed.append(True)
        return original(conn)

    monkeypatch.setattr(collections, 'collection_metadata', during_build)
    snapshot = V4LibraryProjection(database).rebuild()
    assert snapshot.cards
    assert completed == [True]
    with database.connect() as conn:
        assert conn.execute('SELECT status FROM jobs WHERE job_id=?', (job_id,)).fetchone()[0] == 'running'


def test_concurrent_authority_update_keeps_projection_dirty(tmp_path, monkeypatch):
    database = _database(tmp_path, monkeypatch)
    original = collections.collection_metadata
    changed = []

    def during_build(conn):
        if not changed:
            changed.append(True)
            with database.connect() as writer:
                writer.execute("UPDATE works SET preferred_title='Updated Show'")
                writer.execute("INSERT OR REPLACE INTO v4_meta(key,value) VALUES ('library_projection_dirty','update')")
        return original(conn)

    monkeypatch.setattr(collections, 'collection_metadata', during_build)
    projection = V4LibraryProjection(database)
    first = projection.rebuild()
    assert first.cards[0]['title'] == 'Show'
    with database.connect() as conn:
        assert conn.execute("SELECT 1 FROM v4_meta WHERE key='library_projection_dirty'").fetchone()
    assert projection.rebuild().cards[0]['title'] == 'Updated Show'
    with database.connect() as conn:
        assert not conn.execute("SELECT 1 FROM v4_meta WHERE key='library_projection_dirty'").fetchone()


def test_older_projection_cannot_replace_a_concurrently_published_generation(tmp_path, monkeypatch):
    database = _database(tmp_path, monkeypatch)
    original = collections.collection_metadata
    published = []

    def during_build(conn):
        if not published:
            published.append(None)
            with database.connect() as writer:
                writer.execute("UPDATE works SET preferred_title='Newer Show'")
            published[0] = V4LibraryProjection(database).rebuild()
        return original(conn)

    monkeypatch.setattr(collections, 'collection_metadata', during_build)
    result = V4LibraryProjection(database).rebuild()
    assert result.generation_id == published[0].generation_id
    assert result.cards[0]['title'] == 'Newer Show'
    assert V4LibraryProjection(database).current() == result
