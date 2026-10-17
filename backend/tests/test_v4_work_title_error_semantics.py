"""标题覆盖写入必须如实报告未知作品，不得静默成功。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient


def _client(tmp_path, monkeypatch) -> tuple[TestClient, object]:
    from app.api import media_v4
    from app.media_v4.persistence.database import V4Database

    database = V4Database(tmp_path / "work-title.db")
    database.initialize()
    monkeypatch.setattr(media_v4, "_database", database)
    application = FastAPI()
    application.include_router(media_v4.router)
    return TestClient(application), database


def test_title_write_rejects_unknown_work_without_writing_override(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)

    patched = client.patch("/api/v4/works/work-missing/title", json={"title": "用户标题"})
    assert patched.status_code == 404
    assert patched.json()["detail"] == "作品不存在"

    restored = client.delete("/api/v4/works/work-missing/title")
    assert restored.status_code == 404
    assert restored.json()["detail"] == "作品不存在"

    with database.connect() as conn:
        assert conn.execute(
            "SELECT COUNT(*) FROM work_overrides WHERE work_id = 'work-missing'"
        ).fetchone()[0] == 0


def test_title_write_keeps_existing_work_flow(tmp_path, monkeypatch):
    client, database = _client(tmp_path, monkeypatch)
    with database.connect() as conn:
        conn.execute(
            "INSERT INTO works(work_id, identity_key, work_type, preferred_title, show_type, card_type, created_at, updated_at) "
            "VALUES ('w1', 'ik-w1', 'series', '原始标题', 'anime_series', 'main_series', 'now', 'now')"
        )

    patched = client.patch("/api/v4/works/w1/title", json={"title": "用户标题"})
    assert patched.status_code == 200
    assert patched.json()["title"] == "用户标题"
    with database.connect() as conn:
        stored = conn.execute(
            "SELECT override_json FROM work_overrides WHERE work_id = 'w1'"
        ).fetchone()
    assert stored is not None and "用户标题" in stored["override_json"]

    restored = client.delete("/api/v4/works/w1/title")
    assert restored.status_code == 200
    assert restored.json()["restored"] is True


def test_artwork_restore_reports_unknown_work(tmp_path, monkeypatch):
    """恢复自动图片与手工上传同组，未知作品不能返回"已恢复"。"""

    client, database = _client(tmp_path, monkeypatch)

    missing = client.delete("/api/v4/works/work-missing/artwork/poster")
    assert missing.status_code == 404
    assert missing.json()["detail"] == "作品不存在"

    with database.connect() as conn:
        conn.execute(
            "INSERT INTO works(work_id, identity_key, work_type, preferred_title, show_type, card_type, created_at, updated_at) "
            "VALUES ('w1', 'ik-w1', 'series', '原始标题', 'anime_series', 'main_series', 'now', 'now')"
        )
    known = client.delete("/api/v4/works/w1/artwork/poster")
    assert known.status_code == 200
    assert known.json()["restored"] is True
