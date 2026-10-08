"""浏览请求不得承担投影构建和图片准备，覆盖操作保留独立字段。"""

import json

import pytest
from app.api import library_v4, media_v4
from app.media_v4.persistence.database import V4Database
from app.media_v4.projection.library import V4LibraryProjection

from backend.tests.test_v4_p006 import _seed_work


@pytest.fixture
def database(tmp_path, monkeypatch):
    database = V4Database(tmp_path / 'read-model.db')
    database.initialize()
    _seed_work(database, work_id='w1', title='Fixture', season_count=1, episode_numbers=(1,))
    monkeypatch.setattr(media_v4, '_database', database)
    return database


def _published(database, metadata=None):
    snapshot = V4LibraryProjection(database).rebuild()
    if metadata:
        with database.connect() as conn:
            conn.execute('UPDATE library_cards SET metadata_json=?', (json.dumps(metadata),))
    return snapshot


def test_diagnostics_never_loads_cards_or_rebuilds(database, monkeypatch):
    _published(database)
    with database.connect() as conn:
        conn.execute("INSERT OR REPLACE INTO v4_meta VALUES ('library_projection_dirty','changed')")
    statements = []
    original = database.open_connection

    def connection():
        conn = original()
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(database, 'open_connection', connection)
    monkeypatch.setattr(V4LibraryProjection, 'rebuild', lambda _: pytest.fail('GET rebuilt projection'))
    result = library_v4.diagnostics()
    assert result['digest']
    assert not any('library_cards' in sql for sql in statements)
    assert not any(sql.startswith(('INSERT', 'UPDATE', 'DELETE')) for sql in statements)


def test_missing_projection_is_readable_without_synchronous_build(database, monkeypatch):
    monkeypatch.setattr(V4LibraryProjection, 'rebuild', lambda _: pytest.fail('GET rebuilt projection'))
    assert library_v4.diagnostics()['summary']['work_count'] == 0
    assert library_v4.get_library(compact=True)['works'] == []


def test_compact_avoids_decoding_detail_metadata_and_preparing_images(database, monkeypatch):
    _published(database, {
        'metadata_state': 'not_required', 'plot': 'Home synopsis', 'rating': 8,
        'cast': [{'name': 'Detail actor'}], 'episode_mappings': [{'episode_id': 'large-detail'}],
        'sources': ['pan115'], 'related_works': [{'title': 'Search alias'}],
        'collections': [{'collection_id': 'c1', 'title': 'Local grouping'}],
    })
    decoded = []
    original = V4LibraryProjection._decode_card

    def decode(card):
        result = original(card)
        decoded.append(result['metadata'])
        return result

    monkeypatch.setattr(V4LibraryProjection, '_decode_card', staticmethod(decode))
    monkeypatch.setattr(library_v4, 'queue_library_artwork', lambda _: pytest.fail('GET prepared artwork'))
    result = library_v4.get_library(compact=True)
    assert result['works'][0]['plot'] == 'Home synopsis'
    assert result['works'][0]['related_works'][0]['title'] == 'Search alias'
    assert result['collections'][0]['work_ids'] == ['w1']
    assert 'cast' not in result['works'][0]
    assert decoded and all('episode_mappings' not in metadata and 'cast' not in metadata for metadata in decoded)


def test_restoring_title_keeps_artwork_and_hidden(database):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    payload = {'title': 'Manual', 'local_poster_path': 'fixture-poster', 'hidden': True}
    with database.connect() as conn:
        conn.execute('INSERT INTO work_overrides VALUES (?,?,?,?)', ('w1', json.dumps(payload), 'now', 'now'))
    application = FastAPI()
    application.include_router(media_v4.router)
    assert TestClient(application).delete('/api/v4/works/w1/title').status_code == 200
    with database.connect() as conn:
        row = conn.execute("SELECT override_json FROM work_overrides WHERE work_id='w1'").fetchone()
    assert row is not None
    assert json.loads(row[0]) == {'local_poster_path': 'fixture-poster', 'hidden': True}


def test_manual_title_is_reported_and_updates_lightweight_version(database):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    _published(database, {'metadata_state': 'not_required'})
    before = library_v4.diagnostics()['digest']
    application = FastAPI()
    application.include_router(media_v4.router)
    assert TestClient(application).patch('/api/v4/works/w1/title', json={'title': 'Manual'}).status_code == 200
    result = library_v4.get_library(compact=True)
    assert result['works'][0]['title_provenance'] == 'manual'
    assert library_v4.diagnostics()['digest'] != before
    with database.connect() as conn:
        assert conn.execute("SELECT 1 FROM v4_meta WHERE key='library_projection_dirty'").fetchone() is None


def test_background_refresh_retries_and_publishes_without_get(database, monkeypatch):
    from app.media_v4.projection.refresh import ProjectionRefreshScheduler

    scheduler = ProjectionRefreshScheduler(database)
    original = V4LibraryProjection.rebuild
    attempts = []

    def rebuild(projection):
        attempts.append(True)
        if len(attempts) == 1:
            raise OSError('fixture failure')
        return original(projection)

    monkeypatch.setattr(V4LibraryProjection, 'rebuild', rebuild)
    assert scheduler.tick(now=0) is False
    assert scheduler.tick(now=0.5) is False
    assert len(attempts) == 1
    assert scheduler.tick(now=30) is True
    assert V4LibraryProjection(database).current() is not None
    assert scheduler.tick(now=31) is False


def test_watch_change_updates_version_without_rebuilding(database):
    from app.media_v4.tracking.store import V4TrackingStore

    _published(database)
    before = library_v4.diagnostics()['digest']
    V4TrackingStore(database).save_state('w1', 'local', provider_id='', last_watched_episode=None,
                                       metadata={'favorite': True})
    assert library_v4.diagnostics()['digest'] != before


def test_idle_recovery_and_scan_claim_do_not_acquire_write_lock(database, monkeypatch):
    from app.media_v4.jobs.runner import V4JobRunner
    from app.media_v4.sources.source_scan_runner import SourceScanRunner

    statements = []
    original = database.open_connection

    def connection():
        conn = original()
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(database, 'open_connection', connection)
    assert V4JobRunner(database).schedule_recovery() == 0
    assert SourceScanRunner(database).claim_next_scan() is None
    assert 'BEGIN IMMEDIATE' not in statements


def test_overlay_reads_respect_connection_variable_limit(database, monkeypatch):
    import sqlite3

    original = database.open_connection

    def connection():
        conn = original()
        conn.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 10)
        return conn

    monkeypatch.setattr(database, 'open_connection', connection)
    ids = ['w1', *(f'absent-{i}' for i in range(30))]
    assert library_v4._work_overrides_map(ids) == {}
    assert library_v4._watch_status_map(ids) == {}
    library_v4._content_scope_map(ids)


def test_validation_scope_hashes_once_and_rechecks_changed_files(tmp_path, monkeypatch):
    import hashlib
    from pathlib import Path

    from app.media_v4.persistence.artifact_validation import artifact_matches, validation_scope

    path = tmp_path / 'artifact.bin'
    contents = b'a' * (2 * 1024 * 1024)
    path.write_bytes(contents)
    digest = hashlib.sha256(contents).hexdigest()
    opened = []
    original = Path.open

    def open_file(source, *args, **kwargs):
        if source == path and args == ('rb',):
            opened.append(True)
        return original(source, *args, **kwargs)

    monkeypatch.setattr(Path, 'open', open_file)
    with validation_scope():
        assert artifact_matches(path, digest)
        assert artifact_matches(path, digest)
        assert len(opened) == 1
        path.write_bytes(b'changed')
        assert not artifact_matches(path, digest)
    path.write_bytes(contents)
    assert artifact_matches(path, digest)
    assert len(opened) == 3


@pytest.mark.parametrize('card_count', [1, 1000])
def test_summary_query_cost_does_not_grow_with_library(database, monkeypatch, card_count):
    snapshot = _published(database)
    with database.connect() as conn:
        conn.executemany(
            "INSERT INTO works(work_id,identity_key,work_type,preferred_title,created_at,updated_at) "
            "VALUES (?,?,'series','Fixture','now','now')",
            [(f'extra-{i}', f'extra-identity-{i}') for i in range(card_count - 1)],
        )
        conn.executemany(
            "INSERT INTO library_cards(generation_id,work_id,title,media_type,metadata_json) VALUES (?,?,?,'tv',?)",
            [(snapshot.generation_id, f'extra-{i}', 'Fixture', json.dumps({'cast': ['detail'] * 100}))
             for i in range(card_count - 1)],
        )
    statements = []
    original = database.open_connection

    def connection():
        conn = original()
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(database, 'open_connection', connection)
    library_v4.diagnostics()
    reads = [sql for sql in statements if sql.lstrip().startswith('SELECT')]
    assert len(reads) == 1
    assert not any('library_cards' in sql for sql in reads)


def test_compact_can_read_historical_invalid_json(database):
    _published(database)
    with database.connect() as conn:
        conn.execute("UPDATE library_cards SET metadata_json='broken'")
    assert len(library_v4.get_library(compact=True, include_all=True)['works']) == 1
