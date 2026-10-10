"""图片尚在准备时继续反馈进度，普通 GET 仍只读 SQLite。"""

import time

import pytest
from backend.tests.test_v4_artwork_catalog import _database, enqueue_metadata

from app.api import library_v4
from app.media_v4.assets.catalog import enqueue_manual
from app.media_v4.assets.status import has_active_artwork
from app.media_v4.projection.library import V4LibraryProjection
from app.media_v4.projection.source_libraries import _active_task, _progress_message, _progress_percent
from app.media_v4.revisions.service import V4RevisionService


def test_published_reads_report_artwork_activity_without_rebuilding(tmp_path, monkeypatch):
    database = _database(tmp_path)
    V4LibraryProjection(database).rebuild()
    with database.connect() as conn:
        resource = enqueue_manual(conn, work_id='one', role='poster', local_path=str(tmp_path / 'cover.jpg'))
    monkeypatch.setattr(library_v4, 'get_database', lambda: database)
    monkeypatch.setattr(V4LibraryProjection, 'rebuild', lambda self: pytest.fail('GET rebuilt projection'))
    first = library_v4.get_library()
    assert first['updating'] is False
    assert first['background_active'] is True
    assert library_v4.get_changes()['background_active'] is True
    with database.connect() as conn:
        conn.execute("UPDATE artwork_resources SET state='retry',retry_at=? WHERE resource_id=?",
                     (time.time() + 300, resource))
    assert library_v4.get_changes()['background_active'] is False
    with database.connect() as conn:
        conn.execute("UPDATE artwork_resources SET retry_at=0 WHERE resource_id=?", (resource,))
    assert library_v4.get_changes()['background_active'] is True
    with database.connect() as conn:
        conn.execute("UPDATE works SET status='retired' WHERE work_id='one'")
    assert library_v4.get_changes()['background_active'] is False
    assert library_v4.get_library()['generation_id'] == first['generation_id']


def test_completed_metadata_does_not_finish_active_picture_preparation(tmp_path):
    database = _database(tmp_path)
    with database.connect() as conn:
        for work in ('one', 'two'):
            conn.execute("INSERT INTO jobs(job_id,job_type,revision_id,work_id,idempotency_key,status,created_at,updated_at) "
                         "VALUES (?,'scrape_work','r',?,?,'succeeded','now','now')", (work, work, work))
            conn.execute("INSERT INTO scrape_bindings(binding_id,revision_id,work_id,provider,provider_id,status,metadata_json,created_at,updated_at) "
                         "VALUES (?,'r',?,'tmdb',?,'confirmed',?, 'now','now')",
                         (work, work, work, '{"metadata_state":"ready"}'))
        resource = enqueue_manual(conn, work_id='one', role='poster', local_path=str(tmp_path / 'cover.jpg'))
    service = V4RevisionService(database)
    progress = service.get_execution_progress('r')
    assert {unit['overall_status'] for unit in progress['work_units']} == {'running_artwork', 'needs_attention'}
    assert progress['overall_status'] == 'running'
    assert _progress_message(progress) == '正在准备本地图片'
    assert _progress_percent(progress) == 50
    task = _active_task(None, None, 'r', progress)
    assert task['stage'] == 'prepare_artwork'
    assert task['can_cancel'] is False
    with database.connect() as conn:
        other = enqueue_manual(conn, work_id='two', role='poster', local_path=str(tmp_path / 'other.jpg'))
        conn.execute("UPDATE artwork_resources SET state='failed' WHERE resource_id=?", (other,))
    mixed = service.get_execution_progress('r')
    assert mixed['stage_summary']['artwork']['status'] == 'failed'
    assert _progress_message(mixed) == '正在准备本地图片'
    assert _active_task(None, None, 'r', mixed)['stage'] == 'prepare_artwork'
    with database.connect() as conn:
        conn.execute("UPDATE artwork_resources SET state='failed' WHERE resource_id=?", (resource,))
    assert service.get_execution_progress('r')['overall_status'] == 'needs_attention'


@pytest.mark.parametrize('mutation', ['disabled', 'retired', 'superseded', 'snapshot', 'cancelled'])
def test_inactive_automatic_artwork_does_not_keep_polling_busy(tmp_path, mutation):
    database = _database(tmp_path)
    with database.connect() as conn:
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='s',
                         metadata={'poster_url': 'https://image.tmdb.org/t/p/original/cover.jpg'})
        assert has_active_artwork(conn)
        if mutation == 'disabled':
            conn.execute('UPDATE source_roots SET enabled=0')
        elif mutation == 'retired':
            conn.execute("UPDATE source_roots SET retired_at='now'")
        elif mutation == 'superseded':
            conn.execute("UPDATE import_revisions SET status='superseded'")
        elif mutation == 'snapshot':
            conn.execute('DELETE FROM revision_metadata_refs')
        else:
            conn.execute("INSERT INTO v4_meta(key,value) VALUES ('artwork_cancelled_revision:r:one','1')")
        assert not has_active_artwork(conn)


def test_metadata_job_activity_is_read_only_and_current_source_scoped(tmp_path, monkeypatch):
    database = _database(tmp_path)
    V4LibraryProjection(database).rebuild()
    monkeypatch.setattr(library_v4, 'get_database', lambda: database)
    assert not library_v4.get_changes()['background_active']
    with database.connect() as conn:
        conn.execute("INSERT INTO jobs(job_id,job_type,revision_id,work_id,idempotency_key,status,created_at,updated_at) "
                     "VALUES ('metadata','scrape_work','r','one','metadata','running','now','now')")
    assert library_v4.get_changes()['background_active']
    with database.connect() as conn:
        conn.execute('UPDATE jobs SET cancel_requested=1')
    assert not library_v4.get_changes()['background_active']
    with database.connect() as conn:
        conn.execute('UPDATE jobs SET cancel_requested=0')
        conn.execute("UPDATE source_roots SET retired_at='now'")
    assert not library_v4.get_changes()['background_active']
