from __future__ import annotations

import io

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.media_v4.assets.catalog import (
    enqueue_manual,
    get_metadata_image,
    get_work_artwork,
    get_work_artwork_many,
    restore_auto,
    retry_work,
)
from app.media_v4.assets.catalog import (
    enqueue_metadata as enqueue_metadata_real,
)
from app.media_v4.assets.service import ArtworkService
from app.media_v4.persistence.database import V4Database
from app.media_v4.persistence.metadata_lifecycle import publish_snapshot


def _database(tmp_path):
    db = V4Database(tmp_path / 'library.db')
    db.initialize()
    with db.connect() as conn:
        for work in ('one', 'two'):
            conn.execute("INSERT INTO works(work_id,identity_key,work_type,created_at,updated_at) "
                         "VALUES (?,?,'movie','now','now')", (work, work))
        conn.execute("INSERT INTO source_roots(root_id,provider,ingest_method,created_at,updated_at) "
                     "VALUES ('root','local','local_scan','now','now')")
        conn.execute("INSERT INTO source_scans(scan_id,root_id,generation,status) VALUES ('scan','root',1,'completed')")
        conn.execute("INSERT INTO import_revisions(revision_id,root_id,scan_id,resolver_version,status,created_at) "
                     "VALUES ('r','root','scan','fixture','draft','now')")
        for work in ('one', 'two'):
            conn.execute('INSERT INTO source_evidence(evidence_id,scan_id,root_id,source_key,relative_path,entry_kind) '
                         "VALUES (?,'scan','root',?,?,'video')", (work, work, f'{work}.mkv'))
            conn.execute("INSERT INTO revision_bindings(binding_id,revision_id,evidence_id,work_id) VALUES (?,'r',?,?)",
                         (work, work, work))
        conn.execute("UPDATE import_revisions SET status='confirmed',confirmed_at='now' WHERE revision_id='r'")
    return db


def enqueue_metadata(conn, *, revision_id, work_id, snapshot_id, metadata):
    """真实当前快照夹具；资源服务不得接受未确认或无资料引用的需求。"""
    snapshot_id = f'{snapshot_id}-{work_id}'
    payload = {'provider': 'tmdb', 'provider_id': work_id, 'metadata_state': 'ready',
               'title': work_id, 'media_type': 'movie', **metadata}
    if not conn.execute('SELECT 1 FROM metadata_snapshots WHERE snapshot_id=?', (snapshot_id,)).fetchone():
        publish_snapshot(conn, revision_id=revision_id, work_id=work_id, snapshot_id=snapshot_id,
                         metadata=payload, artifact_ids=[])
    enqueue_metadata_real(conn, revision_id=revision_id, work_id=work_id, snapshot_id=snapshot_id, metadata=payload)


def _image(tmp_path):
    output = io.BytesIO()
    Image.new('RGB', (600, 900), 'red').save(output, 'PNG')
    path = tmp_path / 'manual.png'
    path.write_bytes(output.getvalue())
    return path


def test_manual_artwork_is_managed_deduplicated_and_not_overridden(tmp_path):
    db = _database(tmp_path)
    source = _image(tmp_path)
    with db.connect() as conn:
        enqueue_manual(conn, work_id='one', role='poster', local_path=str(source))
        enqueue_manual(conn, work_id='two', role='poster', local_path=str(source))
    service = ArtworkService(db, data_root=tmp_path)
    assert service.process_available() == 1
    with db.connect() as conn:
        first = get_work_artwork(conn, 'one')['poster']
        second = get_work_artwork(conn, 'two')['poster']
        assert first == second
        assert '384' in first['variants']
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='s',
                         metadata={'poster_url': 'https://image.tmdb.org/t/p/original/auto.jpg'})
        assert get_work_artwork(conn, 'one')['poster'] == first
        assert conn.execute('SELECT count(*) FROM artwork_variants').fetchone()[0] == 3
        assert conn.execute('SELECT count(*) FROM library_changes').fetchone()[0] == 2


def test_failure_and_lease_recovery_are_independent_of_metadata(tmp_path, monkeypatch):
    db = _database(tmp_path)
    with db.connect() as conn:
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='s',
                         metadata={'poster_url': 'https://image.tmdb.org/t/p/original/fail.jpg'})
        conn.execute("UPDATE artwork_resources SET state='running',lease_until=0")
    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', lambda *args: (_ for _ in ()).throw(ValueError('bad image')))
    assert service.process_available() == 1
    assert service.process_available() == 0
    with db.connect() as conn:
        row = conn.execute('SELECT state,attempts FROM artwork_resources').fetchone()
        assert tuple(row) == ('retry', 1)
        assert get_work_artwork(conn, 'one') == {}
        assert conn.execute('SELECT count(*) FROM metadata_snapshots').fetchone()[0] == 1
        assert '"metadata_state":"ready"' in conn.execute('SELECT metadata_json FROM metadata_snapshots').fetchone()[0]


def test_late_automatic_result_cannot_publish_over_new_manual_choice(tmp_path, monkeypatch):
    db = _database(tmp_path)
    source = _image(tmp_path)
    with db.connect() as conn:
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='s',
                         metadata={'poster_url': 'https://image.tmdb.org/t/p/original/late.jpg'})
    service = ArtworkService(db, data_root=tmp_path)

    def late_result(url):
        with db.connect() as conn:
            enqueue_manual(conn, work_id='one', role='poster', local_path=str(source))
        return source.read_bytes()

    monkeypatch.setattr(service, '_download', late_result)
    assert service.process_available(limit=1) == 1
    with db.connect() as conn:
        assert get_work_artwork(conn, 'one') == {}
    assert service.process_available() == 1
    with db.connect() as conn:
        assert get_work_artwork(conn, 'one')['poster']['state'] == 'ready'
        assert conn.execute('SELECT priority FROM artwork_bindings').fetchone()[0] == 100


def test_failed_replacement_keeps_published_artwork_and_cancel_needs_explicit_retry(tmp_path, monkeypatch):
    db = _database(tmp_path)
    source = _image(tmp_path)
    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', lambda url: source.read_bytes())
    with db.connect() as conn:
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='s',
                         metadata={'poster_url': 'https://image.tmdb.org/t/p/original/old.jpg'})
    service.process_available()
    with db.connect() as conn:
        old = get_work_artwork(conn, 'one')
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='s2',
                         metadata={'poster_url': 'https://image.tmdb.org/t/p/original/new.jpg'})
        resource_id = conn.execute('SELECT candidate_id FROM artwork_bindings').fetchone()[0]
    service.cancel(resource_id)
    assert service.process_available() == 0
    with db.connect() as conn:
        assert get_work_artwork(conn, 'one') == old
    service.retry(resource_id)
    monkeypatch.setattr(service, '_download', lambda url: (_ for _ in ()).throw(ValueError('invalid')))
    service.process_available()
    with db.connect() as conn:
        assert get_work_artwork(conn, 'one') == old


def test_distinct_urls_share_digest_and_variants(tmp_path, monkeypatch):
    db = _database(tmp_path)
    source = _image(tmp_path)
    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', lambda url: source.read_bytes())
    with db.connect() as conn:
        for work_id in ('one', 'two'):
            enqueue_metadata(conn, revision_id='r', work_id=work_id, snapshot_id='s',
                             metadata={'poster_url': f'https://image.tmdb.org/t/p/original/{work_id}.png'})
    assert service.process_available() == 2
    with db.connect() as conn:
        assert conn.execute('SELECT count(*) FROM artwork_variants').fetchone()[0] == 3
        assert conn.execute('SELECT count(DISTINCT content_digest) FROM artwork_resources').fetchone()[0] == 1


def test_get_reads_only_published_variant_without_original_or_encoding(tmp_path, monkeypatch):
    from app.api import assets, media_v4

    db = _database(tmp_path)
    source = _image(tmp_path)
    with db.connect() as conn:
        enqueue_manual(conn, work_id='one', role='poster', local_path=str(source))
    ArtworkService(db, data_root=tmp_path).process_available()
    with db.connect() as conn:
        image = get_work_artwork(conn, 'one')['poster']
        original = conn.execute('SELECT original_path FROM artwork_resources').fetchone()[0]
    (tmp_path / original).unlink()
    monkeypatch.setattr(media_v4, 'get_database', lambda: db)
    monkeypatch.setattr(assets, 'get_data_dir', lambda: tmp_path)
    monkeypatch.setattr(Image, 'open', lambda *args: pytest.fail('GET must not decode images'))
    app = FastAPI()
    app.include_router(assets.router)
    with TestClient(app) as client:
        response = client.get(image['variants']['384'])
        assert response.status_code == 200
        assert response.headers['content-type'] == 'image/webp'
        assert client.get(image['variants']['384'], headers={'If-None-Match': response.headers['etag']}).status_code == 304
        assert client.get(image['variants']['384'].replace(image['content_version'], 'stale')).status_code == 404


def test_download_rejects_untrusted_url_before_network(tmp_path, monkeypatch):
    from app.media_v4.assets import service as module

    service = ArtworkService(_database(tmp_path), data_root=tmp_path)
    monkeypatch.setattr(module, '_artwork_client', lambda *args: pytest.fail('network must not be called'))
    for url in ('http://image.tmdb.org/t/p/original/a.png', 'https://127.0.0.1/a.png',
                'https://image.tmdb.org/t/p/original/../a.png'):
        with pytest.raises(ValueError):
            service._download(url)


def test_restore_auto_preserves_managed_manual_original(tmp_path, monkeypatch):
    db = _database(tmp_path)
    source = _image(tmp_path)
    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', lambda url: source.read_bytes())
    with db.connect() as conn:
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='s',
                         metadata={'poster_url': 'https://image.tmdb.org/t/p/original/auto.jpg'})
        enqueue_manual(conn, work_id='one', role='poster', local_path=str(source))
    service.process_available()
    with db.connect() as conn:
        manual = get_work_artwork(conn, 'one')['poster']
        original = conn.execute('SELECT original_path FROM artwork_resources WHERE resource_id=?',
                                (manual['resource_id'],)).fetchone()[0]
        restore_auto(conn, 'one', 'poster')
        assert get_work_artwork(conn, 'one')['poster'] == manual
    service.process_available()
    with db.connect() as conn:
        assert get_work_artwork(conn, 'one')['poster']['resource_id'] != manual['resource_id']
    assert (tmp_path / original).is_file()


def test_existing_manual_override_is_adopted_once_and_cast_images_are_prepared(tmp_path, monkeypatch):
    db = _database(tmp_path)
    source = _image(tmp_path)
    with db.connect() as conn:
        import json

        conn.execute('INSERT INTO work_overrides VALUES (?,?,?,?)',
                     ('one', json.dumps({'local_poster_path': str(source)}), 'now', 'now'))
        enqueue_metadata(conn, revision_id='r', work_id='two', snapshot_id='s', metadata={
            'cast': [{'name': 'actor', 'profile_path': '/profile.png'}],
            'related_works': [{'title': 'related', 'poster_path': '/related.png'}],
        })
    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', lambda url: source.read_bytes())
    assert service.process_available() == 3
    source.unlink()
    assert service.process_available() == 0
    with db.connect() as conn:
        assert get_work_artwork(conn, 'one')['poster']['state'] == 'ready'
        assert get_metadata_image(conn, '/profile.png').startswith('/api/assets/artwork/')
        assert get_metadata_image(conn, '/related.png').startswith('/api/assets/artwork/')
        assert get_metadata_image(conn, '/unprepared.png') is None


def test_batch_read_uses_one_query_per_500_subjects(tmp_path):
    db = _database(tmp_path)
    source = _image(tmp_path)
    with db.connect() as conn:
        enqueue_manual(conn, work_id='one', role='poster', local_path=str(source))
    ArtworkService(db, data_root=tmp_path).process_available()
    with db.connect() as conn:
        statements = []
        conn.set_trace_callback(statements.append)
        result = get_work_artwork_many(conn, ['one', 'two', *[f'absent-{index}' for index in range(1000)]])
        conn.set_trace_callback(None)
        assert result['one']['poster']['state'] == 'ready'
        assert len(statements) == 3
        assert all('JOIN artwork_variants' in statement for statement in statements)


def test_episode_sources_merge_only_current_confirmed_members(tmp_path):
    from backend.tests.test_v4_revision_confirmation import _entry

    from app.media_v4.revisions.service import V4RevisionService

    db = _database(tmp_path)
    revisions = V4RevisionService(db)
    revisions.create_draft('current', [_entry()])
    revisions.confirm('current')
    with db.connect() as conn:
        row = conn.execute('SELECT work_id,episode_id FROM revision_bindings WHERE revision_id=?',
                           ('current',)).fetchone()
        enqueue_metadata(conn, revision_id='current', work_id=row['work_id'], snapshot_id='s', metadata={
            'episode_artworks': [{'episode_id': row['episode_id'], 'still_url': 'https://image.tmdb.org/a.jpg'}],
            'episode_mappings': [{'episode_id': row['episode_id'], 'still_url': 'https://image.tmdb.org/b.jpg'},
                                 {'episode_id': 'foreign', 'still_url': 'https://image.tmdb.org/foreign.jpg'}],
        })
        bindings = conn.execute("SELECT subject_id FROM artwork_bindings WHERE role='episode_thumb'").fetchall()
        assert [item[0] for item in bindings] == [row['episode_id']]
        assert conn.execute('SELECT source_url FROM artwork_resources').fetchone()[0] == 'https://image.tmdb.org/b.jpg'


def test_claimed_resources_have_no_executor_queue_with_running_leases(tmp_path, monkeypatch):
    db = _database(tmp_path)
    source = _image(tmp_path)
    with db.connect() as conn:
        for work_id in ('one', 'two'):
            enqueue_metadata(conn, revision_id='r', work_id=work_id, snapshot_id='s', metadata={
                'poster_url': f'https://image.tmdb.org/{work_id}.jpg',
                'fanart_url': f'https://image.tmdb.org/{work_id}-fanart.jpg',
            })
    running_counts = []

    def download(url):
        with db.connect() as conn:
            running_counts.append(conn.execute("SELECT count(*) FROM artwork_resources WHERE state='running'").fetchone()[0])
        return source.read_bytes()

    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', download)
    assert service.process_available(limit=4) == 4
    assert max(running_counts) <= 2


@pytest.mark.parametrize('mutation', ['retired', 'superseded', 'snapshot', 'identity'])
def test_expired_automatic_task_cannot_publish_or_emit_changes(tmp_path, monkeypatch, mutation):
    db = _database(tmp_path)
    source = _image(tmp_path)
    with db.connect() as conn:
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='s',
                         metadata={'poster_url': 'https://image.tmdb.org/old.jpg'})

    def download(url):
        with db.connect() as conn:
            if mutation == 'retired':
                conn.execute("UPDATE source_roots SET retired_at='now'")
            elif mutation == 'superseded':
                conn.execute("UPDATE import_revisions SET status='superseded' WHERE revision_id='r'")
            elif mutation == 'snapshot':
                enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='new',
                                 metadata={'poster_url': 'https://image.tmdb.org/new.jpg'})
            else:
                conn.execute("UPDATE works SET year=2026 WHERE work_id='one'")
        return source.read_bytes()

    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', download)
    assert service.process_available(limit=1) == 1
    with db.connect() as conn:
        assert get_work_artwork(conn, 'one') == {}
        assert conn.execute('SELECT count(*) FROM library_changes').fetchone()[0] == 0


def test_obsolete_enqueue_cannot_replace_current_candidate(tmp_path):
    db = _database(tmp_path)
    with db.connect() as conn:
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='old',
                         metadata={'poster_url': 'https://image.tmdb.org/old.jpg'})
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='new',
                         metadata={'poster_url': 'https://image.tmdb.org/new.jpg'})
        new = conn.execute('SELECT candidate_id FROM artwork_bindings').fetchone()[0]
        enqueue_metadata_real(conn, revision_id='r', work_id='one', snapshot_id='old-one',
                              metadata={'poster_url': 'https://image.tmdb.org/obsolete.jpg'})
        assert conn.execute('SELECT candidate_id FROM artwork_bindings').fetchone()[0] == new


def test_published_variant_records_dimensions_bytes_etag_and_display_version(tmp_path, monkeypatch):
    from app.media_v4.assets import service as module

    db = _database(tmp_path)
    source = _image(tmp_path)
    fsync_calls = []
    fsync = module.os.fsync
    monkeypatch.setattr(module.os, 'fsync', lambda descriptor: (fsync_calls.append(descriptor), fsync(descriptor))[-1])
    with db.connect() as conn:
        enqueue_manual(conn, work_id='one', role='poster', local_path=str(source))
    ArtworkService(db, data_root=tmp_path).process_available()
    with db.connect() as conn:
        row = conn.execute('SELECT * FROM artwork_variants WHERE width=384').fetchone()
        assert row['pixel_width'] == 384 and row['pixel_height'] == 576
        assert row['byte_size'] == (tmp_path / row['relative_path']).stat().st_size
        assert len(row['etag']) == 64
        assert conn.execute("SELECT value FROM v4_meta WHERE key='library_display_version'").fetchone()[0]
        assert conn.execute("SELECT value FROM v4_meta WHERE key='display_version'").fetchone() is None
    assert len(fsync_calls) >= 4


def test_restore_auto_copies_current_snapshot_context_for_guarded_publication(tmp_path, monkeypatch):
    db = _database(tmp_path)
    source = _image(tmp_path)
    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', lambda url: source.read_bytes())
    with db.connect() as conn:
        enqueue_metadata(conn, revision_id='r', work_id='one', snapshot_id='s',
                         metadata={'poster_url': 'https://image.tmdb.org/auto.jpg'})
        enqueue_manual(conn, work_id='one', role='poster', local_path=str(source))
    service.process_available()
    with db.connect() as conn:
        restore_auto(conn, 'one', 'poster')
        row = conn.execute('SELECT revision_id,snapshot_id FROM artwork_bindings').fetchone()
        assert tuple(row) == ('r', 's-one')
        conn.execute("UPDATE source_roots SET enabled=0")
    service.process_available()
    with db.connect() as conn:
        assert conn.execute('SELECT priority FROM artwork_bindings').fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM library_changes').fetchone()[0] == 1


def test_legacy_picture_routes_are_not_registered_and_do_no_work(monkeypatch):
    from app.api import assets

    monkeypatch.setattr(assets, 'get_mirror_root', lambda: pytest.fail('retired GET inspected mirror'))
    monkeypatch.setattr(assets, 'load_config', lambda: pytest.fail('retired GET started download'))
    app = FastAPI()
    app.include_router(assets.router)
    assert [route.path for route in assets.router.routes] == ['/api/assets/artwork/{resource_id}/{content_version}/{width}']
    with TestClient(app) as client:
        for path in ('/api/assets?path=poster.jpg', '/api/assets?path=tvshow.nfo',
                     '/api/assets/thumbnail?path=poster.jpg', '/api/assets/remote?url=https://image.tmdb.org/a.jpg'):
            assert client.get(path).status_code == 404
        assert client.post('/api/assets/thumbnails/prepare', json={'items': [{'path': 'poster.jpg', 'width': 384}]}).status_code == 404


def test_episode_number_change_during_download_prevents_publication(tmp_path, monkeypatch):
    from backend.tests.test_v4_revision_confirmation import _entry

    from app.media_v4.revisions.service import V4RevisionService

    db = _database(tmp_path)
    source = _image(tmp_path)
    revisions = V4RevisionService(db)
    revisions.create_draft('current', [_entry()])
    revisions.confirm('current')
    with db.connect() as conn:
        row = conn.execute('SELECT work_id,episode_id FROM revision_bindings WHERE revision_id=?', ('current',)).fetchone()
        enqueue_metadata(conn, revision_id='current', work_id=row['work_id'], snapshot_id='s', metadata={
            'episode_mappings': [{'episode_id': row['episode_id'], 'still_url': 'https://image.tmdb.org/still.jpg'}],
        })

    def download(url):
        with db.connect() as conn:
            conn.execute('UPDATE episodes SET local_episode_number=2 WHERE episode_id=?', (row['episode_id'],))
        return source.read_bytes()

    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', download)
    service.process_available()
    with db.connect() as conn:
        assert conn.execute('SELECT published_id FROM artwork_bindings').fetchone()[0] is None
        assert conn.execute('SELECT count(*) FROM library_changes').fetchone()[0] == 0


def test_new_role_added_during_encoding_waits_for_all_required_sizes(tmp_path, monkeypatch):
    from app.media_v4.assets import service as module

    db = _database(tmp_path)
    source = _image(tmp_path)
    with db.connect() as conn:
        enqueue_manual(conn, work_id='one', role='poster', local_path=str(source))
    atomic = module._atomic_bytes
    added = []

    def write_with_new_role(path, payload):
        atomic(path, payload)
        if not added:
            added.append(True)
            with db.connect() as conn:
                enqueue_manual(conn, work_id='one', role='fanart', local_path=str(source))

    monkeypatch.setattr(module, '_atomic_bytes', write_with_new_role)
    service = ArtworkService(db, data_root=tmp_path)
    assert service.process_available(limit=1) == 1
    with db.connect() as conn:
        first = get_work_artwork(conn, 'one')
        assert first['poster']['state'] == 'ready'
        assert 'fanart' not in first
        assert conn.execute('SELECT state FROM artwork_resources').fetchone()[0] == 'pending'
    assert service.process_available(limit=1) == 1
    with db.connect() as conn:
        assert set(get_work_artwork(conn, 'one')['fanart']['variants']) == {'512', '768', '1280'}


def test_revision_cancel_during_download_keeps_manual_cover_and_retry_is_work_scoped(tmp_path, monkeypatch):
    from app.media_v4.jobs.runner import V4JobRunner

    db = _database(tmp_path)
    source = _image(tmp_path)
    service = ArtworkService(db, data_root=tmp_path)
    with db.connect() as conn:
        enqueue_manual(conn, work_id='two', role='poster', local_path=str(source))
    service.process_available()
    with db.connect() as conn:
        manual = get_work_artwork(conn, 'two')['poster']
        for work_id in ('one', 'two'):
            enqueue_metadata(conn, revision_id='r', work_id=work_id, snapshot_id='s',
                             metadata={'fanart_url': f'https://image.tmdb.org/{work_id}.jpg'})

    def download(url):
        V4JobRunner(db).cancel_revision('r')
        return source.read_bytes()

    monkeypatch.setattr(service, '_download', download)
    assert service.process_available() == 2
    with db.connect() as conn:
        assert get_work_artwork(conn, 'one') == {}
        assert get_work_artwork(conn, 'two')['poster'] == manual
        assert conn.execute("SELECT count(*) FROM artwork_resources WHERE state='running'").fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM library_changes').fetchone()[0] == 1
        assert retry_work(conn, 'one') == 1
        assert conn.execute("SELECT value FROM v4_meta WHERE key='artwork_cancelled_revision:r:one'").fetchone() is None
        assert conn.execute("SELECT value FROM v4_meta WHERE key='artwork_cancelled_revision:r:two'").fetchone() is not None
    monkeypatch.setattr(service, '_download', lambda url: source.read_bytes())
    assert service.process_available() == 1
    with db.connect() as conn:
        assert get_work_artwork(conn, 'one')['fanart']['state'] == 'ready'
        assert 'fanart' not in get_work_artwork(conn, 'two')
        assert get_work_artwork(conn, 'two')['poster'] == manual
