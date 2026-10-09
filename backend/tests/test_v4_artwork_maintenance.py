from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from app.api import assets, media_v4
from app.media_v4.assets.catalog import (
    _enqueue,
    capture_identity_repair_bindings,
    enqueue_manual,
    get_metadata_images_many,
    preserve_identity_repair_bindings,
)
from app.media_v4.assets.gc import execute_artwork_gc, preview_artwork_gc
from app.media_v4.assets.service import ArtworkService
from app.media_v4.persistence.database import V4Database
from fastapi import FastAPI
from fastapi.testclient import TestClient


def _database(tmp_path: Path) -> V4Database:
    database = V4Database(tmp_path / 'library.db')
    database.initialize()
    with database.connect() as conn:
        conn.execute("INSERT INTO works(work_id,identity_key,work_type,created_at,updated_at) "
                     "VALUES ('work','work','movie','now','now')")
    return database


def _resource(conn, *, resource_id: str, source_url: str = '', local_source: str = '') -> None:
    conn.execute('INSERT INTO artwork_resources(resource_id,source_url,local_source,created_at) VALUES (?,?,?,?)',
                 (resource_id, source_url, local_source, datetime.now(UTC).isoformat()))


def test_artwork_idle_claim_avoids_write_transaction(tmp_path):
    service = ArtworkService(_database(tmp_path), data_root=tmp_path)
    with service.database.connect() as conn:
        statements = []
        conn.set_trace_callback(statements.append)
        assert service._claim(2) == []
        conn.set_trace_callback(None)
    assert not any('BEGIN IMMEDIATE' in statement.upper() for statement in statements)
    assert not any(statement.lstrip().upper().startswith(('UPDATE ', 'INSERT ', 'DELETE '))
                   for statement in statements)


def test_cache_subroot_junction_cannot_expand_the_managed_boundary(tmp_path, monkeypatch):
    from app.media_v4.assets.gc import _managed_original_path, _managed_variant_path

    root = tmp_path / 'data'
    external = tmp_path / 'outside'
    original_resolve = Path.resolve

    def redirected_resolve(path, *args, **kwargs):
        for subroot in (root / 'cache' / 'artwork_variants', root / 'artwork' / 'originals'):
            if path == subroot or subroot in path.parents:
                return external / path.relative_to(subroot)
        return original_resolve(path, *args, **kwargs)

    monkeypatch.setattr(Path, 'resolve', redirected_resolve)
    assert _managed_variant_path(root, 'cache/artwork_variants/aa/fixture.webp') is None
    assert _managed_original_path(root, 'artwork/originals/aa/fixture') is None


def test_manual_enqueue_is_lexically_validated_before_writes(tmp_path):
    database = _database(tmp_path)
    with database.connect() as conn:
        for role, path in (('poster', 'relative/poster.png'), ('poster', str(tmp_path / 'poster.txt')),
                           ('profile', str(tmp_path / 'profile.png'))):
            with pytest.raises(ValueError):
                enqueue_manual(conn, work_id='work', role=role, local_path=path)
        assert conn.execute('SELECT count(*) FROM artwork_resources').fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM artwork_bindings').fetchone()[0] == 0


def test_historical_invalid_manual_source_becomes_explanatory_terminal_failure(tmp_path):
    database = _database(tmp_path)
    with database.connect() as conn:
        _enqueue(conn, work_id='work', subject_type='work', subject_id='work', role='poster',
                 local_source='relative/poster.txt', priority=100)
    service = ArtworkService(database, data_root=tmp_path)
    assert service.process_available(limit=1) == 1
    assert service.process_available(limit=1) == 0
    with database.connect() as conn:
        row = conn.execute('SELECT state,error_kind,attempts FROM artwork_resources').fetchone()
        assert tuple(row) == ('failed', 'invalid_manual_source', 1)
        from app.media_v4.assets.status import artwork_status

        assert artwork_status(conn, 'work')['reason_codes'] == ['invalid_manual_source']


def test_metadata_image_batch_deduplicates_and_bounds_queries(tmp_path):
    database = _database(tmp_path)
    with database.connect() as conn:
        url = 'https://image.tmdb.org/t/p/original/one.jpg'
        resource_id = _enqueue(conn, work_id='work', subject_type='metadata', subject_id='related-one',
                               role='related_poster', source_url=url)
        digest = 'c' * 64
        conn.execute("UPDATE artwork_resources SET state='ready',content_digest=? WHERE resource_id=?",
                     (digest, resource_id))
        for width in (256, 384, 512):
            conn.execute('INSERT INTO artwork_variants(content_digest,recipe_version,width,relative_path,'
                         'pixel_width,pixel_height,byte_size,etag) VALUES (?,?,?,?,?,?,?,?)',
                         (digest, 'webp-v1', width, f'cache/artwork_variants/{digest[:2]}/{digest}-{width}.webp',
                          width, width, 1, digest))
        conn.execute("UPDATE artwork_bindings SET published_id=candidate_id WHERE role='related_poster'")
        statements = []
        conn.set_trace_callback(statements.append)
        sources = ['/one.jpg', '/one.jpg', *[f'/missing-{index}.jpg' for index in range(600)]]
        result = get_metadata_images_many(conn, sources)
        conn.set_trace_callback(None)
        assert result['/one.jpg'].startswith('/api/assets/artwork/')
        assert len(statements) == 2
        statements.clear()
        conn.set_trace_callback(statements.append)
        assert get_metadata_images_many(conn, []) == {}
        conn.set_trace_callback(None)
        assert statements == []


def test_artwork_get_handles_missing_and_unreadable_files_before_response_send(tmp_path, monkeypatch):
    database = _database(tmp_path)
    digest = 'd' * 64
    resource_id = 'e' * 64
    relative = f'cache/artwork_variants/{digest[:2]}/{digest}-webp-v1-384.webp'
    target = tmp_path / relative
    target.parent.mkdir(parents=True)
    target.write_bytes(b'webp-data')
    with database.connect() as conn:
        _resource(conn, resource_id=resource_id, source_url='https://image.tmdb.org/image.webp')
        conn.execute('UPDATE artwork_resources SET state=?,content_digest=? WHERE resource_id=?',
                     ('ready', digest, resource_id))
        conn.execute('INSERT INTO artwork_variants(content_digest,recipe_version,width,relative_path,'
                     'pixel_width,pixel_height,byte_size,etag) VALUES (?,?,?,?,?,?,?,?)',
                     (digest, 'webp-v1', 384, relative, 384, 576, 9, 'f' * 64))
        conn.execute("INSERT INTO artwork_bindings(subject_type,subject_id,work_id,role,candidate_id,published_id) "
                     "VALUES ('work','work','work','poster',?,?)", (resource_id, resource_id))
    monkeypatch.setattr(media_v4, 'get_database', lambda: database)
    monkeypatch.setattr('app.core.paths.get_data_dir', lambda: tmp_path)
    app = FastAPI()
    app.include_router(assets.router)
    path = f'/api/assets/artwork/{resource_id}/{digest}-webp-v1/384'
    with TestClient(app) as client:
        response = client.get(path)
        assert response.status_code == 200
        assert response.content == b'webp-data'
        original_open = Path.open
        reads = []

        class ReadTrackingFile:
            def __init__(self, wrapped):
                self.wrapped = wrapped

            def __enter__(self):
                self.wrapped.__enter__()
                return self

            def __exit__(self, *args):
                return self.wrapped.__exit__(*args)

            def fileno(self):
                return self.wrapped.fileno()

            def read(self, *args):
                reads.append(args)
                return self.wrapped.read(*args)

        def track_open(path_obj, *args, **kwargs):
            opened = original_open(path_obj, *args, **kwargs)
            return ReadTrackingFile(opened) if path_obj == target else opened

        monkeypatch.setattr(Path, 'open', track_open)
        conditional = client.get(path, headers={'If-None-Match': response.headers['etag']})
        assert conditional.status_code == 304
        assert reads == []
        assert target.stat().st_size == 9
        monkeypatch.setattr(Path, 'open', original_open)
        target.unlink()
        assert client.get(path).status_code == 404
        target.write_bytes(b'webp-data')

        def fail_requested_open(path_obj, *args, **kwargs):
            if path_obj == target:
                raise PermissionError('fixture unreadable')
            return original_open(path_obj, *args, **kwargs)

        monkeypatch.setattr(Path, 'open', fail_requested_open)
        assert client.get(path).status_code == 404


def test_artwork_gc_requires_confirmation_rechecks_references_and_keeps_originals(tmp_path):
    database = _database(tmp_path)
    now = datetime(2026, 10, 9, tzinfo=UTC)
    old = (now - timedelta(days=45)).isoformat()
    digest = '1' * 64
    resource_id = '2' * 64
    original = tmp_path / 'artwork' / 'originals' / digest[:2] / digest
    variant_relative = f'cache/artwork_variants/{digest[:2]}/{digest}-webp-v1-384.webp'
    variant = tmp_path / variant_relative
    original.parent.mkdir(parents=True)
    variant.parent.mkdir(parents=True)
    original.write_bytes(b'protected-original')
    variant.write_bytes(b'derived-cache')
    with database.connect() as conn:
        _resource(conn, resource_id=resource_id, local_source='C:/manual/poster.png')
        conn.execute('UPDATE artwork_resources SET state=?,content_digest=?,original_path=?,created_at=? '
                     'WHERE resource_id=?', ('ready', digest, str(original.relative_to(tmp_path)).replace('\\', '/'),
                                              old, resource_id))
        conn.execute('INSERT INTO artwork_variants(content_digest,recipe_version,width,relative_path,'
                     'pixel_width,pixel_height,byte_size,etag) VALUES (?,?,?,?,?,?,?,?)',
                     (digest, 'webp-v1', 384, variant_relative, 384, 576, variant.stat().st_size, hashlib.sha256(b'cache').hexdigest()))

    plan = preview_artwork_gc(database, tmp_path, now=now)
    assert plan['content_digests'] == [digest]
    assert plan['variant_count'] == 1
    with pytest.raises(ValueError):
        execute_artwork_gc(database, tmp_path, plan, now=now)

    # A newly added binding after preview makes the digest ineligible at execution.
    with database.connect() as conn:
        _enqueue(conn, work_id='work', subject_type='work', subject_id='work', role='poster',
                 local_source='C:/manual/poster.png', priority=100)
        conn.execute('UPDATE artwork_bindings SET candidate_id=?,published_id=?', (resource_id, resource_id))
    result = execute_artwork_gc(database, tmp_path, plan, confirm=True, now=now)
    assert result['removed'] == 0
    assert result['skipped'] == 1
    assert variant.exists()
    assert original.read_bytes() == b'protected-original'


def test_artwork_gc_removes_only_unreferenced_managed_variants(tmp_path):
    database = _database(tmp_path)
    now = datetime(2026, 10, 9, tzinfo=UTC)
    digest = '3' * 64
    resource_id = '4' * 64
    original = tmp_path / 'artwork' / 'originals' / digest[:2] / digest
    relative = f'cache/artwork_variants/{digest[:2]}/{digest}-webp-v1-384.webp'
    target = tmp_path / relative
    original.parent.mkdir(parents=True)
    target.parent.mkdir(parents=True)
    original.write_bytes(b'original-stays')
    target.write_bytes(b'variant-remove')
    with database.connect() as conn:
        _resource(conn, resource_id=resource_id, local_source='C:/manual/cover.png')
        conn.execute('UPDATE artwork_resources SET content_digest=?,original_path=?,created_at=? WHERE resource_id=?',
                     (digest, str(original.relative_to(tmp_path)).replace('\\', '/'),
                      (now - timedelta(days=45)).isoformat(), resource_id))
        conn.execute('INSERT INTO artwork_variants(content_digest,recipe_version,width,relative_path,'
                     'pixel_width,pixel_height,byte_size,etag) VALUES (?,?,?,?,?,?,?,?)',
                     (digest, 'webp-v1', 384, relative, 384, 576, target.stat().st_size, hashlib.sha256(b'v').hexdigest()))
    plan = preview_artwork_gc(database, tmp_path, now=now)
    result = execute_artwork_gc(database, tmp_path, plan, confirm=True, now=now)
    assert result == {'removed': 1, 'bytes': len(b'variant-remove'), 'skipped': 0, 'originals_deleted': 0}
    assert not target.exists()
    assert original.read_bytes() == b'original-stays'
    with database.connect() as conn:
        assert conn.execute('SELECT count(*) FROM artwork_variants').fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM artwork_resources').fetchone()[0] == 1


def test_artwork_gc_removes_expired_automatic_original_but_protects_manual_and_shared_digest(tmp_path):
    database = _database(tmp_path)
    now = datetime(2026, 10, 9, tzinfo=UTC)
    old = (now - timedelta(days=45)).isoformat()
    auto_digest = 'd' * 64
    shared_digest = 'e' * 64
    auto_original_rel = f'artwork/originals/{auto_digest[:2]}/{auto_digest}'
    manual_original_rel = f'artwork/originals/{shared_digest[:2]}/{shared_digest}'
    auto_original = tmp_path / auto_original_rel
    manual_original = tmp_path / manual_original_rel
    auto_variant_rel = f'cache/artwork_variants/{auto_digest[:2]}/{auto_digest}-webp-v1-384.webp'
    shared_variant_rel = f'cache/artwork_variants/{shared_digest[:2]}/{shared_digest}-webp-v1-384.webp'
    auto_variant = tmp_path / auto_variant_rel
    shared_variant = tmp_path / shared_variant_rel
    for path in (auto_original, manual_original, auto_variant, shared_variant):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'fixture-image')
    with database.connect() as conn:
        _resource(conn, resource_id='f' * 64, source_url='https://image.tmdb.org/auto.jpg')
        conn.execute('UPDATE artwork_resources SET content_digest=?,original_path=?,created_at=? WHERE resource_id=?',
                     (auto_digest, auto_original_rel, old, 'f' * 64))
        _resource(conn, resource_id='9' * 64, source_url='https://image.tmdb.org/auto-shared.jpg')
        conn.execute('UPDATE artwork_resources SET content_digest=?,original_path=?,created_at=? WHERE resource_id=?',
                     (auto_digest, auto_original_rel, old, '9' * 64))
        _resource(conn, resource_id='a' * 64, local_source='C:/manual/poster.png')
        conn.execute('UPDATE artwork_resources SET content_digest=?,original_path=?,created_at=? WHERE resource_id=?',
                     (shared_digest, manual_original_rel, old, 'a' * 64))
        _resource(conn, resource_id='b' * 64, source_url='https://image.tmdb.org/shared.jpg')
        conn.execute('UPDATE artwork_resources SET content_digest=?,original_path=?,created_at=? WHERE resource_id=?',
                     (shared_digest, manual_original_rel, old, 'b' * 64))
        for digest, relative in ((auto_digest, auto_variant_rel), (shared_digest, shared_variant_rel)):
            conn.execute('INSERT INTO artwork_variants(content_digest,recipe_version,width,relative_path,'
                         'pixel_width,pixel_height,byte_size,etag) VALUES (?,?,?,?,?,?,?,?)',
                         (digest, 'webp-v1', 384, relative, 384, 576, len(b'fixture-image'), digest))

    plan = preview_artwork_gc(database, tmp_path, now=now)
    assert plan['content_digests'] == [auto_digest, shared_digest]
    assert [item['content_digest'] for item in plan['originals']] == [auto_digest]
    result = execute_artwork_gc(database, tmp_path, plan, confirm=True, now=now)

    assert result['removed'] == 2
    assert result['originals_deleted'] == 1
    assert not auto_original.exists()
    assert not auto_variant.exists()
    assert manual_original.read_bytes() == b'fixture-image'
    assert not shared_variant.exists()
    with database.connect() as conn:
        paths = conn.execute(
            "SELECT original_path FROM artwork_resources WHERE content_digest=? AND local_source=''",
            (auto_digest,),
        ).fetchall()
    assert len(paths) == 2 and all(row[0] == '' for row in paths)


def test_artwork_gc_advances_past_completed_first_page(tmp_path, monkeypatch):
    import app.media_v4.assets.gc as gc_module

    database = _database(tmp_path)
    now = datetime(2026, 10, 9, tzinfo=UTC)
    old = (now - timedelta(days=45)).isoformat()
    digests = ['1' * 64, '2' * 64, '3' * 64]
    with database.connect() as conn:
        for index, digest in enumerate(digests):
            resource_id = str(index + 1) * 64
            _resource(conn, resource_id=resource_id, source_url=f'https://image.tmdb.org/{index}.jpg')
            conn.execute('UPDATE artwork_resources SET content_digest=?,created_at=? WHERE resource_id=?',
                         (digest, old, resource_id))
            relative = f'cache/artwork_variants/{digest[:2]}/{digest}-webp-v1-384.webp'
            variant = tmp_path / relative
            variant.parent.mkdir(parents=True, exist_ok=True)
            variant.write_bytes(b'variant')
            conn.execute('INSERT INTO artwork_variants(content_digest,recipe_version,width,relative_path,'
                         'pixel_width,pixel_height,byte_size,etag) VALUES (?,?,?,?,?,?,?,?)',
                         (digest, 'webp-v1', 384, relative, 384, 576, variant.stat().st_size, digest))
    monkeypatch.setattr(gc_module, '_MAX_DIGESTS_PER_PLAN', 2)

    first = preview_artwork_gc(database, tmp_path, now=now)
    assert first['content_digests'] == digests[:2]
    assert execute_artwork_gc(database, tmp_path, first, confirm=True, now=now)['removed'] == 2
    second = preview_artwork_gc(database, tmp_path, now=now)
    assert second['content_digests'] == digests[2:]
    assert execute_artwork_gc(database, tmp_path, second, confirm=True, now=now)['removed'] == 1
    assert preview_artwork_gc(database, tmp_path, now=now)['content_digests'] == []


def test_artwork_gc_preview_protects_all_binding_slots_leases_and_shared_digests(tmp_path):
    database = _database(tmp_path)
    now = datetime(2026, 10, 9, tzinfo=UTC)
    old = (now - timedelta(days=45)).isoformat()
    recent = (now - timedelta(days=2)).isoformat()
    cases = (
        ('candidate', '5' * 64, 'C:/manual/candidate.png', old, '', '', 'poster'),
        ('published', '6' * 64, 'C:/manual/published.png', old, 'published', '', 'fanart'),
        ('automatic', '7' * 64, '', old, '', 'automatic', 'clearlogo'),
        ('leased', '8' * 64, '', old, 'lease', '', 'poster'),
    )
    with database.connect() as conn:
        for name, digest, local_source, created_at, binding_kind, automatic_kind, role in cases:
            if binding_kind == 'lease':
                resource_id = 'a' * 64
                _resource(conn, resource_id=resource_id, source_url=f'https://image.tmdb.org/{name}.jpg')
                conn.execute('UPDATE artwork_resources SET content_digest=?,created_at=?,lease_token=?,lease_until=? '
                             'WHERE resource_id=?', (digest, created_at, 'active', now.timestamp() + 60, resource_id))
                continue
            resource_id = _enqueue(
                conn, work_id='work', subject_type='work', subject_id=name, role=role, local_source=local_source,
                source_url=f'https://image.tmdb.org/{name}.jpg' if not local_source else '',
                priority=0 if automatic_kind else 100,
            )
            conn.execute('UPDATE artwork_resources SET content_digest=?,created_at=? WHERE resource_id=?',
                         (digest, created_at, resource_id))
            if binding_kind == 'published':
                conn.execute('UPDATE artwork_bindings SET published_id=? WHERE candidate_id=?',
                             (resource_id, resource_id))
        # 与老 orphan 共享内容的较新资源会阻止整个 digest 的变体回收。
        _resource(conn, resource_id='b' * 64, source_url='https://image.tmdb.org/shared-old.jpg')
        conn.execute('UPDATE artwork_resources SET content_digest=?,created_at=? WHERE resource_id=?',
                     ('9' * 64, old, 'b' * 64))
        _resource(conn, resource_id='c' * 64, source_url='https://image.tmdb.org/shared-recent.jpg')
        conn.execute('UPDATE artwork_resources SET content_digest=?,created_at=? WHERE resource_id=?',
                     ('9' * 64, recent, 'c' * 64))
    plan = preview_artwork_gc(database, tmp_path, now=now)
    assert plan['content_digests'] == []


def test_identity_repair_artwork_copy_preserves_manual_target_override(tmp_path):
    database = _database(tmp_path)
    source_path = tmp_path / 'source.png'
    source_path.write_bytes(b'source')
    target_path = tmp_path / 'target.png'
    target_path.write_bytes(b'target')
    with database.connect() as conn:
        for work_id in ('old', 'new', 'protected'):
            conn.execute("INSERT INTO works(work_id,identity_key,work_type,created_at,updated_at) "
                         "VALUES (?,?, 'movie','now','now')", (work_id, work_id))
        old_resource = _enqueue(conn, work_id='old', subject_type='work', subject_id='old', role='poster',
                                local_source=str(source_path), priority=100)
        old_published = old_resource
        conn.execute("UPDATE artwork_bindings SET published_id=? WHERE subject_id='old'", (old_published,))
        protected_resource = _enqueue(conn, work_id='protected', subject_type='work', subject_id='protected',
                                      role='poster', local_source=str(target_path), priority=100)
        conn.execute("UPDATE artwork_bindings SET published_id=? WHERE subject_id='protected'",
                     (protected_resource,))
        result = preserve_identity_repair_bindings(conn, 'old', ['new', 'protected'])
        new_binding = conn.execute("SELECT candidate_id,published_id,priority FROM artwork_bindings "
                                   "WHERE subject_id='new'").fetchone()
        protected_binding = conn.execute("SELECT candidate_id,published_id,priority FROM artwork_bindings "
                                         "WHERE subject_id='protected'").fetchone()
    assert result == {'manual': ['new'], 'automatic': []}
    assert tuple(new_binding) == (old_resource, old_published, 100)
    assert tuple(protected_binding) == (protected_resource, protected_resource, 100)


def test_identity_repair_captures_only_complete_current_automatic_artwork(tmp_path):
    from backend.tests.test_v4_artwork_catalog import _database as artwork_database
    from backend.tests.test_v4_artwork_catalog import enqueue_metadata as add_metadata

    database = artwork_database(tmp_path)
    with database.connect() as conn:
        for work_id in ('one', 'two', 'new'):
            if work_id == 'new':
                conn.execute("INSERT INTO works(work_id,identity_key,work_type,created_at,updated_at) "
                             "VALUES ('new','new','movie','now','now')")
        add_metadata(conn, revision_id='r', work_id='one', snapshot_id='ready', metadata={
            'poster_url': 'https://image.tmdb.org/ready.jpg',
            'fanart_url': 'https://image.tmdb.org/incomplete.jpg',
        })
        add_metadata(conn, revision_id='r', work_id='two', snapshot_id='target', metadata={
            'poster_url': 'https://image.tmdb.org/target.jpg',
        })
        poster_ids = {}
        for work_id, digest in (('one', 'a' * 64), ('two', 'b' * 64)):
            row = conn.execute("SELECT candidate_id FROM artwork_bindings WHERE work_id=? AND role='poster'",
                               (work_id,)).fetchone()
            resource_id = row[0]
            poster_ids[work_id] = resource_id
            conn.execute("UPDATE artwork_resources SET state='ready',content_digest=? WHERE resource_id=?",
                         (digest, resource_id))
            for width in (256, 384, 512):
                conn.execute('INSERT INTO artwork_variants(content_digest,recipe_version,width,relative_path,'
                             'pixel_width,pixel_height,byte_size,etag) VALUES (?,?,?,?,?,?,?,?)',
                             (digest, 'webp-v1', width, f'cache/artwork_variants/{digest[:2]}/{digest}-{width}.webp',
                              width, width, 1, digest))
            conn.execute("UPDATE artwork_bindings SET published_id=candidate_id WHERE work_id=? AND role='poster'",
                         (work_id,))
        fanart = conn.execute("SELECT candidate_id FROM artwork_bindings WHERE work_id='one' AND role='fanart'").fetchone()
        conn.execute("UPDATE artwork_resources SET state='ready',content_digest=? WHERE resource_id=?",
                     ('c' * 64, fanart[0]))
        for width in (512, 768):
            conn.execute('INSERT INTO artwork_variants(content_digest,recipe_version,width,relative_path,'
                         'pixel_width,pixel_height,byte_size,etag) VALUES (?,?,?,?,?,?,?,?)',
                         ('c' * 64, 'webp-v1', width, f'cache/artwork_variants/cc/incomplete-{width}.webp',
                          width, width, 1, 'c' * 64))
        conn.execute("UPDATE artwork_bindings SET published_id=candidate_id WHERE work_id='one' AND role='fanart'")

        captured = capture_identity_repair_bindings(conn, 'one')
        assert [item['role'] for item in captured] == ['poster']
        result = preserve_identity_repair_bindings(conn, 'one', ['new', 'two'], source_bindings=captured)
        new_row = conn.execute("SELECT candidate_id,published_id,automatic_id FROM artwork_bindings "
                               "WHERE subject_id='new' AND role='poster'").fetchone()
        target_row = conn.execute("SELECT candidate_id,published_id,automatic_id FROM artwork_bindings "
                                  "WHERE subject_id='two' AND role='poster'").fetchone()
        assert conn.execute("SELECT count(*) FROM artwork_bindings WHERE subject_id='new' AND role='fanart'").fetchone()[0] == 0
    assert result == {'manual': [], 'automatic': ['new']}
    assert tuple(new_row) == (poster_ids['one'], poster_ids['one'], poster_ids['one'])
    assert tuple(target_row) == (poster_ids['two'], poster_ids['two'], poster_ids['two'])
