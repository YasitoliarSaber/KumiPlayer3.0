"""图片来源只由后台领取；HTTP 并发只消费已发布的本地派生。"""

from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path

import httpx
import pytest
from app.api import assets, media_v4
from app.media_v4.assets.catalog import get_work_artwork
from app.media_v4.assets.service import ArtworkService, _atomic_bytes
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.tests.test_v4_artwork_catalog import _database, _image, enqueue_metadata

TMDB_URL = 'https://image.tmdb.org/t/p/original/poster.jpg'


def _published(tmp_path, monkeypatch):
    db = _database(tmp_path)
    source = _image(tmp_path)
    with db.connect() as conn:
        for work_id in ('one', 'two'):
            enqueue_metadata(conn, revision_id='r', work_id=work_id, snapshot_id='s',
                             metadata={'poster_url': TMDB_URL})
    downloads = []
    worker = ArtworkService(db, data_root=tmp_path)
    monkeypatch.setattr(worker, '_download', lambda url: (downloads.append(url), source.read_bytes())[-1])
    assert worker.process_available() == 1
    assert downloads == [TMDB_URL]
    with db.connect() as conn:
        picture = get_work_artwork(conn, 'one')['poster']
        variant = dict(conn.execute('SELECT * FROM artwork_variants WHERE width=384').fetchone())
    monkeypatch.setattr(media_v4, 'get_database', lambda: db)
    monkeypatch.setattr('app.core.paths.get_data_dir', lambda: tmp_path)
    app = FastAPI()
    app.include_router(assets.router)
    return app, db, picture, variant


def test_concurrent_same_resource_gets_do_not_download_or_reencode(tmp_path, monkeypatch):
    app, db, picture, variant = _published(tmp_path, monkeypatch)
    monkeypatch.setattr(ArtworkService, 'process_available', lambda *args: pytest.fail('GET must not prepare'))

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
            return await asyncio.gather(*[client.get(picture['variants']['384']) for _ in range(6)])

    responses = asyncio.run(scenario())
    expected = (tmp_path / variant['relative_path']).read_bytes()
    assert [response.status_code for response in responses] == [200] * 6
    assert all(response.content == expected for response in responses)
    with db.connect() as conn:
        assert conn.execute('SELECT attempts FROM artwork_resources').fetchone()[0] == 1


def test_cache_get_uses_registered_etag_and_size_without_read_bytes(tmp_path, monkeypatch):
    app, db, picture, variant = _published(tmp_path, monkeypatch)
    monkeypatch.setattr(Path, 'read_bytes', lambda *args: pytest.fail('GET must not hash the original or cached image'))
    with TestClient(app) as client:
        first = client.get(picture['variants']['384'])
        assert first.status_code == 200
        assert first.headers['cache-control'] == 'private, max-age=31536000, immutable'
        assert first.headers['etag'] == f'"{variant["etag"]}"'
        assert int(first.headers['content-length']) == variant['byte_size'] == len(first.content)
        assert variant['etag'] == hashlib.sha256(first.content).hexdigest()
        assert client.get(picture['variants']['384'], headers={'If-None-Match': first.headers['etag']}).status_code == 304


def test_remote_and_path_gets_are_retired_even_with_preexisting_cache(tmp_path, monkeypatch):
    app, _, _, _ = _published(tmp_path, monkeypatch)
    with TestClient(app) as client:
        assert client.get('/api/assets/remote', params={'url': TMDB_URL}).status_code == 404
        assert client.get('/api/assets', params={'path': 'poster.jpg'}).status_code == 404


def test_atomic_write_failure_keeps_previous_file_and_cleans_temporary(tmp_path, monkeypatch):
    from app.media_v4.assets import service

    target = tmp_path / 'variant.webp'
    target.write_bytes(b'published-image')
    monkeypatch.setattr(service.os, 'fsync', lambda *args: (_ for _ in ()).throw(OSError('disk failure')))
    with pytest.raises(OSError):
        _atomic_bytes(target, b'new-image')
    assert target.read_bytes() == b'published-image'
    assert list(tmp_path.glob('.variant.webp.*.tmp')) == []


@pytest.mark.parametrize('width', [0, 1, 999, 4096])
def test_unregistered_width_never_falls_back_to_original(tmp_path, monkeypatch, width):
    app, _, picture, _ = _published(tmp_path, monkeypatch)
    with TestClient(app) as client:
        assert client.get(picture['variants']['384'].removesuffix('/384') + f'/{width}').status_code == 404
