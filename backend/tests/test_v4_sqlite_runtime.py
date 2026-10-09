"""确认、资料和展示在没有镜像、NFO 或图片时仍走同一 SQLite 执行链。"""

from backend.tests.test_v4_import_metadata_lifecycle import confirm, provider

from app.media_v4.jobs.runner import V4JobRunner
from app.media_v4.persistence.database import V4Database
from app.media_v4.projection.library import V4LibraryProjection


def _ready_database(tmp_path):
    database = V4Database(tmp_path / 'runtime.db')
    database.initialize()
    confirm(database, 'r1')
    V4JobRunner(database, metadata_provider=provider).process_available()
    return database, V4LibraryProjection(database).current().cards[0]['work_id']


def test_confirm_enqueues_only_metadata_and_projection(tmp_path):
    database = V4Database(tmp_path / "runtime.db")
    database.initialize()
    confirm(database, "r1")
    with database.connect() as conn:
        types = {row[0] for row in conn.execute("SELECT job_type FROM jobs")}
    assert types == {"scrape_work", "refresh_projection"}


def test_metadata_and_published_cards_need_no_mirror_or_nfo(tmp_path, monkeypatch):
    database = V4Database(tmp_path / "runtime.db")
    database.initialize()
    confirm(database, "r1")

    def forbid(*_args, **_kwargs):
        raise AssertionError("runtime accessed mirror/NFO or physical completeness")

    monkeypatch.setattr("app.core.paths.get_mirror_root", forbid)
    monkeypatch.setattr("app.media_v4.jobs.metadata_artifacts.publish_metadata_artifacts", forbid)
    monkeypatch.setattr("app.media_v4.jobs.completeness.assess_persisted_completeness", forbid)
    V4JobRunner(database, metadata_provider=provider).process_available()
    snapshot = V4LibraryProjection(database).current()
    assert snapshot and snapshot.cards[0]["metadata"]["metadata_state"] == "ready"
    assert snapshot.cards[0]["title"] == "Online title"
    with database.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM metadata_snapshots").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM artifacts").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM jobs WHERE status!='succeeded'").fetchone()[0] == 0


def test_confirmed_media_is_published_before_optional_metadata(tmp_path):
    database = V4Database(tmp_path / "runtime.db")
    database.initialize()
    confirm(database, "r1")
    card = V4LibraryProjection(database).rebuild().cards[0]
    assert card["title"] == "Show"
    assert card["metadata"]["metadata_state"] == "waiting_metadata"
    from unittest.mock import patch

    from app.api import library_v4

    with patch.object(library_v4, "get_database", return_value=database):
        assert library_v4.get_library()["works"][0]["work_id"] == card["work_id"]


def test_browsing_reads_published_detail_without_rebuilding_or_checking_files(tmp_path, monkeypatch):
    from app.api import library_v4

    database, work_id = _ready_database(tmp_path)
    monkeypatch.setattr(library_v4, 'get_database', lambda: database)
    before = library_v4.get_work_detail(work_id)
    with database.connect() as conn:
        conn.execute("UPDATE episodes SET display_title='not published'")
    def forbid(*args, **kwargs):
        raise AssertionError('read request started background work')
    monkeypatch.setattr('app.media_v4.projection.details.build_work_detail', forbid)
    monkeypatch.setattr(V4LibraryProjection, 'rebuild', forbid)
    monkeypatch.setattr('pathlib.Path.is_file', forbid)
    assert library_v4.get_work_detail(work_id) == before
    assert library_v4.get_library(compact=True)['works'][0]['work_id'] == work_id


def test_partial_projection_preserves_generation_and_unaffected_detail(tmp_path, monkeypatch):
    from app.media_v4.projection import details
    from app.media_v4.projection.library import mark_projection_dirty

    database, work_id = _ready_database(tmp_path)
    snapshot = V4LibraryProjection(database).current()
    with database.connect() as conn:
        conn.execute("INSERT INTO works(work_id,identity_key,work_type,created_at,updated_at) "
                     "VALUES ('untouched','untouched','movie','now','now')")
        conn.execute('INSERT INTO library_cards(generation_id,work_id,title,media_type,episode_count,asset_count,metadata_json) '
                     "VALUES (?, 'untouched','Other','movie',1,1,'{}')", (snapshot.generation_id,))
        conn.execute("INSERT INTO library_details VALUES (?,'untouched','{}')", (snapshot.generation_id,))
        conn.execute("UPDATE works SET preferred_title='Changed' WHERE work_id=?", (work_id,))
        mark_projection_dirty(conn, [work_id])
    calls = []
    original = details.build_work_detail
    def build(conn, target, metadata):
        calls.append(target)
        return original(conn, target, metadata)
    monkeypatch.setattr(details, 'build_work_detail', build)
    result = V4LibraryProjection(database).refresh_if_needed()
    assert result.generation_id == snapshot.generation_id
    assert calls == [work_id]
    with database.connect() as conn:
        assert conn.execute("SELECT detail_json FROM library_details WHERE work_id='untouched'").fetchone()[0] == '{}'
        assert conn.execute("SELECT 1 FROM v4_meta WHERE key='library_projection_dirty'").fetchone() is None


def test_changes_are_bounded_and_expired_cursor_requires_reset(tmp_path, monkeypatch):
    from app.media_v4.projection import changes

    database = V4Database(tmp_path / 'events.db')
    database.initialize()
    with database.connect() as conn:
        for work_id in ('one', 'two', 'three'):
            changes.record_change(conn, 'artwork', work_id)
        first = changes.read_changes(conn, 0, 2)
        assert first['has_more'] and first['next_sequence'] == 2
        assert [event['work_id'] for event in first['changes']] == ['one', 'two']
        last = changes.read_changes(conn, first['next_sequence'], 2)
        assert not last['has_more'] and last['next_sequence'] == 3
        monkeypatch.setattr(changes, 'RETENTION', 2)
        changes.record_change(conn, 'artwork', 'four')
        assert changes.read_changes(conn, 0, 2)['reset_required']


def test_bad_image_does_not_change_metadata_or_rebuild_library(tmp_path, monkeypatch):
    from app.media_v4.assets.service import ArtworkService

    database, work_id = _ready_database(tmp_path)
    before = V4LibraryProjection(database).current()
    with database.connect() as conn:
        snapshot_before = tuple(conn.execute('SELECT * FROM metadata_snapshots').fetchone())
    service = ArtworkService(database, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', lambda *args: b'not an image')
    service.process_available()
    after = V4LibraryProjection(database).current()
    assert before.generation_id == after.generation_id and after.cards[0]['metadata']['metadata_state'] == 'ready'
    with database.connect() as conn:
        assert tuple(conn.execute('SELECT * FROM metadata_snapshots').fetchone()) == snapshot_before
        assert conn.execute("SELECT 1 FROM v4_meta WHERE key='library_projection_dirty'").fetchone() is None


def test_import_confirm_rejects_missing_or_remote_final_path(tmp_path, monkeypatch):
    from dataclasses import replace

    import pytest
    from fastapi import HTTPException

    from app.api import media_v4
    from app.media_v4.parsing.parser import V4Parser
    from app.media_v4.revisions.service import V4RevisionService
    from app.media_v4.sources.adapters import SourceEntry, to_source_evidence

    database = V4Database(tmp_path / 'paths.db')
    database.initialize()
    monkeypatch.setattr(media_v4, 'get_database', lambda: database)
    for index, path in enumerate(('', 'https://example.com/video.mkv', 'relative/video.mkv', 'Z:/video.strm')):
        evidence = to_source_evidence(SourceEntry(root_id=f'root{index}', scan_id=f'r{index}', provider='local',
            ingest_method='local_scan', relative_path='Show.S01E01.mkv'))
        evidence = replace(evidence, playback_locator=path)
        service = V4RevisionService(database)
        service.create_draft(f'r{index}', [(evidence, V4Parser().parse(evidence))])
        with pytest.raises(HTTPException) as exc:
            media_v4.confirm(f'r{index}')
        assert exc.value.status_code == 409
        assert service.get_status(f'r{index}') == 'draft'


def test_source_retirement_needs_no_mirror_and_preserves_personal_data(tmp_path, monkeypatch):
    import json

    from app.core.config import AppConfig
    from app.media_v4.maintenance.source_deletion import enqueue_source_deletion, plan_source_deletion

    database, work_id = _ready_database(tmp_path)
    cover = tmp_path / 'manual.png'
    cover.write_bytes(b'manual image preserved')
    with database.connect() as conn:
        conn.execute("INSERT INTO work_overrides VALUES (?,?, 'now','now')",
                     (work_id, json.dumps({'local_poster_path': str(cover)})))
        conn.execute("INSERT INTO tracking_states(work_id,provider,metadata_json,updated_at) VALUES (?,'local','{}','now')",
                     (work_id,))
    monkeypatch.setattr('app.core.config.load_config', lambda: AppConfig(mirror_dir=''))
    assert plan_source_deletion(database, 'root-life')['works_removable'] == 1
    job_id = enqueue_source_deletion(database, 'root-life')
    result = V4JobRunner(database).process_job(job_id)
    assert result.status == 'succeeded'
    assert V4LibraryProjection(database).current().cards == ()
    assert cover.read_bytes() == b'manual image preserved'
    with database.connect() as conn:
        assert conn.execute('SELECT 1 FROM work_overrides WHERE work_id=?', (work_id,)).fetchone()
        assert conn.execute('SELECT 1 FROM tracking_states WHERE work_id=?', (work_id,)).fetchone()


def test_projection_cannot_promote_unreferenced_legacy_binding(tmp_path):
    import json

    database = V4Database(tmp_path / 'legacy.db')
    database.initialize()
    confirm(database, 'r1')
    with database.connect() as conn:
        work_id = conn.execute("SELECT work_id FROM revision_bindings WHERE revision_id='r1'").fetchone()[0]
        conn.execute('INSERT INTO scrape_bindings(binding_id,revision_id,work_id,provider,provider_id,metadata_json,status,created_at,updated_at) '
                     "VALUES ('legacy','r1',?,'tmdb','123',?,'confirmed','now','now')",
                     (work_id, json.dumps({'metadata_state': 'ready', 'provider': 'tmdb', 'title': 'unreferenced title'})))
    card = V4LibraryProjection(database).rebuild().cards[0]
    assert card['title'] == 'Show'
    assert card['metadata']['metadata_state'] == 'waiting_metadata'


def test_noop_dirty_does_not_publish_events_or_change_digest(tmp_path):
    from app.media_v4.projection.library import mark_projection_dirty

    database, work_id = _ready_database(tmp_path)
    before = V4LibraryProjection(database).current()
    with database.connect() as conn:
        mark_projection_dirty(conn, [work_id])
    after = V4LibraryProjection(database).refresh_if_needed()
    assert after.change_sequence == before.change_sequence
    assert after.digest == before.digest and after.generation_id == before.generation_id


def test_detail_only_change_publishes_local_event(tmp_path):
    from app.media_v4.projection.library import mark_projection_dirty

    database, work_id = _ready_database(tmp_path)
    before = V4LibraryProjection(database).current()
    with database.connect() as conn:
        conn.execute("UPDATE assets SET availability_state='missing'")
        mark_projection_dirty(conn, [work_id])
    after = V4LibraryProjection(database).refresh_if_needed()
    assert after.generation_id == before.generation_id
    assert after.change_sequence == before.change_sequence + 1


def test_manual_cover_api_keeps_old_display_until_ready_and_preserves_original(tmp_path, monkeypatch):
    import asyncio
    import base64
    import io

    from PIL import Image

    from app.api import media_v4
    from app.media_v4.assets.catalog import get_work_artwork
    from app.media_v4.assets.service import ArtworkService

    database, work_id = _ready_database(tmp_path)
    monkeypatch.setattr(media_v4, 'get_database', lambda: database)
    monkeypatch.setattr('app.core.paths.get_data_dir', lambda: tmp_path)
    def png(color):
        output = io.BytesIO()
        Image.new('RGB', (60, 90), color).save(output, 'PNG')
        return output.getvalue()
    service = ArtworkService(database, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', lambda *args: png('red'))
    service.process_available()
    with database.connect() as conn:
        automatic = get_work_artwork(conn, work_id)['poster']
    result = asyncio.run(media_v4.upload_work_artwork(work_id, media_v4.ArtworkUploadRequest(
        kind='poster', data_base64=base64.b64encode(png('blue')).decode())))
    assert result['state'] == 'pending'
    with database.connect() as conn:
        assert get_work_artwork(conn, work_id)['poster'] == automatic
    service.process_available()
    with database.connect() as conn:
        manual = get_work_artwork(conn, work_id)['poster']
        original = conn.execute('SELECT local_source FROM artwork_resources WHERE resource_id=?',
                                (manual['resource_id'],)).fetchone()[0]
    from pathlib import Path
    assert Path(original).read_bytes() == png('blue')
    assert manual != automatic
    media_v4.restore_work_artwork(work_id, 'poster')
    service.process_available()
    with database.connect() as conn:
        assert get_work_artwork(conn, work_id)['poster'] == automatic
    assert Path(original).read_bytes() == png('blue')
