"""Cache maintenance uses server-owned previews and explicit confirmation."""

from datetime import UTC, datetime, timedelta

from app.api import media_v4
from app.media_v4.persistence.database import V4Database
from fastapi import FastAPI
from fastapi.testclient import TestClient


def test_cache_confirm_uses_saved_preview_and_is_idempotent(tmp_path, monkeypatch):
    database = V4Database(tmp_path / 'library.db')
    database.initialize()
    monkeypatch.setattr(media_v4, 'get_database', lambda: database)
    monkeypatch.setattr(media_v4, 'get_data_dir', lambda: tmp_path)
    app = FastAPI()
    app.include_router(media_v4.router)
    client = TestClient(app)
    preview = client.post('/api/v4/artwork-cache/preview', json={}).json()
    assert preview['variant_count'] == 0
    assert preview['original_count'] == 0
    request = {'preview_id': preview['preview_id'], 'digest': preview['digest'], 'confirm': True}
    assert client.post('/api/v4/artwork-cache/confirm', json={**request, 'confirm': False}).status_code == 422
    assert client.post('/api/v4/artwork-cache/confirm', json={**request, 'digest': '0' * 64}).status_code == 409
    result = client.post('/api/v4/artwork-cache/confirm', json=request)
    assert result.status_code == 200
    assert result.json()['removed'] == 0
    assert client.post('/api/v4/artwork-cache/confirm', json=request).json() == result.json()


def test_cache_preview_expiry_and_data_root_changes_block_execution(tmp_path, monkeypatch):
    database = V4Database(tmp_path / 'library.db')
    database.initialize()
    monkeypatch.setattr(media_v4, 'get_database', lambda: database)
    monkeypatch.setattr(media_v4, 'get_data_dir', lambda: tmp_path)
    app = FastAPI()
    app.include_router(media_v4.router)
    client = TestClient(app)
    preview = client.post('/api/v4/artwork-cache/preview', json={}).json()
    request = {'preview_id': preview['preview_id'], 'digest': preview['digest'], 'confirm': True}
    monkeypatch.setattr(media_v4, 'get_data_dir', lambda: tmp_path / 'other')
    assert client.post('/api/v4/artwork-cache/confirm', json=request).status_code == 409
    monkeypatch.setattr(media_v4, 'get_data_dir', lambda: tmp_path)
    with database.connect() as conn:
        conn.execute('UPDATE v4_meta SET value=json_set(value,?,?) WHERE key=?',
                     ('$.expires_at', (datetime.now(UTC) - timedelta(minutes=1)).isoformat(),
                      'artwork_gc_preview:' + preview['preview_id']))
    assert client.post('/api/v4/artwork-cache/confirm', json=request).status_code == 409
    assert client.post('/api/v4/artwork-cache/preview', json={'retention_days': 0}).status_code == 422
