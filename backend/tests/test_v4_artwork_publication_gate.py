"""图片三项硬门槛与逐作品增量发布；全部采用隔离夹具。"""
import io

import pytest
from backend.tests.test_v4_library_projection import _entry
from PIL import Image

from app.media_v4.assets.service import ArtworkService
from app.media_v4.jobs.scrape import V4ScrapeService
from app.media_v4.persistence.database import V4Database
from app.media_v4.projection.library import V4LibraryProjection
from app.media_v4.revisions.service import V4RevisionService


def _prepared(tmp_path, monkeypatch, *, missing_still=False):
    database = V4Database(tmp_path / 'gate.db')
    database.initialize()
    revisions = V4RevisionService(database)
    revisions.create_draft('gate', [_entry('gate-episode')])
    revisions.confirm('gate')
    job = next(j for j in revisions.list_jobs('gate') if j['job_type'] == 'scrape_work')
    V4ScrapeService(database).process(job['job_id'], lambda target: {
        'provider': 'tmdb', 'provider_id': '42', 'metadata_state': 'ready', 'title': 'Ready Show',
        'poster_url': 'https://image.tmdb.org/poster.jpg',
        'fanart_url': 'https://image.tmdb.org/fanart.jpg',
        'episode_mappings': [{'episode_id': e['episode_id'], 'provider_episode_id': '1',
                              'title': 'Episode', 'still_url': '' if missing_still else 'https://image.tmdb.org/still.jpg'}
                             for e in target['episodes']],
    }, mirror_root=tmp_path / 'unused')
    output = io.BytesIO()
    Image.new('RGB', (16, 16), 'red').save(output, 'PNG')
    artwork = ArtworkService(database, tmp_path / 'images')
    monkeypatch.setattr(artwork, '_download', lambda url: output.getvalue())
    return database, revisions, artwork, job['work_id']


def test_initial_cards_wait_for_all_three_images_then_publish_incrementally(tmp_path, monkeypatch):
    database, revisions, artwork, work_id = _prepared(tmp_path, monkeypatch)
    projection = V4LibraryProjection(database)
    initial = projection.rebuild()
    assert initial.cards == ()
    assert revisions.get_execution_progress('gate')['work_units'][0]['overall_status'] == 'running_artwork'
    assert artwork.process_available(limit=2) == 2
    projection.refresh_if_needed()
    assert projection.current().cards == ()
    assert artwork.process_available(limit=1) == 1
    assert revisions.get_execution_progress('gate')['work_units'][0]['overall_status'] == 'waiting_publication'
    projection.refresh_if_needed()
    current = projection.current()
    assert [c['work_id'] for c in current.cards] == [work_id]
    assert current.generation_id == initial.generation_id
    assert revisions.get_execution_progress('gate')['work_units'][0]['overall_status'] == 'completed'


def test_no_still_source_is_a_missing_requirement_not_completed(tmp_path, monkeypatch):
    database, revisions, artwork, _ = _prepared(tmp_path, monkeypatch, missing_still=True)
    artwork.process_available()
    assert V4LibraryProjection(database).rebuild().cards == ()
    unit = revisions.get_execution_progress('gate')['work_units'][0]
    assert unit['metadata_state'] == 'ready'
    assert unit['overall_status'] == 'needs_attention'
    assert any('预览图' in reason for reason in unit['artifact_reasons'])


def test_optional_actor_image_failure_does_not_block_ready_work(tmp_path, monkeypatch):
    database, revisions, artwork, work_id = _prepared(tmp_path, monkeypatch)
    artwork.process_available()
    with database.connect() as conn:
        conn.execute("INSERT INTO artwork_resources(resource_id,source_url,state,created_at) VALUES ('actor','https://image.tmdb.org/actor.jpg','failed','now')")
        conn.execute("INSERT INTO artwork_bindings(subject_type,subject_id,work_id,role,candidate_id) VALUES ('metadata','actor',?,'profile','actor')", (work_id,))
    assert len(V4LibraryProjection(database).rebuild().cards) == 1
    assert revisions.get_execution_progress('gate')['work_units'][0]['overall_status'] == 'completed'


def test_movies_do_not_require_episode_previews_and_all_variants_are_required(tmp_path, monkeypatch):
    from app.media_v4.assets.status import required_artwork_status

    database, _, artwork, work_id = _prepared(tmp_path, monkeypatch, missing_still=True)
    with database.connect() as conn:
        conn.execute("UPDATE episodes SET episode_kind='movie' WHERE work_id=?", (work_id,))
    artwork.process_available()
    with database.connect() as conn:
        status = required_artwork_status(conn, work_id)
        assert status['status'] == 'ready'
        assert status['total'] == 2
        conn.execute('DELETE FROM artwork_variants WHERE width=1280')
        status = required_artwork_status(conn, work_id)
        assert status['status'] == 'failed'
        assert status['reasons'] == ['背景图尚未就绪（1 张）']


def test_old_publication_policy_is_not_served_before_background_refresh(tmp_path, monkeypatch):
    from fastapi import HTTPException

    from app.api import library_v4, media_v4

    database, _, artwork, work_id = _prepared(tmp_path, monkeypatch)
    monkeypatch.setattr(media_v4, '_database', database)
    artwork.process_available()
    projection = V4LibraryProjection(database)
    projection.rebuild()
    with database.connect() as conn:
        conn.execute("UPDATE v4_meta SET value='published-details-artwork-4' WHERE key='library_presentation_policy'")
    assert projection.current() is None
    assert projection.summary()['work_count'] == 0
    assert projection.summary()['updating']
    with pytest.raises(HTTPException, match='作品展示尚未发布'):
        library_v4.get_work_detail(work_id)
    projection.refresh_if_needed()
    assert len(projection.current().cards) == 1
