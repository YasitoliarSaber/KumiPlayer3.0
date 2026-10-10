from __future__ import annotations

import io
from concurrent.futures import ThreadPoolExecutor
from threading import Event, Lock

from backend.tests.test_v4_artwork_catalog import _database, enqueue_metadata
from PIL import Image

from app.media_v4.assets.catalog import _enqueue
from app.media_v4.assets.service import ArtworkService


def _image_bytes() -> bytes:
    output = io.BytesIO()
    Image.new('RGB', (600, 900), 'blue').save(output, 'PNG')
    return output.getvalue()


def test_fast_completion_releases_slot_without_waiting_for_slow_peer(tmp_path, monkeypatch):
    db = _database(tmp_path)
    with db.connect() as conn:
        for work_id in ('one', 'two'):
            enqueue_metadata(conn, revision_id='r', work_id=work_id, snapshot_id='s', metadata={
                'poster_url': f'https://image.tmdb.org/{work_id}-poster.jpg',
                'fanart_url': f'https://image.tmdb.org/{work_id}-fanart.jpg',
            })

    slow_started = Event()
    fast_started = Event()
    third_started = Event()
    release_slow = Event()
    download_lock = Lock()
    download_count = 0
    image = _image_bytes()

    def download(url: str) -> bytes:
        nonlocal download_count
        with download_lock:
            download_count += 1
            call_number = download_count
        if url.endswith('one-poster.jpg'):
            slow_started.set()
            assert release_slow.wait(3)
        else:
            fast_started.set()
        if call_number == 3:
            third_started.set()
        return image

    service = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(service, '_download', download)
    with ThreadPoolExecutor(max_workers=1) as caller:
        future = caller.submit(service.process_available, 3)
        try:
            assert slow_started.wait(2)
            assert fast_started.wait(2)
            assert third_started.wait(2), 'the next demand should start when the fast slot becomes free'
            assert not future.done(), 'the first slow download should still be holding its slot'
        finally:
            release_slow.set()
        assert future.result(timeout=5) == 3


def test_claim_orders_role_then_manual_priority_then_creation_time(tmp_path):
    db = _database(tmp_path)
    with db.connect() as conn:
        for work_id in ('episode-old', 'poster-new', 'poster-auto-old', 'poster-manual'):
            conn.execute("INSERT INTO works(work_id,identity_key,work_type,created_at,updated_at) "
                         "VALUES (?,?,'movie','now','now')", (work_id, work_id))
        rows = [
            ('episode-old', 'episode_thumb', 0, 'https://image.tmdb.org/episode.jpg', '2020'),
            ('poster-new', 'poster', 0, 'https://image.tmdb.org/poster-new.jpg', '2024'),
            ('poster-auto-old', 'poster', 0, 'https://image.tmdb.org/poster-auto-old.jpg', '2021'),
            ('poster-manual', 'poster', 100, 'https://image.tmdb.org/poster-manual.jpg', '2023'),
        ]
        for work_id, role, priority, url, created_at in rows:
            resource_id = _enqueue(
                conn,
                work_id=work_id,
                subject_type='work',
                subject_id=work_id,
                role=role,
                source_url=url,
                priority=priority,
            )
            conn.execute('UPDATE artwork_resources SET created_at=? WHERE resource_id=?',
                         (created_at, resource_id))

    claimed = ArtworkService(db, data_root=tmp_path)._claim(4)
    assert [row['source_url'] for row, _ in claimed] == [
        'https://image.tmdb.org/poster-manual.jpg',
        'https://image.tmdb.org/poster-auto-old.jpg',
        'https://image.tmdb.org/poster-new.jpg',
        'https://image.tmdb.org/episode.jpg',
    ]
